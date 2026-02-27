<!--
  PointerInput — tracks mouse/touch position via pointer events,
  raycasts onto the arena ground plane (y=0), and sends the world-space
  target to the actor via GameRoomControls context.

  Performance: only sends input to the actor when the player is actively
  pressing (isPointing). Passive hover updates the visual target indicator
  but does NOT send network traffic.
-->
<script lang="ts">
	import { T, useThrelte } from "@threlte/core";
	import * as THREE from "three";
	import { getGameStore, getGameRoomControls } from "$lib/game/context";

	const store = getGameStore();
	const controls = getGameRoomControls();

	// Raycasting state — reused objects (no allocations per frame)
	const raycaster = new THREE.Raycaster();
	const pointer = new THREE.Vector2();
	const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
	const intersectPoint = new THREE.Vector3();

	// Reactive target position for the visual indicator
	let targetX = $state(0);
	let targetZ = $state(0);
	let isPointing = $state(false);
	let showTarget = $state(false);

	const { camera, renderer } = useThrelte();

	function updatePointer(clientX: number, clientY: number): void {
		const canvas = renderer.domElement;
		if (!canvas) return;

		const rect = canvas.getBoundingClientRect();
		pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
		pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;

		const cam = camera.current;
		if (!cam) return;

		raycaster.setFromCamera(pointer, cam);
		const hit = raycaster.ray.intersectPlane(groundPlane, intersectPoint);

		if (hit) {
			targetX = intersectPoint.x;
			targetZ = intersectPoint.z;
			showTarget = true;

			// Only send input when actively pressing — passive hover is visual only
			if (isPointing) {
				controls.sendInput({
					tx: intersectPoint.x,
					tz: intersectPoint.z,
					active: true,
				});
			}
		}
	}

	// Attach pointer events (unified mouse + touch + pen) to the canvas
	$effect(() => {
		const canvas = renderer.domElement;
		if (!canvas) return;

		const handlePointerDown = (e: PointerEvent) => {
			if (e.button !== 0) return;
			isPointing = true;
			updatePointer(e.clientX, e.clientY);
		};

		const handlePointerMove = (e: PointerEvent) => {
			updatePointer(e.clientX, e.clientY);
		};

		const handlePointerUp = (e: PointerEvent) => {
			if (e.button !== 0) return;
			isPointing = false;
			controls.sendInput({
				tx: targetX,
				tz: targetZ,
				active: false,
			});
		};

		const handleContextMenu = (e: Event) => {
			e.preventDefault();
		};

		canvas.addEventListener("pointerdown", handlePointerDown);
		canvas.addEventListener("pointermove", handlePointerMove);
		window.addEventListener("pointerup", handlePointerUp);
		canvas.addEventListener("contextmenu", handleContextMenu);

		// Prevent touch scrolling on the canvas
		canvas.style.touchAction = "none";

		return () => {
			canvas.removeEventListener("pointerdown", handlePointerDown);
			canvas.removeEventListener("pointermove", handlePointerMove);
			window.removeEventListener("pointerup", handlePointerUp);
			canvas.removeEventListener("contextmenu", handleContextMenu);
		};
	});
</script>

<!-- Visual target indicator on the ground plane -->
{#if showTarget}
	<T.Group position={[targetX, 0.05, targetZ]}>
		<!-- Outer ring -->
		<T.Mesh rotation.x={-Math.PI / 2}>
			<T.RingGeometry args={[0.4, 0.55, 32]} />
			<T.MeshBasicMaterial
			color={isPointing ? "#0A9EF5" : "#ffffff"}
			transparent
			opacity={isPointing ? 0.6 : 0.2}
		/>
	</T.Mesh>
	<!-- Center dot -->
	<T.Mesh rotation.x={-Math.PI / 2}>
		<T.CircleGeometry args={[0.1, 16]} />
		<T.MeshBasicMaterial
			color={isPointing ? "#0A9EF5" : "#ffffff"}
				transparent
				opacity={isPointing ? 0.8 : 0.35}
			/>
		</T.Mesh>
	</T.Group>
{/if}
