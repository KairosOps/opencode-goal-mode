/**
 * Quote-aware shell command analyzer.
 *
 * The previous implementation matched raw regular expressions against the whole
 * command string. That approach is trivially bypassed: command substitution
 * (`$(rm -rf /)`), pipes into a shell (`curl x | sh`), `bash -c "..."`,
 * absolute paths (`/bin/rm`), env-assignment prefixes (`FOO=bar rm ...`),
 * `git -C <dir> reset` and newline separators all evade boundary-anchored
 * regexes, while legitimate commands such as `git checkout -b feature` get
 * flagged as destructive.
 *
 * This module instead lexes the command with awareness of quoting, separators,
 * command substitution and shell wrappers, decomposes it into the individual
 * simple commands that will actually run, and classifies each one by its
 * resolved binary. Wrappers (`sudo`, `xargs`, `env`, `bash -c`, `eval`, ...)
 * and substitutions are recursed into, so a dangerous command cannot hide
 * behind one.
 *
 * Classification produces four independent signals:
 *   - destructive   irreversible data/branch/disk loss; blocked before execution
 *   - mutating      writes to the tree/working state; marks the session dirty
 *   - verification  a test/build/lint/typecheck command; counts as evidence
 *   - networkExec   pipes untrusted network output into a shell (also destructive)
 *
 * A single command may carry several signals (e.g. `npm run build` is
 * verification but not mutating; `tee x && rm -rf y` is mutating and destructive).
 */

const MAX_DEPTH = 6;

/** Shell wrappers whose *next* argument is the command that actually runs. */
const SIMPLE_WRAPPERS = new Set([
  "sudo",
  "command",
  "builtin",
  "nice",
  "nohup",
  "ionice",
  "setsid",
  "stdbuf",
  "time",
  "nocorrect",
  "doas",
  "exec",
  "caffeinate",
  "proxychains",
  "proxychains4",
]);

/** Interpreters that execute a command string passed via `-c`/`/c`. */
const DASH_C_INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish"]);

/** Shells that execute whatever is piped into them on stdin. */
const STDIN_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash"]);

/**
 * Wrapper options that consume the FOLLOWING token as their value, so the value
 * is not mistaken for the wrapped command (e.g. `sudo -u root rm -rf /` — `root`
 * is the value of `-u`, not the command).
 */
const WRAPPER_VALUE_OPTS = {
  sudo: new Set(["-u", "-g", "-U", "-C", "-p", "-r", "-T", "-h", "--user", "--group", "--prompt", "--role", "--type", "--host", "--close-from", "--other-user"]),
  doas: new Set(["-u", "-C"]),
  nice: new Set(["-n", "--adjustment"]),
  ionice: new Set(["-c", "-n", "-p"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
};

/** Commands that fetch remote content; piping them into a shell is remote code execution. */
const NETWORK_FETCHERS = new Set(["curl", "wget", "fetch", "http", "https", "aria2c"]);

const SEPARATORS = new Set([";", "\n", "&&", "||", "|", "|&", "&"]);

/**
 * Lex a command string into tokens, respecting single/double quotes and
 * backslash escapes, capturing `$( … )` and backtick substitutions as nested
 * strings, and emitting separator/redirection operators.
 *
 * @param {string} input
 * @returns {Array<{type: "word"|"op"|"subst", value: string}>}
 */
function lex(input) {
  const tokens = [];
  let word = "";
  let wordActive = false;
  const pushWord = () => {
    if (wordActive) {
      tokens.push({ type: "word", value: word });
      word = "";
      wordActive = false;
    }
  };
  const pushOp = (value) => {
    pushWord();
    tokens.push({ type: "op", value });
  };

  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input[i];

    // Backslash escape (outside single quotes, which we handle below).
    if (c === "\\") {
      if (i + 1 < n) {
        const next = input[i + 1];
        // A backslash-newline is a line continuation: it disappears.
        if (next !== "\n") {
          word += next;
          wordActive = true;
        }
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (c === "'") {
      // Single quotes: everything literal until the next single quote.
      wordActive = true;
      i += 1;
      while (i < n && input[i] !== "'") {
        word += input[i];
        i += 1;
      }
      i += 1; // skip closing quote (or end of string)
      continue;
    }

    if (c === '"') {
      // Double quotes: literal except for substitutions and escapes.
      wordActive = true;
      i += 1;
      while (i < n && input[i] !== '"') {
        if (input[i] === "\\" && i + 1 < n) {
          word += input[i + 1];
          i += 2;
          continue;
        }
        if (input[i] === "$" && input[i + 1] === "(") {
          const [inner, next] = readBalanced(input, i + 2, "(", ")");
          tokens.push({ type: "subst", value: inner });
          i = next;
          continue;
        }
        if (input[i] === "`") {
          const [inner, next] = readBacktick(input, i + 1);
          tokens.push({ type: "subst", value: inner });
          i = next;
          continue;
        }
        word += input[i];
        i += 1;
      }
      i += 1; // skip closing quote
      continue;
    }

    // Command substitution $( … )
    if (c === "$" && input[i + 1] === "(") {
      const [inner, next] = readBalanced(input, i + 2, "(", ")");
      tokens.push({ type: "subst", value: inner });
      i = next;
      continue;
    }

    // Backtick substitution
    if (c === "`") {
      const [inner, next] = readBacktick(input, i + 1);
      tokens.push({ type: "subst", value: inner });
      i = next;
      continue;
    }

    // Process substitution / grouping parens: treat the content as a nested command.
    if ((c === "<" || c === ">") && input[i + 1] === "(") {
      const [inner, next] = readBalanced(input, i + 2, "(", ")");
      tokens.push({ type: "subst", value: inner });
      i = next;
      continue;
    }

    // Two-character operators.
    const two = input.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === ">>" || two === "|&" || two === "2>" || two === "&>") {
      pushOp(two);
      i += 2;
      continue;
    }

    // Single-character operators / separators.
    if (c === ";" || c === "|" || c === "&" || c === "\n" || c === "<" || c === ">") {
      pushOp(c);
      i += 1;
      continue;
    }

    // Subshell / grouping parens become separators around their content.
    if (c === "(" || c === ")" || c === "{" || c === "}") {
      pushOp(c);
      i += 1;
      continue;
    }

    // A '#' at a word boundary starts a comment that runs to end of line.
    if (c === "#" && !wordActive) {
      while (i < n && input[i] !== "\n") i += 1;
      continue;
    }

    if (c === " " || c === "\t" || c === "\r") {
      pushWord();
      i += 1;
      continue;
    }

    word += c;
    wordActive = true;
    i += 1;
  }
  pushWord();
  return tokens;
}

/** Read a balanced region given an opening delimiter already consumed. */
function readBalanced(input, start, open, close) {
  let depth = 1;
  let i = start;
  let out = "";
  while (i < input.length && depth > 0) {
    const c = input[i];
    if (c === "\\" && i + 1 < input.length) {
      out += c + input[i + 1];
      i += 2;
      continue;
    }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) {
        i += 1;
        break;
      }
    }
    out += c;
    i += 1;
  }
  return [out, i];
}

/** Read until the next unescaped backtick. */
function readBacktick(input, start) {
  let i = start;
  let out = "";
  while (i < input.length && input[i] !== "`") {
    if (input[i] === "\\" && i + 1 < input.length) {
      out += input[i + 1];
      i += 2;
      continue;
    }
    out += input[i];
    i += 1;
  }
  return [out, i + 1];
}

/**
 * Split a token stream into pipelines (groups of simple commands separated by
 * pipes) and simple commands (separated by `;`, `&&`, `||`, newlines, `&`).
 * Returns an array of pipelines, each a list of simple commands, each simple
 * command a list of `{ words, redirects }`.
 */
function structure(tokens) {
  const pipelines = [];
  let pipeline = [];
  let words = [];
  const redirects = [];
  const substs = [];

  const flushCommand = () => {
    if (words.length || redirects.length) {
      pipeline.push({ words: words.slice(), redirects: redirects.slice() });
    }
    words = [];
    redirects.length = 0;
  };
  const flushPipeline = () => {
    flushCommand();
    if (pipeline.length) pipelines.push(pipeline.slice());
    pipeline = [];
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.type === "subst") {
      substs.push(t.value);
      continue;
    }
    if (t.type === "word") {
      words.push(t.value);
      continue;
    }
    // operator
    if (t.value === "|" || t.value === "|&") {
      flushCommand();
      continue;
    }
    if (SEPARATORS.has(t.value)) {
      flushPipeline();
      continue;
    }
    if (t.value === "(" || t.value === ")" || t.value === "{" || t.value === "}") {
      flushPipeline();
      continue;
    }
    if (t.value === ">" || t.value === ">>" || t.value === "<" || t.value === "2>" || t.value === "&>") {
      // The following word is the redirect target.
      const target = tokens[i + 1];
      if (target && target.type === "word") {
        redirects.push({ op: t.value, target: target.value });
        i += 1;
      } else {
        redirects.push({ op: t.value, target: "" });
      }
      continue;
    }
  }
  flushPipeline();
  return { pipelines, substs };
}

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Resolve the effective binary name for a command word (strip path, drop env assigns). */
function baseName(word) {
  if (!word) return "";
  // Strip a trailing path separator artefacts and resolve basename.
  const cleaned = word.replace(/\/+$/, "");
  const idx = cleaned.lastIndexOf("/");
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/** Does an argument list contain any of the given flags (exact or bundled short flags)? */
function hasFlag(args, flags) {
  for (const arg of args) {
    if (flags.includes(arg)) return true;
    // Bundled short flags like -rf contain -r and -f.
    if (/^-[a-zA-Z]+$/.test(arg)) {
      for (const f of flags) {
        if (f.length === 2 && f[0] === "-" && arg.includes(f[1])) return true;
      }
    }
  }
  return false;
}

function nonFlagArgs(args) {
  return args.filter((a) => !a.startsWith("-"));
}

/** Index of the first non-option token for a wrapper, honoring value-taking options. */
function skipWrapperOptions(bin, args) {
  const valueOpts = WRAPPER_VALUE_OPTS[bin] || new Set();
  let j = 0;
  while (j < args.length) {
    const a = args[j];
    if (a === "--") {
      j += 1;
      break;
    }
    if (a.startsWith("-")) {
      // `--opt=value` carries its own value; otherwise a value-taking option
      // consumes the next token.
      if (!a.includes("=") && valueOpts.has(a)) j += 1;
      j += 1;
      continue;
    }
    if (/^\d+$/.test(a) && valueOpts.size === 0) {
      // Bare numeric option value for wrappers with no declared value-opts.
      j += 1;
      continue;
    }
    break;
  }
  return j;
}

/** Decode `$'...'` ANSI-C quoting into a plain single-quoted literal so the
 * lexer cannot be evaded by hex/octal/escape-encoded command names. */
function decodeAnsiCQuotes(input) {
  return input.replace(/\$'((?:[^'\\]|\\.)*)'/g, (_m, body) => {
    const decoded = body
      .replace(/\\x([0-9a-fA-F]{1,2})/g, (_s, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\0([0-7]{1,3})/g, (_s, o) => String.fromCharCode(parseInt(o, 8)))
      .replace(/\\([0-7]{1,3})/g, (_s, o) => String.fromCharCode(parseInt(o, 8)))
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\r/g, "\r")
      .replace(/\\\\/g, "\\")
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"');
    return `'${decoded.replace(/'/g, "'\\''")}'`;
  });
}

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "pip", "pip3", "pipenv", "poetry", "cargo", "go", "gem", "bundle", "composer", "apt", "apt-get", "brew", "gradle", "mvn", "dotnet", "deno"]);
const PKG_MUTATING_SUBCMDS = new Set(["install", "i", "ci", "add", "remove", "rm", "uninstall", "update", "upgrade", "link", "unlink", "prune", "dedupe", "rebuild", "get", "tidy"]);
const PKG_SCRIPT_RUNNERS = new Set(["run", "run-script", "exec"]);

const TEST_SCRIPT_WORDS = new Set(["test", "tests", "validate", "check", "lint", "typecheck", "type-check", "tsc", "build", "unit", "integration", "e2e", "coverage", "ci", "verify", "spec"]);
const DIRECT_TEST_BINS = new Set(["jest", "mocha", "vitest", "ava", "tap", "tape", "playwright", "cypress", "pytest", "phpunit", "rspec", "nyc", "karma", "jasmine", "tox", "nose", "nosetests"]);

const FORMATTERS = new Set(["prettier", "eslint", "black", "ruff", "gofmt", "goimports", "rustfmt", "clang-format", "autopep8", "isort", "standard", "biome", "dprint", "yapf", "stylelint"]);

const MUTATING_BINS = new Set(["mkdir", "rmdir", "touch", "ln", "mv", "cp", "tee", "install", "patch", "rsync", "rename", "chmod", "chown", "chgrp", "git-apply"]);
const DESTRUCTIVE_BINS = new Set(["shred", "mkfs", "fdisk", "parted", "wipefs", "sgdisk", "blkdiscard", "unlink"]);

/**
 * Classify a single already-split simple command (array of words).
 * @returns {{ destructive: boolean, mutating: boolean, verification: boolean, networkExec: boolean, reasons: string[] }}
 */
function classifyCommand(words, redirects, depth, acc, pipelineCmds, indexInPipeline) {
  // Strip leading environment assignments (FOO=bar cmd).
  let idx = 0;
  while (idx < words.length && ENV_ASSIGN.test(words[idx])) idx += 1;
  const head = words[idx];
  if (head === undefined) {
    // Pure assignment or redirect-only command. Redirects can still mutate.
    applyRedirects(redirects, acc);
    return;
  }
  const bin = baseName(head);
  const args = words.slice(idx + 1);

  // Redirections to a real file mutate the tree regardless of the command.
  applyRedirects(redirects, acc);

  // env VAR=val cmd ...
  if (bin === "env") {
    let j = 0;
    while (j < args.length && (ENV_ASSIGN.test(args[j]) || args[j] === "-i" || args[j].startsWith("--"))) j += 1;
    if (j < args.length) return classifyCommand(args.slice(j), [], depth + 1, acc, pipelineCmds, indexInPipeline);
    return;
  }

  // Simple wrappers: skip the wrapper's own options — including the values of
  // value-taking options (e.g. `sudo -u root cmd`, `nice -n 10 cmd`) — then the
  // next token is the real command.
  if (SIMPLE_WRAPPERS.has(bin)) {
    const j = skipWrapperOptions(bin, args);
    if (j < args.length) return classifyCommand(args.slice(j), [], depth + 1, acc, pipelineCmds, indexInPipeline);
    return;
  }

  // timeout [opts] DURATION cmd... — skip value-aware options, then the
  // duration token, then classify the remainder.
  if (bin === "timeout") {
    let j = skipWrapperOptions("timeout", args);
    j += 1; // duration token
    if (j < args.length) return classifyCommand(args.slice(j), [], depth + 1, acc, pipelineCmds, indexInPipeline);
    return;
  }

  // xargs [opts] CMD ... — the trailing command is what runs (possibly many times).
  if (bin === "xargs") {
    let j = 0;
    while (j < args.length && args[j].startsWith("-")) {
      // -I {}, -n N, -P N, -d X take a value
      if (["-I", "-n", "-P", "-d", "-E", "-s", "-L"].includes(args[j])) j += 1;
      j += 1;
    }
    if (j < args.length) return classifyCommand(args.slice(j), [], depth + 1, acc, pipelineCmds, indexInPipeline);
    return;
  }

  // Interpreters running a command string: sh -c "...", python -c "...", node -e "...", perl -e, ruby -e.
  if (DASH_C_INTERPRETERS.has(bin)) {
    const ci = args.findIndex((a) => a === "-c");
    if (ci >= 0 && args[ci + 1] !== undefined) {
      analyzeInto(args[ci + 1], depth + 1, acc);
      return;
    }
    // A bare shell at the END of a pipeline executes its piped stdin.
    handlePipedShell(bin, args, pipelineCmds, indexInPipeline, depth, acc);
    return;
  }

  if (bin === "eval") {
    if (args.length) analyzeInto(args.join(" "), depth + 1, acc);
    return;
  }

  if (bin === "node" || bin === "nodejs" || bin === "deno") {
    classifyInterpreterScript(bin, args, depth, acc);
    // deno also has subcommands; fall through handled in classifyInterpreterScript
    if (bin === "deno") classifyDeno(args, acc);
    return;
  }
  if (bin === "python" || bin === "python3" || bin === "python2") {
    classifyPython(args, depth, acc);
    return;
  }
  if (bin === "perl" || bin === "ruby") {
    classifyPerlRuby(bin, args, depth, acc);
    return;
  }
  if (bin === "awk" || bin === "gawk" || bin === "mawk") {
    classifyAwk(args, depth, acc);
    return;
  }

  // rm. Recursive/force/wildcard/root deletions are irreversible (blocked); a
  // plain single- or multi-file rm only marks the session dirty (the host's own
  // `rm *` permission rule decides whether to prompt).
  if (bin === "rm") {
    const recursive = hasFlag(args, ["-r", "-R", "--recursive"]);
    const force = hasFlag(args, ["-f", "--force"]);
    const targets = nonFlagArgs(args);
    const wildcard = targets.some((t) => /[*?]/.test(t) || t === "/" || t === "~" || t.endsWith("/*"));
    if (recursive || force || wildcard) {
      acc.destructive = true;
      acc.reasons.push(`rm with ${recursive ? "recursive " : ""}${force ? "force " : ""}deletion`.replace(/\s+/g, " ").trim());
    } else {
      acc.mutating = true;
      acc.reasons.push("rm file deletion");
    }
    return;
  }

  // git
  if (bin === "git") {
    classifyGit(args, depth, acc);
    return;
  }

  // dd of=/dev/...
  if (bin === "dd") {
    if (args.some((a) => /^of=\/dev\//.test(a))) {
      acc.destructive = true;
      acc.reasons.push("dd writing to a device");
    } else if (args.some((a) => /^of=/.test(a))) {
      acc.mutating = true;
      acc.reasons.push("dd writing to a file");
    }
    return;
  }

  // find ... -delete / -exec rm / -execdir rm
  if (bin === "find" || bin === "fd" || bin === "fdfind") {
    if (hasFlag(args, ["-delete"]) || args.includes("-delete")) {
      acc.destructive = true;
      acc.reasons.push("find -delete");
    }
    const execIdx = args.findIndex((a) => a === "-exec" || a === "-execdir" || a === "-x" || a === "--exec");
    if (execIdx >= 0 && args[execIdx + 1] !== undefined) {
      const rest = [];
      for (let k = execIdx + 1; k < args.length; k += 1) {
        if (args[k] === ";" || args[k] === "+" || args[k] === "\\;") break;
        rest.push(args[k]);
      }
      // An -exec body runs once per match, so even a single-target rm deletes a
      // whole match set: treat any rm under -exec as destructive.
      if (rest.length && baseName(rest[0]) === "rm") {
        acc.destructive = true;
        acc.reasons.push("find -exec rm over a match set");
      } else if (rest.length) {
        classifyCommand(rest, [], depth + 1, acc, [], 0);
      }
    }
    return;
  }

  // truncate (data loss)
  if (bin === "truncate") {
    acc.destructive = true;
    acc.reasons.push("truncate");
    return;
  }

  // sed -i / perl -pi handled in MUTATING via flags
  if (bin === "sed" || bin === "gsed") {
    if (hasFlag(args, ["-i", "--in-place"]) || args.some((a) => a.startsWith("-i"))) {
      acc.mutating = true;
      acc.reasons.push("sed in-place edit");
    }
    return;
  }

  // chmod/chown recursive on a system path → destructive; otherwise mutating.
  // The first non-flag operand is the mode/owner; the rest are paths.
  if (bin === "chmod" || bin === "chown" || bin === "chgrp") {
    const paths = nonFlagArgs(args).slice(1);
    const systemPath = (t) => t === "/" || t === "~" || /^\/(etc|usr|bin|sbin|boot|var|lib|lib64|sys|root|dev|proc)\b/.test(t);
    if (hasFlag(args, ["-R", "--recursive"]) && paths.some(systemPath)) {
      acc.destructive = true;
      acc.reasons.push(`${bin} -R on a system path`);
    } else {
      acc.mutating = true;
      acc.reasons.push(bin);
    }
    return;
  }

  // Destructive disk/file utilities.
  if (DESTRUCTIVE_BINS.has(bin)) {
    acc.destructive = true;
    acc.reasons.push(bin);
    return;
  }

  // Package managers.
  if (PACKAGE_MANAGERS.has(bin)) {
    classifyPackageManager(bin, args, acc);
    return;
  }

  // npx / bunx run an arbitrary binary directly.
  if (bin === "npx" || bin === "pnpx" || bin === "bunx") {
    classifyRunner(args, acc);
    return;
  }

  // Formatters / linters run directly.
  if (FORMATTERS.has(bin)) {
    if (hasFlag(args, ["-w", "--write", "--fix", "-i", "--in-place"])) {
      acc.mutating = true;
      acc.reasons.push(`${bin} --write/--fix`);
    } else {
      acc.verification = true; // check-only lint counts as verification evidence
    }
    return;
  }

  // Direct test binaries.
  if (DIRECT_TEST_BINS.has(bin)) {
    acc.verification = true;
    return;
  }

  // make <target>. Signal writes are monotonic (OR-accumulated): never assign
  // false, which would clobber a `true` set by an earlier command in the chain.
  if (bin === "make" || bin === "gmake") {
    const target = nonFlagArgs(args)[0] || "";
    if (TEST_SCRIPT_WORDS.has(target)) acc.verification = true;
    if (["install", "clean", "distclean", "uninstall"].includes(target)) {
      acc.mutating = true;
      acc.reasons.push(`make ${target}`);
    }
    return;
  }

  // node --test
  // handled in classifyInterpreterScript

  // Known mutating file utilities.
  if (MUTATING_BINS.has(bin)) {
    acc.mutating = true;
    acc.reasons.push(bin);
    return;
  }

  // rimraf / trash / del CLIs
  if (bin === "rimraf" || bin === "trash" || bin === "del-cli") {
    acc.destructive = true;
    acc.reasons.push(bin);
    return;
  }

  // Fork bomb pattern (rarely tokenizes, but guard anyway).
  // (handled at string level in analyze())
}

/** find/handle a shell that runs piped stdin: `<source> | sh`. */
function handlePipedShell(shellBin, args, pipelineCmds, indexInPipeline, depth, acc) {
  if (!STDIN_SHELLS.has(shellBin)) return;
  if (args.some((a) => a === "-c")) return; // handled elsewhere
  // Look at the upstream command in the same pipeline.
  if (!pipelineCmds || indexInPipeline <= 0) return;
  for (let k = indexInPipeline - 1; k >= 0; k -= 1) {
    const upstream = pipelineCmds[k];
    const uhead = baseName((upstream.words || []).find((w) => !ENV_ASSIGN.test(w)) || "");
    if (NETWORK_FETCHERS.has(uhead)) {
      // Remote code execution. Kept distinct from `destructive` so it can be
      // toggled independently via config.blockNetworkExec.
      acc.networkExec = true;
      acc.reasons.push(`piping ${uhead} into ${shellBin}`);
      return;
    }
    if (uhead === "echo" || uhead === "printf") {
      const literal = echoCommandLiteral(uhead, upstream.words || []);
      if (literal) analyzeInto(literal, depth + 1, acc);
      return;
    }
  }
}

/** Classify the binary an ad-hoc runner (npx/bunx/pnpm dlx/yarn dlx) executes. */
function classifyRunner(args, acc) {
  // Skip runner flags and the optional `-p pkg` / `--package pkg` selectors.
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    if (["-p", "--package", "-c", "--call"].includes(args[i])) i += 1;
    i += 1;
  }
  const target = args.slice(i).find((a) => !a.startsWith("-"));
  if (!target) return;
  const tbin = baseName(target);
  if (tbin === "rimraf" || tbin === "del" || tbin === "del-cli" || tbin === "trash") {
    acc.destructive = true;
    acc.reasons.push(`${tbin} via runner`);
    return;
  }
  if (FORMATTERS.has(tbin)) {
    if (hasFlag(args, ["-w", "--write", "--fix", "-i"])) {
      acc.mutating = true;
      acc.reasons.push(`${tbin} --write/--fix`);
    } else {
      acc.verification = true;
    }
    return;
  }
  if (DIRECT_TEST_BINS.has(tbin)) acc.verification = true;
}

function classifyInterpreterScript(bin, args, depth, acc) {
  if (args.includes("--test") || args.includes("--test-only")) {
    acc.verification = true;
  }
  const ei = args.findIndex((a) => a === "-e" || a === "--eval" || a === "-p" || a === "--print");
  if (ei >= 0 && args[ei + 1] !== undefined) {
    inspectScriptString(args[ei + 1], depth, acc);
  }
}

function classifyDeno(args, acc) {
  const sub = args.find((a) => !a.startsWith("-"));
  if (sub === "test" || sub === "lint" || sub === "check") acc.verification = true;
  if (sub === "install" || sub === "cache" || sub === "add") {
    acc.mutating = true;
    acc.reasons.push(`deno ${sub}`);
  }
}

function classifyPython(args, depth, acc) {
  const mi = args.findIndex((a) => a === "-m");
  if (mi >= 0) {
    const mod = args[mi + 1];
    if (mod === "pytest" || mod === "unittest" || mod === "nose" || mod === "tox") acc.verification = true;
    if (mod === "pip") {
      const sub = args.slice(mi + 2).find((a) => !a.startsWith("-"));
      if (sub && PKG_MUTATING_SUBCMDS.has(sub)) {
        acc.mutating = true;
        acc.reasons.push(`pip ${sub}`);
      }
    }
  }
  const ci = args.findIndex((a) => a === "-c");
  if (ci >= 0 && args[ci + 1] !== undefined) inspectScriptString(args[ci + 1], depth, acc);
}

function classifyPerlRuby(bin, args, depth, acc) {
  if (bin === "perl" && args.some((a) => /^-.*i/.test(a) && /^-.*p/.test(a))) {
    acc.mutating = true;
    acc.reasons.push("perl -pi in-place");
  }
  const ei = args.findIndex((a) => a === "-e" || a === "-E");
  if (ei >= 0 && args[ei + 1] !== undefined) inspectScriptString(args[ei + 1], depth, acc);
}

function classifyAwk(args, depth, acc) {
  const program = args.find((a) => !a.startsWith("-"));
  if (program) {
    const m = program.match(/system\s*\(\s*["']([^"']*)["']\s*\)/);
    if (m) analyzeInto(m[1], depth + 1, acc);
    if (/print\b[^>]*>[^>]/.test(program)) {
      acc.mutating = true;
      acc.reasons.push("awk redirect to file");
    }
  }
}

/**
 * Heuristic inspection of an interpreter script string for filesystem effects.
 * Note: alternatives are NOT wrapped in a single `\b…\b` because several
 * dot-prefixed members (`.rmSync`, `.write_text`) would never match after a
 * non-word character such as `)`.
 */
const SCRIPT_DELETE_RE = /(os\.remove|os\.unlink|os\.rmdir|shutil\.rmtree|\.rmSync\b|\.rmdirSync\b|fs\.rm\(|fs\.rmSync|fs\.unlink|\.unlink\(|rimraf)/;
const SCRIPT_WRITE_RE = /(writeFile|appendFile|copyFile|mkdir|createWriteStream|\.write_text|\.write_bytes|shutil\.copy|shutil\.move|open\s*\([^)]*['"][wax]\+?['"])/;
/** Sinks where an interpreter shells out; the quoted argument is a real command. */
const SCRIPT_EXEC_RE = /(?:os\.system|os\.popen|subprocess\.(?:run|call|Popen|check_output|check_call)|child_process\.\w+|execSync|execFileSync|spawnSync|\bexecvp?\b|\bsystem|\bpopen|\bqx|`[^`]*`)/;

const EXEC_SINK_RE = /(?:os\.system|os\.popen|subprocess\.(?:run|call|Popen|check_output|check_call)|child_process\.\w+|execSync|execFileSync|spawnSync|execvp?|popen|system|qx)\s*\(/g;

/** Extract the shell command an exec sink runs (handles a string or an argv list). */
function extractExecCommand(code) {
  // Perl/Ruby backticks: `cmd`.
  const bt = code.match(/`([^`]+)`/);
  if (bt) return bt[1];
  EXEC_SINK_RE.lastIndex = 0;
  const m = EXEC_SINK_RE.exec(code);
  if (!m) return null;
  const [region] = readBalanced(code, m.index + m[0].length, "(", ")");
  const quoted = [...region.matchAll(/["']([^"']*)["']/g)].map((q) => q[1]).filter(Boolean);
  if (!quoted.length) return null;
  // argv list (`["rm","-rf","/"]`) → join; single string → use as-is.
  return /^\s*\[/.test(region) ? quoted.join(" ") : quoted[0];
}

function inspectScriptString(code, depth, acc) {
  // Interpreter that shells out: pull the command out of the exec sink's own
  // argument region (so unrelated quoted strings elsewhere are ignored).
  if (SCRIPT_EXEC_RE.test(code)) {
    const cmd = extractExecCommand(code);
    if (cmd) analyzeInto(cmd, (depth || 0) + 1, acc);
    else {
      acc.destructive = true;
      acc.reasons.push("interpreter shell-out");
    }
    return;
  }
  if (SCRIPT_DELETE_RE.test(code)) {
    acc.destructive = true;
    acc.reasons.push("interpreter filesystem deletion");
    return;
  }
  if (SCRIPT_WRITE_RE.test(code)) {
    acc.mutating = true;
    acc.reasons.push("interpreter filesystem write");
  }
}

function classifyPackageManager(bin, args, acc) {
  const positionals = args.filter((a) => !a.startsWith("-"));
  const sub = positionals[0];
  if (!sub) return;

  // go test / cargo test
  if ((bin === "go" || bin === "cargo" || bin === "dotnet" || bin === "gradle" || bin === "mvn") && (sub === "test" || sub === "vet" || sub === "check" || sub === "build")) {
    acc.verification = sub === "test" || sub === "vet" || sub === "check";
    if (bin === "go" && (sub === "get" || sub === "install" || sub === "mod")) {
      acc.mutating = true;
      acc.reasons.push(`go ${sub}`);
    }
    if ((bin === "cargo" || bin === "dotnet") && (sub === "install" || sub === "add" || sub === "update")) {
      acc.mutating = true;
      acc.reasons.push(`${bin} ${sub}`);
    }
    return;
  }

  // pnpm dlx / yarn dlx / bun x — run an arbitrary fetched binary.
  if (sub === "dlx" || (bin === "bun" && sub === "x")) {
    classifyRunner(args.slice(args.indexOf(sub) + 1), acc);
    return;
  }

  // npm/pnpm/yarn/bun
  if (PKG_MUTATING_SUBCMDS.has(sub)) {
    acc.mutating = true;
    acc.reasons.push(`${bin} ${sub}`);
    return;
  }
  if (sub === "test" || sub === "t") {
    acc.verification = true;
    return;
  }
  if (PKG_SCRIPT_RUNNERS.has(sub)) {
    const script = positionals[1];
    if (script && TEST_SCRIPT_WORDS.has(baseName(script))) acc.verification = true;
    if (script && /^(format|fix|lint:fix|lint-fix)$/.test(script)) {
      acc.mutating = true;
      acc.reasons.push(`${bin} run ${script}`);
    }
    return;
  }
  // bun test / bun run handled above; bun <file> executes a script
  if (bin === "bun" && sub === "test") acc.verification = true;
}

function classifyGit(args, depth, acc) {
  // Skip leading global options: -C <dir>, -c key=val, --git-dir=, etc.
  // A `-c` config override can weaponize git: `git -c alias.x='!rm -rf /' x`
  // or `git -c core.pager='!cmd' log` runs an embedded shell command.
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    if (args[i] === "-C") i += 2;
    else if (args[i] === "-c") {
      const kv = args[i + 1] || "";
      const val = kv.slice(kv.indexOf("=") + 1);
      if (val.startsWith("!")) analyzeInto(val.slice(1), (depth || 0) + 1, acc);
      i += 2;
    } else i += 1;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (!sub) return;

  switch (sub) {
    case "config": {
      // `git config alias.x '!rm -rf /'` (or core.pager etc.) stores a shell
      // command that runs on later invocation; analyze the embedded command.
      const shellVal = rest.find((a) => a.startsWith("!"));
      if (shellVal) analyzeInto(shellVal.slice(1), (depth || 0) + 1, acc);
      acc.mutating = true;
      acc.reasons.push("git config");
      return;
    }
    case "reflog":
      if (rest[0] === "expire" || rest[0] === "delete") {
        acc.destructive = true;
        acc.reasons.push(`git reflog ${rest[0]}`);
      }
      return;
    case "gc":
      if (rest.some((a) => a === "--prune=now" || a.startsWith("--prune=") || a === "--aggressive")) {
        acc.destructive = true;
        acc.reasons.push("git gc --prune");
      }
      return;
    case "filter-branch":
    case "filter-repo":
      acc.destructive = true;
      acc.reasons.push(`git ${sub}`);
      return;
    case "worktree":
      if (rest[0] === "remove" || rest[0] === "prune") {
        acc.destructive = true;
        acc.reasons.push(`git worktree ${rest[0]}`);
      } else {
        acc.mutating = true;
        acc.reasons.push("git worktree");
      }
      return;
    case "remote":
      if (rest[0] === "remove" || rest[0] === "rm" || rest[0] === "prune") {
        acc.mutating = true;
        acc.reasons.push(`git remote ${rest[0]}`);
      }
      return;
    case "notes":
      if (rest[0] === "prune" || rest[0] === "remove") {
        acc.mutating = true;
        acc.reasons.push(`git notes ${rest[0]}`);
      }
      return;
    case "reset":
      if (hasFlag(rest, ["--hard", "--merge", "--keep"]) || rest.some((a) => a === "--hard")) {
        acc.destructive = true;
        acc.reasons.push("git reset --hard");
      } else {
        acc.mutating = true;
        acc.reasons.push("git reset");
      }
      return;
    case "clean":
      if (hasFlag(rest, ["-f", "--force", "-d", "-x", "-X"])) {
        acc.destructive = true;
        acc.reasons.push("git clean -f");
      }
      return;
    case "checkout":
      // Destructive when explicitly discarding changes: `--` pathspec, -f/--force, or `.`.
      // KNOWN HEURISTIC GAP: `git checkout <file>` (a bare pathspec) also discards
      // that file's uncommitted edits, but a bare arg is indistinguishable from a
      // branch/ref switch (`git checkout main`) without repo state, so we do not
      // block it to avoid false-positiving the far more common branch switch. Use
      // `git restore`/`git checkout -- <file>` to make the intent explicit.
      if (rest.includes("--") || hasFlag(rest, ["-f", "--force"]) || rest.includes(".")) {
        acc.destructive = true;
        acc.reasons.push("git checkout discarding changes");
      }
      return;
    case "switch":
      if (hasFlag(rest, ["-f", "--force", "--discard-changes"])) {
        acc.destructive = true;
        acc.reasons.push("git switch --discard-changes");
      }
      return;
    case "restore":
      acc.destructive = true;
      acc.reasons.push("git restore discards worktree changes");
      return;
    case "branch":
      if (hasFlag(rest, ["-D", "-d"]) || rest.includes("-D") || rest.includes("-d") || rest.includes("--delete")) {
        acc.destructive = true;
        acc.reasons.push("git branch delete");
      }
      return;
    case "push":
      if (hasFlag(rest, ["-f", "--force"]) || rest.some((a) => a === "--force-with-lease" || a.startsWith("--force-with-lease") || a === "--delete" || a === "-d")) {
        acc.destructive = true;
        acc.reasons.push("git push --force/--delete");
      } else {
        acc.mutating = true;
        acc.reasons.push("git push");
      }
      return;
    case "update-ref":
      if (rest.includes("-d")) {
        acc.destructive = true;
        acc.reasons.push("git update-ref -d");
      }
      return;
    case "rm":
      acc.destructive = true;
      acc.reasons.push("git rm");
      return;
    case "stash":
      if (rest[0] === "drop" || rest[0] === "clear" || rest[0] === "pop") {
        acc.mutating = true;
        acc.reasons.push(`git stash ${rest[0]}`);
      }
      return;
    case "add":
    case "commit":
    case "merge":
    case "rebase":
    case "cherry-pick":
    case "revert":
    case "apply":
    case "am":
    case "mv":
    case "tag":
    case "pull":
    case "fetch":
      acc.mutating = true;
      acc.reasons.push(`git ${sub}`);
      return;
    default:
      return;
  }
}

/** Redirections to anything other than /dev/null write to the filesystem. */
function applyRedirects(redirects, acc) {
  for (const r of redirects) {
    if ((r.op === ">" || r.op === ">>" || r.op === "&>" || r.op === "2>") && r.target && !/^\/dev\/(null|stdout|stderr|tty|fd)/.test(r.target) && r.target !== "&1" && r.target !== "&2") {
      acc.mutating = true;
      acc.reasons.push(`redirect ${r.op} ${r.target}`);
    }
  }
}

/** Does any top-level command in these pipelines invoke a bare shell interpreter? */
function hasBareShell(pipelines) {
  for (const pipeline of pipelines) {
    for (const cmd of pipeline) {
      let k = 0;
      const words = cmd.words || [];
      while (k < words.length && ENV_ASSIGN.test(words[k])) k += 1;
      const head = baseName(words[k] || "");
      if (STDIN_SHELLS.has(head) && !words.includes("-c")) return true;
    }
  }
  return false;
}

/**
 * Extract the literal text emitted by an `echo`/`printf` word list, dropping
 * only echo's own leading flags (-n/-e/-E) and printf's format string — NOT the
 * inner command's flags (so `echo rm -rf x` yields `rm -rf x`, not `rm x`).
 */
function echoCommandLiteral(head, words) {
  let parts = words.slice(1);
  if (head === "echo") {
    while (parts.length && /^-[neE]+$/.test(parts[0])) parts = parts.slice(1);
  } else if (head === "printf" && parts.length && /%/.test(parts[0])) {
    parts = parts.slice(1);
  }
  return parts.join(" ") || null;
}

/** If a substitution is `echo X`/`printf X`, return X (a candidate script). */
function echoLiteralOf(substString) {
  const { pipelines } = structure(lex(substString));
  if (pipelines.length !== 1 || pipelines[0].length !== 1) return null;
  const words = pipelines[0][0].words || [];
  const head = baseName(words[0] || "");
  if (head !== "echo" && head !== "printf") return null;
  return echoCommandLiteral(head, words);
}

/** Analyze a command string, merging results into `acc`. */
function analyzeInto(rawInput, depth, acc) {
  if (depth > MAX_DEPTH || typeof rawInput !== "string" || rawInput.length === 0) return;
  const input = decodeAnsiCQuotes(rawInput);

  // Fork-bomb detection at the raw level.
  if (/:\s*\(\s*\)\s*\{[^}]*\|\s*:\s*&[^}]*\}\s*;\s*:/.test(input) || /\}\s*;\s*:\s*$/.test(input.replace(/\s+/g, " "))) {
    if (/:\(\)\{.*:\|:.*\}/.test(input.replace(/\s+/g, ""))) {
      acc.destructive = true;
      acc.reasons.push("fork bomb");
    }
  }

  const tokens = lex(input);
  const { pipelines, substs } = structure(tokens);
  for (const pipeline of pipelines) {
    pipeline.forEach((cmd, indexInPipeline) => {
      classifyCommand(cmd.words, cmd.redirects, depth, acc, pipeline, indexInPipeline);
    });
  }
  // When a bare shell interpreter is present (e.g. `bash <(echo rm -rf /)`), an
  // echoed substitution is a script fed to that shell — analyze its literal as code.
  const shellPresent = hasBareShell(pipelines);
  for (const s of substs) {
    if (shellPresent) {
      const literal = echoLiteralOf(s);
      if (literal) {
        analyzeInto(literal, depth + 1, acc);
        continue;
      }
    }
    analyzeInto(s, depth + 1, acc);
  }
}

/**
 * Analyze a shell command string and return its classification.
 * @param {string} command
 * @returns {{ destructive: boolean, mutating: boolean, verification: boolean, networkExec: boolean, reasons: string[] }}
 */
export function analyzeCommand(command) {
  const acc = { destructive: false, mutating: false, verification: false, networkExec: false, reasons: [] };
  const input = typeof command === "string" ? command.trim() : "";
  if (!input) return acc;
  try {
    analyzeInto(input, 0, acc);
  } catch {
    // A parser failure must never crash a tool call; fall back to "unknown but
    // not blocked" so the host's own permission rules still apply.
  }
  return acc;
}

/** Back-compat helpers preserving the previous public surface. */
export function looksLikeDestructiveBash(command) {
  const a = analyzeCommand(command);
  return a.destructive;
}

export function looksLikeMutatingBash(command) {
  const a = analyzeCommand(command);
  return a.destructive || a.mutating;
}

export function isVerification(command) {
  return analyzeCommand(command).verification;
}

export const __shellTest = { lex, structure, baseName, classifyGit, classifyPackageManager };
