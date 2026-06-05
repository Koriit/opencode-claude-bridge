import fs from "node:fs"
import path from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import type { Logger } from "./logger.js"
import { type BridgeConfig, type ClaudePlugin } from "./types.js"

/** The Bun shell handle provided to plugins (`input.$`); not exported by name from the package. */
type BunShell = PluginInput["$"]

/** Minimal duck-type guard for one `claude plugin list --json` entry. */
function isClaudePlugin(value: unknown): value is ClaudePlugin {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  const projectPath = v["projectPath"]
  return (
    typeof v["id"] === "string" &&
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
