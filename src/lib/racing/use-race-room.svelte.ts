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
import { getSoundManager } from "./sound-manager.svelte.js";
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
  type RoomSettings,
} from "./types.js";

interface UseRaceRoomOptions {
  roomId: string;
  playerName: string;
  carId: string;
  store: RaceStore;
  /** Sent as connection params; the first player to connect configures the room */
  roomSettings?: Partial<RoomSettings>;
  /** Optional player-chosen room name (used when this client created the room) */
  roomName?: string;
}

// ---------------------------------------------------------------------------
// Player token — persistent client identity for reconnect grace
// ---------------------------------------------------------------------------

const PLAYER_TOKEN_STORAGE_KEY = "rivet-kart:player-token";

/**
 * A stable per-browser UUID sent with the connection params. The race room
 * holds a disconnected player's kart for a grace window and re-adopts it when
 * a connection presenting the same token returns — so a page refresh or
 * network blip mid-race doesn't forfeit the player.
 */
function getOrCreatePlayerToken(): string {
  if (typeof localStorage === "undefined") return "";
  try {
    let token = localStorage.getItem(PLAYER_TOKEN_STORAGE_KEY);
    if (!token) {
      token =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `tok_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(PLAYER_TOKEN_STORAGE_KEY, token);
    }
    return token;
  } catch {
    // Storage unavailable (private mode etc.) — no reconnect grace
    return "";
  }
}

/**
 * Touch input written by the mobile HUD controls. RaceInput merges this with
 * keyboard state every frame and is the single input sender — without the
 * arbiter, the touch rAF loop and the keyboard useTask loop both overwrote
 * `lastInput` and randomly clobbered each other.
 */
export interface TouchInputState {
  steering: number; // -1..1, touch wins over keyboard when nonzero
  throttle: boolean;
  brake: boolean;
  drift: boolean;
}

export interface RaceRoomControlsWithTouch extends RaceRoomControls {
  setTouchInput(partial: Partial<TouchInputState>): void;
  readonly touchInput: TouchInputState;
}

interface RaceRoomActions {
  getJoinState(): Promise<RaceJoinStateResult>;
  sendInput(input: KartInput): Promise<void>;
  useItem(): Promise<void>;
  readyUp(): Promise<void>;
  voteRematch(): Promise<void>;
}

export function useRaceRoom(opts: UseRaceRoomOptions): RaceRoomControlsWithTouch {
  const { roomId, playerName, carId, store, roomSettings, roomName } = opts;
  const { useActor } = getRivetContext<typeof registry>();

  // ---------------------------------------------------------------------------
  // Touch input arbiter — written by the mobile HUD, merged by RaceInput
  // ---------------------------------------------------------------------------

  const touchInput = $state<TouchInputState>({
    steering: 0,
    throttle: false,
    brake: false,
    drift: false,
  });

  function setTouchInput(partial: Partial<TouchInputState>): void {
    Object.assign(touchInput, partial);
  }

  function resetTouchInput(): void {
    setTouchInput({ steering: 0, throttle: false, brake: false, drift: false });
  }

  // ---------------------------------------------------------------------------
  // Audio — the synthesized sound engine reacts to phase, items, and the local
  // kart speed. The AudioContext stays suspended until a user gesture resumes
  // it (handled on the play page); these calls are no-ops until then.
  // ---------------------------------------------------------------------------

  const sound = getSoundManager();

  /** Distance attenuation (0..1) for a remote kart's impact, vs the local kart. */
  function impactAttenuation(kartId: string): number {
    if (kartId === store.localPlayerId) return 1;
    const local = store.localPlayerId
      ? store.karts[store.localPlayerId]
      : null;
    const other = store.karts[kartId];
    if (!local || !other) return 0.5;
    const dx = local.position.x - other.position.x;
    const dz = local.position.z - other.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    // Full volume within ~30 units, fading to a floor by ~180 units.
    return Math.max(0.12, 1 - dist / 180);
  }

  const room = useActor(() => ({
    name: "raceRoom" as const,
    key: [roomId],
    params: {
      playerName,
      carId,
      playerToken: getOrCreatePlayerToken(),
      // Honored only by the first player to reach a fresh waiting room; later
      // connections (and reconnects) carry it harmlessly.
      ...(roomSettings ? { roomSettings } : {}),
      ...(roomName ? { roomName } : {}),
    },
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
    const prevPhase = store.phase;
    store.applyPhaseChanged(data);

    // The touch HUD unmounts outside countdown/racing, which can swallow
    // touchend events — release everything so nothing stays latched into
    // the next race.
    if (data.phase !== "racing" && data.phase !== "countdown") {
      resetTouchInput();
    }

    // GO sting when the countdown clears into racing. (Engine + music are
    // driven reactively off store.phase below so a mid-race join also gets
    // them, since initFromJoinState sets the phase without a phaseChanged.)
    if (data.phase === "racing" && prevPhase === "countdown") {
      sound.countdownBeep(true);
    }

    // Countdown timer management
    if (data.phase === "countdown") {
      store.countdownNumber = 3;
      sound.countdownBeep(false); // beep on "3"
      let lastBeep = 3;
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
        // One beep per number change (2, then 1). GO fires on the racing
        // transition above, not here, so a dropped phase event can't double it.
        if (store.countdownNumber !== null && store.countdownNumber !== lastBeep) {
          lastBeep = store.countdownNumber;
          sound.countdownBeep(false);
        }
      }, 100);
    } else {
      store.countdownNumber = null;
    }
  });

  room.onEvent("itemPickedUp", (data: ItemPickedUpEvent) => {
    store.applyItemPickedUp(data);
    // The local pickup spins a ~1.5s roulette — the lock-in blip is fired when
    // it lands (the isItemRolling true→false edge in the audio loop). Remote
    // karts get no roulette, so a soft pickup blip plays immediately here.
    if (data.kartId !== store.localPlayerId) {
      sound.itemPickup();
    }
  });

  room.onEvent("itemUsed", (data: ItemUsedEvent) => {
    store.applyItemUsed(data);
    sound.itemFire();
  });

  room.onEvent("kartHit", (data: KartHitEvent) => {
    store.applyKartHit(data);
    sound.itemImpact(impactAttenuation(data.kartId));
  });

  room.onEvent("lapCompleted", (data: LapCompletedEvent) => {
    store.applyLapCompleted(data);
    // Lap ding for the local player; flag the final lap so the alert sting
    // plays as they cross onto it.
    if (data.kartId === store.localPlayerId) {
      const finalLap = data.lap >= store.lapCount - 1;
      sound.lapDing(finalLap);
    }
  });

  room.onEvent("raceFinished", (data: RaceFinishedEvent) => {
    store.applyRaceFinished(data);
    store.phase = "finished";
    const won =
      data.positions.length > 0 && data.positions[0] === store.localPlayerId;
    sound.finishFanfare(won);
  });

  // New events
  room.onEvent("driftTierReached", (data: { kartId: string; tier: number }) => {
    store.applyDriftTier(data);
    if (data.kartId === store.localPlayerId) {
      sound.driftTier(data.tier);
    }
  });

  room.onEvent("slipstream", (data: { kartId: string; active: boolean }) => {
    store.applySlipstream(data);
  });

  room.onEvent(
    "rocketStart",
    (data: { kartId: string; tier: string; boostSpeed: number }) => {
      store.applyRocketStart(data);
      if (data.kartId === store.localPlayerId) {
        sound.rocketStart(data.tier);
      }
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

  room.onEvent(
    "itemDestroyed",
    (data: {
      x: number;
      y: number;
      z: number;
      cause: "shellVsShell" | "shellVsBanana" | "trailBlock";
      defenderId?: string;
    }) => {
      store.applyItemDestroyed(data);
      // Reuse the impact thud, attenuated by distance from the contact point to
      // the local kart (the defender on a trailBlock, else the nearest kart).
      const refId =
        data.cause === "trailBlock" && data.defenderId
          ? data.defenderId
          : store.localPlayerId ?? "";
      sound.itemImpact(impactAttenuation(refId));
    },
  );

  // -------------------------------------------------------------------------
  // Phase-reactive audio — engine on during countdown/racing, music intensity
  // tracks the lobby/race state. Reacting to store.phase (not just the
  // phaseChanged event) covers a fresh join mid-race, where initFromJoinState
  // sets the phase directly without firing a transition event.
  // -------------------------------------------------------------------------

  $effect(() => {
    const phase = store.phase;
    if (phase === "racing" || phase === "countdown") {
      sound.startEngine();
    } else {
      sound.stopEngine();
    }
    if (phase === "racing") {
      sound.setMusic("racing");
    } else if (phase === "waiting" || phase === "countdown") {
      sound.setMusic("waiting");
    } else {
      // finished — hush the loop so the fanfare lands clean.
      sound.setMusic("off");
    }
  });

  // -------------------------------------------------------------------------
  // Engine + drift audio loop — drive the engine pitch/cutoff from the local
  // kart's speed every frame and gate the drift noise on its drift state. The
  // roulette tick loop mirrors the store's item-roulette flag. The context
  // stays suspended until a gesture resumes it, so this is silent until then.
  // -------------------------------------------------------------------------

  $effect(() => {
    let raf = 0;
    let lastRolling = false;
    const loop = () => {
      const kart = store.localKart;
      if (kart && !store.isSpectator) {
        sound.updateEngine(
          kart.speed + (kart.boostSpeed || 0),
          kart.boostTimer > 0,
        );
        sound.setDrift(kart.driftState.active);
      } else {
        sound.setDrift(false);
      }
      // Roulette tick loop follows the store's local roulette animation; the
      // lock-in blip lands on the spin→settle edge (when the item is revealed).
      if (store.isItemRolling !== lastRolling) {
        if (store.isItemRolling) {
          sound.startRoulette();
        } else if (lastRolling) {
          sound.itemPickup(); // also stops the tick loop
        }
        lastRolling = store.isItemRolling;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      sound.setDrift(false);
      sound.stopRoulette();
      sound.stopEngine();
      // Leaving the race page entirely — hush the loop. The lobby restarts its
      // quiet "waiting" music on the next gesture.
      sound.setMusic("off");
    };
  });

  // -------------------------------------------------------------------------
  // Throttled input sender (~30 Hz), seq-stamped for client prediction
  // -------------------------------------------------------------------------

  let lastInput: KartInput | null = null;
  let inputSeq = 0;

  const throttledSend = useThrottle(
    () => {
      if (!lastInput || !room.isConnected) return;
      // Stamp the wire send with a monotonically increasing seq. The server
      // echoes the newest seq it has applied per kart (lastProcessedSeq in
      // snapshots) so the prediction path knows which inputs to replay.
      const stamped: KartInput = { ...lastInput, seq: ++inputSeq };
      store.recordSentInput(stamped);
      room.sendInput(stamped).catch(() => {});
    },
    () => RACE_INPUT_SEND_INTERVAL,
  );

  function sendInput(input: KartInput): void {
    lastInput = input;
    // Latest intent feeds the local prediction step every frame, regardless
    // of the wire send cadence.
    store.setLocalInput(input);
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
    setTouchInput,
    get touchInput() {
      return touchInput;
    },
    get isConnected() {
      return room.isConnected;
    },
    get connStatus() {
      // rivetkit's ActorConnStatus union: idle | connecting | connected |
      // disconnected ("reconnecting" was never a real value).
      return room.connStatus ?? "idle";
    },
  };
}
