import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FileSessionStore, handleSessionApi } from "../worker/session-api.ts";

const VOICE = { iceServers: [] };

const playerAt = (changedAt) => ({
  paused: true,
  position: 0,
  playbackRate: 1,
  audioLanguage: "original",
  subtitleLanguage: "off",
  subtitleOffset: 0,
  changedAt,
  actorId: "system",
});

async function tempSessionFile(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-sessions-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, "sessions.json");
}

test("persists sessions and restores them into a fresh store", async (t) => {
  const file = await tempSessionFile(t);
  const now = 1_700_000_000_000;

  const first = new FileSessionStore(VOICE, file, { now: () => now });
  await first.initialize();
  await first.create("ABCD-EFGH", "host-device", now);
  await first.touch("ABCD-EFGH", "host-device", "Host", undefined, now);
  await first.setSource(
    "ABCD-EFGH",
    {
      id: "source-0001",
      kind: "direct",
      value: "https://media.example/video.mp4",
      label: "Shared video",
      addedBy: "host-device",
      addedAt: now,
    },
    now
  );
  await first.setPlayer("ABCD-EFGH", { ...playerAt(now), position: 42.5, paused: false }, now);
  await first.addVoiceSignal("ABCD-EFGH", {
    id: "signal-0001",
    fromId: "host-device",
    toId: "guest-device",
    type: "offer",
    data: "sdp-payload",
    createdAt: now,
  });
  await first.flush();

  // The snapshot is atomic: the live file exists, the temporary file does not.
  await access(file);
  await assert.rejects(access(`${file}.tmp`));

  // A brand-new store on the same file behaves like a coordinator restart.
  const second = new FileSessionStore(VOICE, file, { now: () => now });
  await second.initialize();
  const session = await second.get("ABCD-EFGH");
  assert.ok(session);
  assert.equal(session.hostId, "host-device");
  assert.equal(session.sources.length, 1);
  assert.equal(session.sources[0].id, "source-0001");
  assert.equal(session.player.position, 42.5);
  assert.equal(session.player.paused, false);
  assert.equal(session.participants.length, 1);
  assert.equal(session.participants[0].name, "Host");
  const signals = await second.get("ABCD-EFGH", "guest-device");
  assert.equal(signals.voiceSignals.length, 1);
  assert.equal(signals.voiceSignals[0].type, "offer");
});

test("debounces snapshot writes after mutations", async (t) => {
  const file = await tempSessionFile(t);
  const now = 1_700_000_000_000;
  const store = new FileSessionStore(VOICE, file, { now: () => now, debounceMs: 100 });
  await store.initialize();

  await store.create("ABCD-EFGH", "host-device", now);
  // The debounce window has not elapsed yet: nothing is on disk.
  await assert.rejects(access(file));

  await store.touch("ABCD-EFGH", "host-device", "Host", undefined, now);
  await new Promise((resolve) => setTimeout(resolve, 250));

  const snapshot = JSON.parse(await readFile(file, "utf8"));
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.sessions[0].token, "ABCD-EFGH");
  await assert.rejects(access(`${file}.tmp`));
});

test("flushes deterministically through an injected scheduler", async (t) => {
  const file = await tempSessionFile(t);
  const now = 1_700_000_000_000;
  let fire = null;
  const store = new FileSessionStore(VOICE, file, {
    now: () => now,
    schedule: (callback) => {
      fire = callback;
      return 1;
    },
    clearSchedule: () => {
      fire = null;
    },
  });
  await store.initialize();

  await store.create("ABCD-EFGH", "host-device", now);
  assert.equal(typeof fire, "function", "a debounced write should be pending");
  await assert.rejects(access(file));

  fire(); // the debounce fires and serializes the current snapshot
  await store.flush();
  await access(file);
  const snapshot = JSON.parse(await readFile(file, "utf8"));
  assert.equal(snapshot.sessions.length, 1);
  await assert.rejects(access(`${file}.tmp`));
});

test("drops expired sessions when loading the snapshot", async (t) => {
  const file = await tempSessionFile(t);
  const future = 1_800_000_000_000;
  const past = 1_000_000_000;
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      savedAt: future,
      sessions: [
        {
          token: "LIVE-0001",
          hostId: "host-device",
          sources: [],
          selectedMedia: null,
          player: playerAt(past),
          seq: 0,
          createdAt: past,
          expiresAt: future + 1,
          updatedAt: past,
          participants: [],
          voiceSignals: [],
        },
        {
          token: "DEAD-0001",
          hostId: "host-device",
          sources: [],
          selectedMedia: null,
          player: playerAt(past),
          seq: 0,
          createdAt: past,
          expiresAt: past + 1,
          updatedAt: past,
          participants: [],
          voiceSignals: [],
        },
      ],
    })
  );

  const store = new FileSessionStore(VOICE, file, { now: () => future });
  await store.initialize();
  assert.ok(await store.get("LIVE-0001"));
  assert.equal(await store.get("DEAD-0001"), null);
});

test("tolerates a missing and a corrupt snapshot file", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-sessions-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const quiet = () => {};

  const missing = new FileSessionStore(VOICE, path.join(directory, "missing.json"), {
    onError: quiet,
  });
  await missing.initialize();
  assert.equal(await missing.get("ABCD-EFGH"), null);

  const file = path.join(directory, "corrupt.json");
  await writeFile(file, "{ this is not json");
  const corrupt = new FileSessionStore(VOICE, file, { onError: quiet });
  await corrupt.initialize();
  assert.equal(await corrupt.get("ABCD-EFGH"), null);

  // A later valid snapshot overwrites the corrupt payload.
  const recovered = new FileSessionStore(VOICE, file, {
    onError: quiet,
    now: () => 1_700_000_000_000,
  });
  await recovered.initialize();
  await recovered.create("ABCD-EFGH", "host-device", 1_700_000_000_000);
  await recovered.flush();
  assert.ok(await recovered.get("ABCD-EFGH"));
});

test("keeps sessions in memory only when no file is configured", async () => {
  const now = 1_700_000_000_000;
  const first = new FileSessionStore(VOICE, null, { now: () => now });
  await first.initialize();
  await first.create("ABCD-EFGH", "host-device", now);
  await first.flush(); // no file: no-op
  assert.ok(await first.get("ABCD-EFGH"));

  // Store instances do not share state.
  const second = new FileSessionStore(VOICE, null, { now: () => now });
  await second.initialize();
  assert.equal(await second.get("ABCD-EFGH"), null);
});

test("rejoin with an empty queue preserves previously published per-video readiness", async (t) => {
  const file = await tempSessionFile(t);
  const now = 1_700_000_000_000;
  const store = new FileSessionStore(VOICE, file, { now: () => now });
  await store.initialize();
  await store.create("ABCD-EFGH", "host-device", now);

  const readyItem = {
    ready: true,
    progress: 100,
    status: "Ready to watch",
    fileName: "video.mp4",
    fileSize: 123,
    fingerprint: "fp-0001",
    preparation: "ready",
  };
  await store.touch("ABCD-EFGH", "guest-device", "Guest", {
    ...readyItem,
    queue: { "source-0001": readyItem },
    voice: { enabled: false, muted: true, deafened: false },
  }, now);

  // A fresh page load (or a leave/rejoin) publishes an empty readiness. The
  // merge must keep the previously published per-video queue instead of wiping
  // it, so the coordinator does not regress to "not ready" on rejoin.
  await store.touch("ABCD-EFGH", "guest-device", "Guest", undefined, now);

  const session = await store.get("ABCD-EFGH");
  const guest = session.participants.find((participant) => participant.deviceId === "guest-device");
  assert.ok(guest);
  assert.equal(guest.queue?.["source-0001"]?.ready, true);
  assert.equal(guest.queue?.["source-0001"]?.preparation, "ready");
});

test("wires WATCHPAIR_SESSION_FILE through the session API", async (t) => {
  const file = await tempSessionFile(t);
  const env = { WATCHPAIR_SESSION_FILE: file, WATCHPAIR_ICE_SERVERS: "{}" };

  const createdResponse = await handleSessionApi(
    new Request("http://127.0.0.1/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "create", deviceId: "host-device", name: "Host" }),
    }),
    env
  );
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  const token = created.session.token;
  assert.match(token, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  // Wait past the coordinator's ~1s write debounce, then confirm the snapshot.
  await new Promise((resolve) => setTimeout(resolve, 1_250));
  const snapshot = JSON.parse(await readFile(file, "utf8"));
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.sessions[0].token, token);

  // The same env reuses the cached store; the session is still readable.
  const getResponse = await handleSessionApi(
    new Request(`http://127.0.0.1/api/sessions?token=${token}&deviceId=host-device`),
    env
  );
  assert.equal(getResponse.status, 200);
  const got = await getResponse.json();
  assert.equal(got.session.token, token);
  assert.equal(got.session.hostId, "host-device");

  // A fresh store on the persisted file (a coordinator restart) restores it.
  const restarted = new FileSessionStore(VOICE, file, { now: () => Date.now() });
  await restarted.initialize();
  assert.equal((await restarted.get(token))?.token, token);
});
