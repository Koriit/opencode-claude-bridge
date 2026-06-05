/**
 * Skills injection from enabled Claude plugins into OpenCode's `cfg.skills.paths`.
 *
 * Skills have no inline form: OpenCode discovers them from directories, naming each
 * skill from the `SKILL.md` frontmatter `name`. For each enabled plugin (in sorted-by-id
 * order), we scan `<installPath>/skills/` for skill subdirectories (each containing a
 * `SKILL.md`). Then:
 *
 * - If the skill's bare name is free: push the individual skill dir directly onto
 *   `cfg.skills.paths` — zero files copied.
 * - If the name collides: copy the whole skill dir into the bridge cache, patch the
 *   copy's `SKILL.md` frontmatter `name` to the prefixed name, then push the copy.
 *
 * The bridge cache lives at `~/.cache/opencode-claude-bridge/skills/` (override via
 * `cacheRoot` option for hermetic tests). Each copy is keyed by
 * `<marketplace>/<plugin>/<version>/<allocatedName>` and regenerated when the source is
 * newer. Stale version directories (from prior plugin upgrades) are pruned on each run.
 *
 * Design constraints:
 * - Do NOT call `Skill.Service.all()` or any OpenCode Skill service — it would force the
 *   lazy skill cache to populate before our injected `cfg.skills.paths` (§6.3).
 * - Use `collectExistingSkillNames` (fs-scan) for existing-name detection only.
 * - Zero runtime npm dependencies — `node:*` only.
 */

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Config } from "@opencode-ai/plugin"
import { extractSkillName } from "./skill-scan.js"
import { NameAllocator, splitPluginId } from "./naming.js"
import { parseFrontmatter, FRONTMATTER_PARSE_ERROR } from "./frontmatter.js"
import { injectCommandEntry } from "./inject.js"
import type { Logger } from "./logger.js"
import type { ClaudePlugin } from "./types.js"

// ── Config shape guard ────────────────────────────────────────────────────────

/**
 * The minimal view of `cfg.skills` that we read and mutate. OpenCode's V1 shape
 * has both `paths` and `urls` as Schema.optional (either can be absent at hook
 * time — verified against packages/core/src/v1/config/skills.ts).
 *
 * The real `Config` type from `@opencode-ai/plugin` uses complex Effect/Schema
 * types; we cast to this interface internally (verified empirically — Appendix A).
 */
interface SkillsConfig {
  paths?: string[]
  urls?: string[]
}

/** Normalized skills config with both arrays guaranteed non-null. */
interface NormalizedSkillsConfig {
  paths: string[]
  urls: string[]
}

interface InjectableConfig {
  skills?: SkillsConfig | boolean | undefined
  command?: Record<string, unknown> | undefined
}

/**
 * Ensure `cfg.skills` is a plain `{ paths, urls }` object with both arrays
 * initialized. Guards `undefined`/`null`/boolean values AND independently
 * fills in missing `paths` or `urls` — both fields are `Schema.optional` in
 * OpenCode V1, so a real user config of `{ "skills": { "paths": ["x"] } }`
 * (no `urls`) is valid and must not throw (Appendix A).
 *
 * Returns the normalized reference with both arrays guaranteed present.
 */
function guardSkillsConfig(cfg: InjectableConfig): NormalizedSkillsConfig {
  if (
    cfg.skills === undefined ||
    cfg.skills === null ||
    typeof cfg.skills === "boolean"
  ) {
    cfg.skills = { paths: [], urls: [] }
  } else {
    // Both fields are optional in the V1 schema; initialize each independently
    // so a config that has only one of them does not throw on the other.
    const s = cfg.skills as SkillsConfig
    if (!Array.isArray(s.paths)) s.paths = []
    if (!Array.isArray(s.urls)) s.urls = []
  }
  return cfg.skills as NormalizedSkillsConfig
}

// ── Directory utilities ───────────────────────────────────────────────────────

/**
 * List the immediate subdirectory names of `dir`. Returns an empty array when the
 * directory is absent or inaccessible — callers treat a missing skills/ dir as "no
 * skills to inject" for this plugin.
 */
async function listSubdirs(dir: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
}

/**
 * Recursively copy `srcDir` to `dstDir`, excluding dot-directories (`.git`, etc.)
 * and any symlinks. Asset files (images, data files, etc.) are copied verbatim so
 * relative references in SKILL.md survive. `dstDir` and all parents are created if
 * they do not exist.
 *
 * Symlinks are skipped intentionally: `fs.copyFile` follows symlinks and copies the
 * target content, which could exfiltrate arbitrary files (e.g. a skill shipping
 * `evil-link → ~/.aws/credentials`) into the bridge cache. Legitimate skill assets
 * do not need symlinks.
 */
async function copyDirRecursive(srcDir: string, dstDir: string, logger: Logger): Promise<void> {
  await fs.mkdir(dstDir, { recursive: true })

  let entries: import("node:fs").Dirent[]
  try {
    entries = await fs.readdir(srcDir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    // Exclude dot-directories (e.g. .git, .github) — but do copy dot-files.
    if (entry.isDirectory() && entry.name.startsWith(".")) continue

    const srcPath = path.join(srcDir, entry.name)
    const dstPath = path.join(dstDir, entry.name)

    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, dstPath, logger)
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, dstPath)
    } else if (entry.isSymbolicLink()) {
      // Skip symlinks — following them could copy arbitrary host files into the
      // bridge cache (a skill could ship a symlink targeting sensitive paths).
      logger.warn(`skipped symlink "${srcPath}" in skill cache copy`, { fatalInStrict: false })
    }
  }
}

// ── Path segment sanitization ─────────────────────────────────────────────────

/**
 * Sanitize a single path segment so a hostile plugin id/version cannot escape
 * the cache root. Rules:
 *   - Replace every `/` (path separator) with `_`
 *   - Replace every `..` component with `__` (prevents parent traversal)
 *   - Strip a leading `.` (prevents hidden-file names in the cache dir)
 *   - Replace every `\` (Windows path separator) with `_`
 *
 * The input is always a non-empty string; the output is a safe, flat filename.
 */
export function sanitizeCacheSegment(segment: string): string {
  return segment
    .replace(/\\/g, "_")      // Windows path separators
    .replace(/\//g, "_")      // Unix path separators
    .replace(/\.\./g, "__")   // parent-traversal sequences
    .replace(/^\./, "_")      // leading dot → hidden file prevention
}

// ── Cache key / staleness ─────────────────────────────────────────────────────

/**
 * Return the bridge-cache directory for a specific (plugin, skill) combination.
 *
 * Key: `<cacheRoot>/<marketplace>/<plugin>/<version>/<allocatedName>/`
 *
 * `<marketplace>` and `<plugin>` are derived by splitting the plugin id via
 * `splitPluginId`. Every segment is sanitized defensively so a hostile id
 * cannot escape the cache root via path traversal.
 */
function cacheDirForSkill(cacheRoot: string, plugin: ClaudePlugin, skillName: string): string {
  const { plugin: pluginPart, marketplace } = splitPluginId(plugin.id)
  return path.join(
    cacheRoot,
    sanitizeCacheSegment(marketplace),
    sanitizeCacheSegment(pluginPart),
    sanitizeCacheSegment(plugin.version),
    skillName,
  )
}

/**
 * Prune stale version directories under `<cacheRoot>/<marketplace>/<plugin>/`.
 *
 * After writing the current-version directory, any sibling `<other-version>/`
 * directories that belong to the SAME plugin (same marketplace + plugin segment)
 * but carry a different version string are removed. This cleans up copies left
 * by prior plugin upgrades.
 *
 * Only other-version dirs are touched — neighboring marketplace or plugin dirs
 * are never affected. GC failures are skip+warn, never thrown.
 */
async function gcOldVersionDirs(
  cacheRoot: string,
  plugin: ClaudePlugin,
  currentVersion: string,
  logger: Logger,
): Promise<void> {
  const { plugin: pluginPart, marketplace } = splitPluginId(plugin.id)
  const pluginCacheDir = path.join(
    cacheRoot,
    sanitizeCacheSegment(marketplace),
    sanitizeCacheSegment(pluginPart),
  )

  let entries: import("node:fs").Dirent[]
  try {
    entries = await fs.readdir(pluginCacheDir, { withFileTypes: true })
  } catch {
    return // directory does not exist yet — nothing to GC
  }

  const safeCurrentVersion = sanitizeCacheSegment(currentVersion)
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === safeCurrentVersion) continue // keep current version

    const staleDir = path.join(pluginCacheDir, entry.name)
    try {
      await fs.rm(staleDir, { recursive: true, force: true })
      logger.info(`pruned stale cache version "${staleDir}" for plugin "${plugin.id}"`)
    } catch (err) {
      logger.warn(
        `could not prune stale cache version "${staleDir}" for plugin "${plugin.id}" (${err instanceof Error ? err.message : String(err)}); skipping`,
        { fatalInStrict: false },
      )
    }
  }
}

/**
 * Return `true` when the cached copy needs to be (re-)generated.
 *
 * The copy is stale (and must be regenerated) when:
 *   - The cache directory does not exist at all, OR
 *   - The source `SKILL.md` is newer than the cached `SKILL.md`.
 *
 * "Missing or stale" covers both first-run (always copy) and version-change
 * (cache path changes per version, so old copies are silently abandoned).
 */
async function isCacheStale(srcSkillMd: string, cachedSkillMd: string): Promise<boolean> {
  let cachedStat: Awaited<ReturnType<typeof fs.stat>>
  try {
    cachedStat = await fs.stat(cachedSkillMd)
  } catch {
    return true // cache does not exist
  }

  let srcStat: Awaited<ReturnType<typeof fs.stat>>
  try {
    srcStat = await fs.stat(srcSkillMd)
  } catch {
    return true // cannot stat source — treat as stale so the caller will warn
  }

  return srcStat.mtimeMs > cachedStat.mtimeMs
}

// ── Frontmatter name patching ─────────────────────────────────────────────────

/**
 * Rewrite the `name:` field in a `SKILL.md` file's YAML frontmatter to `newName`,
 * preserving all other content verbatim.
 *
 * The patch is targeted: only the first non-indented `name:` line inside the
 * frontmatter block is replaced. The rest of the file (including body text, asset
 * references, and unknown frontmatter keys) is left byte-identical to the source.
 *
 * Returns the patched content string, or throws if the frontmatter is malformed
 * (no opening fence, no closing fence, or no top-level `name:` line to replace).
 */
export function patchSkillName(content: string, newName: string): string {
  const lines = content.split(/\r?\n/)

  if (lines[0]?.trim() !== "---") {
    throw new Error("SKILL.md does not start with a frontmatter fence")
  }

  let closingIdx = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      closingIdx = i
      break
    }
  }
  if (closingIdx === -1) {
    throw new Error("SKILL.md frontmatter is not closed")
  }

  // Find and replace the first non-indented `name:` line in the frontmatter.
  let patched = false
  for (let i = 1; i < closingIdx; i++) {
    const line = lines[i]!
    if (/^name\s*:/.test(line)) {
      lines[i] = `name: ${newName}`
      patched = true
      break
    }
  }

  if (!patched) {
    throw new Error("SKILL.md frontmatter has no top-level `name:` field to patch")
  }

  // Reassemble using the original line endings. If the content used CRLF we split
  // on CRLF/LF above; rejoin with the original separator of the first line.
  const sep = content.includes("\r\n") ? "\r\n" : "\n"
  return lines.join(sep)
}

// ── Per-plugin injection ──────────────────────────────────────────────────────

/**
 * Scan `<installPath>/skills/` for skill subdirectories and inject each one into
 * `cfg.skills.paths` and/or `cfg.command` based on the skill's frontmatter flags.
 *
 * Routing table (from `user-invocable` and `disable-model-invocation` frontmatter):
 *   - neither flag      → inject as skill AND command
 *   - user-invocable: false → inject as skill only (no command)
 *   - disable-model-invocation: true → inject as command only (no skill)
 *   - both flags set    → skip entirely with a WARN
 */
async function injectPluginSkills(
  plugin: ClaudePlugin,
  skillsCfg: NormalizedSkillsConfig,
  mutableCfg: InjectableConfig,
  skillAllocator: NameAllocator,
  commandAllocator: NameAllocator,
  cacheRoot: string,
  summary: SkillInjectionSummary,
  logger: Logger,
): Promise<void> {
  const pluginSkillsDir = path.join(plugin.installPath, "skills")
  const subdirs = await listSubdirs(pluginSkillsDir)
  if (subdirs.length === 0) return

  // GC stale version directories for this plugin once per injection run,
  // before materializing any new copies. This removes copies left by previous
  // plugin versions. Failure is non-fatal (skip+warn).
  await gcOldVersionDirs(cacheRoot, plugin, plugin.version, logger)

  for (const subdir of subdirs) {
    const skillDir = path.join(pluginSkillsDir, subdir)
    const skillMdPath = path.join(skillDir, "SKILL.md")

    // Read and parse the skill name from frontmatter.
    let content: string
    try {
      content = await fs.readFile(skillMdPath, "utf8")
    } catch (err) {
      logger.warn(
        `could not read SKILL.md at "${skillMdPath}" from plugin "${plugin.id}" (${err instanceof Error ? err.message : String(err)}); skipping`,
      )
      continue
    }

    const extractedName = extractSkillName(content)
    // Fall back to the directory name when the SKILL.md has no `name:` field —
    // the directory name is the conventional skill identifier and is always present.
    const bareName = extractedName ?? subdir
    if (extractedName === null) {
      logger.info(
        `SKILL.md at "${skillMdPath}" from plugin "${plugin.id}" has no frontmatter name; using directory name "${subdir}"`,
      )
    }

    // Parse additional frontmatter flags that control injection routing.
    const parsed = parseFrontmatter(content)
    let userInvocable = true
    let disableModelInvocation = false
    let description: string | undefined
    let body = ""

    if (parsed !== null && parsed !== FRONTMATTER_PARSE_ERROR) {
      const fm = parsed.data
      if (fm["user-invocable"] === false) userInvocable = false
      if (fm["disable-model-invocation"] === true) disableModelInvocation = true
      if (typeof fm["description"] === "string") description = fm["description"]
      body = parsed.body
    }

    const asSkill = !disableModelInvocation
    const asCommand = userInvocable

    if (!asSkill && !asCommand) {
      logger.warn(
        `skill "${bareName}" from plugin "${plugin.id}" has both "disable-model-invocation: true" and "user-invocable: false"; skipping`,
        { fatalInStrict: false },
      )
      continue
    }

    if (asSkill) {
      const { name: allocatedName, renamed } = skillAllocator.claim(plugin.id, bareName)

      if (!renamed) {
        // No collision — point OpenCode directly at the plugin's skill dir.
        skillsCfg.paths.push(skillDir)
        summary.skills++
      } else {
        // Collision — copy the skill dir into the bridge cache and patch the name.
        const cachedSkillDir = cacheDirForSkill(cacheRoot, plugin, allocatedName)
        const cachedSkillMd = path.join(cachedSkillDir, "SKILL.md")

        const stale = await isCacheStale(skillMdPath, cachedSkillMd)
        if (stale) {
          try {
            await copyDirRecursive(skillDir, cachedSkillDir, logger)
            // Patch using the content already in memory (read above for extractSkillName)
            // rather than re-reading the just-copied file — same bytes, avoids a round-trip.
            const patched = patchSkillName(content, allocatedName)
            await fs.writeFile(cachedSkillMd, patched, "utf8")
          } catch (err) {
            logger.warn(
              `failed to create bridge-cache copy for skill "${bareName}" from plugin "${plugin.id}" (${err instanceof Error ? err.message : String(err)}); skipping`,
            )
            continue
          }
        }

        skillsCfg.paths.push(cachedSkillDir)
        summary.skills++
        summary.renamed++
      }
    }

    if (asCommand) {
      if (!body) continue
      const fmData = (parsed !== null && parsed !== FRONTMATTER_PARSE_ERROR) ? parsed.data : {}
      const modelRaw = fmData["model"]
      const model = typeof modelRaw === "string" && modelRaw.includes("/") ? modelRaw : undefined
      const { renamed } = injectCommandEntry(
        bareName,
        { template: body, description, model },
        mutableCfg as unknown as { command?: Record<string, import("./inject.js").CommandEntry> },
        commandAllocator,
        plugin.id,
        logger,
      )
      summary.commandsAdded++
      if (renamed) summary.renamed++
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Summary counters for skills injection collected across all plugins. */
export interface SkillInjectionSummary {
  skills: number
  renamed: number
  commandsAdded: number
}

/**
 * Options for {@link injectSkills}.
 */
export interface SkillInjectOptions {
  /**
   * The user's home directory. Used for `collectExistingSkillNames` and for
   * the default bridge-cache path (`~/.cache/opencode-claude-bridge/skills/`).
   */
  home: string
  /**
   * The current project directory (OpenCode's instance directory).
   * Used as the starting point for project-upward skill-name scans.
   */
  projectDir: string
  /**
   * Override the bridge-cache root for hermetic tests. When omitted, defaults
   * to `~/.cache/opencode-claude-bridge/skills/`.
   */
  cacheRoot?: string
  /**
   * The fully-populated command name allocator from `injectCommandsAndAgents`.
   * Required to participate in the same command namespace so skill-derived
   * commands never collide with plugin commands or built-in commands.
   * When omitted (e.g. in legacy callers), a fresh allocator is created.
   */
  commandAllocator?: NameAllocator
}

/**
 * Inject skills from all `plugins` into the mutable `cfg`.
 *
 * Builds a `NameAllocator` seeded with the union of existing skill names
 * (from the fs scan via `collectExistingSkillNames`) so injected skills never
 * shadow native/existing items. Processes plugins in the order given (callers
 * must pass the sorted-by-id order from `selectEnabledPlugins`).
 *
 * Emits a warning if `cfg.skills.urls` is non-empty (URL-sourced skill collision
 * detection is not possible at hook time — §6.3).
 *
 * Accepts the SDK `Config` type and casts it internally. The runtime shape is a
 * plain mutable object (verified empirically, Appendix A).
 *
 * A skill whose SKILL.md can't be read/parsed, or whose collision-copy fails, is
 * skipped with a warning; the hook still never throws in non-strict mode.
 */
export async function injectSkills(
  plugins: ClaudePlugin[],
  cfg: Config,
  existingSkillNames: ReadonlySet<string>,
  opts: SkillInjectOptions,
  logger: Logger,
): Promise<SkillInjectionSummary> {
  const mutableCfg = cfg as unknown as InjectableConfig
  const summary: SkillInjectionSummary = { skills: 0, renamed: 0, commandsAdded: 0 }

  if (plugins.length === 0) return summary

  const skillsCfg = guardSkillsConfig(mutableCfg)

  // Note (not a warning): URL-sourced skill names aren't knowable at hook time
  // without triggering the lazy Skill-service fetch (§6.3). The bridge proceeds
  // without collision-detection for those skills — a normal, acceptable limitation.
  if (skillsCfg.urls.length > 0) {
    logger.info(
      "cfg.skills.urls is non-empty; URL-sourced skill names are not available at hook time — bridge cannot detect collisions against URL-sourced skills",
    )
  }

  const cacheRoot =
    opts.cacheRoot ?? path.join(opts.home, ".cache", "opencode-claude-bridge", "skills")

  // Seed the skill allocator with every name OpenCode already knows about (native + built-ins).
  // `existingSkillNames` is provided by the caller (from `collectExistingSkillNames`) to
  // avoid calling the Skill service from the hook.
  const skillAllocator = new NameAllocator(existingSkillNames)

  // Use the caller-provided command allocator so skill-derived commands share the
  // same namespace as plugin commands. Fall back to a fresh one if not provided.
  const commandAllocator = opts.commandAllocator ?? new NameAllocator(new Set<string>())

  for (const plugin of plugins) {
    await injectPluginSkills(plugin, skillsCfg, mutableCfg, skillAllocator, commandAllocator, cacheRoot, summary, logger)
  }

  return summary
}
