// mapping.ts - pure translation from hand pose(s) to a musical selection.
// Kept separate from gesture geometry (gestures.ts) and audio (synth.ts) so the
// full gesture→chord mapping can be unit tested without a DOM or AudioContext.

import {
  buildChord,
  voiceParsed,
  scaleDegreeCount,
  type Chord,
  type ChordExtension,
  type KeyConfig,
  type ParsedChord,
} from "./music";
import type { HandPose } from "./gestures";

export type PlayMode = "diatonic" | "progression";

export interface MappingConfig {
  mode?: PlayMode;
  key: KeyConfig;
  /** Diatonic mode: chord extension applied to the picked degree. */
  extension?: ChordExtension;
  /** Back-compat: boolean seventh (true → "7th"). */
  seventh?: boolean;
  /** Progression mode: ordered palette of parsed chords (nulls skipped). */
  progression?: (ParsedChord | null)[];
  twoHand: boolean;
  filterMinHz?: number;
  filterMaxHz?: number;
}

export interface Selection {
  /** null when resting/muted (fist or no hand). */
  chord: Chord | null;
  rest: boolean;
  /** Low-pass cutoff in Hz derived from hand Y. */
  cutoffHz: number;
  /** Expression / gain 0..1 derived from pinch. */
  expression: number;
  /** Octave shift applied (from the modifier hand in two-hand mode). */
  octaveShift: number;
  /** Chord voicing inversion (from hand X). */
  inversion: number;
  /** Diatonic: degree 0..4. Progression: selected slot index. -1 when resting. */
  degree: number;
}

function resolveExtension(cfg: MappingConfig): ChordExtension {
  if (cfg.extension) return cfg.extension;
  if (cfg.seventh) return "7th";
  return "triad";
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Extended-finger count 1..5 → scale degree 0..4 (I, ii, iii, IV, V). */
export function countToDegree(count: number): number {
  return clamp(count, 1, 5) - 1;
}

/** Extended-finger count 1..5 → palette slot 0..4 (progression mode). */
export function countToSlot(count: number): number {
  return clamp(count, 1, 5) - 1;
}

/**
 * Progression mode: the modifier (left) hand, held open, shifts the slot
 * window by +5 so the right hand's 1..5 reaches slots 6..10.
 */
export function modifierToSlotOffset(mod: HandPose | null): number {
  return mod && mod.extendedCount >= 3 ? 5 : 0;
}

/** Hand X in [0,1] → inversion 0,1,2 (root, 1st, 2nd). */
export function xToInversion(x: number): number {
  if (x < 1 / 3) return 0;
  if (x < 2 / 3) return 1;
  return 2;
}

/** Hand Y in [0,1] (y down) → exponential low-pass cutoff. Top = bright. */
export function yToCutoff(y: number, minHz = 220, maxHz = 6000): number {
  const t = clamp(1 - y, 0, 1); // top of frame -> 1 -> bright
  return minHz * Math.pow(maxHz / minHz, t);
}

/** Pinch distance → expression 0..1 (open hand loud, pinched quiet). */
export function pinchToExpression(pinch: number): number {
  return clamp(pinch / 1.2, 0, 1);
}

/**
 * Modifier hand (two-hand mode) → octave shift in {-1, 0, +1}.
 * Fist / few fingers lower the octave, an open hand raises it.
 */
export function modifierToOctaveShift(mod: HandPose): number {
  if (mod.extendedCount <= 1) return -1;
  if (mod.extendedCount >= 4) return 1;
  return 0;
}

/**
 * Translate the playing hand (and optional modifier hand) into a Selection.
 *
 * @param play  the primary/right hand, or null when no hand is detected
 * @param mod   the modifier/left hand in two-hand mode (else null)
 */
export function mapHandsToSelection(
  play: HandPose | null,
  mod: HandPose | null,
  cfg: MappingConfig
): Selection {
  const minHz = cfg.filterMinHz ?? 220;
  const maxHz = cfg.filterMaxHz ?? 6000;
  const mode: PlayMode = cfg.mode ?? "diatonic";

  // The two-hand modifier now serves the SAME role in both modes: an open left
  // hand adds a +5 offset to the right hand's index. In diatonic mode this
  // reaches degrees vi/vii; in progression mode it reaches slots 6-10. (This
  // replaces the previous two-hand octave-shift in diatonic mode, prioritizing
  // access to all seven diatonic degrees.) octaveShift is retained on the
  // Selection for back-compat but is always 0.
  const octaveShift = 0;

  // No hand, or a closed fist -> rest / mute.
  if (!play || play.fist) {
    return {
      chord: null,
      rest: true,
      cutoffHz: play ? yToCutoff(play.y, minHz, maxHz) : minHz,
      expression: play ? pinchToExpression(play.pinch) : 0,
      octaveShift,
      inversion: 0,
      degree: -1,
    };
  }

  const inversion = xToInversion(play.x);
  const cutoffHz = yToCutoff(play.y, minHz, maxHz);
  const expression = pinchToExpression(play.pinch);

  if (mode === "progression") {
    const palette = cfg.progression ?? [];
    const offset = cfg.twoHand ? modifierToSlotOffset(mod) : 0;
    const slot = countToSlot(play.extendedCount) + offset;
    const parsed = palette[slot] ?? null;
    // Empty / unparseable / out-of-range slot -> rest.
    if (!parsed) {
      return {
        chord: null,
        rest: true,
        cutoffHz,
        expression,
        octaveShift: 0,
        inversion,
        degree: slot,
      };
    }
    const chord = voiceParsed(parsed, cfg.key.octave, inversion);
    return {
      chord,
      rest: false,
      cutoffHz,
      expression,
      octaveShift: 0,
      inversion,
      degree: slot,
    };
  }

  // Diatonic mode. Right-hand 1..5 -> degrees I..V. With two-hand mode, an open
  // left hand adds +5 so 1 finger -> vi and 2 fingers -> vii; higher counts are
  // clamped to vii (degree 6) so you can't overshoot the scale.
  const degreeOffset = cfg.twoHand ? modifierToSlotOffset(mod) : 0;
  const maxDegree = scaleDegreeCount(cfg.key.scale) - 1;
  const degree = clamp(
    countToDegree(play.extendedCount) + degreeOffset,
    0,
    maxDegree
  );
  const key: KeyConfig = {
    ...cfg.key,
    octave: cfg.key.octave + octaveShift,
  };
  const chord = buildChord(key, degree, resolveExtension(cfg), inversion);

  return {
    chord,
    rest: false,
    cutoffHz,
    expression,
    octaveShift,
    inversion,
    degree,
  };
}
