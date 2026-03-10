<!--
  Kart.svelte — Renders a single racing kart from the GLTF car model.

  Uses @threlte/gltf virtual graph (gltf.nodes) so each mesh is individually
  addressable. Interpolates position/rotation toward server snapshots with
  velocity extrapolation. Animates wheel spin, front-wheel steering, body roll,
  and status effects (shrunk, spinning).

  Enhancements:
  - Squash & stretch based on acceleration/braking/turning
  - Slipstream wind lines when kart.slipstreamActive
  - Boost activation scale pulse

  Performance: Three.js refs are plain `let` (no $state proxy in useTask).
  Single useTask callback handles all per-frame animation. Zero heap allocs.
-->
<script lang="ts">
	import { T, useTask } from "@threlte/core";
	import { useGltf, HTML } from "@threlte/extras";
	import * as THREE from "three";
	import { getRaceStore } from "$lib/racing/context.js";
	import {
		CAR_VARIANT_COLORS,
		type KartState,
		type DriftCharge,
	} from "$lib/racing/types.js";
	import DriftSparks from "./DriftSparks.svelte";
	import BoostFlame from "./BoostFlame.svelte";

	// -----------------------------------------------------------------------
	// Props
	// -----------------------------------------------------------------------
	interface Props {
		kartId: string;
		isLocal?: boolean;
	}

	let { kartId, isLocal = false }: Props = $props();

	// -----------------------------------------------------------------------
	// Store
	// -----------------------------------------------------------------------
	const store = getRaceStore();

	// -----------------------------------------------------------------------
	// GLTF loading — virtual graph gives us individual node access
	// -----------------------------------------------------------------------
	type GLTFResult = {
		nodes: {
			BodyCar_BodyCar2_0: THREE.Mesh;
			wheelsfront1_Wheels_0: THREE.Mesh;
			wheelsfront_Wheels_0: THREE.Mesh;
			Wheelsback_Wheels_0: THREE.Mesh;
			BodyCar_BodyCar3_0: THREE.Mesh;
			wheelsfront1_Wheels_0_1: THREE.Mesh;
			wheelsfront_Wheels_0_1: THREE.Mesh;
			Wheelsback_Wheels_0_1: THREE.Mesh;
			BodyCar_BodyCar4_0: THREE.Mesh;
			wheelsfront1_Wheels_0_2: THREE.Mesh;
			wheelsfront_Wheels_0_2: THREE.Mesh;
			Wheelsback_Wheels_0_2: THREE.Mesh;
			BodyCar_BodyCar5_0: THREE.Mesh;
			wheelsfront1_Wheels_0_3: THREE.Mesh;
			wheelsfront_Wheels_0_3: THREE.Mesh;
			Wheelsback_Wheels_0_3: THREE.Mesh;
			[key: string]: THREE.Mesh;
		};
		materials: {
			BodyCar2: THREE.MeshStandardMaterial;
			Wheels: THREE.MeshStandardMaterial;
			BodyCar3: THREE.MeshStandardMaterial;
			BodyCar4: THREE.MeshStandardMaterial;
			BodyCar5: THREE.MeshStandardMaterial;
		};
	};

	const gltf = useGltf<GLTFResult>("/racing_cars_gltf/scene.gltf");

	// -----------------------------------------------------------------------
	// Mesh name mappings per variant
	// -----------------------------------------------------------------------
	const VARIANT_MESHES: Array<{
		body: string;
		wheelFL: string;
		wheelFR: string;
		wheelRear: string;
		axle: string;
	}> = [
		{
			body: "BodyCar_BodyCar2_0",
			wheelFL: "wheelsfront1_Wheels_0",
			wheelFR: "wheelsfront_Wheels_0",
			wheelRear: "Wheelsback_Wheels_0",
			axle: "ca\u00f1o_Wheels_0",
		},
		{
			body: "BodyCar_BodyCar3_0",
			wheelFL: "wheelsfront1_Wheels_0_1",
			wheelFR: "wheelsfront_Wheels_0_1",
			wheelRear: "Wheelsback_Wheels_0_1",
			axle: "ca\u00f1o_Wheels_0_1",
		},
		{
			body: "BodyCar_BodyCar4_0",
			wheelFL: "wheelsfront1_Wheels_0_2",
			wheelFR: "wheelsfront_Wheels_0_2",
			wheelRear: "Wheelsback_Wheels_0_2",
			axle: "ca\u00f1o_Wheels_0_2",
		},
		{
			body: "BodyCar_BodyCar5_0",
			wheelFL: "wheelsfront1_Wheels_0_3",
			wheelFR: "wheelsfront_Wheels_0_3",
			wheelRear: "Wheelsback_Wheels_0_3",
			axle: "ca\u00f1o_Wheels_0_3",
		},
	];

	// -----------------------------------------------------------------------
	// Constants
	// -----------------------------------------------------------------------
	const LERP_SPEED = 15;
	const ROTATION_LERP_SPEED = 12;
	const MODEL_SCALE = 0.008;
	const MODEL_ROTATION_Y = -Math.PI / 2;
	const WHEEL_SPIN_FACTOR = 80;
	const MAX_STEER_ANGLE = 0.3;
	const MAX_BODY_ROLL = 0.08;
	const BODY_ROLL_LERP = 3;
	const SHRUNK_SCALE = 0.6;
	const SPIN_SPEED = 12;

	// Squash & stretch constants
	const ACCEL_STRETCH = { x: 0.95, y: 1.02, z: 1.05 };
	const BRAKE_SQUASH = { x: 1.06, y: 0.97, z: 0.94 };
	const BOOST_PULSE = { x: 0.92, y: 1.04, z: 1.08 };
	const BOOST_PULSE_DURATION = 80; // ms

	// Slipstream wind line constants
	const SLIPSTREAM_LINE_COUNT = 4;
	const SLIPSTREAM_LINE_LENGTH = 2.5;
	const SLIPSTREAM_SPREAD = 0.6;

	// -----------------------------------------------------------------------
	// Three.js refs — plain `let`, NOT $state
	// -----------------------------------------------------------------------
	let groupRef: THREE.Group | undefined;
	let modelInnerRef: THREE.Group | undefined;
	let modelOuterRef: THREE.Group | undefined;

	// Wheel pivot groups
	let wheelFLPivot: THREE.Group | undefined;
	let wheelFRPivot: THREE.Group | undefined;
	let wheelRearLeftPivot: THREE.Group | undefined;
	let wheelRearRightPivot: THREE.Group | undefined;
	let wheelFLSpin: THREE.Group | undefined;
	let wheelFRSpin: THREE.Group | undefined;
	let wheelRearLeftSpin: THREE.Group | undefined;
	let wheelRearRightSpin: THREE.Group | undefined;

	// Slipstream wind line refs
	let slipstreamGroupRef: THREE.Group | undefined;

	// -----------------------------------------------------------------------
	// Animation state (non-reactive, mutated in-place each frame)
	// -----------------------------------------------------------------------
	let initialized = false;
	let lastTargetX = 0;
	let lastTargetZ = 0;
	let snapshotTime = 0;
	let currentRoll = 0;
	let currentSteer = 0;
	let spinAccum = 0;         // "spinning" status effect accumulator
	let wheelSpinAccum = 0;    // wheel rolling accumulator (separate!)
	let prevVisualHeading = 0; // for computing visual turn rate → steer
	let smoothedTurnRate = 0;  // EMA-smoothed turn rate
	let currentScale = 1;
	let pointLightRef: THREE.PointLight | undefined;

	// Squash & stretch state
	let prevSpeed = 0;
	let squashX = 1, squashY = 1, squashZ = 1;
	let boostPulseStartTime = 0;
	let wasBoostActive = false;
	let wasShrunk = false;
	let shrinkAnimT = 0;

	// Slipstream wind line animation
	let slipstreamPhase = 0;

	// Track which variant we've built
	let builtVariant = -1;
	const wheelSpinAxis = new THREE.Vector3(0, 0, 1);
	const wheelSpinQuat = new THREE.Quaternion();

	// -----------------------------------------------------------------------
	// Build the car model from the virtual graph
	// -----------------------------------------------------------------------

	function buildGeo(p: number[], n: number[], u: number[]): THREE.BufferGeometry {
		const geo = new THREE.BufferGeometry();
		geo.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
		if (n.length > 0) geo.setAttribute("normal", new THREE.Float32BufferAttribute(n, 3));
		if (u.length > 0) geo.setAttribute("uv", new THREE.Float32BufferAttribute(u, 2));
		return geo;
	}

	function projectOntoAxis(x: number, y: number, z: number, axis: THREE.Vector3): number {
		return x * axis.x + y * axis.y + z * axis.z;
	}

	function geometryProjectionRange(
		geo: THREE.BufferGeometry,
		axis: THREE.Vector3,
	): { min: number; max: number } {
		const pos = geo.attributes.position;
		let min = Infinity;
		let max = -Infinity;
		for (let i = 0; i < pos.count; i++) {
			const projection = projectOntoAxis(pos.getX(i), pos.getY(i), pos.getZ(i), axis);
			if (projection < min) min = projection;
			if (projection > max) max = projection;
		}
		return { min, max };
	}

	function splitGeometryByAxis(
		srcGeo: THREE.BufferGeometry,
		axis: THREE.Vector3,
		splitProjection: number,
	): [THREE.BufferGeometry, THREE.BufferGeometry] {
		const nonIndexed = srcGeo.index ? srcGeo.toNonIndexed() : srcGeo.clone();
		const pos = nonIndexed.attributes.position;
		const norm = nonIndexed.attributes.normal;
		const uv = nonIndexed.attributes.uv;
		const triCount = pos.count / 3;

		const leftPos: number[] = [];
		const leftNorm: number[] = [];
		const leftUv: number[] = [];
		const rightPos: number[] = [];
		const rightNorm: number[] = [];
		const rightUv: number[] = [];

		for (let t = 0; t < triCount; t++) {
			const base = t * 3;
			const cx = (pos.getX(base) + pos.getX(base + 1) + pos.getX(base + 2)) / 3;
			const cy = (pos.getY(base) + pos.getY(base + 1) + pos.getY(base + 2)) / 3;
			const cz = (pos.getZ(base) + pos.getZ(base + 1) + pos.getZ(base + 2)) / 3;
			const projection = projectOntoAxis(cx, cy, cz, axis);

			const pArr = projection < splitProjection ? leftPos : rightPos;
			const nArr = projection < splitProjection ? leftNorm : rightNorm;
			const uArr = projection < splitProjection ? leftUv : rightUv;

			for (let v = 0; v < 3; v++) {
				const i = base + v;
				pArr.push(pos.getX(i), pos.getY(i), pos.getZ(i));
				if (norm) nArr.push(norm.getX(i), norm.getY(i), norm.getZ(i));
				if (uv) uArr.push(uv.getX(i), uv.getY(i));
			}
		}

		return [
			buildGeo(leftPos, leftNorm, leftUv),
			buildGeo(rightPos, rightNorm, rightUv),
		];
	}

	function buildCarModel(
		nodes: GLTFResult["nodes"],
		materials: GLTFResult["materials"],
		variant: number,
	): THREE.Group | null {
		const mapping = VARIANT_MESHES[variant] ?? VARIANT_MESHES[0];

		const bodyMesh = nodes[mapping.body];
		const wheelFLMesh = nodes[mapping.wheelFL];
		const wheelFRMesh = nodes[mapping.wheelFR];
		const wheelRearMesh = nodes[mapping.wheelRear];
		const axleMesh = nodes[mapping.axle];

		if (!bodyMesh) {
			console.warn(`[Kart] Missing body mesh: ${mapping.body}`);
			return null;
		}

		const outer = new THREE.Group();
		outer.scale.setScalar(MODEL_SCALE);

		const inner = new THREE.Group();
		inner.rotation.y = MODEL_ROTATION_Y;
		outer.add(inner);

		// Body mesh — clone material and tint with team variant color
		const bodyMat = (bodyMesh.material as THREE.MeshStandardMaterial).clone();
		const variantColor = CAR_VARIANT_COLORS[variant] ?? CAR_VARIANT_COLORS[0];
		// Blend the variant color into the base material
		bodyMat.color.lerp(new THREE.Color(variantColor), 0.35);
		bodyMat.emissive = new THREE.Color(variantColor);
		bodyMat.emissiveIntensity = 0.15;
		const body = new THREE.Mesh(bodyMesh.geometry.clone(), bodyMat);
		inner.add(body);

		// Front axle tube (caño) — hidden; the rod pokes outside the body
		// if (axleMesh) { inner.add(new THREE.Mesh(axleMesh.geometry.clone(), axleMesh.material)); }

		type WheelRig = {
			pivot: THREE.Group;
			spin: THREE.Group;
			center: THREE.Vector3;
		};

		// Wheel pivot helper — centers geometry at its bbox center,
		// positions the pivot group at that center so rotation is around the axle.
		// Uses bbox center (not vertex centroid) for accurate axle alignment —
		// vertex centroid can be biased by non-uniform vertex density (more
		// detail on tread than hub), causing off-axis wobble during spin.
		function bboxCenter(geo: THREE.BufferGeometry): THREE.Vector3 {
			geo.computeBoundingBox();
			const center = new THREE.Vector3();
			geo.boundingBox!.getCenter(center);
			return center;
		}

		function makeWheelRig(srcMesh: THREE.Mesh | undefined): WheelRig | undefined {
			if (!srcMesh) return undefined;
			const geo = srcMesh.geometry.clone();
			return makeWheelRigFromGeo(geo, srcMesh.material);
		}

		function makeWheelRigFromGeo(
			geo: THREE.BufferGeometry,
			material: THREE.Material | THREE.Material[],
		): WheelRig | undefined {
			const pos = geo.attributes.position;
			if (!pos || pos.count === 0) return undefined;
			const center = bboxCenter(geo);
			geo.translate(-center.x, -center.y, -center.z);

			const mesh = new THREE.Mesh(geo, material);
			const spin = new THREE.Group();
			spin.add(mesh);
			const pivot = new THREE.Group();
			pivot.position.copy(center);
			pivot.add(spin);
			return { pivot, spin, center };
		}

		// Filter out axle rod triangles from rear wheel geometry by projecting onto
		// the actual wheel axle direction from the source asset.
		function clipAxleRod(
			geo: THREE.BufferGeometry,
			axis: THREE.Vector3,
			keepNearMin: boolean,
			wheelExtent: number,
		): THREE.BufferGeometry {
			const { min, max } = geometryProjectionRange(geo, axis);
			const threshold = keepNearMin ? min + wheelExtent : max - wheelExtent;

			const nonIndexed = geo.index ? geo.toNonIndexed() : geo.clone();
			const pos = nonIndexed.attributes.position;
			const norm = nonIndexed.attributes.normal;
			const uv = nonIndexed.attributes.uv;
			const triCount = pos.count / 3;

			const keptPos: number[] = [];
			const keptNorm: number[] = [];
			const keptUv: number[] = [];

			for (let t = 0; t < triCount; t++) {
				const base = t * 3;
				const cx = (pos.getX(base) + pos.getX(base + 1) + pos.getX(base + 2)) / 3;
				const cy = (pos.getY(base) + pos.getY(base + 1) + pos.getY(base + 2)) / 3;
				const cz = (pos.getZ(base) + pos.getZ(base + 1) + pos.getZ(base + 2)) / 3;
				const projection = projectOntoAxis(cx, cy, cz, axis);
				const keep = keepNearMin ? projection < threshold : projection > threshold;
				if (!keep) continue;

				for (let v = 0; v < 3; v++) {
					const i = base + v;
					keptPos.push(pos.getX(i), pos.getY(i), pos.getZ(i));
					if (norm) keptNorm.push(norm.getX(i), norm.getY(i), norm.getZ(i));
					if (uv) keptUv.push(uv.getX(i), uv.getY(i));
				}
			}

			const out = new THREE.BufferGeometry();
			out.setAttribute("position", new THREE.Float32BufferAttribute(keptPos, 3));
			if (keptNorm.length > 0) out.setAttribute("normal", new THREE.Float32BufferAttribute(keptNorm, 3));
			if (keptUv.length > 0) out.setAttribute("uv", new THREE.Float32BufferAttribute(keptUv, 2));
			return out;
		}

		// Front wheels
		const frontLeftRig = makeWheelRig(wheelFLMesh);
		const frontRightRig = makeWheelRig(wheelFRMesh);
		wheelFLPivot = frontLeftRig?.pivot;
		wheelFRPivot = frontRightRig?.pivot;
		wheelFLSpin = frontLeftRig?.spin;
		wheelFRSpin = frontRightRig?.spin;

		if (frontLeftRig && frontRightRig) {
			wheelSpinAxis.copy(frontRightRig.center).sub(frontLeftRig.center);
			if (wheelSpinAxis.lengthSq() > 1e-6) {
				wheelSpinAxis.normalize();
			} else {
				wheelSpinAxis.set(0, 0, 1);
			}
		} else {
			wheelSpinAxis.set(0, 0, 1);
		}

		// Rear wheels — split the combined mesh using the real axle direction.
		wheelRearLeftPivot = undefined;
		wheelRearRightPivot = undefined;
		wheelRearLeftSpin = undefined;
		wheelRearRightSpin = undefined;

		if (wheelRearMesh) {
			const rearGeo = wheelRearMesh.geometry;
			const rearProjectionRange = geometryProjectionRange(rearGeo, wheelSpinAxis);
			const splitProjection = (rearProjectionRange.min + rearProjectionRange.max) / 2;

			let [leftGeo, rightGeo] = splitGeometryByAxis(rearGeo, wheelSpinAxis, splitProjection);
			const frontWheelRange =
				wheelFLMesh
					? geometryProjectionRange(wheelFLMesh.geometry, wheelSpinAxis)
					: wheelFRMesh
						? geometryProjectionRange(wheelFRMesh.geometry, wheelSpinAxis)
						: { min: 0, max: 120 };
			const wheelExtent = Math.max(120, (frontWheelRange.max - frontWheelRange.min) * 1.15);

			// Clip axle rod geometry from each half by keeping only triangles near
			// the outer ends of the rear axle.
			leftGeo = clipAxleRod(leftGeo, wheelSpinAxis, true, wheelExtent);
			rightGeo = clipAxleRod(rightGeo, wheelSpinAxis, false, wheelExtent);

			if (leftGeo.attributes.position.count > 0) {
				const rearLeftRig = makeWheelRigFromGeo(leftGeo, wheelRearMesh.material);
				wheelRearLeftPivot = rearLeftRig?.pivot;
				wheelRearLeftSpin = rearLeftRig?.spin;
			}
			if (rightGeo.attributes.position.count > 0) {
				const rearRightRig = makeWheelRigFromGeo(rightGeo, wheelRearMesh.material);
				wheelRearRightPivot = rearRightRig?.pivot;
				wheelRearRightSpin = rearRightRig?.spin;
			}
		}

		if (wheelFLPivot) inner.add(wheelFLPivot);
		if (wheelFRPivot) inner.add(wheelFRPivot);
		if (wheelRearLeftPivot) inner.add(wheelRearLeftPivot);
		if (wheelRearRightPivot) inner.add(wheelRearRightPivot);

		// Center the assembled model: XZ at origin, wheel bottoms at Y=0
		const box = new THREE.Box3().setFromObject(outer);
		const boxCenter = new THREE.Vector3();
		box.getCenter(boxCenter);
		inner.position.x -= boxCenter.x / MODEL_SCALE;
		inner.position.z -= boxCenter.z / MODEL_SCALE;

		// Use wheel bottom for Y baseline (not front wing tips which hang lower)
		let wheelMinY = Infinity;
		const wheelPivots = [wheelFLPivot, wheelFRPivot, wheelRearLeftPivot, wheelRearRightPivot];
		for (const wp of wheelPivots) {
			if (!wp) continue;
			const wb = new THREE.Box3().setFromObject(wp);
			if (wb.min.y < wheelMinY) wheelMinY = wb.min.y;
		}
		// Fall back to overall bounding box if no wheels found
		if (!isFinite(wheelMinY)) {
			box.setFromObject(outer);
			wheelMinY = box.min.y;
		}
		inner.position.y -= wheelMinY / MODEL_SCALE;

		return outer;
	}

	// -----------------------------------------------------------------------
	// Reactive: rebuild car model when gltf loads or variant changes
	// -----------------------------------------------------------------------
	$effect(() => {
		const kart = store.karts[kartId];
		if (!kart) return;

		const loadedGltf = $gltf;
		if (!loadedGltf) return;

		const variant = kart.carVariant;
		if (variant === builtVariant && modelInnerRef) return;

		// Remove old model
		if (modelInnerRef && groupRef) {
			groupRef.remove(modelInnerRef.parent!);
			modelInnerRef = undefined;
			modelOuterRef = undefined;
			wheelFLPivot = undefined;
			wheelFRPivot = undefined;
			wheelRearLeftPivot = undefined;
			wheelRearRightPivot = undefined;
			wheelFLSpin = undefined;
			wheelFRSpin = undefined;
			wheelRearLeftSpin = undefined;
			wheelRearRightSpin = undefined;
		}

		const model = buildCarModel(loadedGltf.nodes, loadedGltf.materials, variant);
		if (model && groupRef) {
			groupRef.add(model);
			modelOuterRef = model;
			modelInnerRef = model.children[0] as THREE.Group;
			builtVariant = variant;
		}
	});

	// -----------------------------------------------------------------------
	// useTask — per-frame animation
	// -----------------------------------------------------------------------
	useTask((delta) => {
		if (!groupRef) return;

		const kart: KartState | undefined = store.karts[kartId];
		if (!kart) return;

		const tx = kart.position.x;
		const ty = kart.position.y;
		const tz = kart.position.z;
		const heading = kart.heading;
		const speed = kart.speed;
		const vx = kart.velocity.x;
		const vz = kart.velocity.z;
		const status = kart.status;
		const driftActive = kart.driftState.active;
		const driftDir = kart.driftState.direction;
		const isBoostedNow = kart.boostTimer > 0 || status === "boosted" || status === "starred";
		const isSlipstream = kart.slipstreamActive;

		// Detect new snapshot arrival
		if (tx !== lastTargetX || tz !== lastTargetZ) {
			lastTargetX = tx;
			lastTargetZ = tz;
			snapshotTime = performance.now();
		}

		// Velocity extrapolation
		const extrapolationSec = Math.min(
			(performance.now() - snapshotTime) / 1000,
			0.05,
		);
		const etx = tx + vx * extrapolationSec * 60;
		const etz = tz + vz * extrapolationSec * 60;

		// Position interpolation
		if (!initialized) {
			groupRef.position.set(tx, ty, tz);
			groupRef.rotation.y = heading;
			initialized = true;
			prevSpeed = speed;
			return;
		}

		const t = Math.min(1, LERP_SPEED * delta);
		groupRef.position.x += (etx - groupRef.position.x) * t;
		groupRef.position.y += (ty - groupRef.position.y) * t;
		groupRef.position.z += (etz - groupRef.position.z) * t;

		// Heading interpolation with angle wrapping
		const rt = Math.min(1, ROTATION_LERP_SPEED * delta);
		let angleDiff = heading - groupRef.rotation.y;
		while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
		while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

		if (status === "spinning") {
			spinAccum += SPIN_SPEED * delta;
			groupRef.rotation.y += SPIN_SPEED * delta;
		} else {
			spinAccum = 0;
			groupRef.rotation.y += angleDiff * rt;
		}

		// ----- Squash & Stretch -----
		const accel = speed - prevSpeed;
		prevSpeed = speed;

		// Detect boost activation for pulse
		if (isBoostedNow && !wasBoostActive) {
			boostPulseStartTime = performance.now();
		}
		wasBoostActive = isBoostedNow;

		// Detect shrink for squash intermediate
		const isShrunk = status === "shrunk";
		if (isShrunk && !wasShrunk) {
			shrinkAnimT = 0;
		}
		wasShrunk = isShrunk;
		if (isShrunk && shrinkAnimT < 1) {
			shrinkAnimT = Math.min(1, shrinkAnimT + delta * 8);
		}

		// Compute target squash/stretch
		let targetSX = 1, targetSY = 1, targetSZ = 1;

		// Boost pulse (brief, 80ms)
		const boostPulseElapsed = performance.now() - boostPulseStartTime;
		if (boostPulseElapsed < BOOST_PULSE_DURATION && boostPulseStartTime > 0) {
			const bp = 1 - boostPulseElapsed / BOOST_PULSE_DURATION;
			targetSX = 1 + (BOOST_PULSE.x - 1) * bp;
			targetSY = 1 + (BOOST_PULSE.y - 1) * bp;
			targetSZ = 1 + (BOOST_PULSE.z - 1) * bp;
		} else if (accel > 0.005) {
			// Accelerating — stretch forward
			const blend = Math.min(accel / 0.02, 1);
			targetSX = 1 + (ACCEL_STRETCH.x - 1) * blend;
			targetSY = 1 + (ACCEL_STRETCH.y - 1) * blend;
			targetSZ = 1 + (ACCEL_STRETCH.z - 1) * blend;
		} else if (accel < -0.005) {
			// Braking — squash
			const blend = Math.min(-accel / 0.04, 1);
			targetSX = 1 + (BRAKE_SQUASH.x - 1) * blend;
			targetSY = 1 + (BRAKE_SQUASH.y - 1) * blend;
			targetSZ = 1 + (BRAKE_SQUASH.z - 1) * blend;
		}

		// Lightning shrink: animate through squash intermediate
		if (isShrunk && shrinkAnimT < 1) {
			const squashPhase = Math.sin(shrinkAnimT * Math.PI);
			targetSX *= 1 + squashPhase * 0.15;
			targetSY *= 1 - squashPhase * 0.1;
			targetSZ *= 1 - squashPhase * 0.05;
		}

		// Smooth the squash/stretch
		const sqLerp = Math.min(1, 12 * delta);
		squashX += (targetSX - squashX) * sqLerp;
		squashY += (targetSY - squashY) * sqLerp;
		squashZ += (targetSZ - squashZ) * sqLerp;

		// Apply overall scale (shrunk + squash/stretch)
		const targetScale = isShrunk ? SHRUNK_SCALE : 1.0;
		currentScale += (targetScale - currentScale) * Math.min(1, 8 * delta);
		groupRef.scale.set(
			currentScale * squashX,
			currentScale * squashY,
			currentScale * squashZ,
		);

		// ---- Steering signal from visual turn rate (Mario Kart style) ----
		const visualHeading = groupRef.rotation.y;
		let visualTurnDelta = visualHeading - prevVisualHeading;
		if (visualTurnDelta > Math.PI) visualTurnDelta -= Math.PI * 2;
		if (visualTurnDelta < -Math.PI) visualTurnDelta += Math.PI * 2;
		prevVisualHeading = visualHeading;

		const rawTurnRate = delta > 0 ? visualTurnDelta / delta : 0;
		// Smooth the turn rate with EMA to kill 20Hz snapshot jitter
		smoothedTurnRate += (rawTurnRate - smoothedTurnRate) * Math.min(1, 3 * delta);
		const turnRateNorm = Math.max(-1, Math.min(1, smoothedTurnRate / 2.5));
		const steerSignal = driftActive ? driftDir : turnRateNorm;

		// Body roll — DISABLED on groupRef to avoid Euler Y+Z interaction wobble.
		// groupRef only uses rotation.y (heading). No second axis = no wobble.
		groupRef.rotation.z = 0;

		// ---- Wheel spin (rolling) ----
		const wheelSpinDelta = speed * WHEEL_SPIN_FACTOR * delta;
		// Accumulate in a SEPARATE variable (spinAccum is for "spinning" status!)
		wheelSpinAccum += wheelSpinDelta;
		if (wheelSpinAccum > Math.PI) wheelSpinAccum -= Math.PI * 2;
		if (wheelSpinAccum < -Math.PI) wheelSpinAccum += Math.PI * 2;

		// ---- Front wheel steer angle ----
		const targetSteerAngle = Math.max(
			-MAX_STEER_ANGLE,
			Math.min(MAX_STEER_ANGLE, steerSignal * MAX_STEER_ANGLE),
		);
		currentSteer += (targetSteerAngle - currentSteer) * Math.min(1, 10 * delta);

		// Spin + steer with a real axle vector from the source mesh. The asset is
		// slightly canted in GLTF space, so assuming a plain Z spin axis makes the
		// wheels precess as they roll.
		wheelSpinQuat.setFromAxisAngle(wheelSpinAxis, wheelSpinAccum);
		if (wheelFLPivot) {
			wheelFLPivot.rotation.set(0, currentSteer, 0);
			if (wheelFLSpin) wheelFLSpin.quaternion.copy(wheelSpinQuat);
		}
		if (wheelFRPivot) {
			wheelFRPivot.rotation.set(0, currentSteer, 0);
			if (wheelFRSpin) wheelFRSpin.quaternion.copy(wheelSpinQuat);
		}
		if (wheelRearLeftSpin) {
			wheelRearLeftSpin.quaternion.copy(wheelSpinQuat);
		}
		if (wheelRearRightSpin) {
			wheelRearRightSpin.quaternion.copy(wheelSpinQuat);
		}

		// Point light color update
		if (pointLightRef) {
			const variantColor =
				CAR_VARIANT_COLORS[kart.carVariant] ?? CAR_VARIANT_COLORS[0];
			pointLightRef.color.set(variantColor);
			pointLightRef.intensity =
				status === "boosted" || status === "starred" ? 4 : 2;
		}

		// ----- Slipstream wind lines animation -----
		if (slipstreamGroupRef) {
			slipstreamGroupRef.visible = isSlipstream;
			if (isSlipstream) {
				slipstreamPhase += delta * 8;
				const children = slipstreamGroupRef.children;
				for (let i = 0; i < children.length; i++) {
					const line = children[i];
					// Scroll lines backward cyclically
					const phase = ((slipstreamPhase + i * 0.25) % 1.0);
					const zOff = -0.5 - phase * SLIPSTREAM_LINE_LENGTH;
					const xSpread = (i / (SLIPSTREAM_LINE_COUNT - 1) - 0.5) * SLIPSTREAM_SPREAD * 2;
					line.position.set(xSpread, 0.4 + Math.sin(phase * Math.PI) * 0.15, zOff);
					// Scale: thin at start, normal in middle, thin at end
					const scaleX = 0.3 + Math.sin(phase * Math.PI) * 0.7;
					line.scale.set(scaleX, 1, 1);
					// Opacity via material
					const mat = (line as THREE.Mesh).material as THREE.MeshBasicMaterial;
					if (mat && mat.opacity !== undefined) {
						mat.opacity = Math.sin(phase * Math.PI) * 0.5;
					}
				}
			}
		}
	});

	// -----------------------------------------------------------------------
	// Derived values for template
	// -----------------------------------------------------------------------
	const kartColor = $derived.by(() => {
		const kart = store.karts[kartId];
		if (!kart) return CAR_VARIANT_COLORS[0];
		return CAR_VARIANT_COLORS[kart.carVariant] ?? CAR_VARIANT_COLORS[0];
	});

	const kartName = $derived.by(() => {
		const kart = store.karts[kartId];
		return kart?.name ?? "Racer";
	});

	const kartExists = $derived(!!store.karts[kartId]);

	const nameLabelStyle = $derived(
		`font-family:monospace;font-size:12px;font-weight:bold;` +
			`color:${kartColor};` +
			`text-shadow:0 0 4px rgba(0,0,0,0.8),0 0 8px ${kartColor}40;` +
			`white-space:nowrap;text-align:center;pointer-events:none;user-select:none;`,
	);

	const driftActive = $derived.by(() => {
		const kart = store.karts[kartId];
		return kart?.driftState.active ?? false;
	});

	const driftCharge = $derived.by(() => {
		const kart = store.karts[kartId];
		return (kart?.driftState.charge ?? 0) as DriftCharge;
	});

	const isBoosted = $derived.by(() => {
		const kart = store.karts[kartId];
		if (!kart) return false;
		return (
			kart.boostTimer > 0 ||
			kart.status === "boosted" ||
			kart.status === "starred"
		);
	});
</script>

{#if kartExists}
	<T.Group
		oncreate={(ref) => {
			groupRef = ref;
		}}
	>
		<!-- Team color indicator light underneath the kart -->
		<T.PointLight
			oncreate={(ref) => {
				pointLightRef = ref;
			}}
			color={kartColor}
			intensity={2}
			distance={6}
			decay={2}
			position.y={0.3}
		/>

		<!-- Ground glow ring (team color) -->
		<T.Mesh rotation.x={-Math.PI / 2} position.y={0.02}>
			<T.RingGeometry args={[0.6, 0.9, 32]} />
			<T.MeshBasicMaterial
				color={kartColor}
				transparent
				opacity={0.35}
				side={THREE.DoubleSide}
				depthWrite={false}
			/>
		</T.Mesh>

		<!-- Local player outline ring -->
		{#if isLocal}
			<T.Mesh rotation.x={-Math.PI / 2} position.y={0.03}>
				<T.RingGeometry args={[0.9, 1.0, 32]} />
				<T.MeshBasicMaterial
					color="#ffffff"
					transparent
					opacity={0.5}
					side={THREE.DoubleSide}
					depthWrite={false}
				/>
			</T.Mesh>
		{/if}

		<!-- Headlights (front of kart) — PointLights at nose height -->
		<T.PointLight
			color="#FFFFFF"
			intensity={3}
			distance={12}
			decay={2}
			position={[-0.6, 0.4, -2.5]}
		/>
		<T.PointLight
			color="#FFFFFF"
			intensity={3}
			distance={12}
			decay={2}
			position={[0.6, 0.4, -2.5]}
		/>

		<!-- Taillights (rear of kart) -->
		<T.PointLight
			color="#FF2200"
			intensity={2}
			distance={4}
			decay={2}
			position={[-0.5, 0.4, 2.0]}
		/>
		<T.PointLight
			color="#FF2200"
			intensity={2}
			distance={4}
			decay={2}
			position={[0.5, 0.4, 2.0]}
		/>
		<!-- Taillight glow meshes -->
		<T.Mesh position={[-0.5, 0.4, 2.0]}>
			<T.SphereGeometry args={[0.08, 8, 6]} />
			<T.MeshBasicMaterial color="#FF2200" transparent opacity={0.9} />
		</T.Mesh>
		<T.Mesh position={[0.5, 0.4, 2.0]}>
			<T.SphereGeometry args={[0.08, 8, 6]} />
			<T.MeshBasicMaterial color="#FF2200" transparent opacity={0.9} />
		</T.Mesh>

		<!-- Drift sparks (rear of kart) -->
		<DriftSparks active={driftActive} charge={driftCharge} color={kartColor} />

		<!-- Boost flame (rear exhaust) -->
		<BoostFlame active={isBoosted} intensity={1} />

		<!-- Slipstream wind lines — 4 horizontal speed-line sprites behind kart -->
		<T.Group
			oncreate={(ref) => { slipstreamGroupRef = ref; }}
			visible={false}
		>
			{#each Array(SLIPSTREAM_LINE_COUNT) as _, i}
				<T.Mesh position={[0, 0.4, -1 - i * 0.5]}>
					<T.PlaneGeometry args={[0.06, 0.4]} />
					<T.MeshBasicMaterial
						color="#00DDFF"
						transparent
						opacity={0.4}
						depthWrite={false}
						blending={THREE.AdditiveBlending}
					/>
				</T.Mesh>
			{/each}
		</T.Group>

		<!-- Player name label (HTML overlay above kart) -->
		<HTML position.y={1.5} center pointerEvents="none" sprite>
			<div style={nameLabelStyle}>
				{kartName}
			</div>
		</HTML>
	</T.Group>
{/if}
