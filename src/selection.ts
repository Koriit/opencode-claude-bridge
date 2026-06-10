import fs from "node:fs"
import fsPromises from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import type { PluginInput } from "@opencode-ai/plugin"
import type { Logger } from "./logger.js"
import { type BridgeConfig, type ClaudePlugin } from "./types.js"

/** The Bun shell handle provided to plugins (`input.$`); not exported by name from the package. */
type BunShell = PluginInput["$"]

// ─────────────────────────────────────────────────────────────────────────────
// Plugin resolution overview
// ─────────────────────────────────────────────────────────────────────────────
//
// Claude Code enables a plugin if it appears as `enabledPlugins[<id>] === true`
// in ANY of its settings layers (global, project, project-local). Plugins can be
// enabled two ways:
//
//   1. Via the `claude plugin` CLI (`claude plugin add ...`) — these are recorded
//      in `~/.claude/plugins/installed_plugins.json` and surface in
//      `claude plugin list --json` with a resolved `installPath`.
//
//   2. By hand-editing `enabledPlugins` in a `settings.json` — these are NOT
//      recorded in `installed_plugins.json` and therefore NEVER appear in
//      `claude plugin list --json`, even though Claude Code loads them fine.
//
// Depending solely on `claude plugin list --json` misses case (2). To mirror
// Claude exactly we resolve enablement ourselves from the merged settings layers,
// then resolve each enabled plugin's on-disk `installPath` via the marketplace
// manifest (`claude plugin marketplace list --json` → `<installLocation>/.claude-plugin/marketplace.json`),
// falling back to the `claude plugin list --json` entry when the manifest cannot
// resolve a path (e.g. git-subdir sources cached in non-obvious locations).

// ── Settings layers ───────────────────────────────────────────────────────────

/**
 * Read the `enabledPlugins` map from a single `settings.json`-style file. Returns
 * an empty object when the file is absent, unreadable, not JSON, or has no
 * `enabledPlugins` object. Only string→boolean entries are kept.
 */
export async function readEnabledPlugins(settingsPath: string): Promise<Record<string, boolean>> {
  let raw: string
  try {
    raw = await fsPromises.readFile(settingsPath, "utf8")
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== "object" || parsed === null) return {}
  const ep = (parsed as Record<string, unknown>)["enabledPlugins"]
  if (typeof ep !== "object" || ep === null) return {}
  const result: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(ep)) {
    if (typeof v === "boolean") result[k] = v
  }
  return result
}

/** One resolved enablement decision plus the scope it came from (for diagnostics). */
interface EnablementDecision {
  /** Final merged value; only `true` entries are injected. */
  enabled: boolean
  /** Which settings layer last set the value: `user` (global) or `project`. */
  scope: "user" | "project"
}

/**
 * Merge `enabledPlugins` across the settings layers Claude reads, in precedence
 * order (later layers override earlier ones):
 *
 *   1. `<home>/.claude/settings.json`            (scope: user)
 *   2. `<cwd>/.claude/settings.json`             (scope: project)
 *   3. `<cwd>/.claude/settings.local.json`       (scope: project)
 *
 * Returns a map of id → { enabled, scope }. A later `false` correctly overrides
 * an earlier `true` (and vice versa), matching Claude's behavior.
 */
export async function mergeEnabledPlugins(
  home: string,
  cwd: string,
): Promise<Record<string, EnablementDecision>> {
  const layers: Array<{ file: string; scope: "user" | "project" }> = [
    { file: path.join(home, ".claude", "settings.json"), scope: "user" },
    { file: path.join(cwd, ".claude", "settings.json"), scope: "project" },
    { file: path.join(cwd, ".claude", "settings.local.json"), scope: "project" },
  ]

  const merged: Record<string, EnablementDecision> = {}
  for (const { file, scope } of layers) {
    const ep = await readEnabledPlugins(file)
    for (const [id, enabled] of Object.entries(ep)) {
      merged[id] = { enabled, scope }
    }
  }
  return merged
}

// ── Marketplace manifest resolution ───────────────────────────────────────────

/** A single entry from `claude plugin marketplace list --json`. */
interface MarketplaceEntry {
  name: string
  installLocation: string
}

/**
 * Run `claude plugin marketplace list --json` and return a map of marketplace
 * name → `installLocation`. Returns an empty map (and warns) on any failure —
 * resolution then relies on the `claude plugin list --json` fallback.
 */
export async function listMarketplaces(
  $: BunShell,
  logger: Logger,
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  let raw: string
  try {
    const out = await $`claude plugin marketplace list --json`.quiet().nothrow()
    if (out.exitCode !== 0) {
      logger.warn(
        `\`claude plugin marketplace list --json\` exited ${out.exitCode}; marketplace path resolution unavailable this run`,
        { fatalInStrict: false },
      )
      return result
    }
    raw = out.stdout.toString()
  } catch (err) {
    logger.warn(
      `could not run \`claude plugin marketplace list --json\` (${err instanceof Error ? err.message : String(err)}); marketplace path resolution unavailable this run`,
      { fatalInStrict: false },
    )
    return result
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    logger.warn(`could not parse \`claude plugin marketplace list --json\` output as JSON`, {
      fatalInStrict: false,
    })
    return result
  }
  if (!Array.isArray(parsed)) return result

  for (const entry of parsed) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as MarketplaceEntry).name === "string" &&
      typeof (entry as MarketplaceEntry).installLocation === "string"
    ) {
      const e = entry as MarketplaceEntry
      result.set(e.name, e.installLocation)
    }
  }
  return result
}

/**
 * Read a marketplace manifest (`<installLocation>/.claude-plugin/marketplace.json`)
 * and resolve a single plugin's on-disk directory.
 *
 * The manifest lists each plugin with a `source` field. When `source` is a string
 * it is a path relative to the marketplace root (e.g. `./plugins/kio-jvm`), which
 * resolves to `<installLocation>/<source>`. When `source` is an object
 * (`git-subdir`, `url`, etc.) the plugin is cached elsewhere by Claude and cannot
 * be resolved from the manifest alone — those return `undefined` so the caller
 * falls back to the `claude plugin list --json` entry.
 *
 * Returns the absolute install path, or `undefined` when the manifest is missing,
 * the plugin is not listed, or its `source` is not a simple relative path.
 */
export async function resolvePluginPathFromMarketplace(
  installLocation: string,
  pluginName: string,
): Promise<string | undefined> {
  const manifestPath = path.join(installLocation, ".claude-plugin", "marketplace.json")
  let raw: string
  try {
    raw = await fsPromises.readFile(manifestPath, "utf8")
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const plugins = (parsed as Record<string, unknown>)["plugins"]
  if (!Array.isArray(plugins)) return undefined

  for (const p of plugins) {
    if (typeof p !== "object" || p === null) continue
    const entry = p as Record<string, unknown>
    if (entry["name"] !== pluginName) continue
    const source = entry["source"]
    // Only simple relative-path sources are resolvable from the manifest.
    if (typeof source !== "string") return undefined
    const resolved = path.normalize(path.resolve(installLocation, source))
    return resolved
  }
  return undefined
}

// ── claude plugin list (fallback installPath source) ──────────────────────────

/** Minimal duck-type guard for one `claude plugin list --json` entry. */
function isClaudePlugin(value: unknown): value is ClaudePlugin {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  const projectPath = v["projectPath"]
  return (
    typeof v["id"] === "string" &&
    typeof v["version"] === "string" &&
    typeof v["installPath"] === "string" &&
    typeof v["enabled"] === "boolean" &&
    (v["scope"] === "user" || v["scope"] === "project" || v["scope"] === "local") &&
    // Guard projectPath so a non-string value can't later reach path.resolve and throw.
    (projectPath === undefined || projectPath === null || typeof projectPath === "string")
  )
}

/**
 * Run `claude plugin list --json` via the plugin's Bun shell and parse the result.
 * Returns `null` (and warns) if the CLI is absent, exits non-zero, or emits
 * unparseable output. A `null` result is non-fatal: resolution proceeds from the
 * settings layers and marketplace manifest alone.
 *
 * This list is now a SUPPLEMENTARY source — it provides resolved `installPath`s
 * for plugins added via `claude plugin add` (including ones cached in non-obvious
 * locations), but it is no longer the sole source of truth for enablement.
 */
export async function listClaudePlugins($: BunShell, logger: Logger): Promise<ClaudePlugin[] | null> {
  let raw: string
  try {
    const out = await $`claude plugin list --json`.quiet().nothrow()
    if (out.exitCode !== 0) {
      logger.warn(
        `\`claude plugin list --json\` exited ${out.exitCode}; relying on settings + marketplace resolution this run`,
        { fatalInStrict: false },
      )
      return null
    }
    raw = out.stdout.toString()
  } catch (err) {
    logger.warn(
      `could not run the \`claude\` CLI (${err instanceof Error ? err.message : String(err)}); is it on PATH? relying on settings + marketplace resolution this run`,
      { fatalInStrict: false },
    )
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    logger.warn(`could not parse \`claude plugin list --json\` output as JSON`, { fatalInStrict: false })
    return null
  }
  if (!Array.isArray(parsed)) {
    logger.warn(`unexpected \`claude plugin list --json\` output (not an array)`, { fatalInStrict: false })
    return null
  }

  const plugins: ClaudePlugin[] = []
  for (const entry of parsed) {
    if (isClaudePlugin(entry)) plugins.push(entry)
    else logger.warn(`skipping a malformed \`claude plugin list\` entry`, { fatalInStrict: false })
  }
  return plugins
}

// ── Path comparison (kept for compatibility / diagnostics) ─────────────────────

/**
 * Resolve a path to its canonical form, following symlinks. Falls back to
 * `path.resolve` when the path does not exist, so the result is always a
 * deterministic string and never throws.
 */
function realpathOrResolve(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/**
 * True when two filesystem paths refer to the same directory.
 *
 * Compares canonical (realpath) forms first so symlinked paths are correctly
 * identified as equal. Falls back to lexical `path.resolve` comparison as a
 * secondary check when one side doesn't exist yet.
 */
export function samePath(a: string | null | undefined, b: string): boolean {
  if (!a) return false
  return realpathOrResolve(a) === realpathOrResolve(b) || path.resolve(a) === path.resolve(b)
}

// ── Top-level resolution ───────────────────────────────────────────────────────

/**
 * Resolve the full set of plugins to inject by mirroring Claude's own enablement
 * logic, then resolving each enabled plugin's on-disk `installPath`.
 *
 * Resolution per enabled id (`name@marketplace`):
 *   1. Marketplace manifest: look up `<marketplace>`'s `installLocation` from
 *      `claude plugin marketplace list --json`, then resolve the plugin's relative
 *      `source` in `<installLocation>/.claude-plugin/marketplace.json`.
 *   2. Fallback: the matching `claude plugin list --json` entry's `installPath`
 *      (covers git-subdir/url sources and other non-trivial caching).
 *
 * Plugins that cannot be resolved by either method are skipped with a non-fatal
 * log. Blocked plugins (`config.blockedPlugins`) are excluded. Results are
 * de-duplicated by id and sorted by id ascending for deterministic downstream
 * naming.
 */
export async function resolveEnabledPlugins(
  $: BunShell,
  config: BridgeConfig,
  cwd: string,
  logger: Logger,
  home: string = os.homedir(),
): Promise<ClaudePlugin[]> {
  const blocked = new Set(config.blockedPlugins)

  // 1. Determine enablement from the merged settings layers.
  const merged = await mergeEnabledPlugins(home, cwd)

  // 2. Gather the supplementary sources for installPath resolution.
  const marketplaces = await listMarketplaces($, logger)
  const cliList = (await listClaudePlugins($, logger)) ?? []
  const cliById = new Map<string, ClaudePlugin>()
  for (const p of cliList) {
    // Keep the first occurrence; the CLI may list one id under several projects.
    if (!cliById.has(p.id)) cliById.set(p.id, p)
  }

  const byId = new Map<string, ClaudePlugin>()

  for (const [id, decision] of Object.entries(merged)) {
    if (!decision.enabled) continue
    if (blocked.has(id)) continue
    if (byId.has(id)) continue

    // Parse `name@marketplace` — the LAST `@` separates name from marketplace.
    const atIdx = id.lastIndexOf("@")
    if (atIdx < 1) {
      logger.info(`enabledPlugins: skipping malformed id "${id}" (no @marketplace suffix)`)
      continue
    }
    const pluginName = id.slice(0, atIdx)
    const marketplace = id.slice(atIdx + 1)

    // 2a. Try marketplace-manifest resolution first.
    let installPath: string | undefined
    let version = "unknown"
    const installLocation = marketplaces.get(marketplace)
    if (installLocation) {
      const resolved = await resolvePluginPathFromMarketplace(installLocation, pluginName)
      if (resolved && fs.existsSync(resolved)) installPath = resolved
    }

    // 2b. Fall back to the claude plugin list entry (resolved installPath + version).
    const cliEntry = cliById.get(id)
    if (!installPath && cliEntry && fs.existsSync(cliEntry.installPath)) {
      installPath = cliEntry.installPath
    }
    if (cliEntry) version = cliEntry.version

    if (!installPath) {
      logger.info(
        `enabledPlugins: could not resolve installPath for "${id}" (marketplace="${marketplace}"); skipping`,
      )
      continue
    }

    byId.set(id, {
      id,
      version,
      scope: decision.scope,
      enabled: true,
      installPath,
      projectPath: decision.scope === "project" ? cwd : null,
    })
  }

  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
