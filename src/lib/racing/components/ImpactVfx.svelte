<!--
  ImpactVfx — scene-level one-shot impact/status VFX pool. Mounted ONCE inside
  the Canvas by RaceScene. Drains the race store's `vfxQueue` each frame and
  plays pooled, LIGHT-FREE effects (emissive + the scene bloom pass carry the
  glow — no PointLights are ever mounted/unmounted, so no shader recompiles):

  (1) SHOCKWAVE BURSTS — a fixed pool of reusable effects, each an expanding,
      fading additive ring laid flat on the ground plus a short burst of
      camera-billboarded additive sprite quads kicked outward. Used for shell
      hits (warm) and lightning strikes (a taller, cool bolt-tinted burst with
      a vertical streak).

  (2) FINISH CONFETTI — a single InstancedMesh (~150 quads) of colored,
      gravity-driven, tumbling paper rained over the start/finish line when the
      race ends. One draw call; per-instance color via instanceColor.

  Everything is purely cosmetic — zero server involvement, server stays
  authoritative. Geometry/materials/textures are disposed on unmount.
-->
<script lang="ts">
  import { T, useTask, useThrelte } from "@threlte/core";
  import * as THREE from "three";
  import { onDestroy } from "svelte";
  import { getRaceStore } from "$lib/racing/context.js";

  const store = getRaceStore();
  const { camera } = useThrelte();

  // ---------------------------------------------------------------------------
  // Shockwave burst pool (rings + sprite quads)
  // ---------------------------------------------------------------------------

  const BURST_COUNT = 8; // concurrent effects
  const SPRITES_PER_BURST = 6;
  const BURST_LIFETIME = 0.55; // seconds
  const RING_START_RADIUS = 0.4;
  const RING_END_RADIUS = 4.0;
  const SPRITE_SPEED = 7.0; // units/sec outward
  const SPRITE_RISE = 2.4; // units/sec upward
  const SPRITE_START_SIZE = 0.55;
  // Karts hover 2.3 above the road visually (see Kart.svelte) — drop the ring to
  // ground level so the shockwave reads as hitting the asphalt.
  const KART_VISUAL_Y_OFFSET = 2.3;

  interface Burst {
    active: boolean;
    age: number;
    x: number;
    y: number; // ground height for the ring
    cx: number;
    cy: number; // center height for sprites (kart body height)
    cz: number;
    r: number;
    g: number;
    b: number;
    tall: boolean; // lightning: vertical streak + taller sprite rise
    // Per-sprite outward velocity directions (unit, on the ground plane).
    dirX: Float32Array;
    dirZ: Float32Array;
    // Per-sprite size + outward-speed jitter so the burst doesn't read as a
    // clean symmetric ring of identical quads.
    size: Float32Array;
    speed: Float32Array;
  }

  function makeBurst(): Burst {
    const dirX = new Float32Array(SPRITES_PER_BURST);
    const dirZ = new Float32Array(SPRITES_PER_BURST);
    const size = new Float32Array(SPRITES_PER_BURST);
    const speed = new Float32Array(SPRITES_PER_BURST);
    return {
      active: false,
      age: 0,
      x: 0,
      y: 0,
      cx: 0,
      cy: 0,
      cz: 0,
      r: 1,
      g: 1,
      b: 1,
      tall: false,
      dirX,
      dirZ,
      size,
      speed,
    };
  }

  const bursts: Burst[] = Array.from({ length: BURST_COUNT }, makeBurst);
  let burstCursor = 0;

  // Ring geometry: a flat annulus laid on the XZ plane (rotated -90° about X).
  const ringGeo = new THREE.RingGeometry(0.7, 1.0, 36);
  const ringMats: THREE.MeshBasicMaterial[] = Array.from(
    { length: BURST_COUNT },
    () =>
      new THREE.MeshBasicMaterial({
        color: "#ffffff",
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      }),
  );
  const ringRefs: (THREE.Mesh | undefined)[] = Array(BURST_COUNT).fill(undefined);

  // Ground scorch flash (all hits) — a soft, flat radial disc that punches in
  // bright on impact then fades over the first ~third of the burst, so the hit
  // reads as a flash on the asphalt under the expanding ring. Uses the same
  // soft spark texture (created below) on a flat quad; one per burst slot,
  // pooled + disposed alongside everything else.
  const scorchGeo = new THREE.PlaneGeometry(1, 1);
  const scorchMats: THREE.MeshBasicMaterial[] = Array.from(
    { length: BURST_COUNT },
    () =>
      new THREE.MeshBasicMaterial({
        color: "#ffffff",
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
  );
  const scorchRefs: (THREE.Mesh | undefined)[] = Array(BURST_COUNT).fill(undefined);

  // Vertical streak (lightning only) — a tall additive plane, billboarded to
  // the camera, fading fast.
  const streakGeo = new THREE.PlaneGeometry(0.5, 5.0);
  const streakMats: THREE.MeshBasicMaterial[] = Array.from(
    { length: BURST_COUNT },
    () =>
      new THREE.MeshBasicMaterial({
        color: "#cfe8ff",
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
  );
  const streakRefs: (THREE.Mesh | undefined)[] = Array(BURST_COUNT).fill(undefined);

  // Sprite quads: a soft radial-gradient texture so each quad reads as a spark.
  function createSparkTexture(): THREE.CanvasTexture {
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
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.4, "rgba(255,255,255,0.7)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    return new THREE.CanvasTexture(canvas);
  }
  const sparkTexture = createSparkTexture();
  // The ground scorch discs reuse the same soft radial texture.
  for (const m of scorchMats) m.map = sparkTexture;
  const sparkGeo = new THREE.PlaneGeometry(1, 1);
  // One material per (burst × sprite) so each can carry its own tint + opacity.
  const SPRITE_TOTAL = BURST_COUNT * SPRITES_PER_BURST;
  const spriteMats: THREE.MeshBasicMaterial[] = Array.from(
    { length: SPRITE_TOTAL },
    () =>
      new THREE.MeshBasicMaterial({
        map: sparkTexture,
        color: "#ffffff",
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
  );
  const spriteRefs: (THREE.Mesh | undefined)[] = Array(SPRITE_TOTAL).fill(
    undefined,
  );

  function fireBurst(
    type: "hit" | "lightning",
    x: number,
    y: number,
    z: number,
    color: string,
  ): void {
    const b = bursts[burstCursor];
    burstCursor = (burstCursor + 1) % BURST_COUNT;
    b.active = true;
    b.age = 0;
    b.tall = type === "lightning";
    b.x = x;
    b.y = y - KART_VISUAL_Y_OFFSET + 0.06; // ground ring just above asphalt
    b.cx = x;
    b.cy = y - KART_VISUAL_Y_OFFSET + 0.6; // sprite burst at body height
    b.cz = z;
    const col = new THREE.Color(color);
    b.r = col.r;
    b.g = col.g;
    b.b = col.b;
    // Random outward fan for the sprite quads, with per-sprite size + speed
    // jitter so the spark burst reads as chaotic shrapnel, not a tidy ring.
    for (let i = 0; i < SPRITES_PER_BURST; i++) {
      const a = (i / SPRITES_PER_BURST) * Math.PI * 2 + Math.random() * 0.6;
      b.dirX[i] = Math.cos(a);
      b.dirZ[i] = Math.sin(a);
      b.size[i] = 0.7 + Math.random() * 0.8; // 0.7..1.5×
      b.speed[i] = 0.7 + Math.random() * 0.7; // 0.7..1.4×
    }
  }

  // ---------------------------------------------------------------------------
  // Finish confetti — single InstancedMesh, gravity + tumble
  // ---------------------------------------------------------------------------

  const CONFETTI_COUNT = 150;
  const CONFETTI_LIFETIME = 3.2; // seconds
  const CONFETTI_GRAVITY = 9.5;
  const CONFETTI_SPREAD = 7.0; // initial horizontal radius
  const CONFETTI_UP = 9.0; // initial upward speed
  const CONFETTI_PALETTE = [
    "#ff5566",
    "#ffd93d",
    "#44ff88",
    "#00ccff",
    "#cc66ff",
    "#ffffff",
  ];

  interface ConfettiPiece {
    x: number;
    y: number;
    z: number;
    vx: number;
    vy: number;
    vz: number;
    rx: number;
    ry: number;
    rz: number;
    vrx: number;
    vry: number;
    age: number;
    active: boolean;
  }

  const confetti: ConfettiPiece[] = Array.from(
    { length: CONFETTI_COUNT },
    () => ({
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      rx: 0,
      ry: 0,
      rz: 0,
      vrx: 0,
      vry: 0,
      age: 0,
      active: false,
    }),
  );
  let confettiActive = false;

  const confettiGeo = new THREE.PlaneGeometry(0.32, 0.5);
  // Per-instance color comes from InstancedMesh.instanceColor (set at spawn);
  // MeshBasicMaterial multiplies it in automatically when the attribute exists,
  // so no vertexColors / geometry color attribute is needed.
  const confettiMat = new THREE.MeshBasicMaterial({
    color: "#ffffff",
    transparent: true,
    opacity: 1,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const confettiMesh = new THREE.InstancedMesh(
    confettiGeo,
    confettiMat,
    CONFETTI_COUNT,
  );
  confettiMesh.frustumCulled = false;
  confettiMesh.count = 0; // hidden until the finish burst spawns
  confettiMesh.renderOrder = 7;
  confettiMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // Per-instance color (assigned once at spawn).
  const confettiColor = new THREE.Color();
  const confettiMatrix = new THREE.Matrix4();
  const confettiQuat = new THREE.Quaternion();
  const confettiEuler = new THREE.Euler();
  const confettiScaleVec = new THREE.Vector3(1, 1, 1);
  const confettiPosVec = new THREE.Vector3();

  function spawnConfetti(cx: number, cy: number, cz: number): void {
    confettiActive = true;
    confettiMesh.count = CONFETTI_COUNT;
    const groundY = cy - KART_VISUAL_Y_OFFSET;
    for (let i = 0; i < CONFETTI_COUNT; i++) {
      const p = confetti[i];
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * CONFETTI_SPREAD;
      p.x = cx + Math.cos(angle) * radius * 0.4;
      p.z = cz + Math.sin(angle) * radius * 0.4;
      p.y = groundY + 2 + Math.random() * 4;
      p.vx = Math.cos(angle) * (1 + Math.random() * 3);
      p.vz = Math.sin(angle) * (1 + Math.random() * 3);
      p.vy = CONFETTI_UP * (0.4 + Math.random() * 0.6);
      p.rx = Math.random() * Math.PI * 2;
      p.ry = Math.random() * Math.PI * 2;
      p.rz = Math.random() * Math.PI * 2;
      p.vrx = (Math.random() - 0.5) * 12;
      p.vry = (Math.random() - 0.5) * 12;
      p.age = 0;
      p.active = true;
      confettiColor.set(
        CONFETTI_PALETTE[(Math.random() * CONFETTI_PALETTE.length) | 0],
      );
      confettiMesh.setColorAt(i, confettiColor);
    }
    if (confettiMesh.instanceColor) confettiMesh.instanceColor.needsUpdate = true;
  }

  // ---------------------------------------------------------------------------
  // Per-frame update
  // ---------------------------------------------------------------------------

  useTask((delta) => {
    // Drain newly-queued effects from the store.
    const queued = store.drainVfx();
    for (let i = 0; i < queued.length; i++) {
      const e = queued[i];
      if (e.type === "confetti") {
        spawnConfetti(e.x, e.y, e.z);
      } else {
        fireBurst(e.type, e.x, e.y, e.z, e.color);
      }
    }

    const camQuat = camera.current.quaternion;

    // --- Shockwave bursts ---
    for (let bi = 0; bi < BURST_COUNT; bi++) {
      const b = bursts[bi];
      const ring = ringRefs[bi];
      const streak = streakRefs[bi];
      const scorch = scorchRefs[bi];
      const ringMat = ringMats[bi];
      const streakMat = streakMats[bi];
      const scorchMat = scorchMats[bi];

      if (!b.active) {
        if (ring && ring.visible) ring.visible = false;
        if (streak && streak.visible) streak.visible = false;
        if (scorch && scorch.visible) scorch.visible = false;
        for (let s = 0; s < SPRITES_PER_BURST; s++) {
          const ref = spriteRefs[bi * SPRITES_PER_BURST + s];
          if (ref && ref.visible) ref.visible = false;
        }
        continue;
      }

      b.age += delta;
      const life = b.age / BURST_LIFETIME;
      if (life >= 1) {
        b.active = false;
        if (ring) ring.visible = false;
        if (streak) streak.visible = false;
        if (scorch) scorch.visible = false;
        for (let s = 0; s < SPRITES_PER_BURST; s++) {
          const ref = spriteRefs[bi * SPRITES_PER_BURST + s];
          if (ref) ref.visible = false;
        }
        continue;
      }

      const fade = 1 - life;

      // Expanding ground ring.
      if (ring) {
        const radius =
          RING_START_RADIUS + (RING_END_RADIUS - RING_START_RADIUS) * life;
        ring.visible = true;
        ring.position.set(b.x, b.y, b.cz);
        ring.scale.setScalar(radius);
        ringMat.color.setRGB(b.r, b.g, b.b);
        ringMat.opacity = fade * 0.9;
      }

      // Ground scorch flash — a bright, soft disc on the asphalt that punches
      // in hard at impact and dies over the first third of the burst, growing
      // a little as it fades so it reads as heat washing out.
      if (scorch) {
        if (life < 0.45) {
          const sl = life / 0.45; // 0..1 over the flash window
          scorch.visible = true;
          scorch.position.set(b.x, b.y + 0.01, b.cz);
          scorch.scale.setScalar(2.0 + sl * 2.5);
          scorchMat.color.setRGB(b.r, b.g, b.b);
          scorchMat.opacity = (1 - sl) * 0.85;
        } else if (scorch.visible) {
          scorch.visible = false;
        }
      }

      // Lightning streak — a tall billboarded flash that dies in the first third.
      if (streak) {
        if (b.tall && life < 0.4) {
          streak.visible = true;
          streak.position.set(b.cx, b.cy + 1.5, b.cz);
          streak.quaternion.copy(camQuat);
          streakMat.color.setRGB(b.r, b.g, b.b);
          streakMat.opacity = (1 - life / 0.4) * 0.95;
        } else if (streak.visible) {
          streak.visible = false;
        }
      }

      // Outward billboarded sprite quads.
      const rise = b.tall ? SPRITE_RISE * 1.8 : SPRITE_RISE;
      for (let s = 0; s < SPRITES_PER_BURST; s++) {
        const ref = spriteRefs[bi * SPRITES_PER_BURST + s];
        const mat = spriteMats[bi * SPRITES_PER_BURST + s];
        if (!ref) continue;
        // Per-sprite speed jitter so shrapnel scatters at varied distances.
        const dist = SPRITE_SPEED * b.speed[s] * b.age;
        ref.visible = true;
        ref.position.set(
          b.cx + b.dirX[s] * dist,
          b.cy + rise * b.age - 0.5 * 4 * b.age * b.age,
          b.cz + b.dirZ[s] * dist,
        );
        ref.quaternion.copy(camQuat);
        // Per-sprite size jitter for chunkier/finer mixed shrapnel.
        ref.scale.setScalar(SPRITE_START_SIZE * b.size[s] * (1 + life * 1.5));
        mat.color.setRGB(b.r, b.g, b.b);
        mat.opacity = fade;
      }
    }

    // --- Finish confetti ---
    if (confettiActive) {
      let anyAlive = false;
      for (let i = 0; i < CONFETTI_COUNT; i++) {
        const p = confetti[i];
        if (!p.active) {
          // Collapse retired instances out of view.
          confettiMatrix.makeScale(0, 0, 0);
          confettiMesh.setMatrixAt(i, confettiMatrix);
          continue;
        }
        p.age += delta;
        if (p.age >= CONFETTI_LIFETIME) {
          p.active = false;
          confettiMatrix.makeScale(0, 0, 0);
          confettiMesh.setMatrixAt(i, confettiMatrix);
          continue;
        }
        anyAlive = true;
        p.vy -= CONFETTI_GRAVITY * delta;
        p.x += p.vx * delta;
        p.y += p.vy * delta;
        p.z += p.vz * delta;
        // Flutter: a little horizontal sway as it falls.
        p.vx *= 0.99;
        p.vz *= 0.99;
        p.rx += p.vrx * delta;
        p.ry += p.vry * delta;
        confettiPosVec.set(p.x, p.y, p.z);
        confettiEuler.set(p.rx, p.ry, p.rz);
        confettiQuat.setFromEuler(confettiEuler);
        confettiMatrix.compose(confettiPosVec, confettiQuat, confettiScaleVec);
        confettiMesh.setMatrixAt(i, confettiMatrix);
      }
      confettiMesh.instanceMatrix.needsUpdate = true;
      if (!anyAlive) {
        confettiActive = false;
        confettiMesh.count = 0;
      }
    }
  });

  onDestroy(() => {
    ringGeo.dispose();
    ringMats.forEach((m) => m.dispose());
    scorchGeo.dispose();
    scorchMats.forEach((m) => m.dispose());
    streakGeo.dispose();
    streakMats.forEach((m) => m.dispose());
    sparkGeo.dispose();
    sparkTexture.dispose();
    spriteMats.forEach((m) => m.dispose());
    confettiGeo.dispose();
    confettiMat.dispose();
    confettiMesh.dispose();
  });
</script>

<!-- Shockwave ground rings (one per burst slot). -->
{#each ringMats as mat, i (i)}
  <T.Mesh
    geometry={ringGeo}
    material={mat}
    rotation.x={-Math.PI / 2}
    frustumCulled={false}
    visible={false}
    renderOrder={6}
    oncreate={(ref) => {
      ringRefs[i] = ref;
    }}
  />
{/each}

<!-- Ground scorch flash discs (one per burst slot), laid flat on the asphalt. -->
{#each scorchMats as mat, i (i)}
  <T.Mesh
    geometry={scorchGeo}
    material={mat}
    rotation.x={-Math.PI / 2}
    frustumCulled={false}
    visible={false}
    renderOrder={6}
    oncreate={(ref) => {
      scorchRefs[i] = ref;
    }}
  />
{/each}

<!-- Lightning vertical streaks. -->
{#each streakMats as mat, i (i)}
  <T.Mesh
    geometry={streakGeo}
    material={mat}
    frustumCulled={false}
    visible={false}
    renderOrder={7}
    oncreate={(ref) => {
      streakRefs[i] = ref;
    }}
  />
{/each}

<!-- Billboarded spark sprites (burst × sprite). -->
{#each spriteMats as mat, i (i)}
  <T.Mesh
    geometry={sparkGeo}
    material={mat}
    frustumCulled={false}
    visible={false}
    renderOrder={7}
    oncreate={(ref) => {
      spriteRefs[i] = ref;
    }}
  />
{/each}

<!-- Finish confetti — single instanced draw call. dispose={false}: the geometry
     and material are disposed explicitly in onDestroy. -->
<T is={confettiMesh} dispose={false} />
