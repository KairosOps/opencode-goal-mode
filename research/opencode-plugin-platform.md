# OpenCode plugin platform — verified reference

Facts verified against `@opencode-ai/plugin@1.15.13` (the installed type
definitions) and the `sst/opencode` source at tag `v1.15.13`. This is the
pinned runtime reference the `goal-guard` plugin is engineered against; the npm
latest was `1.16.2` when this document was refreshed, so claims below are
version-scoped unless explicitly called out as current-docs behavior.

Primary sources: OpenCode schema (`https://opencode.ai/config.json`), OpenCode
config/agents/plugins docs (`https://opencode.ai/docs/config/`,
`https://opencode.ai/docs/agents/`, `https://opencode.ai/docs/plugins/`),
plugin source at `https://raw.githubusercontent.com/sst/opencode/v1.15.13/`,
and npm metadata for `@opencode-ai/plugin`.

## Plugin discovery

- Auto-discovery glob is `{plugin,plugins}/*.{ts,js}` — **single level only**
  (`config/plugin.ts`). Files directly under `plugins/` become plugins; files
  in **subdirectories** (e.g. `plugins/goal-guard/state.js`) are **not**
  auto-loaded. This is what lets Goal Mode ship a multi-file plugin: the entry
  `plugins/goal-guard.js` imports its modules from `plugins/goal-guard/`
  relatively, and those modules are never treated as standalone plugins.
- Scanned directories include `~/.config/opencode`, every `.opencode` from the
  session directory up to the worktree, `~/.opencode`, and `$OPENCODE_CONFIG_DIR`.
- TypeScript plugins load natively (Bun); no build step is required.
- The config `plugin` array also accepts npm package names and `["spec", options]`
  tuples; the second tuple element arrives as the plugin factory's second arg.
  Auto-discovered plugins receive `options === undefined`.
- Current OpenCode docs prefer plural config directories such as
  `.opencode/plugins/`; singular directories are backward-compatible.

## Hooks (the ones Goal Mode uses)

| Hook | Input → Output | Notes |
| --- | --- | --- |
| `chat.message` | `{sessionID, agent?}` → `{message, parts}` | Captures the user's goal text. |
| `chat.params` | `{sessionID, agent, model, …}` → params | Tracks the current agent. |
| `experimental.chat.system.transform` | `{sessionID?, model}` → `{system: string[]}` | Inject system-prompt strings. |
| `tool.execute.before` | `{tool, sessionID, callID}` → `{args}` | **Throwing blocks the tool** and the thrown message becomes the tool's error result shown to the model. `args` are on the **output**, not the input. Mutate `output.args` in place. |
| `tool.execute.after` | `{tool, sessionID, callID, args}` → `{title, output, metadata}` | The `task` tool's output wraps the subagent text in `<task><task_result>…</task_result></task>`. |
| `experimental.text.complete` | `{sessionID, messageID, partID}` → `{text}` | The returned `text` **is persisted** to the transcript. No `agent` field — gate on tracked `active` state. |
| `experimental.session.compacting` | `{sessionID}` → `{context: string[], prompt?}` | Append preservation context. |
| `event` | `{event}` | Directory-scoped; `file.edited`, `session.idle`, etc. `file.edited` carries `{file}` and **no** sessionID. |
| `tool` | `{ [id]: ToolDefinition }` | Custom tools; the object key is the tool name verbatim. `tool.schema` is zod. |

## Critical version-specific facts

- **`permission.ask` is dormant in 1.15.13.** The hook is declared in the type
  but has **zero trigger sites** in the runtime. A guard must enforce via
  `tool.execute.before` throws, not this hook.
- **Subagent `task` runs in a NEW child session.** The `task` tool's
  before/after fire in the **parent** session with the subagent's final text;
  the subagent's own internal tool calls fire under the **child** sessionID.
  This is why Goal Mode records review verdicts via the task path (parent) and
  treats agent-path verdicts as same-session only.
- **Agent frontmatter** (`{agent,agents}/**/*.md`, recursive): `model`,
  `variant`, `temperature`, `top_p`, `prompt`, `description`, `mode`
  (`primary|subagent|all`), `hidden`, `disable`, `color` (hex or theme literal),
  `steps`, `options`, `permission`. **Unknown keys are silently folded into
  `options`** — so a typo'd key disappears rather than erroring.
  `ext_mcp_server_trust` is **not a real key**.
- **Command frontmatter** (`{command,commands}/**/*.md`): `template`,
  `description`, `agent`, `model`, `variant`, `subtask`. Unlike agents, a
  **command with an unknown key throws** a parse error.
- **Current built-in agents include `build`, `plan`, `general`, `explore`, and
  `scout`.** Goal Mode allows delegation to the stock `explore`, `general`, and
  `scout` subagents from its primary agent.
- **Permissions** are last-matching-rule-wins; `deny` from any scope beats
  `allow`. Per-tool pattern maps are supported for `bash`, `task`,
  `external_directory`, etc.

## State persistence

There is **no** plugin key/value store. Plugins persist their own JSON; the XDG
state dir (`$XDG_STATE_HOME/opencode/…`, default `~/.local/state`) is the
durable, disposable-cache-free location. `PluginInput.directory` is the session
working dir; `PluginInput.worktree` is the git worktree root (a stable
per-project key).

## Pitfalls

- Hooks run sequentially across plugins in load order, awaited one by one — a
  throw in a `chat.*`/`text.complete` hook can break the turn, so keep them
  defensive (Goal Mode wraps each in try/catch).
- A failed dynamic `import()` of a plugin file is cached for the process; editing
  a plugin requires restarting OpenCode.
- `experimental.text.complete` runs at text-end; streaming deltas already
  emitted the original text, so the rewrite is a final-form correction, not a
  pre-display redaction.
