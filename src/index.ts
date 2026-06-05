import os from "node:os"
import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { parseBridgeConfig } from "./config.js"
import { injectCommandsAndAgents } from "./inject.js"
import { injectSkills } from "./skill-inject.js"
import { injectMcp } from "./mcp-inject.js"
import { injectLsp } from "./lsp-inject.js"
import { createLogger } from "./logger.js"
import { listClaudePlugins, selectEnabledPlugins } from "./selection.js"
import { collectExistingSkillNames } from "./skill-scan.js"
import { checkVersion, fetchOpencodeVersion } from "./version.js"

/**
 * The OpenCode plugin factory. Bridge options arrive as the tuple's second element
 * (`["opencode-claude-bridge", { ...options }]`) and are captured in the `config` hook's
 * closure — the hook signature carries only the config object (verified against the
 * OpenCode source). The hook resolves the set of enabled Claude plugins and injects
 * their commands, agents, skills, and (opt-in) MCP and LSP servers into the shared,
 * mutable config.
 */
export const server: Plugin = async (_input, options) => {
  const { config: bridge, warnings } = parseBridgeConfig(options)

  return {
    config: async (cfg) => {
      const logger = createLogger(bridge.strict)
      try {
        // Replay parse-time validation warnings (strict-promotable).
        for (const w of warnings) logger.warn(w)

        // §9 version-compat advisory (always soft — still attempts injection).
        const version = await fetchOpencodeVersion(_input.serverUrl)
        checkVersion(version, logger)

        // §5 mirror-claude resolution.
        const all = await listClaudePlugins(_input.$, logger)
        if (all === null) return // CLI missing/failed — already warned; inject nothing.

        const selected = selectEnabledPlugins(all, bridge, _input.directory)
        const ids = selected.map((p) => p.id).join(", ")
        logger.info(
          `resolved ${selected.length} enabled Claude plugin(s)${ids ? `: ${ids}` : ""}`,
        )

        // §6.1 commands, §6.2 agents — inline injection into the shared cfg.
        const cmdAgentSummary = await injectCommandsAndAgents(selected, cfg, logger)

        // §6.3 skills — cfg.skills.paths injection (with bridge-cache copy on collision).
        const home = os.homedir()
        const existingSkillNames = await collectExistingSkillNames({
          home,
          projectDir: _input.directory,
          skillsPaths: (cfg as unknown as { skills?: { paths?: string[] } }).skills?.paths,
          // Mirror OpenCode's RuntimeFlags so the bridge scans the same dirs OpenCode will.
          disableExternalSkills: process.env["OPENCODE_DISABLE_EXTERNAL_SKILLS"] === "true",
          disableClaudeCodeSkills:
            process.env["OPENCODE_DISABLE_CLAUDE_CODE"] === "true" ||
            process.env["OPENCODE_DISABLE_CLAUDE_CODE_SKILLS"] === "true",
        })
        const skillSummary = await injectSkills(selected, cfg, existingSkillNames, {
          home,
          projectDir: _input.directory,
          cacheRoot: process.env["OPENCODE_CLAUDE_BRIDGE_CACHE_ROOT"],
        }, logger)

        // §6.4 MCP — cfg.mcp injection (opt-in via allowMcp).
        const mcpSummary = await injectMcp(selected, cfg, bridge.allowMcp, logger)

        // §6.5 LSP — cfg.lsp injection (opt-in via allowLsp; respects cfg.lsp === false).
        const lspSummary = await injectLsp(selected, cfg, bridge.allowLsp, logger)

        // §10 concise per-run summary.
        const renamed = cmdAgentSummary.renamed + skillSummary.renamed + mcpSummary.renamed + lspSummary.renamed
        const summaryParts: string[] = [
          `injected ${cmdAgentSummary.commands} command(s), ${cmdAgentSummary.agents} agent(s), ${skillSummary.skills} skill(s), ${mcpSummary.servers} MCP server(s), ${lspSummary.servers} LSP server(s)`,
        ]
        if (renamed > 0) summaryParts.push(`renamed ${renamed} (collision)`)
        if (mcpSummary.skippedPolicy > 0) summaryParts.push(`skipped ${mcpSummary.skippedPolicy} MCP (policy)`)
        if (lspSummary.skippedPolicy > 0) summaryParts.push(`skipped ${lspSummary.skippedPolicy} LSP (policy)`)
        logger.info(summaryParts.join("; "))
      } catch (err) {
        // Strict mode: surface a hard failure. Non-strict: the hook must never throw,
        // so OpenCode still starts (design §10).
        if (bridge.strict) throw err
        const detail = err instanceof Error ? err.message : String(err)
        // Strict already re-threw above, so this soft warning only runs in non-strict mode;
        // route it through the logger so all bridge output shares one format.
        logger.warn(`unexpected error during config injection (${detail}); injected nothing this run`, {
          fatalInStrict: false,
        })
      }
    },
  }
}

/** Stable plugin id — required for `file://`-loaded plugins and used as the bridge's identity. */
export const PLUGIN_ID = "opencode-claude-bridge"

/**
 * The OpenCode V1 plugin module. OpenCode reads `mod.default`: it must be an object carrying a
 * `server` factory (and, for path-loaded plugins, an `id`). A bare default-exported *function*
 * is not recognized as V1 and falls through to OpenCode's legacy export scan, which rejects any
 * non-function export. Because this object is a valid V1 default export, that scan never runs —
 * which is why the named `server` / `PLUGIN_ID` exports above are safe to keep for tests.
 */
const plugin: PluginModule = { id: PLUGIN_ID, server }
export default plugin
