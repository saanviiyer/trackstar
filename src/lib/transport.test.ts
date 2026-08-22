import { describe, it, expect } from "vitest";
import {
  secondsPerBeat,
  secondsPerBar,
  loopLengthSec,
  countInSec,
  barBeatFromPosition,
  loopPositionSec,
  cycleIndex,
  wrapBufferOffset,
  computePeaks,
  clampRange,
  moveClip,
  deleteClip,
  duplicateClip,
  trimClip,
  type Clip,
} from "./transport";

describe("bar/beat <-> seconds", () => {
  it("computes beat and bar durations", () => {
    expect(secondsPerBeat(120)).toBeCloseTo(0.5);
    expect(secondsPerBar(120, 4)).toBeCloseTo(2);
    expect(secondsPerBar(120, 3)).toBeCloseTo(1.5);
  });
  it("computes loop and count-in lengths", () => {
    expect(loopLengthSec(120, 2, 4)).toBeCloseTo(4);
    expect(loopLengthSec(60, 1, 4)).toBeCloseTo(4);
    expect(countInSec(1, 120, 4)).toBeCloseTo(2);
    expect(countInSec(2, 120, 4)).toBeCloseTo(4);
  });
  it("guards against zero/negative bpm", () => {
    expect(secondsPerBeat(0)).toBe(60);
  });
});

describe("barBeatFromPosition", () => {
  it("reports 1.1 at the loop start", () => {
    const bb = barBeatFromPosition(0, 120, 4);
    expect(bb).toMatchObject({ bar: 1, beat: 1 });
    expect(bb.beatFraction).toBeCloseTo(0);
  });
  it("advances beats and bars", () => {
    // 120 bpm -> 0.5s/beat. 2.5s = beat index 5 -> bar 2, beat 2, half through.
    const bb = barBeatFromPosition(2.5, 120, 4);
    expect(bb.bar).toBe(2);
    expect(bb.beat).toBe(2);
    expect(bb.beatFraction).toBeCloseTo(0);
  });
  it("wraps within the loop when barsInLoop is given", () => {
    // 2-bar loop at 120bpm = 4s. Position 4.5s wraps to 0.5s -> bar1 beat2.
    const bb = barBeatFromPosition(4.5, 120, 4, 2);
    expect(bb.bar).toBe(1);
    expect(bb.beat).toBe(2);
  });
});

describe("loopPositionSec + cycleIndex (cycle-record scheduling)", () => {
  it("is zero before an anchor exists", () => {
    expect(loopPositionSec(10, null, 4)).toBe(0);
    expect(cycleIndex(10, null, 4)).toBe(0);
  });
  it("wraps the position within the cycle", () => {
    expect(loopPositionSec(105, 100, 4)).toBeCloseTo(1); // 5s in, 4s loop -> 1s
    expect(loopPositionSec(100, 100, 4)).toBe(0);
  });
  it("counts completed cycles for take labelling", () => {
    expect(cycleIndex(100, 100, 4)).toBe(0);
    expect(cycleIndex(103.9, 100, 4)).toBe(0);
    expect(cycleIndex(104, 100, 4)).toBe(1);
    expect(cycleIndex(108.2, 100, 4)).toBe(2);
  });
});

describe("wrapBufferOffset (phase-lock rotation for clip move)", () => {
  it("is zero for no offset", () => {
    expect(wrapBufferOffset(0, 4)).toBeCloseTo(0);
  });
  it("rotates content so a later start reads earlier in the buffer", () => {
    // shift 1s later in a 4s loop -> read from 3s in.
    expect(wrapBufferOffset(1, 4)).toBeCloseTo(3);
  });
  it("wraps offsets larger than the loop", () => {
    expect(wrapBufferOffset(5, 4)).toBeCloseTo(3); // 5 -> 1 shift -> read 3
  });
  it("is safe for a zero-length loop", () => {
    expect(wrapBufferOffset(1, 0)).toBe(0);
  });
});

describe("computePeaks", () => {
  it("returns one bucket per request", () => {
    const s = new Float32Array([0, 0.2, -0.9, 0.4, 0.1, -0.3]);
    expect(computePeaks(s, 3)).toHaveLength(3);
  });
  it("reports the peak magnitude per bucket", () => {
    const s = new Float32Array([0.1, -0.5, 0.9, -0.2]);
    const peaks = computePeaks(s, 2);
    expect(peaks[0]).toBeCloseTo(0.5);
    expect(peaks[1]).toBeCloseTo(0.9);
  });
  it("handles empty input", () => {
    expect(computePeaks(new Float32Array(0), 4)).toEqual([0, 0, 0, 0]);
  });
});

describe("clampRange", () => {
  it("clamps and maps NaN to the low bound", () => {
    expect(clampRange(5, 0, 3)).toBe(3);
    expect(clampRange(-1, 0, 3)).toBe(0);
    expect(clampRange(NaN, 2, 9)).toBe(2);
  });
});

describe("clip/timeline model", () => {
  const base: Clip[] = [
    { id: 1, trackId: 10, startSec: 0, durationSec: 4, offsetSec: 0 },
    { id: 2, trackId: 11, startSec: 1, durationSec: 2, offsetSec: 0 },
  ];

  it("moves a clip and clamps it inside the loop", () => {
    const out = moveClip(base, 2, 3, 4);
    // duration 2 in a 4s loop -> max start 2
    expect(out.find((c) => c.id === 2)!.startSec).toBe(2);
    // negative clamps to 0
    expect(moveClip(base, 2, -5, 4).find((c) => c.id === 2)!.startSec).toBe(0);
    // other clip untouched, new array
    expect(out).not.toBe(base);
    expect(out.find((c) => c.id === 1)!.startSec).toBe(0);
  });

  it("deletes a clip", () => {
    const out = deleteClip(base, 1);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(2);
  });

  it("duplicates a clip with a nudge and new id", () => {
    const out = duplicateClip(base, 1, 99, 0.5, 8);
    expect(out).toHaveLength(3);
    const copy = out.find((c) => c.id === 99)!;
    expect(copy.trackId).toBe(10);
    expect(copy.startSec).toBeCloseTo(0.5);
  });

  it("returns input unchanged when duplicating a missing clip", () => {
    expect(duplicateClip(base, 404, 5, 0, 8)).toBe(base);
  });

  it("trims a clip and advances the read offset by the head trim", () => {
    const out = trimClip(base, 1, 1, 3, 4);
    const c = out.find((cl) => cl.id === 1)!;
    expect(c.startSec).toBeCloseTo(1);
    expect(c.durationSec).toBeCloseTo(2);
    expect(c.offsetSec).toBeCloseTo(1); // head trimmed by 1s
  });

  it("keeps a minimum trim duration", () => {
    const out = trimClip(base, 1, 2, 2, 4, 0.1);
    const c = out.find((cl) => cl.id === 1)!;
    expect(c.durationSec).toBeGreaterThanOrEqual(0.1);
  });
});
