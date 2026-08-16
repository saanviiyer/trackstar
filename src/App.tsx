import { useState } from "react";
import SimpleMode from "./SimpleMode";
import ProducerMode from "./ProducerMode";

type TopMode = "simple" | "producer";

/** Decorative palette flower (inline SVG). Purely ornamental. */
function Flower({
  size = 40,
  className = "",
  petal = "#d000ff",
  center = "#ffd400",
  opacity = 0.9,
}: {
  size?: number;
  className?: string;
  petal?: string;
  center?: string;
  opacity?: number;
}) {
  const angles = [0, 72, 144, 216, 288];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <g transform="translate(50,50)" opacity={opacity}>
        {angles.map((a) => (
          <ellipse
            key={a}
            cx="0"
            cy="-26"
            rx="13"
            ry="24"
            fill={petal}
            transform={`rotate(${a})`}
          />
        ))}
        <circle r="12" fill={center} />
      </g>
    </svg>
  );
}

export default function App() {
  const [mode, setMode] = useState<TopMode>("simple");

  return (
    <div className="min-h-full mx-auto max-w-6xl px-4 py-6">
      <header className="mb-6">
        <div className="flex items-center gap-3">
          <Flower size={44} petal="#ff9f1c" center="#ffd400" className="shrink-0" />
          <div>
            <h1 className="text-4xl font-bold tracking-tight">
              dee<span className="text-yellow">synth</span>
            </h1>
            <p className="text-sm text-white/70">
              Hand-gesture synth and AI music producer in one. Simple mode plays;
              Producer mode records loops into a mixer and adds AI backing.
            </p>
          </div>
          <Flower
            size={36}
            petal="#d000ff"
            center="#ffd400"
            className="ml-auto hidden shrink-0 sm:block"
          />
        </div>

        {/* Top-level mode toggle */}
        <div className="mt-4 inline-flex rounded-xl border border-magenta/40 bg-purple/15 p-1">
          {(
            [
              ["simple", "Simple"],
              ["producer", "Producer"],
            ] as [TopMode, string][]
          ).map(([m, label]) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`rounded-lg px-5 py-2 text-sm font-semibold transition ${
                mode === m
                  ? "bg-yellow text-ink"
                  : "text-white/80 hover:bg-magenta/30"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      {/* Only one mode is mounted at a time; switching unmounts the other, which
          releases its camera + AudioContext via that component's cleanup. */}
      {mode === "simple" ? <SimpleMode /> : <ProducerMode />}

      <footer className="mt-8 text-xs text-white/40">
        Best in Chrome/Edge. Camera requires HTTPS or localhost. Hand tracking:
        MediaPipe Tasks Vision. Audio: Web Audio API. AI producer: deejai backend.
      </footer>
    </div>
  );
}
