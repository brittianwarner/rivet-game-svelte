<script lang="ts">
	import { setupRivetKit } from "@rivetkit/svelte";
	import type { registry } from "$lib/actors/registry";
	import "../app.css";

	setupRivetKit<typeof registry>(`${window.location.origin}/api/rivet`);

	let { children } = $props();
</script>

<div class="h-screen w-screen overflow-hidden">
	{@render children()}
</div>
