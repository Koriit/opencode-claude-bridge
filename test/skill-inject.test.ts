import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { injectSkills, patchSkillName, type SkillInjectionSummary } from "../src/skill-inject.js"
import { extractSkillName } from "../src/skill-scan.js"
import type { Logger } from "../src/logger.js"
import type { ClaudePlugin } from "../src/types.js"
import type { Config } from "@opencode-ai/plugin"

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Base directory for test temp dirs. Respects `OCB_TMPDIR` (or `TMPDIR`) so tests
 * can be redirected off a full system tmpfs. Always returns an absolute path.
 */
function testBase(): string {
  const override = process.env["OCB_TMPDIR"] ?? process.env["TMPDIR"]
  if (override) {
    const abs = path.resolve(override)
    mkdirSync(abs, { recursive: true })
    return abs
  }
  return tmpdir()
}

function makeLogger(): Logger & { warnings: string[]; infos: string[] } {
  const warnings: string[] = []
  const infos: string[] = []
  return {
    warnings,
    infos,
    info(msg: string) {
      infos.push(msg)
    },
    warn(msg: string) {
      warnings.push(msg)
    },
    hadWarnings() { return warnings.length > 0 },
  }
}

function fakePlugin(id: string, installPath: string, version = "1.0.0"): ClaudePlugin {
  return { id, version, scope: "user", enabled: true, installPath }
}

function asConfig(c: Record<string, unknown>): Config {
  return c as unknown as Config
}

function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(testBase(), "ocb-skill-inject-"))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function writeSkillDir(baseDir: string, skillName: string, extraFiles?: Record<string, string>): string {
  const skillDir = path.join(baseDir, skillName)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: A skill named ${skillName}.\n---\n\nSkill body.\n`,
  )
  if (extraFiles) {
    for (const [relPath, content] of Object.entries(extraFiles)) {
      const fullPath = path.join(skillDir, relPath)
      mkdirSync(path.dirname(fullPath), { recursive: true })
      writeFileSync(fullPath, content)
    }
  }
  return skillDir
}

/** Write a plugin's skills/ directory with the given skill names. */
function writePluginSkills(pluginDir: string, skillNames: string[]): void {
  const skillsDir = path.join(pluginDir, "skills")
  mkdirSync(skillsDir, { recursive: true })
  for (const name of skillNames) {
    writeSkillDir(skillsDir, name)
  }
}

// ── patchSkillName ────────────────────────────────────────────────────────────

describe("patchSkillName", () => {
  test("replaces the name field while preserving other frontmatter keys and body", () => {
    const content = "---\nname: old-name\ndescription: A skill.\n---\n\nBody text here.\n"
    const patched = patchSkillName(content, "new-name")
    expect(extractSkillName(patched)).toBe("new-name")
    expect(patched).toContain("description: A skill.")
    expect(patched).toContain("Body text here.")
  })

  test("preserves all body content including whitespace exactly", () => {
    const content = "---\nname: old\ndescription: Desc.\n---\n\nLine 1.\n\nLine 2.\n"
    const patched = patchSkillName(content, "new")
    const bodyStart = patched.indexOf("---\n\n") // after closing fence
    expect(patched.slice(bodyStart)).toBe("---\n\nLine 1.\n\nLine 2.\n")
  })

  test("replaces only the first non-indented name: line", () => {
    const content = [
      "---",
      "name: real-name",
      "description: |",
      "  name: nested-name",
      "---",
      "",
      "Body.",
    ].join("\n")
    const patched = patchSkillName(content, "patched-name")
    expect(patched).toContain("name: patched-name")
    expect(patched).toContain("  name: nested-name") // nested line untouched
    expect(extractSkillName(patched)).toBe("patched-name")
  })

  test("throws when there is no opening frontmatter fence", () => {
    expect(() => patchSkillName("name: foo\n---\nBody", "x")).toThrow()
  })

  test("throws when the frontmatter is not closed", () => {
    expect(() => patchSkillName("---\nname: foo\nBody", "x")).toThrow()
  })

  test("throws when there is no top-level name: field", () => {
    expect(() => patchSkillName("---\ndescription: No name.\n---\nBody", "x")).toThrow()
  })

  test("handles CRLF line endings correctly", () => {
    const content = "---\r\nname: old\r\ndescription: Test.\r\n---\r\nBody.\r\n"
    const patched = patchSkillName(content, "new")
    expect(extractSkillName(patched)).toBe("new")
    // CRLF preserved
    expect(patched).toContain("\r\n")
  })

  test("round-trips correctly when the original name is double-quoted", () => {
    // extractSkillName strips quotes; patchSkillName must write a bare name
    // (not re-quote it). After patching, extractSkillName should return the new name.
    const content = '---\nname: "quoted-old"\ndescription: Desc.\n---\n\nBody.\n'
    const patched = patchSkillName(content, "new-name")
    expect(extractSkillName(patched)).toBe("new-name")
    // The patched line should be bare (not re-quoted).
    expect(patched).toContain("name: new-name")
  })

  test("round-trips correctly when the original name has a trailing comment", () => {
    // extractSkillName strips `# ...`; patchSkillName replaces the whole line.
    const content = "---\nname: old-name # some comment\ndescription: Desc.\n---\n\nBody.\n"
    const patched = patchSkillName(content, "new-name")
    expect(extractSkillName(patched)).toBe("new-name")
    // The comment must be gone after the patch.
    expect(patched).not.toContain("# some comment")
  })

  test("patches correctly when 'name' is not the first frontmatter key", () => {
    // description appears before name — the patch must still find and replace it.
    const content = "---\ndescription: A skill.\nname: old-name\n---\n\nBody.\n"
    const patched = patchSkillName(content, "new-name")
    expect(extractSkillName(patched)).toBe("new-name")
    expect(patched).toContain("description: A skill.")
  })
})

// ── injectSkills — cfg.skills guard ──────────────────────────────────────────

describe("injectSkills — cfg.skills guard", () => {
  let tmp: { dir: string; cleanup: () => void }
  beforeEach(() => {
    tmp = makeTempDir()
  })
  afterEach(() => tmp.cleanup())

  test("initializes cfg.skills to { paths: [], urls: [] } when undefined", async () => {
    const pluginDir = mkdtempSync(path.join(tmp.dir, "plug-"))
    writePluginSkills(pluginDir, ["my-skill"])
    const cfg = asConfig({})
    const logger = makeLogger()

    await injectSkills(
      [fakePlugin("plug@mkt", pluginDir)],
      cfg,
      new Set<string>(),
      { home: tmp.dir, projectDir: tmp.dir, cacheRoot: path.join(tmp.dir, "cache") },
      logger,
    )

    const mutable = cfg as unknown as { skills?: { paths: string[]; urls: string[] } }
    expect(mutable.skills).toBeDefined()
    expect(Array.isArray(mutable.skills!.paths)).toBe(true)
    expect(Array.isArray(mutable.skills!.urls)).toBe(true)
  })

  test("initializes cfg.skills when it is boolean false", async () => {
    const pluginDir = mkdtempSync(path.join(tmp.dir, "plug-"))
    writePluginSkills(pluginDir, ["my-skill"])
    const cfg = asConfig({ skills: false })
    const logger = makeLogger()

    await injectSkills(
      [fakePlugin("plug@mkt", pluginDir)],
      cfg,
      new Set<string>(),
      { home: tmp.dir, projectDir: tmp.dir, cacheRoot: path.join(tmp.dir, "cache") },
      logger,
    )

    const mutable = cfg as unknown as { skills?: { paths: string[] } }
    expect(Array.isArray(mutable.skills!.paths)).toBe(true)
  })

  test("initializes cfg.skills when it is boolean true", async () => {
    const pluginDir = mkdtempSync(path.join(tmp.dir, "plug-"))
    writePluginSkills(pluginDir, ["my-skill"])
    const cfg = asConfig({ skills: true })
    const logger = makeLogger()

    await injectSkills(
      [fakePlugin("plug@mkt", pluginDir)],
      cfg,
      new Set<string>(),
      { home: tmp.dir, projectDir: tmp.dir, cacheRoot: path.join(tmp.dir, "cache") },
      logger,
    )

    const mutable = cfg as unknown as { skills?: { paths: string[] } }
    expect(Array.isArray(mutable.skills!.paths)).toBe(true)
  })
})

// ── injectSkills — no-collision path ─────────────────────────────────────────

describe("injectSkills — no-collision: direct path pushed", () => {
  let tmp: { dir: string; cleanup: () => void }
  beforeEach(() => {
    tmp = makeTempDir()
  })
  afterEach(() => tmp.cleanup())

  test("pushes the individual skill dir onto cfg.skills.paths when no collision", async () => {
    const pluginDir = mkdtempSync(path.join(tmp.dir, "plug-"))
    writePluginSkills(pluginDir, ["audit"])
    const cfg = asConfig({ skills: { paths: [], urls: [] } })
    const logger = makeLogger()
    const cacheRoot = path.join(tmp.dir, "cache")

    const summary = await injectSkills(
      [fakePlugin("plug@mkt", pluginDir)],
      cfg,
      new Set<string>(),
      { home: tmp.dir, projectDir: tmp.dir, cacheRoot },
      logger,
    )

    const mutable = cfg as unknown as { skills: { paths: string[] } }
    expect(mutable.skills.paths).toHaveLength(1)
    expect(mutable.skills.paths[0]).toBe(path.join(pluginDir, "skills", "audit"))
    expect(summary.skills).toBe(1)
    expect(summary.renamed).toBe(0)
    // No cache copy: the cache dir should not exist.
    expect(existsSync(cacheRoot)).toBe(false)
  })

  test("pushes multiple skill dirs from one plugin in subdirectory order", async () => {
    const pluginDir = mkdtempSync(path.join(tmp.dir, "plug-"))
    writePluginSkills(pluginDir, ["alpha", "beta", "gamma"])
    const cfg = asConfig({ skills: { paths: [], urls: [] } })
    const logger = makeLogger()

    const summary = await injectSkills(
      [fakePlugin("plug@mkt", pluginDir)],
      cfg,
      new Set<string>(),
      { home: tmp.dir, projectDir: tmp.dir, cacheRoot: path.join(tmp.dir, "cache") },
      logger,
    )

    const mutable = cfg as unknown as { skills: { paths: string[] } }
    expect(mutable.skills.paths).toHaveLength(3)
    expect(summary.skills).toBe(3)
    expect(summary.renamed).toBe(0)
  })

  test("returns empty summary and pushes nothing when plugin has no skills/ dir", async () => {
    const pluginDir = mkdtempSync(path.join(tmp.dir, "plug-"))
    // No skills/ dir created
    const cfg = asConfig({ skills: { paths: [], urls: [] } })
    const logger = makeLogger()

    const summary = await injectSkills(
      [fakePlugin("plug@mkt", pluginDir)],
      cfg,
      new Set<string>(),
      { home: tmp.dir, projectDir: tmp.dir, cacheRoot: path.join(tmp.dir, "cache") },
      logger,
    )

    const mutable = cfg as unknown as { skills: { paths: string[] } }
    expect(mutable.skills.paths).toHaveLength(0)
    expect(summary.skills).toBe(0)
    expect(summary.renamed).toBe(0)
  })

  test("does nothing when plugins list is empty", async () => {
    const cfg = asConfig({ skills: { paths: [], urls: [] } })
    const logger = makeLogger()

    const summary = await injectSkills(
      [],
      cfg,
      new Set<string>(),
      { home: tmp.dir, projectDir: tmp.dir, cacheRoot: path.join(tmp.dir, "cache") },
      logger,
    )

    expect(summary.skills).toBe(0)
    expect(summary.renamed).toBe(0)
  })
})

// ── injectSkills — collision path (rename + cache copy) ───────────────────────

describe("injectSkills — collision: renamed copy in bridge cache", () => {
  let tmp: { dir: string; cleanup: () => void }
  beforeEach(() => {
    tmp = makeTempDir()
  })
  afterEach(() => tmp.cleanup())

  test("copies skill dir to cache and patches SKILL.md name on collision with existing name", async () => {
    const pluginDir = mkdtempSync(path.join(tmp.dir, "plug-"))
    writePluginSkills(pluginDir, ["my-skill"])
    const cacheRoot = path.join(tmp.dir, "cache")

    // "my-skill" is already claimed by native skills
    const existingNames = new Set(["my-skill"])
    const cfg = asConfig({ skills: { paths: [], urls: [] } })
    const logger = makeLogger()

    const summary = await injectSkills(
      [fakePlugin("myplugin@mkt", pluginDir)],
      cfg,
      existingNames,
      { home: tmp.dir, projectDir: tmp.dir, cacheRoot },
      logger,
    )

    const mutable = cfg as unknown as { skills: { paths: string[] } }
    expect(mutable.skills.paths).toHaveLength(1)
    const injectedPath = mutable.skills.paths[0]!
    // Should be under the cache root
    expect(injectedPath.startsWith(cacheRoot)).toBe(true)
    // The SKILL.md in the copy should have the prefixed name
    const skillMdContent = readFileSync(path.join(injectedPath, "SKILL.md"), "utf8")
    expect(extractSkillName(skillMdContent)).toBe("myplugin-my-skill")
    expect(summary.skills).toBe(1)
    expect(summary.renamed).toBe(1)
  })

  test("preserves asset files in the cached copy (relative references survive)", async () => {
    const pluginDir = mkdtempSync(path.join(tmp.dir, "plug-"))
    const skillsDir = path.join(pluginDir, "skills")
    mkdirSync(skillsDir, { recursive: true })
    writeSkillDir(skillsDir, "my-skill", {
      "assets/diagram.png": "fake-image-bytes",
      "examples/usage.md": "# Usage example",
    })
    const cacheRoot = path.join(tmp.dir, "cache")

    const existingNames = new Set(["my-skill"])
    const cfg = asConfig({ skills: { paths: [], urls: [] } })
    const logger = makeLogger()

    await injectSkills(
      [fakePlugin("myplugin@mkt", pluginDir)],
      cfg,
      existingNames,
      { home: tmp.dir, projectDir: tmp.dir, cacheRoot },
      logger,
    )

    const mutable = cfg as unknown as { skills: { paths: string[] } }
    const cachedDir = mutable.skills.paths[0]!
    // Assets are present
    expect(readFileSync(path.join(cachedDir, "assets", "diagram.png"), "utf8")).toBe("fake-image-bytes")
    expect(readFileSync(path.join(cachedDir, "examples", "usage.md"), "utf8")).toBe("# Usage example")
  })

  test("excludes dot-directories (e.g. .git) from the cached copy", async () => {
    const pluginDir = mkdtempSync(path.join(tmp.dir, "plug-"))
    const skillsDir = path.join(pluginDir, "skills")
    mkdirSync(skillsDir, { recursive: true })
    writeSkillDir(skillsDir, "versioned-skill", {
      ".git/config": "[core]\n\trepositoryformatversion = 0",
      "README.md": "# Readme",
    })
    const cacheRoot = path.join(tmp.dir, "cache")

    const existingNames = new Set(["versioned-skill"])
    const cfg = asConfig({ skills: { paths: [], urls: [] } })
    const logger = makeLogger()

    await injectSkills(
      [fakePlugin("plug@mkt", pluginDir)],
      cfg,
      existingNames,
      { home: tmp.dir, projectDir: tmp.dir, cacheRoot },
      logger,
    )

    const mutable = cfg as unknown as { skills: { paths: string[] } }
    const cachedDir = mutable.skills.paths[0]!
    // Dot-dir .git must NOT be copied
    expect(existsSync(path.join(cachedDir, ".git"))).toBe(false)
    // Non-dot files are present
    expect(existsSync(path.join(cachedDir, "README.md"))).toBe(true)
  })
})

// ── injectSkills — cache keying / invalidation ────────────────────────────────

describe("injectSkills — cache keying and invalidation", () => {
  let tmp: { dir: string; cleanup: () => void }
  beforeEach(() => {
    tmp = makeTempDir()
  })
  afterEach(() => tmp.cleanup())

  test("reuses cached copy when source has not changed (no re-copy)", async () => {
    const pluginDir = mkdtempSync(path.join(tmp.dir, "plug-"))
    writePluginSkills(pluginDir, ["shared-name"])
    const cacheRoot = path.join(tmp.dir, "cache")
    const existingNames = new Set(["shared-name"])
    const plugin = fakePlugin("myplugin@mkt", pluginDir)

    // First injection
    const cfg1 = asConfig({ skills: { paths: [], urls: [] } })
    await injectSkills([plugin], cfg1, existingNames, { home: tmp.dir, projectDir: tmp.dir, cacheRoot }, makeLogger())

    const mutable1 = cfg1 as unknown as { skills: { paths: string[] } }
    const cachedDir = mutable1.skills.paths[0]!
    const cachedMd = path.join(cachedDir, "SKILL.md")
    const firstMtime = (await import("node:fs")).statSync(cachedMd).mtimeMs

    // Second injection (same source — no re-copy expected)
    const cfg2 = asConfig({ skills: { paths: [], urls: [] } })
    await injectSkills([plugin], cfg2, existingNames, { home: tmp.dir, projectDir: tmp.dir, cacheRoot }, makeLogger())

    const secondMtime = (await import("node:fs")).statSync(cachedMd).mtimeMs
    expect(secondMtime).toBe(firstMtime) // file not touched
  })

  test("regenerates cached copy when source SKILL.md is newer", async () => {
    const pluginDir = mkdtempSync(path.join(tmp.dir, "plug-"))
    writePluginSkills(pluginDir, ["shared-name"])
    const cacheRoot = path.join(tmp.dir, "cache")
    const existingNames = new Set(["shared-name"])
    const plugin = fakePlugin("myplugin@mkt", pluginDir)

    // First injection
    const cfg1 = asConfig({ skills: { paths: [], urls: [] } })
    await injectSkills([plugin], cfg1, existingNames, { home: tmp.dir, projectDir: tmp.dir, cacheRoot }, makeLogger())

    const mutable1 = cfg1 as unknown as { skills: { paths: string[] } }
    const cachedDir = mutable1.skills.paths[0]!
    const cachedMd = path.join(cachedDir, "SKILL.md")
    const firstMtime = (await import("node:fs")).statSync(cachedMd).mtimeMs

    // Simulate source update: touch the source SKILL.md to make it newer
    await Bun.sleep(10)
    const srcMd = path.join(pluginDir, "skills", "shared-name", "SKILL.md")
    writeFileSync(srcMd, readFileSync(srcMd, "utf8"))

    // Second injection (source is newer — should re-copy)
    const cfg2 = asConfig({ skills: { paths: [], urls: [] } })
    await injectSkills([plugin], cfg2, existingNames, { home: tmp.dir, projectDir: tmp.dir, cacheRoot }, makeLogger())

    const secondMtime = (await import("node:fs")).statSync(cachedMd).mtimeMs
    expect(secondMtime).toBeGreaterThan(firstMtime)
  })

  test("cache path uses <marketplace>/<plugin>/<version>/<allocatedName> layout", async () => {
    const pluginDir = mkdtempSync(path.join(tmp.dir, "plug-"))
    writePluginSkills(pluginDir, ["my-skill"])
    const cacheRoot = path.join(tmp.dir, "cache")
    const existingNames = new Set(["my-skill"])
    const plugin = fakePlugin("myplugin@acme", pluginDir, "2.3.4")

    const cfg = asConfig({ skills: { paths: [], urls: [] } })
    await injectSkills([plugin], cfg, existingNames, { home: tmp.dir, projectDir: tmp.dir, cacheRoot }, makeLogger())

    const mutable = cfg as unknown as { skills: { paths: string[] } }
    const cachedPath = mutable.skills.paths[0]!
    // Path must contain marketplace/plugin/version/allocatedName segments
    expect(cachedPath).toContain(path.join("acme", "myplugin", "2.3.4"))
    expect(cachedPath).toContain("myplugin-my-skill")
    // Old _at_ encoding must NOT appear
    expect(cachedPath).not.toContain("_at_")
  })

  test("GC removes stale version dir on version bump, keeps current version dir", async () => {
    const pluginDir = mkdtempSync(path.join(tmp.dir, "plug-"))
    writePluginSkills(pluginDir, ["shared-name"])
    const cacheRoot = path.join(tmp.dir, "cache")
    const existingNames = new Set(["shared-name"])

    // First injection with version 1.0.0
    const pluginV1 = fakePlugin("myplugin@acme", pluginDir, "1.0.0")
    const cfg1 = asConfig({ skills: { paths: [], urls: [] } })
    await injectSkills([pluginV1], cfg1, existingNames, { home: tmp.dir, projectDir: tmp.dir, cacheRoot }, makeLogger())

    // Verify the v1 dir was created
    const mutable1 = cfg1 as unknown as { skills: { paths: string[] } }
    const v1CachedDir = mutable1.skills.paths[0]!
    expect(v1CachedDir).toContain("1.0.0")
    expect(existsSync(v1CachedDir)).toBe(true)

    // Second injection with version 2.0.0
    const pluginV2 = fakePlugin("myplugin@acme", pluginDir, "2.0.0")
    const logger2 = makeLogger()
    const cfg2 = asConfig({ skills: { paths: [], urls: [] } })
    await injectSkills([pluginV2], cfg2, existingNames, { home: tmp.dir, projectDir: tmp.dir, cacheRoot }, logger2)

    const mutable2 = cfg2 as unknown as { skills: { paths: string[] } }
    const v2CachedDir = mutable2.skills.paths[0]!
    expect(v2CachedDir).toContain("2.0.0")

    // Stale v1.0.0 dir must have been pruned
    expect(existsSync(v1CachedDir)).toBe(false)
    // Current v2.0.0 dir must remain
    expect(existsSync(v2CachedDir)).toBe(true)
    // A "pruned" log line must have been emitted
    expect(logger2.infos.some((m) => m.includes("pruned"))).toBe(true)
  })

  test("GC does not touch other plugins in the same marketplace", async () => {
    const pluginADir = mkdtempSync(path.join(tmp.dir, "plug-a-"))
    const pluginBDir = mkdtempSync(path.join(tmp.dir, "plug-b-"))
    writePluginSkills(pluginADir, ["shared-name"])
    writePluginSkills(pluginBDir, ["shared-name"])
    const cacheRoot = path.join(tmp.dir, "cache")

    // Inject pluginA@acme v1, then pluginB@acme v1 — both produce collision copies
    const existingNames = new Set(["shared-name"])
    const pluginA = fakePlugin("plugin-a@acme", pluginADir, "1.0.0")
    const pluginB = fakePlugin("plugin-b@acme", pluginBDir, "1.0.0")
    const cfg1 = asConfig({ skills: { paths: [], urls: [] } })
    await injectSkills([pluginA, pluginB], cfg1, existingNames,
      { home: tmp.dir, projectDir: tmp.dir, cacheRoot }, makeLogger())

    const mutable1 = cfg1 as unknown as { skills: { paths: string[] } }
    const pathA = mutable1.skills.paths[0]!
    const pathB = mutable1.skills.paths[1]!
    expect(existsSync(pathA)).toBe(true)
    expect(existsSync(pathB)).toBe(true)

    // Now upgrade only pluginA to v2 — pluginB's cache must survive
    const pluginAV2 = fakePlugin("plugin-a@acme", pluginADir, "2.0.0")
    const cfg2 = asConfig({ skills: { paths: [], urls: [] } })
    await injectSkills([pluginAV2, pluginB], cfg2, existingNames,
      { home: tmp.dir, projectDir: tmp.dir, cacheRoot }, makeLogger())

    // pluginA v1 stale dir is gone; pluginB v1 dir is untouched
    expect(existsSync(pathA)).toBe(false)
    expect(existsSync(pathB)).toBe(true)
  })

  test("GC does not touch other marketplaces (boundary safety)", async () => {
    const pluginZDir = mkdtempSync(path.join(tmp.dir, "plug-z-"))
    const pluginADir = mkdtempSync(path.join(tmp.dir, "plug-a-"))
    writePluginSkills(pluginZDir, ["shared-name"])
    writePluginSkills(pluginADir, ["shared-name"])
    const cacheRoot = path.join(tmp.dir, "cache")

    const existingNames = new Set(["shared-name"])

    // Inject plugin-z@mkt-B v1 — creates mkt-B/plugin-z/1.0.0/ in cache
    const pluginZ = fakePlugin("plugin-z@mkt-B", pluginZDir, "1.0.0")
    const cfgZ = asConfig({ skills: { paths: [], urls: [] } })
    await injectSkills([pluginZ], cfgZ, existingNames,
      { home: tmp.dir, projectDir: tmp.dir, cacheRoot }, makeLogger())

    const mutableZ = cfgZ as unknown as { skills: { paths: string[] } }
    const pathZ = mutableZ.skills.paths[0]!
    expect(existsSync(pathZ)).toBe(true)

    // Inject plugin-a@mkt-A v1, then v2 — GC should only touch mkt-A/plugin-a/
    const pluginAv1 = fakePlugin("plugin-a@mkt-A", pluginADir, "1.0.0")
    const cfgA1 = asConfig({ skills: { paths: [], urls: [] } })
    await injectSkills([pluginAv1], cfgA1, existingNames,
      { home: tmp.dir, projectDir: tmp.dir, cacheRoot }, makeLogger())

    const mutableA1 = cfgA1 as unknown as { skills: { paths: string[] } }
    const pathA1 = mutableA1.skills.paths[0]!
    expect(existsSync(pathA1)).toBe(true)

    const pluginAv2 = fakePlugin("plugin-a@mkt-A", pluginADir, "2.0.0")
    const cfgA2 = asConfig({ skills: { paths: [], urls: [] } })
    await injectSkills([pluginAv2], cfgA2, existingNames,
      { home: tmp.dir, projectDir: tmp.dir, cacheRoot }, makeLogger())

    // mkt-A/plugin-a v1 pruned; mkt-B/plugin-z v1 completely untouched
    expect(existsSync(pathA1)).toBe(false)
    expect(existsSync(pathZ)).toBe(true)
  })

  test("GC failure skips+warns but does not throw", async () => {
    const pluginDir = mkdtempSync(path.join(tmp.dir, "plug-"))
    writePluginSkills(pluginDir, ["shared-name"])
    const cacheRoot = path.join(tmp.dir, "cache")
    const existingNames = new Set(["shared-name"])

    // First injection creates the stale v1.0.0 cache entry
    const pluginV1 = fakePlugin("myplugin@acme", pluginDir, "1.0.0")
    const cfg1 = asConfig({ skills: { paths: [], urls: [] } })
    await injectSkills([pluginV1], cfg1, existingNames,
      { home: tmp.dir, projectDir: tmp.dir, cacheRoot }, makeLogger())

    const mutable1 = cfg1 as unknown as { skills: { paths: string[] } }
    const v1Dir = mutable1.skills.paths[0]!
    expect(existsSync(v1Dir)).toBe(true)

    // Make the stale dir unremovable by replacing it with a file of the same name
    // (fs.rm with recursive:true on a file succeeds; instead, chmod 000 it on Unix)
    // Simplest cross-platform simulation: remove the dir and put a file in its parent
    // with the same name so rm on it will have a different result.
    // Use a real approach: make the version-segment path read-only on the parent.
    const { mkdirSync: mkSync, chmodSync } = require("node:fs")
    const pluginCacheDir = require("node:path").dirname(v1Dir) // acme/myplugin
    chmodSync(pluginCacheDir, 0o555) // read+execute only → can't remove children

    let caughtThrow = false
    const logger2 = makeLogger()
    const pluginV2 = fakePlugin("myplugin@acme", pluginDir, "2.0.0")
    const cfg2 = asConfig({ skills: { paths: [], urls: [] } })
    try {
      await injectSkills([pluginV2], cfg2, existingNames,
        { home: tmp.dir, projectDir: tmp.dir, cacheRoot }, logger2)
    } catch {
      caughtThrow = true
    } finally {
      // Restore permissions so cleanup succeeds
      chmodSync(pluginCacheDir, 0o755)
    }

    expect(caughtThrow).toBe(false) // must not throw
    expect(logger2.warnings.some((w) => w.includes("prune"))).toBe(true)
  })
})

// ── sanitizeCacheSegment — adversarial inputs ─────────────────────────────────

import { sanitizeCacheSegment as _sanitize } from "../src/skill-inject.js"

describe("sanitizeCacheSegment — adversarial inputs", () => {
  test("replaces forward slash with underscore", () => {
    expect(_sanitize("a/b")).toBe("a_b")
  })

  test("replaces backslash with underscore", () => {
    expect(_sanitize("a\\b")).toBe("a_b")
  })

  test("replaces standalone .. with __", () => {
    expect(_sanitize("..")).toBe("__")
  })

  test("replaces .. embedded in a segment (slashes also replaced)", () => {
    // "foo../bar": '/' → '_' = "foo.._bar"; '..' → '__' = "foo___bar"
    expect(_sanitize("foo../bar")).toBe("foo___bar")
  })

  test("strips leading dot", () => {
    expect(_sanitize(".hidden")).toBe("_hidden")
  })

  test("all unsafe chars are gone from a mixed-separator traversal input", () => {
    const result = _sanitize("../..\\evil")
    expect(result).not.toContain("/")
    expect(result).not.toContain("\\")
    expect(result).not.toContain("..")
  })

  test("absolute path start is neutralized — no remaining slashes", () => {
    const result = _sanitize("/absolute/path")
    expect(result).not.toContain("/")
  })

  test("normal segment passes through unchanged", () => {
    expect(_sanitize("my-plugin")).toBe("my-plugin")
    expect(_sanitize("1.2.3")).toBe("1.2.3")
    expect(_sanitize("acme")).toBe("acme")
  })
})

// ── injectSkills — collision detection sources ────────────────────────────────

describe("injectSkills — collision detection", () => {
  let tmp: { dir: string; cleanup: () => void }
  beforeEach(() => {
    tmp = makeTempDir()
  })
  afterEach(() => tmp.cleanup())

  test("detects collision with built-in 'customize-opencode' skill", async () => {
    const pluginDir = mkdtempSync(path.join(tmp.dir, "plug-"))
    writePluginSkills(pluginDir, ["customize-opencode"])
    const cacheRoot = path.join(tmp.dir, "cache")

    // BUILTIN_SKILL_NAMES includes "customize-opencode"
    const existingNames = new Set(["customize-opencode"])
    const cfg = asConfig({ skills: { paths: [], urls: [] } })
    const logger = makeLogger()

    await injectSkills(
      [fakePlugin("myplugin@mkt", pluginDir)],
      cfg,
      existingNames,
      { home: tmp.dir, projectDir: tmp.dir, cacheRoot },
      logger,
    )

    const mutable = cfg as unknown as { skills: { paths: string[] } }
    expect(mutable.skills.paths).toHaveLength(1)
    // Should be in cache (collision path)
    expect(mutable.skills.paths[0]!.startsWith(cacheRoot)).toBe(true)
    // Patched name: myplugin-customize-opencode
    const content = readFileSync(path.join(mutable.skills.paths[0]!, "SKILL.md"), "utf8")
    expect(extractSkillName(content)).toBe("myplugin-customize-opencode")
  })

  test("intra-run collision: first plugin keeps bare name, second gets prefixed", async () => {
    // a-plugin < b-plugin alphabetically
    const pluginA = mkdtempSync(path.join(tmp.dir, "plug-a-"))
    const pluginB = mkdtempSync(path.join(tmp.dir, "plug-b-"))
    writePluginSkills(pluginA, ["shared"])
    writePluginSkills(pluginB, ["shared"])
    const cacheRoot = path.join(tmp.dir, "cache")

    const cfg = asConfig({ skills: { paths: [], urls: [] } })
    const logger = makeLogger()

    const summary = await injectSkills(
      [fakePlugin("a-plugin@mkt", pluginA), fakePlugin("b-plugin@mkt", pluginB)],
      cfg,
      new Set<string>(),
      { home: tmp.dir, projectDir: tmp.dir, cacheRoot },
      logger,
    )

    const mutable = cfg as unknown as { skills: { paths: string[] } }
    expect(mutable.skills.paths).toHaveLength(2)
    // First plugin's skill dir: direct (no cache copy)
    expect(mutable.skills.paths[0]!.startsWith(pluginA)).toBe(true)
    // Second plugin's skill: in cache
    expect(mutable.skills.paths[1]!.startsWith(cacheRoot)).toBe(true)
    // Patched name
    const content = readFileSync(path.join(mutable.skills.paths[1]!, "SKILL.md"), "utf8")
    expect(extractSkillName(content)).toBe("b-plugin-shared")
    expect(summary.skills).toBe(2)
    expect(summary.renamed).toBe(1)
  })

  test("native skill from existing names stays untouched; bridge item is prefixed", async () => {
    const pluginDir = mkdtempSync(path.join(tmp.dir, "plug-"))
    writePluginSkills(pluginDir, ["audit"])
    const cacheRoot = path.join(tmp.dir, "cache")

    // "audit" already claimed by a native skill (from .agents/skills/audit)
    const existingNames = new Set(["audit"])
    const cfg = asConfig({ skills: { paths: [], urls: [] } })
    const logger = makeLogger()

    await injectSkills(
      [fakePlugin("kio-development@mkt", pluginDir)],
      cfg,
      existingNames,
      { home: tmp.dir, projectDir: tmp.dir, cacheRoot },
      logger,
    )

    const mutable = cfg as unknown as { skills: { paths: string[] } }
    // The injected path must be in the cache (collision forced rename)
    expect(mutable.skills.paths[0]!.startsWith(cacheRoot)).toBe(true)
    // The native "audit" skill set is unchanged — we only added to cfg.skills.paths
    const content = readFileSync(path.join(mutable.skills.paths[0]!, "SKILL.md"), "utf8")
    expect(extractSkillName(content)).toBe("kio-development-audit")
  })
})

// ── injectSkills — failure handling ──────────────────────────────────────────

describe("injectSkills — failure handling", () => {
  let tmp: { dir: string; cleanup: () => void }
  beforeEach(() => {
    tmp = makeTempDir()
  })
  afterEach(() => tmp.cleanup())

  test("skips and warns when SKILL.md is unreadable (missing file)", async () => {
    const pluginDir = mkdtempSync(path.join(tmp.dir, "plug-"))
    // Create skills/ dir with a subdirectory but NO SKILL.md inside
    const skillsDir = path.join(pluginDir, "skills", "broken-skill")
    mkdirSync(skillsDir, { recursive: true })
    // No SKILL.md written

    const cfg = asConfig({ skills: { paths: [], urls: [] } })
    const logger = makeLogger()

    const summary = await injectSkills(
      [fakePlugin("plug@mkt", pluginDir)],
      cfg,
      new Set<string>(),
      { home: tmp.dir, projectDir: tmp.dir, cacheRoot: path.join(tmp.dir, "cache") },
      logger,
    )

    const mutable = cfg as unknown as { skills: { paths: string[] } }
    expect(mutable.skills.paths).toHaveLength(0)
    expect(summary.skills).toBe(0)
    expect(logger.warnings).toHaveLength(1)
    expect(logger.warnings[0]).toContain("could not read SKILL.md")
  })

  test("skips and warns when SKILL.md has no frontmatter name", async () => {
    const pluginDir = mkdtempSync(path.join(tmp.dir, "plug-"))
    const skillsDir = path.join(pluginDir, "skills", "no-name-skill")
    mkdirSync(skillsDir, { recursive: true })
    writeFileSync(path.join(skillsDir, "SKILL.md"), "No frontmatter here.\n")

    const cfg = asConfig({ skills: { paths: [], urls: [] } })
    const logger = makeLogger()

    const summary = await injectSkills(
      [fakePlugin("plug@mkt", pluginDir)],
      cfg,
      new Set<string>(),
      { home: tmp.dir, projectDir: tmp.dir, cacheRoot: path.join(tmp.dir, "cache") },
      logger,
    )

    const mutable = cfg as unknown as { skills: { paths: string[] } }
    expect(mutable.skills.paths).toHaveLength(0)
    expect(summary.skills).toBe(0)
    expect(logger.warnings).toHaveLength(1)
    expect(logger.warnings[0]).toContain("has no frontmatter name")
  })

  test("skips invalid skill but still injects valid skills from the same plugin", async () => {
    const pluginDir = mkdtempSync(path.join(tmp.dir, "plug-"))
    const skillsDir = path.join(pluginDir, "skills")
    mkdirSync(skillsDir, { recursive: true })
    // A valid skill
    writeSkillDir(skillsDir, "good-skill")
    // A broken skill (no SKILL.md)
    mkdirSync(path.join(skillsDir, "broken"), { recursive: true })

    const cfg = asConfig({ skills: { paths: [], urls: [] } })
    const logger = makeLogger()

    const summary = await injectSkills(
      [fakePlugin("plug@mkt", pluginDir)],
      cfg,
      new Set<string>(),
      { home: tmp.dir, projectDir: tmp.dir, cacheRoot: path.join(tmp.dir, "cache") },
      logger,
    )

    const mutable = cfg as unknown as { skills: { paths: string[] } }
    expect(mutable.skills.paths).toHaveLength(1)
    expect(summary.skills).toBe(1)
    // One warning for the broken skill
    expect(logger.warnings).toHaveLength(1)
  })
})

// ── injectSkills — cfg.skills.urls advisory ───────────────────────────────────

describe("injectSkills — cfg.skills.urls advisory", () => {
  let tmp: { dir: string; cleanup: () => void }
  beforeEach(() => {
    tmp = makeTempDir()
  })
  afterEach(() => tmp.cleanup())

  test("emits INFO (not warning) when cfg.skills.urls is non-empty", async () => {
    const pluginDir = mkdtempSync(path.join(tmp.dir, "plug-"))
    writePluginSkills(pluginDir, ["my-skill"])

    const cfg = asConfig({ skills: { paths: [], urls: ["https://example.com/skill.zip"] } })
    const logger = makeLogger()

    await injectSkills(
      [fakePlugin("plug@mkt", pluginDir)],
      cfg,
      new Set<string>(),
      { home: tmp.dir, projectDir: tmp.dir, cacheRoot: path.join(tmp.dir, "cache") },
      logger,
    )

    expect(logger.infos.some((m) => m.includes("cfg.skills.urls"))).toBe(true)
    expect(logger.warnings.every((w) => !w.includes("cfg.skills.urls"))).toBe(true)
    expect(logger.hadWarnings()).toBe(false)
  })

  test("does not emit urls info when cfg.skills.urls is empty", async () => {
    const pluginDir = mkdtempSync(path.join(tmp.dir, "plug-"))
    writePluginSkills(pluginDir, ["my-skill"])

    const cfg = asConfig({ skills: { paths: [], urls: [] } })
    const logger = makeLogger()

    await injectSkills(
      [fakePlugin("plug@mkt", pluginDir)],
      cfg,
      new Set<string>(),
      { home: tmp.dir, projectDir: tmp.dir, cacheRoot: path.join(tmp.dir, "cache") },
      logger,
    )

    expect(logger.infos.every((m) => !m.includes("cfg.skills.urls"))).toBe(true)
  })
})

describe("injectSkills — cfg.skills with only paths or only urls (A1 fix)", () => {
  let tmp: { dir: string; cleanup: () => void }

  beforeEach(() => { tmp = makeTempDir() })
  afterEach(() => tmp.cleanup())

  test("config with only paths (no urls) does not throw", async () => {
    // Simulates a real user config: { "skills": { "paths": ["~/my-skills"] } } — no urls key.
    // Before the fix this would throw TypeError: Cannot read properties of undefined (reading 'length').
    const cfg = asConfig({ skills: { paths: [] } })
    const logger = makeLogger()
    await expect(
      injectSkills([], cfg, new Set<string>(), { home: tmp.dir, projectDir: tmp.dir }, logger),
    ).resolves.toBeDefined()
  })

  test("config with only urls (no paths) does not throw", async () => {
    const cfg = asConfig({ skills: { urls: [] } })
    const logger = makeLogger()
    await expect(
      injectSkills([], cfg, new Set<string>(), { home: tmp.dir, projectDir: tmp.dir }, logger),
    ).resolves.toBeDefined()
  })

  test("config with only paths gets urls initialized to empty array", async () => {
    const cfg = asConfig({ skills: { paths: [] } })
    // Must pass at least one plugin so guardSkillsConfig runs.
    const pluginDir = path.join(tmp.dir, "plug")
    mkdirSync(path.join(pluginDir, "skills"), { recursive: true })
    const logger = makeLogger()
    await injectSkills(
      [fakePlugin("p@mkt", pluginDir)],
      cfg,
      new Set<string>(),
      { home: tmp.dir, projectDir: tmp.dir },
      logger,
    )
    const skills = (cfg as unknown as { skills: { paths: string[]; urls: string[] } }).skills
    expect(Array.isArray(skills.urls)).toBe(true)
  })
})

describe("injectSkills — symlink skip in copyDirRecursive (A5 fix)", () => {
  if (process.platform === "win32") return

  let tmp: { dir: string; cleanup: () => void }

  beforeEach(() => { tmp = makeTempDir() })
  afterEach(() => tmp.cleanup())

  test("symlink inside a skill dir is skipped with a warning and NOT copied to cache", async () => {
    const pluginDir = path.join(tmp.dir, "plugin")
    const skillDir = path.join(pluginDir, "skills", "my-skill")
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: my-skill\n---\nbody")
    // Create a symlink inside the skill dir pointing to an arbitrary host-path.
    // Before the A5 fix, this would have been followed and the target's content
    // copied into the bridge cache — a potential information-exfiltration path.
    require("node:fs").symlinkSync("/etc/hostname", path.join(skillDir, "evil-link"))

    const cacheRoot = path.join(tmp.dir, "cache")
    const cfg = asConfig({})
    const logger = makeLogger()

    // Force a collision so the cache-copy path runs (pre-claim the bare name).
    await injectSkills(
      [fakePlugin("plug@mkt", pluginDir)],
      cfg,
      new Set<string>(["my-skill"]),
      { home: tmp.dir, projectDir: tmp.dir, cacheRoot },
      logger,
    )

    // A "skipped symlink" warning must be emitted.
    expect(logger.warnings.some((w) => w.includes("symlink"))).toBe(true)

    // The symlink (and its resolved target content) must NOT appear in the cache.
    // The cache copy should contain SKILL.md but no "evil-link" entry.
    const skillName = (cfg as unknown as { skills?: { paths?: string[] } }).skills?.paths?.[0]
    expect(skillName).toBeDefined()
    // The allocated name is the prefixed one ("plug-my-skill" since "my-skill" was taken).
    const cachedEntries = require("node:fs").readdirSync(skillName!)
    expect(cachedEntries).not.toContain("evil-link")
    expect(cachedEntries).toContain("SKILL.md")
  })
})
