import { describe, it, expect } from "vitest";
import {
  midiToFreq,
  midiToName,
  pitchToMidi,
  buildChord,
  parseChord,
  parseProgression,
  voiceParsed,
  scaleDegreeCount,
  type KeyConfig,
} from "./music";

describe("equal-temperament frequency", () => {
  it("A4 (MIDI 69) = 440 Hz", () => {
    expect(midiToFreq(69)).toBeCloseTo(440, 6);
  });

  it("A5 is an octave (2x) above A4", () => {
    expect(midiToFreq(81)).toBeCloseTo(880, 4);
  });

  it("Middle C (MIDI 60) ≈ 261.63 Hz", () => {
    expect(midiToFreq(60)).toBeCloseTo(261.6256, 3);
  });

  it("a semitone up multiplies frequency by 2^(1/12)", () => {
    expect(midiToFreq(70) / midiToFreq(69)).toBeCloseTo(Math.pow(2, 1 / 12), 8);
  });
});

describe("pitch/name conversion", () => {
  it("C4 is MIDI 60", () => {
    expect(pitchToMidi(0, 4)).toBe(60);
  });
  it("names round-trip", () => {
    expect(midiToName(60)).toBe("C4");
    expect(midiToName(69)).toBe("A4");
    expect(midiToName(61)).toBe("C#4");
  });
});

describe("diatonic chord construction - C major", () => {
  const key: KeyConfig = { tonic: 0, scale: "major", octave: 4 };

  it("I is C major triad C4 E4 G4 with correct intervals", () => {
    const c = buildChord(key, 0);
    expect(c.notes).toEqual([60, 64, 67]);
    expect(c.label).toBe("I");
    expect(c.name).toBe("C major");
    // intervals from root: major third (4) + minor third (3)
    expect(c.notes[1] - c.notes[0]).toBe(4);
    expect(c.notes[2] - c.notes[1]).toBe(3);
  });

  it("ii is D minor triad D4 F4 A4", () => {
    const c = buildChord(key, 1);
    expect(c.notes).toEqual([62, 65, 69]);
    expect(c.label).toBe("ii");
    expect(c.notes[1] - c.notes[0]).toBe(3); // minor third first
    expect(c.notes[2] - c.notes[1]).toBe(4);
  });

  it("V is G major triad G4 B4 D5", () => {
    const c = buildChord(key, 4);
    expect(c.notes).toEqual([67, 71, 74]);
    expect(c.label).toBe("V");
  });

  it("V7 adds the minor seventh (F5)", () => {
    const c = buildChord(key, 4, true);
    expect(c.notes).toEqual([67, 71, 74, 77]);
    expect(c.label).toBe("V7");
    // G dominant 7th: root->b7 is 10 semitones
    expect(c.notes[3] - c.notes[0]).toBe(10);
  });

  it("vi is A minor triad A4 C5 E5 (Am)", () => {
    const c = buildChord(key, 5);
    expect(c.notes).toEqual([69, 72, 76]);
    expect(c.label).toBe("vi");
    expect(c.name).toBe("A minor");
  });

  it("vii is the diminished triad B4 D5 F5 (Bdim)", () => {
    const c = buildChord(key, 6);
    expect(c.notes).toEqual([71, 74, 77]);
    expect(c.label).toBe("vii°");
    // diminished: minor third + diminished fifth
    expect(c.notes[1] - c.notes[0]).toBe(3);
    expect(c.notes[2] - c.notes[0]).toBe(6);
  });

  it("vii with 7th is half-diminished B D F A (Bm7b5)", () => {
    const c = buildChord(key, 6, "7th");
    expect(c.notes).toEqual([71, 74, 77, 81]);
    // half-diminished: dim triad + minor 7th (10 semitones over root)
    expect(c.notes[3] - c.notes[0]).toBe(10);
    // pitch classes B D F A
    const pc = c.notes.map((n) => n % 12).sort((a, b) => a - b);
    expect(pc).toEqual([2, 5, 9, 11]);
  });

  it("chord frequencies match the MIDI notes", () => {
    const c = buildChord(key, 0);
    expect(c.freqs[0]).toBeCloseTo(midiToFreq(60), 6);
    expect(c.freqs[2]).toBeCloseTo(midiToFreq(67), 6);
  });
});

describe("diatonic chord construction - A minor", () => {
  const key: KeyConfig = { tonic: 9, scale: "minor", octave: 4 };

  it("i is A minor triad A4 C5 E5", () => {
    const c = buildChord(key, 0);
    expect(c.notes).toEqual([69, 72, 76]);
    expect(c.label).toBe("i");
    expect(c.name).toBe("A minor");
  });

  it("III is C major triad C5 E5 G5", () => {
    const c = buildChord(key, 2);
    expect(c.notes).toEqual([72, 76, 79]);
    expect(c.label).toBe("III");
  });
});

describe("inversions", () => {
  const key: KeyConfig = { tonic: 0, scale: "major", octave: 4 };
  it("1st inversion lifts the root an octave: E4 G4 C5", () => {
    const c = buildChord(key, 0, false, 1);
    expect(c.notes).toEqual([64, 67, 72]);
  });
  it("2nd inversion: G4 C5 E5", () => {
    const c = buildChord(key, 0, false, 2);
    expect(c.notes).toEqual([67, 72, 76]);
  });
});

describe("chord extensions - 6th and 7th (diatonic)", () => {
  const cmaj: KeyConfig = { tonic: 0, scale: "major", octave: 4 };
  const amin: KeyConfig = { tonic: 9, scale: "minor", octave: 4 };

  it("C major I6 adds the diatonic 6th A: C4 E4 G4 A4", () => {
    const c = buildChord(cmaj, 0, "6th");
    expect(c.notes).toEqual([60, 64, 67, 69]);
    expect(c.label).toBe("I6");
  });

  it("C major I7 (maj7) adds B: C4 E4 G4 B4", () => {
    const c = buildChord(cmaj, 0, "7th");
    expect(c.notes).toEqual([60, 64, 67, 71]);
    expect(c.label).toBe("I7");
    expect(c.notes[3] - c.notes[0]).toBe(11); // major seventh
  });

  it("C major V6 adds E: G4 B4 D5 E5", () => {
    const c = buildChord(cmaj, 4, "6th");
    expect(c.notes).toEqual([67, 71, 74, 76]);
    expect(c.label).toBe("V6");
  });

  it("C major V7 is dominant (b7 = F5)", () => {
    const c = buildChord(cmaj, 4, "7th");
    expect(c.notes).toEqual([67, 71, 74, 77]);
    expect(c.notes[3] - c.notes[0]).toBe(10);
  });

  it("A minor i6 adds diatonic 6th F: A4 C5 E5 F5", () => {
    const c = buildChord(amin, 0, "6th");
    expect(c.notes).toEqual([69, 72, 76, 77]);
    expect(c.label).toBe("i6");
  });

  it("A minor i7 adds G: A4 C5 E5 G5 (minor 7th)", () => {
    const c = buildChord(amin, 0, "7th");
    expect(c.notes).toEqual([69, 72, 76, 79]);
    expect(c.notes[3] - c.notes[0]).toBe(10);
  });

  it("A minor v7 adds diatonic 7th (natural minor v7 = Em7)", () => {
    const c = buildChord(amin, 4, "7th");
    // v sits above the tonic octave: E5 G5 B5 D6 = 76,79,83,86 (Em7 shape)
    expect(c.notes).toEqual([76, 79, 83, 86]);
    expect(c.label).toBe("v7");
    // pitch classes = E G B D
    const pc = c.notes.map((n) => n % 12).sort((a, b) => a - b);
    expect(pc).toEqual([2, 4, 7, 11]);
  });

  it("boolean true still means 7th (back-compat)", () => {
    expect(buildChord(cmaj, 4, true).notes).toEqual(
      buildChord(cmaj, 4, "7th").notes
    );
  });
});

describe("chord-symbol parser", () => {
  // Helper: pitch classes of the parsed notes (order-independent).
  const pcs = (notes: number[]) =>
    [...new Set(notes.map((n) => ((n % 12) + 12) % 12))].sort((a, b) => a - b);

  it("Am -> A C E", () => {
    const c = parseChord("Am")!;
    expect(c).not.toBeNull();
    expect(c.quality).toBe("minor");
    expect(pcs(c.notes)).toEqual([0, 4, 9]); // A(9) C(0) E(4)
    expect(c.label).toBe("Am");
  });

  it("E -> E G# B", () => {
    const c = parseChord("E")!;
    expect(c.quality).toBe("major");
    expect(pcs(c.notes)).toEqual([4, 8, 11]);
  });

  it("F -> F A C", () => {
    expect(pcs(parseChord("F")!.notes)).toEqual([0, 5, 9]);
  });

  it("C -> C E G", () => {
    expect(pcs(parseChord("C")!.notes)).toEqual([0, 4, 7]);
  });

  it("G7 -> G B D F (dominant)", () => {
    const c = parseChord("G7")!;
    expect(c.quality).toBe("7");
    expect(pcs(c.notes)).toEqual([2, 5, 7, 11]); // G B D F
    expect(c.label).toBe("G7");
  });

  it("Cmaj7 -> C E G B", () => {
    const c = parseChord("Cmaj7")!;
    expect(c.quality).toBe("maj7");
    expect(pcs(c.notes)).toEqual([0, 4, 7, 11]);
    expect(c.label).toBe("Cmaj7");
  });

  it("Dm7 -> D F A C", () => {
    const c = parseChord("Dm7")!;
    expect(c.quality).toBe("m7");
    expect(pcs(c.notes)).toEqual([0, 2, 5, 9]);
  });

  it("F6 -> F A C D", () => {
    const c = parseChord("F6")!;
    expect(c.quality).toBe("6");
    expect(pcs(c.notes)).toEqual([0, 2, 5, 9]); // F A C D
  });

  it("Bdim -> B D F", () => {
    const c = parseChord("Bdim")!;
    expect(c.quality).toBe("dim");
    expect(pcs(c.notes)).toEqual([2, 5, 11]);
  });

  it("Csus4 -> C F G", () => {
    const c = parseChord("Csus4")!;
    expect(c.quality).toBe("sus4");
    expect(pcs(c.notes)).toEqual([0, 5, 7]);
  });

  it("sharps/flats and aug/sus2/m7b5 parse", () => {
    expect(pcs(parseChord("F#")!.notes)).toEqual([1, 6, 10]); // F# A# C#
    expect(pcs(parseChord("Bb")!.notes)).toEqual([2, 5, 10]); // Bb D F
    expect(parseChord("Caug")!.quality).toBe("aug");
    expect(parseChord("Dsus2")!.quality).toBe("sus2");
    expect(parseChord("Bm7b5")!.quality).toBe("m7b5");
  });

  it("returns null for garbage tokens", () => {
    expect(parseChord("H")).toBeNull();
    expect(parseChord("Xyz")).toBeNull();
    expect(parseChord("")).toBeNull();
  });

  it("m6 uses the major 6th over a minor triad", () => {
    // Am6 = A C E F#  => pcs 9,0,4,6
    expect(pcs(parseChord("Am6")!.notes)).toEqual([0, 4, 6, 9]);
  });

  it("inversion re-voices via voiceParsed but keeps pitch classes", () => {
    const c = parseChord("C", 4, 0)!;
    const inv = voiceParsed(c, 4, 1);
    expect(inv.notes).toEqual([64, 67, 72]); // E4 G4 C5
    expect(pcs(inv.notes)).toEqual([0, 4, 7]);
  });
});

describe("parseProgression", () => {
  it("parses 'Am E F C' into 4 valid slots", () => {
    const slots = parseProgression("Am E F C");
    expect(slots.map((s) => s.symbol)).toEqual(["Am", "E", "F", "C"]);
    expect(slots.every((s) => s.chord !== null)).toBe(true);
  });

  it("handles commas and flags unparseable tokens but keeps the rest", () => {
    const slots = parseProgression("G7, Cmaj7, Zz, Dm7");
    expect(slots.map((s) => s.symbol)).toEqual(["G7", "Cmaj7", "Zz", "Dm7"]);
    expect(slots[2].chord).toBeNull();
    expect(slots[0].chord).not.toBeNull();
    expect(slots[3].chord).not.toBeNull();
  });
});

describe("expanded scales - degree count", () => {
  it("7-note modes have 7 degrees, pentatonics have 5", () => {
    expect(scaleDegreeCount("major")).toBe(7);
    expect(scaleDegreeCount("dorian")).toBe(7);
    expect(scaleDegreeCount("harmonicMinor")).toBe(7);
    expect(scaleDegreeCount("majorPentatonic")).toBe(5);
    expect(scaleDegreeCount("minorPentatonic")).toBe(5);
  });
});

describe("Dorian degree chords (C dorian)", () => {
  const key: KeyConfig = { tonic: 0, scale: "dorian", octave: 4 };
  it("i is C minor (C Eb G)", () => {
    const c = buildChord(key, 0);
    expect(c.notes).toEqual([60, 63, 67]);
    expect(c.label).toBe("i");
    expect(c.name).toBe("C minor");
  });
  it("IV is major (F A C) - the Dorian characteristic", () => {
    const c = buildChord(key, 3);
    expect(c.notes).toEqual([65, 69, 72]);
    expect(c.label).toBe("IV");
    expect(c.name).toBe("F major");
  });
});

describe("Harmonic Minor degree chords (C harmonic minor)", () => {
  const key: KeyConfig = { tonic: 0, scale: "harmonicMinor", octave: 4 };
  it("i is C minor (C Eb G)", () => {
    const c = buildChord(key, 0);
    expect(c.notes).toEqual([60, 63, 67]);
    expect(c.label).toBe("i");
  });
  it("III is augmented (Eb G B)", () => {
    const c = buildChord(key, 2);
    expect(c.notes).toEqual([63, 67, 71]);
    // augmented: major third + augmented fifth
    expect(c.notes[1] - c.notes[0]).toBe(4);
    expect(c.notes[2] - c.notes[0]).toBe(8);
    expect(c.label).toBe("III+");
  });
  it("V is major (G B D) - the raised leading tone dominant", () => {
    const c = buildChord(key, 4);
    expect(c.notes).toEqual([67, 71, 74]);
    expect(c.label).toBe("V");
    expect(c.name).toBe("G major");
  });
  it("vii is diminished (B D F)", () => {
    const c = buildChord(key, 6);
    expect(c.notes).toEqual([71, 74, 77]);
    expect(c.label).toBe("vii°");
  });
});

describe("Pentatonic degree->chord mapping (C major pentatonic)", () => {
  const key: KeyConfig = { tonic: 0, scale: "majorPentatonic", octave: 4 };
  it("has 5 selectable degrees", () => {
    expect(scaleDegreeCount("majorPentatonic")).toBe(5);
  });
  it("degree 0 stacks alternate scale tones: C E A", () => {
    // majorPentatonic = C D E G A; stacking [0,2,4] gives C, E, A
    const c = buildChord(key, 0);
    expect(c.notes).toEqual([60, 64, 69]);
    expect(c.label).toBe("I");
    // pitch classes C E A
    const pc = c.notes.map((n) => n % 12).sort((a, b) => a - b);
    expect(pc).toEqual([0, 4, 9]);
  });
  it("degree wraps within the 5-note scale", () => {
    // degree 5 == degree 0 (mod 5)
    expect(buildChord(key, 5).notes).toEqual(buildChord(key, 0).notes);
  });
  it("minor pentatonic degree 0 stacks C F Bb", () => {
    const mk: KeyConfig = { tonic: 0, scale: "minorPentatonic", octave: 4 };
    const c = buildChord(mk, 0);
    // minorPentatonic = C Eb F G Bb; stacking [0,2,4] gives C, F, Bb
    expect(c.notes).toEqual([60, 65, 70]);
  });
});
