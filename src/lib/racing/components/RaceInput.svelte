<!--
  RaceInput — the single input sender. Merges keyboard state with touch
  input (written by the mobile HUD via controls.setTouchInput) and sends
  KartInput to the race actor.
  Renders nothing visible. Must be placed inside a Threlte <Canvas>.

  Keys are tracked by physical e.code ("KeyW", "ShiftLeft", ...), which is
  case-stable — tracking e.key let Shift (the drift key) strand a latched
  lowercase key ('a' added, 'A' deleted) so the kart steered forever after
  every drift exit. A window blur listener releases everything so alt-tab
  never leaves throttle latched.

  Enhancement: Input buffering — queues item-use and drift-initiate inputs
  for 6 ticks. If pressed during spin recovery, fires on first valid frame.

  Gamepad: a connected pad is polled every frame (no events on stick/trigger
  movement, so polling is the only option) and merged into buildInput alongside
  keyboard + touch — analog steering wins over digital when past the deadzone,
  booleans are OR'd. The Gamepad API needs no permission and no dependency.
-->
<script lang="ts">
	import { useTask } from "@threlte/core";
	import { SvelteSet } from "svelte/reactivity";
	import { getRaceRoomControls, getRaceStore } from "$lib/racing/context";
	import type { RaceRoomControlsWithTouch } from "$lib/racing/use-race-room.svelte";
	import { isHoldableItem, type KartInput } from "$lib/racing/types";

	// The race page always builds controls via useRaceRoom, which returns the
	// touch-aware extension of RaceRoomControls.
	const controls = getRaceRoomControls() as RaceRoomControlsWithTouch;
	const store = getRaceStore();

	// Track pressed keys by physical code (KeyboardEvent.code)
	const pressed = new SvelteSet<string>();

	// Game keys that must not scroll the page
	const PREVENT_DEFAULT_CODES = new Set([
		"ArrowUp",
		"ArrowDown",
		"ArrowLeft",
		"ArrowRight",
		"Space",
	]);

	// Input buffer constants
	const BUFFER_TICKS = 6;

	// --- Item tap-vs-hold (rear defense) -------------------------------------
	// Holding the item key with a holdable item (shells/banana) trails it behind
	// the kart as a shield (heldBehind in the input stream); a tap, or releasing
	// after a hold, fires it via useItem(). Speed/utility items aren't holdable —
	// they fire immediately on press as before (no release latency).
	const ITEM_HOLD_THRESHOLD_MS = 150;
	// performance.now() the item key went down; 0 when not held.
	let itemKeyDownAt = 0;
	// True while the held item is actively trailed (past the hold threshold).
	let itemTrailing = false;
	// Set on press to skip release-fire when the item fired immediately on press
	// (non-holdable item, or no item held).
	let itemFiredOnPress = false;

	// --- Gamepad constants ---------------------------------------------------
	// Left-stick deadzone (ignore drift/noise near center).
	const GAMEPAD_DEADZONE = 0.15;
	// Analog triggers report 0..1; treat past this as "pressed".
	const TRIGGER_PRESS_THRESHOLD = 0.2;

	/** Resolved analog/button state from the first connected pad, per frame. */
	interface GamepadRead {
		steering: number; // -1..1, 0 when within deadzone
		throttle: boolean;
		brake: boolean;
		drift: boolean;
		item: boolean;
		ready: boolean;
	}

	function readGamepad(): GamepadRead | null {
		if (typeof navigator === "undefined" || !navigator.getGamepads) {
			return null;
		}
		const pads = navigator.getGamepads();
		let pad: Gamepad | null = null;
		for (const p of pads) {
			if (p) {
				pad = p;
				break;
			}
		}
		if (!pad) return null;

		const axes = pad.axes;
		const buttons = pad.buttons;

		// Left-stick X → steering with a deadzone + quadratic response curve
		// (x*|x|) for fine control near center, full lock at the rim.
		const rawX = axes.length > 0 ? axes[0] : 0;
		let steering = 0;
		if (Math.abs(rawX) > GAMEPAD_DEADZONE) {
			// Rescale so the curve starts at the deadzone edge (no dead step).
			const sign = Math.sign(rawX);
			const mag = (Math.abs(rawX) - GAMEPAD_DEADZONE) / (1 - GAMEPAD_DEADZONE);
			const clamped = Math.min(1, mag);
			steering = sign * clamped * clamped;
		}

		const btn = (i: number): boolean =>
			i < buttons.length ? buttons[i].pressed || buttons[i].value > 0.5 : false;
		const triggerHeld = (i: number): boolean =>
			i < buttons.length &&
			(buttons[i].value > TRIGGER_PRESS_THRESHOLD || buttons[i].pressed);

		return {
			steering,
			// Right trigger (RT, button 7) → throttle; A (button 0) also works.
			throttle: triggerHeld(7) || btn(0),
			// Left trigger (LT, button 6) → brake.
			brake: triggerHeld(6),
			// X (button 2) / right bumper (button 5) → drift (hand-brake feel).
			drift: btn(2) || btn(5),
			// B (button 1) → use item.
			item: btn(1),
			// Start (button 9) → ready up in the lobby.
			ready: btn(9),
		};
	}

	// Latest pad read for the current frame (populated at the top of useTask so
	// buildInput, the buffers, and the ready-press edge all share one snapshot).
	let gamepad: GamepadRead | null = null;
	// Ready-button rising-edge latch (so holding Start fires readyUp once).
	let wasGamepadReadyHeld = false;
	// Item-button rising-edge latch (buffer the use on press, not while held).
	let wasGamepadItemHeld = false;

	// Track useItem as a buffered input (fires on first valid frame within buffer window)
	let itemBufferTicks = 0;

	// Track drift initiation as a buffered input
	let driftBufferTicks = 0;

	// Track whether drift was active last frame (to detect initiation vs. hold)
	let wasDriftHeld = false;

	$effect(() => {
		function onKeyDown(e: KeyboardEvent) {
			const code = e.code;

			// Prevent default for game keys to avoid scrolling etc.
			if (PREVENT_DEFAULT_CODES.has(code)) {
				e.preventDefault();
			}

			// Item key: tap fires, hold trails (rear defense). Press records the
			// hold start; the fire/trail decision is made in useTask + on release.
			if (!e.repeat && (code === "KeyE" || code === "KeyX")) {
				onItemPress();
			}

			// Buffered drift initiation: queue on initial keydown
			if (
				!e.repeat &&
				(code === "ShiftLeft" || code === "ShiftRight" || code === "Space")
			) {
				if (!wasDriftHeld) {
					driftBufferTicks = BUFFER_TICKS;
				}
			}

			pressed.add(code);
		}

		function onKeyUp(e: KeyboardEvent) {
			if (e.code === "KeyE" || e.code === "KeyX") {
				onItemRelease();
			}
			pressed.delete(e.code);
		}

		function onBlur() {
			// Alt-tab / focus loss: keyup events never arrive, so release
			// everything to avoid latched throttle/steering/drift (and a latched
			// trailed item).
			pressed.clear();
			itemBufferTicks = 0;
			driftBufferTicks = 0;
			wasDriftHeld = false;
			itemKeyDownAt = 0;
			itemTrailing = false;
			itemFiredOnPress = false;
		}

		// One-time "Gamepad connected" toast (per connect event). The first read
		// happens lazily in useTask — this is purely the feedback.
		function onGamepadConnected() {
			store.addToast("Gamepad connected", "#44FF88");
		}

		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("keyup", onKeyUp);
		window.addEventListener("blur", onBlur);
		window.addEventListener("gamepadconnected", onGamepadConnected);

		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("keyup", onKeyUp);
			window.removeEventListener("blur", onBlur);
			window.removeEventListener("gamepadconnected", onGamepadConnected);
			pressed.clear();
		};
	});

	function keyboardDriftHeld(): boolean {
		return (
			pressed.has("ShiftLeft") ||
			pressed.has("ShiftRight") ||
			pressed.has("Space")
		);
	}

	// --- Item tap-vs-hold edge handlers --------------------------------------

	/** Item key/button went down (debounced; ignores auto-repeat / re-entry). */
	function onItemPress(): void {
		if (itemKeyDownAt !== 0) return; // already held
		itemKeyDownAt = performance.now();
		itemTrailing = false;
		// Non-holdable items (mushroom/star/lightning) fire immediately on press
		// — there's nothing to trail and release latency would hurt their feel.
		if (!isHoldableItem(store.localItem)) {
			itemBufferTicks = BUFFER_TICKS;
			itemFiredOnPress = true;
		} else {
			itemFiredOnPress = false;
		}
	}

	/** Item key/button released — fire a holdable item (tap or release-after-hold). */
	function onItemRelease(): void {
		if (itemKeyDownAt === 0) return;
		// A holdable item that didn't already fire on press fires now (covers both
		// a quick tap and releasing after trailing it as a shield).
		if (!itemFiredOnPress) {
			itemBufferTicks = BUFFER_TICKS;
		}
		itemKeyDownAt = 0;
		itemTrailing = false;
		itemFiredOnPress = false;
	}

	function buildInput(): KartInput {
		// Merge keyboard with the touch arbiter and the gamepad: booleans OR'd,
		// analog steering wins over digital (touch, then gamepad stick) when it's
		// past its deadzone. The server clamps steering to [-1, 1] and already
		// accepts floats, so analog input improves handling with no netcode change.
		const touch = controls.touchInput;
		const pad = gamepad;

		const throttle =
			pressed.has("KeyW") ||
			pressed.has("ArrowUp") ||
			touch.throttle ||
			(pad?.throttle ?? false);

		const brake =
			pressed.has("KeyS") ||
			pressed.has("ArrowDown") ||
			touch.brake ||
			(pad?.brake ?? false);

		const steerLeft =
			pressed.has("KeyA") ||
			pressed.has("ArrowLeft");

		const steerRight =
			pressed.has("KeyD") ||
			pressed.has("ArrowRight");

		// Digital keyboard steering first; touch overrides; the analog stick
		// overrides last when deflected past its deadzone (readGamepad already
		// zeroes it inside the deadzone).
		let steering = 0;
		if (steerLeft && !steerRight) steering = -1;
		else if (steerRight && !steerLeft) steering = 1;
		if (touch.steering !== 0) steering = touch.steering;
		if (pad && pad.steering !== 0) steering = pad.steering;

		const driftHeld = keyboardDriftHeld() || touch.drift || (pad?.drift ?? false);

		// Drift: use buffer if we have buffered ticks, otherwise use current hold state
		let drift = driftHeld;
		if (driftBufferTicks > 0) {
			drift = true;
		}

		return {
			steering,
			throttle,
			brake,
			drift,
			useItem: false,
			// Rear-defense: trail the held item while the item key is held past the
			// hold threshold with a holdable item (resolved in useTask).
			heldBehind: itemTrailing,
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
		// Poll the pad once per frame; buildInput, the buffers, and the edge
		// detectors below all read this snapshot.
		gamepad = readGamepad();

		// Start button → ready up (lobby). Handled before the racing guards so a
		// gamepad-only player can ready up without touching the keyboard. Fire on
		// the rising edge so holding Start doesn't toggle ready every frame.
		if (gamepad) {
			if (gamepad.ready && !wasGamepadReadyHeld) {
				if (
					controls.isConnected &&
					store.phase === "waiting" &&
					!store.isSpectator &&
					store.localPlayerId
				) {
					controls.readyUp();
				}
			}
			wasGamepadReadyHeld = gamepad.ready;
		} else {
			wasGamepadReadyHeld = false;
		}

		// Wrong-way evaluation is client-side and self-throttled to ~10Hz; the
		// store method guards on phase/status so calling it each frame is cheap.
		store.updateWrongWay(performance.now());

		if (!controls.isConnected) return;
		if (!store.localKart) return;
		// Inputs only matter while racing — plus countdown, where the server
		// tracks held throttle for rocket-start timing.
		if (!store.isRacing && store.phase !== "countdown") return;

		// Gamepad item button → tap/hold edges (mirrors the keyboard handlers;
		// there are no button-press events to hook, so edges are derived here).
		if (gamepad) {
			if (gamepad.item && !wasGamepadItemHeld) {
				onItemPress();
			} else if (!gamepad.item && wasGamepadItemHeld) {
				onItemRelease();
			}
			wasGamepadItemHeld = gamepad.item;
		} else {
			if (wasGamepadItemHeld) onItemRelease();
			wasGamepadItemHeld = false;
		}

		// Gamepad drift button → buffered drift initiation on the rising edge.
		const padDrift = gamepad?.drift ?? false;
		if (padDrift && !wasDriftHeld && driftBufferTicks === 0) {
			driftBufferTicks = BUFFER_TICKS;
		}

		// Resolve trailing: a holdable item, held past the threshold and not yet
		// fired on press, trails behind the kart as a shield. Lost-item / spin
		// cases drop it (the server also clears heldItemActive in those states).
		itemTrailing =
			itemKeyDownAt !== 0 &&
			!itemFiredOnPress &&
			isHoldableItem(store.localItem) &&
			performance.now() - itemKeyDownAt >= ITEM_HOLD_THRESHOLD_MS;

		const input = buildInput();
		const isValid = canAcceptInput();

		// Decrement buffers
		if (itemBufferTicks > 0) {
			if (isValid) {
				controls.useItem();
				itemBufferTicks = 0;
			} else {
				// Keep waiting for the first frame where the kart can accept inputs.
				itemBufferTicks--;
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

		// Track drift hold state for next-frame initiation detection (includes
		// the gamepad so a held drift button doesn't re-trigger the buffer).
		wasDriftHeld =
			keyboardDriftHeld() || controls.touchInput.drift || padDrift;

		controls.sendInput(input);
	});
</script>
