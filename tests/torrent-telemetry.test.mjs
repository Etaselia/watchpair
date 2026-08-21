import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  classifyTrackerError,
  createTorrentTelemetry,
  sanitizeTrackerEndpoint,
} from "../agent/torrent-telemetry.mjs";

class FakeTorrent extends EventEmitter {
  constructor(tracker) {
    super();
    this.announce = [
      "https://user:private-passkey@Tracker.Example:8443/announce/private?token=secret#fragment",
      "udp://tracker.example:6969/announce",
    ];
    this.wires = [];
    this.downloadSpeed = 2_048;
    this.uploadSpeed = 1_024;
    this.downloaded = 4_096;
    this.uploaded = 512;
    this.client = { utPex: true };
    this.discovery = { tracker, dht: {}, lsd: null };
  }
}

test("tracker endpoints expose only scheme, host, and a validated port", () => {
  assert.equal(
    sanitizeTrackerEndpoint("https://user:pass@Tracker.Example:8443/announce/passkey?token=secret#part"),
    "https://tracker.example:8443"
  );
  assert.equal(sanitizeTrackerEndpoint("udp://tracker.example:6969/a/b"), "udp://tracker.example:6969");
  assert.equal(sanitizeTrackerEndpoint("wss://TRACKER.example/private"), "wss://tracker.example");
  assert.equal(sanitizeTrackerEndpoint("ftp://tracker.example/announce"), null);
  assert.equal(sanitizeTrackerEndpoint("udp://tracker.example:99999/announce"), null);
  assert.equal(sanitizeTrackerEndpoint("not a URL"), null);
});

test("tracker failures are categorized without returning their messages", () => {
  assert.equal(classifyTrackerError(new Error("tracker request timed out")), "timeout");
  assert.equal(classifyTrackerError(new Error("403 forbidden")), "rejected");
  assert.equal(classifyTrackerError(new Error("unsupported protocol")), "unsupported");
  assert.equal(classifyTrackerError(new Error("invalid tracker response")), "invalid-response");
  assert.equal(classifyTrackerError(new Error("getaddrinfo ENOTFOUND")), "unreachable");
  assert.equal(classifyTrackerError(new Error("tracker is unavailable")), "unavailable");
});

test("telemetry distinguishes connected peers and confirmed connected seeds", () => {
  const tracker = new EventEmitter();
  const torrent = new FakeTorrent(tracker);
  torrent.wires = [
    { isSeeder: true, destroyed: false },
    { isSeeder: false, destroyed: false },
    { destroyed: false },
    { isSeeder: true, destroyed: true },
  ];
  const telemetry = createTorrentTelemetry(torrent);

  assert.deepEqual(
    {
      connectedPeers: telemetry.summary().connectedPeers,
      connectedSeeds: telemetry.summary().connectedSeeds,
    },
    { connectedPeers: 3, connectedSeeds: 1 }
  );
  assert.equal(telemetry.summary().downloadSpeed, 2_048);
  assert.equal(telemetry.summary().uploadSpeed, 1_024);
  telemetry.dispose();
});

test("fresh tracker availability uses the maximum report, never the sum", () => {
  let clock = 1_000;
  const tracker = new EventEmitter();
  tracker._trackers = [
    { announceUrl: "https://one.example/private/passkey" },
    { announceUrl: "udp://two.example:6969/announce" },
  ];
  const torrent = new FakeTorrent(tracker);
  const telemetry = createTorrentTelemetry(torrent, {
    now: () => clock,
    staleAfterMs: 5_000,
  });

  tracker.emit("update", {
    announce: "https://name:password@one.example/private/passkey?token=secret",
    complete: 7,
    incomplete: 4,
  });
  clock += 1_000;
  tracker.emit("update", {
    announce: "udp://two.example:6969/announce/secret",
    complete: 5,
    incomplete: 9,
  });

  const current = telemetry.summary();
  assert.equal(current.trackerReportedSeeders, 7);
  assert.equal(current.trackerReportedLeechers, 9);
  assert.equal(current.trackerAvailability, "known");
  assert.equal(current.respondingTrackers, 2);

  clock += 5_001;
  const expired = telemetry.summary();
  assert.equal(expired.trackerReportedSeeders, null);
  assert.equal(expired.trackerReportedLeechers, null);
  assert.equal(expired.trackerAvailability, "unknown");
  assert.equal(expired.respondingTrackers, 0);
  assert.equal(expired.lastTrackerResponseAt, 2_000);
  assert.ok(telemetry.snapshot().trackers.some((entry) => entry.state === "stale"));
  telemetry.dispose();
});

test("an explicit fresh zero is different from unknown availability", () => {
  const tracker = new EventEmitter();
  const torrent = new FakeTorrent(tracker);
  const telemetry = createTorrentTelemetry(torrent, { now: () => 42 });

  assert.equal(telemetry.summary().trackerReportedSeeders, null);
  tracker.emit("update", {
    announce: "udp://tracker.example:6969/announce",
    complete: 0,
    incomplete: 0,
  });
  assert.equal(telemetry.summary().trackerReportedSeeders, 0);
  assert.equal(telemetry.summary().trackerAvailability, "known");
  telemetry.dispose();
});

test("tracker warnings retain only a safe endpoint and category", () => {
  const tracker = new EventEmitter();
  const torrent = new FakeTorrent(tracker);
  const telemetry = createTorrentTelemetry(torrent, { now: () => 77 });

  tracker.emit(
    "warning",
    new Error("tracker request timed out https://person:password@tracker.example/private-passkey?token=secret")
  );
  const serialized = JSON.stringify(telemetry.snapshot());
  assert.deepEqual(telemetry.snapshot().latestTrackerError, {
    category: "timeout",
    at: 77,
    endpoint: "https://tracker.example",
  });
  assert.doesNotMatch(serialized, /password|private-passkey|token=secret|person/u);
  telemetry.dispose();
});

test("telemetry disposes old listeners and rebinds replacement tracker clients", () => {
  let clock = 10;
  const first = new EventEmitter();
  const second = new EventEmitter();
  const torrent = new FakeTorrent(first);
  const telemetry = createTorrentTelemetry(torrent, { now: () => clock });

  assert.equal(first.listenerCount("update"), 1);
  torrent.discovery.tracker = second;
  clock = 20;
  torrent.emit("trackerAnnounce");
  assert.equal(first.listenerCount("update"), 0);
  assert.equal(second.listenerCount("update"), 1);

  first.emit("update", {
    announce: "https://ignored.example/secret",
    complete: 99,
  });
  second.emit("update", {
    announce: "https://active.example/secret",
    complete: 3,
    incomplete: 1,
  });
  assert.equal(telemetry.summary().trackerReportedSeeders, 3);
  assert.equal(telemetry.summary().trackerAnnounces, 1);

  telemetry.dispose();
  assert.equal(second.listenerCount("update"), 0);
  assert.equal(torrent.listenerCount("trackerAnnounce"), 0);
  assert.equal(torrent.listenerCount("metadata"), 0);
});
