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
		Vector3,
		ShaderMaterial,
	} from "three";
	import { getTrack } from "../track.js";
	import { TRACK_WALL_HEIGHT } from "../types.js";

	// -----------------------------------------------------------------------
	// Track data (generated once, cached)
	// -----------------------------------------------------------------------

	const track = getTrack();
	const { segments, boostZones } = track;
	const segCount = segments.length;

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
	 * Determine LED color for a given segment index.
	 * Green near boost zones, white near checkpoints, default blue.
	 */
	function getLedColor(segIdx: number): string {
		// Check if near a boost zone
		for (const bz of boostZones) {
			if (segIdx >= bz.segmentStart - 5 && segIdx <= bz.segmentEnd + 5) {
				return "#00FFAA";
			}
		}
		// Check if near a checkpoint
		for (const cp of track.checkpoints) {
			const diff = Math.abs(segIdx - cp.segmentIndex);
			if (diff < 4 || diff > segCount - 4) {
				return "#FFFFFF";
			}
		}
		return "#0A9EF5";
	}

	// -----------------------------------------------------------------------
	// Build all geometries on mount
	// -----------------------------------------------------------------------

	onMount(() => {
		// -- Road surface --
		const lefts = segments.map((s) => s.left);
		const rights = segments.map((s) => s.right);
		roadGeo = buildQuadStrip(lefts, rights, true);

		// -- Wall strips (now using actual Y values from edges) --
		const leftNormals = segments.map((s) => ({ x: -s.normal.x, z: -s.normal.z }));
		leftWallGeo = buildWallStrip(lefts, TRACK_WALL_HEIGHT, leftNormals);

		const rightNormals = segments.map((s) => ({ x: s.normal.x, z: s.normal.z }));
		rightWallGeo = buildWallStrip(rights, TRACK_WALL_HEIGHT, rightNormals);

		// -- Wall-top LED strips --
		leftLedGeo = buildLedStrip(lefts, leftNormals, TRACK_WALL_HEIGHT, 0.08);
		rightLedGeo = buildLedStrip(rights, rightNormals, TRACK_WALL_HEIGHT, 0.08);

		// -- Boost pad geometry --
		const BOOST_Y = 0.03;
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
					y: s.center.y + 0.06,
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
		if (Array.isArray(trackScenery)) {
			sceneryItems = trackScenery;
		}

		// -- Start/finish line --
		const s0 = segments[0];
		const lineWidth = 0.5;
		const startLineVerts = new Float32Array([
			s0.left.x, s0.left.y + 0.02, s0.left.z,
			s0.right.x, s0.right.y + 0.02, s0.right.z,
			s0.left.x + s0.forward.x * lineWidth, s0.left.y + 0.02, s0.left.z + s0.forward.z * lineWidth,
			s0.left.x + s0.forward.x * lineWidth, s0.left.y + 0.02, s0.left.z + s0.forward.z * lineWidth,
			s0.right.x, s0.right.y + 0.02, s0.right.z,
			s0.right.x + s0.forward.x * lineWidth, s0.right.y + 0.02, s0.right.z + s0.forward.z * lineWidth,
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
		const DASH_LENGTH = 3;
		const GAP_LENGTH = 3;
		const DASH_HALF_WIDTH = 0.08;
		const DASH_Y_OFFSET = 0.015;
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
	});

	// -----------------------------------------------------------------------
	// Chevron animation — scroll arrows forward over boost pads
	// -----------------------------------------------------------------------

	let chevronGroupRefs: (THREE.Group | undefined)[] = [];

	useTask((delta) => {
		chevronTime += delta;

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
				const spanDist = 1.5; // distance the chevron scrolls
				arrow.position.set(
					basePos.x + chev.forward.x * phase * spanDist,
					basePos.y + 0.05,
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
		for (const geo of boostGeos) {
			geo.dispose();
		}
	});
</script>

<!-- ===================================================================== -->
<!-- Ground plane — large grass surface surrounding the track              -->
<!-- ===================================================================== -->
<T.Mesh rotation.x={-Math.PI / 2} position.y={-10} receiveShadow>
	<T.PlaneGeometry args={[2000, 2000]} />
	<T.MeshStandardMaterial
		color="#2d5a1e"
		roughness={0.95}
		metalness={0.0}
	/>
</T.Mesh>
<!-- Slightly lighter grass patches for texture variation -->
<T.Mesh rotation.x={-Math.PI / 2} position={[-120, -9.98, 80]}>
	<T.CircleGeometry args={[80, 32]} />
	<T.MeshStandardMaterial
		color="#3a6b2a"
		roughness={0.95}
		metalness={0.0}
	/>
</T.Mesh>
<T.Mesh rotation.x={-Math.PI / 2} position={[100, -9.98, -60]}>
	<T.CircleGeometry args={[70, 32]} />
	<T.MeshStandardMaterial
		color="#336625"
		roughness={0.95}
		metalness={0.0}
	/>
</T.Mesh>
<T.Mesh rotation.x={-Math.PI / 2} position={[-40, -9.98, -140]}>
	<T.CircleGeometry args={[100, 32]} />
	<T.MeshStandardMaterial
		color="#3a6b2a"
		roughness={0.95}
		metalness={0.0}
	/>
</T.Mesh>

<!-- ===================================================================== -->
<!-- Road surface — dark asphalt                                           -->
<!-- ===================================================================== -->
{#if roadGeo}
	<T.Mesh geometry={roadGeo} receiveShadow>
		<T.MeshStandardMaterial
			color="#333340"
			roughness={0.8}
			metalness={0.1}
			side={DoubleSide}
		/>
	</T.Mesh>
{/if}

<!-- ===================================================================== -->
<!-- Left wall — translucent blue barrier                                  -->
<!-- ===================================================================== -->
{#if leftWallGeo}
	<T.Mesh geometry={leftWallGeo}>
		<T.MeshStandardMaterial
			color="#0A9EF5"
			emissive="#0A9EF5"
			emissiveIntensity={0.2}
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
<!-- Right wall — translucent blue barrier                                 -->
<!-- ===================================================================== -->
{#if rightWallGeo}
	<T.Mesh geometry={rightWallGeo}>
		<T.MeshStandardMaterial
			color="#0A9EF5"
			emissive="#0A9EF5"
			emissiveIntensity={0.2}
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
<!-- Wall-top LED strip — left                                             -->
<!-- ===================================================================== -->
{#if leftLedGeo}
	<T.Mesh geometry={leftLedGeo}>
		<T.MeshBasicMaterial
			color="#0A9EF5"
			transparent
			opacity={0.9}
		/>
	</T.Mesh>
{/if}

<!-- ===================================================================== -->
<!-- Wall-top LED strip — right                                            -->
<!-- ===================================================================== -->
{#if rightLedGeo}
	<T.Mesh geometry={rightLedGeo}>
		<T.MeshBasicMaterial
			color="#0A9EF5"
			transparent
			opacity={0.9}
		/>
	</T.Mesh>
{/if}

<!-- ===================================================================== -->
<!-- Boost pads — bright green emissive strips on the road                 -->
<!-- ===================================================================== -->
{#each boostGeos as geo}
	<T.Mesh geometry={geo}>
		<T.MeshStandardMaterial
			color="#00FFAA"
			emissive="#00FFAA"
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
			<T.Group position={[pos.x, pos.y + 0.05, pos.z]}>
				<!-- Chevron arrow shape: flat triangle pointing forward -->
				<T.Mesh rotation.x={-Math.PI / 2}>
					<T.ConeGeometry args={[0.4, 0.8, 3]} />
					<T.MeshBasicMaterial
						color="#00FFAA"
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
<!-- Center line dashes — thin white dashed line along track center        -->
<!-- ===================================================================== -->
{#if centerDashGeo}
	<T.Mesh geometry={centerDashGeo}>
		<T.MeshStandardMaterial
			color="#ffffff"
			emissive="#ffffff"
			emissiveIntensity={0.6}
			transparent
			opacity={0.35}
			side={FrontSide}
		/>
	</T.Mesh>
{/if}

<!-- ===================================================================== -->
<!-- Checkpoint markers — subtle translucent arches at each checkpoint     -->
<!-- ===================================================================== -->
{#each track.checkpoints as cp, i}
	{@const seg = segments[cp.segmentIndex]}
	<!-- Left post -->
	<T.Mesh
		position={[seg.left.x, seg.left.y + TRACK_WALL_HEIGHT * 0.5, seg.left.z]}
	>
		<T.CylinderGeometry args={[0.06, 0.06, TRACK_WALL_HEIGHT, 6]} />
		<T.MeshStandardMaterial
			color="#0A9EF5"
			emissive="#0A9EF5"
			emissiveIntensity={0.4}
			transparent
			opacity={0.2}
			depthWrite={false}
		/>
	</T.Mesh>
	<!-- Right post -->
	<T.Mesh
		position={[seg.right.x, seg.right.y + TRACK_WALL_HEIGHT * 0.5, seg.right.z]}
	>
		<T.CylinderGeometry args={[0.06, 0.06, TRACK_WALL_HEIGHT, 6]} />
		<T.MeshStandardMaterial
			color="#0A9EF5"
			emissive="#0A9EF5"
			emissiveIntensity={0.4}
			transparent
			opacity={0.2}
			depthWrite={false}
		/>
	</T.Mesh>
{/each}

<!-- ===================================================================== -->
<!-- Track-side scenery objects                                             -->
<!-- ===================================================================== -->
{#each sceneryItems as item}
	{#if item.type === "pylon"}
		<!-- Tall emissive cylinder -->
		<T.Mesh
			position={[item.position.x, item.position.y + item.height / 2, item.position.z]}
		>
			<T.CylinderGeometry args={[0.15, 0.15, item.height, 8]} />
			<T.MeshStandardMaterial
				color={item.color || "#0A9EF5"}
				emissive={item.color || "#0A9EF5"}
				emissiveIntensity={0.8}
			/>
		</T.Mesh>
	{:else if item.type === "block"}
		<!-- Rectangular box with emissive surface -->
		<T.Mesh
			position={[item.position.x, item.position.y + (item.height || 1) / 2, item.position.z]}
		>
			<T.BoxGeometry args={[item.width || 2, item.height || 1, item.depth || 2]} />
			<T.MeshStandardMaterial
				color={item.color || "#0066AA"}
				emissive={item.color || "#0066AA"}
				emissiveIntensity={0.4}
				roughness={0.6}
				metalness={0.3}
			/>
		</T.Mesh>
	{:else if item.type === "arch"}
		<!-- Two posts + crossbar spanning the road at segment 0 -->
		{@const seg0 = segments[0]}
		<!-- Left post -->
		<T.Mesh
			position={[seg0.left.x, seg0.left.y + (item.height || 4) / 2, seg0.left.z]}
		>
			<T.CylinderGeometry args={[0.2, 0.2, item.height || 4, 8]} />
			<T.MeshStandardMaterial
				color={item.color || "#0A9EF5"}
				emissive={item.color || "#0A9EF5"}
				emissiveIntensity={0.6}
			/>
		</T.Mesh>
		<!-- Right post -->
		<T.Mesh
			position={[seg0.right.x, seg0.right.y + (item.height || 4) / 2, seg0.right.z]}
		>
			<T.CylinderGeometry args={[0.2, 0.2, item.height || 4, 8]} />
			<T.MeshStandardMaterial
				color={item.color || "#0A9EF5"}
				emissive={item.color || "#0A9EF5"}
				emissiveIntensity={0.6}
			/>
		</T.Mesh>
		<!-- Crossbar -->
		{@const archMidX = (seg0.left.x + seg0.right.x) / 2}
		{@const archMidZ = (seg0.left.z + seg0.right.z) / 2}
		{@const archSpan = Math.sqrt((seg0.right.x - seg0.left.x) ** 2 + (seg0.right.z - seg0.left.z) ** 2)}
		{@const archAngle = Math.atan2(seg0.right.z - seg0.left.z, seg0.right.x - seg0.left.x)}
		<T.Mesh
			position={[archMidX, (item.height || 4), archMidZ]}
			rotation.y={-archAngle}
		>
			<T.BoxGeometry args={[archSpan, 0.3, 0.3]} />
			<T.MeshStandardMaterial
				color={item.color || "#0A9EF5"}
				emissive={item.color || "#0A9EF5"}
				emissiveIntensity={0.6}
			/>
		</T.Mesh>
	{/if}
{/each}
