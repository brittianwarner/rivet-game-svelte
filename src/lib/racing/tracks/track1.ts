import {
  NUM_CHECKPOINTS,
  type CheckpointDef,
  type TrackDefinition,
  type TrackPoint,
  type TrackSegment,
  type TrackVisualDefinition,
  type Vec3,
} from "../types.js";
import { TRACK1_CENTERS, TRACK1_WIDTHS } from "./track1-generated.js";

const TRACK1_BACK_ROW_OFFSET = 3;

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

function buildCheckpoints(segments: TrackSegment[]): CheckpointDef[] {
  const cps: CheckpointDef[] = [];
  for (let i = 0; i < NUM_CHECKPOINTS; i++) {
    const idx = Math.floor((i / NUM_CHECKPOINTS) * segments.length);
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
  const back = segments[TRACK1_BACK_ROW_OFFSET];
  const laneOffset = TRACK1_WIDTHS[0] * 0.15;

  return [front, front, back, back].map((seg, i) => {
    const side = i % 2 === 0 ? -1 : 1;
    return {
      x: seg.center.x + seg.normal.x * laneOffset * side,
      y: seg.center.y + 2.5,
      z: seg.center.z + seg.normal.z * laneOffset * side,
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
    boostZones: [],
    itemBoxZones: [],
    checkpoints: buildCheckpoints(segments),
    startPositions: buildStartPositions(segments),
    startHeading: Math.atan2(segments[0].forward.x, segments[0].forward.z),
    shortcuts: [],
    scenery: [],
    visual: TRACK1_VISUAL,
  };
}
