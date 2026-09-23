import { describe, expect, it } from "vitest";
import {
  arrangementAllows,
  arrangementFromPreset,
  createArrangement,
  isTrackArrangement,
  resizeArrangement,
  setArrangementCell,
} from "./arrangement";

describe("track arrangement", () => {
  it("toggles layers independently by bar", () => {
    const arranged = setArrangementCell(createArrangement(4), "bass", 1, false);
    expect(arrangementAllows(arranged, "bass", 0)).toBe(true);
    expect(arrangementAllows(arranged, "bass", 16)).toBe(false);
    expect(arrangementAllows(arranged, "drums", 16)).toBe(true);
  });

  it("provides musical structure presets", () => {
    const build = arrangementFromPreset("Build up", 8);
    expect(build.drums[0]).toBe(false);
    expect(build.drums[3]).toBe(true);
    expect(build.bass[3]).toBe(false);
    expect(build.bass[5]).toBe(true);
  });

  it("resizes, wraps playback, and validates", () => {
    const base = setArrangementCell(createArrangement(4), "drums", 1, false);
    const eight = resizeArrangement(base, 8);
    expect(eight.drums[5]).toBe(false);
    expect(arrangementAllows(eight, "drums", 16 * 9)).toBe(false);
    expect(isTrackArrangement(eight)).toBe(true);
    expect(isTrackArrangement({ ...eight, bass: [true] })).toBe(false);
  });
});

