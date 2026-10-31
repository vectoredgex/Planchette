import { Board, HAND_COLORS } from "./board3d.js";
import { Sound } from "./audio.js";

const $ = (id) => document.getElementById(id);
// report browser errors to the server log, so problems can be diagnosed remotely
const report = (msg) => { try { fetch("api/clientlog", { method: "POST", body: JSON.stringify({ msg }) }); } catch {} };
addEventListener("error", (e) => report(`error: ${e.message} at ${e.filename}:${e.lineno}`));
addEventListener("unhandledrejection", (e) => report(`unhandled: ${e.reason && (e.reason.stack || e.reason)}`));
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const store = {
  get(k, d) { try { const v = localStorage.getItem("planchette." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("planchette." + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const sound = new Sound();
const board = new Board($("board"), {
  reducedMotion: reduced,
  onMove: (v) => sound.move(v),
  onLand: (step) => { sound.knock(0.6 + Math.min(0.6, step.entropy / 3)); addCell(step); caption(""); },
  onTorn: (x) => sound.torn(x),
});

const EXAMPLES = {
  wanderer: ["What happened in this house?", "How did you die?", "What is your name?"],
  abuela: ["What do you want to tell me?", "Are you proud of me?", "What food should I leave on the ofrenda?"],
  daemon: ["Are you watching me right now?", "What is my biggest secret?", "What did I delete last night?"],
};

const S = {
  status: null, staticMode: false,
  persona: store.get("persona", "wanderer"),
  hands: store.get("hands", null),
  temp: 1.0,
  sound: true,
  numbers: store.get("numbers", true),
  busy: false, es: null, sid: null, steps: [],
  asked: 0, idleDone: false, refused: false, lastTouch: performance.now(),
};

// ------------------------------------------------------------------ startup
(async function boot() {
  try { await board.init(); } catch (e) { notice(esc(e.message)); }
  sound.setOn(S.sound);
  board.showNumbers = true;
  try {
    const r = await fetch("api/status", { cache: "no-store" });
    if (!r.ok) throw new Error(String(r.status));
    S.status = await r.json();
  } catch { S.staticMode = true; }
  if (S.staticMode) return bootStatic();

  renderPersonas();
  if (!S.status.ollama) notice(`The spirits can't reach Ollama. Start Ollama, then reload this page.`);
  else if (!S.status.models.length) notice("Ollama has no models yet. Run <code>ollama pull gemma3</code>, then reload.");
  const names = S.status.models.map((m) => m.name);
  const lead = (S.status.default || [])[0];
  if (lead) $("explain").textContent = `${prettyModel(lead)} moves the planchette with its real odds for every letter. When it hesitates, the model is truly torn.`;
  if (!S.hands || !S.hands.some((h) => names.includes(h))) S.hands = S.status.default;
  S.hands = S.hands.filter((h) => names.includes(h));
  renderHands();
  if (S.status.voice && navigator.mediaDevices && window.MediaRecorder) $("mic").hidden = false;
  report(`page ready: elevenlabs=${!!S.status.voice} sfx=${(S.status.sfx || []).length}`);
  if (S.status.voice || (S.status.sfx || []).length)
    sound.load(["room", "music", "whisper", "knock", "gust", "creak", "strike", "breath"])
      .then((got) => report(`sounds: ${got.length ? got.join(",") : "built-in only"}`));
  setInterval(idleCheck, 1000);
  // several models at once is an advanced mode: open the page with ?models to use it
  $("advanced").hidden = !new URLSearchParams(location.search).has("models");
  $("q").focus();
  $("hint").textContent = "Ask the spirit a question, or choose one below.";
  watchWaking();
})();

// Gemma takes ~30s to load the first time. Show it, so the board never looks frozen.
async function watchWaking() {
  let st = S.status.warm;
  if (st !== "warming" && st !== "cold") return;
  board.jitter = 0.5;
  $("hint").textContent = "The spirit is waking up. The first time, the model takes about half a minute to load.";
  while (st === "warming" || st === "cold") {
    await sleep(1500);
    try { st = (await (await fetch("api/status", { cache: "no-store" })).json()).warm; } catch { break; }
  }
  if (!S.busy) { board.jitter = 0; $("hint").textContent = "The spirit is awake. Ask it a question."; }
}

async function bootStatic() {
  $("q").disabled = true; $("askBtn").hidden = true;
  $("q").placeholder = "Watch a recorded séance below";
  $("hint").textContent = "These are real séances recorded with Gemma running on a laptop. To ask your own question, run Planchette on your computer.";
  $("examples").hidden = true;
  $("personas").hidden = true; $("advanced").hidden = true;
  try {
    const list = await (await fetch("recordings/index.json")).json();
    const ul = $("recs");
    for (const r of list) {
      const li = document.createElement("li"), b = document.createElement("button");
      b.type = "button";
      b.innerHTML = `${esc(r.question)}<span class="a">${esc(r.answer)}</span>`;
      b.onclick = async () => replay(await (await fetch(`recordings/${r.file}`)).json());
      li.append(b); ul.append(li);
    }
    ul.hidden = !list.length;
  } catch { /* nothing recorded */ }
}

// ------------------------------------------------------------------ settings
const SPIRIT_ICONS = {
  wanderer: '<path d="M11 9h10l2 4v11a3 3 0 0 1-3 3h-8a3 3 0 0 1-3-3V13z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M13 9V7a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M16 15c2 2 2 5 0 7-2-2-2-5 0-7z" fill="currentColor"/>',
  abuela: '<g fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="16" cy="9" r="3.4"/><circle cx="16" cy="23" r="3.4"/><circle cx="9" cy="16" r="3.4"/><circle cx="23" cy="16" r="3.4"/><circle cx="11" cy="11" r="3.2"/><circle cx="21" cy="11" r="3.2"/><circle cx="11" cy="21" r="3.2"/><circle cx="21" cy="21" r="3.2"/></g><circle cx="16" cy="16" r="3.2" fill="currentColor"/>',
  daemon: '<rect x="6" y="7" width="20" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12 25h8M16 21v4" stroke="currentColor" stroke-width="1.5"/><path d="M13 18v-5a3 3 0 0 1 6 0v5l-1-1-1 1-1-1-1 1-1-1z" fill="currentColor"/>',
};
const SPIRIT_LINES = {
  wanderer: "A lost soul trapped in the board",
  abuela: "A grandmother home for Día de los Muertos",
  daemon: "The spirit inside your computer",
};

function renderPersonas() {
  const box = $("personas");
  box.innerHTML = "";
  for (const [key, p] of Object.entries(S.status.personas)) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "spirit"; b.setAttribute("role", "radio"); b.dataset.key = key; b.title = p.blurb;
    b.innerHTML = `<svg viewBox="0 0 32 32" aria-hidden="true">${SPIRIT_ICONS[key] || SPIRIT_ICONS.wanderer}</svg><span class="txt"><span class="n">${esc(p.name)}</span><span class="d">${esc(SPIRIT_LINES[key] || p.blurb)}</span></span>`;
    b.onclick = () => { if (!S.busy) { S.persona = key; store.set("persona", key); sync(); } };
    const wrap = document.createElement("span");
    wrap.className = "spirit-wrap";
    wrap.append(b);
    box.append(wrap);
  }
  if (!S.status.personas[S.persona]) S.persona = "wanderer";
  const sync = () => {
    for (const w of box.children) {
      const b = w.firstElementChild, on = b.dataset.key === S.persona;
      b.setAttribute("aria-checked", String(on));
      w.classList.toggle("on", on);
    }
    renderExamples();
  };
  sync();
}

function renderExamples() {
  const box = $("examples");
  box.innerHTML = "";
  for (const q of EXAMPLES[S.persona] || EXAMPLES.wanderer) {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = q;
    b.onclick = () => { if (!S.busy) { $("q").value = q; ask(q); } };
    box.append(b);
  }
}

function renderHands() {
  const box = $("hands");
  box.innerHTML = "";
  for (const m of S.status.models) {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = m.name;
    b.setAttribute("aria-pressed", String(S.hands.includes(m.name)));
    const i = S.hands.indexOf(m.name);
    if (i >= 0 && S.hands.length > 1) b.style.textDecorationColor = HAND_COLORS[i % HAND_COLORS.length];
    b.onclick = () => {
      if (S.busy) return;
      if (S.hands.includes(m.name)) { if (S.hands.length > 1) S.hands = S.hands.filter((h) => h !== m.name); }
      else if (S.hands.length < 4) S.hands = [...S.hands, m.name];
      store.set("hands", S.hands); renderHands();
    };
    box.append(b);
  }
}

for (const t of ["keydown", "pointerdown", "input"]) addEventListener(t, () => { S.lastTouch = performance.now(); }, true);
// browsers only allow sound after the first click or key: the room and its music start then
for (const t of ["pointerdown", "keydown"]) addEventListener(t, () => sound.start(), { once: true, capture: true });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") return letGo();
  // M mutes the room (there is no button: the page stays clean)
  if (e.target.tagName !== "INPUT" && (e.key === "m" || e.key === "M")) { S.sound = !S.sound; store.set("sound", S.sound); sound.setOn(S.sound); }
  // F toggles full screen (handy for recording)
  if (e.target.tagName !== "INPUT" && (e.key === "f" || e.key === "F")) {
    if (document.fullscreenElement) document.exitFullscreen?.(); else document.documentElement.requestFullscreen?.().catch(() => {});
  }
});
$("ask").onsubmit = (e) => { e.preventDefault(); if (S.busy) return letGo(); ask($("q").value.trim()); };
$("byeBtn").onclick = goodbye;

// ------------------------------------------------------------------ the séance
async function ask(q, idle = false) {
  // idle: "idle" (it speaks on its own) or "refused" (it explains why you can't leave)
  if ((!q && !idle) || S.staticMode || S.busy) return;
  while (S.leaving) await sleep(100);
  if (S.busy) return;
  if (!S.status?.ollama) return notice("Start Ollama first, then reload this page.");
  sound.start();
  if (!idle) { S.asked++; S.idleDone = false; S.refused = false; }
  S.mode = idle || "";
  begin(idle);
  const url = `api/seance?${idle ? `${idle === "refused" ? "refused" : "idle"}=1&q=-` : "q=" + encodeURIComponent(q)}&persona=${encodeURIComponent(S.persona)}&temp=${S.temp}&spirits=${encodeURIComponent(S.hands.join(","))}`;
  const es = (S.es = new EventSource(url));
  const queue = [];
  let ended = false;
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === "hello") S.sid = ev.id;
    queue.push(ev);
    if (ev.type === "done" || ev.type === "error") { ended = true; es.close(); }
  };
  es.onerror = () => {
    if (!ended) { ended = true; queue.push({ type: "error", message: "Lost contact with Planchette. Is its window still open?" }); }
    es.close();
  };
  consume(() => queue.shift(), () => ended && queue.length === 0);
}

function replay(rec, idle = false) {
  if (S.busy) return;
  sound.start();
  $("q").value = idle ? "" : rec.question || "";
  begin(idle);
  const evs = rec.events.filter((e) => e.type !== "hello");
  consume(() => evs.shift(), () => evs.length === 0, { replay: true });
}

function begin(idle = false) {
  S.busy = true; S.steps = [];
  if (board.dark) { board.relight(); sound.strike(); }
  for (const b of $("examples").children) b.disabled = true;
  $("cells").innerHTML = ""; $("cells").className = "cells";
  $("hint").textContent = idle === "refused" ? "It won't let you go…" : idle ? "Nobody touched it. The planchette is moving on its own…" : "The planchette is moving…";
  if (idle) { $("q").value = ""; }
  $("byeBtn").hidden = true;
  $("askBtn").textContent = "Let go";
  board.fadeEmbers();
  hideNotice();
  caption("");
}

async function consume(next, finished, opts = {}) {
  let spirits = [];
  let waited = 0, first = true, first_hint_done = false;
  board.jitter = 0.45;
  while (true) {
    const ev = next();
    if (!ev) {
      if (finished() || !S.busy) break;
      if (waited % 1000 === 200) board.seek(true);
      await sleep(25);
      waited += 25;
      if (first && waited === 4000 && !first_hint_done) $("hint").textContent = "The spirit is waking up. The first answer can take up to a minute.";
      continue;
    }
    board.seek(false);
    waited = 0;
    if (ev.type === "step" && first) { first = false; $("hint").textContent = ""; }
    if (!S.busy && !opts.replay) break;
    if (ev.type === "begin") spirits = ev.spirits || [];
    else if (ev.type === "step") {
      S.steps.push(ev);
      caption(tornLine(ev));
      await board.play(ev);
      if (ev.chosen === "_") addGap();
    } else if (ev.type === "done") { await finish(ev, spirits); break; }
    else if (ev.type === "error") { notice(esc(ev.message)); $("hint").textContent = ""; break; }
  }
  end();
}

async function finish(ev, spirits) {
  const text = (ev.text || "").trim();
  if (text && ev.reason !== "cancelled") board.flareAll();
  const firstWord = text.split(" ")[0];
  if (firstWord === "YES" || firstWord === "NO") {
    if (text === firstWord) $("cells").classList.add("yesno");
    await board.glideTo(firstWord, 300);   // a yes/no answer ends resting on YES or NO
  }
  const letters = S.steps.filter((s) => s.chosen !== "_" && s.chosen !== "#");
  let line = "";
  if (letters.length) {
    const torn = letters.reduce((m, s) => (topP(s) < topP(m) ? s : m), letters[0]);
    const alt = torn.dist.find(([k]) => k !== torn.chosen && k !== "_" && k !== "#");
    const pc = Math.round(probOf(torn, torn.chosen) * 100), pa = alt ? Math.round(alt[1] * 100) : 0;
    if (alt && topP(torn) < 0.85) line = pa > pc
      ? `It defied the odds: it chose ${torn.chosen} (${pc}%) over the likelier ${alt[0]} (${pa}%).`
      : `It almost said ${alt[0]} instead of ${torn.chosen} (${pa}% against ${pc}%).`;
    else line = "It never hesitated.";
  }
  if (ev.reason === "cancelled") line = "You let go of the planchette.";
  if (S.mode === "refused" && ev.reason !== "cancelled") line = S.refusedLine || line;
  $("hint").textContent = line;
  $("byeBtn").textContent = S.refused && S.mode === "refused" ? "Say goodbye again" : "Say goodbye";
  $("byeBtn").hidden = false;
}

function end() {
  S.busy = false; S.es = null;
  for (const b of $("examples").children) b.disabled = false;
  $("askBtn").textContent = "Ask";
  board.clearThinking();
  sound.torn(0);
  caption("");
  S.lastTouch = performance.now();
}

function letGo() {
  if (!S.busy) return;
  if (S.sid) fetch("api/cancel", { method: "POST", body: JSON.stringify({ id: S.sid }) }).catch(() => {});
  if (S.es) S.es.close();
  S.busy = false;
  $("hint").textContent = "You let go of the planchette.";
}

async function goodbye() {
  if (S.busy || S.leaving) return;
  $("byeBtn").hidden = true;
  sound.start();
  S.leaving = true;
  // the spirit is asked, for real, whether it lets you go. It can refuse once.
  let no = 0;
  if (!S.refused && S.status?.ollama) {
    $("hint").textContent = "You move the planchette toward GOODBYE…";
    board.jitter = 0.5;
    try {
      const d = await (await fetch("api/consent", { method: "POST", body: JSON.stringify({ persona: S.persona, spirits: S.hands }) })).json();
      no = d.no || 0;
    } catch { /* let them go */ }
    board.jitter = 0.18;
  }
  if (!S.refused && Math.random() < no) {
    S.refused = true;
    $("hint").textContent = "You move the planchette toward GOODBYE…";
    await board.creep("GOODBYE", 0.7, 1500);     // it goes most of the way… and stops
    sound.breath();
    board.refuse();                               // the candles gutter, the room goes cold
    await board.wait(700);
    await board.lunge("NO");                      // and it drags itself back to NO
    sound.knock(1.4);
    S.refusedLine = `It won't let you go. ${prettyModel(S.hands[0] || "")} was ${Math.round(no * 100)}% sure it wants you to stay.`;
    $("hint").textContent = S.refusedLine;
    S.leaving = false;
    await sleep(1600);
    await ask("", "refused");                    // then it tells you why
    S.lastTouch = performance.now();
    return;
  }
  await board.glideTo("GOODBYE", 600);
  sound.blow();
  await board.blowOut();
  board.fadeEmbers();
  $("hint").textContent = S.refused ? "It let go, this time. Ask again to call it back." : "The spirit is gone. Ask again to call it back.";
  await board.glideTo("_", 0);
  // …almost gone: in the dark, one last knock, and the planchette twitches on its own
  await sleep(2600);
  if (board.dark && !S.busy) { sound.knock(0.9); board.twitch(); }
  S.leaving = false; S.idleDone = true;
}

// Leave the board alone after an answer, and the planchette starts moving by itself:
// a real séance where the question is your silence. Once per question.
function idleCheck() {
  if (S.busy || S.leaving || S.idleDone || !S.asked || S.staticMode || board.dark || document.hidden) return;
  if (!S.status?.ollama) return;
  if (performance.now() - S.lastTouch < 22000) return;
  S.idleDone = true;
  report("idle: the planchette moves on its own");
  sound.creak();
  setTimeout(() => { if (!S.busy) ask("", "idle"); }, 1400);
}

// ------------------------------------------------------------------ rendering
function currentWord() {
  const cells = $("cells");
  let w = cells.lastElementChild;
  if (!w || w.dataset.closed) { w = document.createElement("span"); w.className = "word"; cells.append(w); }
  return w;
}
function addCell(step) {
  const cell = document.createElement("span");
  cell.className = "cell";
  const alts = step.dist.filter(([k, p]) => k !== step.chosen && k !== "_" && k !== "#" && p >= 0.04).slice(0, 2);
  cell.innerHTML = `<span class="ch">${esc(step.chosen)}</span>`;
  cell.title = `${step.chosen}: ${Math.round(probOf(step, step.chosen) * 100)}%` + alts.map(([k, p]) => `, ${k}: ${Math.round(p * 100)}%`).join("");
  currentWord().append(cell);
}
function addGap() { const w = $("cells").lastElementChild; if (w) w.dataset.closed = "1"; }

// ------------------------------------------------------------------ ask out loud (ElevenLabs speech to text)
(() => {
  const mic = $("mic");
  let rec = null, chunks = [];
  const start = async (e) => {
    e.preventDefault();
    if (S.busy || rec) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      rec = new MediaRecorder(stream); chunks = [];
      rec.ondataavailable = (ev) => chunks.push(ev.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        mic.classList.remove("rec");
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        rec = null;
        if (blob.size < 2000) return;
        $("q").value = "…";
        try {
          const d = await (await fetch("api/listen", { method: "POST", headers: { "Content-Type": blob.type }, body: blob })).json();
          if (d.text) { $("q").value = d.text; ask(d.text); } else { $("q").value = ""; notice(esc(d.error || "The spirit could not hear you.")); }
        } catch { $("q").value = ""; }
      };
      rec.start(); mic.classList.add("rec");
    } catch { notice("Microphone access was blocked. Type your question instead."); }
  };
  const stop = () => { if (rec && rec.state === "recording") rec.stop(); };
  mic.addEventListener("pointerdown", start);
  mic.addEventListener("pointerup", stop);
  mic.addEventListener("pointerleave", stop);
})();

// handles for recorded playback (the static demo site and the demo video)
window.planchette = { replay, goodbye, S, board, sound };

// ------------------------------------------------------------------ helpers
function prettyModel(n) {
  const base = n.split(":")[0];
  if (base.startsWith("gemma")) return "Gemma";
  if (base.startsWith("qwen")) return "Qwen";
  if (base.startsWith("llama")) return "Llama";
  return base;
}
function topP(s) { return (s.dist.find(([k]) => k !== "#") || [0, 0])[1]; }
function probOf(s, sym) { return (s.dist.find(([k]) => k === sym) || [0, 0])[1]; }
function listNames(a) { return a.length <= 1 ? (a[0] || "the model") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]; }
// the live caption: while the model is torn, the hint line says between what
function caption(t) {
  const h = $("hint");
  if (t) { h.textContent = t; h.classList.add("torn"); }
  else if (h.classList.contains("torn")) { h.classList.remove("torn"); if (S.busy) h.textContent = ""; }
}
function tornLine(ev) {
  const d = ev.dist.filter(([k]) => k !== "#" && k !== "_");
  if (ev.chosen === "_" || ev.chosen === "#" || d.length < 2) return "";
  if (d[0][1] > 0.85 || d[1][1] < 0.08) return "";
  const parts = d.slice(0, 3).filter(([, p], i) => i < 2 || p >= 0.08).map(([k, p]) => `${k} (${Math.round(p * 100)}%)`);
  return `Torn between ${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}…`;
}
function press(btn, on) { btn.setAttribute("aria-pressed", String(on)); }
function notice(html) { const n = $("notice"); n.innerHTML = html; n.hidden = false; }
function hideNotice() { $("notice").hidden = true; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
