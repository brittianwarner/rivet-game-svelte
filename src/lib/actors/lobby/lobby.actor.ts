import { actor, event } from "rivetkit";
import {
  ALLOWED_ORIGINS,
  MAX_PLAYERS,
  MAX_ROOMS,
  MAX_ROOM_NAME_LEN,
  type RoomSummary,
  type CreateRoomResult,
} from "../../game/types.js";

const SWEEP_INTERVAL = 60_000;
const ROOM_TTL = 300_000;

/**
 * Race rooms standardize on "waiting" | "racing" (RaceRoomSummary in
 * racing/types.ts); the bump game still reports "playing". The lobby stores
 * whichever the room actor sent.
 */
type LobbyRoomStatus = "waiting" | "playing" | "racing";

interface LobbyRoom extends Omit<RoomSummary, "status"> {
  status: LobbyRoomStatus;
  /** Last time the owning room actor was heard from (heartbeat). */
  lastHeardAt: number;
  /** Race-room config surfaced for lobby cards (set by the room actor). */
  trackId?: string;
  trackName?: string;
  lapCount?: number;
}

function buildRoom(
  roomId: string,
  name: unknown,
  game: unknown,
): LobbyRoom {
  const gameType = (game === "race" ? "race" : "bump") as "bump" | "race";
  const defaultName = gameType === "race" ? "Race Room" : "Soccer Match";
  const safeName =
    (typeof name === "string" ? name : "").trim().slice(0, MAX_ROOM_NAME_LEN) ||
    defaultName;
  return {
    id: roomId,
    name: safeName,
    game: gameType,
    playerCount: 0,
    maxPlayers: gameType === "race" ? 4 : MAX_PLAYERS,
    status: "waiting",
    createdAt: Date.now(),
    lastHeardAt: Date.now(),
  };
}

export const lobby = actor({
  state: { rooms: [] as LobbyRoom[] },

  run: async (c: any) => {
    while (!c.aborted) {
      await new Promise((r) => setTimeout(r, SWEEP_INTERVAL));
      const now = Date.now();
      const before = c.state.rooms.length;
      c.state.rooms = c.state.rooms.filter((room: LobbyRoom) => {
        // Evict rooms whose actor has gone silent — regardless of the last
        // reported playerCount (a crashed room must not haunt the lobby).
        const lastHeard = room.lastHeardAt ?? room.createdAt;
        const silent = now - lastHeard > ROOM_TTL;
        const staleEmpty = room.playerCount === 0 && now - room.createdAt > ROOM_TTL;
        if (silent || staleEmpty) {
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
    roomCreated: event<{ room: LobbyRoom }>(),
    roomUpdated: event<{ roomId: string; patch: Partial<LobbyRoom> }>(),
    roomRemoved: event<{ roomId: string }>(),
  },

  onBeforeConnect: (c: any) => {
    const origin = c.request?.headers.get("origin") ?? "";
    if (ALLOWED_ORIGINS.length > 0 && !ALLOWED_ORIGINS.includes(origin)) {
      throw new Error("Origin not allowed");
    }
  },

  actions: {
    listRooms: (c: any): LobbyRoom[] => c.state.rooms,

    createRoom: (c: any, name: string, game?: string): CreateRoomResult => {
      if (c.state.rooms.length >= MAX_ROOMS) {
        return { success: false, message: "Too many active rooms" };
      }
      const roomId = `room_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const room = buildRoom(roomId, name, game);
      c.state.rooms.push(room);
      c.broadcast("roomCreated", { room });
      return { success: true, roomId };
    },

    registerRoom: (c: any, roomId: string, name: string, game?: string): void => {
      const existing = c.state.rooms.find((r: LobbyRoom) => r.id === roomId);
      if (existing) {
        existing.lastHeardAt = Date.now();
        return;
      }
      if (c.state.rooms.length >= MAX_ROOMS) return;
      const room = buildRoom(roomId, name, game);
      c.state.rooms.push(room);
      c.broadcast("roomCreated", { room });
    },

    updateRoom: (
      c: any,
      roomId: string,
      patch: Record<string, unknown>,
    ): void => {
      let room = c.state.rooms.find((r: LobbyRoom) => r.id === roomId);
      if (!room) {
        // Upsert — room actors heartbeat through updateRoom, and a room that
        // deregistered itself (race finish) must reappear once it returns to
        // waiting instead of silently vanishing from the lobby forever.
        if (c.state.rooms.length >= MAX_ROOMS) return;
        room = buildRoom(roomId, patch.name, patch.game);
        c.state.rooms.push(room);
        c.broadcast("roomCreated", { room });
      }

      room.lastHeardAt = Date.now();

      if (
        typeof patch.playerCount === "number" &&
        patch.playerCount >= 0 &&
        patch.playerCount <= room.maxPlayers
      ) {
        room.playerCount = patch.playerCount;
      }
      if (
        patch.status === "waiting" ||
        patch.status === "racing" ||
        patch.status === "playing"
      ) {
        // Race rooms use "racing"; normalize any legacy "playing" they send.
        room.status =
          room.game === "race" && patch.status === "playing"
            ? "racing"
            : patch.status;
      }
      // Track config (race rooms) — keep lobby cards truthful as the room is
      // configured by its first player.
      if (typeof patch.trackId === "string") room.trackId = patch.trackId;
      if (typeof patch.trackName === "string") room.trackName = patch.trackName;
      if (typeof patch.lapCount === "number" && patch.lapCount > 0) {
        room.lapCount = patch.lapCount;
      }
      // Let a configured room update its display name too (default→track name).
      if (typeof patch.name === "string" && patch.name.trim()) {
        room.name = patch.name.trim().slice(0, MAX_ROOM_NAME_LEN);
      }
      c.broadcast("roomUpdated", {
        roomId,
        patch: {
          playerCount: room.playerCount,
          status: room.status,
          trackId: room.trackId,
          trackName: room.trackName,
          lapCount: room.lapCount,
          name: room.name,
        },
      });
    },

    removeRoom: (c: any, roomId: string): void => {
      c.state.rooms = c.state.rooms.filter(
        (r: LobbyRoom) => r.id !== roomId,
      );
      c.broadcast("roomRemoved", { roomId });
    },

    findOrCreateRoom: (c: any, game?: string): CreateRoomResult => {
      const gameType = (game === "race" ? "race" : "bump") as "bump" | "race";
      // Quick match must only ever land the player in a JOINABLE WAITING room.
      // Race rooms report any non-waiting phase (countdown/racing/finished) as
      // "racing", so requiring status === "waiting" already excludes every
      // in-progress room — a quick-matched player is never dropped into a race
      // already underway (which would silently seat them as a spectator). If no
      // open waiting room exists we fall through and mint a fresh one below.
      const available = c.state.rooms.find(
        (r: LobbyRoom) =>
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
      const room = buildRoom(roomId, defaultName, gameType);
      c.state.rooms.push(room);
      c.broadcast("roomCreated", { room });
      return { success: true, roomId };
    },
  },
});
