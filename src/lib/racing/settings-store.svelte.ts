/**
 * SettingsStore — player-facing graphics / accessibility / diagnostics options.
 *
 * A runes singleton (parked on globalThis so an HMR reload keeps the same
 * instance) persisted to localStorage. It owns the cross-cutting preferences
 * the pause/options overlay exposes:
 *
 *   - reducedMotion ('auto' | 'on' | 'off') — 'auto' follows the OS
 *     prefers-reduced-motion media query; 'on'/'off' force it. The derived
 *     `reducedMotionActive` is the single boolean the rest of the app reads
 *     (speed-line vignette, camera shake, banner flashes) so a single switch
 *     calms all the motion at once.
 *   - cameraFovKick (boolean) — whether the chase cam does its speed/boost FOV
 *     punch. Off = a steady FOV for players prone to motion sickness.
 *   - showDiagnostics (boolean) — render the tiny netcode overlay (snapshot Hz
 *     + age) on the play page.
 *
 * Audio volume/mute are intentionally NOT duplicated here — the SoundManager
 * (wave 2) is the single source of truth for those (it already persists them
 * and every audio call routes through it). The options overlay binds its
 * volume/mute controls straight to the SoundManager so there is exactly one
 * audio state.
 *
 * Components that should react to reduced-motion at the DOM level can read the
 * `data-reduced-motion` attribute this store mirrors onto <html> (used by
 * app.css to neutralize CSS keyframe animations); runtime systems (ChaseCam,
 * the speed-line gate) read `reducedMotionActive` / `cameraFovKick` directly.
 */

export type ReducedMotionPref = "auto" | "on" | "off";

const REDUCED_MOTION_KEY = "rivetKart.settings.reducedMotion";
const FOV_KICK_KEY = "rivetKart.settings.cameraFovKick";
const DIAGNOSTICS_KEY = "rivetKart.settings.showDiagnostics";

function loadReducedMotion(): ReducedMotionPref {
  if (typeof localStorage === "undefined") return "auto";
  const raw = localStorage.getItem(REDUCED_MOTION_KEY);
  return raw === "on" || raw === "off" || raw === "auto" ? raw : "auto";
}

function loadBool(key: string, fallback: boolean): boolean {
  if (typeof localStorage === "undefined") return fallback;
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  return raw === "true";
}

export class SettingsStore {
  // --- Persisted preferences ------------------------------------------------
  reducedMotion = $state<ReducedMotionPref>(loadReducedMotion());
  cameraFovKick = $state<boolean>(loadBool(FOV_KICK_KEY, true));
  showDiagnostics = $state<boolean>(loadBool(DIAGNOSTICS_KEY, false));

  /**
   * Live value of the OS prefers-reduced-motion query (only meaningful when
   * `reducedMotion === 'auto'`). Kept in $state and updated from a media-query
   * listener registered in `init()` so 'auto' tracks an OS toggle live.
   */
  private osReducedMotion = $state<boolean>(false);
  private mql: MediaQueryList | null = null;
  private mqlHandler: ((e: MediaQueryListEvent) => void) | null = null;

  /** The single boolean the rest of the app reads. */
  reducedMotionActive = $derived(
    this.reducedMotion === "on"
      ? true
      : this.reducedMotion === "off"
        ? false
        : this.osReducedMotion,
  );

  /**
   * Bind the OS media query and mirror reduced-motion onto <html> so app.css
   * can neutralize CSS animations. Safe to call repeatedly (idempotent) and
   * a no-op on the server. Returns a teardown for the media-query listener.
   */
  init(): () => void {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return () => {};
    }
    if (!this.mql && typeof window.matchMedia === "function") {
      this.mql = window.matchMedia("(prefers-reduced-motion: reduce)");
      this.osReducedMotion = this.mql.matches;
      this.mqlHandler = (e: MediaQueryListEvent) => {
        this.osReducedMotion = e.matches;
        this.syncDom();
      };
      // addEventListener is the modern API; older Safari only has addListener.
      if ("addEventListener" in this.mql) {
        this.mql.addEventListener("change", this.mqlHandler);
      } else {
        (this.mql as MediaQueryList).addListener(this.mqlHandler);
      }
    }
    this.syncDom();
    return () => {
      if (this.mql && this.mqlHandler) {
        if ("removeEventListener" in this.mql) {
          this.mql.removeEventListener("change", this.mqlHandler);
        } else {
          (this.mql as MediaQueryList).removeListener(this.mqlHandler);
        }
      }
      this.mql = null;
      this.mqlHandler = null;
    };
  }

  /** Mirror the effective reduced-motion state onto <html data-reduced-motion>. */
  syncDom(): void {
    if (typeof document === "undefined") return;
    document.documentElement.dataset.reducedMotion = this.reducedMotionActive
      ? "true"
      : "false";
  }

  // --- Mutators -------------------------------------------------------------
  setReducedMotion(pref: ReducedMotionPref): void {
    this.reducedMotion = pref;
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(REDUCED_MOTION_KEY, pref);
    }
    this.syncDom();
  }

  setCameraFovKick(on: boolean): void {
    this.cameraFovKick = on;
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(FOV_KICK_KEY, String(on));
    }
  }

  toggleCameraFovKick(): void {
    this.setCameraFovKick(!this.cameraFovKick);
  }

  setShowDiagnostics(on: boolean): void {
    this.showDiagnostics = on;
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(DIAGNOSTICS_KEY, String(on));
    }
  }

  toggleShowDiagnostics(): void {
    this.setShowDiagnostics(!this.showDiagnostics);
  }
}

// ---------------------------------------------------------------------------
// Singleton (HMR-safe — parked on globalThis so a hot reload reuses the same
// instance instead of dropping the player's chosen options each edit).
// ---------------------------------------------------------------------------

const GLOBAL_KEY = "__rivetKartSettings__";

interface GlobalWithSettings {
  [GLOBAL_KEY]?: SettingsStore;
}

export function getSettingsStore(): SettingsStore {
  const g = globalThis as GlobalWithSettings;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new SettingsStore();
  }
  return g[GLOBAL_KEY];
}
