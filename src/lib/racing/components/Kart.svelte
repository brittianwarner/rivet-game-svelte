<!--
  Kart.svelte — renders a single racing kart from the curated generic car pack.

  Loads the shared 20-car GLTF once, clones only the selected curated car root,
  recenters it, and wraps each wheel in pivot/spin groups so steering and
  rolling stay independent from the source asset hierarchy.
-->
<script lang="ts">
  import { T, useTask } from "@threlte/core";
  import { HTML, useGltf } from "@threlte/extras";
  import { onDestroy } from "svelte";
  import * as THREE from "three";
  import { getRaceStore } from "$lib/racing/context.js";
  import {
    buildCarRig,
    type CarRigAnchors,
    type BodyMaterial,
  } from "$lib/racing/build-car-rig.js";
  import { getPlayerAccentColor, getRaceCar } from "$lib/racing/car-catalog.js";
  import { type DriftCharge, type KartState } from "$lib/racing/types.js";
  import DriftSparks from "./DriftSparks.svelte";
  import BoostFlame from "./BoostFlame.svelte";

  interface Props {
    kartId: string;
    isLocal?: boolean;
  }

  let { kartId, isLocal = false }: Props = $props();

  const store = getRaceStore();

  type GenericCarsPackGltf = {
    scene: THREE.Group;
    nodes: Record<string, THREE.Object3D>;
    materials: Record<string, THREE.Material | THREE.Material[]>;
  };

  const gltf = useGltf<GenericCarsPackGltf>("/20x_generic_cars_gltf/scene.gltf");

  const WHEEL_SPIN_FACTOR = 80;
  // Cap visual wheel spin at ~0.5π rad per 60Hz frame so wheels read as
  // rolling instead of strobing at speed.
  const MAX_WHEEL_SPIN_RATE = Math.PI * 0.5 * 60; // rad/s
  const MAX_STEER_ANGLE = 0.3;
  const SHRUNK_SCALE = 0.6;
  const SPIN_SPEED = 12;
  // The server pins kart.position.y to road height + 2.5 while the rig grounds
  // wheel bottoms at local y=0 — pull the visual down, leaving ~0.2 suspension.
  const KART_VISUAL_Y_OFFSET = 2.3;
  // Beyond this horizontal distance the kart teleported (respawn, lightning,
  // rematch grid) — snap instead of gliding across the map through walls.
  const TELEPORT_SNAP_DISTANCE = 18;
  const DRIFT_POSE_GAIN = 1.2;
  const MAX_BODY_PITCH = 0.35;
  const BODY_LEAN_MAX = 0.06;
  const SHADOW_RADIUS = 2.2;

  // --- Status VFX tuning (emissive-driven; bloom carries the glow) ---
  // White hit flash: a 150ms emissive pop when this kart is struck.
  const HIT_FLASH_MS = 150;
  const HIT_FLASH_EMISSIVE = 1.6;
  // Star: cycle the body emissive through the hue wheel ~3Hz while invincible.
  const STAR_HUE_HZ = 3;
  const STAR_EMISSIVE = 0.9;
  // Shrunk: desaturated blue-grey wash + dimmed emissive.
  const SHRUNK_TINT = "#6f7d8f";
  const SHRUNK_TINT_BLEND = 0.55;

  const ACCEL_STRETCH = { x: 0.95, y: 1.02, z: 1.05 };
  const BRAKE_SQUASH = { x: 1.06, y: 0.97, z: 0.94 };
  const BOOST_PULSE = { x: 0.92, y: 1.04, z: 1.08 };
  const BOOST_PULSE_DURATION = 80;

  const SLIPSTREAM_LINE_COUNT = 4;
  const SLIPSTREAM_LINE_LENGTH = 2.5;
  const SLIPSTREAM_SPREAD = 0.6;

  // Kart-group local space: +Z is the nose (forward), −Z the tail.
  const DEFAULT_ANCHORS: CarRigAnchors = {
    frontLightX: 0.6,
    frontLightY: 0.4,
    frontLightZ: 2.1,
    rearLightX: 0.5,
    rearLightY: 0.4,
    rearLightZ: -1.8,
    nameY: 1.6,
    rearEffectZ: -1.0,
  };

  let groupRef: THREE.Group | undefined;
  let groupMounted = $state(false);
  let modelRootRef: THREE.Group | undefined;

  let wheelFLPivot: THREE.Group | undefined;
  let wheelFRPivot: THREE.Group | undefined;
  let wheelRearLeftSpin: THREE.Group | undefined;
  let wheelRearRightSpin: THREE.Group | undefined;
  let wheelFLSpin: THREE.Group | undefined;
  let wheelFRSpin: THREE.Group | undefined;

  let pointLightRef: THREE.PointLight | undefined;
  let slipstreamGroupRef: THREE.Group | undefined;
  let shadowRef: THREE.Mesh | undefined;

  let initialized = false;
  let currentSteer = 0;
  // Spin-exit recovery: the spin animation accumulates arbitrary visual
  // rotation — blend back to the pose heading instead of popping.
  let wasSpinning = false;
  let headingBlend = 0;
  let spinAccum = 0;
  let wheelSpinAccum = 0;
  let prevVisualHeading = 0;
  let smoothedTurnRate = 0;
  let smoothedPitch = 0;
  let smoothedSlipYaw = 0;
  const KART_MODEL_SCALE = 5;
  let currentScale = KART_MODEL_SCALE;
  let prevSpeed = 0;
  let squashX = 1;
  let squashY = 1;
  let squashZ = 1;
  let boostPulseStartTime = 0;
  let wasBoostActive = false;
  let wasShrunk = false;
  let shrinkAnimT = 0;
  let slipstreamPhase = 0;
  let builtCarId: string | null = null;
  let modelAnchors = $state<CarRigAnchors>({ ...DEFAULT_ANCHORS });

  const wheelSpinAxis = new THREE.Vector3(1, 0, 0);
  const wheelSteerAxis = new THREE.Vector3(0, 1, 0);
  const wheelSpinQuat = new THREE.Quaternion();
  const wheelSteerQuat = new THREE.Quaternion();

  // Per-rig body materials (cloned in buildCarRig) with their base look cached
  // for exact restoration after a status tint. Scratch Color objects avoid
  // per-frame allocation while computing tints.
  let bodyMaterials: BodyMaterial[] = [];
  const shrunkColor = new THREE.Color(SHRUNK_TINT);
  const scratchColor = new THREE.Color();
  // Last tint mode written, so we only touch the materials on a change (or each
  // frame while animating — flash/star, which are time-varying).
  let lastTintMode: "base" | "flash" | "star" | "shrunk" | "none" = "none";

  function restoreBaseMaterials(): void {
    for (const bm of bodyMaterials) {
      bm.material.color.copy(bm.baseColor);
      bm.material.emissive.copy(bm.baseEmissive);
      bm.material.emissiveIntensity = bm.baseEmissiveIntensity;
    }
  }

  /** Dispose a rig's cloned materials (built fresh per car build). */
  function disposeBodyMaterials(mats: BodyMaterial[]): void {
    for (const bm of mats) bm.material.dispose();
  }

  // Cheap blob contact shadow: radial-gradient transparent-black texture.
  function createBlobShadowTexture(): THREE.CanvasTexture {
    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const gradient = ctx.createRadialGradient(
      size / 2,
      size / 2,
      0,
      size / 2,
      size / 2,
      size / 2,
    );
    gradient.addColorStop(0, "rgba(0,0,0,0.5)");
    gradient.addColorStop(0.55, "rgba(0,0,0,0.32)");
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    return new THREE.CanvasTexture(canvas);
  }

  const shadowTexture = createBlobShadowTexture();

  onDestroy(() => {
    shadowTexture.dispose();
    disposeBodyMaterials(bodyMaterials);
    bodyMaterials = [];
  });

  $effect(() => {
    const kart = store.karts[kartId];
    if (!groupMounted || !groupRef || !kart) return;

    const loadedGltf = $gltf;
    if (!loadedGltf) return;

    const nextCarId = kart.carId;
    if (nextCarId === builtCarId && modelRootRef) return;

    if (modelRootRef) {
      groupRef.remove(modelRootRef);
      modelRootRef = undefined;
    }
    // The outgoing rig's materials were cloned per-rig — dispose them so a
    // car switch doesn't leak GPU programs/uniforms.
    if (bodyMaterials.length) {
      disposeBodyMaterials(bodyMaterials);
      bodyMaterials = [];
    }
    lastTintMode = "none";

    wheelFLPivot = undefined;
    wheelFRPivot = undefined;
    wheelRearLeftSpin = undefined;
    wheelRearRightSpin = undefined;
    wheelFLSpin = undefined;
    wheelFRSpin = undefined;
    modelAnchors = { ...DEFAULT_ANCHORS };

    const rig = buildCarRig(loadedGltf.scene, getRaceCar(nextCarId));
    if (!rig) return;

    groupRef.add(rig.root);
    modelRootRef = rig.root;
    wheelFLPivot = rig.wheels.frontLeft?.pivot;
    wheelFRPivot = rig.wheels.frontRight?.pivot;
    wheelRearLeftSpin = rig.wheels.rearLeft?.spin;
    wheelRearRightSpin = rig.wheels.rearRight?.spin;
    wheelFLSpin = rig.wheels.frontLeft?.spin;
    wheelFRSpin = rig.wheels.frontRight?.spin;
    wheelSpinAxis.copy(rig.wheelSpinAxis);
    wheelSteerAxis.copy(rig.steerAxis);
    bodyMaterials = rig.bodyMaterials;
    smoothedSlipYaw = 0;
    modelAnchors = rig.anchors;
    builtCarId = nextCarId;
  });

  useTask((delta) => {
    if (!groupRef) return;

    const kart: KartState | undefined = store.karts[kartId];
    if (!kart) return;

    // --- Pose source ---
    // Local kart while racing: client-side prediction — the shared physics
    // step (stepKart) runs at render rate on the latest input plus a decaying
    // reconciliation offset, so steering responds THIS frame instead of a
    // server round-trip later. Remote karts (and the local kart outside
    // racing): render ~100ms behind the newest snapshot, interpolating
    // between buffered snapshots with capped velocity extrapolation on gaps.
    // Raw store state is the last-resort fallback (waiting-phase grids).
    let pose = isLocal ? store.stepLocalPrediction(delta) : null;
    if (!pose) pose = store.sampleKartPose(kartId, performance.now());

    const tx = pose ? pose.x : kart.position.x;
    const tz = pose ? pose.z : kart.position.z;
    const heading = pose ? pose.heading : kart.heading;
    const speed = pose ? pose.speed : kart.speed;
    const status = kart.status;
    const driftActive = kart.driftState.active;
    const driftDir = kart.driftState.direction;
    const isBoostedNow =
      kart.boostTimer > 0 || status === "boosted" || status === "starred";
    const isSlipstream = kart.slipstreamActive;

    // Ground the visual: the server hovers karts 2.5 above the road.
    const targetY = (pose ? pose.y : kart.position.y) - KART_VISUAL_Y_OFFSET;

    if (initialized) {
      const snapDx = tx - groupRef.position.x;
      const snapDz = tz - groupRef.position.z;
      if (
        snapDx * snapDx + snapDz * snapDz >
        TELEPORT_SNAP_DISTANCE * TELEPORT_SNAP_DISTANCE
      ) {
        // Teleport (respawn/lightning/rematch grid) — snap, don't glide.
        initialized = false;
      }
    }

    if (!initialized) {
      groupRef.position.set(tx, targetY, tz);
      groupRef.rotation.set(0, heading, 0);
      prevVisualHeading = heading;
      prevSpeed = speed;
      smoothedTurnRate = 0;
      smoothedPitch = 0;
      smoothedSlipYaw = 0;
      currentSteer = 0;
      wasSpinning = false;
      headingBlend = 0;
      if (modelRootRef) modelRootRef.rotation.y = 0;
      initialized = true;
      return;
    }

    const prevPosX = groupRef.position.x;
    const prevPosY = groupRef.position.y;
    const prevPosZ = groupRef.position.z;

    // Pose sources are already smooth (prediction or interpolation) — apply
    // directly so no extra lerp latency stacks on top.
    groupRef.position.x = tx;
    groupRef.position.y = targetY;
    groupRef.position.z = tz;

    let angleDiff = heading - groupRef.rotation.y;
    while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
    while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

    if (status === "spinning") {
      spinAccum += SPIN_SPEED * delta;
      groupRef.rotation.y += SPIN_SPEED * delta;
      wasSpinning = true;
    } else {
      spinAccum = 0;
      if (wasSpinning) {
        // The spin animation left an arbitrary visual heading — recover
        // smoothly instead of popping.
        wasSpinning = false;
        headingBlend = 1;
      }
      if (headingBlend > 0 && Math.abs(angleDiff) > 0.02) {
        headingBlend = Math.max(0, headingBlend - delta * 2);
        groupRef.rotation.y += angleDiff * (1 - Math.exp(-10 * delta));
      } else {
        headingBlend = 0;
        groupRef.rotation.y = heading;
      }
    }

    const accel = speed - prevSpeed;
    prevSpeed = speed;

    if (isBoostedNow && !wasBoostActive) {
      boostPulseStartTime = performance.now();
    }
    wasBoostActive = isBoostedNow;

    const isShrunk = status === "shrunk";
    if (isShrunk && !wasShrunk) {
      shrinkAnimT = 0;
    }
    wasShrunk = isShrunk;
    if (isShrunk && shrinkAnimT < 1) {
      shrinkAnimT = Math.min(1, shrinkAnimT + delta * 8);
    }

    let targetSX = 1;
    let targetSY = 1;
    let targetSZ = 1;

    const boostPulseElapsed = performance.now() - boostPulseStartTime;
    if (boostPulseElapsed < BOOST_PULSE_DURATION && boostPulseStartTime > 0) {
      const boostPulse = 1 - boostPulseElapsed / BOOST_PULSE_DURATION;
      targetSX = 1 + (BOOST_PULSE.x - 1) * boostPulse;
      targetSY = 1 + (BOOST_PULSE.y - 1) * boostPulse;
      targetSZ = 1 + (BOOST_PULSE.z - 1) * boostPulse;
    } else if (accel > 0.005) {
      const blend = Math.min(accel / 0.02, 1);
      targetSX = 1 + (ACCEL_STRETCH.x - 1) * blend;
      targetSY = 1 + (ACCEL_STRETCH.y - 1) * blend;
      targetSZ = 1 + (ACCEL_STRETCH.z - 1) * blend;
    } else if (accel < -0.005) {
      const blend = Math.min(-accel / 0.04, 1);
      targetSX = 1 + (BRAKE_SQUASH.x - 1) * blend;
      targetSY = 1 + (BRAKE_SQUASH.y - 1) * blend;
      targetSZ = 1 + (BRAKE_SQUASH.z - 1) * blend;
    }

    if (isShrunk && shrinkAnimT < 1) {
      const squashPhase = Math.sin(shrinkAnimT * Math.PI);
      targetSX *= 1 + squashPhase * 0.15;
      targetSY *= 1 - squashPhase * 0.1;
      targetSZ *= 1 - squashPhase * 0.05;
    }

    const squashLerp = Math.min(1, 12 * delta);
    squashX += (targetSX - squashX) * squashLerp;
    squashY += (targetSY - squashY) * squashLerp;
    squashZ += (targetSZ - squashZ) * squashLerp;

    const targetScale = isShrunk ? SHRUNK_SCALE * KART_MODEL_SCALE : KART_MODEL_SCALE;
    currentScale += (targetScale - currentScale) * Math.min(1, 8 * delta);
    groupRef.scale.set(
      currentScale * squashX,
      currentScale * squashY,
      currentScale * squashZ,
    );

    const visualHeading = groupRef.rotation.y;
    let visualTurnDelta = visualHeading - prevVisualHeading;
    if (visualTurnDelta > Math.PI) visualTurnDelta -= Math.PI * 2;
    if (visualTurnDelta < -Math.PI) visualTurnDelta += Math.PI * 2;
    prevVisualHeading = visualHeading;

    const rawTurnRate = delta > 0 ? visualTurnDelta / delta : 0;
    smoothedTurnRate +=
      (rawTurnRate - smoothedTurnRate) * Math.min(1, 3 * delta);
    const turnRateNorm = Math.max(-1, Math.min(1, smoothedTurnRate / 2.5));
    // turnRateNorm > 0 = turning left (heading increasing); driftDir follows
    // the server's sign(input.steering) where positive steering turns RIGHT.
    const steerSignal = driftActive && driftDir !== 0 ? -driftDir : turnRateNorm;

    // Drift pose: yaw the model root (not the physics group) by the server's
    // slip angle so the kart hangs sideways through drifts.
    let slipSign = 0;
    if (driftActive && driftDir !== 0) {
      slipSign = driftDir;
    } else if (Math.abs(smoothedTurnRate) > 0.05) {
      slipSign = smoothedTurnRate > 0 ? -1 : 1;
    }
    const targetSlipYaw = -slipSign * (kart.slipAngle ?? 0) * DRIFT_POSE_GAIN;
    smoothedSlipYaw +=
      (targetSlipYaw - smoothedSlipYaw) * (1 - Math.exp(-10 * delta));
    if (modelRootRef) {
      modelRootRef.rotation.y = smoothedSlipYaw;
    }

    // Pitch from per-frame motion (positive rotation.x dips the nose), roll
    // lean into the turn from the smoothed turn rate. Group order is YXZ so
    // pitch/roll happen in the heading-local frame.
    const movedX = groupRef.position.x - prevPosX;
    const movedY = groupRef.position.y - prevPosY;
    const movedZ = groupRef.position.z - prevPosZ;
    const forwardDist =
      movedX * Math.sin(visualHeading) + movedZ * Math.cos(visualHeading);
    let targetPitch = 0;
    if (Math.abs(forwardDist) > 1e-3) {
      targetPitch = Math.max(
        -MAX_BODY_PITCH,
        Math.min(
          MAX_BODY_PITCH,
          Math.atan2(movedY * Math.sign(forwardDist), Math.abs(forwardDist)),
        ),
      );
    }
    smoothedPitch +=
      (targetPitch - smoothedPitch) * (1 - Math.exp(-8 * delta));
    groupRef.rotation.x = -smoothedPitch;
    groupRef.rotation.z = -BODY_LEAN_MAX * turnRateNorm;

    const wheelSpinRate = Math.max(
      -MAX_WHEEL_SPIN_RATE,
      Math.min(MAX_WHEEL_SPIN_RATE, speed * WHEEL_SPIN_FACTOR),
    );
    wheelSpinAccum += wheelSpinRate * delta;
    if (wheelSpinAccum > Math.PI) wheelSpinAccum -= Math.PI * 2;
    if (wheelSpinAccum < -Math.PI) wheelSpinAccum += Math.PI * 2;

    const targetSteerAngle = Math.max(
      -MAX_STEER_ANGLE,
      Math.min(MAX_STEER_ANGLE, steerSignal * MAX_STEER_ANGLE),
    );
    currentSteer +=
      (targetSteerAngle - currentSteer) * Math.min(1, 10 * delta);

    // Steering yaws the pivot around the car's up axis (composed before the
    // spin, which rolls the wheel around its steered axle).
    wheelSpinQuat.setFromAxisAngle(wheelSpinAxis, wheelSpinAccum);
    wheelSteerQuat.setFromAxisAngle(wheelSteerAxis, currentSteer);
    if (wheelFLPivot) {
      wheelFLPivot.quaternion.copy(wheelSteerQuat);
      if (wheelFLSpin) wheelFLSpin.quaternion.copy(wheelSpinQuat);
    }
    if (wheelFRPivot) {
      wheelFRPivot.quaternion.copy(wheelSteerQuat);
      if (wheelFRSpin) wheelFRSpin.quaternion.copy(wheelSpinQuat);
    }
    if (wheelRearLeftSpin) {
      wheelRearLeftSpin.quaternion.copy(wheelSpinQuat);
    }
    if (wheelRearRightSpin) {
      wheelRearRightSpin.quaternion.copy(wheelSpinQuat);
    }

    if (shadowRef) {
      // Contact shadow stretches slightly along the car at speed.
      const speedStretch = 1 + Math.min(Math.abs(speed) / 3, 1) * 0.18;
      shadowRef.scale.set(1, speedStretch, 1);
    }

    // --- Status / hit material VFX (emissive-driven; bloom carries glow) ---
    // Priority: a fresh hit flash overrides everything; then star rainbow; then
    // the shrunk wash; otherwise restore the cached base look. Star hue is
    // animated, so it writes every frame; flat states write once on entry.
    if (bodyMaterials.length) {
      const hitElapsed =
        store.lastHitKartId === kartId
          ? performance.now() - store.lastHitTime
          : Infinity;
      const flashing = hitElapsed < HIT_FLASH_MS;

      if (flashing) {
        // White emissive pop, brightest at impact, decaying over the window.
        const t = 1 - hitElapsed / HIT_FLASH_MS;
        const e = HIT_FLASH_EMISSIVE * t;
        for (const bm of bodyMaterials) {
          bm.material.color.copy(bm.baseColor);
          bm.material.emissive.setRGB(1, 1, 1);
          bm.material.emissiveIntensity = bm.baseEmissiveIntensity + e;
        }
        lastTintMode = "flash";
      } else if (status === "starred") {
        // HSL hue-cycle the emissive ~3Hz for the invincibility rainbow.
        const hue = (performance.now() * 0.001 * STAR_HUE_HZ) % 1;
        scratchColor.setHSL(hue, 1, 0.55);
        for (const bm of bodyMaterials) {
          bm.material.color.copy(bm.baseColor);
          bm.material.emissive.copy(scratchColor);
          bm.material.emissiveIntensity = STAR_EMISSIVE;
        }
        lastTintMode = "star";
      } else if (status === "shrunk") {
        if (lastTintMode !== "shrunk") {
          for (const bm of bodyMaterials) {
            bm.material.color
              .copy(bm.baseColor)
              .lerp(shrunkColor, SHRUNK_TINT_BLEND);
            bm.material.emissive.copy(bm.baseEmissive);
            bm.material.emissiveIntensity = bm.baseEmissiveIntensity * 0.4;
          }
          lastTintMode = "shrunk";
        }
      } else if (lastTintMode !== "base") {
        restoreBaseMaterials();
        lastTintMode = "base";
      }
    }

    if (pointLightRef) {
      pointLightRef.color.set(getPlayerAccentColor(kart.accentIndex));
      let intensity = status === "boosted" || status === "starred" ? 4 : 2;
      if (status === "starred") {
        // Pulse the kept accent light in time with the rainbow body.
        intensity = 4 + Math.sin(performance.now() * 0.012) * 2;
      }
      pointLightRef.intensity = intensity;
    }

    if (slipstreamGroupRef) {
      slipstreamGroupRef.visible = isSlipstream;
      if (isSlipstream) {
        slipstreamPhase += delta * 8;
        const children = slipstreamGroupRef.children;
        for (let i = 0; i < children.length; i++) {
          const line = children[i];
          const phase = (slipstreamPhase + i * 0.25) % 1.0;
          const zOffset = -0.5 - phase * SLIPSTREAM_LINE_LENGTH;
          const xSpread =
            (i / (SLIPSTREAM_LINE_COUNT - 1) - 0.5) *
            SLIPSTREAM_SPREAD *
            2;
          line.position.set(
            xSpread,
            0.4 + Math.sin(phase * Math.PI) * 0.15,
            zOffset,
          );
          const scaleX = 0.3 + Math.sin(phase * Math.PI) * 0.7;
          line.scale.set(scaleX, 1, 1);
          const material = (line as THREE.Mesh)
            .material as THREE.MeshBasicMaterial;
          if (material && material.opacity !== undefined) {
            material.opacity = Math.sin(phase * Math.PI) * 0.5;
          }
        }
      }
    }
  });

  const kartColor = $derived.by(() => {
    const kart = store.karts[kartId];
    return getPlayerAccentColor(kart?.accentIndex ?? 0);
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

  // --- Trailed-item rear defense (held-behind) ---
  // Color the trailed mesh by item type; bananas read as yellow, shells by hue.
  const HELD_ITEM_COLORS: Record<string, string> = {
    greenShell: "#44FF88",
    redShell: "#FF4444",
    blueShell: "#4488FF",
    banana: "#FFDD33",
  };

  const heldItemActive = $derived.by(() => {
    const kart = store.karts[kartId];
    return kart?.heldItemActive ?? false;
  });

  const heldItemColor = $derived.by(() => {
    const kart = store.karts[kartId];
    return HELD_ITEM_COLORS[kart?.currentItem ?? ""] ?? "#FFFFFF";
  });

  const heldItemIsBanana = $derived.by(() => {
    const kart = store.karts[kartId];
    return kart?.currentItem === "banana";
  });
</script>

{#if kartExists}
  <T.Group
    oncreate={(ref) => {
      // Yaw → pitch → roll so pitch/roll apply in the heading-local frame.
      ref.rotation.order = "YXZ";
      groupRef = ref;
      groupMounted = true;
    }}
  >
    <!-- The ONE permanent per-kart light (accent). Intensity is toggled in
         useTask, never mounted/unmounted, so NUM_POINT_LIGHTS stays constant
         and shaders never recompile mid-race. All other glow (headlights,
         taillights, drift sparks, boost flame) is emissive-only + bloom. -->
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

    <T.Mesh
      oncreate={(ref) => {
        shadowRef = ref;
      }}
      rotation.x={-Math.PI / 2}
      position.y={0.01}
      renderOrder={1}
    >
      <T.CircleGeometry args={[SHADOW_RADIUS, 24]} />
      <T.MeshBasicMaterial
        map={shadowTexture}
        transparent
        depthWrite={false}
      />
    </T.Mesh>

    <T.Mesh rotation.x={-Math.PI / 2} position.y={0.02} renderOrder={2}>
      <T.RingGeometry args={[0.6, 0.9, 32]} />
      <T.MeshBasicMaterial
        color={kartColor}
        transparent
        opacity={0.35}
        side={THREE.DoubleSide}
        depthWrite={false}
      />
    </T.Mesh>

    {#if isLocal}
      <T.Mesh rotation.x={-Math.PI / 2} position.y={0.03} renderOrder={3}>
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

    <!-- Headlight glow spheres — emissive past bloom threshold; the bloom
         pass carries the halo that the deleted headlight PointLights faked. -->
    <T.Mesh
      position={[
        -modelAnchors.frontLightX,
        modelAnchors.frontLightY,
        modelAnchors.frontLightZ,
      ]}
    >
      <T.SphereGeometry args={[0.08, 8, 6]} />
      <T.MeshStandardMaterial
        color="#FFFFEE"
        emissive="#FFFFEE"
        emissiveIntensity={2.5}
      />
    </T.Mesh>
    <T.Mesh
      position={[
        modelAnchors.frontLightX,
        modelAnchors.frontLightY,
        modelAnchors.frontLightZ,
      ]}
    >
      <T.SphereGeometry args={[0.08, 8, 6]} />
      <T.MeshStandardMaterial
        color="#FFFFEE"
        emissive="#FFFFEE"
        emissiveIntensity={2.5}
      />
    </T.Mesh>

    <!-- Taillight glow spheres -->
    <T.Mesh
      position={[
        -modelAnchors.rearLightX,
        modelAnchors.rearLightY,
        modelAnchors.rearLightZ,
      ]}
    >
      <T.SphereGeometry args={[0.08, 8, 6]} />
      <T.MeshStandardMaterial
        color="#FF2200"
        emissive="#FF2200"
        emissiveIntensity={2.5}
      />
    </T.Mesh>
    <T.Mesh
      position={[
        modelAnchors.rearLightX,
        modelAnchors.rearLightY,
        modelAnchors.rearLightZ,
      ]}
    >
      <T.SphereGeometry args={[0.08, 8, 6]} />
      <T.MeshStandardMaterial
        color="#FF2200"
        emissive="#FF2200"
        emissiveIntensity={2.5}
      />
    </T.Mesh>

    <T.Group position.z={modelAnchors.rearEffectZ - 0.75}>
      <DriftSparks active={driftActive} charge={driftCharge} color={kartColor} />
    </T.Group>

    <!-- Flipped 180° so the flame cone points backwards (−Z, out the tail) -->
    <T.Group position.z={modelAnchors.rearEffectZ} rotation.y={Math.PI}>
      <BoostFlame active={isBoosted} intensity={1} />
    </T.Group>

    <!-- Trailed item (rear defense): the held shell/banana dragged behind the
         kart while the item key is held. Emissive so the bloom carries the glow;
         a banana reads as a flattened sphere, a shell as a glowing orb. -->
    {#if heldItemActive}
      <T.Group position={[0, 0.35, modelAnchors.rearEffectZ - 0.45]}>
        <T.Mesh scale={heldItemIsBanana ? [0.42, 0.26, 0.42] : [0.34, 0.34, 0.34]}>
          <T.SphereGeometry args={[1, 14, 10]} />
          <T.MeshStandardMaterial
            color={heldItemColor}
            emissive={heldItemColor}
            emissiveIntensity={1.6}
            metalness={0.4}
            roughness={0.25}
          />
        </T.Mesh>
      </T.Group>
    {/if}

    <T.Group
      oncreate={(ref) => {
        slipstreamGroupRef = ref;
      }}
      visible={false}
    >
      {#each Array(SLIPSTREAM_LINE_COUNT) as _, i (i)}
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

    {#if !isLocal}
      <HTML position.y={modelAnchors.nameY} center pointerEvents="none" sprite>
        <div style={nameLabelStyle}>
          {kartName}
        </div>
      </HTML>
    {/if}
  </T.Group>
{/if}
