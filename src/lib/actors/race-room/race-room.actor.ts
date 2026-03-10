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
  BOOST_PAD_DURATION,
  BOOST_PAD_SPEED,
  BANANA_RADIUS,
  DRIFT_BOOST_DURATIONS,
  DRIFT_BOOST_SPEEDS,
  DRIFT_CHARGE_THRESHOLDS,
  DRIFT_TURN_MULTIPLIER,
  GREEN_SHELL_MAX_BOUNCES,
  ITEM_BOX_RESPAWN_TIME,
  ITEM_PROBABILITIES,
  KART_ACCELERATION,
  KART_BRAKE_FORCE,
  KART_COLLISION_PUSH,
  KART_DRAG,
  KART_MAX_SPEED,
  KART_RADIUS,
  KART_REVERSE_ACCEL,
  KART_REVERSE_MAX,
  KART_TURN_RATE,
  LIGHTNING_SHRINK_DURATION,
  MIN_DRIFT_SPEED,
  MUSHROOM_BOOST_DURATION,
  MUSHROOM_BOOST_SPEED,
  NUM_CHECKPOINTS,
  OFF_ROAD_SPEED_MULT,
  OFF_ROAD_BOUNDARY,
  OUT_OF_BOUNDS_BOUNDARY,
  PRE_RACE_COUNTDOWN,
  PROJECTILE_MAX_AGE,
  RACE_FINISH_DISPLAY,
  RACE_LAP_COUNT,
  RACE_MAX_PLAYERS,
  RACE_SERVER_TICK_INTERVAL,
  RACE_SNAPSHOT_INTERVAL,
  RACE_TIME_LIMIT,
  SHELL_RADIUS,
  SHELL_SPEED,
  SHRUNK_SPEED_PENALTY,
  SPIN_DURATION,
  STAR_DURATION,
  STAR_SPEED_BONUS,
  CAR_VARIANT_COLORS,
  sanitizeName,
  plainVec3,
  vec3Zero,
  vec3Distance2D,
  // New constants
  ROCKET_START_WINDOW,
  ROCKET_START_PERFECT_SPEED,
  ROCKET_START_PERFECT_DURATION,
  ROCKET_START_GOOD_SPEED,
  ROCKET_START_GOOD_DURATION,
  ROCKET_START_OK_SPEED,
  ROCKET_START_OK_DURATION,
  ROCKET_START_STALL_DURATION,
  ROCKET_START_STALL_MAX_SPEED,
  HITSTOP_FRAMES,
  SLIPSTREAM_CONE_ANGLE,
  SLIPSTREAM_CONE_LENGTH,
  SLIPSTREAM_CHARGE_TICKS,
  SLIPSTREAM_BONUS,
  SLIPSTREAM_DURATION_TICKS,
  SLIPSTREAM_DECAY_TICKS,
  TURN_CURVE_EXPONENT,
  TURN_HIGH_SPEED_REDUCTION,
  COUNTER_STEER_BONUS,
  SNAP_STEERING_FRAMES,
  SNAP_STEERING_MULT,
  HIT_IMMUNITY_TICKS,
  BLUE_SHELL_GAP_THRESHOLD,
  // Types
  type RaceStats,
  type RocketStartTier,
  type DriftCharge,
  type DriftDirection,
  type DriftState,
  type HazardState,
  type ItemBoxState,
  type ItemType,
  type KartHitEvent,
  type KartInput,
  type KartJoinedEvent,
  type KartLeftEvent,
  type KartState,
  type KartStatus,
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
} from "../../racing/types.js";
import {
  getTrack,
  findNearestSegment,
  getLateralOffset,
  isOnRoad,
  isInBoostZone,
  getRespawnPosition,
} from "../../racing/track.js";

// ---------------------------------------------------------------------------
// Connection types
// ---------------------------------------------------------------------------

interface ConnParams {
  playerName: string;
  carVariant: number;
}

interface ConnState {
  playerId: string;
  playerName: string;
  carVariant: number;
  input: KartInput;
  lastInputAt: number;
  // Ready state
  ready: boolean;
  // Spectator mode
  spectator: boolean;
  // Improved turn curve — counter-steer detection
  lastSteerDirection: number;
  // Snap steering
  steerInputTicks: number;
  prevSteerSign: number;
  // Slipstream
  slipstreamTicks: number;
  slipstreamBonusTicks: number;
  // Rocket start
  accelerateHeldSince: number; // tick counter when throttle was first held during countdown; -1 if not held
  rocketStartFired: boolean;
  // Hit immunity
  immunityTicks: number;
  // Drift release grace
  driftReleaseGraceTicks: number;
  driftReleaseGraceCharge: DriftCharge;
  // Hitstop pending data
  hitstopPendingSpeed: number;
  hitstopPendingDrift: boolean;
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
  carVariant: number,
  position: Vec3,
  heading: number,
): KartState {
  return {
    id,
    name,
    carVariant,
    position: plainVec3(position),
    heading,
    speed: 0,
    velocity: vec3Zero(),
    driftState: defaultDrift(),
    lap: 0,
    checkpoint: 0,
    currentItem: null,
    itemCharges: 0,
    status: "normal",
    statusTimer: 0,
    raceProgress: 0,
    finishTime: null,
    finishPosition: null,
    boostTimer: 0,
    boostSpeed: 0,
    slipstreamActive: false,
    slipstreamTicks: 0,
    hitstopTicks: 0,
    rocketStartTier: "none",
  };
}

/** Generate initial item boxes from the track definition */
function generateItemBoxes(): ItemBoxState[] {
  const track = getTrack();
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

/** Reset all karts to grid positions for race start */
function resetForRaceStart(c: any): void {
  const track = getTrack();
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
    kart.finishTime = null;
    kart.finishPosition = null;
    kart.boostTimer = 0;
    kart.boostSpeed = 0;
    kart.slipstreamActive = false;
    kart.slipstreamTicks = 0;
    kart.hitstopTicks = 0;
    kart.rocketStartTier = "none";
  }
  // Reset items on track
  c.state.projectiles = [];
  c.state.hazards = [];
  c.state.itemBoxes = generateItemBoxes();
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
    cs.accelerateHeldSince = -1;
    cs.rocketStartFired = false;
    cs.immunityTicks = 0;
    cs.steerInputTicks = 0;
    cs.prevSteerSign = 0;
    cs.lastSteerDirection = 0;
    cs.driftReleaseGraceTicks = 0;
    cs.driftReleaseGraceCharge = 0;
    cs.hitstopPendingSpeed = 0;
    cs.hitstopPendingDrift = false;
  }
}

/** Pick a random item based on improved rubber-banding (positionRatio-based) */
function rollItem(
  state: RaceRoomState,
  kartId: string,
): { item: ItemType; charges: number } {
  const positions = state.positions;
  const karts = Object.values(state.players) as KartState[];
  const activeKarts = karts.filter((k) => k.finishTime === null);

  if (activeKarts.length <= 1) {
    // Solo / only player — default to old behavior with pos 0
    return rollItemLegacy(0);
  }

  const posIdx = positions.indexOf(kartId);
  const positionRatio = activeKarts.length > 1
    ? Math.max(0, posIdx) / (activeKarts.length - 1)
    : 0; // 0 = leader, 1 = last

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

/** Legacy item roll (fallback, position-index based) */
function rollItemLegacy(positionIndex: number): { item: ItemType; charges: number } {
  const clampedPos = Math.min(positionIndex, 3) as 0 | 1 | 2 | 3;
  const entries = Object.entries(ITEM_PROBABILITIES) as [ItemType, [number, number, number, number]][];
  let totalWeight = 0;
  for (const [, weights] of entries) {
    totalWeight += weights[clampedPos];
  }
  let roll = Math.random() * totalWeight;
  for (const [item, weights] of entries) {
    roll -= weights[clampedPos];
    if (roll <= 0) {
      const charges = item === "triMushroom" ? 3 : 1;
      return { item, charges };
    }
  }
  return { item: "greenShell", charges: 1 };
}

// ---------------------------------------------------------------------------
// Lobby notification helper (fire-and-forget)
// ---------------------------------------------------------------------------

async function notifyLobby(
  c: any,
  roomId: string,
  patch: { playerCount: number; status: "waiting" | "playing" } | null,
): Promise<void> {
  try {
    const lobbyActor = c.getActor({ name: "lobby", key: ["main"] });
    if (patch) {
      await lobbyActor.updateRoom(roomId, patch);
    } else {
      await lobbyActor.removeRoom(roomId);
    }
  } catch (e) {
    // Best-effort; lobby sweep will clean up if this fails
  }
}

async function ensureLobbyRegistration(c: any): Promise<void> {
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

  // Need >= 2 players AND all ready, OR auto-start after 30s check (handled in phaseTick)
  // In dev/solo mode (>= 1 player): auto-ready handled in onConnect
  if (nonSpectators >= 1 && readyCount === nonSpectators) {
    state.phase = "countdown";
    state.phaseStartedAt = Date.now();
    state.raceTimer = 0;
    resetForRaceStart(c);
    c.broadcast("phaseChanged", {
      phase: state.phase,
      raceTimer: state.raceTimer,
    });
  }
}

// ---------------------------------------------------------------------------
// Actor definition
// ---------------------------------------------------------------------------

export const raceRoom = actor({
  createState: (c: any): RaceRoomState => ({
    id: c.key?.[0] ?? `race_${Date.now().toString(36)}`,
    name: "Neon Circuit",
    players: {},
    projectiles: [],
    hazards: [],
    itemBoxes: generateItemBoxes(),
    phase: "waiting" as RacePhase,
    lapCount: RACE_LAP_COUNT,
    raceTimer: 0,
    maxPlayers: RACE_MAX_PLAYERS,
    trackId: "neon-circuit",
    createdAt: Date.now(),
    phaseStartedAt: Date.now(),
    positions: [],
    finishedCount: 0,
    readyPlayers: [],
    rematchVotes: {},
    stats: {},
  }),

  createConnState: (c: any, params: ConnParams): ConnState => {
    const state = c.state as RaceRoomState;
    const playerCount = Object.keys(state.players).length;

    // Spectator mode: if race is already in progress and room has players
    const isSpectator =
      state.phase !== "waiting" && playerCount > 0 && playerCount >= RACE_MAX_PLAYERS;

    if (!isSpectator && playerCount >= RACE_MAX_PLAYERS) {
      throw new Error("Room is full");
    }

    const playerId = `k_${uid()}`;
    return {
      playerId,
      playerName: sanitizeName(params.playerName),
      carVariant: Math.max(0, Math.min(3, Math.floor(Number(params.carVariant) || 0))),
      input: { steering: 0, throttle: false, brake: false, drift: false, useItem: false },
      lastInputAt: 0,
      ready: false,
      spectator: isSpectator,
      lastSteerDirection: 0,
      steerInputTicks: 0,
      prevSteerSign: 0,
      slipstreamTicks: 0,
      slipstreamBonusTicks: 0,
      accelerateHeldSince: -1,
      rocketStartFired: false,
      immunityTicks: 0,
      driftReleaseGraceTicks: 0,
      driftReleaseGraceCharge: 0,
      hitstopPendingSpeed: 0,
      hitstopPendingDrift: false,
    };
  },

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
    const { playerId, playerName, carVariant } = cs;
    const state = c.state as RaceRoomState;

    // Spectators don't get a kart
    if (cs.spectator) {
      return;
    }

    const existingCount = Object.keys(state.players).length;
    if (existingCount >= RACE_MAX_PLAYERS) {
      conn.close?.();
      return;
    }

    const track = getTrack();
    const gridPos = track.startPositions[existingCount] ?? track.startPositions[0];

    const kart = createKart(
      playerId,
      playerName,
      carVariant,
      gridPos,
      track.startHeading,
    );

    state.players[playerId] = kart;
    c.broadcast("kartJoined", { kart });

    const playerCount = Object.keys(state.players).length;

    if (playerCount === 1) {
      ensureLobbyRegistration(c);
    }

    // Dev/solo mode: auto-ready after 3 seconds (handled via setTimeout)
    if (playerCount >= 1 && state.phase === "waiting") {
      // Auto-ready for solo/dev mode after 3 seconds
      setTimeout(() => {
        if (conn.state && !conn.state.ready && !conn.state.spectator) {
          const currentState = c.state as RaceRoomState;
          if (currentState.phase === "waiting") {
            conn.state.ready = true;
            const total = getNonSpectatorCount(c);
            const readyCount = getReadyCount(c);
            c.broadcast("readyStateChanged", {
              playerId: conn.state.playerId,
              ready: true,
              readyCount,
              totalCount: total,
            });
            tryStartCountdown(c);
          }
        }
      }, 3000);
    }

    notifyLobby(c, state.id, {
      playerCount,
      status: playerCount >= 2 ? "playing" : "waiting",
    });
  },

  onDisconnect: (c: any, conn: any) => {
    const cs = conn.state as ConnState;
    const { playerId, playerName } = cs;

    // Spectators just leave
    if (cs.spectator) return;

    if (!c.state.players[playerId]) return;

    delete c.state.players[playerId];
    c.broadcast("kartLeft", { kartId: playerId, kartName: playerName });

    // Remove any projectiles/hazards owned by this player
    c.state.projectiles = (c.state.projectiles as ProjectileState[]).filter(
      (p) => p.ownerId !== playerId,
    );
    c.state.hazards = (c.state.hazards as HazardState[]).filter(
      (h) => h.ownerId !== playerId,
    );

    // Clean up stats and rematch votes
    delete c.state.stats[playerId];
    delete c.state.rematchVotes[playerId];

    const remaining = Object.values(c.state.players) as KartState[];

    if (
      remaining.length < 2 &&
      c.state.phase !== "waiting" &&
      c.state.phase !== "finished"
    ) {
      // Forfeit — remaining player wins
      c.state.phase = "finished";
      c.state.phaseStartedAt = Date.now();

      const positions = remaining.map((k) => k.id);
      const finishTimes: Record<string, number | null> = {};
      for (const k of remaining) {
        finishTimes[k.id] = k.finishTime;
      }

      c.broadcast("raceFinished", {
        positions,
        finishTimes,
        stats: c.state.stats,
      });
      c.broadcast("phaseChanged", {
        phase: "finished",
        raceTimer: c.state.raceTimer,
      });
      notifyLobby(c, c.state.id, null);
    } else if (remaining.length === 0) {
      notifyLobby(c, c.state.id, null);
    } else {
      notifyLobby(c, c.state.id, {
        playerCount: remaining.length,
        status: c.state.phase === "waiting" ? "waiting" : "playing",
      });
    }
  },

  // -----------------------------------------------------------------------
  // Server tick loop
  // -----------------------------------------------------------------------

  run: async (c: any) => {
    let lastSnapshot = 0;
    let tickCounter = 0;
    let lastTickTime = Date.now();
    let nextTickTarget = lastTickTime + RACE_SERVER_TICK_INTERVAL;
    let emptyAt: number | null = null;
    const EMPTY_TIMEOUT = 10_000;
    // Auto-start timer for waiting phase (30s with 2+ players)
    let waitingAutoStartAt: number | null = null;

    while (!c.aborted) {
      const now = Date.now();
      const dtMs = Math.min(now - lastTickTime, 50);
      const dt = dtMs / RACE_SERVER_TICK_INTERVAL;
      lastTickTime = now;

      // Empty room auto-shutdown
      const connCount = c.conns?.size ?? 0;
      if (connCount === 0) {
        if (!emptyAt) emptyAt = now;
        if (c.state.phase === "finished" || now - emptyAt > EMPTY_TIMEOUT) {
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
              if (!cs.spectator) cs.ready = true;
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

      // Physics simulation when racing
      if (state.phase === "racing") {
        const track = getTrack();
        kartPhysicsTick(c, dt, now, track, tickCounter);
        slipstreamTick(c, track);
        kartCollisionTick(c, dt);
        projectileTick(c, dt, now, track);
        hazardTick(c, track);
        itemBoxTick(c, now, track);
        checkpointTick(c, track);
        positionTick(c, track);
      }

      // Broadcast snapshot at 20Hz
      if (
        state.phase === "racing" &&
        now - lastSnapshot >= RACE_SNAPSHOT_INTERVAL
      ) {
        lastSnapshot += RACE_SNAPSHOT_INTERVAL;
        broadcastSnapshot(c, tickCounter);
      }

      tickCounter++;
      nextTickTarget += RACE_SERVER_TICK_INTERVAL;
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
          lapCount: s.lapCount,
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

      const now = Date.now();
      if (now - connState.lastInputAt < 30) return;
      connState.lastInputAt = now;

      // Validate input fields
      const steering = Number(input.steering);
      if (!Number.isFinite(steering)) return;

      connState.input = {
        steering: Math.max(-1, Math.min(1, steering)),
        throttle: Boolean(input.throttle),
        brake: Boolean(input.brake),
        drift: Boolean(input.drift),
        useItem: Boolean(input.useItem),
      };
    },

    useItem: (c: any): void => {
      const connState = c.conn?.state as ConnState | undefined;
      if (!connState) return;
      if (connState.spectator) return;
      if (c.state.phase !== "racing") return;

      const kart = c.state.players[connState.playerId] as KartState | undefined;
      if (!kart || !kart.currentItem) return;

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

      // Record vote
      state.rematchVotes[connState.playerId] = true;

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

      c.broadcast("rematchVote", {
        votes: { ...state.rematchVotes },
        voteCount,
        needed,
      });

      // If all connected players voted yes, reset to waiting
      if (voteCount >= needed && needed > 0) {
        state.phase = "waiting";
        state.phaseStartedAt = Date.now();
        state.raceTimer = 0;
        state.rematchVotes = {};
        state.stats = {};

        // Reset ready state for all connections
        for (const conn of c.conns.values()) {
          const cs = conn.state as ConnState;
          cs.ready = false;
        }

        c.broadcast("phaseChanged", {
          phase: "waiting",
          raceTimer: 0,
        });

        c.broadcast("raceToast", {
          text: "Rematch! Waiting for players to ready up...",
          color: "#44AAFF",
        });
      }
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
      if (cs.accelerateHeldSince === -1) {
        cs.accelerateHeldSince = tickCounter;
      }
    } else {
      // Released throttle during countdown — note the release
      // (accelerateHeldSince stays set so we know they pressed and released)
      // No action here — the evaluation happens on phase transition
    }
  }
}

// ---------------------------------------------------------------------------
// Rocket start — evaluate on GO
// ---------------------------------------------------------------------------

function evaluateRocketStarts(c: any, goTick: number): void {
  const state = c.state as RaceRoomState;

  for (const conn of c.conns.values()) {
    const cs = conn.state as ConnState;
    if (cs.spectator || cs.rocketStartFired) continue;

    cs.rocketStartFired = true;

    const kart = state.players[cs.playerId] as KartState | undefined;
    if (!kart) continue;

    // If never pressed throttle during countdown, no rocket start
    if (cs.accelerateHeldSince === -1) {
      kart.rocketStartTier = "none";
      continue;
    }

    // If throttle was held continuously through GO (never released)
    if (cs.input.throttle && cs.accelerateHeldSince < goTick - 1) {
      // Stall penalty: held throttle through the entire countdown
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

    // Player released and re-pressed (or is pressing now at GO)
    // Evaluate timing: how close their current press is to the GO tick
    const tickDiff = Math.abs(goTick - cs.accelerateHeldSince);
    // If they released and are now pressing again, use current tick as reference
    const effectiveDiff = cs.input.throttle ? 0 : tickDiff;
    const finalDiff = Math.min(tickDiff, effectiveDiff || tickDiff);

    let tier: RocketStartTier;
    let boostSpeed: number;
    let boostDuration: number;

    if (finalDiff <= 2) {
      tier = "perfect";
      boostSpeed = ROCKET_START_PERFECT_SPEED;
      boostDuration = ROCKET_START_PERFECT_DURATION;
    } else if (finalDiff <= 4) {
      tier = "good";
      boostSpeed = ROCKET_START_GOOD_SPEED;
      boostDuration = ROCKET_START_GOOD_DURATION;
    } else if (finalDiff <= ROCKET_START_WINDOW) {
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
      // Hit all other karts
      const karts = Object.values(state.players) as KartState[];
      for (const other of karts) {
        if (other.id === kart.id) continue;
        if (other.status === "starred") continue; // Star grants immunity
        other.status = "shrunk";
        other.statusTimer = LIGHTNING_SHRINK_DURATION;
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
      y: 0.3,
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
      y: 0.15,
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
  connState: ConnState | null,
  speedMult: number,
  byKartId: string | null,
  itemType: ItemType | "collision",
): void {
  const state = c.state as RaceRoomState;

  // Set hitstop frames — freeze the kart briefly before applying the spin
  kart.hitstopTicks = HITSTOP_FRAMES;

  // Store pending hit data on the connection state if available
  if (connState) {
    connState.hitstopPendingSpeed = speedMult;
    connState.hitstopPendingDrift = true;
  } else {
    // No connState (offline player?) — apply immediately without hitstop
    kart.status = "spinning";
    kart.statusTimer = SPIN_DURATION;
    kart.speed *= speedMult;
    kart.driftState = defaultDrift();
  }

  // Track hit stats
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

      // Check time limit
      const timeExpired = state.raceTimer >= RACE_TIME_LIMIT;

      if (allFinished || timeExpired) {
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

/** Compute slipstream speed bonus for a kart (called in kartPhysicsTick) */
function getSlipstreamBonus(cs: ConnState): number {
  if (cs.slipstreamBonusTicks <= 0) return 0;

  // Full bonus for most of the duration, decay in last SLIPSTREAM_DECAY_TICKS
  if (cs.slipstreamBonusTicks > SLIPSTREAM_DECAY_TICKS) {
    return SLIPSTREAM_BONUS;
  }
  // Linear decay
  return SLIPSTREAM_BONUS * (cs.slipstreamBonusTicks / SLIPSTREAM_DECAY_TICKS);
}

// ---------------------------------------------------------------------------
// Kart physics tick
// ---------------------------------------------------------------------------

function kartPhysicsTick(
  c: any,
  dt: number,
  now: number,
  track: ReturnType<typeof getTrack>,
  tickCounter: number,
): void {
  const state = c.state as RaceRoomState;
  const segments = track.segments;

  for (const conn of c.conns.values()) {
    const cs = conn.state as ConnState;
    if (cs.spectator) continue;

    const kart = state.players[cs.playerId] as KartState | undefined;
    if (!kart) continue;

    // Already finished — freeze kart
    if (kart.finishTime !== null) continue;

    // --- Hitstop: freeze kart for N ticks on impact ---
    if (kart.hitstopTicks > 0) {
      kart.hitstopTicks--;
      if (kart.hitstopTicks <= 0) {
        // Hitstop expired — now apply the spin/knockback
        kart.status = "spinning";
        kart.statusTimer = SPIN_DURATION;
        kart.speed *= cs.hitstopPendingSpeed;
        if (cs.hitstopPendingDrift) {
          kart.driftState = defaultDrift();
        }
        cs.hitstopPendingSpeed = 0;
        cs.hitstopPendingDrift = false;
      }
      // Skip all physics while in hitstop
      continue;
    }

    // --- Hit immunity tick ---
    if (cs.immunityTicks > 0) {
      cs.immunityTicks--;
    }

    // --- Status effect handling ---
    if (kart.status === "spinning" || kart.status === "falling") {
      kart.statusTimer -= dt * RACE_SERVER_TICK_INTERVAL;
      kart.speed *= 0.92; // Rapid deceleration while spinning
      if (kart.statusTimer <= 0) {
        // Respawn if falling, otherwise just recover
        if (kart.status === "falling") {
          const segIdx = findNearestSegment(segments, kart.position.x, kart.position.z);
          const respawn = getRespawnPosition(segments, segIdx);
          kart.position = plainVec3(respawn.position);
          kart.heading = respawn.heading;
          kart.speed = 0;
        }
        kart.status = "normal";
        kart.statusTimer = 0;
        // Grant hit immunity after recovering from spin
        cs.immunityTicks = HIT_IMMUNITY_TICKS;
      }
      // Update velocity for snapshot
      kart.velocity = {
        x: Math.sin(kart.heading) * kart.speed,
        y: 0,
        z: Math.cos(kart.heading) * kart.speed,
      };
      continue;
    }

    // --- Starred timer ---
    if (kart.status === "starred") {
      kart.statusTimer -= dt * RACE_SERVER_TICK_INTERVAL;
      if (kart.statusTimer <= 0) {
        kart.status = "normal";
        kart.statusTimer = 0;
      }
    }

    // --- Shrunk timer ---
    if (kart.status === "shrunk") {
      kart.statusTimer -= dt * RACE_SERVER_TICK_INTERVAL;
      if (kart.statusTimer <= 0) {
        kart.status = "normal";
        kart.statusTimer = 0;
      }
    }

    // --- Read input ---
    const input = cs.input;

    // --- Handle useItem from input flag ---
    if (input.useItem && kart.currentItem) {
      executeItemUse(c, kart, cs.playerId);
      input.useItem = false;
    }

    // --- Acceleration / Braking ---
    const shrunkMult = kart.status === "shrunk" ? SHRUNK_SPEED_PENALTY : 1.0;

    // Rocket start stall penalty: cap speed during stall
    const isStalling = kart.rocketStartTier === "stall" && kart.boostTimer > 0;

    if (input.throttle) {
      kart.speed += KART_ACCELERATION * dt * shrunkMult;
    }

    if (input.brake) {
      if (kart.speed > 0) {
        // Braking (only when not drifting)
        if (!kart.driftState.active) {
          kart.speed -= KART_BRAKE_FORCE * dt;
          if (kart.speed < 0) kart.speed = 0;
        }
      } else {
        // Reverse
        kart.speed -= KART_REVERSE_ACCEL * dt;
      }
    }

    // --- Drag ---
    kart.speed *= 1 - KART_DRAG * dt;

    // --- Surface check ---
    const segIdx = findNearestSegment(segments, kart.position.x, kart.position.z);
    const onRoad = isOnRoad(segments, segIdx, kart.position.x, kart.position.z);

    if (!onRoad) {
      // Check how far off-road
      const seg = segments[segIdx];
      const hw =
        Math.sqrt(
          (seg.right.x - seg.left.x) ** 2 + (seg.right.z - seg.left.z) ** 2,
        ) / 2;
      const lateralDist = Math.abs(getLateralOffset(segments, segIdx, kart.position.x, kart.position.z));

      if (lateralDist > hw * OUT_OF_BOUNDS_BOUNDARY) {
        // Way off-track — trigger fall/respawn
        kart.status = "falling";
        kart.statusTimer = SPIN_DURATION;
        kart.speed = 0;
        kart.driftState = defaultDrift();
        continue;
      }

      // Off-road slowdown (extra drag per tick, scaled by dt)
      kart.speed *= 1 - (1 - OFF_ROAD_SPEED_MULT) * 0.05 * dt;
    }

    // --- Boost zone check ---
    if (isInBoostZone(track.boostZones, segIdx)) {
      if (kart.boostTimer <= 0 || kart.boostSpeed < BOOST_PAD_SPEED) {
        kart.boostSpeed = BOOST_PAD_SPEED;
        kart.boostTimer = BOOST_PAD_DURATION;
      }
    }

    // --- Active boost timer ---
    if (kart.boostTimer > 0) {
      kart.boostTimer -= dt * RACE_SERVER_TICK_INTERVAL;
      if (kart.boostTimer <= 0) {
        kart.boostTimer = 0;
        kart.boostSpeed = 0;
        // Clear stall tier when stall timer expires
        if (kart.rocketStartTier === "stall") {
          kart.rocketStartTier = "none";
        }
      }
    }

    // --- Speed cap ---
    const slipBonus = getSlipstreamBonus(cs);
    let maxSpeed = (KART_MAX_SPEED + kart.boostSpeed + slipBonus) * shrunkMult;

    // Apply stall penalty
    if (isStalling) {
      maxSpeed = Math.min(maxSpeed, ROCKET_START_STALL_MAX_SPEED);
    }

    const maxReverse = KART_REVERSE_MAX * shrunkMult;
    if (kart.speed > maxSpeed) kart.speed = maxSpeed;
    if (kart.speed < -maxReverse) kart.speed = -maxReverse;

    // --- Track top speed stat ---
    if (state.stats[cs.playerId]) {
      if (Math.abs(kart.speed) > state.stats[cs.playerId].topSpeed) {
        state.stats[cs.playerId].topSpeed = Math.abs(kart.speed);
      }
    }

    // --- Improved Turn Curve ---
    const speedRatio = Math.abs(kart.speed) / KART_MAX_SPEED;
    let turnRate = KART_TURN_RATE * (1 - TURN_HIGH_SPEED_REDUCTION * Math.pow(speedRatio, TURN_CURVE_EXPONENT));

    if (kart.driftState.active) {
      turnRate *= DRIFT_TURN_MULTIPLIER;
    }

    // --- Counter-steer bonus ---
    const currentSteerDir = input.steering > 0.01 ? 1 : (input.steering < -0.01 ? -1 : 0);
    // Angular velocity direction: if heading is decreasing, kart is turning right (positive steer)
    // We use lastSteerDirection as a proxy for the current angular velocity direction
    if (currentSteerDir !== 0 && cs.lastSteerDirection !== 0 && currentSteerDir !== cs.lastSteerDirection) {
      turnRate *= COUNTER_STEER_BONUS;
    }

    // --- Snap Steering ---
    const prevSign = cs.prevSteerSign;
    if (currentSteerDir !== 0 && (prevSign === 0 || currentSteerDir !== prevSign)) {
      // New steering input detected — reset snap counter
      cs.steerInputTicks = 0;
    }

    if (currentSteerDir !== 0 && cs.steerInputTicks < SNAP_STEERING_FRAMES) {
      // Apply snap steering multiplier, decaying linearly from SNAP_STEERING_MULT to 1.0
      const snapProgress = cs.steerInputTicks / SNAP_STEERING_FRAMES;
      const snapMult = SNAP_STEERING_MULT + (1.0 - SNAP_STEERING_MULT) * snapProgress;
      turnRate *= snapMult;
      cs.steerInputTicks++;
    } else if (currentSteerDir !== 0) {
      cs.steerInputTicks++;
    }

    cs.prevSteerSign = currentSteerDir;
    if (currentSteerDir !== 0) {
      cs.lastSteerDirection = currentSteerDir;
    }

    const steerAmount = input.steering * turnRate * dt;
    kart.heading -= steerAmount;

    // --- Drift mechanics ---
    const drift = kart.driftState;

    if (
      !drift.active &&
      input.drift &&
      Math.abs(kart.speed) > MIN_DRIFT_SPEED &&
      Math.abs(input.steering) > 0.3
    ) {
      // Start drift
      drift.active = true;
      drift.direction = (input.steering > 0 ? 1 : -1) as DriftDirection;
      drift.charge = 0;
      drift.timer = 0;
      // Reset drift release grace
      cs.driftReleaseGraceTicks = 0;
      cs.driftReleaseGraceCharge = 0;
    }

    if (drift.active) {
      if (input.drift && Math.abs(kart.speed) > MIN_DRIFT_SPEED * 0.5) {
        // Continue drifting — increment charge timer
        drift.timer += 1;

        // Check charge thresholds and broadcast tier events
        const prevCharge = drift.charge;

        if (drift.timer >= DRIFT_CHARGE_THRESHOLDS[2] && drift.charge < 3) {
          drift.charge = 3 as DriftCharge;
        } else if (drift.timer >= DRIFT_CHARGE_THRESHOLDS[1] && drift.charge < 2) {
          drift.charge = 2 as DriftCharge;
        } else if (drift.timer >= DRIFT_CHARGE_THRESHOLDS[0] && drift.charge < 1) {
          drift.charge = 1 as DriftCharge;
        }

        // Broadcast drift tier events on threshold crossing
        if (drift.charge > prevCharge) {
          c.broadcast("driftTierReached", {
            kartId: kart.id,
            tier: drift.charge,
          });
          // Track the latest tier reached (for grace window)
          cs.driftReleaseGraceTicks = 4; // Reset grace ticks on new tier
          cs.driftReleaseGraceCharge = drift.charge;
        } else if (cs.driftReleaseGraceTicks > 0) {
          cs.driftReleaseGraceTicks--;
        }
      } else {
        // Release drift — apply boost based on charge
        let chargeToUse = drift.charge;

        // Drift Release Grace Window: if within 4 ticks of reaching a new tier, grant that tier
        if (cs.driftReleaseGraceTicks > 0 && cs.driftReleaseGraceCharge > drift.charge) {
          chargeToUse = cs.driftReleaseGraceCharge;
        }

        if (chargeToUse > 0) {
          const chargeIdx = (chargeToUse - 1) as 0 | 1 | 2;
          kart.boostSpeed = DRIFT_BOOST_SPEEDS[chargeIdx];
          kart.boostTimer = DRIFT_BOOST_DURATIONS[chargeIdx];

          // Track drift boost stat
          if (state.stats[cs.playerId]) {
            state.stats[cs.playerId].driftBoosts++;
          }
        }

        // Reset drift
        drift.active = false;
        drift.direction = 0;
        drift.charge = 0;
        drift.timer = 0;
        cs.driftReleaseGraceTicks = 0;
        cs.driftReleaseGraceCharge = 0;
      }
    }

    // --- Elevation-Aware Physics ---
    const seg = segments[segIdx];
    const segY = seg.center.y;

    // --- Position integration ---
    const vx = Math.sin(kart.heading) * kart.speed;
    const vz = Math.cos(kart.heading) * kart.speed;

    kart.position.x += vx * dt;
    kart.position.z += vz * dt;
    kart.position.y = segY + 0.5; // Elevation-aware: use segment center Y + 0.5

    // --- Slope force: apply acceleration based on segment's forward Y component ---
    // seg.forward.y represents the slope; downhill (negative forward.y when going forward) = faster
    // We add slope force along the kart's heading direction
    const slopeForce = -seg.forward.y * 0.02 * dt; // Tuning factor for slope effect
    kart.speed += slopeForce;

    // --- Update velocity for snapshot interpolation ---
    kart.velocity = { x: vx, y: 0, z: vz };
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

      // Push apart
      const overlap = (minDist - dist) / 2;
      a.position.x -= nx * overlap;
      a.position.z -= nz * overlap;
      b.position.x += nx * overlap;
      b.position.z += nz * overlap;

      // Apply push force to speeds (along collision normal vs heading)
      const aForwardX = Math.sin(a.heading);
      const aForwardZ = Math.cos(a.heading);
      const bForwardX = Math.sin(b.heading);
      const bForwardZ = Math.cos(b.heading);

      const aDot = aForwardX * nx + aForwardZ * nz;
      const bDot = bForwardX * (-nx) + bForwardZ * (-nz);

      a.speed -= aDot * KART_COLLISION_PUSH;
      b.speed -= bDot * KART_COLLISION_PUSH;

      // Star collision — starred kart spins the other
      if (a.status === "starred" && b.status !== "starred") {
        if (b.status !== "spinning" && b.status !== "falling") {
          const bConn = findConnStateForPlayer(c, b.id);
          // Check hit immunity
          if (!bConn || bConn.immunityTicks <= 0) {
            applyHitToKart(c, b, bConn, 0.3, a.id, "collision");
          }
        }
      } else if (b.status === "starred" && a.status !== "starred") {
        if (a.status !== "spinning" && a.status !== "falling") {
          const aConn = findConnStateForPlayer(c, a.id);
          if (!aConn || aConn.immunityTicks <= 0) {
            applyHitToKart(c, a, aConn, 0.3, b.id, "collision");
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Projectile tick (shells)
// ---------------------------------------------------------------------------

function projectileTick(c: any, dt: number, now: number, track: ReturnType<typeof getTrack>): void {
  const state = c.state as RaceRoomState;
  const projectiles = state.projectiles as ProjectileState[];
  const segments = track.segments;
  const toRemove: Set<string> = new Set();

  for (const proj of projectiles) {
    // Age check
    proj.age += dt * RACE_SERVER_TICK_INTERVAL;
    if (proj.age >= PROJECTILE_MAX_AGE) {
      toRemove.add(proj.id);
      continue;
    }

    // Red shell & blue shell homing
    if ((proj.type === "redShell" || proj.type === "blueShell") && proj.targetId) {
      // For blue shell, dynamically retarget 1st place
      let targetId = proj.targetId;
      if (proj.type === "blueShell" && state.positions.length > 0) {
        targetId = state.positions[0];
        proj.targetId = targetId;
      }

      const target = state.players[targetId] as KartState | undefined;
      if (target && target.finishTime === null) {
        const dx = target.position.x - proj.position.x;
        const dz = target.position.z - proj.position.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist > 0.1) {
          const nx = dx / dist;
          const nz = dz / dist;
          // Steer toward target
          const currentSpeed = Math.sqrt(
            proj.velocity.x * proj.velocity.x + proj.velocity.z * proj.velocity.z,
          );
          const speed = Math.max(currentSpeed, SHELL_SPEED);
          proj.velocity.x = nx * speed;
          proj.velocity.z = nz * speed;
        }
      }
    }

    // Move projectile
    proj.position.x += proj.velocity.x * dt;
    proj.position.z += proj.velocity.z * dt;

    // Track boundary bounce/destroy
    const segIdx = findNearestSegment(segments, proj.position.x, proj.position.z);
    const onRoad = isOnRoad(segments, segIdx, proj.position.x, proj.position.z);

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
      const kartConn = findConnStateForPlayer(c, kid);
      if (kartConn && kartConn.immunityTicks > 0) continue;

      const hitDist = vec3Distance2D(proj.position, kart.position);
      if (hitDist < SHELL_RADIUS + KART_RADIUS) {
        applyHitToKart(c, kart, kartConn, 0.3, proj.ownerId, proj.type);
        toRemove.add(proj.id);
        break;
      }
    }
  }

  // Remove destroyed projectiles
  if (toRemove.size > 0) {
    state.projectiles = projectiles.filter((p) => !toRemove.has(p.id));
  }
}

// ---------------------------------------------------------------------------
// Hazard tick (bananas)
// ---------------------------------------------------------------------------

function hazardTick(c: any, track: ReturnType<typeof getTrack>): void {
  const state = c.state as RaceRoomState;
  const hazards = state.hazards as HazardState[];
  const toRemove: Set<string> = new Set();

  const kartIds = Object.keys(state.players);

  for (const hazard of hazards) {
    for (const kid of kartIds) {
      const kart = state.players[kid] as KartState;
      if (kart.finishTime !== null) continue;
      if (kart.status === "starred") continue; // Star grants immunity
      if (kart.status === "spinning" || kart.status === "falling") continue;
      if (kart.hitstopTicks > 0) continue; // Already in hitstop

      // Check hit immunity
      const kartConn = findConnStateForPlayer(c, kid);
      if (kartConn && kartConn.immunityTicks > 0) continue;

      // Brief owner immunity (based on distance — owner just dropped it)
      if (kart.id === hazard.ownerId) {
        const dropDist = vec3Distance2D(kart.position, hazard.position);
        if (dropDist < KART_RADIUS * 3) continue;
      }

      const hitDist = vec3Distance2D(hazard.position, kart.position);
      if (hitDist < BANANA_RADIUS + KART_RADIUS) {
        applyHitToKart(c, kart, kartConn, 0.5, hazard.ownerId, "banana");
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

  const kartIds = Object.keys(state.players);
  for (const kid of kartIds) {
    const kart = state.players[kid] as KartState;
    if (kart.finishTime !== null) continue;

    const segIdx = findNearestSegment(segments, kart.position.x, kart.position.z);

    // Check if kart is near their next checkpoint
    const nextCp = kart.checkpoint;
    if (nextCp >= checkpoints.length) {
      // All checkpoints passed — check if crossing start/finish (segment 0 region)
      if (segIdx < totalSegments * 0.1) {
        // Crossed start/finish — complete lap
        kart.lap += 1;
        kart.checkpoint = 0;

        // Track best lap time in stats
        const stats = state.stats[kid];
        if (stats) {
          const lapTime = state.raceTimer - ((stats as any).lapStartTime || 0);
          if (kart.lap > 1 && (stats.bestLapTime === null || lapTime < stats.bestLapTime)) {
            stats.bestLapTime = lapTime;
          }
          (stats as any).lapStartTime = state.raceTimer;
        }

        c.broadcast("lapCompleted", {
          kartId: kart.id,
          lap: kart.lap,
          raceTime: state.raceTimer,
        });

        // Check if race finished for this kart
        if (kart.lap >= RACE_LAP_COUNT) {
          state.finishedCount += 1;
          kart.finishPosition = state.finishedCount;
          kart.finishTime = state.raceTimer;
          kart.speed = 0;
          kart.velocity = vec3Zero();
        }
      }
      continue;
    }

    const cpSegIdx = checkpoints[nextCp].segmentIndex;
    // Check if kart segment is within range of the checkpoint segment
    const segDiff = Math.abs(segIdx - cpSegIdx);
    const wrappedDiff = Math.min(segDiff, totalSegments - segDiff);

    if (wrappedDiff < totalSegments * 0.05) {
      // Close enough — advance checkpoint
      kart.checkpoint = nextCp + 1;
    }

    // Update race progress for ranking
    kart.raceProgress = kart.lap * totalSegments + segIdx;
  }
}

// ---------------------------------------------------------------------------
// Position ranking
// ---------------------------------------------------------------------------

function positionTick(c: any, track: ReturnType<typeof getTrack>): void {
  const state = c.state as RaceRoomState;
  const kartIds = Object.keys(state.players);
  const totalSegments = track.segments.length;

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

  const karts: RaceSnapshot["karts"] = {};
  for (const id of kartIds) {
    const k = state.players[id] as KartState;
    karts[id] = {
      position: k.position,
      heading: k.heading,
      speed: k.speed,
      velocity: k.velocity,
      driftState: k.driftState,
      status: k.status,
      statusTimer: k.statusTimer,
      currentItem: k.currentItem,
      itemCharges: k.itemCharges,
      lap: k.lap,
      checkpoint: k.checkpoint,
      boostTimer: k.boostTimer,
      boostSpeed: k.boostSpeed,
      slipstreamActive: k.slipstreamActive,
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
