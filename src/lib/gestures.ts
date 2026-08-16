// gestures.ts - pure functions over MediaPipe hand landmarks.
//
// MediaPipe HandLandmarker returns 21 landmarks per hand, each normalized to
// the image: x,y in [0,1] (x right, y down), z relative depth. Index map:
//   0        wrist
//   1..4     thumb  (CMC, MCP, IP, TIP)
//   5..8     index  (MCP, PIP, DIP, TIP)
//   9..12    middle (MCP, PIP, DIP, TIP)
//   13..16   ring   (MCP, PIP, DIP, TIP)
//   17..20   pinky  (MCP, PIP, DIP, TIP)
//
// All functions here are pure so they can be unit tested with hand-crafted
// landmark arrays.

export interface Landmark {
  x: number;
  y: number;
  z?: number;
}

export const WRIST = 0;

// [pip-analog, tip] joint indices per finger, thumb first.
const FINGER_JOINTS: { pip: number; tip: number }[] = [
  { pip: 2, tip: 4 }, // thumb  (use MCP as the reference joint)
  { pip: 6, tip: 8 }, // index
  { pip: 10, tip: 12 }, // middle
  { pip: 14, tip: 16 }, // ring
  { pip: 18, tip: 20 }, // pinky
];

export const THUMB_TIP = 4;
export const INDEX_TIP = 8;
const MIDDLE_MCP = 9;

export type FingerFlags = [boolean, boolean, boolean, boolean, boolean];

function dist(a: Landmark, b: Landmark): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

/** Characteristic hand size: wrist → middle-finger MCP distance. */
export function handSize(lm: Landmark[]): number {
  const s = dist(lm[WRIST], lm[MIDDLE_MCP]);
  // Guard against degenerate input.
  return s > 1e-6 ? s : 1e-6;
}

/**
 * Which fingers are extended, order [thumb, index, middle, ring, pinky].
 *
 * Heuristic (orientation-independent): a finger is extended when its tip is
 * farther from the wrist than its reference joint (PIP for fingers, MCP for
 * the thumb), by a small margin scaled to hand size.
 */
export function fingersExtended(lm: Landmark[]): FingerFlags {
  const margin = 0.0 * handSize(lm); // tune: 0 = strictly farther
  const flags = FINGER_JOINTS.map(({ pip, tip }) => {
    const tipD = dist(lm[tip], lm[WRIST]);
    const pipD = dist(lm[pip], lm[WRIST]);
    return tipD > pipD + margin;
  });
  return flags as FingerFlags;
}

/** Count of extended fingers (0..5). */
export function extendedCount(lm: Landmark[]): number {
  return fingersExtended(lm).filter(Boolean).length;
}

/** True when the hand is a closed fist (no fingers extended). */
export function isFist(lm: Landmark[]): boolean {
  return extendedCount(lm) === 0;
}

/**
 * Thumb-index pinch distance, normalized by hand size so it is roughly
 * scale-invariant. ~0 when pinched, ~1.5+ when wide open.
 */
export function pinchDistance(lm: Landmark[]): number {
  return dist(lm[THUMB_TIP], lm[INDEX_TIP]) / handSize(lm);
}

/** True when thumb and index are pinched together. */
export function isPinching(lm: Landmark[], threshold = 0.35): boolean {
  return pinchDistance(lm) < threshold;
}

const FINGERTIPS = [4, 8, 12, 16, 20];

/**
 * Continuous hand openness in [0,1]: 0 = closed fist, 1 = wide-open hand.
 *
 * Metric: mean fingertip distance from the wrist, normalized by hand size, then
 * remapped from a closed-hand baseline to a fully-open range. This is a smooth
 * signal (unlike the discrete extended-finger count), which makes it well suited
 * to driving a continuous parameter like the vocoder wet amount.
 */
export function handOpenness(lm: Landmark[]): number {
  const size = handSize(lm);
  let sum = 0;
  for (const t of FINGERTIPS) sum += dist(lm[t], lm[WRIST]) / size;
  const mean = sum / FINGERTIPS.length;
  // Closed hand ~1.0, wide-open hand ~2.0 in wrist-distance/handSize units.
  const lo = 1.1;
  const hi = 1.9;
  const o = (mean - lo) / (hi - lo);
  return Math.max(0, Math.min(1, o));
}

export interface HandPose {
  /** Normalized hand center X in [0,1] (image space, x right). */
  x: number;
  /** Normalized hand center Y in [0,1] (image space, y down). */
  y: number;
  fingers: FingerFlags;
  extendedCount: number;
  pinch: number;
  fist: boolean;
  /** Continuous openness 0..1 (0 = fist, 1 = wide open). */
  openness: number;
}

/** Palm center: mean of wrist + all four finger MCPs (5,9,13,17). */
export function handCenter(lm: Landmark[]): { x: number; y: number } {
  const idx = [WRIST, 5, 9, 13, 17];
  let sx = 0;
  let sy = 0;
  for (const i of idx) {
    sx += lm[i].x;
    sy += lm[i].y;
  }
  return { x: sx / idx.length, y: sy / idx.length };
}

/** Summarize a hand into the values the chord engine consumes. */
export function readHand(lm: Landmark[]): HandPose {
  const fingers = fingersExtended(lm);
  const center = handCenter(lm);
  const count = fingers.filter(Boolean).length;
  return {
    x: center.x,
    y: center.y,
    fingers,
    extendedCount: count,
    pinch: pinchDistance(lm),
    fist: count === 0,
    openness: handOpenness(lm),
  };
}
