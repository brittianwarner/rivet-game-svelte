/**
 * ghost-recorder — client-only time-trial ghost recording, persistence, and
 * playback. ZERO server involvement: a ghost is a replay of the local kart's
 * own rendered path, sampled at GHOST_SAMPLE_HZ and stored in localStorage,
 * scoped per (trackId, carId) and schema-versioned.
 *
 * Coordinate space: keyframes store the SERVER-authoritative kart pose
 * (store.localKart.position + heading), so playback shares the exact frame the
 * live Kart renders in — GhostKart then applies the same KART_VISUAL_Y_OFFSET
 * the live kart does, sitting the ghost on the road at the same height.
 *
 * Storage layout (per key): metadata JSON + an int16-quantized keyframe blob
 * (x,y,z,heading per sample, plus a uniform dt) base64-encoded. 10Hz int16
 * floats are ~8 bytes/sample → ~5KB per minute, trivially inside the ~5MB
 * localStorage budget even at the 10-minute cap.
 */

import {
  GHOST_SAMPLE_HZ,
  GHOST_MAX_DURATION_MS,
  GHOST_STORAGE_VERSION,
  type TrackId,
  type TrackSegment,
} from "./types.js";
import type { RaceCarId } from "./car-catalog.js";
import { getTrack, findNearestSegment } from "./track.js";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const SAMPLE_INTERVAL_MS = 1000 / GHOST_SAMPLE_HZ; // 100ms
const MAX_SAMPLES = Math.ceil(GHOST_MAX_DURATION_MS / SAMPLE_INTERVAL_MS);
const STORAGE_PREFIX = "rivetKart.ghost.";
/** Quantization extent (world units) — track1/neon both fit inside ±this. */
const QUANT_EXTENT = 4000;
const QUANT_SCALE = 32767 / QUANT_EXTENT;
/** Heading quantized over [-π, π] into the int16 range. */
const HEADING_SCALE = 32767 / Math.PI;

// ---------------------------------------------------------------------------
// Persisted shapes
// ---------------------------------------------------------------------------

/** Per-(track, car) personal-best metadata + the stored ghost path. */
export interface GhostRecord {
  version: number;
  trackId: TrackId;
  carId: RaceCarId;
  /** Total race time of the stored run, ms (the ghost is this run's path). */
  totalMs: number;
  /** Best single-lap split of the stored run, ms (null if unknown). */
  bestLapMs: number | null;
  /** Lap count the run was driven over (so a 3-lap ghost isn't shown on a 5). */
  lapCount: number;
  /** ms between samples (uniform). */
  dtMs: number;
  savedAtISO: string;
  /** base64 of the int16 keyframe blob (x,y,z,heading × sampleCount). */
  blob: string;
}

/** Decoded keyframe stream (Float32) + precomputed per-sample progress. */
export interface GhostTimeline {
  trackId: TrackId;
  carId: RaceCarId;
  dtMs: number;
  totalMs: number;
  bestLapMs: number | null;
  lapCount: number;
  sampleCount: number;
  /** x,y,z,heading interleaved (length = sampleCount × 4). */
  data: Float32Array;
  /**
   * Continuous arc-length progress per sample (lap-aware, monotonic), used to
   * map the local kart's current progress onto the ghost's timeline for the
   * live time delta. Length = sampleCount.
   */
  progress: Float32Array;
}

// ---------------------------------------------------------------------------
// Personal-bests summary (lobby panel) — light read of all stored ghosts.
// ---------------------------------------------------------------------------

export interface PersonalBest {
  trackId: TrackId;
  carId: RaceCarId;
  totalMs: number;
  bestLapMs: number | null;
  lapCount: number;
  savedAtISO: string;
}

// ---------------------------------------------------------------------------
// Storage key + base64 helpers
// ---------------------------------------------------------------------------

function storageKey(
  trackId: TrackId,
  carId: RaceCarId,
  lapCount: number,
): string {
  // lapCount is part of the storage identity so a PB at a SHORTER lap count
  // can't permanently block a PB at a LONGER one (and vice versa) — each
  // (track, car, lapCount) gets its own personal-best slot.
  return `${STORAGE_PREFIX}${GHOST_STORAGE_VERSION}.${trackId}.${carId}.${lapCount}`;
}

function int16ToBase64(arr: Int16Array): string {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let binary = "";
  // Chunk to avoid blowing the argument count on String.fromCharCode.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToInt16(b64: string): Int16Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // The blob is always a whole number of int16s.
  return new Int16Array(bytes.buffer, 0, bytes.length >> 1);
}

function quantPos(v: number): number {
  return Math.max(-32767, Math.min(32767, Math.round(v * QUANT_SCALE)));
}
function dequantPos(v: number): number {
  return v / QUANT_SCALE;
}
function quantHeading(h: number): number {
  // Wrap to [-π, π] before quantizing.
  let w = h;
  while (w > Math.PI) w -= Math.PI * 2;
  while (w < -Math.PI) w += Math.PI * 2;
  return Math.max(-32767, Math.min(32767, Math.round(w * HEADING_SCALE)));
}
function dequantHeading(v: number): number {
  return v / HEADING_SCALE;
}

// ---------------------------------------------------------------------------
// Track progress — lap-aware arc length, mirrors the server's raceProgress
// metric closely enough for a comparative delta (both sides use this same fn).
// ---------------------------------------------------------------------------

function segmentProgress(
  segments: TrackSegment[],
  segIdx: number,
  x: number,
  z: number,
): number {
  const seg = segments[segIdx];
  // Project the position onto the segment forward to refine within-segment.
  const dx = x - seg.center.x;
  const dz = z - seg.center.z;
  const along = dx * seg.forward.x + dz * seg.forward.z;
  return seg.distance + along;
}

// ---------------------------------------------------------------------------
// Recorder — samples the live local kart at 10Hz during a time-trial run.
// ---------------------------------------------------------------------------

export class GhostRecorder {
  private readonly trackId: TrackId;
  private readonly carId: RaceCarId;
  /** Lap count this run is driven over — part of the personal-best slot key. */
  private readonly lapCount: number;
  // Flat buffers (x,y,z,heading per sample), preallocated to the cap.
  private readonly xs = new Float32Array(MAX_SAMPLES);
  private readonly ys = new Float32Array(MAX_SAMPLES);
  private readonly zs = new Float32Array(MAX_SAMPLES);
  private readonly hs = new Float32Array(MAX_SAMPLES);
  private count = 0;
  private nextSampleAt = 0;
  /** Set true if the run is disqualified (e.g. the kart fell + respawned). */
  private invalid = false;
  private recording = false;

  constructor(trackId: TrackId, carId: RaceCarId, lapCount: number) {
    this.trackId = trackId;
    this.carId = carId;
    this.lapCount = lapCount;
  }

  /** Begin a fresh recording at the GO instant (raceTime 0). */
  start(): void {
    this.count = 0;
    this.nextSampleAt = 0;
    this.invalid = false;
    this.recording = true;
  }

  stop(): void {
    this.recording = false;
  }

  /** Disqualify the current recording (a fall+respawn shortcuts the path). */
  invalidate(): void {
    this.invalid = true;
  }

  get isValid(): boolean {
    return !this.invalid && this.count > 1;
  }

  /**
   * Feed a pose sampled against the race clock (ms since GO). Records at most
   * one keyframe per SAMPLE_INTERVAL_MS and stops at the duration cap.
   */
  sample(raceTimeMs: number, x: number, y: number, z: number, heading: number): void {
    if (!this.recording || this.invalid) return;
    if (raceTimeMs < this.nextSampleAt) return;
    if (this.count >= MAX_SAMPLES) {
      this.recording = false;
      return;
    }
    const i = this.count++;
    this.xs[i] = x;
    this.ys[i] = y;
    this.zs[i] = z;
    this.hs[i] = heading;
    // Advance to the next uniform sample slot (skip ahead if we lagged).
    this.nextSampleAt = (this.count) * SAMPLE_INTERVAL_MS;
  }

  /**
   * Persist this run as the new ghost for (track, car) IF it beats the stored
   * personal best total time (or there is none) and the run is valid. Returns
   * true when it actually wrote a new best.
   */
  saveIfBest(totalMs: number, bestLapMs: number | null, lapCount: number): boolean {
    if (!this.isValid) return false;
    if (typeof localStorage === "undefined") return false;

    // Compare against (and write to) the per-lap-count slot only — a faster run
    // at a different lap count lives in a different slot and never blocks this.
    const existing = loadGhostRecord(this.trackId, this.carId, this.lapCount);
    if (existing && existing.totalMs <= totalMs) return false;

    const sampleCount = this.count;
    const blob = new Int16Array(sampleCount * 4);
    for (let i = 0; i < sampleCount; i++) {
      blob[i * 4] = quantPos(this.xs[i]);
      blob[i * 4 + 1] = quantPos(this.ys[i]);
      blob[i * 4 + 2] = quantPos(this.zs[i]);
      blob[i * 4 + 3] = quantHeading(this.hs[i]);
    }

    const record: GhostRecord = {
      version: GHOST_STORAGE_VERSION,
      trackId: this.trackId,
      carId: this.carId,
      totalMs,
      bestLapMs,
      lapCount,
      dtMs: SAMPLE_INTERVAL_MS,
      savedAtISO: new Date().toISOString(),
      blob: int16ToBase64(blob),
    };

    try {
      localStorage.setItem(
        storageKey(this.trackId, this.carId, this.lapCount),
        JSON.stringify(record),
      );
      return true;
    } catch {
      // Quota / private mode — silently skip (ghost is a nicety, not core).
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Persistence + decode
// ---------------------------------------------------------------------------

export function loadGhostRecord(
  trackId: TrackId,
  carId: RaceCarId,
  lapCount: number,
): GhostRecord | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(storageKey(trackId, carId, lapCount));
    if (!raw) return null;
    const rec = JSON.parse(raw) as GhostRecord;
    if (rec.version !== GHOST_STORAGE_VERSION) return null;
    if (rec.trackId !== trackId || rec.carId !== carId) return null;
    if (rec.lapCount !== lapCount) return null;
    return rec;
  } catch {
    return null;
  }
}

/**
 * Load + decode the stored ghost for (track, car, lapCount) into a playback
 * timeline with per-sample track progress precomputed. Returns null when no
 * ghost exists for this exact (track, car, lapCount) slot — a ghost driven over
 * a different lap count lives in a different slot (its total time would be
 * meaningless for the current race).
 */
export function loadGhostTimeline(
  trackId: TrackId,
  carId: RaceCarId,
  lapCount: number,
): GhostTimeline | null {
  const rec = loadGhostRecord(trackId, carId, lapCount);
  if (!rec) return null;

  let blob: Int16Array;
  try {
    blob = base64ToInt16(rec.blob);
  } catch {
    return null;
  }
  const sampleCount = Math.floor(blob.length / 4);
  if (sampleCount < 2) return null;

  const data = new Float32Array(sampleCount * 4);
  for (let i = 0; i < sampleCount; i++) {
    data[i * 4] = dequantPos(blob[i * 4]);
    data[i * 4 + 1] = dequantPos(blob[i * 4 + 1]);
    data[i * 4 + 2] = dequantPos(blob[i * 4 + 2]);
    data[i * 4 + 3] = dequantHeading(blob[i * 4 + 3]);
  }

  // Precompute lap-aware arc-length progress per sample (monotonic) so the live
  // delta can map the local kart's progress onto the ghost timeline.
  const track = getTrack(trackId);
  const segments = track.segments;
  const trackLength = track.totalLength || 1;
  const progress = new Float32Array(sampleCount);
  let lap = 0;
  let prevSeg = 0;
  let segHint = 0;
  for (let i = 0; i < sampleCount; i++) {
    const x = data[i * 4];
    const z = data[i * 4 + 2];
    const seg = findNearestSegment(segments, x, z, segHint);
    segHint = seg;
    // Detect a lap wrap: the nearest segment jumped from near the end of the
    // ring back to near the start (and forward, not a small backwards wobble).
    if (prevSeg > segments.length * 0.75 && seg < segments.length * 0.25) {
      lap++;
    }
    prevSeg = seg;
    progress[i] = lap * trackLength + segmentProgress(segments, seg, x, z);
  }

  return {
    trackId,
    carId,
    dtMs: rec.dtMs,
    totalMs: rec.totalMs,
    bestLapMs: rec.bestLapMs,
    lapCount: rec.lapCount,
    sampleCount,
    data,
    progress,
  };
}

// ---------------------------------------------------------------------------
// Playback sampler — pose at a race-clock time + live delta vs the local kart.
// ---------------------------------------------------------------------------

export interface GhostPose {
  x: number;
  y: number;
  z: number;
  heading: number;
}

/**
 * Sample the ghost's pose at `raceTimeMs` since GO with linear interpolation
 * (position) + shortest-arc interpolation (heading). Clamps to the endpoints
 * before/after the timeline. Mutates+returns `out` to avoid per-frame garbage.
 */
export function sampleGhostPose(
  timeline: GhostTimeline,
  raceTimeMs: number,
  out: GhostPose,
): GhostPose {
  const { data, dtMs, sampleCount } = timeline;
  const fIdx = raceTimeMs / dtMs;
  const i0 = Math.max(0, Math.min(sampleCount - 1, Math.floor(fIdx)));
  const i1 = Math.min(sampleCount - 1, i0 + 1);
  const f = i1 > i0 ? Math.max(0, Math.min(1, fIdx - i0)) : 0;

  const ax = data[i0 * 4];
  const ay = data[i0 * 4 + 1];
  const az = data[i0 * 4 + 2];
  const ah = data[i0 * 4 + 3];
  const bx = data[i1 * 4];
  const by = data[i1 * 4 + 1];
  const bz = data[i1 * 4 + 2];
  const bh = data[i1 * 4 + 3];

  let dh = bh - ah;
  while (dh > Math.PI) dh -= Math.PI * 2;
  while (dh < -Math.PI) dh += Math.PI * 2;

  out.x = ax + (bx - ax) * f;
  out.y = ay + (by - ay) * f;
  out.z = az + (bz - az) * f;
  out.heading = ah + dh * f;
  return out;
}

/**
 * Compute the live time delta vs the ghost at MATCHING track progress:
 *   delta = currentRaceTimeMs − (time the ghost reached `localProgress`)
 * Positive → the local kart is BEHIND (the ghost got here earlier); negative →
 * AHEAD. Returns null when the local kart hasn't moved yet, or has driven past
 * the ghost's recorded extent (e.g. a brand-new personal best in progress).
 *
 * `localProgress` is the local kart's lap-aware arc length in the SAME metric as
 * `timeline.progress` (both produced by the segment arc-length above).
 */
export function ghostTimeDelta(
  timeline: GhostTimeline,
  localProgress: number,
  currentRaceTimeMs: number,
): number | null {
  const prog = timeline.progress;
  const n = prog.length;
  if (n < 2) return null;
  // Before the ghost moved at all.
  if (localProgress <= prog[0]) return 0;
  // Past the ghost's final recorded progress — the local kart is beating it to
  // a point the ghost never reached this run; treat the ghost as "way behind"
  // by reporting the gap to its last sample's time.
  if (localProgress >= prog[n - 1]) {
    return currentRaceTimeMs - (n - 1) * timeline.dtMs;
  }
  // Binary-search the (monotonic) progress array for the bracketing pair.
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (prog[mid] <= localProgress) lo = mid;
    else hi = mid;
  }
  const span = prog[hi] - prog[lo];
  const f = span > 1e-6 ? (localProgress - prog[lo]) / span : 0;
  const ghostTimeMs = (lo + f) * timeline.dtMs;
  return currentRaceTimeMs - ghostTimeMs;
}

/**
 * Local kart's lap-aware arc-length progress in the ghost-comparison metric.
 * `lap` is the kart's authoritative lap counter; `segHint` keeps the segment
 * lookup cheap across frames (pass + store the returned hint via `out.segHint`).
 */
export function localTrackProgress(
  trackId: TrackId,
  x: number,
  z: number,
  lap: number,
  segHint: number,
): { progress: number; segHint: number } {
  const track = getTrack(trackId);
  const segments = track.segments;
  const trackLength = track.totalLength || 1;
  const seg = findNearestSegment(segments, x, z, segHint);
  const progress =
    Math.max(0, lap) * trackLength + segmentProgress(segments, seg, x, z);
  return { progress, segHint: seg };
}

// ---------------------------------------------------------------------------
// Personal-bests panel — read every stored ghost (small N: tracks × cars).
// ---------------------------------------------------------------------------

export function listPersonalBests(): PersonalBest[] {
  if (typeof localStorage === "undefined") return [];
  const out: PersonalBest[] = [];
  const prefix = `${STORAGE_PREFIX}${GHOST_STORAGE_VERSION}.`;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try {
        const rec = JSON.parse(raw) as GhostRecord;
        if (rec.version !== GHOST_STORAGE_VERSION) continue;
        out.push({
          trackId: rec.trackId,
          carId: rec.carId,
          totalMs: rec.totalMs,
          bestLapMs: rec.bestLapMs,
          lapCount: rec.lapCount,
          savedAtISO: rec.savedAtISO,
        });
      } catch {
        // Skip a corrupt entry.
      }
    }
  } catch {
    // localStorage iteration blocked — return what we have.
  }
  // Best total first.
  out.sort((a, b) => a.totalMs - b.totalMs);
  return out;
}
