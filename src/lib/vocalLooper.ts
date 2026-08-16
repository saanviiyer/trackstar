// vocalLooper.ts - a loop recorder with harmony overdub stacking that can
// record either the microphone (voice), the instrument (synth output), or a mix
// of both, and play back / export the finished stack.
//
// Capture uses a ScriptProcessorNode (reliable, no extra Vite worklet build) to
// copy the chosen source's Float32 samples into a fixed-length loop buffer. Each
// finished take becomes an AudioBufferSourceNode (loop=true) started on the
// shared loop boundary, so every track stays phase-locked. Tracks route to the
// provided output bus (the synth master record bus) so the master recorder
// captures them too.
//
// Feedback safety: an "Instrument" take taps the synth INSTRUMENT bus (synth +
// effects + vocoder + drums) which does NOT include the loop tracks, so a loop
// never records itself.
//
// The pure math (loop length, mix gain, boundary alignment, export duration,
// source selection, WAV encoding) is exported separately and unit tested.

export const BEATS_PER_BAR = 4;

/** Loop length in samples for `bars` bars at `bpm` (4/4). */
export function loopLengthSamples(
  bpm: number,
  bars: number,
  sampleRate: number,
  beatsPerBar = BEATS_PER_BAR
): number {
  const seconds = (bars * beatsPerBar * 60) / bpm;
  return Math.max(1, Math.round(seconds * sampleRate));
}

/** Loop length in seconds for `bars` bars at `bpm` (4/4). */
export function loopLengthSeconds(
  bpm: number,
  bars: number,
  beatsPerBar = BEATS_PER_BAR
): number {
  return (bars * beatsPerBar * 60) / bpm;
}

/** Total export duration (seconds) for a number of loop cycles. */
export function exportDurationSeconds(cycles: number, loopDurSec: number): number {
  return Math.max(0, cycles) * Math.max(0, loopDurSec);
}

/** Total export length in samples for a number of loop cycles. */
export function exportLengthSamples(
  cycles: number,
  loopDurSec: number,
  sampleRate: number
): number {
  return Math.max(1, Math.ceil(exportDurationSeconds(cycles, loopDurSec) * sampleRate));
}

export type RecordSource = "mic" | "instrument" | "mix";

/** Which physical inputs a source selection needs connected to the recorder. */
export function sourcesForSelection(sel: RecordSource): ("mic" | "instrument")[] {
  if (sel === "mic") return ["mic"];
  if (sel === "instrument") return ["instrument"];
  return ["mic", "instrument"];
}

export interface TrackMix {
  muted: boolean;
  solo: boolean;
  volume: number; // 0..1
}

/**
 * Effective gain for a track in an overdub stack. Muted tracks are silent; if
 * any track is soloed, only soloed tracks are audible; otherwise the track's
 * own volume applies.
 */
export function effectiveGain(t: TrackMix, anySolo: boolean): number {
  if (t.muted) return 0;
  if (anySolo && !t.solo) return 0;
  return Math.max(0, Math.min(1, t.volume));
}

/**
 * Time of the next loop boundary at or after `now`, given the loop's start time
 * and duration. With no established loop (loopStart null) playback can start
 * immediately, so `now` is returned.
 */
export function nextLoopBoundary(
  now: number,
  loopStart: number | null,
  loopDur: number
): number {
  if (loopStart === null || loopDur <= 0) return now;
  const elapsed = now - loopStart;
  if (elapsed <= 0) return loopStart;
  const k = Math.ceil(elapsed / loopDur - 1e-9);
  return loopStart + k * loopDur;
}

/** Encode mono Float32 PCM as a 16-bit WAV file (returns the bytes). */
export function encodeWavBytes(
  samples: Float32Array,
  sampleRate: number
): ArrayBuffer {
  const bytesPerSample = 2;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples.length * bytesPerSample, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += bytesPerSample;
  }
  return buffer;
}

export interface LoopTrackState {
  id: number;
  name: string;
  source: RecordSource;
  muted: boolean;
  solo: boolean;
  volume: number;
  durationSec: number;
}

interface LoopTrack {
  id: number;
  buffer: AudioBuffer;
  gain: GainNode;
  source: AudioBufferSourceNode | null;
  muted: boolean;
  solo: boolean;
  volume: number;
  name: string;
  recordSource: RecordSource;
}

export interface LooperConfig {
  bpm: number;
  bars: number;
  free: boolean;
}

/**
 * Audio-graph controller for the looper. Not exercised by unit tests (needs an
 * AudioContext); the pure helpers above are what get tested.
 */
export class VocalLooper {
  private ctx: AudioContext;
  private output: AudioNode;
  private clickCb: (time: number, accent: boolean) => void;

  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private instrumentNode: AudioNode | null = null;

  private sp: ScriptProcessorNode | null = null;
  private silent: GainNode | null = null;
  private captureSource: AudioNode | null = null;
  private captureMix: GainNode | null = null;

  private tracks: LoopTrack[] = [];
  private loopStart: number | null = null;
  private loopDur = 0; // seconds
  private playing = false;

  private cfg: LooperConfig = { bpm: 120, bars: 2, free: false };
  private recordSource: RecordSource = "mic";

  private recording = false;
  private capture: Float32Array | null = null;
  private writeIdx = 0;
  private freeChunks: Float32Array[] = [];
  private nextId = 1;
  private countInTimer: ReturnType<typeof setTimeout> | null = null;

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
    return this.recording;
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

  setConfig(cfg: LooperConfig): void {
    this.cfg = { ...cfg };
  }
  setRecordSource(sel: RecordSource): void {
    this.recordSource = sel;
  }

  /** Provide the shared mic stream (same one the vocoder uses). */
  setMicStream(stream: MediaStream): void {
    if (this.micStream === stream && this.micSource) return;
    this.micStream = stream;
    this.micSource = this.ctx.createMediaStreamSource(stream);
  }

  /** Provide the instrument tap node (the synth instrument bus). */
  setInstrumentNode(node: AudioNode): void {
    this.instrumentNode = node;
  }

  getStates(): LoopTrackState[] {
    return this.tracks.map((t) => ({
      id: t.id,
      name: t.name,
      source: t.recordSource,
      muted: t.muted,
      solo: t.solo,
      volume: t.volume,
      durationSec: t.buffer.duration,
    }));
  }

  /** True when the current selection has the inputs it needs available. */
  canRecord(): boolean {
    const kinds = sourcesForSelection(this.recordSource);
    for (const k of kinds) {
      if (k === "mic" && !this.micSource) return false;
      if (k === "instrument" && !this.instrumentNode) return false;
    }
    return true;
  }

  /**
   * Arm and begin recording a take. An optional count-in of `countInBars` bars
   * plays metronome clicks first. Bars mode captures a fixed length; free mode
   * captures until stopRecording() when it is the first take.
   */
  arm(countInBars: number): void {
    if (this.recording || !this.canRecord()) return;
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
      const delayMs = clickBars * barDur * 1000;
      this.countInTimer = setTimeout(() => this.beginCapture(), delayMs);
    } else {
      this.beginCapture();
    }
  }

  private resolveCaptureSource(): AudioNode | null {
    const kinds = sourcesForSelection(this.recordSource);
    if (kinds.length === 1) {
      return kinds[0] === "mic" ? this.micSource : this.instrumentNode;
    }
    // Mix: sum mic + instrument into a temporary gain.
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
          ? 0 // free + first take: grow until stop
          : loopLengthSamples(this.cfg.bpm, this.cfg.bars, sr);

    this.writeIdx = 0;
    this.freeChunks = [];
    this.capture = fixedLen > 0 ? new Float32Array(fixedLen) : null;

    const sp = this.ctx.createScriptProcessor(2048, 1, 1);
    const silent = this.ctx.createGain();
    silent.gain.value = 0;
    src.connect(sp);
    sp.connect(silent);
    silent.connect(this.ctx.destination);
    sp.onaudioprocess = (e) => this.onAudio(e);
    this.sp = sp;
    this.silent = silent;
    this.captureSource = src;
    this.onChange?.();
  }

  private onAudio(e: AudioProcessingEvent): void {
    if (!this.recording) return;
    const input = e.inputBuffer.getChannelData(0);
    if (this.capture) {
      const remaining = this.capture.length - this.writeIdx;
      const n = Math.min(remaining, input.length);
      this.capture.set(input.subarray(0, n), this.writeIdx);
      this.writeIdx += n;
      if (this.writeIdx >= this.capture.length) this.finalize();
    } else {
      this.freeChunks.push(new Float32Array(input));
    }
  }

  /** Stop a free-mode first take (fixed takes stop themselves when full). */
  stopRecording(): void {
    if (!this.recording) return;
    if (this.countInTimer) {
      clearTimeout(this.countInTimer);
      this.countInTimer = null;
      this.recording = false;
      this.teardownCapture();
      this.onChange?.();
      return;
    }
    if (!this.capture) {
      const total = this.freeChunks.reduce((a, c) => a + c.length, 0);
      const buf = new Float32Array(Math.max(1, total));
      let o = 0;
      for (const c of this.freeChunks) {
        buf.set(c, o);
        o += c.length;
      }
      this.capture = buf;
      this.writeIdx = buf.length;
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

  private startTrack(track: LoopTrack, when: number): void {
    const source = this.ctx.createBufferSource();
    source.buffer = track.buffer;
    source.loop = true;
    source.connect(track.gain);
    source.start(when);
    track.source = source;
  }

  private stopTrackSource(track: LoopTrack): void {
    if (track.source) {
      try {
        track.source.stop();
      } catch {
        /* ignore */
      }
      try {
        track.source.disconnect();
      } catch {
        /* ignore */
      }
      track.source = null;
    }
  }

  private finalize(): void {
    this.recording = false;
    const data = this.capture ?? new Float32Array(1);
    this.teardownCapture();

    const sr = this.ctx.sampleRate;
    const buffer = this.ctx.createBuffer(1, data.length, sr);
    buffer.getChannelData(0).set(data);

    const gain = this.ctx.createGain();
    gain.connect(this.output);

    const track: LoopTrack = {
      id: this.nextId++,
      buffer,
      gain,
      source: null,
      muted: false,
      solo: false,
      volume: 0.9,
      name: `Take ${this.nextId - 1}`,
      recordSource: this.recordSource,
    };
    this.tracks.push(track);
    this.capture = null;
    this.freeChunks = [];

    if (this.loopStart === null) {
      // First take establishes the loop length and starts the transport.
      this.loopDur = this.cfg.free
        ? buffer.duration
        : loopLengthSeconds(this.cfg.bpm, this.cfg.bars);
      this.playAll();
    } else if (this.playing) {
      // Overdub while playing: align the new track to the running loop.
      const startAt = nextLoopBoundary(
        this.ctx.currentTime + 0.02,
        this.loopStart,
        this.loopDur
      );
      this.startTrack(track, startAt);
      this.applyMix();
    } else {
      // Was stopped: restart the whole stack aligned so overdub monitoring works.
      this.playAll();
    }
    this.onChange?.();
  }

  private applyMix(): void {
    const anySolo = this.tracks.some((t) => t.solo);
    const now = this.ctx.currentTime;
    for (const t of this.tracks) {
      t.gain.gain.setTargetAtTime(effectiveGain(t, anySolo), now, 0.02);
    }
  }

  /** Start every track phase-locked from a fresh loop anchor. */
  playAll(): void {
    if (this.tracks.length === 0 || this.loopDur <= 0) return;
    for (const t of this.tracks) this.stopTrackSource(t);
    const startAt = this.ctx.currentTime + 0.08;
    this.loopStart = startAt;
    for (const t of this.tracks) this.startTrack(t, startAt);
    this.playing = true;
    this.applyMix();
    this.onChange?.();
  }

  /** Stop all loop-track playback (buffers are kept). */
  stopAll(): void {
    for (const t of this.tracks) this.stopTrackSource(t);
    this.playing = false;
    this.onChange?.();
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
      t.volume = volume;
      this.applyMix();
      this.onChange?.();
    }
  }

  deleteTrack(id: number): void {
    const idx = this.tracks.findIndex((x) => x.id === id);
    if (idx < 0) return;
    const t = this.tracks[idx];
    this.stopTrackSource(t);
    t.gain.disconnect();
    this.tracks.splice(idx, 1);
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
      this.stopTrackSource(t);
      t.gain.disconnect();
    }
    this.tracks = [];
    this.loopStart = null;
    this.loopDur = 0;
    this.playing = false;
    this.onChange?.();
  }

  /** WAV bytes for one take, for download. */
  getTrackWav(id: number): ArrayBuffer | null {
    const t = this.tracks.find((x) => x.id === id);
    if (!t) return null;
    return encodeWavBytes(t.buffer.getChannelData(0), this.ctx.sampleRate);
  }

  /**
   * Bounce the whole stack (all non-muted / soloed tracks, summed) for `cycles`
   * loop cycles to a WAV file, via an OfflineAudioContext (fast, click-free).
   */
  async exportMix(cycles: number): Promise<ArrayBuffer | null> {
    if (this.tracks.length === 0 || this.loopDur <= 0) return null;
    const sr = this.ctx.sampleRate;
    const frames = exportLengthSamples(cycles, this.loopDur, sr);
    const oac = new OfflineAudioContext(1, frames, sr);
    const anySolo = this.tracks.some((t) => t.solo);
    let any = false;
    for (const t of this.tracks) {
      const g = effectiveGain(t, anySolo);
      if (g <= 0) continue;
      any = true;
      const s = oac.createBufferSource();
      s.buffer = t.buffer;
      s.loop = true;
      const gn = oac.createGain();
      gn.gain.value = g;
      s.connect(gn);
      gn.connect(oac.destination);
      s.start(0);
    }
    if (!any) return null;
    const rendered = await oac.startRendering();
    return encodeWavBytes(rendered.getChannelData(0), sr);
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
