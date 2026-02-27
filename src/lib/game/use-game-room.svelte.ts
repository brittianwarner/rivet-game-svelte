/**
 * useGameRoom — composable that wires a gameRoom actor to a GameStore.
 *
 * Creates the actor connection, subscribes to events, and provides
 * controls (sendInput, respawn, leave) for components to use.
 * Input sending is throttled via useThrottle from Runed.
 */

import { goto } from "$app/navigation";
import { getRivetContext } from "@rivetkit/svelte";
import { useThrottle } from "runed";
import type { registry } from "$lib/actors/registry.js";
import { GameStore } from "./game-store.svelte.js";
import type { GameRoomControls } from "./context.js";
import {
  INPUT_SEND_INTERVAL,
  type JoinStateResult,
  type PlayerInput,
  type PlayerState,
  type PhysicsSnapshot,
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
  respawn(): Promise<void>;
}

export function useGameRoom(opts: UseGameRoomOptions): GameRoomControls {
  const { roomId, playerName, store } = opts;
  const { useActor } = getRivetContext<typeof registry>();

  // Actions are Proxy-forwarded to the actor connection at runtime
  const room = useActor(() => ({
    name: "gameRoom" as const,
    key: [roomId],
    params: { playerName },
  })) as ReturnType<typeof useActor> & GameRoomActions;

  // -------------------------------------------------------------------------
  // Sync initial state on connect — single RPC
  // -------------------------------------------------------------------------

  $effect(() => {
    if (room.isConnected) {
      syncState();
    }
  });

  async function syncState(): Promise<void> {
    try {
      const result: JoinStateResult = await room.getJoinState();
      store.initFromJoinState(result);
    } catch (err) {
      console.error("[useGameRoom] Failed to sync join state:", err);
    }
  }

  // -------------------------------------------------------------------------
  // Wire actor events → store mutations
  // -------------------------------------------------------------------------

  room.onEvent("playerJoined", (data: { player: PlayerState }) => {
    store.addPlayer(data.player);
    // If this is us and localPlayerId wasn't set yet (race condition guard)
    if (!store.localPlayerId && data.player.name === playerName) {
      store.initFromJoinState({
        state: {
          id: store.roomId,
          name: store.roomName,
          players: store.players,
          maxPlayers: 8,
          status: store.status,
          createdAt: 0,
        },
        playerId: data.player.id,
      });
    }
  });

  room.onEvent("playerLeft", (data: { playerId: string }) => {
    store.removePlayer(data.playerId);
  });

  room.onEvent("physicsSnapshot", (data: PhysicsSnapshot) => {
    store.applySnapshot(data);
  });

  room.onEvent(
    "playerFell",
    (data: {
      playerId: string;
      score: number;
      falls: number;
      knockedOffBy: string | null;
    }) => {
      store.setPlayerFell(data);
    },
  );

  room.onEvent(
    "playerRespawned",
    (data: { playerId: string; position: Vec3 }) => {
      store.setPlayerRespawned(data.playerId, data.position);
    },
  );

  // -------------------------------------------------------------------------
  // Throttled input sender (20 Hz)
  // -------------------------------------------------------------------------

  let lastInput: PlayerInput | null = null;

  const throttledSend = useThrottle(
    () => {
      if (!lastInput || !room.isConnected) return;
      room.sendInput(lastInput).catch(() => {});
    },
    () => INPUT_SEND_INTERVAL,
  );

  function sendInput(input: PlayerInput): void {
    lastInput = input;
    throttledSend();
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  function respawn(): void {
    if (!room.isConnected) return;
    room.respawn().catch(() => {});
  }

  function leave(): void {
    store.reset();
    goto("/");
  }

  // -------------------------------------------------------------------------
  // Return controls interface
  // -------------------------------------------------------------------------

  return {
    sendInput,
    respawn,
    leave,
    get isConnected() {
      return room.isConnected;
    },
  };
}
