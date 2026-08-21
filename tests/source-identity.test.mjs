import assert from "node:assert/strict";
import test from "node:test";

import {
  agentJobMatchesSourceIdentity,
  publishedMagnetRoomSourceId,
  sharedSourceIdentity,
} from "../lib/source-identity.mjs";

test("source identities normalize magnets and direct URLs without exposing values", async () => {
  const firstMagnet = "magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&dn=one";
  const aliasMagnet = "magnet:?dn=two&xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&tr=udp%3A%2F%2Ftracker.example";
  const differentMagnet = "magnet:?xt=urn:btih:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  assert.equal(await sharedSourceIdentity("magnet", firstMagnet), await sharedSourceIdentity("magnet", aliasMagnet));
  assert.notEqual(await sharedSourceIdentity("magnet", firstMagnet), await sharedSourceIdentity("magnet", differentMagnet));
  assert.equal(
    await sharedSourceIdentity("direct", "https://MEDIA.example:443/folder/../video.mp4"),
    await sharedSourceIdentity("direct", "https://media.example/video.mp4")
  );
  assert.notEqual(
    await sharedSourceIdentity("direct", "https://media.example/video.mp4"),
    await sharedSourceIdentity("direct", "https://media.example/other.mp4")
  );
});

test("published torrents bind to the source id retained by room deduplication", () => {
  const published = "magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&dn=new";
  const sources = [{
    id: "existing-source",
    kind: "magnet",
    value: "magnet:?dn=old&xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  }];
  assert.equal(
    publishedMagnetRoomSourceId(sources, "new-source", published),
    "existing-source"
  );
  assert.equal(
    publishedMagnetRoomSourceId(
      [...sources, { id: "new-source", kind: "magnet", value: published }],
      "new-source",
      published
    ),
    "new-source"
  );
  assert.equal(
    publishedMagnetRoomSourceId(sources, "new-source", "magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    null
  );
});

test("same public source ids never make different or unproven media reusable", async () => {
  const expectedMagnet = await sharedSourceIdentity(
    "magnet",
    "magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  );
  const otherMagnet = await sharedSourceIdentity(
    "magnet",
    "magnet:?xt=urn:btih:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
  );
  assert.equal(
    agentJobMatchesSourceIdentity(
      { id: "shared-source-id", sourceIdentity: expectedMagnet },
      expectedMagnet
    ),
    true
  );
  assert.equal(
    agentJobMatchesSourceIdentity(
      { id: "shared-source-id", sourceIdentity: otherMagnet },
      expectedMagnet
    ),
    false
  );
  assert.equal(
    agentJobMatchesSourceIdentity({ id: "shared-source-id" }, expectedMagnet),
    false
  );

  const expectedDirect = await sharedSourceIdentity("direct", "https://media.example/one.mp4");
  const otherDirect = await sharedSourceIdentity("direct", "https://media.example/two.mp4");
  assert.equal(
    agentJobMatchesSourceIdentity(
      { id: "same-direct-id", sourceIdentity: otherDirect },
      expectedDirect
    ),
    false
  );
});
