<!--
  DriftSparks — particle effect behind a drifting kart.
  Color changes with drift charge level:
    1 = blue (#3399FF)
    2 = orange (#FF8800)
    3 = purple (#CC44FF)

  Placed as a child of the kart group, offset to the rear.
  Renders 5 small emissive spheres with random jitter + upward drift.

  Enhancement: DriftSmoke — 10 billboard sprites that spawn at rear wheels
  during drift, expand, rise, and fade. White-to-transparent with drift
  charge color tint.
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
	// Drift Sparks (existing)
	// -----------------------------------------------------------------------
	const SPARK_COUNT = 5;
	const SPARK_RADIUS = 0.06;
	const JITTER_RANGE = 0.4;
	const UPWARD_SPEED = 1.2;
	const RESET_Y = 0.8;

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

	// -----------------------------------------------------------------------
	// Drift Smoke (new enhancement)
	// -----------------------------------------------------------------------
	const SMOKE_COUNT = 10;
	const SMOKE_LIFETIME = 0.8; // seconds per smoke puff
	const SMOKE_EXPAND_RATE = 2.0;
	const SMOKE_RISE_SPEED = 1.5;
	const SMOKE_SIZE = 0.15;

	interface SmokeParticle {
		x: number;
		y: number;
		z: number;
		age: number;
		scale: number;
		active: boolean;
	}

	const smokePuffs: SmokeParticle[] = Array.from(
		{ length: SMOKE_COUNT },
		() => ({
			x: 0, y: 0, z: 0,
			age: 0, scale: 0.1, active: false,
		}),
	);

	let smokeSpawnTimer = 0;
	const SMOKE_SPAWN_INTERVAL = 0.06; // seconds between spawns

	const smokeGeo = new THREE.PlaneGeometry(SMOKE_SIZE, SMOKE_SIZE);
	const smokeMats: THREE.MeshBasicMaterial[] = Array.from(
		{ length: SMOKE_COUNT },
		() => new THREE.MeshBasicMaterial({
			color: "#FFFFFF",
			transparent: true,
			opacity: 0.4,
			depthWrite: false,
			blending: THREE.NormalBlending,
			side: THREE.DoubleSide,
		}),
	);

	let smokeRefs: (THREE.Mesh | undefined)[] = Array(SMOKE_COUNT).fill(undefined);

	onDestroy(() => {
		sparkGeo.dispose();
		materials.forEach((m) => m.dispose());
		smokeGeo.dispose();
		smokeMats.forEach((m) => m.dispose());
	});

	let sparkRefs: (THREE.Mesh | undefined)[] = Array(SPARK_COUNT).fill(undefined);

	const visible = $derived(active && charge > 0);
	const matIndex = $derived(Math.max(0, Math.min(charge - 1, 2)));

	useTask((delta) => {
		// ----- Sparks -----
		if (visible) {
			for (let i = 0; i < SPARK_COUNT; i++) {
				const s = sparks[i];
				s.y += s.vy * delta;
				s.x += (Math.random() - 0.5) * JITTER_RANGE * delta * 4;
				s.z += (Math.random() - 0.5) * 0.3 * delta * 4;

				if (s.y > RESET_Y) {
					s.x = (Math.random() - 0.5) * JITTER_RANGE;
					s.y = 0;
					s.z = (Math.random() - 0.5) * 0.2;
					s.vy = UPWARD_SPEED * (0.5 + Math.random() * 0.5);
				}

				const ref = sparkRefs[i];
				if (ref) {
					ref.position.set(s.x, s.y, s.z);
					const opacity = 1.0 - s.y / RESET_Y;
					(ref.material as THREE.MeshStandardMaterial).opacity = opacity * 0.9;
				}
			}
		}

		// ----- Drift Smoke -----
		if (active) {
			// Spawn new smoke puffs
			smokeSpawnTimer += delta;
			if (smokeSpawnTimer >= SMOKE_SPAWN_INTERVAL) {
				smokeSpawnTimer = 0;
				// Find an inactive puff
				for (let i = 0; i < SMOKE_COUNT; i++) {
					if (!smokePuffs[i].active) {
						smokePuffs[i].active = true;
						smokePuffs[i].age = 0;
						smokePuffs[i].scale = 0.1;
						// Spawn at left or right rear wheel position (alternating)
						const side = i % 2 === 0 ? -0.4 : 0.4;
						smokePuffs[i].x = side + (Math.random() - 0.5) * 0.1;
						smokePuffs[i].y = 0;
						smokePuffs[i].z = (Math.random() - 0.5) * 0.15;
						break;
					}
				}
			}

			// Update smoke puffs
			const chargeColorHex = charge > 0 ? DRIFT_CHARGE_COLORS[Math.min(charge - 1, 2)] : "#FFFFFF";
			for (let i = 0; i < SMOKE_COUNT; i++) {
				const puff = smokePuffs[i];
				const ref = smokeRefs[i];
				if (!ref) continue;

				if (!puff.active) {
					ref.visible = false;
					continue;
				}

				puff.age += delta;
				if (puff.age > SMOKE_LIFETIME) {
					puff.active = false;
					ref.visible = false;
					continue;
				}

				ref.visible = true;

				// Expand
				puff.scale += SMOKE_EXPAND_RATE * delta;
				// Rise
				puff.y += SMOKE_RISE_SPEED * delta;

				ref.position.set(puff.x, puff.y, puff.z);
				ref.scale.setScalar(puff.scale);

				// Fade from visible to transparent
				const lifeRatio = puff.age / SMOKE_LIFETIME;
				const mat = smokeMats[i];
				mat.opacity = 0.4 * (1 - lifeRatio);
				// Tint with charge color
				if (charge > 0) {
					// Blend from white to charge color based on charge level
					const blendAmt = Math.min(charge / 3, 0.5);
					const white = new THREE.Color("#FFFFFF");
					const tint = new THREE.Color(chargeColorHex);
					mat.color.copy(white).lerp(tint, blendAmt);
				} else {
					mat.color.set("#FFFFFF");
				}
			}
		} else {
			// Hide all smoke when not drifting
			for (let i = 0; i < SMOKE_COUNT; i++) {
				smokePuffs[i].active = false;
				const ref = smokeRefs[i];
				if (ref) ref.visible = false;
			}
			smokeSpawnTimer = 0;
		}
	});
</script>

{#if visible}
	<!-- Offset group placed at rear of kart -->
	<T.Group position.x={0} position.y={0.1} position.z={0.7}>
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

		<!-- Charge-colored point light -->
		<T.PointLight
			color={DRIFT_CHARGE_COLORS[matIndex]}
			intensity={1 + charge}
			distance={2.5}
			decay={2}
		/>
	</T.Group>
{/if}

<!-- Drift Smoke — always rendered when actively drifting (even at charge 0) -->
{#if active}
	<T.Group position.x={0} position.y={0.05} position.z={0.8}>
		{#each Array(SMOKE_COUNT) as _, i}
			<T.Mesh
				geometry={smokeGeo}
				material={smokeMats[i]}
				oncreate={(ref) => { smokeRefs[i] = ref; }}
				visible={false}
			/>
		{/each}
	</T.Group>
{/if}
