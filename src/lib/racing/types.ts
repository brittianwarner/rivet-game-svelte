import {
  CURATED_RACE_CARS,
  PLAYER_ACCENT_COLORS,
  type RaceCarId,
} from "./car-catalog.js";

// ---------------------------------------------------------------------------
// Vec3 helpers — shared between server actor and client store
// ---------------------------------------------------------------------------

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function plainVec3(v: Vec3): Vec3 {
  return { x: Number(v.x) || 0, y: Number(v.y) || 0, z: Number(v.z) || 0 };
}

export function vec3Zero(): Vec3 {
  return { x: 0, y: 0, z: 0 };
}

export function vec3Length(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

export function vec3Normalize(v: Vec3): Vec3 {
  const len = vec3Length(v);
  if (len < 0.0001) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

export function vec3Dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function vec3Distance(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function vec3Distance2D(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

// ---------------------------------------------------------------------------
// Sanitization helpers
// ---------------------------------------------------------------------------

export const MAX_PLAYER_NAME_LEN = 24;

export function sanitizeName(raw: unknown): string {
  if (typeof raw !== "string") return "Racer";
  const trimmed = raw.trim().slice(0, MAX_PLAYER_NAME_LEN);
  const cleaned = trimmed.replace(/[^\w\s\-]/g, "");
  return cleaned || "Racer";
}

// ---------------------------------------------------------------------------
// Track types
// ---------------------------------------------------------------------------

export interface TrackPoint {
  x: number;
  y: number; // elevation
  z: number;
  width: number;
  banking?: number; // radians, positive = banked right
}

export interface TrackSegment {
  /** Center of the road at this segment */
  center: Vec3;
  /** Left edge of the road */
  left: Vec3;
  /** Right edge of the road */
  right: Vec3;
  /** Forward direction (unit) along the track */
  forward: Vec3;
  /** Normal direction (unit) pointing right from center */
  normal: Vec3;
  /** Cumulative distance from start */
  distance: number;
}

export interface BoostZone {
  segmentStart: number;
  segmentEnd: number;
}

export interface ItemBoxZone {
  segmentIndex: number;
  /** Lateral positions across the road for each box */
  positions: Vec3[];
}

export interface CheckpointDef {
  segmentIndex: number;
  center: Vec3;
  normal: Vec3;
}

export interface ShortcutZone {
  segmentStart: number;
  segmentEnd: number;
  /** Centerline points for rendering the shortcut road */
  points: Vec3[];
}

export interface SceneryObject {
  position: Vec3;
  type: "pylon" | "block" | "billboard" | "arch";
  color: string;
  height: number;
  width?: number;
  depth?: number;
}

export type TrackId = "track1" | "neon-circuit";

/**
 * Static, sim-independent description of a track for the lobby/track picker
 * and HUD. Lives next to the (heightfield-free) track helpers so clients can
 * import it without pulling the server-only road mesh.
 */
export interface TrackMeta {
  id: TrackId;
  displayName: string;
  /** Short flavor used as the default room name + visual theme tag */
  theme: string;
  /** Approximate loop length in world units (one lap) */
  lengthM: number;
  difficulty: "easy" | "medium" | "hard";
}

/** Difficulty tier for CPU opponents — scales their base speed + driving line. */
export type BotDifficulty = "easy" | "medium" | "hard";

/**
 * Room game mode.
 *  - "race"      — the standard multiplayer race (bots, items, forfeit on drop).
 *  - "timeTrial" — solo against the clock + a localStorage ghost. The server
 *    skips bots, allows a lone player to launch without the 2-player auto-start
 *    gate, swaps the item table for a mushroom-only rotation, and never forfeits
 *    a disconnect. The ghost itself is purely client-side (zero server state).
 */
export type RaceMode = "race" | "timeTrial";

/**
 * Per-room race configuration chosen at creation. The first player to connect
 * to a fresh (waiting, unconfigured) room applies these via connection params;
 * thereafter the room is authoritative and ignores further config attempts.
 */
export interface RoomSettings {
  trackId: TrackId;
  /** Race vs solo time-trial — chosen at creation, locked once the room runs. */
  mode: RaceMode;
  /** Laps to win — clamped to [LAP_COUNT_MIN, LAP_COUNT_MAX] */
  lapCount: number;
  /** When false, no item boxes are generated and rolls are suppressed */
  itemsEnabled: boolean;
  /**
   * Fill empty grid slots with CPU opponents at race start. When undefined the
   * server defaults to ON for races with fewer than RACE_MAX_PLAYERS humans.
   */
  botsEnabled: boolean;
  /** Skill tier for the CPU opponents this room spawns. */
  botDifficulty: BotDifficulty;
}

export interface TrackVisualTransform {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

export type TrackVisualDefinition =
  | {
      kind: "procedural";
    }
  | {
      kind: "gltf";
      modelPath: string;
      transform: TrackVisualTransform;
    };

export interface TrackDefinition {
  points: TrackPoint[];
  segments: TrackSegment[];
  totalLength: number;
  boostZones: BoostZone[];
  itemBoxZones: ItemBoxZone[];
  checkpoints: CheckpointDef[];
  startPositions: Vec3[];
  startHeading: number;
  shortcuts: ShortcutZone[];
  scenery: SceneryObject[];
  visual: TrackVisualDefinition;
}

// ---------------------------------------------------------------------------
// Vehicle types
// ---------------------------------------------------------------------------

export interface KartInput {
  steering: number; // -1 (left) to +1 (right)
  throttle: boolean;
  brake: boolean;
  drift: boolean;
  useItem: boolean;
  /**
   * True while the player holds the item key with a holdable item (shells,
   * banana). The server exposes a defense point ~HELD_ITEM_DEFENSE_OFFSET units
   * behind the kart that destroys incoming shells (consuming the held item).
   * The fire happens via the dedicated useItem() action on release/tap, so this
   * flag only carries the "trail it behind me" intent in the input stream.
   */
  heldBehind?: boolean;
  /**
   * Client-stamped, monotonically increasing input sequence number used for
   * prediction/reconciliation. Optional because input builders (keyboard /
   * touch merge) produce unstamped intents — the wire sender stamps seq just
   * before transmission, and the server echoes the newest seq it has applied
   * per kart in snapshots (lastProcessedSeq).
   */
  seq?: number;
}

export type DriftDirection = -1 | 0 | 1;
export type DriftCharge = 0 | 1 | 2 | 3;

export interface DriftState {
  active: boolean;
  direction: DriftDirection;
  charge: DriftCharge;
  timer: number; // ticks in drift
}

export type KartStatus =
  | "normal"
  | "boosted"
  | "starred"
  | "shrunk"
  | "spinning"
  | "falling";

export type RocketStartTier = "perfect" | "good" | "ok" | "stall" | "none";

export interface RaceStats {
  itemsUsed: number;
  hitsDealt: number;
  hitsTaken: number;
  driftBoosts: number;
  topSpeed: number;
  bestLapTime: number | null;
}

export interface KartState {
  id: string;
  name: string;
  carId: RaceCarId;
  accentIndex: number; // stable player accent slot assigned on join
  /** CPU-controlled kart (no connection) — clients render a "CPU" badge. */
  isBot?: boolean;
  position: Vec3;
  heading: number; // radians
  speed: number;
  velocity: Vec3; // derived from heading+speed for interpolation
  driftState: DriftState;
  lap: number; // 0 = not started first lap, 1-3 = current lap
  checkpoint: number; // next checkpoint index (0-7)
  currentItem: ItemType | null;
  itemCharges: number;
  /**
   * The kart is trailing its held item behind it (rear-defense). True while the
   * player holds the item key with a holdable item; clients render the trailed
   * shell/banana at the rear anchor and an incoming shell that reaches the
   * defense point is destroyed, consuming the item.
   */
  heldItemActive: boolean;
  status: KartStatus;
  statusTimer: number; // ms remaining on status effect
  raceProgress: number; // continuous, checkpoint-gated progress in world units (lap * trackLength + arc distance)
  segmentIndex: number; // nearest track segment, cached by the server physics step
  finishTime: number | null; // ms from race start
  finishPosition: number | null; // 1-maxPlayers
  boostTimer: number; // ms remaining on any boost
  boostSpeed: number; // additional speed from boost
  slipstreamActive: boolean;
  slipstreamTicks: number;
  hitstopTicks: number;
  rocketStartTier: RocketStartTier;
  slipAngle: number;
  flowMeter: number;
  surface: SurfaceType;
  loadFactor: number;
}

// ---------------------------------------------------------------------------
// Item types
// ---------------------------------------------------------------------------

export type ItemType =
  | "greenShell"
  | "redShell"
  | "banana"
  | "mushroom"
  | "triMushroom"
  | "star"
  | "lightning"
  | "blueShell";

export interface ProjectileState {
  id: string;
  type: "greenShell" | "redShell" | "blueShell";
  position: Vec3;
  velocity: Vec3;
  ownerId: string;
  targetId: string | null;
  bounces: number;
  age: number; // ms
}

export interface HazardState {
  id: string;
  type: "banana";
  position: Vec3;
  ownerId: string;
}

export interface ItemBoxState {
  id: number;
  position: Vec3;
  active: boolean;
  respawnTimer: number;
}

// ---------------------------------------------------------------------------
// Race types
// ---------------------------------------------------------------------------

export type RacePhase =
  | "waiting"
  | "countdown"
  | "racing"
  | "finished";

export interface RaceRoomState {
  id: string;
  name: string;
  players: Record<string, KartState>;
  projectiles: ProjectileState[];
  hazards: HazardState[];
  itemBoxes: ItemBoxState[];
  phase: RacePhase;
  /** Race vs solo time-trial mode (drives bots/items/solo-start/forfeit rules) */
  mode: RaceMode;
  lapCount: number;
  /** When false, item boxes are not generated and item rolls are suppressed */
  itemsEnabled: boolean;
  /** Fill empty grid slots with CPU opponents at race start */
  botsEnabled: boolean;
  /** Skill tier for CPU opponents this room spawns */
  botDifficulty: BotDifficulty;
  raceTimer: number; // ms elapsed since race start
  maxPlayers: number;
  trackId: TrackId;
  createdAt: number;
  phaseStartedAt: number;
  positions: string[]; // ordered player IDs (1st first)
  finishedCount: number;
  readyPlayers: Record<string, boolean>;
  rematchVotes: Record<string, boolean>;
  stats: Record<string, RaceStats>;
}

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

export interface RaceSnapshot {
  karts: Record<
    string,
    {
      // Identity — lets clients upsert karts they missed a kartJoined for
      name: string;
      carId: RaceCarId;
      accentIndex: number;
      /** CPU flag echoed so an upserted kart still renders its "CPU" badge */
      isBot?: boolean;
      position: Vec3;
      heading: number;
      speed: number;
      velocity: Vec3;
      driftState: DriftState;
      status: KartStatus;
      statusTimer: number;
      currentItem: ItemType | null;
      itemCharges: number;
      /** Kart is trailing its held item behind it (rear-defense) */
      heldItemActive: boolean;
      lap: number;
      checkpoint: number;
      boostTimer: number;
      boostSpeed: number;
      slipstreamActive: boolean;
      slipAngle: number;
      flowMeter: number;
      surface: SurfaceType;
      loadFactor: number;
      /** Newest input seq the server has applied for this kart (prediction ack) */
      lastProcessedSeq: number;
    }
  >;
  projectiles: ProjectileState[];
  hazards: HazardState[];
  itemBoxes: { id: number; active: boolean }[];
  raceTimer: number;
  positions: string[];
  tick: number;
}

export interface KartJoinedEvent {
  kart: KartState;
}

export interface KartLeftEvent {
  kartId: string;
  kartName: string;
}

export interface ItemPickedUpEvent {
  kartId: string;
  item: ItemType;
  charges: number;
  boxId: number;
}

export interface ItemUsedEvent {
  kartId: string;
  item: ItemType;
  projectile?: ProjectileState;
  hazard?: HazardState;
}

export interface KartHitEvent {
  kartId: string;
  byKartId: string | null;
  itemType: ItemType | "collision";
}

export interface LapCompletedEvent {
  kartId: string;
  lap: number;
  raceTime: number;
  /**
   * Duration of the lap that was just completed, ms. Server-computed (race
   * timer at this crossing minus the previous crossing) so the HUD can show a
   * truthful lap split without re-deriving it from raceTime deltas the client
   * might have dropped a snapshot for. 0 for the opening (out-)lap.
   */
  lapTime: number;
}

export interface RaceFinishedEvent {
  positions: string[];
  finishTimes: Record<string, number | null>;
  stats: Record<string, RaceStats>;
}

export interface RacePhaseChangedEvent {
  phase: RacePhase;
  raceTimer: number;
}

export interface DriftTierEvent {
  kartId: string;
  tier: DriftCharge;
}

export interface SlipstreamEvent {
  kartId: string;
  active: boolean;
}

export interface RocketStartEvent {
  kartId: string;
  tier: RocketStartTier;
  boostSpeed: number;
}

export interface ReadyStateEvent {
  playerId: string;
  ready: boolean;
  readyCount: number;
  totalCount: number;
}

export interface RematchVoteEvent {
  votes: Record<string, boolean>;
  voteCount: number;
  needed: number;
}

export interface RaceToastEvent {
  text: string;
  color: string;
  icon?: string;
}

/**
 * A projectile/hazard/held-item was destroyed by a defensive contact (shell vs
 * shell, shell vs banana, or a shell stopped by a trailed item). Position is
 * the contact point so clients can spawn a small VFX/audio cue. `defenderId` is
 * set when a kart's trailed item blocked the shell (so the HUD can credit it).
 */
export interface ItemDestroyedEvent {
  x: number;
  y: number;
  z: number;
  /** What collided — drives the cue color/sound. */
  cause: "shellVsShell" | "shellVsBanana" | "trailBlock";
  /** The kart whose trailed item blocked an incoming shell (trailBlock only). */
  defenderId?: string;
}

/**
 * Items a kart may trail behind it for rear defense (and which therefore use
 * tap-vs-hold input handling). Speed/utility items fire immediately and are not
 * holdable. Shared by the server (defense-point logic) and the client (RaceInput
 * tap/hold timing, Kart trailed-item mesh, HUD hint).
 */
export const HOLDABLE_ITEMS: ReadonlySet<ItemType> = new Set<ItemType>([
  "greenShell",
  "redShell",
  "blueShell",
  "banana",
]);

export function isHoldableItem(item: ItemType | null | undefined): boolean {
  return item != null && HOLDABLE_ITEMS.has(item);
}

export interface RaceJoinStateResult {
  state: RaceRoomState;
  playerId: string;
  isSpectator: boolean;
}

// ---------------------------------------------------------------------------
// Lobby types (extends existing bump game lobby)
// ---------------------------------------------------------------------------

export interface RaceRoomSummary {
  id: string;
  name: string;
  game: "race";
  playerCount: number;
  maxPlayers: number;
  status: "waiting" | "racing";
  createdAt: number;
  /** Surfaced by the room actor so lobby cards can show the chosen track/laps */
  trackId?: TrackId;
  trackName?: string;
  lapCount?: number;
}

// ---------------------------------------------------------------------------
// Constants — Track
// ---------------------------------------------------------------------------

export const TRACK_ROAD_WIDTH = 18;
export const TRACK_WALL_HEIGHT = 1.5;
export const NUM_CHECKPOINTS = 8;

// ---------------------------------------------------------------------------
// Constants — Kart physics
// ---------------------------------------------------------------------------

export const KART_MAX_SPEED = 3.0;
export const KART_ACCELERATION = 0.09;
export const KART_BRAKE_FORCE = 0.2;
export const KART_TURN_RATE = 0.038;
export const KART_DRAG = 0.008;
export const KART_RADIUS = 3.0;
export const KART_MASS = 1.0;
export const KART_REVERSE_MAX = 0.75;
export const KART_REVERSE_ACCEL = 0.05;
export const MIN_DRIFT_SPEED = 1.0;

// ---------------------------------------------------------------------------
// Constants — Drift
// ---------------------------------------------------------------------------

export const DRIFT_TURN_MULTIPLIER = 1.4;
export const DRIFT_COUNTER_STEER = 0.6;
export const DRIFT_CHARGE_THRESHOLDS: [number, number, number] = [60, 120, 180];
export const DRIFT_BOOST_SPEEDS: [number, number, number] = [0.4, 0.7, 1.1];
export const DRIFT_BOOST_DURATIONS: [number, number, number] = [500, 800, 1200];
export const DRIFT_CHARGE_COLORS = ["#3399FF", "#FF8800", "#CC44FF"] as const;

// ---------------------------------------------------------------------------
// Constants — Items
// ---------------------------------------------------------------------------

export const MUSHROOM_BOOST_SPEED = 1.25;
export const MUSHROOM_BOOST_DURATION = 1500;
export const STAR_DURATION = 8000;
export const STAR_SPEED_BONUS = 0.5;
export const LIGHTNING_SHRINK_DURATION = 5000;
export const SHRUNK_SPEED_PENALTY = 0.6;
export const SHELL_SPEED = 4.0;
export const GREEN_SHELL_MAX_BOUNCES = 5;
export const SHELL_RADIUS = 1.5;
export const BANANA_RADIUS = 1.5;
export const SPIN_DURATION = 1500;
export const ITEM_BOX_RESPAWN_TIME = 10000;
export const PROJECTILE_MAX_AGE = 10000;

// ---------------------------------------------------------------------------
// Constants — Held-item rear defense
// ---------------------------------------------------------------------------

/** Distance behind the kart center where a trailed item sits / blocks shells. */
export const HELD_ITEM_DEFENSE_OFFSET = 2.5;
/** An incoming shell within this radius of the defense point is destroyed. */
export const HELD_ITEM_DEFENSE_RADIUS = 1.5;
/**
 * Two newly-launched projectiles from the same owner ignore each other for
 * this long (ms) so a multi-shot (tri-shell, rapid fire) can't self-destruct at
 * the muzzle.
 */
export const PROJECTILE_PAIR_GRACE_MS = 500;

// ---------------------------------------------------------------------------
// Constants — Boost pads
// ---------------------------------------------------------------------------

export const BOOST_PAD_SPEED = 1.0;
export const BOOST_PAD_DURATION = 800;

// ---------------------------------------------------------------------------
// Constants — Off-road
// ---------------------------------------------------------------------------

export const OFF_ROAD_SPEED_MULT = 0.7;
export const OFF_ROAD_BOUNDARY = 2.0;
export const OUT_OF_BOUNDS_BOUNDARY = 6.0;

// ---------------------------------------------------------------------------
// Constants — Race rules
// ---------------------------------------------------------------------------

export const RACE_MAX_PLAYERS = 4;
export const RACE_LAP_COUNT = 3;
/** Selectable lap range for room settings (RACE_LAP_COUNT is the default) */
export const LAP_COUNT_MIN = 1;
export const LAP_COUNT_MAX = 5;
export const RACE_TIME_LIMIT = 300000; // 5 minutes max
export const PRE_RACE_COUNTDOWN = 3000;
export const RACE_FINISH_DISPLAY = 10000;
export const KART_COLLISION_PUSH = 0.75;
/**
 * How long a mid-race disconnect holds the player's kart before the
 * departure is finalized. A reconnecting client presenting the same
 * playerToken within this window re-adopts its kart (same playerId,
 * not a spectator — even while the race is running).
 */
export const RECONNECT_GRACE_MS = 12000;

// ---------------------------------------------------------------------------
// Constants — CPU bots
// ---------------------------------------------------------------------------

/**
 * Base top-speed multiplier per difficulty tier — folded into the bot's
 * KartInput so it shares the SAME shared physics step humans use (no parallel
 * fork). Rubber-banding nudges this ±BOT_RUBBERBAND_RANGE around the human pack.
 */
export const BOT_BASE_SPEED_MULT: Record<BotDifficulty, number> = {
  easy: 0.88,
  medium: 0.95,
  hard: 1.0,
};

/** Max ± fraction the rubber-band can scale a bot's speed by distance-to-human */
export const BOT_RUBBERBAND_RANGE = 0.08;

/** Default difficulty when a room doesn't pick one */
export const DEFAULT_BOT_DIFFICULTY: BotDifficulty = "medium";

/** Flavor names + cars cycled through when filling grid slots with bots */
export const BOT_NAMES = ["Ratchet", "Torque", "Gasket", "Sprocket"] as const;

// ---------------------------------------------------------------------------
// Constants — Time trial / ghosts
// ---------------------------------------------------------------------------

/** Default mode for a fresh room (the lobby's "Time Trial" buttons override it) */
export const DEFAULT_RACE_MODE: RaceMode = "race";

/** Ghost keyframe sample rate (Hz) — 10 floats/sec keeps localStorage tiny. */
export const GHOST_SAMPLE_HZ = 10;

/** Cap a recording at ~10 minutes so a parked car can't grow it unbounded. */
export const GHOST_MAX_DURATION_MS = 10 * 60 * 1000;

/** localStorage schema version — bump to invalidate incompatible old ghosts.
 *  v2: lapCount is part of the storage key, so a PB at one lap count no longer
 *  blocks a PB at another. Old single-slot (v1) ghosts invalidate cleanly. */
export const GHOST_STORAGE_VERSION = 2;

// ---------------------------------------------------------------------------
// Constants — Car selection and player accents
// ---------------------------------------------------------------------------

export const RACE_CAR_IDS = CURATED_RACE_CARS.map((car) => car.id);
export const RACE_CAR_NAMES = CURATED_RACE_CARS.map((car) => car.name);

// Legacy alias kept so older code paths or shared docs do not silently drift.
export const CAR_VARIANT_COLORS = PLAYER_ACCENT_COLORS;

// ---------------------------------------------------------------------------
// Constants — Timing
// ---------------------------------------------------------------------------

export const RACE_SERVER_TICK_INTERVAL = 16; // ~60Hz
export const RACE_SNAPSHOT_INTERVAL = 50; // 20Hz
export const RACE_INPUT_SEND_INTERVAL = 33; // ~30Hz
/** Remote karts/projectiles render this far behind the newest snapshot */
export const RACE_INTERP_DELAY_MS = RACE_SNAPSHOT_INTERVAL * 2; // 100ms

// ---------------------------------------------------------------------------
// Constants — Lobby
// ---------------------------------------------------------------------------

export const RACE_MAX_ROOMS = 50;
export const MAX_RACE_ROOM_NAME_LEN = 40;

// ---------------------------------------------------------------------------
// Constants — Rocket start
// ---------------------------------------------------------------------------

// Timing windows are in server ticks (~16ms) measured from the GO tick to the
// most recent throttle press. Widened to absorb the client input send cadence.
export const ROCKET_START_PERFECT_WINDOW = 6; // ~100ms
export const ROCKET_START_GOOD_WINDOW = 12; // ~200ms
export const ROCKET_START_OK_WINDOW = 25; // ~400ms
export const ROCKET_START_PERFECT_SPEED = 1.5;
export const ROCKET_START_PERFECT_DURATION = 600;
export const ROCKET_START_GOOD_SPEED = 0.9;
export const ROCKET_START_GOOD_DURATION = 400;
export const ROCKET_START_OK_SPEED = 0.4;
export const ROCKET_START_OK_DURATION = 250;
export const ROCKET_START_STALL_DURATION = 800;
export const ROCKET_START_STALL_MAX_SPEED = 0.5;

// ---------------------------------------------------------------------------
// Constants — Hitstop
// ---------------------------------------------------------------------------

export const HITSTOP_FRAMES = 3;

// ---------------------------------------------------------------------------
// Constants — Slipstream
// ---------------------------------------------------------------------------

export const SLIPSTREAM_CONE_ANGLE = 0.25;
export const SLIPSTREAM_CONE_LENGTH = 17.5;
export const SLIPSTREAM_CHARGE_TICKS = 45;
export const SLIPSTREAM_BONUS = 0.4;
export const SLIPSTREAM_DURATION_TICKS = 90;
export const SLIPSTREAM_DECAY_TICKS = 30;

// ---------------------------------------------------------------------------
// Constants — Improved turn curve
// ---------------------------------------------------------------------------

export const TURN_CURVE_EXPONENT = 1.6;
export const TURN_HIGH_SPEED_REDUCTION = 0.45;
export const COUNTER_STEER_BONUS = 1.15;
/** Ticks the counter-steer bonus stays active after a steering direction flip */
export const COUNTER_STEER_WINDOW_TICKS = 12;

// ---------------------------------------------------------------------------
// Constants — Snap steering
// ---------------------------------------------------------------------------

export const SNAP_STEERING_FRAMES = 4;
export const SNAP_STEERING_MULT = 1.35;

// ---------------------------------------------------------------------------
// Constants — Hit immunity after spin
// ---------------------------------------------------------------------------

export const HIT_IMMUNITY_TICKS = 90;

// ---------------------------------------------------------------------------
// Constants — Blue shell gap threshold
// ---------------------------------------------------------------------------

export const BLUE_SHELL_GAP_THRESHOLD = 0.15;

// ---------------------------------------------------------------------------
// Constants — Grip-budget / slip angle
// ---------------------------------------------------------------------------

// Buildup scales steer-rate * speed into slip; recovery is proportional to the
// current slip angle, so hard corners settle at a sustained ~0.15-0.25 rad
// (equilibrium = buildup / (SLIP_ANGLE_RECOVERY * grip)) instead of recovery
// instantly pinning slip back to zero.
export const SLIP_ANGLE_BUILDUP = 1.1;
export const SLIP_ANGLE_RECOVERY = 0.08;
export const SLIP_ANGLE_MAX = 0.35;
export const GRIP_LOSS_AT_MAX_SLIP = 0.45;
export const LATERAL_PUSH_STRENGTH = 0.04;
export const DRIFT_SLIP_FLOOR = 0.15;

// ---------------------------------------------------------------------------
// Constants — Surface types
// ---------------------------------------------------------------------------

export type SurfaceType = "asphalt" | "shoulder" | "sand" | "rumble";

export const SURFACE_GRIP: Record<SurfaceType, number> = {
  asphalt: 1.0,
  shoulder: 0.75,
  sand: 0.5,
  rumble: 0.85,
};

export const SURFACE_DRAG: Record<SurfaceType, number> = {
  asphalt: 1.0,
  shoulder: 1.4,
  sand: 2.2,
  rumble: 1.15,
};

export const SURFACE_DRIFT_CHARGE_MULT: Record<SurfaceType, number> = {
  asphalt: 1.0,
  shoulder: 0.7,
  sand: 0.4,
  rumble: 1.2,
};

export const DUST_CARRYOVER_TICKS = 20;
export const DUST_CARRYOVER_GRIP_PENALTY = 0.1;

// ---------------------------------------------------------------------------
// Constants — Compression / banking physics
// ---------------------------------------------------------------------------

export const CREST_GRIP_LOSS = 0.3;
export const COMPRESSION_GRIP_GAIN = 0.15;
export const LANDING_SCRUB_THRESHOLD = 0.4;
export const LANDING_SCRUB_PENALTY = 0.06;
export const LANDING_CLEAN_BONUS = 0.03;
export const BANKING_GRIP_BONUS = 0.12;

// ---------------------------------------------------------------------------
// Constants — Contact duel handling
// ---------------------------------------------------------------------------

export const SIDE_RUB_SCRUB_RATE = 0.015;
export const REAR_TAP_DESTABILIZE = 0.08;
export const WALL_SCRUB_SPEED_LOSS = 0.04;
export const WALL_SCRUB_ANGLE_THRESHOLD = 0.5;
export const MASS_ADVANTAGE_PUSH = 0.06;

// ---------------------------------------------------------------------------
// Constants — Flow chain / heat meter
// ---------------------------------------------------------------------------

export const FLOW_GAIN_DRIFT_RELEASE = 0.12;
export const FLOW_GAIN_CLEAN_CORNER = 0.04;
export const FLOW_GAIN_SLIPSTREAM = 0.02;
export const FLOW_GAIN_BOOST_PAD = 0.06;
export const FLOW_GAIN_ROCKET_START = 0.15;
export const FLOW_DECAY_PER_TICK = 0.001;
export const FLOW_DECAY_ON_HIT = 0.5;
export const FLOW_DECAY_OFF_ROAD = 0.03;
export const FLOW_MAX = 1.0;
export const FLOW_SPEED_BONUS = 0.3;
export const FLOW_TURN_BONUS = 0.08;
export const FLOW_BOOST_EXTEND_MULT = 1.2;

// ---------------------------------------------------------------------------
// Context keys
// ---------------------------------------------------------------------------

export const RACE_STORE_KEY = Symbol("race-store");
export const RACE_ROOM_KEY = Symbol("race-room");

// ---------------------------------------------------------------------------
// CORS (shared with bump game)
// ---------------------------------------------------------------------------

const IS_DEV =
  typeof process !== "undefined" &&
  (process.env.NODE_ENV === "development" || !process.env.NODE_ENV);

export const ALLOWED_ORIGINS = [
  ...(IS_DEV ? ["http://localhost:5175", "http://localhost:3000"] : []),
  ...(typeof process !== "undefined" && process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
    : []),
  ...(typeof process !== "undefined" && process.env.VERCEL_URL
    ? [`https://${process.env.VERCEL_URL}`]
    : []),
];

// ---------------------------------------------------------------------------
// Item probability tables (by position: 1st, 2nd, 3rd, 4th)
// ---------------------------------------------------------------------------

export const ITEM_PROBABILITIES: Record<ItemType, [number, number, number, number]> = {
  greenShell:  [30, 25, 15,  5],
  banana:      [25, 15, 10,  5],
  redShell:    [ 5, 20, 20, 10],
  triMushroom: [ 0,  5, 10, 15],
  mushroom:    [15, 15, 15, 10],
  star:        [ 0,  5, 10, 20],
  lightning:   [ 0,  0,  5, 15],
  blueShell:   [ 0,  5, 10, 15],
};
