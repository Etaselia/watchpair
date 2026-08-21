import assert from "node:assert/strict";
import test from "node:test";

import { opaqueSeedLeaseId } from "../lib/seed-lease.mjs";

test("seed lease ids are stable per room but reveal no room token", async () => {
  const input = {
    secret: "local-browser-secret",
    tabId: "tab-one",
    roomToken: "ABCD-2345",
    deviceId: "device-one",
    sourceId: "source-one",
  };
  const first = await opaqueSeedLeaseId(input);
  assert.match(first, /^lease-[a-f0-9]{64}$/);
  assert.equal(first.includes(input.roomToken), false);
  assert.equal(await opaqueSeedLeaseId(input), first);
  assert.notEqual(await opaqueSeedLeaseId({ ...input, roomToken: "WXYZ-9876" }), first);
  assert.notEqual(await opaqueSeedLeaseId({ ...input, sourceId: "source-two" }), first);
  assert.notEqual(
    await opaqueSeedLeaseId({ ...input, tabId: "tab-two" }),
    first,
    "two tabs must hold separate server leases so either can leave independently"
  );
});
