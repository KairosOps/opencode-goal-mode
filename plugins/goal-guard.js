/**
 * Goal Guard — OpenCode plugin entry point.
 *
 * OpenCode loads a plugin file by importing it and treating EVERY export as a
 * plugin factory (see @opencode-ai/plugin's example: `export const X = async …`).
 * A non-function export (or a second factory) makes OpenCode fail with
 * "Plugin export is not a function" / double-register. So this entry exports
 * EXACTLY ONE thing — the default plugin factory. All implementation and the
 * test surface live in ./goal-guard/guard.js, which is nested one level deeper
 * and therefore not matched by OpenCode's `{plugin,plugins}/*.{ts,js}` glob.
 */

import { GoalGuardPlugin } from "./goal-guard/guard.js";

export default GoalGuardPlugin;
