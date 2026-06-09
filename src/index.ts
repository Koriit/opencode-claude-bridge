import os from "node:os"
import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { parseBridgeConfig } from "./config.js"
import { injectCommandsAndAgents } from "./inject.js"
import { injectSkills, patchNativeSkillVars, readSkillPaths } from "./skill-inject.js"
import { createLogger } from "./logger.js"
import { listClaudePlugins, selectEnabledPlugins, supplementFromSettings } from "./selection.js"
import { collectExistingSkillNames } from "./skill-scan.js"

/**
 * Symbol used as a non-enumerable marker on a `cfg` object to detect when the
 * bridge has already processed it. Non-enumerable so it is invisible to OpenCode's
 * own config serialization / inspection passes.
 */
const BRIDGE_PROCESSED = Symbol("opencode-claude-bridge.processed")

/**
 * Parse an environment-variable value as a boolean, matching the set of truthy
 * strings that Effect's `Config.boolean` accepts (used by OpenCode's `RuntimeFlags`):
 * `1`, `true`, `yes`, `on` → `true`; everything else including `undefined` → `false`.
 * Comparison is case-insensitive.
 *
 * This ensures the bridge's skip-decision mirrors OpenCode's own flag evaluation —
 * a mismatch would cause the bridge to scan dirs that OpenCode skips (or vice versa),
 * producing spurious collision-renames.
 */
export function parseBooleanEnv(value: string | undefined): boolean {
  if (value === undefined) return false
  switch (value.toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true
    default:
      return false
  }
}

/**
 * The OpenCode plugin factory. Bridge options arrive as the tuple's second element
 * (`["opencode-claude-bridge", { ...options }]`) and are captured in the `config` hook's
 * closure — the hook signature carries only the config object (verified against the
 * OpenCode source). The hook resolves the set of enabled Claude plugins and injects
 * their commands, agents, and skills into the shared, mutable config.
 */
export const server: Plugin = async (_input, options) => {
  const { config: bridge, warnings } = parseBridgeConfig(options)

  return {
    config: async (cfg) => {
      const logger = createLogger(_input.client, bridge.strict)
      try {
        // Idempotency guard: if OpenCode invokes the config hook twice on the same mutable
        // cfg, skip the second run. Without this, the allocators re-seed from their own
        // prior output, producing duplicate renamed commands/agents and double-pushed skill
        // paths. The sentinel is non-enumerable so it is invisible to config serialization.
        const cfgObj = cfg as unknown as Record<symbol, boolean>
        if (cfgObj[BRIDGE_PROCESSED]) {
          logger.info("config hook invoked again on the same cfg object; skipping (idempotency guard)")
          return
        }
        Object.defineProperty(cfgObj, BRIDGE_PROCESSED, { value: true, enumerable: false })

        // Replay parse-time validation warnings (strict-promotable).
        for (const w of warnings) logger.warn(w)

        // §5 mirror-claude resolution.
        const cliPlugins = await listClaudePlugins(_input.$, logger)
        if (cliPlugins === null) return // CLI missing/failed — already warned; inject nothing.

        // Supplement with plugins enabled via settings.json but absent from the CLI output
        // (e.g. manually edited settings.json without going through `claude plugin add`).
        const all = await supplementFromSettings(cliPlugins, _input.directory, logger)

        const selected = selectEnabledPlugins(all, bridge, _input.directory)
        const ids = selected.map((p) => p.id).join(", ")
        logger.info(
          `resolved ${selected.length} enabled Claude plugin(s)${ids ? `: ${ids}` : ""}`,
        )

        // §6.1 commands, §6.2 agents — inline injection into the shared cfg.
        const home = os.homedir()
        const cmdAgentSummary = await injectCommandsAndAgents(selected, cfg, home, logger)
        const { commandAllocator } = cmdAgentSummary

        // Patch ${CLAUDE_SKILL_DIR} and ${CLAUDE_SESSION_ID} in native/local skills
        // that OpenCode already loaded into cfg.skills.paths before our hook ran.
        // Must run before injectSkills so only pre-bridge paths are processed.
        await patchNativeSkillVars(
          cfg,
          home,
          process.env["OPENCODE_CLAUDE_BRIDGE_CACHE_ROOT"],
          logger,
        )

        // §6.3 skills — cfg.skills.paths injection (with bridge-cache copy on collision).
        const existingSkillNames = await collectExistingSkillNames({
          home,
          projectDir: _input.directory,
          skillsPaths: readSkillPaths(cfg),
          // Mirror OpenCode's RuntimeFlags so the bridge scans the same dirs OpenCode will.
          disableExternalSkills: parseBooleanEnv(process.env["OPENCODE_DISABLE_EXTERNAL_SKILLS"]),
          disableClaudeCodeSkills:
            parseBooleanEnv(process.env["OPENCODE_DISABLE_CLAUDE_CODE"]) ||
            parseBooleanEnv(process.env["OPENCODE_DISABLE_CLAUDE_CODE_SKILLS"]),
        })
        const skillSummary = await injectSkills(selected, cfg, existingSkillNames, {
          home,
          projectDir: _input.directory,
          cacheRoot: process.env["OPENCODE_CLAUDE_BRIDGE_CACHE_ROOT"],
          commandAllocator,
        }, logger)

        // §10 concise per-run summary.
        const renamed = cmdAgentSummary.renamed + skillSummary.renamed
        const summaryParts: string[] = [
          `injected ${cmdAgentSummary.commands + skillSummary.commandsAdded} command(s), ${cmdAgentSummary.agents} agent(s), ${skillSummary.skills} skill(s)`,
        ]
        if (renamed > 0) summaryParts.push(`renamed ${renamed} (collision)`)
        logger.info(summaryParts.join("; "))
      } catch (err) {
        // Strict mode: surface a hard failure. Non-strict: the hook must never throw,
        // so OpenCode still starts (design §10).
        if (bridge.strict) {
          // Emit a terminal marker before propagating so waitForHookComplete in the e2e
          // harness can return promptly instead of burning the full timeout.
          logger.info("hook complete (strict failure)")
          throw err
        }
        const detail = err instanceof Error ? err.message : String(err)
        // Strict already re-threw above, so this soft warning only runs in non-strict mode;
        // route it through the logger so all bridge output shares one format.
        logger.warn(`unexpected error during config injection (${detail}); injected nothing this run`, {
          fatalInStrict: false,
        })
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      // Per-session hook: inject the concrete session ID into the system prompt.
      // This is the counterpart to the `${CLAUDE_SESSION_ID}` → "<use Session ID
      // from context>" substitution — content lives in the per-directory config
      // and can't carry a session-specific ID, so the model reads it from here.
      if (input.sessionID)
        output.system.push(`Session ID: ${input.sessionID}`)
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
