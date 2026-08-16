// arp.ts - arpeggiator: pure sequence generation + a Web Audio lookahead
// scheduler ("A Tale of Two Clocks"). The sequence generator is pure and
// testable; the scheduler drives Synth.triggerNote at precise AudioContext
// times.

import { midiToFreq } from "./music";

export type ArpPattern = "up" | "down" | "updown" | "random";

// Note division -> beats per step (a beat = one quarter note).
export type ArpDivision = "1/4" | "1/8" | "1/16" | "1/8T" | "1/16T";

export const DIVISION_BEATS: Record<ArpDivision, number> = {
  "1/4": 1,
  "1/8": 0.5,
  "1/16": 0.25,
  "1/8T": 1 / 3,
  "1/16T": 1 / 6,
};

/** Expand chord notes across `octaveRange` octaves (ascending, de-duped). */
export function expandOctaves(notes: number[], octaveRange: number): number[] {
  const base = [...new Set(notes)].sort((a, b) => a - b);
  const range = Math.max(1, Math.floor(octaveRange));
  const out: number[] = [];
  for (let o = 0; o < range; o++) {
    for (const n of base) out.push(n + 12 * o);
  }
  return out;
}

/**
 * Build the ordered note sequence for one arpeggio cycle.
 *
 * - up:     ascending pool
 * - down:   descending pool
 * - updown: ascending then descending, without repeating the extremes
 *           (e.g. [C,E,G] -> C E G E; two octaves -> C E G c e g e c G E)
 * - random: returns the ascending pool; the scheduler samples from it (kept
 *           deterministic here so the function stays pure/testable)
 */
export function arpSequence(
  notes: number[],
  pattern: ArpPattern,
  octaveRange: number
): number[] {
  const pool = expandOctaves(notes, octaveRange);
  if (pool.length <= 1) return pool;
  switch (pattern) {
    case "up":
      return pool;
    case "down":
      return [...pool].reverse();
    case "updown":
      return pool.concat(pool.slice(1, -1).reverse());
    case "random":
      return pool;
  }
}

export interface ArpParams {
  pattern: ArpPattern;
  division: ArpDivision;
  bpm: number;
  octaveRange: number;
  /** Fraction of a step the note sounds (0.05..1). */
  gate: number;
}

const DEFAULT_PARAMS: ArpParams = {
  pattern: "up",
  division: "1/8",
  bpm: 120,
  octaveRange: 1,
  gate: 0.6,
};

/**
 * Lookahead scheduler. Every `lookaheadMs` it schedules any notes whose start
 * time falls within `scheduleAheadTime` seconds, using AudioContext.currentTime
 * as the authoritative clock. Timing stays tight even if the timer jitters.
 */
export class Arpeggiator {
  private ctx: AudioContext;
  private trigger: (freq: number, atTime: number, gate: number) => void;

  private params: ArpParams = { ...DEFAULT_PARAMS };
  private notes: number[] = [];
  private seq: number[] = [];
  private step = 0;
  private nextNoteTime = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  private readonly lookaheadMs = 25;
  private readonly scheduleAheadTime = 0.1;

  constructor(
    ctx: AudioContext,
    trigger: (freq: number, atTime: number, gate: number) => void
  ) {
    this.ctx = ctx;
    this.trigger = trigger;
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  setParams(p: Partial<ArpParams>): void {
    this.params = { ...this.params, ...p };
    this.rebuildSequence();
  }

  /** Set the chord to arpeggiate. Empty array stops the arp. */
  setChord(notes: number[]): void {
    const changed =
      notes.length !== this.notes.length ||
      notes.some((n, i) => n !== this.notes[i]);
    if (!changed) return;
    this.notes = [...notes];
    this.rebuildSequence();
    if (notes.length === 0) {
      this.stop();
    } else if (!this.isRunning) {
      this.start();
    }
  }

  private rebuildSequence(): void {
    this.seq = arpSequence(
      this.notes,
      this.params.pattern,
      this.params.octaveRange
    );
    if (this.seq.length > 0) this.step = this.step % this.seq.length;
    else this.step = 0;
  }

  private stepDuration(): number {
    const beat = 60 / Math.max(1, this.params.bpm);
    return beat * DIVISION_BEATS[this.params.division];
  }

  start(): void {
    if (this.timer !== null || this.seq.length === 0) return;
    this.step = 0;
    this.nextNoteTime = this.ctx.currentTime + 0.05;
    this.timer = setInterval(() => this.tick(), this.lookaheadMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    if (this.seq.length === 0) {
      this.stop();
      return;
    }
    const dur = this.stepDuration();
    while (this.nextNoteTime < this.ctx.currentTime + this.scheduleAheadTime) {
      const idx =
        this.params.pattern === "random"
          ? Math.floor(Math.random() * this.seq.length)
          : this.step % this.seq.length;
      const note = this.seq[idx];
      if (note !== undefined) {
        this.trigger(
          midiToFreq(note),
          this.nextNoteTime,
          Math.max(0.02, dur * this.params.gate)
        );
      }
      this.nextNoteTime += dur;
      this.step = (this.step + 1) % this.seq.length;
    }
  }
}
