import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTransferControls, validateBandwidthSettings, orderTransferTargets, transferStage, groupTransferSnapshots } from "../agent/transfer-controls.mjs";
import { createRoomControl } from "../agent/room-control.mjs";
test("manual queue limits distinct transfers, preserves file priorities, and excludes paused work", () => {
    const controls = normalizeTransferControls({ queueMode: "manual", order: ["second-job", "first-job"], paused: ["paused-job"], maxActiveDownloads: 1, priorities: { "second-job": { 0: "low", 1: "high" } } });
    assert.deepEqual(orderTransferTargets([{ jobId: "first-job", fileIndex: 0 }, { jobId: "second-job", fileIndex: 0 }, { jobId: "second-job", fileIndex: 1 }, { jobId: "paused-job", fileIndex: 0 }], controls), [{ jobId: "second-job", fileIndex: 1 }, { jobId: "second-job", fileIndex: 0 }]);
    assert.equal(normalizeTransferControls(null).downloadLimit, 0);
    assert.throws(() => validateBandwidthSettings({ downloadLimit: -1, uploadLimit: 0, maxActiveDownloads: 1, queueMode: "manual" }));
    assert.equal(transferStage({ paused: true, manualPaused: true }).label, "Paused manually");
    assert.equal(transferStage({ status: "ready", files: [{ included: true, progress: 100, downloadReady: true, ready: false }] }).key, "preparing");
    const downloaded = { included: true, progress: 100, downloadReady: true, ready: true, fingerprint: "verified-fingerprint", preparation: { status: "queued" } };
    assert.equal(transferStage({ files: [downloaded] }).key, "preparing", "Downloaded data is not a prepared browser copy");
    assert.equal(transferStage({ files: [{ ...downloaded, preparation: { status: "ready" } }] }).key, "ready");
    assert.equal(transferStage({ files: [{ ...downloaded, preparation: { status: "error", error: "Probe failed" } }] }).key, "error");
    assert.equal(transferStage({ files: [{ included: false }] }).key, "waiting");
});
test("room controls verify the current host, keep credentials private, and expire without browser renewal", async () => {
    let time = 1000, host = "host-device";
    const actions = [];
    const bridge = createRoomControl({ now: () => time, ttlMs: 100, fetcher: async (_url, options) => {
            if (options.body)
                actions.push(JSON.parse(options.body));
            return Response.json({ session: { seq: 7, hostId: host, sources: [], watchRecords: {}, participants: [{ deviceId: "host-device" }] } });
        } });
    const { id } = await bridge.register("https://room.example", { token: "ABCD-EFGH", deviceId: "host-device" });
    assert.equal(bridge.list()[0].host, true);
    assert.equal(JSON.stringify(bridge.list()).includes("ABCD-EFGH"), false);
    await bridge.act(id, { action: "companion-select-files" });
    assert.equal(actions[0].expectedSeq, 7);
    host = "another-host";
    await assert.rejects(bridge.act(id, { action: "companion-select-files" }), /Only the room host/);
    time += 101;
    assert.deepEqual(bridge.list(), []);
    await assert.rejects(bridge.act(id, {}), /expired/);
});

test("shared transfer rows show the union while source controls keep their own selection", () => {
    const local = { id: "local-source", sharedTransferId: "physical-transfer", kind: "magnet", downloadRole: "foreground",
        files: [{ index: 0, size: 100, progress: 40, included: false }] };
    const other = { ...local, id: "other-source", files: [{ ...local.files[0], included: true }] };
    const groups = groupTransferSnapshots([local, other]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].physical.files[0].included, true);
    assert.equal(groups[0].jobs[0].files[0].included, false);
    assert.equal(transferStage(groups[0].physical).key, "downloading");
    assert.equal(transferStage({ ...groups[0].physical, downloadRole: "waiting" }).key, "queued");
});
