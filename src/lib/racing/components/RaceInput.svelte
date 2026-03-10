<!--
  RaceInput — captures keyboard input and sends KartInput to the race actor.
  Renders nothing visible. Must be placed inside a Threlte <Canvas>.

  Enhancement: Input buffering — queues item-use and drift-initiate inputs
  for 6 ticks. If pressed during spin recovery, fires on first valid frame.
-->
<script lang="ts">
	import { useTask } from "@threlte/core";
	import { getRaceRoomControls, getRaceStore } from "$lib/racing/context";
	import type { KartInput } from "$lib/racing/types";

	const controls = getRaceRoomControls();
	const store = getRaceStore();

	// Track pressed keys
	const pressed = new Set<string>();

	// Input buffer constants
	const BUFFER_TICKS = 6;

	// Track useItem as a buffered input (fires on first valid frame within buffer window)
	let itemBufferTicks = 0;

	// Track drift initiation as a buffered input
	let driftBufferTicks = 0;

	// Track whether drift was active last frame (to detect initiation vs. hold)
	let wasDriftHeld = false;

	$effect(() => {
		function onKeyDown(e: KeyboardEvent) {
			// Prevent default for game keys to avoid scrolling etc.
			const key = e.key;
			if (
				key === "ArrowUp" ||
				key === "ArrowDown" ||
				key === "ArrowLeft" ||
				key === "ArrowRight" ||
				key === " "
			) {
				e.preventDefault();
			}

			// Buffered item use: queue on initial keydown, not repeat
			if (!e.repeat && (key === "e" || key === "E" || key === "x" || key === "X")) {
				itemBufferTicks = BUFFER_TICKS;
			}

			// Buffered drift initiation: queue on initial keydown
			if (!e.repeat && (key === "Shift" || key === " ")) {
				if (!wasDriftHeld) {
					driftBufferTicks = BUFFER_TICKS;
				}
			}

			pressed.add(key);
		}

		function onKeyUp(e: KeyboardEvent) {
			pressed.delete(e.key);
		}

		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("keyup", onKeyUp);

		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("keyup", onKeyUp);
			pressed.clear();
		};
	});

	function buildInput(): KartInput {
		const throttle =
			pressed.has("w") ||
			pressed.has("W") ||
			pressed.has("ArrowUp");

		const brake =
			pressed.has("s") ||
			pressed.has("S") ||
			pressed.has("ArrowDown");

		const steerLeft =
			pressed.has("a") ||
			pressed.has("A") ||
			pressed.has("ArrowLeft");

		const steerRight =
			pressed.has("d") ||
			pressed.has("D") ||
			pressed.has("ArrowRight");

		let steering = 0;
		if (steerLeft && !steerRight) steering = -1;
		else if (steerRight && !steerLeft) steering = 1;

		const driftHeld =
			pressed.has("Shift") ||
			pressed.has(" ");

		// Drift: use buffer if we have buffered ticks, otherwise use current hold state
		let drift = driftHeld;
		if (driftBufferTicks > 0) {
			drift = true;
		}

		// Item use from buffer
		let useItem = false;
		if (itemBufferTicks > 0) {
			useItem = true;
		}

		return {
			steering,
			throttle,
			brake,
			drift,
			useItem,
		};
	}

	// Check if the local kart can accept inputs (not in spin/falling state)
	function canAcceptInput(): boolean {
		const kart = store.localKart;
		if (!kart) return false;
		// During spinning or falling, inputs are blocked on the server
		// but we still buffer them
		return kart.status !== "spinning" && kart.status !== "falling";
	}

	// Send input every frame — the RaceRoomControls.sendInput composable
	// handles 20Hz throttling internally.
	useTask(() => {
		if (!controls.isConnected) return;
		if (!store.localKart) return;

		const input = buildInput();
		const isValid = canAcceptInput();

		// Decrement buffers
		if (itemBufferTicks > 0) {
			if (isValid) {
				// Fire the buffered item use
				itemBufferTicks = 0;
			} else {
				// Keep waiting
				itemBufferTicks--;
				// Don't send useItem yet if not valid
				input.useItem = false;
			}
		}

		if (driftBufferTicks > 0) {
			if (isValid) {
				driftBufferTicks = 0;
			} else {
				driftBufferTicks--;
				// Keep drift flagged until buffer runs out
			}
		}

		// Track drift hold state for next-frame initiation detection
		wasDriftHeld = pressed.has("Shift") || pressed.has(" ");

		controls.sendInput(input);

		// Fire item use through the dedicated RPC when queued
		if (input.useItem && isValid) {
			controls.useItem();
		}
	});
</script>
