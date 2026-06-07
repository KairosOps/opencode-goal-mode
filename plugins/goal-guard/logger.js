/**
 * Defensive wrappers around the OpenCode client. Every call is best-effort:
 * a logging or toast failure must never propagate into a hook and break a turn.
 */

export function createLogger(client) {
  const log = client?.app?.log?.bind(client.app);
  const toast = client?.tui?.showToast?.bind(client.tui);

  return {
    async info(message, extra) {
      if (!log) return;
      try {
        await log({ body: { service: "goal-guard", level: "info", message, extra } });
      } catch {
        /* ignore */
      }
    },
    async warn(message, extra) {
      if (!log) return;
      try {
        await log({ body: { service: "goal-guard", level: "warn", message, extra } });
      } catch {
        /* ignore */
      }
    },
    async toast(message, variant = "warning") {
      if (!toast) return;
      try {
        await toast({ body: { message, variant } });
      } catch {
        /* ignore */
      }
    },
  };
}
