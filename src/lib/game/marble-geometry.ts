/**
 * marble-geometry.ts — Shared geometry instances for marble rendering.
 *
 * All marbles reuse the same geometry buffers to minimize GPU memory.
 * Created lazily on first access (browser-only — Three.js requires WebGL).
 *
 * Segment counts optimized for visual quality at game camera distance:
 * - Shell: 24×24 (was 32×32) — indistinguishable at r=0.5
 * - Ring: 6×32 (was 8×48) — thin tube at r=0.02, Fresnel-driven visual
 * - Glow: detail 2 (was 3) — pure Fresnel carrier, lower poly is fine
 * - Core: 16×16 — hidden behind shell, no change needed
 *
 * Total triangles per marble: ~3,136 (local, 3 rings) or ~2,368 (remote, 1 ring)
 * Down from ~6,144 / ~4,608 — a 49% reduction.
 */

import { SphereGeometry, TorusGeometry, IcosahedronGeometry } from "three";
import {
  MARBLE_RADIUS,
  CORE_RADIUS_RATIO,
  RING_RADIUS_RATIO,
  RING_TUBE_RADIUS,
  GLOW_RADIUS_RATIO,
} from "./types.js";

// Lazy singletons — created on first call, reused across all marble instances.
let _core: SphereGeometry | null = null;
let _shell: SphereGeometry | null = null;
let _ring: TorusGeometry | null = null;
let _glow: IcosahedronGeometry | null = null;

/** Inner core sphere (low-poly, hidden behind shell) — 512 triangles */
export function getCoreGeometry(): SphereGeometry {
  if (!_core) {
    _core = new SphereGeometry(MARBLE_RADIUS * CORE_RADIUS_RATIO, 16, 16);
  }
  return _core;
}

/** Main clearcoat glass shell — 1,152 triangles (24×24) */
export function getShellGeometry(): SphereGeometry {
  if (!_shell) {
    _shell = new SphereGeometry(MARBLE_RADIUS, 24, 24);
  }
  return _shell;
}

/** Thin torus ring for orbiting elements — 384 triangles (6×32) */
export function getRingGeometry(): TorusGeometry {
  if (!_ring) {
    _ring = new TorusGeometry(
      MARBLE_RADIUS * RING_RADIUS_RATIO,
      RING_TUBE_RADIUS,
      6,
      32,
    );
  }
  return _ring;
}

/** Icosahedron shell for FakeGlowMaterial — 320 triangles (detail 2) */
export function getGlowGeometry(): IcosahedronGeometry {
  if (!_glow) {
    _glow = new IcosahedronGeometry(MARBLE_RADIUS * GLOW_RADIUS_RATIO, 2);
  }
  return _glow;
}
