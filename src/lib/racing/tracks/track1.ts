import {
  NUM_CHECKPOINTS,
  type BoostZone,
  type CheckpointDef,
  type ItemBoxZone,
  type TrackDefinition,
  type TrackPoint,
  type TrackSegment,
  type TrackVisualDefinition,
  type Vec3,
} from "../types.js";
import { TRACK1_CENTERS, TRACK1_WIDTHS } from "./track1-generated.js";

/**
 * World units the back grid row trails BEHIND the front line (~one kart-length).
 * The back row used to be placed at a LATER segment (segments[3]) which sits
 * AHEAD in race direction — handing grid slots 3-4 a free head start because
 * raceProgress grows with segment distance. It now sits behind the start line.
 */
const TRACK1_BACK_ROW_GAP = 8;

const TRACK1_VISUAL = {
  kind: "gltf",
  modelPath: "/track1/source_gltf/scene.gltf",
  transform: {
    position: {
      x: -240.4957530261819 * 5,
      y: 15.327628805206947 * 5,
      z: -232.70588146332116 * 5,
    },
    rotation: { x: 0, y: -1.3089969389957472, z: 0 },
    scale: {
      x: 1.0928561025018675 * 5,
      y: 0.32822438841686713 * 5,
      z: 1.0928561025018675 * 5,
    },
  },
} satisfies TrackVisualDefinition;

// ---------------------------------------------------------------------------
// Item rows & boost pads — authored against the 400-segment baked loop
// (~7,200 world units).
//
// IMPORTANT: TRACK1_CENTERS diverges from the baked road-mesh heightfield
// (the surface karts actually drive and the on-road test samples) by up to
// ~130 units along long stretches of the loop. Every segment below was
// verified offline against the heightfield: the full lateral band
// (fractions 0.2-0.8 between left/right edges) sits on the mesh
// (sampleRoadDistance = 0) with centerline Y within ~1 unit of the sampled
// mesh height. Do not move these picks without re-checking that agreement.
// ---------------------------------------------------------------------------

/**
 * One row of item boxes per entry, spread laterally across the road.
 * meshYLift compensates where the banked road mesh rises above the
 * (flat) centerline Y so boxes never sink into the surface.
 * - 74:  exit of the first sweeper complex (~14.6% of the loop)
 * - 133: the dead-straight valley run (~27.4%)
 * - 303: the plateau straight before the final descent (~74.3%)
 */
const TRACK1_ITEM_ROWS: { segmentIndex: number; meshYLift: number }[] = [
  { segmentIndex: 74, meshYLift: 0 },
  { segmentIndex: 133, meshYLift: 0 },
  { segmentIndex: 303, meshYLift: 1.6 },
];

/** Lateral box placement across the road, as left→right edge fractions. */
const TRACK1_ITEM_ROW_FRACTIONS = [0.2, 0.4, 0.6, 0.8];

/** Boxes hover above the road surface (matches the neon-circuit rows). */
const TRACK1_ITEM_BOX_HOVER = 1.2;

/**
 * Boost pads on mesh-verified straights (zones are segment-index ranges;
 * the kart's nearest-segment cache drives isInBoostZone).
 * - 83-86:   flat straight after item row 1 (~16.5%)
 * - 154-158: downhill chute into the valley (~31%)
 * - 256-260: the hairpin exit lane — reward for rounding the tip (~59%)
 * - 393-399: the run to the start/finish line (~99%)
 */
const TRACK1_BOOST_ZONES: BoostZone[] = [
  { segmentStart: 83, segmentEnd: 86 },
  { segmentStart: 154, segmentEnd: 158 },
  { segmentStart: 256, segmentEnd: 260 },
  { segmentStart: 393, segmentEnd: 399 },
];

function distance3(a: Vec3, b: Vec3): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function buildSegments(): TrackSegment[] {
  const n = TRACK1_CENTERS.length;
  const segments: TrackSegment[] = [];
  let cumDist = 0;

  for (let i = 0; i < n; i++) {
    const [cx, cy, cz] = TRACK1_CENTERS[i];
    const [nx2, ny2, nz2] = TRACK1_CENTERS[(i + 1) % n];
    const center: Vec3 = { x: cx, y: cy, z: cz };
    const hw = TRACK1_WIDTHS[i] / 2;

    if (i > 0) {
      const [px, py, pz] = TRACK1_CENTERS[i - 1];
      cumDist += Math.sqrt((cx-px)**2 + (cy-py)**2 + (cz-pz)**2);
    }

    const dx = nx2 - cx;
    const dy = ny2 - cy;
    const dz = nz2 - cz;
    const fLen = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const forward: Vec3 = { x: dx / fLen, y: dy / fLen, z: dz / fLen };

    const nLen = Math.sqrt(forward.z * forward.z + forward.x * forward.x) || 1;
    const normal: Vec3 = {
      x: -forward.z / nLen,
      y: 0,
      z: forward.x / nLen,
    };

    segments.push({
      center,
      left: {
        x: cx - normal.x * hw,
        y: cy,
        z: cz - normal.z * hw,
      },
      right: {
        x: cx + normal.x * hw,
        y: cy,
        z: cz + normal.z * hw,
      },
      forward,
      normal,
      distance: cumDist,
    });
  }

  return segments;
}

function buildItemBoxZones(segments: TrackSegment[]): ItemBoxZone[] {
  return TRACK1_ITEM_ROWS.map(({ segmentIndex, meshYLift }) => {
    const seg = segments[segmentIndex];
    const positions: Vec3[] = TRACK1_ITEM_ROW_FRACTIONS.map((t) => ({
      x: seg.left.x + (seg.right.x - seg.left.x) * t,
      y: seg.center.y + meshYLift + TRACK1_ITEM_BOX_HOVER,
      z: seg.left.z + (seg.right.z - seg.left.z) * t,
    }));
    return { segmentIndex, positions };
  });
}

// ---------------------------------------------------------------------------
// Checkpoints — arc-length distributed, hairpin-pinch aware
// ---------------------------------------------------------------------------

/** Matches checkpointTick's ±5%-of-loop segment-index collection window. */
const CHECKPOINT_WINDOW_FRACTION = 0.05;

/**
 * Edge-to-edge XZ gap (world units) below which two non-adjacent parts of
 * the loop count as a pinch. The hairpin's opposing lanes overlap here
 * (negative gap), while ordinary corners stay hundreds of units apart.
 */
const PINCH_EDGE_GAP = 4;

function segmentHalfWidthXZ(seg: TrackSegment): number {
  const dx = seg.right.x - seg.left.x;
  const dz = seg.right.z - seg.left.z;
  return Math.sqrt(dx * dx + dz * dz) / 2;
}

/**
 * Find the opposing-lane partner of a segment: the nearest segment beyond
 * the checkpoint collection window whose road edge comes within
 * PINCH_EDGE_GAP units in XZ. Returns -1 when the loop never folds back on
 * itself near this segment.
 */
function findPinchPartner(segments: TrackSegment[], idx: number): number {
  const n = segments.length;
  const guard = Math.ceil(n * CHECKPOINT_WINDOW_FRACTION);
  const seg = segments[idx];
  const hw = segmentHalfWidthXZ(seg);

  let best = -1;
  let bestGap = PINCH_EDGE_GAP;
  for (let j = 0; j < n; j++) {
    const direct = Math.abs(j - idx);
    const wrapped = Math.min(direct, n - direct);
    if (wrapped <= guard) continue;

    const other = segments[j];
    const dx = other.center.x - seg.center.x;
    const dz = other.center.z - seg.center.z;
    const gap = Math.sqrt(dx * dx + dz * dz) - hw - segmentHalfWidthXZ(other);
    if (gap < bestGap) {
      bestGap = gap;
      best = j;
    }
  }
  return best;
}

/**
 * Distribute NUM_CHECKPOINTS checkpoints by cumulative arc length (segments
 * are unevenly spaced, so index-based spacing bunched checkpoints in dense
 * regions). Any checkpoint that lands where opposing lanes pinch together —
 * the hairpin, where the actor's ±5% index window is satisfiable from the
 * approach lane without rounding the turn — is nudged to the hairpin tip:
 * the midpoint of the loop arc enclosed between the two pinched lanes.
 */
function buildCheckpoints(segments: TrackSegment[]): CheckpointDef[] {
  const n = segments.length;
  const last = segments[n - 1];
  const totalLength = last.distance + distance3(last.center, segments[0].center);

  const cps: CheckpointDef[] = [];
  let searchFrom = 0;

  for (let i = 0; i < NUM_CHECKPOINTS; i++) {
    const targetDist = (i / NUM_CHECKPOINTS) * totalLength;

    // Last segment at or before the target arc distance (monotonic walk).
    let idx = searchFrom;
    while (idx + 1 < n && segments[idx + 1].distance <= targetDist) idx++;
    searchFrom = idx;

    const partner = findPinchPartner(segments, idx);
    if (partner !== -1) {
      // Nudge to the tip: midpoint of the shorter arc between the lanes.
      const forwardSpan = (partner - idx + n) % n;
      const tip =
        forwardSpan <= n - forwardSpan
          ? (idx + Math.round(forwardSpan / 2)) % n
          : (partner + Math.round((n - forwardSpan) / 2)) % n;
      // Keep exactly NUM_CHECKPOINTS checkpoints in track order.
      const prevIdx = cps.length > 0 ? cps[cps.length - 1].segmentIndex : -1;
      if (tip > prevIdx) idx = tip;
    }

    const seg = segments[idx];
    cps.push({
      segmentIndex: idx,
      center: { ...seg.center },
      normal: { ...seg.forward },
    });
  }
  return cps;
}

function buildStartPositions(segments: TrackSegment[]): Vec3[] {
  const front = segments[0];
  const laneOffset = TRACK1_WIDTHS[0] * 0.15;

  // The back row shares the front row's segment (same start line, same normal +
  // heading) but is shifted one kart-length BEHIND along the negative forward,
  // so it trails the front row instead of leading it. The start-line region is
  // on the road mesh, so this small backward shift stays on-road.
  const rows = [
    { center: front.center, normal: front.normal },
    { center: front.center, normal: front.normal },
    {
      center: {
        x: front.center.x - front.forward.x * TRACK1_BACK_ROW_GAP,
        y: front.center.y,
        z: front.center.z - front.forward.z * TRACK1_BACK_ROW_GAP,
      },
      normal: front.normal,
    },
    {
      center: {
        x: front.center.x - front.forward.x * TRACK1_BACK_ROW_GAP,
        y: front.center.y,
        z: front.center.z - front.forward.z * TRACK1_BACK_ROW_GAP,
      },
      normal: front.normal,
    },
  ];

  return rows.map((row, i) => {
    const side = i % 2 === 0 ? -1 : 1;
    return {
      x: row.center.x + row.normal.x * laneOffset * side,
      y: row.center.y + 2.5,
      z: row.center.z + row.normal.z * laneOffset * side,
    };
  });
}

export function buildTrack1Definition(): TrackDefinition {
  const segments = buildSegments();
  const last = segments[segments.length - 1];
  const totalLength = last.distance + distance3(last.center, segments[0].center);

  const points: TrackPoint[] = segments
    .filter((_, i) => i % 10 === 0)
    .map((seg, idx) => ({
      x: seg.center.x,
      y: seg.center.y,
      z: seg.center.z,
      width: TRACK1_WIDTHS[idx * 10] ?? TRACK1_WIDTHS[0],
    }));

  return {
    points,
    segments,
    totalLength,
    boostZones: TRACK1_BOOST_ZONES,
    itemBoxZones: buildItemBoxZones(segments),
    checkpoints: buildCheckpoints(segments),
    startPositions: buildStartPositions(segments),
    startHeading: Math.atan2(segments[0].forward.x, segments[0].forward.z),
    shortcuts: [],
    scenery: [],
    visual: TRACK1_VISUAL,
  };
}
