// harmonizer.ts - an intelligent vocal harmonizer.
//
// It listens to the live microphone, estimates the fundamental frequency the
// user is singing (monophonic autocorrelation pitch detection), and for the
// chord the user is currently holding with a gesture it produces one
// pitch-shifted copy of the voice per chord tone, so the harmony lands on the
// chord's notes. Sing a C and hold a C-major chord -> you hear your voice at
// C, E and G.
//
// Signal graph (per Harmonizer):
//   micNode -> analyser                     (pitch detection tap, no output)
//   micNode -> dryGain -> outGain -> out    (your original voice, blended)
//   micNode -> shifter(ScriptProcessor) -> wetGain -> outGain -> out
//
// `out` is the Synth's instrument bus, so the harmonized voice is captured by
// the master recorder AND by the looper's "Instrument" / "Mix" takes, letting
// the user record the harmony and cycle-stack it.
//
// PITCH SHIFTER: a self-contained granular (overlap-add) shifter running in a
// single ScriptProcessorNode. Every output sample reads a shared input ring
// buffer through two grains a half-cycle out of phase, each windowed by
// sin^2 so the two windows sum to 1 (constant power) and the wrap-around
// discontinuity is always hidden under a near-zero window. Each voice keeps its
// own read phase and its own (smoothed) shift ratio, so the voices shift
// independently and re-lock continuously as the sung pitch and the held chord
// change.
//
// The pure math (pitch detection, shift ratio, nearest-octave target selection,
// voicing) is exported and unit tested; the real-time audio path needs the
// user's ears to judge.

// ---------------------------------------------------------------------------
// Pure DSP / music helpers (unit tested)
// ---------------------------------------------------------------------------

export interface PitchDetectOptions {
  /** Lowest fundamental to look for (Hz). */
  minHz?: number;
  /** Highest fundamental to look for (Hz). */
  maxHz?: number;
  /** RMS below this is treated as silence (returns null). */
  rmsThreshold?: number;
  /** Normalized autocorrelation peak below this is unvoiced (returns null). */
  clarityThreshold?: number;
}

/**
 * Estimate the fundamental frequency (Hz) of a block of time-domain samples by
 * autocorrelation, or null when the block is silent/unvoiced (no clear pitch).
 *
 * The unnormalized autocorrelation sum naturally peaks at the fundamental
 * period (more overlapping terms at shorter lags), so the global maximum over
 * the search range is the fundamental rather than an octave error. A parabolic
 * interpolation around the peak gives sub-sample (sub-Hz) accuracy. Pure and
 * unit tested against synthetic sines.
 */
export function detectPitchAutocorr(
  buf: Float32Array,
  sampleRate: number,
  opts: PitchDetectOptions = {}
): number | null {
  const minHz = opts.minHz ?? 80;
  const maxHz = opts.maxHz ?? 800;
  const rmsThreshold = opts.rmsThreshold ?? 0.01;
  const clarityThreshold = opts.clarityThreshold ?? 0.6;

  const n = buf.length;
  if (n < 4 || sampleRate <= 0) return null;

  let sumSq = 0;
  for (let i = 0; i < n; i++) sumSq += buf[i] * buf[i];
  const rms = Math.sqrt(sumSq / n);
  if (rms < rmsThreshold || sumSq <= 0) return null;

  const maxLag = Math.min(Math.floor(sampleRate / minHz), n - 1);
  const minLag = Math.max(2, Math.floor(sampleRate / maxHz));
  if (minLag >= maxLag) return null;

  let bestLag = -1;
  let best = -Infinity;
  let bestPrev = 0;
  let bestNext = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    const end = n - lag;
    for (let i = 0; i < end; i++) s += buf[i] * buf[i + lag];
    if (s > best) {
      best = s;
      bestLag = lag;
    }
  }
  if (bestLag < 0 || best <= 0) return null;

  // Normalized autocorrelation at the peak: ~1 for a clean periodic signal,
  // small for noise. Reject unvoiced input.
  const overlap = Math.max(1, n - bestLag);
  const norm = best / (sumSq * (overlap / n));
  if (!Number.isFinite(norm) || norm < clarityThreshold) return null;

  // Parabolic interpolation using the neighbours of the peak lag.
  const computeAt = (lag: number): number => {
    if (lag < minLag || lag > maxLag) return 0;
    let s = 0;
    const end = n - lag;
    for (let i = 0; i < end; i++) s += buf[i] * buf[i + lag];
    return s;
  };
  bestPrev = computeAt(bestLag - 1);
  bestNext = computeAt(bestLag + 1);
  let refinedLag = bestLag;
  const denom = bestPrev - 2 * best + bestNext;
  if (denom !== 0) {
    const delta = (0.5 * (bestPrev - bestNext)) / denom;
    if (Number.isFinite(delta) && Math.abs(delta) < 1) refinedLag = bestLag + delta;
  }
  if (refinedLag <= 0) return null;

  const freq = sampleRate / refinedLag;
  if (freq < minHz || freq > maxHz || !Number.isFinite(freq)) return null;
  return freq;
}

/**
 * The pitch-shift ratio that moves `detectedFreq` onto `targetFreq`
 * (ratio > 1 shifts up, < 1 shifts down). Returns 1 for invalid input.
 */
export function shiftRatio(targetFreq: number, detectedFreq: number): number {
  if (
    !Number.isFinite(targetFreq) ||
    !Number.isFinite(detectedFreq) ||
    detectedFreq <= 0 ||
    targetFreq <= 0
  ) {
    return 1;
  }
  return targetFreq / detectedFreq;
}

/**
 * Place a chord tone in the octave nearest a reference pitch. Shifts
 * `chordToneFreq` by whole octaves so it is as close as possible (in log-pitch)
 * to `referenceFreq`, which keeps the harmony voicing near the sung note and
 * keeps every shift ratio inside roughly [1/sqrt2, sqrt2] (a tritone), where a
 * granular shifter sounds cleanest.
 */
export function nearestOctaveFreq(
  chordToneFreq: number,
  referenceFreq: number
): number {
  if (chordToneFreq <= 0 || referenceFreq <= 0) return chordToneFreq;
  const k = Math.round(Math.log2(referenceFreq / chordToneFreq));
  return chordToneFreq * Math.pow(2, k);
}

export interface HarmonyVoice {
  /** Target frequency for this harmony voice (Hz). */
  targetFreq: number;
  /** Pitch-shift ratio to apply to the sung voice (targetFreq / sungFreq). */
  ratio: number;
}

/**
 * Build the harmony voices for a sung pitch over a held chord. Each chord tone
 * becomes one voice, placed in the octave nearest the sung pitch, with the
 * shift ratio that moves the sung pitch onto it. Near-duplicate targets (same
 * resulting pitch) are removed and the list is capped at `maxVoices`, keeping
 * the tones nearest the sung pitch first so the voicing stays tight. Returns []
 * when there is no clear sung pitch or no chord.
 */
export function computeHarmony(
  sungFreq: number | null,
  chordFreqs: number[],
  maxVoices = 4
): HarmonyVoice[] {
  if (!sungFreq || sungFreq <= 0 || !Number.isFinite(sungFreq)) return [];
  if (!chordFreqs || chordFreqs.length === 0) return [];

  const targets: number[] = [];
  for (const cf of chordFreqs) {
    if (!Number.isFinite(cf) || cf <= 0) continue;
    const t = nearestOctaveFreq(cf, sungFreq);
    // Deduplicate targets that land within ~10 cents of an existing one.
    const dup = targets.some(
      (x) => Math.abs(Math.log2(x / t)) < 0.008
    );
    if (!dup) targets.push(t);
  }

  // Keep the tones nearest the sung pitch first (tightest voicing), then cap.
  targets.sort(
    (a, b) =>
      Math.abs(Math.log2(a / sungFreq)) - Math.abs(Math.log2(b / sungFreq))
  );
  const capped = targets.slice(0, Math.max(0, Math.floor(maxVoices)));

  return capped.map((t) => ({ targetFreq: t, ratio: t / sungFreq }));
}

// ---------------------------------------------------------------------------
// Real-time harmonizer (Web Audio)
// ---------------------------------------------------------------------------

export interface HarmonizerOptions {
  /** Maximum simultaneous harmony voices (chord tones). Default 4. */
  maxVoices?: number;
  /** Dry/wet 0..1: 0 = only your voice, 1 = only harmonies. Default 0.7. */
  dryWet?: number;
  /** Output level 0..1 for the whole harmonizer. Default 0.9. */
  outputLevel?: number;
  /** Grain size (samples) for the granular shifter. Default 1024. */
  grainSize?: number;
  /** Pitch-detection tuning. */
  detect?: PitchDetectOptions;
}

interface ShiftVoice {
  ratioTarget: number;
  ratioCurrent: number;
  gainTarget: number;
  gainCurrent: number;
  phase: number;
}

/**
 * Live vocal harmonizer. Construct it with the AudioContext, the shared mic
 * node and the output bus, connect(), then call update(chordFreqs) once per
 * animation frame with the frequencies of the currently held chord.
 */
export class Harmonizer {
  private ctx: BaseAudioContext;
  private out: AudioNode;

  private micNode: AudioNode | null = null;
  private analyser: AnalyserNode;
  private analyserBuf: Float32Array<ArrayBuffer>;

  private proc: ScriptProcessorNode;
  private dryGain: GainNode;
  private wetGain: GainNode;
  private outGain: GainNode;

  private ring: Float32Array;
  private ringMask: number;
  private writePos = 0;
  private grainSize: number;

  private voices: ShiftVoice[] = [];
  private maxVoices: number;
  private dryWet: number;
  private outputLevel: number;
  private enabled = false;
  private detectOpts: PitchDetectOptions;

  private lastPitch: number | null = null;
  private lastTargets: number[] = [];
  // Short pitch hold so brief unvoiced dips (consonants, vibrato troughs) do not
  // drop the whole harmony out and back in, which sounds choppy. Holds the last
  // clear pitch for a few update frames before fading.
  private heldPitch: number | null = null;
  private holdFrames = 0;
  private static readonly HOLD_FRAMES = 10;

  constructor(
    ctx: BaseAudioContext,
    out: AudioNode,
    opts: HarmonizerOptions = {}
  ) {
    this.ctx = ctx;
    this.out = out;
    this.maxVoices = Math.max(1, Math.min(6, Math.floor(opts.maxVoices ?? 4)));
    // Default fully wet: the raw voice is captured into the recording elsewhere
    // (Synth micHub -> recorderDest), so the harmonizer only needs to add the
    // harmony voices on top rather than doubling the dry voice.
    this.dryWet = Math.max(0, Math.min(1, opts.dryWet ?? 1.0));
    this.outputLevel = Math.max(0, Math.min(1, opts.outputLevel ?? 1.0));
    this.grainSize = Math.max(256, Math.floor(opts.grainSize ?? 1280));
    // A more permissive gate than the pure-function defaults so a real, slightly
    // breathy voice through the shifter is not rejected frame to frame (which
    // reads as choppy). Callers can still override.
    this.detectOpts =
      opts.detect ?? { clarityThreshold: 0.5, rmsThreshold: 0.008 };

    // Pitch-detection analyser (observes the mic only, no onward output).
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;
    this.analyserBuf = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));

    // Ring buffer sized to comfortably exceed one grain plus a processing block.
    let size = 1;
    while (size < this.grainSize * 4) size <<= 1;
    this.ring = new Float32Array(size);
    this.ringMask = size - 1;

    // The granular shifter. Mono in, mono out. Runs on the main thread; a
    // 1024-frame buffer keeps latency low while giving the callback enough work
    // headroom for a few voices.
    this.proc = ctx.createScriptProcessor(1024, 1, 1);
    this.proc.onaudioprocess = (e) => this.process(e);

    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();
    this.outGain = ctx.createGain();
    this.dryGain.gain.value = 1 - this.dryWet;
    this.wetGain.gain.value = this.dryWet;
    this.outGain.gain.value = 0; // ramped up on start() to stay click-free

    this.proc.connect(this.wetGain);
    this.wetGain.connect(this.outGain);
    this.dryGain.connect(this.outGain);
    this.outGain.connect(this.out);

    for (let i = 0; i < this.maxVoices; i++) {
      this.voices.push({
        ratioTarget: 1,
        ratioCurrent: 1,
        gainTarget: 0,
        gainCurrent: 0,
        phase: 0,
      });
    }
  }

  /**
   * Attach the shared mic hub as the input to the pitch detector, the granular
   * shifter and the dry path. Reads the shared source node (never makes its own)
   * so the looper and level meter keep receiving the voice too.
   */
  connect(micNode: AudioNode): void {
    if (this.micNode === micNode) return;
    if (this.micNode) {
      for (const dst of [this.analyser, this.proc, this.dryGain]) {
        try {
          this.micNode.disconnect(dst);
        } catch {
          /* ignore */
        }
      }
    }
    this.micNode = micNode;
    micNode.connect(this.analyser);
    micNode.connect(this.proc);
    micNode.connect(this.dryGain);
  }

  /** Ramp the output up. Call after connect() with a mic attached. */
  start(): void {
    this.enabled = true;
    const now = this.ctx.currentTime;
    this.outGain.gain.setTargetAtTime(this.outputLevel, now, 0.03);
  }

  /** Ramp the output down (harmonies fade out; dispose after the fade). */
  stop(): void {
    this.enabled = false;
    for (const v of this.voices) v.gainTarget = 0;
    const now = this.ctx.currentTime;
    this.outGain.gain.setTargetAtTime(0, now, 0.05);
  }

  setOutputLevel(v: number): void {
    this.outputLevel = Math.max(0, Math.min(1, v));
    if (this.enabled) {
      const now = this.ctx.currentTime;
      this.outGain.gain.setTargetAtTime(this.outputLevel, now, 0.03);
    }
  }

  /** Dry/wet 0..1: 0 = only your voice, 1 = only harmonies. */
  setDryWet(v: number): void {
    this.dryWet = Math.max(0, Math.min(1, v));
    const now = this.ctx.currentTime;
    this.dryGain.gain.setTargetAtTime(1 - this.dryWet, now, 0.03);
    this.wetGain.gain.setTargetAtTime(this.dryWet, now, 0.03);
  }

  setMaxVoices(n: number): void {
    this.maxVoices = Math.max(1, Math.min(this.voices.length, Math.floor(n)));
  }

  /** The most recent detected sung pitch (Hz), or null. For UI display. */
  getDetectedPitch(): number | null {
    return this.lastPitch;
  }

  /** The most recent harmony target frequencies (Hz). For UI display. */
  getTargets(): number[] {
    return this.lastTargets;
  }

  /**
   * Per-frame update: detect the sung pitch and re-point the harmony voices at
   * the held chord's tones. Pass the frequencies of the currently held chord
   * (empty when resting), so the harmony re-locks as pitch and chord change.
   */
  update(chordFreqs: number[]): void {
    if (!this.enabled || !this.micNode) {
      this.lastPitch = null;
      this.lastTargets = [];
      return;
    }
    this.analyser.getFloatTimeDomainData(this.analyserBuf);
    const sr = this.ctx.sampleRate;
    const detected = detectPitchAutocorr(this.analyserBuf, sr, this.detectOpts);

    // Hold the last clear pitch briefly through unvoiced dips to avoid choppy
    // drop-outs; only truly fade once the hold window expires.
    let pitch = detected;
    if (detected !== null) {
      this.heldPitch = detected;
      this.holdFrames = Harmonizer.HOLD_FRAMES;
    } else if (this.holdFrames > 0) {
      pitch = this.heldPitch;
      this.holdFrames--;
    }
    this.lastPitch = pitch;

    if (pitch === null || !chordFreqs || chordFreqs.length === 0) {
      // No clear pitch or no chord: fade the harmonies out to avoid artifacts.
      this.lastTargets = [];
      for (const v of this.voices) v.gainTarget = 0;
      return;
    }

    const harmony = computeHarmony(pitch, chordFreqs, this.maxVoices);
    this.lastTargets = harmony.map((h) => h.targetFreq);
    const active = harmony.length;
    // Per-voice gain with makeup so the harmonies sit at a similar level to the
    // voice/synths instead of a third of it. Equal-power scaling keeps the sum
    // from clipping as more tones are added; the 1.5 makeup lifts the whole
    // stack (a single voice reaches full gain).
    const perVoice = active > 0 ? Math.min(1, 1.5 / Math.sqrt(active)) : 0;
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      if (i < active) {
        v.ratioTarget = harmony[i].ratio;
        v.gainTarget = perVoice;
      } else {
        v.gainTarget = 0;
      }
    }
  }

  private readInterp(fpos: number): number {
    const size = this.ring.length;
    let idx = fpos % size;
    if (idx < 0) idx += size;
    const i0 = Math.floor(idx);
    const frac = idx - i0;
    const a = this.ring[i0 & this.ringMask];
    const b = this.ring[(i0 + 1) & this.ringMask];
    return a + (b - a) * frac;
  }

  private process(e: AudioProcessingEvent): void {
    const input = e.inputBuffer.getChannelData(0);
    const output = e.outputBuffer.getChannelData(0);
    const len = output.length;
    const grain = this.grainSize;
    // Per-sample one-pole smoothing coefficients (~10 ms glide at 44.1 kHz).
    const smooth = 0.002;
    const ring = this.ring;
    const mask = this.ringMask;

    for (let i = 0; i < len; i++) {
      const x = input[i];
      ring[this.writePos] = x;
      let sum = 0;
      for (let vi = 0; vi < this.voices.length; vi++) {
        const v = this.voices[vi];
        v.ratioCurrent += (v.ratioTarget - v.ratioCurrent) * smooth;
        v.gainCurrent += (v.gainTarget - v.gainCurrent) * smooth;
        if (v.gainCurrent < 0.0002) continue;
        // Advance the grain read phase. Downward shifts (ratio<1) grow the read
        // delay over time; upward shifts shrink it. Two grains a half-cycle
        // apart cross-fade so the wrap is always hidden under a ~0 window.
        v.phase += (1 - v.ratioCurrent) / grain;
        v.phase -= Math.floor(v.phase);
        const p1 = v.phase;
        const p2 = p1 < 0.5 ? p1 + 0.5 : p1 - 0.5;
        const d1 = p1 * grain;
        const d2 = p2 * grain;
        const s1 = Math.sin(Math.PI * p1);
        const s2 = Math.sin(Math.PI * p2);
        const env1 = s1 * s1;
        const env2 = s2 * s2;
        const r1 = this.readInterp(this.writePos - d1);
        const r2 = this.readInterp(this.writePos - d2);
        sum += (r1 * env1 + r2 * env2) * v.gainCurrent;
      }
      output[i] = sum;
      this.writePos = (this.writePos + 1) & mask;
    }
  }

  /** Tear down. Detaches from the shared mic hub (leaving it live for others). */
  dispose(): void {
    if (this.micNode) {
      for (const dst of [this.analyser, this.proc, this.dryGain]) {
        try {
          this.micNode.disconnect(dst);
        } catch {
          /* ignore */
        }
      }
      this.micNode = null;
    }
    this.proc.onaudioprocess = null;
    try {
      this.proc.disconnect();
    } catch {
      /* ignore */
    }
    try {
      this.analyser.disconnect();
    } catch {
      /* ignore */
    }
    this.dryGain.disconnect();
    this.wetGain.disconnect();
    this.outGain.disconnect();
    this.voices = [];
  }
}
