<!--
  Minimap — top-down HTML/SVG overlay showing the track outline and kart positions.
  Positioned in the top-right corner of the viewport.
-->
<script lang="ts">
	import { getRaceStore } from "$lib/racing/context.js";
	import { DEFAULT_TRACK_ID, getTrack } from "$lib/racing/track.js";
	import { getPlayerAccentColor } from "$lib/racing/car-catalog.js";

	const store = getRaceStore();
	const track = $derived.by(() => getTrack(store.trackId || DEFAULT_TRACK_ID));

	const MAP_SIZE = 220;
	const PADDING = 14;
	const LOCAL_DOT_RADIUS = 6;

	const SAMPLE_INTERVAL = 2;

	const projection = $derived.by(() => {
		let minX = Infinity;
		let maxX = -Infinity;
		let minZ = Infinity;
		let maxZ = -Infinity;

		for (const seg of track.segments) {
			const lx = Math.min(seg.left.x, seg.right.x);
			const rx = Math.max(seg.left.x, seg.right.x);
			const lz = Math.min(seg.left.z, seg.right.z);
			const rz = Math.max(seg.left.z, seg.right.z);
			if (lx < minX) minX = lx;
			if (rx > maxX) maxX = rx;
			if (lz < minZ) minZ = lz;
			if (rz > maxZ) maxZ = rz;
		}

		const rangeX = maxX - minX || 1;
		const rangeZ = maxZ - minZ || 1;
		const scale = (MAP_SIZE - PADDING * 2) / Math.max(rangeX, rangeZ);
		const offsetX = (MAP_SIZE - rangeX * scale) / 2;
		const offsetZ = (MAP_SIZE - rangeZ * scale) / 2;

		return { minX, minZ, scale, offsetX, offsetZ };
	});

	function toMapX(worldX: number): number {
		return (worldX - projection.minX) * projection.scale + projection.offsetX;
	}

	function toMapY(worldZ: number): number {
		return (worldZ - projection.minZ) * projection.scale + projection.offsetZ;
	}

	const trackPolygon = $derived.by(() => {
		const leftPts: string[] = [];
		const rightPts: string[] = [];
		for (let i = 0; i < track.segments.length; i += SAMPLE_INTERVAL) {
			const seg = track.segments[i];
			leftPts.push(`${toMapX(seg.left.x).toFixed(1)},${toMapY(seg.left.z).toFixed(1)}`);
			rightPts.push(`${toMapX(seg.right.x).toFixed(1)},${toMapY(seg.right.z).toFixed(1)}`);
		}
		const first = track.segments[0];
		leftPts.push(`${toMapX(first.left.x).toFixed(1)},${toMapY(first.left.z).toFixed(1)}`);
		rightPts.push(`${toMapX(first.right.x).toFixed(1)},${toMapY(first.right.z).toFixed(1)}`);
		return [...leftPts, ...rightPts.reverse()].join(" ");
	});

	const trackCenterline = $derived.by(() => {
		const pts: string[] = [];
		for (let i = 0; i < track.segments.length; i += SAMPLE_INTERVAL) {
			const seg = track.segments[i];
			pts.push(`${toMapX(seg.center.x).toFixed(1)},${toMapY(seg.center.z).toFixed(1)}`);
		}
		const first = track.segments[0];
		pts.push(`${toMapX(first.center.x).toFixed(1)},${toMapY(first.center.z).toFixed(1)}`);
		return pts.join(" ");
	});

	const boostMarks = $derived.by(() => {
		const marks: { points: string }[] = [];
		for (const bz of track.boostZones) {
			const pts: string[] = [];
			for (let i = bz.segmentStart; i <= bz.segmentEnd && i < track.segments.length; i += 2) {
				const seg = track.segments[i];
				pts.push(`${toMapX(seg.center.x).toFixed(1)},${toMapY(seg.center.z).toFixed(1)}`);
			}
			const endSeg = track.segments[Math.min(bz.segmentEnd, track.segments.length - 1)];
			pts.push(`${toMapX(endSeg.center.x).toFixed(1)},${toMapY(endSeg.center.z).toFixed(1)}`);
			if (pts.length >= 2) {
				marks.push({ points: pts.join(" ") });
			}
		}
		return marks;
	});

	// Item boxes — read the LIVE store (active/inactive), not the static track
	// definition, so collected boxes dim until they respawn.
	const itemBoxDots = $derived.by(() => {
		const dots: { cx: number; cy: number; active: boolean }[] = [];
		for (const box of store.itemBoxes) {
			dots.push({
				cx: toMapX(box.position.x),
				cy: toMapY(box.position.z),
				active: box.active,
			});
		}
		return dots;
	});

	// Projectiles (red) + hazards (yellow) — live threats on the map.
	const projectileDots = $derived.by(() =>
		store.projectiles.map((p) => ({
			id: p.id,
			cx: toMapX(p.position.x),
			cy: toMapY(p.position.z),
		})),
	);

	const hazardDots = $derived.by(() =>
		store.hazards.map((h) => ({
			id: h.id,
			cx: toMapX(h.position.x),
			cy: toMapY(h.position.z),
		})),
	);

	// Start/finish tick — perpendicular line across segment 0.
	const startTick = $derived.by(() => {
		const seg = track.segments[0];
		if (!seg) return null;
		return {
			x1: toMapX(seg.left.x),
			y1: toMapY(seg.left.z),
			x2: toMapX(seg.right.x),
			y2: toMapY(seg.right.z),
		};
	});

	const kartDots = $derived.by(() => {
		const dots: {
			id: string;
			cx: number;
			cy: number;
			color: string;
			isLocal: boolean;
			rotation: number;
		}[] = [];

		for (const kart of Object.values(store.karts)) {
			// Forward (sin h, cos h) in world (x,z) → map (x,y). SVG rotate() is
			// clockwise from +x with the triangle authored pointing up (-y).
			const rotation =
				(Math.atan2(Math.sin(kart.heading), Math.cos(kart.heading)) * 180) /
					Math.PI +
				90;
			dots.push({
				id: kart.id,
				cx: toMapX(kart.position.x),
				cy: toMapY(kart.position.z),
				color: getPlayerAccentColor(kart.accentIndex),
				isLocal: kart.id === store.localPlayerId,
				rotation,
			});
		}

		return dots;
	});

	let pulsePhase = $state(0);

	$effect(() => {
		let raf: number;
		let running = true;

		function tick() {
			if (!running) return;
			pulsePhase = (performance.now() / 600) % (Math.PI * 2);
			raf = requestAnimationFrame(tick);
		}

		raf = requestAnimationFrame(tick);

		return () => {
			running = false;
			cancelAnimationFrame(raf);
		};
	});

	const localPulseRadius = $derived(LOCAL_DOT_RADIUS + Math.sin(pulsePhase) * 1.5);
</script>

<div class="minimap">
	<svg
		width={MAP_SIZE}
		height={MAP_SIZE}
		viewBox={`0 0 ${MAP_SIZE} ${MAP_SIZE}`}
		xmlns="http://www.w3.org/2000/svg"
	>
		<!-- Road surface fill -->
		<polygon
			points={trackPolygon}
			fill="rgba(80, 80, 90, 0.5)"
			stroke="rgba(255, 255, 255, 0.25)"
			stroke-width="1"
		/>

		<!-- Center line -->
		<polyline
			points={trackCenterline}
			fill="none"
			stroke="rgba(255, 255, 255, 0.15)"
			stroke-width="1"
			stroke-linejoin="round"
			stroke-linecap="round"
			stroke-dasharray="3,3"
		/>

		<!-- Boost zone indicators -->
		{#each boostMarks as mark}
			<polyline
				points={mark.points}
				fill="none"
				stroke="rgba(0, 255, 170, 0.7)"
				stroke-width="4"
				stroke-linejoin="round"
				stroke-linecap="round"
			/>
		{/each}

		<!-- Start/finish tick across segment 0 -->
		{#if startTick}
			<line
				x1={startTick.x1}
				y1={startTick.y1}
				x2={startTick.x2}
				y2={startTick.y2}
				stroke="rgba(255, 255, 255, 0.9)"
				stroke-width="2"
				stroke-dasharray="2,2"
			/>
		{/if}

		<!-- Item box indicators — live store, dimmed while inactive (collected) -->
		{#each itemBoxDots as dot}
			<circle
				cx={dot.cx}
				cy={dot.cy}
				r={2.5}
				fill={dot.active ? "rgba(255, 217, 61, 0.9)" : "rgba(255, 217, 61, 0.25)"}
				stroke="none"
			/>
		{/each}

		<!-- Hazards (bananas) — yellow -->
		{#each hazardDots as dot (dot.id)}
			<circle
				cx={dot.cx}
				cy={dot.cy}
				r={2.5}
				fill="#FFD93D"
				stroke="rgba(0,0,0,0.5)"
				stroke-width="0.75"
			/>
		{/each}

		<!-- Projectiles (shells) — red -->
		{#each projectileDots as dot (dot.id)}
			<circle
				cx={dot.cx}
				cy={dot.cy}
				r={2.5}
				fill="#FF4444"
				stroke="rgba(0,0,0,0.5)"
				stroke-width="0.75"
			/>
		{/each}

		<!-- Kart triangles — non-local first, then local on top -->
		{#each kartDots.filter((d) => !d.isLocal) as dot (dot.id)}
			<polygon
				points="0,-5 3.5,4 -3.5,4"
				fill={dot.color}
				stroke="rgba(0,0,0,0.5)"
				stroke-width="1"
				transform={`translate(${dot.cx} ${dot.cy}) rotate(${dot.rotation})`}
			/>
		{/each}

		{#each kartDots.filter((d) => d.isLocal) as dot (dot.id)}
			<circle
				cx={dot.cx}
				cy={dot.cy}
				r={localPulseRadius + 1}
				fill="none"
				stroke={dot.color}
				stroke-width="1.5"
				opacity="0.5"
			/>
			<polygon
				points="0,-6 4,5 -4,5"
				fill={dot.color}
				stroke="#FFFFFF"
				stroke-width="1.5"
				transform={`translate(${dot.cx} ${dot.cy}) rotate(${dot.rotation})`}
			/>
		{/each}
	</svg>
</div>

<style>
	/* Placement is controlled by the page wrapper — the minimap is just a sized
	   panel here so it no longer fights the HUD layout for the top-right corner. */
	.minimap {
		width: 220px;
		height: 220px;
		background: rgba(0, 0, 0, 0.6);
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 8px;
		pointer-events: none;
		overflow: hidden;
	}
</style>
