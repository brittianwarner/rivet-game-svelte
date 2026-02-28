/**
 * gameRoom actor — server-authoritative 1v1 marble soccer.
 *
 * Rectangular walled field, ball entity, goal detection, dash mechanic,
 * match timer with golden goal. Delta-time physics at ~60Hz.
 */

import { actor, event } from "rivetkit";
import {
  ALLOWED_ORIGINS,
  BALL_DRAG,
  BALL_MASS,
  BALL_MAX_SPEED,
  BALL_RADIUS,
  DASH_COOLDOWN,
  DASH_DURATION,
  DASH_FORCE_MULT,
  DRAG,
  FIELD_HALF_LENGTH,
  FIELD_HALF_WIDTH,
  GOAL_CELEBRATION,
  GOAL_DEPTH,
  GOAL_HALF_WIDTH,
  GOALS_TO_WIN,
  GOLDEN_GOAL_HALF_WIDTH,
  GRAVITY,
  GROUND_Y,
  INPUT_DEAD_ZONE,
  KICKOFF_FREEZE,
  MARBLE_RADIUS,
  MATCH_TIME_LIMIT,
  MAX_PLAYERS,
  MAX_SPEED,
  MOVE_FORCE,
  PRE_GAME_COUNTDOWN,
  PUSH_FORCE,
  SERVER_TICK_INTERVAL,
  SNAPSHOT_BROADCAST_INTERVAL,
  TEAM_COLORS,
  WALL_RESTITUTION_BALL,
  WALL_RESTITUTION_PLAYER,
  clampSpeed,
  plainVec3,
  sanitizeName,
  vec3Zero,
  type BallState,
  type GamePhase,
  type GameRoomState,
  type JoinStateResult,
  type PhysicsSnapshot,
  type PlayerInput,
  type PlayerState,
  type Vec3,
} from "../../game/types.js";

// ---------------------------------------------------------------------------
// Connection types
// ---------------------------------------------------------------------------

interface ConnParams {
  playerName: string;
}

interface ConnState {
  playerId: string;
  playerName: string;
  input: PlayerInput;
  dashCooldownUntil: number;
  dashStartedAt: number;
  lastInputAt: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createBall(): BallState {
  return {
    position: { x: 0, y: GROUND_Y, z: 0 },
    velocity: vec3Zero(),
    lastTouchedBy: null,
  };
}

function kickoffPositions(): { p1: { x: number; y: number; z: number }; p2: { x: number; y: number; z: number } } {
  return {
    p1: { x: 0, y: GROUND_Y, z: -7 },
    p2: { x: 0, y: GROUND_Y, z: 7 },
  };
}

function resetForKickoff(c: any): void {
  const players = Object.values(c.state.players) as PlayerState[];
  const pos = kickoffPositions();
  for (const p of players) {
    const spawn = p.team === 1 ? pos.p1 : pos.p2;
    p.position = plainVec3(spawn);
    p.velocity = vec3Zero();
  }
  c.state.ball = createBall();
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
    await lobbyActor.registerRoom(c.state.id, c.state.name);
  } catch {
    // Best-effort
  }
}

// ---------------------------------------------------------------------------
// Actor definition
// ---------------------------------------------------------------------------

export const gameRoom = actor({
  createState: (c: any): GameRoomState => ({
    id: c.key?.[0] ?? `room_${Date.now().toString(36)}`,
    name: "Soccer",
    players: {},
    ball: createBall(),
    scores: [0, 0] as [number, number],
    phase: "waiting" as GamePhase,
    timeRemaining: MATCH_TIME_LIMIT,
    phaseStartedAt: Date.now(),
    maxPlayers: MAX_PLAYERS,
    createdAt: Date.now(),
  }),

  createConnState: (c: any, params: ConnParams): ConnState => {
    if (Object.keys(c.state.players).length >= MAX_PLAYERS) {
      throw new Error("Room is full");
    }
    const playerId = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    return {
      playerId,
      playerName: sanitizeName(params.playerName),
      input: { tx: 0, tz: 0, active: false, dash: false },
      dashCooldownUntil: 0,
      dashStartedAt: 0,
      lastInputAt: 0,
    };
  },

  events: {
    playerJoined: event<{ player: PlayerState }>(),
    playerLeft: event<{ playerId: string; playerName: string }>(),
    physicsSnapshot: event<PhysicsSnapshot>(),
    goalScored: event<{
      scorerId: string | null;
      teamScored: 1 | 2;
      scores: [number, number];
    }>(),
    gameOver: event<{
      winnerId: string | null;
      winnerTeam: 1 | 2 | null;
      scores: [number, number];
    }>(),
    phaseChanged: event<{ phase: GamePhase; timeRemaining: number }>(),
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
    const { playerId, playerName } = conn.state as ConnState;
    const existingCount = Object.keys(c.state.players).length;
    if (existingCount >= MAX_PLAYERS) {
      conn.close?.();
      return;
    }
    const team = (existingCount === 0 ? 1 : 2) as 1 | 2;
    const pos = kickoffPositions();

    const player: PlayerState = {
      id: playerId,
      name: playerName,
      color: TEAM_COLORS[team - 1],
      team,
      position: plainVec3(team === 1 ? pos.p1 : pos.p2),
      velocity: vec3Zero(),
    };

    c.state.players[playerId] = player;
    c.broadcast("playerJoined", { player });

    const playerCount = Object.keys(c.state.players).length;

    if (playerCount === 1) {
      ensureLobbyRegistration(c);
    }

    if (playerCount === 2 && c.state.phase === "waiting") {
      c.state.phase = "countdown";
      c.state.phaseStartedAt = Date.now();
      c.state.timeRemaining = MATCH_TIME_LIMIT;
      c.state.scores = [0, 0];
      resetForKickoff(c);
      c.broadcast("phaseChanged", {
        phase: c.state.phase,
        timeRemaining: c.state.timeRemaining,
      });
    }

    notifyLobby(c, c.state.id, {
      playerCount,
      status: playerCount >= 2 ? "playing" : "waiting",
    });
  },

  onDisconnect: (c: any, conn: any) => {
    const { playerId, playerName } = conn.state as ConnState;
    if (!c.state.players[playerId]) return;

    delete c.state.players[playerId];
    c.broadcast("playerLeft", { playerId, playerName });

    const remaining = Object.values(c.state.players) as PlayerState[];
    if (
      remaining.length < 2 &&
      c.state.phase !== "waiting" &&
      c.state.phase !== "finished"
    ) {
      c.state.phase = "finished";
      const winner = remaining[0] ?? null;
      c.broadcast("gameOver", {
        winnerId: winner?.id ?? null,
        winnerTeam: winner?.team ?? null,
        scores: c.state.scores,
      });
      c.broadcast("phaseChanged", {
        phase: "finished",
        timeRemaining: c.state.timeRemaining,
      });
      notifyLobby(c, c.state.id, null);
    } else if (remaining.length === 0) {
      notifyLobby(c, c.state.id, null);
    } else {
      notifyLobby(c, c.state.id, {
        playerCount: remaining.length,
        status: "waiting",
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
    let nextTickTarget = lastTickTime + SERVER_TICK_INTERVAL;
    let emptyAt: number | null = null;
    const EMPTY_TIMEOUT = 10_000;

    while (!c.aborted) {
      const now = Date.now();
      const dtMs = Math.min(now - lastTickTime, 50);
      const dt = dtMs / SERVER_TICK_INTERVAL;
      lastTickTime = now;

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

      phaseTick(c, now, dtMs);

      const phase: GamePhase = c.state.phase;
      const physicsActive = phase === "waiting" || phase === "playing" || phase === "goldenGoal";
      if (physicsActive) {
        physicsTick(c, dt, now);
      }

      if (physicsActive && now - lastSnapshot >= SNAPSHOT_BROADCAST_INTERVAL) {
        lastSnapshot += SNAPSHOT_BROADCAST_INTERVAL;
        broadcastSnapshot(c, tickCounter++);
      }

      nextTickTarget += SERVER_TICK_INTERVAL;
      const sleepMs = Math.max(1, nextTickTarget - Date.now());
      await new Promise((r) => setTimeout(r, sleepMs));
    }
  },

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------

  actions: {
    getJoinState: (c: any): JoinStateResult => {
      const connState = c.conn?.state as ConnState | undefined;
      const s = c.state as GameRoomState;
      return {
        state: {
          id: s.id,
          name: s.name,
          players: s.players,
          ball: s.ball,
          scores: [s.scores[0], s.scores[1]] as [number, number],
          phase: s.phase,
          timeRemaining: s.timeRemaining,
          phaseStartedAt: 0,
          maxPlayers: s.maxPlayers,
          createdAt: 0,
        },
        playerId: connState?.playerId ?? "",
      };
    },

    sendInput: (c: any, input: PlayerInput): void => {
      const connState = c.conn?.state as ConnState | undefined;
      if (!connState) return;

      const now = Date.now();
      if (now - connState.lastInputAt < 30) return;
      connState.lastInputAt = now;

      const tx = Number(input.tx);
      const tz = Number(input.tz);
      if (!Number.isFinite(tx) || !Number.isFinite(tz)) return;

      const maxX = FIELD_HALF_WIDTH + GOAL_DEPTH + 5;
      const maxZ = FIELD_HALF_LENGTH + GOAL_DEPTH + 5;
      connState.input = {
        tx: Math.max(-maxX, Math.min(maxX, tx)),
        tz: Math.max(-maxZ, Math.min(maxZ, tz)),
        active: Boolean(input.active),
        dash: Boolean(input.dash),
      };
    },
  },
});

// ---------------------------------------------------------------------------
// Phase management
// ---------------------------------------------------------------------------

function phaseTick(c: any, now: number, dtMs: number): void {
  const state: GameRoomState = c.state;
  const elapsed = now - state.phaseStartedAt;

  switch (state.phase) {
    case "countdown": {
      if (elapsed >= PRE_GAME_COUNTDOWN) {
        state.phase = "playing";
        state.phaseStartedAt = now;
        c.broadcast("phaseChanged", {
          phase: "playing",
          timeRemaining: state.timeRemaining,
        });
      }
      break;
    }
    case "goalScored": {
      if (elapsed >= GOAL_CELEBRATION + KICKOFF_FREEZE) {
        const [s1, s2] = state.scores;
        if (s1 >= GOALS_TO_WIN || s2 >= GOALS_TO_WIN) {
          state.phase = "finished";
          const players = Object.values(state.players) as PlayerState[];
          const winnerTeam = s1 >= GOALS_TO_WIN ? 1 : 2;
          const winner = players.find((p) => p.team === winnerTeam) ?? null;
          c.broadcast("gameOver", {
            winnerId: winner?.id ?? null,
            winnerTeam,
            scores: state.scores,
          });
          c.broadcast("phaseChanged", {
            phase: "finished",
            timeRemaining: state.timeRemaining,
          });
          notifyLobby(c, state.id, null);
        } else {
          resetForKickoff(c);
          state.phase = "playing";
          state.phaseStartedAt = now;
          c.broadcast("phaseChanged", {
            phase: "playing",
            timeRemaining: state.timeRemaining,
          });
        }
      }
      break;
    }
    case "playing": {
      state.timeRemaining -= dtMs;
      if (state.timeRemaining <= 0) {
        state.timeRemaining = 0;
        const [s1, s2] = state.scores;
        if (s1 === s2) {
          state.phase = "goldenGoal";
          state.phaseStartedAt = now;
          c.broadcast("phaseChanged", {
            phase: "goldenGoal",
            timeRemaining: 0,
          });
        } else {
          state.phase = "finished";
          const players = Object.values(state.players) as PlayerState[];
          const winnerTeam = s1 > s2 ? 1 : 2;
          const winner = players.find((p) => p.team === winnerTeam) ?? null;
          c.broadcast("gameOver", {
            winnerId: winner?.id ?? null,
            winnerTeam,
            scores: state.scores,
          });
          c.broadcast("phaseChanged", {
            phase: "finished",
            timeRemaining: 0,
          });
          notifyLobby(c, state.id, null);
        }
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Physics simulation
// ---------------------------------------------------------------------------

function physicsTick(c: any, dt: number, now: number): void {
  const state: GameRoomState = c.state;
  const players = state.players;
  const ball = state.ball;
  const playerIds = Object.keys(players);
  if (playerIds.length === 0) return;

  const isGoldenGoal = state.phase === "goldenGoal";
  const goalHW = isGoldenGoal ? GOLDEN_GOAL_HALF_WIDTH : GOAL_HALF_WIDTH;

  // 1. Read inputs and apply forces
  for (const conn of c.conns.values()) {
    const cs = conn.state as ConnState;
    const player = players[cs.playerId];
    if (!player) continue;

    // Handle dash activation — consume flag to prevent auto-retrigger
    if (cs.input.dash && now >= cs.dashCooldownUntil) {
      cs.dashStartedAt = now;
      cs.dashCooldownUntil = now + DASH_COOLDOWN;
      cs.input.dash = false;
    }

    const isDashing = now - cs.dashStartedAt < DASH_DURATION;
    const forceMult = isDashing ? DASH_FORCE_MULT : 1.0;

    if (cs.input.active) {
      const dx = cs.input.tx - player.position.x;
      const dz = cs.input.tz - player.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);

      if (dist > INPUT_DEAD_ZONE) {
        const nx = dx / dist;
        const nz = dz / dist;
        const strength = Math.min(dist / 8, 1.0) * MOVE_FORCE * forceMult * dt;
        player.velocity.x += nx * strength;
        player.velocity.z += nz * strength;
      }
    }
  }

  // 2. Player-to-player collision
  for (let i = 0; i < playerIds.length; i++) {
    const a = players[playerIds[i]];
    for (let j = i + 1; j < playerIds.length; j++) {
      const b = players[playerIds[j]];
      resolveCollision(a, b, MARBLE_RADIUS, MARBLE_RADIUS, PUSH_FORCE);
    }
  }

  // 3. Ball-player collision (momentum-based, asymmetric mass)
  for (const id of playerIds) {
    const player = players[id];
    const dx = ball.position.x - player.position.x;
    const dz = ball.position.z - player.position.z;
    const distSq = dx * dx + dz * dz;
    const minDist = MARBLE_RADIUS + BALL_RADIUS;

    if (distSq >= minDist * minDist || distSq < 0.000001) continue;

    const dist = Math.sqrt(distSq);
    const nx = dx / dist;
    const nz = dz / dist;

    // Separate overlap
    const overlap = minDist - dist;
    const totalMass = 1.0 + BALL_MASS;
    const playerPush = overlap * (BALL_MASS / totalMass);
    const ballPush = overlap * (1.0 / totalMass);

    player.position.x -= nx * playerPush;
    player.position.z -= nz * playerPush;
    ball.position.x += nx * ballPush;
    ball.position.z += nz * ballPush;

    // Momentum-based impulse along collision normal
    const relVx = player.velocity.x - ball.velocity.x;
    const relVz = player.velocity.z - ball.velocity.z;
    const relDot = relVx * nx + relVz * nz;

    if (relDot > 0) {
      const jPlayer = (2 * BALL_MASS / totalMass) * relDot;
      const jBall = (2 * 1.0 / totalMass) * relDot;

      player.velocity.x -= nx * jPlayer;
      player.velocity.z -= nz * jPlayer;
      ball.velocity.x += nx * jBall;
      ball.velocity.z += nz * jBall;
    }

    ball.lastTouchedBy = id;
  }

  // 4. Apply drag and integrate
  for (const id of playerIds) {
    const p = players[id];
    const dragFactor = Math.pow(1 - DRAG, dt);
    p.velocity.x *= dragFactor;
    p.velocity.z *= dragFactor;
    clampSpeed(p.velocity, MAX_SPEED);
    p.velocity.y += GRAVITY * dt;
    p.position.x += p.velocity.x * dt;
    p.position.y += p.velocity.y * dt;
    p.position.z += p.velocity.z * dt;
    if (p.position.y <= GROUND_Y) {
      p.position.y = GROUND_Y;
      p.velocity.y = 0;
    }
  }

  // Ball drag + integrate
  const ballDrag = Math.pow(1 - BALL_DRAG, dt);
  ball.velocity.x *= ballDrag;
  ball.velocity.z *= ballDrag;
  clampSpeed(ball.velocity, BALL_MAX_SPEED);
  ball.velocity.y += GRAVITY * dt;
  ball.position.x += ball.velocity.x * dt;
  ball.position.y += ball.velocity.y * dt;
  ball.position.z += ball.velocity.z * dt;
  if (ball.position.y <= GROUND_Y) {
    ball.position.y = GROUND_Y;
    ball.velocity.y = 0;
  }

  // 5. Wall collision — axis-aligned bounces
  for (const id of playerIds) {
    wallBounce(players[id], MARBLE_RADIUS, WALL_RESTITUTION_PLAYER, goalHW);
  }
  wallBounce(ball, BALL_RADIUS, WALL_RESTITUTION_BALL, goalHW);

  // 6. Goal detection (skip during waiting — solo practice mode)
  if (state.phase !== "waiting") {
    checkGoal(c, ball, goalHW, now);
  }
}

// ---------------------------------------------------------------------------
// Collision helper (symmetric elastic push for equal-ish mass entities)
// ---------------------------------------------------------------------------

function resolveCollision(
  a: { position: Vec3; velocity: Vec3 },
  b: { position: Vec3; velocity: Vec3 },
  rA: number,
  rB: number,
  pushForce: number,
): void {
  const dx = b.position.x - a.position.x;
  const dz = b.position.z - a.position.z;
  const distSq = dx * dx + dz * dz;
  const minDist = rA + rB;

  if (distSq >= minDist * minDist || distSq < 0.000001) return;

  const dist = Math.sqrt(distSq);
  const nx = dx / dist;
  const nz = dz / dist;

  const overlap = (minDist - dist) / 2;
  a.position.x -= nx * overlap;
  a.position.z -= nz * overlap;
  b.position.x += nx * overlap;
  b.position.z += nz * overlap;

  const relVx = a.velocity.x - b.velocity.x;
  const relVz = a.velocity.z - b.velocity.z;
  const relDot = relVx * nx + relVz * nz;

  if (relDot > 0) {
    a.velocity.x -= nx * relDot * pushForce;
    a.velocity.z -= nz * relDot * pushForce;
    b.velocity.x += nx * relDot * pushForce;
    b.velocity.z += nz * relDot * pushForce;
  }

  const basePush = pushForce * 0.3;
  a.velocity.x -= nx * basePush;
  a.velocity.z -= nz * basePush;
  b.velocity.x += nx * basePush;
  b.velocity.z += nz * basePush;
}

// ---------------------------------------------------------------------------
// Wall bounce — handles field boundary + goal pocket geometry
// ---------------------------------------------------------------------------

function wallBounce(
  entity: { position: Vec3; velocity: Vec3 },
  radius: number,
  restitution: number,
  goalHW: number,
): void {
  const pos = entity.position;
  const vel = entity.velocity;
  const absZ = Math.abs(pos.z);
  const absX = Math.abs(pos.x);
  const inGoalPocket = absZ > FIELD_HALF_LENGTH && absX < goalHW;

  // Side walls (X axis)
  const xLimit = (inGoalPocket ? goalHW : FIELD_HALF_WIDTH) - radius;
  if (pos.x > xLimit) {
    pos.x = xLimit;
    vel.x *= -restitution;
  } else if (pos.x < -xLimit) {
    pos.x = -xLimit;
    vel.x *= -restitution;
  }

  // Goal-post inner edges: prevent lateral escape at the goal line boundary
  if (absZ > FIELD_HALF_LENGTH - radius && absZ <= FIELD_HALF_LENGTH + GOAL_DEPTH && !inGoalPocket) {
    if (absX < goalHW + radius && absX >= goalHW - radius) {
      if (pos.x > 0) {
        pos.x = goalHW - radius;
      } else {
        pos.x = -(goalHW - radius);
      }
      vel.x *= -restitution;
    }
  }

  // Back walls of goal pockets
  const backWallZ = FIELD_HALF_LENGTH + GOAL_DEPTH - radius;
  if (pos.z > backWallZ && absX < goalHW) {
    pos.z = backWallZ;
    vel.z *= -restitution;
  }
  if (pos.z < -backWallZ && absX < goalHW) {
    pos.z = -backWallZ;
    vel.z *= -restitution;
  }

  // End walls (Z axis) — solid except goal opening
  if (pos.z > FIELD_HALF_LENGTH - radius && absX >= goalHW - radius) {
    pos.z = FIELD_HALF_LENGTH - radius;
    vel.z *= -restitution;
  }
  if (pos.z < -(FIELD_HALF_LENGTH - radius) && absX >= goalHW - radius) {
    pos.z = -(FIELD_HALF_LENGTH - radius);
    vel.z *= -restitution;
  }
}

// ---------------------------------------------------------------------------
// Goal detection
// ---------------------------------------------------------------------------

function checkGoal(c: any, ball: BallState, goalHW: number, now: number): void {
  const state: GameRoomState = c.state;
  if (Math.abs(ball.position.x) >= goalHW) return;

  let teamScored: 1 | 2 | null = null;

  if (ball.position.z > FIELD_HALF_LENGTH + BALL_RADIUS) {
    // Ball entered +Z goal → team 2's goal → team 1 scores
    teamScored = 1;
  } else if (ball.position.z < -(FIELD_HALF_LENGTH + BALL_RADIUS)) {
    // Ball entered -Z goal → team 1's goal → team 2 scores
    teamScored = 2;
  }

  if (!teamScored) return;

  const idx = teamScored - 1;
  state.scores[idx] += 1;
  state.phase = "goalScored";
  state.phaseStartedAt = now;

  c.broadcast("goalScored", {
    scorerId: ball.lastTouchedBy,
    teamScored,
    scores: [...state.scores],
  });
  c.broadcast("phaseChanged", {
    phase: "goalScored",
    timeRemaining: state.timeRemaining,
  });
}

// ---------------------------------------------------------------------------
// Broadcast snapshot
// ---------------------------------------------------------------------------

const _snapshotPlayers: Record<string, { position: Vec3; velocity: Vec3 }> = {};

function broadcastSnapshot(c: any, tick: number): void {
  const state: GameRoomState = c.state;
  const ids = Object.keys(state.players);
  if (ids.length === 0) return;

  for (const id of ids) {
    _snapshotPlayers[id] = state.players[id];
  }

  c.broadcast("physicsSnapshot", {
    players: _snapshotPlayers,
    ball: state.ball,
    tick,
    timeRemaining: state.timeRemaining,
  } satisfies PhysicsSnapshot);

  for (const id of ids) {
    delete _snapshotPlayers[id];
  }
}
