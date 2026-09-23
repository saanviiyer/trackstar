import { describe, expect, it } from "vitest";
import { cleanProjectName, isTrackstarProject, sanitizeCompositionState, sanitizeDrumState } from "./projectStore";
import { CUSTOM_PATTERN, emptyPattern, setStep } from "./drums";
import { bassPatternFromPreset } from "./bass";
import { createArrangement } from "./arrangement";

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

describe("sanitizeDrumState", () => {
  const custom = setStep(emptyPattern(2), "kick", 20, true);

  it("accepts a saved choice and beat", () => {
    expect(sanitizeDrumState({ choice: CUSTOM_PATTERN, custom })).toEqual({
      choice: CUSTOM_PATTERN,
      custom,
    });
    expect(sanitizeDrumState({ choice: "Boom-bap", custom })?.choice).toBe("Boom-bap");
  });

  it("returns null for missing or damaged drum state", () => {
    expect(sanitizeDrumState(undefined)).toBeNull();
    expect(sanitizeDrumState({ choice: "Jungle", custom })).toBeNull();
    expect(sanitizeDrumState({ choice: CUSTOM_PATTERN })).toBeNull();
    expect(
      sanitizeDrumState({ choice: CUSTOM_PATTERN, custom: { kick: [1], snare: [], hat: [] } })
    ).toBeNull();
  });

  it("a damaged beat does not invalidate the project that carries it", () => {
    const project = {
      version: 1 as const,
      name: "Demo",
      savedAt: "2026-08-17T00:00:00.000Z",
      bpm: 120,
      bars: 2,
      mixer: { version: 1 as const, loopDurationSec: 0, tracks: [] },
      drums: { choice: "Jungle", custom: null } as never,
    };
    expect(isTrackstarProject(project)).toBe(true);
    expect(sanitizeDrumState(project.drums)).toBeNull();
  });

  it("still loads projects saved before the sequencer existed", () => {
    const old = {
      version: 1,
      name: "Old",
      savedAt: "2026-08-17T00:00:00.000Z",
      bpm: 96,
      bars: 4,
      mixer: { version: 1, loopDurationSec: 0, tracks: [] },
    };
    expect(isTrackstarProject(old)).toBe(true);
  });

  it("upgrades original three-lane custom beats", () => {
    const legacy = { kick: new Array(16).fill(0), snare: new Array(16).fill(0), hat: new Array(16).fill(0) };
    const restored = sanitizeDrumState({ choice: CUSTOM_PATTERN, custom: legacy });
    expect(restored?.custom.clap).toEqual(new Array(16).fill(0));
    expect(restored?.custom.tom).toEqual(new Array(16).fill(0));
    expect(restored?.custom.shaker).toEqual(new Array(16).fill(0));
  });
});

describe("sanitizeCompositionState", () => {
  it("accepts bass and arrangement data without risking the main project", () => {
    const composition = {
      bassOn: true,
      bass: bassPatternFromPreset("Root pulse", 0),
      arrangement: createArrangement(8),
    };
    expect(sanitizeCompositionState(composition)).toEqual(composition);
    expect(sanitizeCompositionState({ ...composition, bassOn: "yes" })).toBeNull();
  });
});
