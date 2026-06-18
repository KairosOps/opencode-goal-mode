// Goal Lab — API client + SSE live stream.

const j = (r) => r.json();

export const api = {
  health: () => fetch("/api/health").then(j),
  tasks: () => fetch("/api/tasks").then(j),
  runs: () => fetch("/api/runs").then(j),
  run: (id) => fetch(`/api/runs/${id}`).then(j),
  events: (id, since = 0) => fetch(`/api/runs/${id}/events?since=${since}`).then(j),
  graph: (id) => fetch(`/api/runs/${id}/graph`).then(j),
  incidents: (q = "") => fetch(`/api/incidents${q}`).then(j),
  incident: (id) => fetch(`/api/incidents/${id}`).then(j),
  metrics: () => fetch("/api/metrics").then(j),
  insights: () => fetch("/api/insights").then(j),
  export: () => fetch("/api/export").then(j),
  startBatch: (count) => fetch("/api/batch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ count }) }).then(j),
  startRun: (taskId, model, count = 1) => fetch("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId, model, count }) }).then(j),
  abort: (id) => fetch(`/api/runs/${id}/abort`, { method: "POST" }).then(j),
  abortAll: () => fetch("/api/abort-all", { method: "POST" }).then(j),
};

/** Connect to the SSE feed. Calls handlers.{hello,snapshot,message,open,close}. */
export function connectStream(handlers) {
  let es;
  let closed = false;
  const open = () => {
    es = new EventSource("/api/stream");
    es.addEventListener("hello", (e) => handlers.hello?.(JSON.parse(e.data)));
    es.addEventListener("snapshot", (e) => handlers.snapshot?.(JSON.parse(e.data)));
    es.addEventListener("ping", () => handlers.ping?.());
    es.onmessage = (e) => {
      try {
        handlers.message?.(JSON.parse(e.data));
      } catch {
        /* ignore */
      }
    };
    es.onopen = () => handlers.open?.();
    es.onerror = () => {
      handlers.close?.();
      es.close();
      if (!closed) setTimeout(open, 1500); // auto-reconnect
    };
  };
  open();
  return () => {
    closed = true;
    es?.close();
  };
}
