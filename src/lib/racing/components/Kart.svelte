<!--
  Kart.svelte — renders a single racing kart from the curated generic car pack.

  Loads the shared 20-car GLTF once, clones only the selected curated car root,
  recenters it, and wraps each wheel in pivot/spin groups so steering and
  rolling stay independent from the source asset hierarchy.
-->
<script lang="ts">
  import { T, useTask } from "@threlte/core";
  import { HTML, useGltf } from "@threlte/extras";
  import * as THREE from "three";
  import { getRaceStore } from "$lib/racing/context.js";
  import { buildCarRig, type CarRigAnchors } from "$lib/racing/build-car-rig.js";
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

  const LERP_SPEED = 15;
  const ROTATION_LERP_SPEED = 12;
  const WHEEL_SPIN_FACTOR = 80;
  const MAX_STEER_ANGLE = 0.3;
  const SHRUNK_SCALE = 0.6;
  const SPIN_SPEED = 12;

  const ACCEL_STRETCH = { x: 0.95, y: 1.02, z: 1.05 };
  const BRAKE_SQUASH = { x: 1.06, y: 0.97, z: 0.94 };
  const BOOST_PULSE = { x: 0.92, y: 1.04, z: 1.08 };
  const BOOST_PULSE_DURATION = 80;

  const SLIPSTREAM_LINE_COUNT = 4;
  const SLIPSTREAM_LINE_LENGTH = 2.5;
  const SLIPSTREAM_SPREAD = 0.6;

  const DEFAULT_ANCHORS: CarRigAnchors = {
    frontLightX: 0.6,
    frontLightY: 0.4,
    frontLightZ: -2.1,
    rearLightX: 0.5,
    rearLightY: 0.4,
    rearLightZ: 1.8,
    nameY: 1.6,
    rearEffectZ: 1.0,
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

  let initialized = false;
  let lastTargetX = 0;
  let lastTargetZ = 0;
  let snapshotTime = 0;
  let currentSteer = 0;
  let spinAccum = 0;
  let wheelSpinAccum = 0;
  let prevVisualHeading = 0;
  let smoothedTurnRate = 0;
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
  const wheelSpinQuat = new THREE.Quaternion();

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
    modelAnchors = rig.anchors;
    builtCarId = nextCarId;
  });

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
    const isBoostedNow =
      kart.boostTimer > 0 || status === "boosted" || status === "starred";
    const isSlipstream = kart.slipstreamActive;

    if (tx !== lastTargetX || tz !== lastTargetZ) {
      lastTargetX = tx;
      lastTargetZ = tz;
      snapshotTime = performance.now();
    }

    const extrapolationSec = Math.min(
      (performance.now() - snapshotTime) / 1000,
      0.05,
    );
    const etx = tx + vx * extrapolationSec * 60;
    const etz = tz + vz * extrapolationSec * 60;

    if (!initialized) {
      groupRef.position.set(tx, ty, tz);
      groupRef.rotation.y = heading;
      initialized = true;
      prevSpeed = speed;
      return;
    }

    const t = Math.min(1, LERP_SPEED * delta);
    groupRef.position.x += (etx - groupRef.position.x) * t;
    groupRef.position.z += (etz - groupRef.position.z) * t;
    // Y tracks faster since the server already smooths elevation
    const yt = Math.min(1, LERP_SPEED * 2 * delta);
    groupRef.position.y += (ty - groupRef.position.y) * yt;

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
    const steerSignal = driftActive ? driftDir : turnRateNorm;

    groupRef.rotation.z = 0;

    const wheelSpinDelta = speed * WHEEL_SPIN_FACTOR * delta;
    wheelSpinAccum += wheelSpinDelta;
    if (wheelSpinAccum > Math.PI) wheelSpinAccum -= Math.PI * 2;
    if (wheelSpinAccum < -Math.PI) wheelSpinAccum += Math.PI * 2;

    const targetSteerAngle = Math.max(
      -MAX_STEER_ANGLE,
      Math.min(MAX_STEER_ANGLE, steerSignal * MAX_STEER_ANGLE),
    );
    currentSteer +=
      (targetSteerAngle - currentSteer) * Math.min(1, 10 * delta);

    wheelSpinQuat.setFromAxisAngle(wheelSpinAxis, wheelSpinAccum);
    const visualSteerAngle = -currentSteer;
    if (wheelFLPivot) {
      wheelFLPivot.rotation.set(0, visualSteerAngle, 0);
      if (wheelFLSpin) wheelFLSpin.quaternion.copy(wheelSpinQuat);
    }
    if (wheelFRPivot) {
      wheelFRPivot.rotation.set(0, visualSteerAngle, 0);
      if (wheelFRSpin) wheelFRSpin.quaternion.copy(wheelSpinQuat);
    }
    if (wheelRearLeftSpin) {
      wheelRearLeftSpin.quaternion.copy(wheelSpinQuat);
    }
    if (wheelRearRightSpin) {
      wheelRearRightSpin.quaternion.copy(wheelSpinQuat);
    }

    if (pointLightRef) {
      pointLightRef.color.set(getPlayerAccentColor(kart.accentIndex));
      pointLightRef.intensity =
        status === "boosted" || status === "starred" ? 4 : 2;
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
</script>

{#if kartExists}
  <T.Group
    oncreate={(ref) => {
      groupRef = ref;
      groupMounted = true;
    }}
  >
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

    <T.PointLight
      color="#FFFFFF"
      intensity={3}
      distance={12}
      decay={2}
      position={[
        -modelAnchors.frontLightX,
        modelAnchors.frontLightY,
        modelAnchors.frontLightZ,
      ]}
    />
    <T.PointLight
      color="#FFFFFF"
      intensity={3}
      distance={12}
      decay={2}
      position={[
        modelAnchors.frontLightX,
        modelAnchors.frontLightY,
        modelAnchors.frontLightZ,
      ]}
    />

    <T.PointLight
      color="#FF2200"
      intensity={2}
      distance={4}
      decay={2}
      position={[
        -modelAnchors.rearLightX,
        modelAnchors.rearLightY,
        modelAnchors.rearLightZ,
      ]}
    />
    <T.PointLight
      color="#FF2200"
      intensity={2}
      distance={4}
      decay={2}
      position={[
        modelAnchors.rearLightX,
        modelAnchors.rearLightY,
        modelAnchors.rearLightZ,
      ]}
    />

    <T.Mesh
      position={[
        -modelAnchors.rearLightX,
        modelAnchors.rearLightY,
        modelAnchors.rearLightZ,
      ]}
    >
      <T.SphereGeometry args={[0.08, 8, 6]} />
      <T.MeshBasicMaterial color="#FF2200" transparent opacity={0.9} />
    </T.Mesh>
    <T.Mesh
      position={[
        modelAnchors.rearLightX,
        modelAnchors.rearLightY,
        modelAnchors.rearLightZ,
      ]}
    >
      <T.SphereGeometry args={[0.08, 8, 6]} />
      <T.MeshBasicMaterial color="#FF2200" transparent opacity={0.9} />
    </T.Mesh>

    <T.Group position.z={modelAnchors.rearEffectZ - 0.75}>
      <DriftSparks active={driftActive} charge={driftCharge} color={kartColor} />
    </T.Group>

    <T.Group position.z={modelAnchors.rearEffectZ - 0.5}>
      <BoostFlame active={isBoosted} intensity={1} />
    </T.Group>

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

    <HTML position.y={modelAnchors.nameY} center pointerEvents="none" sprite>
      <div style={nameLabelStyle}>
        {kartName}
      </div>
    </HTML>
  </T.Group>
{/if}
