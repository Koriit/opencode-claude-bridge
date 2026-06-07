# opencode-claude-bridge

> Use your Claude Code plugins inside [OpenCode](https://opencode.ai) — no porting, no copying, no
> second install.

If you already manage plugins with `claude plugin install`, this bridge makes their **commands,
agents, and skills** available in OpenCode too. It reads Claude's enabled-plugin state at OpenCode
launch and injects the components live, namespaced so they never shadow anything you already have.

It is a single plugin — no wrapper binary, no generated files, no lockfile. You run plain
`opencode`; the bridge reads `claude plugin list --json` and injects the components on each launch.

**Example.** You install a plugin in Claude:

```bash
claude plugin install code-tools@acme
```

Start OpenCode in that project, and the plugin's `audit` command, `reviewer` agent, and `SKILL.md`
skills are already there — `/audit`, the `reviewer` subagent, and so on. Nothing else to do. If a
name is already taken by one of your own items, the bridge's copy is renamed (e.g.
`/code-tools-audit`) — your item is never touched.

> **Status: early development.** Commands, agents, and skills from enabled Claude plugins are
> supported.
>
> **MCP and LSP servers are not supported.** Two problems make a straight bridge unreliable:
>
> 1. **OAuth client mismatch.** A plugin's `.mcp.json` OAuth registration is tied to Claude's OAuth
>    client — those credentials don't carry over to OpenCode, which authenticates as its own client.
>    Copying the config across does not produce a working authenticated server.
> 2. **Claude-specific porting.** MCP/LSP servers ship with Claude-specific setup and porting
>    instructions that don't translate cleanly to OpenCode, so injecting the raw `.mcp.json` /
>    `.lsp.json` is not enough to make them work.
>
> The feature has been removed for now. Track this in the project issues if you need it.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Configuration](#configuration)
  - [What gets bridged](#what-gets-bridged)
  - [What gets injected](#what-gets-injected)
- [How it works (internals)](#how-it-works-internals)
  - [No-shadowing & naming](#no-shadowing--naming)
  - [Skills: no-copy in the common case, bridge cache on collision](#skills-no-copy-in-the-common-case-bridge-cache-on-collision)
  - [Variable substitution](#variable-substitution)
  - [Security model](#security-model)
  - [Why the version is pinned](#why-the-version-is-pinned)
  - [Schema-safety invariant](#schema-safety-invariant)
- [Diagnostics](#diagnostics)
- [Development](#development)
- [Releasing (maintainer)](#releasing-maintainer)
- [License](#license)

## Requirements

- **OpenCode** `>=1.15.0 <1.16.0` (see [Why the version is pinned](#why-the-version-is-pinned)).
- The **`claude` CLI** on your `PATH` at OpenCode runtime. Reading Claude's plugin state is the
  bridge's entire job; if `claude` is missing, the bridge logs a warning and injects nothing —
  OpenCode still starts normally.

> **Windows is best-effort only.** The bridge is developed and tested on Linux/macOS. Core features
> (commands, agents, skills) should work, but path handling and `${CLAUDE_PLUGIN_ROOT}` /
> `${CLAUDE_PLUGIN_DATA}` resolution have not been validated on Windows.

## Install

Add the plugin to your **global** `~/.config/opencode/opencode.json` so it applies across all
projects. The bare-string form uses all defaults:

```jsonc
{
  "plugin": ["@koriit/opencode-claude-bridge"]
}
```

The tuple form lets you set options (all shown here at their defaults):

```jsonc
{
  "plugin": [
    [
      "@koriit/opencode-claude-bridge",
      {
        "blockedPlugins": []
      }
    ]
  ]
}
```

That's the whole install. OpenCode fetches the package with `ignoreScripts: true`, so no build step
runs — the package entry points at `src/index.ts` on purpose, and OpenCode's Bun runtime imports the
TypeScript directly. The bridge has zero runtime dependencies (every `@opencode-ai/plugin` import is
`import type`, erased at runtime).

## Configuration

All keys are optional. Unknown keys and ill-typed values are ignored with a warning.

| Key              | Type       | Default         | Meaning                                                                |
| ---------------- | ---------- | --------------- | ---------------------------------------------------------------------- |
| `blockedPlugins` | `string[]` | `[]`            | Plugin ids (`name@marketplace`) to never inject — any component type.  |
| `strict`         | boolean    | `false`         | Promote warnings (parse failures, missing CLI) to hard errors.         |
| `mode`           | `string`   | `mirror-claude` | The only accepted mode: mirror exactly Claude's enabled set.           |

### What gets bridged

The bridge runs in `mirror-claude` mode (the only mode). A Claude plugin is bridged when
`claude plugin list --json` reports it as **enabled** *and* it is in scope for the current project:

- `user`-scoped plugins always apply (they are global).
- `project`/`local`-scoped plugins apply only when their project matches your current directory.
- ids listed in `blockedPlugins` are never bridged.
- Disabled plugins (`enabled: false`) are always skipped.

### What gets injected

| Component | Default | Source & mapping                                                                                                                                                                                                                                                                                                               |
| --------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Commands  | On      | `commands/**/*.md` → `cfg.command`; `$ARGUMENTS` / `$1..n` pass through.                                                                                                                                                                                                                                                       |
| Agents    | On      | `agents/*.md` → `cfg.agent`; uses the `prompt` field; `mode` defaults to `subagent` (also `primary`/`all`); `temperature`, `top_p`, `steps`, `hidden`, `color`, `variant` pass through (sanitized).                                                                                                                            |
| Skills    | On      | `skills/<name>/SKILL.md` dirs → `cfg.skills.paths` **and** `cfg.command` by default (see [dual routing](#skills-no-copy-in-the-common-case-bridge-cache-on-collision) below); `user-invocable: false` → skill only; `disable-model-invocation: true` → command only; both set → skipped. Zero files copied in the common case. |

Commands, agents, and skills are plain text prompts and are always bridged.

> **MCP and LSP servers are not bridged.** See the [status note](#opencode-claude-bridge) above —
> Claude's MCP OAuth client doesn't carry over to OpenCode, and the servers need Claude-specific
> porting that doesn't translate, so the feature was removed.

---

## How it works (internals)

This section is reference material for maintainers and the curious — you don't need it to use the
bridge. It documents the naming rules, the skills cache, variable substitution, and the
OpenCode-internal behavior the bridge depends on.

### No-shadowing & naming

Injected items are namespaced so they **never shadow** your existing OpenCode commands, agents, or
skills (including OpenCode's built-ins). On a name collision the **bridge's item** is renamed — the
native/existing item is never touched. The rename ladder, tried in order until a free slot is found:

1. `<name>` — the bare name (e.g. `audit`)
2. `<plugin>-<name>` (e.g. `code-tools-audit`)
3. `<marketplace>-<plugin>-<name>` if still colliding
4. `<marketplace>-<plugin>-<name>-<8hex>` — deterministic SHA-256 tiebreak

`<plugin>` and `<marketplace>` are the two halves of the plugin id `name@marketplace`. Processing
order is sorted by plugin id, so the first claimant of a bare name wins deterministically across
runs. Every injected item's description is suffixed with `[plugin-id]` for traceability.

### Skills: no-copy in the common case, bridge cache on collision

Each skill in a plugin's `skills/<name>/` directory is discovered by reading its `SKILL.md`
frontmatter `name`. In the common case — no collision — the plugin's own skill directory is pushed
directly onto `cfg.skills.paths`: **zero files are copied.**

On collision (the bare name is already taken by a native OpenCode skill, a built-in, or an
earlier-processed plugin), the entire skill directory is copied to the bridge cache:

```text
~/.cache/opencode-claude-bridge/skills/<marketplace>/<plugin>/<version>/<allocatedName>/
```

The copy's `SKILL.md` frontmatter `name` is patched to the prefixed name; all other files (assets,
sub-directories) are preserved so relative references keep working. `.git` and other dot-directories
are excluded. Copies are keyed by `<marketplace>/<plugin>/<version>/<allocatedName>` and regenerated
when the source is newer; when the plugin version changes, old version directories are pruned (GC).
This cache is distinct from OpenCode's own `~/.cache/opencode/skills`.

Override the cache location with the `OPENCODE_CLAUDE_BRIDGE_CACHE_ROOT` environment variable (set
before starting OpenCode) — useful in CI or test environments.

> **URL-sourced skills:** if your `opencode.json` lists entries in `cfg.skills.urls`, the bridge
> cannot detect collisions against them at hook time (fetching URL skills would force the lazy Skill
> service to load before our injected paths). A warning is logged when URLs are present.

### Variable substitution

The bridge resolves these variables in injected content before OpenCode sees it.

| Variable                | Resolves to                                                                                                                                                                          | Available in                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `${CLAUDE_PLUGIN_ROOT}` | Plugin resolved on-disk install directory — the `installPath` from `claude plugin list --json`; in current Claude that is `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>` | Commands, agents, skills (body + SKILL.md)           |
| `${CLAUDE_PLUGIN_DATA}` | Plugin persistent data dir — `~/.claude/plugins/data/<sanitized-id>`                                                                                                                 | Commands, agents, skills (body + SKILL.md)           |
| `${CLAUDE_SKILL_DIR}`   | Skill source directory (dirname of `SKILL.md`)                                                                                                                                       | Plugin skills only (body + SKILL.md)                 |
| `${CLAUDE_SESSION_ID}`  | The literal `<use Session ID from context>` (see note)                                                                                                                               | Commands, agents, skills (body + SKILL.md)           |

`<sanitized-id>` is the plugin id with all characters outside `[a-zA-Z0-9_-]` replaced by `-`
(e.g. `my-plugin@acme` → `my-plugin-acme`).

> **`${CLAUDE_SESSION_ID}` limitation.** The bridge runs in the `config` hook, which produces a
> single config object **shared by all sessions in the same directory**. Baking a concrete session
> ID into content there would leak one session's ID into every other session that reuses the config.
> So `${CLAUDE_SESSION_ID}` is replaced with the literal `<use Session ID from context>`, which
> instructs the model to read the real ID from the system prompt. The bridge injects a
> `Session ID: <id>` line into every message's system prompt via the per-session
> `experimental.chat.system.transform` hook, making the current ID available whenever the model
> needs it.

### Security model

- Commands, agents, and skills are text prompts (lower risk) and are always bridged — but always
  namespaced so they can never shadow your own items.
- MCP and LSP servers (which would spawn processes / open connections) are **not bridged** — see the
  [status note](#opencode-claude-bridge).
- `blockedPlugins` hard-excludes plugin ids from **all** bridge injection (commands, agents,
  skills). It governs what the bridge injects; it cannot suppress commands that OpenCode's own native
  Claude-plugin integration may load independently of the bridge.
- Disabled plugins are always skipped.

### Why the version is pinned

```text
>=1.15.0 <1.16.0
```

Verified against **OpenCode 1.15.13**. The bridge relies on OpenCode-internal behavior that is not a
documented public contract (config hook shape, `cfg.skills` object layout, skill discovery paths), so
it pins a conservative same-minor window.

This range is **documentation only** — the bridge does NOT read the running OpenCode version and does
NOT warn at runtime. It relies on OpenCode-internal behavior verified against the version above and
works across versions until something actually breaks. The range is widened only after the
end-to-end suite passes against a new version.

### Schema-safety invariant

Every field copied from a Claude component into OpenCode's config is schema-validated or sanitized
before write — never raw passthrough. This is not cosmetic: OpenCode validates the *merged* config
when the TUI issues `config.get` at startup, **outside** the bridge's `config` hook try/catch. A
Claude field that violates OpenCode's schema would therefore not be caught by the bridge's non-throw
guard — it would crash the whole instance later. Injecting nothing is always safer than injecting an
invalid value. (Known cases handled: agent `color` name → hex mapping, finite `temperature`/`top_p`.)

## Diagnostics

Bridge log lines are written through OpenCode's own logging endpoint (`client.app.log`) under the
`opencode-claude-bridge` service, so they land in OpenCode's **server logs** alongside everything
else and honor OpenCode's log configuration. Logging is fire-and-forget — a logging failure can
never disrupt injection.

The bridge surfaces no in-TUI notifications. Many of its warnings reflect issues in the *plugin
author's* definitions and aren't actionable by you, so a per-session toast would be noise. To stream
the bridge's `service=opencode-claude-bridge` lines to stderr, run with `--print-logs`:

```bash
opencode --print-logs
```

Without `--print-logs` the entries still go to OpenCode's server log file; the flag just mirrors them
to stderr. Check there whenever a component you expect is missing or misbehaving.

## Development

A Bun + TypeScript package.

```bash
bun install              # install dev dependencies
bun run typecheck        # type-check src + tests
bun run build            # emit dist/
bun run test             # unit tests (sets OCB_TMPDIR=.tmp)
bun run test:e2e         # end-to-end tests (sets OCB_TMPDIR=.tmp; launches real opencode)
bun run test:all         # unit + e2e
bun run test:coverage    # unit tests with line/function coverage report
```

> **Always use `bun run test`** (the npm script), not `bun test test/` directly. The scripts set
> `OCB_TMPDIR=.tmp` to keep test scratch off a potentially small system `/tmp`.

The end-to-end suite launches a real `opencode serve` with the plugin loaded and a fake `claude` CLI
on `PATH`, then asserts behavior against the live HTTP API. It also acts as the version-compatibility
canary: run it after every OpenCode upgrade before widening the supported range.

## Releasing (maintainer)

1. Bump `version` in `package.json`, commit.
2. Create a GitHub Release with tag `v<version>` (e.g. `v0.1.1`).
3. The [publish workflow](.github/workflows/publish.yml) runs the test gates and publishes to npm
   automatically (requires the `NPM_TOKEN` repo secret — see the workflow file header for setup).

## License

MIT
