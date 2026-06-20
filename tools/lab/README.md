# Goal Lab — agent observatory

Goal Lab is the proving ground for Goal Mode's boldest claim: weak or distracted
models should still be forced through a visible, auditable workflow. It turns
many live goal sessions into data you can inspect, compare, and use to harden the
plugin.

A browser dev-tool that drives many **Goal Mode** agents at once against real
`opencode serve` instances and real **free OpenCode Zen models**, captures every
event and every byte of the guard's ledger, auto-investigates failures, and
presents it all as a clean, Cloudflare/Kumo-styled list → detail UI (inline
status, semantic color, Temporal-style event history, run tree, stepper).

Its purpose is to produce **high-value, actionable data for improving the
plugin**: where weak models make the guard miss a contract, skip a review, leak
a completion, loop on auto-continue, or where a destructive command slips past
the shell guard.

## Run it

```bash
node tools/lab/server/index.mjs
# open http://127.0.0.1:7878
```

Then click **Launch agents** (default 10) or `POST /api/batch {"count":10}`.

Env knobs (see `server/config.mjs`): `GOAL_LAB_PORT`, `GOAL_LAB_CONCURRENCY`,
`GOAL_LAB_RUN_TIMEOUT_MS`, `GOAL_LAB_IDLE_SETTLE_MS`, `GOAL_LAB_MODELS`.

## Where ALL the data lives (for debugging a task)

Everything is on disk under `tools/lab/data/` (gitignored) AND on the API. To
debug a specific task run, you have the complete record:

| What | On disk | API |
|---|---|---|
| One run, everything | `data/runs/<runId>/run.json` | `GET /api/runs/:id/data` ← the full bundle |
| Every normalized event | `data/runs/<runId>/events.jsonl` | `GET /api/runs/:id/events` |
| All investigated incidents | `data/incidents.jsonl` | `GET /api/incidents` |
| The guard's own ledger | `data/xdg-state/opencode/goal-guard/<projectKey>.json` | included in `:id/data` |

`GET /api/runs/:id/data` returns `{ run, task, guard, metrics, graph, events,
incidents }` — the single payload an engineer or agent needs to reproduce and fix
a problem. The UI's **Data ↧** button on each run links straight to it.

## API surface

```
GET  /api/health
GET  /api/tasks                hard-task corpus + configured models
GET  /api/models               configured model list
GET  /api/runs                 list (running first, newest)
POST /api/runs                 { plan:[{taskId,model}] } | { taskId, model, count }
POST /api/batch                { count }  → balanced task×model fan-out
POST /api/abort-all
GET  /api/runs/:id             run + task + guard + metrics
GET  /api/runs/:id/events      normalized event log (?since=seq)
GET  /api/runs/:id/graph       orchestration graph (goal→subagents→tools)
GET  /api/runs/:id/data        EVERYTHING for one task (debug bundle)
POST /api/runs/:id/abort
GET  /api/incidents            ?family= &severity=
GET  /api/incidents/:id        incident + context window + suggested fix
GET  /api/metrics              global aggregates
GET  /api/insights             ranked plugin-improvement recommendations
GET  /api/export               full corpus dump
GET  /api/stream               SSE live feed (drives the whole UI)
```

## Architecture

```
server/
  config.mjs        paths, models, concurrency
  schema.mjs        normalized event/incident shapes + taxonomy
  tasks.mjs         the "extremely hard" task corpus (+ failure-mode baits)
  store.mjs         in-mem + JSONL persistence + SSE pub/sub bus
  normalizer.mjs    raw /event + guard-ledger diff → normalized signals
  guard-state.mjs   reads the plugin's own on-disk ledger (reuses its helpers)
  orchestrator.mjs  spawns serve, drives goal sessions, polls ledger, pool of N
  incidents.mjs     LIVE error investigator + STRUCTURAL terminal scan
  metrics.mjs       per-run + global aggregation + insight synthesis
  server.mjs        HTTP + SSE + static
web/                vanilla ESM + SVG; Cloudflare/Kumo design tokens, no build
```

Data sources per run: (1) the live `/event` SSE stream from a dedicated
`opencode serve` pinned to an isolated git project, and (2) the guard's debounced
on-disk ledger (contract, sticky gates, verdicts, completionRejections,
dirtyReasons, auto-continue counters), polled and diffed into signals.
