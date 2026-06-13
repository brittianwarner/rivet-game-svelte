/**
 * Server-only road-mesh surface sampling for track1.
 *
 * track1 ships a ~717KB baked heightfield (tracks/track1-heightfield.ts). That
 * data is needed ONLY by the authoritative sim (kart Y placement, surface
 * classification, projectile/hazard grounding). Keeping the import here — and
 * NOT in track.ts (which client components like Track.svelte / Minimap.svelte
 * import) — keeps the heightfield out of the browser bundle entirely.
 *
 * Importing this module registers the sampler into the client-safe seam in
 * track.ts (registerTrack1SurfaceSampler), so the shared physics step
 * (kart-physics.ts, run by both server and client) can reach the real surface
 * on the server while the client transparently falls back to the segment
 * centerline. ONLY the actor imports this module.
 */

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
import { registerTrack1SurfaceSampler } from "./track.js";

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
  if (h00 === null || h10 === null || h01 === null || h11 === null) {
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

// Wire the real track1 surface into the client-safe seam. The client never
// imports this module, so the sampler stays unregistered there and the shared
// physics step uses its centerline fallback.
registerTrack1SurfaceSampler({ sampleRoadHeight, sampleRoadDistance });
