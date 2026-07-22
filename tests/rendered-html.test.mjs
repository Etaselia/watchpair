import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { after, before, test } from "node:test";

const port = 3199;
let server;
let serverOutput = "";

before(async () => {
  server = spawn(
    process.execPath,
    ["node_modules/vinext/dist/cli.js", "start", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: new URL("../", import.meta.url),
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`Production server exited early.\n${serverOutput}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Production server did not become ready.\n${serverOutput}`);
});

after(() => {
  server?.kill("SIGTERM");
});

test("production-renders the WatchPair application", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>WatchPair \| Watch in sync<\/title>/i);
  assert.match(html, /WatchPair/);
  assert.match(html, /Same frame/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("production session API supports join-in-progress state", async () => {
  const createdResponse = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "create", deviceId: "test-host", name: "Host" }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.match(created.session.token, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  const joinedResponse = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "join",
      token: created.session.token,
      deviceId: "test-guest",
      name: "Guest",
    }),
  });
  assert.equal(joinedResponse.status, 200);

  const snapshotResponse = await fetch(
    `http://127.0.0.1:${port}/api/sessions?token=${created.session.token}`,
  );
  assert.equal(snapshotResponse.status, 200);
  const snapshot = await snapshotResponse.json();
  assert.equal(snapshot.session.participants.length, 2);
});

test("ships the coordination and companion surfaces", async () => {
  const [app, route, agent, media, packageJson] = await Promise.all([
    readFile(new URL("../app/watch-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../worker/session-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../agent/server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../lib/media.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(app, /Watch together/);
  assert.match(app, /getAgentDownload/);
  assert.match(app, /subtitleOffset/);
  assert.match(route, /action === "heartbeat"/);
  assert.match(route, /action === "player"/);
  assert.match(route, /action === "select-media"/);
  assert.match(agent, /new WebTorrent/);
  assert.match(agent, /content-range/);
  assert.match(media, /fingerprintFile/);
  assert.match(packageJson, /"agent": "node agent\/server\.mjs"/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
});
