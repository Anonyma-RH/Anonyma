import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  build: {
    outDir: "dist/client",
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
    },
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react()],
});
