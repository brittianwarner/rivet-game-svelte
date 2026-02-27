import { getContext, setContext } from "svelte";
import { GameStore } from "./game-store.svelte.js";
import { GAME_STORE_KEY, GAME_ROOM_KEY, type PlayerInput } from "./types.js";

export interface GameRoomControls {
  sendInput: (input: PlayerInput) => void;
  dash: () => void;
  leave: () => void;
  readonly isConnected: boolean;
}

// ---------------------------------------------------------------------------
// Store context
// ---------------------------------------------------------------------------

export function setGameStore(store: GameStore): GameStore {
  return setContext(GAME_STORE_KEY, store);
}

export function getGameStore(): GameStore {
  const store = getContext<GameStore>(GAME_STORE_KEY);
  if (!store) {
    throw new Error(
      "GameStore not found in context. Did you call setGameStore() in a parent component?",
    );
  }
  return store;
}

// ---------------------------------------------------------------------------
// Room controls context
// ---------------------------------------------------------------------------

export function setGameRoomControls(
  controls: GameRoomControls,
): GameRoomControls {
  return setContext(GAME_ROOM_KEY, controls);
}

export function getGameRoomControls(): GameRoomControls {
  const controls = getContext<GameRoomControls>(GAME_ROOM_KEY);
  if (!controls) {
    throw new Error(
      "GameRoomControls not found in context. Did you call setGameRoomControls() in a parent component?",
    );
  }
  return controls;
}
