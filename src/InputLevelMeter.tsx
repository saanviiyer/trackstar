import { useEffect, useRef, useState } from "react";
import type { InputMeter } from "./lib/meter";

/**
 * Live input-level meter for the selected record source. Polls an InputMeter on
 * animation frames and draws an RMS/peak bar so the user can SEE their voice (or
 * the instrument) arriving before and during recording. When the source is the
 * mic but no mic is available, it shows a clear state instead of a dead bar.
 */
export function InputLevelMeter({
  meter,
  active,
  label,
  unavailable,
}: {
  /** The meter instance to read; may be null before the app starts. */
  meter: React.RefObject<InputMeter | null>;
  /** Run the animation loop only when the graph is live and a source is set. */
  active: boolean;
  /** Short label for the metered source (e.g. "Mic", "Mix"). */
  label: string;
  /** Non-null message when the chosen source needs a mic that is not available. */
  unavailable?: string | null;
}) {
  const [bar, setBar] = useState(0);
  const [peak, setPeak] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active || unavailable) {
      setBar(0);
      setPeak(0);
      return;
    }
    let running = true;
    const tick = () => {
      if (!running) return;
      const m = meter.current;
      if (m) {
        const r = m.read();
        setBar(r.bar);
        setPeak(r.peak);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      running = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [active, unavailable, meter]);

  const clipping = peak >= 0.99;
  const pct = Math.round(Math.max(0, Math.min(1, bar)) * 100);

  return (
    <div className="mb-3 text-sm">
      <div className="mb-1 flex items-center justify-between text-white/70">
        <span>Input level ({label})</span>
        {clipping && <span className="text-orange">clipping</span>}
      </div>
      {unavailable ? (
        <p className="rounded-md bg-orange/20 px-2 py-1 text-xs text-orange">
          {unavailable}
        </p>
      ) : (
        <div
          className="h-3 w-full overflow-hidden rounded-full bg-purple/25"
          role="meter"
          aria-label={`Input level ${label}`}
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={`h-full rounded-full transition-[width] duration-75 ${
              clipping ? "bg-orange" : "bg-yellow"
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {!unavailable && (
        <p className="mt-1 text-[11px] text-white/45">
          Talk or play to check the bar moves before you record.
        </p>
      )}
    </div>
  );
}
