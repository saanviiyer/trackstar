// transport.ts - pure transport + timeline math for Trackstar's Producer DAW.
//
// None of this touches the Web Audio graph, so it is all unit tested. The audio
// engine (producerMixer.ts) and the timeline view (Timeline.tsx) consume these
// helpers so the bar/beat clock, the cycle-record scheduling offsets, the
// waveform peaks, and the clip model behave identically to their tests.

export const DEFAULT_BEATS_PER_BAR = 4;

/** Seconds per quarter-note beat at `bpm`. */
export function secondsPerBeat(bpm: number): number {
  return 60 / Math.max(1, bpm);
}

/** Seconds in one bar of `beatsPerBar` beats at `bpm`. */
export function secondsPerBar(bpm: number, beatsPerBar = DEFAULT_BEATS_PER_BAR): number {
  return secondsPerBeat(bpm) * Math.max(1, beatsPerBar);
}

/** Length of a `bars`-bar loop in seconds. */
export function loopLengthSec(
  bpm: number,
  bars: number,
  beatsPerBar = DEFAULT_BEATS_PER_BAR
): number {
  return secondsPerBar(bpm, beatsPerBar) * Math.max(0, bars);
}

/** Duration of a `bars`-bar count-in in seconds. */
export function countInSec(
  bars: number,
  bpm: number,
  beatsPerBar = DEFAULT_BEATS_PER_BAR
): number {
  return loopLengthSec(bpm, Math.max(0, bars), beatsPerBar);
}

export interface BarBeat {
  /** 1-based bar number within the loop. */
  bar: number;
  /** 1-based beat within the bar. */
  beat: number;
  /** 0..1 progress through the current beat. */
  beatFraction: number;
}

/**
 * Convert a position (seconds, measured from the loop start) into a musical
 * bar/beat readout. Wraps within `barsInLoop` when given so the transport
 * counter cycles 1.1 .. bars.beats and repeats.
 */
export function barBeatFromPosition(
  posSec: number,
  bpm: number,
  beatsPerBar = DEFAULT_BEATS_PER_BAR,
  barsInLoop = 0
): BarBeat {
  const beatDur = secondsPerBeat(bpm);
  const totalBeats = Math.max(0, posSec) / beatDur;
  let beatIndex = Math.floor(totalBeats);
  const beatFraction = totalBeats - beatIndex;
  if (barsInLoop > 0) {
    const loopBeats = barsInLoop * beatsPerBar;
    beatIndex = ((beatIndex % loopBeats) + loopBeats) % loopBeats;
  }
  const bar = Math.floor(beatIndex / beatsPerBar) + 1;
  const beat = (beatIndex % beatsPerBar) + 1;
  return { bar, beat, beatFraction };
}

/**
 * Position within the current loop cycle, in seconds (0 .. loopDur). Returns 0
 * when the transport has no anchor or no length.
 */
export function loopPositionSec(
  now: number,
  loopStart: number | null,
  loopDur: number
): number {
  if (loopStart === null || loopDur <= 0) return 0;
  const elapsed = now - loopStart;
  if (elapsed <= 0) return 0;
  return elapsed - Math.floor(elapsed / loopDur) * loopDur;
}

/**
 * How many whole loop cycles have completed since `loopStart` (0 before the
 * first boundary). Used to label cycle-record takes.
 */
export function cycleIndex(
  now: number,
  loopStart: number | null,
  loopDur: number
): number {
  if (loopStart === null || loopDur <= 0) return 0;
  const elapsed = now - loopStart;
  if (elapsed <= 0) return 0;
  return Math.floor(elapsed / loopDur);
}

/**
 * The buffer read offset (seconds) needed so a looping take's content appears to
 * start `offsetSec` later within the cycle. A take started at the loop boundary
 * with this read offset is rotated so its downbeat lands `offsetSec` into the
 * loop. Always in [0, loopDur).
 */
export function wrapBufferOffset(offsetSec: number, loopDur: number): number {
  if (loopDur <= 0) return 0;
  const raw = (loopDur - offsetSec) % loopDur;
  return ((raw % loopDur) + loopDur) % loopDur;
}

// ---------------------------------------------------------------------------
// Waveform peaks
// ---------------------------------------------------------------------------

/**
 * Downsample mono samples to `buckets` peak-magnitude values (max |x| per
 * bucket) for drawing a clip waveform. Never returns fewer than one bucket.
 */
export function computePeaks(samples: Float32Array, buckets: number): number[] {
  const n = Math.max(1, Math.floor(buckets));
  const out = new Array<number>(n).fill(0);
  if (samples.length === 0) return out;
  const per = samples.length / n;
  for (let b = 0; b < n; b++) {
    const start = Math.floor(b * per);
    const end = Math.min(samples.length, Math.floor((b + 1) * per));
    let peak = 0;
    for (let i = start; i < end; i++) {
      const a = Math.abs(samples[i]);
      if (a > peak) peak = a;
    }
    out[b] = peak;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Clip / timeline model (pure)
// ---------------------------------------------------------------------------

export interface Clip {
  id: number;
  trackId: number;
  /** Start of the clip within the loop cycle, in seconds. */
  startSec: number;
  /** Visible length of the clip, in seconds. */
  durationSec: number;
  /** Read offset into the source buffer (seconds) for trims from the head. */
  offsetSec: number;
}

/** Clamp a value into [lo, hi]. */
export function clampRange(value: number, lo: number, hi: number): number {
  if (Number.isNaN(value)) return lo;
  return Math.max(lo, Math.min(hi, value));
}

/**
 * Move a clip so its start becomes `newStartSec`, clamped so the clip stays
 * inside [0, loopDur]. Returns a new array; other clips are untouched.
 */
export function moveClip(
  clips: Clip[],
  id: number,
  newStartSec: number,
  loopDur: number
): Clip[] {
  return clips.map((c) => {
    if (c.id !== id) return c;
    const maxStart = Math.max(0, loopDur - c.durationSec);
    return { ...c, startSec: clampRange(newStartSec, 0, maxStart) };
  });
}

/** Remove a clip by id. Returns a new array. */
export function deleteClip(clips: Clip[], id: number): Clip[] {
  return clips.filter((c) => c.id !== id);
}

/**
 * Duplicate a clip, giving the copy `newId` and nudging it by `offsetSec`
 * (clamped to the loop). Returns a new array with the copy appended.
 */
export function duplicateClip(
  clips: Clip[],
  id: number,
  newId: number,
  offsetSec: number,
  loopDur: number
): Clip[] {
  const src = clips.find((c) => c.id === id);
  if (!src) return clips;
  const maxStart = Math.max(0, loopDur - src.durationSec);
  const copy: Clip = {
    ...src,
    id: newId,
    startSec: clampRange(src.startSec + offsetSec, 0, maxStart),
  };
  return [...clips, copy];
}

/**
 * Trim a clip to the region [newStartSec, newEndSec] within the loop, keeping at
 * least `minDur` seconds. The source read offset is advanced so the audio under
 * the new head still lines up. Returns a new array.
 */
export function trimClip(
  clips: Clip[],
  id: number,
  newStartSec: number,
  newEndSec: number,
  loopDur: number,
  minDur = 0.05
): Clip[] {
  return clips.map((c) => {
    if (c.id !== id) return c;
    const oldStart = c.startSec;
    const start = clampRange(newStartSec, 0, loopDur - minDur);
    const end = clampRange(newEndSec, start + minDur, loopDur);
    const headTrim = start - oldStart;
    return {
      ...c,
      startSec: start,
      durationSec: end - start,
      offsetSec: Math.max(0, c.offsetSec + headTrim),
    };
  });
}
