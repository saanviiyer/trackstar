import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Client-only SPA. MediaPipe WASM lives in public/wasm (copied at install time
// by scripts/copy-wasm.mjs) and the hand model in public/models.
//
// Producer mode's AI features talk to the deejai FastAPI backend. To avoid CORS
// in dev, browser calls to "/deejai/..." are proxied to the local backend. The
// client uses VITE_DEEJAI_URL if set, otherwise the "/deejai" proxy path.
const DEEJAI_TARGET = "http://localhost:8000";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    target: "es2020",
  },
  server: {
    proxy: {
      "/deejai": {
        target: DEEJAI_TARGET,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/deejai/, ""),
      },
    },
  },
});
