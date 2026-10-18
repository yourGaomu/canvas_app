import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 4173,
    proxy: {
      "/api": { target: "https://mikasa.icu", changeOrigin: true, secure: true },
      "/v1": { target: "https://mikasa.icu", changeOrigin: true, secure: true },
      "/v1beta": { target: "https://mikasa.icu", changeOrigin: true, secure: true },
      "/kling": { target: "https://mikasa.icu", changeOrigin: true, secure: true },
      "/jimeng": { target: "https://mikasa.icu", changeOrigin: true, secure: true },
    },
  },
  build: { target: "es2022" },
});
