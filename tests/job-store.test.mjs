import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJsonStore } from "../agent/job-store.mjs";

test("job manifest replacement retries Windows locks while preserving the previous manifest", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-job-store-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "jobs.json");
  await writeFile(target, JSON.stringify([{ id: "previous-download" }]));
  let attempts = 0;
  const store = createJsonStore(target, { renameFile: async (temporary, destination) => {
    attempts += 1;
    if (attempts <= 3) {
      assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), [{ id: "previous-download" }]);
      throw Object.assign(new Error("Temporarily locked"), { code: ["EPERM", "EACCES", "EBUSY"][attempts - 1] });
    }
    return rename(temporary, destination);
  } });
  store.schedule([{ id: "recovered-download", storageId: "alternate-folder" }]);
  const writing = store.flush();
  store.schedule([{ id: "newer-selection", downloadFileIndexes: [] }]);
  await Promise.all([writing, store.flush()]);
  assert.equal(attempts, 5);
  assert.deepEqual(await store.load(), [{ id: "newer-selection", downloadFileIndexes: [] }]);
});

test("job manifest replacement does not remove the previous manifest on a permanent failure", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-job-store-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "jobs.json");
  await writeFile(target, JSON.stringify([{ id: "previous-download" }]));
  const warnings = context.mock.method(console, "warn", () => {});
  let attempts = 0;
  const store = createJsonStore(target, { renameFile: async () => {
    attempts += 1;
    throw Object.assign(new Error("Storage failure"), { code: "EIO" });
  } });
  store.schedule([{ id: "new-download" }]);
  await store.flush();
  assert.equal(attempts, 1);
  assert.equal(warnings.mock.callCount(), 1);
  assert.deepEqual(await store.load(), [{ id: "previous-download" }]);
});
