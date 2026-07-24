import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parse } from "yaml";

test("deployment scripts reject unvalidated SSH commands before sudo", () => {
  for (const command of [
    "deploy 1.2.0 not-a-sha",
    "deploy 1.2.0 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa extra",
    "status 1.2 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "shell 1.2.0 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ]) {
    const result = spawnSync("bash", ["ops/watchpair-ci-gate"], {
      env: { ...process.env, SSH_ORIGINAL_COMMAND: command },
      encoding: "utf8",
    });
    assert.equal(result.status, 64, command);
    assert.match(result.stderr, /validated WatchPair deployment commands/);
  }
});

test("deployment workflow separates Vienna maintenance and approved manual environments", async () => {
  const workflow = await readFile(".github/workflows/deploy-vps.yml", "utf8");
  const parsed = parse(workflow);
  assert.equal(parsed.on.schedule[0].timezone, "Europe/Vienna");
  assert.ok(parsed.jobs.deploy.steps.length > 5);
  assert.match(workflow, /cron: '7 4 \* \* \*'/);
  assert.match(workflow, /timezone: Europe\/Vienna/);
  assert.match(workflow, /inputs\.approve/);
  assert.match(workflow, /production-vps-scheduled/);
  assert.match(workflow, /production-vps/);
  assert.match(workflow, /status \$VERSION \$REVISION/);
});

test("all GitHub workflow files contain valid YAML", async () => {
  for (const name of ["ci.yml", "deploy-vps.yml", "deployment-image.yml", "release.yml"]) {
    const contents = await readFile(`.github/workflows/${name}`, "utf8");
    assert.doesNotThrow(() => parse(contents), name);
  }
});

test("deployment shell scripts pass syntax validation", () => {
  for (const script of ["ops/watchpair-ci-gate", "ops/watchpair-ci-deploy"]) {
    const result = spawnSync("bash", ["-n", script], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});
