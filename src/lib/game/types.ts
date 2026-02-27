// ---------------------------------------------------------------------------
// Vec3 helpers — shared between server actor and client store
// ---------------------------------------------------------------------------

/** Player position / velocity in 3D space */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Coerce a Vec3 into a fresh plain object safe for RivetKit state. */
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

/**
 * Player input sent from client to server.
 * The client raycasts mouse/touch onto the arena ground plane
 * and sends the world-space target point. The server computes
 * the direction vector from the marble to the target.
 */
export interface PlayerInput {
  /** Target point on the ground plane (world space) */
  tx: number;
  tz: number;
  /** Whether the player is actively pressing/touching (applying force) */
  active: boolean;
}

/** A single player's state within a game room */
export interface PlayerState {
  id: string;
  name: string;
  color: string;
  position: Vec3;
  velocity: Vec3;
  score: number;
  /** Number of times this player has knocked others off the arena */
  knockoffs: number;
  /** Number of times this player has fallen off the arena */
  falls: number;
  alive: boolean;
  /** Timestamp (ms) when the player will auto-respawn. 0 = not respawning. */
  respawnAt: number;
  /** ID of the last player who hit this player (for knockoff attribution) */
  lastHitBy: string | null;
  /** Timestamp of last hit (expires after HIT_ATTRIBUTION_WINDOW ms) */
  lastHitAt: number;
}

/** Summary of a room shown in the lobby */
export interface RoomSummary {
  id: string;
  name: string;
  playerCount: number;
  maxPlayers: number;
  status: "waiting" | "playing";
  createdAt: number;
}

/** Full game room state */
export interface GameRoomState {
  id: string;
  name: string;
  players: Record<string, PlayerState>;
  maxPlayers: number;
  status: "waiting" | "playing" | "finished";
  createdAt: number;
}

/** Lobby coordinator state */
export interface LobbyState {
  rooms: RoomSummary[];
}

/** Standard action result */
export interface ActionResult {
  success: boolean;
  message?: string;
}

/** Result from creating a room */
export interface CreateRoomResult extends ActionResult {
  roomId?: string;
}

/** Returned from getJoinState — initial state + local player id in one call */
export interface JoinStateResult {
  state: GameRoomState;
  playerId: string;
}

/** Broadcast payload: physics snapshot for all players (sent at 20Hz) */
export interface PhysicsSnapshot {
  players: Record<
    string,
    {
      position: Vec3;
      velocity: Vec3;
      alive: boolean;
      score: number;
      knockoffs: number;
      falls: number;
    }
  >;
  tick: number;
}

/** Broadcast payload for player join */
export interface PlayerJoinedEvent {
  player: PlayerState;
}

/** Broadcast payload for player leave */
export interface PlayerLeftEvent {
  playerId: string;
  playerName: string;
}

/** Broadcast payload for player fall */
export interface PlayerFellEvent {
  playerId: string;
  score: number;
  falls: number;
  /** ID of the player who knocked them off (null if self-fall) */
  knockedOffBy: string | null;
}

/** Broadcast payload for player respawn */
export interface PlayerRespawnedEvent {
  playerId: string;
  position: Vec3;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Available marble colors — warm/vibrant tones that contrast the blue arena */
export const PLAYER_COLORS = [
  "#FF6B4A", // coral red
  "#FFB830", // golden amber
  "#A8E64E", // lime green
  "#FF4DA6", // hot magenta
  "#FF9248", // tangerine
  "#E54DFF", // vivid violet
  "#FFD93D", // sunflower yellow
  "#4DFFB8", // mint green
] as const;

/**
 * Legacy fixed spawn positions — no longer used.
 * Spawns are now randomized within the arena circle (see game-room.actor.ts).
 * Kept as reference for deterministic testing if needed.
 */
export const SPAWN_POSITIONS: Vec3[] = [
  { x: 0, y: 0.5, z: -6 },
  { x: 6, y: 0.5, z: 0 },
  { x: 0, y: 0.5, z: 6 },
  { x: -6, y: 0.5, z: 0 },
  { x: 4.2, y: 0.5, z: -4.2 },
  { x: 4.2, y: 0.5, z: 4.2 },
  { x: -4.2, y: 0.5, z: 4.2 },
  { x: -4.2, y: 0.5, z: -4.2 },
];

/** Arena radius in world units */
export const ARENA_RADIUS = 10;

/** Y threshold below which a player is considered fallen */
export const FALL_THRESHOLD = -5;

/** How often (ms) the client sends input to the server */
export const INPUT_SEND_INTERVAL = 50; // 20 Hz

/** Server physics tick rate (ms) */
export const SERVER_TICK_INTERVAL = 16; // ~60 Hz

/** How often (ms) the server broadcasts full physics snapshot */
export const SNAPSHOT_BROADCAST_INTERVAL = 50; // 20 Hz

/** Movement force applied per tick when player is pointing (at 60 Hz baseline) */
export const MOVE_FORCE = 0.04;

/** Boost multiplier (unused for now — reserved for power-ups) */
export const BOOST_MULTIPLIER = 2.0;

/** Maximum horizontal speed (units/tick at 60 Hz baseline) */
export const MAX_SPEED = 0.45;

/** Linear drag applied each tick (0-1, closer to 1 = more friction) */
export const DRAG = 0.035;

/** Gravity applied per tick to Y velocity (at 60 Hz baseline) */
export const GRAVITY = -0.02;

/** Ground plane Y position (marble center when resting on arena) */
export const GROUND_Y = 0.5;

/** Marble radius */
export const MARBLE_RADIUS = 0.5;

/** Push force when two marbles collide */
export const PUSH_FORCE = 0.25;

/** Respawn delay in ms */
export const RESPAWN_DELAY = 2000;

/** Minimum distance from marble to target before force is applied */
export const INPUT_DEAD_ZONE = 0.5;

/** Time window (ms) for knockoff attribution after last collision */
export const HIT_ATTRIBUTION_WINDOW = 3000;

/** Marble scale growth per knockoff (multiplicative, e.g., 0.08 = 8% bigger per kill) */
export const KNOCKOFF_SCALE_GROWTH = 0.08;

/** Maximum marble scale multiplier (caps growth so marbles don't get absurd) */
export const MAX_MARBLE_SCALE = 2.0;

// ---------------------------------------------------------------------------
// Marble Visual Constants (Elemental Core design)
// ---------------------------------------------------------------------------

/** Inner core radius as fraction of MARBLE_RADIUS */
export const CORE_RADIUS_RATIO = 0.55;

/** Ring orbit radius as fraction of MARBLE_RADIUS */
export const RING_RADIUS_RATIO = 1.2;

/** Ring tube cross-section radius */
export const RING_TUBE_RADIUS = 0.02;

/** FakeGlow shell radius as fraction of MARBLE_RADIUS */
export const GLOW_RADIUS_RATIO = 2.2;

/** Particle orbit radius at idle (× MARBLE_RADIUS) */
export const PARTICLE_ORBIT_MIN = 1.4;

/** Particle orbit radius at max speed (× MARBLE_RADIUS) */
export const PARTICLE_ORBIT_MAX = 2.0;

/** Ring rotation speed at idle (rad/s) */
export const BASE_RING_SPEED = 0.5;

/** Ring rotation speed at max velocity (rad/s) — capped to prevent smearing */
export const MAX_RING_SPEED = 2.5;

/** Core pulse frequency at idle (Hz) */
export const CORE_PULSE_IDLE_FREQ = 2;

/** Core pulse frequency at max speed (Hz) */
export const CORE_PULSE_MOVE_FREQ = 6;

/** Collision flash duration (seconds) */
export const COLLISION_FLASH_DURATION = 0.25;

/** Velocity threshold for collision VFX detection (units/s^2) */
export const COLLISION_ACCEL_THRESHOLD = 8.0;

/** Max estimated horizontal speed for normalizing velocity (units/s) */
export const ESTIMATED_MAX_SPEED = 8.0;

/** Svelte context key for GameStore */
export const GAME_STORE_KEY = Symbol("game-store");

/** Svelte context key for game room controls */
export const GAME_ROOM_KEY = Symbol("game-room");

/** Set of used color indices — tracks which colors are assigned to avoid duplicates */
export const ASSIGNED_COLORS_KEY = "_assignedColors";

/**
 * Allowed origins for actor connections (CORS validation).
 * Includes localhost for dev + any ALLOWED_ORIGINS env var entries for production.
 */
export const ALLOWED_ORIGINS = [
  "http://localhost:5175",
  "http://localhost:3000",
  ...(typeof process !== "undefined" && process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
    : []),
  ...(typeof process !== "undefined" && process.env.VERCEL_URL
    ? [`https://${process.env.VERCEL_URL}`]
    : []),
];
