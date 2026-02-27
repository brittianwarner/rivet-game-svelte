<!--
  Scene — 3D canvas setup. Reads all game state from GameStore context.
  No props. No physics engine (server-authoritative).

  Camera: fixed top-down angle. Scroll to zoom. No orbit rotation
  (left-click is reserved for game input via PointerInput).
-->
<script lang="ts">
	import { Canvas, T } from "@threlte/core";
	import { OrbitControls } from "@threlte/extras";
	import Environment from "./Environment.svelte";
	import Arena from "./Arena.svelte";
	import Marble from "./Marble.svelte";
	import PointerInput from "./PointerInput.svelte";
	import { getGameStore } from "$lib/game/context";

	const store = getGameStore();
</script>

<Canvas>
	<!-- Camera: fixed angle, scroll to zoom only -->
	<T.PerspectiveCamera
		makeDefault
		position={[0, 18, 18]}
		fov={50}
		oncreate={(ref) => {
			ref.lookAt(0, 0, 0);
		}}
	>
		<OrbitControls
			enableDamping
			enablePan={false}
			enableRotate={false}
			minDistance={10}
			maxDistance={35}
			target={[0, 0, 0]}
		/>
	</T.PerspectiveCamera>

	<Environment />
	<Arena />

	<!-- Local player marble -->
	{#if store.localPlayer}
		<Marble
			color={store.localPlayer.color}
			target={store.localPlayer.position}
			isLocal={true}
			name={store.localPlayer.name}
			knockoffs={store.localPlayer.knockoffs}
		/>
	{/if}

	<!-- Remote player marbles -->
	{#each store.remotePlayers as player (player.id)}
		<Marble
			color={player.color}
			target={player.position}
			name={player.name}
			knockoffs={player.knockoffs}
		/>
	{/each}

	<!-- Mouse/touch input handler + target indicator -->
	<PointerInput />
</Canvas>
