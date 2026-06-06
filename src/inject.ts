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

/** Full result of {@link injectCommandsAndAgents}, including the populated command allocator. */
export interface InjectionResult extends InjectionSummary {
  commandAllocator: NameAllocator
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
 * Sanitize a plugin id for use as a filesystem path segment by replacing every
 * character that is not `[a-zA-Z0-9_-]` with `-`.
 */
export function sanitizePluginId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "-")
}

/**
 * Return the persistent data directory for a plugin under the user's home directory.
 * Path: `<home>/.claude/plugins/data/<sanitized-id>/`
 */
export function pluginDataDir(home: string, pluginId: string): string {
  return path.join(home, ".claude", "plugins", "data", sanitizePluginId(pluginId))
}

/**
 * Resolve `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` in a string.
 * `$ARGUMENTS` and `$1..$n` pass through untouched (OpenCode supports them).
 */
export function resolvePluginVars(text: string, installPath: string, dataDir: string): string {
  return text
    .replaceAll("${CLAUDE_PLUGIN_ROOT}", installPath)
    .replaceAll("${CLAUDE_PLUGIN_DATA}", dataDir)
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

// ── Agent color sanitization ──────────────────────────────────────────────────

/**
 * OpenCode's agent `color` field accepts exactly two forms (from ConfigAgentV1.Info):
 *   1. A hex string matching `^#[0-9a-fA-F]{6}$`
 *   2. One of the 7 semantic enum values: primary | secondary | accent | success | warning | error | info
 *
 * Claude Code agents use free-form CSS color names (e.g. "magenta", "cyan"). Writing these
 * raw into cfg.agent causes OpenCode's schema validation to throw at config.get — outside
 * our try/catch — crashing the entire instance.
 *
 * This regex matches form 1.
 */
const OPENCODE_HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

/**
 * The 7 semantic color tokens OpenCode accepts as an alternative to a hex code.
 */
const OPENCODE_COLOR_ENUMS = new Set(["primary", "secondary", "accent", "success", "warning", "error", "info"])

/**
 * Mapping from CSS named colors to their `#rrggbb` equivalents.
 * This covers the named colors Claude Code agents realistically use in frontmatter.
 * Standard CSS named-color hex values (per the CSS Color Level 4 spec).
 */
const CSS_COLOR_TO_HEX: Record<string, string> = {
  // Common single-word CSS colors used in Claude agent frontmatter
  aliceblue: "#f0f8ff",
  antiquewhite: "#faebd7",
  aqua: "#00ffff",
  aquamarine: "#7fffd4",
  azure: "#f0ffff",
  beige: "#f5f5dc",
  bisque: "#ffe4c4",
  black: "#000000",
  blanchedalmond: "#ffebcd",
  blue: "#0000ff",
  blueviolet: "#8a2be2",
  brown: "#a52a2a",
  burlywood: "#deb887",
  cadetblue: "#5f9ea0",
  chartreuse: "#7fff00",
  chocolate: "#d2691e",
  coral: "#ff7f50",
  cornflowerblue: "#6495ed",
  cornsilk: "#fff8dc",
  crimson: "#dc143c",
  cyan: "#00ffff",
  darkblue: "#00008b",
  darkcyan: "#008b8b",
  darkgoldenrod: "#b8860b",
  darkgray: "#a9a9a9",
  darkgreen: "#006400",
  darkgrey: "#a9a9a9",
  darkkhaki: "#bdb76b",
  darkmagenta: "#8b008b",
  darkolivegreen: "#556b2f",
  darkorange: "#ff8c00",
  darkorchid: "#9932cc",
  darkred: "#8b0000",
  darksalmon: "#e9967a",
  darkseagreen: "#8fbc8f",
  darkslateblue: "#483d8b",
  darkslategray: "#2f4f4f",
  darkslategrey: "#2f4f4f",
  darkturquoise: "#00ced1",
  darkviolet: "#9400d3",
  deeppink: "#ff1493",
  deepskyblue: "#00bfff",
  dimgray: "#696969",
  dimgrey: "#696969",
  dodgerblue: "#1e90ff",
  firebrick: "#b22222",
  floralwhite: "#fffaf0",
  forestgreen: "#228b22",
  fuchsia: "#ff00ff",
  gainsboro: "#dcdcdc",
  ghostwhite: "#f8f8ff",
  gold: "#ffd700",
  goldenrod: "#daa520",
  gray: "#808080",
  green: "#008000",
  greenyellow: "#adff2f",
  grey: "#808080",
  honeydew: "#f0fff0",
  hotpink: "#ff69b4",
  indianred: "#cd5c5c",
  indigo: "#4b0082",
  ivory: "#fffff0",
  khaki: "#f0e68c",
  lavender: "#e6e6fa",
  lavenderblush: "#fff0f5",
  lawngreen: "#7cfc00",
  lemonchiffon: "#fffacd",
  lightblue: "#add8e6",
  lightcoral: "#f08080",
  lightcyan: "#e0ffff",
  lightgoldenrodyellow: "#fafad2",
  lightgray: "#d3d3d3",
  lightgreen: "#90ee90",
  lightgrey: "#d3d3d3",
  lightpink: "#ffb6c1",
  lightsalmon: "#ffa07a",
  lightseagreen: "#20b2aa",
  lightskyblue: "#87cefa",
  lightslategray: "#778899",
  lightslategrey: "#778899",
  lightsteelblue: "#b0c4de",
  lightyellow: "#ffffe0",
  lime: "#00ff00",
  limegreen: "#32cd32",
  linen: "#faf0e6",
  magenta: "#ff00ff",
  maroon: "#800000",
  mediumaquamarine: "#66cdaa",
  mediumblue: "#0000cd",
  mediumorchid: "#ba55d3",
  mediumpurple: "#9370db",
  mediumseagreen: "#3cb371",
  mediumslateblue: "#7b68ee",
  mediumspringgreen: "#00fa9a",
  mediumturquoise: "#48d1cc",
  mediumvioletred: "#c71585",
  midnightblue: "#191970",
  mintcream: "#f5fffa",
  mistyrose: "#ffe4e1",
  moccasin: "#ffe4b5",
  navajowhite: "#ffdead",
  navy: "#000080",
  oldlace: "#fdf5e6",
  olive: "#808000",
  olivedrab: "#6b8e23",
  orange: "#ffa500",
  orangered: "#ff4500",
  orchid: "#da70d6",
  palegoldenrod: "#eee8aa",
  palegreen: "#98fb98",
  paleturquoise: "#afeeee",
  palevioletred: "#db7093",
  papayawhip: "#ffefd5",
  peachpuff: "#ffdab9",
  peru: "#cd853f",
  pink: "#ffc0cb",
  plum: "#dda0dd",
  powderblue: "#b0e0e6",
  purple: "#800080",
  rebeccapurple: "#663399",
  red: "#ff0000",
  rosybrown: "#bc8f8f",
  royalblue: "#4169e1",
  saddlebrown: "#8b4513",
  salmon: "#fa8072",
  sandybrown: "#f4a460",
  seagreen: "#2e8b57",
  seashell: "#fff5ee",
  sienna: "#a0522d",
  silver: "#c0c0c0",
  skyblue: "#87ceeb",
  slateblue: "#6a5acd",
  slategray: "#708090",
  slategrey: "#708090",
  snow: "#fffafa",
  springgreen: "#00ff7f",
  steelblue: "#4682b4",
  tan: "#d2b48c",
  teal: "#008080",
  thistle: "#d8bfd8",
  tomato: "#ff6347",
  turquoise: "#40e0d0",
  violet: "#ee82ee",
  wheat: "#f5deb3",
  white: "#ffffff",
  whitesmoke: "#f5f5f5",
  yellow: "#ffff00",
  yellowgreen: "#9acd32",
}

/**
 * Sanitize an agent `color` value for injection into OpenCode's config.
 *
 * Returns the sanitized string if it can be mapped to a valid OpenCode color,
 * or `null` if the value is unrecognizable and must be dropped. Never returns
 * a value that would fail OpenCode's `^#[0-9a-fA-F]{6}$` / enum check.
 *
 * Decision table:
 *   - Already a valid hex `#rrggbb`                  → pass through as-is
 *   - Already one of the 7 OpenCode enum tokens       → pass through as-is
 *   - A known CSS named color (case-insensitive)      → map to hex
 *   - Anything else                                   → null (caller drops + warns)
 */
export function sanitizeAgentColor(value: string): string | null {
  // Fast-path: already valid.
  if (OPENCODE_HEX_COLOR_RE.test(value)) return value
  if (OPENCODE_COLOR_ENUMS.has(value)) return value

  // Try CSS named color (case-insensitive lookup).
  const hex = CSS_COLOR_TO_HEX[value.toLowerCase()]
  if (hex !== undefined) return hex

  // Unknown — must be dropped to avoid an OpenCode schema error.
  return null
}

// ── Single-entry command injection ───────────────────────────────────────────

/**
 * Insert one command entry into `cfg.command` using the allocator, appending `[pluginId]`
 * to the description. Returns the allocated name and whether it was renamed.
 *
 * The `entry.template` must already be fully resolved by the caller (e.g. via
 * `resolvePluginVars` for commands from the plugin's commands/ dir, or verbatim for
 * skill-derived commands whose body does not use plugin variables).
 */
export function injectCommandEntry(
  bareName: string,
  entry: CommandEntry,
  cfg: InjectableConfig,
  allocator: NameAllocator,
  pluginId: string,
  logger: Logger,
): { allocatedName: string; renamed: boolean } {
  if (cfg.command === undefined || cfg.command === null || typeof cfg.command !== "object") {
    cfg.command = {}
  }

  const { name: allocatedName, renamed } = allocator.claim(pluginId, bareName)

  const rawDescription = entry.description
  const tracedDescription = rawDescription
    ? `${rawDescription} [${pluginId}]`
    : `${bareName} [${pluginId}]`

  warnUnsupportedPlaceholders(entry.template, allocatedName, pluginId, logger)

  cfg.command[allocatedName] = { ...entry, description: tracedDescription }
  return { allocatedName, renamed }
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
  home: string,
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

  const dataDir = pluginDataDir(home, plugin.id)

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
      const template = resolvePluginVars(body, plugin.installPath, dataDir)
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
      ? `${resolvePluginVars(rawDescription, plugin.installPath, dataDir)} [${plugin.id}]`
      : `${bareName} [${plugin.id}]`

    const template = resolvePluginVars(body, plugin.installPath, dataDir)
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
  home: string,
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

  const dataDir = pluginDataDir(home, plugin.id)

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
      const prompt = resolvePluginVars(body, plugin.installPath, dataDir)
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
      ? `${resolvePluginVars(rawDescription, plugin.installPath, dataDir)} [${plugin.id}]`
      : `${bareName} [${plugin.id}]`

    const prompt = resolvePluginVars(body, plugin.installPath, dataDir)

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
    // OpenCode uses Schema.Finite which rejects NaN, Infinity, and -Infinity.
    if (typeof temperature === "number" && isFinite(temperature)) entry.temperature = temperature

    const top_p = data["top_p"]
    // Same finite constraint as temperature.
    if (typeof top_p === "number" && isFinite(top_p)) entry.top_p = top_p

    const steps = data["steps"]
    if (typeof steps === "number" && Number.isInteger(steps) && steps > 0) entry.steps = steps

    const hidden = data["hidden"]
    if (typeof hidden === "boolean") entry.hidden = hidden

    const colorRaw = data["color"]
    if (typeof colorRaw === "string") {
      const color = sanitizeAgentColor(colorRaw)
      if (color !== null) {
        entry.color = color
      } else {
        logger.warn(
          `agent "${bareName}" from plugin "${plugin.id}" has unrecognized color value "${colorRaw}"; dropping color field`,
          { fatalInStrict: false },
        )
      }
    }

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
  home: string,
  logger: Logger,
): Promise<InjectionResult> {
  const mutableCfg = cfg as unknown as InjectableConfig

  // Seed the command allocator with existing cfg keys ∪ built-in command names.
  const existingCommands = new Set<string>([
    ...BUILTIN_COMMAND_NAMES,
    ...Object.keys(mutableCfg.command ?? {}),
  ])
  const commandAlloc = new NameAllocator(existingCommands)

  const summary: InjectionSummary = { commands: 0, agents: 0, renamed: 0 }

  if (plugins.length === 0) return { ...summary, commandAllocator: commandAlloc }

  // Seed the agent allocator with existing cfg keys ∪ built-in agent names.
  const existingAgents = new Set<string>([
    ...BUILTIN_AGENT_NAMES,
    ...Object.keys(mutableCfg.agent ?? {}),
  ])
  const agentAlloc = new NameAllocator(existingAgents)

  for (const plugin of plugins) {
    await injectPluginCommands(plugin, mutableCfg, commandAlloc, summary, home, logger)
    await injectPluginAgents(plugin, mutableCfg, agentAlloc, summary, home, logger)
  }

  return { ...summary, commandAllocator: commandAlloc }
}
