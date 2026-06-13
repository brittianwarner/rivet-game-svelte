<!--
  ChaseCam — third-person chase camera that follows the local player's kart.
  Smooths position behind and above the kart, rotated by heading.
  Speed-based FOV for a rush effect during boosts.

  Enhancements:
  - Camera shake applied POST-lerp (full amplitude reaches the lens) to both
    the camera position and the look-at point, decayed via store.shakeDecay
  - Drift roll: camera banks into the corner while drifting (applied after
    lookAt, which resets rotation)
  - Look-back: hold C to swing the camera 180° around the kart
  - Frame-rate-independent smoothing via 1 - exp(-rate * delta)
  - Ground clamp so the camera never dips below the road on hills
  - Asymmetric FOV interpolation (faster increase, slower decrease)
  - Mushroom boost FOV spike (+12 degrees instant, decays over 400ms)
-->
<script lang="ts">
	import { T, useTask } from "@threlte/core";
	import { PerspectiveCamera, Vector3 } from "three";
	import { getRaceStore } from "$lib/racing/context";
	import { getSettingsStore } from "$lib/racing/settings-store.svelte";
	import { KART_MAX_SPEED } from "$lib/racing/types";

	const store = getRaceStore();
	const settings = getSettingsStore();

	const BASE_FOV = 65;
	const MAX_FOV_BOOST = 15;
	const CAMERA_BEHIND = 30;
	const CAMERA_ABOVE = 14;
	const LOOK_AHEAD = 15;

	// Frame-rate-independent smoothing rates (per second), applied as
	// 1 - Math.exp(-rate * delta). Calibrated to match the old per-frame
	// lerp factors at 60Hz (0.08 -> ~5/s, 0.15 -> ~9.7/s, 0.06 -> ~3.7/s).
	const POS_SMOOTH_RATE = 5;
	const FOV_INCREASE_RATE = 9.7; // faster when FOV should increase (boost)
	const FOV_DECREASE_RATE = 3.7; // slower when returning to normal
	const ROLL_SMOOTH_RATE = 6;    // drift roll ease in/out
	const LOOK_BACK_RATE = 14;     // fast but smoothed 180° flip

	// Camera shake: applied AFTER the position lerp so the full random
	// amplitude reaches the lens each frame (pre-lerp shake was ~88% filtered)
	const SHAKE_SCALE = 3;         // amplitude multiplier vs. store intensity
	const SHAKE_LOOK_SCALE = 0.5;  // look-at point gets half the positional shake

	// Drift roll
	const DRIFT_ROLL_MAX = 0.05; // radians of bank while drifting

	// Ground clamp: camera never dips below kart height + this margin
	const MIN_CAMERA_ABOVE_KART = 1.5;

	// FOV enhancement constants
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

	// Drift roll state
	let currentRoll = 0;

	// Look-back state (hold C to look behind)
	let lookBackHeld = false;
	let lookBackBlend = 0; // 0 = forward, 1 = fully flipped

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

	// Look-back key listener — 'KeyC' is unused by RaceInput (which binds
	// WASD/arrows, Space, Shift, E and X). Self-contained; cleaned up on unmount.
	$effect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.code === "KeyC") lookBackHeld = true;
		}
		function onKeyUp(e: KeyboardEvent) {
			if (e.code === "KeyC") lookBackHeld = false;
		}
		function onBlur() {
			lookBackHeld = false;
		}

		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("keyup", onKeyUp);
		window.addEventListener("blur", onBlur);

		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("keyup", onKeyUp);
			window.removeEventListener("blur", onBlur);
		};
	});

	useTask((delta) => {
		if (!camera) return;

		// Exponential smoothing factor — identical feel at 60Hz and 144Hz
		const posLerp = 1 - Math.exp(-POS_SMOOTH_RATE * delta);

		// Follow the camera target: the local kart normally, but the current
		// leader once the local player finishes early (so the view stays on the
		// race instead of freezing on the parked kart). Falls back to localKart.
		const targetId = store.cameraTargetKartId;
		const kart =
			(targetId ? store.karts[targetId] : null) ?? store.localKart;

		if (!kart) {
			// No local kart yet — hold a default overview position
			camera.position.lerp(DEFAULT_POS, posLerp);
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

		// ----- Look-Back Blend -----
		// While C is held, the camera swings 180° around the kart so you can
		// watch incoming red shells. Smoothed so the flip arcs around the side.
		const blendTarget = lookBackHeld ? 1 : 0;
		lookBackBlend += (blendTarget - lookBackBlend) * (1 - Math.exp(-LOOK_BACK_RATE * delta));
		if (Math.abs(lookBackBlend - blendTarget) < 0.001) {
			lookBackBlend = blendTarget;
		}

		// Camera angle: kart heading, rotated up to 180° when looking back
		const camAngle = heading + Math.PI * lookBackBlend;
		const sinC = Math.sin(camAngle);
		const cosC = Math.cos(camAngle);

		// Camera offset: behind and above, rotated by the (possibly flipped) angle
		_offset.set(
			-CAMERA_BEHIND * sinC,
			CAMERA_ABOVE,
			-CAMERA_BEHIND * cosC,
		);

		// Target camera position
		_target.copy(_kartPos).add(_offset);

		// Smooth camera position FIRST...
		camera.position.lerp(_target, posLerp);

		// ----- Camera Shake (post-lerp, so it actually reaches the lens) -----
		let shakeLookX = 0;
		let shakeLookY = 0;
		let shakeLookZ = 0;
		const shakeI = store.shakeIntensity;
		if (shakeI > 0.001) {
			const sx = (Math.random() - 0.5) * 2 * shakeI * SHAKE_SCALE;
			const sy = (Math.random() - 0.5) * shakeI * SHAKE_SCALE;
			const sz = (Math.random() - 0.5) * 2 * shakeI * SHAKE_SCALE;
			camera.position.x += sx;
			camera.position.y += sy;
			camera.position.z += sz;
			// Same sample at half strength on the look-at point for a
			// coherent rotational jolt
			shakeLookX = sx * SHAKE_LOOK_SCALE;
			shakeLookY = sy * SHAKE_LOOK_SCALE;
			shakeLookZ = sz * SHAKE_LOOK_SCALE;
			// Decay shake intensity at the store's rate, frame-rate independent
			store.shakeIntensity *= Math.exp(-store.shakeDecay * delta);
			if (store.shakeIntensity < 0.001) {
				store.shakeIntensity = 0;
			}
		}

		// ----- Ground Clamp -----
		// Never let the camera dip below the road surface on hills
		const minCamY = _kartPos.y + MIN_CAMERA_ABOVE_KART;
		if (camera.position.y < minCamY) {
			camera.position.y = minCamY;
		}

		// Look at a point ahead of the kart (behind it while looking back)
		_lookAt.set(
			_kartPos.x + sinC * LOOK_AHEAD + shakeLookX,
			_kartPos.y + 1 + shakeLookY,
			_kartPos.z + cosC * LOOK_AHEAD + shakeLookZ,
		);
		camera.lookAt(_lookAt);

		// ----- Drift Roll -----
		// Bank into the corner while drifting. driftState.direction carries the
		// steering sign (+1 = right). Applied AFTER lookAt, which resets rotation.
		const drift = kart.driftState;
		const rollTarget = drift.active ? -drift.direction * DRIFT_ROLL_MAX : 0;
		currentRoll += (rollTarget - currentRoll) * (1 - Math.exp(-ROLL_SMOOTH_RATE * delta));
		if (Math.abs(currentRoll) < 0.0001 && rollTarget === 0) {
			currentRoll = 0;
		} else {
			camera.rotateZ(currentRoll);
		}

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

		// Honor the player's "camera FOV kick" preference (and reduced motion):
		// hold a steady FOV when disabled so motion-sensitive players get no zoom
		// pulse. The smoothing below still eases back to BASE_FOV if toggled mid-race.
		if (!settings.cameraFovKick || settings.reducedMotionActive) {
			targetFov = BASE_FOV;
		}

		// Off-road FOV drop (check if status suggests off-road via reduced speed)
		// Use a heuristic: if speed is much lower than expected while throttle is on
		// A simpler approach: check if the kart appears to be off the track
		// For now, we do NOT have direct off-road state, so skip this unless
		// the store gains an offRoad flag in the future.

		// Asymmetric smoothing: increase faster, decrease slower
		const fovDiff = targetFov - currentFov;
		const fovRate = fovDiff > 0 ? FOV_INCREASE_RATE : FOV_DECREASE_RATE;
		currentFov += fovDiff * (1 - Math.exp(-fovRate * delta));

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
