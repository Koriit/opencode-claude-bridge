# opencode-claude-bridge

An [OpenCode](https://opencode.ai) plugin that bridges your **enabled Claude Code plugins** —
the bundles managed by `claude plugin install` and stored under `~/.claude/plugins/cache/…` — into
OpenCode at runtime. Their **commands, agents, skills** (and, opt-in, **MCP** and **LSP** servers)
become available inside OpenCode, namespaced so they never shadow your existing items.

It is a single plugin: no wrapper binary, no generated files, no lockfile. You run plain
`opencode`; the plugin reads Claude's enabled-plugin state via `claude plugin list --json` and
injects the components live on each launch.

> **Status.** Early development. Commands, agents, skills, MCP servers, and LSP servers from
> enabled Claude plugins are all injected into OpenCode (see below). MCP and LSP are opt-in and
> off by default.

## Requirements

- **OpenCode** within the supported range below.
- The **`claude` CLI** on your `PATH` at OpenCode runtime — the bridge's entire purpose is reading
  Claude's plugin state. If it is missing, the bridge logs a warning and injects nothing (OpenCode
  still starts normally).

> **Windows support is best-effort only.** The bridge is developed and tested on Linux/macOS.
> Core features (commands, agents, skills) should work, but edge cases — particularly around
> path handling and `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` resolution — have not
> been validated on Windows.

### Supported OpenCode version

```text
>=1.15.0 <1.16.0
```

Verified against **OpenCode 1.15.10**. The bridge relies on OpenCode-internal behavior that is not
a documented public contract, so it pins a conservative same-minor window. At startup it reads the
running OpenCode version and logs a one-line warning if you are outside this range — it still
attempts to work, but treat that as untested. The range is widened only after the end-to-end suite
passes against a new version.

## Install

Add the plugin to your **global** `~/.config/opencode/opencode.json` so it applies across all
projects:

```jsonc
{
  "plugin": [
    [
      "@koriit/opencode-claude-bridge",
      {
        "allowMcp": false,
        "allowLsp": false,
        "blockedPlugins": []
      }
    ]
  ]
}
```

The bare-string form works too and uses all defaults:

```jsonc
{
  "plugin": ["@koriit/opencode-claude-bridge"]
}
```

**How it works.** OpenCode installs plugins via Arborist with `ignoreScripts: true` — no build step
runs on install. The package entry points at `src/index.ts` intentionally: OpenCode runs on Bun,
which imports TypeScript directly. Zero runtime dependencies; all `@opencode-ai/plugin` imports are
`import type` (erased at runtime).

### Releasing (maintainer)

1. Bump `version` in `package.json`, commit.
2. Create a GitHub Release with tag `v<version>` (e.g. `v0.1.1`).
3. The [publish workflow](.github/workflows/publish.yml) runs the test gates and publishes to npm
   automatically (requires the `NPM_TOKEN` secret to be configured in the repo — see the workflow
   file header for setup instructions).

## Configuration

All keys are optional; the table shows their defaults.

| Key              | Type              | Default         | Meaning                                                        |
| ---------------- | ----------------- | --------------- | -------------------------------------------------------------- |
| `mode`           | `"mirror-claude"` | `mirror-claude` | The only accepted mode (mirror exactly Claude's enabled set).  |
| `allowMcp`       | boolean           | `false`         | Inject MCP servers from plugins (global on/off).               |
| `allowLsp`       | boolean           | `false`         | Inject LSP servers from plugins (global on/off).               |
| `blockedPlugins` | `string[]`        | `[]`            | Plugin ids (`name@marketplace`) to never inject.               |
| `strict`         | boolean           | `false`         | Promote warnings (parse failures, missing CLI) to hard errors. |

Unknown keys and ill-typed values are ignored with a warning.

### What gets bridged (`mirror-claude`)

A Claude plugin is bridged when `claude plugin list --json` reports it as **enabled** and it is in
scope for the current project:

- `user`-scoped plugins always apply (they are global).
- `project`/`local`-scoped plugins apply only when their project matches your current directory.
- ids listed in `blockedPlugins` are never bridged.

### What is injected

| Component | Status   | Notes                                                                                                                                                                                                  |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Commands  | Injected | `commands/**/*.md` → `cfg.command`; `$ARGUMENTS`/`$1..n` pass through                                                                                                                                  |
| Agents    | Injected | `agents/*.md` → `cfg.agent`; `prompt` field (not `system`); `mode` defaults to `subagent` (also accepts `primary`/`all`); `temperature`, `top_p`, `steps`, `hidden`, `color`, `variant` passed through |
| Skills    | Injected | `skills/<name>/SKILL.md` dirs → `cfg.skills.paths`; zero files copied in the common case; collision-renamed copies go to `~/.cache/opencode-claude-bridge/skills/` (see below)                         |
| MCP       | Injected | Opt-in (`allowMcp: true`). Source: `<installPath>/.mcp.json`. Claude `type:"http"` → OpenCode `type:"remote"`; stdio/command → `type:"local"`. Processes spawned on connection.                        |
| LSP       | Injected | Opt-in (`allowLsp: true`). Source: `<installPath>/.lsp.json`. `cfg.lsp === false` is respected. Processes spawned per file-type activation.                                                            |

### Skills: no-copy in the common case, bridge cache on collision

Each skill in a plugin's `skills/<name>/` directory is discovered by reading its `SKILL.md`
frontmatter `name`. In the common case — no name collision — the plugin's own skill directory is
pushed directly onto `cfg.skills.paths`: **zero files are copied**.

When a collision is detected (the bare name is already taken by a native OpenCode skill, a built-in,
or an earlier-processed plugin), the entire skill directory is copied to the bridge cache at:

```text
~/.cache/opencode-claude-bridge/skills/<marketplace>/<plugin>/<version>/<allocatedName>/
```

where `<marketplace>` and `<plugin>` are the two halves of the plugin id (e.g. `acme` and
`my-plugin` from `my-plugin@acme`). The copy's `SKILL.md` frontmatter `name` is patched to
the prefixed name; all other files (assets, sub-directories) are preserved so relative references
within the skill continue to work. The `.git` directory and other dot-directories are excluded
from copies.

Copies are keyed by `<marketplace>/<plugin>/<version>/<allocatedName>` and regenerated when the
source is newer. When the plugin version changes, the old version's cache directories are pruned
automatically (version GC). The bridge cache is distinct from OpenCode's own
`~/.cache/opencode/skills`.

To override the cache location (e.g. in CI or test environments), set the
`OPENCODE_CLAUDE_BRIDGE_CACHE_ROOT` environment variable before starting OpenCode.

> **URL-sourced skills:** if your `opencode.json` lists entries in `cfg.skills.urls`, the bridge
> cannot detect collision against them at hook time (fetching URL skills would force the lazy Skill
> service to load before our injected paths). A warning is logged when URLs are present.

### Variable substitution

The bridge resolves the following variables in injected content before OpenCode sees it.

| Variable | Resolves to | Available in |
|---|---|---|
| `${CLAUDE_PLUGIN_ROOT}` | Plugin versioned install path — `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>` | Commands, agents, skills (body + SKILL.md), MCP, LSP |
| `${CLAUDE_PLUGIN_DATA}` | Plugin persistent data dir — `~/.claude/plugins/data/<sanitized-id>` | Commands, agents, skills (body + SKILL.md), MCP, LSP |
| `${CLAUDE_SKILL_DIR}` | Skill source directory (dirname of `SKILL.md`) | Plugin skills only (body + SKILL.md) |
| `${CLAUDE_SESSION_ID}` | Current OpenCode session ID | Native/local skills (SKILL.md patched on first message once session ID is available); the model resolves it in other contexts from the `Session ID:` line the bridge injects into the system prompt |

`<sanitized-id>` is the plugin id with all characters outside `[a-zA-Z0-9_-]` replaced by `-`
(e.g. `my-plugin@acme` → `my-plugin-acme`).

### MCP servers (opt-in)

When `allowMcp: true`, the bridge reads each enabled plugin's top-level `.mcp.json` and injects
the declared servers into OpenCode's flat `cfg.mcp` record. The mapping:

- Claude `type:"http"` → OpenCode `{ type:"remote", url, headers?, oauth? }`
- Claude stdio/command servers → OpenCode `{ type:"local", command:[cmd, ...args], environment? }`
- All string fields support variable substitution (see above).
- OAuth: the `clientId`, `callbackPort`, etc. field names are identical between Claude and OpenCode.

**Name:** `<plugin>-<server>` (e.g. a plugin `slack@official` with server `slack` becomes
`slack-slack`). The same no-shadowing + collision-rename rules apply.

Because MCP servers spawn external processes (and can initiate network connections), they are
gated behind an explicit `allowMcp: true` toggle — **off by default.**

### LSP servers (opt-in)

When `allowLsp: true`, the bridge reads each enabled plugin's top-level `.lsp.json` and injects
the declared servers into `cfg.lsp`. The mapping:

- Claude `command` (string) + `args` (array) → OpenCode `command` (string array)
- Claude `extensionToLanguage` keys (e.g. `{ ".rs": "rust" }`) → OpenCode `extensions` array
- `env`, `initializationOptions` (falling back to `settings`) → `env`, `initialization`
  (only one is used; `initializationOptions` takes precedence — they do not merge)
- All string fields (command, args, env) support variable substitution (see above).
- Servers with no `.`-prefixed keys in `extensionToLanguage`, or with `transport: "socket"`,
  are skipped with a warning (OpenCode requires `extensions` for custom LSP servers and has
  no socket transport support).

**`cfg.lsp === false` is respected.** If the user explicitly set `lsp: false` in their
`opencode.json`, the bridge injects no LSP servers. This only skips LSP — commands, agents,
skills, and MCP still inject normally.

**Name:** `<plugin>-<server>` with the same collision-rename ladder.

Because LSP servers spawn external processes, they are gated behind `allowLsp: true` — **off by
default.**

> **LSP source note:** the `.lsp.json` convention is derived from Claude Code's plugin loader
> source. No real installed Claude LSP plugin with a `.lsp.json` was available to validate against
> at the time of implementation; validate against a live LSP plugin if you enable this feature.

### No-shadowing & naming

Injected items are namespaced so they **never shadow** your existing OpenCode commands, agents, or
skills (including OpenCode's built-ins). When a name collision is detected the **bridge's item** is
renamed — the native/existing item is never touched. The rename ladder:

1. `<plugin>-<name>` (e.g. `kio-development-audit`)
2. `<marketplace>-<plugin>-<name>` if still colliding
3. `<marketplace>-<plugin>-<name>-<8hex>` deterministic hash tiebreak

Processing order is sorted by plugin id, so the first claimant of a bare name wins
deterministically across runs.

Every injected item's description is suffixed with `[plugin-id]` for traceability.

### Security defaults

Commands, agents, and skills are text prompts (lower risk) and are always bridged — but always
namespaced so they can never shadow your own items. MCP and LSP servers **spawn processes** and
can initiate network connections, so they are gated behind the explicit `allowMcp` / `allowLsp`
toggles, both **off by default**.

- `blockedPlugins` hard-excludes plugin ids from all injection (commands, agents, skills, MCP, LSP).
- The `allowMcp`/`allowLsp` toggles are all-or-nothing per type — there is no per-plugin trust level.
- Disabled plugins (those reported as `enabled: false` by `claude plugin list --json`) are always skipped.

## Development

This is a Bun + TypeScript package.

```bash
bun install              # install dev dependencies
bun run typecheck        # type-check src + tests
bun run build            # emit dist/
bun run test             # unit tests (sets OCB_TMPDIR=.tmp)
bun run test:e2e         # end-to-end tests (sets OCB_TMPDIR=.tmp; launches real opencode)
bun run test:all         # unit + e2e
bun run test:coverage    # unit tests with line/function coverage report
```

> **Note on test commands:** always use `bun run test` (the npm script) rather than `bun test test/`
> directly. The scripts set `OCB_TMPDIR=.tmp` to keep test scratch off a potentially small system
> `/tmp`.

### Bridge diagnostics

Bridge log lines are prefixed `[opencode-claude-bridge]` and are written to the
`opencode` process's **stderr**. OpenCode does not rebind `console.*` and does not
capture plugin output into its own log file — the bridge's messages only reach
OpenCode's log file if they are written through OpenCode's own `Log.*` API, which
the bridge does not use.

**In-TUI nudge.** If the bridge emitted any warnings during startup, a single
`warning` toast appears on your first message in the TUI:

> opencode-claude-bridge encountered issues — run with --print-logs for details

The toast is deferred to your first chat interaction (rather than shown at startup)
because the TUI's event subscription is not yet guaranteed at the moment the config
hook runs (the hook fires on the first instance request, concurrent with the TUI
subscribing to the server's event stream). The toast fires at most once per session.

**Full diagnostic detail.** To see every `[opencode-claude-bridge]` log line,
run `opencode` (or `opencode serve`) with `--print-logs`:

```bash
opencode --print-logs
```

In non-TUI mode (`opencode serve`) or when running without `--print-logs`, all
bridge output goes to stderr only — the toast nudge is not shown in non-TUI mode.
If something appears to be missing or misbehaving, rerun with `--print-logs` to
surface the full set of skip/warn messages.

The end-to-end suite launches a real `opencode serve` with the plugin loaded and a fake `claude`
CLI on `PATH`, then asserts behavior against the live HTTP API. It also acts as the
version-compatibility canary: run it after every OpenCode upgrade before widening the supported
range.

## License

MIT
