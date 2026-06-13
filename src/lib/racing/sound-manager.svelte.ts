/**
 * SoundManager — fully synthesized Web Audio engine for Rivet Kart.
 *
 * Everything is generated procedurally (oscillators + filtered noise) so there
 * are NO audio asset files to license, source, or ship. A single singleton owns
 * one AudioContext routed master → destination, with volume/mute persisted to
 * localStorage and reactive ($state) so UI sliders bind directly.
 *
 * Sound groups:
 *   - Engine: two detuned sawtooths through a lowpass, pitch + cutoff driven by
 *     the local kart's speed each frame, plus a boost pitch kick.
 *   - Drift: looped band-passed white noise gated by the local drift state, with
 *     rising square chimes on each drift tier reached.
 *   - Items: roulette tick loop, pickup blip, fire whoosh, impact thud/crash
 *     (distance-attenuated for remote karts).
 *   - Race flow: countdown beeps + GO, rocket-start sting (tiered), lap ding,
 *     final-lap alert, finish fanfare.
 *   - Music: a quiet generative bass + pentatonic arpeggio on a lookahead
 *     scheduler with distinct waiting / racing intensity.
 *
 * The context starts suspended (browser autoplay policy) and is resumed on the
 * first user gesture (Ready click / pointerdown on the play page).
 *
 * HMR-safe: the singleton is parked on globalThis so a hot reload reuses the
 * same AudioContext instead of leaking a new one (and its oscillators) each
 * edit.
 */

import { KART_MAX_SPEED } from "./types.js";

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const VOLUME_KEY = "rivetKart.audio.volume";
const MUTED_KEY = "rivetKart.audio.muted";

function loadVolume(): number {
  if (typeof localStorage === "undefined") return 0.7;
  const raw = localStorage.getItem(VOLUME_KEY);
  if (raw === null) return 0.7; // unset — default, not Number(null)===0
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0.7;
  return Math.max(0, Math.min(1, n));
}

function loadMuted(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(MUTED_KEY) === "true";
}

// ---------------------------------------------------------------------------
// Music — pentatonic table (A minor pentatonic, two octaves) and chord roots
// ---------------------------------------------------------------------------

const PENTATONIC = [
  220.0, 261.63, 293.66, 329.63, 392.0, // A3 C4 D4 E4 G4
  440.0, 523.25, 587.33, 659.25, 783.99, // A4 C5 D5 E5 G5
];

const BASS_ROOTS = [110.0, 146.83, 130.81, 164.81]; // A2 D3 C3 E3 — gentle loop

// ---------------------------------------------------------------------------
// SoundManager
// ---------------------------------------------------------------------------

export class SoundManager {
  // Reactive so UI controls (slider / mute button) bind directly.
  volume = $state(loadVolume());
  muted = $state(loadMuted());

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** Sub-bus for the engine loop so it can be ducked independently of SFX. */
  private engineBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;

  // Shared noise buffer (reused for drift loop + one-shot noise bursts).
  private noiseBuffer: AudioBuffer | null = null;

  // Engine voices (started once, pitch/filter modulated each frame).
  private engineRunning = false;
  private engineOscA: OscillatorNode | null = null;
  private engineOscB: OscillatorNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private engineGain: GainNode | null = null;

  // Drift loop voice.
  private driftSource: AudioBufferSourceNode | null = null;
  private driftGain: GainNode | null = null;
  private driftActive = false;

  // Item roulette tick loop.
  private rouletteTimer: ReturnType<typeof setInterval> | null = null;

  // Music scheduler.
  private musicTimer: ReturnType<typeof setInterval> | null = null;
  private musicNextNoteTime = 0;
  private musicStep = 0;
  private musicIntensity: "waiting" | "racing" | "off" = "off";

  /** True once the context has been resumed by a user gesture. */
  initialized = $state(false);

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Lazily create the AudioContext + graph. Must be called from (or shortly
   * after) a user gesture — browsers start the context suspended otherwise.
   */
  init(): void {
    if (this.ctx) {
      void this.ctx.resume();
      this.initialized = this.ctx.state === "running";
      return;
    }
    if (typeof window === "undefined") return;
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return;

    try {
      this.ctx = new Ctor();
    } catch {
      return;
    }

    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);

    this.engineBus = ctx.createGain();
    this.engineBus.gain.value = 0.5;
    this.engineBus.connect(this.master);

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = 1.0;
    this.sfxBus.connect(this.master);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0.32; // music sits quietly under everything
    this.musicBus.connect(this.master);

    this.buildNoiseBuffer();
    this.applyMasterGain();

    void ctx.resume().then(() => {
      this.initialized = ctx.state === "running";
    });
  }

  /** Resume after a tab regains focus or a gesture lands; safe to spam. */
  resume(): void {
    if (!this.ctx) {
      this.init();
      return;
    }
    void this.ctx.resume().then(() => {
      this.initialized = this.ctx?.state === "running";
    });
  }

  private buildNoiseBuffer(): void {
    if (!this.ctx) return;
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buf;
  }

  private applyMasterGain(): void {
    if (!this.master || !this.ctx) return;
    const target = this.muted ? 0 : this.volume;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(target, now, 0.02);
  }

  // -------------------------------------------------------------------------
  // Reactive controls (bound by UI)
  // -------------------------------------------------------------------------

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.volume > 0 && this.muted) this.muted = false;
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(VOLUME_KEY, String(this.volume));
    }
    this.applyMasterGain();
  }

  toggleMuted(): void {
    this.muted = !this.muted;
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(MUTED_KEY, String(this.muted));
    }
    if (!this.muted) this.resume();
    this.applyMasterGain();
  }

  // -------------------------------------------------------------------------
  // Small synth helpers
  // -------------------------------------------------------------------------

  private get t(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** A single pitched envelope-shaped tone routed to the SFX bus. */
  private tone(
    freq: number,
    opts: {
      type?: OscillatorType;
      duration?: number;
      gain?: number;
      attack?: number;
      delay?: number;
      glideTo?: number;
      bus?: GainNode | null;
      detune?: number;
    } = {},
  ): void {
    if (!this.ctx || !this.sfxBus) return;
    const {
      type = "square",
      duration = 0.18,
      gain = 0.3,
      attack = 0.005,
      delay = 0,
      glideTo,
      bus = this.sfxBus,
      detune = 0,
    } = opts;
    const start = this.t + delay;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (glideTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(1, glideTo),
        start + duration,
      );
    }
    if (detune) osc.detune.value = detune;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), start + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(g);
    g.connect(bus ?? this.sfxBus);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  /** A short filtered-noise burst (crashes, whooshes, impacts). */
  private noiseBurst(
    opts: {
      duration?: number;
      gain?: number;
      type?: BiquadFilterType;
      freq?: number;
      q?: number;
      freqTo?: number;
      delay?: number;
    } = {},
  ): void {
    if (!this.ctx || !this.sfxBus || !this.noiseBuffer) return;
    const {
      duration = 0.25,
      gain = 0.3,
      type = "bandpass",
      freq = 1800,
      q = 1,
      freqTo,
      delay = 0,
    } = opts;
    const start = this.t + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(freq, start);
    if (freqTo !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(
        Math.max(40, freqTo),
        start + duration,
      );
    }
    filter.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(Math.max(0.0001, gain), start);
    g.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    src.connect(filter);
    filter.connect(g);
    g.connect(this.sfxBus);
    src.start(start);
    src.stop(start + duration + 0.02);
  }

  // -------------------------------------------------------------------------
  // ENGINE — driven each frame from the local kart speed
  // -------------------------------------------------------------------------

  startEngine(): void {
    if (!this.ctx || !this.engineBus || this.engineRunning) return;
    const now = this.t;

    this.engineFilter = this.ctx.createBiquadFilter();
    this.engineFilter.type = "lowpass";
    this.engineFilter.frequency.value = 400;
    this.engineFilter.Q.value = 6;

    this.engineGain = this.ctx.createGain();
    this.engineGain.gain.setValueAtTime(0.0001, now);
    this.engineGain.gain.exponentialRampToValueAtTime(0.16, now + 0.3);

    this.engineOscA = this.ctx.createOscillator();
    this.engineOscA.type = "sawtooth";
    this.engineOscA.frequency.value = 80;

    this.engineOscB = this.ctx.createOscillator();
    this.engineOscB.type = "sawtooth";
    this.engineOscB.frequency.value = 80;
    this.engineOscB.detune.value = 12; // slight beat between the two voices

    this.engineOscA.connect(this.engineFilter);
    this.engineOscB.connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain);
    this.engineGain.connect(this.engineBus);

    this.engineOscA.start(now);
    this.engineOscB.start(now);
    this.engineRunning = true;
  }

  stopEngine(): void {
    if (!this.engineRunning || !this.ctx) return;
    const now = this.t;
    if (this.engineGain) {
      this.engineGain.gain.cancelScheduledValues(now);
      this.engineGain.gain.setTargetAtTime(0.0001, now, 0.08);
    }
    const oscA = this.engineOscA;
    const oscB = this.engineOscB;
    try {
      oscA?.stop(now + 0.3);
      oscB?.stop(now + 0.3);
    } catch {
      // already stopped
    }
    this.engineOscA = null;
    this.engineOscB = null;
    this.engineFilter = null;
    this.engineGain = null;
    this.engineRunning = false;
  }

  /**
   * Update the engine pitch + filter cutoff from the local kart's normalized
   * speed (0..1+) each frame. `boost` adds a pitch kick while a boost is live.
   */
  updateEngine(speed: number, boost = false): void {
    if (!this.engineRunning || !this.engineOscA || !this.engineOscB || !this.ctx)
      return;
    const ratio = Math.max(0, Math.min(1.3, speed / KART_MAX_SPEED));
    const wobble = (Math.random() - 0.5) * 4;
    const kick = boost ? 1.18 : 1;
    const base = (80 + ratio * 200) * kick + wobble; // 80..~330 Hz
    const now = this.t;
    this.engineOscA.frequency.setTargetAtTime(base, now, 0.05);
    this.engineOscB.frequency.setTargetAtTime(base * 1.005, now, 0.05);
    if (this.engineFilter) {
      const cutoff = 350 + ratio * 2600 + (boost ? 800 : 0);
      this.engineFilter.frequency.setTargetAtTime(cutoff, now, 0.05);
    }
  }

  // -------------------------------------------------------------------------
  // DRIFT — looped band-passed noise gated by drift state + tier chimes
  // -------------------------------------------------------------------------

  setDrift(active: boolean): void {
    if (!this.ctx || !this.sfxBus || !this.noiseBuffer) return;
    if (active === this.driftActive) return;
    this.driftActive = active;

    if (active) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;
      const filter = this.ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = 2200;
      filter.Q.value = 0.8;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, this.t);
      g.gain.exponentialRampToValueAtTime(0.12, this.t + 0.05);
      src.connect(filter);
      filter.connect(g);
      g.connect(this.sfxBus);
      src.start();
      this.driftSource = src;
      this.driftGain = g;
    } else {
      const g = this.driftGain;
      const src = this.driftSource;
      if (g) g.gain.setTargetAtTime(0.0001, this.t, 0.05);
      try {
        src?.stop(this.t + 0.2);
      } catch {
        // already stopped
      }
      this.driftSource = null;
      this.driftGain = null;
    }
  }

  /** Rising square chime per drift tier (1/2/3 → higher). */
  driftTier(tier: number): void {
    if (!this.ctx) return;
    const freq = [0, 520, 700, 920][Math.max(0, Math.min(3, tier))] || 700;
    this.tone(freq, { type: "square", duration: 0.16, gain: 0.22 });
    this.tone(freq * 1.5, {
      type: "square",
      duration: 0.14,
      gain: 0.12,
      delay: 0.04,
    });
  }

  // -------------------------------------------------------------------------
  // ITEMS
  // -------------------------------------------------------------------------

  startRoulette(): void {
    if (!this.ctx || this.rouletteTimer) return;
    // Short tick every ~110ms (≈ the store roulette cadence).
    this.rouletteTimer = setInterval(() => {
      this.tone(660, { type: "square", duration: 0.04, gain: 0.12 });
    }, 110);
  }

  stopRoulette(): void {
    if (this.rouletteTimer) {
      clearInterval(this.rouletteTimer);
      this.rouletteTimer = null;
    }
  }

  /** Bright two-note blip when an item is locked in. */
  itemPickup(): void {
    this.stopRoulette();
    this.tone(880, { type: "square", duration: 0.1, gain: 0.25 });
    this.tone(1320, { type: "square", duration: 0.14, gain: 0.2, delay: 0.08 });
  }

  /** Fire whoosh — downward noise sweep + pitch drop. */
  itemFire(): void {
    this.noiseBurst({
      duration: 0.3,
      gain: 0.28,
      type: "bandpass",
      freq: 2600,
      freqTo: 500,
      q: 0.7,
    });
    this.tone(720, {
      type: "sawtooth",
      duration: 0.28,
      gain: 0.16,
      glideTo: 180,
    });
  }

  /**
   * Impact thud + crash noise. `attenuation` (0..1) scales the gain so remote
   * karts hit far away are quieter than a direct hit on the local player.
   */
  itemImpact(attenuation = 1): void {
    const a = Math.max(0.08, Math.min(1, attenuation));
    this.tone(110, {
      type: "sine",
      duration: 0.22,
      gain: 0.34 * a,
      glideTo: 55,
    });
    this.noiseBurst({
      duration: 0.22,
      gain: 0.26 * a,
      type: "lowpass",
      freq: 1400,
      freqTo: 300,
      q: 1,
    });
  }

  // -------------------------------------------------------------------------
  // RACE FLOW
  // -------------------------------------------------------------------------

  /** Countdown beep: 3/2/1 at 440Hz, GO (number === 0 / null) at 880Hz. */
  countdownBeep(go: boolean): void {
    if (go) {
      this.tone(880, { type: "square", duration: 0.4, gain: 0.32 });
      this.tone(1320, {
        type: "square",
        duration: 0.45,
        gain: 0.18,
        delay: 0.03,
      });
    } else {
      this.tone(440, { type: "square", duration: 0.22, gain: 0.28 });
    }
  }

  /** Rocket-start sting tiered by the rocketStart event payload. */
  rocketStart(tier: string): void {
    switch (tier) {
      case "perfect":
        // Triumphant ascending arpeggio.
        this.tone(660, { type: "sawtooth", duration: 0.12, gain: 0.26 });
        this.tone(880, {
          type: "sawtooth",
          duration: 0.12,
          gain: 0.26,
          delay: 0.08,
        });
        this.tone(1320, {
          type: "sawtooth",
          duration: 0.22,
          gain: 0.3,
          delay: 0.16,
        });
        this.itemFire();
        break;
      case "good":
        this.tone(660, { type: "sawtooth", duration: 0.14, gain: 0.24 });
        this.tone(990, {
          type: "sawtooth",
          duration: 0.2,
          gain: 0.26,
          delay: 0.1,
        });
        break;
      case "stall":
        // Sour descending — you bogged the start.
        this.tone(280, { type: "sawtooth", duration: 0.4, gain: 0.26, glideTo: 90 });
        break;
      default:
        this.tone(520, { type: "square", duration: 0.16, gain: 0.2 });
    }
  }

  /** Lap-crossing "ding". `finalLap` adds an alert sting. */
  lapDing(finalLap = false): void {
    this.tone(1180, { type: "sine", duration: 0.18, gain: 0.26 });
    this.tone(1480, { type: "sine", duration: 0.16, gain: 0.16, delay: 0.06 });
    if (finalLap) {
      this.tone(660, { type: "square", duration: 0.5, gain: 0.2, delay: 0.18 });
      this.tone(880, {
        type: "square",
        duration: 0.5,
        gain: 0.2,
        delay: 0.42,
      });
    }
  }

  /** Victory/finish fanfare arpeggio. `win` plays a brighter major run. */
  finishFanfare(win: boolean): void {
    const notes = win
      ? [523.25, 659.25, 783.99, 1046.5]
      : [392.0, 523.25, 659.25, 783.99];
    notes.forEach((f, i) => {
      this.tone(f, {
        type: "square",
        duration: 0.35,
        gain: 0.26,
        delay: i * 0.14,
      });
      this.tone(f * 2, {
        type: "triangle",
        duration: 0.3,
        gain: 0.1,
        delay: i * 0.14,
      });
    });
  }

  // -------------------------------------------------------------------------
  // MUSIC — lookahead generative loop, distinct waiting / racing intensity
  // -------------------------------------------------------------------------

  setMusic(intensity: "waiting" | "racing" | "off"): void {
    if (intensity === this.musicIntensity) return;
    this.musicIntensity = intensity;
    if (intensity === "off") {
      this.stopMusic();
      return;
    }
    if (this.musicBus && this.ctx) {
      const target = intensity === "racing" ? 0.4 : 0.26;
      this.musicBus.gain.setTargetAtTime(target, this.t, 0.4);
    }
    if (!this.musicTimer) this.startMusic();
  }

  private startMusic(): void {
    if (!this.ctx || this.musicTimer) return;
    this.musicNextNoteTime = this.t + 0.1;
    this.musicStep = 0;
    // Lookahead scheduler: every 60ms, schedule any notes due in the next 200ms.
    this.musicTimer = setInterval(() => this.scheduleMusic(), 60);
  }

  private stopMusic(): void {
    if (this.musicTimer) {
      clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
  }

  private scheduleMusic(): void {
    if (!this.ctx || !this.musicBus) return;
    const racing = this.musicIntensity === "racing";
    // Sixteenth-note step duration; racing is a touch faster.
    const stepDur = racing ? 0.16 : 0.22;
    const lookahead = this.t + 0.2;

    while (this.musicNextNoteTime < lookahead) {
      const step = this.musicStep;
      const startT = this.musicNextNoteTime;

      // Bass pulse every 4 steps.
      if (step % 4 === 0) {
        const root = BASS_ROOTS[(step >> 2) % BASS_ROOTS.length];
        this.scheduleMusicVoice(root, startT, stepDur * 3.4, "triangle", 0.22);
      }

      // Arpeggio from the pentatonic table — denser/higher while racing.
      const playArp = racing ? true : step % 2 === 0;
      if (playArp) {
        const span = racing ? PENTATONIC.length : 5;
        const idx = (step * (racing ? 3 : 2)) % span + (racing ? 2 : 0);
        const note = PENTATONIC[Math.min(PENTATONIC.length - 1, idx)];
        this.scheduleMusicVoice(
          note,
          startT,
          stepDur * 0.9,
          racing ? "square" : "triangle",
          racing ? 0.12 : 0.09,
        );
      }

      this.musicNextNoteTime += stepDur;
      this.musicStep = (step + 1) % 64;
    }
  }

  private scheduleMusicVoice(
    freq: number,
    startT: number,
    duration: number,
    type: OscillatorType,
    gain: number,
  ): void {
    if (!this.ctx || !this.musicBus) return;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, startT);
    g.gain.exponentialRampToValueAtTime(gain, startT + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, startT + duration);
    osc.connect(g);
    g.connect(this.musicBus);
    osc.start(startT);
    osc.stop(startT + duration + 0.05);
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  dispose(): void {
    this.stopEngine();
    this.setDrift(false);
    this.stopRoulette();
    this.stopMusic();
    this.musicIntensity = "off";
    if (this.ctx) {
      void this.ctx.close().catch(() => {});
    }
    this.ctx = null;
    this.master = null;
    this.engineBus = null;
    this.sfxBus = null;
    this.musicBus = null;
    this.noiseBuffer = null;
    this.initialized = false;
  }
}

// ---------------------------------------------------------------------------
// Singleton (HMR-safe — parked on globalThis so a hot reload reuses the same
// AudioContext instead of leaking a fresh one each edit).
// ---------------------------------------------------------------------------

const GLOBAL_KEY = "__rivetKartSoundManager__";

interface GlobalWithSound {
  [GLOBAL_KEY]?: SoundManager;
}

export function getSoundManager(): SoundManager {
  const g = globalThis as GlobalWithSound;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new SoundManager();
  }
  return g[GLOBAL_KEY];
}
