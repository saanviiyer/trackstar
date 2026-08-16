// synth.ts - polyphonic Web Audio synth with a sound-design system.
//
// Per-note signal path:
//   oscillators (unison + optional sub) -> per-note filter (env) ->
//   per-note ADSR gain -> shared low-pass filter (hand-Y cutoff + resonance)
//
// Master chain (shared):
//   shared filter -> distortion -> chorus -> delay -> reverb -> tremolo ->
//   master gain -> dry gain -> destination
//
// The vocoder taps `master` as its carrier and crossfades against `dry`, so it
// still works after this chain (effects are pre-master). The hand-Y cutoff and
// resonance live on the shared filter, unchanged in placement.
//
// One voice per chord tone. Chord changes retrigger; a rest releases all
// voices. All gain changes are ramped to avoid clicks. The AudioContext must be
// created/resumed from a user gesture (see ensureStarted()).

import {
  unisonDetunes,
  type EffectsConfig,
  type LfoConfig,
  type SoundConfig,
  type Waveform,
} from "./presets";

export type { Waveform };

export interface Envelope {
  attack: number;
  decay: number;
  sustain: number; // 0..1 level
  release: number;
}

const DEFAULT_ENV: Envelope = {
  attack: 0.02,
  decay: 0.12,
  sustain: 0.7,
  release: 0.25,
};

interface Voice {
  oscs: OscillatorNode[];
  gain: GainNode;
  freq: number;
}

interface FxStage {
  input: GainNode;
  output: GainNode;
  dry: GainNode;
  wet: GainNode;
}

function nearlyEqualFreqs(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > 0.5) return false;
  }
  return true;
}

/** A soft-clip distortion curve. `amount` 0..1 sets drive. */
function makeDistortionCurve(amount: number): Float32Array<ArrayBuffer> {
  const k = amount * 100;
  const n = 1024;
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  const deg = Math.PI / 180;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

/** A decaying-noise impulse response for the reverb convolver. */
function makeImpulse(
  ctx: BaseAudioContext,
  seconds = 2.5,
  decay = 2.5
): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * seconds));
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

export class Synth {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private dry: GainNode | null = null;
  // instrumentBus carries the *played* signal (synth + effects + vocoder +
  // drums) but NOT the loop-playback tracks, so the looper can tap it to record
  // an "Instrument" loop without feeding loops back into themselves.
  // recordBus = instrumentBus + loop tracks; the master recorder taps recordBus.
  private instrumentBus: GainNode | null = null;
  private recordBus: GainNode | null = null;
  private drumBus: GainNode | null = null;
  private recorderDest: MediaStreamAudioDestinationNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private voices: Voice[] = [];

  // Effects chain
  private fxInput: GainNode | null = null; // filter connects here
  private distortion: FxStage | null = null;
  private distShaper: WaveShaperNode | null = null;
  private chorus: FxStage | null = null;
  private chorusDelay: DelayNode | null = null;
  private delay: FxStage | null = null;
  private delayNode: DelayNode | null = null;
  private delayFeedback: GainNode | null = null;
  private reverb: FxStage | null = null;
  private tremolo: GainNode | null = null;

  // LFO
  private lfo: OscillatorNode | null = null;
  private lfoToPitch: GainNode | null = null;
  private lfoToFilter: GainNode | null = null;
  private lfoToAmp: GainNode | null = null;
  private chorusLfo: OscillatorNode | null = null;

  // Sound-design state
  waveform: Waveform = "sawtooth";
  env: Envelope = { ...DEFAULT_ENV };
  private unison = 2;
  private detune = 6;
  private subLevel = 0;
  private filterEnvAmount = 0;

  private masterVolume = 0.5;
  private expression = 1;

  private currentFreqs: number[] = [];

  get isStarted(): boolean {
    return this.ctx !== null;
  }

  get contextState(): AudioContextState | "closed" {
    return this.ctx ? this.ctx.state : "closed";
  }

  getContext(): AudioContext | null {
    return this.ctx;
  }

  /** Carrier node for the vocoder (master, post-effects, pre-destination). */
  getCarrierNode(): GainNode | null {
    return this.master;
  }

  private makeStage(): FxStage {
    const ctx = this.ctx!;
    const input = ctx.createGain();
    const output = ctx.createGain();
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    dry.gain.value = 1;
    wet.gain.value = 0;
    input.connect(dry);
    dry.connect(output);
    wet.connect(output);
    return { input, output, dry, wet };
  }

  /** Create/resume the AudioContext. Must be called from a user gesture. */
  async ensureStarted(): Promise<void> {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      this.ctx = new Ctor();
      const ctx = this.ctx;

      this.filter = ctx.createBiquadFilter();
      this.filter.type = "lowpass";
      this.filter.frequency.value = 4000;
      this.filter.Q.value = 0.9;

      this.master = ctx.createGain();
      this.master.gain.value = this.masterVolume;

      this.dry = ctx.createGain();
      this.dry.gain.value = 1;

      // --- Effects chain ---
      // Distortion (insert)
      this.distortion = this.makeStage();
      this.distShaper = ctx.createWaveShaper();
      this.distShaper.curve = makeDistortionCurve(0.2);
      this.distShaper.oversample = "2x";
      this.distortion.input.connect(this.distShaper);
      this.distShaper.connect(this.distortion.wet);

      // Chorus (modulated short delay, send-style)
      this.chorus = this.makeStage();
      this.chorusDelay = ctx.createDelay(0.05);
      this.chorusDelay.delayTime.value = 0.025;
      this.chorusLfo = ctx.createOscillator();
      this.chorusLfo.type = "sine";
      this.chorusLfo.frequency.value = 0.6;
      const chorusDepth = ctx.createGain();
      chorusDepth.gain.value = 0.002;
      this.chorusLfo.connect(chorusDepth);
      chorusDepth.connect(this.chorusDelay.delayTime);
      this.chorusLfo.start();
      this.chorus.input.connect(this.chorusDelay);
      this.chorusDelay.connect(this.chorus.wet);

      // Delay / echo (feedback, send-style)
      this.delay = this.makeStage();
      this.delayNode = ctx.createDelay(2.0);
      this.delayNode.delayTime.value = 0.3;
      this.delayFeedback = ctx.createGain();
      this.delayFeedback.gain.value = 0.35;
      this.delay.input.connect(this.delayNode);
      this.delayNode.connect(this.delayFeedback);
      this.delayFeedback.connect(this.delayNode);
      this.delayNode.connect(this.delay.wet);

      // Reverb (convolution, send-style)
      this.reverb = this.makeStage();
      const convolver = ctx.createConvolver();
      convolver.buffer = makeImpulse(ctx, 2.5, 2.5);
      this.reverb.input.connect(convolver);
      convolver.connect(this.reverb.wet);

      // Tremolo (amp LFO destination)
      this.tremolo = ctx.createGain();
      this.tremolo.gain.value = 1;

      // --- LFO ---
      this.lfo = ctx.createOscillator();
      this.lfo.type = "sine";
      this.lfo.frequency.value = 5;
      this.lfoToPitch = ctx.createGain();
      this.lfoToFilter = ctx.createGain();
      this.lfoToAmp = ctx.createGain();
      this.lfoToPitch.gain.value = 0;
      this.lfoToFilter.gain.value = 0;
      this.lfoToAmp.gain.value = 0;
      this.lfo.connect(this.lfoToPitch);
      this.lfo.connect(this.lfoToFilter);
      this.lfo.connect(this.lfoToAmp);
      this.lfoToFilter.connect(this.filter.frequency);
      this.lfoToAmp.connect(this.tremolo.gain);
      this.lfo.start();

      // --- Wire the chain ---
      this.fxInput = this.distortion.input;
      this.filter.connect(this.fxInput);
      this.distortion.output.connect(this.chorus.input);
      this.chorus.output.connect(this.delay.input);
      this.delay.output.connect(this.reverb.input);
      this.reverb.output.connect(this.tremolo);
      this.tremolo.connect(this.master);

      // instrumentBus = master (synth+effects) + drums + vocoder wet. recordBus
      // = instrumentBus + loop tracks -> destination. The master recorder taps
      // recordBus; the looper taps instrumentBus for "Instrument" loops (so a
      // loop never records itself -> no feedback).
      this.instrumentBus = ctx.createGain();
      this.recordBus = ctx.createGain();
      this.master.connect(this.dry);
      this.dry.connect(this.instrumentBus);
      this.instrumentBus.connect(this.recordBus);
      this.recordBus.connect(ctx.destination);

      this.drumBus = ctx.createGain();
      this.drumBus.gain.value = 0.9;
      this.drumBus.connect(this.instrumentBus);
    }
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
  }

  /** Apply a full sound configuration (used on preset change). */
  applyConfig(cfg: SoundConfig): void {
    this.setWaveform(cfg.waveform);
    this.unison = Math.max(1, Math.min(7, Math.round(cfg.unison)));
    this.detune = cfg.detune;
    this.subLevel = Math.max(0, Math.min(1, cfg.subLevel));
    this.setEnvelope(cfg.env);
    this.setResonance(cfg.resonance);
    this.filterEnvAmount = Math.max(0, Math.min(1, cfg.filterEnvAmount));
    this.setLfo(cfg.lfo);
    this.setEffects(cfg.fx);
  }

  setEnvelope(env: Envelope): void {
    this.env = { ...env };
  }
  setUnison(n: number): void {
    this.unison = Math.max(1, Math.min(7, Math.round(n)));
  }
  setDetune(cents: number): void {
    this.detune = cents;
  }
  setSubLevel(v: number): void {
    this.subLevel = Math.max(0, Math.min(1, v));
  }
  setFilterEnvAmount(v: number): void {
    this.filterEnvAmount = Math.max(0, Math.min(1, v));
  }

  setResonance(q: number): void {
    if (!this.ctx || !this.filter) return;
    const now = this.ctx.currentTime;
    this.filter.Q.setTargetAtTime(Math.max(0.0001, q), now, 0.02);
  }

  setLfo(cfg: LfoConfig): void {
    if (!this.ctx || !this.lfo || !this.lfoToPitch || !this.lfoToFilter || !this.lfoToAmp)
      return;
    const now = this.ctx.currentTime;
    this.lfo.frequency.setTargetAtTime(Math.max(0.01, cfg.rate), now, 0.02);
    const d = Math.max(0, Math.min(1, cfg.depth));
    const pitch = cfg.target === "pitch" ? d * 100 : 0; // cents
    const filt = cfg.target === "filter" ? d * 2500 : 0; // Hz
    const amp = cfg.target === "amp" ? d * 0.5 : 0; // gain
    this.lfoToPitch.gain.setTargetAtTime(pitch, now, 0.03);
    this.lfoToFilter.gain.setTargetAtTime(filt, now, 0.03);
    this.lfoToAmp.gain.setTargetAtTime(amp, now, 0.03);
  }

  setEffects(fx: EffectsConfig): void {
    this.setReverb(fx.reverb.on, fx.reverb.amount);
    this.setDelay(fx.delay.on, fx.delay.time, fx.delay.feedback, fx.delay.mix);
    this.setDistortion(fx.distortion.on, fx.distortion.amount);
    this.setChorus(fx.chorus.on, fx.chorus.amount);
  }

  setReverb(on: boolean, amount: number): void {
    if (!this.ctx || !this.reverb) return;
    const now = this.ctx.currentTime;
    this.reverb.wet.gain.setTargetAtTime(on ? amount : 0, now, 0.05);
  }

  setDelay(on: boolean, time: number, feedback: number, mix: number): void {
    if (!this.ctx || !this.delay || !this.delayNode || !this.delayFeedback)
      return;
    const now = this.ctx.currentTime;
    this.delayNode.delayTime.setTargetAtTime(
      Math.max(0.001, Math.min(2, time)),
      now,
      0.05
    );
    this.delayFeedback.gain.setTargetAtTime(
      Math.max(0, Math.min(0.95, feedback)),
      now,
      0.05
    );
    this.delay.wet.gain.setTargetAtTime(on ? mix : 0, now, 0.05);
  }

  setDistortion(on: boolean, amount: number): void {
    if (!this.ctx || !this.distortion || !this.distShaper) return;
    const now = this.ctx.currentTime;
    const amt = Math.max(0, Math.min(1, amount));
    this.distShaper.curve = makeDistortionCurve(amt);
    // Insert-style crossfade so drive replaces some of the clean signal.
    this.distortion.wet.gain.setTargetAtTime(on ? amt : 0, now, 0.05);
    this.distortion.dry.gain.setTargetAtTime(on ? 1 - amt * 0.6 : 1, now, 0.05);
  }

  setChorus(on: boolean, amount: number): void {
    if (!this.ctx || !this.chorus) return;
    const now = this.ctx.currentTime;
    this.chorus.wet.gain.setTargetAtTime(on ? amount : 0, now, 0.05);
  }

  /** Crossfade the direct (dry) output (used by the vocoder). */
  setDryGain(v: number, timeConstant = 0.04): void {
    if (!this.ctx || !this.dry) return;
    const now = this.ctx.currentTime;
    this.dry.gain.cancelScheduledValues(now);
    this.dry.gain.setTargetAtTime(
      Math.max(0, Math.min(1, v)),
      now,
      timeConstant
    );
  }

  setWaveform(w: Waveform): void {
    this.waveform = w;
    for (const v of this.voices) {
      for (const o of v.oscs) {
        // Leave the sub oscillator (last, sine) alone.
        if (o.type !== "sine" || w === "sine") o.type = w;
      }
    }
  }

  setMasterVolume(v: number): void {
    this.masterVolume = Math.max(0, Math.min(1, v));
    this.applyMasterGain();
  }

  setExpression(e: number): void {
    this.expression = Math.max(0, Math.min(1, e));
    this.applyMasterGain();
  }

  private applyMasterGain(): void {
    if (!this.ctx || !this.master) return;
    const target = this.masterVolume * this.expression;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(target, now, 0.03);
  }

  /** Ramp the shared low-pass cutoff (Hz) - hand-Y control. */
  setCutoff(hz: number): void {
    if (!this.ctx || !this.filter) return;
    const now = this.ctx.currentTime;
    const clamped = Math.max(60, Math.min(18000, hz));
    this.filter.frequency.cancelScheduledValues(now);
    this.filter.frequency.setTargetAtTime(clamped, now, 0.05);
  }

  /**
   * Build unison + sub oscillators for one note into `dest`, applying the pitch
   * LFO. Returns the created oscillators (already started at t0).
   */
  private buildOscillators(
    freq: number,
    dest: AudioNode,
    t0: number
  ): OscillatorNode[] {
    const ctx = this.ctx!;
    const oscs: OscillatorNode[] = [];
    const detunes = unisonDetunes(this.unison, this.detune);
    for (const d of detunes) {
      const osc = ctx.createOscillator();
      osc.type = this.waveform;
      osc.frequency.setValueAtTime(freq, t0);
      osc.detune.setValueAtTime(d, t0);
      osc.connect(dest);
      if (this.lfoToPitch) this.lfoToPitch.connect(osc.detune);
      osc.start(t0);
      oscs.push(osc);
    }
    if (this.subLevel > 0) {
      const sub = ctx.createOscillator();
      sub.type = "sine";
      sub.frequency.setValueAtTime(freq / 2, t0);
      const subGain = ctx.createGain();
      subGain.gain.value = this.subLevel;
      sub.connect(subGain);
      subGain.connect(dest);
      if (this.lfoToPitch) this.lfoToPitch.connect(sub.detune);
      sub.start(t0);
      oscs.push(sub);
    }
    return oscs;
  }

  /** A per-note lowpass that opens with the filter envelope (or is transparent). */
  private makeNoteFilter(t0: number): BiquadFilterNode {
    const ctx = this.ctx!;
    const vf = ctx.createBiquadFilter();
    vf.type = "lowpass";
    vf.Q.value = 1;
    const amt = this.filterEnvAmount;
    if (amt <= 0) {
      vf.frequency.setValueAtTime(18000, t0); // transparent
    } else {
      const base = 500;
      const peak = base + amt * 6500;
      const { attack, decay } = this.env;
      vf.frequency.setValueAtTime(base, t0);
      vf.frequency.linearRampToValueAtTime(peak, t0 + Math.max(0.001, attack));
      vf.frequency.exponentialRampToValueAtTime(
        Math.max(100, base),
        t0 + Math.max(0.001, attack) + Math.max(0.02, decay)
      );
    }
    return vf;
  }

  private oscCount(): number {
    return this.unison + (this.subLevel > 0 ? 1 : 0);
  }

  playFreqs(freqs: number[]): void {
    if (!this.ctx || !this.filter) return;
    if (freqs.length === 0) {
      this.releaseAll();
      return;
    }
    if (nearlyEqualFreqs(freqs, this.currentFreqs)) return;

    this.releaseAll();
    this.currentFreqs = [...freqs];

    const now = this.ctx.currentTime;
    const { attack, decay, sustain } = this.env;
    const peak =
      (0.9 / Math.max(1, freqs.length)) / Math.sqrt(this.oscCount());

    for (const f of freqs) {
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(peak, now + Math.max(0.001, attack));
      gain.gain.exponentialRampToValueAtTime(
        Math.max(0.0001, peak * sustain),
        now + Math.max(0.001, attack) + Math.max(0.001, decay)
      );

      const vf = this.makeNoteFilter(now);
      vf.connect(gain);
      gain.connect(this.filter);

      const oscs = this.buildOscillators(f, vf, now);
      this.voices.push({ oscs, gain, freq: f });
    }
  }

  /**
   * Fire a single note at an absolute time, held for `gate` seconds (used by
   * the arpeggiator). Fire-and-forget: oscillators stop themselves.
   */
  triggerNote(freq: number, atTime: number, gate: number): void {
    if (!this.ctx || !this.filter) return;
    const t0 = Math.max(atTime, this.ctx.currentTime);
    const { attack, decay, sustain, release } = this.env;
    const peak = 0.6 / Math.sqrt(this.oscCount());
    const gain = this.ctx.createGain();
    const atk = Math.max(0.001, Math.min(attack, gate * 0.5));
    const dec = Math.max(0.001, Math.min(decay, gate * 0.5));
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + atk);
    gain.gain.exponentialRampToValueAtTime(
      Math.max(0.0001, peak * sustain),
      t0 + atk + dec
    );
    const relStart = t0 + gate;
    gain.gain.setValueAtTime(Math.max(0.0001, peak * sustain), relStart);
    gain.gain.exponentialRampToValueAtTime(0.0001, relStart + release);

    const vf = this.makeNoteFilter(t0);
    vf.connect(gain);
    gain.connect(this.filter);

    const oscs = this.buildOscillators(freq, vf, t0);
    for (const osc of oscs) osc.stop(relStart + release + 0.02);
  }

  /** Release all active voices with an envelope release tail. */
  releaseAll(): void {
    if (!this.ctx) {
      this.voices = [];
      this.currentFreqs = [];
      return;
    }
    const now = this.ctx.currentTime;
    const rel = this.env.release;
    for (const v of this.voices) {
      v.gain.gain.cancelScheduledValues(now);
      const current = Math.max(0.0001, v.gain.gain.value);
      v.gain.gain.setValueAtTime(current, now);
      v.gain.gain.exponentialRampToValueAtTime(0.0001, now + Math.max(0.01, rel));
      for (const o of v.oscs) {
        o.stop(now + Math.max(0.01, rel) + 0.02);
      }
    }
    this.voices = [];
    this.currentFreqs = [];
  }

  /**
   * The master mix bus (instrument mix + loop tracks). Loop-playback tracks
   * connect here so the master recorder captures them.
   */
  getOutputBus(): GainNode | null {
    return this.recordBus;
  }

  /**
   * The instrument bus: the played signal (synth + effects + vocoder + drums)
   * WITHOUT the loop tracks. The vocoder connects its wet path here, and the
   * looper taps it to record an "Instrument" loop with no feedback path.
   */
  getInstrumentBus(): GainNode | null {
    return this.instrumentBus;
  }

  /**
   * A MediaStream of the full output for recording. Created lazily and kept
   * connected; capturing it does not affect normal playback.
   */
  getRecordingStream(): MediaStream | null {
    if (!this.ctx || !this.recordBus) return null;
    if (!this.recorderDest) {
      this.recorderDest = this.ctx.createMediaStreamDestination();
      this.recordBus.connect(this.recorderDest);
    }
    return this.recorderDest.stream;
  }

  private noise(): AudioBuffer {
    const ctx = this.ctx!;
    if (!this.noiseBuf) {
      const len = Math.floor(ctx.sampleRate * 1.0);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
    }
    return this.noiseBuf;
  }

  // --- Synthesized drum voices (route to the drum bus, dry, so they are
  // recorded but not colored by the synth filter/effects). ---

  triggerKick(t0: number): void {
    if (!this.ctx || !this.drumBus) return;
    const ctx = this.ctx;
    const t = Math.max(t0, ctx.currentTime);
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(130, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.9, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    osc.connect(g);
    g.connect(this.drumBus);
    osc.start(t);
    osc.stop(t + 0.36);
  }

  triggerSnare(t0: number): void {
    if (!this.ctx || !this.drumBus) return;
    const ctx = this.ctx;
    const t = Math.max(t0, ctx.currentTime);
    // Noise body.
    const src = ctx.createBufferSource();
    src.buffer = this.noise();
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 1200;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.7, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    src.connect(hp);
    hp.connect(ng);
    ng.connect(this.drumBus);
    src.start(t);
    src.stop(t + 0.22);
    // Tonal snap.
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(180, t);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.4, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    osc.connect(og);
    og.connect(this.drumBus);
    osc.start(t);
    osc.stop(t + 0.12);
  }

  triggerHat(t0: number): void {
    if (!this.ctx || !this.drumBus) return;
    const ctx = this.ctx;
    const t = Math.max(t0, ctx.currentTime);
    const src = ctx.createBufferSource();
    src.buffer = this.noise();
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    src.connect(hp);
    hp.connect(g);
    g.connect(this.drumBus);
    src.start(t);
    src.stop(t + 0.06);
  }

  triggerClick(t0: number, accent: boolean): void {
    if (!this.ctx || !this.drumBus) return;
    const ctx = this.ctx;
    const t = Math.max(t0, ctx.currentTime);
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(accent ? 1600 : 1000, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(accent ? 0.4 : 0.25, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    osc.connect(g);
    g.connect(this.drumBus);
    osc.start(t);
    osc.stop(t + 0.04);
  }

  /** Fully tear down the audio graph. */
  async close(): Promise<void> {
    this.releaseAll();
    if (this.ctx) {
      await this.ctx.close();
      this.ctx = null;
      this.master = null;
      this.filter = null;
      this.dry = null;
      this.instrumentBus = null;
      this.recordBus = null;
      this.drumBus = null;
      this.recorderDest = null;
      this.noiseBuf = null;
    }
  }
}
