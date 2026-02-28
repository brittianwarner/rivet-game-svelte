/**
 * useGameRoom — composable that wires a gameRoom actor to a GameStore.
 *
 * Creates the actor connection, subscribes to events, and provides
 * controls (sendInput, dash, leave) for components to use.
 */

import { goto } from "$app/navigation";
import { getRivetContext } from "@rivetkit/svelte";
import { useThrottle } from "runed";
import type { registry } from "$lib/actors/registry.js";
import { GameStore } from "./game-store.svelte.js";
import type { GameRoomControls } from "./context.js";
import {
  INPUT_SEND_INTERVAL,
  type GamePhase,
  type GoalScoredEvent,
  type JoinStateResult,
  type PhysicsSnapshot,
  type PlayerInput,
  type PlayerState,
  type Vec3,
} from "./types.js";

interface UseGameRoomOptions {
  roomId: string;
  playerName: string;
  store: GameStore;
}

interface GameRoomActions {
  getJoinState(): Promise<JoinStateResult>;
  sendInput(input: PlayerInput): Promise<void>;
}

export function useGameRoom(opts: UseGameRoomOptions): GameRoomControls {
  const { roomId, playerName, store } = opts;
  const { useActor } = getRivetContext<typeof registry>();

  const room = useActor(() => ({
    name: "gameRoom" as const,
    key: [roomId],
    params: { playerName },
  })) as ReturnType<typeof useActor> & GameRoomActions;

  // -------------------------------------------------------------------------
  // Sync initial state on connect
  // -------------------------------------------------------------------------

  $effect(() => {
    if (room.isConnected) {
      syncState();
    }
  });

  async function syncState(): Promise<void> {
    const MAX_RETRIES = 3;
    const BASE_DELAY = 500;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result: JoinStateResult = await room.getJoinState();
        store.initFromJoinState(result);
        store.connectionError = null;
        return;
      } catch (err) {
        console.error(`[useGameRoom] Sync attempt ${attempt + 1} failed:`, err);
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, BASE_DELAY * Math.pow(2, attempt)));
        }
      }
    }
    store.connectionError = "Failed to join game. Please try again.";
  }

  // -------------------------------------------------------------------------
  // Wire actor events → store mutations
  // -------------------------------------------------------------------------

  room.onEvent("playerJoined", (data: { player: PlayerState }) => {
    store.addPlayer(data.player);
    if (!store.localPlayerId && data.player.name === playerName) {
      store.localPlayerId = data.player.id;
    }
  });

  room.onEvent("playerLeft", (data: { playerId: string }) => {
    store.removePlayer(data.playerId);
  });

  room.onEvent("physicsSnapshot", (data: PhysicsSnapshot) => {
    store.applySnapshot(data);
  });

  room.onEvent("goalScored", (data: GoalScoredEvent) => {
    store.applyGoalScored(data);
  });

  room.onEvent(
    "gameOver",
    (data: {
      winnerId: string | null;
      winnerTeam: 1 | 2 | null;
      scores: [number, number];
    }) => {
      store.applyGameOver(data);
    },
  );

  room.onEvent(
    "phaseChanged",
    (data: { phase: GamePhase; timeRemaining: number }) => {
      store.applyPhaseChanged(data.phase, data.timeRemaining);
    },
  );

  // -------------------------------------------------------------------------
  // Throttled input sender (20 Hz)
  // -------------------------------------------------------------------------

  let lastInput: PlayerInput | null = null;
  let dashRequested = false;
  let dashRequestedAt = 0;
  const DASH_STALE_MS = 200;

  const throttledSend = useThrottle(
    () => {
      if (!lastInput || !room.isConnected) return;
      if (dashRequested && Date.now() - dashRequestedAt > DASH_STALE_MS) {
        dashRequested = false;
      }
      const input: PlayerInput = {
        ...lastInput,
        dash: dashRequested,
      };
      dashRequested = false;
      room.sendInput(input).catch(() => {});
    },
    () => INPUT_SEND_INTERVAL,
  );

  function sendInput(input: PlayerInput): void {
    lastInput = input;
    throttledSend();
  }

  function dash(): void {
    dashRequested = true;
    dashRequestedAt = Date.now();
    if (lastInput && room.isConnected) {
      room.sendInput({ ...lastInput, dash: true }).catch(() => {});
      dashRequested = false;
    }
  }

  function leave(): void {
    goto("/").then(() => store.reset());
  }

  return {
    sendInput,
    dash,
    leave,
    get isConnected() {
      return room.isConnected;
    },
    get connStatus() {
      return (room as any).connStatus ?? "unknown";
    },
  };
}
