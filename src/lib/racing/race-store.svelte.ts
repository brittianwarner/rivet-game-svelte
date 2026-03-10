/**
 * RaceStore — single reactive state container for kart racing.
 *
 * Components read from this store via Svelte context. The useRaceRoom
 * composable writes to it from actor events.
 */

import {
  vec3Zero,
  type Vec3,
  type KartState,
  type DriftState,
  type KartStatus,
  type ItemType,
  type ProjectileState,
  type HazardState,
  type ItemBoxState,
  type RacePhase,
  type RaceSnapshot,
  type RaceJoinStateResult,
  type KartHitEvent,
  type LapCompletedEvent,
  type ItemPickedUpEvent,
  type ItemUsedEvent,
  type RaceFinishedEvent,
  type RacePhaseChangedEvent,
  type RaceRoomState,
} from "./types.js";

function defaultDriftState(): DriftState {
  return { active: false, direction: 0, charge: 0, timer: 0 };
}

export class RaceStore {
  // ---------------------------------------------------------------------------
  // Reactive state
  // ---------------------------------------------------------------------------

  karts = $state<Record<string, KartState>>({});
  localPlayerId = $state<string | null>(null);
  projectiles = $state<ProjectileState[]>([]);
  hazards = $state<HazardState[]>([]);
  itemBoxes = $state<ItemBoxState[]>([]);
  phase = $state<RacePhase>("waiting");
  raceTimer = $state(0);
  positions = $state<string[]>([]);
  connectionError = $state<string | null>(null);
  roomId = $state<string>("");
  roomName = $state<string>("");
  finishedCount = $state(0);

  // Hit flash state (client-only visual)
  lastHitKartId = $state<string | null>(null);
  lastHitTime = $state(0);

  // Lap notification
  lastLapKartId = $state<string | null>(null);
  lastLapNumber = $state(0);
  lastLapTime = $state(0);

  // Toast notifications
  toasts = $state<{ id: number; text: string; color: string; timestamp: number }[]>([]);
  private toastCounter = 0;

  // Position change tracking
  previousPosition = $state(0);
  positionDelta = $state(0);
  positionChangeTime = $state(0);

  // Camera shake
  shakeIntensity = $state(0);
  shakeDecay = 4; // decay rate per second

  // Item roulette
  isItemRolling = $state(false);
  rollingItem = $state<string | null>(null);
  pendingItem = $state<string | null>(null);
  pendingCharges = $state(0);

  // Ready state (lobby)
  readyPlayers = $state<Record<string, boolean>>({});

  // Rematch
  rematchVotes = $state<Record<string, boolean>>({});

  // Stats
  raceStats = $state<Record<string, any>>({});

  // Spectator
  isSpectator = $state(false);

  // Countdown
  countdownNumber = $state<number | null>(null);

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  localKart = $derived.by(() => {
    if (!this.localPlayerId) return null;
    return this.karts[this.localPlayerId] ?? null;
  });

  localPosition = $derived.by(() => {
    if (!this.localPlayerId) return 0;
    const idx = this.positions.indexOf(this.localPlayerId);
    return idx >= 0 ? idx + 1 : 0;
  });

  playerCount = $derived(Object.keys(this.karts).length);

  kartList = $derived.by(() => Object.values(this.karts));

  localItem = $derived.by(() => this.localKart?.currentItem ?? null);

  localLap = $derived.by(() => this.localKart?.lap ?? 0);

  localSpeed = $derived.by(() => this.localKart?.speed ?? 0);

  // Drift charge for HUD
  localDriftActive = $derived.by(() => this.localKart?.driftState.active ?? false);
  localDriftCharge = $derived.by(() => this.localKart?.driftState.charge ?? 0);

  // Slipstream
  localSlipstream = $derived.by(() => this.localKart?.slipstreamActive ?? false);

  // Speed lines intensity
  speedLineIntensity = $derived.by(() => {
    const speed = this.localKart?.speed ?? 0;
    const boost = this.localKart?.boostSpeed ?? 0;
    const ratio = (speed + boost) / 0.6; // KART_MAX_SPEED
    return Math.max(0, (ratio - 0.6) * 2.5);
  });

  isRacing = $derived(this.phase === "racing");

  // ---------------------------------------------------------------------------
  // Mutators
  // ---------------------------------------------------------------------------

  initFromJoinState(result: RaceJoinStateResult): void {
    const { state, playerId } = result;
    this.roomId = state.id;
    this.roomName = state.name;
    this.phase = state.phase;
    this.localPlayerId = playerId;
    this.raceTimer = state.raceTimer;
    this.positions = [...state.positions];
    this.finishedCount = state.finishedCount;
    this.isSpectator = (result as any).isSpectator ?? false;

    // Rebuild karts
    const rebuilt: Record<string, KartState> = {};
    for (const [id, k] of Object.entries(state.players)) {
      rebuilt[id] = {
        ...k,
        velocity: k.velocity ?? vec3Zero(),
        driftState: k.driftState ?? defaultDriftState(),
      };
    }
    this.karts = rebuilt;

    // Item boxes
    this.itemBoxes = state.itemBoxes?.map((b) => ({ ...b })) ?? [];

    // Projectiles + hazards
    this.projectiles = state.projectiles?.map((p) => ({ ...p })) ?? [];
    this.hazards = state.hazards?.map((h) => ({ ...h })) ?? [];
  }

  applySnapshot(snapshot: RaceSnapshot): void {
    // Karts — deep mutation
    for (const [id, data] of Object.entries(snapshot.karts)) {
      const kart = this.karts[id];
      if (!kart) continue;
      kart.position.x = data.position.x;
      kart.position.y = data.position.y;
      kart.position.z = data.position.z;
      kart.heading = data.heading;
      kart.speed = data.speed;
      kart.velocity.x = data.velocity.x;
      kart.velocity.y = data.velocity.y;
      kart.velocity.z = data.velocity.z;
      kart.driftState.active = data.driftState.active;
      kart.driftState.direction = data.driftState.direction;
      kart.driftState.charge = data.driftState.charge;
      kart.driftState.timer = data.driftState.timer;
      kart.status = data.status;
      kart.statusTimer = data.statusTimer;
      kart.currentItem = data.currentItem;
      kart.itemCharges = data.itemCharges;
      kart.lap = data.lap;
      kart.checkpoint = data.checkpoint;
      kart.boostTimer = data.boostTimer;
      kart.boostSpeed = data.boostSpeed;
    }

    // Projectiles — replace
    this.projectiles = snapshot.projectiles.map((p) => ({ ...p }));

    // Hazards — replace
    this.hazards = snapshot.hazards.map((h) => ({ ...h }));

    // Item boxes — update active state
    for (const box of snapshot.itemBoxes) {
      const local = this.itemBoxes.find((b) => b.id === box.id);
      if (local) {
        local.active = box.active;
      }
    }

    // Meta
    this.raceTimer = snapshot.raceTimer;
    this.positions = [...snapshot.positions];

    // Track position changes
    const newPos = this.localPlayerId ? this.positions.indexOf(this.localPlayerId) + 1 : 0;
    if (newPos > 0 && this.previousPosition > 0 && newPos !== this.previousPosition) {
      this.positionDelta = this.previousPosition - newPos; // positive = gained
      this.positionChangeTime = performance.now();
    }
    this.previousPosition = newPos;
  }

  addKart(kart: KartState): void {
    this.karts[kart.id] = {
      ...kart,
      velocity: kart.velocity ?? vec3Zero(),
      driftState: kart.driftState ?? defaultDriftState(),
    };
  }

  removeKart(kartId: string): void {
    delete this.karts[kartId];
  }

  applyPhaseChanged(data: RacePhaseChangedEvent): void {
    this.phase = data.phase;
    this.raceTimer = data.raceTimer;
  }

  applyItemPickedUp(data: ItemPickedUpEvent): void {
    const kart = this.karts[data.kartId];
    if (kart) {
      // If it's the local player, use roulette animation
      if (data.kartId === this.localPlayerId) {
        this.startItemRoulette(data.item as string, data.charges);
      } else {
        kart.currentItem = data.item;
        kart.itemCharges = data.charges;
      }
    }
    const box = this.itemBoxes.find((b) => b.id === data.boxId);
    if (box) {
      box.active = false;
    }
  }

  applyItemUsed(data: ItemUsedEvent): void {
    const kart = this.karts[data.kartId];
    if (kart) {
      if (kart.itemCharges > 1) {
        kart.itemCharges--;
      } else {
        kart.currentItem = null;
        kart.itemCharges = 0;
      }
    }
    if (data.projectile) {
      this.projectiles.push({ ...data.projectile });
    }
    if (data.hazard) {
      this.hazards.push({ ...data.hazard });
    }
  }

  applyKartHit(data: KartHitEvent): void {
    this.lastHitKartId = data.kartId;
    this.lastHitTime = performance.now();

    // Trigger camera shake for local player
    if (data.kartId === this.localPlayerId) {
      this.triggerShake(0.08); // direct hit
    } else {
      this.triggerShake(0.03); // nearby hit
    }

    // Add toast
    const hitKart = this.karts[data.kartId];
    const byKart = data.byKartId ? this.karts[data.byKartId] : null;
    const hitName = hitKart?.name ?? "Unknown";
    const byName = byKart?.name ?? "";
    const itemNames: Record<string, string> = {
      greenShell: "Green Shell",
      redShell: "Red Shell",
      blueShell: "Blue Shell",
      banana: "Banana",
      lightning: "Lightning",
      collision: "collision",
    };
    const itemLabel = itemNames[data.itemType] ?? data.itemType;
    if (byName) {
      this.addToast(`${byName} hit ${hitName} with ${itemLabel}`, "#FF4444");
    } else {
      this.addToast(`${hitName} hit by ${itemLabel}`, "#FF4444");
    }
  }

  applyLapCompleted(data: LapCompletedEvent): void {
    const kart = this.karts[data.kartId];
    if (kart) {
      kart.lap = data.lap;
    }
    this.lastLapKartId = data.kartId;
    this.lastLapNumber = data.lap;
    this.lastLapTime = performance.now();
  }

  applyRaceFinished(data: RaceFinishedEvent): void {
    this.positions = [...data.positions];
    for (const [id, time] of Object.entries(data.finishTimes)) {
      const kart = this.karts[id];
      if (kart) {
        kart.finishTime = time;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // New event handlers
  // ---------------------------------------------------------------------------

  applyDriftTier(data: { kartId: string; tier: number }): void {
    // Toast only for local player tier 3
    if (data.kartId === this.localPlayerId && data.tier === 3) {
      this.addToast("MAX DRIFT CHARGE!", "#CC44FF");
    }
  }

  applySlipstream(data: { kartId: string; active: boolean }): void {
    if (data.kartId === this.localPlayerId && data.active) {
      this.addToast("SLIPSTREAM!", "#00CCFF");
    }
  }

  applyRocketStart(data: { kartId: string; tier: string; boostSpeed: number }): void {
    if (data.kartId === this.localPlayerId) {
      const labels: Record<string, [string, string]> = {
        perfect: ["PERFECT START!", "#FFD700"],
        good: ["GOOD START!", "#44FF88"],
        ok: ["OK START", "#AAAAAA"],
        stall: ["STALLED!", "#FF4444"],
      };
      const [text, color] = labels[data.tier] ?? ["START", "#FFFFFF"];
      this.addToast(text, color);
    }
  }

  applyReadyState(data: {
    playerId: string;
    ready: boolean;
    readyCount: number;
    totalCount: number;
  }): void {
    this.readyPlayers[data.playerId] = data.ready;
  }

  applyRematchVote(data: {
    votes: Record<string, boolean>;
    voteCount: number;
    needed: number;
  }): void {
    this.rematchVotes = { ...data.votes };
  }

  applyRaceToast(data: { text: string; color: string }): void {
    this.addToast(data.text, data.color);
  }

  // ---------------------------------------------------------------------------
  // Toast / shake / roulette helpers
  // ---------------------------------------------------------------------------

  addToast(text: string, color: string): void {
    this.toasts = [
      ...this.toasts,
      { id: this.toastCounter++, text, color, timestamp: performance.now() },
    ];
    // Auto-remove after 3 seconds
    const id = this.toastCounter - 1;
    setTimeout(() => {
      this.toasts = this.toasts.filter((t) => t.id !== id);
    }, 3000);
    // Cap at 4 visible
    if (this.toasts.length > 4) {
      this.toasts = this.toasts.slice(-4);
    }
  }

  triggerShake(intensity: number): void {
    this.shakeIntensity = Math.max(this.shakeIntensity, intensity);
  }

  startItemRoulette(finalItem: string, finalCharges: number): void {
    this.isItemRolling = true;
    this.pendingItem = finalItem;
    this.pendingCharges = finalCharges;
    // Roulette animation: cycle random items for 1.5s
    const items = [
      "greenShell",
      "redShell",
      "banana",
      "mushroom",
      "star",
      "blueShell",
      "lightning",
      "triMushroom",
    ];
    let cycles = 0;
    const maxCycles = 15;
    const interval = setInterval(() => {
      this.rollingItem = items[Math.floor(Math.random() * items.length)];
      cycles++;
      if (cycles >= maxCycles) {
        clearInterval(interval);
        this.rollingItem = finalItem;
        this.isItemRolling = false;
        // Apply the real item to the kart
        if (this.localPlayerId && this.karts[this.localPlayerId]) {
          this.karts[this.localPlayerId].currentItem = finalItem as any;
          this.karts[this.localPlayerId].itemCharges = finalCharges;
        }
      }
    }, 100);
  }

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------

  reset(): void {
    this.karts = {};
    this.localPlayerId = null;
    this.projectiles = [];
    this.hazards = [];
    this.itemBoxes = [];
    this.phase = "waiting";
    this.raceTimer = 0;
    this.positions = [];
    this.connectionError = null;
    this.roomId = "";
    this.roomName = "";
    this.finishedCount = 0;
    this.lastHitKartId = null;
    this.lastHitTime = 0;
    this.lastLapKartId = null;
    this.lastLapNumber = 0;
    this.lastLapTime = 0;
    this.toasts = [];
    this.toastCounter = 0;
    this.previousPosition = 0;
    this.positionDelta = 0;
    this.positionChangeTime = 0;
    this.shakeIntensity = 0;
    this.isItemRolling = false;
    this.rollingItem = null;
    this.pendingItem = null;
    this.pendingCharges = 0;
    this.readyPlayers = {};
    this.rematchVotes = {};
    this.raceStats = {};
    this.isSpectator = false;
    this.countdownNumber = null;
  }
}
