// Legend.tsx - on-screen gesture → chord mapping reference (per mode).
import type { PlayMode } from "./lib/mapping";

const DIATONIC_ROWS: { gesture: string; effect: string }[] = [
  { gesture: "1 finger", effect: "Chord I (degree 1)" },
  { gesture: "2 fingers", effect: "Chord ii (degree 2)" },
  { gesture: "3 fingers", effect: "Chord iii (degree 3)" },
  { gesture: "4 fingers", effect: "Chord IV (degree 4)" },
  { gesture: "5 fingers", effect: "Chord V (degree 5)" },
  { gesture: "Left open + 1 finger", effect: "Chord vi (two-hand)" },
  { gesture: "Left open + 2 fingers", effect: "Chord vii (two-hand)" },
  { gesture: "Closed fist", effect: "Rest / mute" },
  { gesture: "Hand left→right", effect: "Inversion (root / 1st / 2nd)" },
  { gesture: "Hand up→down", effect: "Low-pass filter (bright → dark)" },
  { gesture: "Pinch thumb+index", effect: "Expression / volume (open = loud)" },
];

const PROGRESSION_ROWS: { gesture: string; effect: string }[] = [
  { gesture: "1-5 fingers", effect: "Play slot 1-5 of your sequence" },
  { gesture: "Closed fist", effect: "Rest / mute" },
  { gesture: "Left hand open", effect: "Slots 6-10 (two-hand mode)" },
  { gesture: "Hand left→right", effect: "Inversion (root / 1st / 2nd)" },
  { gesture: "Hand up→down", effect: "Low-pass filter (bright → dark)" },
  { gesture: "Pinch thumb+index", effect: "Expression / volume (open = loud)" },
];

export function Legend({
  mode,
  twoHand,
}: {
  mode: PlayMode;
  twoHand: boolean;
}) {
  const rows = mode === "progression" ? PROGRESSION_ROWS : DIATONIC_ROWS;
  return (
    <section className="rounded-2xl border border-magenta/30 bg-purple/15 p-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/70">
        Gesture map: {mode === "progression" ? "Progression" : "Diatonic"}
      </h2>
      <ul className="flex flex-col divide-y divide-magenta/20 text-sm">
        {rows.map((r) => (
          <li key={r.gesture} className="flex justify-between gap-3 py-1.5">
            <span className="text-white/90">{r.gesture}</span>
            <span className="text-right text-white/55">{r.effect}</span>
          </li>
        ))}
        {mode === "diatonic" && twoHand && (
          <li className="flex justify-between gap-3 py-1.5">
            <span className="text-magenta">Left hand open</span>
            <span className="text-right text-white/55">
              +5 degrees → reach vi / vii
            </span>
          </li>
        )}
      </ul>
      <p className="mt-3 text-xs text-white/40">
        {mode === "progression" ? (
          <>
            Type a sequence like <code>Am E F C</code>. The right hand plays;
            in two-hand mode an open left hand reaches slots 6-10.
          </>
        ) : (
          <>
            Right hand plays I-V. Enable two-hand mode and hold your left hand
            open to add +5 and reach vi / vii.
          </>
        )}
      </p>
    </section>
  );
}
