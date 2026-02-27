<!--
  Field — rectangular soccer pitch with neon markings.
  Replaces the circular Arena for the soccer game mode.
  20x12 field (Z axis = length, X axis = width) with goal openings at Z extremes.
-->
<script lang="ts">
	import { T } from "@threlte/core";
	import {
		FIELD_HALF_LENGTH,
		FIELD_HALF_WIDTH,
		GOAL_HALF_WIDTH,
		GOAL_DEPTH,
		TEAM_COLORS,
	} from "$lib/game/types";

	const FIELD_HEIGHT = 0.5;
	const LINE_Y = 0.02;
	const CENTER_CIRCLE_RADIUS = 3;
	const CENTER_CIRCLE_SEGMENTS = 64;
	const WALL_HEIGHT = 0.6;
	const WALL_THICKNESS = 0.3;
</script>

<!-- Main field platform -->
<T.Group position={[0, -FIELD_HEIGHT / 2, 0]}>
	<T.Mesh receiveShadow castShadow>
		<T.BoxGeometry
			args={[FIELD_HALF_WIDTH * 2, FIELD_HEIGHT, FIELD_HALF_LENGTH * 2]}
		/>
		<T.MeshStandardMaterial
			color="#050914"
			emissive="#061a33"
			emissiveIntensity={0.22}
			metalness={0.75}
			roughness={0.25}
		/>
	</T.Mesh>
</T.Group>

<!-- Goal pocket floors -->
{#each [1, -1] as sign}
	<T.Mesh
		position={[0, -FIELD_HEIGHT / 2, sign * (FIELD_HALF_LENGTH + GOAL_DEPTH / 2)]}
		receiveShadow
	>
		<T.BoxGeometry
			args={[GOAL_HALF_WIDTH * 2, FIELD_HEIGHT, GOAL_DEPTH]}
		/>
		<T.MeshStandardMaterial
			color="#030610"
			emissive={sign === 1 ? TEAM_COLORS[1] : TEAM_COLORS[0]}
			emissiveIntensity={0.08}
			metalness={0.8}
			roughness={0.3}
		/>
	</T.Mesh>
{/each}

<!-- Grid -->
<T.GridHelper
	args={[Math.max(FIELD_HALF_WIDTH * 2, FIELD_HALF_LENGTH * 2), 24, "#061a33", "#0A9EF5"]}
	position.y={LINE_Y}
/>

<!-- Center line -->
<T.Mesh position={[0, LINE_Y, 0]} rotation.x={-Math.PI / 2}>
	<T.PlaneGeometry args={[FIELD_HALF_WIDTH * 2, 0.06]} />
	<T.MeshStandardMaterial
		color="#0A9EF5"
		emissive="#0A9EF5"
		emissiveIntensity={1.2}
		transparent
		opacity={0.6}
	/>
</T.Mesh>

<!-- Center circle -->
<T.Mesh position={[0, LINE_Y, 0]} rotation.x={-Math.PI / 2}>
	<T.RingGeometry args={[CENTER_CIRCLE_RADIUS - 0.03, CENTER_CIRCLE_RADIUS, CENTER_CIRCLE_SEGMENTS]} />
	<T.MeshStandardMaterial
		color="#0A9EF5"
		emissive="#0A9EF5"
		emissiveIntensity={1.0}
		transparent
		opacity={0.4}
	/>
</T.Mesh>

<!-- Center dot -->
<T.Mesh position={[0, LINE_Y, 0]} rotation.x={-Math.PI / 2}>
	<T.CircleGeometry args={[0.15, 16]} />
	<T.MeshStandardMaterial
		color="#0A9EF5"
		emissive="#0A9EF5"
		emissiveIntensity={1.5}
		transparent
		opacity={0.8}
	/>
</T.Mesh>

<!-- Perimeter edge glow -->
<T.Mesh position={[0, LINE_Y, 0]} rotation.x={-Math.PI / 2}>
	<T.RingGeometry args={[
		Math.sqrt(FIELD_HALF_WIDTH ** 2 + FIELD_HALF_LENGTH ** 2) - 0.15,
		Math.sqrt(FIELD_HALF_WIDTH ** 2 + FIELD_HALF_LENGTH ** 2),
		4
	]} />
	<T.MeshStandardMaterial
		color="#0A9EF5"
		emissive="#0A9EF5"
		emissiveIntensity={0.5}
		transparent
		opacity={0.0}
	/>
</T.Mesh>

<!-- Side walls (X boundaries, full Z length) -->
{#each [1, -1] as sign}
	<T.Mesh
		position={[sign * (FIELD_HALF_WIDTH + WALL_THICKNESS / 2), WALL_HEIGHT / 2, 0]}
		castShadow
	>
		<T.BoxGeometry args={[WALL_THICKNESS, WALL_HEIGHT, FIELD_HALF_LENGTH * 2]} />
		<T.MeshStandardMaterial
			color="#080c1a"
			emissive="#0A9EF5"
			emissiveIntensity={0.3}
			transparent
			opacity={0.6}
			metalness={0.8}
			roughness={0.2}
		/>
	</T.Mesh>
{/each}

<!-- End walls (Z boundaries, with goal opening gap) -->
{#each [1, -1] as zSign}
	{#each [1, -1] as xSign}
		{@const wallWidth = FIELD_HALF_WIDTH - GOAL_HALF_WIDTH}
		{@const wallX = xSign * (GOAL_HALF_WIDTH + wallWidth / 2)}
		<T.Mesh
			position={[wallX, WALL_HEIGHT / 2, zSign * (FIELD_HALF_LENGTH + WALL_THICKNESS / 2)]}
			castShadow
		>
			<T.BoxGeometry args={[wallWidth, WALL_HEIGHT, WALL_THICKNESS]} />
			<T.MeshStandardMaterial
				color="#080c1a"
				emissive={zSign === -1 ? TEAM_COLORS[0] : TEAM_COLORS[1]}
				emissiveIntensity={0.4}
				transparent
				opacity={0.6}
				metalness={0.8}
				roughness={0.2}
			/>
		</T.Mesh>
	{/each}
{/each}

<!-- Goal pocket side walls -->
{#each [1, -1] as zSign}
	{#each [1, -1] as xSign}
		<T.Mesh
			position={[
				xSign * (GOAL_HALF_WIDTH + WALL_THICKNESS / 2),
				WALL_HEIGHT / 2,
				zSign * (FIELD_HALF_LENGTH + GOAL_DEPTH / 2),
			]}
			castShadow
		>
			<T.BoxGeometry args={[WALL_THICKNESS, WALL_HEIGHT, GOAL_DEPTH]} />
			<T.MeshStandardMaterial
				color="#080c1a"
				emissive={zSign === -1 ? TEAM_COLORS[0] : TEAM_COLORS[1]}
				emissiveIntensity={0.3}
				transparent
				opacity={0.5}
				metalness={0.8}
				roughness={0.2}
			/>
		</T.Mesh>
	{/each}
{/each}

<!-- Goal back walls -->
{#each [1, -1] as zSign}
	<T.Mesh
		position={[0, WALL_HEIGHT / 2, zSign * (FIELD_HALF_LENGTH + GOAL_DEPTH + WALL_THICKNESS / 2)]}
		castShadow
	>
		<T.BoxGeometry args={[GOAL_HALF_WIDTH * 2, WALL_HEIGHT, WALL_THICKNESS]} />
		<T.MeshStandardMaterial
			color="#080c1a"
			emissive={zSign === -1 ? TEAM_COLORS[0] : TEAM_COLORS[1]}
			emissiveIntensity={0.2}
			transparent
			opacity={0.4}
			metalness={0.8}
			roughness={0.2}
		/>
	</T.Mesh>
{/each}
