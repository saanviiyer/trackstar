import { MAX_PATTERN_BARS, STEPS_PER_BAR } from "./drums";

export interface BassPattern {
  /** One monophonic MIDI note per 16th note; null is a rest. */
  notes: Array<number | null>;
}

export type BassPresetName =
  | "Empty"
  | "Root pulse"
  | "Offbeat"
  | "Octave bounce"
  | "Walking"
  | "808 syncopation";

export const BASS_PRESET_NAMES: BassPresetName[] = [
  "Empty",
  "Root pulse",
  "Offbeat",
  "Octave bounce",
  "Walking",
  "808 syncopation",
];

const clampBars = (bars: number) =>
  Math.max(1, Math.min(MAX_PATTERN_BARS, Math.round(bars) || 1));

export function emptyBassPattern(bars = 1): BassPattern {
  return { notes: new Array(clampBars(bars) * STEPS_PER_BAR).fill(null) };
}

export function bassPatternBars(pattern: BassPattern): number {
  return Math.max(1, Math.round(pattern.notes.length / STEPS_PER_BAR));
}

export function setBassPatternBars(pattern: BassPattern, bars: number): BassPattern {
  const target = clampBars(bars) * STEPS_PER_BAR;
  const source = pattern.notes.length ? pattern.notes : emptyBassPattern().notes;
  return {
    notes: Array.from({ length: target }, (_, i) => source[i % source.length] ?? null),
  };
}

export function setBassNote(
  pattern: BassPattern,
  step: number,
  midi: number | null
): BassPattern {
  if (step < 0 || step >= pattern.notes.length) return { notes: [...pattern.notes] };
  const notes = [...pattern.notes];
  notes[step] = midi === null ? null : Math.max(24, Math.min(72, Math.round(midi)));
  return { notes };
}

export function clearBassPattern(pattern: BassPattern): BassPattern {
  return { notes: pattern.notes.map(() => null) };
}

export function bassNoteAt(pattern: BassPattern, step: number): number | null {
  const n = pattern.notes.length || STEPS_PER_BAR;
  return pattern.notes[((step % n) + n) % n] ?? null;
}

export function isBassPattern(value: unknown): value is BassPattern {
  if (!value || typeof value !== "object") return false;
  const notes = (value as Partial<BassPattern>).notes;
  if (!Array.isArray(notes)) return false;
  if (
    notes.length < STEPS_PER_BAR ||
    notes.length > MAX_PATTERN_BARS * STEPS_PER_BAR ||
    notes.length % STEPS_PER_BAR !== 0
  ) return false;
  return notes.every(
    (note) => note === null || (Number.isInteger(note) && note >= 24 && note <= 72)
  );
}

export function bassPatternFromPreset(
  name: BassPresetName,
  tonic: number,
  bars = 1
): BassPattern {
  const root = 36 + ((Math.round(tonic) % 12) + 12) % 12;
  const one = emptyBassPattern(1);
  const put = (steps: number[], notes: number[]) => {
    steps.forEach((step, i) => {
      one.notes[step] = notes[i % notes.length];
    });
  };
  if (name === "Root pulse") put([0, 4, 8, 12], [root]);
  if (name === "Offbeat") put([2, 6, 10, 14], [root]);
  if (name === "Octave bounce") put([0, 3, 6, 8, 11, 14], [root, root + 12]);
  if (name === "Walking") put([0, 4, 8, 12], [root, root + 4, root + 7, root + 9]);
  if (name === "808 syncopation") put([0, 6, 10, 15], [root, root, root + 7, root + 12]);
  return setBassPatternBars(one, bars);
}

