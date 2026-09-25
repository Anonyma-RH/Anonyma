import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  build: {
    outDir: "dist/client",
    // The walkthrough's Three.js/Lottie chunk is lazy-loaded and knowingly large.
    chunkSizeWarningLimit: 900,
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "127.0.0.1",
    port: 5175,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:3001",
      "/v1": "http://127.0.0.1:3001",
      "/health": "http://127.0.0.1:3001",
      "/llms": "http://127.0.0.1:3001",
      "/cli.mjs": "http://127.0.0.1:3001",
      "/install.sh": "http://127.0.0.1:3001",
      "/install.ps1": "http://127.0.0.1:3001",
      // Live Preview's sandboxed frame page and its headers come from the API.
      "/preview-frame.html": "http://127.0.0.1:3001",
    },
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react()],
});
