import { describe, it, expect } from "vitest";
import {
  countToDegree,
  xToInversion,
  yToCutoff,
  mapHandsToSelection,
  type MappingConfig,
} from "./mapping";
import type { HandPose } from "./gestures";

function pose(p: Partial<HandPose>): HandPose {
  return {
    x: 0.1,
    y: 0.5,
    fingers: [false, true, false, false, false],
    extendedCount: 1,
    pinch: 0.8,
    fist: false,
    openness: 0.2,
    ...p,
  };
}

const cfg: MappingConfig = {
  key: { tonic: 0, scale: "major", octave: 4 },
  seventh: false,
  twoHand: false,
};

describe("control curves", () => {
  it("finger count 1..5 maps to degree 0..4", () => {
    expect(countToDegree(1)).toBe(0);
    expect(countToDegree(3)).toBe(2);
    expect(countToDegree(5)).toBe(4);
  });
  it("x thirds select inversion", () => {
    expect(xToInversion(0.1)).toBe(0);
    expect(xToInversion(0.5)).toBe(1);
    expect(xToInversion(0.9)).toBe(2);
  });
  it("top of frame is brighter than bottom", () => {
    expect(yToCutoff(0)).toBeGreaterThan(yToCutoff(1));
  });
});

describe("mapHandsToSelection", () => {
  it("one finger at left => I chord, root position", () => {
    const sel = mapHandsToSelection(pose({ extendedCount: 1, x: 0.1 }), null, cfg);
    expect(sel.rest).toBe(false);
    expect(sel.chord?.label).toBe("I");
    expect(sel.inversion).toBe(0);
    expect(sel.chord?.notes).toEqual([60, 64, 67]);
  });

  it("fist => rest / muted", () => {
    const sel = mapHandsToSelection(pose({ fist: true, extendedCount: 0 }), null, cfg);
    expect(sel.rest).toBe(true);
    expect(sel.chord).toBeNull();
  });

  it("no hand => rest", () => {
    const sel = mapHandsToSelection(null, null, cfg);
    expect(sel.rest).toBe(true);
  });

  it("two-hand diatonic: open left hand + 1 finger => vi (Am)", () => {
    const sel = mapHandsToSelection(
      pose({ extendedCount: 1, x: 0.1 }),
      pose({ extendedCount: 5 }),
      { ...cfg, twoHand: true }
    );
    expect(sel.octaveShift).toBe(0); // octave shift replaced by degree offset
    expect(sel.degree).toBe(5);
    expect(sel.chord?.label).toBe("vi");
    expect(sel.chord?.notes).toEqual([69, 72, 76]); // A4 C5 E5 = Am
  });

  it("two-hand diatonic: open left hand + 2 fingers => vii (Bdim)", () => {
    const sel = mapHandsToSelection(
      pose({ extendedCount: 2, x: 0.1 }),
      pose({ extendedCount: 5 }),
      { ...cfg, twoHand: true }
    );
    expect(sel.degree).toBe(6);
    expect(sel.chord?.label).toBe("vii°");
    expect(sel.chord?.notes).toEqual([71, 74, 77]); // B4 D5 F5 = Bdim
  });

  it("two-hand diatonic: degree offset clamps at vii (no overshoot)", () => {
    const sel = mapHandsToSelection(
      pose({ extendedCount: 5, x: 0.1 }), // 4 + 5 = 9 -> clamp 6
      pose({ extendedCount: 5 }),
      { ...cfg, twoHand: true }
    );
    expect(sel.degree).toBe(6);
    expect(sel.chord?.label).toBe("vii°");
  });

  it("two-hand diatonic: a closed/low left hand adds no offset (still I-V)", () => {
    const sel = mapHandsToSelection(
      pose({ extendedCount: 1, x: 0.1 }),
      pose({ extendedCount: 0, fist: true }),
      { ...cfg, twoHand: true }
    );
    expect(sel.degree).toBe(0);
    expect(sel.chord?.label).toBe("I");
  });
});
