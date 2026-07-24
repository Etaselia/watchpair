import { createServer, request as requestUpstream } from "node:http";
import path from "node:path";
import { startProdServer } from "vinext/server/prod-server";

const port = Number.parseInt(process.env.PORT || "3000", 10);
const externalPort = Number.isFinite(port) ? port : 3000;
const upstream = await startProdServer({
  port: 0,
  host: "127.0.0.1",
  outDir: path.resolve("dist"),
  silent: true,
});

const server = createServer((request, response) => {
  const upstreamRequest = requestUpstream({
    host: "127.0.0.1",
    port: upstream.port,
    path: request.url,
    method: request.method,
    headers: request.headers,
  }, (upstreamResponse) => {
    const headers = { ...upstreamResponse.headers };
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
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
