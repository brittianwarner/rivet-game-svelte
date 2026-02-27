<!--
  Game Room Page — thin shell that creates the store, wires the actor,
  provides context, and renders Scene + HUD. All game logic lives in
  GameStore (state), useGameRoom (actor bridge), and components (visuals).
-->
<script lang="ts">
	import { page } from "$app/state";
	import Scene from "$lib/components/Scene.svelte";
	import { GameStore } from "$lib/game/game-store.svelte";
	import { setGameStore, setGameRoomControls } from "$lib/game/context";
	import { useGameRoom } from "$lib/game/use-game-room.svelte";

	// ---------------------------------------------------------------------------
	// Route params (stable for this page's lifetime)
	// ---------------------------------------------------------------------------

	const roomId = page.params.roomId ?? "";
	const playerName =
		new URLSearchParams(
			typeof window !== "undefined" ? window.location.search : "",
		).get("name") ?? "Anonymous";

	// ---------------------------------------------------------------------------
	// Create store + wire actor → provide via context
	// ---------------------------------------------------------------------------

	const store = new GameStore();
	setGameStore(store);

	const controls = useGameRoom({ roomId, playerName, store });
	setGameRoomControls(controls);
</script>

<div class="relative h-full w-full">
	<!-- 3D scene (reads from store context, handles input via context) -->
	<div class="absolute inset-0">
		<Scene />
	</div>

	<!-- HUD overlay -->
	<div class="pointer-events-none absolute inset-0">
		<!-- Top bar: room info + leave button -->
		<div class="flex items-start justify-between p-4">
			<div
				class="pointer-events-auto rounded-lg border px-4 py-2"
				style="background: var(--color-surface); border-color: var(--color-border); backdrop-filter: blur(8px)"
			>
				<div class="text-sm font-semibold" style="color: var(--color-accent)">
					{store.roomId || roomId}
				</div>
				<div class="text-xs" style="color: var(--color-text-muted)">
					{store.playerCount} players
				</div>
			</div>

			<button
				onclick={() => controls.leave()}
				class="pointer-events-auto rounded-lg border px-4 py-2 text-sm transition-colors hover:border-[var(--color-danger)]"
				style="background: var(--color-surface); border-color: var(--color-border); color: var(--color-text-muted)"
			>
				Leave
			</button>
		</div>

		<!-- Scoreboard -->
		{#if store.sortedPlayers.length > 0}
			<div class="absolute right-4 top-20">
				<div
					class="rounded-lg border p-3"
					style="background: var(--color-surface); border-color: var(--color-border); backdrop-filter: blur(8px)"
				>
					<div
						class="mb-2 flex items-center gap-3 text-xs font-semibold uppercase tracking-wider"
						style="color: var(--color-text-muted)"
					>
						<span class="flex-1">Player</span>
						<span class="w-6 text-center" title="Knockoffs">KO</span>
						<span class="w-6 text-center" title="Falls">F</span>
						<span class="w-8 text-right" title="Score (KO - Falls)">Pts</span>
					</div>
					{#each store.sortedPlayers as player (player.id)}
						<div class="flex items-center gap-3 py-1">
							<div
								class="h-3 w-3 shrink-0 rounded-full"
								style="background: {player.color}"
							></div>
							<span
								class="flex-1 truncate text-xs {player.id === store.localPlayerId ? 'font-bold' : ''}"
								style="color: var(--color-text)"
							>
								{player.name}
							</span>
							<span
								class="w-6 text-center font-mono text-xs"
								style="color: var(--color-accent)"
							>
								{player.knockoffs}
							</span>
							<span
								class="w-6 text-center font-mono text-xs"
								style="color: var(--color-danger)"
							>
								{player.falls}
							</span>
							<span
								class="w-8 text-right font-mono text-xs font-semibold"
								style="color: var(--color-text-muted)"
							>
								{player.score}
							</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Death overlay -->
		{#if store.respawning}
			<div class="absolute inset-0 flex items-center justify-center">
				<div
					class="rounded-xl border px-8 py-6 text-center"
					style="background: var(--color-surface); border-color: var(--color-border); backdrop-filter: blur(12px)"
				>
					<div class="text-2xl font-bold" style="color: var(--color-danger)">
						{store.knockedOffByName ? `Bumped by ${store.knockedOffByName}!` : 'Fell off!'}
					</div>
					<div class="mt-2 text-sm" style="color: var(--color-text-muted)">
						Respawning...
					</div>
				</div>
			</div>
		{/if}

		<!-- Controls hint -->
		{#if store.localPlayerId}
			<div class="absolute bottom-4 left-1/2 -translate-x-1/2">
				<div
					class="rounded-lg border px-4 py-2 text-xs"
					style="background: var(--color-surface); border-color: var(--color-border); color: var(--color-text-muted); backdrop-filter: blur(8px)"
				>
					<span class="font-semibold">Click/tap</span> to move toward cursor
					<span class="mx-2">·</span>
					Push opponents off the edge
				</div>
			</div>
		{/if}

		<!-- Connecting overlay -->
		{#if !controls.isConnected}
			<div
				class="absolute inset-0 flex items-center justify-center"
				style="background: var(--color-bg)"
			>
				<div class="text-center">
					<div class="text-lg font-semibold" style="color: var(--color-accent)">
						Connecting to arena...
					</div>
				</div>
			</div>
		{/if}
	</div>
</div>
