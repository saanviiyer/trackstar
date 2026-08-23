// producerMixer.ts - the multitrack mixer that powers Trackstar's Producer mode.
//
// It unifies two kinds of tracks in ONE shared AudioContext (the handsynth
// Synth's context):
//   - "loop" tracks:  live handsynth performance captured from the instrument
//                     bus (or the mic), phase-locked to the transport, like the
//                     handsynth looper.
//   - "stem" tracks:  AudioBuffers decoded from deejai's rendered WAV stems
//                     (the AI beat / pad / bass / arp), dropped straight in.
//
// Every track has volume, pan, mute and solo. Play-all starts every track from
// one shared anchor so they line up; Export bounces the whole mix (stereo, so
// pan is preserved) via an OfflineAudioContext.
//
// The mute/solo gain math is reused from the handsynth looper (effectiveGain),
// and the transport-length / boundary / duration helpers are reused too, so
// this file only adds pan, stem tracks, stereo export, and the graph wiring.
// The genuinely new pure logic (stereo WAV encoding, export span) is exported
// and unit tested.

import {
  BEATS_PER_BAR,
  effectiveGain,
  exportDurationSeconds,
  loopLengthSamples,
  loopLengthSeconds,
  nextLoopBoundary,
  normalizeGain,
  peakAmplitude,
  encodeWavBytes,
  sourcesForSelection,
  type RecordSource,
  type TrackMix,
} from "./vocalLooper";
import {
  computePeaks,
  countInSec,
  cycleIndex,
  loopPositionSec,
  secondsPerBeat,
  wrapBufferOffset,
} from "./transport";

export type TrackKind = "loop" | "stem";

export interface MixerTrackState {
  id: number;
  name: string;
  kind: TrackKind;
  role: string;
  source: RecordSource | "ai";
  muted: boolean;
  solo: boolean;
  volume: number;
  pan: number; // -1 (L) .. 1 (R)
  durationSec: number;
  /** Armed for record (punch-in target). */
  armed: boolean;
  /** Clip start offset within the loop cycle (seconds), for timeline move. */
  offsetSec: number;
}

/** Live transport snapshot for the UI (playhead, count-in, bar/beat). */
export interface TransportInfo {
  playing: boolean;
  recording: boolean;
  countingIn: boolean;
  /** Seconds of count-in still remaining (0 when not counting in). */
  countInRemaining: number;
  /** Position within the current loop cycle (seconds). */
  positionSec: number;
  loopDurationSec: number;
  /** Index of the cycle currently being recorded (for take labels). */
  cycle: number;
}

export interface MixerConfig {
  bpm: number;
  bars: number;
  free: boolean;
  beatsPerBar?: number;
}

export interface SerializedMixerTrack {
  name: string;
  kind: TrackKind;
  role: string;
  source: RecordSource | "ai";
  muted: boolean;
  solo: boolean;
  volume: number;
  pan: number;
  sampleRate: number;
  channels: ArrayBuffer[];
  normGain?: number;
  offsetSec?: number;
}

export interface MixerProjectSnapshot {
  version: 1;
  loopDurationSec: number;
  tracks: SerializedMixerTrack[];
}

// ---------------------------------------------------------------------------
// Pure helpers (unit tested)
// ---------------------------------------------------------------------------

/** Clamp a pan value to the mixer range. */
export function clampPan(pan: number): number {
  if (Number.isNaN(pan)) return 0;
  return Math.max(-1, Math.min(1, pan));
}

export function sanitizeTrackName(name: string, fallback = "Untitled track"): string {
  const clean = name.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 80);
  return clean || fallback;
}

/**
 * The length (seconds) one export cycle should span. If the mix has a
 * transport loop (from a recorded loop track) it drives the span; otherwise the
 * longest stem's duration does, so a lone AI beat still exports in full.
 */
export function exportSpanSec(loopDurSec: number, longestStemSec: number): number {
  if (loopDurSec > 0) return loopDurSec;
  return Math.max(0, longestStemSec);
}

/** Total export length in frames for `cycles` cycles of a given span. */
export function exportFrames(
  cycles: number,
  spanSec: number,
  sampleRate: number
): number {
  return Math.max(1, Math.ceil(exportDurationSeconds(cycles, spanSec) * sampleRate));
}

/**
 * Encode interleaved stereo Float32 channels as a 16-bit PCM WAV. Mirrors the
 * looper's mono encoder but writes two channels so pan survives export.
 */
export function encodeWavStereo(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number
): ArrayBuffer {
  const channels = 2;
  const frames = Math.min(left.length, right.length);
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataBytes, true);
  let off = 44;
  const clip = (x: number) => Math.max(-1, Math.min(1, x));
  for (let i = 0; i < frames; i++) {
    const l = clip(left[i]);
    const r = clip(right[i]);
    view.setInt16(off, l < 0 ? l * 0x8000 : l * 0x7fff, true);
    view.setInt16(off + 2, r < 0 ? r * 0x8000 : r * 0x7fff, true);
    off += 4;
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// Mixer
// ---------------------------------------------------------------------------

interface MixerTrack {
  id: number;
  name: string;
  kind: TrackKind;
  role: string;
  source: RecordSource | "ai";
  buffer: AudioBuffer;
  gain: GainNode;
  panner: StereoPannerNode;
  node: AudioBufferSourceNode | null;
  muted: boolean;
  solo: boolean;
  volume: number;
  pan: number;
  /** Peak-normalization makeup baked at record time (1 for stems/imports). */
  normGain: number;
  /** Armed for punch-in record. */
  armed: boolean;
  /** Clip start offset within the loop (seconds); rotates the looping content. */
  offsetSec: number;
}

/**
 * Audio-graph controller. Needs a real AudioContext, so it is not unit tested
 * directly; the pure helpers above (and the reused looper helpers) are.
 */
export class ProducerMixer {
  private ctx: AudioContext;
  private output: AudioNode;

  // Dedicated loop bus (recorded takes) -> safety limiter -> output, mirroring
  // the handsynth looper so stacked harmony takes stay clear instead of clipping.
  // AI stems / imports route straight to output (unchanged), so their sound is
  // untouched; export mirrors both paths.
  private loopBus: GainNode;
  private limiter: DynamicsCompressorNode;
  // Metronome / count-in clicks generated here route only to destination, so a
  // click is NEVER captured into an instrument take.
  private clickGain: GainNode;

  // Shared mic tap (the Synth's mic hub). The mixer never creates its own
  // MediaStreamAudioSourceNode: only one source node may exist per mic stream or
  // the recorder captures silence. See Synth.getMicNode().
  private micSource: AudioNode | null = null;
  private instrumentNode: AudioNode | null = null;

  // capture state (recording a live instrument/mic loop)
  private sp: ScriptProcessorNode | null = null;
  private silent: GainNode | null = null;
  private captureSource: AudioNode | null = null;
  private captureMix: GainNode | null = null;
  private capture: Float32Array | null = null;
  private freeChunks: Float32Array[] = [];
  private recording = false;
  private countInTimer: ReturnType<typeof setTimeout> | null = null;
  private recordSource: RecordSource = "instrument";

  // cycle-record state (continuous, seamless loop-length segmentation)
  private cycleMode = false;
  private cycleBuf: Float32Array | null = null;
  private cycleWrite = 0;
  private cycleSkip = 0;
  private countingIn = false;
  private countInEnd = 0;
  private armedTrackId: number | null = null;

  // metronome lookahead scheduler
  private metronomeOn = false;
  private metroTimer: ReturnType<typeof setInterval> | null = null;
  private metroNextTime = 0;
  private metroBeat = 0;

  private tracks: MixerTrack[] = [];
  private loopStart: number | null = null;
  private loopDur = 0; // seconds (from the first recorded loop)
  private playing = false;
  private nextId = 1;

  private cfg: MixerConfig = { bpm: 120, bars: 2, free: false, beatsPerBar: BEATS_PER_BAR };

  onChange: (() => void) | null = null;

  constructor(
    ctx: AudioContext,
    output: AudioNode,
    // Kept for call-site compatibility; clicks are generated internally so they
    // are never captured into a recorded take.
    _clickCb?: (time: number, accent: boolean) => void
  ) {
    this.ctx = ctx;
    this.output = output;

    this.loopBus = ctx.createGain();
    this.loopBus.gain.value = 1;
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.15;
    this.loopBus.connect(this.limiter);
    this.limiter.connect(this.output);

    this.clickGain = ctx.createGain();
    this.clickGain.gain.value = 1;
    this.clickGain.connect(ctx.destination);
  }

  private beatsPerBar(): number {
    const b = this.cfg.beatsPerBar ?? BEATS_PER_BAR;
    return Math.max(1, Math.round(b));
  }

  /** A short click straight to the speakers (never onto a recorded bus). */
  private playClick(time: number, accent: boolean): void {
    const t = Math.max(time, this.ctx.currentTime);
    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(accent ? 1600 : 1000, t);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(accent ? 0.4 : 0.25, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    osc.connect(g);
    g.connect(this.clickGain);
    osc.start(t);
    osc.stop(t + 0.05);
  }

  get isRecording(): boolean {
    return this.recording || this.countInTimer !== null;
  }
  get isCycleRecording(): boolean {
    return this.cycleMode && (this.recording || this.countingIn);
  }
  get isCountingIn(): boolean {
    return this.countingIn;
  }
  get isPlaying(): boolean {
    return this.playing;
  }
  get trackCount(): number {
    return this.tracks.length;
  }
  get loopDurationSec(): number {
    return this.loopDur;
  }

  setConfig(cfg: MixerConfig): void {
    this.cfg = { ...cfg };
  }
  setRecordSource(sel: RecordSource): void {
    this.recordSource = sel;
  }
  /**
   * Provide the shared mic tap node (the Synth's mic hub, the SAME node the
   * vocoder and level meter read). The mixer does NOT create its own
   * MediaStreamAudioSourceNode, so cycle takes always contain the user's voice.
   */
  setMicNode(node: AudioNode): void {
    this.micSource = node;
  }
  setInstrumentNode(node: AudioNode): void {
    this.instrumentNode = node;
  }

  canRecord(): boolean {
    for (const k of sourcesForSelection(this.recordSource)) {
      if (k === "mic" && !this.micSource) return false;
      if (k === "instrument" && !this.instrumentNode) return false;
    }
    return true;
  }

  getStates(): MixerTrackState[] {
    return this.tracks.map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      role: t.role,
      source: t.source,
      muted: t.muted,
      solo: t.solo,
      volume: t.volume,
      pan: t.pan,
      durationSec: t.buffer.duration,
      armed: t.armed,
      offsetSec: t.offsetSec,
    }));
  }

  // --- track construction ---

  private makeTrack(
    buffer: AudioBuffer,
    name: string,
    kind: TrackKind,
    role: string,
    source: RecordSource | "ai",
    pan: number,
    normGain = 1
  ): MixerTrack {
    const gain = this.ctx.createGain();
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = clampPan(pan);
    gain.gain.value = 0.9;
    gain.connect(panner);
    // Recorded loop takes pass through the limiter bus so a harmony stack stays
    // clean; AI stems / imports go straight to the output as before.
    panner.connect(kind === "loop" ? this.loopBus : this.output);
    const track: MixerTrack = {
      id: this.nextId++,
      name,
      kind,
      role,
      source,
      buffer,
      gain,
      panner,
      node: null,
      muted: false,
      solo: false,
      volume: 0.9,
      pan: clampPan(pan),
      normGain,
      armed: false,
      offsetSec: 0,
    };
    this.tracks.push(track);
    return track;
  }

  /**
   * Add a deejai-rendered stem as a mixer track. If the transport is already
   * playing, the stem starts on the next loop boundary so it lines up.
   */
  addStemTrack(
    buffer: AudioBuffer,
    name: string,
    role: string,
    pan = 0
  ): MixerTrackState {
    const track = this.makeTrack(buffer, name, "stem", role, "ai", pan);
    if (this.playing) {
      const startAt =
        this.loopDur > 0
          ? nextLoopBoundary(this.ctx.currentTime + 0.05, this.loopStart, this.loopDur)
          : this.ctx.currentTime + 0.05;
      this.startTrack(track, startAt);
      this.applyMix();
    }
    this.onChange?.();
    return this.getStates().find((s) => s.id === track.id)!;
  }

  /** Add an audio file chosen by the user as a reusable backing track. */
  addImportedTrack(buffer: AudioBuffer, name: string): MixerTrackState {
    const safeName = sanitizeTrackName(name, `Imported ${this.nextId}`);
    const track = this.makeTrack(buffer, safeName, "stem", "imported", "ai", 0);
    if (this.playing) {
      const startAt = this.loopDur > 0
        ? nextLoopBoundary(this.ctx.currentTime + 0.05, this.loopStart, this.loopDur)
        : this.ctx.currentTime + 0.05;
      this.startTrack(track, startAt);
      this.applyMix();
    }
    this.onChange?.();
    return this.getStates().find((state) => state.id === track.id)!;
  }

  private startTrack(track: MixerTrack, when: number): void {
    const node = this.ctx.createBufferSource();
    node.buffer = track.buffer;
    node.loop = true;
    node.connect(track.gain);
    // A clip moved along the timeline rotates the looping content so its downbeat
    // lands offsetSec into the cycle; loop stays phase-locked to the transport.
    const readOffset =
      track.offsetSec > 0 && this.loopDur > 0
        ? wrapBufferOffset(track.offsetSec, this.loopDur)
        : 0;
    node.start(when, readOffset);
    track.node = node;
  }

  private stopTrackNode(track: MixerTrack): void {
    if (track.node) {
      try {
        track.node.stop();
      } catch {
        /* ignore */
      }
      try {
        track.node.disconnect();
      } catch {
        /* ignore */
      }
      track.node = null;
    }
  }

  // --- recording a live loop (ported from the handsynth looper) ---

  /** One-shot record of a single loop-length take (legacy path). */
  arm(countInBars: number): void {
    if (this.isRecording || !this.canRecord()) return;
    this.cycleMode = false;
    this.scheduleCountIn(countInBars, () => this.beginCapture());
  }

  /**
   * Cycle recording for vocal stacking: after the count-in, capture runs
   * continuously and every pass around the loop is committed as a NEW take that
   * immediately loops phase-locked, so the singer keeps layering harmonies until
   * Stop. If a track is armed, this punches one cycle into that track instead.
   */
  armCycle(countInBars: number): void {
    if (this.isRecording || !this.canRecord()) return;
    this.cycleMode = true;
    this.scheduleCountIn(countInBars, () => this.beginCycleCapture());
  }

  private scheduleCountIn(countInBars: number, onDone: () => void): void {
    const bpb = this.beatsPerBar();
    const beatDur = secondsPerBeat(this.cfg.bpm);
    const clickBars = Math.max(0, Math.floor(countInBars));
    if (clickBars <= 0) {
      onDone();
      return;
    }
    const now = this.ctx.currentTime + 0.06;
    for (let b = 0; b < clickBars; b++) {
      for (let beat = 0; beat < bpb; beat++) {
        const t = now + (b * bpb + beat) * beatDur;
        this.playClick(t, beat === 0);
      }
    }
    const durSec = countInSec(clickBars, this.cfg.bpm, bpb);
    this.countingIn = true;
    this.countInEnd = now + durSec;
    this.countInTimer = setTimeout(() => {
      this.countInTimer = null;
      this.countingIn = false;
      onDone();
    }, durSec * 1000 + 60);
    this.onChange?.();
  }

  private resolveCaptureSource(): AudioNode | null {
    const kinds = sourcesForSelection(this.recordSource);
    if (kinds.length === 1) {
      return kinds[0] === "mic" ? this.micSource : this.instrumentNode;
    }
    const mix = this.ctx.createGain();
    if (this.micSource) this.micSource.connect(mix);
    if (this.instrumentNode) this.instrumentNode.connect(mix);
    this.captureMix = mix;
    return mix;
  }

  private beginCapture(): void {
    const src = this.resolveCaptureSource();
    if (!src) return;
    this.recording = true;
    const sr = this.ctx.sampleRate;
    const fixedLen =
      this.loopDur > 0
        ? Math.round(this.loopDur * sr)
        : this.cfg.free
          ? 0
          : loopLengthSamples(this.cfg.bpm, this.cfg.bars, sr);
    this.freeChunks = [];
    this.capture = fixedLen > 0 ? new Float32Array(fixedLen) : null;
    let writeIdx = 0;

    const sp = this.ctx.createScriptProcessor(2048, 1, 1);
    const silent = this.ctx.createGain();
    silent.gain.value = 0;
    src.connect(sp);
    sp.connect(silent);
    silent.connect(this.ctx.destination);
    sp.onaudioprocess = (e) => {
      if (!this.recording) return;
      const input = e.inputBuffer.getChannelData(0);
      if (this.capture) {
        const remaining = this.capture.length - writeIdx;
        const n = Math.min(remaining, input.length);
        this.capture.set(input.subarray(0, n), writeIdx);
        writeIdx += n;
        if (writeIdx >= this.capture.length) this.finalize();
      } else {
        this.freeChunks.push(new Float32Array(input));
      }
    };
    this.sp = sp;
    this.silent = silent;
    this.captureSource = src;
    this.onChange?.();
  }

  // --- cycle recording (continuous, seamless, phase-locked segmentation) ---

  private beginCycleCapture(): void {
    const src = this.resolveCaptureSource();
    if (!src) {
      this.cycleMode = false;
      this.onChange?.();
      return;
    }
    const sr = this.ctx.sampleRate;
    const bpb = this.beatsPerBar();
    const loopSec =
      this.loopDur > 0
        ? this.loopDur
        : loopLengthSeconds(this.cfg.bpm, this.cfg.bars, bpb);
    const len = Math.max(1, Math.round(loopSec * sr));

    // Align the first captured segment to a loop boundary. If a loop already
    // runs, skip the leading samples up to the next boundary; otherwise anchor
    // the transport to the capture start (this take defines the loop).
    let skip = 0;
    if (this.loopDur > 0 && this.loopStart !== null) {
      const boundary = nextLoopBoundary(
        this.ctx.currentTime,
        this.loopStart,
        this.loopDur
      );
      skip = Math.max(0, Math.round((boundary - this.ctx.currentTime) * sr));
    } else {
      this.loopDur = loopSec;
      this.loopStart = this.ctx.currentTime;
    }

    this.cycleBuf = new Float32Array(len);
    this.cycleWrite = 0;
    this.cycleSkip = skip;
    this.recording = true;

    const sp = this.ctx.createScriptProcessor(2048, 1, 1);
    const silent = this.ctx.createGain();
    silent.gain.value = 0;
    src.connect(sp);
    sp.connect(silent);
    silent.connect(this.ctx.destination);
    sp.onaudioprocess = (e) => this.onCycleAudio(e);
    this.sp = sp;
    this.silent = silent;
    this.captureSource = src;
    if (this.metronomeOn) this.startMetronome();
    this.onChange?.();
  }

  private onCycleAudio(e: AudioProcessingEvent): void {
    if (!this.recording || !this.cycleBuf) return;
    const input = e.inputBuffer.getChannelData(0);
    const segLen = this.cycleBuf.length;
    let i = 0;
    if (this.cycleSkip > 0) {
      const s = Math.min(this.cycleSkip, input.length);
      this.cycleSkip -= s;
      i = s;
    }
    while (i < input.length) {
      const buf = this.cycleBuf;
      if (!buf) break;
      const n = Math.min(buf.length - this.cycleWrite, input.length - i);
      buf.set(input.subarray(i, i + n), this.cycleWrite);
      this.cycleWrite += n;
      i += n;
      if (this.cycleWrite >= buf.length) {
        this.cycleBuf = new Float32Array(segLen);
        this.cycleWrite = 0;
        this.commitCycleTake(buf);
        if (!this.recording) break; // punch-in / stop happened during commit
      }
    }
  }

  private commitCycleTake(data: Float32Array): void {
    const sr = this.ctx.sampleRate;
    const buffer = this.ctx.createBuffer(1, data.length, sr);
    buffer.getChannelData(0).set(data);

    // Punch-in: replace the armed track's buffer instead of stacking a new take.
    if (this.armedTrackId !== null) {
      const target = this.tracks.find((t) => t.id === this.armedTrackId);
      if (target) {
        this.stopTrackNode(target);
        target.buffer = buffer;
        target.normGain = normalizeGain(peakAmplitude(data));
        target.armed = false;
        if (this.playing) {
          const startAt = nextLoopBoundary(
            this.ctx.currentTime + 0.02,
            this.loopStart,
            this.loopDur
          );
          this.startTrack(target, startAt);
          this.applyMix();
        }
      }
      this.armedTrackId = null;
      this.stopRecording(); // punch-in is a single cycle
      return;
    }

    const cyc = cycleIndex(this.ctx.currentTime, this.loopStart, this.loopDur);
    const track = this.makeTrack(
      buffer,
      `Take ${this.nextId} (cyc ${cyc + 1})`,
      "loop",
      "loop",
      this.recordSource,
      0,
      normalizeGain(peakAmplitude(data))
    );
    // Start the take against the EXISTING transport anchor (never re-anchor via
    // playAll here): the capture segments and the playback loop share one clock,
    // so every stacked take stays phase-locked. The take begins on the next loop
    // boundary, one cycle after it was sung, exactly like a hardware looper.
    if (this.loopStart === null) {
      this.loopStart = this.ctx.currentTime;
    }
    const startAt = nextLoopBoundary(
      this.ctx.currentTime + 0.02,
      this.loopStart,
      this.loopDur
    );
    this.startTrack(track, startAt);
    this.playing = true;
    this.applyMix();
    this.onChange?.();
  }

  private endCycleCapture(): void {
    this.cycleMode = false;
    this.recording = false;
    this.cycleBuf = null;
    this.cycleWrite = 0;
    this.cycleSkip = 0;
    this.teardownCapture();
    if (!this.metronomeOn || !this.playing) this.stopMetronome();
    this.onChange?.();
  }

  // --- metronome (lookahead scheduler; clicks never touch a recorded bus) ---

  setMetronome(on: boolean): void {
    this.metronomeOn = on;
    if (on && (this.playing || this.recording)) this.startMetronome();
    else if (!on) this.stopMetronome();
  }
  get metronomeEnabled(): boolean {
    return this.metronomeOn;
  }

  private startMetronome(): void {
    if (this.metroTimer) return;
    const beatDur = secondsPerBeat(this.cfg.bpm);
    // Align the beat grid to the transport anchor when there is one.
    const now = this.ctx.currentTime;
    if (this.loopStart !== null) {
      const since = now - this.loopStart;
      const beatsSince = Math.ceil(since / beatDur - 1e-6);
      this.metroNextTime = this.loopStart + beatsSince * beatDur;
      this.metroBeat = ((Math.round(beatsSince) % this.beatsPerBar()) +
        this.beatsPerBar()) % this.beatsPerBar();
    } else {
      this.metroNextTime = now + 0.1;
      this.metroBeat = 0;
    }
    this.metroTimer = setInterval(() => this.pumpMetronome(), 25);
  }

  private pumpMetronome(): void {
    const beatDur = secondsPerBeat(this.cfg.bpm);
    const bpb = this.beatsPerBar();
    const horizon = this.ctx.currentTime + 0.2;
    while (this.metroNextTime < horizon) {
      this.playClick(this.metroNextTime, this.metroBeat === 0);
      this.metroNextTime += beatDur;
      this.metroBeat = (this.metroBeat + 1) % bpb;
    }
  }

  private stopMetronome(): void {
    if (this.metroTimer) {
      clearInterval(this.metroTimer);
      this.metroTimer = null;
    }
  }

  /** Arm/disarm a track for punch-in record (only one armed at a time). */
  setArm(id: number, armed: boolean): void {
    for (const t of this.tracks) t.armed = armed ? t.id === id : false;
    this.armedTrackId = armed ? id : null;
    this.onChange?.();
  }

  stopRecording(): void {
    if (this.cycleMode || this.cycleBuf) {
      if (this.countInTimer) {
        clearTimeout(this.countInTimer);
        this.countInTimer = null;
        this.countingIn = false;
      }
      this.endCycleCapture();
      return;
    }
    if (this.countInTimer) {
      clearTimeout(this.countInTimer);
      this.countInTimer = null;
      this.countingIn = false;
      this.recording = false;
      this.teardownCapture();
      this.onChange?.();
      return;
    }
    if (!this.recording) return;
    if (!this.capture) {
      const total = this.freeChunks.reduce((a, c) => a + c.length, 0);
      const buf = new Float32Array(Math.max(1, total));
      let o = 0;
      for (const c of this.freeChunks) {
        buf.set(c, o);
        o += c.length;
      }
      this.capture = buf;
    }
    this.finalize();
  }

  private teardownCapture(): void {
    if (this.sp) {
      this.sp.onaudioprocess = null;
      try {
        if (this.captureSource) this.captureSource.disconnect(this.sp);
      } catch {
        /* ignore */
      }
      try {
        this.sp.disconnect();
      } catch {
        /* ignore */
      }
    }
    if (this.silent) {
      try {
        this.silent.disconnect();
      } catch {
        /* ignore */
      }
    }
    if (this.captureMix) {
      try {
        this.micSource?.disconnect(this.captureMix);
      } catch {
        /* ignore */
      }
      try {
        this.instrumentNode?.disconnect(this.captureMix);
      } catch {
        /* ignore */
      }
      try {
        this.captureMix.disconnect();
      } catch {
        /* ignore */
      }
      this.captureMix = null;
    }
    this.sp = null;
    this.silent = null;
    this.captureSource = null;
  }

  private finalize(): void {
    this.recording = false;
    const data = this.capture ?? new Float32Array(1);
    this.teardownCapture();
    const sr = this.ctx.sampleRate;
    const buffer = this.ctx.createBuffer(1, data.length, sr);
    buffer.getChannelData(0).set(data);
    const track = this.makeTrack(
      buffer,
      `Take ${this.nextId - 1}`,
      "loop",
      "loop",
      this.recordSource,
      0,
      normalizeGain(peakAmplitude(data))
    );
    this.capture = null;
    this.freeChunks = [];

    if (this.loopDur <= 0) {
      this.loopDur = this.cfg.free
        ? buffer.duration
        : loopLengthSeconds(this.cfg.bpm, this.cfg.bars);
    }
    if (this.loopStart === null) {
      this.playAll();
    } else if (this.playing) {
      const startAt = nextLoopBoundary(
        this.ctx.currentTime + 0.02,
        this.loopStart,
        this.loopDur
      );
      this.startTrack(track, startAt);
      this.applyMix();
    } else {
      this.playAll();
    }
    this.onChange?.();
  }

  // --- transport ---

  playAll(): void {
    if (this.tracks.length === 0) return;
    for (const t of this.tracks) this.stopTrackNode(t);
    const startAt = this.ctx.currentTime + 0.08;
    this.loopStart = startAt;
    for (const t of this.tracks) this.startTrack(t, startAt);
    this.playing = true;
    this.applyMix();
    if (this.metronomeOn) {
      this.stopMetronome();
      this.startMetronome();
    }
    this.onChange?.();
  }

  stopAll(): void {
    for (const t of this.tracks) this.stopTrackNode(t);
    this.playing = false;
    if (!this.recording) this.stopMetronome();
    this.onChange?.();
  }

  private applyMix(): void {
    const anySolo = this.tracks.some((t) => t.solo);
    const now = this.ctx.currentTime;
    for (const t of this.tracks) {
      const mix: TrackMix = { muted: t.muted, solo: t.solo, volume: t.volume };
      t.gain.gain.setTargetAtTime(effectiveGain(mix, anySolo) * t.normGain, now, 0.02);
    }
  }

  /** Live transport snapshot for the playhead / count-in / bar readout. */
  getTransportInfo(): TransportInfo {
    const now = this.ctx.currentTime;
    return {
      playing: this.playing,
      recording: this.recording,
      countingIn: this.countingIn,
      countInRemaining: this.countingIn ? Math.max(0, this.countInEnd - now) : 0,
      positionSec: loopPositionSec(now, this.loopStart, this.loopDur),
      loopDurationSec: this.loopDur,
      cycle: cycleIndex(now, this.loopStart, this.loopDur),
    };
  }

  /** Peak-magnitude buckets for drawing a track's waveform. */
  getPeaks(id: number, buckets: number): number[] | null {
    const t = this.tracks.find((x) => x.id === id);
    if (!t) return null;
    return computePeaks(t.buffer.getChannelData(0), buckets);
  }

  /** Move a clip's downbeat to `offsetSec` within the loop (timeline drag). */
  setTrackOffset(id: number, offsetSec: number): void {
    const t = this.tracks.find((x) => x.id === id);
    if (!t) return;
    const dur = this.loopDur > 0 ? this.loopDur : t.buffer.duration;
    t.offsetSec = Math.max(0, Math.min(dur, offsetSec));
    if (this.playing && t.node) {
      const startAt = nextLoopBoundary(
        this.ctx.currentTime + 0.02,
        this.loopStart,
        this.loopDur
      );
      this.stopTrackNode(t);
      this.startTrack(t, startAt);
    }
    this.onChange?.();
  }

  /**
   * Trim a loop track to the region [startSec, endSec] within the cycle, keeping
   * the loop length so phase-lock survives: audio outside the region is silenced
   * rather than shortening the buffer. Returns false if the track is not a loop.
   */
  trimTrack(id: number, startSec: number, endSec: number): boolean {
    const t = this.tracks.find((x) => x.id === id);
    if (!t || t.kind !== "loop") return false;
    const sr = t.buffer.sampleRate;
    const len = t.buffer.length;
    const s = Math.max(0, Math.min(len, Math.round(startSec * sr)));
    const e = Math.max(s, Math.min(len, Math.round(endSec * sr)));
    const src = t.buffer.getChannelData(0);
    const out = this.ctx.createBuffer(1, len, sr);
    out.getChannelData(0).set(src.subarray(0, len));
    const data = out.getChannelData(0);
    for (let i = 0; i < s; i++) data[i] = 0;
    for (let i = e; i < len; i++) data[i] = 0;
    t.buffer = out;
    if (this.playing && t.node) {
      const startAt = nextLoopBoundary(
        this.ctx.currentTime + 0.02,
        this.loopStart,
        this.loopDur
      );
      this.stopTrackNode(t);
      this.startTrack(t, startAt);
    }
    this.onChange?.();
    return true;
  }

  setMute(id: number, muted: boolean): void {
    const t = this.tracks.find((x) => x.id === id);
    if (t) {
      t.muted = muted;
      this.applyMix();
      this.onChange?.();
    }
  }
  setSolo(id: number, solo: boolean): void {
    const t = this.tracks.find((x) => x.id === id);
    if (t) {
      t.solo = solo;
      this.applyMix();
      this.onChange?.();
    }
  }
  setVolume(id: number, volume: number): void {
    const t = this.tracks.find((x) => x.id === id);
    if (t) {
      t.volume = Math.max(0, Math.min(1, volume));
      this.applyMix();
      this.onChange?.();
    }
  }
  setPan(id: number, pan: number): void {
    const t = this.tracks.find((x) => x.id === id);
    if (t) {
      t.pan = clampPan(pan);
      t.panner.pan.setTargetAtTime(t.pan, this.ctx.currentTime, 0.02);
      this.onChange?.();
    }
  }

  renameTrack(id: number, name: string): void {
    const t = this.tracks.find((x) => x.id === id);
    if (t) {
      t.name = name.replace(/[\u0000-\u001f]/g, " ").slice(0, 80);
      this.onChange?.();
    }
  }

  duplicateTrack(id: number): MixerTrackState | null {
    const source = this.tracks.find((x) => x.id === id);
    if (!source) return null;
    const copy = this.makeTrack(
      source.buffer,
      `${source.name} copy`.slice(0, 80),
      source.kind,
      source.role,
      source.source,
      source.pan,
      source.normGain
    );
    copy.volume = source.volume;
    copy.muted = source.muted;
    copy.solo = source.solo;
    copy.offsetSec = source.offsetSec;
    if (this.playing) {
      const startAt = this.loopDur > 0
        ? nextLoopBoundary(this.ctx.currentTime + 0.05, this.loopStart, this.loopDur)
        : this.ctx.currentTime + 0.05;
      this.startTrack(copy, startAt);
      this.applyMix();
    }
    this.onChange?.();
    return this.getStates().find((state) => state.id === copy.id) ?? null;
  }

  createSnapshot(): MixerProjectSnapshot {
    return {
      version: 1,
      loopDurationSec: this.loopDur,
      tracks: this.tracks.map((track) => ({
        name: track.name,
        kind: track.kind,
        role: track.role,
        source: track.source,
        muted: track.muted,
        solo: track.solo,
        volume: track.volume,
        pan: track.pan,
        normGain: track.normGain,
        offsetSec: track.offsetSec,
        sampleRate: track.buffer.sampleRate,
        channels: Array.from({ length: track.buffer.numberOfChannels }, (_, channel) => {
          const samples = track.buffer.getChannelData(channel);
          return samples.slice().buffer;
        }),
      })),
    };
  }

  restoreSnapshot(snapshot: MixerProjectSnapshot): void {
    if (snapshot.version !== 1 || !Array.isArray(snapshot.tracks)) {
      throw new Error("Unsupported Trackstar project format.");
    }
    this.clearAll();
    for (const saved of snapshot.tracks) {
      if (
        !saved ||
        !Array.isArray(saved.channels) ||
        !saved.channels.length ||
        !saved.channels.every((channel) => channel instanceof ArrayBuffer) ||
        !Number.isFinite(saved.sampleRate) ||
        saved.sampleRate < 8000 ||
        saved.sampleRate > 192000
      ) continue;
      const arrays = saved.channels.map((bytes) => new Float32Array(bytes));
      const length = Math.min(...arrays.map((samples) => samples.length));
      if (length < 1) continue;
      const buffer = this.ctx.createBuffer(arrays.length, length, saved.sampleRate);
      arrays.forEach((samples, channel) => {
        buffer.getChannelData(channel).set(samples.subarray(0, length));
      });
      const track = this.makeTrack(
        buffer,
        saved.name.trim().slice(0, 80) || `Track ${this.nextId}`,
        saved.kind === "loop" ? "loop" : "stem",
        saved.role || "imported",
        saved.source,
        saved.pan,
        Number.isFinite(saved.normGain) ? Math.max(0, Math.min(8, saved.normGain as number)) : 1
      );
      track.muted = !!saved.muted;
      track.solo = !!saved.solo;
      track.volume = Math.max(0, Math.min(1, saved.volume));
      track.offsetSec = Number.isFinite(saved.offsetSec) ? Math.max(0, saved.offsetSec as number) : 0;
    }
    this.loopDur = Math.max(0, snapshot.loopDurationSec || 0);
    this.applyMix();
    this.onChange?.();
  }

  deleteTrack(id: number): void {
    const idx = this.tracks.findIndex((x) => x.id === id);
    if (idx < 0) return;
    const t = this.tracks[idx];
    this.stopTrackNode(t);
    try {
      t.gain.disconnect();
      t.panner.disconnect();
    } catch {
      /* ignore */
    }
    this.tracks.splice(idx, 1);
    if (this.armedTrackId === id) this.armedTrackId = null;
    if (!this.tracks.some((track) => track.kind === "loop")) this.loopDur = 0;
    if (this.tracks.length === 0) {
      this.loopStart = null;
      this.loopDur = 0;
      this.playing = false;
    } else {
      this.applyMix();
    }
    this.onChange?.();
  }

  clearAll(): void {
    for (const t of this.tracks) {
      this.stopTrackNode(t);
      try {
        t.gain.disconnect();
        t.panner.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.tracks = [];
    this.loopStart = null;
    this.loopDur = 0;
    this.playing = false;
    this.armedTrackId = null;
    if (!this.recording) this.stopMetronome();
    this.onChange?.();
  }

  private longestStemSec(): number {
    let m = 0;
    for (const t of this.tracks) m = Math.max(m, t.buffer.duration);
    return m;
  }

  /** WAV bytes for one track; preserves stereo when the source has two channels. */
  getTrackWav(id: number): ArrayBuffer | null {
    const t = this.tracks.find((x) => x.id === id);
    if (!t) return null;
    if (t.buffer.numberOfChannels > 1) {
      return encodeWavStereo(
        t.buffer.getChannelData(0),
        t.buffer.getChannelData(1),
        t.buffer.sampleRate
      );
    }
    return encodeWavBytes(t.buffer.getChannelData(0), t.buffer.sampleRate);
  }

  /**
   * Bounce the whole mix (all audible tracks, with pan) for `cycles` cycles to a
   * stereo WAV via an OfflineAudioContext.
   */
  async exportMix(cycles: number): Promise<ArrayBuffer | null> {
    if (this.tracks.length === 0) return null;
    const sr = this.ctx.sampleRate;
    const span = exportSpanSec(this.loopDur, this.longestStemSec());
    if (span <= 0) return null;
    const frames = exportFrames(cycles, span, sr);
    const oac = new OfflineAudioContext(2, frames, sr);
    // Mirror the live loop bus + limiter so the bounce matches what is heard:
    // loop takes sum through the limiter, AI stems / imports go straight out.
    const loopBus = oac.createGain();
    loopBus.gain.value = 1;
    const lim = oac.createDynamicsCompressor();
    lim.threshold.value = -6;
    lim.knee.value = 0;
    lim.ratio.value = 20;
    lim.attack.value = 0.003;
    lim.release.value = 0.15;
    loopBus.connect(lim);
    lim.connect(oac.destination);
    const anySolo = this.tracks.some((t) => t.solo);
    let any = false;
    for (const t of this.tracks) {
      const g = effectiveGain(
        { muted: t.muted, solo: t.solo, volume: t.volume },
        anySolo
      );
      if (g <= 0) continue;
      any = true;
      const node = oac.createBufferSource();
      node.buffer = t.buffer;
      node.loop = true;
      const gn = oac.createGain();
      gn.gain.value = g * t.normGain;
      const pn = oac.createStereoPanner();
      pn.pan.value = t.pan;
      node.connect(gn);
      gn.connect(pn);
      pn.connect(t.kind === "loop" ? loopBus : oac.destination);
      const readOffset =
        t.offsetSec > 0 && this.loopDur > 0
          ? wrapBufferOffset(t.offsetSec, this.loopDur)
          : 0;
      node.start(0, readOffset);
    }
    if (!any) return null;
    const rendered = await oac.startRendering();
    return encodeWavStereo(
      rendered.getChannelData(0),
      rendered.numberOfChannels > 1
        ? rendered.getChannelData(1)
        : rendered.getChannelData(0),
      sr
    );
  }

  dispose(): void {
    if (this.countInTimer) clearTimeout(this.countInTimer);
    this.stopMetronome();
    this.recording = false;
    this.cycleMode = false;
    this.cycleBuf = null;
    this.teardownCapture();
    this.clearAll();
    try {
      this.loopBus.disconnect();
    } catch {
      /* ignore */
    }
    try {
      this.limiter.disconnect();
    } catch {
      /* ignore */
    }
    try {
      this.clickGain.disconnect();
    } catch {
      /* ignore */
    }
    // The mic node is shared and owned by the Synth; just drop the reference.
    // Any capture edges were already removed in teardownCapture().
    this.micSource = null;
  }
}
