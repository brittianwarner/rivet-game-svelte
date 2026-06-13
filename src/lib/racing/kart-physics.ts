/**
 * Shared kart physics — the single per-kart simulation step used by BOTH the
 * server actor (authoritative ~60Hz sim) and the client (local-kart
 * prediction + snapshot reconciliation replay).
 *
 * Extracted verbatim from the actor's kartPhysicsTick so server and client
 * integrate identically. Keep this module free of server-only concerns
 * (broadcasts, stats, item grants): stepKart mutates the kart + per-kart sim
 * state and reports what happened via StepKartEvents so the caller can
 * broadcast / track stats as needed.
 *
 * dt is measured in server ticks (elapsedMs / RACE_SERVER_TICK_INTERVAL).
 */

import {
  BANKING_GRIP_BONUS,
  BOOST_PAD_DURATION,
  BOOST_PAD_SPEED,
  COMPRESSION_GRIP_GAIN,
  COUNTER_STEER_BONUS,
  COUNTER_STEER_WINDOW_TICKS,
  CREST_GRIP_LOSS,
  DRIFT_BOOST_DURATIONS,
  DRIFT_BOOST_SPEEDS,
  DRIFT_CHARGE_THRESHOLDS,
  DRIFT_SLIP_FLOOR,
  DRIFT_TURN_MULTIPLIER,
  DUST_CARRYOVER_GRIP_PENALTY,
  DUST_CARRYOVER_TICKS,
  FLOW_BOOST_EXTEND_MULT,
  FLOW_DECAY_OFF_ROAD,
  FLOW_DECAY_ON_HIT,
  FLOW_DECAY_PER_TICK,
  FLOW_GAIN_BOOST_PAD,
  FLOW_GAIN_CLEAN_CORNER,
  FLOW_GAIN_DRIFT_RELEASE,
  FLOW_MAX,
  FLOW_SPEED_BONUS,
  FLOW_TURN_BONUS,
  GRIP_LOSS_AT_MAX_SLIP,
  HIT_IMMUNITY_TICKS,
  KART_ACCELERATION,
  KART_BRAKE_FORCE,
  KART_DRAG,
  KART_MAX_SPEED,
  KART_REVERSE_ACCEL,
  KART_REVERSE_MAX,
  KART_TURN_RATE,
  LANDING_CLEAN_BONUS,
  LANDING_SCRUB_PENALTY,
  LANDING_SCRUB_THRESHOLD,
  LATERAL_PUSH_STRENGTH,
  MIN_DRIFT_SPEED,
  OFF_ROAD_SPEED_MULT,
  OUT_OF_BOUNDS_BOUNDARY,
  RACE_SERVER_TICK_INTERVAL,
  ROCKET_START_STALL_MAX_SPEED,
  SHRUNK_SPEED_PENALTY,
  SLIP_ANGLE_BUILDUP,
  SLIP_ANGLE_MAX,
  SLIP_ANGLE_RECOVERY,
  SLIPSTREAM_BONUS,
  SLIPSTREAM_DECAY_TICKS,
  SNAP_STEERING_FRAMES,
  SNAP_STEERING_MULT,
  SPIN_DURATION,
  SURFACE_DRAG,
  SURFACE_DRIFT_CHARGE_MULT,
  SURFACE_GRIP,
  TURN_CURVE_EXPONENT,
  TURN_HIGH_SPEED_REDUCTION,
  WALL_SCRUB_ANGLE_THRESHOLD,
  WALL_SCRUB_SPEED_LOSS,
  plainVec3,
  type DriftCharge,
  type DriftDirection,
  type DriftState,
  type KartInput,
  type KartState,
  type SurfaceType,
  type TrackDefinition,
  type TrackId,
} from "./types.js";
import {
  findNearestSegment,
  getLateralOffset,
  getRespawnPosition,
  getSurfaceSampler,
  isInBoostZone,
} from "./track.js";
import { getMeshRacingLine } from "./track-racing-line.js";
import { getCarStats } from "./car-catalog.js";

// ---------------------------------------------------------------------------
// Per-kart simulation state
// ---------------------------------------------------------------------------

/**
 * The sim-only bookkeeping the physics step needs alongside the KartState.
 * On the server this lives on the connection state (ConnState extends it);
 * on the client the prediction path keeps one instance for the local kart.
 */
export interface KartSimState {
  // Improved turn curve — counter-steer detection
  lastSteerDirection: number;
  counterSteerTicks: number;
  // Snap steering
  steerInputTicks: number;
  prevSteerSign: number;
  // Slipstream speed bonus (charged by the server's slipstreamTick)
  slipstreamBonusTicks: number;
  // Hit immunity
  immunityTicks: number;
  // Drift release grace
  driftReleaseGraceTicks: number;
  driftReleaseGraceCharge: DriftCharge;
  // Hitstop pending data
  hitstopPendingSpeed: number;
  hitstopPendingDrift: boolean;
  // Surface / grip-budget
  dustCarryoverTicks: number;
  prevElevation: number;
  airborne: boolean;
  // Boost pad latch — flow is granted once per pad entry, not per tick
  inBoostZone: boolean;
}

export function createKartSimState(): KartSimState {
  return {
    lastSteerDirection: 0,
    counterSteerTicks: 0,
    steerInputTicks: 0,
    prevSteerSign: 0,
    slipstreamBonusTicks: 0,
    immunityTicks: 0,
    driftReleaseGraceTicks: 0,
    driftReleaseGraceCharge: 0,
    hitstopPendingSpeed: 0,
    hitstopPendingDrift: false,
    dustCarryoverTicks: 0,
    prevElevation: 0,
    airborne: false,
    inBoostZone: false,
  };
}

/**
 * Server-only outcomes of a step the caller may want to broadcast or fold
 * into stats. The client prediction path ignores these.
 */
export interface StepKartEvents {
  /** Drift charge tier newly reached this step (for driftTierReached) */
  driftTierUp: DriftCharge | null;
  /** A charged drift boost was released this step (for the driftBoosts stat) */
  driftBoostReleased: boolean;
  /** |speed| sampled right after the speed cap (for the topSpeed stat) */
  topSpeedSample: number | null;
}

function defaultDrift(): DriftState {
  return { active: false, direction: 0, charge: 0, timer: 0 };
}

/** Compute slipstream speed bonus for a kart (full, then linear decay) */
function getSlipstreamBonus(sim: KartSimState): number {
  if (sim.slipstreamBonusTicks <= 0) return 0;

  // Full bonus for most of the duration, decay in last SLIPSTREAM_DECAY_TICKS
  if (sim.slipstreamBonusTicks > SLIPSTREAM_DECAY_TICKS) {
    return SLIPSTREAM_BONUS;
  }
  // Linear decay
  return SLIPSTREAM_BONUS * (sim.slipstreamBonusTicks / SLIPSTREAM_DECAY_TICKS);
}

// ---------------------------------------------------------------------------
// The shared per-kart physics step
// ---------------------------------------------------------------------------

export function stepKart(
  kart: KartState,
  sim: KartSimState,
  input: KartInput,
  track: TrackDefinition,
  dt: number,
  trackId: TrackId,
): StepKartEvents {
  const events: StepKartEvents = {
    driftTierUp: null,
    driftBoostReleased: false,
    topSpeedSample: null,
  };
  const segments = track.segments;

  // Already finished — freeze kart
  if (kart.finishTime !== null) return events;

  // --- Hitstop: freeze kart for N ticks on impact ---
  if (kart.hitstopTicks > 0) {
    kart.hitstopTicks--;
    if (kart.hitstopTicks <= 0) {
      // Hitstop expired — now apply the spin/knockback
      kart.status = "spinning";
      kart.statusTimer = SPIN_DURATION;
      kart.speed *= sim.hitstopPendingSpeed;
      if (sim.hitstopPendingDrift) {
        kart.driftState = defaultDrift();
      }
      sim.hitstopPendingSpeed = 0;
      sim.hitstopPendingDrift = false;
    }
    // Skip all physics while in hitstop
    return events;
  }

  // --- Hit immunity tick ---
  if (sim.immunityTicks > 0) {
    sim.immunityTicks--;
  }

  // --- Status effect handling ---
  if (kart.status === "spinning" || kart.status === "falling") {
    kart.statusTimer -= dt * RACE_SERVER_TICK_INTERVAL;
    kart.speed *= Math.pow(0.92, dt); // Rapid deceleration while spinning
    if (kart.statusTimer <= 0) {
      // Respawn if falling, otherwise just recover
      if (kart.status === "falling") {
        const segIdx = findNearestSegment(
          segments,
          kart.position.x,
          kart.position.z,
          kart.segmentIndex,
        );
        // On track1 (server) snap the respawn onto the mesh racing line so the
        // kart lands on the drivable surface, not the off-mesh segment center.
        // Null on the client / neon-circuit → seg.center fallback.
        const respawn = getRespawnPosition(
          segments,
          segIdx,
          getMeshRacingLine(trackId, track),
        );
        kart.position = plainVec3(respawn.position);
        kart.heading = respawn.heading;
        kart.speed = 0;
        kart.segmentIndex = segIdx;
      }
      kart.status = "normal";
      kart.statusTimer = 0;
      // Grant hit immunity after recovering from spin
      sim.immunityTicks = HIT_IMMUNITY_TICKS;
    }
    // Update velocity for snapshot
    kart.velocity = {
      x: Math.sin(kart.heading) * kart.speed,
      y: 0,
      z: Math.cos(kart.heading) * kart.speed,
    };
    return events;
  }

  // --- Starred timer ---
  if (kart.status === "starred") {
    kart.statusTimer -= dt * RACE_SERVER_TICK_INTERVAL;
    if (kart.statusTimer <= 0) {
      kart.status = "normal";
      kart.statusTimer = 0;
    }
  }

  // --- Shrunk timer ---
  if (kart.status === "shrunk") {
    kart.statusTimer -= dt * RACE_SERVER_TICK_INTERVAL;
    if (kart.statusTimer <= 0) {
      kart.status = "normal";
      kart.statusTimer = 0;
    }
  }

  // --- Per-car handling archetype ---
  // Looked up once per step; folded into top speed, acceleration, turn rate
  // and drift-charge gain below. Falls back to neutral 1.0 multipliers for
  // unknown car ids (client prediction shares this exact lookup).
  const carStats = getCarStats(kart.carId);
  // The car's effective top speed. Used both as the speed cap base AND as the
  // normalizer for the turn curve / slip buildup, so handling feel stays
  // self-consistent (a faster car corners at the same fraction of its own top
  // speed, not the global base).
  const carMaxSpeed = KART_MAX_SPEED * carStats.maxSpeedMult;

  // --- Acceleration / Braking ---
  const shrunkMult = kart.status === "shrunk" ? SHRUNK_SPEED_PENALTY : 1.0;

  // Rocket start stall penalty: cap speed during stall
  const isStalling = kart.rocketStartTier === "stall" && kart.boostTimer > 0;

  if (input.throttle) {
    kart.speed += KART_ACCELERATION * carStats.accelMult * dt * shrunkMult;
  }

  if (input.brake) {
    if (kart.speed > 0) {
      // Braking (only when not drifting)
      if (!kart.driftState.active) {
        kart.speed -= KART_BRAKE_FORCE * dt;
        if (kart.speed < 0) kart.speed = 0;
      }
    } else {
      // Reverse
      kart.speed -= KART_REVERSE_ACCEL * dt;
    }
  }

  // --- Surface check & classification ---
  // kart.segmentIndex still holds last tick's segment here; it is the search
  // hint and is re-cached below for checkpointTick/respawn to reuse.
  const segIdx = findNearestSegment(segments, kart.position.x, kart.position.z, kart.segmentIndex);
  const seg = segments[segIdx];
  const hw = Math.sqrt(
    (seg.right.x - seg.left.x) ** 2 + (seg.right.z - seg.left.z) ** 2,
  ) / 2;
  const lateralDist = Math.abs(getLateralOffset(segments, segIdx, kart.position.x, kart.position.z));
  const onRoadHw = hw * 1.3;
  // The road-mesh sampler is registered only on the server (track1). The client
  // and non-track1 tracks fall back to the centerline lateral test below.
  const sampler = getSurfaceSampler(trackId);
  const useMesh = sampler !== null;
  const meshRoadDistance = useMesh
    ? sampler.sampleRoadDistance(kart.position.x, kart.position.z)
    : 0;
  const onRoad = useMesh
    ? meshRoadDistance <= 4
    : lateralDist <= onRoadHw;

  let surface: SurfaceType = "asphalt";
  if (!onRoad) {
    const outOfBounds = useMesh
      ? meshRoadDistance > 120
      : lateralDist > onRoadHw * OUT_OF_BOUNDS_BOUNDARY;
    if (outOfBounds) {
      kart.status = "falling";
      kart.statusTimer = SPIN_DURATION;
      kart.speed = 0;
      kart.driftState = defaultDrift();
      kart.flowMeter = Math.max(0, kart.flowMeter - FLOW_DECAY_ON_HIT);
      return events;
    }
    if (useMesh) {
      surface = meshRoadDistance > 40 ? "sand" : "shoulder";
    } else {
      const offRoadRatio = (lateralDist - onRoadHw) / (onRoadHw * (OUT_OF_BOUNDS_BOUNDARY - 1));
      surface = offRoadRatio > 0.6 ? "sand" : "shoulder";
    }
  } else {
    if (useMesh) {
      if (meshRoadDistance > 0 && meshRoadDistance < 10) surface = "rumble";
    } else {
      const edgeProximity = lateralDist / onRoadHw;
      if (edgeProximity > 0.95) surface = "rumble";
    }
  }
  kart.surface = surface;

  const surfaceGrip = SURFACE_GRIP[surface];
  const surfaceDrag = SURFACE_DRAG[surface];
  const surfaceDriftMult = SURFACE_DRIFT_CHARGE_MULT[surface];

  if (sim.dustCarryoverTicks > 0) sim.dustCarryoverTicks--;
  if (surface !== "asphalt" && surface !== "rumble") {
    sim.dustCarryoverTicks = DUST_CARRYOVER_TICKS;
  }
  const dustPenalty = sim.dustCarryoverTicks > 0 ? DUST_CARRYOVER_GRIP_PENALTY : 0;

  // --- Compression / banking / load factor ---
  // Use only adjacent segment for elevation delta to avoid large jumps
  const adjSegIdx = Math.abs(segIdx - kart.segmentIndex) <= 2
    ? kart.segmentIndex
    : (segIdx - 1 + segments.length) % segments.length;
  const prevSeg = segments[adjSegIdx] || seg;
  const elevDelta = seg.center.y - prevSeg.center.y;
  let loadFactor = 1.0;
  // Clamp elevation delta to reasonable range to prevent wild grip swings
  const clampedDelta = Math.max(-2, Math.min(2, elevDelta));
  if (clampedDelta > 0.1) {
    loadFactor = 1.0 + Math.min(clampedDelta * 0.5, COMPRESSION_GRIP_GAIN);
  } else if (clampedDelta < -0.1) {
    loadFactor = 1.0 - Math.min(Math.abs(clampedDelta) * 0.5, CREST_GRIP_LOSS);
  }

  const bankAngle = seg.left.y !== seg.right.y
    ? Math.atan2(Math.abs(seg.left.y - seg.right.y), hw * 2)
    : 0;
  const bankBonus = bankAngle * BANKING_GRIP_BONUS * 10;
  loadFactor = Math.max(0.6, Math.min(1.3, loadFactor + bankBonus));
  kart.loadFactor = loadFactor;

  const wasAirborne = sim.airborne;
  // Steep crests bottom out at loadFactor 0.7 (CREST_GRIP_LOSS), so the
  // airborne threshold sits just above it — sharp drops now go light.
  sim.airborne = loadFactor < 0.75;
  if (wasAirborne && !sim.airborne) {
    if (Math.abs(kart.slipAngle) > LANDING_SCRUB_THRESHOLD) {
      kart.speed *= 1 - LANDING_SCRUB_PENALTY;
    } else {
      kart.speed += LANDING_CLEAN_BONUS;
      kart.flowMeter = Math.min(FLOW_MAX, kart.flowMeter + 0.02);
    }
  }
  kart.segmentIndex = segIdx;
  sim.prevElevation = seg.center.y;

  // --- Effective grip (combines surface, load, dust, flow) ---
  const flowGripBonus = kart.flowMeter * FLOW_TURN_BONUS;
  const effectiveGrip = Math.max(0.2, (surfaceGrip - dustPenalty) * loadFactor + flowGripBonus);

  // --- Drag (surface-aware) ---
  kart.speed *= 1 - KART_DRAG * surfaceDrag * dt;

  // --- Off-road flow decay + wall scrub ---
  if (!onRoad) {
    const offAmount = useMesh
      ? Math.min(1, meshRoadDistance / 40)
      : (lateralDist - onRoadHw) / onRoadHw;
    const offRoadDrag = (1 - OFF_ROAD_SPEED_MULT) * 0.02 * Math.min(1, offAmount) * dt;
    kart.speed *= 1 - offRoadDrag;
    kart.flowMeter = Math.max(0, kart.flowMeter - FLOW_DECAY_OFF_ROAD * 0.5 * dt);

    if (offAmount > 0.5) {
      const headingAlignToNormal = Math.abs(
        Math.sin(kart.heading) * seg.normal.x + Math.cos(kart.heading) * seg.normal.z
      );
      if (headingAlignToNormal > WALL_SCRUB_ANGLE_THRESHOLD) {
        kart.speed *= 1 - WALL_SCRUB_SPEED_LOSS * 0.5;
        kart.slipAngle = Math.min(SLIP_ANGLE_MAX, kart.slipAngle + 0.03);
      }
    }
  }

  // --- Boost zone check (never downgrade a stronger active boost) ---
  if (isInBoostZone(track.boostZones, segIdx)) {
    kart.boostSpeed = Math.max(kart.boostSpeed, BOOST_PAD_SPEED);
    kart.boostTimer = Math.max(kart.boostTimer, BOOST_PAD_DURATION);
    if (!sim.inBoostZone) {
      // Flow is granted once per pad entry, not every tick inside it
      sim.inBoostZone = true;
      kart.flowMeter = Math.min(FLOW_MAX, kart.flowMeter + FLOW_GAIN_BOOST_PAD);
    }
  } else {
    sim.inBoostZone = false;
  }

  // --- Active boost timer (flow extends duration) ---
  if (kart.boostTimer > 0) {
    const boostDecay = dt * RACE_SERVER_TICK_INTERVAL;
    const flowExtend = kart.flowMeter > 0.5 ? FLOW_BOOST_EXTEND_MULT : 1.0;
    kart.boostTimer -= boostDecay / flowExtend;
    if (kart.boostTimer <= 0) {
      kart.boostTimer = 0;
      kart.boostSpeed = 0;
      if (kart.rocketStartTier === "stall") {
        kart.rocketStartTier = "none";
      }
    }
  }

  // --- Speed cap (with flow bonus) ---
  const slipBonus = getSlipstreamBonus(sim);
  const flowSpeedBonus = kart.flowMeter * FLOW_SPEED_BONUS;
  // Off-road surfaces hard-cap top speed — throttle can no longer
  // out-muscle the extra drag, making cuts genuinely slower than the road.
  const surfaceSpeedMult =
    surface === "sand"
      ? OFF_ROAD_SPEED_MULT * 0.8
      : surface === "shoulder"
        ? OFF_ROAD_SPEED_MULT
        : surface === "rumble"
          ? 0.95
          : 1;
  let maxSpeed =
    (carMaxSpeed + kart.boostSpeed + slipBonus + flowSpeedBonus) *
    shrunkMult *
    surfaceSpeedMult;

  if (isStalling) {
    maxSpeed = Math.min(maxSpeed, ROCKET_START_STALL_MAX_SPEED);
  }

  const maxReverse = KART_REVERSE_MAX * shrunkMult;
  if (kart.speed > maxSpeed) kart.speed = maxSpeed;
  if (kart.speed < -maxReverse) kart.speed = -maxReverse;

  events.topSpeedSample = Math.abs(kart.speed);

  // --- Improved Turn Curve (grip-aware) ---
  const speedRatio = Math.abs(kart.speed) / carMaxSpeed;
  let turnRate = KART_TURN_RATE * carStats.turnMult * (1 - TURN_HIGH_SPEED_REDUCTION * Math.pow(speedRatio, TURN_CURVE_EXPONENT));
  turnRate *= effectiveGrip;

  if (kart.driftState.active) {
    turnRate *= DRIFT_TURN_MULTIPLIER;
  }

  // --- Counter-steer bonus (window persists after a direction flip) ---
  const currentSteerDir = input.steering > 0.01 ? 1 : (input.steering < -0.01 ? -1 : 0);
  if (currentSteerDir !== 0 && sim.lastSteerDirection !== 0 && currentSteerDir !== sim.lastSteerDirection) {
    sim.counterSteerTicks = COUNTER_STEER_WINDOW_TICKS;
  }
  if (sim.counterSteerTicks > 0) {
    turnRate *= COUNTER_STEER_BONUS;
    sim.counterSteerTicks--;
  }

  // --- Snap Steering ---
  const prevSign = sim.prevSteerSign;
  if (currentSteerDir !== 0 && (prevSign === 0 || currentSteerDir !== prevSign)) {
    sim.steerInputTicks = 0;
  }

  if (currentSteerDir !== 0 && sim.steerInputTicks < SNAP_STEERING_FRAMES) {
    const snapProgress = sim.steerInputTicks / SNAP_STEERING_FRAMES;
    const snapMult = SNAP_STEERING_MULT + (1.0 - SNAP_STEERING_MULT) * snapProgress;
    turnRate *= snapMult;
    sim.steerInputTicks++;
  } else if (currentSteerDir !== 0) {
    sim.steerInputTicks++;
  }

  sim.prevSteerSign = currentSteerDir;
  if (currentSteerDir !== 0) {
    sim.lastSteerDirection = currentSteerDir;
  }

  const steerAmount = input.steering * turnRate * dt;
  kart.heading -= steerAmount;

  // --- Slip angle / lateral velocity (Grip-Budget) ---
  const steerMagnitude = Math.abs(steerAmount);
  const speedFactor = Math.min(1, Math.abs(kart.speed) / carMaxSpeed);
  const slipBuildup = steerMagnitude * speedFactor * SLIP_ANGLE_BUILDUP * 0.7;
  // Recovery is proportional to the current slip angle, so sustained hard
  // cornering settles at a visible equilibrium (~0.15-0.25 rad) and slip
  // decays exponentially (~200ms time constant) once the wheel straightens.
  const slipRecovery = kart.slipAngle * SLIP_ANGLE_RECOVERY * effectiveGrip * dt;
  const driftFloor = kart.driftState.active ? DRIFT_SLIP_FLOOR : 0;

  kart.slipAngle = Math.max(driftFloor, Math.min(SLIP_ANGLE_MAX,
    kart.slipAngle + slipBuildup - slipRecovery
  ));

  const gripLoss = (kart.slipAngle / SLIP_ANGLE_MAX) * GRIP_LOSS_AT_MAX_SLIP;
  if (kart.slipAngle > 0.15) {
    kart.speed *= 1 - gripLoss * 0.01 * dt;
  }

  // A slide pushes the kart OUTWARD (away from the corner), so the sign is
  // opposite the steering/drift direction.
  const lateralPush = -kart.slipAngle * LATERAL_PUSH_STRENGTH * Math.sign(input.steering || kart.driftState.direction) * kart.speed;

  // --- Flow meter natural decay ---
  kart.flowMeter = Math.max(0, kart.flowMeter - FLOW_DECAY_PER_TICK * dt);

  // --- Flow: clean corner detection (high speed through turn without off-road) ---
  if (onRoad && steerMagnitude > 0.01 && speedRatio > 0.7 && kart.slipAngle < SLIP_ANGLE_MAX * 0.6) {
    kart.flowMeter = Math.min(FLOW_MAX, kart.flowMeter + FLOW_GAIN_CLEAN_CORNER * dt);
  }

  // --- Drift mechanics ---
  const drift = kart.driftState;

  if (
    !drift.active &&
    input.drift &&
    Math.abs(kart.speed) > MIN_DRIFT_SPEED &&
    Math.abs(input.steering) > 0.3
  ) {
    // Start drift
    drift.active = true;
    drift.direction = (input.steering > 0 ? 1 : -1) as DriftDirection;
    drift.charge = 0;
    drift.timer = 0;
    // Reset drift release grace
    sim.driftReleaseGraceTicks = 0;
    sim.driftReleaseGraceCharge = 0;
  }

  if (drift.active) {
    if (input.drift && Math.abs(kart.speed) > MIN_DRIFT_SPEED * 0.5) {
      // Drift specialists charge boost tiers faster (driftChargeMult).
      drift.timer += surfaceDriftMult * carStats.driftChargeMult * dt;

      // Check charge thresholds and report tier events
      const prevCharge = drift.charge;

      if (drift.timer >= DRIFT_CHARGE_THRESHOLDS[2] && drift.charge < 3) {
        drift.charge = 3 as DriftCharge;
      } else if (drift.timer >= DRIFT_CHARGE_THRESHOLDS[1] && drift.charge < 2) {
        drift.charge = 2 as DriftCharge;
      } else if (drift.timer >= DRIFT_CHARGE_THRESHOLDS[0] && drift.charge < 1) {
        drift.charge = 1 as DriftCharge;
      }

      // Report drift tier crossings so the server can broadcast them
      if (drift.charge > prevCharge) {
        events.driftTierUp = drift.charge;
        // Track the latest tier reached (for grace window)
        sim.driftReleaseGraceTicks = 4; // Reset grace ticks on new tier
        sim.driftReleaseGraceCharge = drift.charge;
      } else if (sim.driftReleaseGraceTicks > 0) {
        sim.driftReleaseGraceTicks--;
      }
    } else {
      // Release drift — apply boost based on charge
      let chargeToUse = drift.charge;

      // Drift Release Grace Window: if within 4 ticks of reaching a new tier, grant that tier
      if (sim.driftReleaseGraceTicks > 0 && sim.driftReleaseGraceCharge > drift.charge) {
        chargeToUse = sim.driftReleaseGraceCharge;
      }

      if (chargeToUse > 0) {
        const chargeIdx = (chargeToUse - 1) as 0 | 1 | 2;
        // Never downgrade a stronger boost already in flight
        kart.boostSpeed = Math.max(kart.boostSpeed, DRIFT_BOOST_SPEEDS[chargeIdx]);
        kart.boostTimer = Math.max(kart.boostTimer, DRIFT_BOOST_DURATIONS[chargeIdx]);
        kart.flowMeter = Math.min(FLOW_MAX, kart.flowMeter + FLOW_GAIN_DRIFT_RELEASE * chargeToUse);

        events.driftBoostReleased = true;
      }

      // Reset drift
      drift.active = false;
      drift.direction = 0;
      drift.charge = 0;
      drift.timer = 0;
      sim.driftReleaseGraceTicks = 0;
      sim.driftReleaseGraceCharge = 0;
    }
  }

  // --- Mesh heightfield placement ---
  // Track1 elevation comes from the baked road mesh (server-only sampler) so
  // the kart stays glued to the visible road surface. Tracks with no mesh — and
  // the client prediction path, which has no sampler registered — use the
  // segment centerline Y instead. (Y is overwritten by the authoritative
  // snapshot every 50ms, so the client fallback never visibly drifts.)
  const nextSegIdx = (segIdx + 1) % segments.length;
  const prevSegIdx2 = (segIdx - 1 + segments.length) % segments.length;
  const nextSeg = segments[nextSegIdx];
  const prevSeg2 = segments[prevSegIdx2];
  const meshY = sampler ? sampler.sampleRoadHeight(kart.position.x, kart.position.z) : null;
  const targetY = meshY ?? seg.center.y;

  // --- Position integration (with lateral push from slip angle) ---
  const vx = Math.sin(kart.heading) * kart.speed;
  const vz = Math.cos(kart.heading) * kart.speed;
  const lateralNx = -Math.cos(kart.heading);
  const lateralNz = Math.sin(kart.heading);

  kart.position.x += (vx + lateralNx * lateralPush) * dt;
  kart.position.z += (vz + lateralNz * lateralPush) * dt;

  const desiredY = targetY + 2.5;
  kart.position.y += (desiredY - kart.position.y) * 0.3;

  // --- Slope force (smoothed over 3 segments) ---
  const slopeGradient = (nextSeg.center.y - prevSeg2.center.y) /
    (Math.max(1, segments[nextSegIdx].distance - segments[prevSegIdx2].distance) || 1);
  const headingDirX = Math.sin(kart.heading);
  const headingDirZ = Math.cos(kart.heading);
  const alignment = headingDirX * seg.forward.x + headingDirZ * seg.forward.z;
  const slopeForce = -slopeGradient * 0.015 * alignment * dt;
  kart.speed += slopeForce;

  // --- Update velocity for snapshot interpolation ---
  kart.velocity = { x: vx + lateralNx * lateralPush, y: 0, z: vz + lateralNz * lateralPush };

  return events;
}
