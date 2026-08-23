import { describe, it, expect } from "vitest";
import {
  detectPitchAutocorr,
  shiftRatio,
  nearestOctaveFreq,
  computeHarmony,
} from "./harmonizer";
import { midiToFreq, pitchToMidi } from "./music";

/** A block of a pure sine at `freq` Hz. */
function sine(freq: number, sampleRate: number, n: number, amp = 0.5): Float32Array {
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    buf[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return buf;
}

const SR = 44100;
const N = 2048;

describe("detectPitchAutocorr", () => {
  it("recovers the frequency of a synthetic sine (within ~1.5%)", () => {
    for (const f of [110, 146.83, 220, 261.63, 329.63, 440, 660]) {
      const est = detectPitchAutocorr(sine(f, SR, N), SR)!;
      expect(est).not.toBeNull();
      expect(Math.abs(est - f) / f).toBeLessThan(0.015);
    }
  });

  it("returns null on silence", () => {
    expect(detectPitchAutocorr(new Float32Array(N), SR)).toBeNull();
  });

  it("returns null on a signal below the RMS gate", () => {
    // A real but extremely quiet sine is treated as silence.
    expect(detectPitchAutocorr(sine(220, SR, N, 0.0005), SR)).toBeNull();
  });

  it("returns null on white noise (no clear pitch)", () => {
    const buf = new Float32Array(N);
    let seed = 12345;
    for (let i = 0; i < N; i++) {
      // Deterministic pseudo-random noise.
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      buf[i] = (seed / 0x7fffffff) * 2 - 1;
    }
    expect(detectPitchAutocorr(buf, SR)).toBeNull();
  });

  it("does not make an octave error on a rich (harmonic) tone", () => {
    // Fundamental + 2nd + 3rd harmonics; fundamental must still win.
    const f0 = 196; // G3
    const buf = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const t = i / SR;
      buf[i] =
        0.5 * Math.sin(2 * Math.PI * f0 * t) +
        0.3 * Math.sin(2 * Math.PI * 2 * f0 * t) +
        0.2 * Math.sin(2 * Math.PI * 3 * f0 * t);
    }
    const est = detectPitchAutocorr(buf, SR)!;
    expect(Math.abs(est - f0) / f0).toBeLessThan(0.02);
  });
});

describe("shiftRatio", () => {
  it("is target/detected", () => {
    expect(shiftRatio(660, 440)).toBeCloseTo(1.5, 6);
    expect(shiftRatio(440, 440)).toBeCloseTo(1, 6);
    expect(shiftRatio(220, 440)).toBeCloseTo(0.5, 6);
  });

  it("is 1 for invalid input", () => {
    expect(shiftRatio(440, 0)).toBe(1);
    expect(shiftRatio(0, 440)).toBe(1);
    expect(shiftRatio(NaN, 440)).toBe(1);
  });
});

describe("nearestOctaveFreq", () => {
  it("keeps a chord tone already near the reference unchanged", () => {
    expect(nearestOctaveFreq(261.63, 261.63)).toBeCloseTo(261.63, 3);
  });

  it("raises a low chord tone into the octave nearest the reference", () => {
    // C3 (130.8) vs a sung C4 (261.6) -> C4.
    expect(nearestOctaveFreq(130.81, 261.63)).toBeCloseTo(261.62, 1);
  });

  it("lowers a high chord tone into the octave nearest the reference", () => {
    // C6 (1046.5) vs a sung C4 (261.6) -> C4.
    expect(nearestOctaveFreq(1046.5, 261.63)).toBeCloseTo(261.63, 1);
  });

  it("always lands within a tritone (ratio in [1/sqrt2, sqrt2]) of the reference", () => {
    const ref = 300;
    for (const tone of [80, 123, 200, 415, 700, 1500]) {
      const placed = nearestOctaveFreq(tone, ref);
      const r = placed / ref;
      expect(r).toBeGreaterThanOrEqual(1 / Math.SQRT2 - 1e-9);
      expect(r).toBeLessThanOrEqual(Math.SQRT2 + 1e-9);
    }
  });
});

describe("computeHarmony", () => {
  // A C-major triad built by the music engine (C, E, G).
  const cMajor = [0, 4, 7].map((iv) => midiToFreq(pitchToMidi(iv % 12, 3)));

  it("returns no voices without a sung pitch or a chord", () => {
    expect(computeHarmony(null, cMajor)).toEqual([]);
    expect(computeHarmony(0, cMajor)).toEqual([]);
    expect(computeHarmony(261.63, [])).toEqual([]);
  });

  it("makes one voice per chord tone with ratio = target/sung", () => {
    const sung = midiToFreq(pitchToMidi(0, 4)); // C4
    const voices = computeHarmony(sung, cMajor, 4);
    expect(voices).toHaveLength(3);
    for (const v of voices) {
      expect(v.ratio).toBeCloseTo(v.targetFreq / sung, 6);
    }
  });

  it("places the harmony on C, E, G pitch classes near the sung note", () => {
    const sung = midiToFreq(pitchToMidi(0, 4)); // C4 261.6
    const voices = computeHarmony(sung, cMajor, 4);
    const pcs = voices
      .map((v) => Math.round(12 * Math.log2(v.targetFreq / 440) + 69) % 12)
      .map((m) => ((m % 12) + 12) % 12)
      .sort((a, b) => a - b);
    // C=0, E=4, G=7.
    expect(pcs).toEqual([0, 4, 7]);
  });

  it("caps the number of voices at maxVoices", () => {
    const sung = midiToFreq(pitchToMidi(0, 4));
    const cMaj7 = [0, 4, 7, 11].map((iv) =>
      midiToFreq(pitchToMidi(iv % 12, 3))
    );
    expect(computeHarmony(sung, cMaj7, 3)).toHaveLength(3);
    expect(computeHarmony(sung, cMaj7, 4)).toHaveLength(4);
  });

  it("keeps the tones nearest the sung pitch when capping", () => {
    const sung = midiToFreq(pitchToMidi(0, 4)); // C4
    // Unison C is nearest; it must survive a cap of 1.
    const voices = computeHarmony(sung, cMajor, 1);
    expect(voices).toHaveLength(1);
    expect(voices[0].ratio).toBeCloseTo(1, 2);
  });
});
