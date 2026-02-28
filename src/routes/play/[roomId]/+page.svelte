<!--
  Game Room Page — 1v1 marble soccer.
  Creates store, wires actor, provides context, renders Scene + HUD.
-->
<script lang="ts">
	import { page } from "$app/state";
	import { onMount, onDestroy } from "svelte";
	import Scene from "$lib/components/Scene.svelte";
	import { GameStore } from "$lib/game/game-store.svelte";
	import { setGameStore, setGameRoomControls } from "$lib/game/context";
	import { useGameRoom } from "$lib/game/use-game-room.svelte";
	import { TEAM_COLORS } from "$lib/game/types";

	const roomId = page.params.roomId ?? "";
	const playerName =
		new URLSearchParams(
			typeof window !== "undefined" ? window.location.search : "",
		).get("name") ?? "Anonymous";

	const store = new GameStore();
	setGameStore(store);

	const controls = useGameRoom({ roomId, playerName, store });
	setGameRoomControls(controls);

	let displayTime = $state(180000);
	let rafId = 0;

	function tickTimer() {
		displayTime = store.getDisplayTime();
		rafId = requestAnimationFrame(tickTimer);
	}

	onMount(() => {
		rafId = requestAnimationFrame(tickTimer);
	});

	onDestroy(() => {
		if (rafId) cancelAnimationFrame(rafId);
	});

	function formatTime(ms: number): string {
		const totalSec = Math.max(0, Math.ceil(ms / 1000));
		const min = Math.floor(totalSec / 60);
		const sec = totalSec % 60;
		return `${min}:${sec.toString().padStart(2, "0")}`;
	}

	function getScorerName(): string | null {
		if (!store.lastGoalScorer) return null;
		return store.players[store.lastGoalScorer]?.name ?? null;
	}

	function getWinnerName(): string | null {
		if (!store.winnerId) return null;
		return store.players[store.winnerId]?.name ?? null;
	}
</script>

<div class="relative h-full w-full">
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
					{store.playerCount}/2 players
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

		<!-- Score display (centered, large) -->
		{#if store.phase !== "waiting"}
			<div class="absolute left-1/2 top-4 -translate-x-1/2">
				<div
					class="rounded-xl border px-8 py-3 text-center"
					style="background: var(--color-surface); border-color: var(--color-border); backdrop-filter: blur(12px)"
				>
					<div class="flex items-center gap-6">
						<span
							class="text-4xl font-bold tabular-nums"
							style="color: {TEAM_COLORS[0]}"
						>
							{store.scores[0]}
						</span>
						<span class="text-2xl font-light" style="color: var(--color-text-muted)">
							—
						</span>
						<span
							class="text-4xl font-bold tabular-nums"
							style="color: {TEAM_COLORS[1]}"
						>
							{store.scores[1]}
						</span>
					</div>
				<!-- Timer -->
				{#if store.phase === "playing" || store.phase === "countdown"}
					<div
						class="mt-1 text-sm tabular-nums"
						style="color: {displayTime < 30000 ? 'var(--color-danger)' : 'var(--color-text-muted)'}"
					>
						{formatTime(displayTime)}
					</div>
					{:else if store.phase === "goldenGoal"}
						<div class="mt-1 text-sm font-bold animate-pulse" style="color: #FFD93D">
							GOLDEN GOAL
						</div>
					{/if}
				</div>
			</div>
		{/if}

		<!-- Countdown overlay -->
		{#if store.phase === "countdown"}
			<div class="absolute inset-0 flex items-center justify-center">
				<div class="text-6xl font-bold animate-pulse" style="color: var(--color-accent)">
					GET READY
				</div>
			</div>
		{/if}

		<!-- Goal scored overlay -->
		{#if store.phase === "goalScored"}
			{@const scorerName = getScorerName()}
			{@const teamColor = store.lastGoalTeam ? TEAM_COLORS[store.lastGoalTeam - 1] : "#fff"}
			<div class="absolute inset-0 flex items-center justify-center">
				<div
					class="rounded-xl border px-12 py-8 text-center"
					style="background: var(--color-surface); border-color: {teamColor}; backdrop-filter: blur(16px)"
				>
					<div class="text-5xl font-black" style="color: {teamColor}">
						GOAL!
					</div>
					{#if scorerName}
						<div class="mt-3 text-lg" style="color: var(--color-text-muted)">
							{scorerName}
						</div>
					{/if}
				</div>
			</div>
		{/if}

		<!-- Game over overlay -->
		{#if store.phase === "finished"}
			{@const winnerName = getWinnerName()}
			{@const winnerColor = store.winnerTeam ? TEAM_COLORS[store.winnerTeam - 1] : "#fff"}
			{@const isLocalWinner = store.winnerId === store.localPlayerId}
			<div class="absolute inset-0 flex items-center justify-center">
				<div
					class="rounded-xl border px-12 py-8 text-center"
					style="background: var(--color-surface); border-color: {winnerColor}; backdrop-filter: blur(16px)"
				>
					<div class="text-5xl font-black" style="color: {winnerColor}">
						{isLocalWinner ? "YOU WIN!" : "GAME OVER"}
					</div>
					{#if winnerName}
						<div class="mt-3 text-lg" style="color: var(--color-text-muted)">
							{isLocalWinner ? "" : `${winnerName} wins`}
						</div>
					{/if}
					<div class="mt-4 flex items-center justify-center gap-4">
						<span class="text-3xl font-bold" style="color: {TEAM_COLORS[0]}">
							{store.scores[0]}
						</span>
						<span class="text-xl" style="color: var(--color-text-muted)">—</span>
						<span class="text-3xl font-bold" style="color: {TEAM_COLORS[1]}">
							{store.scores[1]}
						</span>
					</div>
					<button
						onclick={() => controls.leave()}
						class="pointer-events-auto mt-6 rounded-lg border px-6 py-2 text-sm font-semibold transition-colors hover:border-[var(--color-accent)]"
						style="background: var(--color-surface); border-color: var(--color-border); color: var(--color-text)"
					>
						Back to Lobby
					</button>
				</div>
			</div>
		{/if}

		<!-- Waiting for opponent -->
		{#if store.phase === "waiting" && controls.isConnected}
			<div class="absolute inset-0 flex items-center justify-center">
				<div
					class="rounded-xl border px-8 py-6 text-center"
					style="background: var(--color-surface); border-color: var(--color-border); backdrop-filter: blur(12px)"
				>
					<div class="text-lg font-semibold" style="color: var(--color-accent)">
						Waiting for opponent...
					</div>
					<div class="mt-2 text-sm" style="color: var(--color-text-muted)">
						{store.playerCount}/2 players
					</div>
				</div>
			</div>
		{/if}

		<!-- Controls hint -->
		{#if store.localPlayerId && store.phase !== "finished"}
			<div class="absolute bottom-4 left-1/2 -translate-x-1/2">
				<div
					class="rounded-lg border px-4 py-2 text-xs"
					style="background: var(--color-surface); border-color: var(--color-border); color: var(--color-text-muted); backdrop-filter: blur(8px)"
				>
					<span class="font-semibold">Click/tap</span> to move
					<span class="mx-2">·</span>
					<span class="font-semibold">Right-click</span> to dash
					<span class="mx-2">·</span>
					Push the ball into the goal
				</div>
			</div>
		{/if}

		<!-- Connection error -->
		{#if store.connectionError}
			<div
				class="absolute inset-0 flex items-center justify-center"
				style="background: rgba(0,0,0,0.8)"
			>
				<div class="text-center">
					<div class="text-lg font-semibold" style="color: var(--color-danger)">
						{store.connectionError}
					</div>
					<button
						onclick={() => controls.leave()}
						class="pointer-events-auto mt-4 rounded-lg border px-6 py-2 text-sm font-semibold transition-colors hover:border-[var(--color-accent)]"
						style="background: var(--color-surface); border-color: var(--color-border); color: var(--color-text)"
					>
						Back to Lobby
					</button>
				</div>
			</div>
		{:else if controls.connStatus === "reconnecting"}
			<div class="absolute top-0 left-0 right-0 z-50 px-4 py-2 text-center text-sm" style="background: rgba(180,120,0,0.85); color: #ffe0a0">
				Reconnecting...
			</div>
		{:else if !controls.isConnected}
			<div
				class="absolute inset-0 flex items-center justify-center"
				style="background: var(--color-bg)"
			>
				<div class="text-center">
					<div class="text-lg font-semibold" style="color: var(--color-accent)">
						Connecting...
					</div>
				</div>
			</div>
		{/if}
	</div>
</div>
