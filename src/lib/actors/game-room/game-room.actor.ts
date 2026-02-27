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
  vec3Zero,
  type BallState,
  type GamePhase,
  type GameRoomState,
  type JoinStateResult,
  type PhysicsSnapshot,
  type PlayerInput,
  type PlayerState,
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
      playerName: params.playerName,
      input: { tx: 0, tz: 0, active: false, dash: false },
      dashCooldownUntil: 0,
      dashStartedAt: 0,
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

    if (Object.keys(c.state.players).length === 2 && c.state.phase === "waiting") {
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
    }
  },

  // -----------------------------------------------------------------------
  // Server tick loop
  // -----------------------------------------------------------------------

  run: async (c: any) => {
    let lastSnapshot = 0;
    let lastTickTime = Date.now();

    while (!c.aborted) {
      const now = Date.now();
      const dtMs = Math.min(now - lastTickTime, 50);
      const dt = dtMs / SERVER_TICK_INTERVAL;
      lastTickTime = now;

      phaseTick(c, now);

      const phase: GamePhase = c.state.phase;
      if (phase === "waiting" || phase === "playing" || phase === "goldenGoal") {
        physicsTick(c, dt, now);
      }

      if (now - lastSnapshot >= SNAPSHOT_BROADCAST_INTERVAL) {
        lastSnapshot = now;
        broadcastSnapshot(c, now);
      }

      await new Promise((r) => setTimeout(r, SERVER_TICK_INTERVAL));
    }
  },

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------

  actions: {
    getJoinState: (c: any): JoinStateResult => {
      const connState = c.conn?.state as ConnState | undefined;
      return {
        state: c.state,
        playerId: connState?.playerId ?? "",
      };
    },

    sendInput: (c: any, input: PlayerInput): void => {
      const connState = c.conn?.state as ConnState | undefined;
      if (!connState) return;
      connState.input = {
        tx: Number(input.tx) || 0,
        tz: Number(input.tz) || 0,
        active: Boolean(input.active),
        dash: Boolean(input.dash),
      };
    },
  },
});

// ---------------------------------------------------------------------------
// Phase management
// ---------------------------------------------------------------------------

function phaseTick(c: any, now: number): void {
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
      state.timeRemaining -= SERVER_TICK_INTERVAL;
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

    // Handle dash activation
    if (cs.input.dash && now >= cs.dashCooldownUntil) {
      cs.dashStartedAt = now;
      cs.dashCooldownUntil = now + DASH_COOLDOWN;
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
      resolveCollision(a, b, MARBLE_RADIUS, MARBLE_RADIUS, 1.0, 1.0, PUSH_FORCE, dt);
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
  _massA: number,
  _massB: number,
  pushForce: number,
  dt: number,
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
    const pushDt = pushForce * dt;
    a.velocity.x -= nx * relDot * pushDt;
    a.velocity.z -= nz * relDot * pushDt;
    b.velocity.x += nx * relDot * pushDt;
    b.velocity.z += nz * relDot * pushDt;
  }

  const basePush = pushForce * 0.3 * dt;
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
  const inGoalPocket =
    Math.abs(pos.z) > FIELD_HALF_LENGTH && Math.abs(pos.x) < goalHW;

  // Side walls (X axis)
  if (inGoalPocket) {
    // Inside goal pocket: narrower X bounds
    if (pos.x > goalHW - radius) {
      pos.x = goalHW - radius;
      vel.x *= -restitution;
    } else if (pos.x < -(goalHW - radius)) {
      pos.x = -(goalHW - radius);
      vel.x *= -restitution;
    }
  } else {
    if (pos.x > FIELD_HALF_WIDTH - radius) {
      pos.x = FIELD_HALF_WIDTH - radius;
      vel.x *= -restitution;
    } else if (pos.x < -(FIELD_HALF_WIDTH - radius)) {
      pos.x = -(FIELD_HALF_WIDTH - radius);
      vel.x *= -restitution;
    }
  }

  // End walls (Z axis) — with goal opening
  // Positive Z end wall
  if (pos.z > FIELD_HALF_LENGTH - radius) {
    if (Math.abs(pos.x) > goalHW - radius) {
      pos.z = FIELD_HALF_LENGTH - radius;
      vel.z *= -restitution;
    } else {
      const backWall = FIELD_HALF_LENGTH + GOAL_DEPTH - radius;
      if (pos.z > backWall) {
        pos.z = backWall;
        vel.z *= -restitution;
      }
    }
  }

  // Negative Z end wall
  if (pos.z < -(FIELD_HALF_LENGTH - radius)) {
    if (Math.abs(pos.x) > goalHW - radius) {
      pos.z = -(FIELD_HALF_LENGTH - radius);
      vel.z *= -restitution;
    } else {
      const backWall = -(FIELD_HALF_LENGTH + GOAL_DEPTH - radius);
      if (pos.z < backWall) {
        pos.z = backWall;
        vel.z *= -restitution;
      }
    }
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

function broadcastSnapshot(c: any, tick: number): void {
  const state: GameRoomState = c.state;
  const ids = Object.keys(state.players);
  if (ids.length === 0) return;

  const snapshot: PhysicsSnapshot = {
    players: {},
    ball: {
      position: { ...state.ball.position },
      velocity: { ...state.ball.velocity },
      lastTouchedBy: state.ball.lastTouchedBy,
    },
    tick,
  };

  for (const id of ids) {
    const p = state.players[id];
    snapshot.players[id] = {
      position: { x: p.position.x, y: p.position.y, z: p.position.z },
      velocity: { x: p.velocity.x, y: p.velocity.y, z: p.velocity.z },
    };
  }

  c.broadcast("physicsSnapshot", snapshot);
}
