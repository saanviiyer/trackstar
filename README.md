# Trackstar

Trackstar is a hand-gesture instrument and an AI music studio in one web app. You play synth chords with webcam hand gestures, record loops into a multitrack mixer, and can add AI backing stems from the deejai backend.

A toggle at the top switches between two modes. Only one mode is mounted at a time. Switching modes releases the camera and audio of the other mode.

## Features

### Simple mode

Simple mode is the full handsynth instrument. Gestures map to chords and scales. It includes sound design, an arpeggiator, drums, bass, a vocoder, and a vocal looper. The continuous-stack mode captures 2, 3, 4, or 6 phase-locked vocal passes hands-free and stops by itself. Grant camera access and enable sound to start. Everything runs in the browser. The camera feed never leaves your device.

Simple mode is a copy of handsynth. Its `src/lib`, `Legend.tsx`, `index.css`, `public/` assets, WASM and model scripts, and config were copied without changes. Its `App` component renders here as `SimpleMode`. Changes in the original handsynth project must be copied into Trackstar by hand.

### Producer mode

- Persistent projects. The studio autosaves decoded audio and mixer state to IndexedDB and restores it after you enable sound. It keeps the project name, BPM, bar length, and each track's volume, pan, mute, and solo.
- Live instrument into the mixer. Record the hand instrument (or your mic) as loop tracks. You can rename, duplicate, download, or delete each track. You can also import WAV, MP3, M4A, AAC, OGG, or FLAC files. Play-all starts every track from one shared anchor. Export writes the mix to a stereo WAV.
- Rhythm section. Build one-to-four-bar patterns in a six-voice drum grid (kick, snare, clap, hi-hat, tom, shaker). Write a key-aware monophonic bassline in the piano roll. Arrange a four-to-sixteen-bar track by turning drums and bass on or off per bar. Genre, bassline, and song-form presets give editable starting points. The composition autosaves.
- Vocal Stack recorder. Pick a tight double, wide triple, four-part harmony, or six-take choir, and sing through the loop. Each pass becomes a named, phase-locked take with automatic stereo placement. Recording stops at the selected take count. The stack works like a take folder with group mute, solo, and clear.
- Editing. Timeline regions keep their colors. Clip moves and trims can snap to beats or bars, or snap can be off. Each track has a nondestructive tone control that saved projects and exports keep. A per-track Space send feeds a shared stereo room, and live playback and exported WAVs use the same ambience. Mixer actions have 40 steps of undo and redo. Space, R, M, Escape, and Cmd/Ctrl+Z work as shortcuts outside text fields. You can star vocal takes as comp picks and play them together.
- AI producer (deejai). Type a command such as "add a lofi beat" or "add a warm pad backing in C". Trackstar sends it to a deejai session, fetches the returned stem WAVs, decodes them, and adds the backing stems (beat, pad, bass, arp) to the mixer. It shows deejai's messages and the detected tempo, key, and beat style.

Simple mode and the Producer studio work with no backend and no keys. Only the AI producer needs deejai.

## How it works

Producer mode uses one AudioContext (the handsynth `Synth` context) for the live instrument, the recorded loops, and the deejai stems. The mixer in `src/lib/producerMixer.ts` taps the synth's instrument bus to record loops. It plays decoded stems through `AudioBufferSourceNode -> gain -> stereoPanner -> master bus`. Loops and stems share one context and one transport anchor, so they play and export together. The mute and solo math (`effectiveGain`) and the transport-length helpers come from the handsynth looper.

## Limits

- Producer mode has a compact instrument control set: key, scale, octave, chord extension, sound preset, volume, shared tempo, two-hand, latch, arp, and drums. The full sound-design, vocoder, and effects panels are in Simple mode only.
- Trackstar adds only the AI backing stems. It does not import the demo vocal takes that the engine balances. Your own loops are the takes. The deejai upload, align, lead, and bundle endpoints are not exposed here.
- Loops and stems start on one anchor. Loops of different lengths share the start but are not resampled to a common bar length. For the tightest sync, set the instrument tempo to the project BPM.
- Project storage is local to the browser and does not sync across devices. Accounts, sharing, collaboration, and server backups would need a production identity, database, and object-storage backend.
- IndexedDB autosave recovers from corrupt data and quota errors, and the studio stays usable.

## Run it

```bash
git clone https://github.com/saanviiyer/trackstar
cd trackstar
npm install
npm run dev        # open the printed URL, for example http://localhost:5173
```

`npm install` runs postinstall scripts that copy the MediaPipe hand-tracking WASM and model into `public/`. If that download does not happen (offline install), the app loads them from the MediaPipe CDN at runtime.

```bash
npm run build      # tsc -b, then vite build
npm test           # vitest, 291 tests
npm run test:watch
```

Use Chrome or Edge for best results. The camera needs HTTPS or localhost.

### deejai backend (AI features only)

The AI producer talks to the deejai FastAPI backend, an offline Python audio engine with a REST API. Trackstar does not modify deejai. Start it from the deejai project folder (needs numpy, scipy, soundfile, pyloudnorm, fastapi, and uvicorn):

```bash
python3 -m uvicorn app.server:app --port 8000
```

In development, the Vite dev server proxies `/deejai/...` to `http://localhost:8000` (see `vite.config.ts`), so you need no CORS setup. If the backend does not respond, the AI panel shows the `uvicorn` command and a Retry button. The instrument, mixer, and export keep working.

### Deploy

Import the repo into Vercel or Netlify. Both configs build and serve `dist/` as a single-page app. Set `VITE_DEEJAI_URL` in the host's build settings to the HTTPS origin of a deployed deejai backend. Without it, all features except the AI producer still work.

## Environment variables

| Name | Purpose | Required |
| ---- | ------- | -------- |
| `VITE_DEEJAI_URL` | Base URL of the deejai backend. If unset, the app uses the `/deejai` dev proxy. | Optional |

## Layout

```
src/
  App.tsx              mode toggle and header
  SimpleMode.tsx       handsynth app, rendered as Simple mode
  ProducerMode.tsx     live instrument, mixer, and AI panel
  BeatSequencer.tsx, BassSequencer.tsx, TrackArranger.tsx, Timeline.tsx
  Legend.tsx, index.css   handsynth legend and styles
  lib/
    producerMixer.ts   multitrack mixer (loops, stems, pan, export)
    deejai.ts          deejai REST client
    projectStore.ts    IndexedDB project save and restore
    *.ts               handsynth and rhythm libraries (music, gestures, synth, drums, bass, vocalLooper, ...)
    *.test.ts          unit tests
scripts/               copy-wasm.mjs, fetch-model.mjs (run on install)
public/                MediaPipe WASM and hand model (added at install)
```

Stack: Vite, React, TypeScript (strict), and Tailwind. Hand tracking uses MediaPipe Tasks Vision. Audio uses the Web Audio API.
