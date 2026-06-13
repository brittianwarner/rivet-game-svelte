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
	import { untrack } from "svelte";
	import * as THREE from "three";
	import { onDestroy } from "svelte";

	interface Props {
		active: boolean;
		intensity?: number;
	}

	let { active, intensity = 1 }: Props = $props();

	const FLAME_COLOR = "#FF6622";
	const INNER_COLOR = "#FFAA44";
	// White-hot core, pushed hardest past the bloom threshold for the brightest
	// point of the flame (reads as combustion, not just a tinted glow).
	const CORE_COLOR = "#FFFFEE";

	// Use $derived for geometry dimensions so they react to intensity changes
	const coneRadius = $derived(0.22 * intensity);
	const coneHeight = $derived(0.9 * intensity);
	const sphereRadius = $derived(0.18 * intensity);
	const coreRadius = $derived(0.1 * intensity);

	// Geometries rebuilt when intensity-derived dimensions change
	let coneGeo = $state<THREE.ConeGeometry | undefined>(undefined);
	let sphereGeo = $state<THREE.SphereGeometry | undefined>(undefined);
	let coreGeo = $state<THREE.SphereGeometry | undefined>(undefined);

	$effect(() => {
		// Rebuild geometries when derived dimensions change
		untrack(() => {
			coneGeo?.dispose();
			sphereGeo?.dispose();
			coreGeo?.dispose();
		});

		const newCone = new THREE.ConeGeometry(coneRadius, coneHeight, 8);
		newCone.rotateX(Math.PI / 2);
		coneGeo = newCone;

		sphereGeo = new THREE.SphereGeometry(sphereRadius, 8, 6);
		coreGeo = new THREE.SphereGeometry(coreRadius, 8, 6);
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

	const coreMat = new THREE.MeshStandardMaterial({
		color: CORE_COLOR,
		emissive: CORE_COLOR,
		emissiveIntensity: 6,
		transparent: true,
		opacity: 0.9,
		depthWrite: false,
		blending: THREE.AdditiveBlending,
	});

	onDestroy(() => {
		coneGeo?.dispose();
		sphereGeo?.dispose();
		coreGeo?.dispose();
		flameMat.dispose();
		innerMat.dispose();
		coreMat.dispose();
	});

	let groupRef: THREE.Group | undefined;
	let coreRef: THREE.Mesh | undefined;
	let elapsed = 0;

	useTask((delta) => {
		if (!groupRef || !active) return;

		elapsed += delta;

		// Flicker: rapidly oscillating scale and opacity. Layered sines at
		// incommensurate rates keep the flame from looking like a clean pulse —
		// it sputters. The tail (z) flicker is deeper than the girth (xz) so the
		// flame visibly lengthens and snaps back like real exhaust.
		const flicker =
			0.78 + Math.sin(elapsed * 35) * 0.18 + Math.sin(elapsed * 53) * 0.08;
		const scaleY = intensity * flicker;
		const scaleXZ = intensity * (0.88 + Math.sin(elapsed * 42) * 0.12);

		groupRef.scale.set(scaleXZ, scaleXZ, scaleY);

		// Flicker opacity + emissive. The core is pushed hard and fast so it
		// strobes brightest at the combustion point; the bloom pass smears it.
		flameMat.opacity = 0.68 + Math.sin(elapsed * 40) * 0.17;
		flameMat.emissiveIntensity = 2.6 + Math.sin(elapsed * 30) * 1.1;
		innerMat.emissiveIntensity = 3.6 + Math.sin(elapsed * 45) * 1.6;
		coreMat.emissiveIntensity = 5.5 + Math.sin(elapsed * 60) * 2.0;

		// Subtle independent jitter on the core so it doesn't sit dead-center.
		if (coreRef) {
			coreRef.position.x = Math.sin(elapsed * 47) * 0.03;
			coreRef.position.y = Math.cos(elapsed * 38) * 0.03;
		}
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

		<!-- Inner bright core — emissive past the bloom threshold; the bloom
		     pass provides the glow (no PointLight, which forced a shader
		     recompile every time a boost started or ended) -->
		{#if sphereGeo}
			<T.Mesh
				geometry={sphereGeo}
				material={innerMat}
			/>
		{/if}

		<!-- White-hot combustion core — brightest point, pushed hardest past the
		     bloom threshold so it blooms into a hot spark at the nozzle. -->
		{#if coreGeo}
			<T.Mesh
				geometry={coreGeo}
				material={coreMat}
				oncreate={(ref) => { coreRef = ref; }}
			/>
		{/if}
	</T.Group>
{/if}
