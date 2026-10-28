import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import TrackerServer from "bittorrent-tracker/server";
import WebTorrent from "webtorrent";
import { terminateChildProcess } from "./process-helpers.mjs";
import { handleSessionApi } from "../worker/session-api.ts";

test("companion downloads chosen nested seasons, preserves an empty selection on restart, and skips extras", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-folder-selection-"));
  const tracker = new TrackerServer({ udp: false, ws: false, stats: false });
  const seeder = new WebTorrent({ dht: false, lsd: false, natUpnp: false, natPmp: false, utp: false });
  let child;
  let output = "";
  let roomBase = "";
  const roomApi = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const result = await handleSessionApi(new Request(roomBase + request.url, {
      method: request.method, headers: { "content-type": "application/json" },
      ...(request.method === "POST" ? { body: Buffer.concat(chunks).toString() } : {}),
    }));
    response.writeHead(result.status, { "content-type": "application/json" });
    response.end(await result.text());
  });
  const id = "multifolder-selection";
  try {
    await new Promise(resolve => roomApi.listen(0, "127.0.0.1", resolve));
    roomBase = `http://127.0.0.1:${roomApi.address().port}`;
    const inputs = ["Season 1/Episode 1.mkv", "Season 2/Episode 1.mkv", "Bonus/Interview.mkv",
      ...Array.from({ length: 45 }, (_, index) => `Other Seasons/Season ${index + 3}/Episode 1.mkv`)];
    const seedDirectory = path.join(directory, "Show");
    const bytes = inputs.map((_, index) => randomBytes(index < 3 ? 1024 * 1024 : 64 * 1024));
    for (let index = 0; index < inputs.length; index++) {
      const file = path.join(seedDirectory, inputs[index]);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes[index]);
    }
    await new Promise((resolve, reject) => { tracker.once("error", reject); tracker.listen(0, "127.0.0.1", resolve); });
    const torrent = await new Promise((resolve, reject) => {
      const seeded = seeder.seed(seedDirectory, {
        announce: [`http://127.0.0.1:${tracker.http.address().port}/announce`], pieceLength: 64 * 1024,
      }, resolve);
      seeded.once("error", reject);
    });
    const portServer = createServer();
    await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
    const port = portServer.address().port;
    await new Promise((resolve) => portServer.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    const start = async () => {
      child = spawn(process.execPath, ["agent/server.mjs"], {
        cwd: new URL("../", import.meta.url), windowsHide: true,
        env: { ...process.env, WATCHPAIR_AGENT_PORT: String(port), WATCHPAIR_TORRENT_PORT: "0",
          WATCHPAIR_DOWNLOAD_DIR: path.join(directory, "downloads"), WATCHPAIR_CONFIG_PATH: path.join(directory, "companion.json"),
          WATCHPAIR_CLEANUP_ENABLED: "0", WATCHPAIR_TRANSCODER: "cpu", WATCHPAIR_CONTROL_TOKEN: "test-desktop-control", WATCHPAIR_ORIGINS: roomBase },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (data) => { output += data; });
      child.stderr.on("data", (data) => { output += data; });
      await until(async () => (await fetch(base + "/health").then((response) => response.json())).ok);
    };
    const post = async (route, body) => {
      const response = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.ok(response.ok, await response.clone().text());
      return response.json();
    };
    const job = async () => (await fetch(base + "/downloads/" + id).then((response) => response.json())).job;
    const downloads = path.join(directory, "downloads");
    await mkdir(path.join(downloads, id), { recursive: true });
    await writeFile(path.join(downloads, id, "keep.txt"), "unrelated existing folder");
    await start();
    const source = { id, kind: "magnet", value: torrent.magnetURI, downloadFileIndexes: [] };
    await Promise.all(Array.from({ length: 8 }, () => post("/downloads", { source })));
    await until(async () => (await job())?.files?.length === inputs.length);
    let savedRecord;
    await until(async () => {
      savedRecord = JSON.parse(await readFile(path.join(downloads, ".watchpair-jobs.json"), "utf8"))
        .find((record) => record.id === id);
      return savedRecord?.storageId && savedRecord.storageId !== id;
    });
    const payloadDirectory = path.join(downloads, savedRecord.storageId);
    let snapshot = await job();
    const secondIndex = snapshot.files.find((file) => file.path.includes("Season 2/")).index;
    const firstIndex = snapshot.files.find((file) => file.path.includes("Season 1/")).index;
    const bonusIndex = snapshot.files.find((file) => file.path.includes("Bonus/")).index;
    assert.deepEqual(snapshot.downloadFileIndexes, []);
    assert.ok(snapshot.files.every((file) => file.downloaded === 0));
    await post(`/downloads/${id}/selection`, { fileIndexes: [secondIndex] });
    // A stale priority plan must not override the persisted allowlist.
    await post("/media-priority", { selected: { jobId: id, fileIndex: secondIndex },
      targets: snapshot.files.map((file) => ({ jobId: id, fileIndex: file.index })) });
    await until(async () => (await job()).files[secondIndex].downloadReady);
    snapshot = await job();
    assert.equal(snapshot.files[firstIndex].downloaded, 0);
    assert.equal(snapshot.files[bonusIndex].downloaded, 0);
    assert.deepEqual(await readFile(path.join(payloadDirectory, snapshot.files[secondIndex].path)), bytes[1]);
    await post(`/downloads/${id}/selection`, { fileIndexes: [] });
    const watchedPriority = await post("/media-priority", {
      selected: { jobId: id, fileIndex: secondIndex },
      targets: snapshot.files.map((file) => ({ jobId: id, fileIndex: file.index })),
      selections: [{ jobId: id, fileIndexes: [] }],
    });
    assert.deepEqual(watchedPriority.targets.map((target) => target.fileIndex), [secondIndex]);
    snapshot = await job();
    assert.deepEqual(snapshot.downloadFileIndexes, []);
    assert.equal(snapshot.files[firstIndex].downloaded, 0);
    assert.equal(snapshot.files[bonusIndex].downloaded, 0);
    await post("/media-priority", { selected: null, targets: [] });
    await post(`/downloads/${id}/retry`, {});
    await until(async () => (await job())?.files?.length === inputs.length);
    assert.deepEqual((await job()).downloadFileIndexes, [], "retry preserves the empty allowlist");
    await until(async () => {
      const saved = JSON.parse(await readFile(path.join(directory, "downloads", ".watchpair-jobs.json"), "utf8"));
      return saved.some((entry) => entry.id === id && Array.isArray(entry.downloadFileIndexes) && entry.downloadFileIndexes.length === 0);
    });
    await terminateChildProcess(child);
    await start();
    await until(async () => (await job())?.files?.length === inputs.length);
    snapshot = await job();
    assert.deepEqual(snapshot.downloadFileIndexes, []);
    assert.equal(snapshot.files[firstIndex].downloaded, 0);
    assert.equal(snapshot.files[bonusIndex].downloaded, 0);
    // With no priority plan after restart, only the newly included season may run.
    await post(`/downloads/${id}/selection`, { fileIndexes: [firstIndex] });
    await until(async () => (await job()).files[firstIndex].downloadReady);
    snapshot = await job();
    assert.equal(snapshot.files[bonusIndex].downloaded, 0);
    assert.deepEqual(await readFile(path.join(payloadDirectory, snapshot.files[firstIndex].path)), bytes[0]);
    // Losing the job record must not force a fresh tree or redownload of a season pack.
    const removed = await fetch(`${base}/downloads/${id}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    const reusedFile = path.join(payloadDirectory, snapshot.files[firstIndex].path);
    const reusedMtime = (await stat(reusedFile)).mtimeMs;
    const markerPath = path.join(payloadDirectory, ".watchpair-owned.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    delete marker.sourceIdentity; // Ownership marker from companions before this fix.
    await writeFile(markerPath, JSON.stringify(marker));
    await post("/downloads", { source });
    await until(async () => (await job())?.files?.length === inputs.length);
    await post(`/downloads/${id}/selection`, { fileIndexes: [firstIndex] });
    await until(async () => (await job()).files[firstIndex].downloadReady);
    snapshot = await job();
    assert.equal(snapshot.files[bonusIndex].downloaded, 0);
    assert.deepEqual(await readFile(path.join(payloadDirectory, snapshot.files[firstIndex].path)), bytes[0]);
    assert.equal((await stat(reusedFile)).mtimeMs, reusedMtime, "recovery verifies existing bytes without rewriting them");
    assert.equal(JSON.parse(await readFile(markerPath, "utf8")).token, marker.token,
      "legacy recovery retains the original managed tree and ownership token");
    assert.match(JSON.parse(await readFile(markerPath, "utf8")).sourceIdentity, /^[a-f0-9]{64}$/);
    const aliasIds = ["shared-season-pack", "shared-season-pack-two", "shared-season-pack-three"];
    const aliased = await Promise.all(aliasIds.map((aliasId) => post("/downloads", {
      source: { ...source, id: aliasId },
    })));
    for (const [index, result] of aliased.entries()) {
      assert.equal(result.job.id, aliasIds[index]);
      assert.equal(result.job.sharedTransferId, id);
      assert.equal(result.job.files.length, inputs.length);
      assert.ok(result.job.files.every((file) => file.itemId === `${aliasIds[index]}-f${file.index}`),
        "shared transfer file identities belong to the requesting room source");
      assert.deepEqual(result.job.downloadFileIndexes, []);
      await assert.rejects(stat(path.join(downloads, aliasIds[index])), { code: "ENOENT" });
    }
    assert.deepEqual((await job()).downloadFileIndexes, [firstIndex], "metadata-only aliases preserve existing choices");
    const aliasId = aliasIds[0];
    await post(`/downloads/${aliasId}/selection`, { fileIndexes: [secondIndex] });
    assert.deepEqual((await job()).downloadFileIndexes, [firstIndex], "each room keeps its own selection");
    const aliasPriority = await post("/media-priority", {
      selected: { jobId: aliasId, fileIndex: secondIndex },
      targets: [{ jobId: aliasId, fileIndex: secondIndex }, { jobId: id, fileIndex: secondIndex }],
      selections: [{ jobId: aliasId, fileIndexes: [secondIndex] }, { jobId: id, fileIndexes: [] }],
    });
    assert.equal(aliasPriority.targets.length, 1, "shared files occupy one priority slot");
    assert.equal((await post(`/downloads/${aliasId}/retry`, {})).job.id, aliasId);
    await until(async () => (await job())?.files?.length === inputs.length);
    await until(async () => {
      const saved = JSON.parse(await readFile(path.join(downloads, ".watchpair-jobs.json"), "utf8"));
      const bindings = saved.find((record) => record.id === id)?.downloadBindings;
      return bindings?.some((binding) => binding.id === aliasId && binding.fileIndexes?.includes(secondIndex)) &&
        bindings.some((binding) => binding.id === id && binding.fileIndexes?.length === 0);
    });
    await terminateChildProcess(child);
    const recordsBeforeRestart = JSON.parse(await readFile(path.join(downloads, ".watchpair-jobs.json"), "utf8"));
    const legacyId = "legacy-duplicate-record";
    const legacyDirectory = path.join(downloads, legacyId);
    const legacyToken = randomUUID();
    await mkdir(legacyDirectory);
    await writeFile(path.join(legacyDirectory, ".watchpair-owned.json"), JSON.stringify({ version: 1, id: legacyId, token: legacyToken }));
    await writeFile(path.join(legacyDirectory, "keep.txt"), "preserved old duplicate folder");
    const legacyDuplicate = { ...recordsBeforeRestart[0], id: legacyId, storageId: legacyId,
      ownershipToken: legacyToken, downloaded: 0, downloadFileIndexes: [],
      torrentVerifiedKeys: null, torrentVerifiedKey: null, identityFingerprint: null };
    delete legacyDuplicate.downloadBindings;
    await writeFile(path.join(downloads, ".watchpair-jobs.json"), JSON.stringify([legacyDuplicate, ...recordsBeforeRestart]));
    aliasIds.push(legacyId);
    await start();
    const aliasJob = async (key = aliasId) => (await fetch(`${base}/downloads/${key}`).then((response) => response.json())).job;
    await until(async () => (await aliasJob())?.files[secondIndex]?.downloadReady);
    assert.equal((await aliasJob(legacyId)).sharedTransferId, id, "old duplicate records recover onto the existing transfer");
    assert.deepEqual((await aliasJob()).downloadFileIndexes, [secondIndex]);
    assert.deepEqual((await job()).downloadFileIndexes, []);
    assert.equal((await fetch(`${base}/downloads/${id}?deleteFiles=1`, { method: "DELETE" })).status, 200);
    assert.equal((await fetch(`${base}/downloads/${id}`)).status, 404);
    assert.deepEqual(await readFile(reusedFile), bytes[0], "removing one room must preserve shared files");
    const conflictingHiddenId = await fetch(`${base}/downloads`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ source: {
        ...source, value: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
      } }),
    });
    assert.equal(conflictingHiddenId.status, 400, "a detached physical id cannot overwrite an active shared transfer");
    await until(async () => {
      const saved = JSON.parse(await readFile(path.join(downloads, ".watchpair-jobs.json"), "utf8"));
      const bindings = saved.find((record) => record.id === id)?.downloadBindings;
      return bindings?.length === aliasIds.length && !bindings.some((binding) => binding.id === id);
    });
    await terminateChildProcess(child);
    await start();
    await until(async () => (await aliasJob())?.files?.length === inputs.length);
    assert.equal((await fetch(`${base}/downloads/${id}`)).status, 404, "detached source stays detached after restart");
    assert.deepEqual(await readFile(reusedFile), bytes[0]);
    for (const key of aliasIds.slice(1)) {
      assert.equal((await fetch(`${base}/downloads/${key}?deleteFiles=1`, { method: "DELETE" })).status, 200);
    }
    assert.deepEqual(await readFile(reusedFile), bytes[0]);
    assert.equal((await fetch(`${base}/downloads/${aliasId}?deleteFiles=1`, { method: "DELETE" })).status, 200);
    await assert.rejects(stat(payloadDirectory), { code: "ENOENT" });
    assert.equal(await readFile(path.join(legacyDirectory, "keep.txt"), "utf8"), "preserved old duplicate folder");
    const simultaneousIds = ["simultaneous-add-one", "simultaneous-add-two", "simultaneous-add-three"];
    const simultaneous = await Promise.all(simultaneousIds.map((key) => post("/downloads", { source: { ...source, id: key } })));
    assert.equal(new Set(simultaneous.map((result) => result.job.sharedTransferId)).size, 1,
      "concurrent different room IDs share one physical transfer");
    await until(async () => (await Promise.all(simultaneousIds.map(aliasJob)))
      .every((candidate) => candidate?.files?.length === inputs.length && !candidate.error));
    const control = async body => {
      const response = await fetch(base + "/control/transfers", {method:"POST",headers:{"content-type":"application/json","x-watchpair-control":"test-desktop-control"},body:JSON.stringify(body)});
      assert.equal(response.status,200,await response.clone().text());
      return response.json();
    };
    assert.equal((await fetch(base + "/control/transfers")).status,403,"desktop commands require the native control token");
    const desktopId=simultaneousIds[0];
    await control({command:"selection",id:desktopId,fileIndexes:[firstIndex],priorities:{[firstIndex]:"high"}});
    await post(`/downloads/${desktopId}/selection`,{fileIndexes:[]});
    assert.deepEqual((await aliasJob(desktopId)).downloadFileIndexes,[firstIndex],"browser updates cannot overwrite a manual local selection");
    await control({command:"limits",downloadLimit:1024*1024,uploadLimit:128*1024,maxActiveDownloads:2,queueMode:"manual"});
    await control({command:"pause",id:desktopId});
    assert.equal((await aliasJob(desktopId)).files.length,inputs.length,"paused transfers retain their file tree");
    assert.equal((await post(`/downloads/${desktopId}/resume`,{})).job.paused,true,"browser cannot undo manual pause");
    await terminateChildProcess(child);
    await start();
    assert.equal((await aliasJob(desktopId)).manualPaused,true);
    assert.equal((await aliasJob(desktopId)).files.length,inputs.length);
    await control({command:"resume",id:desktopId});
    await until(async()=>(await aliasJob(desktopId)).files[firstIndex]?.downloadReady);
    assert.deepEqual((await aliasJob(desktopId)).downloadFileIndexes,[firstIndex]);
    const restoredControls=await fetch(base+"/control/transfers",{headers:{"x-watchpair-control":"test-desktop-control"}}).then(response=>response.json());
    assert.equal(restoredControls.controls.downloadLimit,1024*1024);
    await control({command:"follow-room",id:desktopId});
    await post(`/downloads/${desktopId}/selection`,{fileIndexes:[]});
    assert.deepEqual((await aliasJob(desktopId)).downloadFileIndexes,[]);
    let roomToken;
    const roomRequest = async (action, fields = {}) => {
      const response = await fetch(roomBase + "/api/sessions", {method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({action,token:roomToken,deviceId:"desktop-host",name:"Host",...fields})});
      assert.ok(response.ok,await response.clone().text());
      return response.json();
    };
    roomToken=(await roomRequest("create")).session.token;
    const roomSourceId="room-existing-pack";
    await roomRequest("source",{source:{...source,id:roomSourceId}});
    const connected=await fetch(base+"/room-context",{method:"POST",headers:{"content-type":"application/json",origin:roomBase},
      body:JSON.stringify({token:roomToken,deviceId:"desktop-host"})}).then(response=>response.json());
    await control({command:"selection",id:desktopId,roomId:connected.id,fileIndexes:[secondIndex],priorities:{[secondIndex]:"high"}});
    const synchronized=(await roomRequest("heartbeat")).session.sources[0];
    assert.equal(synchronized.id,roomSourceId,"host choices reuse the room's torrent identity");
    assert.deepEqual(synchronized.selectedFileIndexes,[secondIndex]);
    assert.deepEqual((await aliasJob(roomSourceId)).downloadFileIndexes,[secondIndex]);
    assert.equal((await fetch(`${base}/downloads/${roomSourceId}`,{method:"DELETE"})).status,200);
    for (const key of simultaneousIds) {
      assert.equal((await fetch(`${base}/downloads/${key}?deleteFiles=1`, { method: "DELETE" })).status, 200);
    }
    assert.equal(await readFile(path.join(downloads, id, "keep.txt"), "utf8"), "unrelated existing folder");
  } catch (error) {
    throw new Error(`${error.message}\n${output.slice(-6000)}`, { cause: error });
  } finally {
    await terminateChildProcess(child);
    await new Promise((resolve) => seeder.destroy(resolve));
    await new Promise((resolve) => tracker.close(resolve));
    if (roomApi.listening) await new Promise(resolve => roomApi.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

async function until(check, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { /* The service or metadata is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for companion file selection.");
}
