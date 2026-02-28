<!--
  Ball — the soccer ball entity.
  White sphere with glow, velocity-scaled trail colored by last toucher.
  Lerps to server position like Marble.svelte.
-->
<script lang="ts">
	import { T, useTask } from "@threlte/core";
	import { FakeGlowMaterial } from "@threlte/extras";
	import { onDestroy } from "svelte";
	import * as THREE from "three";
	import type { Vec3 } from "$lib/game/types";
	import { BALL_RADIUS, BALL_COLOR, TEAM_COLORS } from "$lib/game/types";
	import { getGameStore } from "$lib/game/context";

	const store = getGameStore();

	const LERP_SPEED = 15;
	const TRAIL_LENGTH = 8;
	const GLOW_RADIUS = BALL_RADIUS * 2.5;

	let groupRef: THREE.Group | undefined;

	// Geometries
	const ballGeo = new THREE.SphereGeometry(BALL_RADIUS, 24, 16);
	const glowGeo = new THREE.IcosahedronGeometry(GLOW_RADIUS, 3);

	// Materials
	const ballMaterial = new THREE.MeshPhysicalMaterial({
		color: 0xffffff,
		emissive: 0xffffff,
		emissiveIntensity: 0.3,
		metalness: 0.1,
		roughness: 0.3,
		clearcoat: 1.0,
		clearcoatRoughness: 0.1,
	});

	// Trail
	const trailPositions = new Float32Array(TRAIL_LENGTH * 3);
	const trailColors = new Float32Array(TRAIL_LENGTH * 4);
	const trailGeo = new THREE.BufferGeometry();
	trailGeo.setAttribute("position", new THREE.BufferAttribute(trailPositions, 3));
	trailGeo.setAttribute("color", new THREE.BufferAttribute(trailColors, 4));
	const trailMaterial = new THREE.PointsMaterial({
		size: 0.08,
		transparent: true,
		opacity: 0.6,
		vertexColors: true,
		sizeAttenuation: true,
		depthWrite: false,
		blending: THREE.AdditiveBlending,
	});

	let trailRef: THREE.Object3D | undefined;
	const trailPosAttr = trailGeo.getAttribute("position") as THREE.BufferAttribute;
	const trailColAttr = trailGeo.getAttribute("color") as THREE.BufferAttribute;

	onDestroy(() => {
		ballGeo.dispose();
		glowGeo.dispose();
		ballMaterial.dispose();
		trailGeo.dispose();
		trailMaterial.dispose();
	});

	let initialized = false;
	let lastBallX = 0;
	let lastBallZ = 0;
	let ballSnapshotTime = 0;

	// Ring buffer for trail (zero allocations per frame)
	const trailRing: { x: number; y: number; z: number }[] =
		Array.from({ length: TRAIL_LENGTH }, () => ({ x: 0, y: -10, z: 0 }));
	let trailHead = 0;
	let trailFilled = 0;

	// Cached trail color (only recomputed when lastTouchedBy changes)
	const _trailColor = new THREE.Color(0xffffff);
	const _white = new THREE.Color(0xffffff);
	let _cachedToucherId: string | null = "__unset__";

	function updateTrailColor(): THREE.Color {
		const toucherId = store.ball.lastTouchedBy;
		if (toucherId === _cachedToucherId) return toucherId ? _trailColor : _white;
		_cachedToucherId = toucherId;
		if (!toucherId) return _white;
		const player = store.players[toucherId];
		if (!player) { return _white; }
		_trailColor.set(player.color);
		return _trailColor;
	}

	useTask((delta) => {
		if (!groupRef) return;

		// Snapshot store values at top of frame to minimize proxy reads
		const ball = store.ball;
		const tx = ball.position.x;
		const ty = ball.position.y;
		const tz = ball.position.z;
		const vx = ball.velocity.x;
		const vz = ball.velocity.z;

		// Detect new snapshot arrival
		if (tx !== lastBallX || tz !== lastBallZ) {
			lastBallX = tx;
			lastBallZ = tz;
			ballSnapshotTime = performance.now();
		}

		// Extrapolate target using velocity
		const extrapSec = Math.min((performance.now() - ballSnapshotTime) / 1000, 0.05);
		const etx = tx + vx * extrapSec * 60;
		const etz = tz + vz * extrapSec * 60;

		if (!initialized) {
			groupRef.position.set(tx, ty, tz);
			initialized = true;
			return;
		}

		const t = Math.min(1, LERP_SPEED * delta);
		groupRef.position.x += (etx - groupRef.position.x) * t;
		groupRef.position.y += (ty - groupRef.position.y) * t;
		groupRef.position.z += (etz - groupRef.position.z) * t;

		// Velocity-scaled glow
		const speed = Math.sqrt(vx * vx + vz * vz);
		ballMaterial.emissiveIntensity = 0.3 + Math.min(speed * 3, 1.5);

		// Update trail ring buffer (O(1), zero allocations)
		const entry = trailRing[trailHead];
		entry.x = groupRef.position.x;
		entry.y = groupRef.position.y;
		entry.z = groupRef.position.z;
		trailHead = (trailHead + 1) % TRAIL_LENGTH;
		if (trailFilled < TRAIL_LENGTH) trailFilled++;

		const trailColor = updateTrailColor();

		for (let i = 0; i < TRAIL_LENGTH; i++) {
			if (i < trailFilled) {
				const idx = (trailHead - 1 - i + TRAIL_LENGTH) % TRAIL_LENGTH;
				const opacity = 1.0 - i / TRAIL_LENGTH;
				trailPosAttr.setXYZ(i, trailRing[idx].x, trailRing[idx].y, trailRing[idx].z);
				trailColAttr.setXYZW(i, trailColor.r, trailColor.g, trailColor.b, opacity * 0.5);
			} else {
				trailPosAttr.setXYZ(i, 0, -10, 0);
				trailColAttr.setXYZW(i, 0, 0, 0, 0);
			}
		}
		trailPosAttr.needsUpdate = true;
		trailColAttr.needsUpdate = true;
	});
</script>

<T.Group oncreate={(ref) => { groupRef = ref; }}>
	<!-- Main ball sphere -->
	<T.Mesh
		geometry={ballGeo}
		material={ballMaterial}
		castShadow
	/>

	<!-- Glow aura -->
	<T.Mesh geometry={glowGeo}>
		<FakeGlowMaterial
			glowColor={BALL_COLOR}
			falloff={3.0}
			glowInternalRadius={4.0}
			glowSharpness={0.3}
		/>
	</T.Mesh>
</T.Group>

<!-- Trail (rendered in world space, not parented to ball group) -->
<T.Points
	oncreate={(ref) => { trailRef = ref; }}
	geometry={trailGeo}
	material={trailMaterial}
/>
