// handLandmarker.ts - initialize MediaPipe HandLandmarker in VIDEO mode.
//
// Deploy wiring:
//  - WASM fileset is vendored into public/wasm at install time by
//    scripts/copy-wasm.mjs (copied from the installed @mediapipe/tasks-vision
//    package). Loaded from `${BASE_URL}wasm`.
//  - The model file public/models/hand_landmarker.task is fetched at install
//    time by scripts/fetch-model.mjs.
//  - If the local assets are missing (e.g. a bare `git clone` with no
//    postinstall), we fall back to the jsDelivr CDN so the app still runs.

import {
  FilesetResolver,
  HandLandmarker,
  type HandLandmarkerResult,
} from "@mediapipe/tasks-vision";

export type { HandLandmarkerResult };

const CDN_WASM =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const CDN_MODEL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

const base = import.meta.env.BASE_URL || "/";
const LOCAL_WASM = `${base}wasm`;
const LOCAL_MODEL = `${base}models/hand_landmarker.task`;

async function headOk(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

export interface LandmarkerInit {
  numHands?: number;
  onStatus?: (msg: string) => void;
}

/**
 * Create a HandLandmarker. Prefers vendored local assets, falls back to CDN.
 * Throws if neither source can be loaded.
 */
export async function createHandLandmarker(
  opts: LandmarkerInit = {}
): Promise<HandLandmarker> {
  const { numHands = 2, onStatus } = opts;

  const localModelOk = await headOk(LOCAL_MODEL);
  const wasmPath = (await headOk(`${LOCAL_WASM}/vision_wasm_internal.js`))
    ? LOCAL_WASM
    : CDN_WASM;
  const modelPath = localModelOk ? LOCAL_MODEL : CDN_MODEL;

  onStatus?.(
    `Loading vision runtime (${wasmPath === LOCAL_WASM ? "local" : "CDN"})…`
  );
  const fileset = await FilesetResolver.forVisionTasks(wasmPath);

  onStatus?.(
    `Loading hand model (${modelPath === LOCAL_MODEL ? "local" : "CDN"})…`
  );
  const landmarker = await HandLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: modelPath,
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numHands,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

  onStatus?.("Hand tracker ready.");
  return landmarker;
}
