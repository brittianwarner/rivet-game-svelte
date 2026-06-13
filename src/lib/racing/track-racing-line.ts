/**
 * Mesh-snapped racing line (server-only, memoized per track).
 *
 * track1's authored segment centerline (TRACK1_CENTERS) diverges from the baked
 * road MESH the sim actually drives on by up to ~130 world units — 205 of the
 * 400 segment centers sample off-road (meshRoadDistance > 4) and a handful are
 * far enough off to read as "falling". CPU bots aim at, and recenter toward, a
 * point taken from the track geometry; using the raw segment centers makes every
 * track1 bot steer toward off-mesh points, climb the mesh distance, fall, respawn
 * off-mesh, and repeat forever (0 laps).
 *
 * This module precomputes — ONCE per track, lazily, using the SurfaceSampler the
 * actor registers from track-heightfield.ts — a racing line that is guaranteed to
 * sit ON the road mesh. Bots aim at this line (see bot-driver.ts), and respawns
 * snap to it (see getRespawnPosition in track.ts), so both stay glued to the
 * drivable surface.
 *
 * For tracks without a baked mesh (neon-circuit) there is no sampler, so the
 * centerline IS the road and this returns null — callers fall back to seg.center.
 *
 * Because it depends on the server-only sampler (the client never registers one),
 * the line is null in the browser and the centerline fallback is used there too.
 */

import type { TrackDefinition, TrackId, Vec3 } from "./types.js";
import { getSurfaceSampler, type SurfaceSampler } from "./track.js";

/** A point is "on the road mesh" within this distance (matches stepKart's test). */
const ON_ROAD_DISTANCE = 4;

/** How far (world units) to scan along a segment normal when snapping laterally. */
const LATERAL_REACH = 150;
const LATERAL_STEP = 1;

/** Rings (×3 units each) for the 2D fallback / re-snap nearest-on-road search. */
const RING_SEARCH_MAX = 40;
const RING_SEARCH_SPOKES = 32;

/** Moving-average half-window + pass count for the final smooth-and-re-snap. */
const SMOOTH_HALF_WINDOW = 2;
const SMOOTH_PASSES = 3;

/** Memoized racing line per track id (null = no mesh / no sampler). */
const _lineCache = new Map<TrackId, Vec3[] | null>();

/**
 * Nearest on-road lateral offset (along the segment normal through its center)
 * to a target offset, scanning ±LATERAL_REACH. Returns null when the road is not
 * reachable along the normal (the centerline points away from the mesh here).
 */
function nearestOnRoadLat(
  sampler: SurfaceSampler,
  cx: number,
  cz: number,
  nx: number,
  nz: number,
  target: number,
): number | null {
  let best: number | null = null;
  let bestDist = Infinity;
  for (let t = -LATERAL_REACH; t <= LATERAL_REACH; t += LATERAL_STEP) {
    const x = cx + nx * t;
    const z = cz + nz * t;
    if (sampler.sampleRoadDistance(x, z) <= ON_ROAD_DISTANCE) {
      const d = Math.abs(t - target);
      if (d < bestDist) {
        bestDist = d;
        best = t;
      }
    }
  }
  return best;
}

/**
 * The nearest on-road point to (px,pz) by an expanding ring search. Used as a
 * 2D fallback when the normal search fails, and to re-snap a smoothed point back
 * onto the mesh. Falls back to the input point if nothing is found.
 */
function nearestOnRoad(
  sampler: SurfaceSampler,
  px: number,
  pz: number,
): { x: number; z: number } {
  if (sampler.sampleRoadDistance(px, pz) <= ON_ROAD_DISTANCE) {
    return { x: px, z: pz };
  }
  for (let ring = 1; ring <= RING_SEARCH_MAX; ring++) {
    const r = ring * 3;
    let best: { x: number; z: number } | null = null;
    let bestDist = Infinity;
    for (let a = 0; a < RING_SEARCH_SPOKES; a++) {
      const ang = (a / RING_SEARCH_SPOKES) * Math.PI * 2;
      const x = px + Math.cos(ang) * r;
      const z = pz + Math.sin(ang) * r;
      if (sampler.sampleRoadDistance(x, z) <= ON_ROAD_DISTANCE && r < bestDist) {
        bestDist = r;
        best = { x, z };
      }
    }
    if (best) return best;
  }
  return { x: px, z: pz };
}

/**
 * Build the mesh-snapped racing line for a track that has a surface sampler.
 *
 *  1. For each segment, snap its center laterally onto the road (the on-road
 *     offset nearest the centerline). Where the road is not reachable along the
 *     normal, fall back to a 2D nearest-on-road search around the center. This
 *     keeps each line point near its OWN segment so the sim's center-keyed
 *     findNearestSegment still resolves the kart to roughly the right segment.
 *  2. Smooth (circular moving average) and re-snap to the nearest on-road point,
 *     repeated a few times, so the line is continuous AND every point is
 *     guaranteed on the mesh (sampleRoadDistance <= ON_ROAD_DISTANCE).
 */
function buildMeshRacingLine(
  sampler: SurfaceSampler,
  track: TrackDefinition,
): Vec3[] {
  const segments = track.segments;
  const n = segments.length;

  // --- 1. Snap each segment center onto the road ---
  let points: { x: number; z: number }[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const seg = segments[i];
    const lat = nearestOnRoadLat(
      sampler,
      seg.center.x,
      seg.center.z,
      seg.normal.x,
      seg.normal.z,
      0,
    );
    if (lat !== null) {
      points[i] = {
        x: seg.center.x + seg.normal.x * lat,
        z: seg.center.z + seg.normal.z * lat,
      };
    } else {
      // Road not reachable along the normal — find the nearest road in 2D.
      points[i] = nearestOnRoad(sampler, seg.center.x, seg.center.z);
    }
  }

  // --- 2. Smooth + re-snap onto the mesh (guarantees on-road + continuity) ---
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    const smoothed: { x: number; z: number }[] = new Array(n);
    for (let i = 0; i < n; i++) {
      let sx = 0;
      let sz = 0;
      let count = 0;
      for (let k = -SMOOTH_HALF_WINDOW; k <= SMOOTH_HALF_WINDOW; k++) {
        const p = points[(i + k + n) % n];
        sx += p.x;
        sz += p.z;
        count++;
      }
      smoothed[i] = nearestOnRoad(sampler, sx / count, sz / count);
    }
    points = smoothed;
  }

  return points.map((p, i) => {
    const meshY = sampler.sampleRoadHeight(p.x, p.z);
    return { x: p.x, y: meshY ?? segments[i].center.y, z: p.z };
  });
}

/**
 * The mesh-snapped racing line for a track, memoized. Returns null when the
 * track has no surface sampler registered (neon-circuit, or any track in the
 * browser): the centerline is the road there, so callers fall back to seg.center.
 */
export function getMeshRacingLine(
  trackId: TrackId,
  track: TrackDefinition,
): Vec3[] | null {
  if (_lineCache.has(trackId)) {
    return _lineCache.get(trackId) ?? null;
  }
  const sampler = getSurfaceSampler(trackId);
  const line = sampler ? buildMeshRacingLine(sampler, track) : null;
  _lineCache.set(trackId, line);
  return line;
}

/**
 * The aim point for a given segment: the mesh-snapped racing-line point when a
 * sampler exists, else the plain segment center (used by bots + respawn).
 */
export function getRacingLinePoint(
  trackId: TrackId,
  track: TrackDefinition,
  segIdx: number,
): Vec3 {
  const line = getMeshRacingLine(trackId, track);
  const n = track.segments.length;
  const idx = ((segIdx % n) + n) % n;
  return line ? line[idx] : track.segments[idx].center;
}
