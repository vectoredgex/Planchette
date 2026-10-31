"""Build a static, model-free copy of the board that replays recorded séances.

    python tools/export_static.py            -> dist/

Upload dist/ to any static host (GitHub Pages, a .tech domain, Render static
site). Visitors watch real séances recorded on your machine, probabilities and
all, without needing a model.
"""
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"

if DIST.exists():
    shutil.rmtree(DIST)
shutil.copytree(ROOT / "web", DIST)
rec_dir = DIST / "recordings"
rec_dir.mkdir()
index = []
for f in sorted((ROOT / "seances").glob("*.json"), reverse=True):
    d = json.loads(f.read_text(encoding="utf-8"))
    if not d.get("answer"):
        continue
    shutil.copy(f, rec_dir / f.name)
    index.append({"file": f.name, "question": d.get("question"), "answer": d.get("answer"),
                  "spirits": d.get("spirits"), "persona": d.get("persona")})
(rec_dir / "index.json").write_text(json.dumps(index, indent=1), encoding="utf-8")
print(f"dist/ ready with {len(index)} recorded seances")
