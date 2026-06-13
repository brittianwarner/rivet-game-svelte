<!--
  Race Game Page — 4-player kart racing.
  Creates store, wires actor, provides context, renders RaceScene + HUD.
-->
<script lang="ts">
  import { page } from "$app/state";
  import { onMount, untrack } from "svelte";
  import { getRivetContext } from "@rivetkit/svelte";
  import type { registry } from "$lib/actors/registry";
  import RaceScene from "$lib/racing/components/RaceScene.svelte";
  import Minimap from "$lib/racing/components/Minimap.svelte";
  import { RaceStore } from "$lib/racing/race-store.svelte";
  import { setRaceStore, setRaceRoomControls } from "$lib/racing/context";
  import { useRaceRoom } from "$lib/racing/use-race-room.svelte";
  import { getSoundManager } from "$lib/racing/sound-manager.svelte";
  import { getSettingsStore } from "$lib/racing/settings-store.svelte";
  import {
    RACE_MAX_PLAYERS,
    KART_MAX_SPEED,
    LAP_COUNT_MIN,
    LAP_COUNT_MAX,
    type RoomSettings,
  } from "$lib/racing/types";
  import { isTrackId, getTrackMeta } from "$lib/racing/track";
  import {
    getPlayerAccentColor,
    resolveRaceCarIdFromSearchParams,
    coerceRaceCarId,
  } from "$lib/racing/car-catalog";
  import {
    GhostRecorder,
    loadGhostTimeline,
    ghostTimeDelta,
    localTrackProgress,
    type GhostTimeline,
  } from "$lib/racing/ghost-recorder";

  // Persisted lobby identity — shared key with the lobby screen so a deep link
  // without ?name= falls back to the player's remembered name/car instead of
  // silently impersonating "Anonymous".
  const NAME_KEY = "rivetKart.playerName";
  const CAR_KEY = "rivetKart.carId";

  const roomId = page.params.roomId ?? "";
  const searchParams =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();

  // Resolve identity: URL params win; otherwise localStorage; otherwise we
  // show a name prompt and defer connecting until the player confirms.
  const urlName = searchParams.get("name")?.trim() || "";
  const storedName =
    typeof localStorage !== "undefined"
      ? (localStorage.getItem(NAME_KEY) ?? "").trim()
      : "";
  const hasCarParam = searchParams.has("carId");
  const storedCar =
    typeof localStorage !== "undefined"
      ? localStorage.getItem(CAR_KEY)
      : null;

  // Name is known when it came from the URL or from a prior session. This is a
  // one-time identity decision made at mount — captured as a plain const so the
  // connection branch below reads a stable value (not a reactive rune).
  const initialName = urlName || storedName;
  let resolvedName = $state(initialName);
  let nameNeeded = $state(!initialName);
  let nameInput = $state(initialName);

  const carId = hasCarParam
    ? resolveRaceCarIdFromSearchParams(searchParams)
    : coerceRaceCarId(storedCar);

  // Room settings carried from the lobby (only honored by the first player to
  // reach a fresh room; the server ignores them for already-configured rooms).
  // A room name param lets a deep-linked creator name the room too.
  const roomSettings: Partial<RoomSettings> | undefined = (() => {
    const out: Partial<RoomSettings> = {};
    const t = searchParams.get("trackId");
    if (t && isTrackId(t)) out.trackId = t;
    const mode = searchParams.get("mode");
    if (mode === "timeTrial" || mode === "race") out.mode = mode;
    const laps = Number(searchParams.get("laps"));
    if (Number.isFinite(laps)) {
      out.lapCount = Math.max(LAP_COUNT_MIN, Math.min(LAP_COUNT_MAX, Math.round(laps)));
    }
    const items = searchParams.get("items");
    if (items === "0" || items === "1") out.itemsEnabled = items === "1";
    const bots = searchParams.get("bots");
    if (bots === "0" || bots === "1") out.botsEnabled = bots === "1";
    const botDiff = searchParams.get("botDiff");
    if (botDiff === "easy" || botDiff === "medium" || botDiff === "hard") {
      out.botDifficulty = botDiff;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  })();
  const roomNameParam = searchParams.get("roomName")?.trim() || undefined;

  // ---------------------------------------------------------------------------
  // Invalid-room guard. A bare deep link to /race/play/{typo} used to silently
  // spawn a fresh empty ghost actor and drop the player into a room they never
  // meant to create. We only connect IMMEDIATELY when there is a real intent to
  // create/enter: a settings-carrying link (lobby create / quick match / time
  // trial), a time-trial room id, or an explicit `?join=1` confirmation. A bare
  // link is validated against the lobby first (below) — found rooms remount with
  // `?join=1`; missing rooms show a "Room not found" prompt before any actor is
  // spawned.
  const hasCreateIntent =
    roomSettings !== undefined ||
    roomNameParam !== undefined ||
    roomId.startsWith("tt_") ||
    searchParams.get("join") === "1";

  const store = new RaceStore();
  setRaceStore(store);

  // Lobby handle (used only to verify a bare-link room exists before connecting
  // — querying the lobby does NOT spawn the race room actor). Available because
  // setupRivetKit runs in the root layout.
  const { useActor } = getRivetContext<typeof registry>();
  const lobby = useActor({ name: "lobby", key: ["main"] }) as ReturnType<
    typeof useActor
  > & { listRooms(): Promise<{ id: string }[]> };

  // Room-check lifecycle: "skip" when we have create intent (connect right away),
  // otherwise "checking" until the lobby answers → "found" (remounts to connect)
  // or "notFound" (prompt the player).
  type RoomCheck = "skip" | "checking" | "found" | "notFound";
  let roomCheck = $state<RoomCheck>(
    hasCreateIntent || !initialName ? "skip" : "checking",
  );

  // Connect only with a real name AND a decision to enter (create intent, or a
  // confirmed-present room). A bare link to a missing room never reaches here.
  const shouldConnect =
    !!initialName &&
    (hasCreateIntent || untrack(() => roomCheck) === "found");

  // Validate a bare link against the lobby once connected to it. Found → remount
  // carrying ?join=1 so the actor connects cleanly (mirrors the name-prompt
  // remount flow). Missing → show the not-found prompt.
  $effect(() => {
    if (roomCheck !== "checking" || !lobby.isConnected) return;
    let cancelled = false;
    lobby
      .listRooms()
      .then((all) => {
        if (cancelled) return;
        const exists = all.some((r) => r.id === roomId);
        if (exists) {
          const params = new URLSearchParams(window.location.search);
          params.set("join", "1");
          window.location.assign(
            `${window.location.pathname}?${params.toString()}`,
          );
        } else {
          roomCheck = "notFound";
        }
      })
      .catch(() => {
        // Lobby unreachable — don't strand the player; fall through to connect
        // (the worst case is the legacy behavior of joining/creating the room).
        if (!cancelled) roomCheck = "found";
      });
    return () => {
      cancelled = true;
    };
  });

  // "Create it / enter anyway" from the not-found prompt: remount with ?join=1
  // so the normal connect flow runs (intentional deep-link room creation).
  function createMissingRoom(): void {
    const params = new URLSearchParams(window.location.search);
    params.set("join", "1");
    window.location.assign(`${window.location.pathname}?${params.toString()}`);
  }

  // Synthesized audio engine (singleton). The AudioContext starts suspended
  // per browser autoplay policy — resume() is called from the first real user
  // gesture (any non-control pointerdown, the Ready button, the touch HUD).
  const sound = getSoundManager();

  // Graphics / accessibility / diagnostics options (singleton). Reduced motion
  // gates the speed-line vignette below and mirrors onto <html> so app.css can
  // calm CSS animations; the camera FOV-kick + diagnostics flags drive the
  // chase cam and the netcode overlay.
  const settings = getSettingsStore();
  onMount(() => settings.init());

  // Honest connection: only wire the actor (which connects immediately with the
  // playerName) once we have a name AND a decision to enter the room (create
  // intent, or a lobby-confirmed room). When the name has to be prompted — or a
  // bare link is still being validated — we don't connect; a navigation
  // remounts the component with the confirmed params so it connects cleanly.
  const controls = shouldConnect
    ? useRaceRoom({
        roomId,
        playerName: initialName,
        carId,
        store,
        roomSettings,
        roomName: roomNameParam,
      })
    : null;
  if (controls) {
    setRaceRoomControls(controls);
    // Remember the resolved identity so future deep links are honest too.
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(NAME_KEY, initialName);
      localStorage.setItem(CAR_KEY, carId);
    }
  }

  function confirmName(): void {
    const name = nameInput.trim();
    if (!name) return;
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(NAME_KEY, name);
      localStorage.setItem(CAR_KEY, carId);
    }
    // Reload with the confirmed params so the actor connects with a real name
    // (useRaceRoom binds playerName at mount — a full nav guarantees a clean
    // first connection rather than a deferred rune call).
    const params = new URLSearchParams(window.location.search);
    params.set("name", name);
    if (!params.has("carId")) params.set("carId", carId);
    window.location.assign(`${window.location.pathname}?${params.toString()}`);
  }

  // Mobile detection. Touch input is NOT sent from here — handlers write to
  // controls.setTouchInput and RaceInput (the single sender) merges it with
  // keyboard state every frame, so the two never clobber each other.
  let isMobile = $state(false);
  // The keyboard listeners live on `window` (RaceInput), so key events only
  // arrive while THIS document/frame holds focus. In embedded or split-pane
  // setups the game frame can load without focus, making WASD appear dead.
  // Grab focus on mount and on any pointer interaction so driving "just works"
  // without the player hunting for the right thing to click.
  let gameRoot = $state<HTMLDivElement | null>(null);
  function grabFocus() {
    gameRoot?.focus({ preventScroll: true });
  }
  // Refocus the game on pointerdown EXCEPT when the player is interacting with
  // a real control (name field, buttons, links) — otherwise we'd yank focus
  // out of the name input mid-type.
  function onScenePointerDown(e: PointerEvent) {
    // First user gesture also unlocks audio (browsers start it suspended).
    sound.resume();
    const el = e.target as HTMLElement | null;
    if (el?.closest("input, button, a, select, textarea")) return;
    grabFocus();
  }
  onMount(() => {
    isMobile = "ontouchstart" in window;
    // Defer one frame so the element is laid out before focusing.
    requestAnimationFrame(grabFocus);
    try {
      window.focus();
    } catch {
      // Cross-origin embed may block programmatic window focus — pointer
      // interaction (below) still recovers it.
    }
  });

  // ---------------------------------------------------------------------------
  // Pause / Options overlay (Esc-toggled). It does NOT pause the authoritative
  // server sim — the race keeps running — so it's labeled "Options". While open
  // we move keyboard focus into the panel and trap Tab within it so it's fully
  // keyboard-navigable; Esc closes it and restores focus to the game root.
  // ---------------------------------------------------------------------------
  let optionsOpen = $state(false);
  let optionsPanel = $state<HTMLDivElement | null>(null);

  function openOptions(): void {
    optionsOpen = true;
    // Defer so the panel is in the DOM before we focus into it.
    requestAnimationFrame(() => {
      const first = optionsPanel?.querySelector<HTMLElement>(
        "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
      );
      first?.focus();
    });
  }

  function closeOptions(): void {
    optionsOpen = false;
    grabFocus();
  }

  function toggleOptions(): void {
    if (optionsOpen) closeOptions();
    else openOptions();
  }

  // Global key handler: Esc toggles the overlay; while open, Tab is trapped
  // inside the panel for keyboard accessibility. (RaceInput owns the gameplay
  // keys — Esc is unused there, so this never conflicts.)
  $effect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        toggleOptions();
        return;
      }
      if (!optionsOpen || e.key !== "Tab" || !optionsPanel) return;
      const focusable = Array.from(
        optionsPanel.querySelectorAll<HTMLElement>(
          "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
        ),
      ).filter((el) => el.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (active && !optionsPanel.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // ---------------------------------------------------------------------------
  // Mobile fullscreen + landscape lock. Requested on Ready Up (a real user
  // gesture, required by the Fullscreen API) and best-effort — wrapped in
  // try/catch since many browsers (notably iOS Safari) reject the orientation
  // lock and some reject fullscreen. A CSS portrait media query shows the
  // rotate-your-device prompt independently of whether the lock succeeded.
  // ---------------------------------------------------------------------------
  async function enterMobileImmersive(): Promise<void> {
    if (!isMobile || typeof document === "undefined") return;
    const root = gameRoot ?? document.documentElement;
    try {
      if (!document.fullscreenElement && root.requestFullscreen) {
        await root.requestFullscreen();
      }
    } catch {
      // Fullscreen denied — harmless, the HUD still works.
    }
    try {
      const orientation = screen.orientation as
        | (ScreenOrientation & { lock?: (o: string) => Promise<void> })
        | undefined;
      if (orientation?.lock) {
        await orientation.lock("landscape");
      }
    } catch {
      // Orientation lock unsupported/denied — the rotate prompt covers it.
    }
  }

  // Ready Up wrapper: unlock audio, request immersive mode (mobile), then ready.
  function onReadyUp(): void {
    sound.resume();
    void enterMobileImmersive();
    controls?.readyUp();
  }

  // ---------------------------------------------------------------------------
  // Diagnostics overlay (opt-in via Settings). The store doesn't expose its
  // private snapshot buffer, but every race snapshot advances store.raceTimer,
  // so we sample its change cadence off rAF to estimate the snapshot rate (Hz)
  // and the age of the most recent snapshot. Cheap and self-contained.
  // ---------------------------------------------------------------------------
  let snapshotHz = $state(0);
  let snapshotAgeMs = $state(0);
  onMount(() => {
    if (typeof window === "undefined") return;
    let raf = 0;
    let lastTimer = -1;
    let lastChangeAt = performance.now();
    const intervals: number[] = [];
    function tick() {
      const now = performance.now();
      // Only meaningful while the server is ticking (racing/countdown advance
      // raceTimer); a static timer just ages the last sample.
      if (settings.showDiagnostics) {
        const t = store.raceTimer;
        if (t !== lastTimer && lastTimer >= 0) {
          const dt = now - lastChangeAt;
          if (dt > 0 && dt < 1000) {
            intervals.push(dt);
            if (intervals.length > 20) intervals.shift();
          }
          lastChangeAt = now;
        }
        if (t !== lastTimer) lastTimer = t;
        snapshotAgeMs = now - lastChangeAt;
        if (intervals.length > 0) {
          const avg =
            intervals.reduce((a, b) => a + b, 0) / intervals.length;
          snapshotHz = avg > 0 ? 1000 / avg : 0;
        }
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });

  // Honest connection UI: full-screen "Connecting..." only before the FIRST
  // successful connect; afterwards a blip shows a non-blocking banner instead
  // of blacking out the race.
  let hasEverConnected = $state(false);
  $effect(() => {
    if (controls?.isConnected) hasEverConnected = true;
  });

  // Position change indicator timing — performance.now() is non-reactive, so a
  // plain $derived against it never re-evaluates and the overtake arrow would
  // never auto-hide. Drive a $state flag off positionChangeTime instead
  // (mirrors the toast auto-dismiss pattern).
  let showPositionDelta = $state(false);
  let positionDeltaTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    // Re-run whenever a new position change is recorded.
    const t = store.positionChangeTime;
    if (t <= 0 || store.positionDelta === 0) return;
    showPositionDelta = true;
    if (positionDeltaTimer) clearTimeout(positionDeltaTimer);
    positionDeltaTimer = setTimeout(() => {
      showPositionDelta = false;
      positionDeltaTimer = null;
    }, 2000);
    return () => {
      if (positionDeltaTimer) clearTimeout(positionDeltaTimer);
      positionDeltaTimer = null;
    };
  });

  // Copy link state
  let linkCopied = $state(false);

  // Position ordinal helper
  function ordinal(n: number): string {
    if (n === 1) return "1st";
    if (n === 2) return "2nd";
    if (n === 3) return "3rd";
    return `${n}th`;
  }

  // Format race time — shared m:ss.cc util so the live timer, lap splits, and
  // results table all read consistently.
  const formatTime = RaceStore.formatRaceTime;

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

  // Get results list for finish screen — the full per-player table ordered by
  // finish, including the never-rendered RaceStats fields (best lap, top speed,
  // hits dealt/taken) the server broadcasts in raceFinished.
  interface ResultRow {
    id: string;
    name: string;
    time: string;
    color: string;
    bestLap: string;
    topSpeed: number;
    hitsDealt: number;
    hitsTaken: number;
    isLocal: boolean;
    isBot: boolean;
  }
  function getResults(): ResultRow[] {
    return store.positions.map((id) => {
      const kart = store.karts[id];
      const stats = store.raceStats[id];
      if (!kart) {
        return {
          id,
          name: "Unknown",
          time: "--",
          color: "#666",
          bestLap: "--",
          topSpeed: 0,
          hitsDealt: 0,
          hitsTaken: 0,
          isLocal: false,
          isBot: false,
        };
      }
      return {
        id,
        name: kart.name,
        time: kart.finishTime ? formatTime(kart.finishTime) : "DNF",
        color: getPlayerAccentColor(kart.accentIndex),
        bestLap: stats?.bestLapTime ? formatTime(stats.bestLapTime) : "--",
        // Speed is in sim units; show a friendlier km/h-ish readout (×60).
        topSpeed: stats?.topSpeed ? Math.round(stats.topSpeed * 60) : 0,
        hitsDealt: stats?.hitsDealt ?? 0,
        hitsTaken: stats?.hitsTaken ?? 0,
        isLocal: id === store.localPlayerId,
        isBot: kart.isBot ?? false,
      };
    });
  }

  // Copy share link — the BARE room URL with no ?name=/?carId= so recipients
  // pick their own identity instead of joining as (and impersonating) the
  // sharer. The play page prompts for a name when none is supplied.
  async function copyShareLink(): Promise<void> {
    try {
      const url = `${window.location.origin}/race/play/${roomId}`;
      await navigator.clipboard.writeText(url);
      linkCopied = true;
      setTimeout(() => (linkCopied = false), 2000);
    } catch {
      // fallback
    }
  }

  // Mobile touch controls — state lives in the controls.touchInput arbiter;
  // only the item-button flash and steer-tracking bookkeeping are local.
  let touchItem = $state(false);
  let steerTouchId: number | null = null;
  let steerStartX = 0;

  function handleSteerStart(e: TouchEvent): void {
    e.preventDefault();
    const touch = e.changedTouches[0];
    steerTouchId = touch.identifier;
    steerStartX = touch.clientX;
    controls?.setTouchInput({ steering: 0 });
  }

  function handleSteerMove(e: TouchEvent): void {
    e.preventDefault();
    for (const touch of e.changedTouches) {
      if (touch.identifier === steerTouchId) {
        const dx = touch.clientX - steerStartX;
        controls?.setTouchInput({ steering: Math.max(-1, Math.min(1, dx / 60)) });
      }
    }
  }

  function handleSteerEnd(e: TouchEvent): void {
    for (const touch of e.changedTouches) {
      if (touch.identifier === steerTouchId) {
        steerTouchId = null;
        controls?.setTouchInput({ steering: 0 });
      }
    }
  }

  // Rematch vote count
  let rematchVoteCount = $derived(
    Object.values(store.rematchVotes).filter((v) => v).length,
  );
  let hasVotedRematch = $derived(
    !!(store.localPlayerId && store.rematchVotes[store.localPlayerId]),
  );

  // Ready state for the local player (waiting room)
  let isLocalReady = $derived(
    !!(store.localPlayerId && store.readyPlayers[store.localPlayerId]),
  );

  // Drift charge colors
  const driftColors = ["#3399FF", "#FF8800", "#CC44FF"];

  // Display name of the active track, from the (client-safe) track metadata.
  let trackDisplayName = $derived(getTrackMeta(store.trackId).displayName);

  // Position ordinal that doesn't flash a meaningless "0th" before the
  // positions list populates from the server.
  function ordinalOrDash(n: number): string {
    return n > 0 ? ordinal(n) : "—";
  }

  // Boost-tier color for the speed-bar flash (matches drift charge colors;
  // any active boost glows). boostSpeed scales the glow's saturation.
  let boostActive = $derived(
    !!(store.localKart && store.localKart.boostTimer > 0),
  );

  // ---------------------------------------------------------------------------
  // Lap timing telemetry
  // ---------------------------------------------------------------------------

  // The store's raceTimer only advances per snapshot (~20Hz), which strobes a
  // centisecond display. Drive a smooth wall-clock estimate off rAF: extrapolate
  // from the last snapshot's raceTimer by the elapsed wall time. Resets cleanly
  // whenever a fresh snapshot lands (raceTimer changes).
  let smoothRaceTimer = $state(0);
  let rafHandle = 0;
  let lastTimerBase = -1;
  let lastTimerBaseAt = 0;
  onMount(() => {
    function tick() {
      const base = store.raceTimer;
      const now = performance.now();
      if (base !== lastTimerBase) {
        lastTimerBase = base;
        lastTimerBaseAt = now;
      }
      smoothRaceTimer =
        store.phase === "racing" ? base + (now - lastTimerBaseAt) : base;
      rafHandle = requestAnimationFrame(tick);
    }
    rafHandle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafHandle);
  });

  // Live current-lap time for the local player (smoothed timer minus the lap
  // baseline the store rolls forward on each lapCompleted).
  let currentLapMs = $derived(
    Math.max(0, smoothRaceTimer - store.lapStartTime),
  );

  // Lap-split toast: show "Lap N — m:ss.cc" for 2.5s when a local split lands.
  let showLapSplit = $state(false);
  let lapSplitTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const at = store.lastLapSplitAt;
    if (at <= 0) return;
    showLapSplit = true;
    if (lapSplitTimer) clearTimeout(lapSplitTimer);
    lapSplitTimer = setTimeout(() => {
      showLapSplit = false;
      lapSplitTimer = null;
    }, 2500);
    return () => {
      if (lapSplitTimer) clearTimeout(lapSplitTimer);
      lapSplitTimer = null;
    };
  });

  // FINAL LAP banner: fire a 1.5s banner the first time the local kart enters
  // its last lap. Tracked by a flag so it shows once per race, not every frame.
  let showFinalLap = $state(false);
  let finalLapShownForLap = -1;
  let finalLapTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    if (
      store.isLocalFinalLap &&
      store.localKart &&
      store.localKart.lap !== finalLapShownForLap
    ) {
      finalLapShownForLap = store.localKart.lap;
      showFinalLap = true;
      if (finalLapTimer) clearTimeout(finalLapTimer);
      finalLapTimer = setTimeout(() => {
        showFinalLap = false;
        finalLapTimer = null;
      }, 1500);
    }
    // Reset the once-per-race latch when a new race starts.
    if (store.phase === "waiting" || store.phase === "countdown") {
      finalLapShownForLap = -1;
    }
    return () => {
      if (finalLapTimer) clearTimeout(finalLapTimer);
      finalLapTimer = null;
    };
  });

  // ---------------------------------------------------------------------------
  // Time-trial ghost (client-only). On GO in time-trial mode we load the stored
  // ghost for (trackId, carId) into the store (RaceScene mounts GhostKart off
  // store.ghostActive) and start recording the local kart's path at 10Hz. Each
  // frame we sample the path, compute the live delta vs the ghost at matching
  // progress (store.ghostDeltaMs drives the HUD), and a fall+respawn disqualifies
  // the run. On raceFinished we persist it if it beats the personal best.
  // ---------------------------------------------------------------------------

  let recorder: GhostRecorder | null = null;
  let ghostTimeline: GhostTimeline | null = null;
  let ghostSegHint = 0;
  // True while the local kart is currently in the "falling" state (so we only
  // invalidate once per fall, on the entering edge).
  let wasFalling = false;
  // Latch so we save at most once per finished run.
  let ghostSavedForRace = false;
  // Set true on finish when the run beat (or set) the personal best.
  let newGhostBest = $state(false);

  function teardownGhost(): void {
    recorder?.stop();
    recorder = null;
    ghostTimeline = null;
    ghostSegHint = 0;
    wasFalling = false;
    store.setGhostTimeline(null);
  }

  function startTimeTrialRun(): void {
    if (store.mode !== "timeTrial" || !store.localPlayerId) return;
    const kart = store.karts[store.localPlayerId];
    // The kart's server-assigned carId is the authoritative pick for this run
    // (falls back to the URL/localStorage carId before the kart hydrates).
    const runCarId = kart?.carId ?? carId;
    // Load the best ghost for this track/car/lap-count (null when none exists).
    ghostTimeline = loadGhostTimeline(store.trackId, runCarId, store.lapCount);
    store.setGhostTimeline(ghostTimeline);
    recorder = new GhostRecorder(store.trackId, runCarId, store.lapCount);
    recorder.start();
    ghostSegHint = 0;
    wasFalling = false;
    ghostSavedForRace = false;
    newGhostBest = false;
  }

  // GO / phase changes drive the run lifecycle.
  $effect(() => {
    const phase = store.phase;
    if (phase === "racing" && store.mode === "timeTrial") {
      // Only (re)start a run when we don't already have a recorder for it.
      if (!recorder) startTimeTrialRun();
    } else if (phase === "waiting" || phase === "countdown") {
      teardownGhost();
    }
  });

  // Per-frame: feed the recorder + recompute the live ghost delta. Driven off
  // the same rAF the smooth timer uses (added in its own loop to stay cheap).
  onMount(() => {
    let raf = 0;
    function tick() {
      if (store.mode === "timeTrial" && store.phase === "racing") {
        const kart = store.localKart;
        if (kart && recorder) {
          // Fall+respawn shortcuts the path — disqualify the recording.
          const falling = kart.status === "falling";
          if (falling && !wasFalling) recorder.invalidate();
          wasFalling = falling;

          recorder.sample(
            store.raceTimer,
            kart.position.x,
            kart.position.y,
            kart.position.z,
            kart.heading,
          );

          // Live delta vs ghost at matching track progress.
          if (ghostTimeline) {
            const { progress, segHint } = localTrackProgress(
              store.trackId,
              kart.position.x,
              kart.position.z,
              kart.lap,
              ghostSegHint,
            );
            ghostSegHint = segHint;
            store.ghostDeltaMs = ghostTimeDelta(
              ghostTimeline,
              progress,
              smoothRaceTimer,
            );
          }
        }
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });

  // Persist the run on finish if it beat the personal best. The finish time
  // arrives via raceFinished (applyRaceFinished sets kart.finishTime); if the
  // "finished" phase lands a frame before that, total is still null — wait for
  // it (the latch only flips once we've actually saved with a real time).
  $effect(() => {
    if (
      store.phase === "finished" &&
      store.mode === "timeTrial" &&
      recorder &&
      !ghostSavedForRace
    ) {
      const total = store.localKart?.finishTime ?? null;
      if (total != null && total > 0) {
        ghostSavedForRace = true;
        recorder.stop();
        newGhostBest = recorder.saveIfBest(total, store.bestLapMs, store.lapCount);
      }
    }
  });

  // Accent color for a kart id (live standings + finish table).
  function accentFor(accentIndex: number): string {
    return getPlayerAccentColor(accentIndex);
  }

  // Live ghost delta formatted for the HUD (+behind / −ahead).
  let ghostDeltaLabel = $derived.by(() => {
    const d = store.ghostDeltaMs;
    if (d == null) return null;
    const sign = d >= 0 ? "+" : "−";
    const abs = Math.abs(d);
    const sec = Math.floor(abs / 1000);
    const cs = Math.floor((abs % 1000) / 10);
    return {
      text: `${sign}${sec}.${cs.toString().padStart(2, "0")}`,
      ahead: d < 0,
    };
  });

  // Per-item inline-SVG-ish icon (emoji glyphs keep it dependency-free and
  // legible at HUD scale).
  function itemIcon(item: string | null): string {
    if (!item) return "";
    const icons: Record<string, string> = {
      greenShell: "🐢",
      redShell: "🎯",
      blueShell: "🔵",
      banana: "🍌",
      mushroom: "🍄",
      triMushroom: "🍄",
      star: "⭐",
      lightning: "⚡",
    };
    return icons[item] ?? "🎁";
  }
</script>

<!-- tabindex makes the game focusable so window key events fire even in an
     embedded frame; outline is suppressed and focus is grabbed on pointerdown
     (but not when clicking real controls). role=application signals a
     keyboard-driven surface to assistive tech. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={gameRoot}
  class="relative h-full w-full outline-none"
  tabindex="-1"
  role="application"
  aria-label="Kart race"
  onpointerdown={onScenePointerDown}
>
  <!-- 3D Scene. Keyed on the authoritative trackId so the scene (and its
       fog / bloom / sky / light consts + the inner EffectComposer) re-initialize
       once the real trackId lands — join state sets it asynchronously AFTER
       connect, so at first mount store.trackId is still the default "track1".
       Without this remount the neon-circuit would render with the desert sky.
       The HUD lives outside this block and is unaffected; the chase camera,
       prediction (RaceInput) and shadow/lightning-flash config all re-init
       cleanly on remount. -->
  <div class="absolute inset-0">
    {#key store.trackId}
      <RaceScene />
    {/key}
  </div>

  {#if nameNeeded}
    <!-- Deep-link without a remembered name: prompt before connecting so we
         never impersonate "Anonymous". -->
    <div
      class="absolute inset-0 flex items-center justify-center"
      style="background: var(--color-bg); z-index: 40"
    >
      <div
        class="w-full max-w-sm rounded-xl border px-8 py-6"
        style="background: var(--color-surface); border-color: var(--color-border); backdrop-filter: blur(12px)"
      >
        <div
          class="font-display text-2xl font-black"
          style="color: var(--color-accent)"
        >
          Enter the Race
        </div>
        <p class="mt-1 text-sm" style="color: var(--color-text-muted)">
          Choose a name before joining this room.
        </p>
        <label
          for="join-name"
          class="mt-4 block text-sm font-medium"
          style="color: var(--color-text-muted)"
        >
          Your Name
        </label>
        <input
          id="join-name"
          type="text"
          bind:value={nameInput}
          maxlength="20"
          class="mt-1 w-full rounded-lg border px-4 py-2.5 text-sm outline-none transition-colors focus:border-(--color-accent)"
          style="background: var(--color-bg); border-color: var(--color-border); color: var(--color-text)"
          placeholder="Enter your name"
          onkeydown={(e) => e.key === "Enter" && confirmName()}
        />
        <button
          onclick={confirmName}
          disabled={!nameInput.trim()}
          class="mt-4 w-full rounded-lg px-6 py-2.5 text-sm font-bold text-black transition-opacity hover:opacity-90 disabled:opacity-50"
          style="background: var(--color-accent)"
        >
          Join Race
        </button>
        <a
          href="/race"
          class="mt-3 block text-center text-xs transition-colors hover:underline"
          style="color: var(--color-text-muted)"
        >
          Back to Lobby
        </a>
      </div>
    </div>
  {/if}

  <!-- Bare deep link being validated against the lobby (no actor spawned yet). -->
  {#if !nameNeeded && roomCheck === "checking"}
    <div
      class="absolute inset-0 flex items-center justify-center"
      style="background: var(--color-bg); z-index: 40"
    >
      <div class="text-center">
        <div class="text-lg font-semibold" style="color: var(--color-accent)">
          Looking for room…
        </div>
      </div>
    </div>
  {/if}

  <!-- Bare link to a room the lobby doesn't know — offer to create it (the
       normal deep-link room-creation flow) or head back, instead of silently
       spawning a fresh ghost room. -->
  {#if !nameNeeded && roomCheck === "notFound"}
    <div
      class="absolute inset-0 flex items-center justify-center"
      style="background: var(--color-bg); z-index: 40"
    >
      <div
        class="w-full max-w-sm rounded-xl border px-8 py-6 text-center"
        style="background: var(--color-surface); border-color: var(--color-border); backdrop-filter: blur(12px)"
      >
        <div class="font-display text-2xl font-black" style="color: var(--color-accent)">
          Room Not Found
        </div>
        <p class="mt-2 text-sm" style="color: var(--color-text-muted)">
          No active race matches this link. It may have ended, or the link is
          mistyped. You can start a fresh room here or return to the lobby.
        </p>
        <button
          onclick={createMissingRoom}
          class="mt-5 w-full rounded-lg px-6 py-2.5 text-sm font-bold text-black transition-opacity hover:opacity-90"
          style="background: var(--color-accent)"
        >
          Create This Room
        </button>
        <a
          href="/race"
          class="mt-3 block text-center text-xs transition-colors hover:underline"
          style="color: var(--color-text-muted)"
        >
          Back to Lobby
        </a>
      </div>
    </div>
  {/if}

  <!-- Speed lines overlay (skipped under reduced motion — the streaking
       vignette is exactly the kind of motion the setting calms) -->
  {#if controls && store.speedLineIntensity > 0 && !store.isSpectator && !settings.reducedMotionActive}
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

  <!-- HUD overlay — only once the actor is wired (a real name is known) -->
  {#if controls}
  <div class="pointer-events-none absolute inset-0" style="z-index: 10">

    <!-- Spectator badge — always visible while spectating so the role is
         unmistakable (the in-progress panel below carries the full context). -->
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

    <!-- Spectator: race already in progress. The server seats late joiners as
         spectators and promotes them onto the grid when the race resets to
         waiting; surface that clearly (so it doesn't read as "stuck"), show the
         live standings, and make Leave / find-another-race obvious. Gated to
         racing/countdown — the waiting overlay carries its own spectator copy
         and the finished overlay has its own Leave. -->
    {#if store.isSpectator && (store.phase === "racing" || store.phase === "countdown")}
      <div class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <div
          class="pointer-events-auto w-[min(22rem,90vw)] rounded-xl border px-7 py-6 text-center"
          style="background: var(--color-surface); border-color: var(--color-accent); backdrop-filter: blur(12px)"
        >
          <div class="font-display text-2xl font-black" style="color: var(--color-accent)">
            Race in progress
          </div>
          <p class="mt-2 text-sm" style="color: var(--color-text-muted)">
            You joined mid-race, so you're spectating. You'll be added to the grid
            automatically for the next race.
          </p>

          <!-- Live standings so spectators have something to follow. -->
          {#if store.standings.length > 0}
            <div
              class="mt-4 space-y-1 rounded-lg border px-3 py-2 text-left"
              style="background: var(--color-bg); border-color: var(--color-border)"
            >
              {#each store.standings as row (row.id)}
                <div class="flex items-center gap-2 text-xs">
                  <span
                    class="w-4 text-right font-bold tabular-nums"
                    style="color: var(--color-text-muted)"
                  >
                    {row.place}
                  </span>
                  <span
                    class="h-2.5 w-2.5 shrink-0 rounded-full"
                    style="background: {accentFor(row.accentIndex)}"
                  ></span>
                  <span
                    class="flex-1 truncate font-medium"
                    style="color: var(--color-text-muted)"
                  >
                    {row.name}
                  </span>
                  {#if row.isBot}
                    <span
                      class="shrink-0 rounded-sm px-1 text-[8px] font-bold tracking-wide"
                      style="background: var(--color-border); color: var(--color-text-muted)"
                    >CPU</span>
                  {/if}
                  <span class="tabular-nums text-[10px]" style="color: var(--color-text-muted)">
                    {#if row.finished}✓{:else}L{Math.min(row.lap + 1, store.lapCount)}{/if}
                  </span>
                </div>
              {/each}
            </div>
          {/if}

          <!-- Obvious exit: leave this race and head back to the lobby to find
               (or start) another. controls.leave() navigates to /race and
               resets the store — the same path every other Leave button uses. -->
          <div class="mt-5 flex items-center justify-center">
            <button
              onclick={() => controls.leave()}
              class="rounded-lg px-6 py-2 text-sm font-bold text-black transition-opacity hover:opacity-90"
              style="background: var(--color-accent)"
            >
              Leave &amp; find another race
            </button>
          </div>
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
          {store.roomName || store.roomId || roomId}
        </div>
        <div class="text-xs" style="color: var(--color-text-muted)">
          {#if store.isTimeTrial}⏱ Time Trial{:else}{store.playerCount}/{RACE_MAX_PLAYERS} racers{/if} · {trackDisplayName} · {store.lapCount}
          {store.lapCount === 1 ? "lap" : "laps"}{store.itemsEnabled ? "" : " · no items"}
        </div>
      </div>

      <div class="flex items-center gap-2">
        <!-- Audio controls: mute toggle + volume slider -->
        <div
          class="pointer-events-auto flex items-center gap-2 rounded-lg border px-3 py-2"
          style="background: var(--color-surface); border-color: var(--color-border)"
        >
          <button
            onclick={() => sound.toggleMuted()}
            aria-label={sound.muted ? "Unmute audio" : "Mute audio"}
            aria-pressed={sound.muted}
            class="text-base leading-none transition-opacity hover:opacity-80"
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
            oninput={(e) => sound.setVolume(Number(e.currentTarget.value))}
            class="h-1 w-20 cursor-pointer"
            style="accent-color: var(--color-accent)"
          />
        </div>

        <!-- Options (Esc) — hosts settings + the controls card + Leave Race. -->
        <button
          onclick={openOptions}
          aria-label="Options"
          aria-haspopup="dialog"
          aria-expanded={optionsOpen}
          class="pointer-events-auto flex items-center gap-1.5 rounded-lg border px-4 py-2 text-sm transition-colors hover:border-(--color-accent)"
          style="background: var(--color-surface); border-color: var(--color-border); color: var(--color-text-muted)"
        >
          <span aria-hidden="true" class="text-base leading-none">⚙</span>
          <span class="hidden sm:inline">Options</span>
        </button>
      </div>
    </div>

    <!-- Position + Lap (centered, large) -->
    {#if store.phase === "racing" && !store.isSpectator && !store.localFinished}
      <div class="absolute left-1/2 top-4 -translate-x-1/2">
        <div
          class="rounded-xl border px-8 py-3 text-center"
          style="background: var(--color-surface); border-color: var(--color-border); backdrop-filter: blur(12px)"
        >
          <div class="flex items-center gap-6">
            <div class="flex items-center gap-2">
              <div
                class="position-numeral font-display text-5xl font-black tabular-nums"
                style="color: var(--color-accent)"
              >
                {ordinalOrDash(store.localPosition)}
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
                {Math.min(store.localLap + 1, store.lapCount)}/{store.lapCount}
              </div>
            </div>
            <div class="text-2xl font-light" style="color: var(--color-border)">|</div>
            <!-- Lap + total timing -->
            <div class="text-left">
              <div class="text-base font-bold tabular-nums leading-tight" style="color: var(--color-text)">
                {formatTime(currentLapMs)}
              </div>
              <div class="text-[10px] uppercase tracking-wide tabular-nums" style="color: var(--color-text-muted)">
                Lap · {formatTime(smoothRaceTimer)} total
              </div>
              {#if store.bestLapMs !== null}
                <div class="text-[10px] tabular-nums" style="color: #44FF88">
                  Best {formatTime(store.bestLapMs)}
                </div>
              {/if}
            </div>
          </div>
        </div>
      </div>
    {/if}

    <!-- Time-trial ghost delta (live gap to your best run at matching progress).
         Green = ahead of the ghost, red = behind. Shows a "no ghost yet" hint
         on the first run for this track/car. -->
    {#if store.isTimeTrial && store.phase === "racing" && !store.isSpectator && !store.localFinished}
      <div class="absolute left-1/2 top-24 -translate-x-1/2 pointer-events-none" style="z-index: 19">
        <div
          class="rounded-lg border px-4 py-1.5 text-center"
          style="background: rgba(0,0,0,0.55); border-color: var(--color-border); backdrop-filter: blur(8px)"
        >
          {#if store.ghostActive && ghostDeltaLabel}
            <span class="text-[10px] uppercase tracking-wider" style="color: var(--color-text-muted)">
              vs Ghost
            </span>
            <span
              class="ml-2 font-display text-lg font-black tabular-nums"
              style="color: {ghostDeltaLabel.ahead ? '#44FF88' : '#FF6666'}"
            >
              {ghostDeltaLabel.text}
            </span>
          {:else if store.ghostActive}
            <span class="text-xs" style="color: var(--color-text-muted)">Ghost loaded</span>
          {:else}
            <span class="text-xs" style="color: var(--color-text-muted)">
              No ghost yet — set the pace!
            </span>
          {/if}
        </div>
      </div>
    {/if}

    <!-- FINAL LAP banner (large, 1.5s, heading font) -->
    {#if showFinalLap && !store.isSpectator}
      <div
        role="status"
        aria-live="assertive"
        class="absolute left-1/2 top-1/3 -translate-x-1/2 -translate-y-1/2 pointer-events-none"
      >
        <div class="final-lap-banner font-display text-6xl font-black" style="color: #FFD93D">
          FINAL LAP!
        </div>
      </div>
    {/if}

    <!-- WRONG WAY warning (client-side; store gates spinning/falling/finished/
         spectator so we only check the flag). aria-live polite, and the flash
         animation is disabled under prefers-reduced-motion. -->
    {#if store.wrongWay && !store.isSpectator}
      <div
        role="status"
        aria-live="polite"
        class="absolute left-1/2 top-[58%] -translate-x-1/2 -translate-y-1/2 pointer-events-none"
      >
        <div
          class="wrong-way-banner flex items-center gap-3 rounded-xl border-2 px-7 py-3"
          style="background: rgba(40,0,0,0.55); border-color: #FF4444; backdrop-filter: blur(6px)"
        >
          <!-- U-turn arrow glyph -->
          <span class="text-4xl leading-none" style="color: #FF4444" aria-hidden="true">⤺</span>
          <span class="font-display text-3xl font-black tracking-wide" style="color: #FF4444">
            WRONG WAY
          </span>
        </div>
      </div>
    {/if}

    <!-- Lap-split toast (local player) — "Lap N — m:ss.cc" -->
    {#if showLapSplit && store.lastLapSplitLap > 0 && !store.isSpectator}
      <div
        role="status"
        aria-live="polite"
        class="absolute left-1/2 top-44 -translate-x-1/2 pointer-events-none"
        style="z-index: 21"
      >
        <div
          class="lap-split-toast rounded-lg border px-5 py-2 text-center"
          style="background: var(--color-surface); border-color: #44FF88; backdrop-filter: blur(8px)"
        >
          <span class="text-xs uppercase tracking-wider" style="color: var(--color-text-muted)">
            Lap {store.lastLapSplitLap}
          </span>
          <span class="ml-2 font-bold tabular-nums" style="color: #44FF88">
            {formatTime(store.lastLapSplitMs)}
          </span>
        </div>
      </div>
    {/if}

    <!-- Live standings widget (left edge, racing only) -->
    {#if store.phase === "racing" && store.standings.length > 0}
      <div class="absolute left-4 top-32">
        <div
          class="rounded-lg border px-3 py-2"
          style="background: var(--color-surface); border-color: var(--color-border); backdrop-filter: blur(8px)"
        >
          <div class="space-y-1">
            {#each store.standings as row (row.id)}
              <div
                class="flex items-center gap-2 rounded px-1.5 py-0.5 text-xs"
                style={row.isLocal
                  ? "background: color-mix(in srgb, var(--color-accent) 18%, transparent)"
                  : ""}
              >
                <span
                  class="w-4 text-right font-bold tabular-nums"
                  style="color: {row.isLocal ? 'var(--color-accent)' : 'var(--color-text-muted)'}"
                >
                  {row.place}
                </span>
                <span
                  class="h-2.5 w-2.5 shrink-0 rounded-full"
                  style="background: {accentFor(row.accentIndex)}"
                ></span>
                <span
                  class="max-w-[7rem] flex-1 truncate font-medium"
                  style="color: {row.isLocal ? 'var(--color-text)' : 'var(--color-text-muted)'}"
                >
                  {row.name}
                </span>
                {#if row.isBot}
                  <span
                    class="shrink-0 rounded-sm px-1 text-[8px] font-bold tracking-wide"
                    style="background: var(--color-border); color: var(--color-text-muted)"
                  >CPU</span>
                {/if}
                <span class="tabular-nums text-[10px]" style="color: var(--color-text-muted)">
                  {#if row.finished}
                    ✓
                  {:else}
                    L{Math.min(row.lap + 1, store.lapCount)}
                  {/if}
                </span>
              </div>
            {/each}
          </div>
        </div>
      </div>
    {/if}

    <!-- Early finisher: local player crossed the line while others race. Swap
         the racing HUD chrome for a waiting banner (the chase cam already
         follows the leader via store.cameraTargetKartId). -->
    {#if store.localFinished && !store.isSpectator}
      <div class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none">
        <div
          class="rounded-xl border px-8 py-5 text-center"
          style="background: var(--color-surface); border-color: var(--color-accent); backdrop-filter: blur(12px)"
        >
          <div class="font-display text-3xl font-black" style="color: var(--color-accent)">
            You finished {ordinalOrDash(store.localFinishPlace)}
          </div>
          <div class="mt-1 text-sm" style="color: var(--color-text-muted)">
            Waiting for {store.remainingRacers}
            {store.remainingRacers === 1 ? "racer" : "racers"}…
          </div>
        </div>
      </div>
    {/if}

    <!-- Toast notification stack — top-center (clear of the top-right minimap),
         below the position/lap card. -->
    <div
      role="status"
      aria-live="polite"
      class="absolute left-1/2 top-28 -translate-x-1/2 flex flex-col items-center space-y-2 pointer-events-none"
      style="z-index: 20"
    >
      {#each store.toasts as toast (toast.id)}
        <div
          class="toast-enter rounded-lg border px-4 py-2 text-sm font-bold whitespace-nowrap"
          style="background: var(--color-surface); border-color: {toast.color}; color: {toast.color}; backdrop-filter: blur(8px)"
        >
          {toast.text}
        </div>
      {/each}
    </div>

    <!-- Item slot (bottom-right) -->
    {#if store.phase === "racing" && !store.isSpectator && !store.localFinished}
      <div class="absolute bottom-20 right-4">
        <div
          class="rounded-xl border px-4 py-3 text-center"
          style="background: var(--color-surface); border-color: {store.isItemRolling ? 'var(--color-text-muted)' : itemColor(store.localItem)}; backdrop-filter: blur(8px)"
        >
          <div class="text-xs" style="color: var(--color-text-muted)">Item</div>
          {#if store.isItemRolling}
            <!-- Item roulette animation -->
            <div class="mt-1 text-3xl item-roulette leading-none">
              {itemIcon(store.rollingItem)}
            </div>
            <div
              class="text-sm font-bold item-roulette"
              style="color: {itemColor(store.rollingItem)}"
            >
              {itemName(store.rollingItem)}
            </div>
          {:else if store.localItem}
            <div class="mt-1 text-3xl leading-none">
              {itemIcon(store.localItem)}
            </div>
            <div
              class="text-sm font-bold"
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
    {#if store.localSlipstream && store.phase === "racing" && !store.isSpectator && !store.localFinished}
      <div class="absolute bottom-20 left-1/2 -translate-x-1/2">
        <div class="slipstream-text text-sm font-black uppercase tracking-wider" style="color: #00CCFF">
          Slipstream
        </div>
      </div>
    {/if}

    <!-- Drift charge meter -->
    {#if store.localDriftActive && store.phase === "racing" && !store.isSpectator && !store.localFinished}
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
    {#if store.localPlayerId && store.phase !== "finished" && !store.isSpectator && !store.localFinished}
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
                class:speed-bar-boost={boostActive}
                style="width: {speedPercent()}%; background: {boostActive
                  ? '#FFD93D'
                  : 'var(--color-accent)'}"
              ></div>
            </div>
          </div>
          {#if !isMobile}
            <div class="mt-1 flex items-center justify-center gap-4 text-xs" style="color: var(--color-text-muted)">
              <span><b>WASD</b> move</span>
              <span><b>Shift</b> drift</span>
              <span><b>E</b>/<b>X</b> item</span>
            </div>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Minimap (top-right, below leave button). Shown during the countdown too
         so players can read grid layout / track shape before GO. -->
    {#if store.phase === "racing" || store.phase === "countdown"}
      <div class="absolute top-16 right-4">
        <Minimap />
      </div>
    {/if}

    <!-- Animated countdown overlay -->
    {#if store.phase === "countdown"}
      <div
        role="status"
        aria-live="assertive"
        class="absolute inset-0 flex items-center justify-center pointer-events-none"
      >
        {#if store.countdownNumber !== null}
          {#key store.countdownNumber}
            <div class="countdown-number font-display" style="color: white; font-size: 120px; font-weight: 900; line-height: 1;">
              {store.countdownNumber}
            </div>
          {/key}
        {:else}
          <div class="countdown-go font-display" style="color: var(--color-accent); font-size: 120px; font-weight: 900; line-height: 1;">
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
            {store.isTimeTrial ? "Time Trial" : "Waiting for racers..."}
          </div>
          <div class="mt-2 text-sm" style="color: var(--color-text-muted)">
            {#if store.isTimeTrial}
              Race the clock and your ghost on {trackDisplayName}. Ready up to start.
            {:else}
              {store.playerCount}/{RACE_MAX_PLAYERS} racers. Start solo or wait for more racers to join.
            {/if}
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

          <!-- Ready up toggle (server readyUp toggles; spectators can't ready) -->
          {#if store.isSpectator}
            <div class="mt-4 text-sm" style="color: var(--color-text-muted)">
              Spectating — you'll join the grid when a slot opens for the next race.
            </div>
          {:else if store.localPlayerId}
            <button
              onclick={onReadyUp}
              class="pointer-events-auto mt-4 rounded-lg border px-6 py-2 text-sm font-bold transition-opacity hover:opacity-90"
              style={isLocalReady
                ? "background: transparent; border-color: #44FF88; color: #44FF88"
                : "background: var(--color-accent); border-color: var(--color-accent); color: black"}
            >
              {isLocalReady
                ? "Ready! (tap to cancel)"
                : store.playerCount <= 1
                  ? "Start Solo Race"
                  : "Ready Up"}
            </button>
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
      {@const ttFinish = store.localKart?.finishTime ?? null}
      <div class="absolute inset-0 flex items-center justify-center">
        <div
          class="rounded-xl border px-12 py-8 text-center"
          style="background: var(--color-surface); border-color: var(--color-accent); backdrop-filter: blur(16px)"
        >
          <div class="font-display text-5xl font-black" style="color: var(--color-accent)">
            {store.isTimeTrial
              ? "TIME TRIAL"
              : localFinish === 1
                ? "YOU WIN!"
                : "RACE OVER"}
          </div>

          <!-- Time-trial result: total time + new-personal-best callout. -->
          {#if store.isTimeTrial && ttFinish != null}
            <div class="mt-3">
              <div class="font-display text-3xl font-black tabular-nums" style="color: var(--color-text)">
                {formatTime(ttFinish)}
              </div>
              {#if newGhostBest}
                <div class="ghost-best mt-1 text-sm font-bold" style="color: #44FF88">
                  ★ New personal best! Ghost saved.
                </div>
              {:else}
                <div class="mt-1 text-xs" style="color: var(--color-text-muted)">
                  Didn't beat your ghost — try again!
                </div>
              {/if}
            </div>
          {/if}

          <!-- Full results table: finish order + per-player stats the server
               broadcasts (best lap, top speed, hits). -->
          <div class="mt-6">
            <div
              class="grid items-center gap-x-3 px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider"
              style="grid-template-columns: 2rem minmax(7rem, 1fr) 4.5rem 4.5rem 3rem 3rem; color: var(--color-text-muted)"
            >
              <span></span>
              <span class="text-left">Racer</span>
              <span class="text-right">Total</span>
              <span class="text-right">Best Lap</span>
              <span class="text-right">Top</span>
              <span class="text-right">Hits</span>
            </div>
            {#each results as result, i (result.id)}
              <div
                class="grid items-center gap-x-3 rounded-md px-2 py-1.5 text-sm"
                style="grid-template-columns: 2rem minmax(7rem, 1fr) 4.5rem 4.5rem 3rem 3rem; {result.isLocal
                  ? 'background: color-mix(in srgb, var(--color-accent) 16%, transparent)'
                  : ''}"
              >
                <span class="text-base font-bold" style="color: {result.color}">
                  {ordinal(i + 1)}
                </span>
                <span class="truncate text-left font-medium" style="color: var(--color-text)">
                  {result.name}{#if result.isBot}<span
                      class="ml-1 rounded-sm px-1 align-middle text-[8px] font-bold tracking-wide"
                      style="background: var(--color-border); color: var(--color-text-muted)"
                    >CPU</span>{/if}
                </span>
                <span class="text-right tabular-nums" style="color: var(--color-text-muted)">
                  {result.time}
                </span>
                <span class="text-right tabular-nums text-xs" style="color: #44FF88">
                  {result.bestLap}
                </span>
                <span class="text-right tabular-nums text-xs" style="color: var(--color-text-muted)">
                  {result.topSpeed || "--"}
                </span>
                <span class="text-right tabular-nums text-xs" style="color: var(--color-text-muted)">
                  {result.hitsDealt}/{result.hitsTaken}
                </span>
              </div>
            {/each}
            <div class="mt-1 px-2 text-right text-[10px]" style="color: var(--color-text-muted)">
              Hits = dealt / taken
            </div>
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

          <!-- Rematch + Leave buttons (spectators can't vote — server rejects them) -->
          <div class="mt-4 flex items-center justify-center gap-4">
            {#if !store.isSpectator}
              <button
                onclick={() => controls.voteRematch()}
                disabled={hasVotedRematch}
                class="pointer-events-auto rounded-lg border px-6 py-2 text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-60"
                style={hasVotedRematch
                  ? "background: transparent; border-color: #44FF88; color: #44FF88"
                  : "background: var(--color-accent); color: black; border-color: var(--color-accent)"}
              >
                {hasVotedRematch
                  ? `Waiting for others (${rematchVoteCount}/${store.playerCount})`
                  : `Rematch (${rematchVoteCount}/${store.playerCount})`}
              </button>
            {/if}
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

    <!-- Mobile touch controls (also shown during countdown so holding GAS
         counts toward rocket-start timing, matching keyboard) -->
    {#if isMobile && (store.phase === "racing" || store.phase === "countdown") && !store.isSpectator}
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
            style="background: var(--color-accent); opacity: 0.4; transform: translateX({controls.touchInput.steering * 30}px)"
          ></div>
        </div>
      </div>

      <!-- Right side: action buttons. Real <button> elements with aria-labels +
           pressed states; touchstart/end drive the input arbiter. -->
      <div class="pointer-events-auto absolute bottom-4 right-4 flex flex-col items-end gap-2" style="z-index: 30">
        <!-- Throttle -->
        <button
          type="button"
          class="touch-btn select-none rounded-full border text-xs font-bold"
          style="width: 72px; height: 72px; background: {controls.touchInput.throttle ? 'var(--color-accent)' : 'rgba(255,255,255,0.08)'}; border-color: var(--color-accent); color: {controls.touchInput.throttle ? 'black' : 'var(--color-accent)'}"
          aria-label="Accelerate"
          aria-pressed={controls.touchInput.throttle}
          ontouchstart={(e) => { e.preventDefault(); sound.resume(); controls.setTouchInput({ throttle: true }); }}
          ontouchend={(e) => { e.preventDefault(); controls.setTouchInput({ throttle: false }); }}
          ontouchcancel={() => controls.setTouchInput({ throttle: false })}
        >
          GAS
        </button>
        <div class="flex gap-2">
          <!-- Brake -->
          <button
            type="button"
            class="touch-btn select-none rounded-full border text-xs font-bold"
            style="width: 56px; height: 56px; background: {controls.touchInput.brake ? '#FF4444' : 'rgba(255,255,255,0.08)'}; border-color: #FF4444; color: {controls.touchInput.brake ? 'black' : '#FF4444'}"
            aria-label="Brake"
            aria-pressed={controls.touchInput.brake}
            ontouchstart={(e) => { e.preventDefault(); controls.setTouchInput({ brake: true }); }}
            ontouchend={(e) => { e.preventDefault(); controls.setTouchInput({ brake: false }); }}
            ontouchcancel={() => controls.setTouchInput({ brake: false })}
          >
            BRK
          </button>
          <!-- Drift -->
          <button
            type="button"
            class="touch-btn select-none rounded-full border text-xs font-bold"
            style="width: 56px; height: 56px; background: {controls.touchInput.drift ? '#CC44FF' : 'rgba(255,255,255,0.08)'}; border-color: #CC44FF; color: {controls.touchInput.drift ? 'black' : '#CC44FF'}"
            aria-label="Drift"
            aria-pressed={controls.touchInput.drift}
            ontouchstart={(e) => { e.preventDefault(); controls.setTouchInput({ drift: true }); }}
            ontouchend={(e) => { e.preventDefault(); controls.setTouchInput({ drift: false }); }}
            ontouchcancel={() => controls.setTouchInput({ drift: false })}
          >
            DFT
          </button>
          <!-- Item -->
          <button
            type="button"
            class="touch-btn select-none rounded-full border text-xs font-bold"
            style="width: 56px; height: 56px; background: {touchItem ? '#FFD93D' : 'rgba(255,255,255,0.08)'}; border-color: #FFD93D; color: {touchItem ? 'black' : '#FFD93D'}"
            aria-label="Use item"
            aria-pressed={touchItem}
            ontouchstart={(e) => { e.preventDefault(); touchItem = true; controls.useItem(); }}
            ontouchend={(e) => { e.preventDefault(); touchItem = false; }}
            ontouchcancel={() => (touchItem = false)}
          >
            ITM
          </button>
        </div>
      </div>
    {/if}

    <!-- Diagnostics overlay (opt-in) — snapshot rate + age estimated from the
         raceTimer change cadence. Bottom-left, out of the way of the HUD. -->
    {#if settings.showDiagnostics}
      <div
        class="pointer-events-none absolute bottom-2 left-2 rounded-md border px-2.5 py-1.5 font-mono text-[10px] leading-tight tabular-nums"
        style="background: rgba(0,0,0,0.6); border-color: var(--color-border); color: #9be7a0; z-index: 35"
        aria-hidden="true"
      >
        <div>snap {snapshotHz > 0 ? snapshotHz.toFixed(1) : "--"} Hz</div>
        <div>age {Math.round(snapshotAgeMs)} ms</div>
        <div style="color: var(--color-text-muted)">
          {controls.connStatus}
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
    {:else if !hasEverConnected}
      <!-- First connect only — afterwards blips show the banner below instead -->
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
    {:else if !controls.isConnected}
      <div
        role="status"
        aria-live="polite"
        class="absolute top-0 left-0 right-0 z-50 px-4 py-2 text-center text-sm"
        style="background: rgba(180,120,0,0.85); color: #ffe0a0"
      >
        {controls.connStatus === "connecting"
          ? "Reconnecting..."
          : "Connection lost — attempting to reconnect..."}
      </div>
    {/if}
  </div>
  {/if}

  <!-- ====================================================================== -->
  <!-- Options overlay (Esc). Does NOT pause the authoritative server sim — the
       race keeps running, hence "Options" rather than "Pause". Focus is trapped
       within the panel and Esc closes it (handled in the global key effect). -->
  <!-- ====================================================================== -->
  {#if optionsOpen}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="pointer-events-auto absolute inset-0 flex items-center justify-center p-4"
      style="background: rgba(0,0,0,0.55); backdrop-filter: blur(4px); z-index: 60"
      onpointerdown={(e) => {
        if (e.target === e.currentTarget) closeOptions();
      }}
    >
      <div
        bind:this={optionsPanel}
        role="dialog"
        aria-modal="true"
        aria-label="Options"
        class="w-full max-w-md rounded-2xl border p-6"
        style="background: var(--color-surface); border-color: var(--color-border); max-height: 90vh; overflow-y: auto"
      >
        <div class="flex items-center justify-between">
          <div class="font-display text-2xl font-black" style="color: var(--color-accent)">
            Options
          </div>
          <button
            onclick={closeOptions}
            aria-label="Close options"
            class="rounded-md border px-2 py-1 text-sm transition-colors hover:border-(--color-accent)"
            style="background: var(--color-bg); border-color: var(--color-border); color: var(--color-text-muted)"
          >
            Esc
          </button>
        </div>
        <p class="mt-1 text-xs" style="color: var(--color-text-muted)">
          The race keeps running while this is open — it doesn't pause the server.
        </p>

        <!-- Audio -->
        <div class="mt-5">
          <div class="text-xs font-semibold uppercase tracking-wider" style="color: var(--color-text-muted)">
            Audio
          </div>
          <div class="mt-2 flex items-center gap-3">
            <button
              onclick={() => sound.toggleMuted()}
              aria-label={sound.muted ? "Unmute audio" : "Mute audio"}
              aria-pressed={sound.muted}
              class="rounded-md border px-3 py-1.5 text-sm font-medium transition-colors"
              style={sound.muted
                ? "background: var(--color-bg); border-color: var(--color-border); color: var(--color-text-muted)"
                : "background: color-mix(in srgb, var(--color-accent) 16%, var(--color-surface)); border-color: var(--color-accent); color: var(--color-accent)"}
            >
              {sound.muted ? "🔇 Muted" : "🔊 Sound On"}
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={sound.volume}
              aria-label="Master volume"
              oninput={(e) => sound.setVolume(Number(e.currentTarget.value))}
              class="h-1 flex-1 cursor-pointer"
              style="accent-color: var(--color-accent)"
            />
            <span class="w-8 text-right text-xs tabular-nums" style="color: var(--color-text-muted)">
              {Math.round(sound.volume * 100)}
            </span>
          </div>
        </div>

        <!-- Motion / accessibility -->
        <div class="mt-5">
          <div class="text-xs font-semibold uppercase tracking-wider" style="color: var(--color-text-muted)">
            Motion
          </div>
          <div class="mt-2 space-y-2">
            <div class="flex items-center justify-between">
              <span class="text-sm" style="color: var(--color-text)">Reduced motion</span>
              <div class="flex items-center gap-1" role="group" aria-label="Reduced motion">
                {#each (["auto", "on", "off"] as const) as opt}
                  <button
                    onclick={() => settings.setReducedMotion(opt)}
                    aria-pressed={settings.reducedMotion === opt}
                    class="rounded-md border px-2.5 py-1 text-xs font-medium capitalize transition-colors"
                    style={settings.reducedMotion === opt
                      ? "background: color-mix(in srgb, var(--color-accent) 16%, var(--color-surface)); border-color: var(--color-accent); color: var(--color-accent)"
                      : "background: var(--color-bg); border-color: var(--color-border); color: var(--color-text-muted)"}
                  >
                    {opt}
                  </button>
                {/each}
              </div>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-sm" style="color: var(--color-text)">Camera FOV kick</span>
              <button
                onclick={() => settings.toggleCameraFovKick()}
                role="switch"
                aria-checked={settings.cameraFovKick}
                class="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors"
                style={settings.cameraFovKick
                  ? "background: color-mix(in srgb, var(--color-accent) 16%, var(--color-surface)); border-color: var(--color-accent); color: var(--color-accent)"
                  : "background: var(--color-bg); border-color: var(--color-border); color: var(--color-text-muted)"}
              >
                <span class="h-2 w-2 rounded-full" style="background: {settings.cameraFovKick ? 'var(--color-accent)' : 'var(--color-text-muted)'}"></span>
                {settings.cameraFovKick ? "On" : "Off"}
              </button>
            </div>
          </div>
        </div>

        <!-- Diagnostics -->
        <div class="mt-5">
          <div class="text-xs font-semibold uppercase tracking-wider" style="color: var(--color-text-muted)">
            Diagnostics
          </div>
          <div class="mt-2 flex items-center justify-between">
            <span class="text-sm" style="color: var(--color-text)">Show netcode overlay</span>
            <button
              onclick={() => settings.toggleShowDiagnostics()}
              role="switch"
              aria-checked={settings.showDiagnostics}
              class="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors"
              style={settings.showDiagnostics
                ? "background: color-mix(in srgb, var(--color-accent) 16%, var(--color-surface)); border-color: var(--color-accent); color: var(--color-accent)"
                : "background: var(--color-bg); border-color: var(--color-border); color: var(--color-text-muted)"}
            >
              <span class="h-2 w-2 rounded-full" style="background: {settings.showDiagnostics ? 'var(--color-accent)' : 'var(--color-text-muted)'}"></span>
              {settings.showDiagnostics ? "On" : "Off"}
            </button>
          </div>
        </div>

        <!-- Controls reference -->
        <div class="mt-5">
          <div class="text-xs font-semibold uppercase tracking-wider" style="color: var(--color-text-muted)">
            Controls
          </div>
          <div class="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2" style="color: var(--color-text-muted)">
            <div class="flex justify-between gap-2"><span>Steer / accelerate</span><b style="color: var(--color-text)">WASD / Arrows</b></div>
            <div class="flex justify-between gap-2"><span>Drift</span><b style="color: var(--color-text)">Shift / Space</b></div>
            <div class="flex justify-between gap-2"><span>Use item</span><b style="color: var(--color-text)">E / X</b></div>
            <div class="flex justify-between gap-2"><span>Look back</span><b style="color: var(--color-text)">C</b></div>
            <div class="flex justify-between gap-2"><span>Options</span><b style="color: var(--color-text)">Esc</b></div>
            {#if isMobile}
              <div class="flex justify-between gap-2"><span>Touch</span><b style="color: var(--color-text)">On-screen pads</b></div>
            {/if}
          </div>
          <div class="mt-2 text-[11px]" style="color: var(--color-text-muted)">
            Gamepad: left stick steer · RT accelerate · LT brake · A/✕ drift · B/RB item.
          </div>
        </div>

        <!-- Actions -->
        <div class="mt-6 flex items-center justify-between gap-3">
          <button
            onclick={() => controls && controls.leave()}
            class="rounded-lg border px-5 py-2 text-sm font-semibold transition-colors hover:border-(--color-danger)"
            style="background: var(--color-bg); border-color: var(--color-border); color: var(--color-danger)"
          >
            Leave Race
          </button>
          <button
            onclick={closeOptions}
            class="rounded-lg px-6 py-2 text-sm font-bold text-black transition-opacity hover:opacity-90"
            style="background: var(--color-accent)"
          >
            Resume
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Portrait rotate prompt (touch devices only). Driven purely by the CSS
       orientation media query so it appears whether or not the orientation
       lock on Ready Up succeeded. -->
  {#if isMobile}
    <div class="rotate-prompt" aria-hidden="true">
      <div class="rotate-prompt-card">
        <div class="rotate-icon">📱↻</div>
        <div class="rotate-text">Rotate your device to landscape</div>
      </div>
    </div>
  {/if}
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

  /* Toast enter animation — drops in from above to suit the top-center stack */
  .toast-enter {
    animation: toastSlideIn 0.3s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
  }

  @keyframes toastSlideIn {
    from {
      transform: translateY(-12px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }

  /* Big skewed position numeral with outline + glow (uses the display font) */
  .position-numeral {
    text-shadow:
      0 0 12px color-mix(in srgb, var(--color-accent) 70%, transparent),
      0 2px 0 rgba(0, 0, 0, 0.5);
    -webkit-text-stroke: 1px rgba(0, 0, 0, 0.35);
  }

  /* Speed-bar boost flash while a boost timer is active */
  .speed-bar-boost {
    animation: speedBarBoost 0.3s ease-in-out infinite alternate;
    box-shadow: 0 0 10px #ffd93d;
  }

  @keyframes speedBarBoost {
    from {
      filter: brightness(1);
    }
    to {
      filter: brightness(1.5);
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

  /* FINAL LAP banner — punchy slam-in then hold, glow pulse */
  .final-lap-banner {
    animation: finalLapSlam 0.5s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
    text-shadow:
      0 0 24px rgba(255, 217, 61, 0.7),
      0 0 48px rgba(255, 217, 61, 0.4),
      0 2px 0 rgba(0, 0, 0, 0.5);
    -webkit-text-stroke: 1px rgba(0, 0, 0, 0.4);
  }

  @keyframes finalLapSlam {
    0% {
      transform: scale(2.2) rotate(-4deg);
      opacity: 0;
    }
    55% {
      transform: scale(0.92) rotate(0deg);
      opacity: 1;
    }
    100% {
      transform: scale(1) rotate(0deg);
      opacity: 1;
    }
  }

  /* Lap-split toast — drop in from above (matches the toast stack motion) */
  .lap-split-toast {
    animation: toastSlideIn 0.3s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
  }

  /* New-personal-best ghost callout — a celebratory pop. */
  .ghost-best {
    animation: ghostBestPop 0.5s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
    text-shadow: 0 0 12px rgba(68, 255, 136, 0.6);
  }

  @keyframes ghostBestPop {
    0% {
      transform: scale(0.7);
      opacity: 0;
    }
    60% {
      transform: scale(1.1);
      opacity: 1;
    }
    100% {
      transform: scale(1);
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .ghost-best {
      animation: none;
    }
  }

  /* WRONG WAY banner — urgent flash. Disabled under reduced motion (it stays
     visible, just doesn't strobe). */
  .wrong-way-banner {
    animation: wrongWayFlash 0.7s ease-in-out infinite;
    box-shadow:
      0 0 18px rgba(255, 68, 68, 0.55),
      0 0 40px rgba(255, 68, 68, 0.3);
    text-shadow: 0 0 12px rgba(255, 68, 68, 0.7);
  }

  @keyframes wrongWayFlash {
    0%,
    100% {
      opacity: 1;
      transform: scale(1);
    }
    50% {
      opacity: 0.45;
      transform: scale(0.96);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .final-lap-banner {
      animation: none;
    }
    .wrong-way-banner {
      animation: none;
      opacity: 1;
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
