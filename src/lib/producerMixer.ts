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
  encodeWavBytes,
  sourcesForSelection,
  type RecordSource,
  type TrackMix,
} from "./vocalLooper";

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
}

export interface MixerConfig {
  bpm: number;
  bars: number;
  free: boolean;
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
}

/**
 * Audio-graph controller. Needs a real AudioContext, so it is not unit tested
 * directly; the pure helpers above (and the reused looper helpers) are.
 */
export class ProducerMixer {
  private ctx: AudioContext;
  private output: AudioNode;
  private clickCb: (time: number, accent: boolean) => void;

  private micSource: MediaStreamAudioSourceNode | null = null;
  private micStream: MediaStream | null = null;
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

  private tracks: MixerTrack[] = [];
  private loopStart: number | null = null;
  private loopDur = 0; // seconds (from the first recorded loop)
  private playing = false;
  private nextId = 1;

  private cfg: MixerConfig = { bpm: 120, bars: 2, free: false };

  onChange: (() => void) | null = null;

  constructor(
    ctx: AudioContext,
    output: AudioNode,
    clickCb: (time: number, accent: boolean) => void
  ) {
    this.ctx = ctx;
    this.output = output;
    this.clickCb = clickCb;
  }

  get isRecording(): boolean {
    return this.recording || this.countInTimer !== null;
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
  setMicStream(stream: MediaStream): void {
    if (this.micStream === stream && this.micSource) return;
    this.micStream = stream;
    this.micSource = this.ctx.createMediaStreamSource(stream);
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
    }));
  }

  // --- track construction ---

  private makeTrack(
    buffer: AudioBuffer,
    name: string,
    kind: TrackKind,
    role: string,
    source: RecordSource | "ai",
    pan: number
  ): MixerTrack {
    const gain = this.ctx.createGain();
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = clampPan(pan);
    gain.gain.value = 0.9;
    gain.connect(panner);
    panner.connect(this.output);
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
    node.start(when);
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

  arm(countInBars: number): void {
    if (this.recording || this.countInTimer || !this.canRecord()) return;
    const barDur = (60 / this.cfg.bpm) * BEATS_PER_BAR;
    const clickBars = Math.max(0, Math.floor(countInBars));
    if (clickBars > 0) {
      const now = this.ctx.currentTime + 0.06;
      for (let b = 0; b < clickBars; b++) {
        for (let beat = 0; beat < BEATS_PER_BAR; beat++) {
          const t = now + (b * BEATS_PER_BAR + beat) * (60 / this.cfg.bpm);
          this.clickCb(t, beat === 0);
        }
      }
      this.countInTimer = setTimeout(
        () => {
          this.countInTimer = null;
          this.beginCapture();
        },
        clickBars * barDur * 1000
      );
      this.onChange?.();
    } else {
      this.beginCapture();
    }
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

  stopRecording(): void {
    if (this.countInTimer) {
      clearTimeout(this.countInTimer);
      this.countInTimer = null;
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
      `Loop ${this.nextId - 1}`,
      "loop",
      "loop",
      this.recordSource,
      0
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
    this.onChange?.();
  }

  stopAll(): void {
    for (const t of this.tracks) this.stopTrackNode(t);
    this.playing = false;
    this.onChange?.();
  }

  private applyMix(): void {
    const anySolo = this.tracks.some((t) => t.solo);
    const now = this.ctx.currentTime;
    for (const t of this.tracks) {
      const mix: TrackMix = { muted: t.muted, solo: t.solo, volume: t.volume };
      t.gain.gain.setTargetAtTime(effectiveGain(mix, anySolo), now, 0.02);
    }
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
      source.pan
    );
    copy.volume = source.volume;
    copy.muted = source.muted;
    copy.solo = source.solo;
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
        saved.pan
      );
      track.muted = !!saved.muted;
      track.solo = !!saved.solo;
      track.volume = Math.max(0, Math.min(1, saved.volume));
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
      gn.gain.value = g;
      const pn = oac.createStereoPanner();
      pn.pan.value = t.pan;
      node.connect(gn);
      gn.connect(pn);
      pn.connect(oac.destination);
      node.start(0);
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
    this.recording = false;
    this.teardownCapture();
    this.clearAll();
    if (this.micSource) {
      try {
        this.micSource.disconnect();
      } catch {
        /* ignore */
      }
      this.micSource = null;
    }
  }
}
