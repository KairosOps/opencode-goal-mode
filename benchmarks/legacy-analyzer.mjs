/**
 * The ORIGINAL regex-based shell classifier, preserved verbatim from the first
 * published version of the plugin (commit 130956d) so the benchmark can compare
 * it apples-to-apples against the current quote-aware analyzer.
 *
 * Do not "improve" this file — its job is to faithfully represent the old
 * behavior that the new analyzer replaced.
 */

const MUTATING_BASH_PATTERNS = [
  /(^|&&|;|\|\|)\s*(sudo\s+)?(rm|mv|cp|mkdir|rmdir|touch|ln)\b/i,
  /(^|&&|;|\|\|)\s*(sudo\s+)?(tee|xargs\s+(rm|mv|cp))\b/i,
  /(^|&&|;|\|\|)\s*[^|]*\s(>|>>)\s*(?!\/dev\/null\b)\S+/i,
  /(^|&&|;|\|\|)\s*(perl\s+-pi|sed\s+-i)\b/i,
  /(^|&&|;|\|\|)\s*(npm|pnpm|yarn|bun)\s+(install|ci|add|remove|update)\b/i,
  /(^|&&|;|\|\|)\s*(npm|pnpm|yarn|bun)\s+(run\s+)?(format|fix|lint:fix)\b/i,
  /\b((npx|pnpm\s+exec|yarn)\s+)?(prettier|eslint)\b.*\s(--write|--fix)\b/i,
  /\b(node|python3?)\b.*\b(writeFile|appendFile|copyFile|rename|unlink|rmSync|mkdir|rmdir|openSync)\b/i,
];

export function looksLikeDestructiveBash(command) {
  const normalized = String(command || "").trim();
  return [
    /(^|&&|;|\|\|)\s*(sudo\s+)?rm\s+-[a-zA-Z]*[rR][a-zA-Z]*[rfRF]?\b/,
    /(^|&&|;|\|\|)\s*(sudo\s+)?rm\s+(--recursive|--force|--recursive\s+--force|-rf|-fr|-r)\b/,
    /(^|&&|;|\|\|)\s*git\s+reset\b/,
    /(^|&&|;|\|\|)\s*git\s+clean\b/,
    /(^|&&|;|\|\|)\s*git\s+checkout\b/,
    /(^|&&|;|\|\|)\s*git\s+restore\b/,
    /(^|&&|;|\|\|)\s*git\s+switch\b/,
    /(^|&&|;|\|\|)\s*git\s+push\b/,
    /(^|&&|;|\|\|)\s*(sudo\s+)?find\b.*\s-delete\b/,
    /(^|&&|;|\|\|)\s*(sudo\s+)?find\b.*\s-exec\s+rm\b/,
    /(^|&&|;|\|\|)\s*(sudo\s+)?dd\b.*\bof=\/dev\//,
    /(^|&&|;|\|\|)\s*(sudo\s+)?mkfs(\.|\s|$)/,
    /(^|&&|;|\|\|)\s*(sudo\s+)?shred\b/,
    /(^|&&|;|\|\|)\s*(sudo\s+)?truncate\b/,
    /(^|&&|;|\|\|)\s*(sudo\s+)?chmod\s+-[a-zA-Z]*[rR][a-zA-Z]*[wW][a-zA-Z]*[xX][a-zA-Z]*\s+\/\b/,
  ].some((pattern) => pattern.test(normalized));
}

export function looksLikeMutatingBash(command) {
  const normalized = String(command || "").trim();
  if (!normalized) return false;
  if (looksLikeDestructiveBash(normalized)) return true;
  return MUTATING_BASH_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** Adapter to the analyzer signal shape used by the benchmark. */
export function analyzeCommand(command) {
  const destructive = looksLikeDestructiveBash(command);
  const mutating = looksLikeMutatingBash(command);
  return { destructive, mutating, verification: false, networkExec: false, reasons: [] };
}
