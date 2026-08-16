// presets.ts - pure sound-design data: the SoundConfig shape, the named preset
// "modes", and small param-mapping helpers. No Web Audio here, so it is fully
// unit-testable. The Synth consumes a SoundConfig via applyConfig().

export type Waveform = "sine" | "sawtooth" | "square" | "triangle";

export type LfoTarget = "off" | "pitch" | "filter" | "amp";

export interface EnvelopeConfig {
  attack: number; // seconds
  decay: number; // seconds
  sustain: number; // 0..1 level
  release: number; // seconds
}

export interface LfoConfig {
  rate: number; // Hz
  depth: number; // 0..1 (mapped per target)
  target: LfoTarget;
}

export interface EffectsConfig {
  reverb: { on: boolean; amount: number };
  delay: { on: boolean; time: number; feedback: number; mix: number };
  distortion: { on: boolean; amount: number };
  chorus: { on: boolean; amount: number };
}

export interface SoundConfig {
  waveform: Waveform;
  /** Unison voices per note (1..7). */
  unison: number;
  /** Unison detune spread in cents. */
  detune: number;
  /** Sub-oscillator (-1 octave) level, 0..1. */
  subLevel: number;
  env: EnvelopeConfig;
  /** Main (hand-Y) filter resonance / Q. */
  resonance: number;
  /** Per-note filter-envelope amount, 0..1 (0 = transparent). */
  filterEnvAmount: number;
  lfo: LfoConfig;
  fx: EffectsConfig;
}

/** Deep-clone a plain-data SoundConfig (so callers can mutate freely). */
export function cloneSound(cfg: SoundConfig): SoundConfig {
  return JSON.parse(JSON.stringify(cfg)) as SoundConfig;
}

const P: Record<string, SoundConfig> = {
  // "Basic" reproduces the original synth voice (2 saws, detune 6, simple env,
  // no effects) so first load / reset sounds like it always did.
  Basic: {
    waveform: "sawtooth",
    unison: 2,
    detune: 6,
    subLevel: 0,
    env: { attack: 0.02, decay: 0.12, sustain: 0.7, release: 0.25 },
    resonance: 0.9,
    filterEnvAmount: 0,
    lfo: { rate: 5, depth: 0, target: "off" },
    fx: {
      reverb: { on: false, amount: 0.3 },
      delay: { on: false, time: 0.3, feedback: 0.35, mix: 0.25 },
      distortion: { on: false, amount: 0.2 },
      chorus: { on: false, amount: 0.4 },
    },
  },

  "Warm Pad": {
    waveform: "sawtooth",
    unison: 3,
    detune: 12,
    subLevel: 0.1,
    env: { attack: 0.8, decay: 0.4, sustain: 0.8, release: 1.5 },
    resonance: 3,
    filterEnvAmount: 0,
    lfo: { rate: 0.3, depth: 0.15, target: "filter" },
    fx: {
      reverb: { on: true, amount: 0.4 },
      delay: { on: false, time: 0.4, feedback: 0.3, mix: 0.2 },
      distortion: { on: false, amount: 0.2 },
      chorus: { on: true, amount: 0.5 },
    },
  },

  Pluck: {
    waveform: "triangle",
    unison: 1,
    detune: 0,
    subLevel: 0,
    env: { attack: 0.005, decay: 0.18, sustain: 0.0, release: 0.15 },
    resonance: 6,
    filterEnvAmount: 0.5,
    lfo: { rate: 5, depth: 0, target: "off" },
    fx: {
      reverb: { on: true, amount: 0.15 },
      delay: { on: false, time: 0.25, feedback: 0.3, mix: 0.2 },
      distortion: { on: false, amount: 0.2 },
      chorus: { on: false, amount: 0.4 },
    },
  },

  Chiptune: {
    waveform: "square",
    unison: 1,
    detune: 0,
    subLevel: 0,
    env: { attack: 0.001, decay: 0.05, sustain: 0.6, release: 0.02 },
    resonance: 0.5,
    filterEnvAmount: 0,
    lfo: { rate: 6, depth: 0.1, target: "pitch" },
    fx: {
      reverb: { on: false, amount: 0.3 },
      delay: { on: false, time: 0.3, feedback: 0.35, mix: 0.25 },
      distortion: { on: false, amount: 0.2 },
      chorus: { on: false, amount: 0.4 },
    },
  },

  "Supersaw Lead": {
    waveform: "sawtooth",
    unison: 7,
    detune: 25,
    subLevel: 0.15,
    env: { attack: 0.02, decay: 0.2, sustain: 0.8, release: 0.3 },
    resonance: 2,
    filterEnvAmount: 0.2,
    lfo: { rate: 5, depth: 0, target: "off" },
    fx: {
      reverb: { on: true, amount: 0.2 },
      delay: { on: true, time: 0.25, feedback: 0.3, mix: 0.2 },
      distortion: { on: true, amount: 0.15 },
      chorus: { on: true, amount: 0.3 },
    },
  },

  Bell: {
    waveform: "sine",
    unison: 2,
    detune: 8,
    subLevel: 0,
    env: { attack: 0.002, decay: 1.2, sustain: 0.0, release: 1.8 },
    resonance: 1,
    filterEnvAmount: 0,
    lfo: { rate: 5, depth: 0.05, target: "pitch" },
    fx: {
      reverb: { on: true, amount: 0.5 },
      delay: { on: false, time: 0.3, feedback: 0.3, mix: 0.2 },
      distortion: { on: false, amount: 0.2 },
      chorus: { on: true, amount: 0.2 },
    },
  },

  Organ: {
    waveform: "sine",
    unison: 3,
    detune: 4,
    subLevel: 0.5,
    env: { attack: 0.01, decay: 0.0, sustain: 1.0, release: 0.08 },
    resonance: 0.7,
    filterEnvAmount: 0,
    lfo: { rate: 6, depth: 0.06, target: "amp" },
    fx: {
      reverb: { on: true, amount: 0.2 },
      delay: { on: false, time: 0.3, feedback: 0.3, mix: 0.2 },
      distortion: { on: false, amount: 0.2 },
      chorus: { on: true, amount: 0.3 },
    },
  },

  "Sub Bass": {
    waveform: "sine",
    unison: 1,
    detune: 0,
    subLevel: 0.8,
    env: { attack: 0.01, decay: 0.15, sustain: 0.7, release: 0.12 },
    resonance: 1,
    filterEnvAmount: 0.3,
    lfo: { rate: 5, depth: 0, target: "off" },
    fx: {
      reverb: { on: false, amount: 0.3 },
      delay: { on: false, time: 0.3, feedback: 0.35, mix: 0.25 },
      distortion: { on: true, amount: 0.1 },
      chorus: { on: false, amount: 0.4 },
    },
  },

  Dream: {
    waveform: "triangle",
    unison: 5,
    detune: 15,
    subLevel: 0.1,
    env: { attack: 1.2, decay: 0.6, sustain: 0.7, release: 2.5 },
    resonance: 2,
    filterEnvAmount: 0,
    lfo: { rate: 0.2, depth: 0.2, target: "filter" },
    fx: {
      reverb: { on: true, amount: 0.6 },
      delay: { on: true, time: 0.5, feedback: 0.45, mix: 0.35 },
      distortion: { on: false, amount: 0.2 },
      chorus: { on: true, amount: 0.5 },
    },
  },
};

export type PresetName = keyof typeof P & string;

export const PRESETS: Record<string, SoundConfig> = P;

export const PRESET_NAMES: string[] = Object.keys(P);

/** Return a fresh, mutable copy of a preset (falls back to Basic). */
export function getPreset(name: string): SoundConfig {
  const p = P[name] ?? P.Basic;
  return cloneSound(p);
}

export const DEFAULT_PRESET = "Basic";

/** The default sound (a copy, so it can be mutated). */
export function defaultSound(): SoundConfig {
  return getPreset(DEFAULT_PRESET);
}

/**
 * Unison detune offsets (cents) for `count` voices spread symmetrically over
 * `spread` cents. 1 voice -> [0]; N voices span [-spread/2, +spread/2].
 */
export function unisonDetunes(count: number, spread: number): number[] {
  const n = Math.max(1, Math.floor(count));
  if (n === 1) return [0];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push((i / (n - 1) - 0.5) * spread);
  }
  return out;
}
