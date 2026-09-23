// BeatSequencer.tsx - the step grid for building a custom beat, one cell per
// 16th note, three lanes (kick / snare / hi-hat), 1 to 4 bars.
//
// All pattern maths lives in lib/drums.ts; this file is presentation plus the
// click-and-drag painting. The playhead is polled from the running DrumMachine
// in a local rAF loop so only this component re-renders while the beat plays.

import { useEffect, useRef, useState } from "react";
import {
  DRUM_LANES,
  DRUM_PATTERN_NAMES,
  MAX_PATTERN_BARS,
  STEPS_PER_BAR,
  clearPattern,
  isPatternEmpty,
  patternBars,
  patternFromName,
  setPatternBars,
  setStep,
  type DrumEnables,
  type DrumInstrument,
  type DrumPattern,
  type DrumPatternName,
} from "./lib/drums";

const LANE_LABEL: Record<DrumInstrument, string> = {
  kick: "Kick",
  snare: "Snare",
  clap: "Clap",
  hat: "Hat",
  tom: "Tom",
  shaker: "Shake",
};

// One accent colour per lane so a glance tells you which row you are on.
const LANE_ON: Record<DrumInstrument, string> = {
  kick: "bg-yellow text-ink",
  snare: "bg-orange text-ink",
  clap: "bg-fuchsia-400 text-ink",
  hat: "bg-magenta text-white",
  tom: "bg-cyan-400 text-ink",
  shaker: "bg-lime-300 text-ink",
};

const BAR_CHOICES = Array.from({ length: MAX_PATTERN_BARS }, (_, i) => i + 1);

const CELL_PX = 18;
const CELL_GAP_PX = 2;
const BAR_WIDTH_PX = STEPS_PER_BAR * CELL_PX + (STEPS_PER_BAR - 1) * CELL_GAP_PX;

export interface BeatSequencerProps {
  pattern: DrumPattern;
  onChange: (next: DrumPattern) => void;
  /** Reads the sounding step from the drum machine; -1 when it is not running. */
  getPlayhead?: () => number;
  /** Lanes the user has muted, drawn dimmed. */
  enables?: DrumEnables;
  /** Poll the playhead only while this is true. */
  running?: boolean;
}

export default function BeatSequencer({
  pattern,
  onChange,
  getPlayhead,
  enables,
  running = false,
}: BeatSequencerProps) {
  const bars = patternBars(pattern);
  const [playhead, setPlayhead] = useState(-1);

  // Paint state: on pointer-down we decide whether this drag turns cells on or
  // off, then every cell dragged over gets that value (GarageBand behaviour).
  const paintRef = useRef<boolean | null>(null);
  const patternRef = useRef(pattern);
  patternRef.current = pattern;

  useEffect(() => {
    const end = () => {
      paintRef.current = null;
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, []);

  useEffect(() => {
    if (!running || !getPlayhead) {
      setPlayhead(-1);
      return;
    }
    let raf = 0;
    let last = -1;
    const tick = () => {
      const raw = getPlayhead();
      const step = raw < 0 ? -1 : raw % (bars * STEPS_PER_BAR);
      if (step !== last) {
        last = step;
        setPlayhead(step);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [bars, running, getPlayhead]);

  const paint = (lane: DrumInstrument, step: number, value: boolean) => {
    const current = patternRef.current;
    if ((current[lane][step] === 1) === value) return;
    const next = setStep(current, lane, step, value);
    patternRef.current = next;
    onChange(next);
  };

  const onCellDown = (lane: DrumInstrument, step: number) => {
    const value = pattern[lane][step] !== 1;
    paintRef.current = value;
    paint(lane, step, value);
  };

  const onCellEnter = (lane: DrumInstrument, step: number) => {
    if (paintRef.current === null) return;
    paint(lane, step, paintRef.current);
  };

  return (
    <div className="select-none">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-1">
          <span className="text-white/70">Bars</span>
          <select
            value={bars}
            onChange={(e) => onChange(setPatternBars(pattern, Number(e.target.value)))}
            className="rounded-md border border-purple/50 bg-purple/25 px-1.5 py-1"
          >
            {BAR_CHOICES.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1">
          <span className="text-white/70">Start from</span>
          <select
            value=""
            onChange={(e) => {
              const name = e.target.value as DrumPatternName;
              if (!name) return;
              onChange(setPatternBars(patternFromName(name), bars));
              e.target.value = "";
            }}
            className="rounded-md border border-purple/50 bg-purple/25 px-1.5 py-1"
          >
            <option value="">Preset...</option>
            {DRUM_PATTERN_NAMES.filter((n) => n !== "Off").map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          onClick={() => onChange(clearPattern(pattern))}
          disabled={isPatternEmpty(pattern)}
          className="rounded-md border border-purple/50 bg-purple/25 px-2 py-1 disabled:opacity-40"
        >
          Clear
        </button>
      </div>

      <div className="overflow-x-auto pb-1">
        <div className="inline-block min-w-full">
          {/* Bar ruler */}
          <div className="mb-1 flex items-center gap-1">
            <div className="w-14 shrink-0" />
            {Array.from({ length: bars }, (_, b) => (
              <div
                key={b}
                className="shrink-0 text-[10px] uppercase tracking-wide text-white/45"
                style={{ width: BAR_WIDTH_PX, marginRight: b < bars - 1 ? 6 : 0 }}
              >
                Bar {b + 1}
              </div>
            ))}
          </div>

          {DRUM_LANES.map((lane) => {
            const muted = enables ? !enables[lane] : false;
            return (
              <div key={lane} className="mb-1 flex items-center gap-1">
                <div
                  className={`w-14 shrink-0 text-[11px] ${
                    muted ? "text-white/30 line-through" : "text-white/70"
                  }`}
                >
                  {LANE_LABEL[lane]}
                </div>
                {Array.from({ length: bars }, (_, b) => (
                  <div
                    key={b}
                    className="flex shrink-0 gap-[2px]"
                    style={{ marginRight: b < bars - 1 ? 6 : 0 }}
                  >
                    {Array.from({ length: STEPS_PER_BAR }, (_, i) => {
                      const step = b * STEPS_PER_BAR + i;
                      const on = pattern[lane][step] === 1;
                      const downbeat = i % 4 === 0;
                      const here = playhead === step;
                      return (
                        <button
                          key={i}
                          type="button"
                          aria-label={`${LANE_LABEL[lane]} step ${step + 1}`}
                          aria-pressed={on}
                          onPointerDown={(e) => {
                            e.preventDefault();
                            onCellDown(lane, step);
                          }}
                          onPointerEnter={() => onCellEnter(lane, step)}
                          className={[
                            "h-[18px] w-[18px] rounded-[3px] border transition-colors",
                            on
                              ? `${LANE_ON[lane]} border-transparent`
                              : downbeat
                                ? "border-white/25 bg-white/10"
                                : "border-white/10 bg-white/[0.04]",
                            muted ? "opacity-40" : "",
                            here ? "ring-2 ring-white/80" : "",
                          ].join(" ")}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      <p className="mt-2 text-[11px] text-white/50">
        Click a cell to place a hit, or drag across the row to paint several.
        Each cell is a 16th note and every group of four is one beat.
      </p>
    </div>
  );
}
