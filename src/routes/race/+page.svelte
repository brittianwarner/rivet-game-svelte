<script lang="ts">
  import { goto } from "$app/navigation";
  import { getRivetContext } from "@rivetkit/svelte";
  import type { registry } from "$lib/actors/registry";
  import { RACE_MAX_PLAYERS, CAR_VARIANT_COLORS } from "$lib/racing/types";
  import type { RoomSummary } from "$lib/game/types";

  interface LobbyActions {
    listRooms(): Promise<RoomSummary[]>;
    createRoom(name: string, game: string): Promise<{ success: boolean; roomId?: string; message?: string }>;
    findOrCreateRoom(game: string): Promise<{ success: boolean; roomId?: string; message?: string }>;
  }

  const { useActor } = getRivetContext<typeof registry>();
  const lobby = useActor({ name: "lobby", key: ["main"] }) as ReturnType<typeof useActor> & LobbyActions;

  let rooms = $state<RoomSummary[]>([]);
  let newRoomName = $state("");
  let isQuickMatching = $state(false);
  let playerName = $state(
    `Racer_${Math.random().toString(36).slice(2, 5)}`,
  );
  let selectedCar = $state(0);
  let isCreating = $state(false);
  let linkCopiedToast = $state(false);

  // Load rooms when connected
  $effect(() => {
    if (lobby.isConnected) {
      loadRooms();
    }
  });

  lobby.onEvent("roomCreated", () => loadRooms());
  lobby.onEvent("roomUpdated", () => loadRooms());
  lobby.onEvent("roomRemoved", () => loadRooms());

  async function loadRooms(): Promise<void> {
    try {
      const all = await lobby.listRooms();
      // Filter to race rooms only
      rooms = all.filter((r: any) => r.game === "race");
    } catch {
      // Will retry on next event
    }
  }

  async function createRoom(): Promise<void> {
    const name = newRoomName.trim() || "Race Room";
    isCreating = true;
    try {
      const result = await lobby.createRoom(name, "race");
      if (result.success && result.roomId) {
        newRoomName = "";
        const url = `${window.location.origin}/race/play/${result.roomId}?name=${encodeURIComponent(playerName)}&car=${selectedCar}`;
        // Copy link to clipboard
        try {
          await navigator.clipboard.writeText(url);
          linkCopiedToast = true;
          setTimeout(() => (linkCopiedToast = false), 2000);
        } catch {
          // Clipboard not available, proceed anyway
        }
        goto(`/race/play/${result.roomId}?name=${encodeURIComponent(playerName)}&car=${selectedCar}`);
      }
    } finally {
      isCreating = false;
    }
  }

  function joinRoom(roomId: string): void {
    goto(`/race/play/${roomId}?name=${encodeURIComponent(playerName)}&car=${selectedCar}`);
  }

  async function quickMatch(): Promise<void> {
    isQuickMatching = true;
    try {
      const result = await lobby.findOrCreateRoom("race");
      if (result.success && result.roomId) {
        goto(`/race/play/${result.roomId}?name=${encodeURIComponent(playerName)}&car=${selectedCar}`);
      }
    } finally {
      isQuickMatching = false;
    }
  }
</script>

<div class="flex h-full items-center justify-center">
  <div class="w-full max-w-lg space-y-8 p-8">
    <!-- Title -->
    <div class="text-center">
      <h1 class="text-5xl font-bold tracking-tight" style="color: var(--color-accent)">
        RIVET KART
      </h1>
      <p class="mt-2" style="color: var(--color-text-muted)">
        4-Player Kart Racing
      </p>
    </div>

    <!-- Link copied toast -->
    {#if linkCopiedToast}
      <div class="lobby-toast rounded-lg border px-4 py-2 text-center text-sm font-semibold"
           style="background: var(--color-surface); border-color: #44FF88; color: #44FF88">
        Room link copied to clipboard!
      </div>
    {/if}

    <!-- Player Name -->
    <div class="space-y-2">
      <label
        for="player-name"
        class="block text-sm font-medium"
        style="color: var(--color-text-muted)"
      >
        Your Name
      </label>
      <input
        id="player-name"
        type="text"
        bind:value={playerName}
        class="w-full rounded-lg border px-4 py-2.5 text-sm outline-none transition-colors focus:border-[var(--color-accent)]"
        style="background: var(--color-surface); border-color: var(--color-border); color: var(--color-text)"
        placeholder="Enter your name"
      />
    </div>

    <!-- Car Selection -->
    <div class="space-y-2">
      <label
        class="block text-sm font-medium"
        style="color: var(--color-text-muted)"
      >
        Select Car
      </label>
      <div class="flex gap-3">
        {#each CAR_VARIANT_COLORS as color, i}
          <button
            onclick={() => (selectedCar = i)}
            class="flex-1 rounded-lg border-2 p-3 text-center text-sm font-semibold transition-all"
            style="
              background: {selectedCar === i ? color + '22' : 'var(--color-surface)'};
              border-color: {selectedCar === i ? color : 'var(--color-border)'};
              color: {color}
            "
          >
            Car {i + 1}
          </button>
        {/each}
      </div>
    </div>

    <!-- Quick Play -->
    <button
      onclick={quickMatch}
      disabled={isQuickMatching || !lobby.isConnected}
      class="w-full rounded-lg px-6 py-3 text-base font-bold text-black transition-opacity hover:opacity-90 disabled:opacity-50"
      style="background: var(--color-accent)"
    >
      {isQuickMatching ? "Finding race..." : "Quick Race"}
    </button>

    <!-- Create Room -->
    <div class="space-y-2">
      <label
        for="room-name"
        class="block text-sm font-medium"
        style="color: var(--color-text-muted)"
      >
        Create Room
      </label>
      <div class="flex gap-2">
        <input
          id="room-name"
          type="text"
          bind:value={newRoomName}
          class="flex-1 rounded-lg border px-4 py-2.5 text-sm outline-none transition-colors focus:border-[var(--color-accent)]"
          style="background: var(--color-surface); border-color: var(--color-border); color: var(--color-text)"
          placeholder="Room name (optional)"
          onkeydown={(e) => e.key === "Enter" && createRoom()}
        />
        <button
          onclick={createRoom}
          disabled={isCreating || !lobby.isConnected}
          class="rounded-lg px-6 py-2.5 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-50"
          style="background: var(--color-accent)"
        >
          {isCreating ? "..." : "Create"}
        </button>
      </div>
    </div>

    <!-- Room List -->
    <div class="space-y-3">
      <h2 class="text-sm font-medium" style="color: var(--color-text-muted)">
        {#if !lobby.isConnected}
          Connecting...
        {:else if rooms.length === 0}
          No race rooms yet — create one above
        {:else}
          Active Races ({rooms.length})
        {/if}
      </h2>

      {#each rooms as room (room.id)}
        <button
          onclick={() => joinRoom(room.id)}
          disabled={room.status === "playing" || room.playerCount >= room.maxPlayers}
          class="flex w-full items-center justify-between rounded-lg border p-4 text-left transition-colors hover:border-[var(--color-accent)] disabled:opacity-50 disabled:cursor-not-allowed"
          style="background: var(--color-surface); border-color: var(--color-border)"
        >
          <div>
            <div class="font-medium">{room.name}</div>
            <div class="mt-0.5 text-xs" style="color: var(--color-text-muted)">
              {room.playerCount}/{room.maxPlayers} · Kart Race
            </div>
          </div>
          <div
            class="rounded-full px-3 py-1 text-xs font-medium"
            style="background: {room.status === 'waiting' ? 'var(--color-accent-dim)' : 'var(--color-border)'}; color: {room.status === 'waiting' ? 'var(--color-accent)' : 'var(--color-text-muted)'}"
          >
            {room.status === "waiting" ? "Join" : "In Progress"}
          </div>
        </button>
      {/each}
    </div>

    <!-- Back to games -->
    <div class="flex items-center justify-between">
      <a
        href="/"
        class="text-sm transition-colors hover:underline"
        style="color: var(--color-text-muted)"
      >
        Back to Games
      </a>
      <div class="flex items-center gap-2 text-xs" style="color: var(--color-text-muted)">
        <div
          class="h-2 w-2 rounded-full"
          style="background: {lobby.isConnected ? 'var(--color-accent)' : 'var(--color-danger)'}"
        ></div>
        {lobby.isConnected ? "Connected" : lobby.connStatus}
      </div>
    </div>
  </div>
</div>

<style>
  .lobby-toast {
    animation: lobbyToastIn 0.3s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
  }

  @keyframes lobbyToastIn {
    from {
      transform: translateY(-10px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }
</style>
