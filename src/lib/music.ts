// music.ts - pure music theory helpers: equal-temperament note→frequency,
// scale + chord construction (major/minor triads + sevenths), key selection.
//
// Conventions:
//  - A MIDI note number is used as the canonical pitch handle (A4 = 69 = 440 Hz).
//  - Note names use sharps, octave in scientific pitch notation ("C4", "F#3").

export const A4_MIDI = 69;
export const A4_FREQ = 440;

export const NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
] as const;

export type NoteName = (typeof NOTE_NAMES)[number];

/** Equal-temperament frequency (Hz) for a MIDI note number. */
export function midiToFreq(midi: number): number {
  return A4_FREQ * Math.pow(2, (midi - A4_MIDI) / 12);
}

/** MIDI note number for a pitch class (0=C..11=B) at a given octave. */
export function pitchToMidi(pitchClass: number, octave: number): number {
  // MIDI: C-1 = 0, so C{oct} = (oct + 1) * 12.
  return (octave + 1) * 12 + ((pitchClass % 12) + 12) % 12;
}

/** Human-readable note name for a MIDI number, e.g. 60 -> "C4". */
export function midiToName(midi: number): string {
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return `${NOTE_NAMES[pc]}${octave}`;
}

/** Frequency for a pitch class + octave (convenience). */
export function noteToFreq(pitchClass: number, octave: number): number {
  return midiToFreq(pitchToMidi(pitchClass, octave));
}

// ---------------------------------------------------------------------------
// Scales
// ---------------------------------------------------------------------------

export type ScaleName =
  | "major"
  | "minor"
  | "dorian"
  | "phrygian"
  | "lydian"
  | "mixolydian"
  | "harmonicMinor"
  | "majorPentatonic"
  | "minorPentatonic";

// Semitone offsets from the tonic. 7-note modes plus two 5-note pentatonics.
export const SCALE_INTERVALS: Record<ScaleName, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11], // Ionian
  minor: [0, 2, 3, 5, 7, 8, 10], // Aeolian (natural minor)
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
};

// Human-readable labels for the scale selector.
export const SCALE_LABELS: Record<ScaleName, string> = {
  major: "Major (Ionian)",
  minor: "Natural Minor (Aeolian)",
  dorian: "Dorian",
  phrygian: "Phrygian",
  lydian: "Lydian",
  mixolydian: "Mixolydian",
  harmonicMinor: "Harmonic Minor",
  majorPentatonic: "Major Pentatonic",
  minorPentatonic: "Minor Pentatonic",
};

export const SCALES: ScaleName[] = Object.keys(SCALE_INTERVALS) as ScaleName[];

/** Number of degrees in a scale (7 for modes, 5 for pentatonics). */
export function scaleDegreeCount(scale: ScaleName): number {
  return SCALE_INTERVALS[scale].length;
}

// ---------------------------------------------------------------------------
// Chords
// ---------------------------------------------------------------------------

export type ChordQuality = "maj" | "min" | "dim" | "aug";

// Intervals (semitones) from the chord root, by triad quality.
export const TRIAD_INTERVALS: Record<ChordQuality, number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
};

/** Semitone offset of the i-th scale degree above the tonic (i may wrap octaves). */
function scaleDegreeSemitone(scale: ScaleName, i: number): number {
  const steps = SCALE_INTERVALS[scale];
  const n = steps.length; // 7 or 5
  const octaves = Math.floor(i / n);
  const idx = ((i % n) + n) % n;
  return steps[idx] + 12 * octaves;
}

// Base roman numerals by degree index (case/suffix applied from triad quality).
const ROMAN_BASE = ["I", "II", "III", "IV", "V", "VI", "VII"];

interface TriadClass {
  word: string; // for the display name, e.g. "minor"
  numeral: string; // full roman incl. case + suffix, e.g. "ii", "vii°", "III+"
}

/**
 * Classify a triad from the semitone size of its third and fifth above the
 * root, producing a display word and a roman numeral. Works for any scale
 * (7-note modes and pentatonic stacks), so quality follows the selected scale.
 */
function classifyTriad(deg: number, third: number, fifth: number): TriadClass {
  const base = ROMAN_BASE[deg % ROMAN_BASE.length];
  const lower = base.toLowerCase();
  if (third === 4 && fifth === 7) return { word: "major", numeral: base };
  if (third === 3 && fifth === 7) return { word: "minor", numeral: lower };
  if (third === 3 && fifth === 6)
    return { word: "dim", numeral: `${lower}°` };
  if (third === 4 && fifth === 8)
    return { word: "aug", numeral: `${base}+` };
  if (third === 2 && fifth === 7) return { word: "sus2", numeral: base };
  if (third === 5 && fifth === 7) return { word: "sus4", numeral: base };
  // Fallback for unusual pentatonic stacks: label by the interval sizes.
  return { word: "", numeral: base };
}

export interface Chord {
  /** Roman-numeral label including quality, e.g. "IV" or "V7". */
  label: string;
  /** Root MIDI note. */
  rootMidi: number;
  /** MIDI notes of all chord tones (sorted ascending). */
  notes: number[];
  /** Frequencies (Hz) of all chord tones. */
  freqs: number[];
  /** Human-readable, e.g. "F major" / "G7". */
  name: string;
}

export interface KeyConfig {
  /** Tonic pitch class, 0=C..11=B. */
  tonic: number;
  scale: ScaleName;
  /** Octave of the tonic for degree 0 chords, e.g. 3 or 4. */
  octave: number;
}

/**
 * Chord extension applied on top of the diatonic triad:
 *  - "triad": plain root/third/fifth
 *  - "6th":   triad + the diatonic 6th above the root
 *  - "7th":   triad + the diatonic 7th above the root
 */
export type ChordExtension = "triad" | "6th" | "7th";

// Scale-step offsets (from the chord root, in scale degrees) added per extension.
// A 6th above the root spans 5 scale steps; a 7th spans 6.
const EXTENSION_STACK: Record<ChordExtension, number[]> = {
  triad: [0, 2, 4],
  "6th": [0, 2, 4, 5],
  "7th": [0, 2, 4, 6],
};

const EXTENSION_SUFFIX: Record<ChordExtension, string> = {
  triad: "",
  "6th": "6",
  "7th": "7",
};

/** Back-compat: a boolean `seventh` maps to "7th" (true) / "triad" (false). */
function normalizeExtension(ext: boolean | ChordExtension): ChordExtension {
  if (ext === true) return "7th";
  if (ext === false) return "triad";
  return ext;
}

/**
 * Build a diatonic chord on the given scale degree (0-indexed) of a key.
 *
 * @param key       tonic / scale / octave
 * @param degree    0..6 scale degree (I..vii)
 * @param extension "triad" | "6th" | "7th". A boolean is accepted for
 *                  backward compatibility (true → "7th", false → "triad").
 * @param inversion number of chord tones to raise by an octave (voicing)
 */
export function buildChord(
  key: KeyConfig,
  degree: number,
  extension: boolean | ChordExtension = "triad",
  inversion = 0
): Chord {
  const n = scaleDegreeCount(key.scale);
  const deg = ((degree % n) + n) % n;
  const ext = normalizeExtension(extension);
  const base = pitchToMidi(key.tonic, key.octave);

  const rootMidi = base + scaleDegreeSemitone(key.scale, deg);

  // Stack diatonic scale-degrees within the selected scale. Diatonic stacking
  // keeps every added tone in the key, so quality follows the scale (e.g. in C
  // major the 7th on V is F, a dominant seventh; in a pentatonic scale the
  // stacks form open, sixth/quartal-flavored voicings on alternate scale tones).
  const stack = EXTENSION_STACK[ext];
  let notes = stack.map((k) => base + scaleDegreeSemitone(key.scale, deg + k));

  // Classify from the root-position triad (before inversion re-voices it).
  const third =
    scaleDegreeSemitone(key.scale, deg + 2) - scaleDegreeSemitone(key.scale, deg);
  const fifth =
    scaleDegreeSemitone(key.scale, deg + 4) - scaleDegreeSemitone(key.scale, deg);
  const cls = classifyTriad(deg, third, fifth);

  // Apply inversion: lift the lowest `inversion` tones up an octave.
  const inv = ((inversion % notes.length) + notes.length) % notes.length;
  for (let i = 0; i < inv; i++) {
    notes[i] += 12;
  }
  notes = [...notes].sort((a, b) => a - b);

  const suffix = EXTENSION_SUFFIX[ext];
  const roman = cls.numeral + suffix;
  const rootName = NOTE_NAMES[((rootMidi % 12) + 12) % 12];
  const name =
    `${rootName}${cls.word ? " " + cls.word : ""}` +
    (suffix ? " " + suffix : "");

  return {
    label: roman,
    rootMidi,
    notes,
    freqs: notes.map(midiToFreq),
    name,
  };
}

/** Convenience: display name for a key, e.g. "C Major (Ionian)". */
export function keyName(key: KeyConfig): string {
  return `${NOTE_NAMES[((key.tonic % 12) + 12) % 12]} ${SCALE_LABELS[key.scale]}`;
}

export const ALL_KEYS: NoteName[] = [...NOTE_NAMES];

// ---------------------------------------------------------------------------
// Chord-symbol parser (independent of the diatonic engine)
// ---------------------------------------------------------------------------
//
// Parses named chords like "Am", "E", "Cmaj7", "F6", "Bdim", "Csus4" into an
// explicit set of pitches, so arbitrary (including non-diatonic) progressions
// can be played, e.g. "Am E F C".

/** Root letter → pitch class. */
const LETTER_PC: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

export type QualityName =
  | "major"
  | "minor"
  | "dim"
  | "aug"
  | "sus2"
  | "sus4"
  | "6"
  | "m6"
  | "7"
  | "maj7"
  | "m7"
  | "m7b5"
  | "dim7";

interface QualitySpec {
  quality: QualityName;
  intervals: number[]; // semitones from root
  /** Display suffix appended to the root, e.g. "m7", "maj7", "". */
  suffix: string;
  /** Words for the long name, e.g. "minor 7". */
  words: string;
}

// Aliases → spec. Case-sensitive ("M" = major, "m" = minor).
const QUALITY_ALIASES: Record<string, QualitySpec> = {};
function reg(aliases: string[], spec: QualitySpec) {
  for (const a of aliases) QUALITY_ALIASES[a] = spec;
}
reg(["", "maj", "M", "major"], {
  quality: "major",
  intervals: [0, 4, 7],
  suffix: "",
  words: "major",
});
reg(["m", "min", "minor", "-"], {
  quality: "minor",
  intervals: [0, 3, 7],
  suffix: "m",
  words: "minor",
});
reg(["dim", "°", "o"], {
  quality: "dim",
  intervals: [0, 3, 6],
  suffix: "dim",
  words: "diminished",
});
reg(["aug", "+"], {
  quality: "aug",
  intervals: [0, 4, 8],
  suffix: "aug",
  words: "augmented",
});
reg(["sus2"], {
  quality: "sus2",
  intervals: [0, 2, 7],
  suffix: "sus2",
  words: "sus2",
});
reg(["sus4", "sus"], {
  quality: "sus4",
  intervals: [0, 5, 7],
  suffix: "sus4",
  words: "sus4",
});
reg(["6", "maj6", "M6"], {
  quality: "6",
  intervals: [0, 4, 7, 9],
  suffix: "6",
  words: "major 6",
});
reg(["m6", "min6", "-6"], {
  quality: "m6",
  intervals: [0, 3, 7, 9],
  suffix: "m6",
  words: "minor 6",
});
reg(["7", "dom7"], {
  quality: "7",
  intervals: [0, 4, 7, 10],
  suffix: "7",
  words: "dominant 7",
});
reg(["maj7", "M7", "Maj7", "Δ", "Δ7"], {
  quality: "maj7",
  intervals: [0, 4, 7, 11],
  suffix: "maj7",
  words: "major 7",
});
reg(["m7", "min7", "-7"], {
  quality: "m7",
  intervals: [0, 3, 7, 10],
  suffix: "m7",
  words: "minor 7",
});
reg(["m7b5", "ø", "min7b5", "m7-5", "halfdim"], {
  quality: "m7b5",
  intervals: [0, 3, 6, 10],
  suffix: "m7b5",
  words: "half-diminished 7",
});
reg(["dim7", "°7", "o7"], {
  quality: "dim7",
  intervals: [0, 3, 6, 9],
  suffix: "dim7",
  words: "diminished 7",
});

export interface ParsedChord {
  /** Original token as typed, e.g. "Am7". */
  symbol: string;
  /** Root pitch class 0..11. */
  root: number;
  rootName: string;
  quality: QualityName;
  /** Semitone intervals from the root. */
  intervals: number[];
  /** Roman-numeral-free display label, e.g. "Am7". */
  label: string;
  /** Long name, e.g. "A minor 7". */
  name: string;
  /** MIDI notes at the requested octave / inversion. */
  notes: number[];
  /** Frequencies (Hz). */
  freqs: number[];
}

/** Apply a voicing (octave placement + inversion) to root+intervals. */
function voice(
  root: number,
  intervals: number[],
  octave: number,
  inversion: number
): number[] {
  const rootMidi = pitchToMidi(root, octave);
  let notes = intervals.map((iv) => rootMidi + iv);
  const inv = ((inversion % notes.length) + notes.length) % notes.length;
  for (let i = 0; i < inv; i++) notes[i] += 12;
  notes = [...notes].sort((a, b) => a - b);
  return notes;
}

/**
 * Parse a chord symbol into an explicit pitch set. Returns null for anything
 * unparseable (unknown root or quality).
 *
 * @param symbol    e.g. "Am", "E", "Cmaj7", "F6", "Bdim", "Csus4"
 * @param octave    octave of the root (default 4)
 * @param inversion voicing inversion (default 0) - reuses hand-X inversion
 */
export function parseChord(
  symbol: string,
  octave = 4,
  inversion = 0
): ParsedChord | null {
  const raw = symbol.trim();
  if (!raw) return null;

  // Root: letter + optional accidental(s).
  const m = /^([A-Ga-g])([#b♯♭]*)(.*)$/.exec(raw);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const accidentals = m[2];
  const rest = m[3];

  let pc = LETTER_PC[letter];
  if (pc === undefined) return null;
  for (const ch of accidentals) {
    if (ch === "#" || ch === "♯") pc += 1;
    else if (ch === "b" || ch === "♭") pc -= 1;
  }
  pc = ((pc % 12) + 12) % 12;

  const spec = QUALITY_ALIASES[rest];
  if (!spec) return null;

  const notes = voice(pc, spec.intervals, octave, inversion);
  const rootName = NOTE_NAMES[pc];
  const label = `${rootName}${spec.suffix}`;
  const name = `${rootName} ${spec.words}`;

  return {
    symbol: raw,
    root: pc,
    rootName,
    quality: spec.quality,
    intervals: spec.intervals,
    label,
    name,
    notes,
    freqs: notes.map(midiToFreq),
  };
}

export interface ProgressionSlot {
  symbol: string;
  chord: ParsedChord | null; // null => unparseable token
}

/**
 * Parse a whitespace/comma-separated progression like "Am E F C" or
 * "G7 Cmaj7 Dm7 F6" into ordered slots. Unparseable tokens keep their slot
 * with chord === null so the caller can flag them but still play the rest.
 */
export function parseProgression(
  text: string,
  octave = 4
): ProgressionSlot[] {
  return text
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((symbol) => ({ symbol, chord: parseChord(symbol, octave) }));
}

/** Re-voice a parsed chord at a new octave/inversion (for live hand-X). */
export function voiceParsed(
  p: ParsedChord,
  octave: number,
  inversion: number
): Chord {
  const notes = voice(p.root, p.intervals, octave, inversion);
  return {
    label: p.label,
    rootMidi: pitchToMidi(p.root, octave),
    notes,
    freqs: notes.map(midiToFreq),
    name: p.name,
  };
}
