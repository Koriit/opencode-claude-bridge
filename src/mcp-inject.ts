/**
 * MCP injection from enabled Claude plugins into OpenCode's flat `cfg.mcp` record.
 *
 * Only runs when the global `allowMcp` toggle is on (safe-by-default off per §8).
 *
 * Source: each plugin's top-level `<installPath>/.mcp.json` — the canonical Claude
 * MCP location (verified against real installed plugins: slack, atlassian, zoom).
 * `plugin.json` holds metadata only and never contains `mcpServers`.
 *
 * Mapping (Claude → OpenCode V1 flat shape):
 *   - `type:"http"` (remote) → `{ type:"remote", url, headers?, oauth? }`
 *   - stdio/command (no type, or `type:"stdio"`) → `{ type:"local", command:[cmd, ...args], environment? }`
 *   - `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` resolved in all string fields
 *
 * oauth: OpenCode V1 uses the same camelCase field names as Claude's `.mcp.json`
 * (`clientId`, `clientSecret`, `scope`, `callbackPort`, `redirectUri`). No rename
 * is needed — the fields are passed through directly. (Appendix B open item resolved.)
 *
 * Naming: base name `<plugin>-<server>`, then apply the §7 NameAllocator collision
 * rules vs existing `cfg.mcp` keys.
 *
 * Skip-and-warn (§10): unreadable/unparseable `.mcp.json` or a malformed server
 * entry logs a warning and that item is skipped; the hook does not throw in non-strict
 * mode.
 */

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Config } from "@opencode-ai/plugin"
import { NameAllocator, splitPluginId } from "./naming.js"
import { resolvePluginVars, pluginDataDir } from "./inject.js"
import type { Logger } from "./logger.js"
import type { ClaudePlugin } from "./types.js"

// ── OpenCode V1 MCP entry shapes ──────────────────────────────────────────────

/**
 * OpenCode V1 oauth configuration shape (same field names as Claude's `.mcp.json`).
 * Verified against OpenCode v1.15.x packages/core/src/v1/config/mcp.ts:
 * `clientId`, `clientSecret`, `scope`, `callbackPort`, `redirectUri`.
 */
export interface McpOauth {
  clientId?: string
  clientSecret?: string
  scope?: string
  callbackPort?: number
  redirectUri?: string
}

/** OpenCode V1 local MCP entry (`type:"local"`). */
export interface McpLocalEntry {
  type: "local"
  command: string[]
  environment?: Record<string, string>
  enabled?: boolean
  timeout?: number
}

/** OpenCode V1 remote MCP entry (`type:"remote"`). */
export interface McpRemoteEntry {
  type: "remote"
  url: string
  headers?: Record<string, string>
  oauth?: McpOauth | false
  enabled?: boolean
  timeout?: number
}

export type McpEntry = McpLocalEntry | McpRemoteEntry

// ── Config shape guard ────────────────────────────────────────────────────────

interface InjectableMcpConfig {
  mcp?: Record<string, McpEntry> | undefined
}

function guardMcpConfig(cfg: InjectableMcpConfig): Record<string, McpEntry> {
  if (cfg.mcp === undefined || cfg.mcp === null || typeof cfg.mcp !== "object") {
    cfg.mcp = {}
  }
  return cfg.mcp
}

// ── Claude .mcp.json schema ───────────────────────────────────────────────────

/**
 * Claude's MCP server entry as it appears in `.mcp.json`.
 * Verified against real installed plugins (slack, atlassian, zoom-skills).
 */
interface ClaudeMcpOauthObject {
  clientId?: string
  clientSecret?: string
  scope?: string
  callbackPort?: number
  redirectUri?: string
  [key: string]: unknown
}

interface ClaudeMcpServer {
  type?: "http" | "stdio" | string
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  headers?: Record<string, string>
  /** Claude oauth may be an object or `false` (to disable OAuth auto-detection). */
  oauth?: ClaudeMcpOauthObject | false
  [key: string]: unknown
}

interface ClaudeMcpJson {
  mcpServers?: Record<string, ClaudeMcpServer>
}

// ── Resolution helpers ────────────────────────────────────────────────────────

/**
 * Resolve plugin variables in all string values of a record.
 *
 * Non-string values (e.g. a numeric header or env value from a loose JSON file)
 * are silently dropped rather than reaching `String.prototype.replaceAll` and
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
    // Non-string values are dropped — they cannot be path-resolved and are
    // not valid in the target OpenCode string-record fields (headers, env).
  }
  return out
}

// ── Claude → OpenCode mapping ─────────────────────────────────────────────────

/**
 * Map a Claude `.mcp.json` server entry to an OpenCode V1 MCP entry.
 *
 * - `type:"http"` → `{ type:"remote", url, headers?, oauth? }`
 * - everything else (stdio, absent) → `{ type:"local", command:[cmd,...args], environment? }`
 * - `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` resolved in all string fields
 * - oauth fields passed through with same camelCase names (OpenCode V1 matches Claude exactly)
 *
 * Returns `null` if the entry is malformed and should be skipped.
 */
export function mapClaudeMcpServer(
  server: ClaudeMcpServer,
  installPath: string,
  dataDir: string,
): McpEntry | null {
  if (server.type === "http") {
    // Remote entry
    if (!server.url || typeof server.url !== "string") return null
    const url = resolvePluginVars(server.url, installPath, dataDir)

    const entry: McpRemoteEntry = { type: "remote", url }

    if (server.headers && typeof server.headers === "object") {
      entry.headers = resolveRecordValues(server.headers, installPath, dataDir)
    }

    if (server.oauth !== undefined) {
      if (server.oauth === false) {
        entry.oauth = false
      } else if (typeof server.oauth === "object") {
        // Pass through camelCase oauth fields verbatim — OpenCode V1 uses the
        // same field names as Claude: clientId, clientSecret, scope, callbackPort,
        // redirectUri. Verified against OpenCode src/v1/config/mcp.ts.
        const oauth: McpOauth = {}
        if (typeof server.oauth.clientId === "string") oauth.clientId = server.oauth.clientId
        if (typeof server.oauth.clientSecret === "string") oauth.clientSecret = server.oauth.clientSecret
        if (typeof server.oauth.scope === "string") oauth.scope = server.oauth.scope
        // OpenCode enforces callbackPort as an integer in [1, 65535] (Schema.isBetween).
        if (
          typeof server.oauth.callbackPort === "number" &&
          Number.isInteger(server.oauth.callbackPort) &&
          server.oauth.callbackPort >= 1 &&
          server.oauth.callbackPort <= 65535
        ) {
          oauth.callbackPort = server.oauth.callbackPort
        }
        if (typeof server.oauth.redirectUri === "string") oauth.redirectUri = server.oauth.redirectUri
        entry.oauth = oauth
      }
    }

    return entry
  }

  // Local / stdio entry
  if (!server.command || typeof server.command !== "string") return null
  const cmd = resolvePluginVars(server.command, installPath, dataDir)
  const args = Array.isArray(server.args)
    ? server.args.map((a) => (typeof a === "string" ? resolvePluginVars(a, installPath, dataDir) : String(a)))
    : []

  const entry: McpLocalEntry = { type: "local", command: [cmd, ...args] }

  if (server.env && typeof server.env === "object") {
    entry.environment = resolveRecordValues(
      server.env as Record<string, unknown>,
      installPath,
      dataDir,
    )
  }

  return entry
}

// ── Per-plugin injection ──────────────────────────────────────────────────────

/**
 * Read and parse `<installPath>/.mcp.json`. Returns the parsed object or `null`
 * if the file is absent or unreadable (caller logs and skips).
 */
async function readMcpJson(
  installPath: string,
  pluginId: string,
  logger: Logger,
): Promise<ClaudeMcpJson | null> {
  const mcpPath = path.join(installPath, ".mcp.json")
  let raw: string
  try {
    raw = await fs.readFile(mcpPath, "utf8")
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") return null // no MCP for this plugin — silent
    logger.warn(
      `could not read ".mcp.json" from plugin "${pluginId}" (${err instanceof Error ? err.message : String(err)}); skipping MCP for this plugin`,
    )
    return null
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      logger.warn(
        `".mcp.json" from plugin "${pluginId}" is not a JSON object; skipping MCP for this plugin`,
      )
      return null
    }
    return parsed as ClaudeMcpJson
  } catch (err) {
    logger.warn(
      `could not parse ".mcp.json" from plugin "${pluginId}" (${err instanceof Error ? err.message : String(err)}); skipping MCP for this plugin`,
    )
    return null
  }
}

/**
 * Inject MCP servers from one plugin's `.mcp.json` into `mcpCfg`.
 */
async function injectPluginMcp(
  plugin: ClaudePlugin,
  mcpCfg: Record<string, McpEntry>,
  allocator: NameAllocator,
  summary: McpInjectionSummary,
  logger: Logger,
): Promise<void> {
  const parsed = await readMcpJson(plugin.installPath, plugin.id, logger)
  if (parsed === null) return

  const servers = parsed.mcpServers
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    // .mcp.json exists but has no mcpServers — not an error, just nothing to inject.
    return
  }

  const dataDir = pluginDataDir(os.homedir(), plugin.id)

  // pluginPart is loop-invariant — hoist outside the per-server loop.
  const pluginPart = splitPluginId(plugin.id).plugin

  for (const [serverName, serverDef] of Object.entries(servers)) {
    if (typeof serverDef !== "object" || serverDef === null || Array.isArray(serverDef)) {
      logger.warn(
        `MCP server "${serverName}" in plugin "${plugin.id}" is not a valid object; skipping`,
      )
      continue
    }

    const mapped = mapClaudeMcpServer(serverDef as ClaudeMcpServer, plugin.installPath, dataDir)
    if (mapped === null) {
      logger.warn(
        `MCP server "${serverName}" in plugin "${plugin.id}" is missing required fields (url for http, command for local); skipping`,
      )
      continue
    }

    // Base name is always "<plugin>-<server>" per §6.4 — the plugin prefix is intentional
    // (every bridge-injected MCP name starts with the plugin name). On collision the
    // NameAllocator ladder escalates from this already-prefixed base, so a double-prefix
    // on collision (e.g. "<plugin>-<plugin>-<server>") is correct, not a bug.
    // pluginPart is hoisted outside the loop (splitPluginId is loop-invariant).
    const baseName = `${pluginPart}-${serverName}`
    const { name, renamed } = allocator.claim(plugin.id, baseName)

    mcpCfg[name] = mapped
    summary.servers++
    if (renamed) summary.renamed++
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Summary counters for MCP injection collected across all plugins. */
export interface McpInjectionSummary {
  servers: number
  renamed: number
  skippedPolicy: number
}

/**
 * Count MCP servers in a plugin's `.mcp.json` without any validation or warnings.
 * Used only for the policy-gate summary when `allowMcp` is off — a user who opted out
 * should not see per-entry warnings from plugins they never enabled.
 * Returns 0 if the file is absent, unreadable, or malformed.
 */
async function countMcpServersQuiet(installPath: string): Promise<number> {
  const mcpPath = path.join(installPath, ".mcp.json")
  try {
    const raw = await fs.readFile(mcpPath, "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === "object" && parsed !== null && "mcpServers" in parsed) {
      const servers = (parsed as { mcpServers?: unknown }).mcpServers
      if (typeof servers === "object" && servers !== null && !Array.isArray(servers)) {
        return Object.keys(servers).length
      }
    }
    return 0
  } catch {
    return 0
  }
}

/**
 * Inject MCP servers from all `plugins` into the mutable `cfg`.
 *
 * When `allowMcp` is false, logs a policy summary and injects nothing.
 * Builds one `NameAllocator` seeded with existing `cfg.mcp` keys.
 * Processes plugins in the order given (caller passes sorted-by-id order).
 */
export async function injectMcp(
  plugins: ClaudePlugin[],
  cfg: Config,
  allowMcp: boolean,
  logger: Logger,
): Promise<McpInjectionSummary> {
  const summary: McpInjectionSummary = { servers: 0, renamed: 0, skippedPolicy: 0 }

  if (!allowMcp) {
    // Policy gate: count potential servers without per-entry validation — a user who
    // opted out of MCP should not see MCP-config warnings from plugins they never enabled.
    let totalServers = 0
    for (const plugin of plugins) {
      totalServers += await countMcpServersQuiet(plugin.installPath)
    }
    summary.skippedPolicy = totalServers
    if (totalServers > 0) {
      logger.info(`skipped ${totalServers} MCP server(s) (policy: allowMcp is off)`)
    }
    return summary
  }

  if (plugins.length === 0) return summary

  const mutableCfg = cfg as unknown as InjectableMcpConfig
  const mcpCfg = guardMcpConfig(mutableCfg)

  // Seed the allocator with existing cfg.mcp keys.
  const existingMcp = new Set<string>(Object.keys(mcpCfg))
  const allocator = new NameAllocator(existingMcp)

  for (const plugin of plugins) {
    await injectPluginMcp(plugin, mcpCfg, allocator, summary, logger)
  }

  return summary
}
