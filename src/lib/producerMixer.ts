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
  /** One-knob low-pass EQ: 0 = dark, 1 = bright. */
  tone: number;
  /** Send level into the shared studio ambience bus. */
  space: number;
  /** Region color used by the timeline and mixer. */
  color: string;
  /** Marked as a preferred take for vocal comping. */
  favorite: boolean;
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
  tone?: number;
  space?: number;
  color?: string;
  favorite?: boolean;
}

export interface VocalStackPlan {
  name: string;
  takes: number;
  /** Stereo width, 0..1. Takes are distributed evenly across it. */
  spread: number;
}

export interface VocalStackProgress {
  name: string;
  recorded: number;
  target: number;
  active: boolean;
}

export interface MixerProjectSnapshot {
  version: 1;
  loopDurationSec: number;
  tracks: SerializedMixerTrack[];
}

export interface MixerHistoryState {
  canUndo: boolean;
  canRedo: boolean;
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

export function toneFrequency(tone: number): number {
  const x = Math.max(0, Math.min(1, Number.isFinite(tone) ? tone : 1));
  return 500 * Math.pow(40, x); // perceptual 500 Hz .. 20 kHz sweep
}

/** Build a short deterministic stereo room impulse for live and offline mixes. */
export function createAmbienceImpulse(
  ctx: BaseAudioContext,
  durationSec = 1.25,
  decay = 3.2
): AudioBuffer {
  const length = Math.max(1, Math.round(ctx.sampleRate * durationSec));
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  let seed = 0x5f3759df;
  const noise = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed / 0xffffffff) * 2 - 1;
  };
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      const envelope = Math.pow(1 - i / length, decay);
      data[i] = noise() * envelope * (channel === 0 ? 0.8 : 0.76);
    }
  }
  return buffer;
}

export function vocalTakePan(index: number, total: number, spread: number): number {
  if (total <= 1) return 0;
  const width = Math.max(0, Math.min(1, spread));
  return clampPan(-width + (2 * width * Math.max(0, Math.min(total - 1, index))) / (total - 1));
}

export function normalizeTrackColor(value: unknown, fallback = "#ffd400"): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
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
  filter: BiquadFilterNode;
  panner: StereoPannerNode;
  spaceGain: GainNode;
  node: AudioBufferSourceNode | null;
  muted: boolean;
  solo: boolean;
  volume: number;
  pan: number;
  tone: number;
  space: number;
  color: string;
  favorite: boolean;
  /** Peak-normalization makeup baked at record time (1 for stems/imports). */
  normGain: number;
  /** Armed for punch-in record. */
  armed: boolean;
  /** Clip start offset within the loop (seconds); rotates the looping content. */
  offsetSec: number;
}

interface MixerHistoryTrack {
  id: number;
  name: string;
  kind: TrackKind;
  role: string;
  source: RecordSource | "ai";
  buffer: AudioBuffer;
  muted: boolean;
  solo: boolean;
  volume: number;
  pan: number;
  tone: number;
  space: number;
  color: string;
  favorite: boolean;
  normGain: number;
  offsetSec: number;
}

interface MixerHistorySnapshot {
  tracks: MixerHistoryTrack[];
  loopDur: number;
  playing: boolean;
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
  /** Shared short room used by every track's post-pan Space send. */
  private ambience: ConvolverNode;
  private ambienceWet: GainNode;
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
  private cyclePlan: VocalStackPlan | null = null;
  private cycleTakesRecorded = 0;
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
  private undoStack: MixerHistorySnapshot[] = [];
  private redoStack: MixerHistorySnapshot[] = [];
  private restoringHistory = false;
  private lastHistoryKey = "";
  private lastHistoryAt = 0;

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

    this.ambience = ctx.createConvolver();
    this.ambience.buffer = createAmbienceImpulse(ctx);
    this.ambienceWet = ctx.createGain();
    this.ambienceWet.gain.value = 0.45;
    this.ambience.connect(this.ambienceWet);
    this.ambienceWet.connect(this.output);

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
   * harmonizer and level meter read). The mixer does NOT create its own
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
      tone: t.tone,
      space: t.space,
      color: t.color,
      favorite: t.favorite,
      durationSec: t.buffer.duration,
      armed: t.armed,
      offsetSec: t.offsetSec,
    }));
  }

  getHistoryState(): MixerHistoryState {
    return { canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 };
  }

  clearHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.lastHistoryKey = "";
    this.onChange?.();
  }

  private captureHistory(): MixerHistorySnapshot {
    return {
      tracks: this.tracks.map((track) => ({
        id: track.id,
        name: track.name,
        kind: track.kind,
        role: track.role,
        source: track.source,
        buffer: track.buffer,
        muted: track.muted,
        solo: track.solo,
        volume: track.volume,
        pan: track.pan,
        tone: track.tone,
        space: track.space,
        color: track.color,
        favorite: track.favorite,
        normGain: track.normGain,
        offsetSec: track.offsetSec,
      })),
      loopDur: this.loopDur,
      playing: this.playing,
    };
  }

  private pushHistory(key: string): void {
    if (this.restoringHistory) return;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (key === this.lastHistoryKey && now - this.lastHistoryAt < 500) {
      this.lastHistoryAt = now;
      return;
    }
    this.undoStack.push(this.captureHistory());
    if (this.undoStack.length > 40) this.undoStack.shift();
    this.redoStack = [];
    this.lastHistoryKey = key;
    this.lastHistoryAt = now;
  }

  private restoreHistory(snapshot: MixerHistorySnapshot): void {
    this.restoringHistory = true;
    for (const track of this.tracks) {
      this.stopTrackNode(track);
      try {
        track.gain.disconnect();
        track.filter.disconnect();
        track.panner.disconnect();
        track.spaceGain.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.tracks = [];
    this.nextId = 1;
    for (const saved of snapshot.tracks) {
      const track = this.makeTrack(
        saved.buffer,
        saved.name,
        saved.kind,
        saved.role,
        saved.source,
        saved.pan,
        saved.normGain,
        saved.color
      );
      track.id = saved.id;
      track.muted = saved.muted;
      track.solo = saved.solo;
      track.volume = saved.volume;
      track.tone = saved.tone;
      track.filter.frequency.value = toneFrequency(saved.tone);
      track.space = saved.space;
      track.spaceGain.gain.value = saved.space;
      track.favorite = saved.favorite;
      track.offsetSec = saved.offsetSec;
      this.nextId = Math.max(this.nextId, saved.id + 1);
    }
    this.loopDur = snapshot.loopDur;
    this.loopStart = null;
    this.playing = false;
    this.applyMix();
    this.restoringHistory = false;
    if (snapshot.playing && this.tracks.length > 0) this.playAll();
    else this.onChange?.();
  }

  undo(): boolean {
    if (this.isRecording || this.undoStack.length === 0) return false;
    const previous = this.undoStack.pop()!;
    this.redoStack.push(this.captureHistory());
    this.restoreHistory(previous);
    this.lastHistoryKey = "";
    return true;
  }

  redo(): boolean {
    if (this.isRecording || this.redoStack.length === 0) return false;
    const next = this.redoStack.pop()!;
    this.undoStack.push(this.captureHistory());
    this.restoreHistory(next);
    this.lastHistoryKey = "";
    return true;
  }

  // --- track construction ---

  private makeTrack(
    buffer: AudioBuffer,
    name: string,
    kind: TrackKind,
    role: string,
    source: RecordSource | "ai",
    pan: number,
    normGain = 1,
    color?: string
  ): MixerTrack {
    const gain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = toneFrequency(1);
    filter.Q.value = 0.7;
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = clampPan(pan);
    const spaceGain = this.ctx.createGain();
    const defaultSpace = role === "vocal-stack" ? 0.22 : 0;
    spaceGain.gain.value = defaultSpace;
    gain.gain.value = 0.9;
    gain.connect(filter);
    filter.connect(panner);
    // Recorded loop takes pass through the limiter bus so a harmony stack stays
    // clean; AI stems / imports go straight to the output as before.
    panner.connect(kind === "loop" ? this.loopBus : this.output);
    panner.connect(spaceGain);
    spaceGain.connect(this.ambience);
    const track: MixerTrack = {
      id: this.nextId++,
      name,
      kind,
      role,
      source,
      buffer,
      gain,
      filter,
      panner,
      spaceGain,
      node: null,
      muted: false,
      solo: false,
      volume: 0.9,
      pan: clampPan(pan),
      tone: 1,
      space: defaultSpace,
      color: normalizeTrackColor(
        color,
        role === "vocal-stack" ? "#38bdf8" : kind === "loop" ? "#ffd400" : "#d000ff"
      ),
      favorite: false,
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
    this.pushHistory("add-stem");
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
    this.pushHistory("import-audio");
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
  armCycle(countInBars: number, plan?: VocalStackPlan): void {
    if (this.isRecording || !this.canRecord()) return;
    this.cycleMode = true;
    this.cyclePlan = plan
      ? {
          name: sanitizeTrackName(plan.name, "Vocal"),
          takes: Math.max(1, Math.min(12, Math.round(plan.takes) || 1)),
          spread: clampPan(Math.abs(plan.spread)),
        }
      : null;
    this.cycleTakesRecorded = 0;
    this.scheduleCountIn(countInBars, () => this.beginCycleCapture());
  }

  getVocalStackProgress(): VocalStackProgress | null {
    if (!this.cyclePlan) return null;
    return {
      name: this.cyclePlan.name,
      recorded: this.cycleTakesRecorded,
      target: this.cyclePlan.takes,
      active: this.isRecording,
    };
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
        this.pushHistory("punch-in");
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
    const takeIndex = this.cycleTakesRecorded;
    const plan = this.cyclePlan;
    this.pushHistory("record-take");
    const track = this.makeTrack(
      buffer,
      plan ? `${plan.name} ${takeIndex + 1}` : `Take ${this.nextId} (cyc ${cyc + 1})`,
      "loop",
      plan ? "vocal-stack" : "loop",
      this.recordSource,
      plan ? vocalTakePan(takeIndex, plan.takes, plan.spread) : 0,
      normalizeGain(peakAmplitude(data)),
      plan ? "#38bdf8" : undefined
    );
    this.cycleTakesRecorded += 1;
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
    if (plan && this.cycleTakesRecorded >= plan.takes) {
      this.endCycleCapture();
      return;
    }
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
    this.pushHistory("record-take");
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
    this.pushHistory(`move-${id}`);
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
    this.pushHistory(`trim-${id}`);
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
      this.pushHistory(`mute-${id}`);
      t.muted = muted;
      this.applyMix();
      this.onChange?.();
    }
  }
  setSolo(id: number, solo: boolean): void {
    const t = this.tracks.find((x) => x.id === id);
    if (t) {
      this.pushHistory(`solo-${id}`);
      t.solo = solo;
      this.applyMix();
      this.onChange?.();
    }
  }
  setVolume(id: number, volume: number): void {
    const t = this.tracks.find((x) => x.id === id);
    if (t) {
      this.pushHistory(`volume-${id}`);
      t.volume = Math.max(0, Math.min(1, volume));
      this.applyMix();
      this.onChange?.();
    }
  }
  setPan(id: number, pan: number): void {
    const t = this.tracks.find((x) => x.id === id);
    if (t) {
      this.pushHistory(`pan-${id}`);
      t.pan = clampPan(pan);
      t.panner.pan.setTargetAtTime(t.pan, this.ctx.currentTime, 0.02);
      this.onChange?.();
    }
  }

  setTone(id: number, tone: number): void {
    const t = this.tracks.find((x) => x.id === id);
    if (t) {
      this.pushHistory(`tone-${id}`);
      t.tone = Math.max(0, Math.min(1, Number.isFinite(tone) ? tone : 1));
      t.filter.frequency.setTargetAtTime(toneFrequency(t.tone), this.ctx.currentTime, 0.02);
      this.onChange?.();
    }
  }

  setSpace(id: number, space: number): void {
    const t = this.tracks.find((x) => x.id === id);
    if (t) {
      this.pushHistory(`space-${id}`);
      t.space = Math.max(0, Math.min(1, Number.isFinite(space) ? space : 0));
      t.spaceGain.gain.setTargetAtTime(t.space, this.ctx.currentTime, 0.02);
      this.onChange?.();
    }
  }

  setColor(id: number, color: string): void {
    const t = this.tracks.find((x) => x.id === id);
    if (t) {
      this.pushHistory(`color-${id}`);
      t.color = normalizeTrackColor(color, t.color);
      this.onChange?.();
    }
  }

  setFavorite(id: number, favorite: boolean): void {
    const t = this.tracks.find((x) => x.id === id);
    if (t) {
      this.pushHistory(`favorite-${id}`);
      t.favorite = favorite;
      this.onChange?.();
    }
  }

  setRoleMute(role: string, muted: boolean): void {
    this.pushHistory(`role-mute-${role}`);
    for (const track of this.tracks) if (track.role === role) track.muted = muted;
    this.applyMix();
    this.onChange?.();
  }

  setRoleSolo(role: string, solo: boolean): void {
    this.pushHistory(`role-solo-${role}`);
    for (const track of this.tracks) if (track.role === role) track.solo = solo;
    this.applyMix();
    this.onChange?.();
  }

  auditionFavoriteTakes(role: string, on: boolean): void {
    this.pushHistory(`audition-${role}`);
    for (const track of this.tracks) {
      if (track.role === role) track.solo = on && track.favorite;
      else if (on) track.solo = false;
    }
    this.applyMix();
    this.onChange?.();
  }

  deleteRole(role: string): number {
    const ids = this.tracks.filter((track) => track.role === role).map((track) => track.id);
    if (ids.length) this.pushHistory(`delete-role-${role}`);
    for (const id of ids) this.deleteTrack(id, true);
    return ids.length;
  }

  renameTrack(id: number, name: string): void {
    const t = this.tracks.find((x) => x.id === id);
    if (t) {
      this.pushHistory(`rename-${id}`);
      t.name = name.replace(/[\u0000-\u001f]/g, " ").slice(0, 80);
      this.onChange?.();
    }
  }

  duplicateTrack(id: number): MixerTrackState | null {
    const source = this.tracks.find((x) => x.id === id);
    if (!source) return null;
    this.pushHistory(`duplicate-${id}`);
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
    copy.tone = source.tone;
    copy.filter.frequency.value = toneFrequency(copy.tone);
    copy.space = source.space;
    copy.spaceGain.gain.value = copy.space;
    copy.color = source.color;
    copy.favorite = source.favorite;
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
        tone: track.tone,
        space: track.space,
        color: track.color,
        favorite: track.favorite,
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
    this.clearAll(true);
    this.undoStack = [];
    this.redoStack = [];
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
        Number.isFinite(saved.normGain) ? Math.max(0, Math.min(8, saved.normGain as number)) : 1,
        saved.color
      );
      track.muted = !!saved.muted;
      track.solo = !!saved.solo;
      track.volume = Math.max(0, Math.min(1, saved.volume));
      track.offsetSec = Number.isFinite(saved.offsetSec) ? Math.max(0, saved.offsetSec as number) : 0;
      track.tone = Number.isFinite(saved.tone) ? Math.max(0, Math.min(1, saved.tone as number)) : 1;
      track.filter.frequency.value = toneFrequency(track.tone);
      track.space = Number.isFinite(saved.space)
        ? Math.max(0, Math.min(1, saved.space as number))
        : saved.role === "vocal-stack"
          ? 0.22
          : 0;
      track.spaceGain.gain.value = track.space;
      track.favorite = !!saved.favorite;
    }
    this.loopDur = Math.max(0, snapshot.loopDurationSec || 0);
    this.applyMix();
    this.onChange?.();
  }

  deleteTrack(id: number, skipHistory = false): void {
    const idx = this.tracks.findIndex((x) => x.id === id);
    if (idx < 0) return;
    if (!skipHistory) this.pushHistory(`delete-${id}`);
    const t = this.tracks[idx];
    this.stopTrackNode(t);
    try {
      t.gain.disconnect();
      t.filter.disconnect();
      t.panner.disconnect();
      t.spaceGain.disconnect();
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

  clearAll(skipHistory = false): void {
    if (!skipHistory && this.tracks.length > 0) this.pushHistory("clear-all");
    for (const t of this.tracks) {
      this.stopTrackNode(t);
      try {
        t.gain.disconnect();
        t.filter.disconnect();
        t.panner.disconnect();
        t.spaceGain.disconnect();
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
    const ambience = oac.createConvolver();
    ambience.buffer = createAmbienceImpulse(oac);
    const ambienceWet = oac.createGain();
    ambienceWet.gain.value = 0.45;
    ambience.connect(ambienceWet);
    ambienceWet.connect(oac.destination);
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
      const eq = oac.createBiquadFilter();
      eq.type = "lowpass";
      eq.frequency.value = toneFrequency(t.tone);
      eq.Q.value = 0.7;
      const pn = oac.createStereoPanner();
      pn.pan.value = t.pan;
      const send = oac.createGain();
      send.gain.value = t.space;
      node.connect(gn);
      gn.connect(eq);
      eq.connect(pn);
      pn.connect(t.kind === "loop" ? loopBus : oac.destination);
      if (t.space > 0) {
        pn.connect(send);
        send.connect(ambience);
      }
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
    this.clearAll(true);
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
      this.ambience.disconnect();
      this.ambienceWet.disconnect();
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
