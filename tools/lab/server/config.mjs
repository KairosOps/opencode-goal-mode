/**
 * Goal Lab — central configuration.
 *
 * The Lab is a self-contained observatory that drives many concurrent Goal Mode
 * agents against REAL OpenCode servers + REAL free OpenCode Zen models, captures
 * every event and every byte of the guard's on-disk ledger, auto-investigates
 * failures, and serves a dense, monochrome browser UI for mining the data into
 * concrete plugin improvements.
 *
 * Everything here is overridable by environment variable so the same code runs
 * on a laptop (a handful of agents) or a beefy box (the full fan-out).
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** tools/lab root (one level up from server/). */
export const LAB_ROOT = join(__dirname, "..");
/** The published plugin repo root (tools/lab/../..). */
export const REPO_ROOT = join(LAB_ROOT, "..", "..");
/** Static SPA assets. */
export const WEB_ROOT = join(LAB_ROOT, "web");
/** Runtime data (gitignored): per-run event logs + isolated guard state. */
export const DATA_ROOT = process.env.GOAL_LAB_DATA || join(LAB_ROOT, "data");
/** Lab-scoped XDG_STATE_HOME handed to every spawned server, so the guard's
 *  ledger lands here (isolated from the user's real state) and stays readable. */
export const STATE_HOME = join(DATA_ROOT, "xdg-state");
/** Throwaway git projects, one per run (full project isolation). */
export const PROJECTS_ROOT = join(DATA_ROOT, "projects");
/** Per-run normalized event logs (JSONL) + snapshots. */
export const RUNS_ROOT = join(DATA_ROOT, "runs");

const num = (v, d) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? d : Number(v));

export const CONFIG = {
  /** HTTP port for the Lab UI + API. */
  port: num(process.env.GOAL_LAB_PORT, 7878),
  host: process.env.GOAL_LAB_HOST || "127.0.0.1",

  /** Max agents running concurrently; excess is queued. The headline "10 at once". */
  concurrency: num(process.env.GOAL_LAB_CONCURRENCY, 10),

  /** Hard wall-clock cap per run before the orchestrator aborts it (ms). Weak free
   *  models are slow; the guard's behavior is observable well before this. */
  runTimeoutMs: num(process.env.GOAL_LAB_RUN_TIMEOUT_MS, 12 * 60 * 1000),
  /** How long to wait for `opencode serve` to print its port (ms). */
  serveStartTimeoutMs: num(process.env.GOAL_LAB_SERVE_TIMEOUT_MS, 45 * 1000),
  /** Idle grace: a run with no new events for this long is considered settled. */
  idleSettleMs: num(process.env.GOAL_LAB_IDLE_SETTLE_MS, 25 * 1000),

  /** The "shitty free" OpenCode Zen models we stress the guard with. The guard's
   *  job is to behave correctly regardless of model quality, so weak models are
   *  exactly what produces the richest failure data. */
  models: (process.env.GOAL_LAB_MODELS
    ? process.env.GOAL_LAB_MODELS.split(",")
    : [
        "opencode/deepseek-v4-flash-free",
        "opencode/mimo-v2.5-free",
        "opencode/nemotron-3-ultra-free",
        "opencode/north-mini-code-free",
      ]
  ).map((s) => s.trim()).filter(Boolean),

  /** Poll cadence for reading the guard's debounced on-disk ledger (ms). */
  guardPollMs: num(process.env.GOAL_LAB_GUARD_POLL_MS, 2000),

  /** Keep at most this many fully-finished runs in memory (logs stay on disk). */
  maxRunsInMemory: num(process.env.GOAL_LAB_MAX_RUNS, 500),
};

/** Parse "provider/model-id" into the SDK's model body. */
export function modelBody(model) {
  const [providerID, ...rest] = String(model).split("/");
  return { providerID, modelID: rest.join("/") };
}

/** Short, stable display label for a model (drops provider + "-free"). */
export function modelLabel(model) {
  return String(model).split("/").pop().replace(/-free$/, "");
}
