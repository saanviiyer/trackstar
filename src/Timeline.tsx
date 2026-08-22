import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MixerTrackState } from "./lib/producerMixer";
import { secondsPerBar } from "./lib/transport";

// Horizontal timeline for the Producer DAW. It shows a bars/beats ruler, an
// adjustable loop/cycle region, a moving playhead, and one lane per track whose
// recorded/stem audio is drawn as a waveform clip block. Clips can be moved
// (drag), trimmed (edge handles), duplicated, and deleted. The model is the
// looping mixer: a clip occupies the loop region and repeats, so the ghosted
// blocks past the loop edge show where it repeats.

const BAR_PX = 110; // fixed bar width so the grid reads the same at any tempo
const MAX_BARS = 8;
const LANE_H = 52;

interface TimelineProps {
  tracks: MixerTrackState[];
  bpm: number;
  beatsPerBar: number;
  loopBars: number;
  loopDurSec: number;
  playheadSec: number;
  playing: boolean;
  getPeaks: (id: number, buckets: number) => number[] | null;
  onSetBars: (bars: number) => void;
  onMove: (id: number, offsetSec: number) => void;
  onTrim: (id: number, startSec: number, endSec: number) => void;
  onDuplicate: (id: number) => void;
  onDelete: (id: number) => void;
}

type DragMode = "move" | "trim-l" | "trim-r";
interface DragState {
  id: number;
  mode: DragMode;
  startX: number;
  origStart: number; // offsetSec at drag start
  origDur: number; // clip duration at drag start
}

function Waveform({
  peaks,
  width,
  height,
  color,
}: {
  peaks: number[];
  width: number;
  height: number;
  color: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = color;
    const mid = height / 2;
    const n = peaks.length;
    const step = n > 0 ? width / n : width;
    for (let i = 0; i < n; i++) {
      const h = Math.max(1, peaks[i] * (height - 4));
      ctx.fillRect(i * step, mid - h / 2, Math.max(1, step - 0.5), h);
    }
  }, [peaks, width, height, color]);
  return <canvas ref={ref} style={{ width, height }} className="block" />;
}

export default function Timeline({
  tracks,
  bpm,
  beatsPerBar,
  loopBars,
  loopDurSec,
  playheadSec,
  playing,
  getPeaks,
  onSetBars,
  onMove,
  onTrim,
  onDuplicate,
  onDelete,
}: TimelineProps) {
  const barSec = secondsPerBar(bpm, beatsPerBar);
  const pps = BAR_PX / barSec; // pixels per second (constant across tempos)
  const beatPx = BAR_PX / Math.max(1, beatsPerBar);
  const totalWidth = BAR_PX * MAX_BARS;
  const loopWidth = Math.min(totalWidth, (loopDurSec || loopBars * barSec) * pps);

  const laneAreaRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const loopDragRef = useRef<boolean>(false);
  // Local live offsets/durations while dragging (avoids restarting audio on
  // every pointermove; the committed value is sent on pointerup).
  const [drafts, setDrafts] = useState<Record<number, { start: number; dur: number }>>({});

  // Waveform peaks are expensive to compute, so cache them and only recompute
  // when the track set / loop length / zoom changes (not on every playhead tick).
  const peaksMap = useMemo(() => {
    const map: Record<number, number[]> = {};
    for (const t of tracks) {
      const dur = loopDurSec > 0 ? Math.min(loopDurSec, t.durationSec) : t.durationSec;
      const w = Math.max(6, dur * pps);
      map[t.id] = getPeaks(t.id, Math.max(8, Math.floor(w / 2))) ?? [];
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks, loopDurSec, pps, getPeaks]);

  const clipStart = useCallback(
    (t: MixerTrackState) => drafts[t.id]?.start ?? t.offsetSec,
    [drafts]
  );
  const clipDur = useCallback(
    (t: MixerTrackState) => {
      const draft = drafts[t.id];
      if (draft) return draft.dur;
      return loopDurSec > 0 ? Math.min(loopDurSec, t.durationSec) : t.durationSec;
    },
    [drafts, loopDurSec]
  );

  const onClipPointerDown = useCallback(
    (e: React.PointerEvent, t: MixerTrackState, mode: DragMode) => {
      e.preventDefault();
      e.stopPropagation();
      (e.target as Element).setPointerCapture?.(e.pointerId);
      const dur = loopDurSec > 0 ? Math.min(loopDurSec, t.durationSec) : t.durationSec;
      dragRef.current = {
        id: t.id,
        mode,
        startX: e.clientX,
        origStart: t.offsetSec,
        origDur: dur,
      };
    },
    [loopDurSec]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const deltaSec = (e.clientX - d.startX) / pps;
      const loop = loopDurSec > 0 ? loopDurSec : d.origDur;
      if (d.mode === "move") {
        const maxStart = Math.max(0, loop - d.origDur);
        const start = Math.max(0, Math.min(maxStart, d.origStart + deltaSec));
        setDrafts((prev) => ({ ...prev, [d.id]: { start, dur: d.origDur } }));
      } else if (d.mode === "trim-l") {
        const start = Math.max(0, Math.min(d.origStart + d.origDur - 0.05, d.origStart + deltaSec));
        const dur = d.origStart + d.origDur - start;
        setDrafts((prev) => ({ ...prev, [d.id]: { start, dur } }));
      } else {
        const dur = Math.max(0.05, Math.min(loop - d.origStart, d.origDur + deltaSec));
        setDrafts((prev) => ({ ...prev, [d.id]: { start: d.origStart, dur } }));
      }
    },
    [pps, loopDurSec]
  );

  const onPointerUp = useCallback(() => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    const draft = drafts[d.id];
    if (!draft) return;
    if (d.mode === "move") {
      onMove(d.id, draft.start);
    } else {
      onTrim(d.id, draft.start, draft.start + draft.dur);
    }
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[d.id];
      return next;
    });
  }, [drafts, onMove, onTrim]);

  // Loop-region right handle: drag to resize, snapping to whole bars 1..MAX_BARS.
  const onLoopHandleMove = useCallback(
    (e: React.PointerEvent) => {
      if (!loopDragRef.current) return;
      const rect = laneAreaRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = e.clientX - rect.left + (laneAreaRef.current?.scrollLeft ?? 0);
      const bars = Math.max(1, Math.min(MAX_BARS, Math.round(x / BAR_PX)));
      onSetBars(bars);
    },
    [onSetBars]
  );

  const gridBg = `repeating-linear-gradient(90deg, rgba(208,0,255,0.28) 0 1px, transparent 1px ${beatPx}px), repeating-linear-gradient(90deg, rgba(255,212,0,0.45) 0 1.5px, transparent 1.5px ${BAR_PX}px)`;

  return (
    <div className="rounded-2xl border border-magenta/30 bg-purple/15 p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-white/70">
          Timeline
        </h2>
        <span className="text-xs text-white/45">
          Loop: {loopBars} {loopBars === 1 ? "bar" : "bars"}. Drag clips to move,
          edges to trim, the yellow handle to resize the loop.
        </span>
      </div>

      <div
        ref={laneAreaRef}
        className="relative overflow-x-auto rounded-lg border border-magenta/20 bg-ink/40"
        onPointerMove={(e) => {
          onPointerMove(e);
          onLoopHandleMove(e);
        }}
        onPointerUp={() => {
          onPointerUp();
          loopDragRef.current = false;
        }}
        onPointerLeave={() => {
          onPointerUp();
          loopDragRef.current = false;
        }}
      >
        <div style={{ width: totalWidth, minWidth: totalWidth }}>
          {/* Ruler */}
          <div className="relative h-6 border-b border-magenta/20 bg-purple/20">
            {Array.from({ length: MAX_BARS }, (_, i) => (
              <span
                key={i}
                className="absolute top-0 select-none pl-1 text-[10px] text-white/60"
                style={{ left: i * BAR_PX }}
              >
                {i + 1}
              </span>
            ))}
            {/* Loop region on the ruler */}
            <div
              className="absolute top-0 h-6 border-x-2 border-yellow/70 bg-yellow/10"
              style={{ left: 0, width: loopWidth }}
            />
            {/* Loop resize handle */}
            <div
              role="slider"
              aria-label="Loop length in bars"
              aria-valuemin={1}
              aria-valuemax={MAX_BARS}
              aria-valuenow={loopBars}
              tabIndex={0}
              onPointerDown={(e) => {
                e.preventDefault();
                loopDragRef.current = true;
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight") onSetBars(Math.min(MAX_BARS, loopBars + 1));
                if (e.key === "ArrowLeft") onSetBars(Math.max(1, loopBars - 1));
              }}
              className="absolute top-0 h-6 w-3 -translate-x-1/2 cursor-ew-resize bg-yellow/80"
              style={{ left: loopWidth }}
              title="Drag to change loop length"
            />
          </div>

          {/* Lanes */}
          <div className="relative" style={{ backgroundImage: gridBg }}>
            {tracks.length === 0 && (
              <div className="flex h-16 items-center justify-center text-xs text-white/40">
                No tracks yet. Record a loop or add an AI stem to see clips here.
              </div>
            )}
            {tracks.map((t) => {
              const start = clipStart(t);
              const dur = clipDur(t);
              const x = start * pps;
              const w = Math.max(6, dur * pps);
              const isLoop = t.kind === "loop";
              const peaks = peaksMap[t.id] ?? [];
              const clipColor = t.muted
                ? "rgba(255,159,28,0.35)"
                : isLoop
                  ? "rgba(255,212,0,0.30)"
                  : "rgba(208,0,255,0.28)";
              const waveColor = isLoop ? "#ffd400" : "#ff9f1c";
              return (
                <div
                  key={t.id}
                  className="relative border-b border-magenta/10"
                  style={{ height: LANE_H }}
                >
                  {/* Ghost repeat of the clip across the view (looping preview) */}
                  {loopDurSec > 0 &&
                    Array.from(
                      { length: Math.max(0, Math.ceil((totalWidth - x - w) / (loopDurSec * pps))) },
                      (_, r) => (
                        <div
                          key={r}
                          className="pointer-events-none absolute top-1 rounded"
                          style={{
                            left: x + (r + 1) * loopDurSec * pps,
                            width: w,
                            height: LANE_H - 8,
                            background: clipColor,
                            opacity: 0.25,
                          }}
                        />
                      )
                    )}
                  {/* The clip block */}
                  <div
                    className="absolute top-1 overflow-hidden rounded ring-1 ring-white/10"
                    style={{ left: x, width: w, height: LANE_H - 8, background: clipColor }}
                    onPointerDown={(e) => onClipPointerDown(e, t, "move")}
                    title={`${t.name} — drag to move`}
                  >
                    <div className="pointer-events-none absolute left-1 top-0.5 z-10 max-w-full truncate pr-1 text-[10px] font-medium text-ink">
                      {t.name}
                    </div>
                    <Waveform peaks={peaks} width={w} height={LANE_H - 8} color={waveColor} />
                    {/* Trim handles */}
                    <div
                      className="absolute left-0 top-0 h-full w-2 cursor-ew-resize bg-ink/30 hover:bg-ink/60"
                      onPointerDown={(e) => onClipPointerDown(e, t, "trim-l")}
                      title="Trim start"
                    />
                    <div
                      className="absolute right-0 top-0 h-full w-2 cursor-ew-resize bg-ink/30 hover:bg-ink/60"
                      onPointerDown={(e) => onClipPointerDown(e, t, "trim-r")}
                      title="Trim end"
                    />
                  </div>
                  {/* Per-clip quick actions */}
                  <div className="absolute right-1 top-1 z-20 flex gap-1">
                    <button
                      onClick={() => onDuplicate(t.id)}
                      className="rounded bg-ink/60 px-1.5 py-0.5 text-[10px] text-white/80 hover:bg-magenta/50"
                      aria-label={`Duplicate ${t.name} clip`}
                    >
                      Copy
                    </button>
                    <button
                      onClick={() => onDelete(t.id)}
                      className="rounded bg-ink/60 px-1.5 py-0.5 text-[10px] text-white/80 hover:bg-magenta/50"
                      aria-label={`Delete ${t.name} clip`}
                    >
                      Del
                    </button>
                  </div>
                </div>
              );
            })}

            {/* Playhead */}
            {playing && (
              <div
                className="pointer-events-none absolute top-0 z-30 w-px bg-orange"
                style={{
                  left: playheadSec * pps,
                  height: Math.max(LANE_H, tracks.length * LANE_H),
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
