import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DATABASE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKER_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function createWranglerConfig({
  databaseId,
  workerName = "watchpair",
  compatibilityDate = "2026-07-23",
}) {
  if (!DATABASE_ID_PATTERN.test(databaseId ?? "")) {
    throw new Error("WATCHPAIR_D1_DATABASE_ID must be a Cloudflare D1 UUID.");
  }
  if (!WORKER_NAME_PATTERN.test(workerName)) {
    throw new Error("WATCHPAIR_WORKER_NAME must be a valid Cloudflare Worker name.");
  }

  return {
    $schema: "node_modules/wrangler/config-schema.json",
    name: workerName,
    compatibility_date: compatibilityDate,
    compatibility_flags: ["nodejs_compat"],
    main: "./worker/index.ts",
    assets: {
      directory: "dist/client",
      not_found_handling: "none",
      binding: "ASSETS",
    },
    images: { binding: "IMAGES" },
    d1_databases: [
      {
        binding: "DB",
        database_name: "watchpair",
        database_id: databaseId,
      },
    ],
    observability: { enabled: true },
  };
}

async function main() {
  const config = createWranglerConfig({
    databaseId: process.env.WATCHPAIR_D1_DATABASE_ID,
    workerName: process.env.WATCHPAIR_WORKER_NAME || "watchpair",
  });
  await writeFile("wrangler.jsonc", `${JSON.stringify(config, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
