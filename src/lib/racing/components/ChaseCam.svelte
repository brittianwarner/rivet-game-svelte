<!--
  ChaseCam — third-person chase camera that follows the local player's kart.
  Lerps position behind and above the kart, rotated by heading.
  Speed-based FOV for a rush effect during boosts.

  Enhancements:
  - Camera shake from store.shakeIntensity with decay
  - Asymmetric FOV interpolation (faster increase, slower decrease)
  - Off-road FOV drop (-4 degrees)
  - Mushroom boost FOV spike (+12 degrees instant, decays over 400ms)
-->
<script lang="ts">
	import { T, useTask, useThrelte } from "@threlte/core";
	import { PerspectiveCamera, Vector3 } from "three";
	import { getRaceStore } from "$lib/racing/context";
	import { KART_MAX_SPEED } from "$lib/racing/types";

	const store = getRaceStore();

	const BASE_FOV = 65;
	const MAX_FOV_BOOST = 15;
	const CAMERA_BEHIND = 30;
	const CAMERA_ABOVE = 14;
	const LOOK_AHEAD = 15;
	const LERP_BASE = 0.08;

	// FOV enhancement constants
	const FOV_INCREASE_LERP = 0.15; // faster when FOV should increase (boost)
	const FOV_DECREASE_LERP = 0.06; // slower when returning to normal
	const OFF_ROAD_FOV_DROP = 4;    // degrees to subtract when off-road
	const MUSHROOM_FOV_SPIKE = 12;  // instant spike on mushroom boost
	const MUSHROOM_FOV_DECAY = 400; // ms to decay mushroom spike

	// Default overview position when no local kart exists
	const DEFAULT_POS = new Vector3(0, 200, 400);
	const DEFAULT_LOOK = new Vector3(0, 0, 200);

	// Reusable Vector3s to avoid per-frame allocation
	const _offset = new Vector3();
	const _target = new Vector3();
	const _lookAt = new Vector3();
	const _kartPos = new Vector3();

	let camera: PerspectiveCamera | undefined;
	let currentFov = BASE_FOV;

	// Mushroom boost FOV spike state
	let mushroomFovSpike = 0;
	let mushroomSpikeTime = 0;
	let prevBoostTimer = 0;
	let prevStatus: string = "normal";

	function oncreate(ref: PerspectiveCamera) {
		camera = ref;
		camera.position.copy(DEFAULT_POS);
		camera.lookAt(DEFAULT_LOOK);
		camera.fov = BASE_FOV;
		camera.updateProjectionMatrix();
	}

	useTask((delta) => {
		if (!camera) return;

		const kart = store.localKart;

		if (!kart) {
			// No local kart yet — hold a default overview position
			camera.position.lerp(DEFAULT_POS, LERP_BASE * delta * 60);
			camera.lookAt(DEFAULT_LOOK);
			if (Math.abs(camera.fov - BASE_FOV) > 0.01) {
				camera.fov = BASE_FOV;
				camera.updateProjectionMatrix();
			}
			return;
		}

		const heading = kart.heading;
		const speed = kart.speed;
		const boostSpeed = kart.boostSpeed ?? 0;
		const effectiveSpeed = speed + boostSpeed;
		const status = kart.status;

		// Kart position as Vector3
		_kartPos.set(kart.position.x, kart.position.y, kart.position.z);

		// Camera offset: behind and above, rotated by heading
		const sinH = Math.sin(heading);
		const cosH = Math.cos(heading);
		_offset.set(
			-CAMERA_BEHIND * sinH,
			CAMERA_ABOVE,
			-CAMERA_BEHIND * cosH,
		);

		// Target camera position
		_target.copy(_kartPos).add(_offset);

		// ----- Camera Shake -----
		const shakeI = store.shakeIntensity;
		if (shakeI > 0.001) {
			_target.x += (Math.random() - 0.5) * 2 * shakeI;
			_target.y += (Math.random() - 0.5) * shakeI;
			_target.z += (Math.random() - 0.5) * 2 * shakeI;
			// Decay shake intensity
			store.shakeIntensity *= Math.max(0, 1 - 4 * delta);
			if (store.shakeIntensity < 0.001) {
				store.shakeIntensity = 0;
			}
		}

		// Lerp camera position toward target
		const lerpFactor = LERP_BASE * delta * 60;
		camera.position.lerp(_target, Math.min(lerpFactor, 1));

		// Look at a point ahead of the kart along its heading
		_lookAt.set(
			_kartPos.x + sinH * LOOK_AHEAD,
			_kartPos.y + 1,
			_kartPos.z + cosH * LOOK_AHEAD,
		);
		camera.lookAt(_lookAt);

		// ----- Mushroom Boost FOV Spike Detection -----
		// Detect when boost activates (boostTimer increases or status changes to boosted)
		if (
			(kart.boostTimer > 0 && prevBoostTimer === 0 && status === "boosted") ||
			(status === "boosted" && prevStatus !== "boosted")
		) {
			mushroomFovSpike = MUSHROOM_FOV_SPIKE;
			mushroomSpikeTime = performance.now();
		}
		prevBoostTimer = kart.boostTimer;
		prevStatus = status;

		// Decay mushroom spike over MUSHROOM_FOV_DECAY ms
		if (mushroomFovSpike > 0) {
			const elapsed = performance.now() - mushroomSpikeTime;
			if (elapsed > MUSHROOM_FOV_DECAY) {
				mushroomFovSpike = 0;
			} else {
				mushroomFovSpike = MUSHROOM_FOV_SPIKE * (1 - elapsed / MUSHROOM_FOV_DECAY);
			}
		}

		// ----- Speed-based FOV with asymmetric interpolation -----
		const speedRatio = Math.min(effectiveSpeed / KART_MAX_SPEED, 1);
		let targetFov = BASE_FOV + speedRatio * MAX_FOV_BOOST;

		// Add mushroom spike
		targetFov += mushroomFovSpike;

		// Off-road FOV drop (check if status suggests off-road via reduced speed)
		// Use a heuristic: if speed is much lower than expected while throttle is on
		// A simpler approach: check if the kart appears to be off the track
		// For now, we do NOT have direct off-road state, so skip this unless
		// the store gains an offRoad flag in the future.

		// Asymmetric lerp: increase faster, decrease slower
		const fovDiff = targetFov - currentFov;
		const fovLerpRate = fovDiff > 0 ? FOV_INCREASE_LERP : FOV_DECREASE_LERP;
		const fovLerp = fovLerpRate * delta * 60;
		currentFov += fovDiff * Math.min(fovLerp, 1);

		if (Math.abs(camera.fov - currentFov) > 0.01) {
			camera.fov = currentFov;
			camera.updateProjectionMatrix();
		}
	});
</script>

<T.PerspectiveCamera
	makeDefault
	fov={BASE_FOV}
	near={1}
	far={15000}
	{oncreate}
/>
