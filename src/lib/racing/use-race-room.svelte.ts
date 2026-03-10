/**
 * useRaceRoom — composable that wires a raceRoom actor to a RaceStore.
 *
 * Creates the actor connection, subscribes to events, and provides
 * controls (sendInput, useItem, leave, readyUp, voteRematch) for
 * components to use.
 */

import { goto } from "$app/navigation";
import { getRivetContext } from "@rivetkit/svelte";
import { useThrottle } from "runed";
import type { registry } from "$lib/actors/registry.js";
import { RaceStore } from "./race-store.svelte.js";
import type { RaceRoomControls } from "./context.js";
import {
  RACE_INPUT_SEND_INTERVAL,
  type KartInput,
  type KartState,
  type RacePhase,
  type RaceSnapshot,
  type RaceJoinStateResult,
  type KartHitEvent,
  type LapCompletedEvent,
  type ItemPickedUpEvent,
  type ItemUsedEvent,
  type RaceFinishedEvent,
  type RacePhaseChangedEvent,
} from "./types.js";

interface UseRaceRoomOptions {
  roomId: string;
  playerName: string;
  carVariant: number;
  store: RaceStore;
}

interface RaceRoomActions {
  getJoinState(): Promise<RaceJoinStateResult>;
  sendInput(input: KartInput): Promise<void>;
  useItem(): Promise<void>;
  readyUp(): Promise<void>;
  voteRematch(): Promise<void>;
}

export function useRaceRoom(opts: UseRaceRoomOptions): RaceRoomControls {
  const { roomId, playerName, carVariant, store } = opts;
  const { useActor } = getRivetContext<typeof registry>();

  const room = useActor(() => ({
    name: "raceRoom" as const,
    key: [roomId],
    params: { playerName, carVariant },
  })) as ReturnType<typeof useActor> & RaceRoomActions;

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
        const result: RaceJoinStateResult = await room.getJoinState();
        store.initFromJoinState(result);
        store.connectionError = null;
        return;
      } catch (err) {
        console.error(`[useRaceRoom] Sync attempt ${attempt + 1} failed:`, err);
        if (attempt < MAX_RETRIES) {
          await new Promise((r) =>
            setTimeout(r, BASE_DELAY * Math.pow(2, attempt)),
          );
        }
      }
    }
    store.connectionError = "Failed to join race. Please try again.";
  }

  // -------------------------------------------------------------------------
  // Wire actor events → store mutations
  // -------------------------------------------------------------------------

  room.onEvent("kartJoined", (data: { kart: KartState }) => {
    store.addKart(data.kart);
  });

  room.onEvent("kartLeft", (data: { kartId: string }) => {
    store.removeKart(data.kartId);
  });

  room.onEvent("raceSnapshot", (data: RaceSnapshot) => {
    store.applySnapshot(data);
  });

  room.onEvent("phaseChanged", (data: RacePhaseChangedEvent) => {
    store.applyPhaseChanged(data);

    // Countdown timer management
    if (data.phase === "countdown") {
      store.countdownNumber = 3;
      const startTime = performance.now();
      const countdownInterval = setInterval(() => {
        const elapsed = performance.now() - startTime;
        if (elapsed < 1000) {
          store.countdownNumber = 3;
        } else if (elapsed < 2000) {
          store.countdownNumber = 2;
        } else if (elapsed < 3000) {
          store.countdownNumber = 1;
        } else {
          store.countdownNumber = null;
          clearInterval(countdownInterval);
        }
      }, 100);
    } else {
      store.countdownNumber = null;
    }
  });

  room.onEvent("itemPickedUp", (data: ItemPickedUpEvent) => {
    store.applyItemPickedUp(data);
  });

  room.onEvent("itemUsed", (data: ItemUsedEvent) => {
    store.applyItemUsed(data);
  });

  room.onEvent("kartHit", (data: KartHitEvent) => {
    store.applyKartHit(data);
  });

  room.onEvent("lapCompleted", (data: LapCompletedEvent) => {
    store.applyLapCompleted(data);
  });

  room.onEvent("raceFinished", (data: RaceFinishedEvent) => {
    store.applyRaceFinished(data);
    store.phase = "finished";
  });

  // New events
  room.onEvent("driftTierReached", (data: { kartId: string; tier: number }) => {
    store.applyDriftTier(data);
  });

  room.onEvent("slipstream", (data: { kartId: string; active: boolean }) => {
    store.applySlipstream(data);
  });

  room.onEvent(
    "rocketStart",
    (data: { kartId: string; tier: string; boostSpeed: number }) => {
      store.applyRocketStart(data);
    },
  );

  room.onEvent(
    "readyStateChanged",
    (data: {
      playerId: string;
      ready: boolean;
      readyCount: number;
      totalCount: number;
    }) => {
      store.applyReadyState(data);
    },
  );

  room.onEvent(
    "rematchVote",
    (data: {
      votes: Record<string, boolean>;
      voteCount: number;
      needed: number;
    }) => {
      store.applyRematchVote(data);
    },
  );

  room.onEvent("raceToast", (data: { text: string; color: string }) => {
    store.applyRaceToast(data);
  });

  // -------------------------------------------------------------------------
  // Throttled input sender (20 Hz)
  // -------------------------------------------------------------------------

  let lastInput: KartInput | null = null;

  const throttledSend = useThrottle(
    () => {
      if (!lastInput || !room.isConnected) return;
      room.sendInput({ ...lastInput }).catch(() => {});
    },
    () => RACE_INPUT_SEND_INTERVAL,
  );

  function sendInput(input: KartInput): void {
    lastInput = input;
    throttledSend();
  }

  function useItem(): void {
    if (!room.isConnected) return;
    room.useItem().catch(() => {});
  }

  function leave(): void {
    goto("/race").then(() => store.reset());
  }

  function readyUp(): void {
    if (!room.isConnected) return;
    room.readyUp().catch(() => {});
  }

  function voteRematch(): void {
    if (!room.isConnected) return;
    room.voteRematch().catch(() => {});
  }

  return {
    sendInput,
    useItem,
    leave,
    readyUp,
    voteRematch,
    get isConnected() {
      return room.isConnected;
    },
    get connStatus() {
      return (room as any).connStatus ?? "unknown";
    },
  };
}
