import "dotenv/config";
import { loadConfig } from "./config.js";
import { firebase } from "./firebase.js";
import { createApp } from "./app.js";
const config = loadConfig();
const service = createApp(config, firebase(config.FIREBASE_PROJECT_ID));
service.http.listen(config.PORT, "0.0.0.0", () =>
  service.log.info({ event: "listening", port: config.PORT }),
);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  const timeout = setTimeout(() => process.exit(1), 10000);
  timeout.unref();
  await service.close();
  clearTimeout(timeout);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
