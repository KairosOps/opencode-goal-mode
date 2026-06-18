/**
 * Goal Lab — entrypoint. Wires the store, the live error investigator, the
 * orchestrator, and the HTTP/SSE server together and starts listening.
 *
 *   node tools/lab/server/index.mjs
 *
 * Env knobs live in config.mjs (GOAL_LAB_PORT, GOAL_LAB_CONCURRENCY, …).
 */

import { createStore } from "./store.mjs";
import { createOrchestrator } from "./orchestrator.mjs";
import { attachLiveInvestigator, scanRun } from "./incidents.mjs";
import { createApiServer } from "./server.mjs";
import { CONFIG } from "./config.mjs";

const store = createStore();
attachLiveInvestigator(store);
const orchestrator = createOrchestrator(store, { onIncidentScan: (runId) => scanRun(store, runId) });
const server = createApiServer(store, orchestrator);

server.listen(CONFIG.port, CONFIG.host, () => {
  const url = `http://${CONFIG.host}:${CONFIG.port}`;
  console.log(`\n  Goal Lab — agent observatory`);
  console.log(`  ${url}`);
  console.log(`  concurrency=${CONFIG.concurrency}  models=${CONFIG.models.length}  [${CONFIG.models.map((m) => m.split("/").pop()).join(", ")}]\n`);
});

const shutdown = () => {
  console.log("\n  shutting down — aborting active runs…");
  try {
    orchestrator.abortAll();
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(0), 1500);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
