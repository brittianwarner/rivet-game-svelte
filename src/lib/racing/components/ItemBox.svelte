<!--
  ItemBox — floating, rotating question-mark cube that grants items on contact.
  Renders a glowing yellow cube with a gentle bob and spin when active.
  When inactive (recently collected), renders nothing.

  Enhancements:
  - 6 orbiting particle sprites around the box
  - Respawn pop animation: scale 0→1.2→1.0 over 300ms when active transitions true
-->
<script lang="ts">
	import { T, useTask } from "@threlte/core";
	import * as THREE from "three";
	import { onDestroy } from "svelte";
	import type { Vec3 } from "$lib/racing/types.js";

	interface Props {
		position: Vec3;
		active: boolean;
	}

	let { position, active }: Props = $props();

	const BOX_SIZE = 1.2;
	const FLOAT_AMPLITUDE = 0.3;
	const FLOAT_FREQUENCY = 1.5;
	const SPIN_SPEED = 1.8;

	// Orbiting particle constants
	const ORBIT_PARTICLE_COUNT = 6;
	const ORBIT_RADIUS = 1.0;
	const ORBIT_SPEED = 2.5;
	const ORBIT_PARTICLE_SIZE = 0.12;

	// Respawn pop animation
	const POP_DURATION = 300; // ms
	const POP_OVERSHOOT = 1.2;

	let groupRef: THREE.Group | undefined;
	let elapsed = 0;
	let orbitParticleRefs: (THREE.Mesh | undefined)[] = Array(ORBIT_PARTICLE_COUNT).fill(undefined);

	// Respawn animation state
	let popStartTime = 0;
	let wasActive = false;
	let popScale = 1;

	const boxGeo = new THREE.BoxGeometry(BOX_SIZE, BOX_SIZE, BOX_SIZE);
	const boxMat = new THREE.MeshStandardMaterial({
		color: "#FFD93D",
		emissive: "#FFD93D",
		emissiveIntensity: 1.5,
		metalness: 0.3,
		roughness: 0.2,
		transparent: true,
		opacity: 0.9,
	});

	// Wireframe outline for extra visibility
	const edgesGeo = new THREE.EdgesGeometry(boxGeo);
	const edgesMat = new THREE.LineBasicMaterial({
		color: "#FFFFFF",
		linewidth: 1,
		transparent: true,
		opacity: 0.6,
	});

	// Orbit particle geometry + material
	const orbitGeo = new THREE.SphereGeometry(ORBIT_PARTICLE_SIZE, 6, 4);
	const orbitMat = new THREE.MeshBasicMaterial({
		color: "#FFD93D",
		transparent: true,
		opacity: 0.7,
		depthWrite: false,
		blending: THREE.AdditiveBlending,
	});

	onDestroy(() => {
		boxGeo.dispose();
		boxMat.dispose();
		edgesGeo.dispose();
		edgesMat.dispose();
		orbitGeo.dispose();
		orbitMat.dispose();
	});

	useTask((delta) => {
		if (!groupRef) return;

		// Detect active transition for pop animation
		if (active && !wasActive) {
			popStartTime = performance.now();
			popScale = 0;
		}
		wasActive = active;

		if (!active) return;

		elapsed += delta;

		// Pop animation: 0 → 1.2 → 1.0 over POP_DURATION ms
		const popElapsed = performance.now() - popStartTime;
		if (popElapsed < POP_DURATION && popStartTime > 0) {
			const t = popElapsed / POP_DURATION;
			if (t < 0.5) {
				// 0 to 1.2
				popScale = t * 2 * POP_OVERSHOOT;
			} else {
				// 1.2 to 1.0
				popScale = POP_OVERSHOOT + (1.0 - POP_OVERSHOOT) * ((t - 0.5) * 2);
			}
		} else {
			popScale = 1;
		}

		groupRef.scale.setScalar(popScale);

		// Gentle Y-axis bob
		groupRef.position.y = position.y + Math.sin(elapsed * FLOAT_FREQUENCY * Math.PI * 2) * FLOAT_AMPLITUDE;

		// Steady spin on Y
		groupRef.rotation.y += SPIN_SPEED * delta;
		// Slight tilt on X for visual interest
		groupRef.rotation.x = Math.sin(elapsed * 0.7) * 0.15;

		// Orbiting particles
		for (let i = 0; i < ORBIT_PARTICLE_COUNT; i++) {
			const ref = orbitParticleRefs[i];
			if (!ref) continue;

			const angle = elapsed * ORBIT_SPEED + (i / ORBIT_PARTICLE_COUNT) * Math.PI * 2;
			const vertAngle = elapsed * 0.8 + i * 0.5;

			ref.position.set(
				Math.cos(angle) * ORBIT_RADIUS,
				Math.sin(vertAngle) * 0.3,
				Math.sin(angle) * ORBIT_RADIUS,
			);

			// Fade based on angle for sparkle effect
			const opacity = 0.4 + Math.sin(angle * 3 + elapsed * 5) * 0.3;
			(ref.material as THREE.MeshBasicMaterial).opacity = Math.max(0.1, opacity);
		}
	});
</script>

{#if active}
	<T.Group
		position.x={position.x}
		position.y={position.y}
		position.z={position.z}
		oncreate={(ref) => { groupRef = ref; }}
	>
		<!-- Main cube -->
		<T.Mesh geometry={boxGeo} material={boxMat} castShadow />

		<!-- Wireframe edges -->
		<T.LineSegments geometry={edgesGeo} material={edgesMat} />

		<!-- Orbiting particle sprites -->
		{#each Array(ORBIT_PARTICLE_COUNT) as _, i}
			<T.Mesh
				geometry={orbitGeo}
				material={orbitMat.clone()}
				oncreate={(ref) => { orbitParticleRefs[i] = ref; }}
			/>
		{/each}

		<!-- Point light for local glow -->
		<T.PointLight
			color="#FFD93D"
			intensity={2}
			distance={4}
			decay={2}
		/>
	</T.Group>
{/if}
