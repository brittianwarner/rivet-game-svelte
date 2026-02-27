import { actor, event } from "rivetkit";
import {
  ALLOWED_ORIGINS,
  PLAYER_COLORS,
  type LobbyState,
  type RoomSummary,
  type CreateRoomResult,
} from "../../game/types.js";

export const lobby = actor({
  state: { rooms: [] as RoomSummary[] } satisfies LobbyState,

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

    createRoom: (c: any, name: string): CreateRoomResult => {
      const roomId = `room_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const room: RoomSummary = {
        id: roomId,
        name,
        playerCount: 0,
        maxPlayers: PLAYER_COLORS.length,
        status: "waiting",
        createdAt: Date.now(),
      };
      c.state.rooms.push(room);
      c.broadcast("roomCreated", { room });
      return { success: true, roomId };
    },

    updateRoom: (
      c: any,
      roomId: string,
      patch: Partial<Pick<RoomSummary, "playerCount" | "status">>,
    ): void => {
      const room = c.state.rooms.find((r: RoomSummary) => r.id === roomId);
      if (room) {
        Object.assign(room, patch);
        c.broadcast("roomUpdated", { roomId, patch });
      }
    },

    removeRoom: (c: any, roomId: string): void => {
      c.state.rooms = c.state.rooms.filter(
        (r: RoomSummary) => r.id !== roomId,
      );
      c.broadcast("roomRemoved", { roomId });
    },
  },
});
