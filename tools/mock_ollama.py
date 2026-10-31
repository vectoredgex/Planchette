"""A tiny fake Ollama for developing the board without a GPU.

    python tools/mock_ollama.py   (listens on :11434)

It behaves like a small model that thinks in multi-letter tokens ("BEH",
"IND") and is sometimes torn between two answers, so the planchette has
something to hesitate over. Never used in a real séance.
"""
import json
import math
import random
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# each question gets a pair of rival answers with their weights
RIVALS = [
    (("YES", 0.55), ("NO", 0.40)),
    (("BEHIND YOU", 0.6), ("BELOW THE STAIRS", 0.35)),
    (("MARIGOLDS", 0.7), ("MUSIC", 0.25)),
    (("THE CELLAR", 0.5), ("THE ATTIC", 0.45)),
    (("I AM ALWAYS HERE", 0.8), ("NOT YET", 0.15)),
]


def chunks(word, seed):
    rng = random.Random(seed)
    out, i = [], 0
    while i < len(word):
        n = rng.choice([2, 3, 3, 4])
        out.append(word[i:i + n])
        i += n
    return out


def tokens_for(text, seed):
    out = []
    for j, w in enumerate(text.split(" ")):
        cs = chunks(w, seed + j)
        if j:
            cs[0] = " " + cs[0]
        out += cs
    return out


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _j(self, o):
        b = json.dumps(o).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path.startswith("/api/version"):
            return self._j({"version": "0.40.12-mock"})
        if self.path.startswith("/api/tags"):
            return self._j({"models": [
                {"name": "gemma3:4b", "details": {"family": "gemma3", "parameter_size": "4.3B"}},
                {"name": "qwen2.5:7b", "details": {"family": "qwen2", "parameter_size": "7.6B"}},
            ]})
        self._j({})

    def do_POST(self):
        d = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        time.sleep(0.15)
        prompt = d["prompt"]
        said = ""
        for marker in ["<start_of_turn>model\n", "<|im_start|>assistant\n"]:
            if marker in prompt:
                head, said = prompt.rsplit(marker, 1)
                break
        q = head.rsplit("\n", 1)[-1] if "\n" in head else head
        seed = sum(map(ord, q)) + (7 if "qwen" in d["model"] else 0)
        (a, pa), (b, pb) = RIVALS[seed % len(RIVALS)]
        if "qwen" in d["model"]:
            pa, pb = pb, pa
        cands = {}
        for ans, w in ((a, pa), (b, pb)):
            toks = tokens_for(ans, seed)
            acc = ""
            for t in toks:
                if said == acc:
                    cands[t] = cands.get(t, 0) + w
                    break
                acc += t
            else:
                if said == acc:
                    cands["<end_of_turn>"] = cands.get("<end_of_turn>", 0) + w
        if not cands:  # off the script: wrap up
            cands = {"<end_of_turn>": 0.7, " NOW": 0.2}
        rng = random.Random(seed + len(said))
        for _ in range(4):
            cands[rng.choice("ABCDEFGHIKLMNOPRSTUWY") + rng.choice("AEIOU")] = 0.01 + rng.random() * 0.03
        z = sum(cands.values())
        tops = sorted(([t, math.log(v / z)] for t, v in cands.items()), key=lambda x: -x[1])[: d.get("top_logprobs", 5)]
        # like real Ollama: if its own sample is end-of-turn, it stops and reports no logprobs
        r, pick = random.random(), tops[0][0]
        for t, lp in tops:
            r -= math.exp(lp)
            if r <= 0:
                pick = t
                break
        if pick == "<end_of_turn>":
            return self._j({"model": d["model"], "response": "", "done": True, "done_reason": "stop"})
        self._j({"model": d["model"], "response": tops[0][0], "done": True, "done_reason": "length",
                 "logprobs": [{"token": tops[0][0], "logprob": tops[0][1],
                               "top_logprobs": [{"token": t, "logprob": lp} for t, lp in tops]}]})


ThreadingHTTPServer(("127.0.0.1", 11434), H).serve_forever()
