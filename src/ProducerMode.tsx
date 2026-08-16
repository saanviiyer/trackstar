import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HandLandmarker } from "@mediapipe/tasks-vision";
import { createHandLandmarker } from "./lib/handLandmarker";
import { readHand, type Landmark, type HandPose } from "./lib/gestures";
import { mapHandsToSelection, type Selection } from "./lib/mapping";
import {
  NOTE_NAMES,
  midiToName,
  keyName,
  SCALES,
  SCALE_LABELS,
  type ScaleName,
  type ChordExtension,
} from "./lib/music";
import { Synth } from "./lib/synth";
import { PRESET_NAMES, getPreset, DEFAULT_PRESET } from "./lib/presets";
import { Arpeggiator } from "./lib/arp";
import { DrumMachine, DRUM_PATTERN_NAMES, type DrumPatternName } from "./lib/drums";
import { LandmarkSmoother } from "./lib/smoothing";
import { drawHand } from "./lib/draw";
import { ProducerMixer, type MixerTrackState } from "./lib/producerMixer";
import {
  deejaiBase,
  probe,
  sendCommand,
  fetchStemBuffer,
  newStemsToAdd,
  stemTrackLabel,
  normalizePan,
  DeejaiUnavailableError,
  type DeejaiProject,
} from "./lib/deejai";

type Phase =
  | "idle"
  | "loading-model"
  | "requesting-camera"
  | "running"
  | "camera-denied"
  | "error";

const HAND_COLORS = ["#ffd400", "#d000ff"];

// Roles that represent AI-generated backing stems (as opposed to the demo
// vocal takes the engine balances). These are what producer commands create.
const AI_STEM_ROLES = new Set(["beat", "pad", "bass", "arp"]);

const UVICORN_CMD =
  "python3 -m uvicorn app.server:app --port 8000";

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function downloadBytes(bytes: ArrayBuffer, name: string): void {
  const blob = new Blob([bytes], { type: "audio/wav" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function ProducerMode() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const landmarkerRef = useRef<HandLandmarker | null>(null);
  const synthRef = useRef<Synth>(new Synth());
  const arpRef = useRef<Arpeggiator | null>(null);
  const drumsRef = useRef<DrumMachine | null>(null);
  const mixerRef = useRef<ProducerMixer | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastVideoTimeRef = useRef<number>(-1);
  const smoothersRef = useRef<LandmarkSmoother[]>([
    new LandmarkSmoother(),
    new LandmarkSmoother(),
  ]);
  const latchedChordRef = useRef<{ notes: number[]; freqs: number[] } | null>(
    null
  );
  const latchedCtrlRef = useRef<{ cutoff: number; expr: number }>({
    cutoff: 4000,
    expr: 0.8,
  });

  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState<string>("");

  // Instrument controls (compact set for the live performance).
  const [tonic, setTonic] = useState<number>(0);
  const [scale, setScale] = useState<ScaleName>("major");
  const [octave, setOctave] = useState<number>(3);
  const [extension, setExtension] = useState<ChordExtension>("triad");
  const [presetName, setPresetName] = useState<string>(DEFAULT_PRESET);
  const [volume, setVolume] = useState<number>(0.5);
  const [twoHand, setTwoHand] = useState<boolean>(false);
  const [latchOn, setLatchOn] = useState<boolean>(false);
  const [arpOn, setArpOn] = useState<boolean>(false);
  const [arpBpm, setArpBpm] = useState<number>(90);
  const [drumsOn, setDrumsOn] = useState<boolean>(false);
  const [drumPattern] = useState<DrumPatternName>(DRUM_PATTERN_NAMES[0]);

  // Mixer
  const [tracks, setTracks] = useState<MixerTrackState[]>([]);
  const [recording, setRecording] = useState<boolean>(false);
  const [playing, setPlaying] = useState<boolean>(false);
  const [loopBars, setLoopBars] = useState<number>(2);
  const [countIn, setCountIn] = useState<boolean>(true);
  const [recordSource, setRecordSource] = useState<"instrument" | "mic">(
    "instrument"
  );
  const [exportCycles, setExportCycles] = useState<number>(2);
  const [mixerError, setMixerError] = useState<string>("");

  // deejai AI
  const [backendUp, setBackendUp] = useState<boolean | null>(null); // null=checking
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [parserName, setParserName] = useState<string>("");
  const [project, setProject] = useState<DeejaiProject | null>(null);
  const [commandText, setCommandText] = useState<string>("add a lofi beat");
  const [aiMessages, setAiMessages] = useState<string[]>([]);
  const [aiBusy, setAiBusy] = useState<boolean>(false);
  const [aiError, setAiError] = useState<string>("");
  const loadedStemFilesRef = useRef<Set<string>>(new Set());

  const [selection, setSelection] = useState<Selection | null>(null);
  const [handCount, setHandCount] = useState<number>(0);

  const base = useMemo(() => deejaiBase(), []);

  // Latest instrument config for the rAF loop.
  const cfgRef = useRef({ tonic, scale, octave, extension, twoHand, arpOn, latchOn });
  useEffect(() => {
    cfgRef.current = { tonic, scale, octave, extension, twoHand, arpOn, latchOn };
  }, [tonic, scale, octave, extension, twoHand, arpOn, latchOn]);

  useEffect(() => {
    if (!latchOn) latchedChordRef.current = null;
  }, [latchOn]);

  useEffect(() => {
    synthRef.current.applyConfig(getPreset(presetName));
  }, [presetName]);
  useEffect(() => {
    synthRef.current.setMasterVolume(volume);
  }, [volume]);

  useEffect(() => {
    arpRef.current?.setParams({
      pattern: "up",
      division: "1/8",
      bpm: arpBpm,
      octaveRange: 1,
      gate: 0.6,
    });
  }, [arpBpm]);
  useEffect(() => {
    if (arpOn) synthRef.current.releaseAll();
  }, [arpOn]);

  useEffect(() => {
    const dm = drumsRef.current;
    if (!dm) return;
    dm.setBpm(arpBpm);
    dm.setPattern(drumPattern);
    if (drumsOn && !dm.isRunning) dm.start();
    else if (!drumsOn && dm.isRunning) dm.stop();
  }, [drumsOn, drumPattern, arpBpm]);

  useEffect(() => {
    mixerRef.current?.setConfig({ bpm: arpBpm, bars: loopBars, free: false });
  }, [arpBpm, loopBars]);
  useEffect(() => {
    mixerRef.current?.setRecordSource(recordSource);
  }, [recordSource]);

  // Probe the deejai backend once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await probe(base);
      if (cancelled) return;
      if (res) {
        setBackendUp(true);
        setSessionId(res.id);
        setParserName(res.parser);
        setProject(res.project);
      } else {
        setBackendUp(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base]);

  const loop = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const landmarker = landmarkerRef.current;
    const synth = synthRef.current;
    if (!video || !canvas || !landmarker) {
      rafRef.current = requestAnimationFrame(loop);
      return;
    }
    const ctx = canvas.getContext("2d");
    if (video.readyState >= 2 && ctx) {
      if (canvas.width !== video.videoWidth) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }
      let playHand: HandPose | null = null;
      let modHand: HandPose | null = null;
      if (video.currentTime !== lastVideoTimeRef.current) {
        lastVideoTimeRef.current = video.currentTime;
        const result = landmarker.detectForVideo(video, performance.now());
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const hands = result.landmarks ?? [];
        setHandCount(hands.length);
        const tSec = performance.now() / 1000;
        for (let i = 0; i < hands.length; i++) {
          const raw = hands[i] as Landmark[];
          const smoother = smoothersRef.current[i] ?? smoothersRef.current[0];
          const lm = smoother.filter(raw, tSec) as Landmark[];
          const handedness =
            result.handednesses?.[i]?.[0]?.categoryName ?? "Right";
          const isModifier = cfgRef.current.twoHand && handedness === "Left";
          drawHand(ctx, lm, canvas.width, canvas.height, HAND_COLORS[isModifier ? 1 : 0]);
          const pose = readHand(lm);
          pose.x = 1 - pose.x;
          if (isModifier) modHand = pose;
          else if (!playHand) playHand = pose;
        }
        const c = cfgRef.current;
        const sel = mapHandsToSelection(playHand, modHand, {
          mode: "diatonic",
          key: { tonic: c.tonic, scale: c.scale, octave: c.octave },
          extension: c.extension,
          twoHand: c.twoHand,
          progression: [],
        });
        let notes: number[] = [];
        let freqs: number[] = [];
        let cutoff = sel.cutoffHz;
        let expr = sel.expression;
        if (!sel.rest && sel.chord) {
          notes = sel.chord.notes;
          freqs = sel.chord.freqs;
          if (c.latchOn) {
            latchedChordRef.current = { notes, freqs };
            latchedCtrlRef.current = { cutoff, expr };
          }
        } else if (c.latchOn && latchedChordRef.current) {
          notes = latchedChordRef.current.notes;
          freqs = latchedChordRef.current.freqs;
          cutoff = latchedCtrlRef.current.cutoff;
          expr = latchedCtrlRef.current.expr;
        }
        synth.setCutoff(cutoff);
        synth.setExpression(expr);
        if (c.arpOn) {
          arpRef.current?.setChord(notes);
          synth.playFreqs([]);
        } else {
          arpRef.current?.setChord([]);
          synth.playFreqs(freqs);
        }
        setSelection(sel);
      }
    }
    rafRef.current = requestAnimationFrame(loop);
  }, []);

  const start = useCallback(async () => {
    setErrorMsg("");
    try {
      await synthRef.current.ensureStarted();
      synthRef.current.applyConfig(getPreset(presetName));
      synthRef.current.setMasterVolume(volume);
      const audioCtx = synthRef.current.getContext();
      if (audioCtx && !arpRef.current) {
        arpRef.current = new Arpeggiator(audioCtx, (f, t, g) =>
          synthRef.current.triggerNote(f, t, g)
        );
        arpRef.current.setParams({
          pattern: "up",
          division: "1/8",
          bpm: arpBpm,
          octaveRange: 1,
          gate: 0.6,
        });
      }
      if (audioCtx && !drumsRef.current) {
        const s = synthRef.current;
        drumsRef.current = new DrumMachine(audioCtx, {
          kick: (t) => s.triggerKick(t),
          snare: (t) => s.triggerSnare(t),
          hat: (t) => s.triggerHat(t),
          click: (t, accent) => s.triggerClick(t, accent),
        });
        drumsRef.current.setBpm(arpBpm);
        drumsRef.current.setPattern(drumPattern);
        if (drumsOn) drumsRef.current.start();
      }
      if (audioCtx && !mixerRef.current) {
        const s = synthRef.current;
        const out = s.getOutputBus() ?? audioCtx.destination;
        const mixer = new ProducerMixer(audioCtx, out, (t, accent) =>
          s.triggerClick(t, accent)
        );
        const instr = s.getInstrumentBus();
        if (instr) mixer.setInstrumentNode(instr);
        mixer.setConfig({ bpm: arpBpm, bars: loopBars, free: false });
        mixer.setRecordSource(recordSource);
        mixer.onChange = () => {
          const m = mixerRef.current;
          if (!m) return;
          setTracks(m.getStates());
          setRecording(m.isRecording);
          setPlaying(m.isPlaying);
        };
        mixerRef.current = mixer;
      }
      setPhase("loading-model");
      landmarkerRef.current = await createHandLandmarker({
        numHands: 2,
        onStatus: setStatus,
      });
      setPhase("requesting-camera");
      setStatus("Requesting camera...");
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 1280, height: 720, facingMode: "user" },
          audio: false,
        });
      } catch (err) {
        setPhase("camera-denied");
        setErrorMsg(err instanceof Error ? err.message : "Camera permission denied.");
        return;
      }
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      setPhase("running");
      setStatus("Tracking. Show a hand to play, then record a loop.");
      rafRef.current = requestAnimationFrame(loop);
    } catch (err) {
      setPhase("error");
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, [loop, volume, presetName, arpBpm, drumPattern, drumsOn, loopBars, recordSource]);

  const getSharedMic = useCallback(async (): Promise<MediaStream> => {
    if (micStreamRef.current) return micStreamRef.current;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micStreamRef.current = stream;
    return stream;
  }, []);

  const toggleRecord = useCallback(async () => {
    setMixerError("");
    const m = mixerRef.current;
    if (!m) {
      setMixerError("Enable camera & sound first.");
      return;
    }
    if (m.isRecording) {
      m.stopRecording();
      return;
    }
    if (recordSource === "mic") {
      try {
        m.setMicStream(await getSharedMic());
      } catch (err) {
        setMixerError(
          err instanceof Error
            ? `Microphone unavailable: ${err.message}`
            : "Microphone permission denied."
        );
        return;
      }
    }
    m.setConfig({ bpm: arpBpm, bars: loopBars, free: false });
    m.setRecordSource(recordSource);
    if (!m.canRecord()) {
      setMixerError("Selected source is not available.");
      return;
    }
    m.arm(countIn ? 1 : 0);
  }, [recordSource, arpBpm, loopBars, countIn, getSharedMic]);

  const exportMix = useCallback(async () => {
    const m = mixerRef.current;
    if (!m) return;
    setMixerError("");
    try {
      const bytes = await m.exportMix(exportCycles);
      if (bytes) downloadBytes(bytes, `deesynth-mix-${stamp()}.wav`);
      else setMixerError("Nothing to export yet.");
    } catch (err) {
      setMixerError(err instanceof Error ? err.message : "Export failed.");
    }
  }, [exportCycles]);

  // Run a natural-language producer command against deejai and pull in the new
  // AI backing stems as mixer tracks.
  const runCommand = useCallback(async () => {
    setAiError("");
    const m = mixerRef.current;
    const audioCtx = synthRef.current.getContext();
    if (!audioCtx || !m) {
      setAiError("Enable camera & sound first so the mixer's audio is ready.");
      return;
    }
    if (!sessionId) {
      setAiError("No deejai session. Is the backend running?");
      return;
    }
    const text = commandText.trim();
    if (!text) return;
    setAiBusy(true);
    try {
      const res = await sendCommand(base, sessionId, text);
      setAiMessages(res.messages ?? []);
      setProject(res.project);
      const candidates = newStemsToAdd(
        res.project,
        loadedStemFilesRef.current
      ).filter((t) => AI_STEM_ROLES.has(t.role));
      if (candidates.length === 0) {
        setAiError(
          "No new backing stems in the response. Try 'add a lofi beat' or 'add a warm pad'."
        );
      }
      for (const t of candidates) {
        try {
          const buf = await fetchStemBuffer(base, sessionId, t.file, audioCtx);
          m.addStemTrack(buf, stemTrackLabel(t), t.role, normalizePan(t.pan));
          loadedStemFilesRef.current.add(t.file);
        } catch {
          setAiError(`Loaded some stems, but failed to fetch ${t.file}.`);
        }
      }
    } catch (err) {
      if (err instanceof DeejaiUnavailableError) {
        setBackendUp(false);
        setAiError("Lost contact with the deejai backend.");
      } else {
        setAiError(err instanceof Error ? err.message : "Command failed.");
      }
    } finally {
      setAiBusy(false);
    }
  }, [base, sessionId, commandText]);

  const retryBackend = useCallback(async () => {
    setBackendUp(null);
    setAiError("");
    const res = await probe(base);
    if (res) {
      setBackendUp(true);
      setSessionId(res.id);
      setParserName(res.parser);
      setProject(res.project);
      loadedStemFilesRef.current = new Set();
    } else {
      setBackendUp(false);
    }
  }, [base]);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      arpRef.current?.stop();
      drumsRef.current?.stop();
      mixerRef.current?.dispose();
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      const v = videoRef.current;
      if (v && v.srcObject) {
        (v.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
      }
      synthRef.current.close();
    };
  }, []);

  const running = phase === "running";
  const started = running || phase === "camera-denied";
  const anySolo = tracks.some((t) => t.solo);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      {/* Stage + mixer */}
      <div className="relative">
        <div
          className="relative aspect-video w-full overflow-hidden rounded-2xl border-2 border-magenta bg-ink"
          style={{ boxShadow: "0 0 24px rgba(208,0,255,0.35)" }}
        >
          <video
            ref={videoRef}
            playsInline
            muted
            className="absolute inset-0 h-full w-full -scale-x-100 object-cover"
          />
          <canvas
            ref={canvasRef}
            className="absolute inset-0 h-full w-full -scale-x-100 object-cover"
          />
          {phase !== "running" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-ink/80 p-6 text-center">
              {phase === "idle" && (
                <>
                  <p className="max-w-sm text-white/90">
                    Producer mode: play the hand instrument live, record loops
                    into the mixer, and add AI backing from deejai. The camera
                    feed never leaves your device.
                  </p>
                  <button
                    onClick={start}
                    className="rounded-xl bg-yellow px-6 py-3 text-lg font-semibold text-ink transition hover:bg-orange"
                  >
                    Enable camera &amp; sound
                  </button>
                </>
              )}
              {(phase === "loading-model" || phase === "requesting-camera") && (
                <div className="flex flex-col items-center gap-3">
                  <div className="h-8 w-8 animate-spin rounded-full border-2 border-purple/40 border-t-yellow" />
                  <p className="text-white/90">{status}</p>
                </div>
              )}
              {phase === "camera-denied" && (
                <div className="flex max-w-sm flex-col items-center gap-3">
                  <p className="font-semibold text-orange">Camera unavailable</p>
                  <p className="text-sm text-white/70">{errorMsg}</p>
                  <button
                    onClick={start}
                    className="rounded-lg bg-purple/45 px-4 py-2 text-sm hover:bg-magenta/50"
                  >
                    Retry
                  </button>
                </div>
              )}
              {phase === "error" && (
                <div className="flex max-w-sm flex-col items-center gap-3">
                  <p className="font-semibold text-orange">Something went wrong</p>
                  <p className="text-sm text-white/70">{errorMsg}</p>
                  <button
                    onClick={start}
                    className="rounded-lg bg-purple/45 px-4 py-2 text-sm hover:bg-magenta/50"
                  >
                    Retry
                  </button>
                </div>
              )}
            </div>
          )}
          {running && handCount === 0 && (
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-ink/80 px-4 py-1.5 text-sm text-white/90">
              No hand detected. Hold your hand up to the camera.
            </div>
          )}
        </div>

        {/* Now playing */}
        <div className="mt-4 rounded-2xl border border-magenta/30 bg-purple/15 p-4">
          <div className="flex items-baseline justify-between">
            <div>
              <div className="text-xs uppercase tracking-wide text-white/55">
                Now playing{arpOn && <span className="text-orange"> · arp</span>}
                {latchOn && <span className="text-yellow"> · latch</span>}
                {drumsOn && <span className="text-orange"> · drums</span>}
              </div>
              <div className="text-2xl font-semibold">
                {selection?.chord ? (
                  <>
                    {selection.chord.name}{" "}
                    <span className="text-yellow">({selection.chord.label})</span>
                  </>
                ) : (
                  <span className="text-white/55">(rest)</span>
                )}
              </div>
            </div>
            <div className="text-right text-sm text-white/70">
              Key: {keyName({ tonic, scale, octave })}
            </div>
          </div>
          <div className="mt-2 font-mono text-sm text-white/90">
            {selection?.chord
              ? selection.chord.notes.map(midiToName).join("  ·  ")
              : " "}
          </div>
        </div>

        {/* MIXER */}
        <div className="mt-4 rounded-2xl border border-magenta/30 bg-purple/15 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-white/70">
              Mixer <span className="text-white/40">({tracks.length})</span>
              {recording && <span className="text-orange"> · recording</span>}
            </h2>
            <div className="flex items-center gap-2">
              <button
                onClick={() =>
                  playing ? mixerRef.current?.stopAll() : mixerRef.current?.playAll()
                }
                disabled={tracks.length === 0}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                  tracks.length === 0
                    ? "cursor-not-allowed bg-purple/25 text-white/40"
                    : "bg-purple/45 text-white hover:bg-magenta/40"
                }`}
              >
                {playing ? "Stop all" : "Play all"}
              </button>
              <button
                onClick={() => mixerRef.current?.clearAll()}
                disabled={tracks.length === 0}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                  tracks.length === 0
                    ? "cursor-not-allowed bg-purple/25 text-white/40"
                    : "bg-purple/45 text-white hover:bg-magenta/40"
                }`}
              >
                Clear
              </button>
            </div>
          </div>

          {/* Record controls */}
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <button
              onClick={toggleRecord}
              disabled={!started}
              className={`rounded-lg px-3 py-1.5 font-medium transition ${
                !started
                  ? "cursor-not-allowed bg-purple/25 text-white/40"
                  : recording
                    ? "bg-orange text-ink hover:bg-yellow"
                    : "bg-magenta text-ink hover:bg-magenta/80"
              }`}
            >
              {recording ? "Stop take" : "Record loop"}
            </button>
            <select
              value={recordSource}
              onChange={(e) => setRecordSource(e.target.value as "instrument" | "mic")}
              className="rounded-lg border border-purple/50 bg-purple/25 px-2 py-1"
            >
              <option value="instrument">Instrument</option>
              <option value="mic">Mic</option>
            </select>
            <select
              value={loopBars}
              onChange={(e) => setLoopBars(Number(e.target.value))}
              className="rounded-lg border border-purple/50 bg-purple/25 px-2 py-1"
            >
              {[1, 2, 4, 8].map((b) => (
                <option key={b} value={b}>
                  {b} {b === 1 ? "bar" : "bars"}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={countIn}
                onChange={(e) => setCountIn(e.target.checked)}
              />
              Count-in
            </label>
          </div>

          {/* Track list */}
          {tracks.length === 0 ? (
            <p className="text-xs text-white/55">
              No tracks yet. Record a loop from the hand instrument, or add an AI
              backing stem from the panel on the right.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {tracks.map((t) => (
                <li
                  key={t.id}
                  className="rounded-lg border border-magenta/20 bg-purple/10 p-2"
                >
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-white/90">
                      {t.name}{" "}
                      <span className="text-xs text-white/40">
                        ({t.kind === "stem" ? t.role : t.source})
                      </span>
                    </span>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => mixerRef.current?.setMute(t.id, !t.muted)}
                        className={`rounded px-2 py-0.5 text-xs font-medium ${
                          t.muted
                            ? "bg-orange text-ink"
                            : "bg-purple/25 text-white/80 hover:bg-magenta/40"
                        }`}
                      >
                        M
                      </button>
                      <button
                        onClick={() => mixerRef.current?.setSolo(t.id, !t.solo)}
                        className={`rounded px-2 py-0.5 text-xs font-medium ${
                          t.solo
                            ? "bg-yellow text-ink"
                            : "bg-purple/25 text-white/80 hover:bg-magenta/40"
                        } ${anySolo && !t.solo ? "opacity-60" : ""}`}
                      >
                        S
                      </button>
                      <button
                        onClick={() => {
                          const b = mixerRef.current?.getTrackWav(t.id);
                          if (b) downloadBytes(b, `deesynth-${t.role}-${t.id}-${stamp()}.wav`);
                        }}
                        className="rounded bg-purple/25 px-2 py-0.5 text-xs text-white/80 hover:bg-magenta/40"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => mixerRef.current?.deleteTrack(t.id)}
                        className="rounded bg-purple/25 px-2 py-0.5 text-xs text-white/80 hover:bg-magenta/40"
                      >
                        Del
                      </button>
                    </div>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="w-8 text-xs text-white/50">Vol</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={t.volume}
                      onChange={(e) =>
                        mixerRef.current?.setVolume(t.id, Number(e.target.value))
                      }
                      className="w-full"
                    />
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="w-8 text-xs text-white/50">Pan</span>
                    <input
                      type="range"
                      min={-1}
                      max={1}
                      step={0.01}
                      value={t.pan}
                      onChange={(e) =>
                        mixerRef.current?.setPan(t.id, Number(e.target.value))
                      }
                      className="w-full"
                    />
                    <span className="w-8 text-right text-xs text-white/40">
                      {t.pan === 0 ? "C" : t.pan < 0 ? `L${Math.round(-t.pan * 100)}` : `R${Math.round(t.pan * 100)}`}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {/* Export */}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-white/70">Export</span>
            <select
              value={exportCycles}
              onChange={(e) => setExportCycles(Number(e.target.value))}
              className="rounded-lg border border-purple/50 bg-purple/25 px-2 py-1"
            >
              {[1, 2, 4, 8].map((c) => (
                <option key={c} value={c}>
                  {c} {c === 1 ? "cycle" : "cycles"}
                </option>
              ))}
            </select>
            <button
              onClick={exportMix}
              disabled={tracks.length === 0}
              className={`rounded-lg px-3 py-1 font-medium transition ${
                tracks.length === 0
                  ? "cursor-not-allowed bg-purple/25 text-white/40"
                  : "bg-yellow text-ink hover:bg-orange"
              }`}
            >
              Export mix (WAV)
            </button>
          </div>
          {!started && (
            <p className="mt-2 text-xs text-white/40">Enable camera &amp; sound first.</p>
          )}
          {mixerError && <p className="mt-1 text-xs text-orange">{mixerError}</p>}
          <p className="mt-2 text-xs text-white/55">
            Loops and AI stems share one AudioContext and start together on Play
            all. Export bounces the whole mix (with pan) to a stereo WAV.
          </p>
        </div>
      </div>

      {/* Right column: instrument controls + AI panel */}
      <aside className="flex flex-col gap-4">
        {/* AI producer panel */}
        <section className="rounded-2xl border border-magenta/30 bg-purple/15 p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-white/70">
              AI producer (deejai)
            </h2>
            <span
              className={`text-xs ${
                backendUp === true
                  ? "text-yellow"
                  : backendUp === false
                    ? "text-orange"
                    : "text-white/40"
              }`}
            >
              {backendUp === true
                ? "connected"
                : backendUp === false
                  ? "offline"
                  : "checking..."}
            </span>
          </div>

          {backendUp === false && (
            <div className="rounded-lg border border-orange/40 bg-orange/10 p-3 text-sm">
              <p className="mb-2 text-white/90">
                Start the deejai backend to enable AI features. The instrument,
                mixer and export all work without it.
              </p>
              <p className="mb-1 text-xs text-white/60">
                From the deejai project directory, run:
              </p>
              <code className="block overflow-x-auto rounded bg-ink/60 px-2 py-1.5 text-xs text-yellow">
                {UVICORN_CMD}
              </code>
              <p className="mt-2 text-xs text-white/55">
                deesynth talks to it at <code>{base}</code> (set{" "}
                <code>VITE_DEEJAI_URL</code> to change). Then:
              </p>
              <button
                onClick={retryBackend}
                className="mt-2 rounded-lg bg-purple/45 px-3 py-1.5 text-sm text-white hover:bg-magenta/40"
              >
                Retry connection
              </button>
            </div>
          )}

          {backendUp === true && (
            <>
              <p className="mb-2 text-xs text-white/55">
                Parser: {parserName || "rule-based"}. Try "add a lofi beat",
                "add a warm pad backing in C", "add a trap beat".
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={commandText}
                  onChange={(e) => setCommandText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !aiBusy) runCommand();
                  }}
                  placeholder="add a lofi beat"
                  className="w-full rounded-lg border border-purple/50 bg-purple/25 px-2 py-1.5 text-sm"
                />
                <button
                  onClick={runCommand}
                  disabled={aiBusy}
                  className={`shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                    aiBusy
                      ? "cursor-wait bg-purple/25 text-white/50"
                      : "bg-yellow text-ink hover:bg-orange"
                  }`}
                >
                  {aiBusy ? "..." : "Run"}
                </button>
              </div>

              {project && (
                <div className="mt-2 flex flex-wrap gap-2 text-xs text-white/70">
                  {project.tempo != null && (
                    <span className="rounded bg-purple/25 px-2 py-0.5">
                      {Math.round(project.tempo)} BPM
                    </span>
                  )}
                  {project.key && (
                    <span className="rounded bg-purple/25 px-2 py-0.5">
                      key {project.key}
                    </span>
                  )}
                  {project.beat_style && (
                    <span className="rounded bg-purple/25 px-2 py-0.5">
                      {project.beat_style}
                    </span>
                  )}
                </div>
              )}

              {aiMessages.length > 0 && (
                <ul className="mt-2 flex flex-col gap-1 text-xs text-white/80">
                  {aiMessages.map((mmsg, i) => (
                    <li key={i} className="rounded bg-ink/40 px-2 py-1">
                      {mmsg}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-xs text-white/45">
                Backing stems (beat / pad / bass / arp) drop into the mixer. Set
                the instrument tempo to the project BPM for the tightest sync.
              </p>
            </>
          )}
          {aiError && <p className="mt-2 text-xs text-orange">{aiError}</p>}
        </section>

        {/* Instrument controls */}
        <section className="rounded-2xl border border-magenta/30 bg-purple/15 p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/70">
            Instrument
          </h2>
          <label className="mb-3 block text-sm">
            <span className="mb-1 block text-white/70">Key</span>
            <select
              value={tonic}
              onChange={(e) => setTonic(Number(e.target.value))}
              className="w-full rounded-lg border border-purple/50 bg-purple/25 px-2 py-1.5"
            >
              {NOTE_NAMES.map((n, i) => (
                <option key={n} value={i}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="mb-3 block text-sm">
            <span className="mb-1 block text-white/70">Scale</span>
            <select
              value={scale}
              onChange={(e) => setScale(e.target.value as ScaleName)}
              className="w-full rounded-lg border border-purple/50 bg-purple/25 px-2 py-1.5"
            >
              {SCALES.map((s) => (
                <option key={s} value={s}>
                  {SCALE_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="mb-3 block text-sm">
            <span className="mb-1 block text-white/70">Base octave: {octave}</span>
            <input
              type="range"
              min={2}
              max={5}
              step={1}
              value={octave}
              onChange={(e) => setOctave(Number(e.target.value))}
              className="w-full"
            />
          </label>
          <div className="mb-3 text-sm">
            <span className="mb-1 block text-white/70">Chord extension</span>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  ["triad", "Triad"],
                  ["6th", "6th"],
                  ["7th", "7th"],
                ] as [ChordExtension, string][]
              ).map(([ext, label]) => (
                <button
                  key={ext}
                  onClick={() => setExtension(ext)}
                  className={`rounded-lg px-2 py-1.5 font-medium transition ${
                    extension === ext
                      ? "bg-yellow text-ink"
                      : "bg-purple/25 text-white/90 hover:bg-magenta/40"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <label className="mb-3 block text-sm">
            <span className="mb-1 block text-white/70">Sound</span>
            <select
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              className="w-full rounded-lg border border-purple/50 bg-purple/25 px-2 py-1.5"
            >
              {PRESET_NAMES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="mb-3 block text-sm">
            <span className="mb-1 block text-white/70">
              Master volume: {(volume * 100).toFixed(0)}%
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              className="w-full"
            />
          </label>
          <label className="mb-3 block text-sm">
            <span className="mb-1 block text-white/70">
              Tempo (shared): {arpBpm} BPM
            </span>
            <input
              type="range"
              min={60}
              max={200}
              step={1}
              value={arpBpm}
              onChange={(e) => setArpBpm(Number(e.target.value))}
              className="w-full"
            />
          </label>
          <div className="flex flex-col gap-2 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={twoHand}
                onChange={(e) => setTwoHand(e.target.checked)}
              />
              Two-hand mode (left open = vi/vii)
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={latchOn}
                onChange={(e) => setLatchOn(e.target.checked)}
              />
              Chord latch
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={arpOn}
                onChange={(e) => setArpOn(e.target.checked)}
              />
              Arpeggiator
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={drumsOn}
                onChange={(e) => setDrumsOn(e.target.checked)}
              />
              Drums ({drumPattern})
            </label>
          </div>
        </section>
      </aside>
    </div>
  );
}
