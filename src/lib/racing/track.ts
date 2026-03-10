/**
 * Procedural track generator — "Neon Circuit"
 *
 * Generates a closed-loop racing track from control points using
 * Catmull-Rom spline interpolation. Outputs segments with center/left/right
 * positions (with elevation + banking), boost zones, item box zones,
 * checkpoints, start grid, shortcuts, and scenery.
 */

import {
  TRACK_ROAD_WIDTH,
  NUM_CHECKPOINTS,
  type TrackId,
  type TrackPoint,
  type TrackSegment,
  type TrackDefinition,
  type BoostZone,
  type ItemBoxZone,
  type CheckpointDef,
  type ShortcutZone,
  type SceneryObject,
  type Vec3,
} from "./types.js";
import { buildTrack1Definition } from "./tracks/track1.js";
import {
  TRACK1_HF_CELL_H,
  TRACK1_HF_CELL_W,
  TRACK1_HF_COLS,
  TRACK1_HEIGHTFIELD,
  TRACK1_HF_ORIGIN_X,
  TRACK1_HF_ORIGIN_Z,
  TRACK1_HF_ROWS,
  TRACK1_HF_SENTINEL,
} from "./tracks/track1-heightfield.js";

// ---------------------------------------------------------------------------
// Catmull-Rom interpolation
// ---------------------------------------------------------------------------

function catmullRom(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t: number,
): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

// ---------------------------------------------------------------------------
// Track control points — "Neon Circuit" with elevation, banking, variable width
// ---------------------------------------------------------------------------

function getControlPoints(): TrackPoint[] {
  const w = TRACK_ROAD_WIDTH;
  const S = 5; // Track scale factor — multiplied into all positions
  const SY = 3; // Elevation scale (slightly less than XZ to keep hills proportional)
  // Closed loop: start/finish on +Z straight heading -Z direction
  // Layout: large ~500m circuit with varied corners
  return [
    // Start/finish straight (heading toward -Z)
    { x: 0 * S, y: 0 * SY, z: 40 * S, width: w },              // 0
    { x: 0 * S, y: 0.2 * SY, z: 30 * S, width: w },            // 1
    { x: 0 * S, y: 0.8 * SY, z: 20 * S, width: w },            // 2

    // Wide right sweeper — gentle rise, banked inward
    { x: 8 * S, y: 1.5 * SY, z: 10 * S, width: w, banking: 0.15 },     // 3
    { x: 18 * S, y: 2.5 * SY, z: 5 * S, width: w, banking: 0.15 },     // 4
    { x: 25 * S, y: 3.0 * SY, z: -5 * S, width: w, banking: 0.15 },    // 5

    // Short straight with boost — crest then descend, narrower road
    { x: 28 * S, y: 3.5 * SY, z: -15 * S, width: w * 0.8 },           // 6
    { x: 28 * S, y: 2.0 * SY, z: -25 * S, width: w * 0.8 },           // 7

    // Tight left hairpin — slight reverse camber for difficulty
    { x: 22 * S, y: 1.5 * SY, z: -35 * S, width: w * 1.2, banking: -0.08 },  // 8
    { x: 10 * S, y: 1.0 * SY, z: -40 * S, width: w * 1.2, banking: -0.08 },  // 9
    { x: 0 * S, y: 1.0 * SY, z: -35 * S, width: w },                          // 10

    // S-curve section — valley dip, slightly narrower at entry
    { x: -8 * S, y: -0.5 * SY, z: -25 * S, width: w * 0.85 },         // 11
    { x: -5 * S, y: -1.5 * SY, z: -15 * S, width: w },                 // 12
    { x: -12 * S, y: -2.0 * SY, z: -5 * S, width: w },                 // 13
    { x: -18 * S, y: -1.0 * SY, z: 5 * S, width: w },                  // 14

    // Long back straight with item boxes — wider road, gradual climb
    { x: -20 * S, y: -0.5 * SY, z: 15 * S, width: w * 1.3 },          // 15
    { x: -18 * S, y: 0.5 * SY, z: 25 * S, width: w * 1.3 },           // 16
    { x: -14 * S, y: 1.0 * SY, z: 35 * S, width: w * 1.3 },           // 17

    // Broad sweeping final turn back to start — wide and smooth
    { x: -4 * S, y: 1.0 * SY, z: 46 * S, width: w * 1.2, banking: 0.1 },   // 18
    { x: 6 * S, y: 0.3 * SY, z: 44 * S, width: w * 1.1 },                   // 19
  ];
}

// ---------------------------------------------------------------------------
// Generate full track definition
// ---------------------------------------------------------------------------

const SEGMENTS_PER_SPAN = 20;

export function generateNeonCircuitTrack(): TrackDefinition {
  const points = getControlPoints();
  const n = points.length;
  const totalSegments = n * SEGMENTS_PER_SPAN;
  const segments: TrackSegment[] = [];

  // Generate interpolated segments
  let cumDist = 0;
  let prevCenter: Vec3 | null = null;

  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];

    const w0 = points[(i - 1 + n) % n].width;
    const w1 = points[i].width;
    const w2 = points[(i + 1) % n].width;
    const w3 = points[(i + 2) % n].width;

    // Banking values (default 0)
    const b0 = p0.banking ?? 0;
    const b1 = p1.banking ?? 0;
    const b2 = p2.banking ?? 0;
    const b3 = p3.banking ?? 0;

    for (let j = 0; j < SEGMENTS_PER_SPAN; j++) {
      const t = j / SEGMENTS_PER_SPAN;
      const cx = catmullRom(p0.x, p1.x, p2.x, p3.x, t);
      const cy = catmullRom(p0.y, p1.y, p2.y, p3.y, t);
      const cz = catmullRom(p0.z, p1.z, p2.z, p3.z, t);
      const hw = catmullRom(w0, w1, w2, w3, t) / 2;
      const banking = catmullRom(b0, b1, b2, b3, t);

      const center: Vec3 = { x: cx, y: cy, z: cz };

      if (prevCenter) {
        const dx = center.x - prevCenter.x;
        const dy = center.y - prevCenter.y;
        const dz = center.z - prevCenter.z;
        cumDist += Math.sqrt(dx * dx + dy * dy + dz * dz);
      }

      // Forward direction from a small epsilon ahead
      const tNext = (j + 0.5) / SEGMENTS_PER_SPAN;
      const fxNext = catmullRom(p0.x, p1.x, p2.x, p3.x, tNext);
      const fyNext = catmullRom(p0.y, p1.y, p2.y, p3.y, tNext);
      const fzNext = catmullRom(p0.z, p1.z, p2.z, p3.z, tNext);
      const fdx = fxNext - cx;
      const fdy = fyNext - cy;
      const fdz = fzNext - cz;
      const fLen = Math.sqrt(fdx * fdx + fdy * fdy + fdz * fdz) || 1;
      const forward: Vec3 = { x: fdx / fLen, y: fdy / fLen, z: fdz / fLen };

      // Normal = right perpendicular of forward in XZ plane (rotate 90 deg CW)
      // We keep the normal in XZ for lateral offset calculations
      const nxRaw = -forward.z;
      const nzRaw = forward.x;
      const nLen2d = Math.sqrt(nxRaw * nxRaw + nzRaw * nzRaw) || 1;
      const normal: Vec3 = { x: nxRaw / nLen2d, y: 0, z: nzRaw / nLen2d };

      // Apply banking to left/right edge Y positions
      // banking > 0 → right side lower (banked right, like turning right)
      // left.y = center.y + hw * sin(banking)
      // right.y = center.y - hw * sin(banking)
      const bankOffset = hw * Math.sin(banking);

      const left: Vec3 = {
        x: cx - normal.x * hw,
        y: cy + bankOffset,
        z: cz - normal.z * hw,
      };
      const right: Vec3 = {
        x: cx + normal.x * hw,
        y: cy - bankOffset,
        z: cz + normal.z * hw,
      };

      segments.push({ center, left, right, forward, normal, distance: cumDist });
      prevCenter = center;
    }
  }

  // Compute total length (distance back to start)
  const first = segments[0].center;
  const last = segments[segments.length - 1].center;
  const closingDist = Math.sqrt(
    (first.x - last.x) ** 2 + (first.y - last.y) ** 2 + (first.z - last.z) ** 2,
  );
  const totalLength = cumDist + closingDist;

  // ---------------------------------------------------------------------------
  // Boost zones — 4 zones placed at specific segment ranges
  // ---------------------------------------------------------------------------
  // Boost 1: entry of right sweeper (~15-18%)
  // Boost 2: exit of hairpin (~42-45%)
  // Boost 3: far-right side of back straight (~72-75%)
  // Boost 4: on the shortcut path (we place it at ~55% which is inside the S-curve shortcut area)
  const boostZones: BoostZone[] = [
    { segmentStart: Math.floor(totalSegments * 0.15), segmentEnd: Math.floor(totalSegments * 0.18) },
    { segmentStart: Math.floor(totalSegments * 0.42), segmentEnd: Math.floor(totalSegments * 0.45) },
    { segmentStart: Math.floor(totalSegments * 0.72), segmentEnd: Math.floor(totalSegments * 0.75) },
    { segmentStart: Math.floor(totalSegments * 0.53), segmentEnd: Math.floor(totalSegments * 0.55) },
  ];

  // ---------------------------------------------------------------------------
  // Item box zones — 3 rows with varying box counts
  // ---------------------------------------------------------------------------
  const itemBoxZones: ItemBoxZone[] = [];

  // Row 1 (~30%): 3 boxes
  {
    const segIdx = Math.floor(totalSegments * 0.30);
    const seg = segments[segIdx];
    const positions: Vec3[] = [];
    for (let b = 0; b < 3; b++) {
      const t = (b + 0.5) / 3;
      positions.push({
        x: seg.left.x + (seg.right.x - seg.left.x) * t,
        y: Math.max(seg.left.y, seg.right.y, seg.center.y) + 1.2,
        z: seg.left.z + (seg.right.z - seg.left.z) * t,
      });
    }
    itemBoxZones.push({ segmentIndex: segIdx, positions });
  }

  // Row 2 (~60%): 5 boxes across the wider road
  {
    const segIdx = Math.floor(totalSegments * 0.60);
    const seg = segments[segIdx];
    const positions: Vec3[] = [];
    for (let b = 0; b < 5; b++) {
      const t = (b + 0.5) / 5;
      positions.push({
        x: seg.left.x + (seg.right.x - seg.left.x) * t,
        y: Math.max(seg.left.y, seg.right.y, seg.center.y) + 1.2,
        z: seg.left.z + (seg.right.z - seg.left.z) * t,
      });
    }
    itemBoxZones.push({ segmentIndex: segIdx, positions });
  }

  // Row 3 (~85%, pre-chicane): 2 boxes
  {
    const segIdx = Math.floor(totalSegments * 0.85);
    const seg = segments[segIdx];
    const positions: Vec3[] = [];
    for (let b = 0; b < 2; b++) {
      const t = (b + 0.5) / 2;
      positions.push({
        x: seg.left.x + (seg.right.x - seg.left.x) * t,
        y: Math.max(seg.left.y, seg.right.y, seg.center.y) + 1.2,
        z: seg.left.z + (seg.right.z - seg.left.z) * t,
      });
    }
    itemBoxZones.push({ segmentIndex: segIdx, positions });
  }

  // ---------------------------------------------------------------------------
  // Checkpoints — evenly spaced
  // ---------------------------------------------------------------------------
  const checkpoints: CheckpointDef[] = [];
  for (let i = 0; i < NUM_CHECKPOINTS; i++) {
    const segIdx = Math.floor((i / NUM_CHECKPOINTS) * totalSegments);
    const seg = segments[segIdx];
    checkpoints.push({
      segmentIndex: segIdx,
      center: { ...seg.center },
      normal: { ...seg.forward },
    });
  }

  // ---------------------------------------------------------------------------
  // Start grid positions — 4 karts in 2x2, staggered
  // ---------------------------------------------------------------------------
  const startSeg0 = segments[0];
  const startSeg1 = segments[Math.min(8, segments.length - 1)];
  const startHeading = Math.atan2(startSeg0.forward.x, startSeg0.forward.z);

  const startPositions: Vec3[] = [
    // Row 1 (front) — spaced 3.5 units from center laterally
    {
      x: startSeg0.center.x - startSeg0.normal.x * 3.5,
      y: startSeg0.center.y + 0.5,
      z: startSeg0.center.z - startSeg0.normal.z * 3.5,
    },
    {
      x: startSeg0.center.x + startSeg0.normal.x * 3.5,
      y: startSeg0.center.y + 0.5,
      z: startSeg0.center.z + startSeg0.normal.z * 3.5,
    },
    // Row 2 (back)
    {
      x: startSeg1.center.x - startSeg1.normal.x * 3.5,
      y: startSeg1.center.y + 0.5,
      z: startSeg1.center.z - startSeg1.normal.z * 3.5,
    },
    {
      x: startSeg1.center.x + startSeg1.normal.x * 3.5,
      y: startSeg1.center.y + 0.5,
      z: startSeg1.center.z + startSeg1.normal.z * 3.5,
    },
  ];

  // ---------------------------------------------------------------------------
  // S-curve shortcut zone
  // ---------------------------------------------------------------------------
  // The S-curve spans roughly points 11-14 (indices in the control point array).
  // In segment space that's approximately segments 11*SEGMENTS_PER_SPAN to 14*SEGMENTS_PER_SPAN.
  // The shortcut cuts across the interior of the S-curve.
  const scurveSegStart = 11 * SEGMENTS_PER_SPAN;
  const scurveSegEnd = 14 * SEGMENTS_PER_SPAN;

  // Centerline points for the shortcut road — cutting straight from
  // entrance of S-curve to exit, through the interior
  const scurveEntry = segments[scurveSegStart].center;
  const scurveExit = segments[Math.min(scurveSegEnd, totalSegments - 1)].center;
  const scurveMidX = (scurveEntry.x + scurveExit.x) / 2 + 3; // offset inward
  const scurveMidY = (scurveEntry.y + scurveExit.y) / 2 - 0.5;
  const scurveMidZ = (scurveEntry.z + scurveExit.z) / 2;

  const shortcuts: ShortcutZone[] = [
    {
      segmentStart: scurveSegStart,
      segmentEnd: scurveSegEnd,
      points: [
        { x: scurveEntry.x, y: scurveEntry.y, z: scurveEntry.z },
        { x: scurveMidX, y: scurveMidY, z: scurveMidZ },
        { x: scurveExit.x, y: scurveExit.y, z: scurveExit.z },
      ],
    },
  ];

  // ---------------------------------------------------------------------------
  // Scenery objects
  // ---------------------------------------------------------------------------
  const scenery: SceneryObject[] = [];

  // Start/finish arch at segment 0
  {
    const seg = segments[0];
    scenery.push({
      position: { x: seg.center.x, y: seg.center.y, z: seg.center.z },
      type: "arch",
      color: "#FFFFFF",
      height: 10,
      width: 22,
      depth: 2,
    });
  }

  // Neon pylons every 15 segments along the track, alternating left/right
  for (let i = 0; i < totalSegments; i += 15) {
    const seg = segments[i];
    const side = (Math.floor(i / 15) % 2 === 0) ? 1 : -1; // alternate right/left
    const hw = Math.sqrt(
      (seg.right.x - seg.left.x) ** 2 + (seg.right.z - seg.left.z) ** 2,
    ) / 2;
    const offset = hw + 4.0; // place just outside the road edge
    const pylonY = side > 0 ? seg.right.y : seg.left.y;
    scenery.push({
      position: {
        x: seg.center.x + seg.normal.x * offset * side,
        y: pylonY,
        z: seg.center.z + seg.normal.z * offset * side,
      },
      type: "pylon",
      color: (Math.floor(i / 15) % 3 === 0) ? "#FF00FF" : (Math.floor(i / 15) % 3 === 1) ? "#00FFFF" : "#FFFF00",
      height: 8,
    });
  }

  // Taller city blocks in the S-curve interior (points 11-14 area)
  // Positions scaled to match track scale
  const blockPositions: Array<{ x: number; y: number; z: number }> = [
    { x: -10, y: -4.0, z: -90 },
    { x: -5, y: -6.0, z: -60 },
    { x: -40, y: -7.0, z: -40 },
    { x: -20, y: -5.0, z: -100 },
    { x: -50, y: -4.0, z: -75 },
  ];
  const blockColors = ["#1A1A3E", "#2A1A4E", "#1A2A4E", "#2A2A3E", "#1A1A5E"];
  for (let bi = 0; bi < blockPositions.length; bi++) {
    const bp = blockPositions[bi];
    scenery.push({
      position: { x: bp.x, y: bp.y, z: bp.z },
      type: "block",
      color: blockColors[bi % blockColors.length],
      height: 20 + (bi % 3) * 8,
      width: 8 + (bi % 2) * 3,
      depth: 8 + ((bi + 1) % 2) * 3,
    });
  }

  return {
    points,
    segments,
    totalLength,
    boostZones,
    itemBoxZones,
    checkpoints,
    startPositions,
    startHeading,
    shortcuts,
    scenery,
    visual: {
      kind: "procedural",
    },
  };
}

export function generateTrack(): TrackDefinition {
  return generateNeonCircuitTrack();
}

// ---------------------------------------------------------------------------
// Track query helpers (used by server physics)
// ---------------------------------------------------------------------------

/**
 * Find the nearest track segment index for a given world position.
 * First checks a local window around the hint index (previous result),
 * then falls back to a full scan only if the local search is poor.
 */
export function findNearestSegment(
  segments: TrackSegment[],
  x: number,
  z: number,
  hintIdx?: number,
): number {
  const n = segments.length;
  let bestIdx = 0;
  let bestDist = Infinity;

  if (hintIdx !== undefined && hintIdx >= 0 && hintIdx < n) {
    const window = Math.min(40, Math.floor(n / 4));
    for (let k = -window; k <= window; k++) {
      const i = ((hintIdx + k) % n + n) % n;
      const seg = segments[i];
      const dx = x - seg.center.x;
      const dz = z - seg.center.z;
      const d = dx * dx + dz * dz;
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    if (bestDist < 10000) return bestIdx;
  }

  bestDist = Infinity;
  for (let i = 0; i < n; i++) {
    const seg = segments[i];
    const dx = x - seg.center.x;
    const dz = z - seg.center.z;
    const d = dx * dx + dz * dz;
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }

  return bestIdx;
}

/**
 * Get the lateral offset from track center.
 * Positive = right of center, negative = left.
 */
export function getLateralOffset(
  segments: TrackSegment[],
  segIdx: number,
  x: number,
  z: number,
): number {
  const seg = segments[segIdx];
  const dx = x - seg.center.x;
  const dz = z - seg.center.z;
  return dx * seg.normal.x + dz * seg.normal.z;
}

/**
 * Check if a position is on the road surface.
 */
export function isOnRoad(
  segments: TrackSegment[],
  segIdx: number,
  x: number,
  z: number,
): boolean {
  const lateral = Math.abs(getLateralOffset(segments, segIdx, x, z));
  // Road half-width is approximated from left/right distance
  const seg = segments[segIdx];
  const hw =
    Math.sqrt(
      (seg.right.x - seg.left.x) ** 2 + (seg.right.z - seg.left.z) ** 2,
    ) / 2;
  return lateral <= hw;
}

/**
 * Check if a position is in a boost zone.
 */
export function isInBoostZone(
  boostZones: BoostZone[],
  segIdx: number,
): boolean {
  return boostZones.some(
    (bz) => segIdx >= bz.segmentStart && segIdx <= bz.segmentEnd,
  );
}

/**
 * Get the respawn position (center of the nearest segment, facing forward).
 * Includes the segment's Y elevation.
 */
export function getRespawnPosition(
  segments: TrackSegment[],
  segIdx: number,
): { position: Vec3; heading: number } {
  const seg = segments[segIdx];
  return {
    position: { x: seg.center.x, y: seg.center.y + 2.5, z: seg.center.z },
    heading: Math.atan2(seg.forward.x, seg.forward.z),
  };
}

function getHeightfieldValue(col: number, row: number): number | null {
  if (col < 0 || row < 0 || col >= TRACK1_HF_COLS || row >= TRACK1_HF_ROWS) {
    return null;
  }
  const value = TRACK1_HEIGHTFIELD[row * TRACK1_HF_COLS + col];
  return value === TRACK1_HF_SENTINEL ? null : value;
}

/**
 * Sample the road mesh height baked into the track1 heightfield.
 * Returns null when the queried XZ lies outside the drivable mesh.
 */
export function sampleRoadHeight(x: number, z: number): number | null {
  const localX = (x - TRACK1_HF_ORIGIN_X) / TRACK1_HF_CELL_W;
  const localZ = (z - TRACK1_HF_ORIGIN_Z) / TRACK1_HF_CELL_H;

  const x0 = Math.floor(localX);
  const z0 = Math.floor(localZ);
  const x1 = x0 + 1;
  const z1 = z0 + 1;

  const fx = localX - x0;
  const fz = localZ - z0;

  const h00 = getHeightfieldValue(x0, z0);
  const h10 = getHeightfieldValue(x1, z0);
  const h01 = getHeightfieldValue(x0, z1);
  const h11 = getHeightfieldValue(x1, z1);

  const samples = [h00, h10, h01, h11].filter((h): h is number => h !== null);
  if (samples.length === 0) {
    return null;
  }

  // If any corner is missing, fall back to the average of available samples.
  if (samples.length < 4) {
    return samples.reduce((sum, value) => sum + value, 0) / samples.length;
  }

  const top = h00 * (1 - fx) + h10 * fx;
  const bottom = h01 * (1 - fx) + h11 * fx;
  return top * (1 - fz) + bottom * fz;
}

/**
 * Approximate distance in world units from an XZ point to the baked road mesh.
 * Returns 0 when the point is inside any occupied road cell.
 */
export function sampleRoadDistance(x: number, z: number, maxRings = 10): number {
  const localX = (x - TRACK1_HF_ORIGIN_X) / TRACK1_HF_CELL_W;
  const localZ = (z - TRACK1_HF_ORIGIN_Z) / TRACK1_HF_CELL_H;
  const baseCol = Math.floor(localX);
  const baseRow = Math.floor(localZ);
  const halfDiag = Math.sqrt(TRACK1_HF_CELL_W ** 2 + TRACK1_HF_CELL_H ** 2) * 0.5;

  let best = Infinity;

  for (let ring = 0; ring <= maxRings; ring++) {
    const minCol = baseCol - ring;
    const maxCol = baseCol + 1 + ring;
    const minRow = baseRow - ring;
    const maxRow = baseRow + 1 + ring;

    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        const isBorder =
          row === minRow || row === maxRow || col === minCol || col === maxCol;
        if (!isBorder && ring > 0) continue;

        const height = getHeightfieldValue(col, row);
        if (height === null) continue;

        const centerX = TRACK1_HF_ORIGIN_X + (col + 0.5) * TRACK1_HF_CELL_W;
        const centerZ = TRACK1_HF_ORIGIN_Z + (row + 0.5) * TRACK1_HF_CELL_H;
        const distToCenter = Math.sqrt(
          (centerX - x) ** 2 + (centerZ - z) ** 2,
        );
        const distToCell = Math.max(0, distToCenter - halfDiag);

        if (distToCell < best) {
          best = distToCell;
        }
      }
    }

    if (best === 0) break;
  }

  return Number.isFinite(best) ? best : Infinity;
}

// ---------------------------------------------------------------------------
// Track registry cache (generated once, shared between server and client)
// ---------------------------------------------------------------------------

export const DEFAULT_TRACK_ID: TrackId = "track1";

const _cachedTracks = new Map<TrackId, TrackDefinition>();

function createTrack(trackId: TrackId): TrackDefinition {
  if (trackId === "track1") {
    return buildTrack1Definition();
  }
  return generateNeonCircuitTrack();
}

export function getTrack(trackId: TrackId = DEFAULT_TRACK_ID): TrackDefinition {
  const existing = _cachedTracks.get(trackId);
  if (existing) {
    return existing;
  }

  const track = createTrack(trackId);
  _cachedTracks.set(trackId, track);
  return track;
}

export function listTrackIds(): TrackId[] {
  return ["track1", "neon-circuit"];
}
