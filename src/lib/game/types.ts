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

export function horizontalSpeed(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.z * v.z);
}

export function clampSpeed(v: Vec3, max: number): void {
  const speed = horizontalSpeed(v);
  if (speed > max) {
    const scale = max / speed;
    v.x *= scale;
    v.z *= scale;
  }
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface PlayerInput {
  tx: number;
  tz: number;
  active: boolean;
  dash: boolean;
}

export interface PlayerState {
  id: string;
  name: string;
  color: string;
  team: 1 | 2;
  position: Vec3;
  velocity: Vec3;
}

export interface BallState {
  position: Vec3;
  velocity: Vec3;
  lastTouchedBy: string | null;
}

export type GamePhase =
  | "waiting"
  | "countdown"
  | "playing"
  | "goalScored"
  | "goldenGoal"
  | "finished";

export interface GameRoomState {
  id: string;
  name: string;
  players: Record<string, PlayerState>;
  ball: BallState;
  scores: [number, number];
  phase: GamePhase;
  timeRemaining: number;
  phaseStartedAt: number;
  maxPlayers: number;
  createdAt: number;
}

export interface RoomSummary {
  id: string;
  name: string;
  playerCount: number;
  maxPlayers: number;
  status: "waiting" | "playing";
  createdAt: number;
}

export interface LobbyState {
  rooms: RoomSummary[];
}

export interface ActionResult {
  success: boolean;
  message?: string;
}

export interface CreateRoomResult extends ActionResult {
  roomId?: string;
}

export interface JoinStateResult {
  state: GameRoomState;
  playerId: string;
}

// ---------------------------------------------------------------------------
// Broadcast event payloads
// ---------------------------------------------------------------------------

export interface PhysicsSnapshot {
  players: Record<
    string,
    {
      position: Vec3;
      velocity: Vec3;
    }
  >;
  ball: {
    position: Vec3;
    velocity: Vec3;
    lastTouchedBy: string | null;
  };
  tick: number;
  timeRemaining: number;
}

export interface PlayerJoinedEvent {
  player: PlayerState;
}

export interface PlayerLeftEvent {
  playerId: string;
  playerName: string;
}

export interface GoalScoredEvent {
  scorerId: string | null;
  teamScored: 1 | 2;
  scores: [number, number];
}

export interface GameOverEvent {
  winnerId: string | null;
  winnerTeam: 1 | 2 | null;
  scores: [number, number];
}

export interface PhaseChangedEvent {
  phase: GamePhase;
  timeRemaining: number;
}

// ---------------------------------------------------------------------------
// Constants — Field & Boundaries
// ---------------------------------------------------------------------------

export const FIELD_HALF_LENGTH = 10;
export const FIELD_HALF_WIDTH = 6;
export const WALL_RESTITUTION_BALL = 0.8;
export const WALL_RESTITUTION_PLAYER = 0.5;

// ---------------------------------------------------------------------------
// Constants — Goals
// ---------------------------------------------------------------------------

export const GOAL_HALF_WIDTH = 2.0;
export const GOAL_DEPTH = 2.0;

// ---------------------------------------------------------------------------
// Constants — Ball
// ---------------------------------------------------------------------------

export const BALL_RADIUS = 0.3;
export const BALL_MASS = 0.3;
export const BALL_MAX_SPEED = 0.65;
export const BALL_DRAG = 0.035;

// ---------------------------------------------------------------------------
// Constants — Player
// ---------------------------------------------------------------------------

export const MARBLE_RADIUS = 0.5;
export const MOVE_FORCE = 0.04;
export const MAX_SPEED = 0.45;
export const DRAG = 0.035;
export const GRAVITY = -0.02;
export const GROUND_Y = 0.5;
export const PUSH_FORCE = 0.2;
export const INPUT_DEAD_ZONE = 0.5;

// ---------------------------------------------------------------------------
// Constants — Dash
// ---------------------------------------------------------------------------

export const DASH_FORCE_MULT = 1.5;
export const DASH_DURATION = 120;
export const DASH_COOLDOWN = 3000;

// ---------------------------------------------------------------------------
// Constants — Match rules
// ---------------------------------------------------------------------------

export const GOALS_TO_WIN = 5;
export const MATCH_TIME_LIMIT = 180000;
export const GOLDEN_GOAL_HALF_WIDTH = 2.5;
export const KICKOFF_FREEZE = 1500;
export const GOAL_CELEBRATION = 1400;
export const PRE_GAME_COUNTDOWN = 3000;

// ---------------------------------------------------------------------------
// Constants — Teams & Colors
// ---------------------------------------------------------------------------

export const TEAM_COLORS = ["#FF6B4A", "#4DFFB8"] as const;
export const BALL_COLOR = "#FFFFFF";
export const MAX_PLAYERS = 2;

// ---------------------------------------------------------------------------
// Constants — Timing
// ---------------------------------------------------------------------------

export const INPUT_SEND_INTERVAL = 50;
export const SERVER_TICK_INTERVAL = 16;
export const SNAPSHOT_BROADCAST_INTERVAL = 50;

// ---------------------------------------------------------------------------
// Marble Visual Constants (Elemental Core design)
// ---------------------------------------------------------------------------

export const CORE_RADIUS_RATIO = 0.55;
export const RING_RADIUS_RATIO = 1.2;
export const RING_TUBE_RADIUS = 0.02;
export const GLOW_RADIUS_RATIO = 2.2;
export const PARTICLE_ORBIT_MIN = 1.4;
export const PARTICLE_ORBIT_MAX = 2.0;
export const BASE_RING_SPEED = 0.5;
export const MAX_RING_SPEED = 2.5;
export const CORE_PULSE_IDLE_FREQ = 2;
export const CORE_PULSE_MOVE_FREQ = 6;
export const COLLISION_FLASH_DURATION = 0.25;
export const COLLISION_ACCEL_THRESHOLD = 8.0;
export const ESTIMATED_MAX_SPEED = 8.0;

// ---------------------------------------------------------------------------
// Context keys
// ---------------------------------------------------------------------------

export const GAME_STORE_KEY = Symbol("game-store");
export const GAME_ROOM_KEY = Symbol("game-room");

// ---------------------------------------------------------------------------
// Lobby limits
// ---------------------------------------------------------------------------

export const MAX_ROOMS = 50;
export const MAX_ROOM_NAME_LEN = 40;
export const MAX_PLAYER_NAME_LEN = 24;

// ---------------------------------------------------------------------------
// CORS
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
// Sanitization helpers
// ---------------------------------------------------------------------------

export function sanitizeName(raw: unknown): string {
  if (typeof raw !== "string") return "Player";
  const trimmed = raw.trim().slice(0, MAX_PLAYER_NAME_LEN);
  const cleaned = trimmed.replace(/[^\w\s\-]/g, "");
  return cleaned || "Player";
}
