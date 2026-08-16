import { describe, it, expect } from "vitest";
import {
  clampPan,
  exportSpanSec,
  exportFrames,
  encodeWavStereo,
} from "./producerMixer";
import { effectiveGain } from "./vocalLooper";

describe("clampPan", () => {
  it("clamps to -1..1 and maps NaN to 0", () => {
    expect(clampPan(0)).toBe(0);
    expect(clampPan(0.3)).toBe(0.3);
    expect(clampPan(5)).toBe(1);
    expect(clampPan(-5)).toBe(-1);
    expect(clampPan(NaN)).toBe(0);
  });
});

describe("mixer gain/mute/solo math (reused effectiveGain)", () => {
  it("mutes silence a track", () => {
    expect(effectiveGain({ muted: true, solo: false, volume: 1 }, false)).toBe(0);
  });
  it("non-soloed tracks are silent when any track is soloed", () => {
    expect(effectiveGain({ muted: false, solo: false, volume: 1 }, true)).toBe(0);
    expect(effectiveGain({ muted: false, solo: true, volume: 0.8 }, true)).toBe(
      0.8
    );
  });
  it("plain volume applies with no solo active", () => {
    expect(effectiveGain({ muted: false, solo: false, volume: 0.6 }, false)).toBe(
      0.6
    );
  });
});

describe("exportSpanSec", () => {
  it("uses the transport loop when present", () => {
    expect(exportSpanSec(4, 30)).toBe(4);
  });
  it("falls back to the longest stem when there is no loop", () => {
    expect(exportSpanSec(0, 12)).toBe(12);
  });
  it("is zero when nothing to export", () => {
    expect(exportSpanSec(0, 0)).toBe(0);
  });
});

describe("exportFrames", () => {
  it("computes cycles * span * sampleRate", () => {
    expect(exportFrames(2, 4, 48000)).toBe(2 * 4 * 48000);
  });
  it("is at least one frame", () => {
    expect(exportFrames(0, 0, 48000)).toBe(1);
  });
});

describe("encodeWavStereo", () => {
  it("writes a valid 2-channel 16-bit WAV header", () => {
    const left = new Float32Array([0, 0.5, -0.5, 1]);
    const right = new Float32Array([0, -0.5, 0.5, -1]);
    const buf = encodeWavStereo(left, right, 44100);
    const view = new DataView(buf);
    // "RIFF"
    expect(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))).toBe("RIFF");
    // "WAVE"
    expect(String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11))).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(2); // channels
    expect(view.getUint32(24, true)).toBe(44100); // sample rate
    expect(view.getUint16(32, true)).toBe(4); // block align (2ch * 2 bytes)
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    // data length = frames * blockAlign
    expect(view.getUint32(40, true)).toBe(4 * 4);
    // total size = 44 + data
    expect(buf.byteLength).toBe(44 + 4 * 4);
  });

  it("interleaves L/R samples and clips to full scale", () => {
    const left = new Float32Array([1]);
    const right = new Float32Array([-1]);
    const buf = encodeWavStereo(left, right, 8000);
    const view = new DataView(buf);
    expect(view.getInt16(44, true)).toBe(0x7fff); // L clipped +
    expect(view.getInt16(46, true)).toBe(-0x8000); // R clipped -
  });

  it("uses the shorter channel length when lengths differ", () => {
    const left = new Float32Array([0, 0, 0]);
    const right = new Float32Array([0]);
    const buf = encodeWavStereo(left, right, 8000);
    expect(new DataView(buf).getUint32(40, true)).toBe(1 * 4);
  });
});
