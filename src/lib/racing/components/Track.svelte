<!--
  Track.svelte — Procedural racing track renderer.

  Builds all track geometry from the TrackDefinition returned by getTrack():
  road surface, edge walls, boost pads, start/finish line, center dashes,
  wall-top LED strips, boost pad chevrons, track-side scenery, and a ground
  plane beneath everything. Dark/neon aesthetic.

  Elevation: geometry builders now use actual Y values from segments.
-->
<script lang="ts">
	import { T, useTask } from "@threlte/core";
	import { onMount, onDestroy } from "svelte";
	import * as THREE from "three";
	import {
		BufferGeometry,
		Float32BufferAttribute,
		DoubleSide,
		FrontSide,
	} from "three";
	import { getRaceStore } from "$lib/racing/context.js";
	import Track1Model from "./Track1Model.svelte";
	import { DEFAULT_TRACK_ID, getTrack } from "../track.js";
	import { TRACK_WALL_HEIGHT } from "../types.js";

	// -----------------------------------------------------------------------
	// Track data (generated once, cached)
	// -----------------------------------------------------------------------

	const store = getRaceStore();
	const track = getTrack(store.trackId || DEFAULT_TRACK_ID);
	const { segments, boostZones } = track;
	const segCount = segments.length;
	const isProceduralTrack = track.visual.kind === "procedural";
	const gltfVisual = track.visual.kind === "gltf" ? track.visual : null;
	const overlayScale = isProceduralTrack ? 1 : 5;

	// -----------------------------------------------------------------------
	// Geometry references — built on mount, disposed on destroy
	// -----------------------------------------------------------------------

	let roadGeo: BufferGeometry | null = $state(null);
	let leftWallGeo: BufferGeometry | null = $state(null);
	let rightWallGeo: BufferGeometry | null = $state(null);
	let startLineGeo: BufferGeometry | null = $state(null);
	let centerDashGeo: BufferGeometry | null = $state(null);
	let boostGeos: BufferGeometry[] = $state([]);
	let leftLedGeo: BufferGeometry | null = $state(null);
	let rightLedGeo: BufferGeometry | null = $state(null);

	// Neon headline EDGE STRIPS — crisp glowing ribbons flush with the road edge.
	let leftEdgeStripGeo: BufferGeometry | null = $state(null);
	let rightEdgeStripGeo: BufferGeometry | null = $state(null);

	// Neon GRID VOID ground (manually new'd THREE.GridHelper — must be disposed).
	let neonGrid: THREE.GridHelper | null = $state(null);

	// Start/finish checker banner texture (manually new'd CanvasTexture — disposed).
	let checkerTexture: THREE.CanvasTexture | null = $state(null);

	// -----------------------------------------------------------------------
	// Neon palette (4-color language). cyan=LEFT edge/side, magenta=RIGHT
	// edge/side, green=boost. (amber #FFD93D = item boxes, rendered in
	// ItemBox.svelte.) Lock these everywhere so players read drift direction.
	// -----------------------------------------------------------------------
	const NEON_CYAN = 0x00e5ff;
	const NEON_MAGENTA = 0xff2bd6;
	const NEON_GREEN = 0x00ffa3;

	// Boost chevron groups — animated arrow shapes above boost pads
	interface ChevronData {
		positions: { x: number; y: number; z: number }[];
		forward: { x: number; z: number };
		center: { x: number; y: number; z: number };
	}
	let boostChevrons: ChevronData[] = $state([]);

	// Track-side scenery from track definition
	interface SceneryItem {
		position: { x: number; y: number; z: number };
		type: string;
		color: string;
		height: number;
		width?: number;
		depth?: number;
	}
	let sceneryItems: SceneryItem[] = $state([]);

	// Chevron animation time
	let chevronTime = $state(0);

	// Checkpoint-gate flash phase (0 = full side color, 1 = flashed white).
	let gateFlash = $state(0);

	/** Base gate color for checkpoint index i: alternating cyan / magenta. */
	function gateBaseHex(i: number): number {
		return i % 2 === 0 ? NEON_CYAN : NEON_MAGENTA;
	}
	/** Gate color mixed toward white by the current flash phase (reactive). */
	function gateFlashColor(i: number, flash: number): THREE.Color {
		return new THREE.Color(gateBaseHex(i)).lerp(new THREE.Color(0xffffff), flash);
	}

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	/**
	 * Build a quad strip from two parallel edge arrays (closed loop).
	 * Each quad = 2 triangles. Returns a BufferGeometry with position + normal.
	 * Properly handles varying Y values for elevation.
	 */
	function buildQuadStrip(
		edgeA: { x: number; y: number; z: number }[],
		edgeB: { x: number; y: number; z: number }[],
		close: boolean,
	): BufferGeometry {
		const count = edgeA.length;
		const quads = close ? count : count - 1;
		const positions = new Float32Array(quads * 6 * 3);
		const normals = new Float32Array(quads * 6 * 3);

		let vi = 0;
		for (let i = 0; i < quads; i++) {
			const ni = (i + 1) % count;

			const a0 = edgeA[i];
			const b0 = edgeB[i];
			const a1 = edgeA[ni];
			const b1 = edgeB[ni];

			// Triangle 1: a0, b0, a1
			positions[vi] = a0.x; positions[vi + 1] = a0.y; positions[vi + 2] = a0.z;
			positions[vi + 3] = b0.x; positions[vi + 4] = b0.y; positions[vi + 5] = b0.z;
			positions[vi + 6] = a1.x; positions[vi + 7] = a1.y; positions[vi + 8] = a1.z;

			// Triangle 2: a1, b0, b1
			positions[vi + 9] = a1.x; positions[vi + 10] = a1.y; positions[vi + 11] = a1.z;
			positions[vi + 12] = b0.x; positions[vi + 13] = b0.y; positions[vi + 14] = b0.z;
			positions[vi + 15] = b1.x; positions[vi + 16] = b1.y; positions[vi + 17] = b1.z;

			// Compute face normal from cross product for proper elevation handling
			const e1x = b0.x - a0.x, e1y = b0.y - a0.y, e1z = b0.z - a0.z;
			const e2x = a1.x - a0.x, e2y = a1.y - a0.y, e2z = a1.z - a0.z;
			let nx = e1y * e2z - e1z * e2y;
			let ny = e1z * e2x - e1x * e2z;
			let nz = e1x * e2y - e1y * e2x;
			const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
			nx /= nLen; ny /= nLen; nz /= nLen;
			// Ensure normal points upward
			if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }

			for (let n = 0; n < 6; n++) {
				normals[vi + n * 3] = nx;
				normals[vi + n * 3 + 1] = ny;
				normals[vi + n * 3 + 2] = nz;
			}

			vi += 18;
		}

		const geo = new BufferGeometry();
		geo.setAttribute("position", new Float32BufferAttribute(positions, 3));
		geo.setAttribute("normal", new Float32BufferAttribute(normals, 3));
		return geo;
	}

	/**
	 * Build a wall strip along one edge of the track (vertical quad strip).
	 * Bottom edge = edge positions at their actual Y values.
	 * Top edge = same positions raised by height from their base Y.
	 * Properly handles elevation.
	 */
	function buildWallStrip(
		edge: { x: number; y: number; z: number }[],
		height: number,
		outwardNormals: { x: number; z: number }[],
	): BufferGeometry {
		const count = edge.length;
		const quads = count; // closed loop
		const positions = new Float32Array(quads * 6 * 3);
		const normals = new Float32Array(quads * 6 * 3);

		let vi = 0;
		for (let i = 0; i < quads; i++) {
			const ni = (i + 1) % count;

			// Bottom and top positions using actual Y from edge data
			const bx0 = edge[i].x, by0 = edge[i].y, bz0 = edge[i].z;
			const tx0 = bx0, ty0 = by0 + height, tz0 = bz0;
			const bx1 = edge[ni].x, by1 = edge[ni].y, bz1 = edge[ni].z;
			const tx1 = bx1, ty1 = by1 + height, tz1 = bz1;

			// Outward-facing normal (averaged between i and ni for smoothness)
			const nx = (outwardNormals[i].x + outwardNormals[ni].x) * 0.5;
			const nz = (outwardNormals[i].z + outwardNormals[ni].z) * 0.5;
			const nLen = Math.sqrt(nx * nx + nz * nz) || 1;
			const nnx = nx / nLen;
			const nnz = nz / nLen;

			// Triangle 1: bottom0, top0, bottom1
			positions[vi] = bx0; positions[vi + 1] = by0; positions[vi + 2] = bz0;
			positions[vi + 3] = tx0; positions[vi + 4] = ty0; positions[vi + 5] = tz0;
			positions[vi + 6] = bx1; positions[vi + 7] = by1; positions[vi + 8] = bz1;

			// Triangle 2: bottom1, top0, top1
			positions[vi + 9] = bx1; positions[vi + 10] = by1; positions[vi + 11] = bz1;
			positions[vi + 12] = tx0; positions[vi + 13] = ty0; positions[vi + 14] = tz0;
			positions[vi + 15] = tx1; positions[vi + 16] = ty1; positions[vi + 17] = tz1;

			for (let n = 0; n < 6; n++) {
				normals[vi + n * 3] = nnx;
				normals[vi + n * 3 + 1] = 0;
				normals[vi + n * 3 + 2] = nnz;
			}

			vi += 18;
		}

		const geo = new BufferGeometry();
		geo.setAttribute("position", new Float32BufferAttribute(positions, 3));
		geo.setAttribute("normal", new Float32BufferAttribute(normals, 3));
		return geo;
	}

	/**
	 * Build a thin LED strip along the top of a wall edge.
	 * Runs along the wall top at y = edge.y + TRACK_WALL_HEIGHT.
	 * Width of strip ~0.08, extends slightly outward from the wall.
	 */
	function buildLedStrip(
		edge: { x: number; y: number; z: number }[],
		outwardNormals: { x: number; z: number }[],
		height: number,
		stripWidth: number,
	): BufferGeometry {
		const count = edge.length;
		const quads = count;
		const positions = new Float32Array(quads * 6 * 3);
		const normals = new Float32Array(quads * 6 * 3);

		let vi = 0;
		for (let i = 0; i < quads; i++) {
			const ni = (i + 1) % count;

			const ey0 = edge[i].y + height;
			const ey1 = edge[ni].y + height;
			const nx0 = outwardNormals[i].x, nz0 = outwardNormals[i].z;
			const nx1 = outwardNormals[ni].x, nz1 = outwardNormals[ni].z;

			// Inner edge (at wall top)
			const ix0 = edge[i].x, iz0 = edge[i].z;
			const ix1 = edge[ni].x, iz1 = edge[ni].z;

			// Outer edge (shifted outward by strip width)
			const ox0 = ix0 + nx0 * stripWidth;
			const oz0 = iz0 + nz0 * stripWidth;
			const ox1 = ix1 + nx1 * stripWidth;
			const oz1 = iz1 + nz1 * stripWidth;

			// Triangle 1
			positions[vi] = ix0; positions[vi + 1] = ey0; positions[vi + 2] = iz0;
			positions[vi + 3] = ox0; positions[vi + 4] = ey0; positions[vi + 5] = oz0;
			positions[vi + 6] = ix1; positions[vi + 7] = ey1; positions[vi + 8] = iz1;

			// Triangle 2
			positions[vi + 9] = ix1; positions[vi + 10] = ey1; positions[vi + 11] = iz1;
			positions[vi + 12] = ox0; positions[vi + 13] = ey0; positions[vi + 14] = oz0;
			positions[vi + 15] = ox1; positions[vi + 16] = ey1; positions[vi + 17] = oz1;

			// Up-facing normals
			for (let n = 0; n < 6; n++) {
				normals[vi + n * 3] = 0;
				normals[vi + n * 3 + 1] = 1;
				normals[vi + n * 3 + 2] = 0;
			}

			vi += 18;
		}

		const geo = new BufferGeometry();
		geo.setAttribute("position", new Float32BufferAttribute(positions, 3));
		geo.setAttribute("normal", new Float32BufferAttribute(normals, 3));
		return geo;
	}

	/**
	 * Determine the per-segment wall-top LED color override.
	 * Returns boost-green near boost zones, white near checkpoints, or null to
	 * fall back to the per-side base color (cyan on the left, magenta on the
	 * right). All returned colors are pre-multiplied so they bloom (>1.0).
	 */
	function getLedColor(segIdx: number): THREE.Color | null {
		// Check if near a boost zone → on-palette neon green.
		for (const bz of boostZones) {
			if (segIdx >= bz.segmentStart - 5 && segIdx <= bz.segmentEnd + 5) {
				return new THREE.Color(NEON_GREEN).multiplyScalar(1.8);
			}
		}
		// Check if near a checkpoint → white-hot.
		for (const cp of track.checkpoints) {
			const diff = Math.abs(segIdx - cp.segmentIndex);
			if (diff < 4 || diff > segCount - 4) {
				return new THREE.Color(0xffffff).multiplyScalar(1.8);
			}
		}
		return null;
	}

	/**
	 * Build a per-vertex color buffer for a wall-top LED strip so boost/checkpoint
	 * adjacent segments tint green/white while the rest carry the side base color.
	 * Mirrors buildLedStrip's quad layout (count quads × 6 verts).
	 */
	function buildLedColors(
		count: number,
		baseColor: THREE.Color,
	): Float32BufferAttribute {
		const colors = new Float32Array(count * 6 * 3);
		let vi = 0;
		for (let i = 0; i < count; i++) {
			const override = getLedColor(i);
			const c = override ?? baseColor;
			for (let n = 0; n < 6; n++) {
				colors[vi] = c.r;
				colors[vi + 1] = c.g;
				colors[vi + 2] = c.b;
				vi += 3;
			}
		}
		return new Float32BufferAttribute(colors, 3);
	}

	// -----------------------------------------------------------------------
	// Build all geometries on mount
	// -----------------------------------------------------------------------

	onMount(() => {
		const lefts = segments.map((s) => s.left);
		const rights = segments.map((s) => s.right);

		if (isProceduralTrack) {
			// -- Road surface --
			roadGeo = buildQuadStrip(lefts, rights, true);

			// -- Wall strips (now using actual Y values from edges) --
			const leftNormals = segments.map((s) => ({ x: -s.normal.x, z: -s.normal.z }));
			leftWallGeo = buildWallStrip(lefts, TRACK_WALL_HEIGHT, leftNormals);

			const rightNormals = segments.map((s) => ({ x: s.normal.x, z: s.normal.z }));
			rightWallGeo = buildWallStrip(rights, TRACK_WALL_HEIGHT, rightNormals);

			// -- Wall-top LED strips (widened 0.08 -> 0.25, vertex-colored per side) --
			leftLedGeo = buildLedStrip(lefts, leftNormals, TRACK_WALL_HEIGHT, 0.25);
			rightLedGeo = buildLedStrip(rights, rightNormals, TRACK_WALL_HEIGHT, 0.25);
			leftLedGeo.setAttribute(
				"color",
				buildLedColors(segCount, new THREE.Color(NEON_CYAN).multiplyScalar(1.8)),
			);
			rightLedGeo.setAttribute(
				"color",
				buildLedColors(segCount, new THREE.Color(NEON_MAGENTA).multiplyScalar(1.8)),
			);

			// -- HEADLINE edge strips — crisp neon ribbons flush at the road surface.
			// Inset ~0.3u from the true edge, lifted ~0.02u, 0.6u wide, flat-up.
			// Run them along an inset edge so the strip sits ON the road, not the wall.
			const STRIP_INSET = 0.3;
			const STRIP_LIFT = 0.02;
			const STRIP_WIDTH = 0.6;
			// inward normals (toward road center) for inset; strip then grows outward.
			const leftInset = segments.map((s) => ({
				x: s.left.x + s.normal.x * STRIP_INSET,
				y: s.left.y,
				z: s.left.z + s.normal.z * STRIP_INSET,
			}));
			const rightInset = segments.map((s) => ({
				x: s.right.x - s.normal.x * STRIP_INSET,
				y: s.right.y,
				z: s.right.z - s.normal.z * STRIP_INSET,
			}));
			// outward normals point back toward the true edge so the strip hugs it.
			const leftStripNormals = segments.map((s) => ({ x: -s.normal.x, z: -s.normal.z }));
			const rightStripNormals = segments.map((s) => ({ x: s.normal.x, z: s.normal.z }));
			leftEdgeStripGeo = buildLedStrip(leftInset, leftStripNormals, STRIP_LIFT, STRIP_WIDTH);
			rightEdgeStripGeo = buildLedStrip(rightInset, rightStripNormals, STRIP_LIFT, STRIP_WIDTH);
		}

		// -- Boost pad geometry --
		const BOOST_Y = 0.03 * overlayScale;
		const newBoostGeos: BufferGeometry[] = [];
		const newChevrons: ChevronData[] = [];

		for (const bz of boostZones) {
			const boostLefts: { x: number; y: number; z: number }[] = [];
			const boostRights: { x: number; y: number; z: number }[] = [];
			for (let i = bz.segmentStart; i <= bz.segmentEnd && i < segCount; i++) {
				const seg = segments[i];
				const hw = Math.sqrt(
					(seg.right.x - seg.left.x) ** 2 + (seg.right.z - seg.left.z) ** 2,
				) / 2;
				const boostHw = hw * 0.6;
				boostLefts.push({
					x: seg.center.x - seg.normal.x * boostHw,
					y: seg.center.y + BOOST_Y,
					z: seg.center.z - seg.normal.z * boostHw,
				});
				boostRights.push({
					x: seg.center.x + seg.normal.x * boostHw,
					y: seg.center.y + BOOST_Y,
					z: seg.center.z + seg.normal.z * boostHw,
				});
			}

			if (boostLefts.length >= 2) {
				newBoostGeos.push(buildQuadStrip(boostLefts, boostRights, false));
			}

			// Build chevron data for animation
			const midIdx = Math.floor((bz.segmentStart + bz.segmentEnd) / 2);
			const midSeg = segments[Math.min(midIdx, segCount - 1)];
			const chevronPositions: { x: number; y: number; z: number }[] = [];
			// Place 4 chevrons evenly across the boost zone
			const span = bz.segmentEnd - bz.segmentStart;
			for (let c = 0; c < 4; c++) {
				const idx = Math.min(bz.segmentStart + Math.floor(span * c / 4), segCount - 1);
				const s = segments[idx];
				chevronPositions.push({
					x: s.center.x,
					y: s.center.y + 0.06 * overlayScale,
					z: s.center.z,
				});
			}
			newChevrons.push({
				positions: chevronPositions,
				forward: { x: midSeg.forward.x, z: midSeg.forward.z },
				center: { x: midSeg.center.x, y: midSeg.center.y, z: midSeg.center.z },
			});
		}
		boostGeos = newBoostGeos;
		boostChevrons = newChevrons;

		// -- Track-side scenery --
		const trackScenery = (track as any).scenery;
		if (isProceduralTrack && Array.isArray(trackScenery)) {
			sceneryItems = trackScenery;
		}

		// -- Start/finish line --
		const s0 = segments[0];
		const startLineYOffset = 0.02 * overlayScale;
		const lineWidth = 0.5 * overlayScale;
		const startLineVerts = new Float32Array([
			s0.left.x, s0.left.y + startLineYOffset, s0.left.z,
			s0.right.x, s0.right.y + startLineYOffset, s0.right.z,
			s0.left.x + s0.forward.x * lineWidth, s0.left.y + startLineYOffset, s0.left.z + s0.forward.z * lineWidth,
			s0.left.x + s0.forward.x * lineWidth, s0.left.y + startLineYOffset, s0.left.z + s0.forward.z * lineWidth,
			s0.right.x, s0.right.y + startLineYOffset, s0.right.z,
			s0.right.x + s0.forward.x * lineWidth, s0.right.y + startLineYOffset, s0.right.z + s0.forward.z * lineWidth,
		]);
		const startLineNorms = new Float32Array([
			0, 1, 0, 0, 1, 0, 0, 1, 0,
			0, 1, 0, 0, 1, 0, 0, 1, 0,
		]);
		const slGeo = new BufferGeometry();
		slGeo.setAttribute("position", new Float32BufferAttribute(startLineVerts, 3));
		slGeo.setAttribute("normal", new Float32BufferAttribute(startLineNorms, 3));
		startLineGeo = slGeo;

		// -- Center line dashes --
		if (isProceduralTrack) {
			const DASH_LENGTH = 4;
			const GAP_LENGTH = 5;
			const DASH_HALF_WIDTH = 0.35 * overlayScale;
			const DASH_Y_OFFSET = 0.04 * overlayScale;
			const dashPositions: number[] = [];
			const dashNormals: number[] = [];

			let segIdx = 0;
			while (segIdx < segCount) {
				const dashEnd = Math.min(segIdx + DASH_LENGTH, segCount);
				for (let i = segIdx; i < dashEnd - 1; i++) {
					const curr = segments[i];
					const next = segments[(i + 1) % segCount];

					const cl_x = curr.center.x - curr.normal.x * DASH_HALF_WIDTH;
					const cl_y = curr.center.y + DASH_Y_OFFSET;
					const cl_z = curr.center.z - curr.normal.z * DASH_HALF_WIDTH;
					const cr_x = curr.center.x + curr.normal.x * DASH_HALF_WIDTH;
					const cr_y = curr.center.y + DASH_Y_OFFSET;
					const cr_z = curr.center.z + curr.normal.z * DASH_HALF_WIDTH;

					const nl_x = next.center.x - next.normal.x * DASH_HALF_WIDTH;
					const nl_y = next.center.y + DASH_Y_OFFSET;
					const nl_z = next.center.z - next.normal.z * DASH_HALF_WIDTH;
					const nr_x = next.center.x + next.normal.x * DASH_HALF_WIDTH;
					const nr_y = next.center.y + DASH_Y_OFFSET;
					const nr_z = next.center.z + next.normal.z * DASH_HALF_WIDTH;

					dashPositions.push(cl_x, cl_y, cl_z);
					dashPositions.push(cr_x, cr_y, cr_z);
					dashPositions.push(nl_x, nl_y, nl_z);
					dashPositions.push(nl_x, nl_y, nl_z);
					dashPositions.push(cr_x, cr_y, cr_z);
					dashPositions.push(nr_x, nr_y, nr_z);

					for (let n = 0; n < 6; n++) {
						dashNormals.push(0, 1, 0);
					}
				}
				segIdx += DASH_LENGTH + GAP_LENGTH;
			}

			if (dashPositions.length > 0) {
				const cdGeo = new BufferGeometry();
				cdGeo.setAttribute(
					"position",
					new Float32BufferAttribute(new Float32Array(dashPositions), 3),
				);
				cdGeo.setAttribute(
					"normal",
					new Float32BufferAttribute(new Float32Array(dashNormals), 3),
				);
				centerDashGeo = cdGeo;
			}

			// -- Neon grid void — a faintly glowing cyan grid retreating into the
			// fog. Manually new'd, so geometry + material are disposed in onDestroy.
			const grid = new THREE.GridHelper(2000, 200, 0x00e5ff, 0x12204a);
			grid.position.y = -9.9;
			(grid.material as THREE.Material).toneMapped = false;
			neonGrid = grid;

			// -- Start/finish checker banner texture (black/white checker). --
			const checkCanvas = document.createElement("canvas");
			checkCanvas.width = 256;
			checkCanvas.height = 32;
			const ctx = checkCanvas.getContext("2d");
			if (ctx) {
				const cols = 16;
				const cell = checkCanvas.width / cols; // 16px
				const rows = Math.round(checkCanvas.height / cell); // 2
				for (let cy = 0; cy < rows; cy++) {
					for (let cx = 0; cx < cols; cx++) {
						ctx.fillStyle = (cx + cy) % 2 === 0 ? "#ffffff" : "#0a0a14";
						ctx.fillRect(cx * cell, cy * cell, cell, cell);
					}
				}
				const tex = new THREE.CanvasTexture(checkCanvas);
				tex.wrapS = THREE.RepeatWrapping;
				tex.repeat.set(8, 1);
				tex.colorSpace = THREE.SRGBColorSpace;
				checkerTexture = tex;
			}
		}
	});

	// -----------------------------------------------------------------------
	// Chevron animation — scroll arrows forward over boost pads
	// -----------------------------------------------------------------------

	let chevronGroupRefs: (THREE.Group | undefined)[] = [];

	useTask((delta) => {
		chevronTime += delta;

		// Checkpoint gates pulse-flash toward white (0..~0.55), eased.
		gateFlash = (Math.sin(chevronTime * 2.2) * 0.5 + 0.5) * 0.55;

		// Animate each chevron group: cycle positions forward
		for (let ci = 0; ci < boostChevrons.length; ci++) {
			const chev = boostChevrons[ci];
			const groupRef = chevronGroupRefs[ci];
			if (!groupRef || !chev) continue;

			// Each child arrow scrolls forward cyclically
			const children = groupRef.children;
			for (let ai = 0; ai < children.length; ai++) {
				const arrow = children[ai];
				const phase = ((chevronTime * 2.5 + ai * 0.25) % 1.0);
				// Scroll along the forward direction
				const basePos = chev.positions[ai];
				if (!basePos) continue;
				const spanDist = 1.5 * overlayScale; // distance the chevron scrolls
				arrow.position.set(
					basePos.x + chev.forward.x * phase * spanDist,
					basePos.y + 0.05 * overlayScale,
					basePos.z + chev.forward.z * phase * spanDist,
				);
				// Fade: bright in center, fade at edges
				const opacity = Math.sin(phase * Math.PI) * 0.8;
				const mat = (arrow as any).children?.[0]?.material;
				if (mat && mat.opacity !== undefined) {
					mat.opacity = opacity;
				}
			}
		}
	});

	// -----------------------------------------------------------------------
	// Cleanup
	// -----------------------------------------------------------------------

	onDestroy(() => {
		roadGeo?.dispose();
		leftWallGeo?.dispose();
		rightWallGeo?.dispose();
		startLineGeo?.dispose();
		centerDashGeo?.dispose();
		leftLedGeo?.dispose();
		rightLedGeo?.dispose();
		leftEdgeStripGeo?.dispose();
		rightEdgeStripGeo?.dispose();
		for (const geo of boostGeos) {
			geo.dispose();
		}
		// Manually new'd resources need explicit disposal.
		if (neonGrid) {
			neonGrid.geometry.dispose();
			(neonGrid.material as THREE.Material).dispose();
		}
		checkerTexture?.dispose();
	});
</script>

{#if isProceduralTrack}
	<!-- ===================================================================== -->
	<!-- Neon grid void — near-black ground plane + faintly glowing cyan grid   -->
	<!-- retreating into the indigo fog.                                        -->
	<!-- ===================================================================== -->
	<T.Mesh rotation.x={-Math.PI / 2} position.y={-10} receiveShadow>
		<T.PlaneGeometry args={[2000, 2000]} />
		<T.MeshStandardMaterial color="#04040c" roughness={1} metalness={0} />
	</T.Mesh>
	{#if neonGrid}
		<T is={neonGrid} />
	{/if}
{/if}

{#if gltfVisual}
	<T.Group
		position={[
			gltfVisual.transform.position.x,
			gltfVisual.transform.position.y,
			gltfVisual.transform.position.z,
		]}
		rotation={[
			gltfVisual.transform.rotation.x,
			gltfVisual.transform.rotation.y,
			gltfVisual.transform.rotation.z,
		]}
		scale={[
			gltfVisual.transform.scale.x,
			gltfVisual.transform.scale.y,
			gltfVisual.transform.scale.z,
		]}
	>
		<Track1Model />
	</T.Group>
{/if}

<!-- ===================================================================== -->
<!-- Road surface — wet-neon asphalt (near-black, low roughness/high metal  -->
<!-- so the bloomed neon edges and sky sheen reflect down the road).        -->
<!-- ===================================================================== -->
{#if roadGeo}
	<!-- FrontSide: the strip is wound CCW from above and only ever seen from
	     above — single-sided keeps early-Z effective. -->
	<T.Mesh geometry={roadGeo} receiveShadow>
		<T.MeshStandardMaterial
			color="#0a0a14"
			roughness={0.35}
			metalness={0.6}
			envMapIntensity={1}
			side={FrontSide}
		/>
	</T.Mesh>
{/if}

<!-- ===================================================================== -->
<!-- HEADLINE neon EDGE STRIPS — crisp glowing ribbons flush with the road  -->
<!-- edges. Left=cyan, right=magenta. Bloomed into solid neon ribbons that  -->
<!-- trace the whole layout (the single biggest visual win).                -->
<!-- ===================================================================== -->
{#if leftEdgeStripGeo}
	<T.Mesh geometry={leftEdgeStripGeo}>
		<T.MeshBasicMaterial
			color={new THREE.Color(NEON_CYAN).multiplyScalar(2.0)}
			toneMapped={false}
			side={DoubleSide}
		/>
	</T.Mesh>
{/if}
{#if rightEdgeStripGeo}
	<T.Mesh geometry={rightEdgeStripGeo}>
		<T.MeshBasicMaterial
			color={new THREE.Color(NEON_MAGENTA).multiplyScalar(2.0)}
			toneMapped={false}
			side={DoubleSide}
		/>
	</T.Mesh>
{/if}

<!-- ===================================================================== -->
<!-- Left wall — translucent CYAN barrier (faint side glow)                -->
<!-- ===================================================================== -->
{#if leftWallGeo}
	<T.Mesh geometry={leftWallGeo}>
		<T.MeshStandardMaterial
			color="#00E5FF"
			emissive="#00E5FF"
			emissiveIntensity={0.6}
			transparent
			opacity={0.12}
			side={DoubleSide}
			metalness={0.4}
			roughness={0.5}
			depthWrite={false}
		/>
	</T.Mesh>
{/if}

<!-- ===================================================================== -->
<!-- Right wall — translucent MAGENTA barrier (faint side glow)            -->
<!-- ===================================================================== -->
{#if rightWallGeo}
	<T.Mesh geometry={rightWallGeo}>
		<T.MeshStandardMaterial
			color="#FF2BD6"
			emissive="#FF2BD6"
			emissiveIntensity={0.6}
			transparent
			opacity={0.12}
			side={DoubleSide}
			metalness={0.4}
			roughness={0.5}
			depthWrite={false}
		/>
	</T.Mesh>
{/if}

<!-- ===================================================================== -->
<!-- Wall-top LED strip — left (cyan base, green near boost, white near CP) -->
<!-- Per-vertex colors are pre-multiplied (>1.0) and bloom; toneMapped off. -->
<!-- ===================================================================== -->
{#if leftLedGeo}
	<T.Mesh geometry={leftLedGeo}>
		<T.MeshBasicMaterial vertexColors toneMapped={false} />
	</T.Mesh>
{/if}

<!-- ===================================================================== -->
<!-- Wall-top LED strip — right (magenta base, green/white overrides)       -->
<!-- ===================================================================== -->
{#if rightLedGeo}
	<T.Mesh geometry={rightLedGeo}>
		<T.MeshBasicMaterial vertexColors toneMapped={false} />
	</T.Mesh>
{/if}

<!-- ===================================================================== -->
<!-- Boost pads — bright green emissive strips on the road                 -->
<!-- ===================================================================== -->
{#each boostGeos as geo}
	<T.Mesh geometry={geo}>
		<T.MeshStandardMaterial
			color="#00FFA3"
			emissive="#00FFA3"
			emissiveIntensity={1.5}
			transparent
			opacity={0.7}
			side={DoubleSide}
			metalness={0.3}
			roughness={0.4}
		/>
	</T.Mesh>
{/each}

<!-- ===================================================================== -->
<!-- Boost pad animated chevrons — scrolling arrows                        -->
<!-- ===================================================================== -->
{#each boostChevrons as chev, ci}
	<T.Group
		oncreate={(ref) => { chevronGroupRefs[ci] = ref; }}
	>
		{#each chev.positions as pos, ai}
			<T.Group position={[pos.x, pos.y + 0.05 * overlayScale, pos.z]}>
				<!-- Chevron arrow shape: flat triangle pointing forward (glows) -->
				<T.Mesh rotation.x={-Math.PI / 2}>
					<T.ConeGeometry args={[0.4 * overlayScale, 0.8 * overlayScale, 3]} />
					<T.MeshBasicMaterial
						color={new THREE.Color(NEON_GREEN).multiplyScalar(1.6)}
						toneMapped={false}
						transparent
						opacity={0.6}
						depthWrite={false}
					/>
				</T.Mesh>
			</T.Group>
		{/each}
	</T.Group>
{/each}

<!-- ===================================================================== -->
<!-- Start / finish line — white emissive quad across the road             -->
<!-- ===================================================================== -->
{#if startLineGeo}
	<T.Mesh geometry={startLineGeo}>
		<T.MeshStandardMaterial
			color="#ffffff"
			emissive="#ffffff"
			emissiveIntensity={2.0}
			transparent
			opacity={0.9}
			side={DoubleSide}
		/>
	</T.Mesh>
{/if}

<!-- ===================================================================== -->
<!-- Center line dashes — white-hot dotted spine that blooms                -->
<!-- ===================================================================== -->
{#if centerDashGeo}
	<T.Mesh geometry={centerDashGeo}>
		<T.MeshBasicMaterial
			color={new THREE.Color(0xffffff).multiplyScalar(1.4)}
			toneMapped={false}
			transparent
			opacity={0.85}
			side={FrontSide}
		/>
	</T.Mesh>
{/if}

<!-- ===================================================================== -->
<!-- Light gates at every checkpoint — glowing gantries spanning the road.  -->
<!-- Alternating cyan / magenta by index, pulsing toward white.            -->
<!-- ===================================================================== -->
{#each track.checkpoints as cp, i}
	{@const seg = segments[cp.segmentIndex]}
	{@const gateHeight = 9}
	{@const span = Math.sqrt((seg.right.x - seg.left.x) ** 2 + (seg.right.z - seg.left.z) ** 2)}
	{@const midX = (seg.left.x + seg.right.x) / 2}
	{@const midZ = (seg.left.z + seg.right.z) / 2}
	{@const baseY = Math.min(seg.left.y, seg.right.y)}
	{@const angle = Math.atan2(seg.right.z - seg.left.z, seg.right.x - seg.left.x)}
	{@const gateColor = gateFlashColor(i, gateFlash)}
	{@const baseHex = i % 2 === 0 ? "#00E5FF" : "#FF2BD6"}
	<!-- Left post -->
	<T.Mesh position={[seg.left.x, baseY + gateHeight / 2, seg.left.z]}>
		<T.BoxGeometry args={[0.4, gateHeight, 0.4]} />
		<T.MeshStandardMaterial color={baseHex} emissive={gateColor} emissiveIntensity={2.2} />
	</T.Mesh>
	<!-- Right post -->
	<T.Mesh position={[seg.right.x, baseY + gateHeight / 2, seg.right.z]}>
		<T.BoxGeometry args={[0.4, gateHeight, 0.4]} />
		<T.MeshStandardMaterial color={baseHex} emissive={gateColor} emissiveIntensity={2.2} />
	</T.Mesh>
	<!-- Glowing crossbar spanning left -> right at the top -->
	<T.Mesh position={[midX, baseY + gateHeight, midZ]} rotation.y={-angle}>
		<T.BoxGeometry args={[span, 0.6, 0.5]} />
		<T.MeshStandardMaterial color={baseHex} emissive={gateColor} emissiveIntensity={2.2} />
	</T.Mesh>
	<!-- Thin top light-tube arch silhouette (flattened torus half-arc) -->
	<T.Mesh position={[midX, baseY + gateHeight + 0.1, midZ]} rotation={[Math.PI / 2, 0, -angle]}>
		<T.TorusGeometry args={[span / 2, 0.12, 8, 24, Math.PI]} />
		<T.MeshBasicMaterial color={gateColor} toneMapped={false} />
	</T.Mesh>
{/each}

<!-- ===================================================================== -->
<!-- Track-side scenery objects                                             -->
<!-- ===================================================================== -->
{#each sceneryItems as item}
	{#if item.type === "pylon"}
		<!-- Neon pylon — bright emissive cylinder + glowing sphere cap. The
		     track.ts cycle (FF00FF / 00FFFF / FFFF00) is remapped onto the locked
		     palette (magenta / cyan / boost-green). -->
		{@const pylonColor =
			item.color === "#FFFF00"
				? "#00FFA3"
				: item.color === "#FF00FF"
					? "#FF2BD6"
					: item.color === "#00FFFF"
						? "#00E5FF"
						: item.color || "#00E5FF"}
		<T.Mesh
			castShadow
			position={[item.position.x, item.position.y + item.height / 2, item.position.z]}
		>
			<T.CylinderGeometry args={[0.15, 0.15, item.height, 8]} />
			<T.MeshStandardMaterial
				color={pylonColor}
				emissive={pylonColor}
				emissiveIntensity={2.0}
			/>
		</T.Mesh>
		<!-- Glowing sphere cap at the top -->
		<T.Mesh position={[item.position.x, item.position.y + item.height, item.position.z]}>
			<T.SphereGeometry args={[0.4, 12, 12]} />
			<T.MeshBasicMaterial
				color={new THREE.Color(pylonColor).multiplyScalar(1.8)}
				toneMapped={false}
			/>
		</T.Mesh>
	{:else if item.type === "block"}
		<!-- Dark skyscraper body + lit neon edge outline (alternating side hue). -->
		{@const blockW = item.width || 2}
		{@const blockH = item.height || 1}
		{@const blockD = item.depth || 2}
		{@const edgeHex = item.position.x < -200 ? "#00E5FF" : "#FF2BD6"}
		<T.Mesh
			castShadow
			position={[item.position.x, item.position.y + blockH / 2, item.position.z]}
		>
			<T.BoxGeometry args={[blockW, blockH, blockD]} />
			<T.MeshStandardMaterial
				color="#0a0a1a"
				emissive={item.color || "#0a0a1a"}
				emissiveIntensity={0.3}
				roughness={0.6}
				metalness={0.3}
			/>
		</T.Mesh>
		<!-- Neon edge outline (skyscraper silhouette glow) -->
		<T.LineSegments position={[item.position.x, item.position.y + blockH / 2, item.position.z]}>
			<T.EdgesGeometry args={[new THREE.BoxGeometry(blockW, blockH, blockD)]} />
			<T.LineBasicMaterial
				color={new THREE.Color(edgeHex).multiplyScalar(1.6)}
				toneMapped={false}
			/>
		</T.LineSegments>
		<!-- Lit 'window' band near the top -->
		<T.Mesh position={[item.position.x, item.position.y + blockH * 0.82, item.position.z]}>
			<T.BoxGeometry args={[blockW + 0.05, blockH * 0.06, blockD + 0.05]} />
			<T.MeshBasicMaterial
				color={new THREE.Color(edgeHex).multiplyScalar(1.4)}
				toneMapped={false}
			/>
		</T.Mesh>
	{:else if item.type === "arch"}
		<!-- START / FINISH gantry — the money shot at lap crossings. -->
		{@const seg0 = segments[0]}
		{@const archH = item.height || 11}
		{@const archMidX = (seg0.left.x + seg0.right.x) / 2}
		{@const archMidZ = (seg0.left.z + seg0.right.z) / 2}
		{@const archBaseY = Math.min(seg0.left.y, seg0.right.y)}
		{@const archSpan = Math.sqrt((seg0.right.x - seg0.left.x) ** 2 + (seg0.right.z - seg0.left.z) ** 2)}
		{@const archAngle = Math.atan2(seg0.right.z - seg0.left.z, seg0.right.x - seg0.left.x)}
		<!-- Left pylon (thick cyan) -->
		<T.Mesh position={[seg0.left.x, archBaseY + archH / 2, seg0.left.z]}>
			<T.CylinderGeometry args={[0.5, 0.5, archH, 12]} />
			<T.MeshStandardMaterial color="#00E5FF" emissive="#00E5FF" emissiveIntensity={2.5} />
		</T.Mesh>
		<!-- Right pylon (thick magenta) -->
		<T.Mesh position={[seg0.right.x, archBaseY + archH / 2, seg0.right.z]}>
			<T.CylinderGeometry args={[0.5, 0.5, archH, 12]} />
			<T.MeshStandardMaterial color="#FF2BD6" emissive="#FF2BD6" emissiveIntensity={2.5} />
		</T.Mesh>
		<!-- Checkered banner across the top -->
		<T.Mesh position={[archMidX, archBaseY + archH, archMidZ]} rotation.y={-archAngle}>
			<T.BoxGeometry args={[archSpan, 1.6, 0.2]} />
			{#if checkerTexture}
				<T.MeshStandardMaterial
					map={checkerTexture}
					emissive="#ffffff"
					emissiveMap={checkerTexture}
					emissiveIntensity={1.5}
					toneMapped={false}
				/>
			{:else}
				<T.MeshBasicMaterial
					color={new THREE.Color(0xffffff).multiplyScalar(1.5)}
					toneMapped={false}
				/>
			{/if}
		</T.Mesh>
		<!-- Two downward-facing strip lights under the banner -->
		<T.Mesh
			position={[
				archMidX + Math.cos(archAngle) * archSpan * 0.25,
				archBaseY + archH - 0.9,
				archMidZ + Math.sin(archAngle) * archSpan * 0.25,
			]}
			rotation.y={-archAngle}
		>
			<T.BoxGeometry args={[archSpan * 0.18, 0.12, 0.5]} />
			<T.MeshBasicMaterial color={new THREE.Color(0x00e5ff).multiplyScalar(1.6)} toneMapped={false} />
		</T.Mesh>
		<T.Mesh
			position={[
				archMidX - Math.cos(archAngle) * archSpan * 0.25,
				archBaseY + archH - 0.9,
				archMidZ - Math.sin(archAngle) * archSpan * 0.25,
			]}
			rotation.y={-archAngle}
		>
			<T.BoxGeometry args={[archSpan * 0.18, 0.12, 0.5]} />
			<T.MeshBasicMaterial color={new THREE.Color(0xff2bd6).multiplyScalar(1.6)} toneMapped={false} />
		</T.Mesh>
	{/if}
{/each}
