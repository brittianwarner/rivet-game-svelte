/**
 * GameStore — single reactive state container for all game state.
 *
 * Components read from this store via Svelte context. The useGameRoom
 * composable writes to it from actor events. Deep reactivity means
 * mutating `store.players[id].position` triggers updates automatically.
 */

import {
  vec3Zero,
  type Vec3,
  type PlayerState,
  type PhysicsSnapshot,
  type GameRoomState,
  type JoinStateResult,
} from "./types.js";

export class GameStore {
  // ---------------------------------------------------------------------------
  // Reactive state ($state fields — Svelte 5 deep proxy)
  // ---------------------------------------------------------------------------

  players = $state<Record<string, PlayerState>>({});
  localPlayerId = $state<string | null>(null);
  status = $state<GameRoomState["status"]>("waiting");
  roomId = $state<string>("");
  roomName = $state<string>("");
  respawning = $state(false);
  /** Name of the player who knocked the local player off (null = self-fall) */
  knockedOffByName = $state<string | null>(null);

  // ---------------------------------------------------------------------------
  // Derived state ($derived — auto-tracked, zero manual triggers)
  // ---------------------------------------------------------------------------

  localPlayer = $derived.by(() => {
    if (!this.localPlayerId) return null;
    return this.players[this.localPlayerId] ?? null;
  });

  remotePlayers = $derived.by(() => {
    return Object.values(this.players).filter(
      (p) => p.id !== this.localPlayerId,
    );
  });

  sortedPlayers = $derived.by(() => {
    return Object.values(this.players).sort((a, b) => b.score - a.score);
  });

  playerCount = $derived(Object.keys(this.players).length);

  // ---------------------------------------------------------------------------
  // Mutators — called by useGameRoom from actor events
  // ---------------------------------------------------------------------------

  /**
   * Initialize from getJoinState response — single RPC replaces
   * the old getState() + getMyPlayer() two-call pattern.
   */
  initFromJoinState(result: JoinStateResult): void {
    const { state, playerId } = result;
    this.roomId = state.id;
    this.roomName = state.name;
    this.status = state.status;
    this.localPlayerId = playerId;

    // Rebuild players with defaults for any missing fields
    const rebuilt: Record<string, PlayerState> = {};
    for (const [id, p] of Object.entries(state.players)) {
      rebuilt[id] = {
        ...p,
        velocity: p.velocity ?? vec3Zero(),
        respawnAt: p.respawnAt ?? 0,
        knockoffs: p.knockoffs ?? 0,
        falls: p.falls ?? 0,
        lastHitBy: p.lastHitBy ?? null,
        lastHitAt: p.lastHitAt ?? 0,
      };
    }
    this.players = rebuilt;
  }

  /** Apply server physics snapshot (positions + velocities + scores for all players) */
  applySnapshot(snapshot: PhysicsSnapshot): void {
    for (const [id, data] of Object.entries(snapshot.players)) {
      const player = this.players[id];
      if (!player) continue;
      // Deep mutation — Svelte 5 $state proxy tracks this automatically
      player.position.x = data.position.x;
      player.position.y = data.position.y;
      player.position.z = data.position.z;
      player.velocity.x = data.velocity.x;
      player.velocity.y = data.velocity.y;
      player.velocity.z = data.velocity.z;
      player.alive = data.alive;
      player.score = data.score;
      player.knockoffs = data.knockoffs;
      player.falls = data.falls;
    }
  }

  /** A new player joined */
  addPlayer(player: PlayerState): void {
    this.players[player.id] = {
      ...player,
      velocity: player.velocity ?? vec3Zero(),
      respawnAt: player.respawnAt ?? 0,
      knockoffs: player.knockoffs ?? 0,
      falls: player.falls ?? 0,
      lastHitBy: player.lastHitBy ?? null,
      lastHitAt: player.lastHitAt ?? 0,
    };
  }

  /** A player left */
  removePlayer(playerId: string): void {
    delete this.players[playerId];
  }

  /** A player fell off the edge */
  setPlayerFell(params: {
    playerId: string;
    score: number;
    falls: number;
    knockedOffBy: string | null;
  }): void {
    const player = this.players[params.playerId];
    if (!player) return;
    player.alive = false;
    player.score = params.score;
    player.falls = params.falls;
    // Attacker's knockoff count is synced via next physics snapshot (authoritative)

    if (params.playerId === this.localPlayerId) {
      this.respawning = true;
      this.knockedOffByName = params.knockedOffBy
        ? (this.players[params.knockedOffBy]?.name ?? null)
        : null;
    }
  }

  /** A player respawned */
  setPlayerRespawned(playerId: string, position: Vec3): void {
    const player = this.players[playerId];
    if (!player) return;
    player.alive = true;
    player.position.x = position.x;
    player.position.y = position.y;
    player.position.z = position.z;
    player.velocity.x = 0;
    player.velocity.y = 0;
    player.velocity.z = 0;
    player.respawnAt = 0;
    if (playerId === this.localPlayerId) {
      this.respawning = false;
      this.knockedOffByName = null;
    }
  }

  /** Reset all state (on disconnect / leave) */
  reset(): void {
    this.players = {};
    this.localPlayerId = null;
    this.status = "waiting";
    this.roomId = "";
    this.roomName = "";
    this.respawning = false;
    this.knockedOffByName = null;
  }
}
