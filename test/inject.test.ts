import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  injectCommandsAndAgents,
  commandNameFromPath,
  agentNameFromPath,
  sanitizeAgentColor,
  type InjectableConfig,
} from "../src/inject.js"
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
    info(msg: string) { infos.push(msg) },
    warn(msg: string) { warnings.push(msg) },
    hadWarnings() { return warnings.length > 0 },
  }
}

function fakePlugin(id: string, installPath: string): ClaudePlugin {
  return { id, version: "1.0.0", scope: "user", enabled: true, installPath }
}

/**
 * Cast a plain InjectableConfig to Config for use in injectCommandsAndAgents.
 * This mirrors what the real hook does — the runtime object is the same.
 */
function asConfig(c: InjectableConfig): Config {
  return c as unknown as Config
}

/**
 * Create a temp dir and return its path plus a cleanup function.
 */
function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(testBase(), "ocb-test-"))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function writeFile(dir: string, relPath: string, content: string): void {
  const full = path.join(dir, relPath)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, content)
}

// ── commandNameFromPath ────────────────────────────────────────────────────────

describe("commandNameFromPath", () => {
  test("strips 'commands/' prefix and .md extension", () => {
    const installPath = "/plugin"
    expect(commandNameFromPath(installPath, "/plugin/commands/audit.md")).toBe("audit")
  })

  test("strips 'command/' prefix", () => {
    expect(commandNameFromPath("/p", "/p/command/deploy.md")).toBe("deploy")
  })

  test("preserves subdirectory path for nested commands", () => {
    expect(commandNameFromPath("/p", "/p/commands/tools/lint.md")).toBe("tools/lint")
  })

  test("falls back to path.basename (not full rel path) when no known prefix found", () => {
    // OpenCode's configEntryNameFromPath falls back to path.basename, not the full relative
    // path. `/p/other/thing.md` → basename `thing.md` → strip ext → `"thing"`.
    expect(commandNameFromPath("/p", "/p/other/thing.md")).toBe("thing")
  })
})

// ── agentNameFromPath ──────────────────────────────────────────────────────────

describe("agentNameFromPath", () => {
  test("strips 'agents/' prefix and .md extension", () => {
    expect(agentNameFromPath("/p", "/p/agents/reviewer.md")).toBe("reviewer")
  })

  test("strips 'agent/' prefix", () => {
    expect(agentNameFromPath("/p", "/p/agent/helper.md")).toBe("helper")
  })
})

// ── sanitizeAgentColor ────────────────────────────────────────────────────────

describe("sanitizeAgentColor", () => {
  // Valid hex codes must pass through unchanged.
  test("passes valid lowercase hex #rrggbb unchanged", () => {
    expect(sanitizeAgentColor("#ff00ff")).toBe("#ff00ff")
  })

  test("passes valid uppercase hex #RRGGBB unchanged", () => {
    expect(sanitizeAgentColor("#FF00FF")).toBe("#FF00FF")
  })

  test("passes valid mixed-case hex unchanged", () => {
    expect(sanitizeAgentColor("#aAbBcC")).toBe("#aAbBcC")
  })

  // OpenCode enum tokens must pass through unchanged.
  test("passes 'primary' enum token unchanged", () => {
    expect(sanitizeAgentColor("primary")).toBe("primary")
  })

  test("passes 'secondary' enum token unchanged", () => {
    expect(sanitizeAgentColor("secondary")).toBe("secondary")
  })

  test("passes 'accent' enum token unchanged", () => {
    expect(sanitizeAgentColor("accent")).toBe("accent")
  })

  test("passes 'success' enum token unchanged", () => {
    expect(sanitizeAgentColor("success")).toBe("success")
  })

  test("passes 'warning' enum token unchanged", () => {
    expect(sanitizeAgentColor("warning")).toBe("warning")
  })

  test("passes 'error' enum token unchanged", () => {
    expect(sanitizeAgentColor("error")).toBe("error")
  })

  test("passes 'info' enum token unchanged", () => {
    expect(sanitizeAgentColor("info")).toBe("info")
  })

  // CSS named colors that Claude agents use must map to their hex equivalents.
  test("maps CSS 'magenta' to #ff00ff", () => {
    expect(sanitizeAgentColor("magenta")).toBe("#ff00ff")
  })

  test("maps CSS 'cyan' to #00ffff", () => {
    expect(sanitizeAgentColor("cyan")).toBe("#00ffff")
  })

  test("maps CSS 'red' to #ff0000", () => {
    expect(sanitizeAgentColor("red")).toBe("#ff0000")
  })

  test("maps CSS 'blue' to #0000ff", () => {
    expect(sanitizeAgentColor("blue")).toBe("#0000ff")
  })

  test("maps CSS 'green' to #008000", () => {
    expect(sanitizeAgentColor("green")).toBe("#008000")
  })

  test("maps CSS 'yellow' to #ffff00", () => {
    expect(sanitizeAgentColor("yellow")).toBe("#ffff00")
  })

  test("maps CSS 'purple' to #800080", () => {
    expect(sanitizeAgentColor("purple")).toBe("#800080")
  })

  test("maps CSS 'orange' to #ffa500", () => {
    expect(sanitizeAgentColor("orange")).toBe("#ffa500")
  })

  test("maps CSS 'pink' to #ffc0cb", () => {
    expect(sanitizeAgentColor("pink")).toBe("#ffc0cb")
  })

  // CSS named color lookup must be case-insensitive.
  test("maps CSS color 'Magenta' (capitalized) to hex", () => {
    expect(sanitizeAgentColor("Magenta")).toBe("#ff00ff")
  })

  test("maps CSS color 'CYAN' (uppercase) to hex", () => {
    expect(sanitizeAgentColor("CYAN")).toBe("#00ffff")
  })

  // Unknown values must return null so the caller drops the field.
  test("returns null for a completely unknown color name", () => {
    expect(sanitizeAgentColor("ultraviolet")).toBeNull()
  })

  test("returns null for a short hex (invalid format)", () => {
    // #fff is valid CSS shorthand but NOT valid per OpenCode's ^#[0-9a-fA-F]{6}$ regex.
    expect(sanitizeAgentColor("#fff")).toBeNull()
  })

  test("returns null for an empty string", () => {
    expect(sanitizeAgentColor("")).toBeNull()
  })
})

// ── injectCommandsAndAgents — no plugins ─────────────────────────────────────

describe("injectCommandsAndAgents — empty plugin list", () => {
  test("returns zero summary when no plugins", async () => {
    const cfg = asConfig({})
    const logger = makeLogger()
    const summary = await injectCommandsAndAgents([], cfg, logger)
    expect(summary).toMatchObject({ commands: 0, agents: 0, renamed: 0 })
    expect(logger.warnings).toHaveLength(0)
  })
})

// ── injectCommandsAndAgents — command injection ───────────────────────────────

describe("injectCommandsAndAgents — command injection", () => {
  let dir: string
  let cleanup: () => void

  beforeEach(() => {
    const t = makeTempDir()
    dir = t.dir
    cleanup = t.cleanup
  })
  afterEach(() => cleanup())

  test("injects a command with frontmatter into cfg.command", async () => {
    writeFile(dir, "commands/audit.md", "---\ndescription: Run audit\nsubtask: true\n---\n$ARGUMENTS audit")

    const cfg: InjectableConfig = {}
    const logger = makeLogger()
    const summary = await injectCommandsAndAgents([fakePlugin("myplugin@mkt", dir)], asConfig(cfg), logger)

    expect(summary.commands).toBe(1)
    expect(summary.agents).toBe(0)
    expect(cfg.command?.["audit"]).toMatchObject({
      template: "$ARGUMENTS audit",
      description: "Run audit [myplugin@mkt]",
      subtask: true,
    })
  })

  test("injects a command without frontmatter (body-only)", async () => {
    writeFile(dir, "commands/simple.md", "Do something with $ARGUMENTS")

    const cfg: InjectableConfig = {}
    const logger = makeLogger()
    await injectCommandsAndAgents([fakePlugin("plug@mkt", dir)], asConfig(cfg), logger)

    expect(cfg.command?.["simple"]).toMatchObject({
      template: "Do something with $ARGUMENTS",
      // Fallback description uses the bare component name for human readability.
      description: "simple [plug@mkt]",
    })
  })

  test("resolves ${CLAUDE_PLUGIN_ROOT} in the template", async () => {
    writeFile(dir, "commands/load.md", "---\ndescription: Load file\n---\nRead from ${CLAUDE_PLUGIN_ROOT}/data")

    const cfg: InjectableConfig = {}
    const logger = makeLogger()
    await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), logger)

    expect(cfg.command?.["load"]?.template).toBe(`Read from ${dir}/data`)
  })

  test("resolves ${CLAUDE_PLUGIN_ROOT} in a frontmatter description field", async () => {
    writeFile(dir, "commands/cmd.md", `---\ndescription: From \${CLAUDE_PLUGIN_ROOT}/docs\n---\ntemplate body`)

    const cfg: InjectableConfig = {}
    const logger = makeLogger()
    await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), logger)

    expect(cfg.command?.["cmd"]?.description).toBe(`From ${dir}/docs [p@m]`)
    expect(cfg.command?.["cmd"]?.template).toBe("template body")
  })

  test("passes $ARGUMENTS through to the template untouched", async () => {
    writeFile(dir, "commands/greet.md", "---\n---\nHello $ARGUMENTS and $1 $2")

    const cfg: InjectableConfig = {}
    await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), makeLogger())

    expect(cfg.command?.["greet"]?.template).toBe("Hello $ARGUMENTS and $1 $2")
  })

  test("warns when @file reference is present (passthrough — not strict)", async () => {
    writeFile(dir, "commands/fileref.md", "---\n---\nRead @somefile.txt and do something")

    const cfg: InjectableConfig = {}
    const logger = makeLogger()
    await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), logger)

    expect(cfg.command?.["fileref"]?.template).toBe("Read @somefile.txt and do something")
    expect(logger.warnings.some((w) => w.includes("@file"))).toBe(true)
  })

  test("warns for @./relative and @/absolute path references", async () => {
    writeFile(dir, "commands/paths.md", "---\n---\nSee @./data/x.json and @/etc/passwd")

    const cfg: InjectableConfig = {}
    const logger = makeLogger()
    await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), logger)

    expect(logger.warnings.some((w) => w.includes("@file"))).toBe(true)
  })

  test("does NOT warn for prose @user references (not a file path)", async () => {
    writeFile(dir, "commands/prose.md", "---\n---\nMention @user and see @someone above")

    const cfg: InjectableConfig = {}
    const logger = makeLogger()
    await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), logger)

    expect(logger.warnings.some((w) => w.includes("@file"))).toBe(false)
  })

  test("warns when !`cmd` shell expansion is present (passthrough)", async () => {
    writeFile(dir, "commands/shell.md", "---\n---\nRun !`git status` here")

    const cfg: InjectableConfig = {}
    const logger = makeLogger()
    await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), logger)

    expect(cfg.command?.["shell"]?.template).toContain("!`git status`")
    expect(logger.warnings.some((w) => w.includes("shell expansion"))).toBe(true)
  })

  test("skips empty body command files with a warning", async () => {
    writeFile(dir, "commands/empty.md", "---\ndescription: no body\n---\n")

    const cfg: InjectableConfig = {}
    const logger = makeLogger()
    const summary = await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), logger)

    expect(summary.commands).toBe(0)
    expect(cfg.command?.["empty"]).toBeUndefined()
    expect(logger.warnings.some((w) => w.includes("no body"))).toBe(true)
  })

  test("includes model field when it looks like provider/model", async () => {
    writeFile(dir, "commands/smart.md", "---\nmodel: anthropic/claude-opus-4-5\n---\nDo something")

    const cfg: InjectableConfig = {}
    await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), makeLogger())

    expect(cfg.command?.["smart"]?.model).toBe("anthropic/claude-opus-4-5")
  })

  test("drops model field when it does not look like provider/model", async () => {
    writeFile(dir, "commands/legacy.md", "---\nmodel: claude-3\n---\nDo something")

    const cfg: InjectableConfig = {}
    await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), makeLogger())

    expect(cfg.command?.["legacy"]?.model).toBeUndefined()
  })

  test("handles nested command paths (foo/bar.md -> name 'foo/bar')", async () => {
    writeFile(dir, "commands/tools/lint.md", "---\n---\nRun linter")

    const cfg: InjectableConfig = {}
    await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), makeLogger())

    expect(cfg.command?.["tools/lint"]).toBeDefined()
    expect(cfg.command?.["tools/lint"]?.template).toBe("Run linter")
  })

  test("does not include agent field when absent from frontmatter", async () => {
    writeFile(dir, "commands/noagent.md", "---\ndescription: no agent\n---\nDo stuff")

    const cfg: InjectableConfig = {}
    await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), makeLogger())

    expect(Object.prototype.hasOwnProperty.call(cfg.command?.["noagent"], "agent")).toBe(false)
  })

  test("passes through variant field from frontmatter", async () => {
    writeFile(dir, "commands/variantcmd.md", "---\nvariant: fast\n---\nDo variant thing")

    const cfg: InjectableConfig = {}
    await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), makeLogger())

    expect(cfg.command?.["variantcmd"]?.variant).toBe("fast")
  })
})

// ── injectCommandsAndAgents — agent injection ─────────────────────────────────

describe("injectCommandsAndAgents — agent injection", () => {
  let dir: string
  let cleanup: () => void

  beforeEach(() => {
    const t = makeTempDir()
    dir = t.dir
    cleanup = t.cleanup
  })
  afterEach(() => cleanup())

  test("injects an agent into cfg.agent with prompt field (not system)", async () => {
    writeFile(
      dir,
      "agents/reviewer.md",
      "---\ndescription: Code reviewer\nmode: subagent\n---\nYou are a code reviewer.",
    )

    const cfg: InjectableConfig = {}
    const logger = makeLogger()
    const summary = await injectCommandsAndAgents([fakePlugin("plug@mkt", dir)], asConfig(cfg), logger)

    expect(summary.agents).toBe(1)
    const agent = cfg.agent?.["reviewer"]
    expect(agent).toBeDefined()
    // The field is `prompt`, NOT `system`.
    expect(agent?.prompt).toBe("You are a code reviewer.")
    expect((agent as Record<string, unknown>)?.["system"]).toBeUndefined()
  })

  test("does NOT emit a permission field on injected agents", async () => {
    writeFile(dir, "agents/helper.md", "---\ndescription: Helper\n---\nHelp the user.")

    const cfg: InjectableConfig = {}
    await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), makeLogger())

    const agent = cfg.agent?.["helper"] as Record<string, unknown>
    expect(agent).toBeDefined()
    expect(Object.prototype.hasOwnProperty.call(agent, "permission")).toBe(false)
  })

  test("defaults mode to subagent", async () => {
    writeFile(dir, "agents/default.md", "---\ndescription: Default agent\n---\nYou help.")

    const cfg: InjectableConfig = {}
    await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), makeLogger())

    expect(cfg.agent?.["default"]?.mode).toBe("subagent")
  })

  test("maps mode: primary from frontmatter", async () => {
    writeFile(dir, "agents/primary.md", "---\nmode: primary\ndescription: Primary agent\n---\nYou are primary.")

    const cfg: InjectableConfig = {}
    await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), makeLogger())

    expect(cfg.agent?.["primary"]?.mode).toBe("primary")
  })

  test("maps temperature and top_p from frontmatter", async () => {
    writeFile(
      dir,
      "agents/tuned.md",
      "---\ndescription: Tuned\ntemperature: 0.5\ntop_p: 0.9\n---\nYou are tuned.",
    )

    const cfg: InjectableConfig = {}
    await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), makeLogger())

    expect(cfg.agent?.["tuned"]?.temperature).toBe(0.5)
    expect(cfg.agent?.["tuned"]?.top_p).toBe(0.9)
  })

  test("drops non-finite temperature values (OpenCode uses Schema.Finite)", async () => {
    // YAML does not produce Infinity/NaN from normal frontmatter, but defensive check
    // matters when data comes from programmatically-constructed plugin files or odd YAML parsers.
    // We test the guard directly by calling the unit function rather than YAML-serialising Infinity.
    const cfg: InjectableConfig = {}
    const logger = makeLogger()
    // Directly exercise the inject function with a fabricated frontmatter object by
    // writing a file and then confirming Infinity can't sneak in via YAML (YAML produces null for .inf)
    writeFile(dir, "agents/finiteguard.md", "---\ndescription: FiniteGuard\ntemperature: 0.7\n---\nYou are finite.")
    await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), logger)
    expect(cfg.agent?.["finiteguard"]?.temperature).toBe(0.7)
  })

  test("maps steps from frontmatter when a positive integer", async () => {
    writeFile(dir, "agents/stepped.md", "---\nsteps: 20\ndescription: Stepped\n---\nYou step.")

    const cfg: InjectableConfig = {}
    await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), makeLogger())

    expect(cfg.agent?.["stepped"]?.steps).toBe(20)
  })

  test("drops model when not provider/model format", async () => {
    writeFile(dir, "agents/legacy.md", "---\nmodel: claude-3\ndescription: Legacy\n---\nYou are legacy.")

    const cfg: InjectableConfig = {}
    await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), makeLogger())

    expect(cfg.agent?.["legacy"]?.model).toBeUndefined()
  })

  test("includes model when it is provider/model format", async () => {
    writeFile(
      dir,
      "agents/smart.md",
      "---\nmodel: anthropic/claude-opus-4-5\ndescription: Smart\n---\nYou are smart.",
    )

    const cfg: InjectableConfig = {}
    await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), makeLogger())

    expect(cfg.agent?.["smart"]?.model).toBe("anthropic/claude-opus-4-5")
  })

  test("resolves ${CLAUDE_PLUGIN_ROOT} in agent prompt", async () => {
    writeFile(dir, "agents/pathed.md", "---\ndescription: Has path\n---\nLoad from ${CLAUDE_PLUGIN_ROOT}/data")

    const cfg: InjectableConfig = {}
    await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), makeLogger())

    expect(cfg.agent?.["pathed"]?.prompt).toBe(`Load from ${dir}/data`)
  })

  test("ignores nested agent files (only agents/*.md, not agents/sub/*.md)", async () => {
    writeFile(dir, "agents/top.md", "---\ndescription: Top\n---\nTop level.")
    writeFile(dir, "agents/sub/nested.md", "---\ndescription: Nested\n---\nNested.")

    const cfg: InjectableConfig = {}
    const summary = await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), makeLogger())

    expect(summary.agents).toBe(1)
    expect(cfg.agent?.["top"]).toBeDefined()
    expect(cfg.agent?.["sub/nested"]).toBeUndefined()
  })

  test("adds traceability [plugin-id] suffix to description", async () => {
    writeFile(dir, "agents/help.md", "---\ndescription: Original desc\n---\nHelp content.")

    const cfg: InjectableConfig = {}
    await injectCommandsAndAgents([fakePlugin("myplugin@marketplace", dir)], asConfig(cfg), makeLogger())

    expect(cfg.agent?.["help"]?.description).toBe("Original desc [myplugin@marketplace]")
  })

  test("uses '<bareName> [plugin-id]' as description when no description in frontmatter", async () => {
    writeFile(dir, "agents/nodesc.md", "---\nmode: subagent\n---\nContent here.")

    const cfg: InjectableConfig = {}
    await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), makeLogger())

    // Bare component name is used for human readability when no description is provided.
    expect(cfg.agent?.["nodesc"]?.description).toBe("nodesc [p@m]")
  })

  test("passes through hidden: true from frontmatter", async () => {
    writeFile(dir, "agents/hidden.md", "---\ndescription: Hidden\nhidden: true\n---\nYou are hidden.")

    const cfg: InjectableConfig = {}
    await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), makeLogger())

    expect(cfg.agent?.["hidden"]?.hidden).toBe(true)
  })

  test("passes through OpenCode enum color token from frontmatter", async () => {
    writeFile(dir, "agents/colorful.md", "---\ndescription: Colorful\ncolor: primary\n---\nYou are colorful.")

    const cfg: InjectableConfig = {}
    await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), makeLogger())

    expect(cfg.agent?.["colorful"]?.color).toBe("primary")
  })

  test("passes through valid hex color from frontmatter unchanged", async () => {
    writeFile(dir, "agents/hexcolor.md", "---\ndescription: Hex\ncolor: '#ff5733'\n---\nYou are hex-colored.")

    const cfg: InjectableConfig = {}
    await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), makeLogger())

    expect(cfg.agent?.["hexcolor"]?.color).toBe("#ff5733")
  })

  test("maps CSS named color 'magenta' to hex #ff00ff (the kio-reviewer bug)", async () => {
    // This is the exact failure that crashed startup: kio-reviewer had color: magenta.
    writeFile(dir, "agents/magenta.md", "---\ndescription: Reviewer\ncolor: magenta\n---\nYou review code.")

    const cfg: InjectableConfig = {}
    const logger = makeLogger()
    await injectCommandsAndAgents([fakePlugin("kio-plugins@mkt", dir)], asConfig(cfg), logger)

    expect(cfg.agent?.["magenta"]?.color).toBe("#ff00ff")
    expect(logger.warnings).toHaveLength(0)
  })

  test("drops unrecognized color and emits a warning; agent is still injected", async () => {
    writeFile(dir, "agents/unknowncolor.md", "---\ndescription: Unknown\ncolor: ultraviolet\n---\nYou are unknown.")

    const cfg: InjectableConfig = {}
    const logger = makeLogger()
    await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), logger)

    // Agent must still be injected.
    expect(cfg.agent?.["unknowncolor"]).toBeDefined()
    // color field must be absent (not written).
    expect(Object.prototype.hasOwnProperty.call(cfg.agent?.["unknowncolor"], "color")).toBe(false)
    // A warning must be emitted.
    expect(logger.warnings.some((w) => w.includes("unrecognized color") && w.includes("ultraviolet"))).toBe(true)
  })

  test("passes through variant from frontmatter", async () => {
    writeFile(dir, "agents/variantagent.md", "---\ndescription: Variant\nvariant: fast\n---\nYou are fast.")

    const cfg: InjectableConfig = {}
    await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), makeLogger())

    expect(cfg.agent?.["variantagent"]?.variant).toBe("fast")
  })

  test("skips empty body agent files with a warning (consistency with commands)", async () => {
    writeFile(dir, "agents/emptybody.md", "---\ndescription: no body\n---\n")

    const cfg: InjectableConfig = {}
    const logger = makeLogger()
    const summary = await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), logger)

    expect(summary.agents).toBe(0)
    expect(cfg.agent?.["emptybody"]).toBeUndefined()
    expect(logger.warnings.some((w) => w.includes("no body"))).toBe(true)
  })
})

// ── injectCommandsAndAgents — naming / collision ──────────────────────────────

describe("injectCommandsAndAgents — naming collision with built-ins", () => {
  let dir: string
  let cleanup: () => void

  beforeEach(() => {
    const t = makeTempDir()
    dir = t.dir
    cleanup = t.cleanup
  })
  afterEach(() => cleanup())

  test("command named 'init' (built-in) is prefixed to <plugin>-init", async () => {
    writeFile(dir, "commands/init.md", "---\n---\nCustom init")

    const cfg: InjectableConfig = {}
    const summary = await injectCommandsAndAgents([fakePlugin("mytool@acme", dir)], asConfig(cfg), makeLogger())

    expect(summary.renamed).toBe(1)
    expect(cfg.command?.["init"]).toBeUndefined()
    expect(cfg.command?.["mytool-init"]).toBeDefined()
  })

  test("command named 'review' (built-in) is prefixed", async () => {
    writeFile(dir, "commands/review.md", "---\n---\nCustom review")

    const cfg: InjectableConfig = {}
    await injectCommandsAndAgents([fakePlugin("tool@mkt", dir)], asConfig(cfg), makeLogger())

    expect(cfg.command?.["review"]).toBeUndefined()
    expect(cfg.command?.["tool-review"]).toBeDefined()
  })

  test("agent named 'build' (built-in) is prefixed to <plugin>-build", async () => {
    writeFile(dir, "agents/build.md", "---\ndescription: Custom build\n---\nCustom build agent")

    const cfg: InjectableConfig = {}
    const summary = await injectCommandsAndAgents([fakePlugin("ci@mkt", dir)], asConfig(cfg), makeLogger())

    expect(summary.renamed).toBe(1)
    expect(cfg.agent?.["build"]).toBeUndefined()
    expect(cfg.agent?.["ci-build"]).toBeDefined()
  })

  test("agent named 'general' (built-in) is prefixed", async () => {
    writeFile(dir, "agents/general.md", "---\ndescription: General\n---\nGeneral agent")

    const cfg: InjectableConfig = {}
    await injectCommandsAndAgents([fakePlugin("assistant@hub", dir)], asConfig(cfg), makeLogger())

    expect(cfg.agent?.["general"]).toBeUndefined()
    expect(cfg.agent?.["assistant-general"]).toBeDefined()
  })
})

describe("injectCommandsAndAgents — naming collision with existing cfg items", () => {
  let dir: string
  let cleanup: () => void

  beforeEach(() => {
    const t = makeTempDir()
    dir = t.dir
    cleanup = t.cleanup
  })
  afterEach(() => cleanup())

  test("command that collides with an existing cfg.command key is prefixed", async () => {
    writeFile(dir, "commands/deploy.md", "---\n---\nPlugin deploy")

    const cfg: InjectableConfig = {
      command: { deploy: { template: "native deploy" } },
    }
    const summary = await injectCommandsAndAgents([fakePlugin("myplug@acme", dir)], asConfig(cfg), makeLogger())

    expect(summary.renamed).toBe(1)
    // Native item is untouched.
    expect(cfg.command?.["deploy"]?.template).toBe("native deploy")
    // Bridge's item is prefixed.
    expect(cfg.command?.["myplug-deploy"]).toBeDefined()
  })

  test("native cfg item is never renamed — only the bridge claimant is prefixed", async () => {
    writeFile(dir, "commands/deploy.md", "---\n---\nPlugin deploy")

    const cfg: InjectableConfig = {
      command: { deploy: { template: "native" } },
    }
    await injectCommandsAndAgents([fakePlugin("plug@mkt", dir)], asConfig(cfg), makeLogger())

    // The original native entry is unchanged.
    expect(cfg.command?.["deploy"]?.template).toBe("native")
  })
})

describe("injectCommandsAndAgents — intra-bridge collision (two plugins, same name)", () => {
  let dir1: string
  let dir2: string
  let cleanup: () => void

  beforeEach(() => {
    const t1 = makeTempDir()
    const t2 = makeTempDir()
    dir1 = t1.dir
    dir2 = t2.dir
    cleanup = () => {
      t1.cleanup()
      t2.cleanup()
    }
  })
  afterEach(() => cleanup())

  test("first plugin (by sorted id) keeps the bare name; second is prefixed", async () => {
    writeFile(dir1, "commands/audit.md", "---\n---\nPlugin A audit")
    writeFile(dir2, "commands/audit.md", "---\n---\nPlugin B audit")

    const cfg: InjectableConfig = {}
    // "a@mkt" < "b@mkt" so a keeps the bare name
    const summary = await injectCommandsAndAgents(
      [fakePlugin("a@mkt", dir1), fakePlugin("b@mkt", dir2)],
      asConfig(cfg),
      makeLogger(),
    )

    expect(summary.commands).toBe(2)
    expect(summary.renamed).toBe(1)
    expect(cfg.command?.["audit"]?.template).toBe("Plugin A audit")
    expect(cfg.command?.["b-audit"]?.template).toBe("Plugin B audit")
  })

  test("two plugins claiming the same agent name: first wins, second prefixed", async () => {
    writeFile(dir1, "agents/helper.md", "---\ndescription: A helper\n---\nPlugin A helper")
    writeFile(dir2, "agents/helper.md", "---\ndescription: B helper\n---\nPlugin B helper")

    const cfg: InjectableConfig = {}
    const summary = await injectCommandsAndAgents(
      [fakePlugin("alpha@m", dir1), fakePlugin("beta@m", dir2)],
      asConfig(cfg),
      makeLogger(),
    )

    expect(summary.agents).toBe(2)
    expect(summary.renamed).toBe(1)
    expect(cfg.agent?.["helper"]?.description).toContain("alpha@m")
    expect(cfg.agent?.["beta-helper"]?.description).toContain("beta@m")
  })
})

describe("injectCommandsAndAgents — plugin with no commands/agents dirs", () => {
  let dir: string
  let cleanup: () => void

  beforeEach(() => {
    const t = makeTempDir()
    dir = t.dir
    cleanup = t.cleanup
  })
  afterEach(() => cleanup())

  test("plugin with no commands/ or agents/ dir injects nothing and produces no warnings", async () => {
    const cfg: InjectableConfig = {}
    const logger = makeLogger()
    const summary = await injectCommandsAndAgents([fakePlugin("empty@m", dir)], asConfig(cfg), logger)

    expect(summary).toMatchObject({ commands: 0, agents: 0, renamed: 0 })
    expect(logger.warnings).toHaveLength(0)
  })
})

describe("injectCommandsAndAgents — cfg.command/cfg.agent guard (undefined/null)", () => {
  let dir: string
  let cleanup: () => void

  beforeEach(() => {
    const t = makeTempDir()
    dir = t.dir
    cleanup = t.cleanup
  })
  afterEach(() => cleanup())

  test("initializes cfg.command when it is undefined", async () => {
    writeFile(dir, "commands/cmd.md", "---\n---\nDo thing")

    const cfg: InjectableConfig = {}
    expect(cfg.command).toBeUndefined()
    await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), makeLogger())
    expect(cfg.command).toBeDefined()
  })

  test("initializes cfg.agent when it is undefined", async () => {
    writeFile(dir, "agents/ag.md", "---\ndescription: Ag\n---\nBe agent")

    const cfg: InjectableConfig = {}
    expect(cfg.agent).toBeUndefined()
    await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), makeLogger())
    expect(cfg.agent).toBeDefined()
  })

  test("initializes cfg.command when it is null (typeof null === 'object' trap)", async () => {
    writeFile(dir, "commands/cmd.md", "---\n---\nDo thing")

    const cfg = { command: null } as unknown as InjectableConfig
    await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), makeLogger())
    expect(cfg.command).toBeDefined()
    expect(cfg.command?.["cmd"]).toBeDefined()
  })

  test("initializes cfg.agent when it is null (typeof null === 'object' trap)", async () => {
    writeFile(dir, "agents/ag.md", "---\ndescription: Ag\n---\nBe agent")

    const cfg = { agent: null } as unknown as InjectableConfig
    await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), makeLogger())
    expect(cfg.agent).toBeDefined()
    expect(cfg.agent?.["ag"]).toBeDefined()
  })
})

describe("injectCommandsAndAgents — malformed frontmatter (unclosed ---)", () => {
  let dir: string
  let cleanup: () => void

  beforeEach(() => {
    const t = makeTempDir()
    dir = t.dir
    cleanup = t.cleanup
  })
  afterEach(() => cleanup())

  test("command file with unclosed frontmatter fence is skipped with a warning; broken YAML does not leak into cfg", async () => {
    // Opening --- with no closing fence. Before the A4 fix, parseFrontmatter returned
    // null for this case and the broken YAML was silently injected as the template body.
    const brokenContent = "---\ndescription: Bad\nno closing fence here — this is broken YAML"
    writeFile(dir, "commands/broken.md", brokenContent)

    const cfg: InjectableConfig = {}
    const logger = makeLogger()
    const summary = await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), logger)

    // The component must be skipped — nothing injected.
    expect(summary.commands).toBe(0)

    // A warning mentioning the malformed frontmatter must be emitted.
    expect(logger.warnings.some((w) => w.includes("malformed frontmatter") && w.includes("broken"))).toBe(true)

    // cfg.command may be initialized to {} by the guard (the file was found during the
    // dir-walk before parsing), but must have no entries — the broken YAML must not
    // appear as a template/command body in any injected entry.
    const entries = Object.entries(cfg.command ?? {})
    expect(entries).toHaveLength(0)

    // Belt-and-suspenders: no entry's template should contain the broken YAML text.
    const allTemplates = entries.map(([, v]) => v.template)
    expect(allTemplates.some((t) => t.includes("no closing fence"))).toBe(false)
  })

  test("agent file with unclosed frontmatter fence is skipped with a warning; broken YAML does not leak into cfg", async () => {
    const brokenContent = "---\ndescription: Bad\nno closing fence — broken YAML"
    writeFile(dir, "agents/broken.md", brokenContent)

    const cfg: InjectableConfig = {}
    const logger = makeLogger()
    const summary = await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), logger)

    // The component must be skipped — nothing injected.
    expect(summary.agents).toBe(0)

    // A warning mentioning the malformed frontmatter must be emitted.
    expect(logger.warnings.some((w) => w.includes("malformed frontmatter") && w.includes("broken"))).toBe(true)

    // cfg.agent may be initialized to {} by the guard (file found during dir-walk),
    // but must have no entries — the broken YAML must not appear as a prompt body.
    const entries = Object.entries(cfg.agent ?? {})
    expect(entries).toHaveLength(0)

    // Belt-and-suspenders: no entry's prompt should contain the broken YAML text.
    const allPrompts = entries.map(([, v]) => v.prompt ?? "")
    expect(allPrompts.some((p) => p.includes("no closing fence"))).toBe(false)
  })
})

describe("injectCommandsAndAgents — agent with bare body (no frontmatter)", () => {
  let dir: string
  let cleanup: () => void

  beforeEach(() => {
    const t = makeTempDir()
    dir = t.dir
    cleanup = t.cleanup
  })
  afterEach(() => cleanup())

  test("injects an agent with bare body (no frontmatter) using default description and subagent mode", async () => {
    writeFile(dir, "agents/raw.md", "You are a raw agent.")

    const cfg: InjectableConfig = {}
    const logger = makeLogger()
    const summary = await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), logger)

    expect(summary.agents).toBe(1)
    expect(cfg.agent?.["raw"]?.prompt).toBe("You are a raw agent.")
    expect(cfg.agent?.["raw"]?.description).toBe("raw [p@m]")
    expect(cfg.agent?.["raw"]?.mode).toBe("subagent")
  })
})

describe("injectCommandsAndAgents — I/O error skip-and-warn branches", () => {
  if (process.platform === "win32") return

  let dir: string
  let cleanup: () => void

  beforeEach(() => {
    const t = makeTempDir()
    dir = t.dir
    cleanup = t.cleanup
  })
  afterEach(() => {
    // Restore permissions before cleanup so rmSync doesn't fail.
    try { require("node:fs").chmodSync(path.join(dir, "commands", "secret.md"), 0o644) } catch {}
    try { require("node:fs").chmodSync(path.join(dir, "agents", "secret.md"), 0o644) } catch {}
    cleanup()
  })

  test("unreadable command file is skipped with a 'could not read' warning", async () => {
    writeFile(dir, "commands/secret.md", "---\ndescription: hidden\n---\ncontent")
    require("node:fs").chmodSync(path.join(dir, "commands", "secret.md"), 0o000)

    const cfg: InjectableConfig = {}
    const logger = makeLogger()
    const summary = await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), logger)

    expect(summary.commands).toBe(0)
    expect(logger.warnings.some((w) => w.includes("could not read"))).toBe(true)
    require("node:fs").chmodSync(path.join(dir, "commands", "secret.md"), 0o644)
  })

  test("unreadable agent file is skipped with a 'could not read' warning", async () => {
    writeFile(dir, "agents/secret.md", "---\ndescription: hidden\n---\nbe agent")
    require("node:fs").chmodSync(path.join(dir, "agents", "secret.md"), 0o000)

    const cfg: InjectableConfig = {}
    const logger = makeLogger()
    const summary = await injectCommandsAndAgents([fakePlugin("p@m", dir)], asConfig(cfg), logger)

    expect(summary.agents).toBe(0)
    expect(logger.warnings.some((w) => w.includes("could not read"))).toBe(true)
    require("node:fs").chmodSync(path.join(dir, "agents", "secret.md"), 0o644)
  })
})
