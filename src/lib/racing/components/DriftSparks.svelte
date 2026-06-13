<!--
  DriftSparks — particle effect behind a drifting kart.
  Color changes with drift charge level:
    1 = blue (#3399FF)
    2 = orange (#FF8800)
    3 = purple (#CC44FF)

  Placed as a child of the kart group, offset to the rear.
  Renders 8 small emissive spheres with random jitter + upward drift; the
  emissive intensity is pushed past the bloom threshold so the scene's
  UnrealBloomPass carries the glow (no per-spark PointLight).

  Trailing drift SMOKE used to live here too, but it was kart-parented so
  puffs travelled with the car. It now lives in the scene-level SkidMarks
  component (world-space, billboarded, decoupled from the drift flag) so puffs
  trail on the asphalt where they were emitted. Sparks stay local to the kart.
-->
<script lang="ts">
	import { T, useTask } from "@threlte/core";
	import * as THREE from "three";
	import { onDestroy } from "svelte";
	import { DRIFT_CHARGE_COLORS, type DriftCharge } from "$lib/racing/types.js";

	interface Props {
		charge: DriftCharge;
		active: boolean;
		color?: string;
	}

	let { charge, active, color }: Props = $props();

	// -----------------------------------------------------------------------
	// Drift Sparks
	// -----------------------------------------------------------------------
	// Pool is sized for the max tier; lower tiers only animate/show a subset, so
	// charge 1 stays a modest flicker and charge 3 erupts. Nothing is allocated
	// per frame — the visible count is just a draw gate on a fixed pool.
	const SPARK_COUNT = 14;
	const SPARK_RADIUS = 0.09;
	const JITTER_RANGE = 0.4;
	const UPWARD_SPEED = 1.2;
	const RESET_Y = 0.8;
	// How many sparks light up at each charge tier (index = charge-1).
	const TIER_SPARKS = [6, 9, 14];
	// Outward spark fan widens with tier so higher charge throws wider.
	const TIER_SPREAD = [0.7, 0.9, 1.25];

	const sparks: { x: number; y: number; z: number; vy: number }[] = Array.from(
		{ length: SPARK_COUNT },
		() => ({
			x: (Math.random() - 0.5) * JITTER_RANGE,
			y: Math.random() * 0.3,
			z: (Math.random() - 0.5) * 0.2,
			vy: UPWARD_SPEED * (0.5 + Math.random() * 0.5),
		}),
	);

	const sparkGeo = new THREE.SphereGeometry(SPARK_RADIUS, 6, 4);

	const materials = DRIFT_CHARGE_COLORS.map(
		(c) =>
			new THREE.MeshStandardMaterial({
				color: c,
				emissive: c,
				emissiveIntensity: 3,
				transparent: true,
				opacity: 0.9,
				depthWrite: false,
				blending: THREE.AdditiveBlending,
			}),
	);

	// Ground scorch glow — a flat additive disc laid on the asphalt under the
	// rear, tinted to the tier color. Pure bloom-fed glow, no light. Its opacity
	// pulses in useTask, so it gets its own material (shared discs would fight).
	const scorchGeo = new THREE.CircleGeometry(0.55, 20);
	const scorchMats = DRIFT_CHARGE_COLORS.map(
		(c) =>
			new THREE.MeshBasicMaterial({
				color: c,
				transparent: true,
				opacity: 0,
				depthWrite: false,
				blending: THREE.AdditiveBlending,
				side: THREE.DoubleSide,
			}),
	);

	onDestroy(() => {
		sparkGeo.dispose();
		materials.forEach((m) => m.dispose());
		scorchGeo.dispose();
		scorchMats.forEach((m) => m.dispose());
	});

	let sparkRefs: (THREE.Mesh | undefined)[] = Array(SPARK_COUNT).fill(undefined);
	let scorchRef: THREE.Mesh | undefined;

	const visible = $derived(active && charge > 0);
	const matIndex = $derived(Math.max(0, Math.min(charge - 1, 2)));
	const activeSparks = $derived(TIER_SPARKS[matIndex]);
	const spread = $derived(TIER_SPREAD[matIndex]);

	let elapsed = 0;

	useTask((delta) => {
		if (!visible) return;
		elapsed += delta;
		for (let i = 0; i < SPARK_COUNT; i++) {
			const ref = sparkRefs[i];
			// Sparks beyond this tier's count stay parked + hidden (no alloc).
			if (i >= activeSparks) {
				if (ref && ref.visible) ref.visible = false;
				continue;
			}
			const s = sparks[i];
			s.y += s.vy * delta;
			s.x += (Math.random() - 0.5) * JITTER_RANGE * spread * delta * 4;
			s.z += (Math.random() - 0.5) * 0.3 * delta * 4;

			if (s.y > RESET_Y) {
				s.x = (Math.random() - 0.5) * JITTER_RANGE * spread;
				s.y = 0;
				s.z = (Math.random() - 0.5) * 0.2;
				s.vy = UPWARD_SPEED * (0.5 + Math.random() * 0.5);
			}

			if (ref) {
				ref.visible = true;
				ref.position.set(s.x, s.y, s.z);
				// All sparks share one material per charge level, so writing
				// material.opacity here would overwrite itself across sparks —
				// fade via per-spark scale instead. Higher tiers throw bigger
				// sparks, so scale ramps with the tier.
				const fade = 1.0 - s.y / RESET_Y;
				const tierScale = 1 + matIndex * 0.25;
				ref.scale.setScalar(Math.max(0.05, fade) * tierScale);
			}
		}

		// Scorch glow — pulses and grows with tier; only tier 2+ leaves a real
		// scorch (tier 1 sparks barely scuff the road).
		if (scorchRef) {
			const scorchMat = scorchMats[matIndex];
			scorchRef.material = scorchMat;
			const pulse = 0.6 + Math.sin(elapsed * 18) * 0.4;
			const tierGlow = matIndex === 0 ? 0.18 : 0.32 + matIndex * 0.12;
			scorchMat.opacity = tierGlow * pulse;
			const s = 0.8 + matIndex * 0.35;
			scorchRef.scale.setScalar(s);
		}
	});
</script>

{#if visible}
	<!-- Offset group placed at rear of kart -->
	<T.Group position.x={0} position.y={0.15} position.z={0.7}>
		<!-- Ground scorch glow laid flat under the rear; bloom carries the glow. -->
		<T.Mesh
			geometry={scorchGeo}
			material={scorchMats[matIndex]}
			rotation.x={-Math.PI / 2}
			position.y={-0.12}
			renderOrder={4}
			oncreate={(ref) => { scorchRef = ref; }}
		/>
		{#each sparks as spark, i}
			<T.Mesh
				geometry={sparkGeo}
				material={materials[matIndex]}
				oncreate={(ref) => { sparkRefs[i] = ref; }}
				position.x={spark.x}
				position.y={spark.y}
				position.z={spark.z}
			/>
		{/each}
	</T.Group>
{/if}
