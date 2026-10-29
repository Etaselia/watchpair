// Offline release signing. The private key is read from the explicit file and
// never printed or copied into an application package.
import { createPrivateKey, createPublicKey, sign, generateKeyPairSync, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, createReadStream, statSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args[0] === 'keygen') {
  const directory = resolve(args[1] ?? '');
  if (!args[1]) throw new Error('Pass a new private signing directory');
  mkdirSync(directory, { mode: 0o700 });
  if (process.platform === 'win32') {
    const protect = `$ErrorActionPreference='Stop'; $taskAcl=[Security.AccessControl.DirectorySecurity]::new(); $taskAcl.SetAccessRuleProtection($true,$false); $taskSid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $taskAcl.SetOwner($taskSid); $taskAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($taskSid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')); ([IO.DirectoryInfo]::new($env:WATCHPAIR_SIGNING_DIRECTORY)).SetAccessControl($taskAcl)`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(protect, 'utf16le').toString('base64')],
      { windowsHide: true, env: { ...process.env, WATCHPAIR_SIGNING_DIRECTORY: directory }, stdio: 'pipe' });
  }
  const pair = generateKeyPairSync('ed25519');
  writeFileSync(join(directory, 'release-private.pem'), pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  writeFileSync(join(directory, 'release-public.hex'), publicKey + '\n', { flag: 'wx' });
  console.log(`Public build key: ${publicKey}\nKeep the private PEM offline in ${directory}.`);
} else if (args[0] === 'sign') {
  const [keyPath, baseUrl, output, ...artifacts] = args.slice(1);
  const origin = new URL(baseUrl);
  if (!keyPath || !output || artifacts.length === 0 ||
      (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && origin.hostname === '127.0.0.1')))
    throw new Error('Usage: sign KEY.pem HTTPS_BASE_URL OUTPUT.json PACKAGE.zip [PACKAGE.tar.gz]');
  const key = createPrivateKey(readFileSync(keyPath));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Use an Ed25519 private key');
  const publicKey = createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  const packages = {};
  let version, protocol;
  for (const artifact of artifacts) {
    const metadata = JSON.parse(readFileSync(artifact + '.json', 'utf8'));
    if (version && (version !== metadata.version || protocol !== metadata.protocol)) throw new Error('All platform packages must have the same version/protocol');
    if (packages[metadata.platform]) throw new Error('Duplicate platform package');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(artifact)) hash.update(chunk);
    if (hash.digest('hex') !== metadata.sha256 || statSync(artifact).size !== metadata.size) throw new Error('An archive changed after packaging');
    version = metadata.version; protocol = metadata.protocol;
    packages[metadata.platform] = { size: metadata.size, sha256: metadata.sha256,
      url: new URL(encodeURIComponent(basename(artifact)), baseUrl.endsWith('/') ? baseUrl : baseUrl + '/').href };
  }
  const payload = Buffer.from(JSON.stringify({ format: 1, version, protocol, notes: process.env.WATCHPAIR_RELEASE_NOTES ?? '', artifacts: packages }));
  writeFileSync(output, JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, key).toString('base64') }, null, 2), { flag: 'wx' });
  console.log(`Signed version ${version} for ${Object.keys(packages).join(', ')}. Pinned build key must be ${publicKey}.`);
} else {
  throw new Error('Use keygen or sign');
}
