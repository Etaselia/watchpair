import vinext from "vinext";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

// vinext builds the App Router RSC server bundle into dist/server/index.js.
// Previously the Cloudflare plugin's wrangler "main" config made that bundle
// resolve to worker/index.ts (the universal server entry that adds the
// /api/health and /api/sessions routes and then passes through to vinext's
// handler). With the Cloudflare plugin gone the RSC environment's input must
// be declared explicitly. This plugin is registered after vinext() so its
// config hook merges last and wins over vinext's default
// virtual:vinext-rsc-entry input.
function workerServerEntry(): Plugin {
  return {
    name: "watchpair:worker-server-entry",
    config() {
      return {
        environments: {
          rsc: {
            build: {
              rollupOptions: {
                input: { index: "./worker/index.ts" },
              },
            },
          },
        },
      };
    },
  };
}

export default defineConfig({
  server: isCodexSeatbeltSandbox
    ? { watch: { useFsEvents: false, usePolling: true } }
    : undefined,
  plugins: [vinext(), workerServerEntry()],
});
