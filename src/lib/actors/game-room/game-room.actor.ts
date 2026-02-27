/**
 * gameRoom actor — server-authoritative physics simulation.
 *
 * Key design decisions:
 * - Delta-time physics: forces/drag/gravity scale with actual elapsed time
 * - Tick-based respawn: no setTimeout — respawnAt timestamp checked each tick
 * - Single joinState action: returns full state + local playerId in one RPC
 * - Cached playerIds: Object.keys() called once per tick, reused
 * - Color tracking: assigned colors tracked in state to avoid duplicates
 * - Selective broadcasting: broadcastState: false, named events only
 */

import { actor, event } from "rivetkit";
import {
  ALLOWED_ORIGINS,
  ARENA_RADIUS,
  DRAG,
  FALL_THRESHOLD,
  GRAVITY,
  GROUND_Y,
  INPUT_DEAD_ZONE,
  MARBLE_RADIUS,
  MAX_SPEED,
  MOVE_FORCE,
  PLAYER_COLORS,
  PUSH_FORCE,
  RESPAWN_DELAY,
  HIT_ATTRIBUTION_WINDOW,
  SERVER_TICK_INTERVAL,
  SNAPSHOT_BROADCAST_INTERVAL,
  plainVec3,
  vec3Zero,
  clampSpeed,
  type GameRoomState,
  type JoinStateResult,
  type PlayerInput,
  type PlayerState,
  type PhysicsSnapshot,
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
  /** Latest input from this client */
  input: PlayerInput;
}

// ---------------------------------------------------------------------------
// Color assignment — track used colors to avoid duplicates
// ---------------------------------------------------------------------------

function assignColor(players: Record<string, PlayerState>): string {
  const usedColors = new Set(Object.values(players).map((p) => p.color));
  for (const color of PLAYER_COLORS) {
    if (!usedColors.has(color)) return color;
  }
  // Fallback: all colors taken, cycle
  return PLAYER_COLORS[Object.keys(players).length % PLAYER_COLORS.length];
}

/**
 * Generate a random spawn position within the arena.
 * Uses rejection sampling to ensure the point is within the circular arena
 * and at least MARBLE_RADIUS * 4 away from any living player.
 */
function assignSpawn(players: Record<string, PlayerState>): {
  x: number;
  y: number;
  z: number;
} {
  const safeRadius = ARENA_RADIUS - 2; // keep away from edge
  const minPlayerDist = MARBLE_RADIUS * 4; // avoid spawning on top of someone
  const minPlayerDistSq = minPlayerDist * minPlayerDist;
  const alivePlayers = Object.values(players).filter((p) => p.alive);

  // Try up to 20 random positions, fall back to center
  for (let attempt = 0; attempt < 20; attempt++) {
    // Random point in circle (uniform distribution via rejection sampling)
    const angle = Math.random() * Math.PI * 2;
    const r = safeRadius * Math.sqrt(Math.random());
    const x = r * Math.cos(angle);
    const z = r * Math.sin(angle);

    // Check distance from all alive players
    let tooClose = false;
    for (const p of alivePlayers) {
      const dx = p.position.x - x;
      const dz = p.position.z - z;
      if (dx * dx + dz * dz < minPlayerDistSq) {
        tooClose = true;
        break;
      }
    }

    if (!tooClose) {
      return { x, y: GROUND_Y, z };
    }
  }

  // Fallback: center of arena
  return { x: 0, y: GROUND_Y, z: 0 };
}

// ---------------------------------------------------------------------------
// Actor definition
// ---------------------------------------------------------------------------

export const gameRoom = actor({
    createState: (c: any): GameRoomState => ({
      id: c.key?.[0] ?? `room_${Date.now().toString(36)}`,
      name: "Arena",
      players: {},
      maxPlayers: PLAYER_COLORS.length,
      status: "waiting",
      createdAt: Date.now(),
    }),

    createConnState: (c: any, params: ConnParams): ConnState => {
      if (Object.keys(c.state.players).length >= c.state.maxPlayers) {
        throw new Error("Room is full");
      }
      const playerId = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      return {
        playerId,
        playerName: params.playerName,
        input: { tx: 0, tz: 0, active: false },
      };
    },

    events: {
      playerJoined: event<{ player: PlayerState }>(),
      playerLeft: event<{ playerId: string; playerName: string }>(),
      physicsSnapshot: event<PhysicsSnapshot>(),
      playerFell: event<{
        playerId: string;
        score: number;
        falls: number;
        knockedOffBy: string | null;
      }>(),
      playerRespawned: event<{
        playerId: string;
        position: { x: number; y: number; z: number };
      }>(),
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

      const player: PlayerState = {
        id: playerId,
        name: playerName,
        color: assignColor(c.state.players),
        position: assignSpawn(c.state.players),
        velocity: vec3Zero(),
        score: 0,
        knockoffs: 0,
        falls: 0,
        alive: true,
        respawnAt: 0,
        lastHitBy: null,
        lastHitAt: 0,
      };

      c.state.players[playerId] = player;
      c.broadcast("playerJoined", { player });
    },

    onDisconnect: (c: any, conn: any) => {
      const { playerId, playerName } = conn.state as ConnState;
      if (c.state.players[playerId]) {
        delete c.state.players[playerId];
        c.broadcast("playerLeft", { playerId, playerName });
      }
    },

    // -----------------------------------------------------------------------
    // Server tick loop — delta-time authoritative physics
    // -----------------------------------------------------------------------

    run: async (c: any) => {
      let lastSnapshot = 0;
      let lastTickTime = Date.now();

      while (!c.aborted) {
        const now = Date.now();
        // Delta time in units of "60Hz ticks" so physics constants stay the same
        const dtMs = Math.min(now - lastTickTime, 50); // cap at 50ms to prevent spiral
        const dt = dtMs / SERVER_TICK_INTERVAL; // 1.0 = perfect 60Hz tick
        lastTickTime = now;

        physicsTick(c, dt, now);

        // Broadcast snapshot at ~20 Hz
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
      /**
       * Single RPC to get full state + local player id on connect.
       * Replaces the old getState() + getMyPlayer() two-call pattern.
       */
      getJoinState: (c: any): JoinStateResult => {
        const connState = c.conn?.state as ConnState | undefined;
        return {
          state: c.state,
          playerId: connState?.playerId ?? "",
        };
      },

      /** Client sends their mouse/touch target point */
      sendInput: (c: any, input: PlayerInput): void => {
        const connState = c.conn?.state as ConnState | undefined;
        if (!connState) return;

        connState.input = {
          tx: Number(input.tx) || 0,
          tz: Number(input.tz) || 0,
          active: Boolean(input.active),
        };
      },

      /** Client requests respawn after falling */
      respawn: (c: any): void => {
        const connState = c.conn?.state as ConnState | undefined;
        if (!connState) return;
        const player = c.state.players[connState.playerId];
        if (!player || player.alive) return;

        const sp = assignSpawn(c.state.players);
        player.position = plainVec3(sp);
        player.velocity = vec3Zero();
        player.alive = true;
        player.respawnAt = 0;

        c.broadcast("playerRespawned", {
          playerId: connState.playerId,
          position: player.position,
        });
      },
    },
});

// ---------------------------------------------------------------------------
// Physics simulation (runs on server every tick at ~60 Hz)
// ---------------------------------------------------------------------------

function physicsTick(c: any, dt: number, now: number): void {
  const players: Record<string, PlayerState> = c.state.players;
  const playerIds = Object.keys(players);
  if (playerIds.length === 0) return;

  // 1. Check tick-based respawns (replaces setTimeout)
  for (const id of playerIds) {
    const player = players[id];
    if (!player.alive && player.respawnAt > 0 && now >= player.respawnAt) {
      const sp = assignSpawn(players);
      player.position = plainVec3(sp);
      player.velocity = vec3Zero();
      player.alive = true;
      player.respawnAt = 0;

      c.broadcast("playerRespawned", {
        playerId: id,
        position: player.position,
      });
    }
  }

  // 2. Read inputs from connections and apply forces
  for (const conn of c.conns.values()) {
    const connState = conn.state as ConnState;
    const player = players[connState.playerId];
    if (!player || !player.alive) continue;

    if (connState.input.active) {
      const dx = connState.input.tx - player.position.x;
      const dz = connState.input.tz - player.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);

      if (dist > INPUT_DEAD_ZONE) {
        const nx = dx / dist;
        const nz = dz / dist;
        const strength = Math.min(dist / 8, 1.0) * MOVE_FORCE * dt;
        player.velocity.x += nx * strength;
        player.velocity.z += nz * strength;
      }
    }
  }

  // 3. Marble-to-marble collision (push physics)
  for (let i = 0; i < playerIds.length; i++) {
    const a = players[playerIds[i]];
    if (!a.alive) continue;

    for (let j = i + 1; j < playerIds.length; j++) {
      const b = players[playerIds[j]];
      if (!b.alive) continue;

      const dx = b.position.x - a.position.x;
      const dz = b.position.z - a.position.z;
      const distSq = dx * dx + dz * dz;
      const minDist = MARBLE_RADIUS * 2;

      // Early exit with squared distance — avoid sqrt for non-collisions
      if (distSq >= minDist * minDist || distSq < 0.000001) continue;

      const dist = Math.sqrt(distSq);
      const nx = dx / dist;
      const nz = dz / dist;

      // Separate overlapping marbles
      const overlap = (minDist - dist) / 2;
      a.position.x -= nx * overlap;
      a.position.z -= nz * overlap;
      b.position.x += nx * overlap;
      b.position.z += nz * overlap;

      // Elastic push — transfer velocity along collision normal
      const relVx = a.velocity.x - b.velocity.x;
      const relVz = a.velocity.z - b.velocity.z;
      const relDot = relVx * nx + relVz * nz;

      if (relDot > 0) {
        const pushDt = PUSH_FORCE * dt;
        a.velocity.x -= nx * relDot * pushDt;
        a.velocity.z -= nz * relDot * pushDt;
        b.velocity.x += nx * relDot * pushDt;
        b.velocity.z += nz * relDot * pushDt;
      }

      // Base push so even slow collisions do something
      const basePush = PUSH_FORCE * 0.3 * dt;
      a.velocity.x -= nx * basePush;
      a.velocity.z -= nz * basePush;
      b.velocity.x += nx * basePush;
      b.velocity.z += nz * basePush;

      // Record hit attribution — each player marks the other as "last hit by"
      a.lastHitBy = playerIds[j];
      a.lastHitAt = now;
      b.lastHitBy = playerIds[i];
      b.lastHitAt = now;
    }
  }

  // 4. Integrate velocity → position, apply drag + gravity
  for (const id of playerIds) {
    const player = players[id];
    if (!player.alive) continue;

    // Drag (horizontal) — exponential decay scaled by dt
    const dragFactor = Math.pow(1 - DRAG, dt);
    player.velocity.x *= dragFactor;
    player.velocity.z *= dragFactor;

    // Clamp horizontal speed
    clampSpeed(player.velocity, MAX_SPEED);

    // Gravity scaled by dt
    player.velocity.y += GRAVITY * dt;

    // Integrate position scaled by dt
    player.position.x += player.velocity.x * dt;
    player.position.y += player.velocity.y * dt;
    player.position.z += player.velocity.z * dt;

    // Ground collision — keep on arena surface if within radius
    const distFromCenter = Math.sqrt(
      player.position.x * player.position.x +
        player.position.z * player.position.z,
    );

    if (distFromCenter <= ARENA_RADIUS && player.position.y <= GROUND_Y) {
      player.position.y = GROUND_Y;
      player.velocity.y = 0;
    }

    // Fall detection — use tick-based respawn instead of setTimeout
    if (player.position.y < FALL_THRESHOLD) {
      player.alive = false;
      player.falls += 1;
      player.score = Math.max(0, player.score - 1);
      player.velocity = vec3Zero();
      player.respawnAt = now + RESPAWN_DELAY;

      // Knockoff attribution — credit the last hitter if within time window
      let knockedOffBy: string | null = null;
      if (
        player.lastHitBy &&
        player.lastHitAt > 0 &&
        now - player.lastHitAt < HIT_ATTRIBUTION_WINDOW
      ) {
        knockedOffBy = player.lastHitBy;
        const attacker = players[knockedOffBy];
        if (attacker) {
          attacker.knockoffs += 1;
          attacker.score += 1;
        }
      }

      // Clear hit attribution
      player.lastHitBy = null;
      player.lastHitAt = 0;

      c.broadcast("playerFell", {
        playerId: id,
        score: player.score,
        falls: player.falls,
        knockedOffBy,
      });
    }
  }
}

function broadcastSnapshot(c: any, tick: number): void {
  const players: Record<string, PlayerState> = c.state.players;
  const ids = Object.keys(players);
  if (ids.length === 0) return;

  const snapshot: PhysicsSnapshot = {
    players: {},
    tick,
  };

  for (const id of ids) {
    const p = players[id];
    snapshot.players[id] = {
      position: { x: p.position.x, y: p.position.y, z: p.position.z },
      velocity: { x: p.velocity.x, y: p.velocity.y, z: p.velocity.z },
      alive: p.alive,
      score: p.score,
      knockoffs: p.knockoffs,
      falls: p.falls,
    };
  }

  c.broadcast("physicsSnapshot", snapshot);
}
