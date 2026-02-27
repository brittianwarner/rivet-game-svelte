<!--
  Environment — Lighting + programmatic environment map for PBR materials.
  
  PMREMGenerator creates a minimal gradient env cube map so clearcoat
  renders properly without external HDR files. Runs once on mount.
  
  Optimizations:
  - Shadow map reduced to 1024x1024 (sufficient for spherical marbles)
  - PMREMGenerator wrapped in try/catch (graceful degradation)
  - Removed unnecessary compileEquirectangularShader() call
  - Correct LinearSRGBColorSpace for env maps (avoids double gamma)
  - Shadow config set via oncreate (avoids Threlte prop watchers)
-->
<script lang="ts">
	import { T, useThrelte } from "@threlte/core";
	import { onMount } from "svelte";
	import * as THREE from "three";

	const threlte = useThrelte();

	onMount(() => {
		const { scene, renderer } = threlte;
		if (!renderer) {
			console.warn("Environment: no WebGL renderer available, skipping env map");
			return;
		}

		let envMap: THREE.Texture | null = null;

		try {
			const pmrem = new THREE.PMREMGenerator(renderer);

			// Create a simple gradient scene for the env map
			const envScene = new THREE.Scene();

			// Dark blue-purple gradient background (matches game aesthetic)
			const topColor = new THREE.Color("#1a0a3e");
			const bottomColor = new THREE.Color("#0a1628");

			const hemiLight = new THREE.HemisphereLight(topColor, bottomColor, 1.0);
			envScene.add(hemiLight);

		// Layerr Blue specular highlight for env map reflections
		const pointLight = new THREE.PointLight("#0A9EF5", 2, 100);
		pointLight.position.set(5, 10, 5);
		envScene.add(pointLight);

		// Dim cool fill from below
		const coolLight = new THREE.PointLight("#0A5EA5", 1, 80);
		coolLight.position.set(-5, -5, -5);
		envScene.add(coolLight);

			const renderTarget = pmrem.fromScene(envScene, 0.04);
			envMap = renderTarget.texture;
			// LinearSRGBColorSpace is correct for env maps — avoids double gamma
			envMap.colorSpace = THREE.LinearSRGBColorSpace;
			scene.environment = envMap;

			pmrem.dispose();
		} catch (err) {
			console.warn("Environment: PMREMGenerator failed, PBR reflections disabled", err);
		}

		// Pre-compile all shaders to avoid first-frame stutter
		try {
			const { camera } = threlte;
			if (camera.current) {
				renderer.compile(scene, camera.current);
			}
		} catch {
			// Non-critical — shaders will compile lazily on first frame
		}

		return () => {
			if (envMap) {
				if (scene.environment === envMap) {
					scene.environment = null;
				}
				envMap.dispose();
			}
		};
	});
</script>

<!-- Ambient fill light -->
<T.AmbientLight intensity={0.2} color="#223366" />

<!-- Main directional light with shadows (config via oncreate to avoid prop watchers) -->
<T.DirectionalLight
	position={[8, 20, 10]}
	intensity={1.55}
	color="#c7f4ff"
	castShadow
	oncreate={(light) => {
		light.shadow.mapSize.width = 1024;
		light.shadow.mapSize.height = 1024;
		light.shadow.camera.near = 0.5;
		light.shadow.camera.far = 50;
		light.shadow.camera.left = -15;
		light.shadow.camera.right = 15;
		light.shadow.camera.top = 15;
		light.shadow.camera.bottom = -15;
	}}
/>

<!-- Rim light for depth -->
<T.DirectionalLight position={[-9, 8, -10]} intensity={0.6} color="#00f6ff" />

<!-- Subtle point light below the arena for glow effect -->
<T.PointLight position={[0, -3, 0]} intensity={1.1} color="#0099ff" distance={42} />
<T.PointLight position={[0, 5, 0]} intensity={0.4} color="#7e5bff" distance={30} />
