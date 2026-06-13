/**
 * RaceStore — single reactive state container for kart racing.
 *
 * Components read from this store via Svelte context. The useRaceRoom
 * composable writes to it from actor events.
 */

import {
  vec3Zero,
  RACE_INTERP_DELAY_MS,
  RACE_SERVER_TICK_INTERVAL,
  RACE_LAP_COUNT,
  SLIPSTREAM_DURATION_TICKS,
  KART_MAX_SPEED,
  type Vec3,
  type KartState,
  type KartInput,
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
  type TrackId,
  type RaceMode,
  DEFAULT_RACE_MODE,
} from "./types.js";
import { coerceRaceCarId } from "./car-catalog.js";
import { getTrack, findNearestSegment } from "./track.js";
import {
  createKartSimState,
  stepKart,
  type KartSimState,
} from "./kart-physics.js";

function defaultDriftState(): DriftState {
  return { active: false, direction: 0, charge: 0, timer: 0 };
}

// ---------------------------------------------------------------------------
// Netcode tuning — interpolation buffer + local prediction
// ---------------------------------------------------------------------------

/** Cap forward extrapolation when snapshots gap out */
const MAX_EXTRAPOLATION_MS = 100;
/** Buffered snapshots kept for render-behind interpolation */
const SNAPSHOT_BUFFER_SIZE = 5;
/** Snapshot velocity is units-per-16ms-tick — convert to units-per-second */
const VELOCITY_PER_SECOND = 1000 / RACE_SERVER_TICK_INTERVAL; // 62.5
/** A bracketing-pair position gap beyond this is a teleport — snap, don't glide */
const INTERP_TELEPORT_DISTANCE = 18;
/** Prediction correction offset decay rate (≈150ms to settle) */
const CORRECTION_DECAY_RATE = 20;
/** Reconciliation error beyond this snaps instead of smoothing (units) */
const MAX_CORRECTION_DISTANCE = 3;
/** Unacked input ring buffer cap (~2s at 30Hz) */
const MAX_PENDING_INPUTS = 64;
/** Replay at most this many unacked inputs per reconciliation */
const MAX_REPLAY_INPUTS = 32;
/** A buffer whose newest entry is older than this is stale (no paced snapshots) */
const SNAPSHOT_STALE_MS = 1000;

// ---------------------------------------------------------------------------
// Wrong-way detection (pure client-side)
// ---------------------------------------------------------------------------

/** Below this speed the kart isn't really "going" anywhere — don't warn. */
const WRONG_WAY_MIN_SPEED = 0.3;
/** dot(travel dir, segment forward) below this counts as facing backwards. */
const WRONG_WAY_DOT_THRESHOLD = -0.5;
/** Sustain a backwards reading this long before the banner shows (debounce). */
const WRONG_WAY_SUSTAIN_MS = 1000;
/** Re-evaluate wrong-way at ~10Hz, not every render frame. */
const WRONG_WAY_INTERVAL_MS = 100;

export interface InterpolatedPose {
  x: number;
  y: number;
  z: number;
  heading: number;
  speed: number;
}

/** A one-shot cosmetic 3D effect queued for the ImpactVfx pool. */
export type VfxType = "hit" | "lightning" | "confetti";

export interface VfxEvent {
  /** Monotonic id so the consumer can tell entries apart / dedup if needed. */
  id: number;
  type: VfxType;
  /** World-space origin of the effect. */
  x: number;
  y: number;
  z: number;
  /** performance.now() at enqueue (for staleness culling). */
  t: number;
  /** Effect tint (hex), e.g. shell vs lightning vs confetti accent. */
  color: string;
}

interface BufferedKart {
  x: number;
  y: number;
  z: number;
  heading: number;
  speed: number;
  vx: number;
  vz: number;
}

interface BufferedProjectile {
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
}

interface SnapshotBufferEntry {
  /** Server sim time of the snapshot (tick × tick interval), ms */
  t: number;
  /** performance.now() at receipt */
  recv: number;
  karts: Record<string, BufferedKart>;
  projectiles: Record<string, BufferedProjectile>;
}

interface PendingInput {
  seq: number;
  input: KartInput;
  sentAt: number;
}

function idleInput(): KartInput {
  return { steering: 0, throttle: false, brake: false, drift: false, useItem: false };
}

/** Shared empty result for drainVfx so the common (idle) path allocates nothing. */
const EMPTY_VFX: VfxEvent[] = [];

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
  trackId = $state<TrackId>("track1");
  mode = $state<RaceMode>(DEFAULT_RACE_MODE);
  lapCount = $state(RACE_LAP_COUNT);
  itemsEnabled = $state(true);
  botsEnabled = $state(true);
  finishedCount = $state(0);

  // Hit flash state (client-only visual)
  lastHitKartId = $state<string | null>(null);
  lastHitTime = $state(0);

  // ---------------------------------------------------------------------------
  // Impact / status VFX (client-only, cosmetic — never touches the sim).
  //
  // One-shot 3D effects (shell-hit shockwaves, lightning strikes, the finish
  // confetti burst) are pushed onto `vfxQueue` from event handlers with a
  // world position read off store.karts / the track. ImpactVfx.svelte drains
  // the queue each frame into a fixed pool of pooled, light-free effects. The
  // queue is NON-reactive (a plain array consumed from a useTask) so pushing to
  // it never schedules a Svelte re-render.
  //
  // `lightningFlashAt` is a reactive timestamp that drives the brief
  // full-screen white flash div (RaceScene's outer DOM layer) when the LOCAL
  // player is struck — reactive because the HTML overlay reads it directly.
  // ---------------------------------------------------------------------------

  /** Drain-once queue of one-shot world VFX (drained by ImpactVfx each frame). */
  readonly vfxQueue: VfxEvent[] = [];
  private vfxCounter = 0;
  /** performance.now() of the most recent local lightning strike (0 = none). */
  lightningFlashAt = $state(0);

  // Lap notification
  lastLapKartId = $state<string | null>(null);
  lastLapNumber = $state(0);
  lastLapTime = $state(0);

  // ---------------------------------------------------------------------------
  // Lap timing telemetry (local player) — fed by lapCompleted events. The live
  // current-lap timer is `raceTimer - lapStartTime`; best/last splits surface
  // in the HUD and the lap-split toast.
  // ---------------------------------------------------------------------------

  /** raceTimer (ms) at the local player's most recent lap crossing / GO */
  lapStartTime = $state(0);
  /** Server-reported duration of the local player's most recently finished lap */
  lastLapSplitMs = $state(0);
  /** Best (smallest) finished lap split for the local player this race, ms */
  bestLapMs = $state<number | null>(null);
  /** Lap number for the most recent local split (drives the split toast) */
  lastLapSplitLap = $state(0);
  /** Wall-clock time the last local split landed (auto-hide the split toast) */
  lastLapSplitAt = $state(0);

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

  // Wrong-way warning (client-only): true once the local kart has been driving
  // against the track direction for >1s. Drives the flashing HUD banner.
  wrongWay = $state(false);

  // ---------------------------------------------------------------------------
  // Time-trial ghost delta (client-only). `ghostDeltaMs` is the live gap to the
  // stored ghost at matching track progress: positive = local is BEHIND the
  // ghost (it reached this point earlier), negative = AHEAD. `ghostActive` is
  // true while a ghost is loaded for the current run. Both are reactive so the
  // HUD delta widget updates; the actual sampling lives in ghost-recorder and is
  // pumped into here each frame from the play page (zero server involvement).
  // ---------------------------------------------------------------------------

  ghostActive = $state(false);
  /** Gap to the ghost in ms (null until both the ghost and local progress exist) */
  ghostDeltaMs = $state<number | null>(null);

  /** True while in time-trial mode (drives the lobby-less solo HUD chrome). */
  isTimeTrial = $derived(this.mode === "timeTrial");

  // The decoded ghost timeline is a Float32Array-backed plain object — kept OFF
  // $state (the proxy would deep-wrap the typed arrays for no benefit). RaceScene
  // mounts GhostKart off the reactive `ghostActive` flag and reads this via the
  // getter; the play page is the only writer (start/stop of a TT run).
  private ghostTimeline: unknown = null;

  /** Set/clear the active ghost playback timeline (null disables the ghost). */
  setGhostTimeline(timeline: unknown): void {
    this.ghostTimeline = timeline;
    this.ghostActive = timeline != null;
    if (timeline == null) this.ghostDeltaMs = null;
  }

  /** The active ghost timeline (typed by the caller against ghost-recorder). */
  getGhostTimeline(): unknown {
    return this.ghostTimeline;
  }

  // ---------------------------------------------------------------------------
  // Netcode state (intentionally NON-reactive — polled from useTask each
  // frame and mutated at render/snapshot rate; $state proxying would only
  // add overhead with no subscriber benefit)
  // ---------------------------------------------------------------------------

  /** Ring buffer of recent snapshots for render-behind interpolation */
  private snapshotBuffer: SnapshotBufferEntry[] = [];

  /** Predicted local-kart physics state (plain clone, stepped at render rate) */
  private predictedKart: KartState | null = null;
  private predictedSim: KartSimState = createKartSimState();
  /** Inputs sent to the server but not yet acked in a snapshot */
  private pendingInputs: PendingInput[] = [];
  /** Newest input seq the server has confirmed applying for the local kart */
  private lastProcessedSeq = 0;
  /** Reconciliation offset (rendered = predicted + correction), decays ~150ms */
  private corrX = 0;
  private corrZ = 0;
  private corrHeading = 0;
  /** Latest local input intent (every frame, regardless of wire cadence) */
  private localInput: KartInput | null = null;
  private lastAuthoritativeStatus: KartStatus = "normal";

  // Item roulette interval (cleared on reset/new roulette so it never leaks)
  private rouletteInterval: ReturnType<typeof setInterval> | null = null;

  // Wrong-way detection bookkeeping (non-reactive — polled at ~10Hz from a
  // frame loop): a cached nearest-segment hint to keep the lookup cheap, the
  // wall-clock instant the kart first started facing backwards (0 = facing
  // forward), and a throttle clock so we only recompute every ~100ms.
  private wrongWaySegHint = 0;
  private wrongWaySince = 0;
  private wrongWayNextEvalAt = 0;

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

  // Speed lines intensity — scaled against the *real* top speed (KART_MAX_SPEED
  // is 3.0; the old hardcoded 0.6 divisor saturated the vignette at ~12% of top
  // speed). Lines now ramp in above ~85% of top speed so they read as
  // boost/near-top-speed rather than "moving at all".
  speedLineIntensity = $derived.by(() => {
    const speed = this.localKart?.speed ?? 0;
    const boost = this.localKart?.boostSpeed ?? 0;
    const ratio = (speed + boost) / KART_MAX_SPEED;
    return Math.max(0, (ratio - 0.85) * 4);
  });

  isRacing = $derived(this.phase === "racing");

  // ---------------------------------------------------------------------------
  // Telemetry derived state
  // ---------------------------------------------------------------------------

  /**
   * Whether a kart has crossed the final finish line. The per-snapshot stream
   * carries `lap` but not `finishTime` (that only lands at race end via
   * raceFinished), and the server stops advancing a kart's lap the moment it
   * finishes — so `lap >= lapCount` is the authoritative mid-race "finished"
   * signal clients can read live.
   */
  private kartHasFinished(kart: KartState | undefined | null): boolean {
    if (!kart) return false;
    if (kart.finishTime !== null) return true;
    return kart.lap >= this.lapCount;
  }

  /** The local player crossed the finish line while others are still racing. */
  localFinished = $derived.by(
    () => this.phase === "racing" && this.kartHasFinished(this.localKart),
  );

  /** How many karts are still racing (not yet across the final line). */
  remainingRacers = $derived.by(
    () => this.kartList.filter((k) => !this.kartHasFinished(k)).length,
  );

  /** The local player's final finishing place (1-based) once finished. */
  localFinishPlace = $derived.by(() => {
    const id = this.localPlayerId;
    if (!id) return 0;
    const place = this.karts[id]?.finishPosition;
    if (place && place > 0) return place;
    const idx = this.positions.indexOf(id);
    return idx >= 0 ? idx + 1 : 0;
  });

  /** True while the local player is on the final lap (uses the room lapCount). */
  isLocalFinalLap = $derived.by(() => {
    const kart = this.localKart;
    if (!kart || this.phase !== "racing" || this.kartHasFinished(kart)) {
      return false;
    }
    // kart.lap is 0-based (lap 0 = "Lap 1/N"); display lap = kart.lap + 1.
    // The final lap is being driven when display lap === lapCount, i.e.
    // kart.lap === lapCount - 1. Crossing the line to kart.lap === lapCount
    // finishes the race.
    return kart.lap >= this.lapCount - 1;
  });

  /**
   * The kart the chase camera should track. Normally the local player, but once
   * they finish early we follow the current race leader so the post-finish view
   * stays on the action instead of freezing on the parked kart.
   */
  cameraTargetKartId = $derived.by(() => {
    if (this.localFinished && this.positions.length > 0) {
      const leader = this.positions.find(
        (id) => !this.kartHasFinished(this.karts[id]),
      );
      if (leader) return leader;
    }
    return this.localPlayerId;
  });

  /**
   * Live standings rows (finish order during the race), ordered by the server's
   * authoritative `positions`. Karts not yet in `positions` (just joined) fall
   * to the end.
   */
  standings = $derived.by(() => {
    const rows = this.positions
      .map((id) => this.karts[id])
      .filter((k): k is KartState => !!k)
      .map((k, i) => ({
        id: k.id,
        place: i + 1,
        name: k.name,
        accentIndex: k.accentIndex,
        lap: k.lap,
        finished: this.kartHasFinished(k),
        isLocal: k.id === this.localPlayerId,
        isBot: k.isBot ?? false,
      }));
    // Karts absent from positions (e.g. mid-join) tacked on at the back.
    for (const k of this.kartList) {
      if (!this.positions.includes(k.id)) {
        rows.push({
          id: k.id,
          place: rows.length + 1,
          name: k.name,
          accentIndex: k.accentIndex,
          lap: k.lap,
          finished: this.kartHasFinished(k),
          isLocal: k.id === this.localPlayerId,
          isBot: k.isBot ?? false,
        });
      }
    }
    return rows;
  });

  // ---------------------------------------------------------------------------
  // Mutators
  // ---------------------------------------------------------------------------

  /** Shared m:ss.cc time formatter (centisecond precision). */
  static formatRaceTime(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) ms = 0;
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    const centis = Math.floor((ms % 1000) / 10);
    return `${min}:${sec.toString().padStart(2, "0")}.${centis
      .toString()
      .padStart(2, "0")}`;
  }

  initFromJoinState(result: RaceJoinStateResult): void {
    const { state, playerId } = result;
    this.roomId = state.id;
    this.roomName = state.name;
    this.trackId = state.trackId;
    this.mode = state.mode ?? DEFAULT_RACE_MODE;
    this.lapCount = state.lapCount ?? RACE_LAP_COUNT;
    this.itemsEnabled = state.itemsEnabled ?? true;
    this.botsEnabled = state.botsEnabled ?? true;
    this.phase = state.phase;
    this.localPlayerId = playerId;
    this.raceTimer = state.raceTimer;
    this.positions = [...state.positions];
    this.finishedCount = state.finishedCount;
    this.isSpectator = result.isSpectator ?? false;
    this.readyPlayers = { ...(state.readyPlayers ?? {}) };
    this.rematchVotes = { ...(state.rematchVotes ?? {}) };
    this.raceStats = { ...(state.stats ?? {}) };

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
    const now = performance.now();

    // Karts — deep mutation (upserting unknown ids: snapshots carry identity
    // fields so a missed kartJoined can no longer leave an invisible racer)
    for (const [id, data] of Object.entries(snapshot.karts)) {
      const kart = this.karts[id];
      if (!kart) {
        this.karts[id] = {
          id,
          name: data.name ?? "Racer",
          carId: coerceRaceCarId(data.carId),
          accentIndex: data.accentIndex ?? 0,
          isBot: data.isBot ?? false,
          position: { ...data.position },
          heading: data.heading,
          speed: data.speed,
          velocity: data.velocity ? { ...data.velocity } : vec3Zero(),
          driftState: data.driftState
            ? { ...data.driftState }
            : defaultDriftState(),
          lap: data.lap,
          checkpoint: data.checkpoint,
          currentItem: data.currentItem,
          itemCharges: data.itemCharges,
          heldItemActive: data.heldItemActive ?? false,
          status: data.status,
          statusTimer: data.statusTimer,
          raceProgress: 0,
          segmentIndex: 0,
          finishTime: null,
          finishPosition: null,
          boostTimer: data.boostTimer,
          boostSpeed: data.boostSpeed,
          slipstreamActive: data.slipstreamActive ?? false,
          slipstreamTicks: 0,
          hitstopTicks: 0,
          rocketStartTier: "none",
          slipAngle: data.slipAngle ?? 0,
          flowMeter: data.flowMeter ?? 0,
          surface: data.surface ?? "asphalt",
          loadFactor: data.loadFactor ?? 1,
        };
        continue;
      }
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
      kart.heldItemActive = data.heldItemActive ?? false;
      kart.lap = data.lap;
      kart.checkpoint = data.checkpoint;
      kart.boostTimer = data.boostTimer;
      kart.boostSpeed = data.boostSpeed;
      kart.slipstreamActive = data.slipstreamActive ?? false;
      kart.slipAngle = data.slipAngle ?? 0;
      kart.flowMeter = data.flowMeter ?? 0;
      kart.surface = data.surface ?? "asphalt";
      kart.loadFactor = data.loadFactor ?? 1;
    }

    // Prune karts absent from snapshot membership (missed kartLeft)
    for (const id of Object.keys(this.karts)) {
      if (!(id in snapshot.karts)) {
        this.removeKart(id);
      }
    }

    // Projectiles — mutate existing entries by id (stable references for
    // components keyed on id), add new ones, drop the departed
    const seenProjectiles = new Set<string>();
    for (const p of snapshot.projectiles) {
      seenProjectiles.add(p.id);
      const existing = this.projectiles.find((e) => e.id === p.id);
      if (existing) {
        existing.position.x = p.position.x;
        existing.position.y = p.position.y;
        existing.position.z = p.position.z;
        existing.velocity.x = p.velocity.x;
        existing.velocity.y = p.velocity.y;
        existing.velocity.z = p.velocity.z;
        existing.targetId = p.targetId;
        existing.bounces = p.bounces;
        existing.age = p.age;
      } else {
        this.projectiles.push({
          ...p,
          position: { ...p.position },
          velocity: { ...p.velocity },
        });
      }
    }
    if (this.projectiles.length !== seenProjectiles.size) {
      this.projectiles = this.projectiles.filter((p) =>
        seenProjectiles.has(p.id),
      );
    }

    // Hazards — same upsert-by-id treatment
    const seenHazards = new Set<string>();
    for (const h of snapshot.hazards) {
      seenHazards.add(h.id);
      const existing = this.hazards.find((e) => e.id === h.id);
      if (existing) {
        existing.position.x = h.position.x;
        existing.position.y = h.position.y;
        existing.position.z = h.position.z;
      } else {
        this.hazards.push({ ...h, position: { ...h.position } });
      }
    }
    if (this.hazards.length !== seenHazards.size) {
      this.hazards = this.hazards.filter((h) => seenHazards.has(h.id));
    }

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

    // Render-behind interpolation buffer (remote karts + projectiles)
    this.pushSnapshotBufferEntry(snapshot, now);

    // Local prediction reconciliation
    const localData = this.localPlayerId
      ? snapshot.karts[this.localPlayerId]
      : undefined;
    if (localData) {
      this.reconcilePrediction(localData, now);
    }

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
    // Spectator promotion: the server hands spectators a kart when slots open
    // on a transition to waiting — a kart with our id means we're racing now.
    if (kart.id === this.localPlayerId && this.isSpectator) {
      this.isSpectator = false;
    }
  }

  removeKart(kartId: string): void {
    delete this.karts[kartId];
    delete this.readyPlayers[kartId];
    delete this.rematchVotes[kartId];
  }

  applyPhaseChanged(data: RacePhaseChangedEvent): void {
    this.phase = data.phase;
    this.raceTimer = data.raceTimer;

    if (data.phase === "waiting" || data.phase === "countdown") {
      // Karts teleport to the grid on these transitions — stale interpolation
      // buffers and predicted state would glide them across the map.
      this.clearNetSmoothing();
      // The grid faces forward again — drop any latched wrong-way warning so it
      // doesn't carry across a rematch/respawn.
      this.clearWrongWay();
      // A fresh attempt resets the ghost gap until the new run produces progress.
      this.ghostDeltaMs = null;
    }

    if (data.phase === "racing") {
      // GO — the current-lap timer counts from raceTimer 0 (server resets it).
      this.resetLapTiming();
    }

    if (data.phase === "waiting") {
      // Entering the lobby loop again (rematch, finish auto-reset, countdown
      // quorum loss): clear the previous race's bookkeeping so the Ready
      // button reappears and stale results stop rendering (rematch softlock).
      this.readyPlayers = {};
      this.rematchVotes = {};
      this.raceStats = {};
      this.countdownNumber = null;
      this.finishedCount = 0;
      this.previousPosition = 0;
      this.positionDelta = 0;
      this.projectiles = [];
      this.hazards = [];
      // Drop any unconsumed one-shot VFX + latched lightning flash so a
      // rematch grid never inherits the previous race's effects.
      this.vfxQueue.length = 0;
      this.lightningFlashAt = 0;
      this.lastHitKartId = null;
      this.resetLapTiming();
      for (const kart of Object.values(this.karts)) {
        kart.finishTime = null;
        kart.finishPosition = null;
      }
    }
  }

  /** Reset per-race local lap-timing telemetry (GO / new race). */
  private resetLapTiming(): void {
    this.lapStartTime = 0;
    this.lastLapSplitMs = 0;
    this.bestLapMs = null;
    this.lastLapSplitLap = 0;
    this.lastLapSplitAt = 0;
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
    const now = performance.now();
    this.lastHitKartId = data.kartId;
    this.lastHitTime = now;

    // Trigger camera shake for local player
    if (data.kartId === this.localPlayerId) {
      this.triggerShake(0.08); // direct hit
    } else {
      this.triggerShake(0.03); // nearby hit
    }

    // One-shot 3D VFX at the victim's position (cosmetic). Lightning gets a
    // taller bolt-colored burst and, when the LOCAL player is the victim, a
    // brief full-screen white flash on top of the shockwave.
    const victim = this.karts[data.kartId];
    if (victim) {
      const isLightning = data.itemType === "lightning";
      this.pushVfx(
        isLightning ? "lightning" : "hit",
        victim.position.x,
        victim.position.y,
        victim.position.z,
        isLightning ? "#cfe8ff" : "#ffe27a",
      );
      if (isLightning && data.kartId === this.localPlayerId) {
        this.lightningFlashAt = now;
      }
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

    // Local-player lap timing: roll the current-lap timer baseline forward and
    // record the split that just closed (server-authoritative lapTime). data.lap
    // is the new lap count, which equals the just-completed lap's display number
    // (lap 0 = "Lap 1/N"; crossing the line to lap N closes display lap N).
    if (data.kartId === this.localPlayerId) {
      this.lapStartTime = data.raceTime;
      const split = data.lapTime ?? 0;
      if (split > 0) {
        this.lastLapSplitMs = split;
        this.lastLapSplitLap = data.lap; // the display lap that just closed
        this.lastLapSplitAt = performance.now();
        if (this.bestLapMs === null || split < this.bestLapMs) {
          this.bestLapMs = split;
        }
      }
    }
  }

  applyRaceFinished(data: RaceFinishedEvent): void {
    this.positions = [...data.positions];
    for (const [id, time] of Object.entries(data.finishTimes)) {
      const kart = this.karts[id];
      if (kart) {
        kart.finishTime = time;
      }
    }
    // finishPosition never reaches clients in snapshots — derive placement
    // from the finish-ordered positions list so the local overlay can render
    // "YOU WIN!" for positions[0].
    data.positions.forEach((id, i) => {
      const kart = this.karts[id];
      if (kart) {
        kart.finishPosition = i + 1;
      }
    });
    this.raceStats = { ...(data.stats ?? {}) };

    // Finish confetti burst at the start/finish line (segment 0 center). Purely
    // cosmetic — the ImpactVfx pool rains instanced colored quads here.
    const segs = getTrack(this.trackId).segments;
    if (segs.length > 0) {
      const c = segs[0].center;
      this.pushVfx("confetti", c.x, c.y, c.z, "#ffffff");
    }
  }

  /** Enqueue a one-shot cosmetic VFX for the ImpactVfx pool to drain. */
  private pushVfx(
    type: VfxType,
    x: number,
    y: number,
    z: number,
    color: string,
  ): void {
    this.vfxQueue.push({ id: this.vfxCounter++, type, x, y, z, t: performance.now(), color });
    // The pool drains every frame; cap the backlog so a paused tab (no render
    // loop draining) can't grow this unbounded.
    if (this.vfxQueue.length > 32) {
      this.vfxQueue.splice(0, this.vfxQueue.length - 32);
    }
  }

  /**
   * Remove and return everything currently queued (called by ImpactVfx each
   * frame). Splicing in place keeps the readonly array reference stable.
   */
  drainVfx(): VfxEvent[] {
    if (this.vfxQueue.length === 0) return EMPTY_VFX;
    return this.vfxQueue.splice(0, this.vfxQueue.length);
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

  /**
   * A defensive item collision (shell vs shell / banana, or a trailed item
   * blocking a shell). Cosmetic: a small spark VFX at the contact point, plus a
   * "Blocked!" toast when the local player's trailed item saved them.
   */
  applyItemDestroyed(data: {
    x: number;
    y: number;
    z: number;
    cause: "shellVsShell" | "shellVsBanana" | "trailBlock";
    defenderId?: string;
  }): void {
    this.pushVfx("hit", data.x, data.y, data.z, "#ffd27a");
    if (data.cause === "trailBlock" && data.defenderId === this.localPlayerId) {
      this.addToast("BLOCKED!", "#44FF88");
    }
  }

  // ---------------------------------------------------------------------------
  // Local-kart prediction (input + sequence plumbing)
  // ---------------------------------------------------------------------------

  /**
   * Latest input intent, recorded every frame by the sender regardless of
   * the wire cadence — the prediction step consumes this at render rate.
   */
  setLocalInput(input: KartInput): void {
    this.localInput = { ...input };
  }

  /**
   * Ring-buffer an input that actually went over the wire (stamped with a
   * seq). Replayed on reconciliation for every seq the server hasn't acked.
   */
  recordSentInput(input: KartInput): void {
    if (typeof input.seq !== "number") return;
    this.pendingInputs.push({
      seq: input.seq,
      input: { ...input },
      sentAt: performance.now(),
    });
    if (this.pendingInputs.length > MAX_PENDING_INPUTS) {
      this.pendingInputs.splice(
        0,
        this.pendingInputs.length - MAX_PENDING_INPUTS,
      );
    }
  }

  /**
   * Step the local kart's predicted physics state by one render frame using
   * the shared stepKart and return the pose to render (predicted + decaying
   * reconciliation offset). Returns null when prediction is inactive (not
   * racing, spectating, or already finished) — callers fall back to the
   * interpolation buffer.
   */
  stepLocalPrediction(delta: number): InterpolatedPose | null {
    const auth = this.localKart;
    if (
      this.phase !== "racing" ||
      this.isSpectator ||
      !auth ||
      auth.finishTime !== null
    ) {
      this.predictedKart = null;
      return null;
    }

    let pred = this.predictedKart;
    if (!pred) {
      // First predicted frame — seed from the authoritative state
      pred = this.predictedKart = {
        ...auth,
        position: { ...auth.position },
        velocity: { ...auth.velocity },
        driftState: { ...auth.driftState },
      };
      this.predictedSim = createKartSimState();
      this.corrX = 0;
      this.corrZ = 0;
      this.corrHeading = 0;
      this.lastAuthoritativeStatus = auth.status;
    }

    const dtTicks =
      (Math.min(delta, 0.05) * 1000) / RACE_SERVER_TICK_INTERVAL;
    if (dtTicks > 0) {
      stepKart(
        pred,
        this.predictedSim,
        this.localInput ?? idleInput(),
        getTrack(this.trackId),
        dtTicks,
        this.trackId,
      );
    }

    // Decay the reconciliation offset (~150ms to settle)
    const decay = Math.exp(-CORRECTION_DECAY_RATE * delta);
    this.corrX *= decay;
    this.corrZ *= decay;
    this.corrHeading *= decay;

    return {
      x: pred.position.x + this.corrX,
      y: pred.position.y,
      z: pred.position.z + this.corrZ,
      heading: pred.heading + this.corrHeading,
      speed: pred.speed,
    };
  }

  /**
   * On each snapshot: rewind the predicted kart to the authoritative state,
   * replay every input the server hasn't processed yet, then fold the
   * divergence between the previously rendered pose and the reconciled pose
   * into a correction offset that decays over ~150ms. Force-snap on large
   * error or on server-driven status changes (spin/fall/respawn).
   */
  private reconcilePrediction(
    data: RaceSnapshot["karts"][string],
    now: number,
  ): void {
    const acked = data.lastProcessedSeq ?? 0;
    this.lastProcessedSeq = acked;
    if (this.pendingInputs.length > 0) {
      this.pendingInputs = this.pendingInputs.filter((p) => p.seq > acked);
    }

    const pred = this.predictedKart;
    if (!pred) {
      this.lastAuthoritativeStatus = data.status;
      return;
    }

    // Rendered pose before reconciliation — the correction keeps it continuous
    const prevX = pred.position.x + this.corrX;
    const prevZ = pred.position.z + this.corrZ;
    const prevHeading = pred.heading + this.corrHeading;
    const statusChanged =
      data.status !== this.lastAuthoritativeStatus &&
      (data.status === "spinning" || data.status === "falling");
    this.lastAuthoritativeStatus = data.status;

    // Rewind to the authoritative kart state...
    pred.position.x = data.position.x;
    pred.position.y = data.position.y;
    pred.position.z = data.position.z;
    pred.heading = data.heading;
    pred.speed = data.speed;
    pred.velocity.x = data.velocity.x;
    pred.velocity.y = data.velocity.y;
    pred.velocity.z = data.velocity.z;
    pred.driftState.active = data.driftState.active;
    pred.driftState.direction = data.driftState.direction;
    pred.driftState.charge = data.driftState.charge;
    pred.driftState.timer = data.driftState.timer;
    pred.status = data.status;
    pred.statusTimer = data.statusTimer;
    pred.boostTimer = data.boostTimer;
    pred.boostSpeed = data.boostSpeed;
    pred.slipstreamActive = data.slipstreamActive ?? false;
    pred.slipAngle = data.slipAngle ?? 0;
    pred.flowMeter = data.flowMeter ?? 0;
    pred.surface = data.surface ?? "asphalt";
    pred.loadFactor = data.loadFactor ?? 1;
    pred.lap = data.lap;
    pred.checkpoint = data.checkpoint;

    // The server-side slipstream charge isn't in snapshots — approximate so
    // the predicted speed cap matches while drafting.
    this.predictedSim.slipstreamBonusTicks = pred.slipstreamActive
      ? SLIPSTREAM_DURATION_TICKS
      : 0;

    // ...then replay the unacked inputs, each over the wall-clock span it
    // was (or still is) the live intent for.
    const track = getTrack(this.trackId);
    const replay = this.pendingInputs.slice(-MAX_REPLAY_INPUTS);
    for (let i = 0; i < replay.length; i++) {
      const cur = replay[i];
      const end = i + 1 < replay.length ? replay[i + 1].sentAt : now;
      const dtMs = Math.min(Math.max(end - cur.sentAt, 0), 100);
      if (dtMs <= 0) continue;
      stepKart(
        pred,
        this.predictedSim,
        cur.input,
        track,
        dtMs / RACE_SERVER_TICK_INTERVAL,
        this.trackId,
      );
    }

    // Fold the divergence into the decaying correction offset
    let corrX = prevX - pred.position.x;
    let corrZ = prevZ - pred.position.z;
    let corrHeading = prevHeading - pred.heading;
    while (corrHeading > Math.PI) corrHeading -= Math.PI * 2;
    while (corrHeading < -Math.PI) corrHeading += Math.PI * 2;

    if (
      statusChanged ||
      corrX * corrX + corrZ * corrZ >
        MAX_CORRECTION_DISTANCE * MAX_CORRECTION_DISTANCE
    ) {
      // Too far off (or a server-driven spin/fall/respawn) — snap
      corrX = 0;
      corrZ = 0;
      corrHeading = 0;
    }
    this.corrX = corrX;
    this.corrZ = corrZ;
    this.corrHeading = corrHeading;
  }

  // ---------------------------------------------------------------------------
  // Render-behind interpolation (remote karts + projectiles)
  // ---------------------------------------------------------------------------

  private pushSnapshotBufferEntry(snapshot: RaceSnapshot, now: number): void {
    const t = snapshot.tick * RACE_SERVER_TICK_INTERVAL;
    const last = this.snapshotBuffer[this.snapshotBuffer.length - 1];
    if (last && t <= last.t) {
      if (t < last.t - 5000) {
        // Server sim clock jumped backwards (actor restart) — start fresh
        // instead of silently rejecting every snapshot forever.
        this.snapshotBuffer = [];
      } else {
        return; // duplicate / out-of-order tick
      }
    }

    const karts: Record<string, BufferedKart> = {};
    for (const [id, k] of Object.entries(snapshot.karts)) {
      karts[id] = {
        x: k.position.x,
        y: k.position.y,
        z: k.position.z,
        heading: k.heading,
        speed: k.speed,
        vx: k.velocity.x,
        vz: k.velocity.z,
      };
    }
    const projectiles: Record<string, BufferedProjectile> = {};
    for (const p of snapshot.projectiles) {
      projectiles[p.id] = {
        x: p.position.x,
        y: p.position.y,
        z: p.position.z,
        vx: p.velocity.x,
        vz: p.velocity.z,
      };
    }
    this.snapshotBuffer.push({ t, recv: now, karts, projectiles });
    if (this.snapshotBuffer.length > SNAPSHOT_BUFFER_SIZE) {
      this.snapshotBuffer.shift();
    }
  }

  /**
   * The server-time instant to render right now: the newest snapshot's time
   * minus the interpolation delay, advanced by the wall-clock elapsed since
   * receipt. Null when the buffer is empty or stale (e.g. the waiting phase
   * has no paced snapshots) — callers fall back to raw store state.
   */
  private renderServerTime(now: number): number | null {
    const latest = this.snapshotBuffer[this.snapshotBuffer.length - 1];
    if (!latest) return null;
    if (now - latest.recv > SNAPSHOT_STALE_MS) return null;
    const rt = latest.t - RACE_INTERP_DELAY_MS + (now - latest.recv);
    return Math.min(rt, latest.t + MAX_EXTRAPOLATION_MS);
  }

  /**
   * Sample a kart's render pose at now − RACE_INTERP_DELAY_MS, interpolating
   * position and shortest-arc heading between bracketing snapshots, with
   * velocity extrapolation capped at MAX_EXTRAPOLATION_MS on gaps.
   */
  sampleKartPose(kartId: string, now: number): InterpolatedPose | null {
    const buf = this.snapshotBuffer;
    const rt = this.renderServerTime(now);
    if (rt === null) return null;

    // Older than everything buffered (fresh buffer) — hold at the oldest
    if (rt < buf[0].t) {
      const k0 = buf[0].karts[kartId];
      return k0
        ? { x: k0.x, y: k0.y, z: k0.z, heading: k0.heading, speed: k0.speed }
        : null;
    }

    for (let i = buf.length - 1; i >= 1; i--) {
      const b = buf[i];
      const a = buf[i - 1];
      if (rt > b.t) break; // beyond the newest pair — extrapolate below
      if (rt < a.t) continue;
      const ka = a.karts[kartId];
      const kb = b.karts[kartId];
      if (!ka || !kb) break; // joined mid-buffer — use the newest sample
      const dx = kb.x - ka.x;
      const dz = kb.z - ka.z;
      if (
        dx * dx + dz * dz >
        INTERP_TELEPORT_DISTANCE * INTERP_TELEPORT_DISTANCE
      ) {
        // Teleport (respawn/lightning/grid reset) — snap, don't glide
        return { x: kb.x, y: kb.y, z: kb.z, heading: kb.heading, speed: kb.speed };
      }
      const f = (rt - a.t) / Math.max(1, b.t - a.t);
      let dh = kb.heading - ka.heading;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      return {
        x: ka.x + dx * f,
        y: ka.y + (kb.y - ka.y) * f,
        z: ka.z + dz * f,
        heading: ka.heading + dh * f,
        speed: ka.speed + (kb.speed - ka.speed) * f,
      };
    }

    // No bracketing pair — extrapolate from the newest sample. Velocity is
    // units-per-16ms-tick, so per-second conversion is ×62.5 (not ×60).
    const latest = buf[buf.length - 1];
    const k = latest.karts[kartId];
    if (!k) return null;
    const extraSec =
      Math.max(0, Math.min(rt - latest.t, MAX_EXTRAPOLATION_MS)) / 1000;
    return {
      x: k.x + k.vx * VELOCITY_PER_SECOND * extraSec,
      y: k.y,
      z: k.z + k.vz * VELOCITY_PER_SECOND * extraSec,
      heading: k.heading,
      speed: k.speed,
    };
  }

  /**
   * Sample a projectile's render position on the same delayed timeline as
   * the karts. Holds at the first buffered sample for projectiles that
   * spawned mid-buffer; null until the projectile is buffered at all
   * (callers fall back to the raw spawn position).
   */
  sampleProjectilePose(
    id: string,
    now: number,
  ): { x: number; y: number; z: number } | null {
    const buf = this.snapshotBuffer;
    const rt = this.renderServerTime(now);
    if (rt === null) return null;

    if (rt < buf[0].t) {
      const p0 = buf[0].projectiles[id];
      return p0 ? { x: p0.x, y: p0.y, z: p0.z } : null;
    }

    for (let i = buf.length - 1; i >= 1; i--) {
      const b = buf[i];
      const a = buf[i - 1];
      if (rt > b.t) break;
      if (rt < a.t) continue;
      const pb = b.projectiles[id];
      if (!pb) break;
      const pa = a.projectiles[id];
      if (!pa) {
        // Spawned between these snapshots — hold at its first known sample
        return { x: pb.x, y: pb.y, z: pb.z };
      }
      const f = (rt - a.t) / Math.max(1, b.t - a.t);
      return {
        x: pa.x + (pb.x - pa.x) * f,
        y: pa.y + (pb.y - pa.y) * f,
        z: pa.z + (pb.z - pa.z) * f,
      };
    }

    const latest = buf[buf.length - 1];
    const p = latest.projectiles[id];
    if (!p) return null;
    const extraSec =
      Math.max(0, Math.min(rt - latest.t, MAX_EXTRAPOLATION_MS)) / 1000;
    return {
      x: p.x + p.vx * VELOCITY_PER_SECOND * extraSec,
      y: p.y,
      z: p.z + p.vz * VELOCITY_PER_SECOND * extraSec,
    };
  }

  /** Drop buffered snapshots + predicted state (phase changes, reset) */
  private clearNetSmoothing(): void {
    this.snapshotBuffer = [];
    this.predictedKart = null;
    this.predictedSim = createKartSimState();
    this.pendingInputs = [];
    this.corrX = 0;
    this.corrZ = 0;
    this.corrHeading = 0;
  }

  // ---------------------------------------------------------------------------
  // Wrong-way detection (client-only, ~10Hz)
  // ---------------------------------------------------------------------------

  /**
   * Recompute whether the local kart is driving against the track direction.
   * Called every render frame from the input loop but self-throttled to ~10Hz
   * (the segment lookup is cheap with a cached hint, but there's no need to run
   * it at full frame rate). Sets `wrongWay` true only after the kart has been
   * facing backwards continuously for WRONG_WAY_SUSTAIN_MS, and clears it the
   * moment the kart is realigned, stopped, spinning/falling, finished, or the
   * race isn't running.
   */
  updateWrongWay(now: number): void {
    if (now < this.wrongWayNextEvalAt) return;
    this.wrongWayNextEvalAt = now + WRONG_WAY_INTERVAL_MS;

    const kart = this.localKart;
    // Only meaningful while actively racing on our own kart.
    if (
      this.phase !== "racing" ||
      this.isSpectator ||
      !kart ||
      this.kartHasFinished(kart) ||
      kart.status === "spinning" ||
      kart.status === "falling"
    ) {
      this.wrongWaySince = 0;
      if (this.wrongWay) this.wrongWay = false;
      return;
    }

    // Direction of travel: prefer the velocity vector while moving, fall back
    // to the heading forward (so reversing reads as backwards too — heading
    // doesn't flip when backing up, but velocity does).
    const speed = Math.abs(kart.speed);
    let dirX: number;
    let dirZ: number;
    const vx = kart.velocity.x;
    const vz = kart.velocity.z;
    const vMag = Math.hypot(vx, vz);
    if (vMag > 0.05) {
      dirX = vx / vMag;
      dirZ = vz / vMag;
    } else if (speed > WRONG_WAY_MIN_SPEED) {
      dirX = Math.sin(kart.heading);
      dirZ = Math.cos(kart.heading);
    } else {
      // Essentially stationary — not going the wrong way.
      this.wrongWaySince = 0;
      if (this.wrongWay) this.wrongWay = false;
      return;
    }

    const track = getTrack(this.trackId);
    const segs = track.segments;
    if (segs.length === 0) {
      this.wrongWaySince = 0;
      if (this.wrongWay) this.wrongWay = false;
      return;
    }
    const segIdx = findNearestSegment(
      segs,
      kart.position.x,
      kart.position.z,
      this.wrongWaySegHint,
    );
    this.wrongWaySegHint = segIdx;
    const fwd = segs[segIdx].forward;

    const dot = dirX * fwd.x + dirZ * fwd.z;
    const facingBackwards = dot < WRONG_WAY_DOT_THRESHOLD;

    if (facingBackwards) {
      if (this.wrongWaySince === 0) {
        this.wrongWaySince = now;
      } else if (now - this.wrongWaySince >= WRONG_WAY_SUSTAIN_MS) {
        if (!this.wrongWay) this.wrongWay = true;
      }
    } else {
      this.wrongWaySince = 0;
      if (this.wrongWay) this.wrongWay = false;
    }
  }

  /** Clear the wrong-way warning + its sustain timer (phase change / reset). */
  private clearWrongWay(): void {
    this.wrongWay = false;
    this.wrongWaySince = 0;
    this.wrongWayNextEvalAt = 0;
    this.wrongWaySegHint = 0;
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
    // A roulette may still be spinning (rapid box pickups / reset) — never
    // leak the previous interval.
    if (this.rouletteInterval !== null) {
      clearInterval(this.rouletteInterval);
      this.rouletteInterval = null;
    }
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
    this.rouletteInterval = setInterval(() => {
      this.rollingItem = items[Math.floor(Math.random() * items.length)];
      cycles++;
      if (cycles >= maxCycles) {
        if (this.rouletteInterval !== null) {
          clearInterval(this.rouletteInterval);
          this.rouletteInterval = null;
        }
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
    if (this.rouletteInterval !== null) {
      clearInterval(this.rouletteInterval);
      this.rouletteInterval = null;
    }
    this.clearNetSmoothing();
    this.localInput = null;
    this.lastProcessedSeq = 0;
    this.lastAuthoritativeStatus = "normal";
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
    this.trackId = "track1";
    this.mode = DEFAULT_RACE_MODE;
    this.lapCount = RACE_LAP_COUNT;
    this.itemsEnabled = true;
    this.botsEnabled = true;
    this.finishedCount = 0;
    this.ghostActive = false;
    this.ghostDeltaMs = null;
    this.ghostTimeline = null;
    this.lastHitKartId = null;
    this.lastHitTime = 0;
    this.vfxQueue.length = 0;
    this.lightningFlashAt = 0;
    this.lastLapKartId = null;
    this.lastLapNumber = 0;
    this.lastLapTime = 0;
    this.resetLapTiming();
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
    this.clearWrongWay();
  }
}
