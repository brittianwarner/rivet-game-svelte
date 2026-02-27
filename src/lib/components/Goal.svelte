<!--
  Goal — goal posts, crossbar, and back net for one end of the field.
  Placed at Z = ±FIELD_HALF_LENGTH. Posts emit defending team color.
-->
<script lang="ts">
	import { T } from "@threlte/core";
	import {
		FIELD_HALF_LENGTH,
		GOAL_HALF_WIDTH,
		GOAL_DEPTH,
		TEAM_COLORS,
	} from "$lib/game/types";

	interface Props {
		/** Which end: 1 = -Z (team 1 defends), 2 = +Z (team 2 defends) */
		team: 1 | 2;
	}

	let { team }: Props = $props();

	const zSign = team === 1 ? -1 : 1;
	const goalZ = zSign * FIELD_HALF_LENGTH;
	const color = TEAM_COLORS[team - 1];
	const POST_RADIUS = 0.12;
	const POST_HEIGHT = 0.8;
	const CROSSBAR_RADIUS = 0.08;
</script>

<T.Group position={[0, 0, goalZ]}>
	<!-- Left post -->
	<T.Mesh position={[-GOAL_HALF_WIDTH, POST_HEIGHT / 2, 0]} castShadow>
		<T.CylinderGeometry args={[POST_RADIUS, POST_RADIUS, POST_HEIGHT, 12]} />
		<T.MeshStandardMaterial
			color={color}
			emissive={color}
			emissiveIntensity={1.5}
			metalness={0.6}
			roughness={0.3}
		/>
	</T.Mesh>

	<!-- Right post -->
	<T.Mesh position={[GOAL_HALF_WIDTH, POST_HEIGHT / 2, 0]} castShadow>
		<T.CylinderGeometry args={[POST_RADIUS, POST_RADIUS, POST_HEIGHT, 12]} />
		<T.MeshStandardMaterial
			color={color}
			emissive={color}
			emissiveIntensity={1.5}
			metalness={0.6}
			roughness={0.3}
		/>
	</T.Mesh>

	<!-- Crossbar -->
	<T.Mesh
		position={[0, POST_HEIGHT, 0]}
		rotation.z={Math.PI / 2}
		castShadow
	>
		<T.CylinderGeometry args={[CROSSBAR_RADIUS, CROSSBAR_RADIUS, GOAL_HALF_WIDTH * 2, 12]} />
		<T.MeshStandardMaterial
			color={color}
			emissive={color}
			emissiveIntensity={1.2}
			metalness={0.6}
			roughness={0.3}
		/>
	</T.Mesh>

	<!-- Back net (translucent grid plane) -->
	<T.Mesh
		position={[0, POST_HEIGHT / 2, zSign * GOAL_DEPTH]}
		receiveShadow
	>
		<T.PlaneGeometry args={[GOAL_HALF_WIDTH * 2, POST_HEIGHT]} />
		<T.MeshStandardMaterial
			color={color}
			emissive={color}
			emissiveIntensity={0.3}
			transparent
			opacity={0.15}
			side={2}
			wireframe
		/>
	</T.Mesh>

	<!-- Goal line glow on floor -->
	<T.Mesh
		position={[0, 0.015, 0]}
		rotation.x={-Math.PI / 2}
	>
		<T.PlaneGeometry args={[GOAL_HALF_WIDTH * 2, 0.08]} />
		<T.MeshStandardMaterial
			color={color}
			emissive={color}
			emissiveIntensity={2.0}
			transparent
			opacity={0.8}
		/>
	</T.Mesh>
</T.Group>
