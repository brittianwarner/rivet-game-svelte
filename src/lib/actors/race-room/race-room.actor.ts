/**
 * raceRoom actor — server-authoritative Mario Kart-style racing.
 *
 * Closed-loop track with kart physics, drift boost, items (shells, bananas,
 * mushrooms, star, lightning, blue shell), checkpoint-based lap tracking,
 * and position ranking. Delta-time physics at ~60Hz.
 *
 * Enhanced with: rocket start, hitstop, slipstream/drafting, improved turn
 * curve, snap steering, drift tier events, drift release grace, ready state,
 * rematch system, spectator mode, race stats, improved rubber-banding,
 * hit immunity, and elevation-aware physics.
 */

import { actor, event } from "rivetkit";
import {
  ALLOWED_ORIGINS,
  BANANA_RADIUS,
  GREEN_SHELL_MAX_BOUNCES,
  ITEM_BOX_RESPAWN_TIME,
  HELD_ITEM_DEFENSE_OFFSET,
  HELD_ITEM_DEFENSE_RADIUS,
  PROJECTILE_PAIR_GRACE_MS,
  isHoldableItem,
  KART_COLLISION_PUSH,
  KART_RADIUS,
  LIGHTNING_SHRINK_DURATION,
  MUSHROOM_BOOST_DURATION,
  MUSHROOM_BOOST_SPEED,
  PRE_RACE_COUNTDOWN,
  PROJECTILE_MAX_AGE,
  RACE_FINISH_DISPLAY,
  RACE_LAP_COUNT,
  RACE_MAX_PLAYERS,
  RECONNECT_GRACE_MS,
  RACE_SERVER_TICK_INTERVAL,
  RACE_SNAPSHOT_INTERVAL,
  RACE_TIME_LIMIT,
  SHELL_RADIUS,
  SHELL_SPEED,
  SPIN_DURATION,
  STAR_DURATION,
  STAR_SPEED_BONUS,
  sanitizeName,
  plainVec3,
  vec3Zero,
  vec3Distance2D,
  // New constants
  ROCKET_START_PERFECT_WINDOW,
  ROCKET_START_GOOD_WINDOW,
  ROCKET_START_OK_WINDOW,
  ROCKET_START_PERFECT_SPEED,
  ROCKET_START_PERFECT_DURATION,
  ROCKET_START_GOOD_SPEED,
  ROCKET_START_GOOD_DURATION,
  ROCKET_START_OK_SPEED,
  ROCKET_START_OK_DURATION,
  ROCKET_START_STALL_DURATION,
  HITSTOP_FRAMES,
  SLIPSTREAM_CONE_ANGLE,
  SLIPSTREAM_CONE_LENGTH,
  SLIPSTREAM_CHARGE_TICKS,
  SLIPSTREAM_DURATION_TICKS,
  BLUE_SHELL_GAP_THRESHOLD,
  // Grip-budget / slip angle (collision response)
  SLIP_ANGLE_MAX,
  // Contact duel
  SIDE_RUB_SCRUB_RATE,
  REAR_TAP_DESTABILIZE,
  MASS_ADVANTAGE_PUSH,
  // Flow chain
  FLOW_GAIN_SLIPSTREAM,
  FLOW_GAIN_ROCKET_START,
  FLOW_DECAY_ON_HIT,
  FLOW_MAX,
  // Types
  type RaceStats,
  type RocketStartTier,
  type DriftState,
  type HazardState,
  type ItemBoxState,
  type ItemType,
  type KartHitEvent,
  type KartInput,
  type KartJoinedEvent,
  type KartLeftEvent,
  type KartState,
  type ItemPickedUpEvent,
  type ItemUsedEvent,
  type LapCompletedEvent,
  type ProjectileState,
  type RaceFinishedEvent,
  type RaceJoinStateResult,
  type RacePhase,
  type RacePhaseChangedEvent,
  type RaceRoomState,
  type RaceSnapshot,
  type Vec3,
  type DriftTierEvent,
  type SlipstreamEvent,
  type RocketStartEvent,
  type ReadyStateEvent,
  type RematchVoteEvent,
  type RaceToastEvent,
  type ItemDestroyedEvent,
  type RoomSettings,
  type TrackId,
  type BotDifficulty,
  type RaceMode,
  LAP_COUNT_MIN,
  LAP_COUNT_MAX,
  MAX_RACE_ROOM_NAME_LEN,
  BOT_BASE_SPEED_MULT,
  BOT_RUBBERBAND_RANGE,
  BOT_NAMES,
  DEFAULT_BOT_DIFFICULTY,
  DEFAULT_RACE_MODE,
} from "../../racing/types.js";
import {
  coerceRaceCarId,
  getCarStats,
  CURATED_RACE_CARS,
} from "../../racing/car-catalog.js";
import {
  computeBotInput,
  createBotSimState,
  type BotSimState,
  type BotContext,
} from "../../racing/bot-driver.js";
import {
  getTrack,
  getTrackMeta,
  coerceTrackId,
  findNearestSegment,
  getLateralOffset,
  isOnRoad,
} from "../../racing/track.js";
import { getMeshRacingLine } from "../../racing/track-racing-line.js";
// Server-only road-mesh sampling. Importing this module also registers the
// track1 surface sampler into track.ts's seam, so the shared physics step can
// reach the baked mesh on the server (the client never imports it).
import {
  sampleRoadHeight,
  sampleRoadDistance,
} from "../../racing/track-heightfield.js";
import {
  createKartSimState,
  stepKart,
  type KartSimState,
} from "../../racing/kart-physics.js";

// ---------------------------------------------------------------------------
// Connection types
// ---------------------------------------------------------------------------

interface ConnParams {
  playerName: string;
  carId: string;
  /** Persistent client identity (localStorage UUID) used for reconnect grace */
  playerToken?: string;
  /**
   * Room configuration sent by the player who created the room. Applied once,
   * by the first player to connect to a fresh (waiting, unconfigured) room.
   * Later connections — and reconnects — carry it harmlessly: the actor only
   * honors it while the room is still on defaults and waiting.
   */
  roomSettings?: Partial<RoomSettings>;
  /** Optional player-chosen room name, surfaced to the lobby + HUD */
  roomName?: string;
}

/**
 * Per-connection state. Extends KartSimState — the sim bookkeeping the shared
 * physics step (stepKart) reads/writes — with server-only concerns: identity,
 * input plumbing, ready/spectator flags, rocket-start tracking and the
 * slipstream charge counter (driven by slipstreamTick, not stepKart).
 */
interface ConnState extends KartSimState {
  playerId: string;
  playerName: string;
  carId: string;
  accentIndex: number;
  /** Client-provided identity token; empty when the client sent none */
  playerToken: string;
  input: KartInput;
  lastInputAt: number;
  /** Newest client input seq applied — echoed per kart in snapshots */
  lastProcessedSeq: number;
  // Ready state
  ready: boolean;
  // Spectator mode
  spectator: boolean;
  // Slipstream charge (the bonus ticks live on KartSimState)
  slipstreamTicks: number;
  // Rocket start
  throttleFirstHeldTick: number; // tick the current continuous throttle hold began; -1 when not held
  throttleLastPressTick: number; // tick of the most recent throttle press during countdown; -1 if never pressed
  rocketStartFired: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a unique ID */
function uid(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** Create default drift state */
function defaultDrift(): DriftState {
  return { active: false, direction: 0, charge: 0, timer: 0 };
}

/** Create default race stats */
function defaultStats(): RaceStats {
  return {
    itemsUsed: 0,
    hitsDealt: 0,
    hitsTaken: 0,
    driftBoosts: 0,
    topSpeed: 0,
    bestLapTime: null,
  };
}

/** Create a fresh KartState at a grid position */
function createKart(
  id: string,
  name: string,
  carId: string,
  accentIndex: number,
  position: Vec3,
  heading: number,
  isBot = false,
): KartState {
  return {
    id,
    name,
    carId: coerceRaceCarId(carId),
    accentIndex,
    isBot,
    position: plainVec3(position),
    heading,
    speed: 0,
    velocity: vec3Zero(),
    driftState: defaultDrift(),
    lap: 0,
    checkpoint: 0,
    currentItem: null,
    itemCharges: 0,
    heldItemActive: false,
    status: "normal",
    statusTimer: 0,
    raceProgress: 0,
    segmentIndex: 0,
    finishTime: null,
    finishPosition: null,
    boostTimer: 0,
    boostSpeed: 0,
    slipstreamActive: false,
    slipstreamTicks: 0,
    hitstopTicks: 0,
    rocketStartTier: "none",
    slipAngle: 0,
    flowMeter: 0,
    surface: "asphalt",
    loadFactor: 1,
  };
}

/**
 * Generate initial item boxes from the track definition. Honors itemsEnabled —
 * an items-off room has no boxes (and rollItem is never reached as a result).
 */
function generateItemBoxes(trackId: TrackId, itemsEnabled: boolean): ItemBoxState[] {
  if (!itemsEnabled) return [];
  const track = getTrack(trackId);
  const boxes: ItemBoxState[] = [];
  let boxId = 0;
  for (const zone of track.itemBoxZones) {
    for (const pos of zone.positions) {
      boxes.push({
        id: boxId++,
        position: plainVec3(pos),
        active: true,
        respawnTimer: 0,
      });
    }
  }
  return boxes;
}

/** Clamp a lap count to the selectable range; fall back to the default. */
function clampLapCount(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return RACE_LAP_COUNT;
  return Math.max(LAP_COUNT_MIN, Math.min(LAP_COUNT_MAX, n));
}

/** Coerce an arbitrary value to a valid bot difficulty tier. */
function coerceBotDifficulty(value: unknown): BotDifficulty {
  return value === "easy" || value === "medium" || value === "hard"
    ? value
    : DEFAULT_BOT_DIFFICULTY;
}

/** Coerce an arbitrary value to a valid race mode. */
function coerceRaceMode(value: unknown): RaceMode {
  return value === "timeTrial" || value === "race" ? value : DEFAULT_RACE_MODE;
}

/**
 * Apply player-chosen room settings to a fresh (waiting, unconfigured) room.
 * The trackId determines start grid / checkpoints, so it must be set before
 * any kart is created — hence this runs in createConnState (before onConnect's
 * addKartForConn). Re-generates item boxes for the chosen track.
 */
function applyRoomSettings(
  c: any,
  settings: Partial<RoomSettings> | undefined,
  roomName: string | undefined,
): void {
  const state = c.state as RaceRoomState;

  // Only the first player configures the room — once a kart exists or the
  // room has left waiting, the configuration is locked.
  if (c.vars) {
    if (c.vars.configured) return;
    c.vars.configured = true;
  }
  if (state.phase !== "waiting") return;
  if (Object.keys(state.players).length > 0) return;

  if (settings) {
    if (settings.trackId !== undefined) {
      state.trackId = coerceTrackId(settings.trackId);
    }
    if (settings.mode !== undefined) {
      state.mode = coerceRaceMode(settings.mode);
    }
    if (settings.lapCount !== undefined) {
      state.lapCount = clampLapCount(settings.lapCount);
    }
    if (settings.itemsEnabled !== undefined) {
      state.itemsEnabled = Boolean(settings.itemsEnabled);
    }
    if (settings.botsEnabled !== undefined) {
      state.botsEnabled = Boolean(settings.botsEnabled);
    }
    if (settings.botDifficulty !== undefined) {
      state.botDifficulty = coerceBotDifficulty(settings.botDifficulty);
    }
  }

  // A player-supplied room name wins; otherwise default to the track name so
  // the HUD/lobby never show the stale "Track 1" placeholder.
  const trimmedName =
    typeof roomName === "string"
      ? roomName.trim().slice(0, MAX_RACE_ROOM_NAME_LEN)
      : "";
  state.name = trimmedName || getTrackMeta(state.trackId).displayName;

  // Rebuild the box layout for the (possibly new) track + items toggle.
  state.itemBoxes = generateItemBoxes(state.trackId, state.itemsEnabled);
}

/**
 * Scrub a non-"waiting" room with an empty roster back to a fresh waiting
 * room. Rivet actors are durable, so a room that finished (or stalled mid
 * countdown/racing) and then lost every racer would otherwise persist with a
 * stale phase and force every future joiner into spectator mode forever — the
 * "RACE OVER / SPECTATING / 0 racers" ghost-room bug. Resetting `configured`
 * lets the next first player re-pick track / laps / items. Shared by
 * createConnState (recovery on join) and removePlayer (scrub when the last
 * racer leaves with no one left to promote) so the two never drift.
 *
 * Returns true when it actually performed a reset.
 */
function recoverGhostRoom(c: any): boolean {
  const state = c.state as RaceRoomState;
  if (state.phase === "waiting") return false;
  // Bots are not racers — a durable room holding only ghost bots (every human
  // gone) is still recoverable. Drop them so the roster reads as empty.
  if (getHumanKartCount(c) > 0) return false;
  clearBots(c);
  if (Object.keys(state.players).length > 0) return false;

  state.phase = "waiting";
  state.phaseStartedAt = Date.now();
  state.raceTimer = 0;
  state.positions = [];
  state.finishedCount = 0;
  state.projectiles = [];
  state.hazards = [];
  state.readyPlayers = {};
  state.rematchVotes = {};
  state.stats = {};
  // The next first player re-configures the room from scratch — reset the mode
  // too so a recovered time-trial ghost room doesn't strand a plain joiner in
  // a bot-less / item-stripped session they never asked for.
  state.mode = DEFAULT_RACE_MODE;
  if (c.vars) c.vars.configured = false;
  return true;
}

/** Reset all karts to grid positions for race start */
function resetForRaceStart(c: any): void {
  const track = getTrack(c.state.trackId);
  const playerIds = Object.keys(c.state.players);
  for (let i = 0; i < playerIds.length; i++) {
    const kart = c.state.players[playerIds[i]] as KartState;
    const gridPos = track.startPositions[i] ?? track.startPositions[0];
    kart.position = plainVec3(gridPos);
    kart.heading = track.startHeading;
    kart.speed = 0;
    kart.velocity = vec3Zero();
    kart.driftState = defaultDrift();
    kart.lap = 0;
    kart.checkpoint = 0;
    kart.currentItem = null;
    kart.itemCharges = 0;
    kart.status = "normal";
    kart.statusTimer = 0;
    kart.raceProgress = 0;
    kart.segmentIndex = findNearestSegment(track.segments, gridPos.x, gridPos.z);
    kart.finishTime = null;
    kart.finishPosition = null;
    kart.boostTimer = 0;
    kart.boostSpeed = 0;
    kart.slipstreamActive = false;
    kart.slipstreamTicks = 0;
    kart.hitstopTicks = 0;
    kart.rocketStartTier = "none";
    kart.slipAngle = 0;
    kart.flowMeter = 0;
    kart.surface = "asphalt";
    kart.loadFactor = 1;
  }
  // Reset items on track
  c.state.projectiles = [];
  c.state.hazards = [];
  c.state.itemBoxes = generateItemBoxes(c.state.trackId, c.state.itemsEnabled);
  c.state.finishedCount = 0;
  c.state.positions = playerIds;
  c.state.rematchVotes = {};

  // Initialize stats for each player
  c.state.stats = {} as Record<string, RaceStats>;
  for (const pid of playerIds) {
    c.state.stats[pid] = defaultStats();
  }

  // Reset connection-level state
  for (const conn of c.conns.values()) {
    const cs = conn.state as ConnState;
    cs.slipstreamTicks = 0;
    cs.slipstreamBonusTicks = 0;
    cs.throttleFirstHeldTick = -1;
    cs.throttleLastPressTick = -1;
    cs.rocketStartFired = false;
    cs.immunityTicks = 0;
    cs.steerInputTicks = 0;
    cs.prevSteerSign = 0;
    cs.lastSteerDirection = 0;
    cs.counterSteerTicks = 0;
    cs.driftReleaseGraceTicks = 0;
    cs.driftReleaseGraceCharge = 0;
    cs.hitstopPendingSpeed = 0;
    cs.hitstopPendingDrift = false;
    cs.dustCarryoverTicks = 0;
    cs.prevElevation = 0;
    cs.airborne = false;
    cs.inBoostZone = false;
  }
}

/** Pick a random item based on improved rubber-banding (positionRatio-based) */
function rollItem(
  state: RaceRoomState,
  kartId: string,
): { item: ItemType; charges: number } {
  // Time trial swaps the whole item table for a mushroom-only rotation — the
  // mode is about the clock + the ghost, so offensive/trap items (with nobody
  // to hit) would only break a clean lap. triMushroom keeps a little variety.
  if (state.mode === "timeTrial") {
    return Math.random() < 0.2
      ? { item: "triMushroom", charges: 3 }
      : { item: "mushroom", charges: 1 };
  }

  const positions = state.positions;
  const karts = Object.values(state.players) as KartState[];
  const activeKarts = karts.filter((k) => k.finishTime === null);

  if (activeKarts.length <= 1) {
    // Solo / only player — boost-weighted table (shells/traps are dead
    // weight with nobody to hit)
    return rollItemSolo();
  }

  // Finished karts still occupy `positions`, so the raw index can exceed the
  // active-kart denominator — clamp so the lerp weights never extrapolate.
  const posIdx = positions.indexOf(kartId);
  const positionRatio = Math.min(
    1,
    Math.max(0, posIdx) / (activeKarts.length - 1),
  ); // 0 = leader, 1 = last

  // Compute distance spread for blue shell threshold
  let leadProgress = 0;
  let secondProgress = 0;
  let totalSpread = 1;

  if (positions.length >= 2) {
    const leader = state.players[positions[0]] as KartState | undefined;
    const second = state.players[positions[1]] as KartState | undefined;
    const last = state.players[positions[positions.length - 1]] as KartState | undefined;

    if (leader) leadProgress = leader.raceProgress;
    if (second) secondProgress = second.raceProgress;
    if (leader && last) totalSpread = Math.max(1, leader.raceProgress - last.raceProgress);
  }

  const gapRatio = totalSpread > 0 ? (leadProgress - secondProgress) / totalSpread : 0;

  // Rubber-banded weights: interpolate based on positionRatio
  // Leader (positionRatio=0) → defensive items; Last (positionRatio=1) → offensive items
  const weights: Record<ItemType, number> = {
    greenShell:  lerp(30, 5, positionRatio),
    banana:      lerp(25, 5, positionRatio),
    redShell:    lerp(5, 15, positionRatio),
    triMushroom: lerp(0, 15, positionRatio),
    mushroom:    lerp(15, 10, positionRatio),
    star:        lerp(0, 20, positionRatio),
    lightning:   lerp(0, 12, positionRatio),
    blueShell:   gapRatio > BLUE_SHELL_GAP_THRESHOLD ? lerp(0, 15, positionRatio) : 0,
  };

  let totalWeight = 0;
  const entries = Object.entries(weights) as [ItemType, number][];
  for (const [, w] of entries) totalWeight += w;

  let roll = Math.random() * totalWeight;
  for (const [item, w] of entries) {
    roll -= w;
    if (roll <= 0) {
      const charges = item === "triMushroom" ? 3 : 1;
      return { item, charges };
    }
  }
  return { item: "greenShell", charges: 1 };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Solo-play item weights — mushroom-heavy so lone laps stay fun */
const SOLO_ITEM_WEIGHTS: [ItemType, number][] = [
  ["mushroom", 50],
  ["triMushroom", 25],
  ["star", 10],
  ["greenShell", 8],
  ["banana", 7],
];

/** Item roll for solo play (no opponents → no offensive/rubber-band table) */
function rollItemSolo(): { item: ItemType; charges: number } {
  let totalWeight = 0;
  for (const [, w] of SOLO_ITEM_WEIGHTS) totalWeight += w;
  let roll = Math.random() * totalWeight;
  for (const [item, w] of SOLO_ITEM_WEIGHTS) {
    roll -= w;
    if (roll <= 0) {
      return { item, charges: item === "triMushroom" ? 3 : 1 };
    }
  }
  return { item: "mushroom", charges: 1 };
}

// ---------------------------------------------------------------------------
// Lobby notification helper (fire-and-forget)
// ---------------------------------------------------------------------------

async function notifyLobby(
  c: any,
  roomId: string,
  patch: { playerCount: number; status: "waiting" | "racing" } | null,
): Promise<void> {
  // Time-trial rooms are private solo sessions (deep-link only) — never list
  // them on the public lobby board, so no one can stumble in to "spectate" a
  // ghost run. A delist (patch === null) still runs in case the room mode was
  // flipped after a prior registration.
  if ((c.state as RaceRoomState).mode === "timeTrial" && patch) return;
  try {
    const lobbyActor = c.getActor({ name: "lobby", key: ["main"] });
    if (patch) {
      const state = c.state as RaceRoomState;
      // Include name/game so the lobby can upsert a room it no longer knows
      // about (e.g. after the finish path deregistered it), plus the chosen
      // track + lap count so lobby cards stay truthful.
      await lobbyActor.updateRoom(roomId, {
        ...patch,
        name: state.name,
        game: "race",
        trackId: state.trackId,
        trackName: getTrackMeta(state.trackId).displayName,
        lapCount: state.lapCount,
      });
    } else {
      await lobbyActor.removeRoom(roomId);
    }
  } catch (e) {
    // Best-effort; lobby sweep will clean up if this fails
  }
}

/** How often an occupied room refreshes its lobby registration */
const LOBBY_HEARTBEAT_INTERVAL = 60_000;

async function ensureLobbyRegistration(c: any): Promise<void> {
  // Private solo time-trial rooms stay off the public lobby board.
  if ((c.state as RaceRoomState).mode === "timeTrial") return;
  try {
    const lobbyActor = c.getActor({ name: "lobby", key: ["main"] });
    await lobbyActor.registerRoom(c.state.id, c.state.name, "race");
  } catch {
    // Best-effort
  }
}

// ---------------------------------------------------------------------------
// Ready system helpers
// ---------------------------------------------------------------------------

function getReadyCount(c: any): number {
  let count = 0;
  for (const conn of c.conns.values()) {
    const cs = conn.state as ConnState;
    if (cs.ready && !cs.spectator) count++;
  }
  return count;
}

function getNonSpectatorCount(c: any): number {
  let count = 0;
  for (const conn of c.conns.values()) {
    const cs = conn.state as ConnState;
    if (!cs.spectator) count++;
  }
  return count;
}

function allPlayersReady(c: any): boolean {
  const total = getNonSpectatorCount(c);
  if (total === 0) return false;
  return getReadyCount(c) === total;
}

function tryStartCountdown(c: any): void {
  const state = c.state as RaceRoomState;
  if (state.phase !== "waiting") return;

  const nonSpectators = getNonSpectatorCount(c);
  const readyCount = getReadyCount(c);

  // A solo player can start immediately once ready; larger groups still require
  // every active racer to ready up before the countdown begins.
  if (nonSpectators >= 1 && readyCount === nonSpectators) {
    state.phase = "countdown";
    state.phaseStartedAt = Date.now();
    state.raceTimer = 0;
    // Fill any empty grid slots with CPU opponents BEFORE the grid reset so the
    // bots are placed on the start grid alongside the humans.
    fillBots(c);
    resetForRaceStart(c);
    // Anchor rocket-start timing to the tick the countdown (first beep) began
    if (c.vars) c.vars.countdownStartTick = c.vars.tick;
    notifyLobby(c, state.id, {
      playerCount: nonSpectators,
      status: "racing",
    });
    c.broadcast("phaseChanged", {
      phase: state.phase,
      raceTimer: state.raceTimer,
    });
    // Sync the freshly reset grid immediately so rematch clients don't render
    // stale positions while waiting for the next paced snapshot.
    broadcastSnapshot(c, c.vars?.tick ?? 0);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle helpers — roster, reconnect grace, waiting transition
// ---------------------------------------------------------------------------

/** Lowest accent index not used by any current player */
function pickAccentIndex(state: RaceRoomState): number {
  const used = new Set<number>();
  for (const k of Object.values(state.players) as KartState[]) {
    used.add(k.accentIndex);
  }
  for (let i = 0; i < RACE_MAX_PLAYERS; i++) {
    if (!used.has(i)) return i;
  }
  return Object.keys(state.players).length % RACE_MAX_PLAYERS;
}

/** Create a kart for a (non-spectator) connection and broadcast kartJoined */
function addKartForConn(c: any, cs: ConnState): KartState | null {
  const state = c.state as RaceRoomState;
  const existingCount = Object.keys(state.players).length;
  if (existingCount >= RACE_MAX_PLAYERS) return null;

  const track = getTrack(state.trackId);
  const gridPos = track.startPositions[existingCount] ?? track.startPositions[0];

  const kart = createKart(
    cs.playerId,
    cs.playerName,
    cs.carId,
    cs.accentIndex,
    gridPos,
    track.startHeading,
  );

  state.players[cs.playerId] = kart;
  c.broadcast("kartJoined", { kart });
  return kart;
}

/** Promote spectator connections onto the grid while slots remain (waiting only) */
function promoteSpectators(c: any): void {
  const state = c.state as RaceRoomState;
  if (state.phase !== "waiting") return;

  for (const conn of c.conns.values()) {
    if (Object.keys(state.players).length >= RACE_MAX_PLAYERS) break;
    const cs = conn.state as ConnState;
    if (!cs.spectator) continue;

    cs.spectator = false;
    cs.ready = false;
    cs.accentIndex = pickAccentIndex(state);
    const kart = addKartForConn(c, cs);
    if (!kart) {
      // Shouldn't happen (capacity checked above) — stay a spectator
      cs.spectator = true;
      continue;
    }
    c.broadcast("raceToast", {
      text: `${cs.playerName} joined the grid!`,
      color: "#44FF88",
    });
  }
}

// ---------------------------------------------------------------------------
// CPU bots — roster fill, per-kart sim state, teardown
// ---------------------------------------------------------------------------

/** A bot kart's playerId carries this prefix so lifecycle code can spot it. */
const BOT_ID_PREFIX = "bot_";

function isBotId(id: string): boolean {
  return id.startsWith(BOT_ID_PREFIX);
}

/** How many human (connection-backed) karts are currently on the grid. */
function getHumanKartCount(c: any): number {
  const state = c.state as RaceRoomState;
  let count = 0;
  for (const id of Object.keys(state.players)) {
    if (!isBotId(id)) count++;
  }
  return count;
}

/**
 * The shared physics-step bookkeeping for a kart: the live ConnState for human
 * karts, or the bot's `sim` for CPU karts. Both satisfy KartSimState (immunity,
 * hitstop-pending, slipstream-bonus) so item/collision ticks treat bots and
 * humans identically without needing a ConnState.
 */
function findSimStateForPlayer(c: any, playerId: string): KartSimState | null {
  const human = findConnStateForPlayer(c, playerId);
  if (human) return human;
  const bot = c.vars?.bots?.[playerId];
  return bot ? bot.sim : null;
}

/**
 * Fill open grid slots with CPU bots up to RACE_MAX_PLAYERS. Called from
 * tryStartCountdown right before the grid resets, so the new bots get reset to
 * the grid alongside the humans. Honors state.botsEnabled. Bots never appear in
 * conns — their sim state lives in c.vars.bots, keyed by playerId.
 */
function fillBots(c: any): void {
  const state = c.state as RaceRoomState;
  // Time trial is solo against the clock + ghost — never seat CPU opponents.
  if (state.mode === "timeTrial") return;
  if (!state.botsEnabled) return;
  if (!c.vars) return;

  const track = getTrack(state.trackId);
  const cars = CURATED_RACE_CARS;
  let nameIdx = 0;

  while (Object.keys(state.players).length < RACE_MAX_PLAYERS) {
    const slot = Object.keys(state.players).length;
    const botId = `${BOT_ID_PREFIX}${uid()}`;
    // Cycle the flavor pool; append a number once it wraps so names stay unique.
    const baseName = BOT_NAMES[nameIdx % BOT_NAMES.length];
    const name =
      nameIdx < BOT_NAMES.length ? baseName : `${baseName} ${Math.floor(nameIdx / BOT_NAMES.length) + 1}`;
    nameIdx++;
    // Distinct car per bot (deterministic by slot) + an unused accent slot.
    const carId = cars[slot % cars.length].id;
    const accentIndex = pickAccentIndex(state);
    const gridPos = track.startPositions[slot] ?? track.startPositions[0];

    const kart = createKart(
      botId,
      name,
      carId,
      accentIndex,
      gridPos,
      track.startHeading,
      true,
    );
    state.players[botId] = kart;
    c.vars.bots[botId] = {
      sim: createKartSimState(),
      driver: createBotSimState(botId),
    };
    c.broadcast("kartJoined", { kart });
  }
}

/** Remove every CPU bot from the room (roster + sim state + bookkeeping). */
function clearBots(c: any): void {
  const state = c.state as RaceRoomState;
  for (const id of Object.keys(state.players)) {
    if (!isBotId(id)) continue;
    delete state.players[id];
    if (c.vars?.bots) delete c.vars.bots[id];
    delete state.stats[id];
    delete state.rematchVotes[id];
    delete state.readyPlayers[id];
    state.positions = state.positions.filter((p: string) => p !== id);
    state.projectiles = (state.projectiles as ProjectileState[]).filter(
      (p) => p.ownerId !== id,
    );
    state.hazards = (state.hazards as HazardState[]).filter(
      (h) => h.ownerId !== id,
    );
    c.broadcast("kartLeft", { kartId: id, kartName: "CPU" });
  }
}

/**
 * Fully remove a player's kart and run the phase-aware quorum logic.
 * Called on immediate departures (waiting/finished), on reconnect-grace
 * expiry, and when finalizing held disconnects during a waiting transition.
 */
function removePlayer(c: any, playerId: string, playerName: string): void {
  const state = c.state as RaceRoomState;
  if (!state.players[playerId]) return;

  delete state.players[playerId];
  c.broadcast("kartLeft", { kartId: playerId, kartName: playerName });

  // Remove any projectiles/hazards owned by this player
  state.projectiles = (state.projectiles as ProjectileState[]).filter(
    (p) => p.ownerId !== playerId,
  );
  state.hazards = (state.hazards as HazardState[]).filter(
    (h) => h.ownerId !== playerId,
  );

  // Clean up stats, votes, ready state, and any pending reconnect grace
  delete state.stats[playerId];
  delete state.rematchVotes[playerId];
  delete state.readyPlayers[playerId];
  state.positions = state.positions.filter((id) => id !== playerId);
  if (c.vars?.disconnects) delete c.vars.disconnects[playerId];

  // Bots don't count as racers for quorum/forfeit — a grid of "remaining" bots
  // with no humans is an abandoned race, not a live one.
  const humanCount = getHumanKartCount(c);
  const remaining = Object.values(state.players) as KartState[];

  if (humanCount === 0) {
    if (state.phase !== "waiting" && (c.conns?.size ?? 0) > 0) {
      // Spectators are still watching an abandoned race — reset the room so
      // they get promoted onto the grid instead of being stuck forever.
      transitionToWaiting(c, "All racers left — race reset");
    } else {
      // No human left to promote. Drop any bots, then scrub the race phase so
      // the durable actor doesn't persist as "finished"/"countdown" (with a
      // ghost bot grid) and force the next joiner to spectate (see
      // recoverGhostRoom, also run on join). Delisted from the lobby either way.
      clearBots(c);
      recoverGhostRoom(c);
      notifyLobby(c, state.id, null);
    }
    return;
  }

  switch (state.phase) {
    case "waiting": {
      // The leaver frees a grid slot and may have been the lone un-ready
      // player — fill the slot and re-check the all-ready start condition.
      promoteSpectators(c);
      tryStartCountdown(c);
      break;
    }

    case "countdown": {
      if (remaining.length < 2) {
        // Not enough racers to launch — return to waiting instead of the
        // old instant zero-stat forfeit "win".
        transitionToWaiting(c, "Not enough racers — back to the lobby");
        return;
      }
      break;
    }

    case "racing": {
      if (remaining.length < 2) {
        // Forfeit — remaining player wins
        state.phase = "finished";
        state.phaseStartedAt = Date.now();
        state.positions = remaining.map((k) => k.id);

        const finishTimes: Record<string, number | null> = {};
        for (const k of remaining) {
          finishTimes[k.id] = k.finishTime;
        }

        c.broadcast("raceFinished", {
          positions: state.positions,
          finishTimes,
          stats: state.stats,
        });
        c.broadcast("phaseChanged", {
          phase: "finished",
          raceTimer: state.raceTimer,
        });
        notifyLobby(c, state.id, null);
        return;
      }
      break;
    }

    case "finished": {
      // The leaver may have been the lone missing rematch vote
      evaluateRematch(c, true);
      // evaluateRematch may have reset to waiting and already notified
      if ((c.state as RaceRoomState).phase === "waiting") return;
      break;
    }
  }

  notifyLobby(c, state.id, {
    playerCount: remaining.length,
    status: state.phase === "waiting" ? "waiting" : "racing",
  });
}

/**
 * Tally rematch votes against connected non-spectators and reset the room to
 * waiting once everyone still here has voted. Shared by the voteRematch
 * action and disconnect handling (a leaver can complete the quorum).
 */
function evaluateRematch(c: any, broadcastTally: boolean): void {
  const state = c.state as RaceRoomState;
  if (state.phase !== "finished") return;

  const connectedNonSpectators: string[] = [];
  for (const conn of c.conns.values()) {
    const cs = conn.state as ConnState;
    if (!cs.spectator) connectedNonSpectators.push(cs.playerId);
  }

  const needed = connectedNonSpectators.length;
  let voteCount = 0;
  for (const pid of connectedNonSpectators) {
    if (state.rematchVotes[pid]) voteCount++;
  }

  if (broadcastTally) {
    c.broadcast("rematchVote", {
      votes: { ...state.rematchVotes },
      voteCount,
      needed,
    });
  }

  // If all connected players voted yes, reset to waiting
  if (voteCount >= needed && needed > 0) {
    transitionToWaiting(c, "Rematch! Waiting for players to ready up...");
  }
}

/**
 * The single path back into the waiting phase (rematch, finish auto-reset,
 * countdown quorum loss). Clears race bookkeeping, finalizes lingering
 * disconnect grace, promotes spectators onto open grid slots, resets karts to
 * the grid, and re-registers the room with the lobby.
 */
function transitionToWaiting(c: any, toastText: string | null): void {
  const state = c.state as RaceRoomState;

  state.phase = "waiting";
  state.phaseStartedAt = Date.now();
  state.raceTimer = 0;
  state.rematchVotes = {};
  state.stats = {};
  state.readyPlayers = {};

  for (const conn of c.conns.values()) {
    (conn.state as ConnState).ready = false;
  }

  // Reconnect grace only preserves identity within a single race — finalize
  // any departures still pending so they don't hold grid slots in the lobby.
  const disconnects = c.vars?.disconnects as
    | Record<string, { token: string; deadline: number }>
    | undefined;
  if (disconnects) {
    for (const playerId of Object.keys(disconnects)) {
      const kart = state.players[playerId] as KartState | undefined;
      delete disconnects[playerId];
      if (kart) removePlayer(c, playerId, kart.name);
    }
  }

  // Bots are race-scoped fill — drop them when returning to the lobby so they
  // free grid slots for any waiting spectators (and are re-filled fresh at the
  // next countdown). This also keeps the rematch/auto-reset roster human-only.
  clearBots(c);

  // Fill open grid slots from the spectator bench
  promoteSpectators(c);

  // Fresh grid + cleared race artifacts for the waiting room
  resetForRaceStart(c);

  c.broadcast("phaseChanged", {
    phase: "waiting",
    raceTimer: 0,
  });
  if (toastText) {
    c.broadcast("raceToast", { text: toastText, color: "#44AAFF" });
  }
  // Sync the reset grid immediately — the waiting phase has no paced snapshots.
  broadcastSnapshot(c, c.vars?.tick ?? 0);

  // The finish path deregistered this room — put it back on the lobby board.
  ensureLobbyRegistration(c);
  notifyLobby(c, state.id, {
    playerCount: getNonSpectatorCount(c),
    status: "waiting",
  });
}

/**
 * Reconnect grace bookkeeping, run every server tick: expire abandoned karts
 * (finalizing their departure) and coast held karts to a stop — the physics
 * tick iterates connections, so a disconnected kart gets no integration here
 * otherwise.
 */
function disconnectGraceTick(c: any, now: number, dt: number): void {
  const disconnects = c.vars?.disconnects as
    | Record<string, { token: string; deadline: number }>
    | undefined;
  if (!disconnects) return;

  const state = c.state as RaceRoomState;

  for (const [playerId, info] of Object.entries(disconnects)) {
    const kart = state.players[playerId] as KartState | undefined;
    if (!kart) {
      delete disconnects[playerId];
      continue;
    }

    if (now >= info.deadline) {
      // Grace expired — finalize the departure (kartLeft + quorum logic)
      delete disconnects[playerId];
      removePlayer(c, playerId, kart.name);
      continue;
    }

    if (
      state.phase === "racing" &&
      kart.finishTime === null &&
      kart.hitstopTicks <= 0 &&
      kart.status !== "falling"
    ) {
      // No driver — bleed speed and roll forward along the current heading
      kart.speed *= Math.pow(0.96, dt);
      if (Math.abs(kart.speed) < 0.005) kart.speed = 0;
      const vx = Math.sin(kart.heading) * kart.speed;
      const vz = Math.cos(kart.heading) * kart.speed;
      kart.position.x += vx * dt;
      kart.position.z += vz * dt;
      kart.velocity = { x: vx, y: 0, z: vz };
    }
  }
}

// ---------------------------------------------------------------------------
// Actor definition
// ---------------------------------------------------------------------------

export const raceRoom = actor({
  createState: (c: any): RaceRoomState => ({
    id: c.key?.[0] ?? `race_${Date.now().toString(36)}`,
    name: getTrackMeta("track1").displayName,
    players: {},
    projectiles: [],
    hazards: [],
    itemBoxes: generateItemBoxes("track1", true),
    phase: "waiting" as RacePhase,
    mode: DEFAULT_RACE_MODE,
    lapCount: RACE_LAP_COUNT,
    itemsEnabled: true,
    botsEnabled: true,
    botDifficulty: DEFAULT_BOT_DIFFICULTY,
    raceTimer: 0,
    maxPlayers: RACE_MAX_PLAYERS,
    trackId: "track1",
    createdAt: Date.now(),
    phaseStartedAt: Date.now(),
    positions: [],
    finishedCount: 0,
    readyPlayers: {},
    rematchVotes: {},
    stats: {},
  }),

  createConnState: (c: any, params: ConnParams): ConnState => {
    const state = c.state as RaceRoomState;

    // Ghost-room recovery FIRST. Rivet actors are durable, so a room that
    // finished (or stalled in countdown) and then lost every racer persists
    // with a non-"waiting" phase and an empty roster. This must run before
    // applyRoomSettings: that helper only applies the joiner's chosen track /
    // laps / items while the room is "waiting" — so a recovering joiner would
    // otherwise silently lose their settings (and inherit the dead room's
    // name). recoverGhostRoom flips the phase back to "waiting" and clears
    // `configured`, making the room genuinely fresh for this first player.
    recoverGhostRoom(c);

    // The first player to reach a fresh waiting room configures it (track, lap
    // count, items, name). Must happen before any kart is created, because the
    // chosen track determines the start grid and checkpoints.
    applyRoomSettings(c, params.roomSettings, params.roomName);

    const playerToken =
      typeof params.playerToken === "string"
        ? params.playerToken.slice(0, 64)
        : "";

    const baseConnState = {
      // Shared physics-step bookkeeping (counter-steer, snap steering, drift
      // grace, dust, airborne, slipstream bonus, ...)
      ...createKartSimState(),
      playerToken,
      input: {
        steering: 0,
        throttle: false,
        brake: false,
        drift: false,
        useItem: false,
        heldBehind: false,
        seq: 0,
      },
      lastInputAt: 0,
      lastProcessedSeq: 0,
      ready: false,
      slipstreamTicks: 0,
      throttleFirstHeldTick: -1,
      throttleLastPressTick: -1,
      rocketStartFired: false,
    };

    // Reconnect grace: a returning connection presenting the token of a
    // recently dropped player re-adopts their kart — same playerId and NOT
    // a spectator, even while the race is running.
    if (playerToken && c.vars?.disconnects) {
      const now = Date.now();
      const disconnects = c.vars.disconnects as Record<
        string,
        { token: string; deadline: number }
      >;
      for (const [playerId, info] of Object.entries(disconnects)) {
        if (info.token !== playerToken || info.deadline < now) continue;
        const kart = state.players[playerId] as KartState | undefined;
        if (!kart) continue;
        delete disconnects[playerId];
        return {
          ...baseConnState,
          playerId,
          playerName: kart.name,
          carId: kart.carId,
          accentIndex: kart.accentIndex,
          spectator: false,
        };
      }
    }

    const playerCount = Object.keys(state.players).length;

    // Once a room leaves the waiting phase, late joiners can only spectate.
    const isSpectator = state.phase !== "waiting";

    if (!isSpectator && playerCount >= RACE_MAX_PLAYERS) {
      throw new Error("Room is full");
    }

    return {
      ...baseConnState,
      playerId: `k_${uid()}`,
      playerName: sanitizeName(params.playerName),
      carId: coerceRaceCarId(params.carId),
      // Lowest unused accent so leavers/joiners never collide on a color slot
      accentIndex: pickAccentIndex(state),
      spectator: isSpectator,
    };
  },

  // Ephemeral per-instance sim bookkeeping (never persisted): the current sim
  // tick, the tick the active countdown began (rocket-start timing anchor),
  // and the reconnect-grace ledger (playerId → token + expiry).
  createVars: () => ({
    tick: 0,
    countdownStartTick: 0,
    disconnects: {} as Record<string, { token: string; deadline: number }>,
    // Latched once the first player has configured the room (track/laps/items).
    configured: false,
    // CPU bot bookkeeping, keyed by the bot's playerId. `sim` is the shared
    // physics-step state (immunity, hitstop, slipstream) so bots run through
    // the SAME stepKart humans do; `driver` is the AI personality/timers.
    bots: {} as Record<string, { sim: KartSimState; driver: BotSimState }>,
  }),

  events: {
    kartJoined: event<KartJoinedEvent>(),
    kartLeft: event<KartLeftEvent>(),
    raceSnapshot: event<RaceSnapshot>(),
    phaseChanged: event<RacePhaseChangedEvent>(),
    itemPickedUp: event<ItemPickedUpEvent>(),
    itemUsed: event<ItemUsedEvent>(),
    kartHit: event<KartHitEvent>(),
    lapCompleted: event<LapCompletedEvent>(),
    raceFinished: event<RaceFinishedEvent>(),
    // New events
    driftTierReached: event<DriftTierEvent>(),
    slipstream: event<SlipstreamEvent>(),
    rocketStart: event<RocketStartEvent>(),
    readyStateChanged: event<ReadyStateEvent>(),
    rematchVote: event<RematchVoteEvent>(),
    raceToast: event<RaceToastEvent>(),
    itemDestroyed: event<ItemDestroyedEvent>(),
  },

  onBeforeConnect: (c: any) => {
    const origin = c.request?.headers.get("origin") ?? "";
    if (ALLOWED_ORIGINS.length > 0 && !ALLOWED_ORIGINS.includes(origin)) {
      throw new Error("Origin not allowed");
    }
  },

  // -----------------------------------------------------------------------
  // Connection lifecycle
  // -----------------------------------------------------------------------

  onConnect: (c: any, conn: any) => {
    const cs = conn.state as ConnState;
    const state = c.state as RaceRoomState;

    // Spectators don't get a kart
    if (cs.spectator) {
      return;
    }

    // Reconnect within grace — the kart never left; just re-arm its driver.
    if (state.players[cs.playerId]) {
      c.broadcast("raceToast", {
        text: `${cs.playerName} reconnected!`,
        color: "#44FF88",
      });
      notifyLobby(c, state.id, {
        playerCount: Object.keys(state.players).length,
        status: state.phase === "waiting" ? "waiting" : "racing",
      });
      return;
    }

    const kart = addKartForConn(c, cs);
    if (!kart) {
      conn.close?.();
      return;
    }

    const playerCount = Object.keys(state.players).length;

    if (playerCount === 1) {
      ensureLobbyRegistration(c);
    }

    notifyLobby(c, state.id, {
      playerCount,
      status: state.phase === "waiting" ? "waiting" : "racing",
    });
  },

  onDisconnect: (c: any, conn: any) => {
    const cs = conn.state as ConnState;
    const { playerId, playerName } = cs;
    const state = c.state as RaceRoomState;

    // Spectators just leave
    if (cs.spectator) return;

    if (!state.players[playerId]) return;

    // Mid-race drop: hold the kart for a reconnect grace window so a refresh
    // or network blip doesn't forfeit the player's race. The kart coasts to
    // a stop (disconnectGraceTick) and is re-adopted in createConnState when
    // a connection with the same player token returns. Only on expiry does
    // the departure finalize (kartLeft + quorum/forfeit logic).
    if (
      (state.phase === "racing" || state.phase === "countdown") &&
      cs.playerToken &&
      c.vars?.disconnects
    ) {
      c.vars.disconnects[playerId] = {
        token: cs.playerToken,
        deadline: Date.now() + RECONNECT_GRACE_MS,
      };
      const kart = state.players[playerId] as KartState;
      kart.driftState = defaultDrift();
      // The driverless ghost would otherwise keep heldItemActive=true (it's only
      // recomputed for LIVE connections in kartPhysicsTick), turning the coasting
      // kart into an invincible 12s rear shield. Clear it on the way out.
      kart.heldItemActive = false;
      c.broadcast("raceToast", {
        text: `${playerName} disconnected — holding their kart`,
        color: "#FFAA44",
      });
      return;
    }

    removePlayer(c, playerId, playerName);
  },

  // -----------------------------------------------------------------------
  // Server tick loop
  // -----------------------------------------------------------------------

  run: async (c: any) => {
    let lastSnapshot = Date.now();
    let tickCounter = 0;
    let lastTickTime = Date.now();
    let nextTickTarget = lastTickTime + RACE_SERVER_TICK_INTERVAL;
    let emptyAt: number | null = null;
    const EMPTY_TIMEOUT = 10_000;
    // Auto-start timer for waiting phase (30s with 2+ players)
    let waitingAutoStartAt: number | null = null;
    // Periodic lobby heartbeat (the lobby evicts rooms silent for >5min)
    let lastLobbyHeartbeat = Date.now();

    while (!c.aborted) {
      const now = Date.now();
      const dtMs = Math.min(now - lastTickTime, 50);
      const dt = dtMs / RACE_SERVER_TICK_INTERVAL;
      lastTickTime = now;
      if (c.vars) c.vars.tick = tickCounter;

      // Empty room auto-shutdown. Never shut down while a disconnect grace
      // window is pending — a solo racer refreshing the page must find the
      // same actor (and kart) when they come back.
      const connCount = c.conns?.size ?? 0;
      if (connCount === 0) {
        if (!emptyAt) emptyAt = now;
        const holdingReconnect =
          c.vars?.disconnects && Object.keys(c.vars.disconnects).length > 0;
        if (
          !holdingReconnect &&
          (c.state.phase === "finished" || now - emptyAt > EMPTY_TIMEOUT)
        ) {
          notifyLobby(c, c.state.id, null);
          return;
        }
      } else {
        emptyAt = null;
      }

      // Auto-start timer: if waiting with 2+ non-spectator players for 30s
      const state = c.state as RaceRoomState;
      if (state.phase === "waiting") {
        const nonSpectators = getNonSpectatorCount(c);
        if (nonSpectators >= 2) {
          if (!waitingAutoStartAt) {
            waitingAutoStartAt = now;
          } else if (now - waitingAutoStartAt >= 30000) {
            // Auto-start: force all players ready
            for (const conn of c.conns.values()) {
              const cs = conn.state as ConnState;
              if (!cs.spectator) {
                cs.ready = true;
                state.readyPlayers[cs.playerId] = true;
              }
            }
            tryStartCountdown(c);
            waitingAutoStartAt = null;
          }
        } else {
          waitingAutoStartAt = null;
        }
      } else {
        waitingAutoStartAt = null;
      }

      // Track rocket start throttle during countdown
      if (state.phase === "countdown") {
        rocketStartCountdownTick(c, tickCounter);
      }

      // Phase management
      phaseTick(c, now, dtMs, tickCounter);

      // Reconnect grace — expire abandoned karts, coast held ones
      disconnectGraceTick(c, now, dt);

      // Lobby heartbeat — refresh registration while occupied so the lobby's
      // silence-based eviction never hides a live room. Skipped while
      // finished: the room is intentionally delisted until it resets.
      if (
        connCount > 0 &&
        state.phase !== "finished" &&
        now - lastLobbyHeartbeat >= LOBBY_HEARTBEAT_INTERVAL
      ) {
        lastLobbyHeartbeat = now;
        notifyLobby(c, state.id, {
          playerCount: getNonSpectatorCount(c),
          status: state.phase === "waiting" ? "waiting" : "racing",
        });
      }

      // Physics simulation when racing
      if (state.phase === "racing") {
        const track = getTrack(state.trackId);
        kartPhysicsTick(c, dt, track);
        botPhysicsTick(c, dt, track);
        slipstreamTick(c, track);
        kartCollisionTick(c, dt);
        projectileTick(c, dt, now, track);
        hazardTick(c, track);
        itemBoxTick(c, now, track);
        checkpointTick(c, track);
        positionTick(c);
      }

      // Broadcast snapshot at 20Hz during countdown (grid sync) and racing
      if (
        (state.phase === "racing" || state.phase === "countdown") &&
        now - lastSnapshot >= RACE_SNAPSHOT_INTERVAL
      ) {
        // Pace against the wall clock — after a hitch, emit at most one late
        // snapshot instead of bursting one per 16ms tick to catch up.
        lastSnapshot = Math.max(
          lastSnapshot + RACE_SNAPSHOT_INTERVAL,
          now - RACE_SNAPSHOT_INTERVAL,
        );
        broadcastSnapshot(c, tickCounter);
      }

      tickCounter++;
      nextTickTarget += RACE_SERVER_TICK_INTERVAL;
      // A stall must not spin a burst of 1ms catch-up sleeps — re-anchor to now
      nextTickTarget = Math.max(nextTickTarget, now - RACE_SERVER_TICK_INTERVAL);
      const sleepMs = Math.max(1, nextTickTarget - Date.now());
      await new Promise((r) => setTimeout(r, sleepMs));
    }
  },

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------

  actions: {
    getJoinState: (c: any): RaceJoinStateResult => {
      const connState = c.conn?.state as ConnState | undefined;
      const s = c.state as RaceRoomState;
      return {
        state: {
          id: s.id,
          name: s.name,
          players: s.players,
          projectiles: s.projectiles,
          hazards: s.hazards,
          itemBoxes: s.itemBoxes,
          phase: s.phase,
          mode: s.mode,
          lapCount: s.lapCount,
          itemsEnabled: s.itemsEnabled,
          botsEnabled: s.botsEnabled,
          botDifficulty: s.botDifficulty,
          raceTimer: s.raceTimer,
          maxPlayers: s.maxPlayers,
          trackId: s.trackId,
          createdAt: 0,
          phaseStartedAt: 0,
          positions: s.positions,
          finishedCount: s.finishedCount,
          readyPlayers: s.readyPlayers,
          rematchVotes: s.rematchVotes,
          stats: s.stats,
        },
        playerId: connState?.playerId ?? "",
        isSpectator: connState?.spectator ?? false,
      };
    },

    sendInput: (c: any, input: KartInput): void => {
      const connState = c.conn?.state as ConnState | undefined;
      if (!connState) return;

      // Spectators can't send input
      if (connState.spectator) return;

      // Always accept the newest input — dropping it would discard the most
      // recent intent (a rate gate here punished well-behaved fast senders).
      connState.lastInputAt = Date.now();

      // Validate input fields
      const steering = Number(input.steering);
      if (!Number.isFinite(steering)) return;

      // Client prediction ack: track the newest seq this connection has
      // delivered. It is echoed per kart in snapshots (lastProcessedSeq) so
      // the client can drop acked inputs and replay only the rest.
      const seq = Number(input.seq);
      const validSeq = Number.isFinite(seq) ? Math.max(0, seq) : 0;
      if (validSeq > connState.lastProcessedSeq) {
        connState.lastProcessedSeq = validSeq;
      }

      connState.input = {
        steering: Math.max(-1, Math.min(1, steering)),
        throttle: Boolean(input.throttle),
        brake: Boolean(input.brake),
        drift: Boolean(input.drift),
        // Item usage is handled via the dedicated `useItem()` action to avoid double-firing.
        useItem: false,
        // Rear-defense intent: carry "trail my held item" through the input
        // stream (the fire still goes through useItem() on tap/release).
        heldBehind: Boolean(input.heldBehind),
        seq: validSeq,
      };
    },

    useItem: (c: any): void => {
      const connState = c.conn?.state as ConnState | undefined;
      if (!connState) return;
      if (connState.spectator) return;
      if (c.state.phase !== "racing") return;

      const kart = c.state.players[connState.playerId] as KartState | undefined;
      if (!kart || !kart.currentItem) return;

      // No item use after finishing, mid-hitstop, or while spun out/falling
      if (kart.finishTime !== null) return;
      if (kart.hitstopTicks > 0) return;
      if (kart.status === "spinning" || kart.status === "falling") return;

      executeItemUse(c, kart, connState.playerId);
    },

    readyUp: (c: any): void => {
      const connState = c.conn?.state as ConnState | undefined;
      if (!connState) return;
      if (connState.spectator) return;

      const state = c.state as RaceRoomState;
      if (state.phase !== "waiting") return;

      // Toggle ready state
      connState.ready = !connState.ready;

      // Keep the persisted roster truthful so getJoinState can hydrate it
      if (connState.ready) {
        state.readyPlayers[connState.playerId] = true;
      } else {
        delete state.readyPlayers[connState.playerId];
      }

      const total = getNonSpectatorCount(c);
      const readyCount = getReadyCount(c);

      c.broadcast("readyStateChanged", {
        playerId: connState.playerId,
        ready: connState.ready,
        readyCount,
        totalCount: total,
      });

      tryStartCountdown(c);
    },

    voteRematch: (c: any): void => {
      const connState = c.conn?.state as ConnState | undefined;
      if (!connState) return;
      if (connState.spectator) return;

      const state = c.state as RaceRoomState;
      if (state.phase !== "finished") return;

      // Record vote, then tally against connected non-spectators (shared
      // with disconnect handling — a leaver can complete the quorum).
      state.rematchVotes[connState.playerId] = true;
      evaluateRematch(c, true);
    },
  },
});

// ---------------------------------------------------------------------------
// Rocket start — countdown throttle tracking
// ---------------------------------------------------------------------------

function rocketStartCountdownTick(c: any, tickCounter: number): void {
  for (const conn of c.conns.values()) {
    const cs = conn.state as ConnState;
    if (cs.spectator || cs.rocketStartFired) continue;

    if (cs.input.throttle) {
      if (cs.throttleFirstHeldTick === -1) {
        // New press — record when this continuous hold began
        cs.throttleFirstHeldTick = tickCounter;
        cs.throttleLastPressTick = tickCounter;
      }
    } else {
      // Released — the next press starts a fresh hold
      cs.throttleFirstHeldTick = -1;
    }
  }
}

// ---------------------------------------------------------------------------
// Rocket start — evaluate on GO
// ---------------------------------------------------------------------------

function evaluateRocketStarts(c: any, goTick: number): void {
  const state = c.state as RaceRoomState;
  const countdownStartTick = c.vars?.countdownStartTick ?? 0;

  for (const conn of c.conns.values()) {
    const cs = conn.state as ConnState;
    if (cs.spectator || cs.rocketStartFired) continue;

    cs.rocketStartFired = true;

    const kart = state.players[cs.playerId] as KartState | undefined;
    if (!kart) continue;

    // If never pressed throttle during countdown, no rocket start
    if (cs.throttleLastPressTick === -1) {
      kart.rocketStartTier = "none";
      continue;
    }

    // Stall ONLY when throttle has been held continuously since (before) the
    // countdown's first beep — i.e. the current hold began within the first
    // few ticks of the countdown. Pressing during the countdown and holding
    // to GO is evaluated by timing below, never stalled.
    const heldSinceFirstBeep =
      cs.input.throttle &&
      cs.throttleFirstHeldTick !== -1 &&
      cs.throttleFirstHeldTick - countdownStartTick <= 4;

    if (heldSinceFirstBeep) {
      kart.rocketStartTier = "stall";
      kart.boostSpeed = 0;
      kart.boostTimer = ROCKET_START_STALL_DURATION;
      // Stall: cap max speed temporarily (handled in kartPhysicsTick)
      c.broadcast("rocketStart", {
        kartId: kart.id,
        tier: "stall" as RocketStartTier,
        boostSpeed: 0,
      });
      c.broadcast("raceToast", {
        text: `${kart.name} stalled!`,
        color: "#FF4444",
      });
      continue;
    }

    // Must be on the throttle at GO to launch
    if (!cs.input.throttle) {
      kart.rocketStartTier = "none";
      continue;
    }

    // Evaluate timing from the most recent press relative to the GO tick
    const tickDiff = Math.abs(goTick - cs.throttleLastPressTick);

    let tier: RocketStartTier;
    let boostSpeed: number;
    let boostDuration: number;

    if (tickDiff <= ROCKET_START_PERFECT_WINDOW) {
      tier = "perfect";
      boostSpeed = ROCKET_START_PERFECT_SPEED;
      boostDuration = ROCKET_START_PERFECT_DURATION;
    } else if (tickDiff <= ROCKET_START_GOOD_WINDOW) {
      tier = "good";
      boostSpeed = ROCKET_START_GOOD_SPEED;
      boostDuration = ROCKET_START_GOOD_DURATION;
    } else if (tickDiff <= ROCKET_START_OK_WINDOW) {
      tier = "ok";
      boostSpeed = ROCKET_START_OK_SPEED;
      boostDuration = ROCKET_START_OK_DURATION;
    } else {
      kart.rocketStartTier = "none";
      continue;
    }

    kart.rocketStartTier = tier;
    kart.boostSpeed = boostSpeed;
    kart.boostTimer = boostDuration;
    kart.flowMeter = Math.min(FLOW_MAX, kart.flowMeter + FLOW_GAIN_ROCKET_START * (tier === "perfect" ? 1.0 : tier === "good" ? 0.6 : 0.3));

    c.broadcast("rocketStart", {
      kartId: kart.id,
      tier,
      boostSpeed,
    });

    const tierColors: Record<string, string> = {
      perfect: "#FFDD00",
      good: "#44FF88",
      ok: "#88AAFF",
    };
    c.broadcast("raceToast", {
      text: `${kart.name}: ${tier.toUpperCase()} start!`,
      color: tierColors[tier] || "#FFFFFF",
    });
  }
}

// ---------------------------------------------------------------------------
// Item use execution
// ---------------------------------------------------------------------------

function executeItemUse(c: any, kart: KartState, playerId?: string): void {
  const item = kart.currentItem;
  if (!item) return;

  const state = c.state as RaceRoomState;

  // Track stats
  const pid = playerId ?? kart.id;
  if (state.stats[pid]) {
    state.stats[pid].itemsUsed++;
  }

  switch (item) {
    case "greenShell": {
      const projectile = createShellProjectile(kart, "greenShell", null);
      state.projectiles.push(projectile);
      kart.currentItem = null;
      kart.itemCharges = 0;
      c.broadcast("itemUsed", { kartId: kart.id, item, projectile });
      break;
    }

    case "redShell": {
      // Target the next kart ahead in position ranking
      const targetId = findNextKartAhead(state, kart.id);
      const projectile = createShellProjectile(kart, "redShell", targetId);
      state.projectiles.push(projectile);
      kart.currentItem = null;
      kart.itemCharges = 0;
      c.broadcast("itemUsed", { kartId: kart.id, item, projectile });
      break;
    }

    case "blueShell": {
      // Target 1st place kart
      const firstId = state.positions.length > 0 ? state.positions[0] : null;
      const targetId = firstId && firstId !== kart.id ? firstId : null;
      const projectile = createShellProjectile(kart, "blueShell", targetId);
      state.projectiles.push(projectile);
      kart.currentItem = null;
      kart.itemCharges = 0;
      c.broadcast("itemUsed", { kartId: kart.id, item, projectile });
      break;
    }

    case "banana": {
      const hazard = createBananaHazard(kart);
      state.hazards.push(hazard);
      kart.currentItem = null;
      kart.itemCharges = 0;
      c.broadcast("itemUsed", { kartId: kart.id, item, hazard });
      break;
    }

    case "mushroom": {
      applyMushroom(kart);
      kart.currentItem = null;
      kart.itemCharges = 0;
      c.broadcast("itemUsed", { kartId: kart.id, item });
      break;
    }

    case "triMushroom": {
      applyMushroom(kart);
      kart.itemCharges -= 1;
      if (kart.itemCharges <= 0) {
        kart.currentItem = null;
        kart.itemCharges = 0;
      }
      c.broadcast("itemUsed", { kartId: kart.id, item });
      break;
    }

    case "star": {
      kart.status = "starred";
      kart.statusTimer = STAR_DURATION;
      kart.boostSpeed = STAR_SPEED_BONUS;
      kart.boostTimer = STAR_DURATION;
      kart.currentItem = null;
      kart.itemCharges = 0;
      c.broadcast("itemUsed", { kartId: kart.id, item });
      break;
    }

    case "lightning": {
      // Hit all other karts still racing (star + post-hit immunity spare them)
      const karts = Object.values(state.players) as KartState[];
      for (const other of karts) {
        if (other.id === kart.id) continue;
        if (other.finishTime !== null) continue; // Already finished
        if (other.status === "starred") continue; // Star grants immunity
        const otherSim = findSimStateForPlayer(c, other.id);
        if (otherSim && otherSim.immunityTicks > 0) continue; // Post-hit immunity

        if (other.status === "spinning" || other.status === "falling") {
          // Mid-spin/fall — apply the shrink duration to the timer without
          // clobbering the status: overwriting "falling" with "shrunk"
          // would strand the kart with no respawn path.
          other.statusTimer = Math.max(
            other.statusTimer,
            LIGHTNING_SHRINK_DURATION,
          );
        } else {
          other.status = "shrunk";
          other.statusTimer = LIGHTNING_SHRINK_DURATION;
        }

        // Track hit stats
        if (state.stats[kart.id]) state.stats[kart.id].hitsDealt++;
        if (state.stats[other.id]) state.stats[other.id].hitsTaken++;
        c.broadcast("kartHit", {
          kartId: other.id,
          byKartId: kart.id,
          itemType: "lightning",
        });
      }
      kart.currentItem = null;
      kart.itemCharges = 0;
      c.broadcast("itemUsed", { kartId: kart.id, item });
      break;
    }
  }
}

/** Create a shell projectile heading in the kart's forward direction */
function createShellProjectile(
  kart: KartState,
  type: "greenShell" | "redShell" | "blueShell",
  targetId: string | null,
): ProjectileState {
  const forwardX = Math.sin(kart.heading);
  const forwardZ = Math.cos(kart.heading);
  return {
    id: `proj_${uid()}`,
    type,
    position: {
      x: kart.position.x + forwardX * (KART_RADIUS + SHELL_RADIUS + 0.2),
      y: kart.position.y + 0.3,
      z: kart.position.z + forwardZ * (KART_RADIUS + SHELL_RADIUS + 0.2),
    },
    velocity: {
      x: forwardX * SHELL_SPEED,
      y: 0,
      z: forwardZ * SHELL_SPEED,
    },
    ownerId: kart.id,
    targetId,
    bounces: 0,
    age: 0,
  };
}

/** Create a banana hazard behind the kart */
function createBananaHazard(kart: KartState): HazardState {
  const backX = -Math.sin(kart.heading);
  const backZ = -Math.cos(kart.heading);
  return {
    id: `haz_${uid()}`,
    type: "banana",
    position: {
      x: kart.position.x + backX * (KART_RADIUS + BANANA_RADIUS + 0.3),
      y: kart.position.y + 0.15,
      z: kart.position.z + backZ * (KART_RADIUS + BANANA_RADIUS + 0.3),
    },
    ownerId: kart.id,
  };
}

/** Apply mushroom boost to a kart */
function applyMushroom(kart: KartState): void {
  kart.boostSpeed = MUSHROOM_BOOST_SPEED;
  kart.boostTimer = MUSHROOM_BOOST_DURATION;
}

/** Find the next kart ahead in position ranking */
function findNextKartAhead(state: RaceRoomState, kartId: string): string | null {
  const idx = state.positions.indexOf(kartId);
  if (idx <= 0) return null; // Already 1st or not found
  return state.positions[idx - 1];
}

// ---------------------------------------------------------------------------
// Apply hit to a kart (with hitstop)
// ---------------------------------------------------------------------------

function applyHitToKart(
  c: any,
  kart: KartState,
  simState: KartSimState | null,
  speedMult: number,
  byKartId: string | null,
  itemType: ItemType | "collision",
): void {
  const state = c.state as RaceRoomState;

  // Set hitstop frames — freeze the kart briefly before applying the spin
  kart.hitstopTicks = HITSTOP_FRAMES;

  // Store pending hit data on the kart's sim state (ConnState for humans, the
  // bot's sim for CPU karts) so the shared stepKart resolves the spin after
  // the hitstop window — identical for bots and humans.
  if (simState) {
    simState.hitstopPendingSpeed = speedMult;
    simState.hitstopPendingDrift = true;
  } else {
    // No sim state (truly driverless, e.g. mid-grace coast) — apply now.
    kart.status = "spinning";
    kart.statusTimer = SPIN_DURATION;
    kart.speed *= speedMult;
    kart.driftState = defaultDrift();
  }

  kart.flowMeter = Math.max(0, kart.flowMeter - FLOW_DECAY_ON_HIT);
  kart.slipAngle = 0;

  if (byKartId && state.stats[byKartId]) state.stats[byKartId].hitsDealt++;
  if (state.stats[kart.id]) state.stats[kart.id].hitsTaken++;

  c.broadcast("kartHit", {
    kartId: kart.id,
    byKartId,
    itemType,
  });
}

/** Find ConnState for a given playerId across all connections */
function findConnStateForPlayer(c: any, playerId: string): ConnState | null {
  for (const conn of c.conns.values()) {
    const cs = conn.state as ConnState;
    if (cs.playerId === playerId) return cs;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Phase management
// ---------------------------------------------------------------------------

function phaseTick(c: any, now: number, dtMs: number, tickCounter: number): void {
  const state = c.state as RaceRoomState;
  const elapsed = now - state.phaseStartedAt;

  switch (state.phase) {
    case "countdown": {
      if (elapsed >= PRE_RACE_COUNTDOWN) {
        state.phase = "racing";
        state.phaseStartedAt = now;
        state.raceTimer = 0;

        // Initialize lap start times for stats
        for (const pid of Object.keys(state.players)) {
          if (state.stats[pid]) {
            (state.stats[pid] as any).lapStartTime = 0;
          }
        }

        c.broadcast("phaseChanged", {
          phase: "racing",
          raceTimer: 0,
        });

        notifyLobby(c, state.id, {
          playerCount: getNonSpectatorCount(c),
          status: "racing",
        });

        // Evaluate rocket starts on GO
        evaluateRocketStarts(c, tickCounter);
      }
      break;
    }

    case "racing": {
      state.raceTimer += dtMs;

      // Check if all karts have finished
      const karts = Object.values(state.players) as KartState[];
      const allFinished = karts.length > 0 && karts.every((k) => k.finishTime !== null);

      // Safety net: a race also ends once every HUMAN racer has finished and only
      // bots are still circulating. Bots finish on their own now (the mesh-aware
      // aim line lets them complete laps), but this guarantees a solo human's race
      // can never hang on the 5-minute RACE_TIME_LIMIT if a bot ever stalls.
      const humanKarts = karts.filter((k) => !isBotId(k.id));
      const allHumansFinished =
        humanKarts.length > 0 && humanKarts.every((k) => k.finishTime !== null);

      // Check time limit
      const timeExpired = state.raceTimer >= RACE_TIME_LIMIT;

      if (allFinished || allHumansFinished || timeExpired) {
        state.phase = "finished";
        state.phaseStartedAt = now;

        // Assign finish positions to any unfinished karts
        const unfinished = karts.filter((k) => k.finishTime === null);
        unfinished.sort((a, b) => b.raceProgress - a.raceProgress);
        for (const k of unfinished) {
          state.finishedCount += 1;
          k.finishPosition = state.finishedCount;
          k.finishTime = state.raceTimer;
        }

        const finishTimes: Record<string, number | null> = {};
        for (const k of karts) {
          finishTimes[k.id] = k.finishTime;
        }

        c.broadcast("raceFinished", {
          positions: state.positions,
          finishTimes,
          stats: state.stats,
        });
        c.broadcast("phaseChanged", {
          phase: "finished",
          raceTimer: state.raceTimer,
        });
        notifyLobby(c, state.id, null);
      }
      break;
    }

    case "finished": {
      // Auto-reset after the results display window so the room loops into
      // the next race even if players never vote rematch (the old missing
      // case left rooms softlocked on the results screen forever).
      if (elapsed >= RACE_FINISH_DISPLAY) {
        transitionToWaiting(c, "Ready up for the next race!");
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Slipstream / Drafting tick
// ---------------------------------------------------------------------------

function slipstreamTick(c: any, track: ReturnType<typeof getTrack>): void {
  const state = c.state as RaceRoomState;
  const kartIds = Object.keys(state.players);

  // Build kart data array for cone checks
  const kartData: Array<{
    id: string;
    pos: Vec3;
    heading: number;
    speed: number;
    vx: number;
    vz: number;
  }> = [];

  for (const kid of kartIds) {
    const k = state.players[kid] as KartState;
    if (k.finishTime !== null) continue;
    kartData.push({
      id: kid,
      pos: k.position,
      heading: k.heading,
      speed: k.speed,
      vx: k.velocity.x,
      vz: k.velocity.z,
    });
  }

  // For each kart, check if any other kart is directly ahead (in their forward cone)
  for (const conn of c.conns.values()) {
    const cs = conn.state as ConnState;
    if (cs.spectator) continue;

    const kart = state.players[cs.playerId] as KartState | undefined;
    if (!kart || kart.finishTime !== null) continue;

    const myFwdX = Math.sin(kart.heading);
    const myFwdZ = Math.cos(kart.heading);
    const mySpeed = Math.sqrt(kart.velocity.x * kart.velocity.x + kart.velocity.z * kart.velocity.z);

    let foundAhead = false;

    if (mySpeed > 0.05) {
      for (const other of kartData) {
        if (other.id === cs.playerId) continue;

        // Vector from this kart to other
        const dx = other.pos.x - kart.position.x;
        const dz = other.pos.z - kart.position.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        if (dist > SLIPSTREAM_CONE_LENGTH || dist < 0.1) continue;

        // Angle between forward direction and direction to other
        const ndx = dx / dist;
        const ndz = dz / dist;
        const dot = myFwdX * ndx + myFwdZ * ndz;
        const angle = Math.acos(Math.max(-1, Math.min(1, dot)));

        if (angle > SLIPSTREAM_CONE_ANGLE) continue;

        // Check velocity alignment (both going roughly same direction)
        const otherSpeed = Math.sqrt(other.vx * other.vx + other.vz * other.vz);
        if (otherSpeed < 0.05) continue;

        const myNvx = kart.velocity.x / mySpeed;
        const myNvz = kart.velocity.z / mySpeed;
        const otherNvx = other.vx / otherSpeed;
        const otherNvz = other.vz / otherSpeed;
        const velDot = myNvx * otherNvx + myNvz * otherNvz;

        if (velDot > 0.7) {
          foundAhead = true;
          break;
        }
      }
    }

    const wasActive = kart.slipstreamActive;

    if (foundAhead) {
      cs.slipstreamTicks = Math.min(cs.slipstreamTicks + 1, SLIPSTREAM_CHARGE_TICKS + 10);

      if (cs.slipstreamTicks >= SLIPSTREAM_CHARGE_TICKS && !kart.slipstreamActive) {
        kart.slipstreamActive = true;
        cs.slipstreamBonusTicks = SLIPSTREAM_DURATION_TICKS;
        kart.flowMeter = Math.min(FLOW_MAX, kart.flowMeter + FLOW_GAIN_SLIPSTREAM);
        c.broadcast("slipstream", { kartId: kart.id, active: true });
      }
    } else {
      // Not in cone — decay slipstream ticks (grace period: lose 10/tick)
      if (cs.slipstreamTicks > 0) {
        cs.slipstreamTicks = Math.max(0, cs.slipstreamTicks - 10);
      }
    }

    // Manage bonus duration
    if (kart.slipstreamActive) {
      if (!foundAhead) {
        cs.slipstreamBonusTicks--;
      }
      if (cs.slipstreamBonusTicks <= 0) {
        kart.slipstreamActive = false;
        cs.slipstreamTicks = 0;
        cs.slipstreamBonusTicks = 0;
        if (wasActive) {
          c.broadcast("slipstream", { kartId: kart.id, active: false });
        }
      }
    }

    // Update kart slipstreamTicks for snapshot
    kart.slipstreamTicks = cs.slipstreamTicks;
  }
}

// ---------------------------------------------------------------------------
// Kart physics tick
// ---------------------------------------------------------------------------

/**
 * Frozen "coast" input fed to a kart that has already crossed the finish line.
 * The kart keeps running through the SAME shared stepKart (so drag rolls it to
 * a gentle natural stop ~2s after finishing — clearing the racing line) but no
 * longer responds to the player's held throttle/steer, which would otherwise
 * let a finished kart keep driving laps. Shared/frozen to avoid per-tick alloc.
 */
const COAST_INPUT: KartInput = Object.freeze({
  steering: 0,
  throttle: false,
  brake: false,
  drift: false,
  useItem: false,
  heldBehind: false,
  seq: 0,
});

function kartPhysicsTick(c: any, dt: number, track: ReturnType<typeof getTrack>): void {
  const state = c.state as RaceRoomState;

  for (const conn of c.conns.values()) {
    const cs = conn.state as ConnState;
    if (cs.spectator) continue;

    const kart = state.players[cs.playerId] as KartState | undefined;
    if (!kart) continue;

    // A finished kart coasts to rest (early-finisher behavior) and ignores
    // live input — finished bots coast the same way in botPhysicsTick, so the
    // two paths stay symmetric and a finished player can't keep driving laps
    // on a held throttle.
    const input = kart.finishTime !== null ? COAST_INPUT : cs.input;

    // Rear-defense: the kart trails its held item while the player holds the
    // item key with a holdable item and is alive. Snapshotted so the client can
    // render the trailed mesh and projectileTick can place the defense point.
    kart.heldItemActive =
      Boolean(input.heldBehind) &&
      isHoldableItem(kart.currentItem) &&
      kart.finishTime === null &&
      kart.hitstopTicks <= 0 &&
      kart.status !== "spinning" &&
      kart.status !== "falling";

    // Shared physics step — the exact same code the client predicts with
    // (src/lib/racing/kart-physics.ts). Server-only outcomes come back as
    // events so they can be folded into stats / broadcasts here.
    const events = stepKart(kart, cs, input, track, dt, state.trackId);
    foldStepEvents(c, kart, cs.playerId, events);
  }
}

/** Fold a stepKart result into stats + driftTier broadcasts (humans + bots). */
function foldStepEvents(
  c: any,
  kart: KartState,
  playerId: string,
  events: ReturnType<typeof stepKart>,
): void {
  const state = c.state as RaceRoomState;
  const stats = state.stats[playerId] as RaceStats | undefined;
  if (stats) {
    if (events.topSpeedSample !== null && events.topSpeedSample > stats.topSpeed) {
      stats.topSpeed = events.topSpeedSample;
    }
    if (events.driftBoostReleased) {
      stats.driftBoosts++;
    }
  }
  if (events.driftTierUp !== null) {
    c.broadcast("driftTierReached", {
      kartId: kart.id,
      tier: events.driftTierUp,
    });
  }
}

// ---------------------------------------------------------------------------
// CPU bot physics tick — same stepKart as humans, AI-synthesized input
// ---------------------------------------------------------------------------

/**
 * Drive every CPU bot one tick: compute a path-following KartInput, run the
 * SHARED stepKart (identical handling to humans), fold stats/events, then let
 * the bot fire its held item through the normal executeItemUse path.
 *
 * Rubber-banding nudges each bot's target speed up/down by its progress gap to
 * the nearest human so a lone human stays in contention without bots feeling
 * unfair.
 */
function botPhysicsTick(c: any, dt: number, track: ReturnType<typeof getTrack>): void {
  const state = c.state as RaceRoomState;
  const bots = c.vars?.bots as
    | Record<string, { sim: KartSimState; driver: BotSimState }>
    | undefined;
  if (!bots) return;

  // Nearest-human progress reference for rubber-banding (best human in front).
  let leadHumanProgress = -Infinity;
  for (const id of Object.keys(state.players)) {
    if (isBotId(id)) continue;
    const k = state.players[id] as KartState;
    if (k.finishTime !== null) continue;
    if (k.raceProgress > leadHumanProgress) leadHumanProgress = k.raceProgress;
  }
  const trackLength = track.totalLength || 1;

  const baseMult = BOT_BASE_SPEED_MULT[state.botDifficulty] ?? BOT_BASE_SPEED_MULT.medium;

  // Mesh-snapped racing line (memoized): on track1 the authored segment centers
  // sit off the baked road mesh by up to ~130 units, so bots must aim at this
  // on-mesh line instead of seg.center or they drive off-road and never finish.
  // Null on neon-circuit (no mesh — centerline is the road).
  const racingLine = getMeshRacingLine(state.trackId, track);

  for (const botId of Object.keys(bots)) {
    const kart = state.players[botId] as KartState | undefined;
    if (!kart) {
      delete bots[botId];
      continue;
    }

    // A finished bot coasts to rest like a finished human (drag rolls it off
    // the racing line over ~2s) instead of freezing mid-motion — no AI input,
    // no item use, just the shared coast step.
    if (kart.finishTime !== null) {
      stepKart(kart, bots[botId].sim, COAST_INPUT, track, dt, state.trackId);
      continue;
    }

    const { sim, driver } = bots[botId];

    // Rubber-band: scale toward the human leader. Behind → speed up (+range),
    // ahead → ease off (−range). Half a lap of gap saturates the effect.
    let speedMult = baseMult;
    if (Number.isFinite(leadHumanProgress)) {
      const gap = leadHumanProgress - kart.raceProgress; // >0 = bot behind
      const norm = Math.max(-1, Math.min(1, gap / (trackLength * 0.5)));
      speedMult = baseMult * (1 + BOT_RUBBERBAND_RANGE * norm);
    }

    // Item targeting: the kart immediately ahead in race order (if not us).
    const posIdx = state.positions.indexOf(botId);
    const targetAheadId =
      posIdx > 0 ? state.positions[posIdx - 1] ?? null : null;
    const isLeading = state.positions.length > 0 && state.positions[0] === botId;

    const ctx: BotContext = {
      tick: c.vars?.tick ?? 0,
      speedMult,
      targetAheadId,
      isLeading,
      racingLine,
    };

    const { input, useItem: wantsItem } = computeBotInput(kart, driver, track, ctx);

    const events = stepKart(kart, sim, input, track, dt, state.trackId);
    foldStepEvents(c, kart, botId, events);

    // Item use through the same path humans take (respects the same guards).
    if (
      wantsItem &&
      kart.currentItem &&
      kart.finishTime === null &&
      kart.hitstopTicks <= 0 &&
      kart.status !== "spinning" &&
      kart.status !== "falling"
    ) {
      executeItemUse(c, kart, botId);
    }
  }
}

// ---------------------------------------------------------------------------
// Kart-kart collision
// ---------------------------------------------------------------------------

function kartCollisionTick(c: any, dt: number): void {
  const state = c.state as RaceRoomState;
  const kartIds = Object.keys(state.players);

  for (let i = 0; i < kartIds.length; i++) {
    const a = state.players[kartIds[i]] as KartState;
    if (a.finishTime !== null) continue;

    for (let j = i + 1; j < kartIds.length; j++) {
      const b = state.players[kartIds[j]] as KartState;
      if (b.finishTime !== null) continue;

      const dx = b.position.x - a.position.x;
      const dz = b.position.z - a.position.z;
      const distSq = dx * dx + dz * dz;
      const minDist = KART_RADIUS * 2;

      if (distSq >= minDist * minDist || distSq < 0.0001) continue;

      const dist = Math.sqrt(distSq);
      const nx = dx / dist;
      const nz = dz / dist;

      // Per-car mass: the heavier kart shoves the lighter one further and
      // loses less of its own speed on contact. Shares are split by the
      // OTHER kart's mass (a heavy opponent pushes you back more).
      const aMass = getCarStats(a.carId).massMult;
      const bMass = getCarStats(b.carId).massMult;
      const totalMass = aMass + bMass;
      const aSepShare = bMass / totalMass; // a is pushed proportional to b's mass
      const bSepShare = aMass / totalMass;
      // Speed-loss multiplier: lighter karts (relative to the pair) eat more
      // of the impulse. MASS_ADVANTAGE_PUSH scales how strong the bias is.
      const aImpulseMult = 1 + (bMass - aMass) / totalMass * (MASS_ADVANTAGE_PUSH * 10);
      const bImpulseMult = 1 + (aMass - bMass) / totalMass * (MASS_ADVANTAGE_PUSH * 10);

      const overlap = minDist - dist;
      a.position.x -= nx * overlap * aSepShare;
      a.position.z -= nz * overlap * aSepShare;
      b.position.x += nx * overlap * bSepShare;
      b.position.z += nz * overlap * bSepShare;

      const aForwardX = Math.sin(a.heading);
      const aForwardZ = Math.cos(a.heading);
      const bForwardX = Math.sin(b.heading);
      const bForwardZ = Math.cos(b.heading);

      const aDot = aForwardX * nx + aForwardZ * nz;
      const bDot = bForwardX * (-nx) + bForwardZ * (-nz);

      const isSideContact = Math.abs(aDot) < 0.5 && Math.abs(bDot) < 0.5;
      const isRearTap = (aDot > 0.6 && bDot < -0.3) || (bDot > 0.6 && aDot < -0.3);

      if (isSideContact) {
        a.speed *= Math.pow(1 - SIDE_RUB_SCRUB_RATE, dt);
        b.speed *= Math.pow(1 - SIDE_RUB_SCRUB_RATE, dt);
        a.slipAngle = Math.min(SLIP_ANGLE_MAX, a.slipAngle + 0.03);
        b.slipAngle = Math.min(SLIP_ANGLE_MAX, b.slipAngle + 0.03);
      } else if (isRearTap) {
        if (aDot > bDot) {
          b.slipAngle = Math.min(SLIP_ANGLE_MAX, b.slipAngle + REAR_TAP_DESTABILIZE);
          b.speed -= KART_COLLISION_PUSH * 1.5 * bImpulseMult;
          a.speed -= KART_COLLISION_PUSH * 0.5 * aImpulseMult;
        } else {
          a.slipAngle = Math.min(SLIP_ANGLE_MAX, a.slipAngle + REAR_TAP_DESTABILIZE);
          a.speed -= KART_COLLISION_PUSH * 1.5 * aImpulseMult;
          b.speed -= KART_COLLISION_PUSH * 0.5 * bImpulseMult;
        }
      } else {
        a.speed -= aDot * KART_COLLISION_PUSH * aImpulseMult;
        b.speed -= bDot * KART_COLLISION_PUSH * bImpulseMult;
      }

      // Star collision — starred kart spins the other. The hitstopTicks
      // guard (mirroring projectileTick) stops kartHit from re-firing every
      // tick while the victim is frozen in the 3-tick hitstop.
      if (a.status === "starred" && b.status !== "starred") {
        if (
          b.status !== "spinning" &&
          b.status !== "falling" &&
          b.hitstopTicks <= 0
        ) {
          const bSim = findSimStateForPlayer(c, b.id);
          // Check hit immunity
          if (!bSim || bSim.immunityTicks <= 0) {
            applyHitToKart(c, b, bSim, 0.3, a.id, "collision");
          }
        }
      } else if (b.status === "starred" && a.status !== "starred") {
        if (
          a.status !== "spinning" &&
          a.status !== "falling" &&
          a.hitstopTicks <= 0
        ) {
          const aSim = findSimStateForPlayer(c, a.id);
          if (!aSim || aSim.immunityTicks <= 0) {
            applyHitToKart(c, a, aSim, 0.3, b.id, "collision");
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Projectile tick (shells)
// ---------------------------------------------------------------------------

/** Segments ahead of the shell's own position a homing shell steers toward */
const SHELL_PATH_LOOKAHEAD_SEGMENTS = 4;
/** Within this XZ distance a homing shell abandons the road and chases the kart */
const SHELL_DIRECT_HOMING_DIST = 50;
/** Shells ride this far above the sampled road surface */
const SHELL_ROAD_HOVER = 1.0;

function projectileTick(c: any, dt: number, now: number, track: ReturnType<typeof getTrack>): void {
  const state = c.state as RaceRoomState;
  const projectiles = state.projectiles as ProjectileState[];
  const segments = track.segments;
  const totalSegments = segments.length;
  const isTrack1 = state.trackId === "track1";
  const toRemove: Set<string> = new Set();

  for (const proj of projectiles) {
    // Age check
    proj.age += dt * RACE_SERVER_TICK_INTERVAL;
    if (proj.age >= PROJECTILE_MAX_AGE) {
      toRemove.add(proj.id);
      continue;
    }

    // Red shell & blue shell homing — path-follow the road toward the
    // target (straight-line pursuit dove off the mesh on every corner).
    if ((proj.type === "redShell" || proj.type === "blueShell") && proj.targetId) {
      // For blue shell, dynamically retarget 1st place
      let targetId = proj.targetId;
      if (proj.type === "blueShell" && state.positions.length > 0) {
        targetId = state.positions[0];
        proj.targetId = targetId;
      }

      const target = state.players[targetId] as KartState | undefined;
      if (target && target.finishTime === null) {
        const projSegIdx = findNearestSegment(
          segments,
          proj.position.x,
          proj.position.z,
        );
        // target.segmentIndex is re-cached by the physics step each tick
        const segGap =
          (target.segmentIndex - projSegIdx + totalSegments) % totalSegments;
        const distToTarget = vec3Distance2D(proj.position, target.position);

        // Far away: steer at the road a few segments ahead so the shell
        // follows corners. Close (or within the lookahead arc): lock on.
        let aimX: number;
        let aimZ: number;
        if (
          distToTarget <= SHELL_DIRECT_HOMING_DIST ||
          segGap <= SHELL_PATH_LOOKAHEAD_SEGMENTS
        ) {
          aimX = target.position.x;
          aimZ = target.position.z;
        } else {
          const ahead =
            segments[(projSegIdx + SHELL_PATH_LOOKAHEAD_SEGMENTS) % totalSegments];
          aimX = ahead.center.x;
          aimZ = ahead.center.z;
        }

        const dx = aimX - proj.position.x;
        const dz = aimZ - proj.position.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist > 0.1) {
          const currentSpeed = Math.sqrt(
            proj.velocity.x * proj.velocity.x + proj.velocity.z * proj.velocity.z,
          );
          const speed = Math.max(currentSpeed, SHELL_SPEED);
          proj.velocity.x = (dx / dist) * speed;
          proj.velocity.z = (dz / dist) * speed;
        }
      }
    }

    // Move projectile
    proj.position.x += proj.velocity.x * dt;
    proj.position.z += proj.velocity.z * dt;

    const segIdx = findNearestSegment(segments, proj.position.x, proj.position.z);

    // Glue the shell to the road surface — launch height otherwise persists
    // across track1's ~68 units of elevation change.
    const meshY = isTrack1
      ? sampleRoadHeight(proj.position.x, proj.position.z)
      : null;
    const roadY = meshY ?? segments[segIdx].center.y;
    proj.position.y += (roadY + SHELL_ROAD_HOVER - proj.position.y) * 0.3;

    // Track boundary bounce/destroy. Track1 karts live on the baked road
    // mesh (sampleRoadDistance <= 4 in kartPhysicsTick), so shells use the
    // same mesh test — the centerline half-width check killed them on wide
    // or folded sections (e.g. the hairpin) that karts drive legally. The
    // centerline test is kept as a union because TRACK1_CENTERS diverges
    // from the mesh on some stretches and homing shells path-follow the
    // centerline there.
    const onRoad = isTrack1
      ? sampleRoadDistance(proj.position.x, proj.position.z) <= 4 ||
        isOnRoad(segments, segIdx, proj.position.x, proj.position.z)
      : isOnRoad(segments, segIdx, proj.position.x, proj.position.z);

    if (!onRoad) {
      if (proj.type === "greenShell") {
        // Bounce green shell
        proj.bounces += 1;
        if (proj.bounces > GREEN_SHELL_MAX_BOUNCES) {
          toRemove.add(proj.id);
          continue;
        }
        // Reflect velocity off track boundary normal
        const seg = segments[segIdx];
        const lateral = getLateralOffset(segments, segIdx, proj.position.x, proj.position.z);
        // Reflect off the track normal (left/right boundary)
        const reflectNx = lateral > 0 ? -seg.normal.x : seg.normal.x;
        const reflectNz = lateral > 0 ? -seg.normal.z : seg.normal.z;
        const dot = proj.velocity.x * reflectNx + proj.velocity.z * reflectNz;
        proj.velocity.x -= 2 * dot * reflectNx;
        proj.velocity.z -= 2 * dot * reflectNz;
        // Push back onto road
        proj.position.x += reflectNx * 0.5;
        proj.position.z += reflectNz * 0.5;
      } else {
        // Red and blue shells destroy on wall hit
        toRemove.add(proj.id);
        continue;
      }
    }

    // Held-item rear defense: a kart trailing an item exposes a defense point
    // ~HELD_ITEM_DEFENSE_OFFSET units behind it. An incoming shell that reaches
    // it (and isn't the defender's own) is destroyed and consumes the held item
    // — the classic "drag a shell to block a red shell" move. Checked before
    // the kart-body collision so a trailed item shields the kart itself.
    let defended = false;
    const defenderIds = Object.keys(state.players);
    for (const did of defenderIds) {
      const defender = state.players[did] as KartState;
      if (!defender.heldItemActive) continue;
      if (!isHoldableItem(defender.currentItem)) continue;
      // Belt-and-suspenders: a grace-held (disconnected, driverless) kart can't
      // defend. Only a live human connection or a CPU bot may hold the shield —
      // a kart with neither is a coasting ghost whose heldItemActive is stale.
      if (!isBotId(did) && !findConnStateForPlayer(c, did)) continue;
      if (did === proj.ownerId && proj.age < PROJECTILE_PAIR_GRACE_MS) continue;
      const backX = -Math.sin(defender.heading);
      const backZ = -Math.cos(defender.heading);
      const dpx = defender.position.x + backX * HELD_ITEM_DEFENSE_OFFSET;
      const dpz = defender.position.z + backZ * HELD_ITEM_DEFENSE_OFFSET;
      const ddx = proj.position.x - dpx;
      const ddz = proj.position.z - dpz;
      const r = HELD_ITEM_DEFENSE_RADIUS + SHELL_RADIUS;
      if (ddx * ddx + ddz * ddz <= r * r) {
        consumeHeldDefense(c, defender);
        toRemove.add(proj.id);
        c.broadcast("itemDestroyed", {
          x: proj.position.x,
          y: proj.position.y,
          z: proj.position.z,
          cause: "trailBlock",
          defenderId: did,
        } satisfies ItemDestroyedEvent);
        defended = true;
        break;
      }
    }
    if (defended) continue;

    // Check kart collision
    const kartIds = Object.keys(state.players);
    for (const kid of kartIds) {
      if (kid === proj.ownerId && proj.age < 500) continue; // Brief owner immunity
      const kart = state.players[kid] as KartState;
      if (kart.finishTime !== null) continue;
      if (kart.status === "starred") continue; // Star grants immunity
      if (kart.status === "spinning" || kart.status === "falling") continue;
      if (kart.hitstopTicks > 0) continue; // Already in hitstop

      // Check hit immunity
      const kartSim = findSimStateForPlayer(c, kid);
      if (kartSim && kartSim.immunityTicks > 0) continue;

      const hitDist = vec3Distance2D(proj.position, kart.position);
      if (hitDist < SHELL_RADIUS + KART_RADIUS) {
        applyHitToKart(c, kart, kartSim, 0.3, proj.ownerId, proj.type);
        toRemove.add(proj.id);
        break;
      }
    }
  }

  // Projectile-vs-hazard: a shell that runs over a banana mutually destroys it.
  // Squared-distance early-out; counts are tiny.
  const hazards = state.hazards as HazardState[];
  if (hazards.length > 0) {
    const hazRemove: Set<string> = new Set();
    for (const proj of projectiles) {
      if (toRemove.has(proj.id)) continue;
      for (const hazard of hazards) {
        if (hazRemove.has(hazard.id)) continue;
        const dx = proj.position.x - hazard.position.x;
        const dz = proj.position.z - hazard.position.z;
        const r = SHELL_RADIUS + BANANA_RADIUS;
        if (dx * dx + dz * dz <= r * r) {
          toRemove.add(proj.id);
          hazRemove.add(hazard.id);
          c.broadcast("itemDestroyed", {
            x: hazard.position.x,
            y: hazard.position.y,
            z: hazard.position.z,
            cause: "shellVsBanana",
          } satisfies ItemDestroyedEvent);
          break;
        }
      }
    }
    if (hazRemove.size > 0) {
      state.hazards = hazards.filter((h) => !hazRemove.has(h.id));
    }
  }

  // Projectile-vs-projectile: two shells that collide mutually destroy. Skip
  // same-owner pairs younger than the launch grace so a multi-shot can't
  // self-destruct at the muzzle.
  for (let i = 0; i < projectiles.length; i++) {
    const a = projectiles[i];
    if (toRemove.has(a.id)) continue;
    for (let j = i + 1; j < projectiles.length; j++) {
      const b = projectiles[j];
      if (toRemove.has(b.id)) continue;
      if (
        a.ownerId === b.ownerId &&
        (a.age < PROJECTILE_PAIR_GRACE_MS || b.age < PROJECTILE_PAIR_GRACE_MS)
      ) {
        continue;
      }
      const dx = a.position.x - b.position.x;
      const dz = a.position.z - b.position.z;
      const r = SHELL_RADIUS + SHELL_RADIUS;
      if (dx * dx + dz * dz <= r * r) {
        toRemove.add(a.id);
        toRemove.add(b.id);
        c.broadcast("itemDestroyed", {
          x: (a.position.x + b.position.x) * 0.5,
          y: (a.position.y + b.position.y) * 0.5,
          z: (a.position.z + b.position.z) * 0.5,
          cause: "shellVsShell",
        } satisfies ItemDestroyedEvent);
        break;
      }
    }
  }

  // Remove destroyed projectiles
  if (toRemove.size > 0) {
    state.projectiles = projectiles.filter((p) => !toRemove.has(p.id));
  }
}

/**
 * A trailed item blocked an incoming shell — consume the defender's held item
 * (clear currentItem / decrement charges) and broadcast an itemUsed-like event
 * so clients fold the item out of the HUD slot.
 */
function consumeHeldDefense(c: any, defender: KartState): void {
  const item = defender.currentItem;
  if (!item) return;
  if (defender.itemCharges > 1) {
    defender.itemCharges -= 1;
  } else {
    defender.currentItem = null;
    defender.itemCharges = 0;
    defender.heldItemActive = false;
  }
  c.broadcast("itemUsed", { kartId: defender.id, item });
}

// ---------------------------------------------------------------------------
// Hazard tick (bananas)
// ---------------------------------------------------------------------------

/** Bananas settle this far above the sampled road surface */
const HAZARD_ROAD_HOVER = 0.5;

function hazardTick(c: any, track: ReturnType<typeof getTrack>): void {
  const state = c.state as RaceRoomState;
  const hazards = state.hazards as HazardState[];
  const segments = track.segments;
  const isTrack1 = state.trackId === "track1";
  const toRemove: Set<string> = new Set();

  const kartIds = Object.keys(state.players);

  for (const hazard of hazards) {
    // Settle the banana onto the road — it's dropped at kart hover height
    // and would otherwise float there forever.
    const meshY = isTrack1
      ? sampleRoadHeight(hazard.position.x, hazard.position.z)
      : null;
    const roadY =
      meshY ??
      segments[
        findNearestSegment(segments, hazard.position.x, hazard.position.z)
      ].center.y;
    hazard.position.y += (roadY + HAZARD_ROAD_HOVER - hazard.position.y) * 0.2;

    for (const kid of kartIds) {
      const kart = state.players[kid] as KartState;
      if (kart.finishTime !== null) continue;
      if (kart.status === "starred") continue; // Star grants immunity
      if (kart.status === "spinning" || kart.status === "falling") continue;
      if (kart.hitstopTicks > 0) continue; // Already in hitstop

      // Check hit immunity
      const kartSim = findSimStateForPlayer(c, kid);
      if (kartSim && kartSim.immunityTicks > 0) continue;

      // Brief owner immunity (based on distance — owner just dropped it)
      if (kart.id === hazard.ownerId) {
        const dropDist = vec3Distance2D(kart.position, hazard.position);
        if (dropDist < KART_RADIUS * 3) continue;
      }

      const hitDist = vec3Distance2D(hazard.position, kart.position);
      if (hitDist < BANANA_RADIUS + KART_RADIUS) {
        applyHitToKart(c, kart, kartSim, 0.5, hazard.ownerId, "banana");
        toRemove.add(hazard.id);
        break;
      }
    }
  }

  if (toRemove.size > 0) {
    state.hazards = hazards.filter((h) => !toRemove.has(h.id));
  }
}

// ---------------------------------------------------------------------------
// Item box tick
// ---------------------------------------------------------------------------

function itemBoxTick(c: any, now: number, track: ReturnType<typeof getTrack>): void {
  const state = c.state as RaceRoomState;
  const itemBoxes = state.itemBoxes as ItemBoxState[];

  for (const box of itemBoxes) {
    if (!box.active) {
      // Countdown respawn
      box.respawnTimer -= RACE_SERVER_TICK_INTERVAL;
      if (box.respawnTimer <= 0) {
        box.active = true;
        box.respawnTimer = 0;
      }
      continue;
    }

    // Check kart collision with active box
    const kartIds = Object.keys(state.players);
    for (const kid of kartIds) {
      const kart = state.players[kid] as KartState;
      if (kart.finishTime !== null) continue;
      if (kart.currentItem !== null) continue; // Already holding an item
      // Tumbling through a row shouldn't vacuum boxes
      if (kart.hitstopTicks > 0) continue;
      if (kart.status === "spinning" || kart.status === "falling") continue;

      const hitDist = vec3Distance2D(box.position, kart.position);
      if (hitDist < KART_RADIUS + 0.8) {
        // Pick up item — use improved rubber-banding
        const { item, charges } = rollItem(state, kart.id);
        kart.currentItem = item;
        kart.itemCharges = charges;

        box.active = false;
        box.respawnTimer = ITEM_BOX_RESPAWN_TIME;

        c.broadcast("itemPickedUp", {
          kartId: kart.id,
          item,
          charges,
          boxId: box.id,
        });
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Checkpoint & lap tracking
// ---------------------------------------------------------------------------

function checkpointTick(c: any, track: ReturnType<typeof getTrack>): void {
  const state = c.state as RaceRoomState;
  const segments = track.segments;
  const totalSegments = segments.length;
  const checkpoints = track.checkpoints;
  const trackLength = track.totalLength;
  const windowSegs = totalSegments * 0.05;

  const kartIds = Object.keys(state.players);
  for (const kid of kartIds) {
    const kart = state.players[kid] as KartState;
    if (kart.finishTime !== null) continue;

    // Reuse the nearest segment cached by the physics step this tick
    const segIdx = kart.segmentIndex;
    const seg = segments[segIdx];

    // --- Checkpoint collection / lap completion ---
    const nextCp = kart.checkpoint;
    if (nextCp >= checkpoints.length) {
      // All checkpoints passed — check if crossing start/finish (segment 0 region)
      if (segIdx < totalSegments * 0.1) {
        // Crossed start/finish — complete lap
        kart.lap += 1;
        kart.checkpoint = 0;

        // If the crossing was detected past checkpoint 0's collection window
        // (fast kart, sparse segment sampling), credit any windows already
        // passed so the lap doesn't silently cost a full extra loop.
        while (
          kart.checkpoint < checkpoints.length &&
          checkpoints[kart.checkpoint].segmentIndex + windowSegs < segIdx
        ) {
          kart.checkpoint += 1;
        }

        // Lap split — race timer at this crossing minus the previous one.
        // Tracked per-kart (not just in stats) so the HUD has a truthful split
        // even before/without a stats entry. EVERY completed lap is timed:
        // lapStartTime starts at 0 on GO, so the first crossing (lap 0 → 1)
        // yields the real lap-1 time, not 0. (The old `kart.lap > 1` guard left
        // lap 1 untimed, killing best-lap telemetry and 1-lap races entirely.)
        const stats = state.stats[kid];
        const prevLapStart = (stats as any)?.lapStartTime ?? 0;
        const lapTime = state.raceTimer - prevLapStart;
        if (stats) {
          if (stats.bestLapTime === null || lapTime < stats.bestLapTime) {
            stats.bestLapTime = lapTime;
          }
          (stats as any).lapStartTime = state.raceTimer;
        }

        c.broadcast("lapCompleted", {
          kartId: kart.id,
          lap: kart.lap,
          raceTime: state.raceTimer,
          lapTime,
        });

        // Check if race finished for this kart
        if (kart.lap >= state.lapCount) {
          state.finishedCount += 1;
          kart.finishPosition = state.finishedCount;
          kart.finishTime = state.raceTimer;
          // Don't hard-zero velocity here: kartPhysicsTick now steps finished
          // karts with a coast input, so drag rolls them to a gentle stop and
          // off the racing line over ~2s (early-finisher feel) instead of
          // snapping to a dead halt the instant the line is crossed.
        }
      }
    } else {
      // Collect the next checkpoint when the kart is within the window of it OR
      // has clearly driven PAST it: its segment sits ahead of the checkpoint
      // segment by more than the window but well short of half a loop (a true
      // wrap). The "passed" case forgives a checkpoint skipped by a fall+respawn
      // just beyond it (e.g. overshooting the hairpin, whose tip checkpoint a
      // respawn can land past) or a fast kart that jumped the window between
      // ticks — without it that kart could never collect the missed checkpoint
      // and laps would stop counting forever (bots AND humans). Loops so a single
      // tick can credit every checkpoint already behind the kart.
      while (kart.checkpoint < checkpoints.length) {
        const cpSegIdx = checkpoints[kart.checkpoint].segmentIndex;
        const segDiff = Math.abs(segIdx - cpSegIdx);
        const wrappedDiff = Math.min(segDiff, totalSegments - segDiff);
        const forwardGap = (segIdx - cpSegIdx + totalSegments) % totalSegments;
        const passedCheckpoint =
          forwardGap >= windowSegs && forwardGap < totalSegments / 2;

        if (wrappedDiff < windowSegs || passedCheckpoint) {
          kart.checkpoint += 1;
        } else {
          break;
        }
      }
    }

    // --- Continuous, checkpoint-gated race progress (world units) ---
    // Arc position along the loop = segment distance + projection of the
    // offset from the segment center onto the segment's forward (XZ).
    const dx = kart.position.x - seg.center.x;
    const dz = kart.position.z - seg.center.z;
    let along = seg.distance + (dx * seg.forward.x + dz * seg.forward.z);

    // Progress is gated to the checkpoint AFTER the next uncollected one, so
    // cutting or reversing over the line can't fake a near-lap lead.
    const gateIdx = kart.checkpoint + 1;
    const gateDist =
      gateIdx < checkpoints.length
        ? segments[checkpoints[gateIdx].segmentIndex].distance
        : trackLength;

    // If the arc position is more than half a loop ahead of the gate, the
    // kart has wrapped behind the start/finish line (grid start, reversing
    // across the line) — count it as negative progress on the current lap.
    if (along - gateDist > trackLength / 2) {
      along -= trackLength;
    }

    kart.raceProgress = kart.lap * trackLength + Math.min(along, gateDist);
  }
}

// ---------------------------------------------------------------------------
// Position ranking
// ---------------------------------------------------------------------------

function positionTick(c: any): void {
  const state = c.state as RaceRoomState;
  const kartIds = Object.keys(state.players);

  // Sort by race progress (finished karts ranked by finish position)
  kartIds.sort((aId, bId) => {
    const a = state.players[aId] as KartState;
    const b = state.players[bId] as KartState;

    // Finished karts go first, ranked by finish position
    if (a.finishTime !== null && b.finishTime !== null) {
      return (a.finishPosition ?? 99) - (b.finishPosition ?? 99);
    }
    if (a.finishTime !== null) return -1;
    if (b.finishTime !== null) return 1;

    // Higher progress = further ahead
    return b.raceProgress - a.raceProgress;
  });

  state.positions = kartIds;
}

// ---------------------------------------------------------------------------
// Broadcast snapshot
// ---------------------------------------------------------------------------

function broadcastSnapshot(c: any, tick: number): void {
  const state = c.state as RaceRoomState;
  const kartIds = Object.keys(state.players);
  if (kartIds.length === 0) return;

  // Per-kart input acks for client prediction (karts without a live
  // connection — reconnect grace — report 0, i.e. "nothing processed").
  const seqByPlayer: Record<string, number> = {};
  for (const conn of c.conns.values()) {
    const cs = conn.state as ConnState;
    if (!cs.spectator) seqByPlayer[cs.playerId] = cs.lastProcessedSeq;
  }

  const karts: RaceSnapshot["karts"] = {};
  for (const id of kartIds) {
    const k = state.players[id] as KartState;
    karts[id] = {
      name: k.name,
      carId: k.carId,
      accentIndex: k.accentIndex,
      isBot: k.isBot,
      position: k.position,
      heading: k.heading,
      speed: k.speed,
      velocity: k.velocity,
      driftState: k.driftState,
      status: k.status,
      statusTimer: k.statusTimer,
      currentItem: k.currentItem,
      itemCharges: k.itemCharges,
      heldItemActive: k.heldItemActive,
      lap: k.lap,
      checkpoint: k.checkpoint,
      boostTimer: k.boostTimer,
      boostSpeed: k.boostSpeed,
      slipstreamActive: k.slipstreamActive,
      slipAngle: k.slipAngle,
      flowMeter: k.flowMeter,
      surface: k.surface,
      loadFactor: k.loadFactor,
      lastProcessedSeq: seqByPlayer[id] ?? 0,
    };
  }

  const itemBoxSnapshots = (state.itemBoxes as ItemBoxState[]).map((b) => ({
    id: b.id,
    active: b.active,
  }));

  c.broadcast("raceSnapshot", {
    karts,
    projectiles: state.projectiles,
    hazards: state.hazards,
    itemBoxes: itemBoxSnapshots,
    raceTimer: state.raceTimer,
    positions: state.positions,
    tick,
  } satisfies RaceSnapshot);
}
