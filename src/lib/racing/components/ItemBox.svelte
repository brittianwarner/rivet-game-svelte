<!--
  ItemBox — floating, rotating question-mark cube that grants items on contact.
  Renders a glowing yellow cube with a gentle bob and spin when active.
  When inactive (recently collected), renders nothing.

  Enhancements:
  - 6 orbiting particle sprites around the box
  - Respawn pop animation: scale 0→1.2→1.0 over 300ms when active transitions true
-->
<script lang="ts">
	import { T, useTask, useThrelte } from "@threlte/core";
	import * as THREE from "three";
	import { onDestroy } from "svelte";
	import type { Vec3 } from "$lib/racing/types.js";

	const { camera } = useThrelte();

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
	let glyphRef: THREE.Mesh | undefined;
	let groundGlowRef: THREE.Mesh | undefined;
	let elapsed = 0;
	let orbitParticleRefs: (THREE.Mesh | undefined)[] = Array(ORBIT_PARTICLE_COUNT).fill(undefined);

	// Reused scratch for orienting the glyph/ground-glow against the spinning
	// group (allocated once, never per frame).
	const invGroupQuat = new THREE.Quaternion();
	// Local quat that points the ground-glow plane flat (face up) — built once.
	const flatLocalQuat = new THREE.Quaternion().setFromAxisAngle(
		new THREE.Vector3(1, 0, 0),
		-Math.PI / 2,
	);

	// Respawn animation state
	let popStartTime = 0;
	let wasActive = false;
	let popScale = 1;

	const boxGeo = new THREE.BoxGeometry(BOX_SIZE, BOX_SIZE, BOX_SIZE);
	// Emissive pushed past the bloom threshold — the bloom pass carries the
	// glow (the old per-box PointLight forced shader recompiles on respawn).
	const boxMat = new THREE.MeshStandardMaterial({
		color: "#FFD93D",
		emissive: "#FFD93D",
		emissiveIntensity: 1.8,
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

	// Orbit particle geometry (shared) + one material PER particle, built once
	// here (not cloned inline in the template) so the 6 materials don't leak a
	// GPU material every time the box respawns/remounts. Each particle owns its
	// own material because useTask animates their opacity independently.
	const orbitGeo = new THREE.SphereGeometry(ORBIT_PARTICLE_SIZE, 6, 4);
	const orbitMats: THREE.MeshBasicMaterial[] = [];
	for (let i = 0; i < ORBIT_PARTICLE_COUNT; i++) {
		orbitMats.push(
			new THREE.MeshBasicMaterial({
				color: "#FFD93D",
				transparent: true,
				opacity: 0.7,
				depthWrite: false,
				blending: THREE.AdditiveBlending,
			}),
		);
	}

	// Crisp floating "?" — drawn once into a canvas texture and shown on a
	// billboarded additive quad that always faces the camera, so the mark stays
	// legible from any angle (a mark painted on the cube faces foreshortens away
	// as the box spins). Emissive-bright via additive blend → the bloom carries
	// a soft glow around it.
	function createGlyphTexture(): THREE.CanvasTexture {
		const size = 128;
		const canvas = document.createElement("canvas");
		canvas.width = size;
		canvas.height = size;
		const ctx = canvas.getContext("2d")!;
		ctx.clearRect(0, 0, size, size);
		ctx.font = "bold 92px system-ui, sans-serif";
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		// Soft dark halo first, then a bright fill, so the glyph reads against
		// both the cube and the bloom.
		ctx.shadowColor = "rgba(120,70,0,0.9)";
		ctx.shadowBlur = 10;
		ctx.fillStyle = "#5a3a00";
		ctx.fillText("?", size / 2 + 2, size / 2 + 4);
		ctx.shadowBlur = 0;
		ctx.fillStyle = "#fff7da";
		ctx.fillText("?", size / 2, size / 2);
		const tex = new THREE.CanvasTexture(canvas);
		tex.anisotropy = 4;
		return tex;
	}
	const glyphTexture = createGlyphTexture();
	const glyphGeo = new THREE.PlaneGeometry(0.9, 0.9);
	const glyphMat = new THREE.MeshBasicMaterial({
		map: glyphTexture,
		transparent: true,
		opacity: 0.95,
		depthWrite: false,
		blending: THREE.AdditiveBlending,
	});

	// Faint additive ground glow disc beneath the box so it reads as hovering
	// over a lit spot rather than floating in a void. Pulses with the box.
	function createGroundGlowTexture(): THREE.CanvasTexture {
		const size = 64;
		const canvas = document.createElement("canvas");
		canvas.width = size;
		canvas.height = size;
		const ctx = canvas.getContext("2d")!;
		const g = ctx.createRadialGradient(
			size / 2,
			size / 2,
			0,
			size / 2,
			size / 2,
			size / 2,
		);
		g.addColorStop(0, "rgba(255,217,61,0.6)");
		g.addColorStop(0.5, "rgba(255,217,61,0.25)");
		g.addColorStop(1, "rgba(255,217,61,0)");
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, size, size);
		return new THREE.CanvasTexture(canvas);
	}
	const groundGlowTexture = createGroundGlowTexture();
	const groundGlowGeo = new THREE.PlaneGeometry(2.2, 2.2);
	const groundGlowMat = new THREE.MeshBasicMaterial({
		map: groundGlowTexture,
		transparent: true,
		opacity: 0.4,
		depthWrite: false,
		blending: THREE.AdditiveBlending,
	});

	onDestroy(() => {
		boxGeo.dispose();
		boxMat.dispose();
		edgesGeo.dispose();
		edgesMat.dispose();
		orbitGeo.dispose();
		orbitMats.forEach((m) => m.dispose());
		glyphGeo.dispose();
		glyphMat.dispose();
		glyphTexture.dispose();
		groundGlowGeo.dispose();
		groundGlowMat.dispose();
		groundGlowTexture.dispose();
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

		// Pulsing emissive — the box breathes brighter/dimmer past the bloom
		// threshold so it shimmers on the track. Edge wireframe pulses with it.
		const pulse = 0.5 + Math.sin(elapsed * 3.2) * 0.5; // 0..1
		boxMat.emissiveIntensity = 1.5 + pulse * 1.1;
		edgesMat.opacity = 0.45 + pulse * 0.4;

		// Billboard the "?" toward the camera. The glyph lives inside the
		// spinning/tilting group, so set its LOCAL quaternion to the camera
		// orientation expressed in the group's frame: q_local = inv(q_group) * q_cam.
		// The ItemBox group is mounted at the scene root (no rotating ancestor),
		// so its LOCAL quaternion — which we just updated this frame — already
		// equals its world orientation; use it directly to avoid a one-frame lag
		// from a stale matrixWorld.
		invGroupQuat.copy(groupRef.quaternion).invert();
		if (glyphRef) {
			glyphRef.quaternion.copy(invGroupQuat).multiply(camera.current.quaternion);
			// Pop the glyph slightly with the same pulse for extra life.
			const gs = 1 + pulse * 0.08;
			glyphRef.scale.setScalar(gs);
			glyphMat.opacity = 0.8 + pulse * 0.2;
		}

		// Keep the ground glow plane flat on the road regardless of the group's
		// spin/tilt: q_local = inv(q_group) * flat. It hangs at a fixed local depth
		// below the box (set in the template), so it gently bobs WITH the box —
		// reads as a soft pool of light the hovering box casts onto the asphalt.
		if (groundGlowRef) {
			groundGlowRef.quaternion.copy(invGroupQuat).multiply(flatLocalQuat);
			groundGlowMat.opacity = 0.3 + pulse * 0.25;
		}

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
		<!-- Faint additive ground glow disc beneath the box (kept flat + pulsing
		     via useTask). Sits a hair below the cube so the box reads as hovering
		     over a lit spot. -->
		<T.Mesh
			geometry={groundGlowGeo}
			material={groundGlowMat}
			position.y={-1.2}
			renderOrder={4}
			oncreate={(ref) => { groundGlowRef = ref; }}
		/>

		<!-- Main cube -->
		<T.Mesh geometry={boxGeo} material={boxMat} castShadow />

		<!-- Wireframe edges -->
		<T.LineSegments geometry={edgesGeo} material={edgesMat} />

		<!-- Crisp floating "?" — camera-billboarded via useTask so it stays
		     legible as the cube spins. Sits just proud of the front face. -->
		<T.Mesh
			geometry={glyphGeo}
			material={glyphMat}
			renderOrder={6}
			oncreate={(ref) => { glyphRef = ref; }}
		/>

		<!-- Orbiting particle sprites -->
		{#each Array(ORBIT_PARTICLE_COUNT) as _, i}
			<T.Mesh
				geometry={orbitGeo}
				material={orbitMats[i]}
				oncreate={(ref) => { orbitParticleRefs[i] = ref; }}
			/>
		{/each}
	</T.Group>
{/if}
