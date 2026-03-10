<!--
  BoostFlame — exhaust flame effect shown when a kart is boosted.
  Renders an emissive cone + sphere at the rear of the kart with
  a flickering intensity animated via useTask.

  Placed as a child of the kart group (rear-facing).

  Fix: Use $derived for geometry sizes instead of capturing `intensity`
  in const declarations at top-level (avoids Svelte warning about
  reactive values being captured in static expressions).
-->
<script lang="ts">
	import { T, useTask } from "@threlte/core";
	import * as THREE from "three";
	import { onDestroy } from "svelte";

	interface Props {
		active: boolean;
		intensity?: number;
	}

	let { active, intensity = 1 }: Props = $props();

	const FLAME_COLOR = "#FF6622";
	const INNER_COLOR = "#FFAA44";

	// Use $derived for geometry dimensions so they react to intensity changes
	const coneRadius = $derived(0.22 * intensity);
	const coneHeight = $derived(0.9 * intensity);
	const sphereRadius = $derived(0.18 * intensity);

	// Geometries rebuilt when intensity-derived dimensions change
	let coneGeo: THREE.ConeGeometry | undefined;
	let sphereGeo: THREE.SphereGeometry | undefined;

	$effect(() => {
		// Rebuild geometries when derived dimensions change
		coneGeo?.dispose();
		sphereGeo?.dispose();

		const newCone = new THREE.ConeGeometry(coneRadius, coneHeight, 8);
		newCone.rotateX(Math.PI / 2);
		coneGeo = newCone;

		sphereGeo = new THREE.SphereGeometry(sphereRadius, 8, 6);
	});

	const flameMat = new THREE.MeshStandardMaterial({
		color: FLAME_COLOR,
		emissive: FLAME_COLOR,
		emissiveIntensity: 3,
		transparent: true,
		opacity: 0.85,
		depthWrite: false,
		blending: THREE.AdditiveBlending,
		side: THREE.DoubleSide,
	});

	const innerMat = new THREE.MeshStandardMaterial({
		color: INNER_COLOR,
		emissive: INNER_COLOR,
		emissiveIntensity: 4,
		transparent: true,
		opacity: 0.7,
		depthWrite: false,
		blending: THREE.AdditiveBlending,
	});

	onDestroy(() => {
		coneGeo?.dispose();
		sphereGeo?.dispose();
		flameMat.dispose();
		innerMat.dispose();
	});

	let groupRef: THREE.Group | undefined;
	let elapsed = 0;

	useTask((delta) => {
		if (!groupRef || !active) return;

		elapsed += delta;

		// Flicker: rapidly oscillating scale and opacity
		const flicker = 0.8 + Math.sin(elapsed * 35) * 0.15 + Math.sin(elapsed * 53) * 0.05;
		const scaleY = intensity * flicker;
		const scaleXZ = intensity * (0.9 + Math.sin(elapsed * 42) * 0.1);

		groupRef.scale.set(scaleXZ, scaleXZ, scaleY);

		// Flicker opacity
		flameMat.opacity = 0.7 + Math.sin(elapsed * 40) * 0.15;
		flameMat.emissiveIntensity = 2.5 + Math.sin(elapsed * 30) * 1.0;
		innerMat.emissiveIntensity = 3.5 + Math.sin(elapsed * 45) * 1.5;
	});
</script>

{#if active}
	<!-- Positioned at rear of kart, slightly above ground -->
	<T.Group
		position.x={0}
		position.y={0.2}
		position.z={0.5}
		oncreate={(ref) => { groupRef = ref; }}
	>
		<!-- Outer flame cone -->
		{#if coneGeo}
			<T.Mesh
				geometry={coneGeo}
				material={flameMat}
				position.z={0.4}
			/>
		{/if}

		<!-- Inner bright core -->
		{#if sphereGeo}
			<T.Mesh
				geometry={sphereGeo}
				material={innerMat}
			/>
		{/if}

		<!-- Dynamic point light -->
		<T.PointLight
			color={FLAME_COLOR}
			intensity={4 * intensity}
			distance={5}
			decay={2}
		/>
	</T.Group>
{/if}
