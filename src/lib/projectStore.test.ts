import { describe, expect, it } from "vitest";
import { cleanProjectName, isTrackstarProject } from "./projectStore";

describe("cleanProjectName", () => {
  it("trims, removes control characters and supplies a fallback", () => {
    expect(cleanProjectName("  Night\u0000 Drive  ")).toBe("Night  Drive");
    expect(cleanProjectName("   ")).toBe("Untitled project");
  });

  it("caps project names at 80 characters", () => {
    expect(cleanProjectName("x".repeat(120))).toHaveLength(80);
  });
});

describe("isTrackstarProject", () => {
  const valid = {
    version: 1,
    name: "Demo",
    savedAt: "2026-08-17T00:00:00.000Z",
    bpm: 120,
    bars: 2,
    mixer: { version: 1, loopDurationSec: 0, tracks: [] },
  };

  it("accepts a versioned project and rejects malformed input", () => {
    expect(isTrackstarProject(valid)).toBe(true);
    expect(isTrackstarProject({ ...valid, bpm: Number.NaN })).toBe(false);
    expect(isTrackstarProject({ ...valid, mixer: { tracks: [] } })).toBe(false);
    expect(isTrackstarProject(null)).toBe(false);
  });
});
