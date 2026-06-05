/**
 * OpenCode built-in name lists and skill-discovery constants.
 *
 * Source locations (all in `packages/opencode/src/`):
 *   - Built-in agents:   `agent/agent.ts:127-248`
 *   - Built-in commands: `command/index.ts:53-110` (`Default.INIT`, `Default.REVIEW`)
 *   - Built-in skills:   `skill/index.ts:33`
 *   - Skill scan dirs:   `skill/index.ts:22-26, 173-233`
 */

// ── Built-in agents ─────────────────────────────────────────────────────────
//
// Registered as hard-coded entries in the `agents` object before `cfg.agent`
// is merged in (`agent/agent.ts:127-248`). They are NOT present in `cfg.agent`
// at hook time, so the bridge must treat them as already-taken names.

/** Built-in OpenCode agent names (not present in cfg at hook time). */
export const BUILTIN_AGENT_NAMES: ReadonlySet<string> = new Set([
  "build",       // agent/agent.ts:128
  "plan",        // agent/agent.ts:143
  "general",     // agent/agent.ts:166
  "explore",     // agent/agent.ts:180
  "compaction",  // agent/agent.ts:203 (hidden/internal)
  "title",       // agent/agent.ts:218 (hidden/internal)
  "summary",     // agent/agent.ts:234 (hidden/internal)
])

// ── Built-in commands ────────────────────────────────────────────────────────
//
// Registered before `cfg.command` entries are merged in (`command/index.ts:53-110`).
// `Default.INIT = "init"`, `Default.REVIEW = "review"`.

/** Built-in OpenCode command names (not present in cfg at hook time). */
export const BUILTIN_COMMAND_NAMES: ReadonlySet<string> = new Set([
  "init",    // command/index.ts:53-55, 77-85
  "review",  // command/index.ts:53-55, 86-95
])

// ── Built-in skills ──────────────────────────────────────────────────────────
//
// The only built-in skill is defined at `skill/index.ts:33`.
// Unlike agents/commands, a file-based skill of the same name *overrides* the
// built-in (not the other way around), but the bridge still avoids shadowing it.

/** Built-in OpenCode skill names (not present in cfg.skills.paths at hook time). */
export const BUILTIN_SKILL_NAMES: ReadonlySet<string> = new Set([
  "customize-opencode",  // skill/index.ts:33
])

// ── Skill-discovery dir specs ────────────────────────────────────────────────
//
// OpenCode discovers SKILL.md files from two families of roots:
//
//   1. External roots (`.claude` + `.agents`): global home dirs + project-upward walk
//      Pattern: `skills/**/SKILL.md`   (`skill/index.ts:24`)
//   2. OpenCode config dirs:             global XDG config + project-upward `.opencode`
//      Pattern: `{skill,skills}/**/SKILL.md` (`skill/index.ts:25`)
//   3. `cfg.skills.paths` entries:       explicit user-specified paths
//      Pattern: `**/SKILL.md`           (`skill/index.ts:26, 219`)
//
// The `.agents` root is for skills only — `.opencode/agents` is NOT a skill dir.
// Source: `skill/index.ts:22-26, 173-233`

/** Glob pattern used under `.claude` and `.agents` external roots. */
export const EXTERNAL_SKILL_GLOB = "skills/**/SKILL.md"

/** Glob pattern used under OpenCode config dirs (`.opencode`, `~/.config/opencode`). */
export const OPENCODE_SKILL_GLOB = "{skill,skills}/**/SKILL.md"

/** Glob pattern used under explicit `cfg.skills.paths` entries. */
export const PATHS_SKILL_GLOB = "**/SKILL.md"

/**
 * External root dir names walked from `$HOME` and project-upward.
 * Source: `skill/index.ts:22-24, 185-201`
 */
export const EXTERNAL_SKILL_ROOTS = [".claude", ".agents"] as const

/**
 * OpenCode config dir name walked project-upward (and from `$HOME`).
 * Also used as part of the global XDG config path (`~/.config/opencode`).
 * Source: `skill/index.ts:205-207`, `config/paths.ts:23-41`
 */
export const OPENCODE_CONFIG_DIR_NAME = ".opencode"
