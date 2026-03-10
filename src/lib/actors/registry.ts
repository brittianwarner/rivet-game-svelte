import { setup } from "rivetkit";
import { lobby } from "./lobby/index.js";
import { gameRoom } from "./game-room/index.js";
import { raceRoom } from "./race-room/index.js";

export const registry = setup({
  use: {
    lobby,
    gameRoom,
    raceRoom,
  },
});
