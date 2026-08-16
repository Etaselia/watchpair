import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import {
  activeRecoverySession,
  isMissingStaticAssetStatus,
  isRecentStaticAssetRecovery,
  isStaticChunkModule,
  STATIC_ASSET_REJOIN_KEY,
  STATIC_ASSET_RELOAD_KEY,
  staticAssetRecoveryBootstrap,
  staticChunkRecoveryModule,
} from "../lib/static-asset-recovery.mjs";

test("recognizes only generated JavaScript chunk paths", () => {
  assert.equal(isStaticChunkModule("/_next/static/chunks/hls-old.js"), true);
  assert.equal(isStaticChunkModule("/_next/static/chunks/nested/hls-old.js"), false);
  assert.equal(isStaticChunkModule("/_next/static/hls-old.js"), false);
  assert.equal(isStaticChunkModule("/_next/static/chunks/hls-old.css"), false);
});

test("recovers only definitive missing-asset responses", () => {
  assert.equal(isMissingStaticAssetStatus(404), true);
  assert.equal(isMissingStaticAssetStatus(410), true);
  assert.equal(isMissingStaticAssetStatus(304), false);
  assert.equal(isMissingStaticAssetStatus(416), false);
  assert.equal(isMissingStaticAssetStatus(500), false);
  assert.equal(isMissingStaticAssetStatus(503), false);
});

test("accepts only recent positive recovery timestamps", () => {
  assert.equal(isRecentStaticAssetRecovery("95000", 100000), true);
  assert.equal(isRecentStaticAssetRecovery("69999", 100000), false);
  assert.equal(isRecentStaticAssetRecovery("100001", 100000), false);
  assert.equal(isRecentStaticAssetRecovery("invalid", 100000), false);
  assert.equal(isRecentStaticAssetRecovery(null, 100000), false);
});

test("auto-rejoin is limited to a device that was already in the room", () => {
  const session = {
    token: "PAIR-2468",
    participants: [{ deviceId: "joined-device" }],
  };
  assert.equal(activeRecoverySession(session, "joined-device"), session);
  assert.equal(activeRecoverySession(session, "invite-only-device"), null);
  assert.equal(activeRecoverySession(null, "joined-device"), null);
});

test("preload recovery reloads once and records a rejoin attempt", () => {
  const values = new Map();
  let listener;
  let reloads = 0;
  let prevented = 0;
  const context = {
    addEventListener(name, callback) {
      assert.equal(name, "vite:preloadError");
      listener = callback;
    },
    Date: class extends Date {
      static now() { return 100000; }
    },
    location: { reload() { reloads += 1; } },
    Number,
    sessionStorage: {
      getItem(key) { return values.get(key) ?? null; },
      setItem(key, value) { values.set(key, value); },
    },
  };

  vm.runInNewContext(staticAssetRecoveryBootstrap(), context);
  assert.equal(typeof listener, "function");
  listener({ preventDefault() { prevented += 1; } });
  assert.equal(reloads, 1);
  assert.equal(prevented, 1);
  assert.equal(values.get(STATIC_ASSET_RELOAD_KEY), "100000");
  assert.equal(values.get(STATIC_ASSET_REJOIN_KEY), "100000");

  listener({ preventDefault() { prevented += 1; } });
  assert.equal(reloads, 1, "a repeated failure must not create a reload loop");
  assert.equal(prevented, 1);
});

test("preload recovery does not reload without a durable loop guard", () => {
  let listener;
  let reloads = 0;
  const context = {
    addEventListener(_name, callback) { listener = callback; },
    Date,
    location: { reload() { reloads += 1; } },
    Number,
    sessionStorage: {
      getItem() { throw new Error("storage unavailable"); },
      setItem() { throw new Error("storage unavailable"); },
    },
  };
  vm.runInNewContext(staticAssetRecoveryBootstrap(), context);
  listener({ preventDefault() { throw new Error("must not suppress the error"); } });
  assert.equal(reloads, 0);
});

test("missing chunk recovery is a self-refreshing JavaScript module", () => {
  const source = staticChunkRecoveryModule();
  assert.match(source, /location\.reload\(\)/);
  assert.match(source, /await new Promise/);
  assert.match(source, /WatchPair was updated/);
  assert.match(source, /export \{\}/);
  assert.match(source, new RegExp(STATIC_ASSET_REJOIN_KEY));
});
