import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function validate(title) {
  return spawnSync(process.execPath, ["scripts/validate-pr-title.mjs"], {
    env: { ...process.env, WATCHPAIR_PR_TITLE: title },
    encoding: "utf8",
  });
}

test("accepts release-compatible pull request titles", () => {
  for (const title of [
    "fix: publish stable desktop artifacts",
    "feat(player)!: replace playback protocol",
    "chore(main): release 0.7.1",
  ]) {
    assert.equal(validate(title).status, 0, title);
  }
});

test("rejects pull request titles Release Please cannot parse", () => {
  const result = validate("Fix stable desktop release publishing");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Conventional Commits/);
});
