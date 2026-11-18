/**
 * Rim Rush: Meal Run. A first-person, hands-first wheelchair game (VR).
 *
 * You sit in a wheelchair at home and push the rims with your hands to get
 * through the house to your meal before the timer runs out. Three levels
 * (breakfast, lunch, dinner) add clutter, longer routes and moving hazards.
 * Bumping furniture costs time and stars.
 *
 * Controls
 * - Two-rim mode: pinch with a hand to grab that side's rim, move the pinched
 *   hand forward (away from you) to push, back to reverse. Holding a pinched rim
 *   still brakes that wheel. Push one rim harder to turn.
 * - One-hand mode: hold a pinch with one hand for 2 s on a menu screen. While
 *   pinched, the hand works like a joystick: forward = drive, sideways = turn.
 * - Keyboard (desktop / emulator): arrow keys drive, Q/A left rim, E/D right rim,
 *   Space start/continue, M toggle mode, V toggle comfort vignette.
 */
import {
  BoxGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  createSystem,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  RepeatWrapping,
  RingGeometry,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
  VisibilityState,
} from '@iwsdk/core';

// ---------- Tuning (metres, seconds) ----------
const CHAIR_RADIUS = 0.36;
const TRACK = 0.9; // virtual wheel spacing: bigger = gentler turns
const PUSH_GAIN = 6; // wheel speed (m/s) gained per metre of hand travel
const MAX_WHEEL = 1.6; // m/s per wheel (indoor speed)
const COAST_DECAY = 0.45;
const BRAKE_DECAY = 4;
const BRAKE_HOLD = 0.35;
const ONE_HAND_SPEED = 1.3;
const ONE_HAND_TURN = 1.3;
const ONE_HAND_RANGE = 0.12;
const KEY_SPEED = 1.4;
const KEY_TURN = 1.4;
const PINCH_ON = 0.018;
const PINCH_OFF = 0.03;
const ONE_HAND_HOLD = 2;
const WALL_H = 2.6;
const WALL_T = 0.12;
const GOAL_RADIUS = 0.9;
const BUMP_PENALTY = 2; // seconds
const DEBUG = false;

type GameState = 'ready' | 'playing' | 'won' | 'failed' | 'done';
type Mode = 'two' | 'one';
type Side = 'left' | 'right';

/** Axis-aligned collider footprint: centre x/z and half sizes. */
interface Rect {
  x: number;
  z: number;
  hx: number;
  hz: number;
}

interface Mover {
  mesh: Object3D;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  speed: number; // m/s
  radius: number;
  t: number;
  dir: number;
  x: number;
  z: number;
}

interface Level {
  title: string;
  objective: string;
  start: [number, number, number]; // x, z, heading
  goal: [number, number];
  time: number;
  group: Group;
  rects: Rect[];
  movers: Mover[];
}

interface HandState {
  pinching: boolean;
  wasPinching: boolean;
  tracked: boolean;
  pos: Vector3; // in XR-origin (player) local space, so riding doesn't count as pushing
  last: Vector3;
  anchor: Vector3;
  holdTime: number;
  stillTime: number;
}

function makeHand(): HandState {
  return {
    pinching: false,
    wasPinching: false,
    tracked: false,
    pos: new Vector3(),
    last: new Vector3(),
    anchor: new Vector3(),
    holdTime: 0,
    stillTime: 0,
  };
}

function readNumber(key: string): number {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

function writeNumber(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* storage unavailable */
  }
}

// ---------- Tiny synth for sound effects ----------
class Sfx {
  private ctx: AudioContext | null = null;
  resume(): void {
    try {
      if (!this.ctx) this.ctx = new AudioContext();
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      this.ctx = null;
    }
  }
  private tone(freq: number, endFreq: number, dur: number, type: OscillatorType, vol: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur);
  }
  start(): void {
    this.tone(330, 660, 0.25, 'sine', 0.2);
  }
  win(): void {
    this.tone(520, 1040, 0.35, 'triangle', 0.25);
  }
  fail(): void {
    this.tone(220, 60, 0.6, 'sawtooth', 0.2);
  }
  bump(): void {
    this.tone(140, 70, 0.15, 'square', 0.15);
  }
  grab(): void {
    this.tone(900, 700, 0.05, 'square', 0.04);
  }
}

// ---------- Materials & textures ----------
function canvasTexture(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (ctx) draw(ctx);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

function woodTexture(base: string, line: string): CanvasTexture {
  const tex = canvasTexture(256, 256, (c) => {
    c.fillStyle = base;
    c.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 8; i++) {
      c.fillStyle = i % 2 ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.04)';
      c.fillRect(0, i * 32, 256, 32);
      c.fillStyle = line;
      c.fillRect(0, i * 32, 256, 2);
      c.fillRect(((i * 97) % 200) + 20, i * 32, 2, 32);
    }
  });
  tex.wrapS = tex.wrapT = RepeatWrapping;
  return tex;
}

function tileTexture(): CanvasTexture {
  const tex = canvasTexture(128, 128, (c) => {
    c.fillStyle = '#e9e4da';
    c.fillRect(0, 0, 128, 128);
    c.fillStyle = '#d3ccbf';
    c.fillRect(0, 62, 128, 4);
    c.fillRect(62, 0, 4, 128);
  });
  tex.wrapS = tex.wrapT = RepeatWrapping;
  return tex;
}

const matCache = new Map<number, MeshStandardMaterial>();
function mat(color: number, roughness = 0.75): MeshStandardMaterial {
  let m = matCache.get(color);
  if (!m) {
    m = new MeshStandardMaterial({ color, roughness });
    matCache.set(color, m);
  }
  return m;
}

function box(g: Group, x: number, y: number, z: number, sx: number, sy: number, sz: number, color: number): Mesh {
  const m = new Mesh(new BoxGeometry(sx, sy, sz), mat(color));
  m.position.set(x, y, z);
  g.add(m);
  return m;
}

// ---------- The wheelchair you sit in (origin = floor under your head, facing -Z) ----------
function buildChair(): { root: Group; leftWheel: Object3D; rightWheel: Object3D } {
  const root = new Group();
  const frameMat = new MeshStandardMaterial({ color: 0x8a96a3, metalness: 0.8, roughness: 0.3 });
  const seatMat = new MeshStandardMaterial({ color: 0x1b1f27, roughness: 0.9 });
  const tyreMat = new MeshStandardMaterial({ color: 0x111111, roughness: 0.95 });
  const handrimMat = new MeshStandardMaterial({ color: 0xc0c8d0, metalness: 0.9, roughness: 0.2 });
  const jeansMat = new MeshStandardMaterial({ color: 0x2f4a6d, roughness: 0.9 });
  const shoeMat = new MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 });
  const soleMat = new MeshStandardMaterial({ color: 0x333333, roughness: 0.8 });

  const seat = new Mesh(new BoxGeometry(0.44, 0.06, 0.42), seatMat);
  seat.position.set(0, 0.5, 0.06);
  const back = new Mesh(new BoxGeometry(0.42, 0.42, 0.04), seatMat);
  back.position.set(0, 0.76, 0.28);
  root.add(seat, back);
  for (const x of [-0.23, 0.23]) {
    const rail = new Mesh(new BoxGeometry(0.025, 0.025, 0.62), frameMat);
    rail.position.set(x, 0.47, -0.04);
    const post = new Mesh(new BoxGeometry(0.025, 0.5, 0.025), frameMat);
    post.position.set(x, 0.73, 0.3);
    const fork = new Mesh(new BoxGeometry(0.025, 0.42, 0.025), frameMat);
    fork.position.set(x * 0.75, 0.28, -0.36);
    fork.rotation.x = -0.25;
    root.add(rail, post, fork);
  }
  const foot = new Mesh(new BoxGeometry(0.34, 0.02, 0.15), frameMat);
  foot.position.set(0, 0.1, -0.44);
  root.add(foot);

  // Legs: thighs on the seat, knees bent, feet on the footplate.
  for (const x of [-0.1, 0.1]) {
    const thigh = new Mesh(new CylinderGeometry(0.075, 0.065, 0.42, 12), jeansMat);
    thigh.rotation.x = Math.PI / 2;
    thigh.position.set(x, 0.6, -0.1);
    const knee = new Mesh(new SphereGeometry(0.068, 12, 10), jeansMat);
    knee.position.set(x, 0.6, -0.32);
    const shin = new Mesh(new CylinderGeometry(0.058, 0.05, 0.44, 12), jeansMat);
    shin.position.set(x, 0.37, -0.37);
    shin.rotation.x = -0.18;
    const shoe = new Mesh(new BoxGeometry(0.1, 0.07, 0.24), shoeMat);
    shoe.position.set(x, 0.15, -0.47);
    const sole = new Mesh(new BoxGeometry(0.105, 0.02, 0.25), soleMat);
    sole.position.set(x, 0.11, -0.47);
    root.add(thigh, knee, shin, shoe, sole);
  }

  const makeWheel = (x: number): Object3D => {
    const wheel = new Group();
    const tyre = new Mesh(new TorusGeometry(0.3, 0.022, 10, 48), tyreMat);
    tyre.rotation.y = Math.PI / 2;
    const handrim = new Mesh(new TorusGeometry(0.27, 0.008, 8, 48), handrimMat);
    handrim.rotation.y = Math.PI / 2;
    handrim.position.x = x > 0 ? 0.035 : -0.035;
    const hub = new Mesh(new CylinderGeometry(0.035, 0.035, 0.06, 16), frameMat);
    hub.rotation.z = Math.PI / 2;
    wheel.add(tyre, handrim, hub);
    for (let i = 0; i < 12; i++) {
      const spoke = new Mesh(new BoxGeometry(0.003, 0.56, 0.003), frameMat);
      spoke.rotation.x = (i * Math.PI) / 12;
      wheel.add(spoke);
    }
    wheel.position.set(x, 0.32, 0.1);
    root.add(wheel);
    return wheel;
  };
  const leftWheel = makeWheel(-0.29);
  const rightWheel = makeWheel(0.29);
  for (const x of [-0.17, 0.17]) {
    const caster = new Mesh(new CylinderGeometry(0.06, 0.06, 0.03, 16), tyreMat);
    caster.rotation.z = Math.PI / 2;
    caster.position.set(x, 0.06, -0.4);
    root.add(caster);
  }
  return { root, leftWheel, rightWheel };
}

/** Floating grab rims at lower-chest height, where hand tracking works best. */
function buildGrabRim(color: number): Group {
  const g = new Group();
  const ring = new Mesh(
    new TorusGeometry(0.12, 0.01, 10, 48),
    new MeshStandardMaterial({ color, emissive: new Color(color), emissiveIntensity: 0.6, transparent: true, opacity: 0.85 }),
  );
  ring.rotation.y = Math.PI / 2;
  const spokeMat = new MeshStandardMaterial({ color: 0xc0c8d0, metalness: 0.8, roughness: 0.3, transparent: true, opacity: 0.5 });
  for (let i = 0; i < 4; i++) {
    const spoke = new Mesh(new BoxGeometry(0.003, 0.23, 0.004), spokeMat);
    spoke.rotation.x = (i * Math.PI) / 4;
    g.add(spoke);
  }
  g.add(ring);
  return g;
}

// ---------- The house ----------
// Footprint x -6..6, z -8..8 (-Z is north).
//   South-west: bedroom    South-east: living room
//   North-west: dining     North-east: kitchen
// Doorways are 1.2 m wide (the chair is about 0.7 m wide).
const WALLS: Array<[number, number, number, number]> = [
  [-6, -8, 6, -8],
  [-6, 8, 6, 8],
  [-6, -8, -6, 8],
  [6, -8, 6, 8],
  // middle east-west wall, doors at x -2.2..-1.0 and 2.0..3.2
  [-6, 0, -2.2, 0],
  [-1.0, 0, 2.0, 0],
  [3.2, 0, 6, 0],
  // south north-south wall (bedroom | living), door at z 4.6..5.8
  [0, 0, 0, 4.6],
  [0, 5.8, 0, 8],
  // north north-south wall (dining | kitchen), door at z -3.4..-2.2
  [0, -8, 0, -3.4],
  [0, -2.2, 0, 0],
];

function buildShell(root: Group, rects: Rect[]): void {
  const wallMat = new MeshStandardMaterial({ color: 0xe9e0d2, roughness: 0.9 });
  const trimMat = mat(0xffffff, 0.6);
  for (const [x1, z1, x2, z2] of WALLS) {
    const sx = Math.abs(x2 - x1) + WALL_T;
    const sz = Math.abs(z2 - z1) + WALL_T;
    const cx = (x1 + x2) / 2;
    const cz = (z1 + z2) / 2;
    const w = new Mesh(new BoxGeometry(sx, WALL_H, sz), wallMat);
    w.position.set(cx, WALL_H / 2, cz);
    root.add(w);
    const base = new Mesh(new BoxGeometry(sx + 0.02, 0.1, sz + 0.02), trimMat);
    base.position.set(cx, 0.05, cz);
    root.add(base);
    rects.push({ x: cx, z: cz, hx: sx / 2, hz: sz / 2 });
  }
  // Door lintels above each doorway
  const lintels: Array<[number, number, number, number]> = [
    [-1.6, 0, 1.2, WALL_T],
    [2.6, 0, 1.2, WALL_T],
    [0, 5.2, WALL_T, 1.2],
    [0, -2.8, WALL_T, 1.2],
  ];
  for (const [x, z, sx, sz] of lintels) {
    const l = new Mesh(new BoxGeometry(sx, 0.5, sz), wallMat);
    l.position.set(x, WALL_H - 0.25, z);
    root.add(l);
  }

  // Floors per room
  const floor = (x: number, z: number, sx: number, sz: number, m: MeshStandardMaterial) => {
    const f = new Mesh(new PlaneGeometry(sx, sz), m);
    f.rotation.x = -Math.PI / 2;
    f.position.set(x, 0, z);
    root.add(f);
  };
  const oak = woodTexture('#b5865a', 'rgba(60,35,15,0.35)');
  oak.repeat.set(3, 4);
  const walnut = woodTexture('#7b5235', 'rgba(30,15,5,0.4)');
  walnut.repeat.set(3, 4);
  const tiles = tileTexture();
  tiles.repeat.set(10, 13);
  floor(-3, 4, 6, 8, new MeshStandardMaterial({ map: oak, roughness: 0.7 }));
  floor(3, 4, 6, 8, new MeshStandardMaterial({ map: walnut, roughness: 0.7 }));
  floor(-3, -4, 6, 8, new MeshStandardMaterial({ map: oak, roughness: 0.7 }));
  floor(3, -4, 6, 8, new MeshStandardMaterial({ map: tiles, roughness: 0.5 }));

  // Ceiling and ceiling lamps
  const ceil = new Mesh(new PlaneGeometry(12, 16), new MeshStandardMaterial({ color: 0xf7f4ee, side: DoubleSide }));
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set(0, WALL_H, 0);
  root.add(ceil);
  const lampMat = new MeshBasicMaterial({ color: 0xfff3d6 });
  for (const [x, z] of [[-3, 4], [3, 4], [-3, -4], [3, -4]] as const) {
    const lamp = new Mesh(new CylinderGeometry(0.25, 0.25, 0.04, 24), lampMat);
    lamp.position.set(x, WALL_H - 0.03, z);
    root.add(lamp);
  }

  // Windows (bright panels on outer walls)
  const winMat = new MeshBasicMaterial({ color: 0xbfe3ff });
  const win = (x: number, z: number, ry: number) => {
    const w = new Mesh(new PlaneGeometry(1.6, 1.1), winMat);
    w.position.set(x, 1.5, z);
    w.rotation.y = ry;
    root.add(w);
    const frame = new Mesh(new BoxGeometry(ry === 0 ? 1.7 : 0.06, 0.06, ry === 0 ? 0.06 : 1.7), trimMat);
    frame.position.set(x, 0.92, z);
    root.add(frame);
  };
  win(-3, 7.93, Math.PI);
  win(3, 7.93, Math.PI);
  win(-5.93, -4, Math.PI / 2);
  win(5.93, -4, -Math.PI / 2);

  // ----- Furniture shared by every level -----
  const solid = (x: number, z: number, sx: number, sz: number) => rects.push({ x, z, hx: sx / 2, hz: sz / 2 });

  // Bedroom: bed, wardrobe, nightstand, desk, rug
  box(root, -4.6, 0.25, 6.6, 1.6, 0.5, 2.0, 0x6d4c41);
  box(root, -4.6, 0.56, 6.7, 1.5, 0.12, 1.8, 0xf5f5f5);
  box(root, -4.6, 0.6, 6.3, 1.52, 0.1, 1.0, 0x5c7cfa);
  box(root, -4.6, 0.7, 7.45, 1.2, 0.14, 0.3, 0xffffff);
  box(root, -4.6, 0.8, 7.62, 1.6, 1.0, 0.08, 0x5d4037);
  solid(-4.6, 6.6, 1.6, 2.1);
  box(root, -5.62, 1.0, 2.2, 0.6, 2.0, 1.6, 0x8d6e63);
  solid(-5.62, 2.2, 0.6, 1.6);
  box(root, -3.45, 0.28, 7.6, 0.45, 0.55, 0.4, 0x5d4037);
  solid(-3.45, 7.6, 0.45, 0.4);
  box(root, -1.2, 0.73, 7.55, 1.3, 0.04, 0.6, 0xd7ccc8);
  box(root, -1.75, 0.36, 7.55, 0.05, 0.72, 0.55, 0x9e9e9e);
  box(root, -0.65, 0.36, 7.55, 0.05, 0.72, 0.55, 0x9e9e9e);
  solid(-1.2, 7.55, 1.3, 0.6);
  box(root, -2.6, 0.005, 4.4, 2.2, 0.01, 1.6, 0xb39ddb);

  // Living room: sofa, coffee table, TV, bookshelf, rug
  box(root, 4.95, 0.22, 5.5, 0.9, 0.44, 2.4, 0x546e7a);
  box(root, 5.32, 0.6, 5.5, 0.18, 0.5, 2.4, 0x455a64);
  box(root, 4.95, 0.5, 4.35, 0.9, 0.2, 0.15, 0x455a64);
  box(root, 4.95, 0.5, 6.65, 0.9, 0.2, 0.15, 0x455a64);
  solid(4.95, 5.5, 0.95, 2.45);
  box(root, 3.3, 0.42, 5.5, 0.7, 0.05, 1.1, 0x795548);
  box(root, 3.3, 0.2, 5.5, 0.6, 0.4, 1.0, 0x5d4037);
  solid(3.3, 5.5, 0.7, 1.1);
  box(root, 0.3, 0.3, 2.6, 0.45, 0.6, 1.8, 0x3e2723);
  box(root, 0.25, 1.15, 2.6, 0.06, 0.75, 1.3, 0x111111);
  solid(0.3, 2.6, 0.45, 1.8);
  box(root, 5.65, 0.95, 1.3, 0.55, 1.9, 1.4, 0x6d4c41);
  for (let i = 0; i < 4; i++) box(root, 5.6, 0.35 + i * 0.45, 1.3, 0.4, 0.28, 1.2, [0xc62828, 0x1565c0, 0x2e7d32, 0xf9a825][i]);
  solid(5.65, 1.3, 0.55, 1.4);
  box(root, 3.4, 0.005, 5.5, 2.2, 0.01, 2.6, 0x90a4ae);

  // Dining room: table with chairs, sideboard
  const table = (x: number, z: number, sx: number, sz: number, h: number, top: number) => {
    box(root, x, h - 0.02, z, sx, 0.04, sz, top);
    for (const dx of [-1, 1])
      for (const dz of [-1, 1]) box(root, x + dx * (sx / 2 - 0.06), (h - 0.04) / 2, z + dz * (sz / 2 - 0.06), 0.05, h - 0.04, 0.05, 0x4e342e);
    solid(x, z, sx, sz);
  };
  const chair = (x: number, z: number, backDz: number) => {
    box(root, x, 0.45, z, 0.42, 0.04, 0.42, 0x8d6e63);
    box(root, x, 0.7, z + backDz * 0.19, 0.42, 0.5, 0.04, 0x8d6e63);
    for (const dx of [-0.18, 0.18]) for (const dz of [-0.18, 0.18]) box(root, x + dx, 0.22, z + dz, 0.035, 0.44, 0.035, 0x5d4037);
    solid(x, z, 0.45, 0.45);
  };
  table(-3.2, -4, 1.0, 1.6, 0.76, 0x6d4c41);
  chair(-3.2, -5.15, -1);
  chair(-3.2, -2.85, 1);
  chair(-4.1, -4, 0);
  box(root, -5.65, 0.5, -6.6, 0.55, 1.0, 1.8, 0x5d4037);
  solid(-5.65, -6.6, 0.55, 1.8);

  // Kitchen: counters, fridge, island
  box(root, 2.5, 0.45, -7.62, 4.8, 0.9, 0.65, 0xf5f5f5);
  box(root, 2.5, 0.92, -7.62, 4.85, 0.04, 0.7, 0x37474f);
  box(root, 2.5, 1.85, -7.75, 4.8, 0.7, 0.35, 0xf5f5f5);
  solid(2.5, -7.62, 4.85, 0.7);
  box(root, 5.5, 0.95, -7.45, 0.8, 1.9, 0.8, 0xcfd8dc);
  box(root, 5.12, 1.2, -7.05, 0.04, 0.5, 0.04, 0x90a4ae);
  solid(5.5, -7.45, 0.8, 0.8);
  box(root, 5.62, 0.45, -5.2, 0.65, 0.9, 2.6, 0xf5f5f5);
  box(root, 5.62, 0.92, -5.2, 0.7, 0.04, 2.65, 0x37474f);
  solid(5.62, -5.2, 0.7, 2.65);
  box(root, 2.8, 0.45, -4.6, 1.8, 0.9, 0.9, 0xeceff1);
  box(root, 2.8, 0.92, -4.6, 1.9, 0.04, 1.0, 0x37474f);
  solid(2.8, -4.6, 1.9, 1.0);
  // Small kitchen table
  table(4.6, -1.5, 0.9, 0.9, 0.76, 0xd7ccc8);
}

/** A plate of food plus a glowing floor marker, placed at the goal. */
function buildMeal(g: Group, x: number, y: number, z: number, food: 'breakfast' | 'lunch' | 'dinner'): void {
  const plate = new Mesh(new CylinderGeometry(0.14, 0.11, 0.02, 24), mat(0xffffff, 0.3));
  plate.position.set(x, y + 0.01, z);
  g.add(plate);
  const add = (geo: BoxGeometry | SphereGeometry | CylinderGeometry, color: number, dx: number, dy: number, dz: number) => {
    const m = new Mesh(geo, mat(color, 0.6));
    m.position.set(x + dx, y + dy, z + dz);
    g.add(m);
  };
  if (food === 'breakfast') {
    add(new CylinderGeometry(0.05, 0.05, 0.012, 16), 0xffffff, -0.04, 0.03, 0);
    add(new SphereGeometry(0.022, 12, 8), 0xffb300, -0.04, 0.04, 0);
    add(new BoxGeometry(0.08, 0.015, 0.09), 0xd7a35a, 0.06, 0.03, 0.01);
  } else if (food === 'lunch') {
    add(new BoxGeometry(0.12, 0.025, 0.1), 0xe0b06a, 0, 0.03, 0);
    add(new BoxGeometry(0.11, 0.015, 0.09), 0x7cb342, 0, 0.05, 0);
    add(new BoxGeometry(0.12, 0.025, 0.1), 0xe0b06a, 0, 0.07, 0);
  } else {
    add(new CylinderGeometry(0.06, 0.06, 0.03, 16), 0xf4e1b5, -0.03, 0.035, 0);
    add(new SphereGeometry(0.035, 12, 8), 0x8d4a2f, 0.05, 0.04, 0.02);
    add(new SphereGeometry(0.02, 10, 8), 0x43a047, 0.05, 0.04, -0.05);
  }
  const cup = new Mesh(new CylinderGeometry(0.035, 0.03, 0.09, 16), mat(0xef5350, 0.5));
  cup.position.set(x + 0.2, y + 0.045, z);
  g.add(cup);
}

function buildMarker(g: Group, x: number, z: number): Mesh {
  const ring = new Mesh(
    new RingGeometry(GOAL_RADIUS * 0.75, GOAL_RADIUS, 40),
    new MeshBasicMaterial({ color: 0x66ff99, transparent: true, opacity: 0.55, side: DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, 0.015, z);
  g.add(ring);
  return ring;
}

function buildLevels(): Level[] {
  const levels: Level[] = [];

  // Level 1, Breakfast: bedroom, through the dining room, into the kitchen.
  {
    const group = new Group();
    const rects: Rect[] = [];
    buildMeal(group, 4.6, 0.76, -1.5, 'breakfast');
    levels.push({
      title: 'LEVEL 1 \u00B7 BREAKFAST',
      objective: 'Roll from the bedroom to the kitchen table',
      start: [-2.6, 2.6, 0],
      goal: [3.6, -1.5],
      time: 90,
      group,
      rects,
      movers: [],
    });
  }

  // Level 2, Lunch: living room to the dining table, with laundry and toys on the floor.
  {
    const group = new Group();
    const rects: Rect[] = [];
    const clutter: Array<[number, number, number, number, number, number]> = [
      [2.4, -1.3, 0.55, 0.42, 0.45, 0xbcaaa4], // laundry basket
      [1.1, -2.2, 0.35, 0.35, 0.3, 0xff7043], // toy box
      [1.4, -3.9, 0.4, 0.4, 0.35, 0x42a5f5], // toy box
      [-1.2, -2.0, 0.6, 0.35, 0.4, 0x8d6e63], // shoe rack
      [-1.6, -5.2, 0.4, 0.4, 0.5, 0x66bb6a], // plant
      [3.9, 1.9, 0.5, 0.5, 0.35, 0xab47bc], // gift box
    ];
    for (const [x, z, sx, sz, h, c] of clutter) {
      box(group, x, h / 2, z, sx, h, sz, c);
      rects.push({ x, z, hx: sx / 2, hz: sz / 2 });
    }
    buildMeal(group, -2.9, 0.76, -4.0, 'lunch');
    levels.push({
      title: 'LEVEL 2 \u00B7 LUNCH',
      objective: 'From the sofa to the dining table. Mind the clutter!',
      start: [3.4, 3.4, 0],
      goal: [-2.1, -4.0],
      time: 80,
      group,
      rects,
      movers: [],
    });
  }

  // Level 3, Dinner: bedroom, living room, kitchen counter. A robot vacuum and the dog are moving around.
  {
    const group = new Group();
    const rects: Rect[] = [
      { x: 1.6, z: 6.9, hx: 0.25, hz: 0.25 },
      { x: 3.6, z: -2.0, hx: 0.3, hz: 0.25 },
    ];
    box(group, 1.6, 0.3, 6.9, 0.5, 0.6, 0.5, 0x7e57c2);
    box(group, 3.6, 0.25, -2.0, 0.6, 0.5, 0.5, 0xbcaaa4);
    const vac = new Group();
    const disc = new Mesh(new CylinderGeometry(0.17, 0.17, 0.08, 24), mat(0x263238, 0.4));
    disc.position.y = 0.04;
    const light = new Mesh(new SphereGeometry(0.02, 8, 6), new MeshBasicMaterial({ color: 0x00e676 }));
    light.position.set(0, 0.085, -0.1);
    vac.add(disc, light);
    group.add(vac);
    const dog = new Group();
    const body = new Mesh(new BoxGeometry(0.28, 0.25, 0.6), mat(0xa1887f));
    body.position.y = 0.38;
    const head = new Mesh(new BoxGeometry(0.22, 0.22, 0.24), mat(0x8d6e63));
    head.position.set(0, 0.55, -0.38);
    const ear = new Mesh(new BoxGeometry(0.05, 0.1, 0.06), mat(0x5d4037));
    ear.position.set(0.09, 0.66, -0.36);
    const ear2 = ear.clone();
    ear2.position.x = -0.09;
    dog.add(body, head, ear, ear2);
    for (const dx of [-0.1, 0.1])
      for (const dz of [-0.22, 0.22]) {
        const leg = new Mesh(new BoxGeometry(0.06, 0.26, 0.06), mat(0x8d6e63));
        leg.position.set(dx, 0.13, dz);
        dog.add(leg);
      }
    group.add(dog);
    buildMeal(group, 4.2, 0.94, -7.55, 'dinner');
    const mover = (mesh: Object3D, ax: number, az: number, bx: number, bz: number, speed: number, radius: number): Mover => ({
      mesh, ax, az, bx, bz, speed, radius, t: 0, dir: 1, x: ax, z: az,
    });
    levels.push({
      title: 'LEVEL 3 \u00B7 DINNER',
      objective: 'Bedroom to the kitchen counter. Watch out for the vacuum and the dog!',
      start: [-3.0, 4.2, -Math.PI / 2],
      goal: [4.0, -6.6],
      time: 85,
      group,
      rects,
      movers: [
        mover(vac, 1.2, 3.6, 4.4, 3.6, 0.45, 0.2),
        mover(dog, 1.4, -6.1, 4.6, -6.1, 0.6, 0.3),
      ],
    });
  }
  return levels;
}

// ---------- The game system ----------
export class RimRushSystem extends createSystem({}) {
  private sfx = new Sfx();
  private state: GameState = 'ready';
  private mode: Mode = 'two';
  private stateTime = 0;

  private houseRoot = new Group();
  private rig = new Group();
  private chairPivot = new Group();
  private leftWheel!: Object3D;
  private rightWheel!: Object3D;
  private leftRim!: Group;
  private rightRim!: Group;
  private hud!: Mesh;
  private arrow!: Mesh;
  private marker!: Mesh;
  private vignette!: Mesh;
  private vignetteMat!: MeshBasicMaterial;
  private vignetteOn = true;
  private hudCanvas!: HTMLCanvasElement;
  private hudCtx!: CanvasRenderingContext2D;
  private hudTexture!: CanvasTexture;
  private hudDirty = true;
  private hudTimer = 0;

  private headLocal = new Vector3(0, 1.2, 0);
  private yaw0 = 0;
  private calibrated = false;
  private calibrateFrames = 0;
  private inXR = false;

  // Simulation (world space)
  private x = 0;
  private z = 0;
  private heading = 0;
  private vL = 0;
  private vR = 0;
  private omega = 0;
  private sharedRects: Rect[] = [];
  private levels: Level[] = [];
  private levelIndex = 0;
  private timeLeft = 0;
  private bumps = 0;
  private bumpCooldown = 0;
  private stars = 0;

  // Input
  private hands: Record<Side, HandState> = { left: makeHand(), right: makeHand() };
  private selectHeld: Record<Side, boolean> = { left: false, right: false };
  private listenedSession: XRSession | null = null;

  // Scratch
  private fwd = new Vector3();
  private right = new Vector3();
  private tmpV = new Vector3();

  init(): void {
    this.world.createTransformEntity(this.houseRoot);
    this.player.add(this.rig);
    this.rig.add(this.chairPivot);
    this.scene.fog = null;

    buildShell(this.houseRoot, this.sharedRects);
    this.levels = buildLevels();
    for (const level of this.levels) {
      level.group.visible = false;
      this.houseRoot.add(level.group);
    }
    this.marker = buildMarker(this.houseRoot, 0, 0);

    const chair = buildChair();
    this.leftWheel = chair.leftWheel;
    this.rightWheel = chair.rightWheel;
    this.chairPivot.add(chair.root);
    this.leftRim = buildGrabRim(0x00b0ff);
    this.rightRim = buildGrabRim(0xff4081);
    this.chairPivot.add(this.leftRim, this.rightRim);
    const arrowGeo = new ConeGeometry(0.03, 0.09, 12);
    arrowGeo.rotateX(-Math.PI / 2); // tip points along -Z
    this.arrow = new Mesh(arrowGeo, new MeshBasicMaterial({ color: 0x66ff99 }));
    this.chairPivot.add(this.arrow);

    this.buildHud();
    this.buildVignette();
    this.loadLevel(0);

    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((v) => {
        const nowXR = v !== VisibilityState.NonImmersive;
        if (nowXR !== this.inXR) {
          this.inXR = nowXR;
          this.calibrated = false;
          this.calibrateFrames = 0;
        }
        if (v === VisibilityState.Visible) {
          this.sfx.resume();
          this.world.session?.updateTargetFrameRate?.(72);
        }
      }),
      () => this.rig.removeFromParent(),
    );
  }

  private buildHud(): void {
    this.hudCanvas = document.createElement('canvas');
    this.hudCanvas.width = 1024;
    this.hudCanvas.height = 512;
    const ctx = this.hudCanvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.hudCtx = ctx;
    this.hudTexture = new CanvasTexture(this.hudCanvas);
    this.hudTexture.colorSpace = SRGBColorSpace;
    this.hud = new Mesh(
      new PlaneGeometry(0.8, 0.4),
      new MeshBasicMaterial({ map: this.hudTexture, transparent: true, side: DoubleSide, depthTest: false, depthWrite: false }),
    );
    this.hud.renderOrder = 10;
    this.chairPivot.add(this.hud);
  }

  private buildVignette(): void {
    const tex = canvasTexture(256, 256, (c) => {
      const g = c.createRadialGradient(128, 128, 40, 128, 128, 128);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.55, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,1)');
      c.fillStyle = g;
      c.fillRect(0, 0, 256, 256);
    });
    this.vignetteMat = new MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
    this.vignette = new Mesh(new PlaneGeometry(0.5, 0.5), this.vignetteMat);
    this.vignette.position.set(0, 0, -0.15);
    this.vignette.renderOrder = 999;
    this.camera.add(this.vignette);
    this.cleanupFuncs.push(() => this.vignette.removeFromParent());
  }

  private drawHud(): void {
    const c = this.hudCtx;
    const w = this.hudCanvas.width;
    const h = this.hudCanvas.height;
    const level = this.levels[this.levelIndex];
    c.clearRect(0, 0, w, h);
    const playing = this.state === 'playing';
    c.fillStyle = playing ? 'rgba(20, 24, 32, 0.55)' : 'rgba(20, 24, 32, 0.88)';
    c.beginPath();
    c.roundRect(8, 8, w - 16, playing ? 200 : h - 16, 36);
    c.fill();
    c.strokeStyle = '#66ff99';
    c.lineWidth = 5;
    c.stroke();
    c.textAlign = 'center';
    const modeText = this.mode === 'two' ? 'TWO-RIM MODE' : 'ONE-HAND MODE';
    const starText = (n: number) => '\u2605'.repeat(n) + '\u2606'.repeat(3 - n);

    if (playing) {
      c.fillStyle = '#ffffff';
      c.font = 'bold 44px sans-serif';
      c.fillText(level.title, w / 2, 70);
      c.fillStyle = this.timeLeft < 15 ? '#ff5252' : '#66ff99';
      c.font = 'bold 72px sans-serif';
      c.fillText(`${Math.ceil(this.timeLeft)}s`, w / 2 - 170, 160);
      c.fillStyle = '#ffd54f';
      c.fillText(`Bumps ${this.bumps}`, w / 2 + 150, 160);
    } else if (this.state === 'ready') {
      c.fillStyle = '#66ff99';
      c.font = 'bold 60px sans-serif';
      c.fillText('RIM RUSH: MEAL RUN', w / 2, 90);
      c.fillStyle = '#ffffff';
      c.font = 'bold 44px sans-serif';
      c.fillText(level.title, w / 2, 160);
      c.font = '34px sans-serif';
      c.fillStyle = '#dddfe3';
      c.fillText(level.objective, w / 2, 215);
      c.fillText(`${level.time} seconds \u00B7 bumping furniture costs ${BUMP_PENALTY}s`, w / 2, 262);
      c.fillText('Pinch + push forward to roll \u00B7 push one rim to turn', w / 2, 330);
      c.fillText('Hold a rim still to brake \u00B7 follow the green arrow', w / 2, 375);
      c.fillStyle = '#ffd54f';
      c.fillText(`Pinch BOTH hands to start (${modeText}) \u00B7 one hand? hold 2 s`, w / 2, 445);
    } else if (this.state === 'won' || this.state === 'done') {
      c.fillStyle = '#66ff99';
      c.font = 'bold 72px sans-serif';
      c.fillText(this.state === 'done' ? 'BON APP\u00C9TIT!' : 'MEAL REACHED!', w / 2, 100);
      c.fillStyle = '#ffd54f';
      c.font = 'bold 90px sans-serif';
      c.fillText(starText(this.stars), w / 2, 210);
      c.fillStyle = '#ffffff';
      c.font = '38px sans-serif';
      c.fillText(`${Math.ceil(this.timeLeft)}s left \u00B7 ${this.bumps} bumps`, w / 2, 280);
      const best = readNumber(`rimrush.stars.${this.levelIndex}`);
      c.fillText(`Best for this level: ${starText(best)}`, w / 2, 335);
      c.fillStyle = '#dddfe3';
      c.font = '34px sans-serif';
      c.fillText(
        this.state === 'done' ? 'All three meals done! Pinch both hands to play again' : 'Pinch both hands for the next meal',
        w / 2,
        430,
      );
    } else {
      c.fillStyle = '#ff5252';
      c.font = 'bold 72px sans-serif';
      c.fillText("TIME'S UP!", w / 2, 110);
      c.fillStyle = '#ffffff';
      c.font = '38px sans-serif';
      c.fillText('Your food got cold. Try a smoother route.', w / 2, 200);
      c.fillText(`Bumps: ${this.bumps}`, w / 2, 260);
      c.fillStyle = '#ffd54f';
      c.fillText('Pinch both hands to retry', w / 2, 360);
    }
    this.hudTexture.needsUpdate = true;
    this.hudDirty = false;
  }

  private calibrate(): void {
    this.camera.updateMatrix();
    this.headLocal.copy(this.camera.position);
    this.tmpV.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.yaw0 = Math.atan2(-this.tmpV.x, -this.tmpV.z);
    this.chairPivot.position.set(this.headLocal.x, 0, this.headLocal.z);
    this.chairPivot.rotation.set(0, this.yaw0, 0);
    // Seat about 0.75 m below the eyes. Never below the floor.
    const chairRoot = this.chairPivot.children[0];
    chairRoot.position.y = Math.max(0, this.headLocal.y - 1.25);
    const rimY = this.headLocal.y - 0.45;
    this.leftRim.position.set(-0.27, rimY, -0.2);
    this.rightRim.position.set(0.27, rimY, -0.2);
    this.arrow.position.set(0, this.headLocal.y - 0.42, -0.45);
    this.hud.position.set(0, this.headLocal.y + 0.38, -1.5);
    this.hud.rotation.set(0.22, 0, 0);
    this.fwd.set(-Math.sin(this.yaw0), 0, -Math.cos(this.yaw0));
    this.right.set(Math.cos(this.yaw0), 0, -Math.sin(this.yaw0));
    this.calibrated = true;
    this.applyRig();
  }

  /** Move the XR origin so your head sits at the chair position, facing `heading`. */
  private applyRig(): void {
    const rot = this.heading - this.yaw0;
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const hx = this.headLocal.x;
    const hz = this.headLocal.z;
    this.player.rotation.set(0, rot, 0);
    this.player.position.set(this.x - (c * hx + s * hz), 0, this.z - (-s * hx + c * hz));
  }

  // ----- level lifecycle -----
  private loadLevel(index: number): void {
    this.levelIndex = index;
    const level = this.levels[index];
    for (let i = 0; i < this.levels.length; i++) this.levels[i].group.visible = i === index;
    [this.x, this.z, this.heading] = level.start;
    this.vL = this.vR = this.omega = 0;
    this.timeLeft = level.time;
    this.bumps = 0;
    this.bumpCooldown = 0;
    for (const m of level.movers) {
      m.t = 0;
      m.dir = 1;
      m.x = m.ax;
      m.z = m.az;
      m.mesh.position.set(m.ax, 0, m.az);
    }
    this.marker.position.set(level.goal[0], 0.015, level.goal[1]);
    this.state = 'ready';
    this.stateTime = 0;
    if (this.calibrated) this.applyRig();
    this.hudDirty = true;
  }

  private startLevel(): void {
    this.loadLevel(this.levelIndex);
    this.state = 'playing';
    this.sfx.resume();
    this.sfx.start();
    this.hudDirty = true;
  }

  private finishLevel(): void {
    const level = this.levels[this.levelIndex];
    const frac = this.timeLeft / level.time;
    this.stars = frac > 0.4 && this.bumps <= 2 ? 3 : this.bumps <= 6 ? 2 : 1;
    const key = `rimrush.stars.${this.levelIndex}`;
    if (this.stars > readNumber(key)) writeNumber(key, this.stars);
    this.state = this.levelIndex === this.levels.length - 1 ? 'done' : 'won';
    this.stateTime = 0;
    this.vL = this.vR = this.omega = 0;
    this.sfx.win();
    this.hudDirty = true;
  }

  private failLevel(): void {
    this.state = 'failed';
    this.stateTime = 0;
    this.vL = this.vR = this.omega = 0;
    this.sfx.fail();
    this.hudDirty = true;
  }

  private onStartGesture(): void {
    if (this.state === 'ready' || this.state === 'failed') this.startLevel();
    else if (this.state === 'won') {
      this.loadLevel(this.levelIndex + 1);
      this.startLevel();
    } else if (this.state === 'done') {
      this.loadLevel(0);
      this.startLevel();
    }
  }

  // ----- input -----
  private readHands(): void {
    const session = this.world.session;
    const frame = this.xrFrame as XRFrame | undefined;
    const refSpace = this.world.renderer.xr.getReferenceSpace();
    this.hands.left.tracked = false;
    this.hands.right.tracked = false;
    if (!session || !frame || !refSpace) {
      this.hands.left.pinching = false;
      this.hands.right.pinching = false;
      return;
    }

    // The platform's own pinch ("select") events are a reliable backup signal.
    if (this.listenedSession !== session) {
      this.listenedSession = session;
      this.selectHeld.left = false;
      this.selectHeld.right = false;
      const onStart = (e: XRInputSourceEvent) => {
        const h = e.inputSource.handedness;
        if (h === 'left' || h === 'right') this.selectHeld[h] = true;
      };
      const onEnd = (e: XRInputSourceEvent) => {
        const h = e.inputSource.handedness;
        if (h === 'left' || h === 'right') this.selectHeld[h] = false;
      };
      session.addEventListener('selectstart', onStart);
      session.addEventListener('selectend', onEnd);
    }

    for (const source of session.inputSources) {
      const side = source.handedness;
      if (side !== 'left' && side !== 'right') continue;
      const hand = this.hands[side];
      if (source.hand) {
        const thumb = source.hand.get('thumb-tip');
        const index = source.hand.get('index-finger-tip');
        if (!thumb || !index || !frame.getJointPose) continue;
        const tp = frame.getJointPose(thumb, refSpace);
        const ip = frame.getJointPose(index, refSpace);
        if (!tp || !ip) continue;
        const a = tp.transform.position;
        const b = ip.transform.position;
        const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
        hand.pinching = (hand.pinching ? d < PINCH_OFF : d < PINCH_ON) || this.selectHeld[side];
        // Reference-space positions are local to the XR origin: riding never counts as pushing.
        hand.pos.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
        hand.tracked = true;
      } else if (source.gamepad) {
        // Controllers are optional; trigger acts as pinch.
        hand.pinching = source.gamepad.buttons[0]?.pressed ?? false;
        this.player.gripSpaces[side].getWorldPosition(hand.pos);
        this.player.worldToLocal(hand.pos);
        hand.tracked = true;
      }
    }
    if (!this.hands.left.tracked) this.hands.left.pinching = false;
    if (!this.hands.right.tracked) this.hands.right.pinching = false;
  }

  private applyInput(dt: number): boolean {
    const kb = this.input.keyboard;
    const L = this.hands.left;
    const R = this.hands.right;
    let startGesture = false;

    if (kb.getKeyDown('KeyM') && this.state !== 'playing') {
      this.mode = this.mode === 'two' ? 'one' : 'two';
      this.hudDirty = true;
    }
    if (kb.getKeyDown('KeyV')) this.vignetteOn = !this.vignetteOn;
    if (kb.getKeyDown('Space')) startGesture = true;

    if (this.state !== 'playing') {
      L.holdTime = L.pinching ? L.holdTime + dt : 0;
      R.holdTime = R.pinching ? R.holdTime + dt : 0;
      if (L.pinching && R.pinching) {
        this.mode = 'two';
        startGesture = true;
      } else if (L.holdTime > ONE_HAND_HOLD || R.holdTime > ONE_HAND_HOLD) {
        this.mode = 'one';
        startGesture = true;
      }
      if (startGesture) {
        L.holdTime = 0;
        R.holdTime = 0;
      }
    }

    if (this.state === 'playing') {
      if (this.mode === 'two') {
        this.vL = this.driveRim(L, this.vL, dt);
        this.vR = this.driveRim(R, this.vR, dt);
      } else {
        this.driveOneHand(L.pinching ? L : R, dt);
      }

      // Keyboard driving
      const push = 3 * dt;
      if (kb.getKeyPressed('KeyQ')) this.vL += push;
      if (kb.getKeyPressed('KeyA')) this.vL -= push;
      if (kb.getKeyPressed('KeyE')) this.vR += push;
      if (kb.getKeyPressed('KeyD')) this.vR -= push;
      const up = kb.getKeyPressed('ArrowUp');
      const down = kb.getKeyPressed('ArrowDown');
      const left = kb.getKeyPressed('ArrowLeft');
      const rightKey = kb.getKeyPressed('ArrowRight');
      if (up || down || left || rightKey) {
        const speed = up ? KEY_SPEED : down ? -KEY_SPEED * 0.4 : (this.vL + this.vR) / 2;
        const turn = (left ? 1 : 0) - (rightKey ? 1 : 0);
        const diff = (turn * KEY_TURN * TRACK) / 2;
        this.vL = this.approach(this.vL, speed - diff, dt * 3);
        this.vR = this.approach(this.vR, speed + diff, dt * 3);
      }
      this.vL = Math.max(-MAX_WHEEL * 0.4, Math.min(MAX_WHEEL, this.vL));
      this.vR = Math.max(-MAX_WHEEL * 0.4, Math.min(MAX_WHEEL, this.vR));
    }

    L.wasPinching = L.pinching;
    R.wasPinching = R.pinching;
    L.last.copy(L.pos);
    R.last.copy(R.pos);
    return startGesture;
  }

  private driveRim(hand: HandState, v: number, dt: number): number {
    if (hand.pinching && !hand.wasPinching) this.sfx.grab();
    if (hand.pinching && hand.wasPinching) {
      this.tmpV.subVectors(hand.pos, hand.last);
      const along = this.tmpV.dot(this.fwd); // + = pushing away from you
      if (Math.abs(along) < 0.0008) {
        hand.stillTime += dt;
        // Holding a rim still on purpose brakes; a short pause after a push just coasts.
        v *= Math.exp(-(hand.stillTime > BRAKE_HOLD ? BRAKE_DECAY : COAST_DECAY) * dt);
      } else {
        hand.stillTime = 0;
        v += along * PUSH_GAIN; // a 15 cm push adds ~1.2 m/s
      }
    } else {
      hand.stillTime = 0;
      v *= Math.exp(-COAST_DECAY * dt);
    }
    return v;
  }

  private driveOneHand(hand: HandState, dt: number): void {
    if (hand.pinching && !hand.wasPinching) {
      hand.anchor.copy(hand.pos);
      this.sfx.grab();
    }
    if (!hand.pinching) {
      const k = Math.exp(-COAST_DECAY * 2 * dt);
      this.vL *= k;
      this.vR *= k;
      return;
    }
    this.tmpV.subVectors(hand.pos, hand.anchor);
    const f = Math.max(-1, Math.min(1, this.tmpV.dot(this.fwd) / ONE_HAND_RANGE));
    const s = Math.max(-1, Math.min(1, this.tmpV.dot(this.right) / ONE_HAND_RANGE));
    const speed = f >= 0 ? f * ONE_HAND_SPEED : f * ONE_HAND_SPEED * 0.4;
    const diff = (-s * ONE_HAND_TURN * TRACK) / 2;
    this.vL = this.approach(this.vL, speed - diff, dt * 3);
    this.vR = this.approach(this.vR, speed + diff, dt * 3);
  }

  private approach(v: number, target: number, rate: number): number {
    return v + (target - v) * Math.min(1, rate);
  }


  // ----- simulation -----
  /** Push the chair circle out of an axis-aligned box. Returns true if it touched. */
  private resolveRect(r: Rect): boolean {
    const cx = Math.max(r.x - r.hx, Math.min(this.x, r.x + r.hx));
    const cz = Math.max(r.z - r.hz, Math.min(this.z, r.z + r.hz));
    const dx = this.x - cx;
    const dz = this.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= CHAIR_RADIUS * CHAIR_RADIUS) return false;
    const d = Math.sqrt(d2);
    if (d > 1e-5) {
      this.x = cx + (dx / d) * CHAIR_RADIUS;
      this.z = cz + (dz / d) * CHAIR_RADIUS;
    } else {
      // Centre inside the box: push out along the shallowest axis.
      const px = r.hx - Math.abs(this.x - r.x);
      const pz = r.hz - Math.abs(this.z - r.z);
      if (px < pz) this.x = r.x + Math.sign(this.x - r.x || 1) * (r.hx + CHAIR_RADIUS);
      else this.z = r.z + Math.sign(this.z - r.z || 1) * (r.hz + CHAIR_RADIUS);
    }
    return true;
  }

  private bump(strength: number): void {
    // Real wheelchairs stop dead against furniture.
    this.vL *= 0.2;
    this.vR *= 0.2;
    if (this.bumpCooldown <= 0 && strength > 0.25) {
      this.bumps++;
      this.timeLeft = Math.max(0, this.timeLeft - BUMP_PENALTY);
      this.bumpCooldown = 0.8;
      this.sfx.bump();
      this.hudDirty = true;
    }
  }

  private simulate(dt: number): void {
    const level = this.levels[this.levelIndex];
    const v = (this.vL + this.vR) / 2;
    this.omega = (this.vR - this.vL) / TRACK;
    this.heading += this.omega * dt;
    this.x += -Math.sin(this.heading) * v * dt;
    this.z += -Math.cos(this.heading) * v * dt;

    this.bumpCooldown -= dt;
    let hit = false;
    for (let pass = 0; pass < 2; pass++) {
      for (const r of this.sharedRects) hit = this.resolveRect(r) || hit;
      for (const r of level.rects) hit = this.resolveRect(r) || hit;
    }
    if (hit) this.bump(Math.abs(v));

    // Moving hazards
    for (const m of level.movers) {
      const len = Math.hypot(m.bx - m.ax, m.bz - m.az);
      m.t += (m.dir * m.speed * dt) / len;
      if (m.t > 1 || m.t < 0) {
        m.dir = -m.dir;
        m.t = Math.max(0, Math.min(1, m.t));
      }
      m.x = m.ax + (m.bx - m.ax) * m.t;
      m.z = m.az + (m.bz - m.az) * m.t;
      m.mesh.position.set(m.x, 0, m.z);
      m.mesh.rotation.y = Math.atan2(-(m.bx - m.ax) * m.dir, -(m.bz - m.az) * m.dir);
      const dx = this.x - m.x;
      const dz = this.z - m.z;
      const d = Math.hypot(dx, dz);
      const minD = CHAIR_RADIUS + m.radius;
      if (d < minD && d > 1e-5) {
        this.x = m.x + (dx / d) * minD;
        this.z = m.z + (dz / d) * minD;
        this.bump(1);
      }
    }

    this.timeLeft -= dt;
    const shown = Math.ceil(this.timeLeft);
    if (shown !== this.hudTimer) {
      this.hudTimer = shown;
      this.hudDirty = true;
    }
    if (Math.hypot(this.x - level.goal[0], this.z - level.goal[1]) < GOAL_RADIUS) {
      this.finishLevel();
      return;
    }
    if (this.timeLeft <= 0) {
      this.timeLeft = 0;
      this.failLevel();
      return;
    }

    // Wheels spin with their speeds (radius 0.3 m); grab rims mirror them.
    this.leftWheel.rotation.x -= (this.vL * dt) / 0.3;
    this.rightWheel.rotation.x -= (this.vR * dt) / 0.3;
    this.leftRim.rotation.x = this.leftWheel.rotation.x;
    this.rightRim.rotation.x = this.rightWheel.rotation.x;
  }

  update(delta: number, time: number): void {
    const vis = this.world.visibilityState.peek();
    if (vis === VisibilityState.VisibleBlurred || vis === VisibilityState.Hidden) return;
    const dt = Math.min(delta, 1 / 30);

    if (!this.calibrated && (!this.inXR || ++this.calibrateFrames > 10)) this.calibrate();

    const panel = this.world.getSceneObject('welcome-panel');
    if (panel) panel.visible = !this.inXR && this.state === 'ready';

    this.readHands();
    const start = this.applyInput(dt);
    this.stateTime += dt;

    if (DEBUG && Math.floor(time * 2) !== Math.floor((time - delta) * 2)) {
      console.info(
        `[rr] ${this.state}/${this.mode} L${this.levelIndex} pos=${this.x.toFixed(2)},${this.z.toFixed(2)} h=${this.heading.toFixed(2)} ` +
          `vL=${this.vL.toFixed(2)} vR=${this.vR.toFixed(2)} L${this.hands.left.pinching ? 'P' : '-'} R${this.hands.right.pinching ? 'P' : '-'} ` +
          `t=${this.timeLeft.toFixed(1)} bumps=${this.bumps}`,
      );
    }

    if (this.state === 'playing') this.simulate(dt);
    else if (start && this.stateTime > 0.8) this.onStartGesture();
    this.applyRig();

    // Guide arrow points toward the meal, relative to where the chair faces.
    const level = this.levels[this.levelIndex];
    const goalYaw = Math.atan2(-(level.goal[0] - this.x), -(level.goal[1] - this.z));
    this.arrow.rotation.y = goalYaw - this.heading;
    this.arrow.visible = this.state === 'playing';
    this.marker.scale.setScalar(1 + Math.sin(time * 4) * 0.05);

    // Comfort vignette while moving or turning.
    const speed = Math.abs((this.vL + this.vR) / 2);
    const target = this.vignetteOn && this.state === 'playing' ? Math.min(0.8, Math.abs(this.omega) * 0.4 + speed * 0.15) : 0;
    this.vignetteMat.opacity += (target - this.vignetteMat.opacity) * Math.min(1, dt * 8);
    this.vignette.visible = this.vignetteMat.opacity > 0.01;

    this.leftRim.scale.setScalar(this.hands.left.pinching ? 1.12 : 1);
    this.rightRim.scale.setScalar(this.hands.right.pinching ? 1.12 : 1);
    const showRims = this.inXR && (this.mode === 'two' || this.state !== 'playing');
    this.leftRim.visible = showRims;
    this.rightRim.visible = showRims;

    if (this.hudDirty) this.drawHud();
  }
}
