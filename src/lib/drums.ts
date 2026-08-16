// drums.ts - synthesized drum machine + metronome.
//
// Pure pattern data + step logic live here (testable). The DrumMachine class is
// a lookahead scheduler (same "Tale of Two Clocks" approach as the arpeggiator)
// running at 16th-note resolution. It shares the transport tempo (BPM) with the
// arpeggiator: both run at the same BPM against AudioContext.currentTime, so the
// drums and arp stay locked.

export type DrumInstrument = "kick" | "snare" | "hat";

export interface DrumPattern {
  kick: number[]; // 16 steps, 1 = hit
  snare: number[];
  hat: number[];
}

export const STEPS_PER_BAR = 16; // 16th notes

function steps(hits: number[]): number[] {
  const a = new Array(STEPS_PER_BAR).fill(0);
  for (const i of hits) if (i >= 0 && i < STEPS_PER_BAR) a[i] = 1;
  return a;
}

export type DrumPatternName =
  | "Off"
  | "Four-on-floor"
  | "Boom-bap"
  | "Hi-hat 8ths";

export const DRUM_PATTERNS: Record<DrumPatternName, DrumPattern> = {
  Off: { kick: steps([]), snare: steps([]), hat: steps([]) },
  "Four-on-floor": {
    kick: steps([0, 4, 8, 12]),
    snare: steps([4, 12]),
    hat: steps([0, 2, 4, 6, 8, 10, 12, 14]),
  },
  "Boom-bap": {
    kick: steps([0, 10]),
    snare: steps([4, 12]),
    hat: steps([0, 2, 4, 6, 8, 10, 12, 14]),
  },
  "Hi-hat 8ths": {
    kick: steps([0]),
    snare: steps([]),
    hat: steps([0, 2, 4, 6, 8, 10, 12, 14]),
  },
};

export const DRUM_PATTERN_NAMES: DrumPatternName[] = Object.keys(
  DRUM_PATTERNS
) as DrumPatternName[];

export interface StepHits {
  kick: boolean;
  snare: boolean;
  hat: boolean;
}

/** Which instruments fire on `step` (0..15) of a named pattern. */
export function drumHits(name: DrumPatternName, step: number): StepHits {
  const p = DRUM_PATTERNS[name];
  const i = ((step % STEPS_PER_BAR) + STEPS_PER_BAR) % STEPS_PER_BAR;
  return {
    kick: p.kick[i] === 1,
    snare: p.snare[i] === 1,
    hat: p.hat[i] === 1,
  };
}

/** Metronome: a click on every quarter (steps 0,4,8,12); accent on beat 1. */
export function metronomeClick(step: number): { click: boolean; accent: boolean } {
  const i = ((step % STEPS_PER_BAR) + STEPS_PER_BAR) % STEPS_PER_BAR;
  return { click: i % 4 === 0, accent: i === 0 };
}

export interface DrumTriggers {
  kick: (time: number) => void;
  snare: (time: number) => void;
  hat: (time: number) => void;
  click: (time: number, accent: boolean) => void;
}

export interface DrumEnables {
  kick: boolean;
  snare: boolean;
  hat: boolean;
}

/**
 * Lookahead scheduler for drums + metronome at 16th-note resolution. Shares the
 * BPM with the arpeggiator so the two stay in tempo.
 */
export class DrumMachine {
  private ctx: AudioContext;
  private trig: DrumTriggers;

  private bpm = 120;
  private pattern: DrumPatternName = "Four-on-floor";
  private enables: DrumEnables = { kick: true, snare: true, hat: true };
  private metronome = false;

  private step = 0;
  private nextTime = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly lookaheadMs = 25;
  private readonly scheduleAhead = 0.1;

  constructor(ctx: AudioContext, trig: DrumTriggers) {
    this.ctx = ctx;
    this.trig = trig;
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  setBpm(bpm: number): void {
    this.bpm = Math.max(20, Math.min(300, bpm));
  }
  setPattern(name: DrumPatternName): void {
    this.pattern = name;
  }
  setEnables(e: DrumEnables): void {
    this.enables = { ...e };
  }
  setMetronome(on: boolean): void {
    this.metronome = on;
  }

  private stepDuration(): number {
    return 60 / this.bpm / 4; // 16th note
  }

  start(): void {
    if (this.timer !== null) return;
    this.step = 0;
    this.nextTime = this.ctx.currentTime + 0.06;
    this.timer = setInterval(() => this.tick(), this.lookaheadMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    const dur = this.stepDuration();
    while (this.nextTime < this.ctx.currentTime + this.scheduleAhead) {
      const t = this.nextTime;
      const hits = drumHits(this.pattern, this.step);
      if (hits.kick && this.enables.kick) this.trig.kick(t);
      if (hits.snare && this.enables.snare) this.trig.snare(t);
      if (hits.hat && this.enables.hat) this.trig.hat(t);
      if (this.metronome) {
        const m = metronomeClick(this.step);
        if (m.click) this.trig.click(t, m.accent);
      }
      this.nextTime += dur;
      this.step = (this.step + 1) % STEPS_PER_BAR;
    }
  }
}
