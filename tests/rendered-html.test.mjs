import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { strFromU8, unzipSync } from "fflate";

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

  const playerResponse = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "player",
      token: created.session.token,
      deviceId: "test-host",
      name: "Host",
      player: {
        paused: false,
        position: 42,
        playbackRate: 1,
        audioLanguage: "embedded:3",
        subtitleLanguage: "embedded:4",
        subtitleOffset: 250,
      },
    }),
  });
  assert.equal(playerResponse.status, 200);

  const selectedResponse = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "select-media",
      token: created.session.token,
      deviceId: "test-host",
      name: "Host",
      media: { name: "episode-2.mkv", size: 2048, fingerprint: "episode-2" },
    }),
  });
  assert.equal(selectedResponse.status, 200);
  const selected = await selectedResponse.json();
  assert.equal(selected.session.player.position, 0);
  assert.equal(selected.session.player.audioLanguage, "original");
  assert.equal(selected.session.player.subtitleLanguage, "off");

  const snapshotResponse = await fetch(
    `http://127.0.0.1:${port}/api/sessions?token=${created.session.token}`,
  );
  assert.equal(snapshotResponse.status, 200);
  const snapshot = await snapshotResponse.json();
  assert.equal(snapshot.session.participants.length, 2);
  assert.deepEqual(
    snapshot.session.participants.map((participant) => participant.deviceId),
    ["test-host", "test-guest"],
  );
});

test("ships the coordination and companion surfaces", async () => {
  const [app, route, agent, agentClient, media, packageJson, layout] = await Promise.all([
    readFile(new URL("../app/watch-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../worker/session-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../agent/server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../lib/agent-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/media.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(app, /Watch together/);
  assert.match(app, /action: "create",\s+deviceId,\s+name: displayName/);
  assert.match(app, /getAgentDownload/);
  assert.match(app, /subtitleOffset/);
  assert.match(app, /autoOpenedMediaRef/);
  assert.match(app, /window\.setInterval\(keepAlive, 8_000\)/);
  assert.match(app, /scheduleControlsHide/);
  assert.match(app, /Caption options/);
  assert.match(app, /Background opacity/);
  assert.match(app, /Character edge/);
  assert.match(app, /applySession/);
  assert.match(app, /Preparing video for this browser/);
  assert.match(app, /HlsRuntime\.isSupported/);
  assert.match(app, /AUDIO_TRACKS_UPDATED/);
  assert.match(route, /action === "heartbeat"/);
  assert.match(route, /action === "player"/);
  assert.match(route, /action === "select-media"/);
  assert.match(route, /stableParticipants/);
  assert.match(agent, /new WebTorrent/);
  assert.match(agent, /content-range/);
  assert.match(agent, /audioTracks/);
  assert.match(agent, /renderAudioPlayback/);
  assert.match(agentClient, /loopback-network/);
  assert.match(agentClient, /getAgentPermissionState/);
  assert.match(media, /fingerprintFile/);
  assert.match(packageJson, /"agent": "node agent\/server\.mjs"/);
  assert.doesNotMatch(layout, /next\/font/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
});

test("packages the pairable magnet and subtitle companion", async () => {
  const archive = unzipSync(
    new Uint8Array(await readFile(new URL("../public/watchpair-companion.zip", import.meta.url))),
  );
  const expected = [
    "WatchPair Companion/server.mjs",
    "WatchPair Companion/hls-playback.mjs",
    "WatchPair Companion/torrent-input.mjs",
    "WatchPair Companion/webtorrent-safety.mjs",
    "WatchPair Companion/package.json",
    "WatchPair Companion/install-and-start.cmd",
    "WatchPair Companion/install-runtime.ps1",
    "WatchPair Companion/pnpm-lock.yaml",
    "WatchPair Companion/pnpm-workspace.yaml",
  ];
  for (const path of expected) assert.ok(archive[path], `Missing ${path}`);

  const bundledAgent = strFromU8(archive["WatchPair Companion/server.mjs"]);
  const bundledHls = strFromU8(archive["WatchPair Companion/hls-playback.mjs"]);
  const bundledSafetyGuard = strFromU8(archive["WatchPair Companion/webtorrent-safety.mjs"]);
  const companionPackage = strFromU8(archive["WatchPair Companion/package.json"]);
  const installer = strFromU8(archive["WatchPair Companion/install-runtime.ps1"]);
  const windowsLauncher = strFromU8(archive["WatchPair Companion/install-and-start.cmd"]);
  const buildPolicy = strFromU8(archive["WatchPair Companion/pnpm-workspace.yaml"]);
  assert.match(bundledAgent, /url\.pathname === "\/pair"/);
  assert.match(bundledAgent, /url\.pathname === "\/resolve"/);
  assert.match(bundledAgent, /FFPROBE_PATH/);
  assert.match(bundledAgent, /subtitleFile/);
  assert.match(bundledAgent, /createHlsPlaybackManager/);
  assert.match(bundledAgent, /window\.close/);
  assert.match(bundledHls, /hls_playlist_type/);
  assert.match(bundledHls, /watchpair-audio/);
  assert.match(bundledAgent, /installWebTorrentSafetyGuards/);
  assert.match(bundledSafetyGuard, /const piece = this\.pieces\?\.\[index\]/);
  assert.match(bundledSafetyGuard, /stabilizeWireBitfieldWrites/);
  assert.match(bundledSafetyGuard, /new Uint8Array\(bytes\)/);
  assert.match(bundledSafetyGuard, /verifiedTorrentFileProgress/);
  assert.match(companionPackage, /"webtorrent": "3\.0\.11"/);
  assert.match(installer, /\$Releases = Invoke-RestMethod/);
  assert.match(installer, /\$Release = \(\$Releases \| Where-Object/);
  assert.match(installer, /\$Version = \[string\]\$Release\.version/);
  assert.match(installer, /win-x64-zip/);
  assert.match(installer, /SHASUMS256\.txt" -OutFile \$ChecksumFile/);
  assert.match(windowsLauncher, /corepack\.cmd" pnpm install --prod --frozen-lockfile/);
  assert.match(buildPolicy, /allowBuilds:/);
  assert.match(buildPolicy, /node-datachannel: true/);
});
