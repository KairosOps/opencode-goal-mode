/**
 * Defensive wrappers around the OpenCode client. Every call is best-effort:
 * a logging or toast failure must never propagate into a hook and break a turn.
 *
 * Guard-initiated turns use `guardPrompt` / `emitGoalCompleted` with synthetic
 * parts + a system directive — never a visible user message in the transcript.
 */

import { PRIMARY_AGENT } from "./agents.js";

export const GUARD_PREFIX = "[Goal Guard]";

/** Minimal synthetic text part that wakes the agent loop without a user bubble. */
export const GUARD_SYNTHETIC_TRIGGER = "(goal-guard continuation)";

/** True when every text part in a user turn is harness synthetic (not the human). */
export function isSyntheticUserTurn(parts) {
  if (!Array.isArray(parts) || parts.length === 0) return false;
  return parts.every((p) => !p || p.type !== "text" || p.synthetic === true);
}

/** Build a promptAsync body for harness-driven goal continuations. */
export function buildGuardPromptBody(text, model) {
  const directive = `${GUARD_PREFIX}\n${String(text)}`;
  return {
    // Pin the continuation to the Goal primary agent so a guard-driven turn can
    // never be misrouted to Build/Plan (which would deactivate Goal Mode). Reference
    // the canonical constant rather than a bare "goal" literal so a future rename
    // of PRIMARY_AGENT cannot desync the two.
    agent: PRIMARY_AGENT,
    ...(model ? { model } : {}),
    system: directive,
    parts: [{ type: "text", text: GUARD_SYNTHETIC_TRIGGER, synthetic: true }],
  };
}

export function createLogger(client, config = {}) {
  const log = client?.app?.log?.bind(client.app);
  const toast = client?.tui?.showToast?.bind(client.tui);
  const promptAsync = client?.session?.promptAsync?.bind(client.session);

  /**
   * Harness-driven continuation after review or auto-continue. Uses synthetic
   * parts + system directive so nothing appears as a user-typed message.
   */
  async function guardPrompt(sessionID, text, model) {
    if (!promptAsync || !sessionID || !text) return false;
    try {
      await promptAsync({
        path: { id: String(sessionID) },
        body: buildGuardPromptBody(text, model),
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
