# Trackstar

Trackstar is a hand-gesture instrument and AI music studio in one web app. It fuses two projects
behind a single top-level mode toggle:

- **Simple mode** is the full handsynth instrument: play synth chords with
  webcam hand gestures. Everything runs in the browser, no backend, no uploads.
- **Producer mode** keeps the hand instrument live but feeds it into a
  multitrack mixer, and adds AI producer features powered by the deejai Python
  backend (natural-language commands like "add a lofi beat").

Simple mode and the Producer studio (record and import loops, persistent
projects, volume/pan/mute/solo, play-all, and export) work with **no backend
and no keys**. Producer mode's AI
features are the only part that needs the deejai backend running.

## Quick start

```bash
npm install
npm run dev
```

Open the printed local URL (for example http://localhost:5173). `npm install`
also vendors the MediaPipe hand-tracking WASM and model into `public/` via the
postinstall scripts; if that download is skipped (offline install), the app
falls back to the MediaPipe CDN at runtime.

Build and test:

```bash
npm run build   # tsc -b + vite build, zero TS errors
npm test        # vitest, 166 tests
```

### Deploy

Import this directory into Vercel or Netlify. Both hosts are configured to
build and serve `dist/` as an SPA. Set `VITE_DEEJAI_URL` in the host's build
environment to the HTTPS origin of a deployed deejai backend; without it, all
non-AI instrument and mixer features continue to work.

## The two modes

### Simple mode

The handsynth experience, unchanged: gestures map to chords/scales, with sound
design, arpeggiator, drums, vocoder and a vocal looper. Grant camera access and
enable sound to start; the camera feed never leaves your device.

> Note: Simple mode is a **copy of handsynth** (its `src/lib`, `Legend.tsx`,
> `index.css`, `public/` assets, WASM/model scripts and config were copied into
> Trackstar verbatim, with the top-level `App` component rendered here as
> `SimpleMode`). Future changes in the original handsynth project would need to
> be re-synced into Trackstar by hand. This keeps the mature instrument isolated
> from Producer-mode changes while both run in one application.

### Producer mode (the new work)

- **Persistent projects.** The studio autosaves decoded audio and mixer state
  to IndexedDB, restores it after sound is enabled, and preserves the project
  name, BPM, bar length, volume, pan, mute, and solo settings.
- **Live instrument -> mixer.** The same hand instrument plays live. Record its
  output (or your mic) into the mixer as loop tracks. Each track has volume,
  pan, mute and solo, plus rename, duplicate, download, and deletion. Existing
  WAV/MP3/M4A/AAC/OGG/FLAC files can be decoded and imported. Play-all starts
  every track from one shared anchor; Export bounces the mix to stereo WAV.
- **AI producer (deejai).** Type a natural-language command ("add a lofi beat",
  "add a warm pad backing in C", "add a trap beat"). Trackstar runs it against a
  deejai session, fetches the returned stem WAVs, decodes them into
  AudioBuffers, and drops the backing stems (beat / pad / bass / arp) into the
  same mixer alongside your loops. It shows deejai's messages and the detected
  tempo / key / beat style.

## Shared-AudioContext design

Producer mode uses **one AudioContext** (the handsynth `Synth`'s context) for
everything: the live instrument, the recorded loop tracks, and the deejai stem
tracks. The mixer (`src/lib/producerMixer.ts`) taps the synth's instrument bus
to record loops, and adds decoded deejai stems as `AudioBufferSourceNode ->
gain -> stereoPanner -> master bus`. Because loops and AI stems live in the same
context and start on the same transport anchor, they play together and export
together. Simple mode and Producer mode each own their context; only one mode is
mounted at a time, and switching modes releases the other's camera and audio.

The mute/solo mix math is reused from the handsynth looper (`effectiveGain`),
and the transport-length / boundary helpers are reused too, so the mixer only
adds pan, stem tracks and stereo export on top of proven logic.

## deejai backend (for Producer AI features)

The AI features talk to the deejai FastAPI backend (the offline Python audio
engine wrapped in a REST API). Trackstar does not modify deejai.

Start it from the deejai project directory (deps: numpy, scipy, soundfile,
pyloudnorm, fastapi, uvicorn):

```bash
python3 -m uvicorn app.server:app --port 8000
```

### How Trackstar reaches it (CORS / proxy)

- In dev, the Vite dev server proxies browser calls from `/deejai/...` to
  `http://localhost:8000` (see `vite.config.ts`), so there is no CORS setup.
- The client base URL is configurable with `VITE_DEEJAI_URL` (see
  `.env.example`). Leave it unset to use the `/deejai` dev proxy, or set it to a
  backend origin, e.g. `VITE_DEEJAI_URL=http://localhost:8000`.

### Graceful degradation

If the backend is unreachable, the AI panel shows a clear "Start the deejai
backend to enable AI features" message with the exact `uvicorn` command and a
Retry button. The instrument, mixer and export keep working fully without it.

## Feature status

Fully working:

- Top-level Simple / Producer mode toggle.
- Simple mode: the complete handsynth instrument.
- Producer mixer: record live instrument (or mic) loops; import existing audio;
  rename, duplicate, download, and delete tracks; volume, pan, mute, solo;
  play-all / stop-all; confirmation-protected clear.
- IndexedDB project autosave and restore, with corruption and quota failure
  recovery that leaves the live studio usable.
- Export: stereo WAV bounce of the whole mix (with pan) for N cycles.
- deejai integration: create/reuse a session, run NL commands, fetch + decode
  stems, add backing stems (beat / pad / bass / arp) to the mixer; show
  messages and tempo / key / beat style.
- Graceful degradation when the backend is down.

Deployment boundaries:

- Producer mode ships a **compact** instrument control set (key, scale, octave,
  chord extension, sound preset, volume, shared tempo, two-hand, latch, arp,
  drums). The full sound-design / vocoder / effects panels live in Simple mode.
- deejai integration auto-adds the AI backing stems (beat / pad
  / bass / arp). The demo vocal takes the engine balances are intentionally not
  imported as tracks (your own loops are the "takes"). Upload / align / lead /
  bundle endpoints remain backend capabilities and are not exposed here.
- Loops and stems start together on one anchor. Loops of different lengths (and
  a long stem vs short loops) share the start but are not resampled to a common
  bar length; set the instrument tempo to the project BPM for the tightest sync.
- Browser-local project storage does not sync across devices. Multi-device
  accounts, sharing, collaboration, and server-side project backups require a
  production identity/database/object-storage backend.
- Simple mode is a maintained copy of handsynth (see the note above).

## Project layout

```
src/
  App.tsx              top-level mode toggle + header
  SimpleMode.tsx       handsynth, verbatim (rendered as Simple mode)
  ProducerMode.tsx     live instrument + mixer + AI panel
  Legend.tsx           handsynth legend (Simple mode)
  index.css            handsynth styles
  lib/
    (handsynth libs)   music, gestures, mapping, synth, drums, arp, vocoder,
                       vocalLooper, presets, smoothing, handLandmarker, draw
    producerMixer.ts   NEW: multitrack mixer (loops + deejai stems, pan, export)
    deejai.ts          NEW: deejai REST client (URLs, session, command, stems)
    *.test.ts          unit tests (incl. producerMixer.test.ts, deejai.test.ts)
public/                MediaPipe WASM + hand model (vendored at install)
```

## Tech

Vite + React + TypeScript (strict) + Tailwind. Hand tracking: MediaPipe Tasks
Vision. Audio: Web Audio API. AI producer: deejai FastAPI backend. Best in
Chrome / Edge; the camera requires HTTPS or localhost.
