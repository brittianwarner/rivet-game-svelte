<!--
  Race Game Page — 4-player kart racing.
  Creates store, wires actor, provides context, renders RaceScene + HUD.
-->
<script lang="ts">
  import { page } from "$app/state";
  import { onMount } from "svelte";
  import RaceScene from "$lib/racing/components/RaceScene.svelte";
  import Minimap from "$lib/racing/components/Minimap.svelte";
  import { RaceStore } from "$lib/racing/race-store.svelte";
  import { setRaceStore, setRaceRoomControls } from "$lib/racing/context";
  import { useRaceRoom } from "$lib/racing/use-race-room.svelte";
  import { CAR_VARIANT_COLORS, RACE_LAP_COUNT, KART_MAX_SPEED } from "$lib/racing/types";

  const roomId = page.params.roomId ?? "";
  const searchParams =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
  const playerName = searchParams.get("name") ?? "Anonymous";
  const carVariant = parseInt(searchParams.get("car") ?? "0", 10) || 0;

  const store = new RaceStore();
  setRaceStore(store);

  const controls = useRaceRoom({ roomId, playerName, carVariant, store });
  setRaceRoomControls(controls);

  // Mobile detection
  let isMobile = $state(false);
  onMount(() => {
    isMobile = "ontouchstart" in window;

    if (!isMobile) return;

    let rafId = 0;
    const sendMobileInput = () => {
      if (controls.isConnected && store.localKart && !store.isSpectator) {
        controls.sendInput({
          steering: touchSteer,
          throttle: touchThrottle,
          brake: touchBrake,
          drift: touchDrift,
          useItem: false,
        });
      }

      rafId = window.requestAnimationFrame(sendMobileInput);
    };

    rafId = window.requestAnimationFrame(sendMobileInput);

    return () => {
      window.cancelAnimationFrame(rafId);
    };
  });

  // Position change indicator timing
  let showPositionDelta = $derived(
    store.positionDelta !== 0 && performance.now() - store.positionChangeTime < 2000,
  );

  // Copy link state
  let linkCopied = $state(false);

  // Position ordinal helper
  function ordinal(n: number): string {
    if (n === 1) return "1st";
    if (n === 2) return "2nd";
    if (n === 3) return "3rd";
    return `${n}th`;
  }

  // Format race time
  function formatTime(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    const centis = Math.floor((ms % 1000) / 10);
    return `${min}:${sec.toString().padStart(2, "0")}.${centis.toString().padStart(2, "0")}`;
  }

  // Speed percentage for bar
  function speedPercent(): number {
    if (!store.localKart) return 0;
    const max = KART_MAX_SPEED + (store.localKart.boostSpeed || 0);
    return Math.min(1, store.localKart.speed / max) * 100;
  }

  // Item display name
  function itemName(item: string | null): string {
    if (!item) return "";
    const names: Record<string, string> = {
      greenShell: "Green Shell",
      redShell: "Red Shell",
      blueShell: "Blue Shell",
      banana: "Banana",
      mushroom: "Mushroom",
      triMushroom: "Triple Mushroom",
      star: "Star",
      lightning: "Lightning",
    };
    return names[item] ?? item;
  }

  // Item color for display
  function itemColor(item: string | null): string {
    if (!item) return "#666";
    const colors: Record<string, string> = {
      greenShell: "#44FF88",
      redShell: "#FF4444",
      blueShell: "#4488FF",
      banana: "#FFD93D",
      mushroom: "#FF6644",
      triMushroom: "#FF6644",
      star: "#FFDD44",
      lightning: "#FFFF66",
    };
    return colors[item] ?? "#FFF";
  }

  // Get results list for finish screen
  function getResults(): { name: string; time: string; color: string }[] {
    return store.positions.map((id, i) => {
      const kart = store.karts[id];
      if (!kart) return { name: "Unknown", time: "--", color: "#666" };
      return {
        name: kart.name,
        time: kart.finishTime ? formatTime(kart.finishTime) : "DNF",
        color: CAR_VARIANT_COLORS[kart.carVariant] ?? "#FFF",
      };
    });
  }

  // Copy share link
  async function copyShareLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(window.location.href);
      linkCopied = true;
      setTimeout(() => (linkCopied = false), 2000);
    } catch {
      // fallback
    }
  }

  // Mobile touch controls state
  let touchSteer = $state(0);
  let touchThrottle = $state(false);
  let touchBrake = $state(false);
  let touchDrift = $state(false);
  let touchItem = $state(false);
  let steerTouchId = $state<number | null>(null);
  let steerStartX = $state(0);

  function handleSteerStart(e: TouchEvent): void {
    e.preventDefault();
    const touch = e.changedTouches[0];
    steerTouchId = touch.identifier;
    steerStartX = touch.clientX;
    touchSteer = 0;
  }

  function handleSteerMove(e: TouchEvent): void {
    e.preventDefault();
    for (const touch of e.changedTouches) {
      if (touch.identifier === steerTouchId) {
        const dx = touch.clientX - steerStartX;
        touchSteer = Math.max(-1, Math.min(1, dx / 60));
      }
    }
  }

  function handleSteerEnd(e: TouchEvent): void {
    for (const touch of e.changedTouches) {
      if (touch.identifier === steerTouchId) {
        steerTouchId = null;
        touchSteer = 0;
      }
    }
  }

  // Rematch vote count
  let rematchVoteCount = $derived(
    Object.values(store.rematchVotes).filter((v) => v).length,
  );

  // Drift charge colors
  const driftColors = ["#3399FF", "#FF8800", "#CC44FF"];
</script>

<div class="relative h-full w-full">
  <!-- 3D Scene -->
  <div class="absolute inset-0">
    <RaceScene />
  </div>

  <!-- Speed lines overlay -->
  {#if store.speedLineIntensity > 0 && !store.isSpectator}
    <div
      class="absolute inset-0 pointer-events-none overflow-hidden"
      style="opacity: {store.speedLineIntensity * 0.3}; z-index: 1"
    >
      {#each Array(20) as _, i}
        <div
          class="speed-line"
          style="
            position: absolute;
            top: 50%; left: 50%;
            width: 2px; height: 40vh;
            background: linear-gradient(to bottom, transparent, rgba(255,255,255,0.6), transparent);
            transform-origin: center top;
            transform: rotate({i * 18}deg) translateY(-20vh);
          "
        ></div>
      {/each}
    </div>
  {/if}

  <!-- HUD overlay -->
  <div class="pointer-events-none absolute inset-0" style="z-index: 10">

    <!-- Spectator badge -->
    {#if store.isSpectator}
      <div class="absolute top-1/2 left-4 -translate-y-1/2">
        <div
          class="rounded-lg border px-4 py-2 text-sm font-bold uppercase tracking-widest"
          style="background: rgba(0,0,0,0.7); border-color: var(--color-text-muted); color: var(--color-text-muted); backdrop-filter: blur(8px)"
        >
          Spectating
        </div>
      </div>
    {/if}

    <!-- Top bar: room info + leave button -->
    <div class="flex items-start justify-between p-4">
      <div
        class="pointer-events-auto rounded-lg border px-4 py-2"
        style="background: var(--color-surface); border-color: var(--color-border); backdrop-filter: blur(8px)"
      >
        <div class="text-sm font-semibold" style="color: var(--color-accent)">
          {store.roomId || roomId}
        </div>
        <div class="text-xs" style="color: var(--color-text-muted)">
          {store.playerCount}/{4} racers
        </div>
      </div>

      <button
        onclick={() => controls.leave()}
        class="pointer-events-auto rounded-lg border px-4 py-2 text-sm transition-colors hover:border-(--color-danger)"
        style="background: var(--color-surface); border-color: var(--color-border); color: var(--color-text-muted)"
      >
        Leave
      </button>
    </div>

    <!-- Position + Lap (centered, large) -->
    {#if store.phase === "racing" && !store.isSpectator}
      <div class="absolute left-1/2 top-4 -translate-x-1/2">
        <div
          class="rounded-xl border px-8 py-3 text-center"
          style="background: var(--color-surface); border-color: var(--color-border); backdrop-filter: blur(12px)"
        >
          <div class="flex items-center gap-6">
            <div class="flex items-center gap-2">
              <div
                class="text-4xl font-black tabular-nums"
                style="color: var(--color-accent)"
              >
                {ordinal(store.localPosition)}
              </div>
              <!-- Position change indicator -->
              {#if showPositionDelta}
                <div class="position-delta">
                  {#if store.positionDelta > 0}
                    <span style="color: #44FF88; font-size: 20px; font-weight: 900">&#9650;</span>
                  {:else}
                    <span style="color: #FF4444; font-size: 20px; font-weight: 900">&#9660;</span>
                  {/if}
                </div>
              {/if}
            </div>
            <div class="text-2xl font-light" style="color: var(--color-border)">|</div>
            <div>
              <div class="text-sm" style="color: var(--color-text-muted)">Lap</div>
              <div class="text-2xl font-bold tabular-nums" style="color: var(--color-text)">
                {Math.min(store.localLap + 1, RACE_LAP_COUNT)}/{RACE_LAP_COUNT}
              </div>
            </div>
            <div class="text-2xl font-light" style="color: var(--color-border)">|</div>
            <div>
              <div class="text-sm tabular-nums" style="color: var(--color-text-muted)">
                {formatTime(store.raceTimer)}
              </div>
            </div>
          </div>
        </div>
      </div>
    {/if}

    <!-- Toast notification stack -->
    <div class="absolute top-40 right-4 space-y-2 pointer-events-none" style="z-index: 20">
      {#each store.toasts as toast (toast.id)}
        <div
          class="toast-enter rounded-lg border px-4 py-2 text-sm font-bold"
          style="background: var(--color-surface); border-color: {toast.color}; color: {toast.color}; backdrop-filter: blur(8px)"
        >
          {toast.text}
        </div>
      {/each}
    </div>

    <!-- Item slot (bottom-right) -->
    {#if store.phase === "racing" && !store.isSpectator}
      <div class="absolute bottom-20 right-4">
        <div
          class="rounded-xl border px-4 py-3 text-center"
          style="background: var(--color-surface); border-color: {store.isItemRolling ? 'var(--color-text-muted)' : itemColor(store.localItem)}; backdrop-filter: blur(8px)"
        >
          <div class="text-xs" style="color: var(--color-text-muted)">Item</div>
          {#if store.isItemRolling}
            <!-- Item roulette animation -->
            <div
              class="mt-1 text-lg font-bold item-roulette"
              style="color: {itemColor(store.rollingItem)}"
            >
              {itemName(store.rollingItem)}
            </div>
          {:else if store.localItem}
            <div
              class="mt-1 text-lg font-bold"
              style="color: {itemColor(store.localItem)}"
            >
              {itemName(store.localItem)}
            </div>
            {#if store.localKart && store.localKart.itemCharges > 1}
              <div class="text-xs" style="color: var(--color-text-muted)">
                x{store.localKart.itemCharges}
              </div>
            {/if}
          {:else}
            <div class="mt-1 text-lg font-bold" style="color: #666">—</div>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Slipstream indicator -->
    {#if store.localSlipstream && store.phase === "racing" && !store.isSpectator}
      <div class="absolute bottom-20 left-1/2 -translate-x-1/2">
        <div class="slipstream-text text-sm font-black uppercase tracking-wider" style="color: #00CCFF">
          Slipstream
        </div>
      </div>
    {/if}

    <!-- Drift charge meter -->
    {#if store.localDriftActive && store.phase === "racing" && !store.isSpectator}
      <div class="absolute bottom-16 left-1/2 -translate-x-1/2">
        <div class="flex gap-1">
          {#each [1, 2, 3] as tier}
            <div
              class="h-3 w-10 rounded-full transition-all duration-150"
              style="background: {store.localDriftCharge >= tier
                ? driftColors[tier - 1]
                : 'var(--color-border)'};
                box-shadow: {store.localDriftCharge >= tier ? `0 0 8px ${driftColors[tier - 1]}` : 'none'}"
            ></div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Speed bar (bottom-center) -->
    {#if store.localPlayerId && store.phase !== "finished" && !store.isSpectator}
      <div class="absolute bottom-4 left-1/2 -translate-x-1/2">
        <div
          class="rounded-lg border px-4 py-2"
          style="background: var(--color-surface); border-color: var(--color-border); backdrop-filter: blur(8px)"
        >
          <div class="flex items-center gap-3">
            <div class="text-xs font-medium" style="color: var(--color-text-muted)">
              SPEED
            </div>
            <div
              class="h-2 w-32 overflow-hidden rounded-full"
              style="background: var(--color-border)"
            >
              <div
                class="h-full rounded-full transition-all"
                style="width: {speedPercent()}%; background: var(--color-accent)"
              ></div>
            </div>
          </div>
          {#if !isMobile}
            <div class="mt-1 flex items-center justify-center gap-4 text-xs" style="color: var(--color-text-muted)">
              <span><b>WASD</b> move</span>
              <span><b>Shift</b> drift</span>
              <span><b>E</b> item</span>
            </div>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Minimap (top-right, below leave button) -->
    {#if store.phase === "racing"}
      <div class="absolute top-16 right-4">
        <Minimap />
      </div>
    {/if}

    <!-- Animated countdown overlay -->
    {#if store.phase === "countdown"}
      <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
        {#if store.countdownNumber !== null}
          {#key store.countdownNumber}
            <div class="countdown-number" style="color: white; font-size: 120px; font-weight: 900; line-height: 1;">
              {store.countdownNumber}
            </div>
          {/key}
        {:else}
          <div class="countdown-go" style="color: var(--color-accent); font-size: 120px; font-weight: 900; line-height: 1;">
            GO!
          </div>
        {/if}
      </div>
    {/if}

    <!-- Waiting for players -->
    {#if store.phase === "waiting" && controls.isConnected}
      <div class="absolute inset-0 flex items-center justify-center">
        <div
          class="rounded-xl border px-8 py-6 text-center"
          style="background: var(--color-surface); border-color: var(--color-border); backdrop-filter: blur(12px)"
        >
          <div class="text-lg font-semibold" style="color: var(--color-accent)">
            Waiting for racers...
          </div>
          <div class="mt-2 text-sm" style="color: var(--color-text-muted)">
            {store.playerCount}/4 racers. Start solo or wait for more racers to join.
          </div>

          <!-- Ready state display -->
          {#if Object.keys(store.readyPlayers).length > 0}
            <div class="mt-3 space-y-1">
              {#each Object.entries(store.karts) as [id, kart]}
                <div class="flex items-center gap-2 text-xs">
                  <div
                    class="h-2 w-2 rounded-full"
                    style="background: {store.readyPlayers[id] ? '#44FF88' : 'var(--color-border)'}"
                  ></div>
                  <span style="color: {store.readyPlayers[id] ? 'var(--color-text)' : 'var(--color-text-muted)'}">
                    {kart.name} {store.readyPlayers[id] ? '(Ready)' : ''}
                  </span>
                </div>
              {/each}
            </div>
          {/if}

          <!-- Ready up button -->
          {#if store.localPlayerId && !store.readyPlayers[store.localPlayerId]}
            <button
              onclick={() => controls.readyUp()}
              class="pointer-events-auto mt-4 rounded-lg px-6 py-2 text-sm font-bold text-black transition-opacity hover:opacity-90"
              style="background: var(--color-accent)"
            >
              {store.playerCount <= 1 ? "Start Solo Race" : "Ready Up"}
            </button>
          {:else if store.localPlayerId && store.readyPlayers[store.localPlayerId]}
            <div class="mt-4 text-sm font-semibold" style="color: #44FF88">
              You're ready!
            </div>
          {/if}

          <!-- Copy share link -->
          <button
            onclick={copyShareLink}
            class="pointer-events-auto mt-3 rounded-lg border px-4 py-1.5 text-xs font-medium transition-colors hover:border-(--color-accent)"
            style="background: var(--color-surface); border-color: var(--color-border); color: var(--color-text-muted)"
          >
            {linkCopied ? "Link Copied!" : "Copy Room Link"}
          </button>
        </div>
      </div>
    {/if}

    <!-- Race finished overlay -->
    {#if store.phase === "finished"}
      {@const results = getResults()}
      {@const localFinish = store.localKart?.finishPosition}
      <div class="absolute inset-0 flex items-center justify-center">
        <div
          class="rounded-xl border px-12 py-8 text-center"
          style="background: var(--color-surface); border-color: var(--color-accent); backdrop-filter: blur(16px)"
        >
          <div class="text-5xl font-black" style="color: var(--color-accent)">
            {localFinish === 1 ? "YOU WIN!" : "RACE OVER"}
          </div>

          <!-- Results table -->
          <div class="mt-6 space-y-2">
            {#each results as result, i}
              <div class="flex items-center gap-4 text-left">
                <span class="text-lg font-bold w-10" style="color: {result.color}">
                  {ordinal(i + 1)}
                </span>
                <span class="flex-1 font-medium" style="color: var(--color-text)">
                  {result.name}
                </span>
                <span class="tabular-nums text-sm" style="color: var(--color-text-muted)">
                  {result.time}
                </span>
              </div>
            {/each}
          </div>

          <!-- Race stats -->
          {#if Object.keys(store.raceStats).length > 0 && store.localPlayerId && store.raceStats[store.localPlayerId]}
            {@const stats = store.raceStats[store.localPlayerId]}
            <div class="mt-4 border-t pt-4" style="border-color: var(--color-border)">
              <div class="text-xs font-medium uppercase tracking-wider" style="color: var(--color-text-muted)">
                Your Stats
              </div>
              <div class="mt-2 grid grid-cols-3 gap-3 text-center">
                {#if stats.itemsUsed !== undefined}
                  <div>
                    <div class="text-lg font-bold" style="color: var(--color-text)">{stats.itemsUsed}</div>
                    <div class="text-xs" style="color: var(--color-text-muted)">Items Used</div>
                  </div>
                {/if}
                {#if stats.hitsDealt !== undefined}
                  <div>
                    <div class="text-lg font-bold" style="color: var(--color-text)">{stats.hitsDealt}</div>
                    <div class="text-xs" style="color: var(--color-text-muted)">Hits Dealt</div>
                  </div>
                {/if}
                {#if stats.driftBoosts !== undefined}
                  <div>
                    <div class="text-lg font-bold" style="color: var(--color-text)">{stats.driftBoosts}</div>
                    <div class="text-xs" style="color: var(--color-text-muted)">Drift Boosts</div>
                  </div>
                {/if}
                {#if stats.bestLapTime}
                  <div>
                    <div class="text-lg font-bold" style="color: var(--color-text)">{formatTime(stats.bestLapTime)}</div>
                    <div class="text-xs" style="color: var(--color-text-muted)">Best Lap</div>
                  </div>
                {/if}
              </div>
            </div>
          {/if}

          <!-- Rematch + Leave buttons -->
          <div class="mt-4 flex items-center justify-center gap-4">
            <button
              onclick={() => controls.voteRematch()}
              class="pointer-events-auto rounded-lg border px-6 py-2 text-sm font-semibold transition-opacity hover:opacity-90"
              style="background: var(--color-accent); color: black; border-color: var(--color-accent)"
            >
              Rematch ({rematchVoteCount}/{store.playerCount})
            </button>
            <button
              onclick={() => controls.leave()}
              class="pointer-events-auto rounded-lg border px-6 py-2 text-sm font-semibold transition-colors hover:border-(--color-accent)"
              style="background: var(--color-surface); border-color: var(--color-border); color: var(--color-text)"
            >
              Leave
            </button>
          </div>
        </div>
      </div>
    {/if}

    <!-- Mobile touch controls -->
    {#if isMobile && store.phase === "racing" && !store.isSpectator}
      <!-- Left side: steering area -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="pointer-events-auto absolute bottom-0 left-0 w-1/2 h-1/3"
        style="z-index: 30"
        ontouchstart={handleSteerStart}
        ontouchmove={handleSteerMove}
        ontouchend={handleSteerEnd}
        ontouchcancel={handleSteerEnd}
      >
        <div
          class="absolute bottom-8 left-8 flex items-center justify-center rounded-full border"
          style="width: 100px; height: 100px; background: rgba(255,255,255,0.05); border-color: var(--color-border)"
        >
          <div class="text-xs font-medium" style="color: var(--color-text-muted)">STEER</div>
          <!-- Steer indicator -->
          <div
            class="absolute h-8 w-8 rounded-full"
            style="background: var(--color-accent); opacity: 0.4; transform: translateX({touchSteer * 30}px)"
          ></div>
        </div>
      </div>

      <!-- Right side: buttons -->
      <div class="pointer-events-auto absolute bottom-4 right-4 flex flex-col items-end gap-2" style="z-index: 30">
        <!-- Throttle -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="flex items-center justify-center rounded-full border text-xs font-bold select-none"
          style="width: 64px; height: 64px; background: {touchThrottle ? 'var(--color-accent)' : 'rgba(255,255,255,0.08)'}; border-color: var(--color-accent); color: {touchThrottle ? 'black' : 'var(--color-accent)'}"
          ontouchstart={() => (touchThrottle = true)}
          ontouchend={() => (touchThrottle = false)}
          ontouchcancel={() => (touchThrottle = false)}
        >
          GAS
        </div>
        <div class="flex gap-2">
          <!-- Brake -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="flex items-center justify-center rounded-full border text-xs font-bold select-none"
            style="width: 48px; height: 48px; background: {touchBrake ? '#FF4444' : 'rgba(255,255,255,0.08)'}; border-color: #FF4444; color: {touchBrake ? 'black' : '#FF4444'}"
            ontouchstart={() => (touchBrake = true)}
            ontouchend={() => (touchBrake = false)}
            ontouchcancel={() => (touchBrake = false)}
          >
            BRK
          </div>
          <!-- Drift -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="flex items-center justify-center rounded-full border text-xs font-bold select-none"
            style="width: 48px; height: 48px; background: {touchDrift ? '#CC44FF' : 'rgba(255,255,255,0.08)'}; border-color: #CC44FF; color: {touchDrift ? 'black' : '#CC44FF'}"
            ontouchstart={() => (touchDrift = true)}
            ontouchend={() => (touchDrift = false)}
            ontouchcancel={() => (touchDrift = false)}
          >
            DFT
          </div>
          <!-- Item -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="flex items-center justify-center rounded-full border text-xs font-bold select-none"
            style="width: 48px; height: 48px; background: {touchItem ? '#FFD93D' : 'rgba(255,255,255,0.08)'}; border-color: #FFD93D; color: {touchItem ? 'black' : '#FFD93D'}"
            ontouchstart={() => { touchItem = true; controls.useItem(); }}
            ontouchend={() => (touchItem = false)}
            ontouchcancel={() => (touchItem = false)}
          >
            ITM
          </div>
        </div>
      </div>
    {/if}

    <!-- Connection error -->
    {#if store.connectionError}
      <div
        class="absolute inset-0 flex items-center justify-center"
        style="background: rgba(0,0,0,0.8)"
      >
        <div class="text-center">
          <div class="text-lg font-semibold" style="color: var(--color-danger)">
            {store.connectionError}
          </div>
          <button
            onclick={() => controls.leave()}
            class="pointer-events-auto mt-4 rounded-lg border px-6 py-2 text-sm font-semibold transition-colors hover:border-(--color-accent)"
            style="background: var(--color-surface); border-color: var(--color-border); color: var(--color-text)"
          >
            Back to Lobby
          </button>
        </div>
      </div>
    {:else if controls.connStatus === "reconnecting"}
      <div class="absolute top-0 left-0 right-0 z-50 px-4 py-2 text-center text-sm" style="background: rgba(180,120,0,0.85); color: #ffe0a0">
        Reconnecting...
      </div>
    {:else if !controls.isConnected}
      <div
        class="absolute inset-0 flex items-center justify-center"
        style="background: var(--color-bg)"
      >
        <div class="text-center">
          <div class="text-lg font-semibold" style="color: var(--color-accent)">
            Connecting...
          </div>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  /* Countdown pop animation */
  .countdown-number {
    animation: countdownPop 0.4s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
    text-shadow: 0 0 40px rgba(255, 255, 255, 0.5), 0 0 80px rgba(10, 158, 245, 0.3);
  }

  @keyframes countdownPop {
    from {
      transform: scale(2);
      opacity: 0.5;
    }
    to {
      transform: scale(1);
      opacity: 1;
    }
  }

  /* GO! pop + fade animation */
  .countdown-go {
    animation: goPop 0.6s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
    text-shadow: 0 0 40px rgba(10, 158, 245, 0.6), 0 0 80px rgba(10, 158, 245, 0.3);
  }

  @keyframes goPop {
    0% {
      transform: scale(2);
      opacity: 0.5;
    }
    40% {
      transform: scale(1.2);
      opacity: 1;
    }
    100% {
      transform: scale(0.5);
      opacity: 0;
    }
  }

  /* Toast enter animation */
  .toast-enter {
    animation: toastSlideIn 0.3s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
  }

  @keyframes toastSlideIn {
    from {
      transform: translateX(40px);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }

  /* Position delta animation */
  .position-delta {
    animation: positionPop 0.4s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
  }

  @keyframes positionPop {
    from {
      transform: scale(2);
      opacity: 0;
    }
    50% {
      transform: scale(1.2);
      opacity: 1;
    }
    to {
      transform: scale(1);
      opacity: 1;
    }
  }

  /* Item roulette flash */
  .item-roulette {
    animation: itemFlash 0.1s ease-in-out infinite alternate;
  }

  @keyframes itemFlash {
    from {
      opacity: 0.6;
    }
    to {
      opacity: 1;
    }
  }

  /* Slipstream glow text */
  .slipstream-text {
    animation: slipstreamPulse 0.8s ease-in-out infinite alternate;
    text-shadow: 0 0 10px #00CCFF, 0 0 20px #00CCFF, 0 0 40px rgba(0, 204, 255, 0.4);
  }

  @keyframes slipstreamPulse {
    from {
      opacity: 0.7;
      text-shadow: 0 0 10px #00CCFF, 0 0 20px #00CCFF;
    }
    to {
      opacity: 1;
      text-shadow: 0 0 10px #00CCFF, 0 0 20px #00CCFF, 0 0 40px rgba(0, 204, 255, 0.4);
    }
  }

  /* Speed line subtle animation */
  .speed-line {
    animation: speedLineFade 0.5s ease-in-out infinite alternate;
  }

  @keyframes speedLineFade {
    from {
      opacity: 0.4;
    }
    to {
      opacity: 1;
    }
  }
</style>
