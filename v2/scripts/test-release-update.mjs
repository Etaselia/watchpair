// Private loopback fixture for the real signed-update/installer acceptance test.
// No package, capability or private signing key is sent to an external service.
import { createServer } from 'node:http';
import { createReadStream, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const [key, archiveArg, testArg, baselineArg, candidateArg, logArg] = process.argv.slice(2);
if (!logArg) throw new Error('Usage: test-release-update.mjs KEY.pem ARCHIVE TEST_BINARY BASELINE_BUNDLE CANDIDATE_BUNDLE LOG.txt');
const archive = resolve(archiveArg);
const name = encodeURIComponent(basename(archive));
const metadata = JSON.parse(readFileSync(archive + '.json', 'utf8'));
const temporary = mkdtempSync(join(tmpdir(), 'watchpair-release-fixture-'));
let envelope;
const server = createServer((request, response) => {
  if (request.method !== 'GET') { response.writeHead(405).end(); return; }
  if (request.url === '/release.json') {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': envelope.length });
    response.end(envelope);
  } else if (request.url === '/' + name) {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': metadata.size });
    const stream = createReadStream(archive);
    stream.on('error', () => response.destroy());
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  } else response.writeHead(404).end();
});
try {
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const base = `http://127.0.0.1:${server.address().port}/`;
  const feed = join(temporary, 'release.json');
  execFileSync(process.execPath, [fileURLToPath(new URL('./sign-release.mjs', import.meta.url)), 'sign', resolve(key), base, feed, archive], { stdio: 'pipe', windowsHide: true });
  envelope = readFileSync(feed);
  // This harness exercises transport and staging. Run graphical installed-app
  // launch/recovery separately, without inheriting a hidden console's startup
  // state from the Node server process on Windows.
  const child = spawn(resolve(testArg), ['signedFeedDownloadsVerifiesAndStagesTheRealPackage', '-o', resolve(logArg) + ',txt'], {
    windowsHide: true, stdio: 'inherit',
    env: { ...process.env, WATCHPAIR_UPDATE_TEST_FEED: base + 'release.json',
      WATCHPAIR_PREVIOUS_PACKAGE: resolve(baselineArg), WATCHPAIR_PACKAGE: resolve(candidateArg) }
  });
  const timer = setTimeout(() => child.kill(), 180_000);
  process.exitCode = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', (code) => accept(code ?? 1)); });
  clearTimeout(timer);
} finally {
  server.closeAllConnections();
  await new Promise(accept => server.close(accept));
  rmSync(temporary, { recursive: true, force: true });
}
