import { useEffect, useMemo, useState } from "react";
import {
  BASS_PRESET_NAMES,
  bassPatternBars,
  bassPatternFromPreset,
  clearBassPattern,
  setBassNote,
  setBassPatternBars,
  type BassPattern,
  type BassPresetName,
} from "./lib/bass";
import { MAX_PATTERN_BARS, STEPS_PER_BAR } from "./lib/drums";
import { SCALE_INTERVALS, midiToName, type ScaleName } from "./lib/music";

interface BassSequencerProps {
  pattern: BassPattern;
  onChange: (next: BassPattern) => void;
  tonic: number;
  scale: ScaleName;
  getPlayhead?: () => number;
  running?: boolean;
}

const BAR_CHOICES = Array.from({ length: MAX_PATTERN_BARS }, (_, i) => i + 1);

export default function BassSequencer({
  pattern,
  onChange,
  tonic,
  scale,
  getPlayhead,
  running = false,
}: BassSequencerProps) {
  const bars = bassPatternBars(pattern);
  const intervals = SCALE_INTERVALS[scale];
  const notes = useMemo(() => {
    const root = 36 + ((tonic % 12) + 12) % 12;
    return [...intervals.map((interval) => root + interval), root + 12].reverse();
  }, [intervals, tonic]);
  const [playhead, setPlayhead] = useState(-1);
  useEffect(() => {
    if (!running || !getPlayhead) {
      setPlayhead(-1);
      return;
    }
    let raf = 0;
    const tick = () => {
      const step = getPlayhead();
      setPlayhead(step < 0 ? -1 : step % pattern.notes.length);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [getPlayhead, pattern.notes.length, running]);

  return (
    <div className="select-none">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-1">
          <span className="text-white/70">Bars</span>
          <select
            value={bars}
            onChange={(event) => onChange(setBassPatternBars(pattern, Number(event.target.value)))}
            className="rounded-md border border-purple/50 bg-purple/25 px-1.5 py-1"
          >
            {BAR_CHOICES.map((bar) => <option key={bar}>{bar}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-white/70">Start from</span>
          <select
            value=""
            onChange={(event) => {
              const preset = event.target.value as BassPresetName;
              if (preset) onChange(bassPatternFromPreset(preset, tonic, bars));
              event.target.value = "";
            }}
            className="rounded-md border border-purple/50 bg-purple/25 px-1.5 py-1"
          >
            <option value="">Preset...</option>
            {BASS_PRESET_NAMES.map((name) => <option key={name}>{name}</option>)}
          </select>
        </label>
        <button
          type="button"
          disabled={pattern.notes.every((note) => note === null)}
          onClick={() => onChange(clearBassPattern(pattern))}
          className="rounded-md border border-purple/50 bg-purple/25 px-2 py-1 disabled:opacity-40"
        >
          Clear
        </button>
      </div>

      <div className="overflow-x-auto pb-1">
        <div className="inline-block min-w-full">
          {notes.map((midi) => (
            <div key={midi} className="mb-1 flex items-center gap-1">
              <div className="w-14 shrink-0 text-[11px] text-white/65">{midiToName(midi)}</div>
              {Array.from({ length: bars * STEPS_PER_BAR }, (_, step) => {
                const on = pattern.notes[step] === midi;
                const downbeat = step % 4 === 0;
                return (
                  <button
                    key={step}
                    type="button"
                    aria-label={`${midiToName(midi)} step ${step + 1}`}
                    aria-pressed={on}
                    onClick={() => onChange(setBassNote(pattern, step, on ? null : midi))}
                    className={[
                      "mr-[2px] h-[18px] w-[18px] rounded-[3px] border transition-colors",
                      on
                        ? "border-transparent bg-cyan-300 text-ink"
                        : downbeat
                          ? "border-white/25 bg-white/10"
                          : "border-white/10 bg-white/[0.04]",
                      playhead === step ? "ring-2 ring-white/80" : "",
                      step % STEPS_PER_BAR === STEPS_PER_BAR - 1 ? "mr-2" : "",
                    ].join(" ")}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <p className="mt-2 text-[11px] text-white/50">
        Pick one note per step. The rows follow the current key and scale; changing key transposes new presets.
      </p>
    </div>
  );
}
