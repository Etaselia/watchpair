import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

function deploymentBash() {
  if (process.env.WATCHPAIR_TEST_BASH) return process.env.WATCHPAIR_TEST_BASH;
  if (process.platform !== "win32") return "bash";

  const candidates = [];
  const gitExecPath = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
  if (gitExecPath.status === 0 && gitExecPath.stdout.trim()) {
    candidates.push(path.resolve(gitExecPath.stdout.trim(), "../../..", "bin", "bash.exe"));
  }
  for (const root of [
    process.env.ProgramW6432,
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
  ]) {
    if (root) candidates.push(path.join(root, "Git", "bin", "bash.exe"));
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"));
  }
  return candidates.find((candidate) => existsSync(candidate)) || "bash";
}

const bash = deploymentBash();
const bashArguments = (arguments_) => process.platform === "win32"
  ? ["-l", ...arguments_]
  : arguments_;

test("deployment scripts reject unvalidated SSH commands before sudo", () => {
  for (const command of [
    "deploy 1.2.0 not-a-sha",
    "deploy 1.2.0 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa extra",
    "status 1.2 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "shell 1.2.0 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ]) {
    const result = spawnSync(bash, bashArguments(["ops/watchpair-ci-gate"]), {
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

test("desktop release artifacts use stable names and publish only after packaged tests", async () => {
  const builder = parse(await readFile("electron-builder.yml", "utf8"));
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const workflow = await readFile(".github/workflows/release.yml", "utf8");

  assert.equal(builder.appImage.artifactName, "WatchPair-Companion-Linux-x64.AppImage");
  assert.equal(builder.deb.artifactName, "WatchPair-Companion-Linux-x64.deb");
  assert.ok(builder.deb.depends.includes("libgtk-3-0 | libgtk-3-0t64"));
  assert.ok(builder.deb.recommends.includes("libappindicator3-1 | libayatana-appindicator3-1"));
  for (const script of ["desktop:dist", "desktop:dist:win", "desktop:dist:linux"]) {
    assert.match(packageJson.scripts[script], /--publish never$/, script);
  }

  for (const artifact of [
    "WatchPair-Companion-Windows-x64-Setup.exe",
    "WatchPair-Companion-Linux-x64.AppImage",
    "WatchPair-Companion-Linux-x64.deb",
  ]) {
    assert.ok(workflow.includes(artifact), artifact);
  }
  assert.ok(
    workflow.indexOf("Test packaged Windows client") <
      workflow.indexOf("Attach Windows installer and update metadata"),
  );
  assert.ok(
    workflow.indexOf("Test packaged Linux client") <
      workflow.indexOf("Attach Linux installers and update metadata"),
  );
});

test("deployment shell scripts pass syntax validation", () => {
  for (const script of ["ops/watchpair-ci-gate", "ops/watchpair-ci-deploy"]) {
    const result = spawnSync(bash, bashArguments(["-n", script]), { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});
