import { describe, it, expect } from "vitest";
import {
  DRUM_PATTERNS,
  DRUM_PATTERN_NAMES,
  drumHits,
  metronomeClick,
  STEPS_PER_BAR,
} from "./drums";

describe("drum pattern catalog", () => {
  it("has the required patterns", () => {
    for (const n of ["Off", "Four-on-floor", "Boom-bap", "Hi-hat 8ths"]) {
      expect(DRUM_PATTERN_NAMES).toContain(n);
    }
  });
  it("every pattern lane is exactly one bar of 16 steps", () => {
    for (const name of DRUM_PATTERN_NAMES) {
      const p = DRUM_PATTERNS[name];
      expect(p.kick).toHaveLength(STEPS_PER_BAR);
      expect(p.snare).toHaveLength(STEPS_PER_BAR);
      expect(p.hat).toHaveLength(STEPS_PER_BAR);
    }
  });
});

describe("drumHits", () => {
  it("Four-on-floor kicks on every quarter (0,4,8,12)", () => {
    for (const s of [0, 4, 8, 12]) expect(drumHits("Four-on-floor", s).kick).toBe(true);
    for (const s of [1, 2, 3, 5, 6, 7]) expect(drumHits("Four-on-floor", s).kick).toBe(false);
  });
  it("Four-on-floor snares on beats 2 and 4 (steps 4,12)", () => {
    expect(drumHits("Four-on-floor", 4).snare).toBe(true);
    expect(drumHits("Four-on-floor", 12).snare).toBe(true);
    expect(drumHits("Four-on-floor", 0).snare).toBe(false);
  });
  it("Four-on-floor hats on 8ths (even steps)", () => {
    for (let s = 0; s < 16; s++) {
      expect(drumHits("Four-on-floor", s).hat).toBe(s % 2 === 0);
    }
  });
  it("Off pattern never hits", () => {
    for (let s = 0; s < 16; s++) {
      const h = drumHits("Off", s);
      expect(h.kick || h.snare || h.hat).toBe(false);
    }
  });
  it("Boom-bap kicks on 0 and 10, snares on 4 and 12", () => {
    expect(drumHits("Boom-bap", 0).kick).toBe(true);
    expect(drumHits("Boom-bap", 10).kick).toBe(true);
    expect(drumHits("Boom-bap", 4).snare).toBe(true);
    expect(drumHits("Boom-bap", 12).snare).toBe(true);
  });
  it("Hi-hat 8ths has no snare and hats on evens", () => {
    for (let s = 0; s < 16; s++) {
      expect(drumHits("Hi-hat 8ths", s).snare).toBe(false);
      expect(drumHits("Hi-hat 8ths", s).hat).toBe(s % 2 === 0);
    }
  });
  it("wraps step indices modulo the bar", () => {
    expect(drumHits("Four-on-floor", 16)).toEqual(drumHits("Four-on-floor", 0));
    expect(drumHits("Four-on-floor", 20)).toEqual(drumHits("Four-on-floor", 4));
  });
});

describe("metronomeClick", () => {
  it("clicks on quarters with an accent only on beat 1", () => {
    expect(metronomeClick(0)).toEqual({ click: true, accent: true });
    expect(metronomeClick(4)).toEqual({ click: true, accent: false });
    expect(metronomeClick(8)).toEqual({ click: true, accent: false });
    expect(metronomeClick(12)).toEqual({ click: true, accent: false });
    for (const s of [1, 2, 3, 5, 7, 9, 11, 13]) {
      expect(metronomeClick(s).click).toBe(false);
    }
  });
});
