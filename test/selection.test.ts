import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { listClaudePlugins, samePath, selectEnabledPlugins, supplementFromSettings } from "../src/selection.js"
import { createLogger, type Logger } from "../src/logger.js"
import { DEFAULT_BRIDGE_CONFIG, type BridgeConfig, type ClaudePlugin } from "../src/types.js"

/** A logger that records warnings instead of printing them. */
function recordingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = []
  return {
    warnings,
    logger: { info: () => {}, warn: (m) => warnings.push(m), hadWarnings: () => warnings.length > 0 },
  }
}

/**
 * A fake `input.$` shell: ignores the command and resolves to a fixed result (or rejects,
 * to simulate a missing `claude` binary). Mirrors the chainable `.quiet().nothrow()` then
 * awaitable contract the real BunShell exposes.
 */
function fakeShell(result: { exitCode: number; stdout: string } | Error): PluginInput["$"] {
  const build = () => {
    const thenable: any = {
      quiet: () => thenable,
      nothrow: () => thenable,
      then: (onF: (v: unknown) => unknown, onR: (e: unknown) => unknown) =>
        result instanceof Error
          ? Promise.reject(result).then(onF, onR)
          : Promise.resolve({
              exitCode: result.exitCode,
              stdout: Buffer.from(result.stdout),
            }).then(onF, onR),
    }
    return thenable
  }
  return (() => build()) as unknown as PluginInput["$"]
}

const cfg = (overrides: Partial<BridgeConfig> = {}): BridgeConfig => ({
  ...DEFAULT_BRIDGE_CONFIG,
  ...overrides,
})

function plugin(over: Partial<ClaudePlugin> & Pick<ClaudePlugin, "id">): ClaudePlugin {
  return {
    version: "1.0.0",
    scope: "user",
    enabled: true,
    installPath: `/cache/${over.id}`,
    ...over,
  }
}

describe("samePath", () => {
  test("matches after normalization", () => {
    expect(samePath("/home/olek/proj", "/home/olek/proj")).toBe(true)
    expect(samePath("/home/olek/proj/", "/home/olek/proj")).toBe(true)
    expect(samePath("/home/olek/proj/../proj", "/home/olek/proj")).toBe(true)
  })
  test("rejects different paths and nullish input", () => {
    expect(samePath("/a", "/b")).toBe(false)
    expect(samePath(null, "/b")).toBe(false)
    expect(samePath(undefined, "/b")).toBe(false)
  })
  test("returns false for a path that does not exist (graceful fallback)", () => {
    expect(samePath("/nonexistent-abc-xyz/foo", "/nonexistent-abc-xyz/bar")).toBe(false)
  })

  if (process.platform !== "win32") {
    test("matches a symlinked path to its realpath target", () => {
      const { mkdtempSync: mktmp, mkdirSync: mkdir, symlinkSync: sym, rmSync: rm } = require("node:fs")
      const base = require("node:os").tmpdir()
      const real = mktmp(require("node:path").join(base, "samepath-real-"))
      const link = mktmp(require("node:path").join(base, "samepath-link-"))
      rm(link, { recursive: true, force: true })
      sym(real, link)
      try {
        // real and link point to the same directory — samePath must return true.
        expect(samePath(real, link)).toBe(true)
        expect(samePath(link, real)).toBe(true)
      } finally {
        try { rm(link, { recursive: true, force: true }) } catch {}
        try { rm(real, { recursive: true, force: true }) } catch {}
      }
    })
  }
})

describe("selectEnabledPlugins", () => {
  const cwd = "/home/olek/proj"

  test("keeps enabled user-scoped plugins regardless of project", () => {
    const selected = selectEnabledPlugins([plugin({ id: "a@m", scope: "user" })], cfg(), cwd)
    expect(selected.map((p) => p.id)).toEqual(["a@m"])
  })

  test("drops disabled plugins", () => {
    const selected = selectEnabledPlugins([plugin({ id: "a@m", enabled: false })], cfg(), cwd)
    expect(selected).toEqual([])
  })

  test("drops blocked plugins", () => {
    const selected = selectEnabledPlugins(
      [plugin({ id: "a@m" }), plugin({ id: "b@m" })],
      cfg({ blockedPlugins: ["a@m"] }),
      cwd,
    )
    expect(selected.map((p) => p.id)).toEqual(["b@m"])
  })

  test("project-scoped plugin is kept only when its projectPath matches cwd", () => {
    const inProject = plugin({ id: "p@m", scope: "project", projectPath: cwd })
    const elsewhere = plugin({ id: "q@m", scope: "project", projectPath: "/other" })
    const selected = selectEnabledPlugins([inProject, elsewhere], cfg(), cwd)
    expect(selected.map((p) => p.id)).toEqual(["p@m"])
  })

  test("de-duplicates by id, keeping the first occurrence", () => {
    const first = plugin({ id: "a@m", version: "1.0.0" })
    const dup = plugin({ id: "a@m", version: "2.0.0" })
    const selected = selectEnabledPlugins([first, dup], cfg(), cwd)
    expect(selected).toHaveLength(1)
    expect(selected[0]!.version).toBe("1.0.0")
  })

  test("sorts the result by id ascending (deterministic ordering)", () => {
    const selected = selectEnabledPlugins(
      [plugin({ id: "c@m" }), plugin({ id: "a@m" }), plugin({ id: "b@m" })],
      cfg(),
      cwd,
    )
    expect(selected.map((p) => p.id)).toEqual(["a@m", "b@m", "c@m"])
  })
})

describe("listClaudePlugins", () => {
  test("parses a well-formed JSON array", async () => {
    const { logger, warnings } = recordingLogger()
    const json = JSON.stringify([
      { id: "a@m", version: "1", scope: "user", enabled: true, installPath: "/x" },
    ])
    const result = await listClaudePlugins(fakeShell({ exitCode: 0, stdout: json }), logger)
    expect(result).toHaveLength(1)
    expect(result![0]!.id).toBe("a@m")
    expect(warnings).toEqual([])
  })

  test("returns null and warns when the CLI is missing (shell rejects)", async () => {
    const { logger, warnings } = recordingLogger()
    const result = await listClaudePlugins(fakeShell(new Error("command not found: claude")), logger)
    expect(result).toBeNull()
    expect(warnings.some((w) => w.includes("claude"))).toBe(true)
  })

  test("returns null and warns on a non-zero exit", async () => {
    const { logger, warnings } = recordingLogger()
    const result = await listClaudePlugins(fakeShell({ exitCode: 1, stdout: "" }), logger)
    expect(result).toBeNull()
    expect(warnings.some((w) => w.includes("exited 1"))).toBe(true)
  })

  test("returns null and warns on invalid JSON", async () => {
    const { logger, warnings } = recordingLogger()
    const result = await listClaudePlugins(fakeShell({ exitCode: 0, stdout: "not json" }), logger)
    expect(result).toBeNull()
    expect(warnings.some((w) => w.includes("parse"))).toBe(true)
  })

  test("skips malformed entries but keeps valid ones", async () => {
    const { logger, warnings } = recordingLogger()
    const json = JSON.stringify([
      { id: "good@m", version: "1", scope: "user", enabled: true, installPath: "/x" },
      { id: "missing-fields" },
    ])
    const result = await listClaudePlugins(fakeShell({ exitCode: 0, stdout: json }), logger)
    expect(result!.map((p) => p.id)).toEqual(["good@m"])
    expect(warnings.some((w) => w.includes("malformed"))).toBe(true)
  })

  test("skips an entry with missing version field and emits a malformed warning", async () => {
    const { logger, warnings } = recordingLogger()
    const json = JSON.stringify([
      // No version field — otherwise valid
      { id: "nover@m", scope: "user", enabled: true, installPath: "/x" },
    ])
    const result = await listClaudePlugins(fakeShell({ exitCode: 0, stdout: json }), logger)
    expect(result).toEqual([])
    expect(warnings.some((w) => w.includes("malformed"))).toBe(true)
  })

  test("skips an entry with a non-string version and emits a malformed warning", async () => {
    const { logger, warnings } = recordingLogger()
    const json = JSON.stringify([
      { id: "badver@m", version: 42, scope: "user", enabled: true, installPath: "/x" },
    ])
    const result = await listClaudePlugins(fakeShell({ exitCode: 0, stdout: json }), logger)
    expect(result).toEqual([])
    expect(warnings.some((w) => w.includes("malformed"))).toBe(true)
  })

  test("returns null and warns when the output is not an array (object)", async () => {
    const { logger, warnings } = recordingLogger()
    const result = await listClaudePlugins(
      fakeShell({ exitCode: 0, stdout: '{"notArray": true}' }),
      logger,
    )
    expect(result).toBeNull()
    expect(warnings.some((w) => w.includes("not an array"))).toBe(true)
  })

  test("a missing CLI becomes a hard error under a strict logger", async () => {
    const strict = createLogger(
      { app: { log: async () => ({ data: true }) } } as unknown as PluginInput["client"],
      true,
    )
    await expect(
      listClaudePlugins(fakeShell(new Error("command not found")), strict),
    ).rejects.toThrow()
  })
})

// ── supplementFromSettings ───────────────────────────────────────────────────

function testBase(): string {
  const override = process.env["OCB_TMPDIR"] ?? process.env["TMPDIR"]
  if (override) {
    const abs = path.resolve(override)
    mkdirSync(abs, { recursive: true })
    return abs
  }
  return tmpdir()
}

function makeInfoLogger(): Logger & { infos: string[]; warnings: string[] } {
  const infos: string[] = []
  const warnings: string[] = []
  return {
    infos,
    warnings,
    info(msg: string) { infos.push(msg) },
    warn(msg: string) { warnings.push(msg) },
    hadWarnings() { return warnings.length > 0 },
  }
}

describe("supplementFromSettings", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(path.join(testBase(), "supplement-"))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  /** Write a settings.json with the given enabledPlugins map. */
  function writeSettings(dir: string, enabledPlugins: Record<string, boolean>) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ enabledPlugins }))
  }

  /** Create a fake plugin cache dir and return its path. */
  function makePluginCache(
    base: string,
    marketplace: string,
    pluginName: string,
    version: string,
  ): string {
    const pluginDir = path.join(base, ".claude", "plugins", "cache", marketplace, pluginName, version)
    mkdirSync(pluginDir, { recursive: true })
    return pluginDir
  }

  /** Write known_marketplaces.json with a single marketplace entry. */
  function writeMarketplace(
    base: string,
    name: string,
    installLocation: string,
  ) {
    const dir = path.join(base, ".claude", "plugins")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, "known_marketplaces.json"),
      JSON.stringify({ [name]: { installLocation, lastUpdated: "2026-01-01T00:00:00.000Z" } }),
    )
  }

  /** Write installed_plugins.json with a single plugin entry. */
  function writeInstalledPlugins(
    base: string,
    pluginId: string,
    entries: Array<{ scope: string; projectPath: string; installPath: string; version: string; lastUpdated: string }>,
  ) {
    const dir = path.join(base, ".claude", "plugins")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { [pluginId]: entries } }),
    )
  }

  test("returns cliPlugins unchanged when no settings.json files exist", async () => {
    const logger = makeInfoLogger()
    const cliPlugin = plugin({ id: "a@m", scope: "user" })
    const result = await supplementFromSettings([cliPlugin], tmp, logger, tmp)
    expect(result).toEqual([cliPlugin])
    expect(logger.warnings).toEqual([])
  })

  test("does not add plugins already present in cliPlugins", async () => {
    const claudeDir = path.join(tmp, ".claude")
    writeSettings(claudeDir, { "a@m": true })
    const cliPlugin = plugin({ id: "a@m", scope: "user" })
    const logger = makeInfoLogger()
    const result = await supplementFromSettings([cliPlugin], tmp, logger, tmp)
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe("a@m")
  })

  test("skips plugins with enabledPlugins: false", async () => {
    const claudeDir = path.join(tmp, ".claude")
    writeSettings(claudeDir, { "a@m": false })
    makePluginCache(tmp, "m", "a", "1.0.0")
    const logger = makeInfoLogger()
    const result = await supplementFromSettings([], tmp, logger, tmp)
    expect(result).toHaveLength(0)
  })

  test("skips malformed plugin id with no @ suffix", async () => {
    const claudeDir = path.join(tmp, ".claude")
    writeSettings(claudeDir, { "noscope": true })
    const logger = makeInfoLogger()
    const result = await supplementFromSettings([], tmp, logger, tmp)
    expect(result).toHaveLength(0)
    expect(logger.infos.some((m) => m.includes("malformed"))).toBe(true)
  })

  test("resolves installPath from cache dir (latest version, lexical sort)", async () => {
    const claudeDir = path.join(tmp, ".claude")
    writeSettings(claudeDir, { "myplugin@mymarket": true })
    makePluginCache(tmp, "mymarket", "myplugin", "1.0.0")
    const latestDir = makePluginCache(tmp, "mymarket", "myplugin", "2.0.0")
    const logger = makeInfoLogger()
    const result = await supplementFromSettings([], tmp, logger, tmp)
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe("myplugin@mymarket")
    expect(result[0]!.installPath).toBe(latestDir)
    expect(result[0]!.enabled).toBe(true)
    expect(result[0]!.scope).toBe("project")
  })

  test("prefers installPath from installed_plugins.json over lexical sort", async () => {
    const claudeDir = path.join(tmp, ".claude")
    writeSettings(claudeDir, { "myplugin@mymarket": true })
    makePluginCache(tmp, "mymarket", "myplugin", "1.0.0")
    const expectedDir = makePluginCache(tmp, "mymarket", "myplugin", "1.5.0")
    writeInstalledPlugins(tmp, "myplugin@mymarket", [
      { scope: "project", projectPath: tmp, installPath: expectedDir, version: "1.5.0", lastUpdated: "2026-06-01T00:00:00.000Z" },
    ])
    const logger = makeInfoLogger()
    const result = await supplementFromSettings([], tmp, logger, tmp)
    expect(result).toHaveLength(1)
    expect(result[0]!.installPath).toBe(expectedDir)
    expect(result[0]!.version).toBe("1.5.0")
  })

  test("falls back to marketplace installLocation plugins/ subdir when no cache", async () => {
    const claudeDir = path.join(tmp, ".claude")
    writeSettings(claudeDir, { "myplugin@mymarket": true })
    // Create marketplace installLocation with plugins/<name> structure (no cache)
    const installLocation = path.join(tmp, "marketplace-source")
    const pluginPath = path.join(installLocation, "plugins", "myplugin")
    mkdirSync(pluginPath, { recursive: true })
    writeMarketplace(tmp, "mymarket", installLocation)
    const logger = makeInfoLogger()
    const result = await supplementFromSettings([], tmp, logger, tmp)
    expect(result).toHaveLength(1)
    expect(result[0]!.installPath).toBe(pluginPath)
    expect(result[0]!.version).toBe("unknown")
  })

  test("logs info and skips when neither cache nor marketplace installLocation resolves", async () => {
    const claudeDir = path.join(tmp, ".claude")
    writeSettings(claudeDir, { "missing@nowhere": true })
    const logger = makeInfoLogger()
    const result = await supplementFromSettings([], tmp, logger, tmp)
    expect(result).toHaveLength(0)
    expect(logger.infos.some((m) => m.includes("could not resolve"))).toBe(true)
  })

  test("global settings.json (scope=user) sets scope to user on synthesized entry", async () => {
    // home/.claude/settings.json → scope=user; use a different cwd so only the global entry fires.
    const homeDir = tmp
    const claudeDir = path.join(homeDir, ".claude")
    writeSettings(claudeDir, { "myplugin@mymarket": true })
    makePluginCache(homeDir, "mymarket", "myplugin", "1.0.0")
    const differentCwd = path.join(tmp, "other-project")
    mkdirSync(differentCwd, { recursive: true })
    const logger = makeInfoLogger()
    const result = await supplementFromSettings([], differentCwd, logger, homeDir)
    expect(result).toHaveLength(1)
    expect(result[0]!.scope).toBe("user")
    expect(result[0]!.projectPath).toBeNull()
  })

  test("project settings.json sets scope to project with projectPath=cwd", async () => {
    // cwd/.claude/settings.json → scope=project; use a different home so only the project entry fires.
    const homeDir = path.join(tmp, "unrelated-home")
    mkdirSync(homeDir, { recursive: true })
    const claudeDir = path.join(tmp, ".claude")
    writeSettings(claudeDir, { "myplugin@mymarket": true })
    // Cache must be under homeDir since resolveLatestCachedInstallPath uses home.
    makePluginCache(homeDir, "mymarket", "myplugin", "1.0.0")
    const logger = makeInfoLogger()
    const result = await supplementFromSettings([], tmp, logger, homeDir)
    expect(result).toHaveLength(1)
    expect(result[0]!.scope).toBe("project")
    expect(result[0]!.projectPath).toBe(tmp)
  })

  test("gracefully handles malformed settings.json (not JSON)", async () => {
    const claudeDir = path.join(tmp, ".claude")
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(path.join(claudeDir, "settings.json"), "not json {{{")
    const logger = makeInfoLogger()
    const result = await supplementFromSettings([], tmp, logger, tmp)
    expect(result).toHaveLength(0)
    expect(logger.warnings).toHaveLength(0)
  })

  test("appends supplemented plugins after cliPlugins", async () => {
    const claudeDir = path.join(tmp, ".claude")
    writeSettings(claudeDir, { "extra@m": true })
    makePluginCache(tmp, "m", "extra", "1.0.0")
    const existing = plugin({ id: "existing@m", scope: "user" })
    const logger = makeInfoLogger()
    const result = await supplementFromSettings([existing], tmp, logger, tmp)
    expect(result).toHaveLength(2)
    expect(result[0]!.id).toBe("existing@m")
    expect(result[1]!.id).toBe("extra@m")
  })
})
