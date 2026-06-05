import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { startBridge, type BridgeServer } from "./harness.js"
import { extractSkillName } from "../src/skill-scan.js"

/**
 * End-to-end injection tests: verifies that enabled-plugin commands and agents appear in
 * the real OpenCode `/command` and `/agent` endpoints, that naming collision is handled
 * correctly (bridge item is prefixed, native item stays untouched), and that disabled/blocked
 * plugins contribute nothing.
 */

const TEST_TIMEOUT = 60_000

// ── Fixture helpers ────────────────────────────────────────────────────────────

/**
 * Base directory for fixture temp dirs. Mirrors the same OCB_TMPDIR override logic
 * as `harnessBase()` in harness.ts so fixture dirs and server dirs land on the same
 * filesystem — important on hosts where /tmp is a small tmpfs.
 *
 * Always returns an absolute path so that fixture installPath values passed in
 * plugin JSON are absolute when the bridge reads them from a different cwd.
 */
function fixtureBase(): string {
  const override = process.env["OCB_TMPDIR"] ?? process.env["TMPDIR"]
  if (override) {
    const abs = path.resolve(override)
    mkdirSync(abs, { recursive: true })
    return abs
  }
  return tmpdir()
}

function makePluginDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(fixtureBase(), "ocb-fixture-"))
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function writeFixtureFile(baseDir: string, relPath: string, content: string): void {
  const full = path.join(baseDir, relPath)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, content)
}

function userPlugin(id: string, installPath: string, enabled = true, version = "1.0.0") {
  return { id, version, scope: "user", enabled, installPath }
}

function writeSkillFixture(
  baseDir: string,
  skillsRelPath: string,
  skillName: string,
  extraFiles?: Record<string, string>,
): void {
  writeFixtureFile(
    baseDir,
    path.join(skillsRelPath, skillName, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: E2E test skill ${skillName}.\n---\n\nSkill body for ${skillName}.\n`,
  )
  if (extraFiles) {
    for (const [relPath, content] of Object.entries(extraFiles)) {
      writeFixtureFile(baseDir, path.join(skillsRelPath, skillName, relPath), content)
    }
  }
}

type CommandItem = { name: string; description?: string; template?: string }
type AgentItem = { name: string; description?: string; prompt?: string; mode?: string }
type SkillItem = { name: string; description?: string; location?: string }

function findByName<T extends { name: string }>(items: T[], name: string): T | undefined {
  return items.find((i) => i.name === name)
}

// ── Test suite: basic command + agent injection ────────────────────────────────

describe("bridge e2e — command injection", () => {
  let fixture: { dir: string; cleanup: () => void }
  let server: BridgeServer | undefined

  beforeAll(async () => {
    fixture = makePluginDir()

    writeFixtureFile(
      fixture.dir,
      "commands/greet.md",
      "---\ndescription: Greet the user\nsubtask: false\n---\nHello $ARGUMENTS",
    )
    writeFixtureFile(fixture.dir, "commands/tools/lint.md", "---\n---\nRun linter on $ARGUMENTS")

    server = await startBridge({
      claude: {
        plugins: [userPlugin("alpha@mkt", fixture.dir)],
      },
    })
    await server.triggerHook()
  }, TEST_TIMEOUT)

  afterAll(async () => {
    await server?.stop()
    fixture.cleanup()
  })

  test("server stays healthy after injection", async () => {
    const health = await server!.get("/global/health")
    expect(health.status).toBe(200)
  })

  test("injected command appears in GET /command", async () => {
    const res = await server!.get("/command")
    expect(res.status).toBe(200)
    const commands = res.body as CommandItem[]
    const greet = findByName(commands, "greet")
    expect(greet).toBeDefined()
    expect(greet?.description).toContain("Greet the user")
    expect(greet?.description).toContain("alpha@mkt")
  })

  test("injected nested command appears in GET /command", async () => {
    const res = await server!.get("/command")
    const commands = res.body as CommandItem[]
    const lint = findByName(commands, "tools/lint")
    expect(lint).toBeDefined()
  })

  test("injection summary is logged", () => {
    expect(server!.logHas("injected ")).toBe(true)
  })

  test("resolved plugin set is logged", () => {
    expect(server!.logHas("alpha@mkt")).toBe(true)
  })
})

// ── Test suite: basic agent injection ─────────────────────────────────────────

describe("bridge e2e — agent injection", () => {
  let fixture: { dir: string; cleanup: () => void }
  let server: BridgeServer | undefined

  beforeAll(async () => {
    fixture = makePluginDir()

    writeFixtureFile(
      fixture.dir,
      "agents/reviewer.md",
      "---\ndescription: Code reviewer\nmode: subagent\n---\nYou are a code reviewer.",
    )

    server = await startBridge({
      claude: {
        plugins: [userPlugin("plugin@mkt", fixture.dir)],
      },
    })
    await server.triggerHook()
  }, TEST_TIMEOUT)

  afterAll(async () => {
    await server?.stop()
    fixture.cleanup()
  })

  test("injected agent appears in GET /agent with description and prompt", async () => {
    const res = await server!.get("/agent")
    expect(res.status).toBe(200)
    const agents = res.body as AgentItem[]
    const reviewer = findByName(agents, "reviewer")
    expect(reviewer).toBeDefined()
    expect(reviewer?.description).toContain("Code reviewer")
    expect(reviewer?.description).toContain("plugin@mkt")
    // Assert the prompt field so a regression that swapped prompt→system would be caught.
    expect(reviewer?.prompt).toContain("You are a code reviewer")
    expect(reviewer?.mode).toBe("subagent")
  })

})

// ── Test suite: collision — bridge item is prefixed, native stays untouched ────

describe("bridge e2e — naming collision (native cfg item wins)", () => {
  let fixtureA: { dir: string; cleanup: () => void }
  let fixtureB: { dir: string; cleanup: () => void }
  let server: BridgeServer | undefined

  beforeAll(async () => {
    // "a-native@mkt" < "b-plugin@mkt" alphabetically, so a-native claims the bare "deploy"
    // name first; b-plugin must take the prefixed "b-plugin-deploy".
    fixtureA = makePluginDir()
    fixtureB = makePluginDir()

    writeFixtureFile(fixtureA.dir, "commands/deploy.md", "---\ndescription: First deploy\n---\nFirst deploy template")
    writeFixtureFile(fixtureB.dir, "commands/deploy.md", "---\ndescription: Plugin deploy\n---\nPlugin deploy template")

    server = await startBridge({
      claude: {
        plugins: [
          userPlugin("a-native@mkt", fixtureA.dir),
          userPlugin("b-plugin@mkt", fixtureB.dir),
        ],
      },
    })
    await server.triggerHook()
  }, TEST_TIMEOUT)

  afterAll(async () => {
    await server?.stop()
    fixtureA.cleanup()
    fixtureB.cleanup()
  })

  test("first plugin by id keeps bare name 'deploy'", async () => {
    const res = await server!.get("/command")
    const commands = res.body as CommandItem[]
    const deploy = findByName(commands, "deploy")
    expect(deploy).toBeDefined()
    expect(deploy?.description).toContain("a-native@mkt")
  })

  test("second plugin's 'deploy' is prefixed to 'b-plugin-deploy'", async () => {
    const res = await server!.get("/command")
    const commands = res.body as CommandItem[]
    const prefixed = findByName(commands, "b-plugin-deploy")
    expect(prefixed).toBeDefined()
    expect(prefixed?.description).toContain("b-plugin@mkt")
  })

  test("rename count is logged", () => {
    expect(server!.logHas("renamed 1 (collision)")).toBe(true)
  })
})

// ── Test suite: built-in collision — bridge item is prefixed ──────────────────

describe("bridge e2e — built-in command collision ('init' is built-in)", () => {
  let fixture: { dir: string; cleanup: () => void }
  let server: BridgeServer | undefined

  beforeAll(async () => {
    fixture = makePluginDir()

    // Plugin tries to inject a command named "init" — collides with the built-in.
    writeFixtureFile(fixture.dir, "commands/init.md", "---\ndescription: Custom init\n---\nCustom init template")

    server = await startBridge({
      claude: {
        plugins: [userPlugin("mytool@acme", fixture.dir)],
      },
    })
    await server.triggerHook()
  }, TEST_TIMEOUT)

  afterAll(async () => {
    await server?.stop()
    fixture.cleanup()
  })

  test("built-in 'init' command still appears in GET /command", async () => {
    const res = await server!.get("/command")
    const commands = res.body as CommandItem[]
    const init = findByName(commands, "init")
    expect(init).toBeDefined()
    // The native init has a known description.
    expect(init?.description).toContain("AGENTS.md")
  })

  test("plugin's 'init' is renamed to 'mytool-init' in GET /command", async () => {
    const res = await server!.get("/command")
    const commands = res.body as CommandItem[]
    const mytoolInit = findByName(commands, "mytool-init")
    expect(mytoolInit).toBeDefined()
    expect(mytoolInit?.description).toContain("mytool@acme")
  })
})

// ── Test suite: native cfg command collision (user opencode.json wins) ────────

describe("bridge e2e — native cfg.command collision (user opencode.json wins)", () => {
  let fixture: { dir: string; cleanup: () => void }
  let server: BridgeServer | undefined

  beforeAll(async () => {
    fixture = makePluginDir()
    writeFixtureFile(
      fixture.dir,
      "commands/deploy.md",
      "---\ndescription: Plugin deploy\n---\nPlugin deploy template",
    )

    server = await startBridge({
      claude: (projectDir) => {
        // Write opencode.json with a native 'deploy' command that should survive collision.
        writeFileSync(
          path.join(projectDir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            command: {
              deploy: { description: "Native deploy", template: "native deploy template" },
            },
            plugin: [
              `file://${path.resolve(import.meta.dir, "../src/index.ts")}`,
            ],
          }, null, 2),
        )
        return { plugins: [userPlugin("plugin@mkt", fixture.dir)] }
      },
    })
    await server.triggerHook()
  }, TEST_TIMEOUT)

  afterAll(async () => {
    await server?.stop()
    fixture.cleanup()
  })

  test("native 'deploy' is preserved with its original description", async () => {
    const res = await server!.get("/command")
    const commands = res.body as CommandItem[]
    const deploy = findByName(commands, "deploy")
    expect(deploy?.description).toContain("Native deploy")
  })

  test("bridge plugin's 'deploy' is renamed to 'plugin-deploy'", async () => {
    const res = await server!.get("/command")
    const commands = res.body as CommandItem[]
    const prefixed = findByName(commands, "plugin-deploy")
    expect(prefixed).toBeDefined()
    expect(prefixed?.description).toContain("plugin@mkt")
  })
})

// ── Test suite: disabled plugins contribute nothing ────────────────────────────

describe("bridge e2e — disabled plugins contribute nothing", () => {
  let fixture: { dir: string; cleanup: () => void }
  let server: BridgeServer | undefined

  beforeAll(async () => {
    fixture = makePluginDir()
    writeFixtureFile(fixture.dir, "commands/disabled-cmd.md", "---\n---\nShould not appear")

    server = await startBridge({
      claude: {
        plugins: [
          { id: "disabled@mkt", version: "1.0.0", scope: "user", enabled: false, installPath: fixture.dir },
        ],
      },
    })
    await server.triggerHook()
  }, TEST_TIMEOUT)

  afterAll(async () => {
    await server?.stop()
    fixture.cleanup()
  })

  test("disabled plugin's command does not appear in GET /command", async () => {
    const res = await server!.get("/command")
    const commands = res.body as CommandItem[]
    const cmd = findByName(commands, "disabled-cmd")
    expect(cmd).toBeUndefined()
  })

  test("injection summary shows 0 commands injected", () => {
    expect(server!.logHas("injected 0 command(s), 0 agent(s), 0 skill(s)")).toBe(true)
  })
})

// ── Test suite: blocked plugins contribute nothing ─────────────────────────────

describe("bridge e2e — blockedPlugins contribute nothing", () => {
  let fixture: { dir: string; cleanup: () => void }
  let server: BridgeServer | undefined

  beforeAll(async () => {
    fixture = makePluginDir()
    writeFixtureFile(fixture.dir, "commands/blocked-cmd.md", "---\n---\nShould not appear")

    server = await startBridge({
      options: { blockedPlugins: ["blocked@mkt"] },
      claude: {
        plugins: [userPlugin("blocked@mkt", fixture.dir)],
      },
    })
    await server.triggerHook()
  }, TEST_TIMEOUT)

  afterAll(async () => {
    await server?.stop()
    fixture.cleanup()
  })

  test("blocked plugin's command does not appear in GET /command", async () => {
    const res = await server!.get("/command")
    const commands = res.body as CommandItem[]
    const cmd = findByName(commands, "blocked-cmd")
    expect(cmd).toBeUndefined()
  })

  test("injection summary shows 0 commands injected", () => {
    expect(server!.logHas("injected 0 command(s), 0 agent(s), 0 skill(s)")).toBe(true)
  })
})

// ── Test suite: basic skill injection ─────────────────────────────────────────

describe("bridge e2e — skill injection", () => {
  let fixture: { dir: string; cleanup: () => void }
  let server: BridgeServer | undefined

  beforeAll(async () => {
    fixture = makePluginDir()

    // Write a plugin skill dir with a SKILL.md
    writeSkillFixture(fixture.dir, "skills", "my-e2e-skill", {
      "assets/example.txt": "asset content",
    })

    server = await startBridge({
      isolateCache: true,
      isolateHome: true,
      claude: {
        plugins: [userPlugin("skill-plugin@mkt", fixture.dir)],
      },
    })
    await server.triggerHook()
  }, TEST_TIMEOUT)

  afterAll(async () => {
    await server?.stop()
    fixture.cleanup()
  })

  test("server stays healthy after skill injection", async () => {
    const health = await server!.get("/global/health")
    expect(health.status).toBe(200)
  })

  test("injected skill appears in GET /skill", async () => {
    const res = await server!.get("/skill")
    expect(res.status).toBe(200)
    const skills = res.body as SkillItem[]
    const skill = findByName(skills, "my-e2e-skill")
    expect(skill).toBeDefined()
    expect(skill?.description).toContain("E2E test skill my-e2e-skill")
  })

  test("injection summary includes skill count", () => {
    expect(server!.logHas("1 skill(s)")).toBe(true)
  })
})

// ── Test suite: skill collision — intra-bridge (two plugins same skill name) ───

describe("bridge e2e — skill collision (intra-bridge)", () => {
  let fixtureA: { dir: string; cleanup: () => void }
  let fixtureB: { dir: string; cleanup: () => void }
  let server: BridgeServer | undefined

  beforeAll(async () => {
    // "a-skill-plugin@mkt" < "b-skill-plugin@mkt" alphabetically.
    // Both expose a skill named "shared-skill". First plugin keeps the bare name;
    // second plugin's copy goes to cache with prefixed name.
    fixtureA = makePluginDir()
    fixtureB = makePluginDir()

    writeSkillFixture(fixtureA.dir, "skills", "shared-skill", {
      "asset.txt": "from plugin A",
    })
    writeSkillFixture(fixtureB.dir, "skills", "shared-skill", {
      "asset.txt": "from plugin B",
    })

    server = await startBridge({
      isolateCache: true,
      isolateHome: true,
      claude: {
        plugins: [
          userPlugin("a-skill-plugin@mkt", fixtureA.dir),
          userPlugin("b-skill-plugin@mkt", fixtureB.dir),
        ],
      },
    })
    await server.triggerHook()
  }, TEST_TIMEOUT)

  afterAll(async () => {
    await server?.stop()
    fixtureA.cleanup()
    fixtureB.cleanup()
  })

  test("first plugin's skill appears under the bare name", async () => {
    const res = await server!.get("/skill")
    const skills = res.body as SkillItem[]
    const skill = findByName(skills, "shared-skill")
    expect(skill).toBeDefined()
    // Location should point into fixtureA's plugin dir (no cache copy)
    expect(skill?.location).toContain(fixtureA.dir)
  })

  test("second plugin's skill appears under the prefixed name", async () => {
    const res = await server!.get("/skill")
    const skills = res.body as SkillItem[]
    const prefixed = findByName(skills, "b-skill-plugin-shared-skill")
    expect(prefixed).toBeDefined()
    // Location should be in the cache (copy, not original)
    expect(prefixed?.location).toContain(server!.cacheDir!)
  })

  test("the prefixed copy has its SKILL.md name patched to the allocated name", async () => {
    const res = await server!.get("/skill")
    const skills = res.body as SkillItem[]
    const prefixed = findByName(skills, "b-skill-plugin-shared-skill")
    // The SKILL.md location is an absolute path into the cache; read and verify the patched name.
    const skillMdPath = prefixed!.location!
    const content = readFileSync(skillMdPath, "utf8")
    expect(extractSkillName(content)).toBe("b-skill-plugin-shared-skill")
  })

  test("assets are preserved in the cached copy", async () => {
    const res = await server!.get("/skill")
    const skills = res.body as SkillItem[]
    const prefixed = findByName(skills, "b-skill-plugin-shared-skill")
    expect(prefixed).toBeDefined()
    // The location is the SKILL.md path; parent dir has asset.txt
    const skillMdPath = prefixed!.location!.replace(/^file:\/\//, "")
    const assetPath = path.join(path.dirname(skillMdPath), "asset.txt")
    const content = readFileSync(assetPath, "utf8")
    expect(content).toBe("from plugin B")
  })

  test("injection summary shows rename count", () => {
    expect(server!.logHas("renamed 1 (collision)")).toBe(true)
  })
})

// ── Test suite: disabled plugin contributes no skills ─────────────────────────

describe("bridge e2e — disabled plugin contributes no skills", () => {
  let fixture: { dir: string; cleanup: () => void }
  let server: BridgeServer | undefined

  beforeAll(async () => {
    fixture = makePluginDir()
    writeSkillFixture(fixture.dir, "skills", "disabled-skill")

    server = await startBridge({
      isolateCache: true,
      isolateHome: true,
      claude: {
        plugins: [
          { id: "disabled@mkt", version: "1.0.0", scope: "user", enabled: false, installPath: fixture.dir },
        ],
      },
    })
    await server.triggerHook()
  }, TEST_TIMEOUT)

  afterAll(async () => {
    await server?.stop()
    fixture.cleanup()
  })

  test("disabled plugin's skill does not appear in GET /skill", async () => {
    const res = await server!.get("/skill")
    const skills = res.body as SkillItem[]
    const skill = findByName(skills, "disabled-skill")
    expect(skill).toBeUndefined()
  })

  test("injection summary shows 0 skills injected", () => {
    expect(server!.logHas("0 skill(s)")).toBe(true)
  })
})

// ── Test suite: native skill collision (bridge plugin skill vs HOME native skill) ─

describe("bridge e2e — native skill collision (bridge skill is prefixed, native is untouched)", () => {
  let fixture: { dir: string; cleanup: () => void }
  let server: BridgeServer | undefined

  beforeAll(async () => {
    fixture = makePluginDir()
    // Bridge plugin has a skill called "common-skill".
    writeSkillFixture(fixture.dir, "skills", "common-skill")

    server = await startBridge({
      isolateHome: true,
      isolateCache: true,
      // Plant a native skill with the same name into the isolated HOME before spawn.
      populateHome: async (homeDir) => {
        const nativeSkillDir = path.join(homeDir, ".claude", "skills", "common-skill")
        mkdirSync(nativeSkillDir, { recursive: true })
        writeFileSync(
          path.join(nativeSkillDir, "SKILL.md"),
          "---\nname: common-skill\ndescription: Native common skill.\n---\n\nNative skill body.\n",
        )
      },
      claude: { plugins: [userPlugin("bridge-plugin@mkt", fixture.dir)] },
    })
    await server.triggerHook()
  }, TEST_TIMEOUT)

  afterAll(async () => {
    await server?.stop()
    fixture.cleanup()
  })

  test("native 'common-skill' appears in GET /skill", async () => {
    const res = await server!.get("/skill")
    const skills = res.body as SkillItem[]
    const native = findByName(skills, "common-skill")
    expect(native).toBeDefined()
    // Native skill location should be in the isolated homeDir, not the plugin dir.
    expect(native?.location).not.toContain(fixture.dir)
  })

  test("bridge's 'common-skill' is prefixed (renamed) to avoid shadowing the native skill", async () => {
    const res = await server!.get("/skill")
    const skills = res.body as SkillItem[]
    // Bridge plugin "bridge-plugin@mkt" → plugin-part "bridge-plugin"
    // Prefixed name: "bridge-plugin-common-skill"
    const prefixed = findByName(skills, "bridge-plugin-common-skill")
    expect(prefixed).toBeDefined()
    // Location should be in the cache (copy, not original plugin dir).
    expect(prefixed?.location).toContain(server!.cacheDir!)
  })
})
