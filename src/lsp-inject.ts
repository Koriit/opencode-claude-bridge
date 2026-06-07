/**
 * LSP injection from enabled Claude plugins into OpenCode's `cfg.lsp` record.
 *
 * Only runs when the global `allowLsp` toggle is on AND the user has not explicitly
 * disabled all LSP via `cfg.lsp === false` (safe-by-default per §8).
 *
 * Source: each plugin's top-level `<installPath>/.lsp.json`.
 * The file format mirrors the Claude LSP plugin schema (verified from claude-code
 * `lspPluginIntegration.ts` and real installed LSP plugins):
 *
 * ```json
 * {
 *   "<serverName>": {
 *     "command": "rust-analyzer",
 *     "args": ["--arg"],
 *     "extensionToLanguage": { ".rs": "rust" },
 *     "env": { "KEY": "value" },
 *     "initializationOptions": { ... }
 *   }
 * }
 * ```
 *
 * Mapping (Claude .lsp.json → OpenCode V1 cfg.lsp entry):
 *   - `command` (string) + `args` (array) → `command` (string array)
 *   - `extensionToLanguage` keys → `extensions` (array of file-extension strings)
 *   - `env` → `env`
 *   - `initializationOptions` or `settings` → `initialization`
 *   - `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` resolved in command/args/env values
 *
 * SOURCE GAP NOTE: No real installed Claude plugin with LSP servers was available on
 * this machine (the rust-analyzer-lsp@claude-plugins-official plugin has only README/LICENSE,
 * no `.lsp.json`). The `.lsp.json` source convention is derived from claude-code source
 * (`lspPluginIntegration.ts`) which explicitly checks `join(plugin.path, '.lsp.json')`.
 * This is an Appendix-B–style open item: the mechanism is implemented and tested against
 * a synthetic fixture, but real-world `.lsp.json` files have not been confirmed against
 * a live installed plugin. Validate when an LSP plugin becomes available.
 *
 * `cfg.lsp === false` guard: if the user explicitly disabled all LSP servers, the bridge
 * injects nothing and returns immediately (§6.5 — do not override user intent). This only
 * skips LSP; commands, agents, skills, and MCP still inject as normal.
 *
 * Naming: base name `<plugin>-<server>`, then apply the §7 NameAllocator collision rules
 * vs existing `cfg.lsp` keys (when `cfg.lsp` is an object).
 */

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Config } from "@opencode-ai/plugin"
import { NameAllocator, splitPluginId } from "./naming.js"
import { resolvePluginVars, pluginDataDir } from "./inject.js"
import type { Logger } from "./logger.js"
import type { ClaudePlugin } from "./types.js"

// ── OpenCode V1 LSP entry shape ────────────────────────────────────────────────

/**
 * OpenCode V1 LSP entry shape (verified against packages/core/src/v1/config/lsp.ts).
 *
 * `cfg.lsp[name]` can be `{ disabled: true }` or a live server definition.
 * We only ever write live entries; we never write `{ disabled: true }`.
 */
export interface LspEntry {
  command: string[]
  extensions?: string[]
  disabled?: boolean
  env?: Record<string, string>
  initialization?: Record<string, unknown>
}

// ── Config shape guard ────────────────────────────────────────────────────────

interface InjectableLspConfig {
  lsp?: false | true | Record<string, LspEntry> | undefined
}

/**
 * Normalize `cfg.lsp` to a mutable object we can extend.
 *
 * Respects `cfg.lsp === false` — callers MUST check before calling this.
 * `true` and `undefined` are normalized to `{}`.
 * When already an object, returns it as-is.
 */
function guardLspConfig(cfg: InjectableLspConfig): Record<string, LspEntry> {
  if (cfg.lsp === false) {
    // Caller must not reach here; guard is defensive.
    cfg.lsp = {}
  } else if (cfg.lsp === undefined || cfg.lsp === true) {
    cfg.lsp = {}
  }
  return cfg.lsp as Record<string, LspEntry>
}

// ── Claude .lsp.json schema ───────────────────────────────────────────────────

/**
 * Claude plugin LSP server definition as read from `.lsp.json`.
 * Schema derived from claude-code `LspServerConfigSchema` (src/utils/plugins/schemas.ts).
 */
interface ClaudeLspServer {
  command?: string
  args?: string[]
  extensionToLanguage?: Record<string, string>
  env?: Record<string, string>
  initializationOptions?: unknown
  settings?: unknown
  transport?: string
  workspaceFolder?: string
  [key: string]: unknown
}

// ── Resolution helpers ────────────────────────────────────────────────────────

/**
 * Resolve plugin variables in all string values of a record.
 *
 * Non-string values (e.g. a numeric env value from a loose JSON file) are
 * silently dropped rather than reaching `String.prototype.replaceAll` and
 * throwing a TypeError that would kill the whole hook run (§10).
 */
function resolveRecordValues(
  record: Record<string, unknown>,
  installPath: string,
  dataDir: string,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(record)) {
    if (typeof v === "string") out[k] = resolvePluginVars(v, installPath, dataDir)
    // Non-string values are dropped — not valid in the target string-record fields (env).
  }
  return out
}

// ── Claude → OpenCode mapping ─────────────────────────────────────────────────

/** Discriminated result from {@link mapClaudeLspServer}. */
export type MapLspResult =
  | { ok: true; entry: LspEntry }
  | { ok: false; reason: "missing-command" | "socket-transport" | "no-extensions" }

/**
 * Map a Claude `.lsp.json` server entry to an OpenCode V1 LSP entry.
 *
 * - `command` (string) + `args` (array) → `command` (string array)
 * - `extensionToLanguage` keys → `extensions` (file extension strings, required)
 * - `env` → `env` (with plugin vars resolved)
 * - `initializationOptions` or `settings` → `initialization` (best-effort)
 * - `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` resolved in command, args, env values
 * - non-string entries in `args` are dropped; `onDroppedArg` is called for each dropped item
 * - `workspaceFolder` is not mapped (no equivalent in OpenCode V1 LSP entry shape)
 *
 * Returns a discriminated result so callers emit precise per-reason warnings. The
 * three rejection reasons are:
 *   - `"missing-command"`: no `command` string field
 *   - `"socket-transport"`: `transport: "socket"` is unsupported by OpenCode's LSP layer
 *   - `"no-extensions"`: no `.`-prefixed keys in `extensionToLanguage`; OpenCode V1
 *     requires `extensions` for any non-builtin cfg.lsp key
 */
export function mapClaudeLspServer(
  server: ClaudeLspServer,
  installPath: string,
  dataDir: string,
  onDroppedArg?: () => void,
): MapLspResult {
  if (!server.command || typeof server.command !== "string") {
    return { ok: false, reason: "missing-command" }
  }

  // OpenCode V1 LSP has no socket transport — silently misbehaves if injected as stdio.
  if (server.transport === "socket") {
    return { ok: false, reason: "socket-transport" }
  }

  const cmd = resolvePluginVars(server.command, installPath, dataDir)
  const args = Array.isArray(server.args)
    ? server.args.flatMap((a) => {
        if (typeof a === "string") return [resolvePluginVars(a, installPath, dataDir)]
        onDroppedArg?.()
        return []
      })
    : []

  const entry: LspEntry = { command: [cmd, ...args] }

  // Extract extensions from extensionToLanguage keys. OpenCode V1 REQUIRES `extensions`
  // for any non-builtin cfg.lsp key; all bridge-injected names are custom by construction.
  if (server.extensionToLanguage && typeof server.extensionToLanguage === "object") {
    const keys = Object.keys(server.extensionToLanguage).filter(
      (k) => typeof k === "string" && k.startsWith("."),
    )
    if (keys.length > 0) entry.extensions = keys
  }

  if (!entry.extensions || entry.extensions.length === 0) {
    return { ok: false, reason: "no-extensions" }
  }

  if (server.env && typeof server.env === "object") {
    entry.env = resolveRecordValues(server.env as Record<string, unknown>, installPath, dataDir)
  }

  // initializationOptions takes precedence over settings (both are best-effort).
  const initSource =
    server.initializationOptions !== undefined
      ? server.initializationOptions
      : server.settings !== undefined
        ? server.settings
        : undefined

  if (initSource !== undefined && typeof initSource === "object" && initSource !== null) {
    entry.initialization = initSource as Record<string, unknown>
  }

  return { ok: true, entry }
}

// ── Per-plugin injection ──────────────────────────────────────────────────────

/**
 * Read and parse `<installPath>/.lsp.json`. Returns the parsed servers record or
 * `null` if the file is absent (silent) or unreadable (warns and skips).
 */
async function readLspJson(
  installPath: string,
  pluginId: string,
  logger: Logger,
): Promise<Record<string, ClaudeLspServer> | null> {
  const lspPath = path.join(installPath, ".lsp.json")
  let raw: string
  try {
    raw = await fs.readFile(lspPath, "utf8")
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") return null // no LSP for this plugin — silent
    logger.warn(
      `could not read ".lsp.json" from plugin "${pluginId}" (${err instanceof Error ? err.message : String(err)}); skipping LSP for this plugin`,
    )
    return null
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      logger.warn(
        `".lsp.json" from plugin "${pluginId}" is not a JSON object; skipping LSP for this plugin`,
      )
      return null
    }
    return parsed as Record<string, ClaudeLspServer>
  } catch (err) {
    logger.warn(
      `could not parse ".lsp.json" from plugin "${pluginId}" (${err instanceof Error ? err.message : String(err)}); skipping LSP for this plugin`,
    )
    return null
  }
}

/**
 * Inject LSP servers from one plugin's `.lsp.json` into `lspCfg`.
 */
async function injectPluginLsp(
  plugin: ClaudePlugin,
  lspCfg: Record<string, LspEntry>,
  allocator: NameAllocator,
  summary: LspInjectionSummary,
  logger: Logger,
): Promise<void> {
  const servers = await readLspJson(plugin.installPath, plugin.id, logger)
  if (servers === null) return

  const dataDir = pluginDataDir(os.homedir(), plugin.id)
  const pluginPart = splitPluginId(plugin.id).plugin

  for (const [serverName, serverDef] of Object.entries(servers)) {
    if (typeof serverDef !== "object" || serverDef === null || Array.isArray(serverDef)) {
      logger.warn(
        `LSP server "${serverName}" in plugin "${plugin.id}" is not a valid object; skipping`,
      )
      continue
    }

    const result = mapClaudeLspServer(serverDef, plugin.installPath, dataDir, () => {
      logger.warn(
        `LSP server "${serverName}" in plugin "${plugin.id}" has a non-string arg entry; dropping it`,
        { fatalInStrict: false },
      )
    })
    if (!result.ok) {
      // Precise per-reason warning — the discriminated result prevents misclassification
      // if new rejection reasons are added to mapClaudeLspServer later.
      if (result.reason === "socket-transport") {
        logger.warn(
          `LSP server "${serverName}" in plugin "${plugin.id}" uses socket transport which is not supported by the bridge; skipping`,
        )
      } else if (result.reason === "missing-command") {
        logger.warn(
          `LSP server "${serverName}" in plugin "${plugin.id}" is missing required "command" field; skipping`,
        )
      } else {
        // "no-extensions": missing or empty extensionToLanguage — OpenCode requires extensions for custom servers.
        logger.warn(
          `LSP server "${serverName}" in plugin "${plugin.id}" has no "extensionToLanguage" mapping; OpenCode requires extensions for custom LSP servers — skipping`,
        )
      }
      continue
    }

    // Base name is always "<plugin>-<server>" per §6.5 — intentional prefix.
    // On collision the NameAllocator ladder escalates from this already-prefixed base.
    // pluginPart is hoisted outside the loop (splitPluginId is loop-invariant).
    const baseName = `${pluginPart}-${serverName}`
    const { name, renamed } = allocator.claim(plugin.id, baseName)

    lspCfg[name] = result.entry
    summary.servers++
    if (renamed) summary.renamed++
  }
}

/**
 * Count LSP servers in a plugin's `.lsp.json` without any validation or warnings.
 * Used only for the policy-gate summary when `allowLsp` is off.
 * Returns 0 if the file is absent, unreadable, or malformed.
 */
async function countLspServersQuiet(installPath: string): Promise<number> {
  const lspPath = path.join(installPath, ".lsp.json")
  try {
    const raw = await fs.readFile(lspPath, "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return Object.keys(parsed as object).length
    }
    return 0
  } catch {
    return 0
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Summary counters for LSP injection collected across all plugins. */
export interface LspInjectionSummary {
  servers: number
  renamed: number
  skippedPolicy: number
  /** True when cfg.lsp === false and injection was skipped per user intent. */
  skippedUserDisabled: boolean
}

/**
 * Inject LSP servers from all `plugins` into the mutable `cfg`.
 *
 * Guards:
 * 1. When `allowLsp` is false, logs a policy summary and injects nothing.
 * 2. When `cfg.lsp === false`, the user has explicitly disabled all LSP — inject
 *    nothing, but this ONLY skips LSP (commands/agents/skills/MCP still inject).
 *
 * Builds one `NameAllocator` seeded with existing `cfg.lsp` keys (when `cfg.lsp`
 * is already an object). Processes plugins in the order given (caller passes
 * sorted-by-id order).
 */
export async function injectLsp(
  plugins: ClaudePlugin[],
  cfg: Config,
  allowLsp: boolean,
  logger: Logger,
): Promise<LspInjectionSummary> {
  const summary: LspInjectionSummary = {
    servers: 0,
    renamed: 0,
    skippedPolicy: 0,
    skippedUserDisabled: false,
  }

  const mutableCfg = cfg as unknown as InjectableLspConfig

  // Guard 1: §6.5 — if user set cfg.lsp === false, respect their intent. Skip LSP only.
  if (mutableCfg.lsp === false) {
    summary.skippedUserDisabled = true
    logger.info("skipped LSP injection (cfg.lsp is false — user disabled all LSP)")
    return summary
  }

  if (!allowLsp) {
    // Policy gate: count potential servers without per-entry validation — a user who
    // opted out of LSP should not see LSP-config warnings from plugins they never enabled.
    let totalServers = 0
    for (const plugin of plugins) {
      totalServers += await countLspServersQuiet(plugin.installPath)
    }
    summary.skippedPolicy = totalServers
    if (totalServers > 0) {
      logger.info(`skipped ${totalServers} LSP server(s) (policy: allowLsp is off)`)
    }
    return summary
  }

  if (plugins.length === 0) return summary

  // Normalize cfg.lsp to an object.
  const lspCfg = guardLspConfig(mutableCfg)

  // Seed the allocator with existing cfg.lsp keys.
  const existingLsp = new Set<string>(Object.keys(lspCfg))
  const allocator = new NameAllocator(existingLsp)

  for (const plugin of plugins) {
    await injectPluginLsp(plugin, lspCfg, allocator, summary, logger)
  }

  return summary
}
