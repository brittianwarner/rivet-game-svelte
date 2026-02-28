<!--
  PointerInput — tracks mouse/touch, raycasts onto ground plane (y=0),
  sends target to actor. Right-click or two-finger tap triggers dash.
-->
<script lang="ts">
	import { T, useThrelte } from "@threlte/core";
	import * as THREE from "three";
	import { getGameStore, getGameRoomControls } from "$lib/game/context";

	const store = getGameStore();
	const controls = getGameRoomControls();

	const raycaster = new THREE.Raycaster();
	const pointer = new THREE.Vector2();
	const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
	const intersectPoint = new THREE.Vector3();

	let targetX = $state(0);
	let targetZ = $state(0);
	let isPointing = $state(false);
	let showTarget = $state(false);

	const { camera, renderer } = useThrelte();

	// Hoisted geometries and materials to avoid re-creation
	const ringGeo = new THREE.RingGeometry(0.4, 0.55, 32);
	const circleGeo = new THREE.CircleGeometry(0.1, 16);
	const ringMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.2, color: 0xffffff });
	const circleMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.35, color: 0xffffff });

	$effect(() => {
		const c = isPointing ? "#0A9EF5" : "#ffffff";
		ringMat.color.set(c);
		ringMat.opacity = isPointing ? 0.6 : 0.2;
		circleMat.color.set(c);
		circleMat.opacity = isPointing ? 0.8 : 0.35;
	});

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

			if (isPointing) {
				controls.sendInput({
					tx: intersectPoint.x,
					tz: intersectPoint.z,
					active: true,
					dash: false,
				});
			}
		}
	}

	$effect(() => {
		const canvas = renderer.domElement;
		if (!canvas) return;

		const handlePointerDown = (e: PointerEvent) => {
			if (e.button === 2) {
				// Right-click = dash
				e.preventDefault();
				controls.dash();
				return;
			}
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
				dash: false,
			});
		};

		const handleContextMenu = (e: Event) => {
			e.preventDefault();
		};

		// Two-finger tap for dash on mobile
		let touchCount = 0;
		const handleTouchStart = (e: TouchEvent) => {
			touchCount = e.touches.length;
			if (touchCount >= 2) {
				controls.dash();
			}
		};
		const handleTouchEnd = () => {
			touchCount = 0;
		};

		canvas.addEventListener("pointerdown", handlePointerDown);
		canvas.addEventListener("pointermove", handlePointerMove);
		window.addEventListener("pointerup", handlePointerUp);
		canvas.addEventListener("contextmenu", handleContextMenu);
		canvas.addEventListener("touchstart", handleTouchStart, { passive: true });
		canvas.addEventListener("touchend", handleTouchEnd, { passive: true });

		canvas.style.touchAction = "none";

		return () => {
			canvas.removeEventListener("pointerdown", handlePointerDown);
			canvas.removeEventListener("pointermove", handlePointerMove);
			window.removeEventListener("pointerup", handlePointerUp);
			canvas.removeEventListener("contextmenu", handleContextMenu);
			canvas.removeEventListener("touchstart", handleTouchStart);
			canvas.removeEventListener("touchend", handleTouchEnd);
		};
	});
</script>

{#if showTarget}
	<T.Group position={[targetX, 0.05, targetZ]}>
		<T.Mesh rotation.x={-Math.PI / 2} geometry={ringGeo} material={ringMat} />
		<T.Mesh rotation.x={-Math.PI / 2} geometry={circleGeo} material={circleMat} />
	</T.Group>
{/if}
