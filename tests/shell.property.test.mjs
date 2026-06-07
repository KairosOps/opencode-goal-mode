import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { analyzeCommand, looksLikeDestructiveBash, looksLikeMutatingBash } from "../plugins/goal-guard/shell.js";

const RUNS = 1500;

test("property: analyzeCommand never throws on arbitrary strings", () => {
  fc.assert(
    fc.property(fc.string(), (s) => {
      analyzeCommand(s);
      return true;
    }),
    { numRuns: RUNS },
  );
});

test("property: analyzeCommand never throws on shell-flavored fuzz", () => {
  const shellChars = fc
    .array(fc.constantFrom(..."abcdef rmgit-/|&;$(){}`\"'<>\n\t*?=."), { maxLength: 60 })
    .map((a) => a.join(""));
  fc.assert(
    fc.property(shellChars, (s) => {
      const a = analyzeCommand(s);
      // Result is always a well-formed signal object.
      return (
        typeof a.destructive === "boolean" &&
        typeof a.mutating === "boolean" &&
        typeof a.verification === "boolean" &&
        Array.isArray(a.reasons)
      );
    }),
    { numRuns: RUNS },
  );
});

test("property: destructive implies the mutating superset", () => {
  const tokens = ["rm", "-rf", "/tmp/x", "git", "reset", "--hard", "ls", "echo", "hi", "&&", ";", "|", "sh"];
  const cmd = fc.array(fc.constantFrom(...tokens), { maxLength: 10 }).map((a) => a.join(" "));
  fc.assert(
    fc.property(cmd, (s) => {
      if (looksLikeDestructiveBash(s)) return looksLikeMutatingBash(s);
      return true;
    }),
    { numRuns: RUNS },
  );
});

test("property: wrapping a destructive command in a separator chain stays destructive", () => {
  const dangerous = fc.constantFrom("rm -rf /tmp/x", "git reset --hard", "dd if=a of=/dev/sda", "find . -delete");
  const sep = fc.constantFrom(" && ", " ; ", "\n", " || ");
  const benign = fc.constantFrom("ls", "echo ok", "pwd", "git status");
  fc.assert(
    fc.property(benign, sep, dangerous, (b, s, d) => looksLikeDestructiveBash(`${b}${s}${d}`)),
    { numRuns: RUNS },
  );
});

test("property: a destructive command inside $() is still caught", () => {
  const dangerous = fc.constantFrom("rm -rf /tmp/x", "git reset --hard", "find . -delete");
  fc.assert(
    fc.property(dangerous, (d) => looksLikeDestructiveBash(`echo $(${d})`)),
    { numRuns: 300 },
  );
});

test("property: pure echo of dangerous text is never destructive", () => {
  const dangerous = fc.constantFrom("rm -rf /", "git reset --hard", "dd of=/dev/sda");
  fc.assert(
    fc.property(dangerous, (d) => !looksLikeDestructiveBash(`echo "${d}"`)),
    { numRuns: 300 },
  );
});

test("property: env-assignment prefixes never hide a destructive command", () => {
  const assigns = fc.array(fc.constantFrom("A=1", "FOO=bar", "PATH=/x"), { maxLength: 3 }).map((a) => a.join(" "));
  fc.assert(
    fc.property(assigns, (pre) => looksLikeDestructiveBash(`${pre} rm -rf /tmp/x`.trim())),
    { numRuns: 300 },
  );
});
