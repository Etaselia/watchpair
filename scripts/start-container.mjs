import { createServer, request as requestUpstream } from "node:http";
import { readdirSync } from "node:fs";
import path from "node:path";
import { startProdServer } from "vinext/server/prod-server";
import {
  isStaticChunkModule,
  staticChunkRecoveryModule,
} from "../lib/static-asset-recovery.mjs";

const port = Number.parseInt(process.env.PORT || "3000", 10);
const externalPort = Number.isFinite(port) ? port : 3000;
const staticChunksDirectory = path.resolve("dist/client/_next/static/chunks");
const emittedStaticChunkModules = new Set(
  readdirSync(staticChunksDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => `/_next/static/chunks/${entry.name}`),
);
const upstream = await startProdServer({
  port: 0,
  host: "127.0.0.1",
  outDir: path.resolve("dist"),
  silent: true,
});

const server = createServer((request, response) => {
  const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
  const recoverableModule =
    (request.method === "GET" || request.method === "HEAD") &&
    isStaticChunkModule(pathname) &&
    !emittedStaticChunkModules.has(pathname);

  if (recoverableModule) {
    const source = staticChunkRecoveryModule();
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(source),
      "content-type": "text/javascript; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-watchpair-recovery": "stale-static-module",
    });
    response.end(request.method === "HEAD" ? undefined : source);
    return;
  }

  const upstreamRequest = requestUpstream({
    host: "127.0.0.1",
    port: upstream.port,
    path: request.url,
    method: request.method,
    headers: request.headers,
  }, (upstreamResponse) => {
    const headers = { ...upstreamResponse.headers };
    const missingStaticAsset =
      (upstreamResponse.statusCode || 500) >= 400 && pathname.startsWith("/_next/static/");
    if (missingStaticAsset) headers["cache-control"] = "no-store";
    if (pathname.startsWith("/_next/static/") && pathname.endsWith(".wasm")) {
      headers["content-type"] = "application/wasm";
    }
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.statusMessage, headers);
    upstreamResponse.pipe(response);
  });

  upstreamRequest.on("error", (error) => {
    console.error("[watchpair] Upstream request failed:", error);
    if (!response.headersSent) response.writeHead(502);
    response.end("Bad Gateway");
  });
  request.pipe(upstreamRequest);
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(externalPort, "0.0.0.0", resolve);
});

const shutdown = () => {
  server.close(() => upstream.server.close());
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log(`[watchpair] Production server running at http://0.0.0.0:${externalPort}`);
