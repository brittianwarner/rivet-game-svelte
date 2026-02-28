<!--
  Scene — 3D canvas for 1v1 marble soccer.
  Reads all game state from GameStore context. No props.
  Camera: fixed overhead angle showing full field.
-->
<script lang="ts">
	import { Canvas, T } from "@threlte/core";
	import { OrbitControls } from "@threlte/extras";
	import Environment from "./Environment.svelte";
	import Field from "./Field.svelte";
	import Goal from "./Goal.svelte";
	import Ball from "./Ball.svelte";
	import Marble from "./Marble.svelte";
	import PointerInput from "./PointerInput.svelte";
	import { getGameStore } from "$lib/game/context";

	const store = getGameStore();
</script>

<Canvas>
	<T.PerspectiveCamera
		makeDefault
		position={[0, 22, 14]}
		fov={50}
		oncreate={(ref) => {
			ref.lookAt(0, 0, 0);
		}}
	>
		<OrbitControls
			enableDamping
			enablePan={false}
			enableRotate={false}
			minDistance={12}
			maxDistance={40}
			target={[0, 0, 0]}
		/>
	</T.PerspectiveCamera>

	<Environment />
	<Field />
	<Goal team={1} />
	<Goal team={2} />
	<Ball />

	<!-- Local player marble -->
	{#if store.localPlayer}
		<Marble
			color={store.localPlayer.color}
			target={store.localPlayer.position}
			velocity={store.localPlayer.velocity}
			isLocal={true}
			name={store.localPlayer.name}
		/>
	{/if}

	<!-- Opponent marble -->
	{#if store.opponentPlayer}
		<Marble
			color={store.opponentPlayer.color}
			target={store.opponentPlayer.position}
			velocity={store.opponentPlayer.velocity}
			name={store.opponentPlayer.name}
		/>
	{/if}

	<PointerInput />
</Canvas>
