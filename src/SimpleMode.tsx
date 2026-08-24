import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HandLandmarker } from "@mediapipe/tasks-vision";
import { createHandLandmarker } from "./lib/handLandmarker";
import { readHand, type Landmark, type HandPose } from "./lib/gestures";
import {
  mapHandsToSelection,
  type Selection,
  type PlayMode,
} from "./lib/mapping";
import {
  NOTE_NAMES,
  midiToName,
  keyName,
  parseProgression,
  SCALES,
  SCALE_LABELS,
  type ScaleName,
  type ChordExtension,
} from "./lib/music";
import { Synth } from "./lib/synth";
import {
  PRESET_NAMES,
  getPreset,
  defaultSound,
  cloneSound,
  DEFAULT_PRESET,
  type SoundConfig,
  type Waveform,
  type LfoTarget,
} from "./lib/presets";
import {
  Arpeggiator,
  type ArpPattern,
  type ArpDivision,
} from "./lib/arp";
import {
  DrumMachine,
  DRUM_PATTERN_NAMES,
  type DrumPatternName,
} from "./lib/drums";
import { LandmarkSmoother } from "./lib/smoothing";
import { Harmonizer } from "./lib/harmonizer";
import {
  VocalLooper,
  sourcesForSelection,
  type RecordSource,
  type LoopTrackState,
} from "./lib/vocalLooper";
import { InputMeter } from "./lib/meter";
import { InputLevelMeter } from "./InputLevelMeter";
import { drawHand } from "./lib/draw";
import { Legend } from "./Legend";

const LS_SOUND = "handsynth.sound.v1";
const LS_PRESET = "handsynth.preset.v1";

function loadSound(): SoundConfig {
  try {
    const raw = localStorage.getItem(LS_SOUND);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && p.env && p.fx && p.lfo) return p as SoundConfig;
    }
  } catch {
    /* ignore */
  }
  return defaultSound();
}

function loadPreset(): string {
  try {
    return localStorage.getItem(LS_PRESET) || DEFAULT_PRESET;
  } catch {
    return DEFAULT_PRESET;
  }
}

/** Elapsed milliseconds -> "M:SS" for the recording timer. */
function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function Range({
  label,
  value,
  min,
  max,
  step,
  onChange,
  fmt,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  fmt?: (v: number) => string;
  disabled?: boolean;
}) {
  return (
    <label className={`mb-2 block text-sm ${disabled ? "opacity-50" : ""}`}>
      <span className="mb-1 flex justify-between text-white/70">
        <span>{label}</span>
        <span className="text-white/55">{fmt ? fmt(value) : value}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full"
      />
    </label>
  );
}

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

/** Nearest note name (e.g. "C4") for a frequency in Hz. */
function freqToNoteLabel(hz: number): string {
  if (!hz || hz <= 0) return "-";
  const midi = Math.round(12 * Math.log2(hz / 440) + 69);
  return midiToName(midi);
}

type Phase =
  | "idle"
  | "loading-model"
  | "requesting-camera"
  | "running"
  | "camera-denied"
  | "error";

const HAND_COLORS = ["#ffd400", "#d000ff"]; // play = yellow, modifier = magenta

// Simple mode: the full handsynth experience, copied verbatim from the
// handsynth project and rendered as one of Trackstar's two top-level modes.
export default function SimpleMode() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const landmarkerRef = useRef<HandLandmarker | null>(null);
  const synthRef = useRef<Synth>(new Synth());
  const arpRef = useRef<Arpeggiator | null>(null);
  const drumsRef = useRef<DrumMachine | null>(null);
  const harmonizerRef = useRef<Harmonizer | null>(null);
  // Frequencies of the chord the user is currently holding, updated each frame
  // so the harmonizer can lock its voices onto the held chord's tones.
  const heldChordFreqsRef = useRef<number[]>([]);
  const micStreamRef = useRef<MediaStream | null>(null);
  // The webcam stream, kept so Record can capture a video of the performer.
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastVideoTimeRef = useRef<number>(-1);

  // Per-hand landmark smoothers (index 0/1), latch + record state.
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
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordStartRef = useRef<number>(0);
  const looperRef = useRef<VocalLooper | null>(null);
  const inputMeterRef = useRef<InputMeter | null>(null);
  const [micReady, setMicReady] = useState<boolean>(false);

  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState<string>("");

  // Musical controls
  const [mode, setMode] = useState<PlayMode>("diatonic");
  const [tonic, setTonic] = useState<number>(0); // C
  const [scale, setScale] = useState<ScaleName>("major");
  const [octave, setOctave] = useState<number>(3);
  const [extension, setExtension] = useState<ChordExtension>("triad");
  const [progressionText, setProgressionText] = useState<string>("Am E F C");

  // Synth controls
  const [sound, setSound] = useState<SoundConfig>(loadSound);
  const [presetName, setPresetName] = useState<string>(loadPreset);
  const [volume, setVolume] = useState<number>(0.5);
  const [twoHand, setTwoHand] = useState<boolean>(false);

  // Arpeggiator controls
  const [arpOn, setArpOn] = useState<boolean>(false);
  const [arpPattern, setArpPattern] = useState<ArpPattern>("up");
  const [arpDivision, setArpDivision] = useState<ArpDivision>("1/8");
  const [arpBpm, setArpBpm] = useState<number>(120);
  const [arpOctaves, setArpOctaves] = useState<number>(1);
  const [arpGate, setArpGate] = useState<number>(0.6);

  // Drum machine + metronome
  const [drumsOn, setDrumsOn] = useState<boolean>(false);
  const [drumPattern, setDrumPattern] =
    useState<DrumPatternName>("Four-on-floor");
  const [kickOn, setKickOn] = useState<boolean>(true);
  const [snareOn, setSnareOn] = useState<boolean>(true);
  const [hatOn, setHatOn] = useState<boolean>(true);
  const [metronomeOn, setMetronomeOn] = useState<boolean>(false);

  // Playability
  const [smoothing, setSmoothing] = useState<number>(0.4);
  const [latchOn, setLatchOn] = useState<boolean>(false);

  // Recording
  const [recording, setRecording] = useState<boolean>(false);
  const [recordElapsed, setRecordElapsed] = useState<number>(0);
  const [recordError, setRecordError] = useState<string>("");

  // Harmonizer controls
  const [harmonizerOn, setHarmonizerOn] = useState<boolean>(false);
  const [micError, setMicError] = useState<string>("");
  const [harmonizerLevel, setHarmonizerLevel] = useState<number>(1.0);
  // Fully wet by default: the raw voice is captured into the recording
  // separately, so the harmonizer adds harmonies on top rather than doubling it.
  const [harmonizerDryWet, setHarmonizerDryWet] = useState<number>(1.0);
  const [harmonizerVoices, setHarmonizerVoices] = useState<number>(4);
  // Live readout of the detected sung pitch (Hz), for on-screen feedback.
  const [sungPitch, setSungPitch] = useState<number | null>(null);

  // Vocal looper
  const [loopSource, setLoopSource] = useState<RecordSource>("mic");
  const [loopBars, setLoopBars] = useState<number>(2);
  const [loopFree, setLoopFree] = useState<boolean>(false);
  const [loopCountIn, setLoopCountIn] = useState<boolean>(true);
  const [loopRecording, setLoopRecording] = useState<boolean>(false);
  const [loopPlaying, setLoopPlaying] = useState<boolean>(false);
  const [loopTracks, setLoopTracks] = useState<LoopTrackState[]>([]);
  const [loopError, setLoopError] = useState<string>("");
  const [exportCycles, setExportCycles] = useState<number>(1);

  // Live readout
  const [selection, setSelection] = useState<Selection | null>(null);
  const [handCount, setHandCount] = useState<number>(0);

  // Parse the progression text into slots (labels + validity + parsed chords).
  const progressionSlots = useMemo(
    () => parseProgression(progressionText, octave),
    [progressionText, octave]
  );

  // Latest values for the rAF loop without re-subscribing every render.
  const cfgRef = useRef({
    mode,
    tonic,
    scale,
    octave,
    extension,
    twoHand,
    arpOn,
    latchOn,
    progression: progressionSlots.map((s) => s.chord),
  });
  useEffect(() => {
    cfgRef.current = {
      mode,
      tonic,
      scale,
      octave,
      extension,
      twoHand,
      arpOn,
      latchOn,
      progression: progressionSlots.map((s) => s.chord),
    };
  }, [
    mode,
    tonic,
    scale,
    octave,
    extension,
    twoHand,
    arpOn,
    latchOn,
    progressionSlots,
  ]);

  // Push smoothing amount into the per-hand landmark smoothers.
  useEffect(() => {
    for (const s of smoothersRef.current) s.setAmount(smoothing);
  }, [smoothing]);

  // When latch turns off, drop the held chord.
  useEffect(() => {
    if (!latchOn) latchedChordRef.current = null;
  }, [latchOn]);

  // Apply the sound config to the synth and persist it.
  useEffect(() => {
    synthRef.current.applyConfig(sound);
    try {
      localStorage.setItem(LS_SOUND, JSON.stringify(sound));
    } catch {
      /* ignore */
    }
  }, [sound]);
  useEffect(() => {
    try {
      localStorage.setItem(LS_PRESET, presetName);
    } catch {
      /* ignore */
    }
  }, [presetName]);
  useEffect(() => {
    synthRef.current.setMasterVolume(volume);
  }, [volume]);

  // Sound-config editing helpers.
  const updateSound = useCallback((mut: (s: SoundConfig) => void) => {
    setSound((prev) => {
      const next = cloneSound(prev);
      mut(next);
      return next;
    });
    setPresetName("custom");
  }, []);
  const selectPreset = useCallback((name: string) => {
    setSound(getPreset(name));
    setPresetName(name);
  }, []);

  // Keep arpeggiator params in sync.
  useEffect(() => {
    arpRef.current?.setParams({
      pattern: arpPattern,
      division: arpDivision,
      bpm: arpBpm,
      octaveRange: arpOctaves,
      gate: arpGate,
    });
  }, [arpPattern, arpDivision, arpBpm, arpOctaves, arpGate]);

  // On enabling the arp, clear any sustained block chord so it doesn't linger.
  useEffect(() => {
    if (arpOn) synthRef.current.releaseAll();
  }, [arpOn]);

  // Keep the drum machine in sync. It shares the transport BPM with the arp.
  useEffect(() => {
    const dm = drumsRef.current;
    if (!dm) return;
    dm.setBpm(arpBpm);
    dm.setPattern(drumPattern);
    dm.setEnables({ kick: kickOn, snare: snareOn, hat: hatOn });
    dm.setMetronome(metronomeOn);
    const shouldRun = drumsOn || metronomeOn;
    if (shouldRun && !dm.isRunning) dm.start();
    else if (!shouldRun && dm.isRunning) dm.stop();
  }, [
    drumsOn,
    drumPattern,
    kickOn,
    snareOn,
    hatOn,
    metronomeOn,
    arpBpm,
  ]);

  // Keep the harmonizer's live parameters in sync with the UI controls.
  useEffect(() => {
    harmonizerRef.current?.setOutputLevel(harmonizerLevel);
  }, [harmonizerLevel]);
  useEffect(() => {
    harmonizerRef.current?.setDryWet(harmonizerDryWet);
  }, [harmonizerDryWet]);
  useEffect(() => {
    harmonizerRef.current?.setMaxVoices(harmonizerVoices);
  }, [harmonizerVoices]);

  // Keep the looper config synced (shares the transport BPM with arp/drums).
  useEffect(() => {
    looperRef.current?.setConfig({ bpm: arpBpm, bars: loopBars, free: loopFree });
  }, [arpBpm, loopBars, loopFree]);
  useEffect(() => {
    looperRef.current?.setRecordSource(loopSource);
  }, [loopSource]);

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
          // One-Euro smoothing on the raw landmarks (per hand index).
          const raw = hands[i] as Landmark[];
          const smoother = smoothersRef.current[i] ?? smoothersRef.current[0];
          const lm = smoother.filter(raw, tSec) as Landmark[];

          const handedness =
            result.handednesses?.[i]?.[0]?.categoryName ?? "Right";
          const isModifier =
            cfgRef.current.twoHand && handedness === "Left";
          drawHand(
            ctx,
            lm,
            canvas.width,
            canvas.height,
            HAND_COLORS[isModifier ? 1 : 0]
          );

          const pose = readHand(lm);
          pose.x = 1 - pose.x; // mirror X to match the mirrored display
          if (isModifier) modHand = pose;
          else if (!playHand) playHand = pose;
        }

        const c = cfgRef.current;
        const sel = mapHandsToSelection(playHand, modHand, {
          mode: c.mode,
          key: { tonic: c.tonic, scale: c.scale, octave: c.octave },
          extension: c.extension,
          twoHand: c.twoHand,
          progression: c.progression,
        });

        // Chord latch: keep the last chord sounding hands-free until a new
        // chord is selected or latch is turned off.
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
          // Hand dropped / fist but latched: hold the chord and its last
          // expressive settings so it does not mute.
          notes = latchedChordRef.current.notes;
          freqs = latchedChordRef.current.freqs;
          cutoff = latchedCtrlRef.current.cutoff;
          expr = latchedCtrlRef.current.expr;
        }

        synth.setCutoff(cutoff);
        synth.setExpression(expr);

        if (c.arpOn) {
          arpRef.current?.setChord(notes);
          synth.playFreqs([]); // arp handles note-on; keep block chord silent
        } else {
          arpRef.current?.setChord([]); // ensure arp is idle
          synth.playFreqs(freqs);
        }

        // Vocal harmonizer: the tones of the chord the user is holding are the
        // harmony targets. Feed them to the harmonizer each frame; it detects
        // the sung pitch on the mic and re-locks a pitch-shifted copy of the
        // voice onto each chord tone. It no-ops cheaply while disabled. When
        // resting (no chord), the empty list fades the harmonies out.
        heldChordFreqsRef.current = freqs;
        const harm = harmonizerRef.current;
        if (harm) {
          harm.update(freqs);
          setSungPitch(harm.getDetectedPitch());
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
      synthRef.current.applyConfig(sound);
      synthRef.current.setMasterVolume(volume);

      // Build the arpeggiator + drum machine now that the AudioContext exists.
      const audioCtx = synthRef.current.getContext();
      if (audioCtx && !arpRef.current) {
        arpRef.current = new Arpeggiator(audioCtx, (f, t, g) =>
          synthRef.current.triggerNote(f, t, g)
        );
        arpRef.current.setParams({
          pattern: arpPattern,
          division: arpDivision,
          bpm: arpBpm,
          octaveRange: arpOctaves,
          gate: arpGate,
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
        drumsRef.current.setEnables({ kick: kickOn, snare: snareOn, hat: hatOn });
        drumsRef.current.setMetronome(metronomeOn);
        if (drumsOn || metronomeOn) drumsRef.current.start();
      }
      if (audioCtx && !looperRef.current) {
        const s = synthRef.current;
        // Loop tracks feed the master mix bus (so the master recorder captures
        // them); the "Instrument" tap reads the feedback-safe instrument bus.
        const out = s.getOutputBus() ?? audioCtx.destination;
        looperRef.current = new VocalLooper(audioCtx, out, (t, accent) =>
          s.triggerClick(t, accent)
        );
        const instr = s.getInstrumentBus();
        if (instr) looperRef.current.setInstrumentNode(instr);
        looperRef.current.setConfig({ bpm: arpBpm, bars: loopBars, free: loopFree });
        looperRef.current.setRecordSource(loopSource);
        if (!inputMeterRef.current) inputMeterRef.current = new InputMeter(audioCtx);
        looperRef.current.onChange = () => {
          const lp = looperRef.current;
          if (!lp) return;
          setLoopTracks(lp.getStates());
          setLoopRecording(lp.isRecording);
          setLoopPlaying(lp.isPlaying);
        };
      }
      for (const sm of smoothersRef.current) sm.setAmount(smoothing);

      setPhase("loading-model");
      landmarkerRef.current = await createHandLandmarker({
        numHands: 2,
        onStatus: setStatus,
      });

      setPhase("requesting-camera");
      setStatus("Requesting camera…");
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 1280, height: 720, facingMode: "user" },
          audio: false,
        });
      } catch (err) {
        setPhase("camera-denied");
        setErrorMsg(
          err instanceof Error ? err.message : "Camera permission denied."
        );
        return;
      }

      cameraStreamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();

      setPhase("running");
      setStatus("Tracking. Show a hand to the camera.");
      rafRef.current = requestAnimationFrame(loop);
    } catch (err) {
      setPhase("error");
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, [
    loop,
    volume,
    sound,
    arpPattern,
    arpDivision,
    arpBpm,
    arpOctaves,
    arpGate,
    drumPattern,
    kickOn,
    snareOn,
    hatOn,
    metronomeOn,
    drumsOn,
    smoothing,
    loopBars,
    loopFree,
    loopSource,
  ]);

  // Acquire the microphone once and route it into the synth's single shared mic
  // hub, so the harmonizer, looper and level meter all read ONE source node (only
  // one MediaStreamAudioSourceNode may exist per stream, or the recorder gets
  // silence).
  const getSharedMic = useCallback(async (): Promise<MediaStream> => {
    if (micStreamRef.current) return micStreamRef.current;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micStreamRef.current = stream;
    synthRef.current.setMicStream(stream);
    setMicReady(true);
    return stream;
  }, []);

  // Point the input meter at the node(s) the current source records from, so the
  // bar reflects exactly what a take would capture.
  const updateMeterInputs = useCallback((sel: RecordSource) => {
    const meter = inputMeterRef.current;
    if (!meter) return;
    const s = synthRef.current;
    const nodes: AudioNode[] = [];
    for (const kind of sourcesForSelection(sel)) {
      const node = kind === "mic" ? s.getMicNode() : s.getInstrumentBus();
      if (node) nodes.push(node);
    }
    meter.setInputs(nodes);
  }, []);

  // Choose the record source. For a source that needs the mic, request it up
  // front so the meter is live before recording; the shared hub means this never
  // conflicts with the harmonizer.
  const selectLoopSource = useCallback(
    async (sel: RecordSource) => {
      setLoopSource(sel);
      setLoopError("");
      if ((sel === "mic" || sel === "mix") && !micStreamRef.current) {
        try {
          await getSharedMic();
        } catch (err) {
          setLoopError(
            err instanceof Error
              ? `Microphone unavailable: ${err.message}`
              : "Microphone permission denied."
          );
        }
      }
      updateMeterInputs(sel);
    },
    [getSharedMic, updateMeterInputs]
  );

  // Keep the meter pointed at the right source as selection / mic availability
  // change (e.g. after the app starts or the mic is granted).
  useEffect(() => {
    if (phase !== "running") return;
    updateMeterInputs(loopSource);
  }, [phase, loopSource, micReady, updateMeterInputs]);

  // Toggle the harmonizer: request the mic on enable, build the graph, and feed
  // its output into the instrument bus so takes and loops capture the harmony.
  const toggleHarmonizer = useCallback(
    async (enable: boolean) => {
      setMicError("");
      const synth = synthRef.current;
      const audioCtx = synth.getContext();

      if (!enable) {
        setHarmonizerOn(false);
        const h = harmonizerRef.current;
        if (h) {
          h.stop();
          setTimeout(() => {
            h.dispose();
            harmonizerRef.current = null;
            // Leave the shared mic open; the looper may still be using it.
          }, 200);
        }
        return;
      }

      if (!audioCtx) {
        setMicError("Start the app (Enable camera & sound) first.");
        return;
      }

      try {
        await getSharedMic();
      } catch (err) {
        setHarmonizerOn(false);
        setMicError(
          err instanceof Error
            ? `Microphone unavailable: ${err.message}`
            : "Microphone permission denied."
        );
        return;
      }
      const micNode = synth.getMicNode();
      if (!micNode) {
        setHarmonizerOn(false);
        setMicError("Microphone unavailable.");
        return;
      }

      // Route the harmonizer into the instrument bus so it is part of the played
      // signal (captured by the master recorder and by "Instrument" loop takes).
      const out =
        synth.getInstrumentBus() ?? synth.getOutputBus() ?? audioCtx.destination;
      const harm = new Harmonizer(audioCtx, out, {
        maxVoices: harmonizerVoices,
        dryWet: harmonizerDryWet,
        outputLevel: harmonizerLevel,
      });
      // Read the SHARED mic hub, not a fresh source node, so the looper and the
      // level meter keep receiving the voice while the harmonizer is on.
      harm.connect(micNode);
      harm.start();
      harmonizerRef.current = harm;
      setHarmonizerOn(true);
    },
    [getSharedMic, harmonizerVoices, harmonizerDryWet, harmonizerLevel]
  );

  // Record a video of the performer plus the full audio mix (synths + drums +
  // effects + harmonizer + loops + the live voice) via MediaRecorder. The mic is
  // folded into the audio inside Synth.getRecordingStream(); here we add the
  // webcam video track so Record saves a shareable video of you over the backing
  // track. Falls back to audio-only if the camera is unavailable.
  const pickMime = (list: string[]): string => {
    for (const m of list) {
      if (
        typeof MediaRecorder !== "undefined" &&
        MediaRecorder.isTypeSupported(m)
      )
        return m;
    }
    return "";
  };

  const startRecording = useCallback(async () => {
    setRecordError("");
    const synth = synthRef.current;
    const audioStream = synth.getRecordingStream();
    if (!audioStream) {
      setRecordError("Start the app (Enable camera & sound) first.");
      return;
    }
    // Make sure the mic is live so the recording captures the voice, not just
    // the synths. Recording still proceeds (without voice) if it is denied.
    try {
      await getSharedMic();
    } catch {
      /* keep recording; the file just will not contain the voice */
    }

    const cam = cameraStreamRef.current;
    const videoTracks = cam ? cam.getVideoTracks() : [];
    const audioTracks = audioStream.getAudioTracks();
    const hasVideo = videoTracks.length > 0;
    const mixed = new MediaStream([...videoTracks, ...audioTracks]);

    const mimeType = hasVideo
      ? pickMime([
          "video/webm;codecs=vp9,opus",
          "video/webm;codecs=vp8,opus",
          "video/webm",
        ])
      : pickMime(["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]);

    try {
      const rec = mimeType
        ? new MediaRecorder(mixed, { mimeType })
        : new MediaRecorder(mixed);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, {
          type: rec.mimeType || (hasVideo ? "video/webm" : "audio/webm"),
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const stamp = new Date()
          .toISOString()
          .replace(/[:.]/g, "-")
          .slice(0, 19);
        a.href = url;
        a.download = `trackstar-${stamp}.webm`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
      rec.start();
      recorderRef.current = rec;
      recordStartRef.current = performance.now();
      setRecordElapsed(0);
      setRecording(true);
      recordTimerRef.current = setInterval(() => {
        setRecordElapsed(performance.now() - recordStartRef.current);
      }, 200);
    } catch (err) {
      setRecordError(
        err instanceof Error ? err.message : "Recording failed to start."
      );
    }
  }, [getSharedMic]);

  const stopRecording = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
    recorderRef.current = null;
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    setRecording(false);
  }, []);

  // --- Vocal looper handlers ---
  const downloadBytes = (bytes: ArrayBuffer, name: string) => {
    const blob = new Blob([bytes], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const stamp = () =>
    new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  const toggleLoopRecord = useCallback(async () => {
    setLoopError("");
    const lp = looperRef.current;
    if (!lp) {
      setLoopError("Start the app (Enable camera & sound) first.");
      return;
    }
    if (lp.isRecording) {
      lp.stopRecording();
      return;
    }
    // Ensure the mic for any source that needs it, then hand the looper the
    // SHARED mic hub node (not a fresh source node).
    if (loopSource === "mic" || loopSource === "mix") {
      try {
        await getSharedMic();
      } catch (err) {
        setLoopError(
          err instanceof Error
            ? `Microphone unavailable: ${err.message}`
            : "Microphone permission denied."
        );
        return;
      }
      const micNode = synthRef.current.getMicNode();
      if (micNode) lp.setMicNode(micNode);
    }
    lp.setConfig({ bpm: arpBpm, bars: loopBars, free: loopFree });
    lp.setRecordSource(loopSource);
    if (!lp.canRecord()) {
      setLoopError("Selected source is not available.");
      return;
    }
    updateMeterInputs(loopSource);
    lp.arm(loopCountIn ? 1 : 0);
  }, [loopSource, arpBpm, loopBars, loopFree, loopCountIn, getSharedMic, updateMeterInputs]);

  const downloadTake = useCallback((id: number) => {
    const lp = looperRef.current;
    const bytes = lp?.getTrackWav(id);
    if (bytes) downloadBytes(bytes, `handsynth-take-${id}-${stamp()}.wav`);
  }, []);

  const exportMix = useCallback(async () => {
    const lp = looperRef.current;
    if (!lp) return;
    setLoopError("");
    try {
      const bytes = await lp.exportMix(exportCycles);
      if (bytes) downloadBytes(bytes, `handsynth-loop-mix-${stamp()}.wav`);
      else setLoopError("Nothing to export yet.");
    } catch (err) {
      setLoopError(
        err instanceof Error ? err.message : "Export failed."
      );
    }
  }, [exportCycles]);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      arpRef.current?.stop();
      drumsRef.current?.stop();
      looperRef.current?.dispose();
      inputMeterRef.current?.dispose();
      inputMeterRef.current = null;
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        try {
          recorderRef.current.stop();
        } catch {
          /* ignore */
        }
      }
      harmonizerRef.current?.dispose();
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

  return (
    <div className="min-h-full mx-auto max-w-6xl px-4 py-6">
      <header className="mb-4">
        <div className="flex items-center gap-3">
          <Flower size={44} petal="#ff9f1c" center="#ffd400" className="shrink-0" />
          <div>
            <h1 className="text-4xl font-bold tracking-tight">
              hand<span className="text-yellow">synth</span>
            </h1>
            <p className="text-sm text-white/70">
              Play synth chords with your hands. Everything runs in your browser:
              no backend, no uploads.
            </p>
          </div>
          <Flower
            size={36}
            petal="#d000ff"
            center="#ffd400"
            className="ml-auto hidden shrink-0 sm:block"
          />
          <Flower
            size={28}
            petal="#8a12ff"
            center="#ff9f1c"
            className="hidden shrink-0 md:block"
          />
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* Stage */}
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
                      Grant camera access and enable sound to start. The camera
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
                {(phase === "loading-model" ||
                  phase === "requesting-camera") && (
                  <div className="flex flex-col items-center gap-3">
                    <div className="h-8 w-8 animate-spin rounded-full border-2 border-purple/40 border-t-yellow" />
                    <p className="text-white/90">{status}</p>
                  </div>
                )}
                {phase === "camera-denied" && (
                  <div className="flex max-w-sm flex-col items-center gap-3">
                    <p className="font-semibold text-orange">
                      Camera unavailable
                    </p>
                    <p className="text-sm text-white/70">{errorMsg}</p>
                    <p className="text-xs text-white/55">
                      Check the browser camera permission (and that a webcam is
                      connected), then try again.
                    </p>
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
                    <p className="font-semibold text-orange">
                      Something went wrong
                    </p>
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
                  Now playing{" "}
                  {arpOn && <span className="text-orange">· arp</span>}
                  {latchOn && <span className="text-yellow"> · latch</span>}
                  {drumsOn && <span className="text-orange"> · drums</span>}
                  {harmonizerOn && (
                    <span className="text-magenta"> · harmonizer</span>
                  )}
                </div>
                <div className="text-2xl font-semibold">
                  {selection?.chord ? (
                    <>
                      {selection.chord.name}{" "}
                      <span className="text-yellow">
                        ({selection.chord.label})
                      </span>
                    </>
                  ) : (
                    <span className="text-white/55">(rest)</span>
                  )}
                </div>
              </div>
              <div className="text-right text-sm text-white/70">
                {mode === "diatonic" ? (
                  <div>Key: {keyName({ tonic, scale, octave })}</div>
                ) : (
                  <div>Progression mode</div>
                )}
                {selection && !selection.rest && (
                  <div>
                    {mode === "progression"
                      ? `slot ${selection.degree + 1}`
                      : `inv ${selection.inversion}`}
                  </div>
                )}
              </div>
            </div>
            <div className="mt-2 font-mono text-sm text-white/90">
              {selection?.chord
                ? selection.chord.notes.map(midiToName).join("  ·  ")
                : " "}
            </div>
          </div>
        </div>

        {/* Controls + legend */}
        <aside className="flex flex-col gap-4">
          {/* Mode switch */}
          <section className="rounded-2xl border border-magenta/30 bg-purple/15 p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/70">
              Mode
            </h2>
            <div className="grid grid-cols-2 gap-2 text-sm">
              {(
                [
                  ["diatonic", "Key (diatonic)"],
                  ["progression", "Progression (custom)"],
                ] as [PlayMode, string][]
              ).map(([m, label]) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`rounded-lg px-3 py-2 font-medium transition ${
                    mode === m
                      ? "bg-yellow text-ink"
                      : "bg-purple/25 text-white/90 hover:bg-magenta/40"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {mode === "progression" && (
              <div className="mt-3">
                <label className="mb-1 block text-sm text-white/70">
                  Chord sequence (space/comma separated)
                </label>
                <input
                  type="text"
                  value={progressionText}
                  onChange={(e) => setProgressionText(e.target.value)}
                  placeholder="Am E F C"
                  className="w-full rounded-lg border border-purple/50 bg-purple/25 px-2 py-1.5 font-mono"
                />
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {progressionSlots.map((s, i) => (
                    <span
                      key={`${s.symbol}-${i}`}
                      title={
                        s.chord
                          ? s.chord.name
                          : `"${s.symbol}" is not a recognized chord`
                      }
                      className={`rounded-md px-2 py-1 text-xs font-mono ${
                        s.chord
                          ? "bg-purple/25 text-white"
                          : "bg-magenta/25 text-orange line-through"
                      }`}
                    >
                      {i + 1}. {s.symbol}
                    </span>
                  ))}
                  {progressionSlots.length === 0 && (
                    <span className="text-xs text-white/55">
                      Type chords like <code>Am E F C</code>.
                    </span>
                  )}
                </div>
                <p className="mt-2 text-xs text-white/55">
                  Fingers 1-5 pick slots 1-5. Enable two-hand mode and hold your
                  left hand open to reach slots 6-10. Quality comes from the
                  typed symbol, so the Triad/6th/7th control is disabled here.
                </p>
              </div>
            )}
          </section>

          {/* Musical controls */}
          <section className="rounded-2xl border border-magenta/30 bg-purple/15 p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/70">
              Performance
            </h2>

            {mode === "diatonic" && (
              <>
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
              </>
            )}

            <label className="mb-3 block text-sm">
              <span className="mb-1 block text-white/70">
                Base octave: {octave}
              </span>
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

            {/* Chord extension (diatonic only) */}
            <div className="mb-3 text-sm">
              <span className="mb-1 block text-white/70">
                Chord extension
                {mode === "progression" && (
                  <span className="ml-1 text-xs text-white/40">
                    (from symbols)
                  </span>
                )}
              </span>
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
                    disabled={mode === "progression"}
                    onClick={() => setExtension(ext)}
                    className={`rounded-lg px-2 py-1.5 font-medium transition ${
                      mode === "progression"
                        ? "cursor-not-allowed bg-purple/10 text-white/40"
                        : extension === ext
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

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={twoHand}
                onChange={(e) => setTwoHand(e.target.checked)}
              />
              Two-hand mode{" "}
              <span className="text-xs text-white/55">
                {mode === "diatonic"
                  ? "(left open = vi/vii)"
                  : "(left = slots 6 to 10)"}
              </span>
            </label>
          </section>

          {/* Record */}
          <section className="rounded-2xl border border-magenta/30 bg-purple/15 p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-white/70">
                Record
              </h2>
              <div className="flex items-center gap-3">
                {recording && (
                  <span className="flex items-center gap-1.5 text-sm text-orange">
                    <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-orange" />
                    {formatElapsed(recordElapsed)}
                  </span>
                )}
                <button
                  onClick={recording ? stopRecording : startRecording}
                  disabled={!started}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                    !started
                      ? "cursor-not-allowed bg-purple/25 text-white/40"
                      : recording
                        ? "bg-orange text-ink hover:bg-yellow"
                        : "bg-magenta text-ink hover:bg-magenta/80"
                  }`}
                >
                  {recording ? "Stop & download" : "Record video"}
                </button>
              </div>
            </div>
            <p className="mt-2 text-xs text-white/55">
              Records a video of you with the full mix (synth, drums, effects,
              harmonizer, loops and your voice) and downloads a timestamped .webm
              file. Stack vocals in the Looper below while recording.
            </p>
            {!started && (
              <p className="mt-1 text-xs text-white/40">
                Enable camera &amp; sound first.
              </p>
            )}
            {recordError && (
              <p className="mt-1 text-xs text-orange">{recordError}</p>
            )}
          </section>

          {/* Playability */}
          <section className="rounded-2xl border border-magenta/30 bg-purple/15 p-4">
            <details>
              <summary className="cursor-pointer list-none text-sm font-semibold uppercase tracking-wide text-white/70">
                Playability
              </summary>
              <div className="mt-3">
                <Range
                  label="Smoothing / sensitivity"
                  value={smoothing}
                  min={0}
                  max={1}
                  step={0.01}
                  fmt={(v) =>
                    v <= 0 ? "off" : `${(v * 100).toFixed(0)}%`
                  }
                  onChange={setSmoothing}
                />
                <p className="mb-3 text-xs text-white/55">
                  One-Euro filter on the hand landmarks. Higher smooths jitter;
                  lower is more responsive.
                </p>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={latchOn}
                    onChange={(e) => setLatchOn(e.target.checked)}
                  />
                  Chord latch
                </label>
                <p className="mt-1 text-xs text-white/55">
                  Hold the last chord hands-free until a new chord is played or
                  latch is turned off. The arpeggiator keeps running on it.
                </p>
              </div>
            </details>
          </section>

          {/* Sound design */}
          <section className="rounded-2xl border border-magenta/30 bg-purple/15 p-4">
            <details open>
              <summary className="cursor-pointer list-none text-sm font-semibold uppercase tracking-wide text-white/70">
                Sound design
              </summary>

              <div className="mt-3">
                <label className="mb-3 block text-sm">
                  <span className="mb-1 block text-white/70">Mode</span>
                  <select
                    value={presetName}
                    onChange={(e) => selectPreset(e.target.value)}
                    className="w-full rounded-lg border border-purple/50 bg-purple/25 px-2 py-1.5"
                  >
                    {!PRESET_NAMES.includes(presetName) && (
                      <option value={presetName}>custom</option>
                    )}
                    {PRESET_NAMES.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>

                {/* Oscillator */}
                <div className="mb-3 rounded-lg border border-magenta/30 p-2">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/55">
                    Oscillator
                  </div>
                  <label className="mb-2 block text-sm">
                    <span className="mb-1 block text-white/70">Waveform</span>
                    <select
                      value={sound.waveform}
                      onChange={(e) =>
                        updateSound((s) => {
                          s.waveform = e.target.value as Waveform;
                        })
                      }
                      className="w-full rounded-lg border border-purple/50 bg-purple/25 px-2 py-1.5"
                    >
                      <option value="sine">sine</option>
                      <option value="sawtooth">sawtooth</option>
                      <option value="square">square</option>
                      <option value="triangle">triangle</option>
                    </select>
                  </label>
                  <Range
                    label="Unison voices"
                    value={sound.unison}
                    min={1}
                    max={7}
                    step={1}
                    onChange={(v) => updateSound((s) => (s.unison = v))}
                  />
                  <Range
                    label="Detune"
                    value={sound.detune}
                    min={0}
                    max={50}
                    step={1}
                    fmt={(v) => `${v} cents`}
                    onChange={(v) => updateSound((s) => (s.detune = v))}
                  />
                  <Range
                    label="Sub oscillator"
                    value={sound.subLevel}
                    min={0}
                    max={1}
                    step={0.01}
                    fmt={(v) => `${(v * 100).toFixed(0)}%`}
                    onChange={(v) => updateSound((s) => (s.subLevel = v))}
                  />
                </div>

                {/* Amp envelope */}
                <div className="mb-3 rounded-lg border border-magenta/30 p-2">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/55">
                    Amp envelope
                  </div>
                  <Range
                    label="Attack"
                    value={sound.env.attack}
                    min={0.001}
                    max={2}
                    step={0.001}
                    fmt={(v) => `${v.toFixed(3)} s`}
                    onChange={(v) => updateSound((s) => (s.env.attack = v))}
                  />
                  <Range
                    label="Decay"
                    value={sound.env.decay}
                    min={0}
                    max={2}
                    step={0.01}
                    fmt={(v) => `${v.toFixed(2)} s`}
                    onChange={(v) => updateSound((s) => (s.env.decay = v))}
                  />
                  <Range
                    label="Sustain"
                    value={sound.env.sustain}
                    min={0}
                    max={1}
                    step={0.01}
                    fmt={(v) => `${(v * 100).toFixed(0)}%`}
                    onChange={(v) => updateSound((s) => (s.env.sustain = v))}
                  />
                  <Range
                    label="Release"
                    value={sound.env.release}
                    min={0.01}
                    max={3}
                    step={0.01}
                    fmt={(v) => `${v.toFixed(2)} s`}
                    onChange={(v) => updateSound((s) => (s.env.release = v))}
                  />
                </div>

                {/* Filter */}
                <div className="mb-3 rounded-lg border border-magenta/30 p-2">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/55">
                    Filter{" "}
                    <span className="normal-case text-white/40">
                      (cutoff = hand height)
                    </span>
                  </div>
                  <Range
                    label="Resonance"
                    value={sound.resonance}
                    min={0.1}
                    max={20}
                    step={0.1}
                    fmt={(v) => v.toFixed(1)}
                    onChange={(v) => updateSound((s) => (s.resonance = v))}
                  />
                  <Range
                    label="Envelope amount"
                    value={sound.filterEnvAmount}
                    min={0}
                    max={1}
                    step={0.01}
                    fmt={(v) => `${(v * 100).toFixed(0)}%`}
                    onChange={(v) =>
                      updateSound((s) => (s.filterEnvAmount = v))
                    }
                  />
                </div>

                {/* LFO */}
                <div className="mb-3 rounded-lg border border-magenta/30 p-2">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/55">
                    LFO
                  </div>
                  <label className="mb-2 block text-sm">
                    <span className="mb-1 block text-white/70">Target</span>
                    <select
                      value={sound.lfo.target}
                      onChange={(e) =>
                        updateSound(
                          (s) => (s.lfo.target = e.target.value as LfoTarget)
                        )
                      }
                      className="w-full rounded-lg border border-purple/50 bg-purple/25 px-2 py-1.5"
                    >
                      <option value="off">off</option>
                      <option value="pitch">pitch (vibrato)</option>
                      <option value="filter">filter (wobble)</option>
                      <option value="amp">amp (tremolo)</option>
                    </select>
                  </label>
                  <Range
                    label="Rate"
                    value={sound.lfo.rate}
                    min={0.1}
                    max={12}
                    step={0.1}
                    fmt={(v) => `${v.toFixed(1)} Hz`}
                    disabled={sound.lfo.target === "off"}
                    onChange={(v) => updateSound((s) => (s.lfo.rate = v))}
                  />
                  <Range
                    label="Depth"
                    value={sound.lfo.depth}
                    min={0}
                    max={1}
                    step={0.01}
                    fmt={(v) => `${(v * 100).toFixed(0)}%`}
                    disabled={sound.lfo.target === "off"}
                    onChange={(v) => updateSound((s) => (s.lfo.depth = v))}
                  />
                </div>

                {/* Effects */}
                <div className="rounded-lg border border-magenta/30 p-2">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/55">
                    Effects
                  </div>

                  {/* Reverb */}
                  <label className="mb-1 flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={sound.fx.reverb.on}
                      onChange={(e) =>
                        updateSound((s) => (s.fx.reverb.on = e.target.checked))
                      }
                    />
                    Reverb
                  </label>
                  <Range
                    label="Amount"
                    value={sound.fx.reverb.amount}
                    min={0}
                    max={1}
                    step={0.01}
                    fmt={(v) => `${(v * 100).toFixed(0)}%`}
                    disabled={!sound.fx.reverb.on}
                    onChange={(v) =>
                      updateSound((s) => (s.fx.reverb.amount = v))
                    }
                  />

                  {/* Delay */}
                  <label className="mb-1 mt-3 flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={sound.fx.delay.on}
                      onChange={(e) =>
                        updateSound((s) => (s.fx.delay.on = e.target.checked))
                      }
                    />
                    Delay / echo
                  </label>
                  <Range
                    label="Time"
                    value={sound.fx.delay.time}
                    min={0.02}
                    max={1}
                    step={0.01}
                    fmt={(v) => `${(v * 1000).toFixed(0)} ms`}
                    disabled={!sound.fx.delay.on}
                    onChange={(v) => updateSound((s) => (s.fx.delay.time = v))}
                  />
                  <Range
                    label="Feedback"
                    value={sound.fx.delay.feedback}
                    min={0}
                    max={0.9}
                    step={0.01}
                    fmt={(v) => `${(v * 100).toFixed(0)}%`}
                    disabled={!sound.fx.delay.on}
                    onChange={(v) =>
                      updateSound((s) => (s.fx.delay.feedback = v))
                    }
                  />
                  <Range
                    label="Mix"
                    value={sound.fx.delay.mix}
                    min={0}
                    max={1}
                    step={0.01}
                    fmt={(v) => `${(v * 100).toFixed(0)}%`}
                    disabled={!sound.fx.delay.on}
                    onChange={(v) => updateSound((s) => (s.fx.delay.mix = v))}
                  />

                  {/* Distortion */}
                  <label className="mb-1 mt-3 flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={sound.fx.distortion.on}
                      onChange={(e) =>
                        updateSound(
                          (s) => (s.fx.distortion.on = e.target.checked)
                        )
                      }
                    />
                    Distortion / drive
                  </label>
                  <Range
                    label="Amount"
                    value={sound.fx.distortion.amount}
                    min={0}
                    max={1}
                    step={0.01}
                    fmt={(v) => `${(v * 100).toFixed(0)}%`}
                    disabled={!sound.fx.distortion.on}
                    onChange={(v) =>
                      updateSound((s) => (s.fx.distortion.amount = v))
                    }
                  />

                  {/* Chorus */}
                  <label className="mb-1 mt-3 flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={sound.fx.chorus.on}
                      onChange={(e) =>
                        updateSound((s) => (s.fx.chorus.on = e.target.checked))
                      }
                    />
                    Chorus
                  </label>
                  <Range
                    label="Amount"
                    value={sound.fx.chorus.amount}
                    min={0}
                    max={1}
                    step={0.01}
                    fmt={(v) => `${(v * 100).toFixed(0)}%`}
                    disabled={!sound.fx.chorus.on}
                    onChange={(v) =>
                      updateSound((s) => (s.fx.chorus.amount = v))
                    }
                  />
                </div>
              </div>
            </details>
          </section>

          {/* Arpeggiator */}
          <section className="rounded-2xl border border-magenta/30 bg-purple/15 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-white/70">
                Arpeggiator
              </h2>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={arpOn}
                  onChange={(e) => setArpOn(e.target.checked)}
                />
                On
              </label>
            </div>

            {/* Shared transport tempo (drives arp + drums + metronome). */}
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

            <div className={arpOn ? "" : "opacity-50"}>
              <div className="mb-3 text-sm">
                <span className="mb-1 block text-white/70">Pattern</span>
                <div className="grid grid-cols-4 gap-1.5">
                  {(
                    [
                      ["up", "Up"],
                      ["down", "Down"],
                      ["updown", "Up-Dn"],
                      ["random", "Rand"],
                    ] as [ArpPattern, string][]
                  ).map(([p, label]) => (
                    <button
                      key={p}
                      disabled={!arpOn}
                      onClick={() => setArpPattern(p)}
                      className={`rounded-md px-1.5 py-1 text-xs font-medium transition ${
                        arpPattern === p
                          ? "bg-orange text-ink"
                          : "bg-purple/25 text-white/90 hover:bg-magenta/40"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <label className="mb-3 block text-sm">
                <span className="mb-1 block text-white/70">Rate</span>
                <select
                  disabled={!arpOn}
                  value={arpDivision}
                  onChange={(e) =>
                    setArpDivision(e.target.value as ArpDivision)
                  }
                  className="w-full rounded-lg border border-purple/50 bg-purple/25 px-2 py-1.5"
                >
                  <option value="1/4">1/4</option>
                  <option value="1/8">1/8</option>
                  <option value="1/16">1/16</option>
                  <option value="1/8T">1/8 triplet</option>
                  <option value="1/16T">1/16 triplet</option>
                </select>
              </label>

              <label className="mb-3 block text-sm">
                <span className="mb-1 block text-white/70">
                  Octave range: {arpOctaves}
                </span>
                <input
                  type="range"
                  min={1}
                  max={3}
                  step={1}
                  disabled={!arpOn}
                  value={arpOctaves}
                  onChange={(e) => setArpOctaves(Number(e.target.value))}
                  className="w-full"
                />
              </label>

              <label className="block text-sm">
                <span className="mb-1 block text-white/70">
                  Gate (note length): {(arpGate * 100).toFixed(0)}%
                </span>
                <input
                  type="range"
                  min={0.05}
                  max={1}
                  step={0.05}
                  disabled={!arpOn}
                  value={arpGate}
                  onChange={(e) => setArpGate(Number(e.target.value))}
                  className="w-full"
                />
              </label>
            </div>
          </section>

          {/* Drums + metronome */}
          <section className="rounded-2xl border border-magenta/30 bg-purple/15 p-4">
            <details>
              <summary className="cursor-pointer list-none text-sm font-semibold uppercase tracking-wide text-white/70">
                Drums &amp; metronome
              </summary>
              <div className="mt-3">
                <div className="mb-3 flex items-center gap-4 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={drumsOn}
                      onChange={(e) => setDrumsOn(e.target.checked)}
                    />
                    Drums on
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={metronomeOn}
                      onChange={(e) => setMetronomeOn(e.target.checked)}
                    />
                    Metronome
                  </label>
                </div>

                <label className="mb-3 block text-sm">
                  <span className="mb-1 block text-white/70">Pattern</span>
                  <select
                    value={drumPattern}
                    onChange={(e) =>
                      setDrumPattern(e.target.value as DrumPatternName)
                    }
                    className="w-full rounded-lg border border-purple/50 bg-purple/25 px-2 py-1.5"
                  >
                    {DRUM_PATTERN_NAMES.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/55">
                  Instruments
                </div>
                <div className="flex flex-wrap gap-4 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={kickOn}
                      onChange={(e) => setKickOn(e.target.checked)}
                    />
                    Kick
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={snareOn}
                      onChange={(e) => setSnareOn(e.target.checked)}
                    />
                    Snare
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={hatOn}
                      onChange={(e) => setHatOn(e.target.checked)}
                    />
                    Hi-hat
                  </label>
                </div>

                <p className="mt-3 text-xs text-white/55">
                  Shares the tempo with the arpeggiator (set BPM in the
                  Arpeggiator panel). Metronome accents beat 1.
                </p>
              </div>
            </details>
          </section>

          {/* Vocal harmonizer */}
          <section className="rounded-2xl border border-magenta/30 bg-purple/15 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-white/70">
                Harmonizer
              </h2>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={harmonizerOn}
                  disabled={!started}
                  onChange={(e) => toggleHarmonizer(e.target.checked)}
                />
                On
              </label>
            </div>
            <p className="text-xs text-white/55">
              Sing into your mic and hold a chord with a gesture: your voice is
              copied onto every tone of that chord. Sing a note and hold C major
              to hear yourself at C, E and G.
            </p>
            {!started && (
              <p className="mt-2 text-xs text-white/40">
                Enable camera &amp; sound first.
              </p>
            )}
            {micError && (
              <p className="mt-2 text-xs text-orange">{micError}</p>
            )}

            {/* Live detected-pitch readout so you can see your voice arriving. */}
            <div className="mt-3 flex items-center justify-between rounded-md bg-purple/25 px-2 py-1.5 text-sm">
              <span className="text-white/70">Detected pitch</span>
              <span className="font-mono text-yellow">
                {harmonizerOn && sungPitch
                  ? `${freqToNoteLabel(sungPitch)} · ${sungPitch.toFixed(0)} Hz`
                  : harmonizerOn
                    ? "listening…"
                    : "off"}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-white/45">
              The input level meter in the Looper panel shows your mic level.
              Pick the Instrument or Mix loop source to record the harmony.
            </p>

            <label className={`mt-3 block text-sm ${harmonizerOn ? "" : "opacity-50"}`}>
              <span className="mb-1 block text-white/70">
                Dry / wet: {(harmonizerDryWet * 100).toFixed(0)}%
                <span className="ml-1 text-xs text-white/40">
                  (voice → harmonies)
                </span>
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                disabled={!harmonizerOn}
                value={harmonizerDryWet}
                onChange={(e) => setHarmonizerDryWet(Number(e.target.value))}
                className="w-full"
              />
            </label>

            <label className={`mt-2 block text-sm ${harmonizerOn ? "" : "opacity-50"}`}>
              <span className="mb-1 block text-white/70">
                Output level: {(harmonizerLevel * 100).toFixed(0)}%
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                disabled={!harmonizerOn}
                value={harmonizerLevel}
                onChange={(e) => setHarmonizerLevel(Number(e.target.value))}
                className="w-full"
              />
            </label>

            <label className="mt-2 block text-sm">
              <span className="mb-1 block text-white/70">
                Voices: {harmonizerVoices}
                <span className="ml-1 text-xs text-white/40">
                  (max chord tones)
                </span>
              </span>
              <input
                type="range"
                min={1}
                max={4}
                step={1}
                value={harmonizerVoices}
                onChange={(e) => setHarmonizerVoices(Number(e.target.value))}
                className="w-full"
              />
            </label>

            <p className="mt-3 text-[11px] text-white/45">
              Real-time pitch shifting in the browser has some latency and
              artifacts; aim for a recognizable harmony, not a studio effect.
            </p>
          </section>

          {/* Vocal looper */}
          <section className="rounded-2xl border border-magenta/30 bg-purple/15 p-4">
            <details>
              <summary className="cursor-pointer list-none text-sm font-semibold uppercase tracking-wide text-white/70">
                Looper{" "}
                <span className="text-white/40">({loopTracks.length})</span>
                {loopRecording && (
                  <span className="text-orange"> recording</span>
                )}
              </summary>

              <div className="mt-3">
                {/* Source */}
                <div className="mb-3 text-sm">
                  <span className="mb-1 block text-white/70">Source</span>
                  <div className="grid grid-cols-3 gap-1.5">
                    {(
                      [
                        ["mic", "Mic"],
                        ["instrument", "Instrument"],
                        ["mix", "Mix"],
                      ] as [RecordSource, string][]
                    ).map(([s, label]) => (
                      <button
                        key={s}
                        onClick={() => selectLoopSource(s)}
                        className={`rounded-md px-2 py-1 text-xs font-medium transition ${
                          loopSource === s
                            ? "bg-yellow text-ink"
                            : "bg-purple/25 text-white/90 hover:bg-magenta/40"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Live input level meter for the selected source */}
                <InputLevelMeter
                  meter={inputMeterRef}
                  active={started}
                  label={
                    loopSource === "mic"
                      ? "Mic"
                      : loopSource === "mix"
                        ? "Mix"
                        : "Instrument"
                  }
                  unavailable={
                    (loopSource === "mic" || loopSource === "mix") && !micReady
                      ? "Microphone not available yet. Pick Mic or Mix to allow it, or check your browser permission."
                      : null
                  }
                />

                {/* Loop length */}
                <div className="mb-3 text-sm">
                  <span className="mb-1 block text-white/70">Loop length</span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {[1, 2, 4, 8].map((b) => (
                      <button
                        key={b}
                        disabled={loopFree}
                        onClick={() => setLoopBars(b)}
                        className={`rounded-md px-2 py-1 text-xs font-medium transition ${
                          loopFree
                            ? "cursor-not-allowed bg-purple/10 text-white/30"
                            : loopBars === b
                              ? "bg-magenta text-ink"
                              : "bg-purple/25 text-white/90 hover:bg-magenta/40"
                        }`}
                      >
                        {b} {b === 1 ? "bar" : "bars"}
                      </button>
                    ))}
                    <label className="ml-1 flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={loopFree}
                        onChange={(e) => setLoopFree(e.target.checked)}
                      />
                      Free
                    </label>
                  </div>
                  <label className="mt-2 flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={loopCountIn}
                      onChange={(e) => setLoopCountIn(e.target.checked)}
                    />
                    Count-in (1 bar)
                  </label>
                </div>

                {/* Transport */}
                <div className="mb-3 flex flex-wrap gap-2">
                  <button
                    onClick={toggleLoopRecord}
                    disabled={!started}
                    className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                      !started
                        ? "cursor-not-allowed bg-purple/25 text-white/40"
                        : loopRecording
                          ? "bg-orange text-ink hover:bg-yellow"
                          : "bg-magenta text-ink hover:bg-magenta/80"
                    }`}
                  >
                    {loopRecording ? "Stop take" : "Record take"}
                  </button>
                  <button
                    onClick={() =>
                      loopPlaying
                        ? looperRef.current?.stopAll()
                        : looperRef.current?.playAll()
                    }
                    disabled={loopTracks.length === 0}
                    className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                      loopTracks.length === 0
                        ? "cursor-not-allowed bg-purple/25 text-white/40"
                        : "bg-purple/45 text-white hover:bg-magenta/40"
                    }`}
                  >
                    {loopPlaying ? "Stop all" : "Play all"}
                  </button>
                  <button
                    onClick={() => looperRef.current?.clearAll()}
                    disabled={loopTracks.length === 0}
                    className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                      loopTracks.length === 0
                        ? "cursor-not-allowed bg-purple/25 text-white/40"
                        : "bg-purple/45 text-white hover:bg-magenta/40"
                    }`}
                  >
                    Clear all
                  </button>
                </div>

                {/* Track list */}
                {loopTracks.length === 0 ? (
                  <p className="text-xs text-white/55">
                    No loops yet. Record a take to start a stack, then record
                    more takes on top to build harmonies.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {loopTracks.map((t) => (
                      <li
                        key={t.id}
                        className="rounded-lg border border-magenta/20 bg-purple/10 p-2"
                      >
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-white/90">
                            {t.name}{" "}
                            <span className="text-xs text-white/40">
                              ({t.source})
                            </span>
                          </span>
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() =>
                                looperRef.current?.setMute(t.id, !t.muted)
                              }
                              className={`rounded px-2 py-0.5 text-xs font-medium ${
                                t.muted
                                  ? "bg-orange text-ink"
                                  : "bg-purple/25 text-white/80 hover:bg-magenta/40"
                              }`}
                            >
                              M
                            </button>
                            <button
                              onClick={() =>
                                looperRef.current?.setSolo(t.id, !t.solo)
                              }
                              className={`rounded px-2 py-0.5 text-xs font-medium ${
                                t.solo
                                  ? "bg-yellow text-ink"
                                  : "bg-purple/25 text-white/80 hover:bg-magenta/40"
                              }`}
                            >
                              S
                            </button>
                            <button
                              onClick={() => downloadTake(t.id)}
                              className="rounded bg-purple/25 px-2 py-0.5 text-xs text-white/80 hover:bg-magenta/40"
                              title="Download this take"
                            >
                              Save
                            </button>
                            <button
                              onClick={() => looperRef.current?.deleteTrack(t.id)}
                              className="rounded bg-purple/25 px-2 py-0.5 text-xs text-white/80 hover:bg-magenta/40"
                              title="Delete this take"
                            >
                              Del
                            </button>
                          </div>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.01}
                          value={t.volume}
                          onChange={(e) =>
                            looperRef.current?.setVolume(
                              t.id,
                              Number(e.target.value)
                            )
                          }
                          className="mt-1 w-full"
                        />
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
                    disabled={loopTracks.length === 0}
                    className={`rounded-lg px-3 py-1 text-sm font-medium transition ${
                      loopTracks.length === 0
                        ? "cursor-not-allowed bg-purple/25 text-white/40"
                        : "bg-yellow text-ink hover:bg-orange"
                    }`}
                  >
                    Export mix
                  </button>
                </div>

                {!started && (
                  <p className="mt-2 text-xs text-white/40">
                    Enable camera &amp; sound first.
                  </p>
                )}
                <p className="mt-2 text-xs text-white/55">
                  Mic and Mix takes need a real microphone. Loops lock to the
                  shared transport BPM and route through the master recorder.
                </p>
                {loopError && (
                  <p className="mt-1 text-xs text-orange">{loopError}</p>
                )}
              </div>
            </details>
          </section>

          <Legend mode={mode} twoHand={twoHand} />
        </aside>
      </div>

      <footer className="mt-8 text-xs text-white/40">
        Best in Chrome/Edge. Camera requires HTTPS or localhost. Hand tracking:
        MediaPipe Tasks Vision · Audio: Web Audio API.
      </footer>
    </div>
  );
}
