// Fetch the hand_landmarker.task model into public/models so it ships with the
// static build (no runtime dependency on Google's model host). Non-fatal: if
// the download fails (offline install), the app falls back to the CDN model.
import { mkdir, writeFile, access, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const dest = resolve(root, "public/models/hand_landmarker.task");
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

async function alreadyPresent() {
  try {
    await access(dest);
    const s = await stat(dest);
    return s.size > 1000; // sanity: real model is ~7MB
  } catch {
    return false;
  }
}

async function main() {
  if (await alreadyPresent()) {
    console.log("[fetch-model] hand_landmarker.task already present, skipping.");
    return;
  }
  await mkdir(dirname(dest), { recursive: true });
  console.log(`[fetch-model] downloading model from ${MODEL_URL}`);
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  console.log(`[fetch-model] saved ${buf.length} bytes -> ${dest}`);
}

main().catch((err) => {
  console.warn(
    "[fetch-model] could not download model:",
    err.message,
    "\n  The app will fall back to the CDN model at runtime."
  );
});
