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
	let trailHistory: { x: number; y: number; z: number }[] = [];

	function getLastToucherColor(): THREE.Color {
		const toucherId = store.ball.lastTouchedBy;
		if (!toucherId) return new THREE.Color(0xffffff);
		const player = store.players[toucherId];
		if (!player) return new THREE.Color(0xffffff);
		return new THREE.Color(player.color);
	}

	useTask((delta) => {
		if (!groupRef) return;

		const tx = store.ball.position.x;
		const ty = store.ball.position.y;
		const tz = store.ball.position.z;

		if (!initialized) {
			groupRef.position.set(tx, ty, tz);
			initialized = true;
			return;
		}

		const t = Math.min(1, LERP_SPEED * delta);
		groupRef.position.x += (tx - groupRef.position.x) * t;
		groupRef.position.y += (ty - groupRef.position.y) * t;
		groupRef.position.z += (tz - groupRef.position.z) * t;

		// Velocity-scaled glow
		const vx = store.ball.velocity.x;
		const vz = store.ball.velocity.z;
		const speed = Math.sqrt(vx * vx + vz * vz);
		ballMaterial.emissiveIntensity = 0.3 + Math.min(speed * 3, 1.5);

		// Update trail
		trailHistory.unshift({
			x: groupRef.position.x,
			y: groupRef.position.y,
			z: groupRef.position.z,
		});
		if (trailHistory.length > TRAIL_LENGTH) {
			trailHistory.length = TRAIL_LENGTH;
		}

		const trailColor = getLastToucherColor();

		for (let i = 0; i < TRAIL_LENGTH; i++) {
			if (i < trailHistory.length) {
				const opacity = 1.0 - i / TRAIL_LENGTH;
				trailPosAttr.setXYZ(i, trailHistory[i].x, trailHistory[i].y, trailHistory[i].z);
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
