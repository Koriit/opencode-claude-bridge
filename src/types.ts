/**
 * The bridge's runtime configuration, parsed from the `opencode.json` plugin-tuple
 * options object. Only the documented keys are honored; everything else is ignored
 * (with a warning). See the design's §4.2 config schema.
 */
export interface BridgeConfig {
  /** The only accepted mode: mirror exactly the Claude plugins Claude reports as enabled. */
  mode: "mirror-claude"
  /** Plugin ids (`name@marketplace`) to never inject. */
  blockedPlugins: string[]
  /** Promote soft warnings (parse failures, missing CLI) to hard errors. */
  strict: boolean
}

export const DEFAULT_BRIDGE_CONFIG: BridgeConfig = {
  mode: "mirror-claude",
  blockedPlugins: [],
  strict: false,
}

/** The scope a Claude plugin is enabled under, as reported by `claude plugin list --json`. */
export type ClaudePluginScope = "user" | "project" | "local"

/**
 * A single entry from `claude plugin list --json`. `installPath` is the fully-resolved
 * on-disk plugin directory — no marketplace/git/npm resolution is needed in mirror mode.
 */
export interface ClaudePlugin {
  /** `name@marketplace`. */
  id: string
  version: string
  scope: ClaudePluginScope
  enabled: boolean
  /** Resolved on-disk plugin directory. */
  installPath: string
  installedAt?: string
  lastUpdated?: string
  /** The project a `project`/`local`-scoped entry is bound to; absent/null for `user` scope. */
  projectPath?: string | null
}
