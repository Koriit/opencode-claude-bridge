import fs from "node:fs/promises"
import path from "node:path"
import {
  BUILTIN_SKILL_NAMES,
  EXTERNAL_SKILL_GLOB,
  EXTERNAL_SKILL_ROOTS,
  OPENCODE_CONFIG_DIR_NAME,
  OPENCODE_SKILL_GLOB,
  PATHS_SKILL_GLOB,
} from "./opencode-builtins.js"

// ── Minimal frontmatter extractor ────────────────────────────────────────────
//
// OpenCode uses `gray-matter` for full YAML parsing; the bridge needs only the
// `name` field. A zero-dependency line-scanner is sufficient: the YAML in a
// SKILL.md frontmatter block is always a flat key-value mapping in practice, and
// we only ever look for `name: <value>`.

const FRONTMATTER_FENCE = "---"

/**
 * Extract the `name` field from a `SKILL.md` file's YAML frontmatter.
 *
 * The parser tolerates unknown keys (consistent with OpenCode's `isSkillFrontmatter`
 * duck-type check), extra whitespace, and both quoted and unquoted values. Returns
 * `null` if the frontmatter block is absent, malformed, or lacks a `name` field.
 *
 * This is intentionally minimal — we only need the `name` string.
 */
export function extractSkillName(content: string): string | null {
  const lines = content.split(/\r?\n/)

  // The file must start with `---` (leading whitespace is not part of the YAML
  // spec for document markers, so we require it at column 0).
  if (lines[0]?.trim() !== FRONTMATTER_FENCE) return null

  let closingIdx = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === FRONTMATTER_FENCE) {
      closingIdx = i
      break
    }
  }
  if (closingIdx === -1) return null

  const frontmatter = lines.slice(1, closingIdx)
  for (const line of frontmatter) {
    // Match `name: <value>` only on non-indented lines (no leading whitespace).
    // Indented `name:` lines are nested under block scalars (e.g. `description: |`)
    // and must not be misread as the top-level skill name.
    // Value may be bare, single-, or double-quoted.
    const match = /^name\s*:\s*(.+)$/.exec(line)
    if (!match) continue
    const raw = match[1]!.trim()
    // Strip surrounding quotes (YAML allows `"value"` or `'value'`).
    // Quoted values are returned as-is after unquoting (the comment stripping
    // below does not apply — a `#` inside quotes is part of the value).
    if (
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
    ) {
      return raw.slice(1, -1)
    }
    // For bare (unquoted) values, strip a trailing YAML line comment.
    // YAML comment syntax: ` # ...` — whitespace before `#` is required to
    // distinguish from a `#` that is part of an unquoted scalar value.
    const commentIdx = raw.search(/\s+#/)
    const value = commentIdx === -1 ? raw : raw.slice(0, commentIdx).trim()
    return value || null
  }
  return null
}

// ── Glob expansion ────────────────────────────────────────────────────────────
//
// Bun exposes `Bun.Glob` for glob matching, but this module must be runnable in
// plain Node tests and in non-Bun environments. We use a minimal recursive
// directory walker instead — it is sufficient for the patterns OpenCode uses,
// which are all of the form `<prefix>/**/SKILL.md`.
//
// The patterns from `opencode-builtins.ts`:
//   - `skills/**/SKILL.md`           — external (.claude/.agents) roots
//   - `{skill,skills}/**/SKILL.md`   — opencode config dirs
//   - `**/SKILL.md`                  — cfg.skills.paths entries

/**
 * Expand a glob pattern that matches `SKILL.md` files under `root`.
 *
 * Handles the three patterns used by OpenCode's skill discovery:
 * - `skills/**\/SKILL.md` — files under a `skills/` subdir
 * - `skill,skills/**\/SKILL.md` — files under `skill/` or `skills/`
 * - `**\/SKILL.md` — any SKILL.md recursively
 *
 * Missing or inaccessible roots return an empty array (callers skip absent dirs).
 */
async function globSkillMd(root: string, pattern: string): Promise<string[]> {
  // Determine the set of immediate subdirs to descend into (or "." for **)
  const prefixes = resolveGlobPrefixes(pattern)
  const results: string[] = []

  for (const prefix of prefixes) {
    const searchRoot = prefix === "." ? root : path.join(root, prefix)
    await collectSkillMd(searchRoot, results)
  }
  return results
}

/**
 * Resolve the literal directory prefix(es) from the patterns we use.
 * Returns `["."]` for `**\/SKILL.md`, `["skills"]` for `skills\/**\/SKILL.md`, and
 * `["skill", "skills"]` for the brace-expansion pattern.
 */
function resolveGlobPrefixes(pattern: string): string[] {
  if (pattern === PATHS_SKILL_GLOB) return ["."]
  if (pattern === EXTERNAL_SKILL_GLOB) return ["skills"]
  if (pattern === OPENCODE_SKILL_GLOB) return ["skill", "skills"]
  // Fallback: treat as `**/SKILL.md`
  return ["."]
}

/** Recursively collect all `SKILL.md` files under `dir`, ignoring errors. */
async function collectSkillMd(dir: string, results: string[]): Promise<void> {
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return // missing or inaccessible dir — skip silently
  }
  for (const name of entries) {
    const fullPath = path.join(dir, name)
    let stat: Awaited<ReturnType<typeof fs.stat>>
    try {
      stat = await fs.stat(fullPath)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      await collectSkillMd(fullPath, results)
    } else if (stat.isFile() && name === "SKILL.md") {
      results.push(fullPath)
    }
  }
}

// ── Project-upward walk ────────────────────────────────────────────────────────

/**
 * Walk up from `start` toward the filesystem root (or `stop` if given), collecting
 * directories whose basename matches one of `targets`.
 *
 * Intentional difference from `FSUtil.up` (`packages/core/src/fs-util.ts:141-155`):
 * the bridge collects only *directories* (via `stat.isDirectory()`), whereas
 * OpenCode's `up()` records any matching path regardless of type (file or dir).
 * The skill-root targets (`.claude`, `.agents`, `.opencode`) are always directories,
 * so this narrowing is safe and avoids spurious stat checks for non-dir matches.
 */
async function walkUp(targets: readonly string[], start: string, stop?: string): Promise<string[]> {
  const result: string[] = []
  let current = path.resolve(start)
  const stopAt = stop ? path.resolve(stop) : undefined

  while (true) {
    for (const target of targets) {
      const candidate = path.join(current, target)
      try {
        const stat = await fs.stat(candidate)
        if (stat.isDirectory()) result.push(candidate)
      } catch {
        // not found or inaccessible — skip
      }
    }
    if (stopAt !== undefined && current === stopAt) break
    const parent = path.dirname(current)
    if (parent === current) break // filesystem root
    current = parent
  }
  return result
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Options for {@link collectExistingSkillNames}.
 */
export interface SkillScanOptions {
  /**
   * The user's home directory (`$HOME`). Passed explicitly so the function is
   * testable with temp-dir fixtures without relying on `os.homedir()`.
   */
  home: string
  /**
   * The current project directory — OpenCode's "instance directory" (`input.directory`).
   * Used as the starting point for project-upward scans.
   */
  projectDir: string
  /**
   * Explicit skill paths already in `cfg.skills.paths`. Entries are expanded the
   * same way OpenCode does (`skill/index.ts:212-213`): `~/` is replaced with `home`,
   * and relative paths are resolved against `projectDir`. Absolute paths are used as-is.
   */
  skillsPaths?: readonly string[]
  /**
   * Override for `$XDG_CONFIG_HOME`. When omitted, `process.env["XDG_CONFIG_HOME"]`
   * is used, falling back to `<home>/.config`. Provide this in tests to keep them
   * hermetic regardless of the host's real `XDG_CONFIG_HOME` value.
   */
  xdgConfigHome?: string
}

/**
 * Collect the set of skill names that OpenCode will discover from all the same
 * directories it would scan itself, so the bridge can detect collisions before
 * injecting plugin skills.
 *
 * This reimplements OpenCode's `discoverSkills` glob (`skill/index.ts:173-233`)
 * without calling any OpenCode service — doing so from the plugin config hook would
 * force the lazy Skill cache to populate before our injected `cfg.skills.paths`,
 * making those skills invisible (§6.3).
 *
 * Missing directories are silently skipped; read errors on individual `SKILL.md`
 * files cause that file to be skipped. The built-in skill names are always included
 * regardless of what files exist on disk.
 *
 * @param opts - Home directory, project directory, and explicit skill paths.
 * @returns The set of all skill names OpenCode would already know about.
 */
export async function collectExistingSkillNames(opts: SkillScanOptions): Promise<Set<string>> {
  const names = new Set<string>(BUILTIN_SKILL_NAMES)

  // ── 1. External roots: ~/.claude, ~/.agents  (global) ────────────────────
  //   + project-upward .claude, .agents dirs
  // Pattern: `skills/**/SKILL.md`
  // Source: skill/index.ts:185-203

  const externalGlobalRoots = EXTERNAL_SKILL_ROOTS.map((dir) => path.join(opts.home, dir))
  for (const root of externalGlobalRoots) {
    await scanSkillsUnder(root, EXTERNAL_SKILL_GLOB, names)
  }

  const upwardExternalDirs = await walkUp(EXTERNAL_SKILL_ROOTS, opts.projectDir)
  for (const root of upwardExternalDirs) {
    await scanSkillsUnder(root, EXTERNAL_SKILL_GLOB, names)
  }

  // ── 2. OpenCode config dirs ───────────────────────────────────────────────
  //   - Global XDG config dir: `~/.config/opencode` (or $XDG_CONFIG_HOME/opencode)
  //   - project-upward `.opencode` dirs
  //   - `~/.opencode` (home-based `.opencode`)
  // Pattern: `{skill,skills}/**/SKILL.md`
  // Source: skill/index.ts:205-207, config/paths.ts:23-41

  const xdgConfigHome =
    opts.xdgConfigHome ?? process.env["XDG_CONFIG_HOME"] ?? path.join(opts.home, ".config")
  const globalOpencodeConfig = path.join(xdgConfigHome, "opencode")
  await scanSkillsUnder(globalOpencodeConfig, OPENCODE_SKILL_GLOB, names)

  // project-upward .opencode dirs
  const upwardOpencodeConfigDirs = await walkUp([OPENCODE_CONFIG_DIR_NAME], opts.projectDir)
  for (const root of upwardOpencodeConfigDirs) {
    await scanSkillsUnder(root, OPENCODE_SKILL_GLOB, names)
  }

  // ~/.opencode (from home-scoped up walk with stop=home, same as config/paths.ts:34-38)
  const homeOpencodeDir = path.join(opts.home, OPENCODE_CONFIG_DIR_NAME)
  // Only scan if it isn't already covered by the upward walk above
  if (!upwardOpencodeConfigDirs.some((d) => path.resolve(d) === path.resolve(homeOpencodeDir))) {
    await scanSkillsUnder(homeOpencodeDir, OPENCODE_SKILL_GLOB, names)
  }

  // ── 3. cfg.skills.paths entries ──────────────────────────────────────────
  // Pattern: `**/SKILL.md`
  // Source: skill/index.ts:210-220
  // OpenCode expands `~/` (→ home) and resolves relative paths against the
  // project dir before scanning (`skill/index.ts:212-213`). Mirror that here
  // so collision detection sees the same paths OpenCode will scan.
  for (const rawPath of opts.skillsPaths ?? []) {
    const skillPath = expandSkillPath(rawPath, opts.home, opts.projectDir)
    await scanSkillsUnder(skillPath, PATHS_SKILL_GLOB, names)
  }

  return names
}

/**
 * Scan `root` for `SKILL.md` files using `pattern`, extract each file's `name`
 * frontmatter field, and add the names to `out`. Files whose frontmatter cannot
 * be parsed are silently skipped (consistent with OpenCode's lenient parser).
 */
async function scanSkillsUnder(root: string, pattern: string, out: Set<string>): Promise<void> {
  const files = await globSkillMd(root, pattern)
  for (const file of files) {
    let content: string
    try {
      content = await fs.readFile(file, "utf8")
    } catch {
      continue
    }
    const name = extractSkillName(content)
    if (name !== null) out.add(name)
  }
}

/**
 * Expand a `cfg.skills.paths` entry the same way OpenCode does
 * (`skill/index.ts:212-213`):
 * - `~/…` is expanded to `<home>/…`
 * - Relative paths are resolved against `projectDir`
 * - Absolute paths are returned as-is
 */
function expandSkillPath(rawPath: string, home: string, projectDir: string): string {
  if (rawPath.startsWith("~/")) {
    return path.join(home, rawPath.slice(2))
  }
  if (path.isAbsolute(rawPath)) {
    return rawPath
  }
  return path.join(projectDir, rawPath)
}
