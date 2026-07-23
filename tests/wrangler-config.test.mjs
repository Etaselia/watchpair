import assert from "node:assert/strict";
import test from "node:test";
import { createWranglerConfig } from "../scripts/write-wrangler-config.mjs";

const DATABASE_ID = "12345678-1234-4123-8123-123456789abc";

test("creates a production Worker config with durable room storage", () => {
  const config = createWranglerConfig({
    databaseId: DATABASE_ID,
    workerName: "watchpair-production",
  });

  assert.equal(config.name, "watchpair-production");
  assert.equal(config.d1_databases[0].binding, "DB");
  assert.equal(config.d1_databases[0].database_id, DATABASE_ID);
  assert.equal(config.assets.binding, "ASSETS");
});

test("rejects invalid deployment identifiers", () => {
  assert.throws(
    () => createWranglerConfig({ databaseId: "not-a-uuid" }),
    /Cloudflare D1 UUID/
  );
  assert.throws(
    () =>
      createWranglerConfig({
        databaseId: DATABASE_ID,
        workerName: "Invalid Worker Name",
      }),
    /valid Cloudflare Worker name/
  );
});
