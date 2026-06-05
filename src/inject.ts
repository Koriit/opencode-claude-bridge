/**
 * Commands and agents injection from enabled Claude plugins into the shared OpenCode config.
 *
 * Each enabled plugin is scanned for:
 *   - `<installPath>/commands/**\/*.md`  → injected into `cfg.command`
 *   - `<installPath>/agents/*.md`        → injected into `cfg.agent`
 *
 * Names are allocated via the §7 NameAllocator seeded with cfg keys ∪ built-ins, processed
 * in the sorted-by-id order that `selectEnabledPlugins` guarantees so the first claimant
 * of any bare name wins deterministically.
 *
 * Traceability: every injected item's `description` is suffixed with `[<plugin-id>]` so a
 * renamed item can be traced back to its source plugin.
 */

import fs from "node:fs/promises"
import path from "node:path"
import type { Config } from "@opencode-ai/plugin"
import { parseFrontmatter, FRONTMATTER_PARSE_ERROR } from "./frontmatter.js"
import { NameAllocator } from "./naming.js"
import { BUILTIN_AGENT_NAMES, BUILTIN_COMMAND_NAMES } from "./opencode-builtins.js"
import type { Logger } from "./logger.js"
import type { ClaudePlugin } from "./types.js"

// ── Regex sentinels for unsupported Claude command placeholders ───────────────
// @file references: the token after @ must contain a `.` or `/` to look like a file path.
// This avoids false positives on prose like `see @user above` (bare word, no dot or slash)
// while still catching `@somefile.txt`, `@./relative`, `@/absolute`, and `@path/to/file`.
// No `/g` flag — these regexes are only used with `.test()` for detection; the `/g` flag
// makes `.test()` stateful (advances lastIndex between calls), which is a foot-gun.
const FILE_REF_RE = /(?<![\w`])@[^\s`]*[./][^\s`]*/
// !`cmd` shell-expansion placeholders.
const SHELL_EXPAND_RE = /!`([^`]+)`/

// ── OpenCode V1 injectable types ──────────────────────────────────────────────

/** The V1 shape accepted by `cfg.command[name]`. Only fields defined in ConfigCommandV1.Info. */
export interface CommandEntry {
  template: string
  description?: string
  agent?: string
  model?: string
  variant?: string
  subtask?: boolean
}

/** The V1 shape accepted by `cfg.agent[name]`. No `permission` field is emitted. */
export interface AgentEntry {
  description?: string
  mode?: "subagent" | "primary" | "all"
  prompt?: string
  model?: string
  variant?: string
  temperature?: number
  top_p?: number
  steps?: number
  hidden?: boolean
  color?: string
}

/**
 * A narrowed view of the OpenCode `Config` object that exposes only the two families
 * injected by this session. We use the SDK `Config` type in the public API and cast
 * internally, since we are intentionally mutating the shared runtime config object.
 *
 * The `Config` type from `@opencode-ai/plugin` has complex Effect/Schema-derived types
 * for `command` and `agent` that don't accept our V1 injection shapes at compile time, but
 * the runtime shape is a plain mutable object — verified empirically (Appendix A).
 */
// Kept for unit-test type assertions.
export interface InjectableConfig {
  command?: Record<string, CommandEntry> | undefined
  agent?: Record<string, AgentEntry> | undefined
}

/** Summary counters collected across all plugins in one injection run. */
export interface InjectionSummary {
  commands: number
  agents: number
  renamed: number
}

// ── File collection helpers ────────────────────────────────────────────────────

/**
 * Recursively collect all `*.md` files under `dir`, ignoring inaccessible paths.
 * Returned paths are absolute.
 */
async function collectMdFiles(dir: string): Promise<string[]> {
  const results: string[] = []
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return results
  }
  for (const name of entries) {
    const full = path.join(dir, name)
    let stat: Awaited<ReturnType<typeof fs.stat>>
    try {
      stat = await fs.stat(full)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      const sub = await collectMdFiles(full)
      results.push(...sub)
    } else if (stat.isFile() && name.endsWith(".md")) {
      results.push(full)
    }
  }
  return results
}

// ── Command name derivation ────────────────────────────────────────────────────

/**
 * Derive the bare command name from an absolute file path and the plugin's installPath.
 *
 * Mirrors OpenCode's `configEntryNameFromPath(path.relative(dir, item), ["command/", "commands/"])`:
 * strips the `commands/` or `command/` prefix from the path relative to `installPath`,
 * then removes the file extension. When no known prefix matches, falls back to
 * `path.basename(rel)` exactly as OpenCode does — so the key is always byte-identical
 * to what OpenCode would produce for the same file.
 *
 * For nested dirs under commands/ (e.g. `commands/foo/bar.md`) the result is `foo/bar`.
 */
export function commandNameFromPath(installPath: string, filePath: string): string {
  const rel = path.relative(installPath, filePath).replaceAll("\\", "/")
  let candidate: string | undefined
  for (const prefix of ["commands/", "command/"]) {
    if (rel.startsWith(prefix)) {
      candidate = rel.slice(prefix.length)
      break
    }
  }
  // OpenCode falls back to path.basename when no known prefix matches.
  const base = candidate ?? path.basename(rel)
  const ext = path.extname(base)
  return ext.length ? base.slice(0, -ext.length) : base
}

/**
 * Derive the bare agent name from an absolute file path and the plugin's installPath.
 *
 * Mirrors OpenCode's `configEntryNameFromPath(path.relative(dir, item), ["agent/", "agents/"])`.
 * Agents are flat (`agents/*.md`), so names have no slashes in practice. Falls back to
 * `path.basename` when no known prefix matches — same as OpenCode.
 */
export function agentNameFromPath(installPath: string, filePath: string): string {
  const rel = path.relative(installPath, filePath).replaceAll("\\", "/")
  let candidate: string | undefined
  for (const prefix of ["agents/", "agent/"]) {
    if (rel.startsWith(prefix)) {
      candidate = rel.slice(prefix.length)
      break
    }
  }
  const base = candidate ?? path.basename(rel)
  const ext = path.extname(base)
  return ext.length ? base.slice(0, -ext.length) : base
}

// ── Template processing ────────────────────────────────────────────────────────

/**
 * Resolve `${CLAUDE_PLUGIN_ROOT}` in a string to the absolute `installPath`.
 * `$ARGUMENTS` and `$1..$n` pass through untouched (OpenCode supports them).
 */
function resolvePluginRoot(text: string, installPath: string): string {
  return text.replaceAll("${CLAUDE_PLUGIN_ROOT}", installPath)
}

/**
 * Warn if the command template contains `@file` references or `` !`cmd` `` shell-expansion
 * placeholders — these are not supported by OpenCode and are left verbatim (§10 passthrough).
 */
function warnUnsupportedPlaceholders(template: string, commandName: string, pluginId: string, logger: Logger): void {
  if (FILE_REF_RE.test(template)) {
    logger.warn(
      `command "${commandName}" from plugin "${pluginId}" uses @file references which are not supported by OpenCode — left verbatim`,
      { fatalInStrict: false },
    )
  }
  if (SHELL_EXPAND_RE.test(template)) {
    logger.warn(
      `command "${commandName}" from plugin "${pluginId}" uses !\`cmd\` shell expansion which is not supported by OpenCode — left verbatim`,
      { fatalInStrict: false },
    )
  }
}

// ── Model string handling ─────────────────────────────────────────────────────

/**
 * Return the model string only if it already looks like `provider/model`.
 * Drop anything else rather than guessing the provider — conservative mapping per the
 * architectural decisions for this session.
 */
function modelIfMappable(model: unknown): string | undefined {
  if (typeof model !== "string") return undefined
  return model.includes("/") ? model : undefined
}

// ── Command injection for one plugin ─────────────────────────────────────────

/**
 * Scan `<installPath>/commands/**\/*.md`, parse each file, and inject into `cfg.command`.
 *
 * @returns the number of commands successfully injected.
 */
async function injectPluginCommands(
  plugin: ClaudePlugin,
  cfg: InjectableConfig,
  allocator: NameAllocator,
  summary: InjectionSummary,
  logger: Logger,
): Promise<void> {
  const commandsDir = path.join(plugin.installPath, "commands")
  const files = await collectMdFiles(commandsDir)
  if (files.length === 0) return

  // Guard: ensure cfg.command is a plain object before writing to it.
  // `typeof null === "object"`, so null must be checked explicitly.
  if (cfg.command === undefined || cfg.command === null || typeof cfg.command !== "object") {
    cfg.command = {}
  }

  for (const filePath of files) {
    let content: string
    try {
      content = await fs.readFile(filePath, "utf8")
    } catch (err) {
      logger.warn(
        `could not read command file "${filePath}" from plugin "${plugin.id}" (${err instanceof Error ? err.message : String(err)}); skipping`,
      )
      continue
    }

    const bareName = commandNameFromPath(plugin.installPath, filePath)

    const parsed = parseFrontmatter(content)
    if (parsed === FRONTMATTER_PARSE_ERROR) {
      // Opening fence found but never closed — malformed YAML, skip per §10.
      logger.warn(
        `command file "${filePath}" from plugin "${plugin.id}" has malformed frontmatter (unclosed --- fence); skipping`,
        { fatalInStrict: false },
      )
      continue
    }
    if (parsed === null) {
      // No frontmatter — treat the entire content as the template body.
      const body = content.trim()
      if (!body) continue
      const { name, renamed } = allocator.claim(plugin.id, bareName)
      const template = resolvePluginRoot(body, plugin.installPath)
      warnUnsupportedPlaceholders(template, name, plugin.id, logger)
      const entry: CommandEntry = {
        template,
        description: `${bareName} [${plugin.id}]`,
      }
      cfg.command[name] = entry
      summary.commands++
      if (renamed) summary.renamed++
      continue
    }

    const { data, body } = parsed
    if (!body) {
      logger.warn(
        `command file "${filePath}" from plugin "${plugin.id}" has no body; skipping`,
        { fatalInStrict: false },
      )
      continue
    }

    const { name, renamed } = allocator.claim(plugin.id, bareName)

    const rawDescription = typeof data["description"] === "string" ? data["description"] : undefined
    const tracedDescription = rawDescription
      ? `${resolvePluginRoot(rawDescription, plugin.installPath)} [${plugin.id}]`
      : `${bareName} [${plugin.id}]`

    const template = resolvePluginRoot(body, plugin.installPath)
    warnUnsupportedPlaceholders(template, name, plugin.id, logger)

    const entry: CommandEntry = {
      template,
      description: tracedDescription,
    }

    const agent = data["agent"]
    if (typeof agent === "string") entry.agent = agent

    const model = modelIfMappable(data["model"])
    if (model !== undefined) entry.model = model

    const variant = data["variant"]
    if (typeof variant === "string") entry.variant = variant

    const subtask = data["subtask"]
    if (typeof subtask === "boolean") entry.subtask = subtask

    cfg.command[name] = entry
    summary.commands++
    if (renamed) summary.renamed++
  }
}

// ── Agent injection for one plugin ───────────────────────────────────────────

/**
 * Scan `<installPath>/agents/*.md`, parse each file, and inject into `cfg.agent`.
 */
async function injectPluginAgents(
  plugin: ClaudePlugin,
  cfg: InjectableConfig,
  allocator: NameAllocator,
  summary: InjectionSummary,
  logger: Logger,
): Promise<void> {
  const agentsDir = path.join(plugin.installPath, "agents")
  const files = await collectMdFiles(agentsDir)
  if (files.length === 0) return

  // Guard: ensure cfg.agent is a plain object before writing to it.
  // `typeof null === "object"`, so null must be checked explicitly.
  if (cfg.agent === undefined || cfg.agent === null || typeof cfg.agent !== "object") {
    cfg.agent = {}
  }

  for (const filePath of files) {
    // Agents are flat: agents/*.md only. Ignore any nested files (Claude spec).
    const rel = path.relative(agentsDir, filePath).replaceAll("\\", "/")
    if (rel.includes("/")) continue

    let content: string
    try {
      content = await fs.readFile(filePath, "utf8")
    } catch (err) {
      logger.warn(
        `could not read agent file "${filePath}" from plugin "${plugin.id}" (${err instanceof Error ? err.message : String(err)}); skipping`,
      )
      continue
    }

    const bareName = agentNameFromPath(plugin.installPath, filePath)

    const parsed = parseFrontmatter(content)
    if (parsed === FRONTMATTER_PARSE_ERROR) {
      // Opening fence found but never closed — malformed YAML, skip per §10.
      logger.warn(
        `agent file "${filePath}" from plugin "${plugin.id}" has malformed frontmatter (unclosed --- fence); skipping`,
        { fatalInStrict: false },
      )
      continue
    }
    if (parsed === null) {
      // No frontmatter — treat the entire content as the prompt body.
      const body = content.trim()
      if (!body) continue
      const { name, renamed } = allocator.claim(plugin.id, bareName)
      const prompt = resolvePluginRoot(body, plugin.installPath)
      const entry: AgentEntry = {
        description: `${bareName} [${plugin.id}]`,
        mode: "subagent",
        prompt,
      }
      cfg.agent[name] = entry
      summary.agents++
      if (renamed) summary.renamed++
      continue
    }

    const { data, body } = parsed

    // Consistency with commands (§10): a body-less agent file is almost certainly broken.
    if (!body) {
      logger.warn(
        `agent file "${filePath}" from plugin "${plugin.id}" has no body; skipping`,
        { fatalInStrict: false },
      )
      continue
    }

    const { name, renamed } = allocator.claim(plugin.id, bareName)

    const rawDescription = typeof data["description"] === "string" ? data["description"] : undefined
    const tracedDescription = rawDescription
      ? `${resolvePluginRoot(rawDescription, plugin.installPath)} [${plugin.id}]`
      : `${bareName} [${plugin.id}]`

    const prompt = resolvePluginRoot(body, plugin.installPath)

    const entry: AgentEntry = {
      description: tracedDescription,
      mode: "subagent",
      prompt,
    }

    // Map `mode` only for the known values; drop anything unrecognized.
    const modeRaw = data["mode"]
    if (modeRaw === "subagent" || modeRaw === "primary" || modeRaw === "all") {
      entry.mode = modeRaw
    }

    const model = modelIfMappable(data["model"])
    if (model !== undefined) entry.model = model

    const variant = data["variant"]
    if (typeof variant === "string") entry.variant = variant

    const temperature = data["temperature"]
    if (typeof temperature === "number") entry.temperature = temperature

    const top_p = data["top_p"]
    if (typeof top_p === "number") entry.top_p = top_p

    const steps = data["steps"]
    if (typeof steps === "number" && Number.isInteger(steps) && steps > 0) entry.steps = steps

    const hidden = data["hidden"]
    if (typeof hidden === "boolean") entry.hidden = hidden

    const color = data["color"]
    if (typeof color === "string") entry.color = color

    cfg.agent[name] = entry
    summary.agents++
    if (renamed) summary.renamed++
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Inject commands and agents from all `plugins` into the mutable `cfg`.
 *
 * Builds one `NameAllocator` per family (commands, agents), seeded with the union of
 * existing cfg keys and the OpenCode built-in name lists. Processes plugins in the
 * order given by `plugins` (callers must pass the sorted-by-id order from
 * `selectEnabledPlugins`). Returns a summary of what was injected.
 *
 * Accepts the SDK `Config` type and casts it to `InjectableConfig` for internal use.
 * The runtime shape is a plain mutable object (verified empirically, Appendix A).
 *
 * A file that fails to read or parse is skipped with a warning; the hook does not throw
 * unless `strict` mode is on and the logger re-throws (design §10).
 */
export async function injectCommandsAndAgents(
  plugins: ClaudePlugin[],
  cfg: Config,
  logger: Logger,
): Promise<InjectionSummary> {
  const mutableCfg = cfg as unknown as InjectableConfig
  const summary: InjectionSummary = { commands: 0, agents: 0, renamed: 0 }

  if (plugins.length === 0) return summary

  // Seed the command allocator with existing cfg keys ∪ built-in command names.
  const existingCommands = new Set<string>([
    ...BUILTIN_COMMAND_NAMES,
    ...Object.keys(mutableCfg.command ?? {}),
  ])
  const commandAlloc = new NameAllocator(existingCommands)

  // Seed the agent allocator with existing cfg keys ∪ built-in agent names.
  const existingAgents = new Set<string>([
    ...BUILTIN_AGENT_NAMES,
    ...Object.keys(mutableCfg.agent ?? {}),
  ])
  const agentAlloc = new NameAllocator(existingAgents)

  for (const plugin of plugins) {
    await injectPluginCommands(plugin, mutableCfg, commandAlloc, summary, logger)
    await injectPluginAgents(plugin, mutableCfg, agentAlloc, summary, logger)
  }

  return summary
}
