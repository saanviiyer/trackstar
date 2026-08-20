import { describe, it, expect } from "vitest";
import {
  bandFrequencies,
  opennessToWet,
  handWetTarget,
  makeWetHoldState,
} from "./vocoder";

describe("bandFrequencies", () => {
  it("returns exactly n frequencies", () => {
    expect(bandFrequencies(24, 110, 7500)).toHaveLength(24);
    expect(bandFrequencies(1, 110, 7500)).toHaveLength(1);
  });

  it("spans the requested range at the endpoints", () => {
    const f = bandFrequencies(24, 110, 7500);
    expect(f[0]).toBeCloseTo(110, 6);
    expect(f[f.length - 1]).toBeCloseTo(7500, 3);
  });

  it("increases monotonically", () => {
    const f = bandFrequencies(24, 110, 7500);
    for (let i = 1; i < f.length; i++) expect(f[i]).toBeGreaterThan(f[i - 1]);
  });

  it("is log-spaced (constant ratio between neighbors)", () => {
    const f = bandFrequencies(12, 100, 6400);
    const r0 = f[1] / f[0];
    for (let i = 2; i < f.length; i++) {
      expect(f[i] / f[i - 1]).toBeCloseTo(r0, 6);
    }
  });
});

describe("opennessToWet mapping", () => {
  it("a closed/relaxed hand is dry", () => {
    expect(opennessToWet(0)).toBe(0);
    expect(opennessToWet(0.05)).toBe(0); // inside the dead zone
  });

  it("a wide-open hand is full wet", () => {
    expect(opennessToWet(1)).toBeCloseTo(1, 6);
  });

  it("is monotonic non-decreasing in openness", () => {
    let prev = -1;
    for (let o = 0; o <= 1.0001; o += 0.05) {
      const w = opennessToWet(o);
      expect(w).toBeGreaterThanOrEqual(prev);
      prev = w;
    }
  });

  it("stays within [0,1] and clamps out-of-range input", () => {
    expect(opennessToWet(-1)).toBe(0);
    expect(opennessToWet(5)).toBeCloseTo(1, 6);
    for (let o = 0; o <= 1; o += 0.1) {
      const w = opennessToWet(o);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
    }
  });

  it("a half-open hand is partially wet", () => {
    const w = opennessToWet(0.5);
    expect(w).toBeGreaterThan(0.2);
    expect(w).toBeLessThan(0.8);
  });
});

describe("handWetTarget (dropout hold + wet floor)", () => {
  const FLOOR = 0.12;
  const HOLD = 12;

  it("tracks a good openness reading directly (above the floor)", () => {
    const st = makeWetHoldState();
    const w = handWetTarget(1, st, FLOOR, HOLD);
    expect(w).toBeCloseTo(1, 6);
    expect(st.missing).toBe(0);
    expect(st.lastOpenness).toBe(1);
  });

  it("never drops below the floor while enabled, even fully closed", () => {
    const st = makeWetHoldState();
    expect(handWetTarget(0, st, FLOOR, HOLD)).toBeCloseTo(FLOOR, 6);
    // Missing hand on the very first frame is still floored, not slammed lower.
    expect(handWetTarget(null, makeWetHoldState(), FLOOR, HOLD)).toBeCloseTo(
      FLOOR,
      6
    );
  });

  it("HOLDS the last wet value through a brief tracking dropout", () => {
    const st = makeWetHoldState();
    handWetTarget(1, st, FLOOR, HOLD); // open, full wet
    // A handful of missing frames within the hold window keep it full wet.
    for (let i = 0; i < HOLD; i++) {
      expect(handWetTarget(null, st, FLOOR, HOLD)).toBeCloseTo(1, 6);
    }
    expect(st.lastOpenness).toBe(1);
  });

  it("glides down (does not snap to dry) after the hold window", () => {
    const st = makeWetHoldState();
    handWetTarget(1, st, FLOOR, HOLD);
    for (let i = 0; i < HOLD; i++) handWetTarget(null, st, FLOOR, HOLD);
    const held = handWetTarget(null, st, FLOOR, HOLD); // first frame past hold
    const later = handWetTarget(null, st, FLOOR, HOLD);
    expect(later).toBeLessThan(held); // decaying
    expect(later).toBeGreaterThanOrEqual(FLOOR); // but never below floor
  });

  it("recovers immediately when the hand comes back", () => {
    const st = makeWetHoldState();
    handWetTarget(1, st, FLOOR, HOLD);
    for (let i = 0; i < HOLD + 20; i++) handWetTarget(null, st, FLOOR, HOLD);
    const back = handWetTarget(0.9, st, FLOOR, HOLD);
    expect(back).toBeGreaterThan(0.5);
    expect(st.missing).toBe(0);
  });

  it("stays within [floor, 1] for any input", () => {
    const st = makeWetHoldState();
    for (const o of [-3, 0, 0.3, 0.7, 1, 5, null]) {
      const w = handWetTarget(o as number | null, st, FLOOR, HOLD);
      expect(w).toBeGreaterThanOrEqual(FLOOR);
      expect(w).toBeLessThanOrEqual(1);
    }
  });
});
