import { actor, event } from "rivetkit";
import {
  ALLOWED_ORIGINS,
  MAX_PLAYERS,
  MAX_ROOMS,
  MAX_ROOM_NAME_LEN,
  type LobbyState,
  type RoomSummary,
  type CreateRoomResult,
} from "../../game/types.js";

const SWEEP_INTERVAL = 60_000;
const ROOM_TTL = 300_000;

export const lobby = actor({
  state: { rooms: [] as RoomSummary[] } satisfies LobbyState,

  run: async (c: any) => {
    while (!c.aborted) {
      await new Promise((r) => setTimeout(r, SWEEP_INTERVAL));
      const now = Date.now();
      const before = c.state.rooms.length;
      c.state.rooms = c.state.rooms.filter((room: RoomSummary) => {
        if (room.playerCount === 0 && now - room.createdAt > ROOM_TTL) {
          c.broadcast("roomRemoved", { roomId: room.id });
          return false;
        }
        return true;
      });
      if (c.state.rooms.length !== before) {
        console.log(`[lobby] Swept ${before - c.state.rooms.length} stale rooms`);
      }
    }
  },

  events: {
    roomCreated: event<{ room: RoomSummary }>(),
    roomUpdated: event<{ roomId: string; patch: Partial<RoomSummary> }>(),
    roomRemoved: event<{ roomId: string }>(),
  },

  onBeforeConnect: (c: any) => {
    const origin = c.request?.headers.get("origin") ?? "";
    if (ALLOWED_ORIGINS.length > 0 && !ALLOWED_ORIGINS.includes(origin)) {
      throw new Error("Origin not allowed");
    }
  },

  actions: {
    listRooms: (c: any): RoomSummary[] => c.state.rooms,

    createRoom: (c: any, name: string, game?: string): CreateRoomResult => {
      if (c.state.rooms.length >= MAX_ROOMS) {
        return { success: false, message: "Too many active rooms" };
      }
      const gameType = (game === "race" ? "race" : "bump") as "bump" | "race";
      const defaultName = gameType === "race" ? "Race Room" : "Soccer Match";
      const safeName = (typeof name === "string" ? name : "").trim().slice(0, MAX_ROOM_NAME_LEN) || defaultName;
      const roomId = `room_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const room: RoomSummary = {
        id: roomId,
        name: safeName,
        game: gameType,
        playerCount: 0,
        maxPlayers: gameType === "race" ? 4 : MAX_PLAYERS,
        status: "waiting",
        createdAt: Date.now(),
      };
      c.state.rooms.push(room);
      c.broadcast("roomCreated", { room });
      return { success: true, roomId };
    },

    registerRoom: (c: any, roomId: string, name: string, game?: string): void => {
      const existing = c.state.rooms.find((r: RoomSummary) => r.id === roomId);
      if (existing) return;
      if (c.state.rooms.length >= MAX_ROOMS) return;
      const gameType = (game === "race" ? "race" : "bump") as "bump" | "race";
      const defaultName = gameType === "race" ? "Race Room" : "Soccer Match";
      const safeName = (typeof name === "string" ? name : "").trim().slice(0, MAX_ROOM_NAME_LEN) || defaultName;
      const room: RoomSummary = {
        id: roomId,
        name: safeName,
        game: gameType,
        playerCount: 0,
        maxPlayers: gameType === "race" ? 4 : MAX_PLAYERS,
        status: "waiting",
        createdAt: Date.now(),
      };
      c.state.rooms.push(room);
      c.broadcast("roomCreated", { room });
    },

    updateRoom: (
      c: any,
      roomId: string,
      patch: Record<string, unknown>,
    ): void => {
      const room = c.state.rooms.find((r: RoomSummary) => r.id === roomId);
      if (!room) return;
      if (typeof patch.playerCount === "number" && patch.playerCount >= 0 && patch.playerCount <= room.maxPlayers) {
        room.playerCount = patch.playerCount;
      }
      if (patch.status === "waiting" || patch.status === "playing") {
        room.status = patch.status;
      }
      c.broadcast("roomUpdated", { roomId, patch: { playerCount: room.playerCount, status: room.status } });
    },

    removeRoom: (c: any, roomId: string): void => {
      c.state.rooms = c.state.rooms.filter(
        (r: RoomSummary) => r.id !== roomId,
      );
      c.broadcast("roomRemoved", { roomId });
    },

    findOrCreateRoom: (c: any, game?: string): CreateRoomResult => {
      const gameType = (game === "race" ? "race" : "bump") as "bump" | "race";
      const available = c.state.rooms.find(
        (r: RoomSummary) =>
          r.status === "waiting" &&
          r.playerCount < r.maxPlayers &&
          (r.game ?? "bump") === gameType,
      );
      if (available) {
        return { success: true, roomId: available.id };
      }
      if (c.state.rooms.length >= MAX_ROOMS) {
        return { success: false, message: "Too many active rooms" };
      }
      const defaultName = gameType === "race" ? "Quick Race" : "Quick Match";
      const roomId = `room_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const room: RoomSummary = {
        id: roomId,
        name: defaultName,
        game: gameType,
        playerCount: 0,
        maxPlayers: gameType === "race" ? 4 : MAX_PLAYERS,
        status: "waiting",
        createdAt: Date.now(),
      };
      c.state.rooms.push(room);
      c.broadcast("roomCreated", { room });
      return { success: true, roomId };
    },
  },
});
