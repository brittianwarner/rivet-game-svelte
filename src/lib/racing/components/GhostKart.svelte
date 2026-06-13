<!--
  GhostKart.svelte — translucent replay of a stored time-trial ghost.

  Reuses buildCarRig (same asset/rig as the live kart) but renders every body
  material transparent at low opacity, with no accent light, no name label, no
  contact shadow, and no collision — it is PURELY cosmetic and never touches the
  sim. The pose is sampled from the decoded ghost timeline against the live race
  clock (started at GO), with the SAME KART_VISUAL_Y_OFFSET the live kart applies
  so the ghost sits on the road at matching height.
-->
<script lang="ts">
  import { T, useTask } from "@threlte/core";
  import { useGltf } from "@threlte/extras";
  import { onDestroy } from "svelte";
  import * as THREE from "three";
  import { getRaceStore } from "$lib/racing/context.js";
  import { buildCarRig } from "$lib/racing/build-car-rig.js";
  import { getRaceCar, type RaceCarId } from "$lib/racing/car-catalog.js";
  import {
    sampleGhostPose,
    type GhostTimeline,
    type GhostPose,
  } from "$lib/racing/ghost-recorder.js";

  interface Props {
    timeline: GhostTimeline;
  }

  let { timeline }: Props = $props();

  const store = getRaceStore();

  // Match the live kart's grounding + model scale exactly.
  const KART_VISUAL_Y_OFFSET = 2.3;
  const KART_MODEL_SCALE = 5;
  const GHOST_OPACITY = 0.4;
  // Beyond this the ghost jumped (lap wrap / start) — snap instead of gliding.
  const TELEPORT_SNAP_DISTANCE = 18;

  type GenericCarsPackGltf = {
    scene: THREE.Group;
    nodes: Record<string, THREE.Object3D>;
    materials: Record<string, THREE.Material | THREE.Material[]>;
  };

  const gltf = useGltf<GenericCarsPackGltf>("/20x_generic_cars_gltf/scene.gltf");

  let groupRef: THREE.Group | undefined;
  let groupMounted = $state(false);
  let modelRootRef: THREE.Group | undefined;
  let builtCarId: RaceCarId | null = null;
  // Cloned, ghosted materials — disposed on rebuild/unmount.
  let ghostMaterials: THREE.Material[] = [];
  let initialized = false;

  // Smoothed race clock (ms since GO). store.raceTimer only ticks at snapshot
  // rate (~20Hz); extrapolate by wall-clock so the ghost glides, mirroring the
  // play page's smoothRaceTimer.
  let lastTimerBase = -1;
  let lastTimerBaseAt = 0;

  const pose: GhostPose = { x: 0, y: 0, z: 0, heading: 0 };

  function disposeGhostMaterials(): void {
    for (const m of ghostMaterials) m.dispose();
    ghostMaterials = [];
  }

  onDestroy(() => {
    disposeGhostMaterials();
  });

  // Build the rig for the ghost's car once the GLTF is ready (rebuild on a
  // car change, which only happens if a new ghost is swapped in).
  $effect(() => {
    if (!groupMounted || !groupRef) return;
    const loaded = $gltf;
    if (!loaded) return;

    const nextCarId = timeline.carId;
    if (nextCarId === builtCarId && modelRootRef) return;

    if (modelRootRef) {
      groupRef.remove(modelRootRef);
      modelRootRef = undefined;
    }
    disposeGhostMaterials();

    const rig = buildCarRig(loaded.scene, getRaceCar(nextCarId));
    if (!rig) return;

    // Ghost the whole rig: transparent, dimmed, depthWrite off so it reads as a
    // translucent apparition. buildCarRig already cloned the materials per-rig,
    // so mutating them here can't bleed into the live karts.
    rig.root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.renderOrder = 2;
      const apply = (mat: THREE.Material) => {
        mat.transparent = true;
        mat.opacity = GHOST_OPACITY;
        mat.depthWrite = false;
        const std = mat as THREE.MeshStandardMaterial;
        if (std.isMeshStandardMaterial) {
          // A cool spectral tint + faint self-glow so the ghost reads even on
          // bright asphalt; bloom (>1 not used here) stays off.
          std.emissive = new THREE.Color("#7fd0ff");
          std.emissiveIntensity = 0.25;
        }
        ghostMaterials.push(mat);
      };
      if (Array.isArray(mesh.material)) mesh.material.forEach(apply);
      else if (mesh.material) apply(mesh.material);
    });

    groupRef.add(rig.root);
    modelRootRef = rig.root;
    builtCarId = nextCarId;
    initialized = false;
  });

  useTask((delta) => {
    if (!groupRef) return;

    // The ghost only plays during the live race; park it (hidden) otherwise.
    if (store.phase !== "racing") {
      groupRef.visible = false;
      initialized = false;
      return;
    }
    groupRef.visible = true;

    // Smooth race clock (ms since GO).
    const base = store.raceTimer;
    const now = performance.now();
    if (base !== lastTimerBase) {
      lastTimerBase = base;
      lastTimerBaseAt = now;
    }
    const raceTimeMs = base + (now - lastTimerBaseAt);

    sampleGhostPose(timeline, raceTimeMs, pose);

    const tx = pose.x;
    const ty = pose.y - KART_VISUAL_Y_OFFSET;
    const tz = pose.z;

    if (initialized) {
      const dx = tx - groupRef.position.x;
      const dz = tz - groupRef.position.z;
      if (dx * dx + dz * dz > TELEPORT_SNAP_DISTANCE * TELEPORT_SNAP_DISTANCE) {
        initialized = false; // lap wrap / restart — snap
      }
    }

    if (!initialized) {
      groupRef.position.set(tx, ty, tz);
      groupRef.rotation.set(0, pose.heading, 0);
      initialized = true;
      return;
    }

    // The sampled pose is already smooth (10Hz interpolation) — a light lerp
    // hides any residual stair-stepping between sample slots.
    const k = 1 - Math.exp(-18 * Math.min(delta, 0.05));
    groupRef.position.x += (tx - groupRef.position.x) * k;
    groupRef.position.y += (ty - groupRef.position.y) * k;
    groupRef.position.z += (tz - groupRef.position.z) * k;

    let dh = pose.heading - groupRef.rotation.y;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    groupRef.rotation.y += dh * k;
  });
</script>

<T.Group
  scale={KART_MODEL_SCALE}
  oncreate={(ref) => {
    ref.rotation.order = "YXZ";
    ref.visible = false;
    groupRef = ref;
    groupMounted = true;
  }}
></T.Group>
