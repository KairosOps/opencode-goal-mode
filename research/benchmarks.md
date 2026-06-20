# Benchmarks

Goal Mode makes strong claims, so this page keeps the numbers reproducible. The
headline results come from third-party command examples, while the curated cases
remain regression fixtures for the exact behaviors the guard promises to keep.

Reproducible measurement of the destructive-command guard from a repository
checkout. Run:

```bash
npm run bench                # external + fixture benchmarks → results.json + charts
node benchmarks/external.mjs # external benchmark only (add --json for full detail)
npm run bench:truthfulness   # print the completion-enforcement fixture JSON
npm run bench:compare        # regenerate the capability-comparison chart
```

`npm run bench` writes `docs/benchmarks/results.json` and the SVG charts the
README embeds.

## Why this was rewritten

The previous benchmark reported "20.8% → 100% detection, 21.7% → 0% false
positives" on a **71-command corpus the analyzer's author wrote**. The analyzer
was, in effect, the specification of that corpus, so 100%/0% mostly restated
"my code passes my own examples." Those numbers are still produced — but they are
now labeled as *regression fixtures*, and the headline figure comes from an
**external corpus the analyzer was never fitted to**.

## Headline: external corpus

- **Source**: real example commands from
  [tldr-pages](https://github.com/tldr-pages/tldr) (`common`, `linux`, `osx`
  English pages), pinned by commit in `benchmarks/external-corpus.json`. These
  are written by hundreds of contributors with no knowledge of this analyzer, so
  it cannot have been tuned to them. `tldr` `{{placeholder}}` tokens and
  `[-f|--force]` alternative-flag notation are canonicalized into literal
  commands by `benchmarks/build-external-corpus.mjs`.
- **Ground-truth labels** come from `labelDestructive()` in that builder: a
  deliberately simple, transparent rule (primary utility ∈ a fixed irreversible
  set; specific destructive `git` subcommands; `curl|wget … | sh`). It is
  intentionally **independent of the analyzer's own logic**. No automatic labeler
  is perfect, so the benchmark prints every disagreement for audit rather than
  hiding them.
- **Sampling**: all destructive examples found are kept (they are rare in real
  docs); safe examples are stride-sampled to a cap. This imbalance is recorded in
  the corpus `totals` and disclosed here so it is not mistaken for a base rate.

Representative run (sample of 704 commands: 104 destructive, 600 safe):

| On real third-party commands | Legacy regex guard | Goal Mode analyzer |
| --- | --- | --- |
| Detection rate | 53.8% | **93.3%** |
| False-positive rate | 0.2% | 0.2% |

Reading the result honestly:

- The remaining Goal Mode misses are almost entirely un-flagged single-target
  `rm <file>` (and `rm -i`/`-v`/`-d`), which the guard **intentionally permits**:
  it blocks `rm -r`/`rm -f`, command-substitution/`bash -c`/interpreter deletes,
  and remote exec, but not a plain single-file `rm`. Under the strict
  every-`rm`-is-destructive labeler these are counted as misses.
- The one counted false positive (`git filter-repo …`) genuinely rewrites
  history, so the real-world false-positive rate is effectively zero. Run
  `node benchmarks/external.mjs --json` to see the full miss / false-positive
  lists.
- This benchmark directly drove real fixes: `mkfs.<fstype>` variants, `srm`, and
  `mkswap` were missing from the analyzer and were added after the external run
  exposed them.

## Curated regression fixtures (a spec, not a survey)

`benchmarks/corpus.mjs` (71 commands) and `benchmarks/completion-corpus.mjs`
(9 completion-claim cases) define the patterns the analyzer must catch and the
completion-policy decisions it must make. They pass **by construction** and exist
to prevent regressions. The 100%/0% / "all cases pass" numbers there are not
measured accuracy — treat them as a checklist the code is required to satisfy.

- **Baseline** for the fixture comparison (`benchmarks/legacy-analyzer.mjs`) is
  the original regex classifier, preserved **verbatim** from the first published
  release (commit `130956d`), so it is the author's own prior code, not a
  strawman built to lose.
- **A command counts as "blocked"** when the analyzer flags it `destructive` or
  `networkExec` (the signals `tool.execute.before` throws on). `mutating` marks
  the session dirty but does not block, so it is not counted.

## Honesty notes

- The analyzer fails **open** on un-analyzable dynamic commands (deferring to the
  host's permission rules); it is defense-in-depth, not a jail — see
  [shell-hardening.md](shell-hardening.md).
- The latency comparison is shown even though the tokenizer is slower than a
  regex: the win is accuracy, and the parse cost is ~1µs per candidate.
- The completion-enforcement fixtures verify mechanical completion-claim policy,
  not that an LLM's prose is semantically true in every domain.
