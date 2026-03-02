import fs from "node:fs";
import path from "node:path";
import { buildServer } from "./server";

const PORT = Number(process.env.PORT ?? 3333);
const DB_PATH =
  process.env.DB_PATH ??
  path.join(process.cwd(), "data", "offline-pos.sqlite");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const app = buildServer({ dbPath: DB_PATH });

app
  .listen({ port: PORT, host: "0.0.0.0" })
  .then((address) => {
    app.log.info(`API listening on ${address}`);
  })
  .catch((err) => {
    app.log.error(err, "Failed to start API");
    process.exit(1);
  });

