// smoothing.ts - pure gesture-smoothing math.
//
// A One-Euro filter (Casiez, Roussel, Vogel 2012) adaptively smooths noisy
// signals: heavy smoothing when the value is stable (kills jitter), light
// smoothing when it moves fast (keeps responsiveness). Plus a plain EMA helper.

/** Exponential moving average step. alpha in [0,1]: higher = less smoothing. */
export function ema(prev: number, x: number, alpha: number): number {
  return alpha * x + (1 - alpha) * prev;
}

function alphaFromCutoff(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuroFilter {
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;

  private xPrev = 0;
  private dxPrev = 0;
  private tPrev = 0;
  private started = false;

  constructor(minCutoff = 1.0, beta = 0.01, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  setParams(minCutoff: number, beta: number): void {
    this.minCutoff = minCutoff;
    this.beta = beta;
  }

  reset(): void {
    this.started = false;
  }

  /** Filter sample `x` observed at time `t` seconds. */
  filter(x: number, t: number): number {
    if (!this.started) {
      this.started = true;
      this.xPrev = x;
      this.dxPrev = 0;
      this.tPrev = t;
      return x;
    }
    let dt = t - this.tPrev;
    if (!(dt > 0)) dt = 1 / 60; // guard against zero/negative timestamps
    this.tPrev = t;

    const dx = (x - this.xPrev) / dt;
    const aD = alphaFromCutoff(this.dCutoff, dt);
    const edx = ema(this.dxPrev, dx, aD);
    this.dxPrev = edx;

    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    const aX = alphaFromCutoff(cutoff, dt);
    const xHat = ema(this.xPrev, x, aX);
    this.xPrev = xHat;
    return xHat;
  }
}

/**
 * Map a UI smoothing amount (0 = off, 1 = heavy) to One-Euro params. Higher
 * amount lowers the minimum cutoff (more smoothing) and the beta (less speed
 * adaptivity). Amount 0 uses a very high cutoff, i.e. effectively passthrough.
 */
export function paramsForAmount(amount: number): {
  minCutoff: number;
  beta: number;
} {
  const a = Math.max(0, Math.min(1, amount));
  if (a <= 0) return { minCutoff: 1000, beta: 0.02 };
  const minCutoff = 5.0 + (0.6 - 5.0) * a; // 5.0 -> 0.6
  const beta = 0.05 + (0.005 - 0.05) * a; // 0.05 -> 0.005
  return { minCutoff, beta };
}

export interface Pt {
  x: number;
  y: number;
  z?: number;
}

/**
 * Smooths a stream of hand-landmark arrays with a per-coordinate One-Euro
 * filter. One instance per tracked hand; call filter() once per frame.
 */
export class LandmarkSmoother {
  private fx: OneEuroFilter[] = [];
  private fy: OneEuroFilter[] = [];
  private amount = 0;

  setAmount(amount: number): void {
    this.amount = amount;
    const { minCutoff, beta } = paramsForAmount(amount);
    for (const f of this.fx) f.setParams(minCutoff, beta);
    for (const f of this.fy) f.setParams(minCutoff, beta);
  }

  reset(): void {
    for (const f of this.fx) f.reset();
    for (const f of this.fy) f.reset();
  }

  /** Return smoothed copies of `pts` at time `t` seconds. */
  filter(pts: Pt[], t: number): Pt[] {
    if (this.amount <= 0) return pts;
    const { minCutoff, beta } = paramsForAmount(this.amount);
    const out: Pt[] = new Array(pts.length);
    for (let i = 0; i < pts.length; i++) {
      if (!this.fx[i]) {
        this.fx[i] = new OneEuroFilter(minCutoff, beta);
        this.fy[i] = new OneEuroFilter(minCutoff, beta);
      }
      out[i] = {
        x: this.fx[i].filter(pts[i].x, t),
        y: this.fy[i].filter(pts[i].y, t),
        z: pts[i].z,
      };
    }
    return out;
  }
}
