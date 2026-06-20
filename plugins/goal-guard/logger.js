/**
 * Defensive wrappers around the OpenCode client. Every call is best-effort:
 * a logging or toast failure must never propagate into a hook and break a turn.
 *
 * Guard-initiated turns use `guardPrompt` / `emitGoalCompleted` — never a bare
 * user-shaped message. The `[Goal Guard]` prefix marks harness-driven continuations
 * (post-review fix cycle or final completion), distinct from the user's goal prompt.
 */

const GUARD_PREFIX = "[Goal Guard]";

export function createLogger(client, config = {}) {
  const log = client?.app?.log?.bind(client.app);
  const toast = client?.tui?.showToast?.bind(client.tui);
  const promptAsync = client?.session?.promptAsync?.bind(client.session);

  /**
   * Harness-driven continuation after a programmatic review cycle (fix or complete).
   * Always targets the goal agent and prefixes the directive so it is not a fake user turn.
   */
  async function guardPrompt(sessionID, text, model) {
    if (!promptAsync || !sessionID || !text) return false;
    try {
      await promptAsync({
        path: { id: String(sessionID) },
        body: {
          agent: "goal",
          ...(model ? { model } : {}),
          parts: [{ type: "text", text: `${GUARD_PREFIX}\n${String(text)}` }],
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  return {
    /**
     * After ALL required reviews PASS programmatically, start the final assistant turn
     * whose output MUST be the earned `Goal Completed` message.
     */
    async emitGoalCompleted(sessionID, reviewCycles, model) {
      const marker = config.completionMarker || "Goal Completed";
      const n = Number(reviewCycles) || 0;
      return guardPrompt(
        sessionID,
        `All required reviews PASSED programmatically. Review cycles: ${n}.\n\n` +
          `Respond with your final deliverable now. It MUST start with exactly:\n\n` +
          `${marker}\n\nReview cycles: ${n}`,
        model,
      );
    },

    /** @deprecated Use guardPrompt — kept for tests that spy on continueSession. */
    async continueSession(sessionID, text, model) {
      return guardPrompt(sessionID, text, model);
    },

    guardPrompt,

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
