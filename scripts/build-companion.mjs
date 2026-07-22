import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "public", "watchpair-companion.zip");
const folder = "WatchPair Companion";

const inputs = [
  ["server.mjs", resolve(root, "agent", "server.mjs")],
  ["package.json", resolve(root, "companion", "package.json")],
  ["package-lock.json", resolve(root, "companion", "package-lock.json")],
  ["install-and-start.cmd", resolve(root, "companion", "install-and-start.cmd")],
  ["install-runtime.ps1", resolve(root, "companion", "install-runtime.ps1")],
  ["start.cmd", resolve(root, "companion", "start.cmd")],
  ["install-and-start.sh", resolve(root, "companion", "install-and-start.sh")],
  ["README.txt", resolve(root, "companion", "README.txt")],
];

const files = {};
for (const [name, source] of inputs) {
  const contents = await readFile(source);
  files[folder + "/" + name] = new Uint8Array(contents);
}

await mkdir(dirname(output), { recursive: true });
await writeFile(output, zipSync(files, { level: 9 }));
