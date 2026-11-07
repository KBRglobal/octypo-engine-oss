import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Served by the engine at /admin (express.static + SPA fallback)
export default defineConfig({
  base: "/admin/",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../dist-admin",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
