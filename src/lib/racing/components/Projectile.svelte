<!--
  Projectile — renders a shell (green, red, or blue) as a glowing sphere.
  Position reads directly from server state — no interpolation needed
  since shells move fast and precision isn't critical visually.

  Enhancement: trailing particles — 8 sprites in a ring buffer recording
  the last N positions, rendered as fading sprites along the trail.
-->
<script lang="ts">
	import { T, useTask } from "@threlte/core";
	import * as THREE from "three";
	import { onDestroy } from "svelte";
	import type { ProjectileState } from "$lib/racing/types.js";

	interface Props {
		projectile: ProjectileState;
	}

	let { projectile }: Props = $props();

	const SHELL_RADIUS = 0.3;
	const TRAIL_COUNT = 8;
	const TRAIL_SPACING = 0.05; // seconds between samples

	const SHELL_COLORS: Record<string, string> = {
		greenShell: "#44FF88",
		redShell: "#FF4444",
		blueShell: "#4488FF",
	};

	const color = $derived(SHELL_COLORS[projectile.type] ?? "#FFFFFF");

	// Trail state
	interface TrailPoint {
		x: number;
		y: number;
		z: number;
		age: number; // seconds since recorded
	}

	const trail: TrailPoint[] = [];
	let trailTimer = 0;
	let trailRefs: (THREE.Mesh | undefined)[] = Array(TRAIL_COUNT).fill(undefined);

	// Trail geometry + material (shared, small spheres)
	const trailGeo = new THREE.SphereGeometry(0.1, 6, 4);
	const trailMats: THREE.MeshBasicMaterial[] = [];

	// Create per-trail-point materials so opacity can differ
	for (let i = 0; i < TRAIL_COUNT; i++) {
		trailMats.push(
			new THREE.MeshBasicMaterial({
				color: "#FFFFFF", // will be set from shell color
				transparent: true,
				opacity: 0.5,
				depthWrite: false,
				blending: THREE.AdditiveBlending,
			}),
		);
	}

	onDestroy(() => {
		trailGeo.dispose();
		trailMats.forEach((m) => m.dispose());
	});

	let groupRef: THREE.Group | undefined;

	useTask((delta) => {
		if (!groupRef) return;

		// Update main position
		groupRef.position.set(
			projectile.position.x,
			projectile.position.y,
			projectile.position.z,
		);

		// Sample trail position
		trailTimer += delta;
		if (trailTimer >= TRAIL_SPACING) {
			trailTimer = 0;
			trail.push({
				x: projectile.position.x,
				y: projectile.position.y,
				z: projectile.position.z,
				age: 0,
			});
			// Keep only TRAIL_COUNT points
			while (trail.length > TRAIL_COUNT) {
				trail.shift();
			}
		}

		// Age trail points
		for (const pt of trail) {
			pt.age += delta;
		}

		// Update trail meshes
		const shellColor = SHELL_COLORS[projectile.type] ?? "#FFFFFF";
		for (let i = 0; i < TRAIL_COUNT; i++) {
			const ref = trailRefs[i];
			if (!ref) continue;

			const pt = trail[trail.length - 1 - i];
			if (pt) {
				ref.visible = true;
				ref.position.set(
					pt.x - projectile.position.x,
					pt.y - projectile.position.y,
					pt.z - projectile.position.z,
				);
				// Fade with distance from head
				const fade = 1 - (i + 1) / (TRAIL_COUNT + 1);
				const mat = ref.material as THREE.MeshBasicMaterial;
				mat.color.set(shellColor);
				mat.opacity = fade * 0.5;
				// Shrink with distance
				const s = fade * 0.8;
				ref.scale.setScalar(s);
			} else {
				ref.visible = false;
			}
		}
	});
</script>

<T.Group
	oncreate={(ref) => { groupRef = ref; }}
	position.x={projectile.position.x}
	position.y={projectile.position.y}
	position.z={projectile.position.z}
>
	<!-- Main shell sphere -->
	<T.Mesh castShadow>
		<T.SphereGeometry args={[SHELL_RADIUS, 16, 12]} />
		<T.MeshStandardMaterial
			{color}
			emissive={color}
			emissiveIntensity={2}
			metalness={0.4}
			roughness={0.2}
		/>
	</T.Mesh>

	<!-- Small point light for glow halo -->
	<T.PointLight
		color={color}
		intensity={1.5}
		distance={3}
		decay={2}
		position.y={0.2}
	/>

	<!-- Trailing particles -->
	{#each Array(TRAIL_COUNT) as _, i}
		<T.Mesh
			geometry={trailGeo}
			material={trailMats[i]}
			oncreate={(ref) => { trailRefs[i] = ref; }}
			visible={false}
		/>
	{/each}
</T.Group>
