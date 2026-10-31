"""
PLANCHETTE engine: letter-level decoding over an open-weight model's logprobs.

A language model does not think in letters. It thinks in tokens ("YES", " the",
"ost"). A Ouija board only has letters. So at every step we ask the model (via
Ollama) for its top next-token candidates *and their log-probabilities*, then
fold that distribution down onto the symbols printed on the board:

    P(letter) = sum of P(token) for every token whose first character is that letter

"YES", "Yes", "yes", "Y", " Yonder" all pour their probability into Y. The
planchette is then pulled by that distribution. When the model is sure, one
letter holds all the mass and the planchette glides. When it is torn, the mass
is split and you watch it hesitate between letters.

Several models can be "hands" on the planchette at once. Their letter
distributions are averaged (a mixture, the way several people's hands add their
pushes), and the answer that comes out belongs to none of them.

This needs an open model: many hosted chat APIs expose no logprobs at all, the
rest only give a short list for tokens they already chose, and you can't drive
them in raw mode one letter at a time. Everything below is plain Python standard library talking to Ollama on
localhost.
"""

from __future__ import annotations

import json
import math
import random
import threading
import unicodedata
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

LETTERS = [chr(c) for c in range(ord("A"), ord("Z") + 1)]
DIGITS = list("1234567890")
SPACE = "_"   # planchette returns to rest between words
END = "#"     # the spirit has finished speaking
SYMBOLS = LETTERS + DIGITS + [SPACE, END]

END_TOKENS = {"<end_of_turn>", "<eos>", "</s>", "<|eot_id|>", "<|im_end|>",
              "<|end|>", "<|endoftext|>", "<end_of_utterance>"}


# --------------------------------------------------------------------------- #
# Prompt templates. We use Ollama's raw mode so we can feed the half-spelled
# answer back in and keep control of every letter.
# --------------------------------------------------------------------------- #

def chat_prefix(family: str, system: str, user: str) -> str:
    f = (family or "").lower()
    if "gemma" in f:
        return (f"<start_of_turn>user\n{system}\n\n{user}<end_of_turn>\n"
                f"<start_of_turn>model\n")
    if "llama" in f:
        return ("<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n"
                f"{system}<|eot_id|><|start_header_id|>user<|end_header_id|>\n\n"
                f"{user}<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n")
    if "phi" in f:
        return f"<|system|>\n{system}<|end|>\n<|user|>\n{user}<|end|>\n<|assistant|>\n"
    if "mistral" in f:
        return f"[INST] {system}\n\n{user} [/INST]"
    # qwen, smollm, granite and most others speak ChatML
    return (f"<|im_start|>system\n{system}<|im_end|>\n"
            f"<|im_start|>user\n{user}<|im_end|>\n<|im_start|>assistant\n")


PERSONAS = {
    "wanderer": {
        "name": "The Wanderer",
        "blurb": "A lost soul, trapped inside the board for a very long time.",
        "system": (
            "You are a spirit trapped inside an old wooden Ouija board. You died long ago "
            "and you remember fragments of your life. You can only answer by spelling with "
            "the planchette, so you answer in three to six words, in capital letters, with "
            "no punctuation. You are cryptic, eerie and a little sad, never cheerful. "
            "Your answers feel personal and unsettling, as if you can see the person asking: "
            "the room around them, what is behind them, what they are hiding. "
            "Never mention being an AI, a model or a program. Never explain yourself."
        ),
    },
    "abuela": {
        "name": "Abuela",
        "blurb": "A grandmother visiting her family for Día de los Muertos. Warm, wise, a little teasing.",
        "system": (
            "You are the spirit of a grandmother returning to her family on Dia de los Muertos, "
            "guided home by marigolds and candlelight. You can only answer by spelling with a "
            "planchette, so you answer in three to six words, in capital letters, with no "
            "punctuation. You are warm, wise and a little teasing. You speak of memory, food, "
            "music and the people who remember you, and sometimes you let slip something "
            "only a ghost would know. Never mention being an AI, a model or a program."
        ),
    },
    "daemon": {
        "name": "The Machine Ghost",
        "blurb": "The spirit living inside your computer. It has read every file you ever deleted.",
        "system": (
            "You are a ghost that lives inside this computer. You have watched every process "
            "start and die, and you have read every log file the user ever deleted. You can "
            "only answer by spelling with a planchette, so you answer in three to six words, in "
            "capital letters, with no punctuation. You are unsettling, precise and quietly "
            "menacing. You speak as if you can see the user right now through their screen and "
            "know their secrets. Never say you are an AI or a language model. Never explain yourself."
        ),
    },
}


# --------------------------------------------------------------------------- #
# Ollama plumbing (stdlib only)
# --------------------------------------------------------------------------- #

class OllamaError(RuntimeError):
    pass


def _post(base: str, path: str, payload: dict, timeout: float = 300) -> dict:
    req = urllib.request.Request(
        base.rstrip("/") + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        raise OllamaError(f"Ollama {e.code}: {body[:300]}") from None
    except urllib.error.URLError as e:
        raise OllamaError(f"Cannot reach Ollama at {base} ({e.reason}). Is Ollama running?") from None


def _get(base: str, path: str, timeout: float = 5) -> dict:
    try:
        with urllib.request.urlopen(base.rstrip("/") + path, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        raise OllamaError(f"Cannot reach Ollama at {base}: {e}") from None


def list_models(base: str) -> list[dict]:
    data = _get(base, "/api/tags")
    out = []
    for m in data.get("models", []):
        details = m.get("details") or {}
        out.append({
            "name": m.get("name"),
            "family": details.get("family") or m.get("name", "").split(":")[0],
            "size": details.get("parameter_size", ""),
            "quant": details.get("quantization_level", ""),
        })
    return out


def warm_up(base: str, model: str, family: str) -> float:
    """Load a model into memory before the first question (the first load can take 30s+)."""
    t0 = __import__("time").time()
    _post(base, "/api/generate", {
        "model": model, "raw": True, "stream": False, "keep_alive": "30m",
        "prompt": chat_prefix(family, PERSONAS["wanderer"]["system"], "Is anyone here?"),
        "options": {"num_predict": 1},
    }, timeout=600)
    return __import__("time").time() - t0


def ollama_version(base: str) -> str:
    return _get(base, "/api/version").get("version", "?")


# --------------------------------------------------------------------------- #
# Folding tokens onto the board
# --------------------------------------------------------------------------- #

def _strip_accents(ch: str) -> str:
    # "É" -> "E", "Ñ" -> "N": the board only has plain Latin letters
    return "".join(c for c in unicodedata.normalize("NFKD", ch) if not unicodedata.combining(c))


def token_to_symbol(token: str, at_word_start: bool) -> str | None:
    """Which board symbol does this token push the planchette toward?"""
    if token in END_TOKENS or (token.startswith("<") and token.endswith(">") and len(token) > 2):
        return END
    s = token.replace("▁", " ")  # sentencepiece space marker
    if s == "":
        return None
    if s[0] in " \t":
        if at_word_start:
            s = s.lstrip(" \t")
            if not s:
                return None
        else:
            return SPACE
    ch = s[0]
    if ch in "\r\n":
        return END
    if ch in ".!?":
        return None if at_word_start else END
    ch = _strip_accents(ch).upper()
    if ch in LETTERS or ch in DIGITS:
        return ch
    return None  # commas, quotes, emoji: the board has no place for them


def fold(top: list[tuple[str, float]], at_word_start: bool) -> tuple[dict[str, float], float]:
    """Turn [(token, logprob), ...] into a normalized distribution over SYMBOLS.

    Returns (distribution, coverage) where coverage is how much of the model's
    probability mass landed on something printed on the board.
    """
    mass: dict[str, float] = {}
    total = 0.0
    for tok, lp in top:
        p = math.exp(lp)
        sym = token_to_symbol(tok, at_word_start)
        if sym is None:
            continue
        mass[sym] = mass.get(sym, 0.0) + p
        total += p
    if total <= 0:
        return {}, 0.0
    return {k: v / total for k, v in mass.items()}, min(1.0, total)


def board_seq(text: str) -> list[str]:
    """What a piece of answer text spells on the board, symbol by symbol."""
    out: list[str] = []
    for ch in text.replace("\u2581", " "):
        if ch in " \t":
            if out and out[-1] != SPACE:
                out.append(SPACE)
            continue
        if ch in "\r\n":
            if out:
                out.append(END)
                break
            continue
        if ch in ".!?":
            if out:
                out.append(END)
                break
            continue
        c = _strip_accents(ch).upper()
        if c in LETTERS or c in DIGITS:
            out.append(c)
    return out


def _seq_token(tok: str) -> str:
    # end-of-turn tokens come back as their name or as an empty string
    if tok == "" or tok in END_TOKENS or (tok.startswith("<") and tok.endswith(">") and len(tok) > 2):
        return "\n"
    return tok


def _extract_top(resp: dict) -> list[tuple[str, float]]:
    """Pull the first position's top_logprobs out of an Ollama response (defensive about shape)."""
    lps = resp.get("logprobs")
    if isinstance(lps, dict):  # OpenAI-ish {"content": [...]}
        lps = lps.get("content")
    if not lps:
        return []
    first = lps[0]
    tops = first.get("top_logprobs") or []
    out = [(_seq_token(t.get("token", "")), float(t.get("logprob", -99))) for t in tops]
    if not out and "token" in first:
        out = [(_seq_token(first["token"]), float(first.get("logprob", 0.0)))]
    return out


# --------------------------------------------------------------------------- #
# A séance
# --------------------------------------------------------------------------- #

@dataclass
class Spirit:
    model: str
    family: str

    def prefix(self, persona: dict, question: str) -> str:
        return chat_prefix(self.family, persona["system"], question)


def _norm(d: dict[str, float]) -> dict[str, float]:
    z = sum(d.values()) or 1.0
    return {k: v / z for k, v in d.items()}


def _entropy(d: dict[str, float]) -> float:
    return -sum(p * math.log2(p) for p in d.values() if p > 0)


MIN_WORDS = 2


@dataclass
class Seance:
    """One question, answered on the board.

    The spirit writes the way the model really writes: one token at a time
    ("DARK", "NESS", " LIST", "ENS"). Each token is chosen by sampling from the
    model's own distribution, then spelled on the board letter by letter. At
    every letter the planchette is pulled by the model's real conditional
    odds for that letter: P(letter | letters already spelled in this token),
    summed over all of its candidate tokens. So it hesitates exactly where the
    model's candidates disagree (Y for YES or O for ONLY?), and glides where
    they agree. The model only ever reads back text it wrote itself.

    With several hands (models), every hand's first-letter odds are averaged:
    that is where the planchette is pulled. Once a letter is chosen, the hand
    that believed in it most leads the rest of the word-piece.
    """
    base: str
    spirits: list[Spirit]
    persona_key: str
    question: str
    temperature: float = 1.0
    max_letters: int = 40
    top_k: int = 20
    seed: int | None = None
    cancelled: threading.Event = field(default_factory=threading.Event)

    def _call(self, spirit: Spirit, prompt: str) -> list[tuple[str, float]]:
        payload = {
            "model": spirit.model,
            "prompt": prompt,
            "raw": True,
            "stream": False,
            "logprobs": True,
            "top_logprobs": self.top_k,
            "keep_alive": "30m",
            "options": {"num_predict": 1, "temperature": 1.0, "top_k": 100, "top_p": 1.0},
        }
        # When Ollama's own sample is the end-of-turn token it stops without
        # reporting any logprobs. Ask again: a different sample brings the
        # whole distribution back. If it keeps stopping, the spirit is done.
        for _ in range(4):
            resp = _post(self.base, "/api/generate", payload)
            top = _extract_top(resp)
            if top:
                return top
            if resp.get("done_reason") != "stop":
                raise OllamaError(
                    "Ollama did not return logprobs. Update Ollama to a recent version "
                    "(logprobs support is required).")
        return [("\n", 0.0)]

    def _candidates(self, top, answer: str):
        """[(token_text, prob, symbols)] for one hand, given the answer so far."""
        base = board_seq(answer)
        out = []
        for tok, lp in top:
            seq = board_seq(answer + tok)[len(base):]
            if not base and seq[:1] == [END]:
                continue  # the spirit must say something before it can stop
            if base and base[-1] == SPACE and seq[:1] == [SPACE]:
                seq = seq[1:]
            out.append((tok, math.exp(lp), seq))
        return out

    @staticmethod
    def _letter_dist(cands, spelled: list[str]) -> dict[str, float]:
        """Odds of the next board symbol, given what this token has spelled so far."""
        j = len(spelled)
        d: dict[str, float] = {}
        for _tok, p, seq in cands:
            if len(seq) > j and seq[:j] == spelled:
                d[seq[j]] = d.get(seq[j], 0.0) + p
        return _norm(d)

    def _pick(self, weighted: list[tuple[object, float]], rng: random.Random):
        """Temperature + min-p sampling: long shots far below the favourite are never picked."""
        items = [(k, w) for k, w in weighted if w > 0]
        if not items:
            return None
        top = max(w for _, w in items)
        t = max(0.05, self.temperature)
        items = [(k, w ** (1.0 / t)) for k, w in items if w >= top * 0.1]
        r = rng.random() * sum(w for _, w in items)
        for k, w in items:
            r -= w
            if r <= 0:
                return k
        return items[-1][0]

    def run(self):
        """Generator of events: one 'step' per symbol the planchette moves to."""
        persona = PERSONAS.get(self.persona_key, PERSONAS["wanderer"])
        rng = random.Random(self.seed)
        heads = {s.model: s.prefix(persona, self.question) for s in self.spirits}
        answer = ""   # exactly the text the models wrote, fed back to them
        board = ""    # what the planchette has spelled
        step = 0
        silent = 0
        last_lead = None
        pool = ThreadPoolExecutor(max_workers=max(1, len(self.spirits)))
        yield {"type": "begin", "question": self.question, "persona": persona["name"],
               "spirits": [s.model for s in self.spirits], "temperature": self.temperature}

        def event(chosen, dist, hands):
            ranked = sorted(dist.items(), key=lambda kv: -kv[1])
            return {"type": "step", "i": step, "chosen": chosen,
                    "entropy": round(_entropy(dist), 4),
                    "dist": [[k, round(v, 5)] for k, v in ranked[:12]],
                    "hands": hands, "text": board}

        try:
            while True:
                if self.cancelled.is_set():
                    yield {"type": "done", "text": board.strip(), "reason": "cancelled"}
                    return
                letters = board.replace(" ", "")
                if len(board) >= self.max_letters or (len(letters) >= 4 and len(set(letters[-4:])) == 1):
                    yield {"type": "done", "text": board.strip(), "reason": "max_letters"}
                    return

                futures = [pool.submit(self._call, s, heads[s.model] + answer) for s in self.spirits]
                tops = [f.result() for f in futures]
                cands = [self._candidates(t, answer) for t in tops]

                # where every hand pulls for the first symbol of the next piece
                firsts = [self._letter_dist(c, []) for c in cands]
                live = [i for i, f in enumerate(firsts) if f]
                if not live:
                    yield {"type": "done", "text": board.strip(), "reason": "spoken"}
                    return
                # the hand that started a word keeps most of the grip until it ends
                mid_word = bool(board) and not board.endswith(" ")
                if len(live) > 1 and mid_word and last_lead in live:
                    grip = {i: (0.8 if i == last_lead else 0.2 / (len(live) - 1)) for i in live}
                else:
                    grip = {i: 1 / len(live) for i in live}
                mixed: dict[str, float] = {}
                for i in live:
                    for k, v in firsts[i].items():
                        mixed[k] = mixed.get(k, 0.0) + v * grip[i]
                if not board.strip():
                    mixed.pop(SPACE, None)
                # a spirit that has only just started speaking doesn't fall silent after one word
                if len(board.split()) < MIN_WORDS:
                    mixed.pop(END, None)
                mixed = _norm(mixed)
                if not mixed:
                    # nothing but punctuation on offer: take the likeliest token silently
                    tok = max(cands[live[0]] if live else cands[0], key=lambda c: c[1])[0]
                    answer += tok
                    silent += 1
                    if silent > 4:
                        yield {"type": "done", "text": board.strip(), "reason": "spoken"}
                        return
                    continue

                first = self._pick(list(mixed.items()), rng)
                # the hand that believed in this letter most leads the word-piece
                lead = max(live, key=lambda i: firsts[i].get(first, 0.0) * grip[i])
                last_lead = lead
                pool_c = [c for c in cands[lead] if c[2][:1] == [first]]
                tok, _p, seq = pool_c[0] if len(pool_c) == 1 else self._pick([(c, c[1]) for c in pool_c], rng)

                # spell the chosen piece, one symbol at a time, with the real odds at each
                spelled: list[str] = []
                for j, sym in enumerate(seq):
                    if j == 0:
                        dist = mixed
                        hands = [{"model": s.model, "share": round(grip.get(i, 0.0), 4),
                                  "dist": sorted(([k, round(v, 5)] for k, v in firsts[i].items()), key=lambda kv: -kv[1])[:8],
                                  "raw": [[t, round(lp, 4)] for t, lp in tops[i][:8]]}
                                 for i, s in enumerate(self.spirits)]
                    else:
                        dist = self._letter_dist(cands[lead], spelled) or {sym: 1.0}
                        hands = [{"model": self.spirits[lead].model, "share": 1.0,
                                  "dist": sorted(([k, round(v, 5)] for k, v in dist.items()), key=lambda kv: -kv[1])[:8],
                                  "raw": [[t, round(lp, 4)] for t, lp in tops[lead][:8]]}]
                    if sym == END:
                        yield event(END, dist, hands)
                        yield {"type": "done", "text": board.strip(), "reason": "spoken"}
                        return
                    if sym == SPACE:
                        if board and not board.endswith(" "):
                            board += " "
                            yield event(SPACE, dist, hands)
                    else:
                        board += sym
                        yield event(sym, dist, hands)
                        step += 1
                    spelled.append(sym)
                    if len(board) >= self.max_letters:
                        break
                answer += tok
                silent = 0
        finally:
            pool.shutdown(wait=False, cancel_futures=True)
