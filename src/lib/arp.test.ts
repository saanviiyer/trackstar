import { describe, it, expect } from "vitest";
import {
  arpSequence,
  expandOctaves,
  DIVISION_BEATS,
} from "./arp";

// C major triad, MIDI: C4 E4 G4
const CEG = [60, 64, 67];

describe("expandOctaves", () => {
  it("1 octave = the chord itself (sorted, de-duped)", () => {
    expect(expandOctaves([67, 60, 64], 1)).toEqual([60, 64, 67]);
  });
  it("2 octaves stacks a +12 copy", () => {
    expect(expandOctaves(CEG, 2)).toEqual([60, 64, 67, 72, 76, 79]);
  });
  it("3 octaves", () => {
    expect(expandOctaves(CEG, 3)).toEqual([
      60, 64, 67, 72, 76, 79, 84, 88, 91,
    ]);
  });
});

describe("arpSequence - patterns (1 octave)", () => {
  it("up = ascending", () => {
    expect(arpSequence(CEG, "up", 1)).toEqual([60, 64, 67]);
  });
  it("down = descending", () => {
    expect(arpSequence(CEG, "down", 1)).toEqual([67, 64, 60]);
  });
  it("updown = up then down without repeating extremes", () => {
    expect(arpSequence(CEG, "updown", 1)).toEqual([60, 64, 67, 64]);
  });
  it("random returns the ascending pool (scheduler samples it)", () => {
    expect(arpSequence(CEG, "random", 1)).toEqual([60, 64, 67]);
  });
});

describe("arpSequence - 2-octave range", () => {
  it("up over 2 octaves", () => {
    expect(arpSequence(CEG, "up", 2)).toEqual([60, 64, 67, 72, 76, 79]);
  });
  it("down over 2 octaves", () => {
    expect(arpSequence(CEG, "down", 2)).toEqual([79, 76, 72, 67, 64, 60]);
  });
  it("updown over 2 octaves", () => {
    expect(arpSequence(CEG, "updown", 2)).toEqual([
      60, 64, 67, 72, 76, 79, 76, 72, 67, 64,
    ]);
  });
});

describe("arpSequence - edge cases", () => {
  it("single note over 1 octave yields a one-element sequence", () => {
    for (const p of ["up", "down", "updown", "random"] as const) {
      expect(arpSequence([60], p, 1)).toEqual([60]);
    }
  });
  it("empty chord yields an empty sequence", () => {
    expect(arpSequence([], "up", 2)).toEqual([]);
  });
});

describe("division timing", () => {
  it("1/8 is half a beat, 1/16 a quarter", () => {
    expect(DIVISION_BEATS["1/4"]).toBe(1);
    expect(DIVISION_BEATS["1/8"]).toBe(0.5);
    expect(DIVISION_BEATS["1/16"]).toBe(0.25);
  });
  it("triplet divisions are thirds of the straight value", () => {
    expect(DIVISION_BEATS["1/8T"]).toBeCloseTo(1 / 3, 10);
    expect(DIVISION_BEATS["1/16T"]).toBeCloseTo(1 / 6, 10);
  });
});
