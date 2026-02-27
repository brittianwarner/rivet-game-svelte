<!--
  Arena — visual-only circular platform.
  No physics (server-authoritative). Just the mesh, edge ring, and grid.
  
  Uses Layerr Blue (#0A9EF5) for edge ring and grid highlights.
-->
<script lang="ts">
	import { T } from "@threlte/core";
	import { ARENA_RADIUS } from "$lib/game/types";
</script>

<!-- Main arena platform -->
<T.Group position={[0, -0.25, 0]}>
	<T.Mesh receiveShadow castShadow>
		<T.CylinderGeometry args={[ARENA_RADIUS, ARENA_RADIUS, 0.5, 64]} />
		<T.MeshStandardMaterial
			color="#050914"
			emissive="#061a33"
			emissiveIntensity={0.22}
			metalness={0.75}
			roughness={0.25}
		/>
	</T.Mesh>
</T.Group>

<!-- Glowing edge ring — Layerr Blue -->
<T.Mesh position.y={0.01} rotation.x={-Math.PI / 2}>
	<T.RingGeometry args={[ARENA_RADIUS - 0.3, ARENA_RADIUS, 64]} />
	<T.MeshStandardMaterial
		color="#0A9EF5"
		emissive="#0A9EF5"
		emissiveIntensity={1.6}
		transparent
		opacity={0.92}
	/>
</T.Mesh>

<!-- Grid lines — Layerr Blue accent -->
<T.GridHelper
	args={[ARENA_RADIUS * 2, 26, "#061a33", "#0A9EF5"]}
	position.y={0.02}
/>
