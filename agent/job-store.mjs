import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export function createJsonStore(filePath, { delayMs = 150 } = {}) {
  let timer = null;
  let pendingJson = null;
  let writePromise = Promise.resolve();

  async function load(fallback = []) {
    try {
      return JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return fallback;
      console.warn(`Could not read ${filePath}: ${error.message}`);
      return fallback;
    }
  }

  async function writePending() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pendingJson === null) return writePromise;

    const json = pendingJson;
    pendingJson = null;
    writePromise = writePromise.then(async () => {
      await mkdir(path.dirname(filePath), { recursive: true });
      const temporary = filePath + ".tmp";
      await writeFile(temporary, json, { mode: 0o600 });
      await rename(temporary, filePath);
    }).catch((error) => {
      console.warn(`Could not persist ${filePath}: ${error.message}`);
    });
    return writePromise;
  }

  function schedule(value) {
    pendingJson = JSON.stringify(value, null, 2);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void writePending(), delayMs);
    timer.unref?.();
  }

  return {
    load,
    schedule,
    flush: writePending,
  };
}
