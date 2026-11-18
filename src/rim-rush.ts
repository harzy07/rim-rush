/**
 * Rim Rush: first-person, hands-first wheelchair light-trail game (VR).
 *
 * You sit in the wheelchair. Push the rims with your hands to roll through a
 * neon arena, collect orbs, and avoid the walls, cones and the light wall you
 * leave behind you (Snake / light-cycle rules).
 *
 * Controls
 * - Two-rim mode: pinch with a hand to grab that side's rim, move the pinched
 *   hand forward (away from you) to push, back to reverse. Holding a pinched rim
 *   still brakes that wheel. Push one rim harder to turn.
 * - One-hand mode: hold a pinch with one hand for 2 s on the start screen. While
 *   pinched, the hand works like a joystick: forward = drive, sideways = turn.
 * - Keyboard (desktop / emulator): arrow keys drive, Q/A left rim, E/D right rim,
 *   Space start/restart, M toggle mode, V toggle comfort vignette.
 */
import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  createSystem,
  CylinderGeometry,
  DoubleSide,
  Fog,
  Group,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  RepeatWrapping,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
  VisibilityState,
} from '@iwsdk/core';

// ---------- Tuning (metres, seconds) ----------
const HALF = 10; // arena half-size: 20 m x 20 m
const CHAIR_RADIUS = 0.45;
const TRACK = 1.6; // virtual wheel spacing: bigger = gentler turns (comfort)
const PUSH_GAIN = 8; // wheel speed (m/s) gained per metre of hand travel
const MAX_WHEEL = 2.8; // m/s per wheel
const COAST_DECAY = 0.35; // per second; wheelchairs roll
const BRAKE_DECAY = 4;
const BRAKE_HOLD = 0.35; // seconds holding a rim still before it brakes
const ONE_HAND_SPEED = 2.2;
const ONE_HAND_TURN = 1.4; // rad/s at full deflection
const ONE_HAND_RANGE = 0.12; // metres of hand travel for full deflection
const KEY_SPEED = 2.4;
const KEY_TURN = 1.5;
const PINCH_ON = 0.018;
const PINCH_OFF = 0.03;
const TRAIL_STEP = 0.5;
const TRAIL_BASE = 6;
const TRAIL_PER_ORB = 5;
const TRAIL_MAX = 400;
const TRAIL_SKIP = 4; // most recent trail segments ignored for self-collision
const ORB_RADIUS = 0.35;
const OBSTACLE_COUNT = 9;
const ONE_HAND_HOLD = 2;
const SPAWN_Z = HALF - 2.5;
const DEBUG = false;

type GameState = 'ready' | 'playing' | 'over';
type Mode = 'two' | 'one';
type Side = 'left' | 'right';

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

/** Wheelchair you sit in. Origin = floor point under your head; you face -Z. */
function buildChair(): { root: Group; leftWheel: Object3D; rightWheel: Object3D } {
  const root = new Group();
  const frameMat = new MeshStandardMaterial({ color: 0x1e88ff, metalness: 0.7, roughness: 0.3 });
  const seatMat = new MeshStandardMaterial({ color: 0x1b1f27, roughness: 0.85 });
  const tyreMat = new MeshStandardMaterial({ color: 0x0b0b0b, roughness: 0.9 });
  const rimMat = neon(0x00e5ff, 0.8);
  const legMat = new MeshStandardMaterial({ color: 0x263238, roughness: 0.8 });
  const shoeMat = new MeshStandardMaterial({ color: 0xff3d7f, roughness: 0.6 });

  const seat = new Mesh(new BoxGeometry(0.44, 0.05, 0.42), seatMat);
  seat.position.set(0, 0.5, 0.05);
  const back = new Mesh(new BoxGeometry(0.44, 0.45, 0.04), seatMat);
  back.position.set(0, 0.75, 0.27);
  root.add(seat, back);

  // Frame rails, footrest and your legs (visible when you look down)
  for (const x of [-0.23, 0.23]) {
    const rail = new Mesh(new BoxGeometry(0.03, 0.03, 0.62), frameMat);
    rail.position.set(x, 0.46, -0.05);
    const down = new Mesh(new BoxGeometry(0.03, 0.4, 0.03), frameMat);
    down.position.set(x * 0.7, 0.28, -0.38);
    down.rotation.x = -0.25;
    root.add(rail, down);
  }
  const foot = new Mesh(new BoxGeometry(0.36, 0.02, 0.14), frameMat);
  foot.position.set(0, 0.1, -0.45);
  root.add(foot);
  for (const x of [-0.1, 0.1]) {
    const thigh = new Mesh(new BoxGeometry(0.13, 0.12, 0.42), legMat);
    thigh.position.set(x, 0.58, -0.12);
    const shin = new Mesh(new BoxGeometry(0.11, 0.42, 0.11), legMat);
    shin.position.set(x, 0.33, -0.36);
    shin.rotation.x = -0.2;
    const shoe = new Mesh(new BoxGeometry(0.11, 0.07, 0.2), shoeMat);
    shoe.position.set(x, 0.14, -0.47);
    root.add(thigh, shin, shoe);
  }

  const makeWheel = (x: number): Object3D => {
    const wheel = new Group();
    const tyre = new Mesh(new TorusGeometry(0.3, 0.025, 10, 40), tyreMat);
    tyre.rotation.y = Math.PI / 2;
    const rim = new Mesh(new TorusGeometry(0.27, 0.008, 8, 40), rimMat);
    rim.rotation.y = Math.PI / 2;
    rim.position.x = x > 0 ? 0.035 : -0.035;
    wheel.add(tyre, rim);
    for (let i = 0; i < 6; i++) {
      const spoke = new Mesh(new BoxGeometry(0.006, 0.56, 0.008), frameMat);
      spoke.rotation.x = (i * Math.PI) / 6;
      wheel.add(spoke);
    }
    wheel.position.set(x, 0.32, 0.12);
    root.add(wheel);
    return wheel;
  };
  const leftWheel = makeWheel(-0.3);
  const rightWheel = makeWheel(0.3);

  for (const x of [-0.18, 0.18]) {
    const caster = new Mesh(new CylinderGeometry(0.06, 0.06, 0.03, 16), tyreMat);
    caster.rotation.z = Math.PI / 2;
    caster.position.set(x, 0.06, -0.38);
    root.add(caster);
  }
  return { root, leftWheel, rightWheel };
}

/** The floating "grab rims" at chest height, where hand tracking works best. */
function buildGrabRim(color: number): Group {
  const g = new Group();
  const ring = new Mesh(new TorusGeometry(0.12, 0.009, 10, 48), neon(color, 1.1));
  ring.rotation.y = Math.PI / 2;
  const spokeMat = new MeshStandardMaterial({ color: 0x9aa4ad, metalness: 0.7, roughness: 0.3, transparent: true, opacity: 0.6 });
  for (let i = 0; i < 4; i++) {
    const spoke = new Mesh(new BoxGeometry(0.003, 0.23, 0.004), spokeMat);
    spoke.rotation.x = (i * Math.PI) / 4;
    g.add(spoke);
  }
  g.add(ring);
  return g;
}

// ---------- The game system ----------
export class RimRushSystem extends createSystem({}) {
  private sfx = new Sfx();
  private state: GameState = 'ready';
  private mode: Mode = 'two';
  private stateTime = 0;

  // Scene graph
  private worldRoot = new Group(); // arena, in world space
  private rig = new Group(); // attached to the player (XR origin): chair, rims, HUD
  private chairPivot = new Group(); // sits under your head, faces your forward
  private leftWheel!: Object3D;
  private rightWheel!: Object3D;
  private leftRim!: Group;
  private rightRim!: Group;
  private hud!: Mesh;
  private orb!: Mesh;
  private orbGlow!: Mesh;
  private trailMesh!: InstancedMesh;
  private obstacles: Mesh[] = [];
  private vignette!: Mesh;
  private vignetteMat!: MeshBasicMaterial;
  private vignetteOn = true;
  private hudCanvas!: HTMLCanvasElement;
  private hudCtx!: CanvasRenderingContext2D;
  private hudTexture!: CanvasTexture;
  private hudDirty = true;

  // Calibration: where your head is inside the XR origin, and which way you faced.
  private headLocal = new Vector3(0, 1.2, 0);
  private yaw0 = 0;
  private calibrated = false;
  private calibrateFrames = 0;
  private inXR = false;

  // Simulation (world space)
  private x = 0;
  private z = SPAWN_Z;
  private heading = 0; // world yaw of the chair; 0 = facing -Z
  private vL = 0;
  private vR = 0;
  private omega = 0;
  private distSinceSample = 0;
  private trailX = new Float32Array(TRAIL_MAX);
  private trailZ = new Float32Array(TRAIL_MAX);
  private trailYaw = new Float32Array(TRAIL_MAX);
  private trailHead = 0;
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

  // Scratch (no per-frame allocations)
  private fwd = new Vector3(); // chair forward in rig-local space
  private right = new Vector3();
  private tmpV = new Vector3();
  private tmpObj = new Object3D();

  init(): void {
    this.best = readNumber('rimrush.best');
    this.bestToday = readNumber(`rimrush.day.${this.dayKey}`);

    this.world.createTransformEntity(this.worldRoot);
    this.player.add(this.rig);
    this.rig.add(this.chairPivot);

    this.buildEnvironment();
    this.buildArena();
    this.buildChairRig();
    this.buildHud();
    this.buildVignette();
    this.resetRun();

    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((v) => {
        const nowXR = v !== VisibilityState.NonImmersive;
        if (nowXR !== this.inXR) {
          this.inXR = nowXR;
          this.calibrated = false; // re-measure head height when entering/leaving XR
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

  // ----- building -----
  private buildEnvironment(): void {
    // Night-sky dome
    const skyTex = canvasTexture(16, 512, (c) => {
      const g = c.createLinearGradient(0, 0, 0, 512);
      g.addColorStop(0, '#05010f');
      g.addColorStop(0.45, '#1a0b3d');
      g.addColorStop(0.52, '#ff2bd6');
      g.addColorStop(0.56, '#1a0b3d');
      g.addColorStop(1, '#030308');
      c.fillStyle = g;
      c.fillRect(0, 0, 16, 512);
    });
    const sky = new Mesh(
      new SphereGeometry(80, 32, 16),
      new MeshBasicMaterial({ map: skyTex, side: BackSide, fog: false, depthWrite: false }),
    );
    this.worldRoot.add(sky);
    this.scene.fog = new Fog(0x0a0518, 14, 45);

    // Ground outside the arena
    const ground = new Mesh(new PlaneGeometry(160, 160), new MeshBasicMaterial({ color: 0x06040c }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.01;
    this.worldRoot.add(ground);
  }

  private buildArena(): void {
    const gridTex = canvasTexture(256, 256, (c) => {
      c.fillStyle = '#0b0f1a';
      c.fillRect(0, 0, 256, 256);
      c.strokeStyle = '#1f6feb';
      c.lineWidth = 6;
      c.strokeRect(0, 0, 256, 256);
      c.strokeStyle = 'rgba(31,111,235,0.35)';
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(128, 0);
      c.lineTo(128, 256);
      c.moveTo(0, 128);
      c.lineTo(256, 128);
      c.stroke();
    });
    gridTex.wrapS = RepeatWrapping;
    gridTex.wrapT = RepeatWrapping;
    gridTex.repeat.set(HALF, HALF); // one tile = 2 m
    const floor = new Mesh(new PlaneGeometry(HALF * 2, HALF * 2), new MeshBasicMaterial({ map: gridTex }));
    floor.rotation.x = -Math.PI / 2;
    this.worldRoot.add(floor);

    // Neon walls
    const wallMat = neon(0xff2bd6, 1.4);
    const wallH = 0.9;
    const t = 0.15;
    const walls: Array<[number, number, number, number]> = [
      [0, -HALF - t / 2, HALF * 2 + t * 2, t],
      [0, HALF + t / 2, HALF * 2 + t * 2, t],
      [-HALF - t / 2, 0, t, HALF * 2],
      [HALF + t / 2, 0, t, HALF * 2],
    ];
    for (const [x, z, w, d] of walls) {
      const wall = new Mesh(new BoxGeometry(w, wallH, d), wallMat);
      wall.position.set(x, wallH / 2, z);
      this.worldRoot.add(wall);
    }

    // Orb
    this.orb = new Mesh(new SphereGeometry(ORB_RADIUS * 0.5, 20, 14), neon(0x39ff14, 2.2));
    this.orbGlow = new Mesh(
      new SphereGeometry(ORB_RADIUS, 20, 14),
      new MeshBasicMaterial({ color: 0x39ff14, transparent: true, opacity: 0.25, blending: AdditiveBlending, depthWrite: false }),
    );
    this.orb.add(this.orbGlow);
    this.worldRoot.add(this.orb);

    // Obstacles (positions set per day)
    const obsMat = neon(0xff6d00, 0.9);
    const stripeMat = new MeshBasicMaterial({ color: 0xffffff });
    for (let i = 0; i < OBSTACLE_COUNT; i++) {
      const cone = new Mesh(new ConeGeometry(1, 1, 20), obsMat);
      const stripe = new Mesh(new CylinderGeometry(0.62, 0.72, 0.12, 20), stripeMat);
      stripe.position.y = -0.1;
      cone.add(stripe);
      this.obstacles.push(cone);
      this.worldRoot.add(cone);
    }

    // Light-wall trail
    this.trailMesh = new InstancedMesh(
      new BoxGeometry(0.06, 0.7, TRAIL_STEP * 1.02),
      new MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.75 }),
      TRAIL_MAX,
    );
    this.trailMesh.count = 0;
    this.trailMesh.frustumCulled = false;
    this.worldRoot.add(this.trailMesh);
  }

  private buildChairRig(): void {
    const chair = buildChair();
    this.leftWheel = chair.leftWheel;
    this.rightWheel = chair.rightWheel;
    this.chairPivot.add(chair.root);

    this.leftRim = buildGrabRim(0x00e5ff);
    this.rightRim = buildGrabRim(0xff2bd6);
    this.chairPivot.add(this.leftRim, this.rightRim);
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
      new MeshBasicMaterial({ map: this.hudTexture, transparent: true, side: DoubleSide, depthWrite: false, fog: false }),
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
    this.vignetteMat = new MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
      fog: false,
    });
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
    c.clearRect(0, 0, w, h);
    const playing = this.state === 'playing';
    c.fillStyle = playing ? 'rgba(8, 12, 20, 0.45)' : 'rgba(8, 12, 20, 0.85)';
    c.beginPath();
    c.roundRect(8, 8, w - 16, h - 16, 40);
    c.fill();
    c.strokeStyle = '#ff2bd6';
    c.lineWidth = 6;
    c.stroke();
    c.textAlign = 'center';

    const modeText = this.mode === 'two' ? 'TWO-RIM MODE' : 'ONE-HAND MODE';
    const bestText = `Best today ${this.bestToday}   ·   All-time ${this.best}`;
    if (this.state === 'ready') {
      c.fillStyle = '#00e5ff';
      c.font = 'bold 96px sans-serif';
      c.fillText('RIM RUSH', w / 2, 115);
      c.fillStyle = '#ffffff';
      c.font = '38px sans-serif';
      c.fillText(`Daily arena ${this.dayKey}  ·  ${modeText}`, w / 2, 180);
      c.fillStyle = '#dddfe3';
      c.font = '34px sans-serif';
      c.fillText('Pinch BOTH hands to start. Pinch + push forward to roll.', w / 2, 255);
      c.fillText('Push one rim harder to turn. Hold a rim still to brake.', w / 2, 300);
      c.fillText('One hand? HOLD a pinch for 2 seconds.', w / 2, 345);
      c.fillText('Grab green orbs. Avoid walls, cones and your light trail.', w / 2, 400);
      c.fillStyle = '#ffd400';
      c.fillText(bestText, w / 2, 465);
    } else if (playing) {
      c.fillStyle = '#39ff14';
      c.font = 'bold 120px sans-serif';
      c.fillText(String(this.score), w / 2, 190);
      c.fillStyle = '#dddfe3';
      c.font = '36px sans-serif';
      c.fillText(modeText, w / 2, 270);
      c.fillStyle = '#ffd400';
      c.fillText(bestText, w / 2, 330);
    } else {
      c.fillStyle = '#ff2bd6';
      c.font = 'bold 96px sans-serif';
      c.fillText('CRASH!', w / 2, 120);
      c.fillStyle = '#ffffff';
      c.font = 'bold 72px sans-serif';
      c.fillText(`Score ${this.score}`, w / 2, 220);
      c.fillStyle = '#ffd400';
      c.font = '38px sans-serif';
      c.fillText(bestText, w / 2, 295);
      c.fillStyle = '#dddfe3';
      c.font = '34px sans-serif';
      c.fillText('Pinch both hands (or hold one) to ride again', w / 2, 375);
      c.fillText('Same arena all day. Can you beat your best?', w / 2, 425);
    }
    this.hudTexture.needsUpdate = true;
    this.hudDirty = false;
  }

  // ----- calibration -----
  /** Measure where the head is inside the XR origin and build the chair under it. */
  private calibrate(): void {
    this.camera.updateMatrix();
    this.headLocal.copy(this.camera.position);
    // Camera looks down its -Z axis; take its yaw in origin space.
    this.tmpV.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.yaw0 = Math.atan2(-this.tmpV.x, -this.tmpV.z);

    this.chairPivot.position.set(this.headLocal.x, 0, this.headLocal.z);
    this.chairPivot.rotation.set(0, this.yaw0, 0);

    // Seat 0.75 m below the eyes (typical seated eye height above the seat).
    const chairRoot = this.chairPivot.children[0];
    chairRoot.position.y = Math.max(0, this.headLocal.y - 1.25);
    // Grab rims: chest height, a little forward and out to the sides.
    const rimY = this.headLocal.y - 0.38;
    this.leftRim.position.set(-0.24, rimY, -0.28);
    this.rightRim.position.set(0.24, rimY, -0.28);
    // HUD: ahead and above the horizon so it never hides orbs or cones.
    this.hud.position.set(0, this.headLocal.y + 0.42, -1.6);
    this.hud.rotation.set(0.22, 0, 0);

    this.fwd.set(-Math.sin(this.yaw0), 0, -Math.cos(this.yaw0));
    this.right.set(Math.cos(this.yaw0), 0, -Math.sin(this.yaw0));
    this.calibrated = true;
    this.applyRig();
  }

  /** Move the XR origin so that your head sits at the chair position, facing `heading`. */
  private applyRig(): void {
    const rot = this.heading - this.yaw0;
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const hx = this.headLocal.x;
    const hz = this.headLocal.z;
    this.player.rotation.set(0, rot, 0);
    this.player.position.set(this.x - (c * hx + s * hz), 0, this.z - (-s * hx + c * hz));
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
      for (let tries = 0; tries < 30; tries++) {
        ox = (this.rng() * 2 - 1) * (HALF - 1.5);
        oz = (this.rng() * 2 - 1) * (HALF - 1.5);
        const clearOfSpawn = Math.hypot(ox, oz - SPAWN_Z) > 3.5 && !(Math.abs(ox) < 1.2 && oz > 0);
        if (clearOfSpawn) break;
      }
      const r = 0.45 + this.rng() * 0.35;
      this.obstacleX[i] = ox;
      this.obstacleZ[i] = oz;
      this.obstacleR[i] = r;
      const cone = this.obstacles[i];
      cone.scale.set(r, 1.3, r);
      cone.position.set(ox, 0.65, oz);
    }

    this.x = 0;
    this.z = SPAWN_Z;
    this.heading = 0;
    this.vL = 0;
    this.vR = 0;
    this.omega = 0;
    this.trailHead = 0;
    this.trailCount = 0;
    this.trailLength = TRAIL_BASE;
    this.distSinceSample = 0;
    this.trailMesh.count = 0;
    this.score = 0;
    this.spawnOrb(true);
    if (this.calibrated) this.applyRig();
    this.hudDirty = true;
  }

  private spawnOrb(first = false): void {
    if (first) {
      // First orb straight ahead so new players learn the push immediately.
      this.orbX = 0;
      this.orbZ = SPAWN_Z - 4;
    } else {
      for (let tries = 0; tries < 60; tries++) {
        const ox = (this.rng() * 2 - 1) * (HALF - 1.2);
        const oz = (this.rng() * 2 - 1) * (HALF - 1.2);
        const d = Math.hypot(ox - this.x, oz - this.z);
        if (d < 3 || d > 12) continue;
        let blocked = false;
        for (let i = 0; i < OBSTACLE_COUNT; i++) {
          if (Math.hypot(ox - this.obstacleX[i], oz - this.obstacleZ[i]) < this.obstacleR[i] + 1) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;
        this.orbX = ox;
        this.orbZ = oz;
        break;
      }
    }
    this.orb.position.set(this.orbX, 0.9, this.orbZ);
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
    this.omega = 0;
    this.hudDirty = true;
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
  private simulate(dt: number): void {
    const v = (this.vL + this.vR) / 2;
    this.omega = (this.vR - this.vL) / TRACK;
    this.heading += this.omega * dt;
    const dx = -Math.sin(this.heading) * v * dt;
    const dz = -Math.cos(this.heading) * v * dt;
    this.x += dx;
    this.z += dz;

    // Trail sampling (light wall behind you)
    this.distSinceSample += Math.hypot(dx, dz);
    if (this.distSinceSample >= TRAIL_STEP) {
      this.distSinceSample = 0;
      this.trailX[this.trailHead] = this.x - dx * 0.5;
      this.trailZ[this.trailHead] = this.z - dz * 0.5;
      this.trailYaw[this.trailHead] = this.heading;
      this.trailHead = (this.trailHead + 1) % TRAIL_MAX;
      this.trailCount = Math.min(this.trailCount + 1, this.trailLength);
      this.writeTrail();
    }

    if (Math.abs(this.x) > HALF - CHAIR_RADIUS || Math.abs(this.z) > HALF - CHAIR_RADIUS) {
      this.endRun();
      return;
    }
    for (let i = 0; i < OBSTACLE_COUNT; i++) {
      if (Math.hypot(this.x - this.obstacleX[i], this.z - this.obstacleZ[i]) < this.obstacleR[i] + CHAIR_RADIUS) {
        this.endRun();
        return;
      }
    }
    for (let n = TRAIL_SKIP; n < this.trailCount; n++) {
      const idx = (this.trailHead - 1 - n + TRAIL_MAX * 2) % TRAIL_MAX;
      if (Math.hypot(this.x - this.trailX[idx], this.z - this.trailZ[idx]) < CHAIR_RADIUS * 0.8) {
        this.endRun();
        return;
      }
    }
    if (Math.hypot(this.x - this.orbX, this.z - this.orbZ) < ORB_RADIUS + CHAIR_RADIUS + 0.2) {
      this.score++;
      this.trailLength = Math.min(TRAIL_MAX, TRAIL_BASE + this.score * TRAIL_PER_ORB);
      this.sfx.orb(this.score);
      this.spawnOrb();
      this.hudDirty = true;
    }

    // Wheels spin with their speeds (radius 0.3 m)
    this.leftWheel.rotation.x -= (this.vL * dt) / 0.3;
    this.rightWheel.rotation.x -= (this.vR * dt) / 0.3;
    this.leftRim.rotation.x = this.leftWheel.rotation.x;
    this.rightRim.rotation.x = this.rightWheel.rotation.x;
  }

  private writeTrail(): void {
    for (let n = 0; n < this.trailCount; n++) {
      const idx = (this.trailHead - 1 - n + TRAIL_MAX * 2) % TRAIL_MAX;
      this.tmpObj.position.set(this.trailX[idx], 0.35, this.trailZ[idx]);
      this.tmpObj.rotation.set(0, this.trailYaw[idx], 0);
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

    // Wait a few frames in XR so the head pose is real before measuring it.
    if (!this.calibrated && (!this.inXR || ++this.calibrateFrames > 10)) this.calibrate();

    // The 2D welcome panel is only useful in the browser before a run.
    const panel = this.world.getSceneObject('welcome-panel');
    if (panel) panel.visible = !this.inXR && this.state !== 'playing';

    this.readHands();
    const start = this.applyInput(dt);
    this.stateTime += dt;

    if (DEBUG && Math.floor(time * 2) !== Math.floor((time - delta) * 2)) {
      console.info(
        `[rr] ${this.state}/${this.mode} pos=${this.x.toFixed(2)},${this.z.toFixed(2)} h=${this.heading.toFixed(2)} ` +
          `vL=${this.vL.toFixed(2)} vR=${this.vR.toFixed(2)} L${this.hands.left.pinching ? 'P' : '-'} R${this.hands.right.pinching ? 'P' : '-'} ` +
          `player=${this.player.position.x.toFixed(2)},${this.player.position.z.toFixed(2)} rot=${this.player.rotation.y.toFixed(2)} ` +
          `cam=${this.camera.getWorldPosition(this.tmpV).x.toFixed(2)},${this.tmpV.z.toFixed(2)} camParent=${this.camera.parent?.type}/${this.camera.parent === this.player} yaw0=${this.yaw0.toFixed(2)}`,
      );
    }

    if (this.state === 'playing') {
      this.simulate(dt);
    } else if (start && this.stateTime > 0.8) {
      this.startRun();
    }
    this.applyRig();

    // Comfort vignette: darken the edges while moving or turning.
    const speed = Math.abs((this.vL + this.vR) / 2);
    const target = this.vignetteOn && this.state === 'playing'
      ? Math.min(0.85, Math.abs(this.omega) * 0.45 + speed * 0.12)
      : 0;
    this.vignetteMat.opacity += (target - this.vignetteMat.opacity) * Math.min(1, dt * 8);
    this.vignette.visible = this.vignetteMat.opacity > 0.01;

    // Orb animation
    this.orb.position.y = 0.9 + Math.sin(time * 3) * 0.1;
    this.orb.rotation.y = time * 2;
    this.orbGlow.scale.setScalar(1 + Math.sin(time * 6) * 0.15);

    // Rims light up while pinched; hide them in one-hand mode during a run.
    this.leftRim.scale.setScalar(this.hands.left.pinching ? 1.1 : 1);
    this.rightRim.scale.setScalar(this.hands.right.pinching ? 1.1 : 1);
    const showRims = this.inXR && (this.mode === 'two' || this.state !== 'playing');
    this.leftRim.visible = showRims;
    this.rightRim.visible = showRims;

    if (this.hudDirty) this.drawHud();
  }
}
