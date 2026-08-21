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

function runAutomaticReleaseResolver(script, environment = {}) {
  const workflowRunScript = script
    .replaceAll("${{ github.event_name }}", "workflow_run")
    .replaceAll("${{ inputs.approve }}", "false");
  const harness = [
    "gh() {",
    "  case \"$*\" in",
    "    *\"/actions/runs/\"*)",
    "      printf '%s\\n' \"$MOCK_RELEASE_JOBS\"",
    "      return \"${MOCK_RELEASE_JOBS_STATUS:-0}\"",
    "      ;;",
    "    *\"/releases?per_page=100\"*)",
    "      printf '%s\\n' \"$MOCK_RELEASES\"",
    "      return \"${MOCK_RELEASES_STATUS:-0}\"",
    "      ;;",
    "    *)",
    "      echo \"Unexpected gh call: $*\" >&2",
    "      return 70",
    "      ;;",
    "  esac",
    "}",
    workflowRunScript,
  ].join("\n");

  return spawnSync(bash, bashArguments(["-s"]), {
    env: {
      ...process.env,
      GITHUB_OUTPUT: "/dev/null",
      GITHUB_REPOSITORY: "Etaselia/watchpair",
      RELEASE_SHA: "a".repeat(40),
      RELEASE_RUN_ID: "1234",
      RELEASE_RUN_ATTEMPT: "2",
      REQUESTED_VERSION: "",
      MOCK_RELEASE_JOBS: "{}",
      MOCK_RELEASES: "[]",
      ...environment,
    },
    input: harness,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
}

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
  assert.match(workflow, /github\.event_name.*schedule[\s\S]*releases\/latest/);
  assert.doesNotMatch(workflow, /\^v\?\[0-9\]\+\\\.\[0-9\]\+\\\.0\$/);
  assert.equal(
    parsed.jobs.deploy.environment.name,
    "${{ github.event_name == 'workflow_dispatch' && 'production-vps' || 'production-vps-scheduled' }}",
  );
});

test("trusted successful releases deploy only the stable tag for their exact commit", async () => {
  const workflow = await readFile(".github/workflows/deploy-vps.yml", "utf8");
  const parsed = parse(workflow);
  const resolveJob = parsed.jobs.resolve;
  const deployJob = parsed.jobs.deploy;
  const releaseStep = resolveJob.steps.find(({ id }) => id === "release");
  const sourceStep = parsed.jobs.deploy.steps.find(({ id }) => id === "source");

  assert.deepEqual(parsed.on.workflow_run, {
    workflows: ["Release"],
    types: ["completed"],
    branches: ["main"],
  });
  assert.match(parsed["run-name"], /github\.event\.workflow_run\.id/);
  assert.match(parsed["run-name"], /github\.event\.workflow_run\.run_attempt/);
  assert.match(parsed["run-name"], /github\.event\.workflow_run\.head_sha/);
  assert.equal(parsed.permissions.contents, "read");
  assert.equal(resolveJob.permissions.actions, "read");
  assert.equal(resolveJob.permissions.contents, "read");
  assert.equal(resolveJob.environment, undefined);
  assert.doesNotMatch(JSON.stringify(resolveJob), /secrets\./);
  assert.equal(resolveJob.outputs.eligible, "${{ steps.release.outputs.eligible }}");
  assert.equal(resolveJob.outputs.tag, "${{ steps.release.outputs.tag }}");
  assert.equal(resolveJob.outputs.version, "${{ steps.release.outputs.version }}");
  assert.equal(deployJob.needs, "resolve");
  assert.equal(deployJob.if, "needs.resolve.outputs.eligible == 'true'");
  assert.equal(deployJob.permissions.contents, "read");
  assert.equal(
    deployJob.steps.find(({ uses }) => uses?.startsWith("actions/checkout@"))?.with.ref,
    "${{ needs.resolve.outputs.tag }}",
  );
  assert.match(JSON.stringify(deployJob), /needs\.resolve\.outputs\.version/);
  assert.doesNotMatch(JSON.stringify(deployJob), /steps\.release\.outputs/);
  assert.match(resolveJob.if, /github\.event_name != 'workflow_run'/);
  assert.match(
    resolveJob.if,
    /github\.event\.workflow_run\.conclusion == 'success'/,
  );
  assert.match(
    resolveJob.if,
    /github\.event\.workflow_run\.event == 'push'/,
  );
  assert.match(
    resolveJob.if,
    /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/,
  );
  assert.match(
    resolveJob.if,
    /github\.event\.workflow_run\.head_branch == 'main'/,
  );
  assert.match(releaseStep.run, /github\.event_name \}\}" == "workflow_run"/);
  assert.equal(
    releaseStep.env.RELEASE_SHA,
    "${{ github.event.workflow_run.head_sha }}",
  );
  assert.equal(
    releaseStep.env.RELEASE_RUN_ID,
    "${{ github.event.workflow_run.id }}",
  );
  assert.equal(
    releaseStep.env.RELEASE_RUN_ATTEMPT,
    "${{ github.event.workflow_run.run_attempt }}",
  );

  const automaticRelease = releaseStep.run.indexOf('== "workflow_run"');
  const manualApproval = releaseStep.run.indexOf("inputs.approve");
  assert.ok(automaticRelease >= 0);
  assert.ok(manualApproval > automaticRelease);

  const automaticScript = releaseStep.run.slice(automaticRelease, manualApproval);
  const jobsLookup = automaticScript.indexOf(
    "actions/runs/$RELEASE_RUN_ID/attempts/$RELEASE_RUN_ATTEMPT/jobs?per_page=100",
  );
  const releasesLookup = automaticScript.indexOf("releases?per_page=100");
  assert.ok(jobsLookup >= 0);
  assert.ok(releasesLookup > jobsLookup);
  const attemptAttestation = automaticScript.slice(jobsLookup, releasesLookup);
  assert.match(attemptAttestation, /if ! release_jobs_ready=\$\(/);
  assert.match(attemptAttestation, /echo "eligible=false"/);
  assert.match(attemptAttestation, /exit 0/);
  for (const jobName of [
    "Publish release artifacts",
    "Publish Windows companion",
    "Publish Linux companion",
  ]) {
    assert.match(automaticScript, new RegExp(`"${jobName}"`));
  }
  assert.match(automaticScript, /\.conclusion == "success"/);
  assert.match(
    automaticScript,
    /--arg sha "\$RELEASE_SHA"/,
  );
  assert.match(
    automaticScript,
    /select\(\s*\.draft == false and\s*\.prerelease == false and\s*\.target_commitish == \$sha/,
  );
  assert.match(
    automaticScript,
    /test\("\^v\?\[0-9\]\+\\\\\.\[0-9\]\+\\\\\.\[0-9\]\+\$"\)/,
  );
  assert.match(automaticScript, /echo "eligible=false"/);
  assert.match(automaticScript, /exit 0/);
  assert.match(
    automaticScript,
    /Multiple stable semantic releases target the completed release workflow commit/,
  );
  assert.match(automaticScript, /if ! releases_json=\$\(gh api --paginate/);
  assert.match(automaticScript, /if ! matching_tags=\$\(/);
  assert.match(
    automaticScript,
    /if ! release_jobs_json=\$\(gh api --paginate/,
  );
  assert.doesNotMatch(automaticScript, /\|\| true/);
  assert.doesNotMatch(automaticScript, /releases\/latest/);

  const checkoutIndex = parsed.jobs.deploy.steps.findIndex(({ uses }) =>
    uses?.startsWith("actions/checkout@"));
  const sourceIndex = parsed.jobs.deploy.steps.indexOf(sourceStep);
  const deployKeyIndex = parsed.jobs.deploy.steps.findIndex(
    ({ name }) => name === "Configure deployment key",
  );
  assert.ok(checkoutIndex >= 0);
  assert.ok(sourceIndex > checkoutIndex);
  assert.ok(deployKeyIndex > sourceIndex);
  assert.equal(
    sourceStep.env.EXPECTED_RELEASE_SHA,
    "${{ github.event.workflow_run.head_sha }}",
  );
  assert.match(sourceStep.run, /"\$sha" != "\$EXPECTED_RELEASE_SHA"/);
  assert.match(sourceStep.run, /exit 64/);
});

test("automatic release resolution fails closed without turning a no-match into an error", async () => {
  const parsed = parse(await readFile(".github/workflows/deploy-vps.yml", "utf8"));
  const script = parsed.jobs.resolve.steps.find(({ id }) => id === "release").run;
  const releaseSha = "a".repeat(40);
  const successfulJobs = JSON.stringify({
    jobs: [
      "Publish release artifacts",
      "Publish Windows companion",
      "Publish Linux companion",
    ].map((name) => ({ name, conclusion: "success" })),
  });
  const exactRelease = {
    draft: false,
    prerelease: false,
    target_commitish: releaseSha,
    tag_name: "v0.10.7",
  };

  const exact = runAutomaticReleaseResolver(script, {
    MOCK_RELEASE_JOBS: successfulJobs,
    MOCK_RELEASES: JSON.stringify([exactRelease]),
  });
  assert.equal(exact.status, 0, exact.stderr);
  assert.match(exact.stdout, /Selected WatchPair 0\.10\.7\./);

  const noMatch = runAutomaticReleaseResolver(script, {
    MOCK_RELEASE_JOBS: successfulJobs,
    MOCK_RELEASES: JSON.stringify([{
      ...exactRelease,
      target_commitish: "b".repeat(40),
    }]),
  });
  assert.equal(noMatch.status, 0, noMatch.stderr);
  assert.match(noMatch.stdout, /No stable semantic release targets/);
  assert.doesNotMatch(noMatch.stdout, /Selected WatchPair/);

  const unpublished = runAutomaticReleaseResolver(script, {
    MOCK_RELEASE_JOBS: JSON.stringify({
      jobs: [
        { name: "Publish release artifacts", conclusion: "success" },
        { name: "Publish Windows companion", conclusion: "skipped" },
        { name: "Publish Linux companion", conclusion: "skipped" },
      ],
    }),
    MOCK_RELEASES_STATUS: "9",
  });
  assert.equal(unpublished.status, 0, unpublished.stderr);
  assert.match(unpublished.stdout, /did not publish every release artifact/);

  const duplicate = runAutomaticReleaseResolver(script, {
    MOCK_RELEASE_JOBS: successfulJobs,
    MOCK_RELEASES: JSON.stringify([
      exactRelease,
      { ...exactRelease, tag_name: "v0.10.8" },
    ]),
  });
  assert.equal(duplicate.status, 64, duplicate.stderr);
  assert.match(duplicate.stderr, /Multiple stable semantic releases/);

  const jobsApiFailure = runAutomaticReleaseResolver(script, {
    MOCK_RELEASE_JOBS_STATUS: "9",
  });
  assert.equal(jobsApiFailure.status, 69, jobsApiFailure.stderr);
  assert.match(jobsApiFailure.stderr, /Could not inspect the completed release workflow attempt/);

  const releaseFilterFailure = runAutomaticReleaseResolver(script, {
    MOCK_RELEASE_JOBS: successfulJobs,
    MOCK_RELEASES: "not-json",
  });
  assert.equal(releaseFilterFailure.status, 65, releaseFilterFailure.stderr);
  assert.match(releaseFilterFailure.stderr, /Could not validate repository releases/);
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
