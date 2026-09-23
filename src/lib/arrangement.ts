import { STEPS_PER_BAR } from "./drums";

export interface TrackArrangement {
  bars: number;
  drums: boolean[];
  bass: boolean[];
}

export type ArrangementPreset = "All in" | "Build up" | "Verse / chorus" | "Drop";
export const ARRANGEMENT_PRESETS: ArrangementPreset[] = [
  "All in",
  "Build up",
  "Verse / chorus",
  "Drop",
];

export function createArrangement(bars = 8): TrackArrangement {
  const length = Math.max(1, Math.min(16, Math.round(bars) || 8));
  return {
    bars: length,
    drums: new Array(length).fill(true),
    bass: new Array(length).fill(true),
  };
}

export function resizeArrangement(
  arrangement: TrackArrangement,
  bars: number
): TrackArrangement {
  const length = Math.max(1, Math.min(16, Math.round(bars) || 8));
  const resize = (lane: boolean[]) =>
    Array.from({ length }, (_, i) => lane[i % Math.max(1, lane.length)] ?? true);
  return { bars: length, drums: resize(arrangement.drums), bass: resize(arrangement.bass) };
}

export function setArrangementCell(
  arrangement: TrackArrangement,
  lane: "drums" | "bass",
  bar: number,
  on: boolean
): TrackArrangement {
  const next = { ...arrangement, drums: [...arrangement.drums], bass: [...arrangement.bass] };
  if (bar >= 0 && bar < arrangement.bars) next[lane][bar] = on;
  return next;
}

export function arrangementAllows(
  arrangement: TrackArrangement | null,
  lane: "drums" | "bass",
  step: number
): boolean {
  if (!arrangement) return true;
  const bar = Math.floor(Math.max(0, step) / STEPS_PER_BAR) % arrangement.bars;
  return arrangement[lane][bar] !== false;
}

export function arrangementFromPreset(
  name: ArrangementPreset,
  bars: number
): TrackArrangement {
  const out = createArrangement(bars);
  for (let bar = 0; bar < out.bars; bar++) {
    if (name === "Build up") {
      out.drums[bar] = bar >= Math.ceil(out.bars / 4);
      out.bass[bar] = bar >= Math.ceil(out.bars / 2);
    } else if (name === "Verse / chorus") {
      const chorus = bar >= Math.floor(out.bars / 2);
      out.drums[bar] = true;
      out.bass[bar] = chorus || bar % 2 === 1;
    } else if (name === "Drop") {
      const breakBar = Math.max(1, Math.floor(out.bars / 2) - 1);
      out.drums[bar] = bar !== breakBar;
      out.bass[bar] = bar > breakBar;
    }
  }
  return out;
}

export function isTrackArrangement(value: unknown): value is TrackArrangement {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<TrackArrangement>;
  return (
    Number.isInteger(v.bars) &&
    v.bars! >= 1 &&
    v.bars! <= 16 &&
    Array.isArray(v.drums) &&
    Array.isArray(v.bass) &&
    v.drums.length === v.bars &&
    v.bass.length === v.bars &&
    v.drums.every((x) => typeof x === "boolean") &&
    v.bass.every((x) => typeof x === "boolean")
  );
}

