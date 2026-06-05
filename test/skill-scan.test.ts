import { describe, expect, test, afterEach } from "bun:test"
import fs from "node:fs/promises"
import { mkdirSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { extractSkillName, collectExistingSkillNames } from "../src/skill-scan.js"
import { BUILTIN_SKILL_NAMES } from "../src/opencode-builtins.js"

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  return os.tmpdir()
}

/** Create a temp directory, run `fn`, then remove it. */
async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(testBase(), "bridge-skill-scan-"))
  try {
    await fn(tmp)
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

/** Write a `SKILL.md` file under `dir/subPath` with the given frontmatter `name`. */
async function writeSkillMd(dir: string, subPath: string, name: string): Promise<void> {
  const fullPath = path.join(dir, subPath)
  await fs.mkdir(path.dirname(fullPath), { recursive: true })
  await fs.writeFile(
    fullPath,
    `---\nname: ${name}\ndescription: A test skill.\n---\n\nSkill body.\n`,
    "utf8",
  )
}

// ── extractSkillName ──────────────────────────────────────────────────────────

describe("extractSkillName", () => {
  test("extracts a bare (unquoted) name from a valid frontmatter block", () => {
    const content = `---\nname: my-skill\ndescription: Test.\n---\n\nBody.\n`
    expect(extractSkillName(content)).toBe("my-skill")
  })

  test("strips double-quoted name values", () => {
    const content = `---\nname: "quoted-skill"\n---\n`
    expect(extractSkillName(content)).toBe("quoted-skill")
  })

  test("strips single-quoted name values", () => {
    const content = `---\nname: 'single-quoted'\n---\n`
    expect(extractSkillName(content)).toBe("single-quoted")
  })

  test("returns null when frontmatter opening fence is missing", () => {
    const content = `name: my-skill\n---\nBody.\n`
    expect(extractSkillName(content)).toBeNull()
  })

  test("returns null when there is no closing fence", () => {
    const content = `---\nname: my-skill\nBody.\n`
    expect(extractSkillName(content)).toBeNull()
  })

  test("returns null when the name field is absent from frontmatter", () => {
    const content = `---\ndescription: No name here.\n---\nBody.\n`
    expect(extractSkillName(content)).toBeNull()
  })

  test("tolerates unknown Claude-specific frontmatter keys", () => {
    const content = `---\nname: kio-dev\nallowed-tools: [bash]\nuser-invocable: true\nlicense: MIT\n---\n`
    expect(extractSkillName(content)).toBe("kio-dev")
  })

  test("returns null for an empty string", () => {
    expect(extractSkillName("")).toBeNull()
  })

  test("does not misread an indented 'name:' line nested under a block scalar", () => {
    // A `description: |` block scalar may contain indented `name: ...` lines that
    // are part of the description text, not the top-level name field.
    const content = [
      "---",
      "description: |",
      "  Use this skill when name: something appears in context.",
      "  name: not-the-skill-name",
      "name: real-skill-name",
      "---",
      "",
      "Body.",
    ].join("\n")
    // Only the non-indented `name:` line should be matched.
    expect(extractSkillName(content)).toBe("real-skill-name")
  })

  test("returns null when only indented name lines exist (no top-level name)", () => {
    const content = [
      "---",
      "description: |",
      "  name: nested-only",
      "---",
      "",
    ].join("\n")
    expect(extractSkillName(content)).toBeNull()
  })

  test("strips a trailing YAML line comment from an unquoted name value", () => {
    const content = `---\nname: foo # the foo skill\n---\n`
    expect(extractSkillName(content)).toBe("foo")
  })

  test("does not strip a # that is part of a bare value with no preceding whitespace", () => {
    // A bare `#` with no whitespace before it is part of the value, not a comment.
    const content = `---\nname: foo#bar\n---\n`
    expect(extractSkillName(content)).toBe("foo#bar")
  })

  test("does not strip comments from a double-quoted name (# is literal inside quotes)", () => {
    const content = `---\nname: "foo # not a comment"\n---\n`
    expect(extractSkillName(content)).toBe("foo # not a comment")
  })

  test("does not strip comments from a single-quoted name", () => {
    const content = `---\nname: 'foo # also not a comment'\n---\n`
    expect(extractSkillName(content)).toBe("foo # also not a comment")
  })
})

// ── collectExistingSkillNames — built-ins always present ─────────────────────

describe("collectExistingSkillNames — built-in skill names", () => {
  test("always includes the built-in skill names even with no directories present", async () => {
    await withTempDir(async (tmp) => {
      const names = await collectExistingSkillNames({
        home: path.join(tmp, "home"),
        projectDir: path.join(tmp, "project"),
      })
      for (const builtin of BUILTIN_SKILL_NAMES) {
        expect(names.has(builtin)).toBe(true)
      }
    })
  })
})

// ── collectExistingSkillNames — external roots (.claude/.agents) ──────────────

describe("collectExistingSkillNames — external roots (.claude/.agents)", () => {
  test("picks up skills from ~/.claude/skills/ (global external root)", async () => {
    await withTempDir(async (tmp) => {
      const home = path.join(tmp, "home")
      // ~/.claude/skills/my-skill/SKILL.md
      await writeSkillMd(path.join(home, ".claude", "skills", "my-skill"), "SKILL.md", "global-claude-skill")

      const names = await collectExistingSkillNames({
        home,
        projectDir: path.join(tmp, "project"),
      })
      expect(names.has("global-claude-skill")).toBe(true)
    })
  })

  test("picks up skills from ~/.agents/skills/ (global agents root)", async () => {
    await withTempDir(async (tmp) => {
      const home = path.join(tmp, "home")
      await writeSkillMd(path.join(home, ".agents", "skills", "agents-skill"), "SKILL.md", "global-agents-skill")

      const names = await collectExistingSkillNames({
        home,
        projectDir: path.join(tmp, "project"),
      })
      expect(names.has("global-agents-skill")).toBe(true)
    })
  })

  test("picks up skills from a project-upward .agents/skills/ dir (native .agents collision case)", async () => {
    await withTempDir(async (tmp) => {
      const home = path.join(tmp, "home")
      // project dir has a parent with .agents/skills
      const projectDir = path.join(tmp, "workspace", "project")
      await fs.mkdir(projectDir, { recursive: true })
      // .agents/skills is a sibling of "workspace"? No — it's UNDER workspace
      // i.e. tmp/workspace/.agents/skills/native/SKILL.md
      await writeSkillMd(
        path.join(tmp, "workspace", ".agents", "skills", "native"),
        "SKILL.md",
        "native-agents-skill",
      )

      const names = await collectExistingSkillNames({ home, projectDir })
      expect(names.has("native-agents-skill")).toBe(true)
    })
  })

  test("ignores absent .claude/.agents dirs without error", async () => {
    await withTempDir(async (tmp) => {
      const names = await collectExistingSkillNames({
        home: path.join(tmp, "no-home"),
        projectDir: path.join(tmp, "no-project"),
      })
      // Should not throw; still returns built-ins
      expect(names.has("customize-opencode")).toBe(true)
    })
  })
})

// ── collectExistingSkillNames — OpenCode config dirs ─────────────────────────

describe("collectExistingSkillNames — OpenCode config dirs", () => {
  test("picks up skills from the XDG opencode config dir (skills/ subdir)", async () => {
    await withTempDir(async (tmp) => {
      const home = path.join(tmp, "home")
      const xdgConfigHome = path.join(home, ".config")
      // ~/.config/opencode/skills/cfg-skill/SKILL.md
      await writeSkillMd(
        path.join(xdgConfigHome, "opencode", "skills", "cfg-skill"),
        "SKILL.md",
        "opencode-config-skill",
      )

      // Pass xdgConfigHome explicitly for hermetic tests.
      const names = await collectExistingSkillNames({
        home,
        projectDir: path.join(tmp, "project"),
        xdgConfigHome,
      })
      expect(names.has("opencode-config-skill")).toBe(true)
    })
  })

  test("xdgConfigHome option overrides process.env XDG_CONFIG_HOME", async () => {
    await withTempDir(async (tmp) => {
      const home = path.join(tmp, "home")
      const customXdg = path.join(tmp, "custom-xdg")
      // Place a skill under the custom XDG path
      await writeSkillMd(
        path.join(customXdg, "opencode", "skills", "custom-xdg-skill"),
        "SKILL.md",
        "custom-xdg-skill",
      )
      // Also place a skill under the default ~/.config to verify it's NOT found when
      // custom xdgConfigHome is provided.
      const defaultXdg = path.join(home, ".config")
      await writeSkillMd(
        path.join(defaultXdg, "opencode", "skills", "default-xdg-skill"),
        "SKILL.md",
        "default-xdg-skill",
      )

      const names = await collectExistingSkillNames({
        home,
        projectDir: path.join(tmp, "project"),
        xdgConfigHome: customXdg,
      })
      expect(names.has("custom-xdg-skill")).toBe(true)
      // The default ~/.config/opencode dir is NOT scanned when xdgConfigHome is overridden.
      expect(names.has("default-xdg-skill")).toBe(false)
    })
  })

  test("picks up skills from a project-upward .opencode/skills/ dir", async () => {
    await withTempDir(async (tmp) => {
      const home = path.join(tmp, "home")
      const projectDir = path.join(tmp, "workspace", "project")
      await fs.mkdir(projectDir, { recursive: true })
      // tmp/workspace/.opencode/skills/proj-skill/SKILL.md
      await writeSkillMd(
        path.join(tmp, "workspace", ".opencode", "skills", "proj-skill"),
        "SKILL.md",
        "project-opencode-skill",
      )

      const names = await collectExistingSkillNames({ home, projectDir })
      expect(names.has("project-opencode-skill")).toBe(true)
    })
  })

  test("picks up skills from ~/.opencode/skills/ (home-scoped .opencode dir)", async () => {
    await withTempDir(async (tmp) => {
      const home = path.join(tmp, "home")
      // ~/.opencode/skills/home-ocode-skill/SKILL.md
      // Use a projectDir outside home so the upward walk does not encounter home's .opencode
      // before the explicit home-opencode dedup branch runs.
      const projectDir = path.join(tmp, "unrelated-project")
      await fs.mkdir(projectDir, { recursive: true })
      await writeSkillMd(
        path.join(home, ".opencode", "skills", "home-ocode-skill"),
        "SKILL.md",
        "home-opencode-skill",
      )

      const names = await collectExistingSkillNames({ home, projectDir })
      expect(names.has("home-opencode-skill")).toBe(true)
    })
  })
})

// ── collectExistingSkillNames — cfg.skills.paths ─────────────────────────────

describe("collectExistingSkillNames — cfg.skills.paths entries", () => {
  test("picks up skills from an explicit skillsPaths entry", async () => {
    await withTempDir(async (tmp) => {
      const home = path.join(tmp, "home")
      const extraSkillDir = path.join(tmp, "extra-skills", "my-plugin-skill")
      await writeSkillMd(extraSkillDir, "SKILL.md", "explicit-path-skill")

      const names = await collectExistingSkillNames({
        home,
        projectDir: path.join(tmp, "project"),
        skillsPaths: [extraSkillDir],
      })
      expect(names.has("explicit-path-skill")).toBe(true)
    })
  })

  test("a missing skillsPaths entry is silently skipped", async () => {
    await withTempDir(async (tmp) => {
      const names = await collectExistingSkillNames({
        home: path.join(tmp, "home"),
        projectDir: path.join(tmp, "project"),
        skillsPaths: [path.join(tmp, "does-not-exist")],
      })
      expect(names.has("customize-opencode")).toBe(true) // no throw
    })
  })

  test("expands a ~/…-prefixed skillsPaths entry against home", async () => {
    await withTempDir(async (tmp) => {
      const home = path.join(tmp, "home")
      // Create the skill at the expanded path: <home>/my-skills/tilde-skill/SKILL.md
      await writeSkillMd(path.join(home, "my-skills", "tilde-skill"), "SKILL.md", "tilde-expanded-skill")

      const names = await collectExistingSkillNames({
        home,
        projectDir: path.join(tmp, "project"),
        skillsPaths: ["~/my-skills/tilde-skill"],
      })
      expect(names.has("tilde-expanded-skill")).toBe(true)
    })
  })

  test("resolves a relative skillsPaths entry against projectDir", async () => {
    await withTempDir(async (tmp) => {
      const home = path.join(tmp, "home")
      const projectDir = path.join(tmp, "project")
      await fs.mkdir(projectDir, { recursive: true })
      // Create the skill at <projectDir>/local-skills/rel-skill/SKILL.md
      await writeSkillMd(path.join(projectDir, "local-skills", "rel-skill"), "SKILL.md", "relative-path-skill")

      const names = await collectExistingSkillNames({
        home,
        projectDir,
        skillsPaths: ["local-skills/rel-skill"],
      })
      expect(names.has("relative-path-skill")).toBe(true)
    })
  })
})

// ── collectExistingSkillNames — collision scenarios ───────────────────────────

describe("collectExistingSkillNames — collision detection", () => {
  test("skills from multiple dirs are all collected into one set", async () => {
    await withTempDir(async (tmp) => {
      const home = path.join(tmp, "home")
      await writeSkillMd(
        path.join(home, ".claude", "skills", "alpha"),
        "SKILL.md",
        "alpha-skill",
      )
      await writeSkillMd(
        path.join(home, ".agents", "skills", "beta"),
        "SKILL.md",
        "beta-skill",
      )

      const names = await collectExistingSkillNames({
        home,
        projectDir: path.join(tmp, "project"),
      })
      expect(names.has("alpha-skill")).toBe(true)
      expect(names.has("beta-skill")).toBe(true)
    })
  })

  test("a skill from .agents/skills signals a collision for a bridge plugin skill with the same name", async () => {
    await withTempDir(async (tmp) => {
      const home = path.join(tmp, "home")
      await writeSkillMd(
        path.join(home, ".agents", "skills", "code-review-skill"),
        "SKILL.md",
        "code-review",
      )

      const names = await collectExistingSkillNames({
        home,
        projectDir: path.join(tmp, "project"),
      })

      // A bridge plugin trying to inject a skill named "code-review" must detect
      // this collision using the returned set.
      expect(names.has("code-review")).toBe(true)
    })
  })

  test("a skill with a malformed SKILL.md (no frontmatter name) is silently ignored", async () => {
    await withTempDir(async (tmp) => {
      const home = path.join(tmp, "home")
      const skillDir = path.join(home, ".claude", "skills", "broken")
      await fs.mkdir(skillDir, { recursive: true })
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "No frontmatter here.\n",
        "utf8",
      )
      // Should not throw; broken skill is skipped
      const names = await collectExistingSkillNames({ home, projectDir: path.join(tmp, "project") })
      expect(names.has("customize-opencode")).toBe(true)
    })
  })
})
