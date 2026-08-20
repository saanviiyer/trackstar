// vocoder.ts - a real, strong Web Audio channel vocoder.
//
// The MICROPHONE is the modulator; the synth signal is the carrier. For each of
// N log-spaced bands:
//   carrier -> bandpass -> VCA(gain) --------------------\
//   mic     -> bandpass -> rectify(WaveShaper) -> lowpass -> envScale -> VCA.gain
//   (the envelope of the mic in that band opens the carrier's gain in that band)
// All bands sum -> makeup gain -> soft-clip -> wet mix gain -> output.
//
// A dry/wet crossfade (Synth.setDryGain + this.wet) keeps enabling/disabling and
// live wet changes click-free. Without a mic the envelopes stay at 0, so the wet
// path is silent.

/** Full-wave rectifier curve for a WaveShaper: input x -> |x|. */
function rectifierCurve(n = 2048): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.abs(x);
  }
  return curve;
}

/** Soft-clip (tanh) curve for the wet limiter so extra makeup gain does not clip. */
function softClipCurve(k = 2.5, n = 2048): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

/**
 * Log-spaced band center frequencies. Pure and testable. Endpoints are exactly
 * minHz and maxHz; consecutive ratios are constant (constant-Q spacing).
 */
export function bandFrequencies(
  n: number,
  minHz: number,
  maxHz: number
): number[] {
  const count = Math.max(1, Math.floor(n));
  if (count === 1) return [minHz];
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    out.push(minHz * Math.pow(maxHz / minHz, t));
  }
  return out;
}

/**
 * Map hand openness (0..1) to a vocoder wet amount (0..1). A closed/relaxed hand
 * is dry; an open hand is full wet. A gentle smoothstep gives a natural feel and
 * a small dead-zone near zero so a relaxed hand stays fully dry.
 */
export function opennessToWet(openness: number): number {
  const o = Math.max(0, Math.min(1, openness));
  const dead = 0.08;
  if (o <= dead) return 0;
  const t = (o - dead) / (1 - dead);
  return t * t * (3 - 2 * t); // smoothstep
}

/**
 * Per-vocoder history for the hand-driven wet control. `lastOpenness` is the
 * most recent good openness reading; `missing` counts consecutive frames with
 * no modifier hand so brief tracking dropouts can be held instead of slamming
 * the effect to dry.
 */
export interface WetHoldState {
  lastOpenness: number;
  missing: number;
}

export function makeWetHoldState(): WetHoldState {
  return { lastOpenness: 0, missing: 0 };
}

/**
 * Robust wet-amount target for the hand-driven vocoder. `openness` is the
 * modifier hand's openness this frame, or null when that hand is missing (left
 * the frame or flickered out). Pure apart from mutating the supplied `state`,
 * so it is unit tested.
 *
 * Behaviour:
 *   - A good reading updates the held openness and clears the dropout counter.
 *   - A dropout within `holdFrames` HOLDS the last openness, so a momentary
 *     tracking gap does not cut the vocoder out.
 *   - A longer dropout glides the held openness gently down toward relaxed
 *     instead of jumping, so it never snaps to dry.
 *   - The result is clamped to at least `floor`, so an enabled vocoder is always
 *     at least faintly present and never fully disappears while it is on.
 */
export function handWetTarget(
  openness: number | null,
  state: WetHoldState,
  floor: number,
  holdFrames: number
): number {
  if (openness !== null && Number.isFinite(openness)) {
    state.lastOpenness = Math.max(0, Math.min(1, openness));
    state.missing = 0;
  } else {
    state.missing += 1;
    if (state.missing > holdFrames) {
      // Past the grace window: glide the held value down rather than snapping.
      state.lastOpenness *= 0.9;
    }
  }
  const wet = opennessToWet(state.lastOpenness);
  return Math.max(floor, Math.min(1, wet));
}

interface Band {
  carrierBP: BiquadFilterNode;
  vca: GainNode;
  modBP: BiquadFilterNode;
  shaper: WaveShaperNode;
  follower: BiquadFilterNode;
  follower2: BiquadFilterNode;
  envScale: GainNode;
}

export interface VocoderOptions {
  bands?: number;
  minHz?: number;
  maxHz?: number;
  /**
   * Envelope smoothing cutoff (Hz). Higher = faster/twitchier response; lower =
   * smoother, more musical glide. Two cascaded poles at this cutoff do the
   * smoothing so the band gains do not chatter on quiet passages.
   */
  followerHz?: number;
  sensitivity?: number;
  /** Bandpass Q (higher = tighter formant separation, but more ring/chatter). */
  q?: number;
  /** Extra intensity multiplier on the envelope drive + makeup. */
  strength?: number;
  /**
   * Minimum wet amount (0..1) the hand-driven control will hold while the
   * vocoder is enabled, so a missing/closed modifier hand never fully drops the
   * effect out. The manual wet/dry slider is unaffected and keeps full range.
   */
  wetFloor?: number;
  /**
   * Frames of missing-hand tracking to hold the last wet value before it starts
   * to glide down (~one frame is 16 ms at 60 fps).
   */
  holdFrames?: number;
  /** Time constant (seconds) for the hand-driven wet ramp; larger = smoother. */
  handRampSec?: number;
}

export class Vocoder {
  private ctx: AudioContext;
  private carrier: AudioNode;
  private out: AudioNode;

  private modInput: GainNode; // mic gain / sensitivity input
  private sum: GainNode; // makeup gain
  private clip: WaveShaperNode; // soft-clip limiter
  private wet: GainNode; // wet mix (0..1)
  private bands: Band[] = [];
  private micSource: MediaStreamAudioSourceNode | null = null;

  private sensitivity: number;
  private strength: number;
  private bandCount: number;

  // Hand-driven wet smoothing state + tunables.
  private wetState: WetHoldState = makeWetHoldState();
  private wetFloor: number;
  private holdFrames: number;
  private handRampSec: number;

  constructor(
    ctx: AudioContext,
    carrier: AudioNode,
    out: AudioNode,
    opts: VocoderOptions = {}
  ) {
    this.ctx = ctx;
    this.carrier = carrier;
    this.out = out;
    this.sensitivity = opts.sensitivity ?? 10;
    this.strength = opts.strength ?? 1;
    this.wetFloor = Math.max(0, Math.min(1, opts.wetFloor ?? 0.12));
    this.holdFrames = Math.max(0, Math.floor(opts.holdFrames ?? 12));
    this.handRampSec = Math.max(0.01, opts.handRampSec ?? 0.18);

    const n = opts.bands ?? 24;
    this.bandCount = n;
    const minHz = opts.minHz ?? 110;
    const maxHz = opts.maxHz ?? 7500;
    // Slower, smoother follower + a gentler Q than the earlier "more powerful"
    // tuning, so the vocoder stays strong but glides instead of chattering.
    const followerHz = opts.followerHz ?? 16;
    const q = opts.q ?? 8;
    const curve = rectifierCurve();
    const freqs = bandFrequencies(n, minHz, maxHz);

    this.modInput = ctx.createGain();
    this.modInput.gain.value = 1;

    this.sum = ctx.createGain();
    this.sum.gain.value = this.makeup();

    this.clip = ctx.createWaveShaper();
    this.clip.curve = softClipCurve();
    this.clip.oversample = "4x";

    this.wet = ctx.createGain();
    this.wet.gain.value = 0; // start silent; setMix/start ramps up

    this.sum.connect(this.clip);
    this.clip.connect(this.wet);
    this.wet.connect(this.out);

    for (const freq of freqs) {
      const carrierBP = ctx.createBiquadFilter();
      carrierBP.type = "bandpass";
      carrierBP.frequency.value = freq;
      carrierBP.Q.value = q;

      const vca = ctx.createGain();
      vca.gain.value = 0; // opened by the mic envelope

      this.carrier.connect(carrierBP);
      carrierBP.connect(vca);
      vca.connect(this.sum);

      const modBP = ctx.createBiquadFilter();
      modBP.type = "bandpass";
      modBP.frequency.value = freq;
      modBP.Q.value = q;

      const shaper = ctx.createWaveShaper();
      shaper.curve = curve;
      shaper.oversample = "4x";

      // Two cascaded one-pole-ish lowpasses (Q ~0.5, no overshoot) smooth the
      // rectified band envelope so the VCA gain glides rather than chattering on
      // syllables. This is what makes the vocoder feel continuous and musical.
      const follower = ctx.createBiquadFilter();
      follower.type = "lowpass";
      follower.frequency.value = followerHz;
      follower.Q.value = 0.5;

      const follower2 = ctx.createBiquadFilter();
      follower2.type = "lowpass";
      follower2.frequency.value = followerHz;
      follower2.Q.value = 0.5;

      const envScale = ctx.createGain();
      envScale.gain.value = this.envDrive();

      this.modInput.connect(modBP);
      modBP.connect(shaper);
      shaper.connect(follower);
      follower.connect(follower2);
      follower2.connect(envScale);
      envScale.connect(vca.gain);

      this.bands.push({
        carrierBP,
        vca,
        modBP,
        shaper,
        follower,
        follower2,
        envScale,
      });
    }
  }

  private envDrive(): number {
    return this.sensitivity * this.strength;
  }

  private makeup(): number {
    // More bands split the carrier into thinner slivers, so boost to keep the
    // vocoded voice clearly present; the soft-clip catches peaks. Slightly
    // gentler than before so the smoother envelope does not pump.
    return 1.2 + 0.045 * this.bandCount * this.strength;
  }

  /** Attach the microphone MediaStream as the modulator. */
  setModulatorStream(stream: MediaStream): void {
    this.micSource = this.ctx.createMediaStreamSource(stream);
    this.micSource.connect(this.modInput);
  }

  /** Mic input gain (voice sensitivity). */
  setMicGain(v: number): void {
    const now = this.ctx.currentTime;
    this.modInput.gain.setTargetAtTime(Math.max(0, v), now, 0.03);
  }

  /** Vocoder intensity: scales the envelope drive and makeup gain (ramped). */
  setStrength(s: number): void {
    this.strength = Math.max(0.25, Math.min(3, s));
    const now = this.ctx.currentTime;
    const drive = this.envDrive();
    for (const b of this.bands) {
      b.envScale.gain.setTargetAtTime(drive, now, 0.05);
    }
    this.sum.gain.setTargetAtTime(this.makeup(), now, 0.05);
  }

  /**
   * Set the wet mix (0..1), crossfading the dry path via the provided setter.
   * Used by the manual slider and by the live hand-openness control.
   */
  setMix(amount: number, setDry: (v: number) => void): void {
    const a = Math.max(0, Math.min(1, amount));
    const now = this.ctx.currentTime;
    this.wet.gain.setTargetAtTime(a, now, 0.05);
    setDry(1 - a);
  }

  /**
   * Hand-driven live wet control. Pass the modifier hand's openness, or null
   * when that hand is missing this frame. Holds the last value through brief
   * tracking dropouts, keeps a minimum wet floor so the effect never fully cuts
   * out while enabled, and ramps with a longer time constant so hand flicker
   * does not stutter the sound. Click-free (setTargetAtTime).
   */
  updateHandWet(openness: number | null, setDry: (v: number) => void): void {
    const target = handWetTarget(
      openness,
      this.wetState,
      this.wetFloor,
      this.holdFrames
    );
    const now = this.ctx.currentTime;
    this.wet.gain.setTargetAtTime(target, now, this.handRampSec);
    setDry(1 - target);
  }

  /** Ramp the wet path up (to `amount`) and fade the dry path. */
  start(setDry: (v: number) => void, amount = 1): void {
    this.wetState = makeWetHoldState();
    this.setMix(amount, setDry);
  }

  /** Ramp the wet path down and restore the dry path. */
  stop(setDry: (v: number) => void): void {
    this.setMix(0, setDry);
  }

  /** Tear down the graph. Call after stop()'s fade. */
  dispose(): void {
    if (this.micSource) {
      try {
        this.micSource.disconnect();
      } catch {
        /* ignore */
      }
    }
    for (const b of this.bands) {
      // Disconnect ONLY this band's carrier tap, not the carrier's other
      // consumers (e.g. master -> dry -> destination).
      try {
        this.carrier.disconnect(b.carrierBP);
      } catch {
        /* ignore */
      }
      b.carrierBP.disconnect();
      b.vca.disconnect();
      b.modBP.disconnect();
      b.shaper.disconnect();
      b.follower.disconnect();
      b.follower2.disconnect();
      b.envScale.disconnect();
    }
    this.modInput.disconnect();
    this.sum.disconnect();
    this.clip.disconnect();
    this.wet.disconnect();
    this.bands = [];
  }
}
