<!--
  RaceScene — top-level 3D scene for the kart racing game.
  Sets up Canvas, renders Track, Karts, Items, Camera, Input.
  Includes bloom post-processing, upgraded banana hazards,
  and slipstream wind-line effects.
-->
<script lang="ts">
  import { Canvas, T } from "@threlte/core";
  import { WebGLRenderer } from "three";
  import { Sky } from "@threlte/extras";
  import Track from "./Track.svelte";
  import Kart from "./Kart.svelte";
  import ItemBox from "./ItemBox.svelte";
  import Projectile from "./Projectile.svelte";
  import ChaseCam from "./ChaseCam.svelte";
  import RaceInput from "./RaceInput.svelte";
  import { getRaceStore } from "../context.js";

  const store = getRaceStore();

  function createRenderer(canvas: HTMLCanvasElement) {
    return new WebGLRenderer({
      canvas,
      antialias: true,
      logarithmicDepthBuffer: true,
    });
  }
</script>

<Canvas {createRenderer}>
  <!-- Camera -->
  <ChaseCam />

  <!-- Lighting -->
  <Sky
    elevation={25}
    azimuth={120}
    turbidity={4}
    rayleigh={0.5}
    mieCoefficient={0.005}
    mieDirectionalG={0.8}
  />
  <T.DirectionalLight
    color={0xffeedd}
    intensity={1.2}
    position={[150, 250, 100]}
  />
  <T.AmbientLight color={0x334466} intensity={0.5} />

  <!-- Track -->
  {#key store.trackId}
    <Track />
  {/key}

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

  <!-- Hazards (bananas) — upgraded with sphere + ground ring + point light -->
  {#each store.hazards as hazard (hazard.id)}
    <T.Group position={[hazard.position.x, hazard.position.y, hazard.position.z]}>
      <!-- Banana sphere -->
      <T.Mesh castShadow>
        <T.SphereGeometry args={[0.3, 12, 8]} />
        <T.MeshStandardMaterial
          color="#FFD93D"
          emissive="#FFD93D"
          emissiveIntensity={0.8}
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

      <!-- Glow light -->
      <T.PointLight
        color="#FFD93D"
        intensity={1.5}
        distance={3}
        decay={2}
      />
    </T.Group>
  {/each}

  <!-- Input handler (invisible) -->
  <RaceInput />
</Canvas>
