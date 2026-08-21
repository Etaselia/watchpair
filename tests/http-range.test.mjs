import assert from "node:assert/strict";
import test from "node:test";
import { parseByteRange } from "../agent/http-range.mjs";

test("parses full, open-ended, bounded, and suffix byte requests", () => {
  assert.equal(parseByteRange(undefined, 1_000), null);
  assert.deepEqual(parseByteRange("bytes=100-", 1_000), { start: 100, end: 999 });
  assert.deepEqual(parseByteRange("bytes=100-199", 1_000), { start: 100, end: 199 });
  assert.deepEqual(parseByteRange("bytes=900-2000", 1_000), { start: 900, end: 999 });
  assert.deepEqual(parseByteRange("bytes=-500", 1_000), { start: 500, end: 999 });
  assert.deepEqual(parseByteRange("bytes=-2000", 1_000), { start: 0, end: 999 });
});

test("rejects unsatisfiable and multiple byte ranges", () => {
  assert.equal(parseByteRange("bytes=1000-", 1_000), false);
  assert.equal(parseByteRange("bytes=500-100", 1_000), false);
  assert.equal(parseByteRange("bytes=-0", 1_000), false);
  assert.equal(parseByteRange("bytes=0-1,4-5", 1_000), false);
  assert.equal(parseByteRange("bytes=-1", 0), false);
  assert.equal(parseByteRange("not-bytes", 1_000), false);
});
