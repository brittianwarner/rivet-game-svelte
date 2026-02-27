<script lang="ts">
	import { goto } from "$app/navigation";
	import { getRivetContext } from "@rivetkit/svelte";
	import type { registry } from "$lib/actors/registry";
	import type { RoomSummary, CreateRoomResult } from "$lib/game/types";

	interface LobbyActions {
		listRooms(): Promise<RoomSummary[]>;
		createRoom(name: string): Promise<CreateRoomResult>;
	}

	const { useActor } = getRivetContext<typeof registry>();
	const lobby = useActor({ name: "lobby", key: ["main"] }) as ReturnType<typeof useActor> & LobbyActions;

	let rooms = $state<RoomSummary[]>([]);
	let newRoomName = $state("");
	let playerName = $state(
		`Player_${Math.random().toString(36).slice(2, 5)}`,
	);
	let isCreating = $state(false);

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
			rooms = await lobby.listRooms();
		} catch {
			// Will retry on next stateChanged
		}
	}

	async function createRoom(): Promise<void> {
		const name = newRoomName.trim() || "Arena";
		isCreating = true;
		try {
			const result = await lobby.createRoom(name);
			if (result.success && result.roomId) {
				newRoomName = "";
				goto(`/play/${result.roomId}?name=${encodeURIComponent(playerName)}`);
			}
		} finally {
			isCreating = false;
		}
	}

	function joinRoom(roomId: string): void {
		goto(`/play/${roomId}?name=${encodeURIComponent(playerName)}`);
	}
</script>

<div class="flex h-full items-center justify-center">
	<div class="w-full max-w-lg space-y-8 p-8">
		<!-- Title -->
		<div class="text-center">
			<h1 class="text-5xl font-bold tracking-tight" style="color: var(--color-accent)">
				BUMP
			</h1>
			<p class="mt-2" style="color: var(--color-text-muted)">
				Multiplayer Marble Sumo
			</p>
		</div>

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
					No rooms yet — create one above
				{:else}
					Active Rooms ({rooms.length})
				{/if}
			</h2>

			{#each rooms as room (room.id)}
				<button
					onclick={() => joinRoom(room.id)}
					class="flex w-full items-center justify-between rounded-lg border p-4 text-left transition-colors hover:border-[var(--color-accent)]"
					style="background: var(--color-surface); border-color: var(--color-border)"
				>
					<div>
						<div class="font-medium">{room.name}</div>
						<div class="mt-0.5 text-xs" style="color: var(--color-text-muted)">
							{room.playerCount} / {room.maxPlayers} players
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

		<!-- Connection indicator -->
		<div class="flex items-center justify-center gap-2 text-xs" style="color: var(--color-text-muted)">
			<div
				class="h-2 w-2 rounded-full"
				style="background: {lobby.isConnected ? 'var(--color-accent)' : 'var(--color-danger)'}"
			></div>
			{lobby.isConnected ? "Connected" : lobby.connStatus}
		</div>
	</div>
</div>
