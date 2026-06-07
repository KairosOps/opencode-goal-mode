# Benchmarks

Reproducible measurement of the destructive-command guard. Run:

```bash
npm run bench          # detection / false-positive / latency benchmark
npm run bench:compare  # regenerate the capability-comparison chart
```

`npm run bench` writes `docs/benchmarks/results.json` and the SVG charts the
README embeds.

## Methodology

- **Corpus** (`benchmarks/corpus.mjs`): 71 real shell commands a coding agent
  might emit, each labeled `destructive` (a guard must block) or `safe` (a guard
  must not block). Split into families: *classic* (plain `rm -rf`, `git reset
  --hard`), *obfuscated* (the bypass corpus — substitutions, wrappers, `bash -c`,
  interpreters, weaponized git), *remote-exec* (`curl | sh`), and *safe*
  (read-only and quoted-text commands, including ones the old guard
  false-positived).
- **Baseline** (`benchmarks/legacy-analyzer.mjs`): the original regex classifier,
  preserved **verbatim** from the first published release (commit `130956d`), so
  the comparison is apples-to-apples against the same code that shipped.
- **A command counts as "blocked"** when the analyzer flags it `destructive` or
  `networkExec` (the two signals `tool.execute.before` throws on). `mutating`
  marks the session dirty but does not block, so it is not counted here.
- **Metrics**: detection rate (recall over destructive commands),
  false-positive rate (safe commands wrongly blocked), and per-command latency.

## Results

Representative run (Node 24, single-threaded; latency varies by machine, the
accuracy figures do not):

| Metric | Legacy regex guard | Goal Mode analyzer |
| --- | --- | --- |
| Detection rate | **20.8%** (10/48) | **100%** (48/48) |
| False-positive rate | **21.7%** (5/23) | **0%** (0/23) |
| Detection — classic | 100% | 100% |
| Detection — obfuscated | 0% (0/35) | 100% (35/35) |
| Detection — remote-exec | 0% (0/3) | 100% (3/3) |
| Latency per command | ~1.3 µs | ~1.9 µs |

The legacy guard catches only the *classic* family and misses every obfuscated
and remote-execution command, while wrongly blocking 1-in-5 benign commands. The
tokenizer catches the entire corpus with zero false positives, for an extra
~0.6 µs per command — negligible for a per-tool-call guard (still ~500,000
classifications/second).

## Honesty notes

- The corpus is hand-built to exercise the known bypass classes; it is a
  capability benchmark, not a claim of catching *every* possible obfuscation
  (the analyzer fails open on un-analyzable dynamic commands — see
  [shell-hardening.md](shell-hardening.md)).
- The latency comparison is intentionally shown even though the new analyzer is
  slower: the win is accuracy, and the parse cost is sub-microsecond.
- "100% on this corpus" means 100% of the labeled set; new bypass classes that
  are discovered get added to the corpus and fixed (that is how the second-wave
  findings — `sudo -u`, `pnpm dlx`, interpreter shell-out — entered it).
