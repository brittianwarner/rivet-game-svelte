/**
 * CPU bot driver — pure, server-side path-following AI.
 *
 * `computeBotInput` turns a bot kart's current state + the track geometry into
 * a KartInput. The actor feeds that input into the SAME shared `stepKart` every
 * human kart uses (no parallel physics fork) so bots obey identical handling,
 * surfaces, drift, boost and collisions.
 *
 * The driver is intentionally stateless across ticks except for the tiny
 * `BotSimState` the caller owns (drift bookkeeping + item-use timer). All the
 * geometry it needs comes from the kart + the track definition.
 */

import {
  KART_MAX_SPEED,
  MIN_DRIFT_SPEED,
  type ItemType,
  type KartInput,
  type KartState,
  type TrackDefinition,
  type Vec3,
} from "./types.js";
import { getCarStats } from "./car-catalog.js";
import { findNearestSegment } from "./track.js";

// ---------------------------------------------------------------------------
// Per-bot persistent bookkeeping (owned by the actor, one per bot kart)
// ---------------------------------------------------------------------------

export interface BotSimState {
  /** Stable 0..1 personality seed derived from the bot's id */
  seed: number;
  /** Look-ahead distance bias (segments) — jittered per bot */
  lookaheadBias: number;
  /** How eager this bot is to fire items / hold a tight line (0..1) */
  aggression: number;
  /** Server tick at which this bot may next use its held item */
  nextItemTick: number;
  /** True while the bot is mid-drift (mirrors kart.driftState but read-ahead) */
  wantsDrift: boolean;
}

/** Deterministic 0..1 hash from a string id so a bot's personality is stable. */
function hashSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // map to 0..1
  return ((h >>> 0) % 100000) / 100000;
}

export function createBotSimState(id: string): BotSimState {
  const seed = hashSeed(id);
  return {
    seed,
    // ±2.5 segments of look-ahead variety so bots don't drive an identical line
    lookaheadBias: (seed - 0.5) * 5,
    // 0.5..1.0 aggression
    aggression: 0.5 + seed * 0.5,
    nextItemTick: 0,
    wantsDrift: false,
  };
}

// ---------------------------------------------------------------------------
// Context the actor passes in (cheap, recomputed per tick)
// ---------------------------------------------------------------------------

export interface BotContext {
  /** Current server tick (drives the randomized item-use timer) */
  tick: number;
  /**
   * Effective top-speed fraction the bot should hold, already including the
   * difficulty base + rubber-band (e.g. 0.88 easy → ~1.0 catching up). The bot
   * gates its throttle to keep within this fraction of its OWN car top speed.
   */
  speedMult: number;
  /**
   * The id of a kart this bot can target with an offensive item (next kart
   * ahead in race order), or null. Used to gate shell firing.
   */
  targetAheadId: string | null;
  /** Whether this bot currently leads the race (drop bananas instead of firing) */
  isLeading: boolean;
  /**
   * Per-segment mesh-snapped racing line (one Vec3 per track segment), or null
   * for tracks whose centerline IS the road (neon-circuit / the browser, which
   * has no surface sampler). When present, the bot aims at and recenters toward
   * this line instead of the raw segment center — the centers on a baked-mesh
   * track (track1) diverge from the drivable surface by up to ~130 units, so
   * aiming at them drives every bot off-road. See track-racing-line.ts.
   */
  racingLine: Vec3[] | null;
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Base look-ahead in segments; scaled up with speed so fast bots plan earlier. */
const LOOKAHEAD_BASE = 8;
const LOOKAHEAD_SPEED_GAIN = 6;
/** Segments ahead sampled to estimate upcoming curvature (braking + drift). */
const CURVATURE_LOOKAHEAD = 15;
/**
 * Window (segments) over which the bot ACCUMULATES |heading change| to detect a
 * long sustained sweeper. A neon sweeper has only moderate per-15-seg curvature
 * (below BRAKE/DRIFT thresholds) but bends continuously over many segments — the
 * single-window probe never sees it, so the bot carries too much speed and
 * washes onto the shoulder. Summing the turn over this longer (~36-seg) window
 * surfaces the sweeper as effective curvature so the bot eases/brakes/drifts
 * before the shoulder. Sampled every CURVATURE_STEP segments.
 */
const CURVATURE_WINDOW = 36;
const CURVATURE_STEP = 4;
/** Curvature (radians of forward-vector turn) above which the bot brakes. */
const BRAKE_CURVATURE = 0.7;
/** Sustained curvature above which the bot initiates a drift. */
const DRIFT_CURVATURE = 0.5;
/**
 * Lateral re-centering gain — steer back toward the racing line off-center.
 * Raised from 0.04 to 0.08 so the lateral correction bites BEFORE a long sweeper
 * can carry the bot out to the shoulder (the old gain let drift build up first).
 */
const RECENTER_GAIN = 0.08;

const OFFENSIVE_ITEMS = new Set<ItemType>([
  "greenShell",
  "redShell",
  "blueShell",
]);

/** Signed angle (radians, [-π,π]) to rotate `from` heading toward `to` heading. */
function angleDelta(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Heading (in the kart's atan2(forward.x, forward.z) convention) of a 2D dir. */
function dirHeading(dx: number, dz: number): number {
  return Math.atan2(dx, dz);
}

/**
 * Compute one tick of input for a CPU kart. Pure: reads the kart + track + the
 * cheap per-tick context, writes nothing. The caller folds the returned input
 * into the shared `stepKart`.
 */
export function computeBotInput(
  kart: KartState,
  bot: BotSimState,
  track: TrackDefinition,
  ctx: BotContext,
): { input: KartInput; useItem: boolean } {
  const segments = track.segments;
  const n = segments.length;

  // Nearest segment, using the kart's cached hint so this stays O(window).
  const segIdx = findNearestSegment(
    segments,
    kart.position.x,
    kart.position.z,
    kart.segmentIndex,
  );

  // The aim/recenter target for a segment: the mesh-snapped racing line when one
  // is supplied (track1, where the authored centers sit off the drivable mesh),
  // else the plain segment center (neon-circuit, where the centerline IS the
  // road). Aiming at the centerline on track1 drives every bot off-mesh, where
  // stepKart's mesh on-road test flips it to "falling" — see track-racing-line.ts.
  const aimPointFor = (idx: number): Vec3 => {
    const line = ctx.racingLine;
    const wrapped = ((idx % n) + n) % n;
    return line ? line[wrapped] : segments[wrapped].center;
  };

  // --- Look-ahead target: a racing-line point several segments down the track,
  //     scaled by speed so faster bots aim further ahead. ---
  const speedFrac = Math.min(1, Math.abs(kart.speed) / KART_MAX_SPEED);
  const lookahead = Math.max(
    3,
    Math.round(
      LOOKAHEAD_BASE + LOOKAHEAD_SPEED_GAIN * speedFrac + bot.lookaheadBias,
    ),
  );
  const aheadPoint = aimPointFor(segIdx + lookahead);

  // Direction from the kart to the look-ahead point.
  const toX = aheadPoint.x - kart.position.x;
  const toZ = aheadPoint.z - kart.position.z;
  const targetHeading = dirHeading(toX, toZ);

  // Re-center toward the racing line: measure how far the kart sits off the line
  // at its current segment (projected onto the segment normal — positive lateral
  // = right of the line → steer left).
  const linePoint = aimPointFor(segIdx);
  const segNormal = segments[segIdx].normal;
  const lateral =
    (kart.position.x - linePoint.x) * segNormal.x +
    (kart.position.z - linePoint.z) * segNormal.z;

  // Signed steer toward the look-ahead heading. heading update is `h -= steer`,
  // so to rotate heading toward target (positive delta) we need NEGATIVE steer.
  const headingErr = angleDelta(kart.heading, targetHeading);
  let steering = -headingErr / (Math.PI * 0.5); // normalize ~90° → full lock
  // Lateral correction nudges the bot back onto the line.
  steering += -lateral * RECENTER_GAIN;
  steering = Math.max(-1, Math.min(1, steering));

  // --- Upcoming curvature: drives braking + drift decisions. We combine two
  //     estimates and take the larger so BOTH sharp corners AND long sustained
  //     sweepers are caught:
  //       (a) single-window: forward-vector turn over the next CURVATURE_LOOKAHEAD
  //           segments — sensitive to a sharp bend right ahead.
  //       (b) cumulative: the SUM of |per-step heading change| over the next
  //           CURVATURE_WINDOW segments — a long neon sweeper bends only a little
  //           per 15 segments (so (a) stays under the thresholds) but a lot over
  //           ~28, which is what makes the bot wash wide. Summing absolute turn
  //           surfaces it as effective curvature so easing/braking/drift trigger.
  const curSeg = segments[segIdx];
  const farSeg = segments[(segIdx + CURVATURE_LOOKAHEAD) % n];
  const singleCurvature = Math.abs(
    angleDelta(
      dirHeading(curSeg.forward.x, curSeg.forward.z),
      dirHeading(farSeg.forward.x, farSeg.forward.z),
    ),
  );
  let cumulativeCurvature = 0;
  for (let s = 0; s < CURVATURE_WINDOW; s += CURVATURE_STEP) {
    const a = segments[(segIdx + s) % n];
    const b = segments[(segIdx + s + CURVATURE_STEP) % n];
    cumulativeCurvature += Math.abs(
      angleDelta(
        dirHeading(a.forward.x, a.forward.z),
        dirHeading(b.forward.x, b.forward.z),
      ),
    );
  }
  // Effective curvature for the corner-handling logic below.
  const curvature = Math.max(singleCurvature, cumulativeCurvature);

  // --- Throttle: hold the difficulty/rubber-band-scaled fraction of THIS
  //     car's top speed. Gating throttle (rather than an external speed cap)
  //     keeps the bot inside the shared stepKart with no physics fork. ---
  const carMax = KART_MAX_SPEED * getCarStats(kart.carId).maxSpeedMult;
  const targetSpeed = carMax * ctx.speedMult;
  let throttle = true;
  let brake = false;

  if (kart.speed > targetSpeed * 1.02) {
    // At/above the bot's target pace — ease off so it doesn't redline past tier.
    throttle = false;
  }

  // Brake into sharp corners when carrying too much speed for the bend.
  if (curvature > BRAKE_CURVATURE && kart.speed > carMax * 0.55) {
    throttle = false;
    brake = true;
  }

  // --- Drift: engage through sustained corners, release on straightening so
  //     the shared stepKart awards the drift boost. ---
  const sharpSteer = Math.abs(steering) > 0.35;
  if (
    !kart.driftState.active &&
    curvature > DRIFT_CURVATURE &&
    sharpSteer &&
    Math.abs(kart.speed) > MIN_DRIFT_SPEED * 1.2
  ) {
    bot.wantsDrift = true;
  } else if (kart.driftState.active) {
    // Release once the corner straightens out (and we have at least tier 1, so
    // stepKart's release-grace converts the charge into a boost).
    if (curvature < DRIFT_CURVATURE * 0.6 || !sharpSteer) {
      if (kart.driftState.charge >= 1 || curvature < DRIFT_CURVATURE * 0.3) {
        bot.wantsDrift = false;
      }
    }
  }
  // A drift needs a held steer past stepKart's 0.3 threshold to *start*.
  if (bot.wantsDrift && Math.abs(steering) < 0.34) {
    steering = Math.sign(steering || (lateral < 0 ? 1 : -1)) * 0.34;
  }

  // --- Item use: randomized cooldown, gated by tactical sense. ---
  let useItem = false;
  if (kart.currentItem && ctx.tick >= bot.nextItemTick) {
    if (shouldUseItem(kart.currentItem, ctx)) {
      useItem = true;
      // Next window: 1.5–4s (≈ 94–250 ticks at 16ms), tighter for aggressive bots.
      const min = 94;
      const span = 156 * (1.2 - bot.aggression * 0.4);
      bot.nextItemTick = ctx.tick + Math.round(min + Math.random() * span);
    }
  }

  return {
    input: {
      steering,
      throttle,
      brake,
      drift: bot.wantsDrift,
      useItem: false, // item use flows through the actor's executeItemUse path
    },
    useItem,
  };
}

/**
 * Tactical gate for firing the held item:
 *  - offensive shells: only when there's a target ahead (or the bot is not
 *    leading, so a green shell at least pressures the pack),
 *  - banana: drop when leading (defensive trap behind),
 *  - everything else (mushroom/star/lightning/tri): use opportunistically.
 */
function shouldUseItem(item: ItemType, ctx: BotContext): boolean {
  if (OFFENSIVE_ITEMS.has(item)) {
    // Red/blue home; green is still useful as a forward poke. Require a target
    // for red/blue, allow green whenever not leading or a target exists.
    if (item === "redShell" || item === "blueShell") {
      return ctx.targetAheadId !== null;
    }
    return ctx.targetAheadId !== null || !ctx.isLeading;
  }
  if (item === "banana") {
    // Best as a rear trap when ahead of the pack; still fine to drop otherwise.
    return true;
  }
  // mushroom / triMushroom / star / lightning — use freely.
  return true;
}
