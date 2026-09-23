import { describe, expect, it } from "vitest";
import {
  bassNoteAt,
  bassPatternFromPreset,
  clearBassPattern,
  emptyBassPattern,
  isBassPattern,
  setBassNote,
  setBassPatternBars,
} from "./bass";

describe("bass patterns", () => {
  it("creates and resizes patterns by tiling the existing phrase", () => {
    const one = setBassNote(emptyBassPattern(1), 3, 36);
    const two = setBassPatternBars(one, 2);
    expect(two.notes).toHaveLength(32);
    expect(two.notes[3]).toBe(36);
    expect(two.notes[19]).toBe(36);
  });

  it("builds useful key-aware presets", () => {
    const c = bassPatternFromPreset("Root pulse", 0);
    const d = bassPatternFromPreset("Root pulse", 2);
    expect(c.notes[0]).toBe(36);
    expect(d.notes[0]).toBe(38);
    expect(bassPatternFromPreset("808 syncopation", 0).notes.filter(Boolean)).toHaveLength(4);
  });

  it("wraps playback, clears, and validates data", () => {
    const pattern = setBassNote(emptyBassPattern(1), 15, 48);
    expect(bassNoteAt(pattern, 31)).toBe(48);
    expect(clearBassPattern(pattern).notes.every((note) => note === null)).toBe(true);
    expect(isBassPattern(pattern)).toBe(true);
    expect(isBassPattern({ notes: [36] })).toBe(false);
    expect(isBassPattern({ notes: new Array(16).fill(99) })).toBe(false);
  });
});

