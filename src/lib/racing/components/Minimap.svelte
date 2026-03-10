<!--
  Minimap — top-down HTML/SVG overlay showing the track outline and kart positions.
  Positioned in the top-right corner of the viewport.

  Reads from RaceStore via context for kart positions/colors, and
  samples the track center line from getTrack() for the polyline.

  Enhancements:
  - Boost zone indicators (green marks on the polyline)
  - Item box indicators (yellow dots)
-->
<script lang="ts">
	import { getRaceStore } from "$lib/racing/context.js";
	import { getTrack } from "$lib/racing/track.js";
	import { CAR_VARIANT_COLORS } from "$lib/racing/types.js";

	const store = getRaceStore();
	const track = getTrack();

	const MAP_SIZE = 150;
	const PADDING = 10;
	const DOT_RADIUS = 4;
	const LOCAL_DOT_RADIUS = 6;

	// Sample every Nth segment for the polyline (track has ~400 segments)
	const SAMPLE_INTERVAL = 4;

	// Compute bounding box of track center points for scaling
	let minX = Infinity;
	let maxX = -Infinity;
	let minZ = Infinity;
	let maxZ = -Infinity;

	for (const seg of track.segments) {
		if (seg.center.x < minX) minX = seg.center.x;
		if (seg.center.x > maxX) maxX = seg.center.x;
		if (seg.center.z < minZ) minZ = seg.center.z;
		if (seg.center.z > maxZ) maxZ = seg.center.z;
	}

	const rangeX = maxX - minX || 1;
	const rangeZ = maxZ - minZ || 1;
	const scale = (MAP_SIZE - PADDING * 2) / Math.max(rangeX, rangeZ);
	const offsetX = (MAP_SIZE - rangeX * scale) / 2;
	const offsetZ = (MAP_SIZE - rangeZ * scale) / 2;

	function toMapX(worldX: number): number {
		return (worldX - minX) * scale + offsetX;
	}

	function toMapY(worldZ: number): number {
		return (worldZ - minZ) * scale + offsetZ;
	}

	// Pre-compute sampled track polyline points string
	const trackPoints = $derived.by(() => {
		const pts: string[] = [];
		for (let i = 0; i < track.segments.length; i += SAMPLE_INTERVAL) {
			const seg = track.segments[i];
			pts.push(`${toMapX(seg.center.x).toFixed(1)},${toMapY(seg.center.z).toFixed(1)}`);
		}
		// Close the loop
		const first = track.segments[0];
		pts.push(`${toMapX(first.center.x).toFixed(1)},${toMapY(first.center.z).toFixed(1)}`);
		return pts.join(" ");
	});

	// Boost zone polyline segments (green highlights on track)
	const boostMarks = $derived.by(() => {
		const marks: { points: string }[] = [];
		for (const bz of track.boostZones) {
			const pts: string[] = [];
			for (let i = bz.segmentStart; i <= bz.segmentEnd && i < track.segments.length; i += 2) {
				const seg = track.segments[i];
				pts.push(`${toMapX(seg.center.x).toFixed(1)},${toMapY(seg.center.z).toFixed(1)}`);
			}
			// Ensure the end segment is included
			const endSeg = track.segments[Math.min(bz.segmentEnd, track.segments.length - 1)];
			pts.push(`${toMapX(endSeg.center.x).toFixed(1)},${toMapY(endSeg.center.z).toFixed(1)}`);
			if (pts.length >= 2) {
				marks.push({ points: pts.join(" ") });
			}
		}
		return marks;
	});

	// Item box positions (yellow dots)
	const itemBoxDots = $derived.by(() => {
		const dots: { cx: number; cy: number }[] = [];
		for (const ibz of track.itemBoxZones) {
			for (const pos of ibz.positions) {
				dots.push({
					cx: toMapX(pos.x),
					cy: toMapY(pos.z),
				});
			}
		}
		return dots;
	});

	// Kart dots — reactive on store.karts
	const kartDots = $derived.by(() => {
		const dots: {
			id: string;
			cx: number;
			cy: number;
			color: string;
			isLocal: boolean;
		}[] = [];

		for (const kart of Object.values(store.karts)) {
			const variantColor = CAR_VARIANT_COLORS[kart.carVariant] ?? "#FFFFFF";
			dots.push({
				id: kart.id,
				cx: toMapX(kart.position.x),
				cy: toMapY(kart.position.z),
				color: variantColor,
				isLocal: kart.id === store.localPlayerId,
			});
		}

		return dots;
	});

	// Pulse animation for local player (CSS-driven)
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
		<!-- Track outline -->
		<polyline
			points={trackPoints}
			fill="none"
			stroke="rgba(255, 255, 255, 0.3)"
			stroke-width="3"
			stroke-linejoin="round"
			stroke-linecap="round"
		/>

		<!-- Boost zone indicators (green overlay on track) -->
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

		<!-- Item box indicators (yellow dots) -->
		{#each itemBoxDots as dot}
			<circle
				cx={dot.cx}
				cy={dot.cy}
				r={2.5}
				fill="rgba(255, 217, 61, 0.8)"
				stroke="none"
			/>
		{/each}

		<!-- Kart dots — non-local first, then local on top -->
		{#each kartDots.filter((d) => !d.isLocal) as dot (dot.id)}
			<circle
				cx={dot.cx}
				cy={dot.cy}
				r={DOT_RADIUS}
				fill={dot.color}
				stroke="rgba(0,0,0,0.5)"
				stroke-width="1"
			/>
		{/each}

		{#each kartDots.filter((d) => d.isLocal) as dot (dot.id)}
			<!-- Pulse ring -->
			<circle
				cx={dot.cx}
				cy={dot.cy}
				r={localPulseRadius}
				fill="none"
				stroke={dot.color}
				stroke-width="1.5"
				opacity="0.5"
			/>
			<!-- Solid dot -->
			<circle
				cx={dot.cx}
				cy={dot.cy}
				r={LOCAL_DOT_RADIUS}
				fill={dot.color}
				stroke="#FFFFFF"
				stroke-width="1.5"
			/>
		{/each}
	</svg>
</div>

<style>
	.minimap {
		position: absolute;
		top: 12px;
		right: 12px;
		width: 150px;
		height: 150px;
		background: rgba(0, 0, 0, 0.6);
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 8px;
		pointer-events: none;
		z-index: 10;
		overflow: hidden;
	}
</style>
