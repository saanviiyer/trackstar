import { describe, it, expect } from "vitest";
import {
  PRESETS,
  PRESET_NAMES,
  getPreset,
  defaultSound,
  unisonDetunes,
  cloneSound,
  type SoundConfig,
} from "./presets";

describe("preset catalog", () => {
  it("provides at least the 8 required modes (plus Basic)", () => {
    expect(PRESET_NAMES.length).toBeGreaterThanOrEqual(8);
    for (const name of [
      "Warm Pad",
      "Pluck",
      "Chiptune",
      "Supersaw Lead",
      "Bell",
      "Organ",
      "Sub Bass",
      "Dream",
    ]) {
      expect(PRESET_NAMES).toContain(name);
    }
  });

  it("every preset has the full SoundConfig shape", () => {
    for (const name of PRESET_NAMES) {
      const p = PRESETS[name];
      expect(typeof p.waveform).toBe("string");
      expect(p.unison).toBeGreaterThanOrEqual(1);
      expect(p.env).toHaveProperty("attack");
      expect(p.env).toHaveProperty("decay");
      expect(p.env).toHaveProperty("sustain");
      expect(p.env).toHaveProperty("release");
      expect(p.fx).toHaveProperty("reverb");
      expect(p.fx).toHaveProperty("delay");
      expect(p.fx).toHaveProperty("distortion");
      expect(p.fx).toHaveProperty("chorus");
      expect(["off", "pitch", "filter", "amp"]).toContain(p.lfo.target);
    }
  });
});

describe("preset character (distinct bundles)", () => {
  it("Chiptune is a square with all effects off", () => {
    const p = getPreset("Chiptune");
    expect(p.waveform).toBe("square");
    expect(p.fx.reverb.on).toBe(false);
    expect(p.fx.delay.on).toBe(false);
    expect(p.fx.distortion.on).toBe(false);
    expect(p.fx.chorus.on).toBe(false);
  });

  it("Supersaw Lead uses 7 detuned saw voices", () => {
    const p = getPreset("Supersaw Lead");
    expect(p.waveform).toBe("sawtooth");
    expect(p.unison).toBe(7);
    expect(p.detune).toBeGreaterThan(0);
  });

  it("Warm Pad has a slow attack, reverb and chorus on", () => {
    const p = getPreset("Warm Pad");
    expect(p.env.attack).toBeGreaterThan(0.3);
    expect(p.fx.reverb.on).toBe(true);
    expect(p.fx.chorus.on).toBe(true);
  });

  it("Pluck is fast attack, short/zero sustain, snappy", () => {
    const p = getPreset("Pluck");
    expect(p.env.attack).toBeLessThan(0.02);
    expect(p.env.sustain).toBeLessThanOrEqual(0.1);
  });

  it("Sub Bass has a strong sub oscillator", () => {
    const p = getPreset("Sub Bass");
    expect(p.subLevel).toBeGreaterThan(0.5);
  });

  it("Bell has fast attack + long release", () => {
    const p = getPreset("Bell");
    expect(p.env.attack).toBeLessThan(0.01);
    expect(p.env.release).toBeGreaterThan(1);
  });

  it("Dream is ambient: slow attack, big reverb + delay", () => {
    const p = getPreset("Dream");
    expect(p.env.attack).toBeGreaterThan(0.8);
    expect(p.fx.reverb.on).toBe(true);
    expect(p.fx.delay.on).toBe(true);
  });

  it("Organ is sustained sines with minimal envelope", () => {
    const p = getPreset("Organ");
    expect(p.waveform).toBe("sine");
    expect(p.env.sustain).toBe(1);
  });
});

describe("getPreset / cloneSound return independent copies", () => {
  it("mutating a returned preset does not affect the catalog", () => {
    const a = getPreset("Warm Pad");
    a.unison = 99;
    a.fx.reverb.on = false;
    const b = getPreset("Warm Pad");
    expect(b.unison).not.toBe(99);
    expect(b.fx.reverb.on).toBe(true);
  });

  it("cloneSound deep-copies nested objects", () => {
    const base: SoundConfig = getPreset("Dream");
    const copy = cloneSound(base);
    copy.env.attack = 0;
    copy.fx.delay.mix = 0;
    expect(base.env.attack).not.toBe(0);
    expect(base.fx.delay.mix).not.toBe(0);
  });

  it("defaultSound is the Basic voice (2 saws, no fx)", () => {
    const d = defaultSound();
    expect(d.waveform).toBe("sawtooth");
    expect(d.unison).toBe(2);
    expect(d.fx.reverb.on).toBe(false);
  });
});

describe("unisonDetunes", () => {
  it("1 voice is centered", () => {
    expect(unisonDetunes(1, 20)).toEqual([0]);
  });
  it("returns exactly `count` offsets", () => {
    for (const n of [1, 2, 3, 5, 7]) {
      expect(unisonDetunes(n, 20)).toHaveLength(n);
    }
  });
  it("3 voices over 12 cents span symmetrically", () => {
    expect(unisonDetunes(3, 12)).toEqual([-6, 0, 6]);
  });
  it("spreads symmetrically around 0 (sum ~ 0)", () => {
    const sum = unisonDetunes(7, 25).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(0, 8);
  });
  it("endpoints reach +/- spread/2", () => {
    const d = unisonDetunes(5, 30);
    expect(d[0]).toBeCloseTo(-15, 8);
    expect(d[d.length - 1]).toBeCloseTo(15, 8);
  });
});
