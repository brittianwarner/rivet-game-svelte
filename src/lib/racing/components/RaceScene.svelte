<!--
  RaceScene — top-level 3D scene for the kart racing game.
  Sets up Canvas, renders Track, Karts, Items, Camera, Input.

  Rendering pipeline: the component self-nests — the outer instance mounts
  <Canvas> and renders itself again (insideCanvas) so the inner instance can
  call useThrelte()/useTask() within the Threlte context. The inner instance
  owns:
  - manual rendering through an EffectComposer (RenderPass → UnrealBloomPass
    → OutputPass) so emissive materials (> 1.0 emissiveIntensity) bloom for
    real instead of leaning on dozens of decorative PointLights
  - a shadow-casting DirectionalLight aligned with the Sky's sun
    (elevation 25 / azimuth 120) whose tight orthographic shadow frustum is
    re-centered on the local kart every frame so shadows follow the action
  - desert depth-haze fog matched to the horizon color
-->
<script lang="ts">
  import { Canvas, T, useTask, useThrelte } from "@threlte/core";
  import {
    type DirectionalLight,
    Fog,
    HalfFloatType,
    MathUtils,
    PCFSoftShadowMap,
    Vector2,
    Vector3,
    WebGLRenderTarget,
  } from "three";
  import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
  import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
  import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
  import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
  import { onDestroy, onMount } from "svelte";
  import { Sky } from "@threlte/extras";
  import Track from "./Track.svelte";
  import Kart from "./Kart.svelte";
  import ItemBox from "./ItemBox.svelte";
  import Projectile from "./Projectile.svelte";
  import ChaseCam from "./ChaseCam.svelte";
  import RaceInput from "./RaceInput.svelte";
  import SkidMarks from "./SkidMarks.svelte";
  import ImpactVfx from "./ImpactVfx.svelte";
  import GhostKart from "./GhostKart.svelte";
  import SceneContent from "./RaceScene.svelte";
  import { getRaceStore } from "../context.js";
  import { getSettingsStore } from "../settings-store.svelte.js";
  import type { GhostTimeline } from "../ghost-recorder.js";

  interface Props {
    /** True for the self-nested instance rendered inside <Canvas>. */
    insideCanvas?: boolean;
  }

  let { insideCanvas = false }: Props = $props();

  const store = getRaceStore();

  // Time-trial ghost: mount a translucent replay kart when a ghost is loaded for
  // this run. ghostActive is reactive (the {#if} re-evaluates on toggle); the
  // timeline itself is read off the store getter (kept off $state — typed arrays).
  const ghostTimeline = $derived(
    store.ghostActive ? (store.getGhostTimeline() as GhostTimeline | null) : null,
  );

  // Sun placement — the DirectionalLight direction is derived from the SAME
  // elevation/azimuth as the Sky shader so highlights and shadows agree with
  // the visible sun disc.
  const SUN_ELEVATION = 25;
  const SUN_AZIMUTH = 120;
  const SUN_DISTANCE = 300;
  const sunDirection = new Vector3().setFromSphericalCoords(
    1,
    MathUtils.degToRad(90 - SUN_ELEVATION),
    MathUtils.degToRad(SUN_AZIMUTH),
  );

  // Tight orthographic shadow frustum half-extent around the local kart.
  // Kept tight (and the map large) so texel density on the road is high —
  // sparse texels at this low sun elevation are what produced shadow-acne
  // "checkerboarding" across the asphalt.
  const SHADOW_EXTENT = 48;
  const SHADOW_MAP_SIZE = 4096;

  // Neon Circuit renders a deep-void atmosphere (no Sky, indigo-black fog,
  // cool lights, stronger bloom) while Sunset Speedway (track1) keeps its
  // desert daytime look. trackId is fixed at mount (set from join state), so
  // the init-time reads below are intentional.
  // svelte-ignore state_referenced_locally
  const isNeon = store.trackId === "neon-circuit";

  // Bloom — threshold just under 1.0 so only emissive materials pushed past
  // 1.0 emissiveIntensity glow; ordinary lit surfaces stay clean. Neon Circuit
  // leans harder on the bloom (lower threshold, wider radius) so the cyan/
  // magenta edge strips and wet-neon road actually halo.
  const BLOOM_STRENGTH = isNeon ? 0.85 : 0.5;
  const BLOOM_RADIUS = isNeon ? 0.6 : 0.4;
  const BLOOM_THRESHOLD = isNeon ? 0.75 : 0.9;

  // Depth haze. track1: desert haze matched to the pale Sky horizon, far kept
  // beyond the track's full extent (~2400 units) so the circuit stays
  // readable. neon-circuit: a tight deep indigo-black void so the track glows
  // out of darkness.
  const FOG_COLOR = isNeon ? 0x05010f : 0xddd5c3;
  const FOG_NEAR = isNeon ? 120 : 250;
  const FOG_FAR = isNeon ? 950 : 2400;

  let sunLight: DirectionalLight | undefined;

  // insideCanvas is fixed for the lifetime of an instance (the outer instance
  // mounts <Canvas>, the inner one owns the render pipeline) — the init-time
  // read is intentional.
  // svelte-ignore state_referenced_locally
  if (insideCanvas) {
    const { renderer, scene, camera, size, dpr, autoRender, renderStage } =
      useThrelte();

    // --- Fog: depth haze matched to the horizon ---
    scene.fog = new Fog(FOG_COLOR, FOG_NEAR, FOG_FAR);

    // --- Post-processing: manual rendering through an EffectComposer ---
    const composerTarget = new WebGLRenderTarget(
      size.current.width * dpr.current,
      size.current.height * dpr.current,
      { type: HalfFloatType, samples: 4 },
    );
    const composer = new EffectComposer(renderer, composerTarget);
    const renderPass = new RenderPass(scene, camera.current);
    const bloomPass = new UnrealBloomPass(
      new Vector2(size.current.width, size.current.height),
      BLOOM_STRENGTH,
      BLOOM_RADIUS,
      BLOOM_THRESHOLD,
    );
    const outputPass = new OutputPass();
    composer.addPass(renderPass);
    composer.addPass(bloomPass);
    composer.addPass(outputPass);

    onMount(() => {
      const before = autoRender.current;
      autoRender.set(false);
      return () => autoRender.set(before);
    });

    // Keep the composer sized with the canvas / pixel-ratio.
    $effect(() => {
      const resize = () => {
        composer.setPixelRatio(dpr.current);
        composer.setSize(size.current.width, size.current.height);
      };
      const unsubSize = size.subscribe(resize);
      const unsubDpr = dpr.subscribe(resize);
      return () => {
        unsubSize();
        unsubDpr();
      };
    });

    // The composer render replaces Threlte's auto-render.
    useTask(
      () => {
        // ChaseCam mounts after the composer is built — track the live camera.
        if (renderPass.camera !== camera.current) {
          renderPass.camera = camera.current;
        }
        composer.render();
      },
      { stage: renderStage, autoInvalidate: false },
    );

    // Re-center the sun + shadow target on the local kart (or the race
    // leader for spectators) each frame so shadows follow the action.
    useTask(() => {
      if (!sunLight) return;
      const focus =
        store.localKart ??
        (store.positions.length > 0
          ? store.karts[store.positions[0]]
          : undefined);
      const fx = focus?.position.x ?? 0;
      const fy = focus?.position.y ?? 0;
      const fz = focus?.position.z ?? 0;
      sunLight.position.set(
        fx + sunDirection.x * SUN_DISTANCE,
        fy + sunDirection.y * SUN_DISTANCE,
        fz + sunDirection.z * SUN_DISTANCE,
      );
      sunLight.target.position.set(fx, fy, fz);
      // The target isn't in the scene graph — update its matrix manually so
      // the shadow camera orients correctly.
      sunLight.target.updateMatrixWorld();
    });

    onDestroy(() => {
      scene.fog = null;
      composer.dispose();
      renderPass.dispose();
      bloomPass.dispose();
      outputPass.dispose();
    });
  }

  // ---------------------------------------------------------------------------
  // Full-screen lightning flash (outer DOM layer only). A brief white wash when
  // the LOCAL player is struck by lightning, driven by store.lightningFlashAt.
  // It lives here rather than in the Canvas because it's a plain HTML overlay
  // and the outer RaceScene instance is the one rendering DOM. Suppressed under
  // prefers-reduced-motion.
  // ---------------------------------------------------------------------------

  const FLASH_DURATION_MS = 130;
  let flashOpacity = $state(0);

  // insideCanvas is fixed for the lifetime of an instance (the outer instance
  // renders this DOM overlay, the inner one owns the 3D scene) — the init-time
  // read is intentional.
  // svelte-ignore state_referenced_locally
  if (!insideCanvas) {
    // Use the in-app reduced-motion switch (its 'auto' mode already follows the
    // OS prefers-reduced-motion query), so forcing reduced motion 'on' in the
    // Options overlay suppresses the flash even when the OS query is off.
    const settings = getSettingsStore();

    let raf = 0;
    $effect(() => {
      const struckAt = store.lightningFlashAt;
      if (!struckAt || settings.reducedMotionActive) return;
      cancelAnimationFrame(raf);
      const tick = () => {
        const elapsed = performance.now() - struckAt;
        if (elapsed >= FLASH_DURATION_MS) {
          flashOpacity = 0;
          return;
        }
        // Snap to full, then ease out over the window.
        flashOpacity = 1 - elapsed / FLASH_DURATION_MS;
        raf = requestAnimationFrame(tick);
      };
      tick();
    });
    onDestroy(() => cancelAnimationFrame(raf));
  }
</script>

{#if insideCanvas}
  <!-- Camera -->
  <ChaseCam />

  <!-- Lighting. The Sky disc + warm lights are the desert (track1) look; the
       Neon Circuit drops the Sky entirely and lights the karts with a dim cool
       moon-key + indigo ambient/hemisphere so they read against the void. The
       key light keeps the SAME tight shadow config in both worlds so karts
       still ground (the per-frame shadow-target follow runs regardless). -->
  {#if !isNeon}
    <Sky
      elevation={SUN_ELEVATION}
      azimuth={SUN_AZIMUTH}
      turbidity={4}
      rayleigh={0.5}
      mieCoefficient={0.005}
      mieDirectionalG={0.8}
    />
  {/if}
  <T.DirectionalLight
    color={isNeon ? 0x9db4ff : 0xffeedd}
    intensity={isNeon ? 1.15 : 1.2}
    position={[
      sunDirection.x * SUN_DISTANCE,
      sunDirection.y * SUN_DISTANCE,
      sunDirection.z * SUN_DISTANCE,
    ]}
    castShadow
    oncreate={(light) => {
      light.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
      const cam = light.shadow.camera;
      cam.left = -SHADOW_EXTENT;
      cam.right = SHADOW_EXTENT;
      cam.top = SHADOW_EXTENT;
      cam.bottom = -SHADOW_EXTENT;
      // Bracket the depth range tightly around the lit region (light sits at
      // SUN_DISTANCE from the focus) so the depth buffer keeps precision.
      cam.near = SUN_DISTANCE - SHADOW_EXTENT * 1.5;
      cam.far = SUN_DISTANCE + SHADOW_EXTENT * 1.5;
      cam.updateProjectionMatrix();
      // normalBias offsets the shadow lookup along the surface normal — the
      // most effective cure for self-shadowing acne on the large flat road at
      // this grazing (25°) sun angle. Paired with a small constant bias.
      light.shadow.bias = -0.0004;
      light.shadow.normalBias = 2.2;
      sunLight = light;
      return () => {
        sunLight = undefined;
      };
    }}
  />
  <T.AmbientLight
    color={isNeon ? 0x3b3a66 : 0x334466}
    intensity={isNeon ? 0.9 : 0.5}
  />
  {#if isNeon}
    <!-- Brighter cool hemisphere so karts read as solid vehicles against the
         dark void; the bloomed neon edges/grid/gates stay dominant regardless. -->
    <T.HemisphereLight
      args={[0x6173d6, 0x241a3e, 0.85]}
    />
  {/if}

  <!-- Track -->
  {#key store.trackId}
    <Track />
  {/key}

  <!-- World-space drift juice: one pooled skid-mark ribbon + a billboarded
       smoke pool shared across every kart, mounted once so marks persist on
       the asphalt and puffs hang in the air where they were emitted. -->
  <SkidMarks />

  <!-- One-shot impact/status VFX: a pooled set of shell-hit + lightning
       shockwaves and the finish-line confetti burst, drained from the store's
       vfx queue. Light-free — the bloom pass carries the glow. -->
  <ImpactVfx />

  <!-- Time-trial ghost: a translucent replay of the player's best run on this
       track/car. Purely cosmetic — no lights, labels, shadow, or collision. -->
  {#if ghostTimeline}
    {#key ghostTimeline}
      <GhostKart timeline={ghostTimeline} />
    {/key}
  {/if}

  <!-- Karts (with slipstream wind lines handled inside Kart.svelte) -->
  {#each Object.keys(store.karts) as kartId (kartId)}
    <Kart
      {kartId}
      isLocal={kartId === store.localPlayerId}
    />
  {/each}

  <!-- Item boxes -->
  {#each store.itemBoxes as box (box.id)}
    <ItemBox position={box.position} active={box.active} />
  {/each}

  <!-- Projectiles -->
  {#each store.projectiles as proj (proj.id)}
    <Projectile projectile={proj} />
  {/each}

  <!-- Hazards (bananas) — emissive sphere + ground ring; bloom carries the
       glow (no per-hazard PointLight, which forced shader recompiles) -->
  {#each store.hazards as hazard (hazard.id)}
    <T.Group position={[hazard.position.x, hazard.position.y, hazard.position.z]}>
      <!-- Banana sphere -->
      <T.Mesh castShadow>
        <T.SphereGeometry args={[0.3, 12, 8]} />
        <T.MeshStandardMaterial
          color="#FFD93D"
          emissive="#FFD93D"
          emissiveIntensity={1.5}
          roughness={0.3}
          metalness={0.2}
        />
      </T.Mesh>

      <!-- Ground warning ring -->
      <T.Mesh rotation.x={-Math.PI / 2} position.y={-0.28}>
        <T.RingGeometry args={[0.35, 0.55, 24]} />
        <T.MeshBasicMaterial
          color="#FFD93D"
          transparent
          opacity={0.35}
          depthWrite={false}
        />
      </T.Mesh>
    </T.Group>
  {/each}

  <!-- Input handler (invisible) — the single sender, merging keyboard with
       the touch arbiter. Not mounted for spectators, who can't send input. -->
  {#if !store.isSpectator}
    <RaceInput />
  {/if}
{:else}
  <!-- DPR clamped to ≤2; Threlte's default renderer (no logarithmic depth
       buffer, which broke early-Z) with PCFSoft shadow maps enabled. -->
  <Canvas dpr={[1, 2]} shadows={PCFSoftShadowMap}>
    <SceneContent insideCanvas />
  </Canvas>

  <!-- Full-screen lightning flash (local strike only). pointer-events-none so
       it never eats input; opacity decays over ~130ms. -->
  {#if flashOpacity > 0}
    <div
      aria-hidden="true"
      style="position:fixed;inset:0;z-index:30;pointer-events:none;background:#eaf4ff;opacity:{flashOpacity};mix-blend-mode:screen;"
    ></div>
  {/if}
{/if}
