import { describe, it, expect } from "vitest";
import {
  fingersExtended,
  extendedCount,
  isFist,
  pinchDistance,
  isPinching,
  readHand,
  handOpenness,
  type Landmark,
} from "./gestures";

// Build a 21-landmark hand from per-index overrides on a neutral base.
// Coordinate frame: x right, y down; hand points up (extended tips = small y).
function makeHand(overrides: Record<number, [number, number]>): Landmark[] {
  const lm: Landmark[] = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 }));
  for (const [k, [x, y]] of Object.entries(overrides)) {
    lm[Number(k)] = { x, y };
  }
  return lm;
}

// Fingers pointing up, well extended.
const OPEN_HAND = makeHand({
  0: [0.5, 1.0], // wrist
  // thumb
  1: [0.4, 0.9],
  2: [0.35, 0.8],
  3: [0.3, 0.72],
  4: [0.25, 0.65],
  // index
  5: [0.45, 0.7],
  6: [0.45, 0.55],
  7: [0.45, 0.45],
  8: [0.45, 0.35],
  // middle
  9: [0.5, 0.7],
  10: [0.5, 0.53],
  11: [0.5, 0.42],
  12: [0.5, 0.3],
  // ring
  13: [0.55, 0.7],
  14: [0.55, 0.55],
  15: [0.55, 0.45],
  16: [0.55, 0.37],
  // pinky
  17: [0.6, 0.72],
  18: [0.6, 0.6],
  19: [0.6, 0.52],
  20: [0.6, 0.45],
});

// Curled fingers: tips fall back toward the palm (larger y than their PIP).
const FIST = makeHand({
  0: [0.5, 1.0],
  1: [0.4, 0.9],
  2: [0.35, 0.8],
  3: [0.4, 0.83],
  4: [0.45, 0.82], // thumb curled across
  5: [0.45, 0.7],
  6: [0.45, 0.55],
  8: [0.45, 0.75], // index tip curled
  9: [0.5, 0.7],
  10: [0.5, 0.53],
  12: [0.5, 0.78],
  13: [0.55, 0.7],
  14: [0.55, 0.55],
  16: [0.55, 0.78],
  17: [0.6, 0.72],
  18: [0.6, 0.6],
  20: [0.6, 0.8],
});

// Index + middle extended, ring + pinky + thumb curled ("peace sign").
const TWO_FINGERS = makeHand({
  0: [0.5, 1.0],
  1: [0.4, 0.9],
  2: [0.35, 0.8],
  4: [0.45, 0.82], // thumb curled
  5: [0.45, 0.7],
  6: [0.45, 0.55],
  8: [0.45, 0.35], // index extended
  9: [0.5, 0.7],
  10: [0.5, 0.53],
  12: [0.5, 0.3], // middle extended
  13: [0.55, 0.7],
  14: [0.55, 0.55],
  16: [0.55, 0.78], // ring curled
  17: [0.6, 0.72],
  18: [0.6, 0.6],
  20: [0.6, 0.8], // pinky curled
});

// Open hand but thumb tip brought to the index tip (pinch).
const PINCH = makeHand({
  ...Object.fromEntries(OPEN_HAND.map((p, i) => [i, [p.x, p.y]])),
  4: [0.45, 0.36], // thumb tip near index tip (0.45,0.35)
} as Record<number, [number, number]>);

describe("fingersExtended", () => {
  it("open hand => all five extended", () => {
    expect(fingersExtended(OPEN_HAND)).toEqual([true, true, true, true, true]);
    expect(extendedCount(OPEN_HAND)).toBe(5);
  });

  it("fist => none extended", () => {
    expect(extendedCount(FIST)).toBe(0);
    expect(isFist(FIST)).toBe(true);
  });

  it("peace sign => index + middle only", () => {
    // [thumb, index, middle, ring, pinky]
    expect(fingersExtended(TWO_FINGERS)).toEqual([
      false,
      true,
      true,
      false,
      false,
    ]);
    expect(extendedCount(TWO_FINGERS)).toBe(2);
  });
});

describe("pinch classification", () => {
  it("open hand is not pinching (thumb far from index)", () => {
    expect(isPinching(OPEN_HAND)).toBe(false);
    expect(pinchDistance(OPEN_HAND)).toBeGreaterThan(0.35);
  });

  it("thumb touching index is pinching", () => {
    expect(isPinching(PINCH)).toBe(true);
    expect(pinchDistance(PINCH)).toBeLessThan(0.2);
  });

  it("pinch distance is normalized (scale-invariant)", () => {
    // Scale the whole open hand by 0.5 about the origin; pinch ratio unchanged.
    const scaled = OPEN_HAND.map((p) => ({ x: p.x * 0.5, y: p.y * 0.5 }));
    expect(pinchDistance(scaled)).toBeCloseTo(pinchDistance(OPEN_HAND), 6);
  });
});

describe("readHand summary", () => {
  it("reports center within the frame and correct finger count", () => {
    const pose = readHand(OPEN_HAND);
    expect(pose.extendedCount).toBe(5);
    expect(pose.fist).toBe(false);
    expect(pose.x).toBeGreaterThan(0);
    expect(pose.x).toBeLessThan(1);
    expect(pose.y).toBeGreaterThan(0);
    expect(pose.y).toBeLessThan(1);
  });

  it("fist pose flags rest", () => {
    expect(readHand(FIST).fist).toBe(true);
  });
});

describe("handOpenness", () => {
  it("is high for an open hand and low for a fist", () => {
    const open = handOpenness(OPEN_HAND);
    const closed = handOpenness(FIST);
    expect(open).toBeGreaterThan(0.6);
    expect(closed).toBeLessThan(0.3);
    expect(open).toBeGreaterThan(closed);
  });

  it("is clamped to [0,1]", () => {
    for (const h of [OPEN_HAND, FIST, TWO_FINGERS, PINCH]) {
      const o = handOpenness(h);
      expect(o).toBeGreaterThanOrEqual(0);
      expect(o).toBeLessThanOrEqual(1);
    }
  });

  it("is scale-invariant (normalized by hand size)", () => {
    const scaled = OPEN_HAND.map((p) => ({ x: p.x * 0.5, y: p.y * 0.5 }));
    expect(handOpenness(scaled)).toBeCloseTo(handOpenness(OPEN_HAND), 6);
  });

  it("is exposed on the HandPose from readHand", () => {
    expect(readHand(OPEN_HAND).openness).toBeGreaterThan(0.6);
  });
});
