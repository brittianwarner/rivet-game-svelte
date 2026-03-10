import { getContext, setContext } from "svelte";
import { RaceStore } from "./race-store.svelte.js";
import { RACE_STORE_KEY, RACE_ROOM_KEY, type KartInput, type ItemType } from "./types.js";

export interface RaceRoomControls {
  sendInput: (input: KartInput) => void;
  useItem: () => void;
  leave: () => void;
  readyUp: () => void;
  voteRematch: () => void;
  readonly isConnected: boolean;
  readonly connStatus: string;
}

// ---------------------------------------------------------------------------
// Store context
// ---------------------------------------------------------------------------

export function setRaceStore(store: RaceStore): RaceStore {
  return setContext(RACE_STORE_KEY, store);
}

export function getRaceStore(): RaceStore {
  const store = getContext<RaceStore>(RACE_STORE_KEY);
  if (!store) {
    throw new Error(
      "RaceStore not found in context. Did you call setRaceStore() in a parent component?",
    );
  }
  return store;
}

// ---------------------------------------------------------------------------
// Room controls context
// ---------------------------------------------------------------------------

export function setRaceRoomControls(
  controls: RaceRoomControls,
): RaceRoomControls {
  return setContext(RACE_ROOM_KEY, controls);
}

export function getRaceRoomControls(): RaceRoomControls {
  const controls = getContext<RaceRoomControls>(RACE_ROOM_KEY);
  if (!controls) {
    throw new Error(
      "RaceRoomControls not found in context. Did you call setRaceRoomControls() in a parent component?",
    );
  }
  return controls;
}
