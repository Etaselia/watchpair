/**
 * Universal server entry for WatchPair.
 *
 * Bundled into dist/server/index.js by `vinext build` (see vite.config.ts,
 * which points the RSC environment's input at this file) and served by the
 * Node production server in scripts/start-container.mjs. Handles the
 * coordinator's own endpoints and passes everything else to vinext's App
 * Router handler.
 */
import handler from "vinext/server/app-router-entry";
import { handleSessionApi } from "./session-api";

interface Env {
  WATCHPAIR_ICE_SERVERS?: string;
  /**
   * Never provided by the self-hosted Node runtime. Declared so this env is
   * structurally compatible with vinext's App Router handler, which accepts
   * an optional Cloudflare-style ASSETS binding and only reads it when set.
   */
  ASSETS?: never;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, service: "watchpair" });
    }

    if (url.pathname === "/api/sessions") {
      return handleSessionApi(request, env);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
