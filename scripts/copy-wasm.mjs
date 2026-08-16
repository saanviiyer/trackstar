// Copy the MediaPipe tasks-vision WASM fileset into public/wasm so the app can
// load it locally (no CDN dependency) and it ships with the static build.
import { cp, mkdir, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const src = resolve(root, "node_modules/@mediapipe/tasks-vision/wasm");
const dest = resolve(root, "public/wasm");

async function main() {
  try {
    await access(src);
  } catch {
    console.warn(
      "[copy-wasm] @mediapipe/tasks-vision/wasm not found (skipping). " +
        "The app will fall back to the CDN at runtime."
    );
    return;
  }
  await mkdir(dest, { recursive: true });
  await cp(src, dest, { recursive: true });
  console.log(`[copy-wasm] copied WASM fileset -> ${dest}`);
}

main().catch((err) => {
  console.warn("[copy-wasm] failed:", err.message);
  // Non-fatal: runtime CDN fallback exists.
});
