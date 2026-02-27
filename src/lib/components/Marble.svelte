<!--
  Marble — "Elemental Core" design (optimized).
  
  6-layer procedural marble with:
  1. Inner Core — MeshBasicMaterial, self-lit, pulsing
  2. Main Shell — MeshPhysicalMaterial, clearcoat glass (no transmission — avoids FBO)
  3. Orbiting Rings — Torus + custom Fresnel ShaderMaterial (3 local / 1 remote)
  4. Floating Particles — Points with figure-8 orbits (8 local / 4 remote)
  5. Glow Aura — FakeGlowMaterial (Fresnel-based, no post-processing)
  6. Outline — Outlines (local player only)

  Performance notes:
  - All refs are plain `let` (no $state proxy overhead in useTask)
  - Ring materials pre-created in script (no factory calls in template)
  - target.x/y/z snapshotted once per frame (3 proxy reads, not 6)
  - Zero heap allocations inside useTask
  - onDestroy disposes all per-instance GPU resources
  - No transmission = no FBO re-render passes
-->
<script lang="ts">
	import { T, useTask } from "@threlte/core";
	import { FakeGlowMaterial, Outlines } from "@threlte/extras";
	import { onDestroy } from "svelte";
	import * as THREE from "three";
	import type { Vec3 } from "$lib/game/types";
	import {
		MARBLE_RADIUS,
		CORE_RADIUS_RATIO,
		BASE_RING_SPEED,
		MAX_RING_SPEED,
		CORE_PULSE_IDLE_FREQ,
		CORE_PULSE_MOVE_FREQ,
		PARTICLE_ORBIT_MIN,
		PARTICLE_ORBIT_MAX,
		COLLISION_FLASH_DURATION,
		COLLISION_ACCEL_THRESHOLD,
		ESTIMATED_MAX_SPEED,
	} from "$lib/game/types";
	import {
		getCoreGeometry,
		getShellGeometry,
		getRingGeometry,
		getGlowGeometry,
	} from "$lib/game/marble-geometry";
	import { ringVertexShader, ringFragmentShader } from "$lib/game/ring-shader";

	// -----------------------------------------------------------------------
	// Props (backward compatible)
	// -----------------------------------------------------------------------
	interface Props {
		color: string;
		target: Vec3;
		isLocal?: boolean;
		name?: string;
	}

	let { color, target, isLocal = false }: Props = $props();

	// -----------------------------------------------------------------------
	// Constants (hoisted from template — no ternary re-evaluation per render)
	// -----------------------------------------------------------------------
	const LERP_SPEED = 15;
	const LOCAL_RING_COUNT = 3;
	const REMOTE_RING_COUNT = 1;
	const LOCAL_PARTICLE_COUNT = 8;
	const REMOTE_PARTICLE_COUNT = 4;

	const ringCount = isLocal ? LOCAL_RING_COUNT : REMOTE_RING_COUNT;
	const particleCount = isLocal ? LOCAL_PARTICLE_COUNT : REMOTE_PARTICLE_COUNT;
	const baseRingIntensity = isLocal ? 1.2 : 0.8;
	const glowFalloff = isLocal ? 2.5 : 3.5;

	// Static array for {#each} — avoids transient { length: N } object per render
	const ringIndices = Array.from({ length: ringCount }, (_, i) => i);

	// -----------------------------------------------------------------------
	// Three.js refs — plain `let`, NOT $state (avoids proxy overhead in useTask)
	// -----------------------------------------------------------------------
	let groupRef: THREE.Group | undefined;
	let coreRef: THREE.Mesh | undefined;
	// Threlte oncreate returns a broader Points generic — we only need the truthy check
	let particlesRef: THREE.Object3D | undefined;

	// Ring refs stored in plain array (set via oncreate)
	const ringMeshes: (THREE.Mesh | undefined)[] = Array(ringCount).fill(undefined);

	// -----------------------------------------------------------------------
	// Shared geometries (lazy singletons — NOT disposed per instance)
	// -----------------------------------------------------------------------
	const coreGeo = getCoreGeometry();
	const shellGeo = getShellGeometry();
	const ringGeo = getRingGeometry();
	const glowGeo = getGlowGeometry();

	// -----------------------------------------------------------------------
	// Materials (created once per marble instance, disposed in onDestroy)
	// -----------------------------------------------------------------------
	const threeColor = new THREE.Color(color);

	// Layer 1: Inner core — self-lit, ignores scene lighting
	const coreMaterial = new THREE.MeshBasicMaterial({
		color: threeColor,
		transparent: true,
		opacity: 0.95,
	});

	// Layer 2: Shell — clearcoat glass WITHOUT transmission (no FBO re-render)
	// The inner core provides the visible color "through" the frosted shell.
	// clearcoat + env map reflections create the glass look without 8x FBO cost.
	const shellMaterial = new THREE.MeshPhysicalMaterial({
		color: threeColor,
		transparent: true,
		opacity: 0.25,
		roughness: 0.15,
		metalness: 0.0,
		clearcoat: 1.0,
		clearcoatRoughness: 0.1,
		envMapIntensity: 1.5,
		side: THREE.FrontSide,
		depthWrite: false,
	});

	// Layer 3: Ring ShaderMaterials — pre-created (NOT factory-called in template)
	const ringUniforms: { uColor: { value: THREE.Color }; uTime: { value: number }; uIntensity: { value: number } }[] = [];
	const ringMaterials: THREE.ShaderMaterial[] = [];

	for (let i = 0; i < ringCount; i++) {
		const uniforms = {
			uColor: { value: threeColor.clone() },
			uTime: { value: 0 },
			uIntensity: { value: baseRingIntensity },
		};
		ringUniforms.push(uniforms);
		ringMaterials.push(
			new THREE.ShaderMaterial({
				vertexShader: ringVertexShader,
				fragmentShader: ringFragmentShader,
				uniforms,
				transparent: true,
				depthWrite: false,
				blending: THREE.AdditiveBlending,
				side: THREE.DoubleSide,
			}),
		);
	}

	// Layer 4: Particle geometry + material
	const particlePositions = new Float32Array(particleCount * 3);
	const particleGeometry = new THREE.BufferGeometry();
	particleGeometry.setAttribute("position", new THREE.BufferAttribute(particlePositions, 3));

	// Cache the position attribute ref — avoids per-frame lookup + cast
	const particlePosAttr = particleGeometry.getAttribute("position") as THREE.BufferAttribute;

	const particleMaterial = new THREE.PointsMaterial({
		color: threeColor,
		size: 0.04,
		transparent: true,
		opacity: 0.7,
		sizeAttenuation: true,
		depthWrite: false,
		blending: THREE.AdditiveBlending,
	});

	// -----------------------------------------------------------------------
	// Disposal — free all per-instance GPU resources when marble is destroyed
	// -----------------------------------------------------------------------
	onDestroy(() => {
		coreMaterial.dispose();
		shellMaterial.dispose();
		particleGeometry.dispose();
		particleMaterial.dispose();
		for (const mat of ringMaterials) mat.dispose();
		// Shared singletons (coreGeo, shellGeo, ringGeo, glowGeo) are NOT disposed
	});

	// -----------------------------------------------------------------------
	// Animation state (non-reactive, mutated in-place each frame)
	// -----------------------------------------------------------------------
	let initialized = false;
	let elapsed = 0;
	let prevPos = { x: 0, y: 0, z: 0 };
	let prevSpeed = 0;
	let speedNorm = 0; // 0..1 normalized speed

	// Collision flash state
	let flashTimer = 0;
	let isFlashing = false;

	// Ring rotation accumulators
	const ringAngles: number[] = Array(ringCount).fill(0);

	// Ring tilt angles (fixed per ring, varied spread)
	const ringTiltAngles: number[] = [];
	for (let i = 0; i < ringCount; i++) {
		ringTiltAngles.push(Math.PI * 0.2 + i * Math.PI * 0.25);
	}

	// Reusable Three.js objects (avoid per-frame allocations)
	const _euler = new THREE.Euler();

	// -----------------------------------------------------------------------
	// useTask — single render loop callback for all animation
	// Zero heap allocations. All proxy reads snapshotted at top.
	// -----------------------------------------------------------------------
	useTask((delta) => {
		if (!groupRef) return;

		// -- Snapshot target from $state proxy (3 reads, not 6) ---------------
		const tx = target.x;
		const ty = target.y;
		const tz = target.z;

		// -- Position interpolation ------------------------------------------
		if (!initialized) {
			groupRef.position.set(tx, ty, tz);
			prevPos.x = tx;
			prevPos.y = ty;
			prevPos.z = tz;
			initialized = true;
			return;
		}

		const t = Math.min(1, LERP_SPEED * delta);
		groupRef.position.x += (tx - groupRef.position.x) * t;
		groupRef.position.y += (ty - groupRef.position.y) * t;
		groupRef.position.z += (tz - groupRef.position.z) * t;

		// -- Velocity estimation (for visual intensity scaling) ---------------
		const invDt = 1 / Math.max(delta, 0.001);
		const vx = (groupRef.position.x - prevPos.x) * invDt;
		const vz = (groupRef.position.z - prevPos.z) * invDt;
		prevPos.x = groupRef.position.x;
		prevPos.y = groupRef.position.y;
		prevPos.z = groupRef.position.z;

		const speed = Math.sqrt(vx * vx + vz * vz);
		speedNorm = Math.min(1, speed / ESTIMATED_MAX_SPEED);

		// -- Collision detection (frame-to-frame speed delta) -----------------
		// Compare current speed to previous frame's speed. A sudden spike
		// indicates a collision impulse from the server physics.
		const speedDelta = Math.abs(speed - prevSpeed) / Math.max(delta, 0.001);
		prevSpeed = speed;

		if (speed > 0.5 && speedDelta > COLLISION_ACCEL_THRESHOLD && !isFlashing) {
			isFlashing = true;
			flashTimer = COLLISION_FLASH_DURATION;
		}
		if (isFlashing) {
			flashTimer -= delta;
			if (flashTimer <= 0) {
				isFlashing = false;
				flashTimer = 0;
			}
		}

		elapsed += delta;

		// -- Layer 1: Core pulse animation -----------------------------------
		if (coreRef) {
			const pulseFreq = CORE_PULSE_IDLE_FREQ + speedNorm * (CORE_PULSE_MOVE_FREQ - CORE_PULSE_IDLE_FREQ);
			const pulseScale = 1.0 + 0.08 * Math.sin(elapsed * pulseFreq * Math.PI * 2);
			const collisionScale = isFlashing ? 1.0 + 0.3 * (flashTimer / COLLISION_FLASH_DURATION) : 1.0;
			// Simplified: set scale directly as multiplier (no redundant multiply/divide)
			const s = pulseScale * collisionScale;
			coreRef.scale.setScalar(s);

			// Flash brightness — write to the typed material directly (no cast)
			coreMaterial.opacity = isFlashing
				? 0.95 + 0.05 * (flashTimer / COLLISION_FLASH_DURATION)
				: 0.95;
		}

		// -- Layer 3: Ring rotation ------------------------------------------
		const ringSpeed = BASE_RING_SPEED + speedNorm * (MAX_RING_SPEED - BASE_RING_SPEED);
		for (let i = 0; i < ringCount; i++) {
			const mesh = ringMeshes[i];
			if (!mesh) continue;

			// Accumulate rotation
			const direction = i % 2 === 0 ? 1 : -1;
			ringAngles[i] += ringSpeed * direction * delta;

			// Apply tilt (X) + spin (Y) via Euler — simple and sufficient for torus rings
			_euler.set(ringTiltAngles[i], ringAngles[i], 0);
			mesh.quaternion.setFromEuler(_euler);

			// Update shader uniforms
			ringUniforms[i].uTime.value = elapsed;
			ringUniforms[i].uIntensity.value = isFlashing
				? baseRingIntensity + 1.5 * (flashTimer / COLLISION_FLASH_DURATION)
				: baseRingIntensity;
		}

		// -- Layer 4: Particle figure-8 orbit --------------------------------
		if (particlesRef) {
			const orbitRadius = MARBLE_RADIUS * (PARTICLE_ORBIT_MIN + speedNorm * (PARTICLE_ORBIT_MAX - PARTICLE_ORBIT_MIN));
			const orbitSpeed = 0.8 + speedNorm * 0.6;

			for (let i = 0; i < particleCount; i++) {
				const phase = (i / particleCount) * Math.PI * 2;
				const angle = elapsed * orbitSpeed + phase;

				// Cache sin/cos to avoid duplicate trig calls
				const sinA = Math.sin(angle);
				const cosA = Math.cos(angle);

				// Figure-8 lemniscate (Bernoulli) in XZ plane, Y oscillates
				const figureX = orbitRadius * sinA;
				const figureZ = orbitRadius * sinA * cosA;
				const figureY = 0.15 * Math.sin(angle * 2 + phase);

				particlePosAttr.setXYZ(i, figureX, figureY, figureZ);
			}

			particlePosAttr.needsUpdate = true;
		}
	});
</script>

<T.Group oncreate={(ref) => { groupRef = ref; }}>
	<!-- Layer 1: Inner Core (self-lit, pulsing) -->
	<T.Mesh
		oncreate={(ref) => { coreRef = ref; }}
		geometry={coreGeo}
		material={coreMaterial}
	/>

	<!-- Layer 2: Clearcoat Glass Shell (no transmission — no FBO pass) -->
	<T.Mesh
		geometry={shellGeo}
		material={shellMaterial}
		castShadow
	>
		<!-- Layer 6: Outline (local player only) -->
		{#if isLocal}
			<Outlines
				color={color}
				thickness={0.03}
				transparent
				opacity={0.6}
			/>
		{/if}
	</T.Mesh>

	<!-- Layer 3: Orbiting Rings (pre-created materials, static array) -->
	{#each ringIndices as i (i)}
		<T.Mesh
			geometry={ringGeo}
			material={ringMaterials[i]}
			oncreate={(ref) => { ringMeshes[i] = ref; }}
		/>
	{/each}

	<!-- Layer 4: Floating Particles (figure-8 orbit) -->
	<T.Points
		oncreate={(ref) => { particlesRef = ref; }}
		geometry={particleGeometry}
		material={particleMaterial}
	/>

	<!-- Layer 5: Glow Aura (FakeGlowMaterial — Fresnel, no bloom pass) -->
	<T.Mesh geometry={glowGeo}>
		<FakeGlowMaterial
			glowColor={color}
			falloff={glowFalloff}
			glowInternalRadius={4.0}
			glowSharpness={0.3}
		/>
	</T.Mesh>
</T.Group>
