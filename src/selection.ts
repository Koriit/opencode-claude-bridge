import fs from "node:fs"
import fsPromises from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import type { PluginInput } from "@opencode-ai/plugin"
import type { Logger } from "./logger.js"
import { type BridgeConfig, type ClaudePlugin } from "./types.js"

/** The Bun shell handle provided to plugins (`input.$`); not exported by name from the package. */
type BunShell = PluginInput["$"]

// ── settings.json supplement ──────────────────────────────────────────────────

/**
 * Read the `enabledPlugins` map from a single `settings.json` file. Returns an
 * empty object when the file is absent, unreadable, or has no `enabledPlugins`.
 */
async function readEnabledPlugins(settingsPath: string): Promise<Record<string, boolean>> {
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
  // Filter to only string→boolean entries.
  const result: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(ep)) {
    if (typeof v === "boolean") result[k] = v
  }
  return result
}

/**
 * Return the `installLocation` for a marketplace name by reading
 * `~/.claude/plugins/known_marketplaces.json`. Returns `undefined` when the
 * file is absent or the marketplace name is not found.
 */
async function resolveMarketplaceInstallLocation(
  home: string,
  marketplace: string,
): Promise<string | undefined> {
  const knownPath = path.join(home, ".claude", "plugins", "known_marketplaces.json")
  let raw: string
  try {
    raw = await fsPromises.readFile(knownPath, "utf8")
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
  const entry = (parsed as Record<string, unknown>)[marketplace]
  if (typeof entry !== "object" || entry === null) return undefined
  const loc = (entry as Record<string, unknown>)["installLocation"]
  return typeof loc === "string" ? loc : undefined
}

/**
 * Find the latest cached version directory for a plugin under
 * `~/.claude/plugins/cache/<marketplace>/<pluginName>/`. Returns `undefined` when
 * the directory is absent or has no version subdirectories.
 *
 * "Latest" is determined by `lastUpdated` from `installed_plugins.json` when
 * available; otherwise falls back to lexical sort of directory names (last wins).
 */
async function resolveLatestCachedInstallPath(
  home: string,
  marketplace: string,
  pluginName: string,
  pluginId: string,
): Promise<{ installPath: string; version: string } | undefined> {
  // First try the standard cache location.
  const cacheDir = path.join(home, ".claude", "plugins", "cache", marketplace, pluginName)
  let entries: fs.Dirent[]
  try {
    entries = await fsPromises.readdir(cacheDir, { withFileTypes: true })
  } catch {
    return undefined
  }

  const versionDirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)

  if (versionDirs.length === 0) return undefined

  // Prefer the version recorded in installed_plugins.json for this id (most reliable).
  const installedPath = path.join(home, ".claude", "plugins", "installed_plugins.json")
  try {
    const raw = await fsPromises.readFile(installedPath, "utf8")
    const data = JSON.parse(raw) as { plugins?: Record<string, Array<{ version: string; installPath: string; lastUpdated?: string }>> }
    const entries = data.plugins?.[pluginId]
    if (Array.isArray(entries) && entries.length > 0) {
      // Pick the entry with the most recent lastUpdated.
      const best = entries.reduce((a, b) =>
        (a.lastUpdated ?? "") >= (b.lastUpdated ?? "") ? a : b
      )
      if (best.installPath && fs.existsSync(best.installPath)) {
        return { installPath: best.installPath, version: best.version }
      }
    }
  } catch {
    // fall through to lexical sort
  }

  // Fall back: lexical sort, last entry wins (highest semver-ish string).
  const version = versionDirs.sort().at(-1)!
  return { installPath: path.join(cacheDir, version), version }
}

/**
 * Supplement the list returned by `claude plugin list --json` with any plugins
 * that appear as `enabledPlugins: true` in `settings.json` files (global and
 * project-level) but are absent from `cliPlugins`.
 *
 * This handles the case where a user manually edits `settings.json` to enable a
 * plugin without going through `claude plugin add` — the plugin is used by Claude
 * but never registered in `installed_plugins.json`, so it never appears in the
 * CLI output.
 *
 * For each missing id the function:
 *   1. Derives the marketplace name from the `name@marketplace` id format.
 *   2. Looks up the marketplace's `installLocation` via `known_marketplaces.json`.
 *   3. Finds the latest cached version under the standard cache path or the
 *      marketplace's `installLocation`.
 *   4. Synthesizes a `ClaudePlugin` entry and appends it to the list.
 *
 * Plugins that cannot be resolved (no cache, unknown marketplace) are skipped
 * with a debug-level log — not a warning, because a manually edited settings.json
 * may reference plugins not yet downloaded.
 */
export async function supplementFromSettings(
  cliPlugins: ClaudePlugin[],
  cwd: string,
  logger: Logger,
  home: string = os.homedir(),
): Promise<ClaudePlugin[]> {
  const cliIds = new Set(cliPlugins.map((p) => p.id))
  const extra: ClaudePlugin[] = []

  // Collect enabledPlugins from global + project settings.json files.
  const settingsPaths = [
    path.join(home, ".claude", "settings.json"),
    path.join(cwd, ".claude", "settings.json"),
  ]

  const enabledById: Record<string, { enabled: boolean; scope: "user" | "project" }> = {}
  for (const [i, sp] of settingsPaths.entries()) {
    const scope = i === 0 ? "user" : "project"
    const ep = await readEnabledPlugins(sp)
    for (const [id, enabled] of Object.entries(ep)) {
      if (enabled) enabledById[id] = { enabled, scope }
    }
  }

  for (const [id, { scope }] of Object.entries(enabledById)) {
    if (cliIds.has(id)) continue // already provided by claude plugin list

    // Parse `name@marketplace` — the last `@` segment is the marketplace.
    const atIdx = id.lastIndexOf("@")
    if (atIdx < 1) {
      logger.info(`settings.json enabledPlugins: skipping malformed id "${id}" (no @marketplace suffix)`)
      continue
    }
    const pluginName = id.slice(0, atIdx)
    const marketplace = id.slice(atIdx + 1)

    // Try to resolve the install path.
    const resolved = await resolveLatestCachedInstallPath(home, marketplace, pluginName, id)
    if (!resolved) {
      // Try marketplace installLocation as a fallback (directory-source marketplaces).
      const installLocation = await resolveMarketplaceInstallLocation(home, marketplace)
      if (installLocation) {
        const marketplacePath = path.join(installLocation, "plugins", pluginName)
        if (fs.existsSync(marketplacePath)) {
          logger.info(`settings.json supplement: resolved "${id}" via marketplace installLocation`)
          extra.push({
            id,
            version: "unknown",
            scope,
            enabled: true,
            installPath: marketplacePath,
            projectPath: scope === "project" ? cwd : null,
          })
          continue
        }
      }
      logger.info(`settings.json supplement: could not resolve installPath for "${id}"; skipping`)
      continue
    }

    logger.info(`settings.json supplement: resolved "${id}" @ ${resolved.version} (not in claude plugin list)`)
    extra.push({
      id,
      version: resolved.version,
      scope,
      enabled: true,
      installPath: resolved.installPath,
      projectPath: scope === "project" ? cwd : null,
    })
  }

  return [...cliPlugins, ...extra]
}

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
 * Returns `null` (and warns) if the CLI is absent, exits non-zero, or emits unparseable
 * output — the hook then injects nothing but still succeeds (design §10). The warning is
 * strict-promotable, so `strict` turns a missing CLI into a hard error.
 */
export async function listClaudePlugins($: BunShell, logger: Logger): Promise<ClaudePlugin[] | null> {
  let raw: string
  try {
    const out = await $`claude plugin list --json`.quiet().nothrow()
    if (out.exitCode !== 0) {
      logger.warn(
        `\`claude plugin list --json\` exited ${out.exitCode}; injecting nothing this run`,
      )
      return null
    }
    raw = out.stdout.toString()
  } catch (err) {
    logger.warn(
      `could not run the \`claude\` CLI (${err instanceof Error ? err.message : String(err)}); is it on PATH? injecting nothing this run`,
    )
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    logger.warn(`could not parse \`claude plugin list --json\` output as JSON; injecting nothing this run`)
    return null
  }
  if (!Array.isArray(parsed)) {
    logger.warn(`unexpected \`claude plugin list --json\` output (not an array); injecting nothing this run`)
    return null
  }

  const plugins: ClaudePlugin[] = []
  for (const entry of parsed) {
    if (isClaudePlugin(entry)) plugins.push(entry)
    // A malformed entry is treated like a component parse failure (§10): skip it and warn,
    // and let `strict` promote it to a hard error (default fatalInStrict). This is deliberate
    // and consistent with how strict treats other parse failures.
    else logger.warn(`skipping a malformed \`claude plugin list\` entry`)
  }
  return plugins
}

/**
 * Resolve a path to its canonical form, following symlinks. Falls back to
 * `path.resolve` when the path does not exist (e.g. a deleted project dir
 * stored in an old `claude plugin list` entry), so the result is always a
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
 * Compares canonical (realpath) forms first so symlinked project paths
 * (common on macOS where `/tmp` → `/private/tmp`, and Linux dev setups)
 * are correctly identified as equal. Falls back to lexical `path.resolve`
 * comparison as a secondary check when one side doesn't exist yet.
 */
export function samePath(a: string | null | undefined, b: string): boolean {
  if (!a) return false
  return realpathOrResolve(a) === realpathOrResolve(b) || path.resolve(a) === path.resolve(b)
}

/**
 * Apply the `mirror-claude` selection predicate (§5): an entry is selected when it is
 * enabled, not blocked, and either `user`-scoped (global) or bound to the current project.
 * The result is de-duplicated by `id` and sorted by `id` ascending so downstream naming is
 * deterministic regardless of `claude plugin list` ordering (§7).
 */
export function selectEnabledPlugins(
  plugins: ClaudePlugin[],
  config: BridgeConfig,
  cwd: string,
): ClaudePlugin[] {
  const blocked = new Set(config.blockedPlugins)
  const byId = new Map<string, ClaudePlugin>()

  for (const p of plugins) {
    if (!p.enabled) continue
    if (blocked.has(p.id)) continue
    const inScope = p.scope === "user" || samePath(p.projectPath, cwd)
    if (!inScope) continue
    if (!byId.has(p.id)) byId.set(p.id, p)
  }

  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
