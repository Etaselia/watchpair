import path from "node:path";
import { startProdServer } from "vinext/server/prod-server";

const port = Number.parseInt(process.env.PORT || "3000", 10);

await startProdServer({
  port: Number.isFinite(port) ? port : 3000,
  host: "0.0.0.0",
  outDir: path.resolve("dist"),
});
