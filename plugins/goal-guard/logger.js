/**
 * Defensive wrappers around the OpenCode client. Every call is best-effort:
 * a logging or toast failure must never propagate into a hook and break a turn.
 */

export function createLogger(client) {
  const log = client?.app?.log?.bind(client.app);
  const toast = client?.tui?.showToast?.bind(client.tui);
  const promptAsync = client?.session?.promptAsync?.bind(client.session);

  return {
    /**
     * Start a fresh turn in a session by sending it a message (fire-and-forget).
     * Used to auto-continue an incomplete goal. Returns true if the call was made.
     */
    async continueSession(sessionID, text) {
      if (!promptAsync || !sessionID || !text) return false;
      try {
        await promptAsync({ path: { id: String(sessionID) }, body: { parts: [{ type: "text", text: String(text) }] } });
        return true;
      } catch {
        return false;
      }
    },
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
