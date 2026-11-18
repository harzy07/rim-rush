/**
 * Rim Rush: hands-first mixed reality wheelchair Snake on your table.
 *
 * Controls
 * - Two-rim mode: pinch with a hand to grab that side's rim, then move the
 *   pinched hand forward (away from you) to push, back to reverse. Holding a
 *   pinch without moving brakes that wheel. Push one rim harder to turn.
 * - One-hand mode: hold a pinch with one hand for ~1.5 s on the start screen.
 *   While pinched, the hand works like a joystick: forward = drive, sideways = turn.
 * - Keyboard (desktop / emulator): Q/A left rim, E/D right rim,
 *   arrow keys for one-hand style driving, Space to start/restart, M to toggle mode.
 */
import {
  AdditiveBlending,
  BoxGeometry,
  CanvasTexture,
  Color,
  createSystem,
  CylinderGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
  VisibilityState,
} from '@iwsdk/core';

// ---------- Tuning ----------
const HALF = 0.28; // arena half-size in metres (arena is 56 cm square)
const CHAIR_RADIUS = 0.016;
const TRACK = 0.1; // virtual distance between wheels, controls turn rate (bigger = wider turns)
const PUSH_GAIN = 0.9; // wheel speed gained per metre of hand travel
const MAX_WHEEL = 0.2; // m/s per wheel
const COAST_DECAY = 0.5; // per second, wheelchairs roll
const BRAKE_DECAY = 6;
const ONE_HAND_SPEED = 0.16;
const ONE_HAND_TURN = 3.2; // rad/s at full deflection
const ONE_HAND_RANGE = 0.12; // metres of hand travel for full deflection
const PINCH_ON = 0.018;
const PINCH_OFF = 0.03;
const TRAIL_STEP = 0.012;
const TRAIL_BASE = 12;
const TRAIL_PER_ORB = 9;
const TRAIL_MAX = 700;
const TRAIL_SKIP = 8; // most recent trail points ignored for self-collision
const ORB_RADIUS = 0.022;
const OBSTACLE_COUNT = 4;
const ONE_HAND_HOLD = 2;
const DEBUG = false;
const BRAKE_HOLD = 0.35; // seconds of holding a pinched rim still before it brakes

type GameState = 'ready' | 'playing' | 'over';
type Mode = 'two' | 'one';
type Side = 'left' | 'right';

interface HandState {
  pinching: boolean;
  wasPinching: boolean;
  tracked: boolean;
  pos: Vector3;
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

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

// ---------- Tiny synth for sound effects (no audio assets needed) ----------
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

  orb(combo: number): void {
    const base = 520 * Math.pow(1.06, Math.min(combo, 12));
    this.tone(base, base * 1.8, 0.18, 'triangle', 0.25);
  }
  start(): void {
    this.tone(330, 660, 0.25, 'sine', 0.2);
  }
  crash(): void {
    this.tone(220, 40, 0.6, 'sawtooth', 0.25);
  }
  grab(): void {
    this.tone(900, 700, 0.05, 'square', 0.05);
  }
}

// ---------- Scene building helpers ----------
function neon(color: number, intensity = 1.6): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color,
    emissive: new Color(color),
    emissiveIntensity: intensity,
    roughness: 0.4,
  });
}

function buildChair(): { root: Group; leftWheel: Object3D; rightWheel: Object3D } {
  const root = new Group();
  const frameMat = new MeshStandardMaterial({ color: 0x1e88ff, metalness: 0.6, roughness: 0.3 });
  const seatMat = new MeshStandardMaterial({ color: 0x222831, roughness: 0.8 });
  const tyreMat = new MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
  const rimMat = neon(0x00e5ff, 1.2);
  const skinMat = new MeshStandardMaterial({ color: 0xf2c49b, roughness: 0.7 });
  const shirtMat = new MeshStandardMaterial({ color: 0xff3d7f, roughness: 0.6 });

  const seat = new Mesh(new BoxGeometry(0.018, 0.003, 0.018), seatMat);
  seat.position.set(0, 0.013, 0.002);
  const back = new Mesh(new BoxGeometry(0.018, 0.016, 0.003), seatMat);
  back.position.set(0, 0.021, 0.011);
  const frame = new Mesh(new BoxGeometry(0.02, 0.002, 0.026), frameMat);
  frame.position.set(0, 0.009, -0.002);
  root.add(seat, back, frame);

  const makeWheel = (x: number): Object3D => {
    const wheel = new Group();
    const tyre = new Mesh(new TorusGeometry(0.011, 0.0018, 8, 24), tyreMat);
    const rim = new Mesh(new TorusGeometry(0.0125, 0.0006, 6, 24), rimMat);
    rim.position.x = x > 0 ? 0.0015 : -0.0015;
    const spoke = new Mesh(new BoxGeometry(0.0006, 0.02, 0.0012), frameMat);
    const spoke2 = spoke.clone();
    spoke2.rotation.x = Math.PI / 2;
    wheel.add(tyre, rim, spoke, spoke2);
    tyre.rotation.y = Math.PI / 2;
    rim.rotation.y = Math.PI / 2;
    wheel.position.set(x, 0.0128, 0.004);
    root.add(wheel);
    return wheel;
  };
  const leftWheel = makeWheel(-0.012);
  const rightWheel = makeWheel(0.012);

  for (const x of [-0.008, 0.008]) {
    const caster = new Mesh(new SphereGeometry(0.003, 8, 6), tyreMat);
    caster.position.set(x, 0.003, -0.013);
    root.add(caster);
  }

  // Rider
  const torso = new Mesh(new CylinderGeometry(0.005, 0.0065, 0.015, 10), shirtMat);
  torso.position.set(0, 0.0225, 0.004);
  const head = new Mesh(new SphereGeometry(0.0052, 12, 10), skinMat);
  head.position.set(0, 0.0345, 0.003);
  const helmet = new Mesh(
    new SphereGeometry(0.0056, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    neon(0xffd400, 0.6),
  );
  helmet.position.copy(head.position);
  const legs = new Mesh(new BoxGeometry(0.011, 0.003, 0.012), new MeshStandardMaterial({ color: 0x263238 }));
  legs.position.set(0, 0.016, -0.007);
  root.add(torso, head, helmet, legs);

  return { root, leftWheel, rightWheel };
}

function buildRim(color: number): Group {
  const g = new Group();
  const ring = new Mesh(new TorusGeometry(0.11, 0.008, 10, 48), neon(color, 1.1));
  ring.rotation.y = Math.PI / 2;
  const hub = new Mesh(new CylinderGeometry(0.012, 0.012, 0.01, 16), new MeshStandardMaterial({ color: 0x333333 }));
  hub.rotation.z = Math.PI / 2;
  const spokeMat = new MeshStandardMaterial({ color: 0x9aa4ad, metalness: 0.7, roughness: 0.3 });
  for (let i = 0; i < 4; i++) {
    const spoke = new Mesh(new BoxGeometry(0.003, 0.21, 0.004), spokeMat);
    spoke.rotation.x = (i * Math.PI) / 4;
    g.add(spoke);
  }
  g.add(ring, hub);
  return g;
}

// ---------- The game system ----------
export class RimRushSystem extends createSystem({}) {
  private sfx = new Sfx();
  private state: GameState = 'ready';
  private mode: Mode = 'two';
  private stateTime = 0;

  // Scene graph
  private anchor = new Group(); // arena placement
  private rimAnchor = new Group(); // floating rims placement
  private chair!: Group;
  private leftWheel!: Object3D;
  private rightWheel!: Object3D;
  private leftRim!: Group;
  private rightRim!: Group;
  private orb!: Mesh;
  private orbGlow!: Mesh;
  private trailMesh!: InstancedMesh;
  private obstacles: Mesh[] = [];
  private hudCanvas!: HTMLCanvasElement;
  private hudCtx!: CanvasRenderingContext2D;
  private hudTexture!: CanvasTexture;
  private hudDirty = true;

  // Simulation
  private x = 0;
  private z = 0;
  private heading = 0;
  private vL = 0;
  private vR = 0;
  private distSinceSample = 0;
  private trailX = new Float32Array(TRAIL_MAX);
  private trailZ = new Float32Array(TRAIL_MAX);
  private trailHead = 0; // ring buffer write index
  private trailCount = 0;
  private trailLength = TRAIL_BASE;
  private orbX = 0;
  private orbZ = 0;
  private score = 0;
  private best = 0;
  private bestToday = 0;
  private dayKey = todayKey();
  private rng: () => number = Math.random;
  private obstacleX = new Float32Array(OBSTACLE_COUNT);
  private obstacleZ = new Float32Array(OBSTACLE_COUNT);
  private obstacleR = new Float32Array(OBSTACLE_COUNT);

  // Input
  private hands: Record<Side, HandState> = { left: makeHand(), right: makeHand() };
  private selectHeld: Record<Side, boolean> = { left: false, right: false };
  private listenedSession: XRSession | null = null;
  private placedInXR = false;

  // Scratch (no per-frame allocations)
  private tmpV = new Vector3();
  private tmpV2 = new Vector3();
  private fwd = new Vector3();
  private right = new Vector3();
  private tmpM = new Matrix4();
  private tmpObj = new Object3D();

  init(): void {
    this.best = readNumber('rimrush.best');
    this.bestToday = readNumber(`rimrush.day.${this.dayKey}`);

    const root = new Group();
    root.add(this.anchor, this.rimAnchor);
    this.world.createTransformEntity(root);

    this.buildArena();
    this.buildRims();
    this.buildHud();
    this.placeForBrowser();
    this.resetRun();

    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((v) => {
        if (v === VisibilityState.Visible) {
          this.sfx.resume();
          this.world.session?.updateTargetFrameRate?.(72);
        }
        if (v === VisibilityState.NonImmersive) {
          this.placedInXR = false;
          this.placeForBrowser();
        }
      }),
    );
  }

  // ----- building -----
  private buildArena(): void {
    const base = new Mesh(
      new BoxGeometry(HALF * 2 + 0.03, 0.012, HALF * 2 + 0.03),
      new MeshStandardMaterial({ color: 0x0d1117, roughness: 0.6, metalness: 0.2, transparent: true, opacity: 0.92 }),
    );
    base.position.y = -0.006;
    this.anchor.add(base);

    // Grid lines
    const gridMat = new MeshBasicMaterial({ color: 0x1f6feb, transparent: true, opacity: 0.25 });
    const lines = 8;
    for (let i = -lines; i <= lines; i++) {
      const p = (i / lines) * HALF;
      const a = new Mesh(new BoxGeometry(HALF * 2, 0.0005, 0.0015), gridMat);
      a.position.set(0, 0.0003, p);
      const b = new Mesh(new BoxGeometry(0.0015, 0.0005, HALF * 2), gridMat);
      b.position.set(p, 0.0003, 0);
      this.anchor.add(a, b);
    }

    // Neon walls
    const wallMat = neon(0xff2bd6, 1.4);
    const wallH = 0.02;
    const t = 0.006;
    const walls: Array<[number, number, number, number]> = [
      [0, -HALF - t / 2, HALF * 2 + t * 2, t],
      [0, HALF + t / 2, HALF * 2 + t * 2, t],
      [-HALF - t / 2, 0, t, HALF * 2],
      [HALF + t / 2, 0, t, HALF * 2],
    ];
    for (const [x, z, w, d] of walls) {
      const wall = new Mesh(new BoxGeometry(w, wallH, d), wallMat);
      wall.position.set(x, wallH / 2, z);
      this.anchor.add(wall);
    }

    // Chair
    const chair = buildChair();
    this.chair = chair.root;
    this.leftWheel = chair.leftWheel;
    this.rightWheel = chair.rightWheel;
    this.anchor.add(this.chair);

    // Orb
    this.orb = new Mesh(new SphereGeometry(ORB_RADIUS * 0.55, 16, 12), neon(0x39ff14, 2.2));
    this.orbGlow = new Mesh(
      new SphereGeometry(ORB_RADIUS, 16, 12),
      new MeshBasicMaterial({ color: 0x39ff14, transparent: true, opacity: 0.25, blending: AdditiveBlending, depthWrite: false }),
    );
    this.orb.add(this.orbGlow);
    this.anchor.add(this.orb);

    // Obstacles (positions set per day)
    const obsMat = neon(0xff6d00, 0.9);
    for (let i = 0; i < OBSTACLE_COUNT; i++) {
      const cone = new Mesh(new CylinderGeometry(0.002, 1, 1, 12), obsMat);
      this.obstacles.push(cone);
      this.anchor.add(cone);
    }

    // Trail
    this.trailMesh = new InstancedMesh(
      new BoxGeometry(0.009, 0.006, 0.009),
      neon(0x00e5ff, 1.8),
      TRAIL_MAX,
    );
    this.trailMesh.count = 0;
    this.trailMesh.frustumCulled = false;
    this.anchor.add(this.trailMesh);
  }

  private buildRims(): void {
    this.leftRim = buildRim(0x00e5ff);
    this.rightRim = buildRim(0xff2bd6);
    this.leftRim.position.set(-0.2, 0, 0);
    this.rightRim.position.set(0.2, 0, 0);
    this.rimAnchor.add(this.leftRim, this.rightRim);
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
    const hud = new Mesh(
      new PlaneGeometry(0.4, 0.2),
      new MeshBasicMaterial({ map: this.hudTexture, transparent: true, side: DoubleSide, depthWrite: false }),
    );
    hud.position.set(0, 0.14, -HALF - 0.05);
    hud.rotation.x = -0.25;
    this.anchor.add(hud);
  }

  private drawHud(): void {
    const c = this.hudCtx;
    const w = this.hudCanvas.width;
    const h = this.hudCanvas.height;
    c.clearRect(0, 0, w, h);
    c.fillStyle = 'rgba(8, 12, 20, 0.78)';
    c.beginPath();
    c.roundRect(8, 8, w - 16, h - 16, 40);
    c.fill();
    c.strokeStyle = '#ff2bd6';
    c.lineWidth = 6;
    c.stroke();
    c.textAlign = 'center';

    const modeText = this.mode === 'two' ? 'TWO-RIM MODE' : 'ONE-HAND MODE';
    if (this.state === 'ready') {
      c.fillStyle = '#00e5ff';
      c.font = 'bold 96px sans-serif';
      c.fillText('RIM RUSH', w / 2, 120);
      c.fillStyle = '#ffffff';
      c.font = '40px sans-serif';
      c.fillText(`Daily arena ${this.dayKey}  ·  ${modeText}`, w / 2, 190);
      c.font = '36px sans-serif';
      c.fillStyle = '#dddfe3';
      c.fillText('Pinch BOTH hands to start (two-rim mode)', w / 2, 270);
      c.fillText('or HOLD a pinch with one hand for one-hand mode', w / 2, 320);
      c.fillText('Grab orbs, grow your trail, avoid walls, cones and your trail', w / 2, 390);
      c.fillStyle = '#ffd400';
      c.fillText(`Best today ${this.bestToday}   ·   All-time ${this.best}`, w / 2, 460);
    } else if (this.state === 'playing') {
      c.fillStyle = '#39ff14';
      c.font = 'bold 150px sans-serif';
      c.fillText(String(this.score), w / 2, 230);
      c.fillStyle = '#dddfe3';
      c.font = '40px sans-serif';
      c.fillText(modeText, w / 2, 320);
      c.fillStyle = '#ffd400';
      c.fillText(`Best today ${this.bestToday}   ·   All-time ${this.best}`, w / 2, 400);
    } else {
      c.fillStyle = '#ff2bd6';
      c.font = 'bold 96px sans-serif';
      c.fillText('CRASH!', w / 2, 120);
      c.fillStyle = '#ffffff';
      c.font = 'bold 72px sans-serif';
      c.fillText(`Score ${this.score}`, w / 2, 220);
      c.fillStyle = '#ffd400';
      c.font = '40px sans-serif';
      c.fillText(`Best today ${this.bestToday}   ·   All-time ${this.best}`, w / 2, 300);
      c.fillStyle = '#dddfe3';
      c.font = '36px sans-serif';
      c.fillText('Pinch both hands (or hold one) to ride again', w / 2, 380);
      c.fillText('Same arena all day. Beat your ghost score!', w / 2, 430);
    }
    this.hudTexture.needsUpdate = true;
    this.hudDirty = false;
  }

  // ----- placement -----
  private placeForBrowser(): void {
    this.anchor.position.set(0, 1.12, 0.15);
    this.anchor.rotation.set(0, 0, 0);
    this.rimAnchor.position.set(0, 1.3, 0.62);
    this.rimAnchor.rotation.set(0, 0, 0);
  }

  /** Place arena on a virtual "table" in front of the player and rims at chest height. */
  private placeInXR(): void {
    const head = this.player.head;
    head.updateWorldMatrix(true, false);
    head.getWorldPosition(this.tmpV);
    head.getWorldDirection(this.fwd); // points backwards for cameras in three.js
    this.fwd.y = 0;
    if (this.fwd.lengthSq() < 1e-4) this.fwd.set(0, 0, 1);
    this.fwd.normalize().negate(); // now points where the user looks
    const yaw = Math.atan2(-this.fwd.x, -this.fwd.z);

    this.anchor.position.set(
      this.tmpV.x + this.fwd.x * 0.6,
      this.tmpV.y - 0.55,
      this.tmpV.z + this.fwd.z * 0.6,
    );
    this.anchor.rotation.set(0, yaw, 0);
    this.rimAnchor.position.set(
      this.tmpV.x + this.fwd.x * 0.3,
      this.tmpV.y - 0.38,
      this.tmpV.z + this.fwd.z * 0.3,
    );
    this.rimAnchor.rotation.set(0, yaw, 0);
    this.placedInXR = true;
  }

  // ----- run lifecycle -----
  private resetRun(): void {
    this.dayKey = todayKey();
    this.bestToday = readNumber(`rimrush.day.${this.dayKey}`);
    const seed = Number(this.dayKey.replace(/-/g, ''));
    this.rng = mulberry32(seed);

    // Daily obstacle layout (same for everyone on the same day)
    for (let i = 0; i < OBSTACLE_COUNT; i++) {
      let ox = 0;
      let oz = 0;
      for (let tries = 0; tries < 20; tries++) {
        ox = (this.rng() * 2 - 1) * (HALF - 0.05);
        oz = (this.rng() * 2 - 1) * (HALF - 0.05);
        if (Math.hypot(ox, oz - 0.12) > 0.1) break; // keep the spawn clear
      }
      const r = 0.012 + this.rng() * 0.01;
      this.obstacleX[i] = ox;
      this.obstacleZ[i] = oz;
      this.obstacleR[i] = r;
      const cone = this.obstacles[i];
      cone.scale.set(r, 0.035, r);
      cone.position.set(ox, 0.0175, oz);
    }

    this.x = 0;
    this.z = 0.12;
    this.heading = 0;
    this.vL = 0;
    this.vR = 0;
    this.trailHead = 0;
    this.trailCount = 0;
    this.trailLength = TRAIL_BASE;
    this.distSinceSample = 0;
    this.trailMesh.count = 0;
    this.score = 0;
    this.spawnOrb();
    this.syncChair(0);
    this.hudDirty = true;
  }

  private spawnOrb(): void {
    for (let tries = 0; tries < 40; tries++) {
      const ox = (this.rng() * 2 - 1) * (HALF - 0.04);
      const oz = (this.rng() * 2 - 1) * (HALF - 0.04);
      if (Math.hypot(ox - this.x, oz - this.z) < 0.08) continue;
      let blocked = false;
      for (let i = 0; i < OBSTACLE_COUNT; i++) {
        if (Math.hypot(ox - this.obstacleX[i], oz - this.obstacleZ[i]) < this.obstacleR[i] + 0.04) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      this.orbX = ox;
      this.orbZ = oz;
      break;
    }
    this.orb.position.set(this.orbX, 0.02, this.orbZ);
  }

  private startRun(): void {
    this.resetRun();
    this.state = 'playing';
    this.stateTime = 0;
    this.sfx.resume();
    this.sfx.start();
    this.hudDirty = true;
  }

  private endRun(): void {
    this.state = 'over';
    this.stateTime = 0;
    this.sfx.crash();
    if (this.score > this.bestToday) {
      this.bestToday = this.score;
      writeNumber(`rimrush.day.${this.dayKey}`, this.score);
    }
    if (this.score > this.best) {
      this.best = this.score;
      writeNumber('rimrush.best', this.score);
    }
    this.vL = 0;
    this.vR = 0;
    this.hudDirty = true;
  }

  // ----- input -----
  private readHands(): void {
    const session = this.world.session;
    const frame = this.world.xrFrame as XRFrame | undefined;
    const refSpace = this.world.renderer.xr.getReferenceSpace();
    this.hands.left.tracked = false;
    this.hands.right.tracked = false;
    if (!session || !frame || !refSpace) return;

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

    this.player.updateWorldMatrix(true, false);
    for (const source of session.inputSources) {
      const side = source.handedness;
      if (side !== 'left' && side !== 'right') continue;
      const hand = this.hands[side];
      if (source.hand) {
        const thumb = source.hand.get('thumb-tip');
        const index = source.hand.get('index-finger-tip');
        const wrist = source.hand.get('wrist');
        if (!thumb || !index || !wrist || !frame.getJointPose) continue;
        const tp = frame.getJointPose(thumb, refSpace);
        const ip = frame.getJointPose(index, refSpace);
        if (!tp || !ip) continue;
        const dx = tp.transform.position.x - ip.transform.position.x;
        const dy = tp.transform.position.y - ip.transform.position.y;
        const dz = tp.transform.position.z - ip.transform.position.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        hand.pinching = (hand.pinching ? d < PINCH_OFF : d < PINCH_ON) || this.selectHeld[side];
        // Use the pinch point as the hand position.
        hand.pos.set(
          (tp.transform.position.x + ip.transform.position.x) / 2,
          (tp.transform.position.y + ip.transform.position.y) / 2,
          (tp.transform.position.z + ip.transform.position.z) / 2,
        );
        this.player.localToWorld(hand.pos);
        hand.tracked = true;
      } else if (source.gamepad) {
        // Controllers are optional; trigger acts as pinch.
        hand.pinching = source.gamepad.buttons[0]?.pressed ?? false;
        this.player.gripSpaces[side].getWorldPosition(hand.pos);
        hand.tracked = true;
      }
    }
    for (const side of ['left', 'right'] as const) {
      const hand = this.hands[side];
      if (!hand.tracked) hand.pinching = false;
    }
  }

  /** Forward / right axes of the rim rig in world space (where the arena faces). */
  private computeRigAxes(): void {
    const yaw = this.rimAnchor.rotation.y;
    this.fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    this.right.set(Math.cos(yaw), 0, -Math.sin(yaw));
  }

  private applyInput(dt: number): { anyStartGesture: boolean } {
    this.computeRigAxes();
    const kb = this.input.keyboard;
    const L = this.hands.left;
    const R = this.hands.right;
    let startGesture = false;

    // Keyboard toggles
    if (kb.getKeyDown('KeyM') && this.state !== 'playing') {
      this.mode = this.mode === 'two' ? 'one' : 'two';
      this.hudDirty = true;
    }
    if (kb.getKeyDown('Space')) startGesture = true;

    // Start gestures (hands)
    if (this.state !== 'playing') {
      for (const hand of [L, R]) {
        hand.holdTime = hand.pinching ? hand.holdTime + dt : 0;
      }
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
      const push = PUSH_GAIN * 0.25 * dt * 4;
      if (kb.getKeyPressed('KeyQ')) this.vL += push;
      if (kb.getKeyPressed('KeyA')) this.vL -= push;
      if (kb.getKeyPressed('KeyE')) this.vR += push;
      if (kb.getKeyPressed('KeyD')) this.vR -= push;
      const up = kb.getKeyPressed('ArrowUp');
      const down = kb.getKeyPressed('ArrowDown');
      const left = kb.getKeyPressed('ArrowLeft');
      const rightKey = kb.getKeyPressed('ArrowRight');
      if (up || down || left || rightKey) {
        const speed = up ? ONE_HAND_SPEED : down ? -ONE_HAND_SPEED * 0.5 : (this.vL + this.vR) / 2;
        const turn = (left ? 1 : 0) - (rightKey ? 1 : 0);
        const diff = (turn * ONE_HAND_TURN * TRACK) / 2;
        this.vL = this.approach(this.vL, speed - diff, dt * 4);
        this.vR = this.approach(this.vR, speed + diff, dt * 4);
      }
    }

    // Remember for next frame
    for (const hand of [L, R]) {
      hand.wasPinching = hand.pinching;
      hand.last.copy(hand.pos);
    }
    return { anyStartGesture: startGesture };
  }

  private driveRim(hand: HandState, v: number, dt: number): number {
    if (hand.pinching && !hand.wasPinching) this.sfx.grab();
    if (hand.pinching && hand.wasPinching) {
      this.tmpV2.subVectors(hand.pos, hand.last);
      const along = this.tmpV2.dot(this.fwd); // + = pushing away from you
      if (Math.abs(along) < 0.0008) {
        hand.stillTime += dt;
        // Holding a rim still on purpose brakes; a short pause after a push just coasts.
        v *= Math.exp(-(hand.stillTime > BRAKE_HOLD ? BRAKE_DECAY : COAST_DECAY) * dt);
      } else {
        hand.stillTime = 0;
        v += along * PUSH_GAIN * 1.5; // a 15 cm push reaches top speed
      }
    } else {
      hand.stillTime = 0;
      v *= Math.exp(-COAST_DECAY * dt);
    }
    return Math.max(-MAX_WHEEL * 0.5, Math.min(MAX_WHEEL, v));
  }

  private driveOneHand(hand: HandState, dt: number): void {
    if (hand.pinching && !hand.wasPinching) {
      hand.anchor.copy(hand.pos);
      this.sfx.grab();
    }
    if (!hand.pinching) {
      const k = Math.exp(-COAST_DECAY * dt);
      this.vL *= k;
      this.vR *= k;
      return;
    }
    this.tmpV2.subVectors(hand.pos, hand.anchor);
    const f = Math.max(-1, Math.min(1, this.tmpV2.dot(this.fwd) / ONE_HAND_RANGE));
    const s = Math.max(-1, Math.min(1, this.tmpV2.dot(this.right) / ONE_HAND_RANGE));
    const speed = f >= 0 ? f * ONE_HAND_SPEED : f * ONE_HAND_SPEED * 0.5;
    const diff = (-s * ONE_HAND_TURN * TRACK) / 2;
    this.vL = this.approach(this.vL, speed - diff, dt * 3);
    this.vR = this.approach(this.vR, speed + diff, dt * 3);
  }

  private approach(v: number, target: number, rate: number): number {
    return v + (target - v) * Math.min(1, rate);
  }

  // ----- simulation -----
  private simulate(dt: number): void {
    const v = (this.vL + this.vR) / 2;
    const omega = (this.vR - this.vL) / TRACK;
    this.heading += omega * dt;
    const dx = -Math.sin(this.heading) * v * dt;
    const dz = -Math.cos(this.heading) * v * dt;
    this.x += dx;
    this.z += dz;

    // Trail sampling
    this.distSinceSample += Math.hypot(dx, dz);
    if (this.distSinceSample >= TRAIL_STEP) {
      this.distSinceSample = 0;
      this.trailX[this.trailHead] = this.x;
      this.trailZ[this.trailHead] = this.z;
      this.trailHead = (this.trailHead + 1) % TRAIL_MAX;
      this.trailCount = Math.min(this.trailCount + 1, this.trailLength);
    }

    // Walls
    if (Math.abs(this.x) > HALF - CHAIR_RADIUS || Math.abs(this.z) > HALF - CHAIR_RADIUS) {
      this.endRun();
      return;
    }
    // Obstacles
    for (let i = 0; i < OBSTACLE_COUNT; i++) {
      if (Math.hypot(this.x - this.obstacleX[i], this.z - this.obstacleZ[i]) < this.obstacleR[i] + CHAIR_RADIUS) {
        this.endRun();
        return;
      }
    }
    // Own trail
    for (let n = TRAIL_SKIP; n < this.trailCount; n++) {
      const idx = (this.trailHead - 1 - n + TRAIL_MAX * 2) % TRAIL_MAX;
      if (Math.hypot(this.x - this.trailX[idx], this.z - this.trailZ[idx]) < CHAIR_RADIUS * 0.8) {
        this.endRun();
        return;
      }
    }
    // Orb
    if (Math.hypot(this.x - this.orbX, this.z - this.orbZ) < ORB_RADIUS + CHAIR_RADIUS) {
      this.score++;
      this.trailLength = Math.min(TRAIL_MAX, TRAIL_BASE + this.score * TRAIL_PER_ORB);
      this.sfx.orb(this.score);
      this.spawnOrb();
      this.hudDirty = true;
    }

    this.syncChair(dt);
  }

  private syncChair(dt: number): void {
    this.chair.position.set(this.x, 0, this.z);
    this.chair.rotation.y = this.heading;
    // Spin the wheels with their speeds (wheel radius ~1.1 cm).
    this.leftWheel.rotation.x -= (this.vL * dt) / 0.011;
    this.rightWheel.rotation.x -= (this.vR * dt) / 0.011;
    // The big floating rims mirror the wheels.
    this.leftRim.rotation.x = this.leftWheel.rotation.x;
    this.rightRim.rotation.x = this.rightWheel.rotation.x;

    // Trail instances
    for (let n = 0; n < this.trailCount; n++) {
      const idx = (this.trailHead - 1 - n + TRAIL_MAX * 2) % TRAIL_MAX;
      this.tmpObj.position.set(this.trailX[idx], 0.003, this.trailZ[idx]);
      const s = 1 - (n / Math.max(1, this.trailCount)) * 0.5;
      this.tmpObj.scale.set(s, 1, s);
      this.tmpObj.updateMatrix();
      this.trailMesh.setMatrixAt(n, this.tmpObj.matrix);
    }
    this.trailMesh.count = this.trailCount;
    this.trailMesh.instanceMatrix.needsUpdate = true;
  }

  update(delta: number, time: number): void {
    const vis = this.world.visibilityState.peek();
    if (vis === VisibilityState.VisibleBlurred || vis === VisibilityState.Hidden) return;
    const dt = Math.min(delta, 1 / 30);

    if (vis === VisibilityState.Visible && !this.placedInXR) {
      this.placeInXR();
      // The 2D welcome panel would float over the arena in XR, so hide it there.
      const panel = this.world.getSceneObject('welcome-panel');
      if (panel) panel.visible = false;
    }
    if (vis === VisibilityState.NonImmersive) {
      const panel = this.world.getSceneObject('welcome-panel');
      if (panel && !panel.visible) panel.visible = true;
    }

    this.readHands();
    const { anyStartGesture } = this.applyInput(dt);
    this.stateTime += dt;

    if (DEBUG && Math.floor(time * 2) !== Math.floor((time - delta) * 2)) {
      const l = this.hands.left;
      const r = this.hands.right;
      console.info(
        `[rr] ${this.state}/${this.mode} vL=${this.vL.toFixed(3)} vR=${this.vR.toFixed(3)} ` +
          `L(${l.tracked ? 'T' : '-'}${l.pinching ? 'P' : '-'} ${l.pos.x.toFixed(2)},${l.pos.y.toFixed(2)},${l.pos.z.toFixed(2)}) ` +
          `R(${r.tracked ? 'T' : '-'}${r.pinching ? 'P' : '-'} ${r.pos.x.toFixed(2)},${r.pos.y.toFixed(2)},${r.pos.z.toFixed(2)})`,
      );
    }

    if (this.state === 'playing') {
      this.simulate(dt);
    } else if (anyStartGesture && this.stateTime > 0.8) {
      this.startRun();
    }

    // Idle animation
    this.orb.position.y = 0.02 + Math.sin(time * 3) * 0.004;
    this.orb.rotation.y = time * 2;
    const glowScale = 1 + Math.sin(time * 6) * 0.15;
    this.orbGlow.scale.setScalar(glowScale);

    // Highlight rims while pinched
    this.leftRim.scale.setScalar(this.hands.left.pinching ? 1.08 : 1);
    this.rightRim.scale.setScalar(this.hands.right.pinching ? 1.08 : 1);
    // Rims only make sense in XR (in the desktop view they would cover the arena).
    this.rimAnchor.visible = this.placedInXR && (this.mode === 'two' || this.state !== 'playing');

    if (this.hudDirty) this.drawHud();
  }
}
