<!--
  SkidMarks — scene-level drift juice. Mounted ONCE inside the Canvas by
  RaceScene. Owns two pooled, world-space systems shared across every kart:

  (1) SKID RIBBON — a single pooled BufferGeometry ring buffer (~2000 quads,
      one draw call) of dark tire marks stamped on the asphalt. Each frame we
      read every kart's smooth render pose (prediction for the local kart,
      interpolation for remotes — the SAME sources Kart.svelte renders from)
      and, while the kart is drifting (or sliding hard), append one quad per
      rear wheel bridging last frame's contact point to this frame's. Quads
      fade out over ~6s via a per-vertex alpha channel (RGBA vertex colors,
      itemSize 4) decremented on the CPU — no per-mark draw calls, no shader
      patching. depthWrite is off + polygonOffset + a high renderOrder so the
      ribbon layers cleanly over the road without z-fighting.

  (2) SMOKE — a world-space, camera-billboarded puff pool. Puffs are spawned
      at the rear wheels of drifting karts but, unlike the old kart-parented
      version, they are stamped into WORLD space at emit time so they hang in
      the air where they were laid down and trail on the track behind the car.
      Puff lifetime is decoupled from the drift flag: releasing drift stops
      SPAWNING but in-flight puffs finish their rise-and-fade.

  Both systems are purely cosmetic — zero server involvement, server stays
  authoritative.
-->
<script lang="ts">
  import { T, useTask, useThrelte } from "@threlte/core";
  import * as THREE from "three";
  import { onDestroy } from "svelte";
  import { getRaceStore } from "$lib/racing/context.js";
  import { DRIFT_CHARGE_COLORS, type KartState } from "$lib/racing/types.js";

  const store = getRaceStore();
  const { camera } = useThrelte();

  // ---------------------------------------------------------------------------
  // Shared geometry constants
  // ---------------------------------------------------------------------------

  // The kart group renders at pose.y − KART_VISUAL_Y_OFFSET (2.3, see
  // Kart.svelte); place marks/puffs at that contact height plus a hair so they
  // sit on the asphalt rather than inside it.
  const KART_VISUAL_Y_OFFSET = 2.3;
  const GROUND_LIFT = 0.05;
  // Rear-wheel contact offsets in world units (kart-local +Z is the nose).
  const WHEEL_LATERAL = 0.9;
  const WHEEL_LONGITUDINAL = -1.3;

  // Skidding gate: lay marks while drifting or while sliding hard enough that
  // a non-drift slide (e.g. a hairpin scrub) still scuffs the road.
  const SLIP_MARK_THRESHOLD = 0.18;

  // ---------------------------------------------------------------------------
  // Skid ribbon — pooled quad ring buffer
  // ---------------------------------------------------------------------------

  const MAX_QUADS = 2000;
  const VERTS_PER_QUAD = 6; // two triangles, non-indexed
  const MAX_VERTS = MAX_QUADS * VERTS_PER_QUAD;
  const MARK_HALF_WIDTH = 0.16; // half tire-mark width
  const MARK_LIFETIME = 6.0; // seconds until fully faded
  const MARK_MAX_ALPHA = 0.55;
  // Skip degenerate / teleport gaps between successive contact points.
  const MIN_SEGMENT = 0.05;
  const MAX_SEGMENT = 5.0;

  const skidGeo = new THREE.BufferGeometry();
  const skidPositions = new Float32Array(MAX_VERTS * 3);
  // RGBA vertex colors (itemSize 4) — three r172 multiplies the alpha channel
  // into the fragment, giving us a free per-vertex fade with no shader patch.
  const skidColors = new Float32Array(MAX_VERTS * 4);
  const skidPosAttr = new THREE.BufferAttribute(skidPositions, 3);
  const skidColAttr = new THREE.BufferAttribute(skidColors, 4);
  skidPosAttr.setUsage(THREE.DynamicDrawUsage);
  skidColAttr.setUsage(THREE.DynamicDrawUsage);
  skidGeo.setAttribute("position", skidPosAttr);
  skidGeo.setAttribute("color", skidColAttr);
  skidGeo.setDrawRange(0, 0);

  const skidMat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  // Ring-buffer write head (in quads) + the birth time of each quad so we can
  // both fade and reclaim it. headQuad points at the next quad slot to write.
  let headQuad = 0;
  let liveQuads = 0;
  const quadBirth = new Float32Array(MAX_QUADS); // performance.now()/1000 secs
  const quadAlive = new Uint8Array(MAX_QUADS);
  // Dirty vertex window for POSITIONS (only written when a quad is pushed).
  // Colors change everywhere every frame (the fade), so those upload wholesale.
  let posDirtyMin = Infinity;
  let posDirtyMax = -Infinity;
  let colorsDirty = false;

  // Per-kart last contact points (world space) for the two rear wheels, so we
  // can bridge a quad from the previous frame to this one.
  interface WheelTrail {
    lx: number;
    lz: number;
    rx: number;
    rz: number;
    has: boolean;
  }
  const trails = new Map<string, WheelTrail>();

  const skidColor = new THREE.Color("#1a1410");

  function markPosDirty(minVert: number, maxVert: number): void {
    if (minVert < posDirtyMin) posDirtyMin = minVert;
    if (maxVert > posDirtyMax) posDirtyMax = maxVert;
  }

  // Write one ribbon quad (a→b along the trail, widened by ±half across the
  // travel direction) into the ring buffer at the current head.
  //
  // `halfWidth` and `darken` let higher drift tiers lay wider, darker rubber:
  // both default to the baseline so a plain hairpin scuff is unchanged. Only the
  // RGB channels carry `darken` — the per-frame fade loop owns the alpha channel
  // (index +3), so we never fight it here (writing a static alpha that the fade
  // immediately overwrites would be wasted work, but it seeds the first frame).
  function pushQuad(
    ax: number,
    az: number,
    bx: number,
    bz: number,
    y: number,
    halfWidth: number = MARK_HALF_WIDTH,
    darken: number = 1,
  ): void {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < MIN_SEGMENT || len > MAX_SEGMENT) return;
    // Perpendicular (in the ground plane) for the mark width.
    const px = (-dz / len) * halfWidth;
    const pz = (dx / len) * halfWidth;

    const q = headQuad;
    const base = q * VERTS_PER_QUAD;
    // Four corners: a-left, a-right, b-left, b-right.
    const alx = ax + px, alz = az + pz;
    const arx = ax - px, arz = az - pz;
    const blx = bx + px, blz = bz + pz;
    const brx = bx - px, brz = bz - pz;

    // Two triangles: (al, ar, br), (al, br, bl).
    const corners = [
      alx, alz,
      arx, arz,
      brx, brz,
      alx, alz,
      brx, brz,
      blx, blz,
    ];
    const cr = skidColor.r * darken;
    const cg = skidColor.g * darken;
    const cb = skidColor.b * darken;
    for (let i = 0; i < VERTS_PER_QUAD; i++) {
      const vi = (base + i) * 3;
      skidPositions[vi] = corners[i * 2];
      skidPositions[vi + 1] = y;
      skidPositions[vi + 2] = corners[i * 2 + 1];
      const ci = (base + i) * 4;
      skidColors[ci] = cr;
      skidColors[ci + 1] = cg;
      skidColors[ci + 2] = cb;
      skidColors[ci + 3] = MARK_MAX_ALPHA;
    }

    quadBirth[q] = performance.now() / 1000;
    if (!quadAlive[q]) {
      quadAlive[q] = 1;
      liveQuads++;
    }
    markPosDirty(base, base + VERTS_PER_QUAD);
    colorsDirty = true;

    headQuad = (q + 1) % MAX_QUADS;
  }

  // ---------------------------------------------------------------------------
  // Smoke — world-space billboarded puff pool
  // ---------------------------------------------------------------------------

  const SMOKE_COUNT = 48;
  const SMOKE_LIFETIME = 0.85; // seconds
  const SMOKE_EXPAND_RATE = 2.2;
  const SMOKE_RISE_SPEED = 1.4;
  const SMOKE_DRIFT_SPREAD = 0.4;
  const SMOKE_START_SIZE = 0.18;
  const SMOKE_START_ALPHA = 0.42;
  // How long between puff emissions per drifting wheel.
  const SMOKE_SPAWN_INTERVAL = 0.045;

  interface SmokePuff {
    x: number;
    y: number;
    z: number;
    vx: number;
    vz: number;
    age: number;
    scale: number;
    active: boolean;
    r: number;
    g: number;
    b: number;
  }

  const smokePuffs: SmokePuff[] = Array.from({ length: SMOKE_COUNT }, () => ({
    x: 0, y: 0, z: 0, vx: 0, vz: 0,
    age: 0, scale: SMOKE_START_SIZE, active: false,
    r: 1, g: 1, b: 1,
  }));
  let smokeCursor = 0;
  // Per-kart spawn accumulator so emission cadence is wall-clock paced.
  const smokeTimers = new Map<string, number>();

  const smokeGeo = new THREE.PlaneGeometry(1, 1);
  const smokeMats: THREE.MeshBasicMaterial[] = Array.from(
    { length: SMOKE_COUNT },
    () =>
      new THREE.MeshBasicMaterial({
        color: "#ffffff",
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
  );
  const smokeRefs: (THREE.Mesh | undefined)[] = Array(SMOKE_COUNT).fill(undefined);

  const whiteColor = new THREE.Color("#ffffff");
  const tintColor = new THREE.Color();

  function spawnSmoke(
    x: number,
    z: number,
    y: number,
    charge: number,
  ): void {
    const puff = smokePuffs[smokeCursor];
    smokeCursor = (smokeCursor + 1) % SMOKE_COUNT;
    puff.active = true;
    puff.age = 0;
    puff.scale = SMOKE_START_SIZE * (0.8 + Math.random() * 0.4);
    puff.x = x + (Math.random() - 0.5) * SMOKE_DRIFT_SPREAD;
    puff.y = y + (Math.random() - 0.5) * 0.05;
    puff.z = z + (Math.random() - 0.5) * SMOKE_DRIFT_SPREAD;
    puff.vx = (Math.random() - 0.5) * 0.4;
    puff.vz = (Math.random() - 0.5) * 0.4;
    // Tint white→charge color so higher drift tiers read as hotter smoke.
    if (charge > 0) {
      const hex = DRIFT_CHARGE_COLORS[Math.min(charge - 1, 2)];
      tintColor.set(hex);
      const blend = Math.min(charge / 3, 0.5);
      puff.r = whiteColor.r + (tintColor.r - whiteColor.r) * blend;
      puff.g = whiteColor.g + (tintColor.g - whiteColor.g) * blend;
      puff.b = whiteColor.b + (tintColor.b - whiteColor.b) * blend;
    } else {
      puff.r = 1;
      puff.g = 1;
      puff.b = 1;
    }
  }

  // ---------------------------------------------------------------------------
  // Per-frame update
  // ---------------------------------------------------------------------------

  const now = () => performance.now();

  useTask((delta) => {
    const nowMs = now();
    const activeIds = new Set<string>();

    // --- Lay skid marks + emit smoke for every drifting kart ---
    for (const kartId of Object.keys(store.karts)) {
      const kart: KartState | undefined = store.karts[kartId];
      if (!kart) continue;
      activeIds.add(kartId);

      const drifting = kart.driftState.active;
      const sliding = Math.abs(kart.slipAngle ?? 0) >= SLIP_MARK_THRESHOLD;
      const skidding =
        (drifting || sliding) &&
        kart.status !== "spinning" &&
        kart.status !== "falling";

      // Smooth render pose — prediction for local, interpolation for remotes;
      // raw store state as a last resort (waiting-phase grid). For the local
      // kart we pass delta=0: Kart.svelte owns advancing the shared predicted
      // physics each frame, so we only READ the current predicted pose here
      // (delta=0 skips the physics step and the correction decay). Stepping it
      // again with a real delta would double-advance the local kart.
      const isLocal = kartId === store.localPlayerId;
      let pose = isLocal ? store.stepLocalPrediction(0) : null;
      if (!pose) pose = store.sampleKartPose(kartId, nowMs);
      const px = pose ? pose.x : kart.position.x;
      const pz = pose ? pose.z : kart.position.z;
      const py = pose ? pose.y : kart.position.y;
      const heading = pose ? pose.heading : kart.heading;
      const groundY = py - KART_VISUAL_Y_OFFSET + GROUND_LIFT;

      // Kart-local axes in world space. Heading is a yaw about +Y where +Z is
      // the nose; matches Kart.svelte's groupRef.rotation.set(0, heading, 0).
      const sin = Math.sin(heading);
      const cos = Math.cos(heading);
      // forward = (sin, cos); right = (cos, -sin).
      const fx = sin, fz = cos;
      const rx = cos, rz = -sin;

      const cx = px + fx * WHEEL_LONGITUDINAL;
      const cz = pz + fz * WHEEL_LONGITUDINAL;
      const lx = cx - rx * WHEEL_LATERAL;
      const lz = cz - rz * WHEEL_LATERAL;
      const rwx = cx + rx * WHEEL_LATERAL;
      const rwz = cz + rz * WHEEL_LATERAL;

      let trail = trails.get(kartId);

      // Higher drift charge bites the asphalt harder: marks widen and darken a
      // touch with tier (0 charge = baseline; a hard slide while drifting leaves
      // a meatier streak). Cosmetic only — read straight off the existing drift
      // charge, no new state.
      const charge = kart.driftState.charge ?? 0;
      const markHalfWidth = MARK_HALF_WIDTH * (1 + charge * 0.18); // up to ~1.54×
      const markDarken = 1 - charge * 0.12; // down to ~0.64× (darker) at tier 3

      if (skidding) {
        if (trail && trail.has) {
          pushQuad(trail.lx, trail.lz, lx, lz, groundY, markHalfWidth, markDarken);
          pushQuad(trail.rx, trail.rz, rwx, rwz, groundY, markHalfWidth, markDarken);
        }
        if (!trail) {
          trail = { lx, lz, rx: rwx, rz: rwz, has: true };
          trails.set(kartId, trail);
        } else {
          trail.lx = lx;
          trail.lz = lz;
          trail.rx = rwx;
          trail.rz = rwz;
          trail.has = true;
        }

        // --- Smoke emission, paced per-kart ---
        let timer = (smokeTimers.get(kartId) ?? 0) + delta;
        while (timer >= SMOKE_SPAWN_INTERVAL) {
          timer -= SMOKE_SPAWN_INTERVAL;
          // Alternate which rear wheel emits.
          const left = Math.random() < 0.5;
          spawnSmoke(
            left ? lx : rwx,
            left ? lz : rwz,
            groundY + 0.1,
            charge,
          );
        }
        smokeTimers.set(kartId, timer);
      } else if (trail) {
        // Stop the ribbon — next skid starts a fresh stroke.
        trail.has = false;
        smokeTimers.set(kartId, 0);
      }
    }

    // Drop trail/timer bookkeeping for karts that left.
    for (const id of trails.keys()) {
      if (!activeIds.has(id)) trails.delete(id);
    }
    for (const id of smokeTimers.keys()) {
      if (!activeIds.has(id)) smokeTimers.delete(id);
    }

    // --- Age + fade the skid ribbon ---
    // Every live quad's alpha changes every frame, so the color buffer is
    // re-uploaded wholesale (only when something is live). Positions only
    // change when new quads are stamped, so they upload a tight window.
    const nowSec = nowMs / 1000;
    if (liveQuads > 0) colorsDirty = true;
    for (let q = 0; q < MAX_QUADS; q++) {
      if (!quadAlive[q]) continue;
      const age = nowSec - quadBirth[q];
      const base = q * VERTS_PER_QUAD;
      if (age >= MARK_LIFETIME) {
        // Reclaim — collapse alpha to zero so the stale verts vanish.
        for (let i = 0; i < VERTS_PER_QUAD; i++) {
          skidColors[(base + i) * 4 + 3] = 0;
        }
        quadAlive[q] = 0;
        liveQuads--;
        continue;
      }
      const alpha = MARK_MAX_ALPHA * (1 - age / MARK_LIFETIME);
      for (let i = 0; i < VERTS_PER_QUAD; i++) {
        skidColors[(base + i) * 4 + 3] = alpha;
      }
    }

    // One draw call covering the whole pool (the ring buffer wraps, so we
    // can't shrink the range without bookkeeping the live extent — drawing
    // the fully-allocated pool with zero-alpha holes is cheaper than that).
    skidGeo.setDrawRange(0, MAX_VERTS);

    // Upload positions for any newly-stamped quads (tight window).
    if (posDirtyMax > posDirtyMin) {
      skidPosAttr.clearUpdateRanges();
      skidPosAttr.addUpdateRange(posDirtyMin * 3, (posDirtyMax - posDirtyMin) * 3);
      skidPosAttr.needsUpdate = true;
      posDirtyMin = Infinity;
      posDirtyMax = -Infinity;
    }
    // Re-upload the whole color buffer when any mark is fading/changing.
    if (colorsDirty) {
      skidColAttr.clearUpdateRanges();
      skidColAttr.needsUpdate = true;
      colorsDirty = false;
    }

    // --- Update + billboard smoke puffs ---
    const camQuat = camera.current.quaternion;
    for (let i = 0; i < SMOKE_COUNT; i++) {
      const puff = smokePuffs[i];
      const ref = smokeRefs[i];
      const mat = smokeMats[i];
      if (!ref) continue;

      if (!puff.active) {
        if (ref.visible) ref.visible = false;
        continue;
      }

      puff.age += delta;
      if (puff.age >= SMOKE_LIFETIME) {
        puff.active = false;
        ref.visible = false;
        continue;
      }

      puff.scale += SMOKE_EXPAND_RATE * delta;
      puff.y += SMOKE_RISE_SPEED * delta;
      puff.x += puff.vx * delta;
      puff.z += puff.vz * delta;

      ref.visible = true;
      ref.position.set(puff.x, puff.y, puff.z);
      ref.scale.setScalar(puff.scale);
      // Billboard toward the camera.
      ref.quaternion.copy(camQuat);

      const lifeRatio = puff.age / SMOKE_LIFETIME;
      // Ease in fast, fade out over the tail.
      const fadeIn = Math.min(1, lifeRatio / 0.15);
      mat.opacity = SMOKE_START_ALPHA * fadeIn * (1 - lifeRatio);
      mat.color.setRGB(puff.r, puff.g, puff.b);
    }
  });

  onDestroy(() => {
    skidGeo.dispose();
    skidMat.dispose();
    smokeGeo.dispose();
    smokeMats.forEach((m) => m.dispose());
  });
</script>

<!-- Skid ribbon — single draw call, renders above the road overlays. -->
<T.Mesh
  geometry={skidGeo}
  material={skidMat}
  frustumCulled={false}
  renderOrder={5}
/>

<!-- World-space smoke pool — not parented to any kart. -->
{#each smokePuffs as _, i (i)}
  <T.Mesh
    geometry={smokeGeo}
    material={smokeMats[i]}
    frustumCulled={false}
    renderOrder={6}
    visible={false}
    oncreate={(ref) => {
      smokeRefs[i] = ref;
    }}
  />
{/each}
