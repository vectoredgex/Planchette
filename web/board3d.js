// The séance in 3D: a black lacquered board on a velvet table, lit by candles.
// Every movement of the planchette comes from the model's probabilities.
import * as THREE from "three";

export const BW = 1200, BH = 780;
export const HAND_COLORS = ["#cfe9e4", "#d9cdf5", "#f5cdd9", "#d6ecc4"];

const BONE = [233, 222, 200];
const MARIGOLD = [255, 168, 48];
const GHOST = [200, 245, 238];
const BG = 0x150d1c;
const LETTER_FONT = '"Marcellus SC", "Cinzel", Georgia, serif';
const TEXT_FONT = '"IM Fell DW Pica", Georgia, serif';

const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a))})`;
function hash(n) { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); }
function noise1(t) { const i = Math.floor(t), f = t - i, u = f * f * (3 - 2 * f); return hash(i) * (1 - u) + hash(i + 1) * u; }
function mulberry(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// board pixels -> world units (the board is 12 x 7.8, its top surface at y = 0)
const wx = (px) => (px - 600) / 100;
const wz = (py) => (py - 390) / 100;

export function layout() {
  const pos = {};
  const C = { x: 600, y: 1250 };
  const row = (chars, R, span, size) => {
    chars.forEach((c, i) => {
      const a = ((-span + (2 * span * i) / (chars.length - 1)) * Math.PI) / 180;
      pos[c] = { x: C.x + R * Math.sin(a), y: C.y - R * Math.cos(a), rot: a, size };
    });
  };
  row("ABCDEFGHIJKLM".split(""), 900, 30, 74);
  row("NOPQRSTUVWXYZ".split(""), 772, 29, 66);
  "1234567890".split("").forEach((c, i) => (pos[c] = { x: 330 + i * 60, y: 652, rot: 0, size: 46 }));
  pos.YES = { x: 210, y: 134, rot: 0, size: 52, word: true };
  pos.NO = { x: 990, y: 134, rot: 0, size: 52, word: true };
  pos.GOODBYE = { x: 600, y: 728, rot: 0, size: 42, word: true };
  pos._ = { x: 600, y: 250, rot: 0 };
  pos["#"] = pos._;
  return pos;
}

function heartPath(ctxOrShape, s = 1) {
  // the planchette outline in board pixels around its lens centre
  const p = ctxOrShape;
  p.moveTo(0 * s, -74 * s);
  p.bezierCurveTo(44 * s, -60 * s, 90 * s, 6 * s, 78 * s, 60 * s);
  p.bezierCurveTo(68 * s, 98 * s, 28 * s, 106 * s, 0, 93 * s);
  p.bezierCurveTo(-28 * s, 106 * s, -68 * s, 98 * s, -78 * s, 60 * s);
  p.bezierCurveTo(-90 * s, 6 * s, -44 * s, -60 * s, 0, -74 * s);
}

export class Board {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.pos = layout();
    this.reduced = !!opts.reducedMotion;
    this.onMove = opts.onMove || (() => {});
    this.onLand = opts.onLand || (() => {});
    this.onTorn = opts.onTorn || (() => {});
    this.P = { x: 600, y: 250, vx: 0, vy: 0, rot: -0.03, vr: 0 };
    this.target = { x: 600, y: 250 };
    this.k = 14; this.zeta = 0.9; this.jitter = 0;
    this.embers = {};
    this.ghosts = [];
    this.threads = [];
    this.trail = [];
    this.flash = null;
    this.showNumbers = true;
    this.t = 0;
    this.ready = false;
    this.room = 0; this.roomTarget = 0;      // overall light, 0 = dark room
    this.torn = 0; this.tornTarget = 0;      // how split the model is right now
    this.flareAmt = 0;
    this.dark = false;
  }

  async init() {
    try {
      await Promise.all([
        document.fonts.load(`80px ${LETTER_FONT}`),
        document.fonts.load(`italic 30px ${TEXT_FONT}`),
        document.fonts.load(`italic 600 32px "Fraunces"`),
      ]);
    } catch (_) { /* fall back */ }
    try {
      this.build();
    } catch (e) {
      console.error(e);
      throw new Error("This browser could not start 3D graphics (WebGL).");
    }
    this.ready = true;
    this.resize();
    window.addEventListener("resize", () => this.resize());
    if (window.ResizeObserver) new ResizeObserver(() => this.resize()).observe(this.canvas.parentElement);
    this._last = this._t0 = performance.now();
    this.renderer.setAnimationLoop((t) => this.frame(t));
    this.intro();
  }

  // ------------------------------------------------------------------ scene
  build() {
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: "high-performance" }));
    r.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.setClearColor(BG, 1);

    const scene = (this.scene = new THREE.Scene());
    scene.background = new THREE.Color(BG);
    scene.fog = new THREE.Fog(BG, 15, 30);
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    this.camBase = new THREE.Vector3(0, 10.5, 10.2);
    this.lookAt = new THREE.Vector3(0, -0.6, 0.6);

    // --- the board's face is painted in code; what glows is painted every frame
    this.colorCanvas = this.paintBoard();
    this.colorTex = new THREE.CanvasTexture(this.colorCanvas);
    this.colorTex.colorSpace = THREE.SRGBColorSpace;
    this.colorTex.anisotropy = r.capabilities.getMaxAnisotropy();
    this.glowCanvas = document.createElement("canvas");
    this.glowCanvas.width = 1200; this.glowCanvas.height = 780;
    this.glowCtx = this.glowCanvas.getContext("2d");
    this.lettersOnly = this.paintLetters();
    this.glowTex = new THREE.CanvasTexture(this.glowCanvas);
    this.glowTex.colorSpace = THREE.SRGBColorSpace;

    // --- the table: a faceted velvet cloth, folds catching the light
    const cloth = new THREE.PlaneGeometry(44, 30, 44, 30).toNonIndexed();
    cloth.rotateX(-Math.PI / 2);
    const cp = cloth.attributes.position;
    for (let i = 0; i < cp.count; i++) {
      const x = cp.getX(i), z = cp.getZ(i);
      const inBoard = Math.abs(x) < 6.6 && Math.abs(z) < 4.5;
      const h = 0.11 * Math.sin(x * 0.9 + z * 0.4) + 0.08 * Math.sin(z * 1.3 - x * 0.3) + (hash(Math.round(x * 3) * 31 + Math.round(z * 3)) - 0.5) * 0.12;
      cp.setY(i, inBoard ? -0.04 : h);
    }
    cloth.computeVertexNormals();
    const table = new THREE.Mesh(cloth, new THREE.MeshStandardMaterial({ color: 0x5a1f3e, roughness: 0.92, flatShading: true }));
    table.position.y = -0.3;
    table.receiveShadow = true;
    scene.add(table);

    // --- the board: an ebony slab with chamfered, faceted edges
    const side = new THREE.MeshStandardMaterial({ color: 0x2a1a14, roughness: 0.6, flatShading: true });
    const top = (this.top = new THREE.MeshStandardMaterial({ map: this.colorTex, emissiveMap: this.glowTex, emissive: 0xffffff, emissiveIntensity: 1.25, roughness: 0.72 }));
    const board = new THREE.Mesh(new RoundedSlab(12, 7.8, 0.3, 0.34, 2), [top, side]);
    board.receiveShadow = true;
    board.castShadow = true;
    scene.add(board);

    // --- the planchette
    this.planchette = this.makePlanchette();
    scene.add(this.planchette);
    this.lens = this.makeLens();
    scene.add(this.lens.group);

    // --- candles
    this.candles = [
      this.makeCandle(-7.0, 2.35, 1.7, 0),
      this.makeCandle(6.95, -2.6, 2.4, 1),
      this.makeCandle(7.55, -1.3, 1.2, 2),
    ];
    this.candles.forEach((c) => scene.add(c.group));

    // --- marigolds (cempasúchil) for the dead, and loose petals on the cloth
    this.flowers = [];
    this._petals = [[], [], [], []];
    for (const [x, z, s] of [[-7.4, 0.9, 1.1], [-7.9, 3.2, 0.85], [-6.6, 4.3, 0.75], [7.6, 0.4, 1.0], [8.1, -2.2, 0.8], [6.6, 4.4, 0.9], [-6.9, -3.6, 0.8], [-2.8, 4.75, 0.6], [3.1, 4.8, 0.65], [7.9, 2.6, 0.7]]) {
      const f = this.makeMarigold(x, z, s);
      this.flowers.push(f);
      scene.add(f);
    }
    // all marigold petals drawn in four batches (one per colour): cheap for any graphics chip
    const cols = [0xe86a12, 0xff8f1f, 0xffa82e, 0xffc24a];
    const petalGeo = new THREE.IcosahedronGeometry(0.11, 0);
    this._petals.forEach((list, k) => {
      const mat = new THREE.MeshStandardMaterial({ color: cols[k], roughness: 0.65, flatShading: true, emissive: 0x401400, emissiveIntensity: 0.35 });
      const inst = new THREE.InstancedMesh(petalGeo, mat, list.length);
      list.forEach((m, i) => inst.setMatrixAt(i, m));
      scene.add(inst);
    });
    scene.add(this.makePetals());

    // --- light: cool moonlight from behind, warm candlelight in front
    const hemi = (this.hemi = new THREE.HemisphereLight(0x8a78c8, 0x1c0a16, 1.0));
    scene.add(hemi);
    const moon = (this.moon = new THREE.DirectionalLight(0x9db0ff, 1.6));
    moon.position.set(-5, 9, -9);
    scene.add(moon);
    const key = (this.key = new THREE.SpotLight(0xffd9b0, 110, 30, 0.62, 0.9, 2));
    key.position.set(-1, 11, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.bias = -0.0008;
    key.shadow.radius = 6;
    scene.add(key, key.target);

    this.dust = this.makeDust();
    scene.add(this.dust);
    this.makeEffects();
  }

  // ------------------------------------------------------------------ effects
  makeEffects() {
    // sparks that burst from a letter when the spirit chooses it
    const sparkGeo = new THREE.TetrahedronGeometry(0.035, 0);
    this.sparks = [];
    for (let i = 0; i < 90; i++) {
      const m = new THREE.Mesh(sparkGeo, new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      m.visible = false;
      this.scene.add(m);
      this.sparks.push({ m, life: 0, v: new THREE.Vector3() });
    }
    // smoke rising from the flames
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d");
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, "rgba(220,210,230,0.7)");
    gr.addColorStop(1, "rgba(220,210,230,0)");
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    this.smoke = [];
    for (let i = 0; i < 70; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false, color: 0xc8bcd8 }));
      sp.visible = false;
      this.scene.add(sp);
      this.smoke.push({ sp, life: 0, v: new THREE.Vector3(), strength: 1 });
    }
    this._smokeClock = 0;
  }

  spark(sym) {
    const p = this.pos[sym];
    if (!p || this.reduced) return;
    let n = 16;
    for (const s of this.sparks) {
      if (s.life > 0) continue;
      s.life = 1;
      s.m.visible = true;
      s.m.position.set(wx(p.x) + (Math.random() - 0.5) * 0.3, 0.05, wz(p.y) + (Math.random() - 0.5) * 0.2);
      const a = Math.random() * Math.PI * 2, sp = 0.6 + Math.random() * 1.4;
      s.v.set(Math.cos(a) * sp * 0.6, 1.4 + Math.random() * 1.8, Math.sin(a) * sp * 0.4);
      s.m.rotation.set(Math.random() * 6, Math.random() * 6, 0);
      if (--n <= 0) break;
    }
  }

  puff(c, strength = 1) {
    for (const s of this.smoke) {
      if (s.life > 0) continue;
      s.life = 1;
      s.strength = strength;
      s.sp.visible = true;
      s.sp.position.set(c.x + (Math.random() - 0.5) * 0.05, c.fy + 0.25, c.z + (Math.random() - 0.5) * 0.05);
      s.v.set((Math.random() - 0.5) * 0.12, 0.45 + Math.random() * 0.3 + (strength > 1 ? 0.4 : 0), (Math.random() - 0.5) * 0.12);
      s.sp.scale.setScalar(0.15);
      return;
    }
  }

  // ------------------------------------------------------------------ moments
  async intro() {
    if (this.reduced) {
      this.room = this.roomTarget = 1;
      for (const c of this.candles) c.lit = c.litTarget = 1;
      return;
    }
    // the room is dark; the candles catch one by one; then the board wakes
    this.roomTarget = 0.12;
    await this.wait(500);
    for (const c of this.candles) {
      c.litTarget = 1;
      c.strike = 1;
      await this.wait(520);
    }
    this.roomTarget = 1;
  }

  flareAll() { this.flareAmt = 1; }

  async blowOut() {
    this.dark = true;
    for (const c of [...this.candles].reverse()) {
      c.litTarget = 0;
      for (let i = 0; i < 9; i++) setTimeout(() => this.puff(c, 2.2), i * 70);
      await this.wait(this.reduced ? 0 : 480);
    }
    this.roomTarget = 0.22;
    for (const k of Object.keys(this.embers)) this.embers[k] = 0;
  }

  async relight() {
    if (!this.dark) return;
    this.dark = false;
    this.roomTarget = 1;
    for (const c of this.candles) {
      c.litTarget = 1;
      c.strike = 1;
      await this.wait(this.reduced ? 0 : 220);
    }
  }

  makeMarigold(x, z, s) {
    // a cempasúchil is a dome of ruffled petals: faceted shards on a half-sphere
    const g = new THREE.Group();
    g.position.set(x, -0.28, z);
    g.scale.setScalar(s * 1.3);
    g.rotation.y = hash(x * 13 + z) * 6.3;
    g.updateMatrixWorld(true);
    const dummy = new THREE.Object3D();
    const rnd = mulberry(Math.round(x * 100 + z * 7));
    const n = 46;
    for (let i = 0; i < n; i++) {
      // golden-angle spiral over the upper hemisphere
      const t = i / n, phi = Math.acos(1 - t * 0.95), th = i * 2.39996;
      const r0 = 0.32;
      const px = Math.sin(phi) * Math.cos(th) * r0, py = Math.cos(phi) * r0 * 0.8, pz = Math.sin(phi) * Math.sin(th) * r0;
      const k = Math.min(3, Math.floor((1 - t) * 3.2 + rnd() * 0.8));
      dummy.position.set(px, 0.1 + py, pz);
      dummy.scale.set(0.9 + rnd() * 0.3, 0.45, 1.25);
      dummy.lookAt(px * 3, 0.1 + py * 3 + 0.2, pz * 3);
      dummy.updateMatrix();
      this._petals[k].push(new THREE.Matrix4().multiplyMatrices(g.matrixWorld, dummy.matrix));
    }
    // two leaves beneath
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x2f5a2a, roughness: 0.8, flatShading: true });
    for (let k = 0; k < 2; k++) {
      const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.6, 3), leafMat);
      leaf.rotation.set(Math.PI / 2, 0, k * 2.4 + 0.6);
      leaf.position.set(Math.cos(k * 2.4) * 0.3, 0.02, Math.sin(k * 2.4) * 0.3);
      leaf.scale.set(1, 1, 0.3);
      g.add(leaf);
    }
    return g;
  }

  makePetals() {
    const g = new THREE.Group();
    const geo = new THREE.TetrahedronGeometry(0.09, 0);
    const mats = [0xff8c1a, 0xffa424, 0xe8701a].map((c) => new THREE.MeshStandardMaterial({ color: c, flatShading: true, roughness: 0.7 }));
    const rnd = mulberry(321);
    for (let i = 0; i < 70; i++) {
      let x, z;
      do { x = (rnd() - 0.5) * 19; z = (rnd() - 0.5) * 12; } while (Math.abs(x) < 6.3 && Math.abs(z) < 4.1);
      const m = new THREE.Mesh(geo, mats[i % 3]);
      m.position.set(x, -0.27, z);
      m.scale.set(1, 0.3, 1.4);
      m.rotation.y = rnd() * 6.3;
      g.add(m);
    }
    return g;
  }

  paintBoard() {
    const S = 2;
    const c = document.createElement("canvas");
    c.width = BW * S; c.height = BH * S;
    const g = c.getContext("2d");
    g.scale(S, S);
    const rnd = mulberry(4242);
    const base = g.createRadialGradient(600, 330, 40, 600, 390, 820);
    base.addColorStop(0, "#2a1d18");
    base.addColorStop(0.6, "#1e1511");
    base.addColorStop(1, "#150e0b");
    g.fillStyle = base;
    g.fillRect(0, 0, BW, BH);
    for (let i = 0; i < 200; i++) {
      const y0 = rnd() * (BH + 60) - 30, amp = 2 + rnd() * 8, fr = 0.002 + rnd() * 0.005, ph = rnd() * 7;
      g.beginPath();
      for (let x = -10; x <= BW + 10; x += 14) {
        const y = y0 + Math.sin(x * fr + ph) * amp + Math.sin(x * fr * 2.7 + ph * 1.3) * amp * 0.35;
        x === -10 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.strokeStyle = rnd() < 0.5 ? `rgba(140,100,70,${0.01 + rnd() * 0.02})` : `rgba(0,0,0,${0.03 + rnd() * 0.05})`;
      g.lineWidth = 0.5 + rnd() * 2;
      g.stroke();
    }
    // inlaid border with corner flourishes
    g.strokeStyle = rgba(BONE, 0.42); g.lineWidth = 1.6;
    g.beginPath(); g.roundRect(34, 34, BW - 68, BH - 68, 16); g.stroke();
    g.strokeStyle = rgba(BONE, 0.2); g.lineWidth = 1;
    g.beginPath(); g.roundRect(44, 44, BW - 88, BH - 88, 11); g.stroke();
    g.fillStyle = rgba(BONE, 0.55);
    for (const [x, y] of [[34, BH / 2], [BW - 34, BH / 2], [BW / 2, 34], [BW / 2, BH - 34]]) {
      g.beginPath(); g.moveTo(x, y - 7); g.lineTo(x + 7, y); g.lineTo(x, y + 7); g.lineTo(x - 7, y); g.closePath(); g.fill();
    }
    for (const [x, y, sx, sy] of [[44, 44, 1, 1], [BW - 44, 44, -1, 1], [44, BH - 44, 1, -1], [BW - 44, BH - 44, -1, -1]]) {
      g.strokeStyle = rgba(BONE, 0.35); g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(x + sx * 10, y + sy * 46); g.quadraticCurveTo(x + sx * 10, y + sy * 10, x + sx * 46, y + sy * 10); g.stroke();
      g.beginPath(); g.arc(x + sx * 20, y + sy * 20, 3, 0, 7); g.fillStyle = rgba(BONE, 0.4); g.fill();
    }
    // letters, inlaid: a dark recess, then bone
    for (const [sym, p] of Object.entries(this.pos)) {
      if (sym === "_" || sym === "#") continue;
      g.save();
      g.translate(p.x, p.y); g.rotate(p.rot || 0);
      g.font = `${p.size}px ${LETTER_FONT}`;
      g.textAlign = "center"; g.textBaseline = "middle";
      g.fillStyle = "rgba(0,0,0,0.7)";
      g.fillText(sym, 1.5, 2);
      g.fillStyle = rgba(BONE, 0.92);
      g.fillText(sym, 0, 0);
      g.restore();
    }
    this.paintOrnaments(g, 0.6);
    return c;
  }

  paintOrnaments(g, a) {
    g.save();
    g.strokeStyle = rgba(BONE, a); g.fillStyle = rgba(BONE, a); g.lineWidth = 1.4;
    const sx = 98, sy = 134;
    g.beginPath(); g.arc(sx, sy, 15, 0, Math.PI * 2); g.stroke();
    for (let i = 0; i < 12; i++) {
      const an = (i / 12) * Math.PI * 2, r1 = 21, r2 = i % 2 ? 28 : 34;
      g.beginPath(); g.moveTo(sx + Math.cos(an) * r1, sy + Math.sin(an) * r1); g.lineTo(sx + Math.cos(an) * r2, sy + Math.sin(an) * r2); g.stroke();
    }
    g.beginPath(); g.arc(1102, 134, 17, 0, Math.PI * 2); g.arc(1110, 128, 14, Math.PI * 2, 0, true); g.fill("evenodd");
    const mx = 600, my = 104;
    for (let ring = 3; ring >= 1; ring--) {
      const n = 8 + ring * 4;
      for (let i = 0; i < n; i++) {
        const an = (i / n) * Math.PI * 2 + ring * 0.4;
        g.beginPath();
        g.ellipse(mx + Math.cos(an) * ring * 7, my + Math.sin(an) * ring * 7, 5 + ring * 1.3, 2.6, an, 0, Math.PI * 2);
        g.stroke();
      }
    }
    g.font = `italic 23px ${TEXT_FONT}`;
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText("planchette", 600, 152);
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(498, 152); g.lineTo(550, 152); g.moveTo(650, 152); g.lineTo(702, 152); g.stroke();
    g.restore();
  }

  // a faint inner light in every letter, so the board never goes fully dark
  paintLetters() {
    const c = document.createElement("canvas");
    c.width = BW; c.height = BH;
    const g = c.getContext("2d");
    for (const [sym, p] of Object.entries(this.pos)) {
      if (sym === "_" || sym === "#") continue;
      g.save();
      g.translate(p.x, p.y); g.rotate(p.rot || 0);
      g.font = `${p.size}px ${LETTER_FONT}`;
      g.textAlign = "center"; g.textBaseline = "middle";
      g.fillStyle = rgba(BONE, 1);
      g.fillText(sym, 0, 0);
      g.restore();
    }
    this.paintOrnaments(g, 0.8);
    return c;
  }

  makePlanchette() {
    const S = 0.01;
    const shape = new THREE.Shape();
    heartPath(shape, 1);
    const pts = shape.extractPoints(4);
    const outer = new THREE.Shape(pts.shape.map((v) => new THREE.Vector2(v.x * S, -v.y * S)));
    const hole = new THREE.Path();
    hole.absarc(0, 0, 0.37, 0, Math.PI * 2, true);
    outer.holes.push(hole);
    const geo = new THREE.ExtrudeGeometry(outer, { depth: 0.08, bevelEnabled: true, bevelThickness: 0.07, bevelSize: 0.08, bevelSegments: 1, curveSegments: 10 });
    geo.rotateX(-Math.PI / 2);
    const wood = new THREE.MeshStandardMaterial({ color: 0xd0874c, roughness: 0.55, flatShading: true });
    const body = new THREE.Mesh(geo, wood);
    body.castShadow = true;
    body.position.y = 0.07;
    const group = new THREE.Group();
    group.add(body);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.39, 0.045, 4, 14), new THREE.MeshStandardMaterial({ color: 0xf2c063, metalness: 0.7, roughness: 0.35, flatShading: true }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.24;
    ring.castShadow = true;
    group.add(ring);
    for (const [fx, fz] of [[0, -0.62], [-0.6, 0.76], [0.6, 0.76]]) {
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.07, 6), new THREE.MeshStandardMaterial({ color: 0x2a1208, flatShading: true }));
      foot.position.set(fx, 0.035, fz);
      group.add(foot);
    }
    return group;
  }

  rosewood() {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const g = c.getContext("2d");
    const rnd = mulberry(77);
    g.fillStyle = "#6b4228"; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 70; i++) {
      const y0 = rnd() * 256;
      g.strokeStyle = rnd() < 0.6 ? `rgba(20,8,2,${0.2 + rnd() * 0.3})` : `rgba(255,200,150,${0.05 + rnd() * 0.08})`;
      g.lineWidth = 0.5 + rnd() * 2.5;
      g.beginPath();
      for (let x = 0; x <= 256; x += 8) g.lineTo(x, y0 + Math.sin(x * 0.03 + i) * 4);
      g.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  // the lens shows the board beneath it, magnified
  makeLens() {
    const group = new THREE.Group();
    // the lens shares the board's own textures; only its UVs move (no extra texture uploads)
    const lensGeo = new THREE.CircleGeometry(0.37, 40);
    this._lensBaseUV = Float32Array.from(lensGeo.attributes.uv.array);
    const disc = new THREE.Mesh(lensGeo, new THREE.MeshBasicMaterial({ map: this.colorTex, color: 0xb8aab0 }));
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.012;
    group.add(disc);
    const glowDisc = new THREE.Mesh(lensGeo, new THREE.MeshBasicMaterial({ map: this.glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    glowDisc.rotation.x = -Math.PI / 2;
    glowDisc.position.y = 0.014;
    group.add(glowDisc);
    // the glass: a low dome of facets that catch the candlelight
    const dome = new THREE.SphereGeometry(0.37, 8, 3, 0, Math.PI * 2, 0, Math.PI / 2);
    const glass = new THREE.Mesh(dome, new THREE.MeshStandardMaterial({ color: 0xd8f0ff, transparent: true, opacity: 0.16, roughness: 0.05, metalness: 0.3, flatShading: true, depthWrite: false }));
    glass.scale.set(1, 0.32, 1);
    glass.position.y = 0.02;
    group.add(glass);
    return { group, geo: lensGeo };
  }

  makeCandle(x, z, h, i) {
    const group = new THREE.Group();
    const base = -0.3, rad = i === 1 ? 0.36 : 0.3;
    const waxMat = new THREE.MeshStandardMaterial({ color: 0xfbe9c6, roughness: 0.75, flatShading: true, emissive: 0x6a3410, emissiveIntensity: 0.45 });
    const wax = new THREE.Mesh(new THREE.CylinderGeometry(rad * 0.94, rad, h, 7), waxMat);
    wax.position.set(x, base + h / 2, z);
    group.add(wax);
    // a melted lip and two drips, still faceted
    const lip = new THREE.Mesh(new THREE.TorusGeometry(rad * 0.8, 0.06, 3, 7), waxMat);
    lip.rotation.x = Math.PI / 2;
    lip.position.set(x, base + h - 0.01, z);
    group.add(lip);
    for (let d = 0; d < 2; d++) {
      const a = d * 2.6 + i, len = 0.35 + hash(i * 7 + d) * 0.5;
      const drip = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.035, len, 4), waxMat);
      drip.position.set(x + Math.cos(a) * rad * 0.97, base + h - len / 2, z + Math.sin(a) * rad * 0.97);
      group.add(drip);
    }
    // a dish under it
    const dish = new THREE.Mesh(new THREE.CylinderGeometry(rad * 1.9, rad * 2.1, 0.08, 8), new THREE.MeshStandardMaterial({ color: 0xb38a4a, metalness: 0.7, roughness: 0.4, flatShading: true }));
    dish.position.set(x, base + 0.04, z);
    dish.receiveShadow = true;
    group.add(dish);
    const wick = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.016, 0.14, 4), new THREE.MeshBasicMaterial({ color: 0x120a06 }));
    wick.position.set(x, base + h + 0.06, z);
    group.add(wick);
    // the flame: two nested crystals, white-hot inside, marigold outside
    const fy = base + h + 0.3;
    const flame = new THREE.Group();
    const outer = new THREE.Mesh(new THREE.OctahedronGeometry(0.11, 0), new THREE.MeshBasicMaterial({ color: 0xffa63a, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
    outer.scale.set(1, 2.5, 1);
    const inner = new THREE.Mesh(new THREE.OctahedronGeometry(0.06, 0), new THREE.MeshBasicMaterial({ color: 0xfff4d0 }));
    inner.scale.set(1, 2.2, 1);
    inner.position.y = -0.04;
    flame.add(outer, inner);
    flame.position.set(x, fy, z);
    group.add(flame);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.haloTexture(), color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending }));
    halo.scale.set(1.8, 1.8, 1);
    halo.position.set(x, fy, z);
    group.add(halo);
    const light = new THREE.PointLight(0xffa050, 18, 0, 2);
    light.position.set(x, fy, z);
    group.add(light);
    return { group, flame, halo, light, fy, x, z, seed: i * 17.3, base: i === 2 ? 9 : 18, lit: 0, litTarget: 0, strike: 0 };
  }

  haloTexture() {
    if (this._halo) return this._halo;
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d");
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, "rgba(255,210,150,1)");
    gr.addColorStop(0.12, "rgba(255,170,90,0.55)");
    gr.addColorStop(0.45, "rgba(255,120,40,0.12)");
    gr.addColorStop(1, "rgba(255,100,30,0)");
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return (this._halo = t);
  }

  flameTexture() {
    if (this._flame) return this._flame;
    const c = document.createElement("canvas");
    c.width = 64; c.height = 160;
    const g = c.getContext("2d");
    const gr = g.createRadialGradient(32, 112, 2, 32, 96, 70);
    gr.addColorStop(0, "rgba(255,255,240,1)");
    gr.addColorStop(0.18, "rgba(255,230,160,1)");
    gr.addColorStop(0.42, "rgba(255,150,50,0.75)");
    gr.addColorStop(1, "rgba(255,80,10,0)");
    g.fillStyle = gr;
    g.beginPath();
    g.moveTo(32, 4);
    g.bezierCurveTo(58, 70, 54, 146, 32, 150);
    g.bezierCurveTo(10, 146, 6, 70, 32, 4);
    g.fill();
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return (this._flame = t);
  }

  makeDust() {
    const n = 260;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3);
    const rnd = mulberry(99);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (rnd() - 0.5) * 20;
      pos[i * 3 + 1] = rnd() * 5;
      pos[i * 3 + 2] = (rnd() - 0.5) * 11;
    }
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const c = document.createElement("canvas");
    c.width = c.height = 32;
    const g = c.getContext("2d");
    const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    gr.addColorStop(0, "rgba(255,220,180,1)");
    gr.addColorStop(1, "rgba(255,220,180,0)");
    g.fillStyle = gr; g.fillRect(0, 0, 32, 32);
    const mat = new THREE.PointsMaterial({ size: 0.045, map: new THREE.CanvasTexture(c), transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffd8a8 });
    return new THREE.Points(geo, mat);
  }

  resize() {
    if (!this.ready) return;
    const el = this.canvas.parentElement;
    const w = Math.max(1, el.clientWidth), h = Math.max(1, el.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.fitCamera();
  }

  // move the camera back until the whole board (and a little table) fits the view
  fitCamera() {
    const cam = this.camera;
    const dir = this.camBase.clone().sub(this.lookAt).normalize();
    const corners = [[-6.4, -4.2, 0], [6.4, -4.2, 0], [-6.4, 4.3, 0], [6.4, 4.3, 0]].map(([x, z, y]) => new THREE.Vector3(x, y, z));
    let lo = 4, hi = 60;
    for (let i = 0; i < 28; i++) {
      const d = (lo + hi) / 2;
      cam.position.copy(this.lookAt).addScaledVector(dir, d);
      cam.lookAt(this.lookAt);
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
      const fits = corners.every((c) => { const v = c.clone().project(cam); return Math.abs(v.x) < 0.96 && Math.abs(v.y) < 0.95; });
      if (fits) hi = d; else lo = d;
    }
    this.camDist = hi;
    this.camDir = dir;
  }

  // ------------------------------------------------------------------ séance controls
  setThinking(dist, hands, entropy) {
    this.ghosts = dist.filter(([s, p]) => p > 0.025 && s !== "#" && s !== "_").slice(0, 6).map(([sym, p]) => ({ sym, p }));
    this.threads = (hands || []).length > 1 ? hands.map((h, i) => {
      const fav = (h.dist || []).find(([s]) => s !== "#") || [];
      return { sym: fav[0], p: fav[1] || 0, color: HAND_COLORS[i % HAND_COLORS.length] };
    }).filter((t) => t.sym) : [];
    this.jitter = Math.min(1, entropy / 3);
  }
  clearThinking() { this.ghosts = []; this.threads = []; this.jitter = 0.18; }
  // while the model is still deciding, the planchette circles slowly where it is
  seek(on) {
    if (on && !this.seeking) { this.anchor = { x: this.P.x, y: this.P.y }; this.k = 6; this.zeta = 0.85; }
    this.seeking = on;
  }

  spot(sym) { const p = this.pos[sym] || this.pos._; return { x: p.x, y: p.y }; }
  moveTo(sym, k = 14, zeta = 0.9) { this.target = this.spot(sym); this.k = k; this.zeta = zeta; }
  wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
  async settle(maxMs = 2600) {
    const t0 = performance.now();
    while (performance.now() - t0 < maxMs) {
      const d = Math.hypot(this.P.x - this.target.x, this.P.y - this.target.y);
      const v = Math.hypot(this.P.vx, this.P.vy);
      if (d < 4 && v < 40) return;
      await this.wait(30);
    }
  }

  async play(step, speed = 1) {
    const dist = step.dist.filter(([s]) => s !== "#");
    const top = dist[0] ? dist[0][1] : 1;
    this.setThinking(step.dist, step.hands, step.entropy);
    const chosen = step.chosen;
    const unsure = Math.min(1, step.entropy / 2.5);
    if (chosen !== "_" && chosen !== "#" && dist.length > 1 && !this.reduced) {
      const cands = dist.filter(([k, p]) => p >= 0.03 && k !== "_").slice(0, 4);
      const runner = cands.find(([k]) => k !== chosen);
      if (cands.length > 1 && top < 0.97) {
        // torn: the room holds its breath while the planchette lunges and swerves
        this.tornTarget = Math.min(1, 0.45 + unsure);
        this.onTorn(this.tornTarget);
        const visits = 1 + Math.round(unsure * 2.2) + (Math.random() < 0.35 ? 1 : 0);
        let prev = null;
        for (let v = 0; v < visits; v++) {
          const pool = cands.filter(([k]) => k !== prev);
          const w = pool.map(([, p]) => Math.pow(p, 0.9));
          let r = Math.random() * w.reduce((x, y) => x + y, 0), pick = pool[0];
          for (let i = 0; i < pool.length; i++) { r -= w[i]; if (r <= 0) { pick = pool[i]; break; } }
          const sp = this.spot(pick[0]);
          const f = 0.72 + Math.random() * 0.2;
          this.target = { x: this.P.x + (sp.x - this.P.x) * f, y: this.P.y + (sp.y - this.P.y) * f };
          this.k = 24; this.zeta = 0.55;
          await this.wait((230 + Math.random() * 230 + pick[1] * 320) / speed);
          prev = pick[0];
        }
      } else if (runner && Math.random() < Math.min(0.85, runner[1] * 6)) {
        // fairly sure, but a real second choice: start toward it, then swerve
        const sp = this.spot(runner[0]);
        this.target = { x: this.P.x + (sp.x - this.P.x) * 0.6, y: this.P.y + (sp.y - this.P.y) * 0.6 };
        this.k = 24; this.zeta = 0.6;
        await this.wait((170 + Math.random() * 140) / speed);
      }
    }
    const pause = chosen === "_" || chosen === "#";
    this.moveTo(chosen, pause ? 12 : 28, 0.82);
    await this.settle(pause ? 700 : 1500);
    if (this.tornTarget) this.onTorn(0);
    this.tornTarget = 0;
    if (!pause) {
      this.embers[chosen] = 1;
      this.flash = { sym: chosen, life: 1 };
      this.spark(chosen);
      this.onLand(step);
    }
    this.clearThinking();
    await this.wait((pause ? 260 : this.reduced ? 100 : 200) / speed);
  }

  async glideTo(sym, ms = 900) {
    this.moveTo(sym, 8, 0.95);
    await this.settle(2600);
    if (sym !== "_") { this.embers[sym] = 1; this.flash = { sym, life: 1 }; }
    await this.wait(ms);
  }
  // the spirit refuses: the room goes cold and dark, the candles lean and gutter
  refuse() {
    this.tornTarget = 1; this.jitter = 0.9; this.roomTarget = 0.45;
    for (const c of this.candles) c.litTarget = 0.45;
    setTimeout(() => {
      this.tornTarget = 0; this.jitter = 0.18;
      if (!this.dark) { this.roomTarget = 1; for (const c of this.candles) c.litTarget = 1; }
    }, 3200);
  }
  // move part of the way toward a symbol, slowly, then stop there trembling
  async creep(sym, frac = 0.7, ms = 1500) {
    const sp = this.spot(sym);
    this.target = { x: this.P.x + (sp.x - this.P.x) * frac, y: this.P.y + (sp.y - this.P.y) * frac };
    this.k = 5; this.zeta = 1.0; this.jitter = 0.35;
    await this.wait(ms);
  }
  // a sudden, hard pull to a symbol
  async lunge(sym) {
    this.moveTo(sym, 46, 0.62);
    await this.settle(1400);
    this.embers[sym] = 1; this.flash = { sym, life: 1 }; this.spark(sym);
    await this.wait(300);
  }
  // in the dark, the planchette jerks a little on its own
  twitch() {
    const a = Math.random() * Math.PI * 2;
    this.target = { x: this.P.x + Math.cos(a) * 46, y: this.P.y + Math.sin(a) * 30 };
    this.k = 30; this.zeta = 0.5;
  }
  fadeEmbers() { for (const k of Object.keys(this.embers)) this.embers[k] = Math.min(this.embers[k], 0.3); }

  // ------------------------------------------------------------------ loop
  frame(now) {
    const dt = Math.min(0.05, (now - this._last) / 1000);
    this._last = now;
    this.t += dt;
    this._frames = (this._frames || 0) + 1;
    if (!this._reported && this.t > 6) {
      this._reported = true;
      const gl = this.renderer.getContext();
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      const gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown";
      const fps = Math.round(this._frames / ((now - this._t0) / 1000));
      try { fetch("api/clientlog", { method: "POST", body: JSON.stringify({ msg: `3d ok: ${fps} fps, gpu=${gpu}, ${innerWidth}x${innerHeight} dpr=${devicePixelRatio}` }) }); } catch {}
    }
    this.physics(dt);
    this._glowClock = (this._glowClock || 0) + dt;
    if (this._glowClock >= 1 / 32) { this._glowClock = 0; this.paintGlow(); }
    this.update3d(dt);
    this.renderer.render(this.scene, this.camera);
  }

  physics(dt) {
    const P = this.P;
    if (this.seeking && this.anchor) {
      const a = this.t * 1.25;
      this.target = { x: this.anchor.x + Math.cos(a) * 34, y: this.anchor.y + Math.sin(a * 1.3) * 22 };
    }
    const sub = 4, h = dt / sub;
    for (let i = 0; i < sub; i++) {
      const k = this.k, c = 2 * Math.sqrt(k) * this.zeta;
      const nx = (noise1(this.t * 3.1) - 0.5) * 2, ny = (noise1(this.t * 2.7 + 50) - 0.5) * 2;
      const jit = this.jitter * 260 + 34;
      const ax = k * k * 0.06 * (this.target.x - P.x) - c * 1.4 * P.vx + nx * jit;
      const ay = k * k * 0.06 * (this.target.y - P.y) - c * 1.4 * P.vy + ny * jit;
      P.vx += ax * h; P.vy += ay * h;
      P.x += P.vx * h; P.y += P.vy * h;
    }
    const want = Math.max(-0.26, Math.min(0.26, P.vx * 0.001)) - 0.03;
    P.vr += ((want - P.rot) * 30 - P.vr * 8) * dt;
    P.rot += P.vr * dt;
    this.speed = Math.hypot(P.vx, P.vy);
    this.onMove(this.speed);
    this.trail.push({ x: P.x, y: P.y });
    if (this.trail.length > 36) this.trail.shift();
    for (const k of Object.keys(this.embers)) this.embers[k] = Math.max(0.18, this.embers[k] - dt * 0.06);
    if (this.flash) { this.flash.life -= dt * 1.1; if (this.flash.life <= 0) this.flash = null; }
  }

  // what glows on the board this frame: letters, numbers, the smoky trail
  paintGlow() {
    const g = this.glowCtx;
    g.globalCompositeOperation = "source-over";
    g.fillStyle = "#000";
    g.fillRect(0, 0, BW, BH);
    const breath = this.reduced ? 1 : 0.85 + 0.15 * noise1(this.t * 0.6);
    g.globalAlpha = 0.24 * breath * (0.25 + 0.75 * this.room);
    g.drawImage(this.lettersOnly, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = "lighter";
    for (let i = 1; i < this.trail.length; i++) {
      const a = this.trail[i - 1], b = this.trail[i], k = i / this.trail.length;
      g.strokeStyle = rgba(GHOST, k * k * 0.05);
      g.lineWidth = 8 + k * 26; g.lineCap = "round";
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    }
    this.threads.forEach((th, i) => {
      const a = this.spot(th.sym), wob = Math.sin(this.t * 3 + i) * 16;
      g.strokeStyle = th.color; g.globalAlpha = 0.25 + th.p * 0.5; g.lineWidth = 1.6;
      g.setLineDash([3, 7]);
      g.beginPath(); g.moveTo(this.P.x, this.P.y);
      g.quadraticCurveTo((this.P.x + a.x) / 2 + wob, (this.P.y + a.y) / 2 - 26, a.x, a.y); g.stroke();
      g.setLineDash([]); g.globalAlpha = 1;
    });
    for (const [sym, life] of Object.entries(this.embers)) this.lightLetter(g, sym, MARIGOLD, 0.7 + life * 0.3);
    this.ghosts.forEach((gh, i) => {
      if (this.embers[gh.sym] > 0.5) return;
      // rivals pulse in turn while the model is torn between them
      const pulse = 1 - this.torn * 0.45 * (0.5 + 0.5 * Math.sin(this.t * 6.5 + i * Math.PI));
      this.lightLetter(g, gh.sym, GHOST, (0.3 + Math.min(0.55, gh.p)) * pulse);
    });
    if (this.flash) this.lightLetter(g, this.flash.sym, [255, 220, 150], 0.9 * this.flash.life);
    if (this.showNumbers && this.ghosts.length) {
      g.font = `italic 600 32px "Fraunces", Georgia, serif`;
      g.textAlign = "center"; g.textBaseline = "middle";
      for (const gh of this.ghosts.slice(0, 3)) {
        if (gh.p < 0.05) continue;
        const p = this.pos[gh.sym];
        if (!p) continue;
        const dx = p.x - 600, dy = p.y - 1250, d = Math.hypot(dx, dy);
        let ox = (dx / d) * 64, oy = (dy / d) * 64;
        if (p.word || "1234567890".includes(gh.sym)) { ox = 0; oy = -46; }
        g.fillStyle = rgba(GHOST, 0.5 + Math.min(0.5, gh.p));
        g.fillText(`${Math.round(gh.p * 100)}%`, p.x + ox, p.y + oy);
      }
    }
    this.glowTex.needsUpdate = true;

  }

  lightLetter(g, sym, col, a) {
    if (a <= 0.02) return;
    const p = this.pos[sym];
    if (!p) return;
    const r = p.word ? 110 : 60;
    const halo = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
    halo.addColorStop(0, rgba(col, 0.3 * a));
    halo.addColorStop(1, rgba(col, 0));
    g.fillStyle = halo;
    g.fillRect(p.x - r, p.y - r, r * 2, r * 2);
    g.save();
    g.translate(p.x, p.y); g.rotate(p.rot || 0);
    g.font = `${p.size}px ${LETTER_FONT}`;
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillStyle = rgba(col, a);
    g.fillText(sym, 0, 0);
    g.restore();
  }

  update3d(dt) {
    const { x, y, rot, vx, vy } = this.P;
    // the planchette slides, tilts into its motion and lifts a little when it lunges
    const pl = this.planchette;
    pl.position.set(wx(x), Math.min(0.08, this.speed * 0.00008), wz(y));
    pl.rotation.set(Math.max(-0.08, Math.min(0.08, vy * 0.00012)), -rot, Math.max(-0.08, Math.min(0.08, -vx * 0.00012)), "YXZ");
    this.lens.group.position.set(wx(x), pl.position.y + 0.16, wz(y));
    // magnify: show a smaller patch of the board around the lens centre
    const r = 37 / 1.45;
    const uv = this.lens.geo.attributes.uv, base = this._lensBaseUV;
    const u0 = x / BW, v0 = 1 - y / BH, ru = (2 * r) / BW, rv = (2 * r) / BH;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + (base[i * 2] - 0.5) * ru, v0 + (base[i * 2 + 1] - 0.5) * rv);
    uv.needsUpdate = true;
    // the room's light, and the breath it holds when the model is torn
    this.room += (this.roomTarget - this.room) * Math.min(1, dt * 1.2);
    this.torn += (this.tornTarget - this.torn) * Math.min(1, dt * 3);
    this.flareAmt = Math.max(0, this.flareAmt - dt * 0.7);
    const hush = 1 - 0.38 * this.torn;
    this.hemi.intensity = 1.0 * (0.12 + 0.88 * this.room) * hush;
    this.moon.intensity = 1.6 * (0.2 + 0.8 * this.room) * hush;
    this.key.intensity = 110 * this.room * (1 - 0.5 * this.torn) * (1 + 0.25 * this.flareAmt);
    this.top.emissiveIntensity = 1.25 * (0.35 + 0.65 * this.room);

    // candles: catch, flicker, lean toward the planchette when the board is torn
    const px = wx(x), pz = wz(y);
    for (const c of this.candles) {
      c.lit += (c.litTarget - c.lit) * Math.min(1, dt * (c.litTarget > c.lit ? 4 : 6));
      c.strike = Math.max(0, c.strike - dt * 2.5);
      const speed = 1 + this.torn * 1.8;
      const f = this.reduced ? 1 : 0.82 + 0.16 * noise1(this.t * 7 * speed + c.seed) + 0.08 * noise1(this.t * 21 * speed + c.seed);
      const L = c.lit, flare = 1 + this.flareAmt * 0.7 + c.strike * 1.2;
      c.light.intensity = c.base * f * L * flare;
      const show = L > 0.03;
      c.flame.visible = c.halo.visible = show;
      c.flame.scale.set((0.9 + 0.12 * f) * L * (1 + this.flareAmt * 0.3), (0.8 + 0.3 * f) * L * flare, (0.9 + 0.12 * f) * L);
      c.flame.rotation.y += dt * 0.6;
      c.halo.material.opacity = 0.75 * f * L * Math.min(1.6, flare);
      c.halo.scale.setScalar((1.6 + 0.35 * f) * (0.6 + 0.4 * L) * (1 + this.flareAmt * 0.4));
      const sway = this.reduced ? 0 : (noise1(this.t * 2.2 * speed + c.seed) - 0.5) * 0.04 * speed;
      const dx = px - c.x, dz = pz - c.z, d = Math.hypot(dx, dz) || 1;
      const lean = this.torn * 0.42;
      c.flame.position.x = c.x + sway + (dx / d) * lean * 0.12;
      c.flame.position.z = c.z + (dz / d) * lean * 0.12;
      c.flame.rotation.z = sway * 2 - (dx / d) * lean;
      c.flame.rotation.x = (dz / d) * lean;
      c.light.position.x = c.flame.position.x;
      c.light.position.z = c.flame.position.z;
      c.halo.position.x = c.flame.position.x;
    }

    // a thread of smoke from every lit flame
    this._smokeClock += dt;
    if (this._smokeClock > 0.32 && !this.reduced) {
      this._smokeClock = 0;
      for (const c of this.candles) if (c.lit > 0.5) this.puff(c, 1);
    }
    for (const s of this.smoke) {
      if (s.life <= 0) continue;
      s.life -= dt * (s.strength > 1 ? 0.4 : 0.32);
      if (s.life <= 0) { s.sp.visible = false; s.sp.material.opacity = 0; continue; }
      s.sp.position.addScaledVector(s.v, dt);
      s.sp.position.x += Math.sin(this.t * 1.3 + s.v.x * 40) * dt * 0.08;
      s.sp.scale.setScalar(0.15 + (1 - s.life) * (s.strength > 1 ? 1.9 : 0.8));
      s.sp.material.opacity = Math.sin(s.life * Math.PI) * (s.strength > 1 ? 0.12 : 0.06);
    }
    // sparks
    for (const s of this.sparks) {
      if (s.life <= 0) continue;
      s.life -= dt * 0.9;
      if (s.life <= 0) { s.m.visible = false; continue; }
      s.v.y -= dt * 3.2;
      s.m.position.addScaledVector(s.v, dt);
      s.m.rotation.x += dt * 5; s.m.rotation.y += dt * 4;
      s.m.material.opacity = Math.min(1, s.life * 1.4);
      s.m.scale.setScalar(0.6 + s.life);
    }
    // dust drifts upward through the light
    const p = this.dust.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      let yy = p.getY(i) + dt * (0.05 + (i % 7) * 0.01);
      if (yy > 5) yy = 0;
      p.setY(i, yy);
      p.setX(i, p.getX(i) + Math.sin(this.t * 0.3 + i) * dt * 0.02);
    }
    p.needsUpdate = true;
    // the camera breathes, very slowly
    if (this.camDir) {
      const drift = this.reduced ? 0 : 1;
      const off = new THREE.Vector3(Math.sin(this.t * 0.11) * 0.35 * drift, Math.sin(this.t * 0.07) * 0.18 * drift, 0);
      this.camera.position.copy(this.lookAt).addScaledVector(this.camDir, this.camDist).add(off);
      this.camera.lookAt(this.lookAt);
    }
  }
}

// a slab with rounded corners: top face gets the painted texture (UVs 0..1)
class RoundedSlab extends THREE.ExtrudeGeometry {
  constructor(w, d, h, r, seg = 12) {
    const s = new THREE.Shape();
    const x = -w / 2, y = -d / 2;
    s.moveTo(x + r, y);
    s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
    s.lineTo(x + w, y + d - r); s.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
    s.lineTo(x + r, y + d); s.quadraticCurveTo(x, y + d, x, y + d - r);
    s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
    super(s, { depth: h - 0.06, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.05, bevelSegments: 1, curveSegments: seg });
    // lie flat with the top at y = 0, and map the top face's UVs onto the board image
    this.rotateX(-Math.PI / 2);
    this.translate(0, -h + 0.03, 0);
    const pos = this.attributes.position, uv = this.attributes.uv, nrm = this.attributes.normal;
    this.computeVertexNormals();
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i), pz = pos.getZ(i);
      uv.setXY(i, (px + w / 2) / w, 1 - (pz + d / 2) / d);
    }
    // material 0 for the top face (normal pointing up), 1 for everything else
    const idx = this.index ? this.index.array : null;
    this.clearGroups();
    const tri = idx ? idx.length / 3 : pos.count / 3;
    const isTop = (t) => {
      const a = idx ? idx[t * 3] : t * 3;
      return this.attributes.normal.getY(a) > 0.95 && pos.getY(a) > -0.01;
    };
    let start = 0, cur = isTop(0) ? 0 : 1;
    for (let t = 1; t <= tri; t++) {
      const m = t < tri ? (isTop(t) ? 0 : 1) : -1;
      if (m !== cur) { this.addGroup(start * 3, (t - start) * 3, cur); start = t; cur = m; }
    }
  }
}
