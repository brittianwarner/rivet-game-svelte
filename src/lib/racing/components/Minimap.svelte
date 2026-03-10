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
	const DOT_RADIUS = 4;
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

	const kartDots = $derived.by(() => {
		const dots: {
			id: string;
			cx: number;
			cy: number;
			color: string;
			isLocal: boolean;
		}[] = [];

		for (const kart of Object.values(store.karts)) {
			dots.push({
				id: kart.id,
				cx: toMapX(kart.position.x),
				cy: toMapY(kart.position.z),
				color: getPlayerAccentColor(kart.accentIndex),
				isLocal: kart.id === store.localPlayerId,
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

		<!-- Item box indicators -->
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
			<circle
				cx={dot.cx}
				cy={dot.cy}
				r={localPulseRadius}
				fill="none"
				stroke={dot.color}
				stroke-width="1.5"
				opacity="0.5"
			/>
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
		width: 220px;
		height: 220px;
		background: rgba(0, 0, 0, 0.6);
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 8px;
		pointer-events: none;
		z-index: 10;
		overflow: hidden;
	}
</style>
