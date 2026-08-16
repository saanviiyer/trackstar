import { describe, it, expect } from "vitest";
import {
  ema,
  OneEuroFilter,
  paramsForAmount,
  LandmarkSmoother,
} from "./smoothing";

function variance(xs: number[]): number {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
}

describe("ema", () => {
  it("alpha 1 passes the new value through", () => {
    expect(ema(5, 9, 1)).toBe(9);
  });
  it("alpha 0 keeps the previous value", () => {
    expect(ema(5, 9, 0)).toBe(5);
  });
  it("blends between prev and x", () => {
    expect(ema(0, 10, 0.5)).toBe(5);
  });
});

describe("OneEuroFilter", () => {
  it("first sample is returned unchanged", () => {
    const f = new OneEuroFilter(1, 0.01);
    expect(f.filter(0.42, 0)).toBe(0.42);
  });

  it("reduces variance of a noisy constant signal", () => {
    const f = new OneEuroFilter(0.6, 0.005);
    const noisy: number[] = [];
    const out: number[] = [];
    let seed = 1;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed / 0x7fffffff) * 2 - 1;
    };
    for (let i = 0; i < 200; i++) {
      const t = i / 60;
      const x = 0.5 + rnd() * 0.05; // jitter around 0.5
      noisy.push(x);
      out.push(f.filter(x, t));
    }
    // Smoothed signal is far less jittery and stays near the mean.
    expect(variance(out.slice(50))).toBeLessThan(variance(noisy.slice(50)));
    const mean = out.slice(50).reduce((a, b) => a + b, 0) / 150;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
  });

  it("eventually converges toward a new steady value (step response)", () => {
    const f = new OneEuroFilter(1.0, 0.01);
    let y = 0;
    for (let i = 0; i < 400; i++) y = f.filter(1, i / 60);
    expect(y).toBeGreaterThan(0.9);
    expect(y).toBeLessThanOrEqual(1.0001);
  });

  it("guards against zero/negative dt without throwing", () => {
    const f = new OneEuroFilter(1, 0.01);
    f.filter(0, 0);
    expect(() => f.filter(1, 0)).not.toThrow();
  });
});

describe("paramsForAmount", () => {
  it("amount 0 is effectively passthrough (very high cutoff)", () => {
    expect(paramsForAmount(0).minCutoff).toBeGreaterThan(100);
  });
  it("more smoothing lowers the min cutoff monotonically", () => {
    expect(paramsForAmount(1).minCutoff).toBeLessThan(paramsForAmount(0.5).minCutoff);
    expect(paramsForAmount(0.5).minCutoff).toBeLessThan(paramsForAmount(0.1).minCutoff);
  });
  it("clamps out-of-range amounts", () => {
    expect(paramsForAmount(5)).toEqual(paramsForAmount(1));
    expect(paramsForAmount(-1)).toEqual(paramsForAmount(0));
  });
});

describe("LandmarkSmoother", () => {
  it("passes through when amount is 0", () => {
    const s = new LandmarkSmoother();
    s.setAmount(0);
    const pts = [
      { x: 0.1, y: 0.2 },
      { x: 0.3, y: 0.4 },
    ];
    expect(s.filter(pts, 0)).toBe(pts); // same reference (bypass)
  });

  it("smooths a jittery landmark stream toward its mean", () => {
    const s = new LandmarkSmoother();
    s.setAmount(0.9);
    let last = { x: 0, y: 0 };
    const flip = [0.02, -0.02, 0.02, -0.02];
    for (let i = 0; i < 60; i++) {
      const out = s.filter(
        [{ x: 0.5 + flip[i % 4], y: 0.5 - flip[i % 4] }],
        i / 60
      );
      last = out[0];
    }
    expect(Math.abs(last.x - 0.5)).toBeLessThan(0.02);
    expect(Math.abs(last.y - 0.5)).toBeLessThan(0.02);
  });
});
