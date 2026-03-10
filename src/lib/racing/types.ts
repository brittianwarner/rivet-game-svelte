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
  carVariant: number; // 0-3
  position: Vec3;
  heading: number; // radians
  speed: number;
  velocity: Vec3; // derived from heading+speed for interpolation
  driftState: DriftState;
  lap: number; // 0 = not started first lap, 1-3 = current lap
  checkpoint: number; // next checkpoint index (0-7)
  currentItem: ItemType | null;
  itemCharges: number;
  status: KartStatus;
  statusTimer: number; // ms remaining on status effect
  raceProgress: number; // used for position ranking
  finishTime: number | null; // ms from race start
  finishPosition: number | null; // 1-4
  boostTimer: number; // ms remaining on any boost
  boostSpeed: number; // additional speed from boost
  slipstreamActive: boolean;
  slipstreamTicks: number;
  hitstopTicks: number;
  rocketStartTier: RocketStartTier;
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
  lapCount: number;
  raceTimer: number; // ms elapsed since race start
  maxPlayers: number;
  trackId: string;
  createdAt: number;
  phaseStartedAt: number;
  positions: string[]; // ordered player IDs (1st first)
  finishedCount: number;
  readyPlayers: string[];
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
      position: Vec3;
      heading: number;
      speed: number;
      velocity: Vec3;
      driftState: DriftState;
      status: KartStatus;
      statusTimer: number;
      currentItem: ItemType | null;
      itemCharges: number;
      lap: number;
      checkpoint: number;
      boostTimer: number;
      boostSpeed: number;
      slipstreamActive: boolean;
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

export const KART_MAX_SPEED = 0.6; // units/tick (dt=1 at 60Hz → 36 u/s)
export const KART_ACCELERATION = 0.018; // per tick
export const KART_BRAKE_FORCE = 0.04; // per tick
export const KART_TURN_RATE = 0.042; // radians per tick at zero speed
export const KART_DRAG = 0.008; // per tick drag coefficient
export const KART_RADIUS = 0.6;
export const KART_MASS = 1.0;
export const KART_REVERSE_MAX = 0.15;
export const KART_REVERSE_ACCEL = 0.01;
export const MIN_DRIFT_SPEED = 0.2;

// ---------------------------------------------------------------------------
// Constants — Drift
// ---------------------------------------------------------------------------

export const DRIFT_TURN_MULTIPLIER = 1.4;
export const DRIFT_COUNTER_STEER = 0.6;
export const DRIFT_CHARGE_THRESHOLDS: [number, number, number] = [60, 120, 180];
export const DRIFT_BOOST_SPEEDS: [number, number, number] = [0.08, 0.14, 0.22];
export const DRIFT_BOOST_DURATIONS: [number, number, number] = [500, 800, 1200];
export const DRIFT_CHARGE_COLORS = ["#3399FF", "#FF8800", "#CC44FF"] as const;

// ---------------------------------------------------------------------------
// Constants — Items
// ---------------------------------------------------------------------------

export const MUSHROOM_BOOST_SPEED = 0.25;
export const MUSHROOM_BOOST_DURATION = 1500;
export const STAR_DURATION = 8000;
export const STAR_SPEED_BONUS = 0.1;
export const LIGHTNING_SHRINK_DURATION = 5000;
export const SHRUNK_SPEED_PENALTY = 0.6;
export const SHELL_SPEED = 0.8;
export const GREEN_SHELL_MAX_BOUNCES = 5;
export const SHELL_RADIUS = 0.3;
export const BANANA_RADIUS = 0.3;
export const SPIN_DURATION = 1500;
export const ITEM_BOX_RESPAWN_TIME = 10000;
export const PROJECTILE_MAX_AGE = 10000;

// ---------------------------------------------------------------------------
// Constants — Boost pads
// ---------------------------------------------------------------------------

export const BOOST_PAD_SPEED = 0.2;
export const BOOST_PAD_DURATION = 800;

// ---------------------------------------------------------------------------
// Constants — Off-road
// ---------------------------------------------------------------------------

export const OFF_ROAD_SPEED_MULT = 0.5;
export const OFF_ROAD_BOUNDARY = 1.2; // beyond road width * this = off-road
export const OUT_OF_BOUNDS_BOUNDARY = 2.0; // beyond road width * this = respawn

// ---------------------------------------------------------------------------
// Constants — Race rules
// ---------------------------------------------------------------------------

export const RACE_MAX_PLAYERS = 4;
export const RACE_LAP_COUNT = 3;
export const RACE_TIME_LIMIT = 300000; // 5 minutes max
export const PRE_RACE_COUNTDOWN = 3000;
export const RACE_FINISH_DISPLAY = 10000;
export const KART_COLLISION_PUSH = 0.15;

// ---------------------------------------------------------------------------
// Constants — Car variants
// ---------------------------------------------------------------------------

export const CAR_VARIANT_NAMES = [
  "RacingCar",
  "RacingCar1",
  "RacingCar2",
  "RacingCar3",
] as const;

export const CAR_VARIANT_COLORS = [
  "#FF4444", // Red
  "#44AAFF", // Blue
  "#44FF88", // Green
  "#FFAA44", // Orange
] as const;

// ---------------------------------------------------------------------------
// Constants — Timing
// ---------------------------------------------------------------------------

export const RACE_SERVER_TICK_INTERVAL = 16; // ~60Hz
export const RACE_SNAPSHOT_INTERVAL = 50; // 20Hz
export const RACE_INPUT_SEND_INTERVAL = 50; // 20Hz

// ---------------------------------------------------------------------------
// Constants — Lobby
// ---------------------------------------------------------------------------

export const RACE_MAX_ROOMS = 50;
export const MAX_RACE_ROOM_NAME_LEN = 40;

// ---------------------------------------------------------------------------
// Constants — Rocket start
// ---------------------------------------------------------------------------

export const ROCKET_START_WINDOW = 6;
export const ROCKET_START_PERFECT_SPEED = 0.30;
export const ROCKET_START_PERFECT_DURATION = 600;
export const ROCKET_START_GOOD_SPEED = 0.18;
export const ROCKET_START_GOOD_DURATION = 400;
export const ROCKET_START_OK_SPEED = 0.08;
export const ROCKET_START_OK_DURATION = 250;
export const ROCKET_START_STALL_DURATION = 800;
export const ROCKET_START_STALL_MAX_SPEED = 0.1;

// ---------------------------------------------------------------------------
// Constants — Hitstop
// ---------------------------------------------------------------------------

export const HITSTOP_FRAMES = 3;

// ---------------------------------------------------------------------------
// Constants — Slipstream
// ---------------------------------------------------------------------------

export const SLIPSTREAM_CONE_ANGLE = 0.25;
export const SLIPSTREAM_CONE_LENGTH = 3.5;
export const SLIPSTREAM_CHARGE_TICKS = 45;
export const SLIPSTREAM_BONUS = 0.08;
export const SLIPSTREAM_DURATION_TICKS = 90;
export const SLIPSTREAM_DECAY_TICKS = 30;

// ---------------------------------------------------------------------------
// Constants — Improved turn curve
// ---------------------------------------------------------------------------

export const TURN_CURVE_EXPONENT = 1.6;
export const TURN_HIGH_SPEED_REDUCTION = 0.45;
export const COUNTER_STEER_BONUS = 1.15;

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
