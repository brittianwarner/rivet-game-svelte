/**
 * GameStore — single reactive state container for 1v1 marble soccer.
 *
 * Components read from this store via Svelte context. The useGameRoom
 * composable writes to it from actor events.
 */

import {
  vec3Zero,
  type Vec3,
  type BallState,
  type GamePhase,
  type GameRoomState,
  type GoalScoredEvent,
  type JoinStateResult,
  type PhysicsSnapshot,
  type PlayerState,
} from "./types.js";

export class GameStore {
  // ---------------------------------------------------------------------------
  // Reactive state
  // ---------------------------------------------------------------------------

  players = $state<Record<string, PlayerState>>({});
  localPlayerId = $state<string | null>(null);
  ball = $state<BallState>({
    position: { x: 0, y: 0.5, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    lastTouchedBy: null,
  });
  scores = $state<[number, number]>([0, 0]);
  phase = $state<GamePhase>("waiting");
  timeRemaining = $state(180000);
  private _timerBaseValue = 180000;
  private _timerStartedAt = 0;
  connectionError = $state<string | null>(null);
  roomId = $state<string>("");
  roomName = $state<string>("");
  lastGoalScorer = $state<string | null>(null);
  lastGoalTeam = $state<1 | 2 | null>(null);
  winnerId = $state<string | null>(null);
  winnerTeam = $state<1 | 2 | null>(null);

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  localPlayer = $derived.by(() => {
    if (!this.localPlayerId) return null;
    return this.players[this.localPlayerId] ?? null;
  });

  opponentPlayer = $derived.by(() => {
    return (
      Object.values(this.players).find(
        (p) => p.id !== this.localPlayerId,
      ) ?? null
    );
  });

  localTeam = $derived.by(() => {
    return this.localPlayer?.team ?? null;
  });

  playerCount = $derived(Object.keys(this.players).length);

  getDisplayTime(): number {
    if (this.phase !== "playing") return this.timeRemaining;
    if (this._timerStartedAt === 0) return this.timeRemaining;
    const elapsed = performance.now() - this._timerStartedAt;
    return Math.max(0, this._timerBaseValue - elapsed);
  }

  // ---------------------------------------------------------------------------
  // Mutators
  // ---------------------------------------------------------------------------

  initFromJoinState(result: JoinStateResult): void {
    const { state, playerId } = result;
    this.roomId = state.id;
    this.roomName = state.name;
    this.phase = state.phase;
    this.localPlayerId = playerId;
    this.scores = [...state.scores] as [number, number];
    this.timeRemaining = state.timeRemaining;

    this.ball = {
      position: { ...state.ball.position },
      velocity: { ...state.ball.velocity },
      lastTouchedBy: state.ball.lastTouchedBy,
    };

    const rebuilt: Record<string, PlayerState> = {};
    for (const [id, p] of Object.entries(state.players)) {
      rebuilt[id] = {
        ...p,
        velocity: p.velocity ?? vec3Zero(),
      };
    }
    this.players = rebuilt;
  }

  applySnapshot(snapshot: PhysicsSnapshot): void {
    for (const [id, data] of Object.entries(snapshot.players)) {
      const player = this.players[id];
      if (!player) continue;
      player.position.x = data.position.x;
      player.position.y = data.position.y;
      player.position.z = data.position.z;
      player.velocity.x = data.velocity.x;
      player.velocity.y = data.velocity.y;
      player.velocity.z = data.velocity.z;
    }
    this.ball.position.x = snapshot.ball.position.x;
    this.ball.position.y = snapshot.ball.position.y;
    this.ball.position.z = snapshot.ball.position.z;
    this.ball.velocity.x = snapshot.ball.velocity.x;
    this.ball.velocity.y = snapshot.ball.velocity.y;
    this.ball.velocity.z = snapshot.ball.velocity.z;
    this.ball.lastTouchedBy = snapshot.ball.lastTouchedBy;

    if (snapshot.timeRemaining !== undefined) {
      this.timeRemaining = snapshot.timeRemaining;
      this._timerBaseValue = snapshot.timeRemaining;
      this._timerStartedAt = performance.now();
    }
  }

  addPlayer(player: PlayerState): void {
    this.players[player.id] = {
      ...player,
      velocity: player.velocity ?? vec3Zero(),
    };
  }

  removePlayer(playerId: string): void {
    delete this.players[playerId];
  }

  applyGoalScored(data: GoalScoredEvent): void {
    this.scores = [...data.scores] as [number, number];
    this.lastGoalScorer = data.scorerId;
    this.lastGoalTeam = data.teamScored;
  }

  applyPhaseChanged(phase: GamePhase, timeRemaining: number): void {
    this.phase = phase;
    this.timeRemaining = timeRemaining;
    this._timerBaseValue = timeRemaining;
    this._timerStartedAt = performance.now();
  }

  applyGameOver(data: {
    winnerId: string | null;
    winnerTeam: 1 | 2 | null;
    scores: [number, number];
  }): void {
    this.winnerId = data.winnerId;
    this.winnerTeam = data.winnerTeam;
    this.scores = [...data.scores] as [number, number];
  }

  reset(): void {
    this.players = {};
    this.localPlayerId = null;
    this.ball = {
      position: { x: 0, y: 0.5, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      lastTouchedBy: null,
    };
    this.scores = [0, 0];
    this.phase = "waiting";
    this.timeRemaining = 180000;
    this.roomId = "";
    this.roomName = "";
    this.lastGoalScorer = null;
    this.lastGoalTeam = null;
    this.winnerId = null;
    this.winnerTeam = null;
  }
}
