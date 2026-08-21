import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { after, before, test } from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { terminateChildProcess } from "./process-helpers.mjs";

const port = 3199;
let server;
let serverOutput = "";

before(async () => {
  server = spawn(
    process.execPath,
    ["scripts/start-container.mjs"],
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

after(async () => {
  await terminateChildProcess(server);
});

test("production-renders the WatchPair application", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>WatchPair \| Watch in sync<\/title>/i);
  assert.match(html, /vite:preloadError/);
  assert.ok(
    html.indexOf("vite:preloadError") < html.indexOf("<body"),
    "the recovery listener should be installed before the application body",
  );
  assert.match(html, /WatchPair/);
  assert.match(html, /Same frame/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("production health endpoint reports readiness", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: "watchpair" });
});

test("production serves libass WebAssembly with the streaming MIME type", async () => {
  const files = await readdir(new URL("../dist/client/_next/static/", import.meta.url));
  const wasm = files.find((file) => file.startsWith("jassub-worker-") && file.endsWith(".wasm"));
  assert.ok(wasm, "JASSUB worker WASM should be emitted");
  const response = await fetch(`http://127.0.0.1:${port}/_next/static/${wasm}`, { method: "HEAD" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/wasm");
});

test("production recovers stale JavaScript chunk requests without caching the miss", async () => {
  const chunks = await readdir(new URL("../dist/client/_next/static/chunks/", import.meta.url));
  const currentChunk = chunks.find((file) => file.startsWith("hls-") && file.endsWith(".js"));
  assert.ok(currentChunk);
  const current = await fetch(
    `http://127.0.0.1:${port}/_next/static/chunks/${currentChunk}`,
    { method: "HEAD" },
  );
  assert.equal(current.status, 200);
  assert.equal(current.headers.get("x-watchpair-recovery"), null);

  const response = await fetch(
    `http://127.0.0.1:${port}/_next/static/chunks/hls-removed-by-deploy.js`,
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/javascript\b/i);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-watchpair-recovery"), "stale-static-module");
  const source = await response.text();
  assert.match(source, /location\.reload\(\)/);
  assert.match(source, /await new Promise/);

  const missingStyle = await fetch(
    `http://127.0.0.1:${port}/_next/static/chunks/removed-by-deploy.css`,
  );
  assert.ok(missingStyle.status >= 400);
  assert.equal(missingStyle.headers.get("cache-control"), "no-store");
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

  const customCreatedResponse = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "create",
      token: "PAIR-2468",
      deviceId: "custom-host",
      name: "Custom Host",
    }),
  });
  assert.equal(customCreatedResponse.status, 201);
  assert.equal((await customCreatedResponse.json()).session.token, "PAIR-2468");

  const fallbackCreatedResponse = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "create",
      token: "HALF",
      deviceId: "fallback-host",
      name: "Fallback Host",
    }),
  });
  assert.equal(fallbackCreatedResponse.status, 201);
  assert.match((await fallbackCreatedResponse.json()).session.token, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  const missingJoinResponse = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "join",
      token: "NEW2-ROOM",
      deviceId: "missing-room-host",
      name: "First arrival",
    }),
  });
  assert.equal(missingJoinResponse.status, 200);
  const missingJoin = await missingJoinResponse.json();
  assert.equal(missingJoin.session.token, "NEW2-ROOM");
  assert.equal(missingJoin.session.hostId, "missing-room-host");

  const simultaneousJoins = await Promise.all(["first", "second"].map((suffix) =>
    fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "join",
        token: "RACE-2468",
        deviceId: `race-${suffix}`,
        name: suffix,
      }),
    })
  ));
  assert.deepEqual(simultaneousJoins.map((response) => response.status), [200, 200]);
  const simultaneousSessions = await Promise.all(simultaneousJoins.map((response) => response.json()));
  assert.equal(simultaneousSessions[0].session.token, "RACE-2468");
  assert.equal(simultaneousSessions[0].session.hostId, simultaneousSessions[1].session.hostId);

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

  const duplicateSourceResponse = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "source",
      token: created.session.token,
      deviceId: "test-host",
      name: "Host",
      source: {
        id: "source-episode-one-duplicate",
        kind: "magnet",
        value: "magnet:?dn=Duplicate&xt=urn:btih:1111111111111111111111111111111111111111&tr=udp%3A%2F%2Ftracker.example%3A80",
        label: "Duplicate episode 1",
      },
    }),
  });
  assert.equal(duplicateSourceResponse.status, 200);
  assert.deepEqual(
    (await duplicateSourceResponse.json()).session.sources.map((source) => source.id),
    ["source-episode-one", "source-episode-two"],
  );

  const conflictingMagnetIdResponse = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "source",
      token: created.session.token,
      deviceId: "test-host",
      name: "Host",
      source: {
        id: "source-episode-one",
        kind: "magnet",
        value: "magnet:?xt=urn:btih:3333333333333333333333333333333333333333",
        label: "Conflicting episode",
      },
    }),
  });
  assert.equal(conflictingMagnetIdResponse.status, 409);

  const directManifestSource = {
    id: "direct-manifest-source",
    kind: "direct",
    value: "https://media.example/direct.mp4",
    label: "Direct source",
  };
  const directSourceResponse = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "source",
      token: created.session.token,
      deviceId: "test-host",
      name: "Host",
      source: directManifestSource,
    }),
  });
  assert.equal(directSourceResponse.status, 200);
  const directManifestResponse = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "source-manifest",
      token: created.session.token,
      deviceId: "test-host",
      name: "Host",
      sourceId: directManifestSource.id,
      infoHash: "1111111111111111111111111111111111111111",
      mediaItems: [{ fileIndex: 0, path: "direct.mp4", size: 100 }],
    }),
  });
  assert.equal(directManifestResponse.status, 409);
  const removeDirectSourceResponse = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "remove-source",
      token: created.session.token,
      deviceId: "test-host",
      name: "Host",
      sourceId: directManifestSource.id,
    }),
  });
  assert.equal(removeDirectSourceResponse.status, 200);

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


  const manifestSourceId = "source-episode-one";
  const manifestInput = [
    { fileIndex: 3, path: "Show/Season 2/Episode 10.mkv", size: 310 },
    { fileIndex: 1, path: "Show/Season 1/Episode 1.mkv", size: 110 },
    { fileIndex: 2, path: "Show/Season 2/Episode 2.mkv", size: 210 },
  ];
  const mismatchedManifest = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "source-manifest",
      token: created.session.token,
      deviceId: "test-host",
      name: "Host",
      sourceId: manifestSourceId,
      infoHash: "9999999999999999999999999999999999999999",
      mediaItems: manifestInput,
    }),
  });
  assert.equal(mismatchedManifest.status, 409);
  const manifested = await mutate("source-manifest", {
    sourceId: manifestSourceId,
    infoHash: "1111111111111111111111111111111111111111",
    mediaItems: manifestInput,
  });
  const manifestedSource = manifested.sources.find((source) => source.id === manifestSourceId);
  assert.deepEqual(
    manifestedSource.mediaItems.map((item) => item.fileIndex),
    [1, 2, 3],
  );
  assert.deepEqual(
    manifestedSource.mediaItems.map((item) => item.path),
    [
      "Show/Season 1/Episode 1.mkv",
      "Show/Season 2/Episode 2.mkv",
      "Show/Season 2/Episode 10.mkv",
    ],
  );

  const prioritizedId = `${manifestSourceId}-f3`;
  const prioritized = await mutate("prioritize-media", {
    itemId: prioritizedId,
    priority: true,
  });
  assert.equal(
    prioritized.sources
      .find((source) => source.id === manifestSourceId)
      .mediaItems.find((item) => item.id === prioritizedId)
      .priority,
    true,
  );

  const excludedId = `${manifestSourceId}-f2`;
  const excluded = await mutate("include-media", {
    itemId: excludedId,
    included: false,
  });
  assert.equal(
    excluded.sources
      .find((source) => source.id === manifestSourceId)
      .mediaItems.find((item) => item.id === excludedId)
      .included,
    false,
  );

  const manualOrder = [prioritizedId, `${manifestSourceId}-f1`, excludedId];
  await mutate("reorder-media", { sourceId: manifestSourceId, itemIds: manualOrder });
  const republished = await mutate("source-manifest", {
    sourceId: manifestSourceId,
    infoHash: "1111111111111111111111111111111111111111",
    mediaItems: manifestInput,
  });
  const republishedSource = republished.sources.find((source) => source.id === manifestSourceId);
  assert.deepEqual(republishedSource.mediaItems.map((item) => item.id), manualOrder);
  assert.equal(republishedSource.mediaItems[0].priority, true);
  assert.equal(republishedSource.mediaItems[2].included, false);
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

  const directSource = {
    id: "source-direct-video",
    kind: "direct",
    value: "https://media.example/video-one.mp4",
    label: "Direct video",
  };
  const directAdded = await mutate("source", { source: directSource });
  assert.equal(directAdded.sources.length, 1);
  const normalizedDirectRetry = await mutate("source", {
    source: { ...directSource, value: "https://MEDIA.example:443/folder/../video-one.mp4" },
  });
  assert.equal(normalizedDirectRetry.sources.length, 1);
  const conflictingDirectIdResponse = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "source",
      token: created.session.token,
      deviceId: "test-host",
      name: "Host",
      source: { ...directSource, value: "https://media.example/video-two.mp4" },
    }),
  });
  assert.equal(conflictingDirectIdResponse.status, 409);
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
  assert.match(app, /action: "create",\s+token: requestedToken\.length === 9/);
  assert.match(app, /setAgentMediaPriority\(plan\.selected, plan\.targets\)/);
  assert.match(app, /orderedMediaQueue\(sources, selectedItemId\)/);
  assert.match(app, /source-manifest/);
  assert.match(app, /crossOrigin="anonymous"/);
  assert.match(app, /getAgentDownloads/);
  assert.match(app, /Download queue/);
  assert.match(app, /const COMPANION_VERSION = "\d+\.\d+\.\d+"; \/\/ x-release-please-version/);
  assert.match(app, /github.com\/Etaselia\/WatchPair\/releases\/tag\/v\$\{COMPANION_VERSION\}/);
  assert.match(app, /getAgentConnectUrl/);
  assert.match(
    app,
    /const shareLibraryFile[\s\S]*seedAgentLibraryFile/
  );
  assert.match(app, /const bindLibraryFileLocally[\s\S]*attachAgentLibraryFile/);
  assert.match(app, /getAgentLibraryPreviewUrl/);
  assert.match(app, /libraryPreviewNeedsHls/);
  assert.match(app, /preview-\$\{crypto\.randomUUID\(\)\}/);
  assert.match(app, /attachAgentLibraryFile\([\s\S]*Preview ·/);
  assert.match(app, /function LibraryVideoPreview/);
  assert.match(app, /void import\("hls\.js"\)/);
  assert.match(app, /stopAgentDownload\(previewJobId, false\)/);
  assert.match(app, /!isLibraryPreviewJobId\(job\.id\)/);
  assert.match(agentClient, /\/downloads\/\$\{encodeURIComponent\(sourceId\)\}\/publication/);
  assert.match(agentClient, /AGENT_PROTOCOL_VERSION = 2/);
  assert.match(agentClient, /result\.protocolVersion !== AGENT_PROTOCOL_VERSION/);
  assert.match(app, /Companion update required/);
  assert.match(app, /opaqueSeedLeaseId/);
  assert.match(app, /ensureSeedLease\(sourceId, roomToken, deviceId\)/);
  assert.match(app, /releaseSeedLeases\(\[removedId\]\)/);
  assert.match(app, /verifiedRoomAgentJobs\.token === roomToken/);
  assert.match(app, /roomAgentJob\(source\.id\)\?\.seed/);
  assert.match(app, /agentJobMatchesSourceIdentity\(job, expectedSourceIdentities\.get\(job\.id\)\)/);
  assert.match(app, /different media under the same source ID/);
  assert.match(app, /publishedMagnetRoomSourceId/);
  assert.match(app, /existing queue item was kept/);
  assert.match(app, /await releaseSeedLeases\(\[sourceId\]\)[\s\S]*stopAgentDownload\(sourceId, true\)/);
  assert.match(app, /Use on this device/);
  assert.match(app, /Share \/ Add to room/);
  assert.match(app, /selectedLibraryFile\.usable === false/);
  assert.match(app, /Still downloading or verifying/);
  assert.match(app, /local copies/);
  assert.match(app, /libraryCatalogStale/);
  assert.match(app, /latest library scan failed/);
  assert.match(agentClient, /error instanceof AgentRequestError && error\.status === 503/);
  assert.match(app, /let refreshRunning = false/);
  assert.match(app, /automaticLibraryBindingsRef\.current\.delete\(automaticMatchKey\)/);
  assert.doesNotMatch(app, />Share local files</);
  assert.match(app, /toggleQueuedSourcePin/);
  assert.match(app, /embeddedChapters/);
  assert.match(app, /queueReadinessForJob/);
  assert.match(app, /file\.ready && Boolean\(fingerprint\) && \(preparation === "ready" \|\| preparation === "direct"\)/);
  assert.match(app, /preparation\.pipeline\?\.hardwareDecode/);
  assert.match(app, /preparation\.diagnostics/);
  assert.match(app, /uploadAndSeedAgentFile/);
  assert.match(app, /Seeding \/ waiting for peers/);
  assert.match(app, /type AcquisitionPolicy = "automatic" \| "ask" \| "never"/);
  assert.match(app, /shouldAcquireSource\(acquisitionPolicy/);
  assert.match(app, /synchronizePlayback/);
  assert.match(app, /shouldHoldLocalSeek/);
  assert.match(app, /shouldHoldLocalPlayback/);
  assert.match(app, /playback_remote_sync_deferred/);
  assert.match(app, /seek_remote_sync_deferred/);
  assert.match(app, /onPointerUp=\{finishSeek\}/);
  assert.match(app, /5_000/);
  assert.match(app, /subtitleOffset/);
  assert.match(app, /autoOpenedMediaRef/);
  assert.match(app, /window\.setInterval\(keepAlive, 8_000\)/);
  assert.match(app, /scheduleControlsHide/);
  assert.match(app, /Caption options/);
  assert.match(app, /Background opacity/);
  assert.match(app, /Character edge/);
  assert.match(app, /Detecting embedded subtitle tracks/);
  assert.match(app, /Preparing .* subtitles on this device/);
  assert.match(app, /Image subtitles unavailable in browser/);
  assert.match(app, /Subtitle preparation failed/);
  assert.match(app, /aria-label="Select video"/);
  assert.match(app, /aria-label="Next video"/);
  assert.match(app, /isTrustedPlaybackUrl/);
  assert.match(app, /event\.currentTarget\.selectedIndex/);
  assert.match(app, /Preparing selected video/);
  assert.match(app, /applySession/);
  assert.match(app, /Preparing video for this browser/);
  assert.match(app, /HlsRuntime\.isSupported/);
  assert.match(app, /AUDIO_TRACKS_UPDATED/);
  assert.match(app, /audioPreference: initialHlsAudioPreference/);
  assert.match(app, /hls\.audioTrack = desiredAudioTrackIndex/);
  assert.match(app, /resolveHlsAudioChannelCount/);
  assert.match(app, /MANIFEST_PARSED/);
  assert.match(app, /Preparing stereo compatibility audio/);
  assert.match(app, /This browser could not decode the prepared video or audio track/);
  assert.doesNotMatch(app, /if \(hlsRef\.current\) return/);
  assert.match(app, /hlsRecoveryRef\.current = true;\s+hlsRef\.current\?\.stopLoad\(\)/);
  const fatalAudioFallbackIndex = app.indexOf("fatalHlsMediaError: data.fatal");
  const hlsMediaRecoveryIndex = app.indexOf("hls.recoverMediaError()");
  assert.ok(
    fatalAudioFallbackIndex >= 0 && fatalAudioFallbackIndex < hlsMediaRecoveryIndex,
    "surround fallback must run before HLS media recovery",
  );
  assert.match(app, /activeFile\?\.ready && activeItem\.ready/);
  assert.match(app, /HTMLMediaElement\.HAVE_METADATA/);
  assert.match(app, /HTMLMediaElement\.HAVE_FUTURE_DATA/);
  assert.doesNotMatch(app, /HLS_STARTUP_FLOOR_SECONDS/);
  assert.match(app, /clampToPreparedRanges\(target, ranges\)/);
  assert.match(app, /seekableStart: finiteMediaValue/);
  assert.match(agent, /clientEvent: String\(body\.event/);
  assert.match(agent, /seekTarget: Number\.isFinite/);
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
  assert.match(route, /COMPLETE_TOKEN/);
  assert.match(route, /!currentSession && action === "join"/);
  assert.match(route, /action === "rename-source"/);
  assert.match(route, /normalizeSources/);
  assert.match(route, /action === "source-manifest"/);
  assert.match(route, /action === "prioritize-media"/);
  assert.match(route, /action === "include-media"/);
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
  assert.match(agent, /fileIdentityFingerprint/);
  assert.match(agent, /torrent\.once\("ready", \(\) => markServing\(torrent\)\)/);
  assert.match(agent, /restoreJobs/);
  assert.match(agent, /media-priority/);
  assert.match(agent, /diagnostics\/client/);
  assert.match(agent, /preparationBlockedByWatchOrder/);
  assert.match(agent, /queueSelectedPreparation/);
  assert.match(agent, /replaceTorrentSelections/);
  assert.match(agentClient, /loopback-network/);
  assert.match(agentClient, /JSON\.stringify\(\{ selected, targets \}\)/);
  assert.match(agentClient, /getAgentDownloads/);
  assert.match(agentClient, /reportAgentPlaybackEvent/);
  assert.match(agentClient, /getAgentPermissionState/);
  assert.match(app, /file\.fingerprint === undefined/);
  assert.match(app, /!selectedMedia\.fingerprint/);
  assert.doesNotMatch(app, /selectedMedia\.fingerprint !== next\.fingerprint/);
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
    "WatchPair Companion/hls-epoch-playback.mjs",
    "WatchPair Companion/hardware-acceleration.mjs",
    "WatchPair Companion/media-governor.mjs",
    "WatchPair Companion/process-registry.mjs",
    "WatchPair Companion/persistent-log.mjs",
    "WatchPair Companion/library-catalog.mjs",
    "WatchPair Companion/http-range.mjs",
    "WatchPair Companion/torrent-telemetry.mjs",
    "WatchPair Companion/magnet-identity.mjs",
    "WatchPair Companion/render-queue.mjs",
    "WatchPair Companion/scheduled-ffmpeg.mjs",
    "WatchPair Companion/subtitle-pipeline.mjs",
    "WatchPair Companion/job-store.mjs",
    "WatchPair Companion/media-priority.mjs",
    "WatchPair Companion/torrent-input.mjs",
    "WatchPair Companion/torrent-bandwidth-governor.mjs",
    "WatchPair Companion/torrent-pressure.mjs",
    "WatchPair Companion/webtorrent-safety.mjs",
    "WatchPair Companion/package.json",
    "WatchPair Companion/install-and-start.cmd",
    "WatchPair Companion/install-runtime.ps1",
    "WatchPair Companion/pnpm-lock.yaml",
    "WatchPair Companion/pnpm-workspace.yaml",
  ];
  for (const path of expected) assert.ok(archive[path], `Missing ${path}`);
  for (const [archivePath, contents] of Object.entries(archive)) {
    if (!archivePath.endsWith(".mjs")) continue;
    const source = strFromU8(contents);
    for (const match of source.matchAll(/from\s+["']\.\/(.+?\.mjs)["']/g)) {
      const dependency = "WatchPair Companion/" + match[1];
      assert.ok(
        archive[dependency],
        `${archivePath} imports missing ${dependency}`
      );
    }
  }

  const bundledAgent = strFromU8(archive["WatchPair Companion/server.mjs"]);
  const bundledHls = strFromU8(archive["WatchPair Companion/hls-playback.mjs"]);
  const bundledHlsEngine = strFromU8(archive["WatchPair Companion/hls-epoch-playback.mjs"]);
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
  assert.match(bundledHls, /export \* from "\.\/hls-epoch-playback\.mjs"/);
  assert.match(bundledHlsEngine, /hls_playlist_type/);
  assert.match(bundledHlsEngine, /watchpair-audio/);
  assert.match(bundledHlsEngine, /videoPipeline/);
  assert.match(bundledHlsEngine, /pipelineDiagnostics/);
  assert.match(bundledHlsEngine, /DEFAULT_PLAYABLE_SECONDS = 120/);
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
  assert.equal(JSON.parse(companionPackage).dependencies.webtorrent, rootPackage.dependencies.webtorrent);
  assert.match(installer, /\$Releases = Invoke-RestMethod/);
  assert.match(installer, /\$Release = \(\$Releases \| Where-Object/);
  assert.match(installer, /\$Version = \[string\]\$Release\.version/);
  assert.match(installer, /win-x64-zip/);
  assert.match(installer, /SHASUMS256\.txt" -OutFile \$ChecksumFile/);
  assert.match(windowsLauncher, /corepack\.cmd" pnpm install --prod --frozen-lockfile/);
  assert.match(buildPolicy, /allowBuilds:/);
  assert.match(buildPolicy, /node-datachannel: true/);
});
