import { mkdirSync, writeFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Vite empties dist/ on every build. The Go binary embeds dist/ and needs the
// directory to exist even before the UI has been built, so keep a placeholder.
const keepPlaceholder = {
  name: "keep-dist-placeholder",
  closeBundle() {
    mkdirSync("dist", { recursive: true });
    writeFileSync("dist/.gitkeep", "");
  },
};

export default defineConfig({
  plugins: [react(), keepPlaceholder],
  server: {
    // `npm run dev` proxies API calls to a locally running dprocess server.
    proxy: { "/api": "http://127.0.0.1:8080" },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/test/setup.ts"],
  },
});
