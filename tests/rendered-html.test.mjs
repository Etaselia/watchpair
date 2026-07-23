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

test("production health endpoint reports readiness", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: "watchpair" });
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

  const voicePresenceResponse = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "heartbeat",
      token: created.session.token,
      deviceId: "test-guest",
      name: "Guest",
      readiness: {
        status: "idle",
        progress: 0,
        queue: {},
        voice: { enabled: true, muted: false, deafened: false },
      },
    }),
  });
  assert.equal(voicePresenceResponse.status, 200);

  const voiceSignalResponse = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "voice-signal",
      token: created.session.token,
      deviceId: "test-host",
      name: "Host",
      signal: {
        toId: "test-guest",
        type: "offer",
        data: JSON.stringify({ type: "offer", sdp: "test-room-voice-sdp" }),
      },
    }),
  });
  assert.equal(voiceSignalResponse.status, 200);

  const hostVoiceSnapshot = await fetch(
    `http://127.0.0.1:${port}/api/sessions?token=${created.session.token}&deviceId=test-host`,
  ).then((response) => response.json());
  assert.equal(hostVoiceSnapshot.session.voiceSignals.length, 0);

  const guestVoiceSnapshot = await fetch(
    `http://127.0.0.1:${port}/api/sessions?token=${created.session.token}&deviceId=test-guest`,
  ).then((response) => response.json());
  assert.equal(guestVoiceSnapshot.session.voiceSignals.length, 1);
  assert.equal(guestVoiceSnapshot.session.voiceSignals[0].fromId, "test-host");
  assert.equal(guestVoiceSnapshot.session.voiceSignals[0].type, "offer");
  assert.equal(
    guestVoiceSnapshot.session.participants.find((participant) => participant.deviceId === "test-guest").voice.enabled,
    true,
  );
  assert.match(guestVoiceSnapshot.session.voice.iceServers[0].urls[0], /^stun:/);

  const queuedSources = [
    { id: "source-episode-one", kind: "magnet", value: "magnet:?xt=urn:btih:1111111111111111111111111111111111111111", label: "Episode 1" },
    { id: "source-episode-two", kind: "magnet", value: "magnet:?xt=urn:btih:2222222222222222222222222222222222222222", label: "Episode 2" },
  ];
  let queueSession;
  for (const source of queuedSources) {
    const sourceResponse = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "source",
        token: created.session.token,
        deviceId: "test-host",
        name: "Host",
        source,
      }),
    });
    assert.equal(sourceResponse.status, 200);
    queueSession = (await sourceResponse.json()).session;
  }
  assert.equal(queueSession.sources.length, 2);
  assert.deepEqual(queueSession.sources.map((source) => source.label), ["Episode 1", "Episode 2"]);
  assert.deepEqual(queueSession.sources.map((source) => source.id), ["source-episode-one", "source-episode-two"]);

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
      media: {
        sourceId: queueSession.sources[1].id,
        fileIndex: 0,
        name: "episode-2.mkv",
        size: 2048,
        fingerprint: "episode-2",
      },
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
  assert.equal(snapshot.session.sources.length, 2);
  assert.equal(snapshot.session.source.id, queueSession.sources[1].id);
  assert.equal(snapshot.session.selectedMedia.sourceId, queueSession.sources[1].id);
  assert.deepEqual(
    snapshot.session.participants.map((participant) => participant.deviceId),
    ["test-host", "test-guest"],
  );

  const mutate = async (action, values) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action,
        token: created.session.token,
        deviceId: "test-host",
        name: "Host",
        ...values,
      }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).session;
  };

  const renamed = await mutate("rename-source", {
    sourceId: "source-episode-one",
    label: "Pilot",
  });
  assert.equal(renamed.sources[0].label, "Pilot");

  const reordered = await mutate("reorder-sources", {
    sourceIds: ["source-episode-two", "source-episode-one"],
  });
  assert.deepEqual(reordered.sources.map((source) => source.id), ["source-episode-two", "source-episode-one"]);

  const removed = await mutate("remove-source", { sourceId: "source-episode-one" });
  assert.deepEqual(removed.sources.map((source) => source.id), ["source-episode-two"]);

  const cleared = await mutate("remove-source", { sourceId: "source-episode-two" });
  assert.equal(cleared.selectedMedia, null);
  assert.equal(cleared.sources.length, 0);
});

test("ships the coordination and companion surfaces", async () => {
  const [app, voice, route, agent, agentClient, media, packageJson, layout] = await Promise.all([
    readFile(new URL("../app/watch-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/room-voice.tsx", import.meta.url), "utf8"),
    readFile(new URL("../worker/session-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../agent/server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../lib/agent-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/media.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(app, /Watch together/);
  assert.match(app, /action: "create",\s+deviceId,\s+name: displayName/);
  assert.match(app, /getAgentDownloads/);
  assert.match(app, /Download queue/);
  assert.match(app, /const COMPANION_VERSION = "\d+\.\d+\.\d+"; \/\/ x-release-please-version/);
  assert.match(app, /watchpair-companion\.zip\?v=\$\{COMPANION_VERSION\}/);
  assert.match(app, /queueReadinessForJob/);
  assert.match(app, /file\.ready && \(preparation === "ready" \|\| preparation === "direct"\)/);
  assert.match(app, /GPU decode/);
  assert.match(app, /uploadAndSeedAgentFile/);
  assert.match(app, /Seeding \/ waiting for peers/);
  assert.match(app, /downloadMode === "automatic"/);
  assert.match(app, /synchronizePlayback/);
  assert.match(app, /5_000/);
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
  assert.match(voice, /new RTCPeerConnection/);
  assert.match(voice, /echoCancellation: true/);
  assert.match(voice, /noiseSuppression/);
  assert.match(voice, /autoGainControl: true/);
  assert.match(voice, /voiceIsolation/);
  assert.match(voice, /setSinkId/);
  assert.match(voice, /HeadphoneOff/);
  assert.match(voice, /Minimize2/);
  assert.match(voice, /Maximize2/);
  assert.match(voice, /setMasterVolume/);
  assert.match(voice, /setParticipantVolume/);
  assert.match(voice, /speakingUntilRef/);
  assert.match(voice, /playVoiceCue\("connect"\)/);
  assert.match(voice, /playVoiceCue\("disconnect"\)/);
  assert.match(route, /action === "heartbeat"/);
  assert.match(route, /action === "voice-signal"/);
  assert.match(route, /watch_voice_signals/);
  assert.match(route, /action === "player"/);
  assert.match(route, /action === "select-media"/);
  assert.match(route, /action === "remove-source"/);
  assert.match(route, /action === "reorder-sources"/);
  assert.match(route, /action === "rename-source"/);
  assert.match(route, /normalizeSources/);
  assert.match(route, /stableParticipants/);
  assert.match(agent, /new WebTorrent/);
  assert.match(agent, /content-range/);
  assert.match(agent, /audioTracks/);
  assert.match(agent, /renderAudioPlayback/);
  assert.match(agent, /receiveImportChunk/);
  assert.match(agent, /seedLocalFile/);
  assert.match(agent, /DEFAULT_TRACKERS/);
  assert.match(agent, /WATCHPAIR_TORRENT_PORT/);
  assert.match(agent, /seedOutgoingConnections: true/);
  assert.match(agent, /tracker\?\.update\(\{ numwant: 50 \}\)/);
  assert.match(agent, /torrentFileName/);
  assert.match(agent, /torrent\.once\("ready", \(\) => markServing\(torrent\)\)/);
  assert.match(agent, /restoreJobs/);
  assert.match(agentClient, /loopback-network/);
  assert.match(agentClient, /getAgentDownloads/);
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
    "WatchPair Companion/hardware-acceleration.mjs",
    "WatchPair Companion/job-store.mjs",
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
  const bundledHardware = strFromU8(archive["WatchPair Companion/hardware-acceleration.mjs"]);
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
  assert.match(bundledHls, /videoEncoderArguments/);
  assert.match(bundledHls, /DEFAULT_PLAYABLE_SECONDS = 120/);
  assert.match(bundledHardware, /h264_nvenc/);
  assert.match(bundledHardware, /h264_qsv/);
  assert.match(bundledHardware, /h264_vaapi/);
  assert.match(bundledHardware, /h264_amf/);
  assert.match(bundledHardware, /testEncoder/);
  assert.match(bundledAgent, /queueBackgroundPreparation/);
  assert.match(bundledAgent, /pipeResponseStream/);
  assert.match(bundledAgent, /TRANSCODER/);
  assert.match(bundledAgent, /installWebTorrentSafetyGuards/);
  assert.match(bundledSafetyGuard, /const piece = this\.pieces\?\.\[index\]/);
  assert.match(bundledSafetyGuard, /stabilizeWireBitfieldWrites/);
  assert.match(bundledSafetyGuard, /new Uint8Array\(bytes\)/);
  assert.match(bundledSafetyGuard, /verifiedTorrentFileProgress/);
  const rootPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(JSON.parse(companionPackage).version, rootPackage.version);
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
