import { describe, it, expect } from "vitest";
import { computeRms, computePeak, levelToBar } from "./meter";

describe("computeRms", () => {
  it("is 0 for an empty block", () => {
    expect(computeRms(new Float32Array(0))).toBe(0);
  });

  it("is 0 for pure silence", () => {
    expect(computeRms(new Float32Array(64))).toBe(0);
  });

  it("equals the amplitude for a full-scale DC block", () => {
    const s = new Float32Array(100).fill(1);
    expect(computeRms(s)).toBeCloseTo(1, 6);
  });

  it("is amplitude/sqrt(2) for a sine wave", () => {
    const n = 2048;
    const s = new Float32Array(n);
    for (let i = 0; i < n; i++) s[i] = Math.sin((2 * Math.PI * i) / 64);
    expect(computeRms(s)).toBeCloseTo(1 / Math.SQRT2, 2);
  });

  it("ignores sign (uses squares)", () => {
    const s = new Float32Array([-0.5, 0.5, -0.5, 0.5]);
    expect(computeRms(s)).toBeCloseTo(0.5, 6);
  });
});

describe("computePeak", () => {
  it("is 0 for an empty block", () => {
    expect(computePeak(new Float32Array(0))).toBe(0);
  });

  it("returns the largest absolute sample", () => {
    expect(computePeak(new Float32Array([0.1, -0.9, 0.3]))).toBeCloseTo(0.9, 6);
  });

  it("is at least the RMS for the same block", () => {
    const s = new Float32Array([0.2, -0.4, 0.6, -0.8]);
    expect(computePeak(s)).toBeGreaterThanOrEqual(computeRms(s));
  });
});

describe("levelToBar", () => {
  it("maps silence to 0", () => {
    expect(levelToBar(0)).toBe(0);
  });

  it("maps full scale to 1", () => {
    expect(levelToBar(1)).toBe(1);
  });

  it("clamps at or below the floor to 0", () => {
    // -60 dB is amplitude 0.001; anything quieter reads 0.
    expect(levelToBar(0.0005)).toBe(0);
  });

  it("maps the half-way dB point to ~0.5", () => {
    // -30 dB is amplitude 10^(-30/20) ~= 0.0316, half of the -60..0 range.
    expect(levelToBar(Math.pow(10, -30 / 20))).toBeCloseTo(0.5, 2);
  });

  it("is monotonic in amplitude", () => {
    expect(levelToBar(0.5)).toBeGreaterThan(levelToBar(0.05));
    expect(levelToBar(0.05)).toBeGreaterThan(levelToBar(0.005));
  });

  it("clamps above full scale to 1", () => {
    expect(levelToBar(2)).toBe(1);
  });
});
