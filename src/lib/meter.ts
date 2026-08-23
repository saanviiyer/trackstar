// meter.ts - a live input-level meter for the record source (Mic / Instrument /
// Mix). An AnalyserNode taps the chosen source node(s) and the pure helpers
// below turn a block of time-domain samples into RMS / peak levels and a 0..1
// bar value the UI can draw. Keeping the math pure makes it unit testable
// without a real AudioContext.
//
// Why this exists: it lets the user SEE their voice arriving before and during
// recording, which both helps them set levels and makes the capture path
// verifiable (if the meter moves when you talk, the mic is reaching the graph).

/** Root-mean-square level of a block of samples (0 for an empty block). */
export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/** Peak absolute amplitude of a block of samples (0 for an empty block). */
export function computePeak(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  return peak;
}

/**
 * Map a linear amplitude (0..1) to a 0..1 meter bar on a dB-ish curve so quiet
 * speech is clearly visible instead of hugging the floor. `floorDb` is the
 * bottom of the scale (default -60 dB). Pure and unit tested.
 */
export function levelToBar(amp: number, floorDb = -60): number {
  const a = Math.max(0, amp);
  if (a <= 0) return 0;
  const db = 20 * Math.log10(a);
  if (db <= floorDb) return 0;
  if (db >= 0) return 1;
  return (db - floorDb) / -floorDb;
}

export interface MeterReading {
  rms: number;
  peak: number;
  /** 0..1 bar value (peak mapped through levelToBar) for drawing. */
  bar: number;
}

/**
 * Wraps an AnalyserNode. Connect one or more source nodes (they sum into the
 * analyser) and call read() each animation frame. The analyser has no onward
 * connection, so it never adds anything to the output; it only observes.
 */
export class InputMeter {
  private analyser: AnalyserNode;
  // Backed by a plain ArrayBuffer so it matches getFloatTimeDomainData's
  // Float32Array<ArrayBuffer> parameter type under TS's typed-array generics.
  private buf: Float32Array<ArrayBuffer>;
  private connected: AudioNode[] = [];

  constructor(ctx: BaseAudioContext, fftSize = 1024) {
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = fftSize;
    this.analyser.smoothingTimeConstant = 0.4;
    this.buf = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
  }

  /**
   * Point the meter at a new set of source nodes. Previous inputs are
   * disconnected from the analyser only (never fully disconnected), so shared
   * nodes such as the mic hub keep feeding their other consumers.
   */
  setInputs(nodes: AudioNode[]): void {
    for (const n of this.connected) {
      try {
        n.disconnect(this.analyser);
      } catch {
        /* ignore */
      }
    }
    this.connected = [];
    for (const n of nodes) {
      if (!n) continue;
      try {
        n.connect(this.analyser);
        this.connected.push(n);
      } catch {
        /* ignore */
      }
    }
  }

  /** True when at least one source is feeding the meter. */
  get active(): boolean {
    return this.connected.length > 0;
  }

  /** Read the current level. Returns zeros when nothing is connected. */
  read(): MeterReading {
    if (this.connected.length === 0) return { rms: 0, peak: 0, bar: 0 };
    this.analyser.getFloatTimeDomainData(this.buf);
    const rms = computeRms(this.buf);
    const peak = computePeak(this.buf);
    return { rms, peak, bar: levelToBar(peak) };
  }

  dispose(): void {
    this.setInputs([]);
  }
}
