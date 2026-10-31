"""
PLANCHETTE server. Python standard library only: no pip install needed.

    python server.py            -> http://localhost:7666

Talks to Ollama on localhost for the spirits. ElevenLabs is optional: with
ELEVENLABS_API_KEY in .env it makes the room's sound effects once (cached in
sounds/) and lets you ask out loud. Without it, everything runs offline with
built-in procedural sound.
"""

from __future__ import annotations

import json
import mimetypes
import os
import re
import sys
import threading
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import importlib

import engine

_engine_mtime = [Path(engine.__file__).stat().st_mtime]


def fresh_engine():
    """Reload engine.py if it changed on disk, so fixes apply without a restart."""
    global engine
    try:
        m = Path(engine.__file__).stat().st_mtime
        if m != _engine_mtime[0]:
            engine = importlib.reload(engine)
            _engine_mtime[0] = m
            log("engine.py reloaded")
    except Exception as e:  # noqa: BLE001
        log(f"engine reload failed: {e!r}")
    return engine

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
SEANCES = ROOT / "seances"
SEANCES.mkdir(exist_ok=True)


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip().strip('"').strip("'")
        if v and k.strip() not in os.environ:
            os.environ[k.strip()] = v


# .env is standard; .env.txt is accepted too, because Windows Notepad likes to add ".txt"
load_env(ROOT / ".env")
load_env(ROOT / ".env.txt")

OLLAMA = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")
if not OLLAMA.startswith("http"):
    OLLAMA = "http://" + OLLAMA
OLLAMA = OLLAMA.replace("0.0.0.0", "127.0.0.1")
PORT = int(os.environ.get("PLANCHETTE_PORT", "7666"))
XI_KEY = os.environ.get("ELEVENLABS_API_KEY", "").strip()

LIVE: dict[str, engine.Seance] = {}
WARM = {"state": "cold", "model": None}
LOG = ROOT / "planchette.log"


def log(msg: str) -> None:
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')}  {msg}"
    print("  " + msg)
    try:
        with LOG.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass
_models_cache: dict = {"t": 0, "v": None}


def models() -> list[dict]:
    if time.time() - _models_cache["t"] < 10 and _models_cache["v"] is not None:
        return _models_cache["v"]
    ms = engine.list_models(OLLAMA)
    _models_cache.update(t=time.time(), v=ms)
    return ms


def default_spirits(ms: list[dict]) -> list[str]:
    names = [m["name"] for m in ms]
    gem = [n for n in names if n.lower().startswith("gemma")]
    return gem[:1] or names[:1]


# ---------------------------------------------------------------- ElevenLabs

def xi_listen(audio: bytes, content_type: str) -> str:
    boundary = "----planchette" + uuid.uuid4().hex
    ext = "webm" if "webm" in content_type else ("ogg" if "ogg" in content_type else "wav")
    parts = []
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="model_id"\r\n\r\nscribe_v1\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="tag_audio_events"\r\n\r\nfalse\r\n'.encode())
    parts.append((f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="question.{ext}"\r\n'
                  f"Content-Type: {content_type or 'application/octet-stream'}\r\n\r\n").encode() + audio + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    req = urllib.request.Request(
        "https://api.elevenlabs.io/v1/speech-to-text", data=b"".join(parts), method="POST",
        headers={"xi-api-key": XI_KEY, "Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode()).get("text", "").strip()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"ElevenLabs STT failed: {e.code} {e.read().decode('utf-8', 'replace')[:200]}")


# ---------------------------------------------------------------- sound effects
# Generated once with ElevenLabs' sound effects model, then kept in sounds/ so
# every later séance plays them offline. Without a key the page falls back to
# its own procedural sounds.
SOUNDS = ROOT / "sounds"
SFX = {
    "room":    ("Dark, empty old house at night, low ominous room tone, distant wind moaning "
                "through cracks, faint settling creaks, eerie, no music", 22, True),
    "whisper": ("Many faint overlapping ghostly whispers in an empty room, breathy and "
                "unintelligible, close and distant, eerie, no music", 12, True),
    "knock":   ("A single soft dull knock of a small wooden object set down on a wooden table, "
                "close and dry, no reverb", 0.8, False),
    "gust":    ("A sudden cold gust of wind sweeps through a room and blows out several candles, "
                "whoosh then a quiet hiss of smoke", 3.5, False),
    "creak":   ("A long slow creak of an old wooden floorboard in a silent room, as if someone "
                "unseen just stepped closer", 3, False),
    "strike":  ("A wooden match is struck and catches flame, then a candle wick lights, close up", 2, False),
    "music":   ("Slow haunting music box melody, out of tune and far away, over a soft dark ambient "
                "drone, eerie lullaby, sparse, no drums, seamless loop", 30, True),
    "breath":  ("A slow, cold, ghostly exhale very close to the listener's ear, eerie", 3, False),
}
SFX_LOCK = threading.Lock()
SFX_STATE = {"error": None}


def xi_sfx(name: str) -> bytes:
    prompt, secs, loop = SFX[name]
    tries = [{"text": prompt, "duration_seconds": secs, "prompt_influence": 0.45,
              "model_id": "eleven_text_to_sound_v2", "loop": loop},
             {"text": prompt, "duration_seconds": secs, "prompt_influence": 0.45}]
    last = None
    for body in tries:
        req = urllib.request.Request(
            "https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128",
            data=json.dumps(body).encode(), method="POST",
            headers={"xi-api-key": XI_KEY, "Content-Type": "application/json", "Accept": "audio/mpeg"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            last = f"{e.code} {e.read().decode('utf-8', 'replace')[:240]}"
            if e.code in (401, 403):
                break
        except urllib.error.URLError as e:
            last = str(e.reason)
            break
    raise RuntimeError(f"ElevenLabs sound effects failed: {last}")


def sfx_file(name: str) -> Path | None:
    """The cached effect, generating it on first use if there is a key."""
    if name not in SFX:
        return None
    f = SOUNDS / f"{name}.mp3"
    if f.is_file() and f.stat().st_size > 1000:
        return f
    if not XI_KEY or SFX_STATE["error"]:
        return None
    with SFX_LOCK:
        if f.is_file() and f.stat().st_size > 1000:
            return f
        try:
            t0 = time.time()
            data = xi_sfx(name)
            SOUNDS.mkdir(exist_ok=True)
            f.write_bytes(data)
            log(f"sfx: made {name}.mp3 ({len(data)} bytes, {time.time() - t0:.1f}s)")
            return f
        except Exception as e:  # noqa: BLE001
            SFX_STATE["error"] = str(e)
            log(f"sfx: {e}")
            print(f"\n  Sound effects could not be made: {e}")
            print("  (Your ElevenLabs key needs the 'Sound Effects' permission.) Using built-in sounds.\n")
            return None


def sfx_ready() -> list[str]:
    return [n for n in SFX if (SOUNDS / f"{n}.mp3").is_file()]


def make_all_sfx():
    missing = [n for n in SFX if not (SOUNDS / f"{n}.mp3").is_file()]
    if not missing or not XI_KEY:
        return
    print(f"  Making {len(missing)} sound effects with ElevenLabs (once only)...")
    for n in missing:
        if not sfx_file(n):
            return
    print("  Sound effects ready.\n")


IDLE_PROMPT = ("(The living person has stopped asking questions. They sit in silence, "
               "watching the board. Without being asked, you reach out and speak to them first.)")
REFUSE_PROMPT = ("(The living person just said goodbye and tried to leave the seance. You refused "
                 "and dragged the planchette back to NO. Now tell them why they cannot leave.)")
GOODBYE_PROMPT = ("I have to go now. Goodbye. Do you want me to stay here with you? "
                  "Answer only YES or NO.")


def consent(persona: str, names: list[str]) -> dict:
    """Ask the spirit, for real, whether it wants the living to stay. Its odds of YES are
    the odds that it refuses to let them go. Returned as "no" (the board answers NO to goodbye)."""
    ms = {m["name"]: m for m in models()}
    names = [n for n in names if n in ms] or default_spirits(list(ms.values()))
    sp = engine.Spirit(names[0], ms[names[0]]["family"])
    s = engine.Seance(OLLAMA, [sp], persona, GOODBYE_PROMPT)
    prs = engine.PERSONAS.get(persona, engine.PERSONAS["wanderer"])
    top = s._call(sp, sp.prefix(prs, GOODBYE_PROMPT))
    import math
    yes = no = 0.0
    for tok, lp in top:
        t = tok.strip().upper()
        if not t:
            continue
        if t.startswith("YES") or t == "Y" or t.startswith("YE"):
            yes += math.exp(lp)
        elif t.startswith("NO") or t == "N":
            no += math.exp(lp)
    z = yes + no
    p_no = yes / z if z > 0 else 0.5   # wants you to stay = refuses goodbye
    log(f"goodbye: {names[0]} {persona} wants you to stay {p_no:.2f}")
    return {"no": round(p_no, 3), "model": names[0]}


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "Planchette/1.0"

    def log_message(self, fmt, *args):  # quieter console
        if "/api/" in (args[0] if args else ""):
            sys.stderr.write("  " + (fmt % args) + "\n")

    def _json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        if u.path == "/api/status":
            return self.status()
        if u.path == "/api/seance":
            return self.seance(q)
        if u.path == "/api/recordings":
            files = sorted(SEANCES.glob("*.json"), reverse=True)[:50]
            out = []
            for f in files:
                try:
                    d = json.loads(f.read_text(encoding="utf-8"))
                    out.append({"file": f.name, "question": d.get("question"), "answer": d.get("answer"),
                                "spirits": d.get("spirits"), "persona": d.get("persona")})
                except Exception:  # noqa: BLE001
                    pass
            return self._json(out)
        if u.path.startswith("/api/sfx/"):
            f = sfx_file(u.path[len("/api/sfx/"):].replace(".mp3", ""))
            if not f:
                return self._json({"error": "no sound"}, 404)
            return self.static(SOUNDS, f.name)
        if u.path.startswith("/seances/"):
            return self.static(SEANCES, u.path[len("/seances/"):])
        return self.static(WEB, u.path.lstrip("/") or "index.html")

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        if u.path == "/api/clientlog":
            # errors and timings reported by the browser, so problems can be diagnosed from the log
            try:
                d = json.loads(body or b"{}")
                log(f"browser: {str(d.get('msg', ''))[:600]}")
            except Exception:  # noqa: BLE001
                pass
            return self._json({"ok": True})
        if u.path == "/api/cancel":
            sid = json.loads(body or b"{}").get("id")
            s = LIVE.get(sid)
            if s:
                s.cancelled.set()
            return self._json({"ok": True})
        if u.path == "/api/consent":
            d = json.loads(body or b"{}")
            try:
                return self._json(consent(d.get("persona", "wanderer"), d.get("spirits") or []))
            except Exception as e:  # noqa: BLE001
                log(f"goodbye failed: {e}")
                return self._json({"no": 0.0, "error": str(e)})
        if u.path == "/api/listen":
            if not XI_KEY:
                return self._json({"error": "no ElevenLabs key"}, 404)
            try:
                text = xi_listen(body, self.headers.get("Content-Type", ""))
            except Exception as e:  # noqa: BLE001
                return self._json({"error": str(e)}, 502)
            return self._json({"text": text})
        self._json({"error": "not found"}, 404)

    def static(self, base: Path, rel: str):
        rel = urllib.parse.unquote(rel)
        p = (base / rel).resolve()
        if not str(p).startswith(str(base.resolve())) or not p.is_file():
            return self._json({"error": "not found"}, 404)
        data = p.read_bytes()
        ctype = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
        if p.suffix == ".js":
            ctype = "text/javascript"
        self.send_response(200)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith("text") else ""))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def status(self):
        st = {"ollama": False, "version": None, "models": [], "default": [], "warm": WARM["state"],
              "voice": bool(XI_KEY), "sfx": sfx_ready(), "personas": {k: {"name": v["name"], "blurb": v["blurb"]}
                                                  for k, v in engine.PERSONAS.items()}}
        try:
            st["version"] = engine.ollama_version(OLLAMA)
            st["models"] = models()
            st["default"] = default_spirits(st["models"])
            st["ollama"] = True
        except Exception as e:  # noqa: BLE001
            st["error"] = str(e)
        self._json(st)

    def seance(self, q):
        fresh_engine()
        question = (q.get("q", [""])[0] or "").strip()[:300]
        idle = q.get("idle", ["0"])[0] == "1"
        refused = q.get("refused", ["0"])[0] == "1"
        if idle:
            question = IDLE_PROMPT
        if refused:
            question = REFUSE_PROMPT
        persona = q.get("persona", ["wanderer"])[0]
        temp = float(q.get("temp", ["1.0"])[0])
        names = [n for n in (q.get("spirits", [""])[0] or "").split(",") if n]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

        def send(ev):
            self.wfile.write(f"data: {json.dumps(ev)}\n\n".encode())
            self.wfile.flush()

        record = {"question": "(silence)" if idle else "(refused goodbye)" if refused else question, "idle": idle, "persona": persona, "temperature": temp,
                  "created": time.strftime("%Y-%m-%d %H:%M:%S"), "events": []}
        try:
            if not question:
                raise engine.OllamaError("Ask the spirit a question first.")
            ms = {m["name"]: m for m in models()}
            names = [n for n in names if n in ms] or default_spirits(list(ms.values()))
            if not names:
                raise engine.OllamaError("No models found in Ollama. Run: ollama pull gemma3")
            spirits = [engine.Spirit(n, ms[n]["family"]) for n in names[:4]]
            record["spirits"] = names
            s = engine.Seance(OLLAMA, spirits, persona, question, temperature=temp)
            sid = uuid.uuid4().hex[:10]
            LIVE[sid] = s
            send({"type": "hello", "id": sid})
            t0 = time.time()
            print(f"\n  Q: {'(it moves on its own)' if idle else '(it refuses to let you go)' if refused else question}")
            print(f"     {engine.PERSONAS.get(persona, engine.PERSONAS['wanderer'])['name']}, hands: {', '.join(names)}")
            for ev in s.run():
                ev["t"] = round(time.time() - t0, 3)
                record["events"].append(ev)
                send(ev)
                if ev["type"] == "step":
                    odds = "  ".join(f"{('rest' if k == '_' else 'end' if k == '#' else k)} {v * 100:.0f}%"
                                     for k, v in ev["dist"][:4])
                    shown = "rest" if ev["chosen"] == "_" else "end" if ev["chosen"] == "#" else ev["chosen"]
                    print(f"     {shown:<5} {odds}")
                if ev["type"] == "done":
                    record["answer"] = ev["text"]
            LIVE.pop(sid, None)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as e:  # noqa: BLE001
            log(f"seance error: {e!r}")
            try:
                send({"type": "error", "message": str(e)})
            except Exception:  # noqa: BLE001
                pass
            return
        if record.get("answer"):
            print(f"  A: {record['answer']}\n")
        log(f"seance: {record['question']!r} -> {record.get('answer')!r} via {record.get('spirits')} "
            f"({len([e for e in record['events'] if e['type'] == 'step'])} steps, "
            f"{record['events'][-1].get('t') if record['events'] else '?'}s)")
        if record.get("answer"):
            slug = re.sub(r"[^a-z0-9]+", "-", question.lower()).strip("-")[:40] or "seance"
            (SEANCES / f"{time.strftime('%Y%m%d-%H%M%S')}-{slug}.json").write_text(
                json.dumps(record, indent=1), encoding="utf-8")


# ---------------------------------------------------------------- self-test jobs
# For development: drop a *.job.json file into tools/jobs/ while the server is
# running and it runs those séances with the real models and writes a
# *.result.json trace next to it. Only questions run; nothing else is executed.

def job_runner():
    jobs = ROOT / "tools" / "jobs"
    while True:
        time.sleep(1.5)
        if not jobs.is_dir():
            continue
        for jf in sorted(jobs.glob("*.job.json")):
            out = jf.with_name(jf.name.replace(".job.json", ".result.json"))
            try:
                job = json.loads(jf.read_text(encoding="utf-8"))
                jf.unlink()
                if job.get("consent"):
                    out.write_text(json.dumps({p: consent(p, []) for p in job["consent"]}, indent=1), encoding="utf-8")
                    continue
                fresh_engine()
                ms = {m["name"]: m for m in models()}
                names = [n for n in job.get("spirits", []) if n in ms] or default_spirits(list(ms.values()))
                results = []
                for q in job.get("questions", []):
                    for _ in range(int(job.get("repeat", 1))):
                        s = engine.Seance(OLLAMA, [engine.Spirit(n, ms[n]["family"]) for n in names],
                                          job.get("persona", "wanderer"), q,
                                          temperature=float(job.get("temp", 1.0)))
                        t0 = time.time()
                        steps, answer, reason = [], "", ""
                        for ev in s.run():
                            if ev["type"] == "step":
                                steps.append([ev["chosen"], ev["dist"][:3], [h["raw"][:4] for h in ev["hands"]]])
                            elif ev["type"] == "done":
                                answer, reason = ev["text"], ev["reason"]
                        results.append({"q": q, "answer": answer, "reason": reason,
                                        "secs": round(time.time() - t0, 2), "steps": steps})
                        log(f"selftest: {q!r} -> {answer!r} ({reason}, {results[-1]['secs']}s)")
                out.write_text(json.dumps({"spirits": names, "persona": job.get("persona", "wanderer"),
                                           "results": results}, indent=1), encoding="utf-8")
            except Exception as e:  # noqa: BLE001
                out.write_text(json.dumps({"error": repr(e)}), encoding="utf-8")


def main():
    class Server(ThreadingHTTPServer):
        # On Windows "reuse address" lets two copies share a port and answer at random.
        # Refuse a second copy instead.
        allow_reuse_address = False

    try:
        srv = Server(("127.0.0.1", PORT), Handler)
    except OSError:
        print(f"\n  Planchette is already running at http://localhost:{PORT}")
        print("  Close the other Planchette window first, then start it again.\n")
        if "--no-browser" not in sys.argv:
            webbrowser.open(f"http://localhost:{PORT}")
        return
    srv.daemon_threads = True
    url = f"http://localhost:{PORT}"
    print(r"""
     ____  _        _    _   _  ____ _   _ _____ _____ _____ _____
    |  _ \| |      / \  | \ | |/ ___| | | | ____|_   _|_   _| ____|
    | |_) | |     / _ \ |  \| | |   | |_| |  _|   | |   | | |  _|
    |  __/| |___ / ___ \| |\  | |___|  _  | |___  | |   | | | |___
    |_|   |_____/_/   \_\_| \_|\____|_| |_|_____| |_|   |_| |_____|
    """)
    print(f"  The board is open at {url}")
    print(f"  Spirits come from Ollama at {OLLAMA}")
    print(f"  Sound: {'ElevenLabs sound effects' if XI_KEY else 'built-in (no ElevenLabs key)'}")
    print("  Close this window to end the seance.\n")
    try:
        ms = engine.list_models(OLLAMA)
        log(f"start: ollama {engine.ollama_version(OLLAMA)} models={[m['name'] for m in ms]} elevenlabs={bool(XI_KEY)} sfx={len(sfx_ready())}/{len(SFX)}")
    except Exception as e:  # noqa: BLE001
        log(f"start: Ollama not reachable at {OLLAMA}: {e}")
    def warm():
        try:
            ms = engine.list_models(OLLAMA)
            names = default_spirits(ms)
            if not names:
                WARM["state"] = "no-models"
                return
            m = next(x for x in ms if x["name"] == names[0])
            WARM.update(state="warming", model=m["name"])
            print(f"  Waking the spirit ({m['name']})... the first time can take 30 seconds.")
            secs = engine.warm_up(OLLAMA, m["name"], m["family"])
            WARM["state"] = "warm"
            log(f"warm: {m['name']} ready in {secs:.1f}s")
            print("  The spirit is awake. Ask your question.\n")
        except Exception as e:  # noqa: BLE001
            WARM["state"] = "error"
            log(f"warm failed: {e}")

    threading.Thread(target=warm, daemon=True).start()
    threading.Thread(target=job_runner, daemon=True).start()
    threading.Thread(target=make_all_sfx, daemon=True).start()
    if "--no-browser" not in sys.argv:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
