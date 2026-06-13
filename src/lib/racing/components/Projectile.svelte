<!--
  Projectile — renders a shell (green, red, or blue) as a glowing sphere.
  Position renders on the same delayed timeline as the karts: interpolated
  between buffered snapshots (race store), falling back to the raw spawn
  state until the projectile shows up in the buffer. This keeps shells
  visually consistent with the karts they chase instead of leading them by
  the interpolation delay.

  Enhancement: trailing particles — 8 sprites in a ring buffer recording
  the last N positions, rendered as fading sprites along the trail.
-->
<script lang="ts">
	import { T, useTask } from "@threlte/core";
	import * as THREE from "three";
	import { onDestroy } from "svelte";
	import { getRaceStore } from "$lib/racing/context.js";
	import type { ProjectileState } from "$lib/racing/types.js";

	interface Props {
		projectile: ProjectileState;
	}

	let { projectile }: Props = $props();

	const store = getRaceStore();

	const SHELL_RADIUS = 0.3;
	const TRAIL_COUNT = 10;
	const TRAIL_SPACING = 0.04; // seconds between samples
	const SHELL_SPIN_SPEED = 9; // rad/sec the shell tumbles as it flies
	// The server settles shells at roadY + SHELL_ROAD_HOVER (1.0). The client
	// renders the shell group directly at that world Y (no kart -2.3 grounding),
	// so the visual road sits ~1.0 below the shell. Drop a flat soft shadow by
	// that much (minus a hair so it floats just over the asphalt) to anchor the
	// shell to the ground. Approximate on banked/elevated road — fine for a
	// soft blob that only needs to read as "under the shell".
	const SHADOW_DROP = 0.95;

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

	// Ground shadow — a flat, dark, soft disc laid on the asphalt below the shell
	// so the projectile reads as a physical object skating the road rather than a
	// free-floating glow. Soft radial texture, one shared mesh held at a fixed
	// local offset below the shell (SHADOW_DROP); a sibling of the spinning shell,
	// so the tumble leaves it flat.
	function createShadowTexture(): THREE.CanvasTexture {
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
		g.addColorStop(0, "rgba(0,0,0,0.55)");
		g.addColorStop(0.6, "rgba(0,0,0,0.28)");
		g.addColorStop(1, "rgba(0,0,0,0)");
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, size, size);
		return new THREE.CanvasTexture(canvas);
	}
	const shadowTexture = createShadowTexture();
	const shadowGeo = new THREE.PlaneGeometry(1.3, 1.3);
	const shadowMat = new THREE.MeshBasicMaterial({
		map: shadowTexture,
		transparent: true,
		opacity: 0.7,
		depthWrite: false,
		// Normal blending (not additive) so the shadow darkens the road.
	});

	// Shell spin/wobble scratch (reused; nothing allocated per frame).
	let spin = 0;

	onDestroy(() => {
		trailGeo.dispose();
		trailMats.forEach((m) => m.dispose());
		shadowGeo.dispose();
		shadowMat.dispose();
		shadowTexture.dispose();
	});

	let groupRef: THREE.Group | undefined;
	let shellRef: THREE.Mesh | undefined;

	useTask((delta) => {
		if (!groupRef) return;

		// Interpolated render-behind position (same timeline as the karts);
		// raw server state until the projectile is buffered (~first snapshot
		// after spawn).
		const pose = store.sampleProjectilePose(projectile.id, performance.now());
		if (pose) {
			groupRef.position.set(pose.x, pose.y, pose.z);
		} else {
			groupRef.position.set(
				projectile.position.x,
				projectile.position.y,
				projectile.position.z,
			);
		}

		// Tumble + wobble the shell mesh (local to the group, so the trail and
		// shadow — siblings — are unaffected).
		spin += delta * SHELL_SPIN_SPEED;
		if (shellRef) {
			shellRef.rotation.y = spin;
			shellRef.rotation.x = Math.sin(spin * 0.6) * 0.4;
			// Gentle vertical bob so it reads as skittering, not gliding.
			shellRef.position.y = Math.sin(spin * 1.3) * 0.08;
		}

		// The ground shadow sits at a fixed local offset (road level relative to
		// the shell's hover height) and is set once on create — no per-frame work
		// needed since it's a sibling of the spinning shell, not parented to it.

		// Sample trail from the RENDERED position so the trail traces the
		// path the shell visually took.
		trailTimer += delta;
		if (trailTimer >= TRAIL_SPACING) {
			trailTimer = 0;
			trail.push({
				x: groupRef.position.x,
				y: groupRef.position.y,
				z: groupRef.position.z,
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
					pt.x - groupRef.position.x,
					pt.y - groupRef.position.y,
					pt.z - groupRef.position.z,
				);
				// Fade with distance from head. The head end of the trail glows
				// hot and fat; it thins and dims toward the tail. Pushed brighter
				// (0.85) so the bloom pass smears it into a proper streak.
				const fade = 1 - (i + 1) / (TRAIL_COUNT + 1);
				const mat = ref.material as THREE.MeshBasicMaterial;
				mat.color.set(shellColor);
				mat.opacity = fade * 0.85;
				// Bigger at the head, tapering down — plus a hair of per-point
				// flicker keyed off the spin so the streak shimmers.
				const flick = 0.9 + Math.sin(spin * 2 + i) * 0.1;
				const s = (0.35 + fade * 1.1) * flick;
				ref.scale.setScalar(s);
			} else {
				ref.visible = false;
			}
		}
	});
</script>

<!-- Position is owned by useTask alone (reactive position props would
     double-write and fight the interpolated pose every snapshot) -->
<T.Group
	oncreate={(ref) => {
		groupRef = ref;
		ref.position.set(
			projectile.position.x,
			projectile.position.y,
			projectile.position.z,
		);
	}}
>
	<!-- Soft ground shadow disc, laid flat on the asphalt under the shell. Not
	     parented to the spinning shell, so it stays put as the shell tumbles. -->
	<T.Mesh
		geometry={shadowGeo}
		material={shadowMat}
		rotation.x={-Math.PI / 2}
		position.y={-SHADOW_DROP}
		renderOrder={5}
	/>

	<!-- Main shell sphere — emissive past the bloom threshold; the bloom
	     pass provides the glow halo (no PointLight, which forced a shader
	     recompile every time a shell spawned or despawned). Tumbles + bobs via
	     shellRef so it reads as a skittering object, not a gliding orb. -->
	<T.Mesh castShadow oncreate={(ref) => { shellRef = ref; }}>
		<T.SphereGeometry args={[SHELL_RADIUS, 16, 12]} />
		<T.MeshStandardMaterial
			{color}
			emissive={color}
			emissiveIntensity={2.4}
			metalness={0.4}
			roughness={0.2}
		/>
	</T.Mesh>

	<!-- Trailing particles -->
	{#each Array(TRAIL_COUNT) as _, i (i)}
		<T.Mesh
			geometry={trailGeo}
			material={trailMats[i]}
			oncreate={(ref) => { trailRefs[i] = ref; }}
			visible={false}
		/>
	{/each}
</T.Group>
