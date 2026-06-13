/**
 * Procedural track generator — "Neon Circuit"
 *
 * Generates a closed-loop racing track from control points using
 * Catmull-Rom spline interpolation. Outputs segments with center/left/right
 * positions (with elevation + banking), boost zones, item box zones,
 * checkpoints, start grid, and scenery.
 */

import {
  TRACK_ROAD_WIDTH,
  NUM_CHECKPOINTS,
  type TrackId,
  type TrackMeta,
  type TrackPoint,
  type TrackSegment,
  type TrackDefinition,
  type BoostZone,
  type ItemBoxZone,
  type CheckpointDef,
  type SceneryObject,
  type Vec3,
} from "./types.js";
import { buildTrack1Definition } from "./tracks/track1.js";

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
  // Definitive Neon Circuit layout — a 21-point Catmull-Rom loop (= 420 segments,
  // lap ~2659u). Numerically rebuilt and validated: every per-segment radius /
  // grade / width / banking / overlap constraint passes (see the build-time guard
  // in generateNeonCircuitTrack). The closing arc was re-solved off the Flow
  // analyst's proposal to kill a 16u final-corner cusp and seg0 mis-alignment, and
  // the over-steep T1 banking was eased.
  const S = 9; // XZ scale — enlarged circuit
  const SY = 3; // elevation scale (held low so the bigger circuit keeps gentle grades)
  const w = TRACK_ROAD_WIDTH * 1.1; // 19.8 — neon road slightly widened

  // Each row: [X, Y, Z, widthMultiplier, banking]. Positions are multiplied by
  // S (XZ) / SY (Y); width by w. Banking is in radians (positive = banked right;
  // never reverse-camber). Corner sequence (fractions of the 420-seg loop):
  //   cp0-2   START/FINISH STRAIGHT (0-7%)     — colinear on x=0, wide clean launch
  //   cp3-5   T1 BANKED RIGHT SWEEPER (5-22%)   — climbs, banked 0.10-0.11
  //   cp6     CREST/CHUTE (28-32%)              — high point, road straightens
  //   cp7-8   T2 MEDIUM RIGHT (33-40%)          — feeds the back straight
  //   cp8-11  WIDE BACK STRAIGHT (40-58%)       — the overtaking spine, road widens
  //   cp12-15 SLOW TECHNICAL COMPLEX (58-76%)   — slowest corner (~92u), wide entry
  //   cp16-17 FLICK (76-80%)                    — quick left-right transition
  //   cp17-19 T5 BANKED LEFT SWEEPER (80-93%)   — banked 0.10-0.11, climbing
  //   cp19-20 FINAL EASE-ON (93-100%)           — fast sweep onto the start straight
  const rows: Array<[number, number, number, number, number]> = [
    [0, 0, 38, 1.15, 0],     // 0
    [0, 0, 25, 1.15, 0],     // 1
    [0, 0.3, 11, 1.0, 0],    // 2
    [9, 1.0, -2, 1.0, 0.11], // 3
    [20, 1.8, -10, 1.0, 0.11], // 4
    [29, 2.4, -22, 1.0, 0.1], // 5
    [31, 2.6, -35, 1.0, 0],  // 6
    [27, 2.2, -48, 1.1, 0.08], // 7
    [15, 1.8, -56, 1.2, 0],  // 8
    [0, 1.6, -58, 1.3, 0],   // 9
    [-15, 1.4, -56, 1.3, 0], // 10
    [-29, 1.2, -50, 1.25, 0], // 11
    [-40, 0.6, -41, 1.1, 0], // 12
    [-48, 0.0, -30, 1.2, 0.05], // 13
    [-53, -0.4, -18, 1.0, 0.05], // 14
    [-52, -0.4, -6, 1.0, 0], // 15
    [-44, 0.0, 3, 1.05, 0],  // 16
    [-34, 0.4, 12, 1.0, 0.1], // 17
    [-26, 0.7, 28, 1.0, 0.11], // 18
    [-16, 0.9, 44, 1.1, 0.05], // 19
    [-7, 0.6, 46, 1.15, 0],  // 20
  ];

  return rows.map(([x, y, z, wm, banking]) => {
    const pt: TrackPoint = { x: x * S, y: y * SY, z: z * S, width: w * wm };
    if (banking !== 0) pt.banking = banking;
    return pt;
  });
}

// ---------------------------------------------------------------------------
// Generate full track definition
// ---------------------------------------------------------------------------

const SEGMENTS_PER_SPAN = 20;

// ---------------------------------------------------------------------------
// Build-time layout guard for the neon circuit
// ---------------------------------------------------------------------------

interface NeonGuardInput {
  segments: TrackSegment[];
  totalSegments: number;
  boostZones: BoostZone[];
  itemBoxZones: ItemBoxZone[];
  checkpoints: CheckpointDef[];
  startPositions: Vec3[];
  blockSpecs: Array<{ x: number; z: number; width: number; depth: number }>;
  halfWidthAt: (i: number) => number;
  radiusAt: (i: number) => number;
}

/**
 * Re-derives every hard constraint over the generated geometry and throws on the
 * first violation. Called at the end of generateNeonCircuitTrack (dev/test only).
 * This is the regression guard the layout spec mandates: it makes the
 * impossible-corner / self-overlap bug class a loud build-time failure instead of
 * a silent on-road / checkpoint corruption.
 */
function assertNeonLayout(input: NeonGuardInput): void {
  const {
    segments,
    totalSegments,
    boostZones,
    itemBoxZones,
    checkpoints,
    startPositions,
    blockSpecs,
    halfWidthAt,
    radiusAt,
  } = input;
  const fail = (msg: string): never => {
    throw new Error(`Neon Circuit layout guard: ${msg}`);
  };

  const seg0 = segments[0];

  // 1. Min corner radius >= 22u everywhere.
  for (let i = 0; i < totalSegments; i++) {
    const r = radiusAt(i);
    if (r < 22) fail(`min corner radius ${r.toFixed(1)}u < 22u at seg ${i}`);
  }

  // 2. Per-segment half-width / grade / banking-edge-delta.
  for (let i = 0; i < totalSegments; i++) {
    const hw = halfWidthAt(i);
    if (hw < 8) fail(`half-width ${hw.toFixed(2)}u < 8u at seg ${i}`);
    const a = segments[i];
    const b = segments[(i + 1) % totalSegments];
    const dx = b.center.x - a.center.x;
    const dz = b.center.z - a.center.z;
    const dy = b.center.y - a.center.y;
    const horiz = Math.sqrt(dx * dx + dz * dz);
    const grade = horiz > 1e-6 ? Math.abs(dy) / horiz : 0;
    if (grade > 0.08) fail(`grade ${(grade * 100).toFixed(1)}% > 8% at seg ${i}`);
    const edgeDelta = Math.abs(a.left.y - a.right.y);
    if (edgeDelta > 2.5)
      fail(`banking edge delta ${edgeDelta.toFixed(2)}u > 2.5u at seg ${i}`);
  }

  // 3. No road self-overlap: non-adjacent pairs (separation > 8, both ways round
  //    the loop) must keep a centerline XZ gap > hw_i + hw_j + 6.
  for (let i = 0; i < totalSegments; i++) {
    const hwi = halfWidthAt(i);
    for (let j = i + 1; j < totalSegments; j++) {
      const lin = j - i;
      const sep = Math.min(lin, totalSegments - lin);
      if (sep <= 8) continue;
      const dx = segments[i].center.x - segments[j].center.x;
      const dz = segments[i].center.z - segments[j].center.z;
      const gap = Math.sqrt(dx * dx + dz * dz);
      const need = hwi + halfWidthAt(j) + 6;
      if (gap <= need)
        fail(
          `road self-overlap: segs ${i}/${j} gap ${gap.toFixed(1)}u <= ${need.toFixed(1)}u`,
        );
    }
  }

  // 4. Start-grid lateral offset <= hw-3 at seg0.
  const grid0Hw = halfWidthAt(0);
  for (let s = 0; s < startPositions.length; s++) {
    const p = startPositions[s];
    const lateral = Math.abs(
      (p.x - seg0.center.x) * seg0.normal.x +
        (p.z - seg0.center.z) * seg0.normal.z,
    );
    if (lateral > grid0Hw - 3)
      fail(
        `grid slot ${s} lateral ${lateral.toFixed(2)}u > hw-3 (${(grid0Hw - 3).toFixed(2)}u)`,
      );
  }

  // 5. Checkpoint / boost feature-segment width >= 9u.
  for (let c = 0; c < checkpoints.length; c++) {
    const hw = halfWidthAt(checkpoints[c].segmentIndex);
    if (hw < 9)
      fail(`checkpoint ${c} hw ${hw.toFixed(2)}u < 9u (seg ${checkpoints[c].segmentIndex})`);
  }
  for (let z = 0; z < boostZones.length; z++) {
    const bz = boostZones[z];
    for (let i = bz.segmentStart; i <= bz.segmentEnd; i++) {
      const hw = halfWidthAt(((i % totalSegments) + totalSegments) % totalSegments);
      if (hw < 9) fail(`boost ${z} hw ${hw.toFixed(2)}u < 9u at seg ${i}`);
      const r = radiusAt(((i % totalSegments) + totalSegments) % totalSegments);
      if (r < 150) fail(`boost ${z} on R ${r.toFixed(0)}u < 150u at seg ${i}`);
    }
  }

  // 6. Item boxes: each row's seg on R>=150 & hw>=9; per-box lateral <= hw-1.5;
  //    neighbours spaced >= pickup diameter (3.8u).
  for (let r = 0; r < itemBoxZones.length; r++) {
    const row = itemBoxZones[r];
    const seg = segments[row.segmentIndex];
    const hw = halfWidthAt(row.segmentIndex);
    if (hw < 9) fail(`item row ${r} hw ${hw.toFixed(2)}u < 9u`);
    if (radiusAt(row.segmentIndex) < 150)
      fail(`item row ${r} on R < 150u (seg ${row.segmentIndex})`);
    const laterals: number[] = [];
    for (const pos of row.positions) {
      const lateral =
        (pos.x - seg.center.x) * seg.normal.x +
        (pos.z - seg.center.z) * seg.normal.z;
      if (Math.abs(lateral) > hw - 1.5)
        fail(
          `item row ${r} box lateral ${Math.abs(lateral).toFixed(2)}u > hw-1.5 (${(hw - 1.5).toFixed(2)}u)`,
        );
      laterals.push(lateral);
    }
    laterals.sort((a, b) => a - b);
    for (let k = 1; k < laterals.length; k++) {
      if (laterals[k] - laterals[k - 1] < 3.8)
        fail(`item row ${r} boxes spaced < 3.8u apart`);
    }
  }

  // 7. Feature index ranges in bounds.
  for (const bz of boostZones) {
    if (bz.segmentStart < 0 || bz.segmentEnd >= totalSegments)
      fail(`boost zone out of range: ${bz.segmentStart}-${bz.segmentEnd}`);
  }
  for (const row of itemBoxZones) {
    if (row.segmentIndex < 0 || row.segmentIndex >= totalSegments)
      fail(`item row out of range: ${row.segmentIndex}`);
  }

  // 8. Framing city blocks must not intersect the main racing corridor.
  for (const blk of blockSpecs) {
    const hwB = blk.width / 2 + 1;
    const hdB = blk.depth / 2 + 1;
    for (let i = 0; i < totalSegments; i++) {
      const s = segments[i];
      const cx = Math.max(blk.x - hwB, Math.min(s.center.x, blk.x + hwB));
      const cz = Math.max(blk.z - hdB, Math.min(s.center.z, blk.z + hdB));
      if (Math.hypot(s.center.x - cx, s.center.z - cz) < halfWidthAt(i) + 2)
        fail(`city block (${blk.x},${blk.z}) intersects main road at seg ${i}`);
    }
  }
}

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
  // Per-segment geometry helpers (radius / half-width) — derived, never hardcoded
  // ---------------------------------------------------------------------------
  // Local road half-width from the generated edges (banking tilts the edges, so
  // the XZ distance is the true on-road half-width the sim uses).
  function halfWidthAt(i: number): number {
    const seg = segments[i];
    return (
      Math.sqrt(
        (seg.right.x - seg.left.x) ** 2 + (seg.right.z - seg.left.z) ** 2,
      ) / 2
    );
  }
  // Turn radius at a segment = arc length / |heading change| over the next span.
  function radiusAt(i: number): number {
    const a = segments[i];
    const b = segments[(i + 1) % totalSegments];
    const dx = b.center.x - a.center.x;
    const dz = b.center.z - a.center.z;
    const segLen = Math.sqrt(dx * dx + dz * dz);
    const ha = Math.atan2(a.forward.x, a.forward.z);
    const hb = Math.atan2(b.forward.x, b.forward.z);
    let d = hb - ha;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return Math.abs(d) > 1e-9 ? segLen / Math.abs(d) : Infinity;
  }

  // ---------------------------------------------------------------------------
  // Boost zones — 4 pads, all derived from the loop fraction (never hardcoded).
  // Every pad sits on a straight/exit (R >= 150u) where holding the line pays off.
  // ---------------------------------------------------------------------------
  // boost1: T2 EXIT onto the back straight (R climbs 157->277, hw~11) — a clean
  //         boost-out-of-corner. (The 0.31-0.34 fraction would clip the T2 apex
  //         at R~117; 0.34-0.36 keeps the whole pad on the rising exit.)
  // boost2: mid WIDE back straight (R~460) — rewards the draft line
  // boost3: slow-complex EXIT onto the flick (R~175+) — boost-out-of-slow-corner
  // boost4: on the technical-complex EXIT (last segments before seg320), a normal
  //         boost pad on the drivable line where the road is wide (R~378, hw~10.2).
  const SHORTCUT_SEG_END = 16 * SEGMENTS_PER_SPAN; // 320
  const boostZones: BoostZone[] = [
    {
      segmentStart: Math.floor(totalSegments * 0.34),
      segmentEnd: Math.floor(totalSegments * 0.36),
    },
    {
      segmentStart: Math.floor(totalSegments * 0.45),
      segmentEnd: Math.floor(totalSegments * 0.48),
    },
    {
      segmentStart: Math.floor(totalSegments * 0.74),
      segmentEnd: Math.floor(totalSegments * 0.77),
    },
    // boost4 — see comment above.
    {
      segmentStart: SHORTCUT_SEG_END - 6,
      segmentEnd: SHORTCUT_SEG_END - 1,
    },
  ];

  // ---------------------------------------------------------------------------
  // Item box rows — placed only on wide, fast road (R >= 150 & hw >= 9).
  // Each box capped at ±(hw-1.5) lateral, spaced >= pickup diameter (3.8u).
  // ---------------------------------------------------------------------------
  const PICKUP_DIAMETER = 3.8;
  const itemBoxZones: ItemBoxZone[] = [];
  function addItemRow(frac: number, count: number) {
    const segIdx = Math.floor(totalSegments * frac);
    const seg = segments[segIdx];
    const hw = halfWidthAt(segIdx);
    const maxLateral = hw - 1.5;
    // Fan the boxes across the road, clamped so the outermost stays inside the
    // edge, and so neighbours never sit closer than a pickup diameter.
    const span = Math.min(
      2 * maxLateral,
      (count - 1) * Math.max(PICKUP_DIAMETER, (2 * maxLateral) / Math.max(1, count)),
    );
    const positions: Vec3[] = [];
    for (let b = 0; b < count; b++) {
      const lateral = count === 1 ? 0 : (b / (count - 1) - 0.5) * span;
      const y = Math.max(seg.left.y, seg.right.y, seg.center.y) + 1.2;
      positions.push({
        x: seg.center.x + seg.normal.x * lateral,
        y,
        z: seg.center.z + seg.normal.z * lateral,
      });
    }
    itemBoxZones.push({ segmentIndex: segIdx, positions });
  }
  addItemRow(0.18, 3); // T1 approach, R~207, hw~9.9
  addItemRow(0.43, 5); // WIDE back straight, R~509, hw~12.9 — 5 fan out
  addItemRow(0.78, 2); // after the flick, R huge, hw~10.3

  // ---------------------------------------------------------------------------
  // Checkpoints — NUM_CHECKPOINTS evenly spaced. cp0 sits at seg0 on the clean
  // start straight; all land on hw >= 9.7u and outside any overlap region.
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
  // Start grid positions — 4 karts in 2x2. BOTH rows are built from seg0.normal
  // so the grid stays symmetric even though seg0 heading is ~17deg off -Z (the
  // road is wide and straight here, and the grid is what defines the start line).
  // The back row trails the front line by BACK_ROW_GAP along -forward (>= 2 kart
  // lengths so it can't clip the front row at lights-out), NOT at a later segment
  // (which would hand the back row free race progress).
  // ---------------------------------------------------------------------------
  const startSeg0 = segments[0];
  const startHeading = Math.atan2(startSeg0.forward.x, startSeg0.forward.z);
  const BACK_ROW_GAP = 12;
  const GRID_LATERAL = 3.5; // <= hw-3 (seg0 hw ~11.4 → 8.4) PASS
  const backX = startSeg0.center.x - startSeg0.forward.x * BACK_ROW_GAP;
  const backY = startSeg0.center.y;
  const backZ = startSeg0.center.z - startSeg0.forward.z * BACK_ROW_GAP;

  const startPositions: Vec3[] = [
    // Row 1 (front)
    {
      x: startSeg0.center.x - startSeg0.normal.x * GRID_LATERAL,
      y: startSeg0.center.y + 0.5,
      z: startSeg0.center.z - startSeg0.normal.z * GRID_LATERAL,
    },
    {
      x: startSeg0.center.x + startSeg0.normal.x * GRID_LATERAL,
      y: startSeg0.center.y + 0.5,
      z: startSeg0.center.z + startSeg0.normal.z * GRID_LATERAL,
    },
    // Row 2 (back) — same start line, trailing the front row
    {
      x: backX - startSeg0.normal.x * GRID_LATERAL,
      y: backY + 0.5,
      z: backZ - startSeg0.normal.z * GRID_LATERAL,
    },
    {
      x: backX + startSeg0.normal.x * GRID_LATERAL,
      y: backY + 0.5,
      z: backZ + startSeg0.normal.z * GRID_LATERAL,
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

  // Neon pylons every 15 segments along the track, alternating left/right.
  const PYLON_COLORS = ["#FF00FF", "#00FFFF", "#FFFF00"];
  for (let i = 0; i < totalSegments; i += 15) {
    const seg = segments[i];
    const step = Math.floor(i / 15);
    const side = step % 2 === 0 ? 1 : -1; // alternate right/left
    const hw = halfWidthAt(i);
    const offset = hw + 4.0; // just outside the road edge
    const pylonY = side > 0 ? seg.right.y : seg.left.y;
    scenery.push({
      position: {
        x: seg.center.x + seg.normal.x * offset * side,
        y: pylonY,
        z: seg.center.z + seg.normal.z * offset * side,
      },
      type: "pylon",
      color: PYLON_COLORS[step % PYLON_COLORS.length],
      height: 8,
    });
  }

  // City blocks clustered around the slow technical complex (the cp12-16 bowl,
  // x:-44..-62 scaled). They FRAME the corner without blocking the main racing
  // line — every position is validated clear of the road corridor (guard §8).
  const blockSpecs: Array<{
    x: number;
    z: number;
    width: number;
    depth: number;
    height: number;
    color: string;
  }> = [
    { x: -558, z: -110, width: 14, depth: 14, height: 30, color: "#1A1A3E" },
    { x: -560, z: -40, width: 12, depth: 12, height: 24, color: "#2A1A4E" },
    { x: -548, z: 30, width: 11, depth: 11, height: 28, color: "#1A2A4E" },
    { x: -540, z: -160, width: 13, depth: 13, height: 22, color: "#2A2A3E" },
    { x: -520, z: -230, width: 12, depth: 12, height: 26, color: "#1A1A5E" },
    { x: -396, z: -78, width: 10, depth: 10, height: 20, color: "#2A1A4E" },
  ];
  for (const spec of blockSpecs) {
    scenery.push({
      position: { x: spec.x, y: 0, z: spec.z },
      type: "block",
      color: spec.color,
      height: spec.height,
      width: spec.width,
      depth: spec.depth,
    });
  }

  // ---------------------------------------------------------------------------
  // Build-time regression guard — re-derives radius / grade / hw / banking /
  // overlap / feature placement and fails loudly on any violation. Converts the
  // impossible-corner / self-overlap bug class into a hard error so future spline
  // edits cannot silently reintroduce it. (Skipped in production builds.)
  // ---------------------------------------------------------------------------
  if (typeof process === "undefined" || process.env.NODE_ENV !== "production") {
    assertNeonLayout({
      segments,
      totalSegments,
      boostZones,
      itemBoxZones,
      checkpoints,
      startPositions,
      blockSpecs,
      halfWidthAt,
      radiusAt,
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
    // No drivable shortcut on the neon circuit — TrackDefinition requires the
    // field, so an empty array (every consumer tolerates []; track1 ships [] too).
    shortcuts: [],
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
 * Get the respawn position for the nearest segment, facing forward.
 *
 * When a mesh-snapped racing line is supplied (track1, server-side) the kart is
 * respawned ONTO that on-mesh point — the authored segment centers diverge from
 * the baked road mesh by up to ~130 units, so respawning at seg.center would
 * drop the kart off-road and (for the far-off segments) immediately re-trigger
 * "falling". Without a line (neon-circuit, or the client which has no sampler)
 * the segment center is the road, so it is used directly.
 */
export function getRespawnPosition(
  segments: TrackSegment[],
  segIdx: number,
  racingLine?: Vec3[] | null,
): { position: Vec3; heading: number } {
  const seg = segments[segIdx];
  const anchor =
    racingLine && racingLine[segIdx] ? racingLine[segIdx] : seg.center;
  return {
    position: { x: anchor.x, y: anchor.y + 2.5, z: anchor.z },
    heading: Math.atan2(seg.forward.x, seg.forward.z),
  };
}

// ---------------------------------------------------------------------------
// Surface sampler seam (server-only road mesh, injected — never bundled here)
// ---------------------------------------------------------------------------

/**
 * The road-mesh surface queries the sim needs. The heightfield that backs them
 * is ~717KB and is intentionally kept out of this (client-imported) module: the
 * server registers a real implementation from track-heightfield.ts at startup,
 * and the client leaves it null so the shared physics step uses its centerline
 * fallback. This keeps the heightfield out of the browser bundle.
 */
export interface SurfaceSampler {
  /** Mesh height at XZ, or null outside the drivable surface */
  sampleRoadHeight(x: number, z: number): number | null;
  /** Distance in world units to the nearest road cell (0 = on road) */
  sampleRoadDistance(x: number, z: number, maxRings?: number): number;
}

let _track1Sampler: SurfaceSampler | null = null;

/** Called once at server startup (track-heightfield.ts) to wire the mesh. */
export function registerTrack1SurfaceSampler(sampler: SurfaceSampler): void {
  _track1Sampler = sampler;
}

/**
 * The surface sampler for a track, or null when none is registered (always the
 * case in the browser, and for non-track1 tracks which have no baked mesh).
 */
export function getSurfaceSampler(trackId: TrackId): SurfaceSampler | null {
  return trackId === "track1" ? _track1Sampler : null;
}

// ---------------------------------------------------------------------------
// Track registry cache (generated once, shared between server and client)
// ---------------------------------------------------------------------------

export const DEFAULT_TRACK_ID: TrackId = "track1";

// ---------------------------------------------------------------------------
// Track metadata — drives the lobby track picker + HUD (client-safe, no mesh)
// ---------------------------------------------------------------------------

export const TRACK_META: Record<TrackId, TrackMeta> = {
  track1: {
    id: "track1",
    displayName: "Sunset Speedway",
    theme: "desert",
    lengthM: 7200,
    difficulty: "medium",
  },
  "neon-circuit": {
    id: "neon-circuit",
    displayName: "Neon Circuit",
    theme: "neon",
    lengthM: 5000,
    difficulty: "hard",
  },
};

export function getTrackMeta(trackId: TrackId): TrackMeta {
  return TRACK_META[trackId] ?? TRACK_META[DEFAULT_TRACK_ID];
}

/** Metadata for every selectable track, in display order. */
export function listTracks(): TrackMeta[] {
  return listTrackIds().map((id) => TRACK_META[id]);
}

/** Validate an arbitrary value against the known track ids. */
export function isTrackId(value: unknown): value is TrackId {
  return value === "track1" || value === "neon-circuit";
}

/** Coerce an arbitrary value to a valid TrackId (default when unknown). */
export function coerceTrackId(value: unknown): TrackId {
  return isTrackId(value) ? value : DEFAULT_TRACK_ID;
}

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
