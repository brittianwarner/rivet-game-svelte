<script lang="ts">
  import { goto } from "$app/navigation";
  import { getRivetContext } from "@rivetkit/svelte";
  import type { registry } from "$lib/actors/registry";
  import {
    RACE_MAX_PLAYERS,
    RACE_LAP_COUNT,
    LAP_COUNT_MIN,
    LAP_COUNT_MAX,
    DEFAULT_BOT_DIFFICULTY,
    type TrackId,
    type BotDifficulty,
  } from "$lib/racing/types";
  import { listTracks, DEFAULT_TRACK_ID, coerceTrackId, getTrackMeta } from "$lib/racing/track";
  import { getSoundManager } from "$lib/racing/sound-manager.svelte";
  import {
    listPersonalBests,
    type PersonalBest,
  } from "$lib/racing/ghost-recorder";
  import {
    CURATED_RACE_CARS,
    DEFAULT_RACE_CAR_ID,
    PLAYER_ACCENT_COLORS,
    coerceRaceCarId,
    getCarStats,
    type CarStats,
    type RaceCarId,
  } from "$lib/racing/car-catalog";

  // The lobby surfaces race-room track config on each card.
  interface RaceLobbyRoom {
    id: string;
    name: string;
    game?: "bump" | "race";
    playerCount: number;
    maxPlayers: number;
    status: "waiting" | "playing" | "racing";
    createdAt: number;
    trackId?: string;
    trackName?: string;
    lapCount?: number;
  }

  interface LobbyActions {
    listRooms(): Promise<RaceLobbyRoom[]>;
    createRoom(name: string, game: string): Promise<{ success: boolean; roomId?: string; message?: string }>;
    findOrCreateRoom(game: string): Promise<{ success: boolean; roomId?: string; message?: string }>;
  }

  const TRACKS = listTracks();

  const { useActor } = getRivetContext<typeof registry>();
  const lobby = useActor({ name: "lobby", key: ["main"] }) as ReturnType<typeof useActor> & LobbyActions;

  // Synthesized audio engine (singleton, shared with the play page). The mute +
  // volume control here persists to localStorage; resume() unlocks the
  // suspended AudioContext on the first user gesture in the lobby and starts the
  // quiet "waiting"-intensity lobby loop.
  const sound = getSoundManager();
  function unlockAudio(): void {
    // resume() lazily creates + resumes the AudioContext. The music scheduler
    // queues into that context immediately; queued notes simply play once the
    // (async) resume completes.
    sound.resume();
    sound.setMusic("waiting");
  }

  // Persisted identity (shared keys with the play page so deep links stay
  // honest). Falls back to a random racer handle on first visit.
  const NAME_KEY = "rivetKart.playerName";
  const CAR_KEY = "rivetKart.carId";
  const TRACK_KEY = "rivetKart.trackId";
  const LAPS_KEY = "rivetKart.lapCount";
  const ITEMS_KEY = "rivetKart.itemsEnabled";
  const BOTS_KEY = "rivetKart.botsEnabled";
  const BOT_DIFF_KEY = "rivetKart.botDifficulty";

  function loadStoredName(): string {
    if (typeof localStorage === "undefined") {
      return `Racer_${Math.random().toString(36).slice(2, 5)}`;
    }
    const stored = (localStorage.getItem(NAME_KEY) ?? "").trim();
    return stored || `Racer_${Math.random().toString(36).slice(2, 5)}`;
  }

  function loadStoredCar(): RaceCarId {
    if (typeof localStorage === "undefined") return DEFAULT_RACE_CAR_ID;
    return coerceRaceCarId(localStorage.getItem(CAR_KEY));
  }

  function loadStoredTrack(): TrackId {
    if (typeof localStorage === "undefined") return DEFAULT_TRACK_ID;
    return coerceTrackId(localStorage.getItem(TRACK_KEY));
  }

  function loadStoredLaps(): number {
    if (typeof localStorage === "undefined") return RACE_LAP_COUNT;
    const n = Number(localStorage.getItem(LAPS_KEY));
    if (!Number.isFinite(n)) return RACE_LAP_COUNT;
    return Math.max(LAP_COUNT_MIN, Math.min(LAP_COUNT_MAX, Math.round(n)));
  }

  function loadStoredItems(): boolean {
    if (typeof localStorage === "undefined") return true;
    return localStorage.getItem(ITEMS_KEY) !== "false";
  }

  function loadStoredBots(): boolean {
    if (typeof localStorage === "undefined") return true;
    return localStorage.getItem(BOTS_KEY) !== "false";
  }

  function loadStoredBotDifficulty(): BotDifficulty {
    if (typeof localStorage === "undefined") return DEFAULT_BOT_DIFFICULTY;
    const v = localStorage.getItem(BOT_DIFF_KEY);
    return v === "easy" || v === "medium" || v === "hard"
      ? v
      : DEFAULT_BOT_DIFFICULTY;
  }

  let rooms = $state<RaceLobbyRoom[]>([]);
  let newRoomName = $state("");
  let isQuickMatching = $state(false);
  let playerName = $state(loadStoredName());
  let selectedCarId = $state<RaceCarId>(loadStoredCar());
  let selectedTrackId = $state<TrackId>(loadStoredTrack());
  let lapCount = $state(loadStoredLaps());
  let itemsEnabled = $state(loadStoredItems());
  let botsEnabled = $state(loadStoredBots());
  let botDifficulty = $state<BotDifficulty>(loadStoredBotDifficulty());
  let isCreating = $state(false);
  let linkCopiedToast = $state(false);
  let actionError = $state<string | null>(null);

  // Persist identity + race settings whenever they change so the play page can
  // fall back to them and the next room starts from the same picks.
  $effect(() => {
    const name = playerName.trim();
    if (typeof localStorage !== "undefined" && name) {
      localStorage.setItem(NAME_KEY, name);
    }
  });
  $effect(() => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(CAR_KEY, selectedCarId);
    }
  });
  $effect(() => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(TRACK_KEY, selectedTrackId);
      localStorage.setItem(LAPS_KEY, String(lapCount));
      localStorage.setItem(ITEMS_KEY, String(itemsEnabled));
      localStorage.setItem(BOTS_KEY, String(botsEnabled));
      localStorage.setItem(BOT_DIFF_KEY, botDifficulty);
    }
  });

  const selectedTrack = $derived(
    TRACKS.find((t) => t.id === selectedTrackId) ?? TRACKS[0],
  );

  // A trimmed, non-empty name is required before joining/creating.
  let trimmedName = $derived(playerName.trim());
  let nameValid = $derived(trimmedName.length > 0);

  // Representative accent swatch per car (slot-assigned accents come from the
  // same palette server-side — this just gives each card a stable color tag).
  function carSwatch(index: number): string {
    return PLAYER_ACCENT_COLORS[index % PLAYER_ACCENT_COLORS.length];
  }

  // Compact stat bars: map each car's handling multiplier onto a 1-5 pip
  // scale. The multipliers are tight (~±12%), so each dimension is rescaled
  // against a visible range so archetype differences read at a glance. The
  // values mirror the physics: Drift uses driftChargeMult, Handling turnMult.
  type StatKey = "Speed" | "Accel" | "Handling" | "Drift";
  const STAT_RANGES: Record<StatKey, [number, number]> = {
    // [multiplier mapped to 1 pip, multiplier mapped to 5 pips]
    Speed: [0.94, 1.08],
    Accel: [0.9, 1.14],
    Handling: [0.92, 1.1],
    Drift: [0.95, 1.22],
  };
  function statPips(stats: CarStats, key: StatKey): number {
    const mult =
      key === "Speed"
        ? stats.maxSpeedMult
        : key === "Accel"
          ? stats.accelMult
          : key === "Handling"
            ? stats.turnMult
            : stats.driftChargeMult;
    const [lo, hi] = STAT_RANGES[key];
    const t = (mult - lo) / (hi - lo);
    return Math.max(1, Math.min(5, Math.round(1 + t * 4)));
  }
  const STAT_KEYS: StatKey[] = ["Speed", "Accel", "Handling", "Drift"];

  const BOT_DIFFICULTIES: BotDifficulty[] = ["easy", "medium", "hard"];

  // Load rooms when connected
  $effect(() => {
    if (lobby.isConnected) {
      loadRooms();
    }
  });

  lobby.onEvent("roomCreated", () => loadRooms());
  lobby.onEvent("roomUpdated", () => loadRooms());
  lobby.onEvent("roomRemoved", () => loadRooms());

  async function loadRooms(): Promise<void> {
    try {
      const all = await lobby.listRooms();
      // Filter to race rooms only
      rooms = all.filter((r: any) => r.game === "race");
    } catch {
      // Will retry on next event
    }
  }

  // Navigate into a room carrying the player's chosen identity. Settings ride
  // along so that whichever player first reaches a fresh room configures it
  // (the server ignores them once the room is configured / out of waiting).
  function joinUrl(
    roomId: string,
    withSettings: boolean,
    roomName?: string,
    mode: "race" | "timeTrial" = "race",
    trackOverride?: TrackId,
  ): string {
    const params = new URLSearchParams({
      name: trimmedName,
      carId: selectedCarId,
    });
    if (withSettings) {
      params.set("trackId", trackOverride ?? selectedTrackId);
      params.set("mode", mode);
      params.set("laps", String(lapCount));
      // Time trial is the player vs the clock + ghost — never seat CPU bots.
      params.set("items", itemsEnabled ? "1" : "0");
      params.set("bots", mode === "timeTrial" ? "0" : botsEnabled ? "1" : "0");
      params.set("botDiff", botDifficulty);
    }
    // The creator's room name configures state.name on the fresh room.
    if (roomName) params.set("roomName", roomName);
    return `/race/play/${roomId}?${params.toString()}`;
  }

  async function createRoom(): Promise<void> {
    unlockAudio();
    if (!nameValid) {
      actionError = "Enter your name before creating a room.";
      return;
    }
    const customRoomName = newRoomName.trim();
    const name = customRoomName || "Race Room";
    isCreating = true;
    actionError = null;
    try {
      const result = await lobby.createRoom(name, "race");
      if (result.success && result.roomId) {
        newRoomName = "";
        // Copy the BARE room link (no identity params) so it can be shared
        // without impersonating the creator.
        const url = `${window.location.origin}/race/play/${result.roomId}`;
        try {
          await navigator.clipboard.writeText(url);
          linkCopiedToast = true;
          setTimeout(() => (linkCopiedToast = false), 2000);
        } catch {
          // Clipboard not available, proceed anyway
        }
        // Creator carries the chosen settings + room name — they configure the
        // fresh room (a blank name defaults to the track name server-side).
        goto(joinUrl(result.roomId, true, customRoomName || undefined));
      } else {
        actionError = result.message ?? "Couldn't create the room. Try again.";
      }
    } catch {
      actionError = "Couldn't create the room. Check your connection.";
    } finally {
      isCreating = false;
    }
  }

  function joinRoom(roomId: string): void {
    unlockAudio();
    if (!nameValid) {
      actionError = "Enter your name before joining a room.";
      return;
    }
    actionError = null;
    // Joining an existing room — never impose our settings on it.
    goto(joinUrl(roomId, false));
  }

  async function quickMatch(): Promise<void> {
    unlockAudio();
    if (!nameValid) {
      actionError = "Enter your name before finding a race.";
      return;
    }
    isQuickMatching = true;
    actionError = null;
    try {
      const result = await lobby.findOrCreateRoom("race");
      if (result.success && result.roomId) {
        // Quick match may land in a fresh OR an existing room — carry settings;
        // the server applies them only to a fresh, unconfigured room.
        goto(joinUrl(result.roomId, true));
      } else {
        actionError = result.message ?? "No race available. Try again.";
      }
    } catch {
      actionError = "Couldn't find a race. Check your connection.";
    } finally {
      isQuickMatching = false;
    }
  }

  // Time trial: race the clock + your localStorage ghost, solo. We mint a fresh
  // private room (unique id) so the player never lands in someone else's race,
  // and carry mode=timeTrial in the settings the first joiner applies.
  let isStartingTimeTrial = $state(false);
  async function startTimeTrial(trackId: TrackId): Promise<void> {
    unlockAudio();
    if (!nameValid) {
      actionError = "Enter your name before a time trial.";
      return;
    }
    isStartingTimeTrial = true;
    actionError = null;
    try {
      const roomId = `tt_${trackId}_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 7)}`;
      const name = `Time Trial · ${getTrackMeta(trackId).displayName}`;
      goto(joinUrl(roomId, true, name, "timeTrial", trackId));
    } catch {
      actionError = "Couldn't start the time trial. Try again.";
    } finally {
      isStartingTimeTrial = false;
    }
  }

  // Personal bests (localStorage ghosts), grouped per track for the lobby panel.
  let personalBests = $state<PersonalBest[]>([]);
  function refreshPersonalBests(): void {
    personalBests = listPersonalBests();
  }
  $effect(() => {
    refreshPersonalBests();
  });
  // Best total + best lap per track (best across cars), for the compact panel.
  const bestByTrack = $derived.by(() => {
    const map = new Map<
      string,
      { trackId: TrackId; totalMs: number; bestLapMs: number | null }
    >();
    for (const pb of personalBests) {
      const cur = map.get(pb.trackId);
      if (!cur || pb.totalMs < cur.totalMs) {
        map.set(pb.trackId, {
          trackId: pb.trackId,
          totalMs: pb.totalMs,
          bestLapMs: pb.bestLapMs,
        });
      } else if (
        pb.bestLapMs != null &&
        (cur.bestLapMs == null || pb.bestLapMs < cur.bestLapMs)
      ) {
        cur.bestLapMs = pb.bestLapMs;
      }
    }
    return TRACKS.map((t) => map.get(t.id)).filter(
      (e): e is { trackId: TrackId; totalMs: number; bestLapMs: number | null } =>
        !!e,
    );
  });

  // m:ss.cc formatter (mirrors RaceStore.formatRaceTime; inlined so the lobby
  // doesn't pull the whole race store + physics into its bundle).
  function fmtTime(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) ms = 0;
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    const cs = Math.floor((ms % 1000) / 10);
    return `${min}:${sec.toString().padStart(2, "0")}.${cs.toString().padStart(2, "0")}`;
  }
</script>

<div class="flex h-full items-center justify-center">
  <div class="w-full max-w-lg space-y-8 p-8">
    <!-- Title -->
    <div class="text-center">
      <h1 class="text-5xl font-bold tracking-tight" style="color: var(--color-accent)">
        RIVET KART
      </h1>
      <p class="mt-2" style="color: var(--color-text-muted)">
        4-Player Kart Racing
      </p>
    </div>

    <!-- Link copied toast -->
    {#if linkCopiedToast}
      <div class="lobby-toast rounded-lg border px-4 py-2 text-center text-sm font-semibold"
           style="background: var(--color-surface); border-color: #44FF88; color: #44FF88">
        Room link copied to clipboard!
      </div>
    {/if}

    <!-- Action error (create/quick-match failures + validation) -->
    {#if actionError}
      <div
        role="alert"
        aria-live="assertive"
        class="lobby-toast rounded-lg border px-4 py-2 text-center text-sm font-semibold"
        style="background: var(--color-surface); border-color: var(--color-danger); color: var(--color-danger)"
      >
        {actionError}
      </div>
    {/if}

    <!-- Player Name -->
    <div class="space-y-2">
      <label
        for="player-name"
        class="block text-sm font-medium"
        style="color: var(--color-text-muted)"
      >
        Your Name
      </label>
      <input
        id="player-name"
        type="text"
        bind:value={playerName}
        maxlength="20"
        aria-invalid={!nameValid}
        class="w-full rounded-lg border px-4 py-2.5 text-sm outline-none transition-colors focus:border-(--color-accent)"
        style="background: var(--color-surface); border-color: {nameValid
          ? 'var(--color-border)'
          : 'var(--color-danger)'}; color: var(--color-text)"
        placeholder="Enter your name"
      />
      {#if !nameValid}
        <p class="text-xs" style="color: var(--color-danger)">
          A name is required to race.
        </p>
      {/if}
    </div>

    <!-- Car Selection -->
    <div class="space-y-2">
      <div
        class="block text-sm font-medium"
        style="color: var(--color-text-muted)"
      >
        Select Car
      </div>
      <div class="grid grid-cols-2 gap-3">
        {#each CURATED_RACE_CARS as car, i}
          <!-- Per-car handling stats — the same multipliers the physics uses. -->
          {@const carStats = getCarStats(car.id)}
          <button
            onclick={() => (selectedCarId = car.id)}
            aria-pressed={selectedCarId === car.id}
            class="rounded-lg border-2 px-4 py-3 text-left text-sm transition-all"
            style={
              selectedCarId === car.id
                ? "background: color-mix(in srgb, var(--color-accent) 16%, var(--color-surface));" +
                  "border-color: var(--color-accent); color: var(--color-text);"
                : "background: var(--color-surface); border-color: var(--color-border); color: var(--color-text);"
            }
          >
            <div class="flex items-center gap-2">
              <span
                class="inline-block h-3 w-3 shrink-0 rounded-full"
                style="background: {carSwatch(i)}; box-shadow: 0 0 6px {carSwatch(i)}"
                aria-hidden="true"
              ></span>
              <span class="font-semibold">{car.name}</span>
            </div>
            <div class="mt-1 text-xs" style="color: var(--color-text-muted)">
              {car.tagline}
            </div>
            <!-- Per-car stat bars (Speed / Accel / Handling / Drift) — the
                 5-pip scale is derived from the same multipliers the physics
                 uses, so the card now tells the truth about each archetype. -->
            <div class="mt-2 space-y-1">
              {#each STAT_KEYS as statKey}
                {@const pips = statPips(carStats, statKey)}
                <div class="flex items-center gap-1.5">
                  <span
                    class="w-16 shrink-0 text-[10px] uppercase tracking-wide"
                    style="color: var(--color-text-muted)"
                  >{statKey}</span>
                  <div
                    class="flex gap-0.5"
                    role="img"
                    aria-label="{statKey} {pips} out of 5"
                  >
                    {#each Array(5) as _, p}
                      <span
                        class="h-1.5 w-3 rounded-sm"
                        style="background: {p < pips
                          ? selectedCarId === car.id
                            ? 'var(--color-accent)'
                            : 'var(--color-text)'
                          : 'var(--color-border)'}"
                        aria-hidden="true"
                      ></span>
                    {/each}
                  </div>
                </div>
              {/each}
            </div>
          </button>
        {/each}
      </div>
    </div>

    <!-- Track Selection -->
    <div class="space-y-2">
      <div class="block text-sm font-medium" style="color: var(--color-text-muted)">
        Select Track
      </div>
      <div class="grid grid-cols-2 gap-3">
        {#each TRACKS as track}
          <div
            class="flex flex-col overflow-hidden rounded-lg border-2 transition-all"
            style={
              selectedTrackId === track.id
                ? "background: color-mix(in srgb, var(--color-accent) 16%, var(--color-surface));" +
                  "border-color: var(--color-accent);"
                : "background: var(--color-surface); border-color: var(--color-border);"
            }
          >
            <button
              onclick={() => (selectedTrackId = track.id)}
              aria-pressed={selectedTrackId === track.id}
              class="px-4 py-3 text-left text-sm transition-all"
              style="color: var(--color-text)"
            >
              <div class="font-semibold">{track.displayName}</div>
              <div class="mt-1 flex items-center gap-2 text-xs" style="color: var(--color-text-muted)">
                <span class="capitalize">{track.difficulty}</span>
                <span>·</span>
                <span>~{(track.lengthM / 1000).toFixed(1)}k units</span>
              </div>
            </button>
            <!-- Time Trial: solo run vs the clock + your localStorage ghost. -->
            <button
              onclick={() => startTimeTrial(track.id)}
              disabled={isStartingTimeTrial || !lobby.isConnected || !nameValid}
              class="border-t px-4 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide transition-opacity hover:opacity-90 disabled:opacity-50"
              style="border-color: var(--color-border); color: var(--color-accent)"
            >
              ⏱ Time Trial
            </button>
          </div>
        {/each}
      </div>
    </div>

    <!-- Personal bests (localStorage ghosts) — per track best total + lap. -->
    {#if bestByTrack.length > 0}
      <div class="space-y-2">
        <div class="block text-sm font-medium" style="color: var(--color-text-muted)">
          Your Best Times
        </div>
        <div class="rounded-lg border" style="background: var(--color-surface); border-color: var(--color-border)">
          {#each bestByTrack as best, i (best.trackId)}
            {@const lapMs = best.bestLapMs}
            <div
              class="flex items-center justify-between px-4 py-2.5 text-sm"
              style={i > 0 ? "border-top: 1px solid var(--color-border)" : ""}
            >
              <span class="font-medium" style="color: var(--color-text)">
                {getTrackMeta(best.trackId).displayName}
              </span>
              <span class="flex items-center gap-4 tabular-nums">
                <span style="color: var(--color-text-muted)">
                  {fmtTime(best.totalMs)}
                </span>
                {#if lapMs != null}
                  <span class="text-xs" style="color: #44FF88">
                    lap {fmtTime(lapMs)}
                  </span>
                {/if}
              </span>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Race rules: laps + items -->
    <div class="space-y-2">
      <div class="block text-sm font-medium" style="color: var(--color-text-muted)">
        Race Rules
      </div>
      <div class="flex items-center justify-between rounded-lg border px-4 py-3"
           style="background: var(--color-surface); border-color: var(--color-border)">
        <div class="flex items-center gap-3">
          <span class="text-sm font-medium" style="color: var(--color-text)">Laps</span>
          <div class="flex items-center gap-1">
            <button
              onclick={() => (lapCount = Math.max(LAP_COUNT_MIN, lapCount - 1))}
              disabled={lapCount <= LAP_COUNT_MIN}
              aria-label="Decrease laps"
              class="flex h-7 w-7 items-center justify-center rounded-md border text-base font-bold transition-opacity hover:opacity-80 disabled:opacity-40"
              style="background: var(--color-bg); border-color: var(--color-border); color: var(--color-text)"
            >−</button>
            <span class="w-6 text-center text-base font-bold tabular-nums" style="color: var(--color-accent)">
              {lapCount}
            </span>
            <button
              onclick={() => (lapCount = Math.min(LAP_COUNT_MAX, lapCount + 1))}
              disabled={lapCount >= LAP_COUNT_MAX}
              aria-label="Increase laps"
              class="flex h-7 w-7 items-center justify-center rounded-md border text-base font-bold transition-opacity hover:opacity-80 disabled:opacity-40"
              style="background: var(--color-bg); border-color: var(--color-border); color: var(--color-text)"
            >+</button>
          </div>
        </div>
        <button
          onclick={() => (itemsEnabled = !itemsEnabled)}
          role="switch"
          aria-checked={itemsEnabled}
          class="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors"
          style={itemsEnabled
            ? "background: color-mix(in srgb, var(--color-accent) 16%, var(--color-surface)); border-color: var(--color-accent); color: var(--color-accent)"
            : "background: var(--color-bg); border-color: var(--color-border); color: var(--color-text-muted)"}
        >
          <span class="h-2 w-2 rounded-full" style="background: {itemsEnabled ? 'var(--color-accent)' : 'var(--color-text-muted)'}"></span>
          Items {itemsEnabled ? "On" : "Off"}
        </button>
      </div>

      <!-- CPU opponents: fill empty grid slots with bots + difficulty tier. -->
      <div class="flex items-center justify-between rounded-lg border px-4 py-3"
           style="background: var(--color-surface); border-color: var(--color-border)">
        <button
          onclick={() => (botsEnabled = !botsEnabled)}
          role="switch"
          aria-checked={botsEnabled}
          class="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors"
          style={botsEnabled
            ? "background: color-mix(in srgb, var(--color-accent) 16%, var(--color-surface)); border-color: var(--color-accent); color: var(--color-accent)"
            : "background: var(--color-bg); border-color: var(--color-border); color: var(--color-text-muted)"}
        >
          <span class="h-2 w-2 rounded-full" style="background: {botsEnabled ? 'var(--color-accent)' : 'var(--color-text-muted)'}"></span>
          Fill with CPU {botsEnabled ? "On" : "Off"}
        </button>

        <div class="flex items-center gap-1" role="group" aria-label="CPU difficulty">
          {#each BOT_DIFFICULTIES as diff}
            <button
              onclick={() => (botDifficulty = diff)}
              disabled={!botsEnabled}
              aria-pressed={botDifficulty === diff}
              class="rounded-md border px-2.5 py-1 text-xs font-medium capitalize transition-colors disabled:opacity-40"
              style={botDifficulty === diff && botsEnabled
                ? "background: color-mix(in srgb, var(--color-accent) 16%, var(--color-surface)); border-color: var(--color-accent); color: var(--color-accent)"
                : "background: var(--color-bg); border-color: var(--color-border); color: var(--color-text-muted)"}
            >
              {diff}
            </button>
          {/each}
        </div>
      </div>
    </div>

    <!-- Quick Play -->
    <button
      onclick={quickMatch}
      disabled={isQuickMatching || !lobby.isConnected || !nameValid}
      class="w-full rounded-lg px-6 py-3 text-base font-bold text-black transition-opacity hover:opacity-90 disabled:opacity-50"
      style="background: var(--color-accent)"
    >
      {isQuickMatching ? "Finding race..." : "Quick Race"}
    </button>

    <!-- Create Room -->
    <div class="space-y-2">
      <label
        for="room-name"
        class="block text-sm font-medium"
        style="color: var(--color-text-muted)"
      >
        Create Room
      </label>
      <div class="flex gap-2">
        <input
          id="room-name"
          type="text"
          bind:value={newRoomName}
          class="flex-1 rounded-lg border px-4 py-2.5 text-sm outline-none transition-colors focus:border-(--color-accent)"
          style="background: var(--color-surface); border-color: var(--color-border); color: var(--color-text)"
          placeholder="Room name (optional)"
          onkeydown={(e) => e.key === "Enter" && createRoom()}
        />
        <button
          onclick={createRoom}
          disabled={isCreating || !lobby.isConnected || !nameValid}
          class="rounded-lg px-6 py-2.5 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-50"
          style="background: var(--color-accent)"
        >
          {isCreating ? "..." : "Create"}
        </button>
      </div>
    </div>

    <!-- Room List -->
    <div class="space-y-3">
      <h2 class="text-sm font-medium" style="color: var(--color-text-muted)">
        {#if !lobby.isConnected}
          Connecting...
        {:else if rooms.length === 0}
          No race rooms yet — create one above
        {:else}
          Active Races ({rooms.length})
        {/if}
      </h2>

      {#each rooms as room (room.id)}
        <!-- A race room reports any non-waiting phase (countdown/racing/finished)
             as "racing", so `inProgress` covers all of them. Open = a waiting
             room with a free slot. -->
        {@const inProgress = room.status === "racing" || room.status === "playing"}
        {@const isOpen =
          room.status === "waiting" && room.playerCount < room.maxPlayers}
        {@const canSpectate = inProgress}
        <button
          onclick={() => joinRoom(room.id)}
          disabled={!isOpen && !canSpectate}
          class="flex w-full items-center justify-between rounded-lg border p-4 text-left transition-colors hover:border-(--color-accent) disabled:opacity-50 disabled:cursor-not-allowed"
          style="background: var(--color-surface); border-color: var(--color-border)"
        >
          <div>
            <div class="font-medium">{room.name}</div>
            <div class="mt-0.5 text-xs" style="color: var(--color-text-muted)">
              {room.playerCount}/{room.maxPlayers}
              {#if room.trackName}· {room.trackName}{/if}
              {#if room.lapCount}· {room.lapCount} {room.lapCount === 1 ? "lap" : "laps"}{/if}
            </div>
            <!-- Explicit status so a manual join is informed BEFORE reading the
                 button: a waiting room can be joined as a racer, an in-progress
                 room can only be spectated (you join the next race). -->
            <div class="mt-1 flex items-center gap-1.5 text-[11px] font-medium">
              <span
                class="h-1.5 w-1.5 rounded-full"
                style="background: {inProgress ? '#FFB454' : '#44FF88'}"
              ></span>
              <span style="color: {inProgress ? '#FFB454' : '#44FF88'}">
                {inProgress ? "Race in progress" : "Waiting for racers"}
              </span>
            </div>
          </div>
          <!-- Open rooms = Join; in-progress rooms = Spectate (the actor seats
               anyone joining after the waiting phase as a spectator and promotes
               them onto the grid when a slot opens). A full *waiting* room is
               temporarily unjoinable until the race starts. -->
          <div
            class="rounded-full px-3 py-1 text-xs font-medium"
            style="background: {isOpen ? 'var(--color-accent-dim)' : 'var(--color-border)'}; color: {isOpen ? 'var(--color-accent)' : 'var(--color-text-muted)'}"
          >
            {isOpen ? "Join" : canSpectate ? "Spectate" : "Full"}
          </div>
        </button>
      {/each}
    </div>

    <!-- Audio controls: mute toggle + volume slider (persists to localStorage,
         shared singleton with the play page). -->
    <div
      class="flex items-center justify-center gap-3 rounded-lg border px-4 py-2.5"
      style="background: var(--color-surface); border-color: var(--color-border)"
    >
      <button
        onclick={() => { sound.toggleMuted(); if (!sound.muted) unlockAudio(); }}
        aria-label={sound.muted ? "Unmute audio" : "Mute audio"}
        aria-pressed={sound.muted}
        class="text-lg leading-none transition-opacity hover:opacity-80"
        style="color: {sound.muted ? 'var(--color-text-muted)' : 'var(--color-accent)'}"
      >
        {sound.muted ? "🔇" : "🔊"}
      </button>
      <input
        type="range"
        min="0"
        max="1"
        step="0.05"
        value={sound.volume}
        aria-label="Master volume"
        oninput={(e) => { unlockAudio(); sound.setVolume(Number(e.currentTarget.value)); }}
        class="h-1 flex-1 cursor-pointer"
        style="accent-color: var(--color-accent)"
      />
      <span class="w-8 text-right text-xs tabular-nums" style="color: var(--color-text-muted)">
        {Math.round(sound.volume * 100)}
      </span>
    </div>

    <!-- Back to games -->
    <div class="flex items-center justify-between">
      <a
        href="/"
        class="text-sm transition-colors hover:underline"
        style="color: var(--color-text-muted)"
      >
        Back to Games
      </a>
      <div class="flex items-center gap-2 text-xs" style="color: var(--color-text-muted)">
        <div
          class="h-2 w-2 rounded-full"
          style="background: {lobby.isConnected ? 'var(--color-accent)' : 'var(--color-danger)'}"
        ></div>
        {lobby.isConnected ? "Connected" : lobby.connStatus}
      </div>
    </div>
  </div>
</div>

<style>
  .lobby-toast {
    animation: lobbyToastIn 0.3s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
  }

  @keyframes lobbyToastIn {
    from {
      transform: translateY(-10px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }
</style>
