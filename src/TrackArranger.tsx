import { useEffect, useState } from "react";
import {
  ARRANGEMENT_PRESETS,
  arrangementFromPreset,
  resizeArrangement,
  setArrangementCell,
  type ArrangementPreset,
  type TrackArrangement,
} from "./lib/arrangement";
import { STEPS_PER_BAR } from "./lib/drums";

interface TrackArrangerProps {
  arrangement: TrackArrangement;
  onChange: (next: TrackArrangement) => void;
  getPlayhead?: () => number;
  running?: boolean;
}

const LAYERS = [
  { id: "drums" as const, label: "Drums", color: "bg-orange text-ink" },
  { id: "bass" as const, label: "Bass", color: "bg-cyan-300 text-ink" },
];

export default function TrackArranger({
  arrangement,
  onChange,
  getPlayhead,
  running = false,
}: TrackArrangerProps) {
  const [activeBar, setActiveBar] = useState(-1);
  useEffect(() => {
    if (!running || !getPlayhead) {
      setActiveBar(-1);
      return;
    }
    let raf = 0;
    const tick = () => {
      const step = getPlayhead();
      setActiveBar(step < 0 ? -1 : Math.floor(step / STEPS_PER_BAR) % arrangement.bars);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [arrangement.bars, getPlayhead, running]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-1">
          <span className="text-white/70">Song length</span>
          <select
            value={arrangement.bars}
            onChange={(event) => onChange(resizeArrangement(arrangement, Number(event.target.value)))}
            className="rounded-md border border-purple/50 bg-purple/25 px-1.5 py-1"
          >
            {[4, 8, 12, 16].map((bars) => <option key={bars} value={bars}>{bars} bars</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-white/70">Shape</span>
          <select
            value=""
            onChange={(event) => {
              const preset = event.target.value as ArrangementPreset;
              if (preset) onChange(arrangementFromPreset(preset, arrangement.bars));
              event.target.value = "";
            }}
            className="rounded-md border border-purple/50 bg-purple/25 px-1.5 py-1"
          >
            <option value="">Preset...</option>
            {ARRANGEMENT_PRESETS.map((preset) => <option key={preset}>{preset}</option>)}
          </select>
        </label>
      </div>

      <div className="overflow-x-auto pb-1">
        <div className="inline-block min-w-full">
          <div className="mb-1 flex gap-1 pl-[60px]">
            {Array.from({ length: arrangement.bars }, (_, bar) => (
              <div key={bar} className="w-11 shrink-0 text-center text-[10px] text-white/45">
                {bar + 1}
              </div>
            ))}
          </div>
          {LAYERS.map((layer) => (
            <div key={layer.id} className="mb-1 flex items-center gap-1">
              <div className="w-14 shrink-0 text-[11px] text-white/70">{layer.label}</div>
              {Array.from({ length: arrangement.bars }, (_, bar) => {
                const on = arrangement[layer.id][bar];
                return (
                  <button
                    key={bar}
                    type="button"
                    aria-label={`${layer.label} in bar ${bar + 1}`}
                    aria-pressed={on}
                    onClick={() => onChange(setArrangementCell(arrangement, layer.id, bar, !on))}
                    className={[
                      "h-8 w-11 shrink-0 rounded-md border text-[10px] font-semibold transition",
                      on ? `${layer.color} border-transparent` : "border-white/10 bg-white/[0.04] text-white/30",
                      activeBar === bar ? "ring-2 ring-white/80" : "",
                    ].join(" ")}
                  >
                    {on ? "ON" : "—"}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <p className="mt-2 text-[11px] text-white/50">
        Each column is one bar. Switch layers off for intros and breaks, then bring them back for drops.
      </p>
    </div>
  );
}
