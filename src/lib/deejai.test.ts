import { describe, it, expect } from "vitest";
import {
  sessionUrl,
  commandUrl,
  fileUrl,
  normalizePan,
  newStemsToAdd,
  stemTrackLabel,
  type DeejaiProject,
  type DeejaiTrack,
} from "./deejai";

const track = (over: Partial<DeejaiTrack>): DeejaiTrack => ({
  file: "stems/beat.wav",
  name: "beat",
  role: "beat",
  pan: 0,
  ...over,
});

const project = (tracks: DeejaiTrack[]): DeejaiProject => ({
  tempo: 90,
  key: "C major",
  progression: "I V vi IV",
  lead: "mid.wav",
  tracks,
});

describe("deejai url builders", () => {
  it("builds the session url", () => {
    expect(sessionUrl("/deejai")).toBe("/deejai/api/session");
    expect(sessionUrl("http://localhost:8000")).toBe(
      "http://localhost:8000/api/session"
    );
  });

  it("builds the command url with an encoded session id", () => {
    expect(commandUrl("/deejai", "abc123")).toBe(
      "/deejai/api/session/abc123/command"
    );
  });

  it("encodes the file path query param", () => {
    expect(fileUrl("/deejai", "sid", "stems/synth pad.wav")).toBe(
      "/deejai/api/session/sid/file?path=stems%2Fsynth%20pad.wav"
    );
  });
});

describe("normalizePan", () => {
  it("clamps to -1..1 and defaults NaN/undefined to 0", () => {
    expect(normalizePan(0.5)).toBe(0.5);
    expect(normalizePan(2)).toBe(1);
    expect(normalizePan(-3)).toBe(-1);
    expect(normalizePan(undefined)).toBe(0);
    expect(normalizePan(NaN)).toBe(0);
  });
});

describe("newStemsToAdd", () => {
  it("returns only tracks whose file is not already loaded", () => {
    const proj = project([
      track({ file: "stems/beat.wav", role: "beat" }),
      track({ file: "stems/synth_pad.wav", role: "pad", name: "synth pad" }),
    ]);
    const result = newStemsToAdd(proj, ["stems/beat.wav"]);
    expect(result.map((t) => t.file)).toEqual(["stems/synth_pad.wav"]);
  });

  it("dedupes within the same project response", () => {
    const proj = project([
      track({ file: "stems/beat.wav" }),
      track({ file: "stems/beat.wav" }),
    ]);
    expect(newStemsToAdd(proj, [])).toHaveLength(1);
  });

  it("skips tracks with an empty file path", () => {
    const proj = project([track({ file: "" }), track({ file: "stems/bass.wav" })]);
    expect(newStemsToAdd(proj, []).map((t) => t.file)).toEqual([
      "stems/bass.wav",
    ]);
  });
});

describe("stemTrackLabel", () => {
  it("prefixes the name with AI", () => {
    expect(stemTrackLabel(track({ name: "beat" }))).toBe("AI: beat");
    expect(stemTrackLabel(track({ name: "", role: "pad" }))).toBe("AI: pad");
  });
});
