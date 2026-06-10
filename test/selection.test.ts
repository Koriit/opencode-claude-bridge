import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import {
  listClaudePlugins,
  listMarketplaces,
  mergeEnabledPlugins,
  readEnabledPlugins,
  resolveEnabledPlugins,
  resolvePluginPathFromMarketplace,
  samePath,
} from "../src/selection.js"
import { createLogger, type Logger } from "../src/logger.js"
import { DEFAULT_BRIDGE_CONFIG, type BridgeConfig, type ClaudePlugin } from "../src/types.js"

/** A logger that records warnings and infos instead of printing them. */
function recordingLogger(): { logger: Logger; warnings: string[]; infos: string[] } {
  const warnings: string[] = []
  const infos: string[] = []
  return {
    warnings,
    infos,
    logger: {
      info: (m) => infos.push(m),
      warn: (m) => warnings.push(m),
      hadWarnings: () => warnings.length > 0,
    },
  }
}

type ShellResult = { exitCode: number; stdout: string } | Error

/**
 * A fake `input.$` shell that routes by command substring. The bridge runs two
 * commands — `claude plugin marketplace list --json` and `claude plugin list --json`
 * — so the fake must answer each independently. `routes` is checked in order; the
 * first key found as a substring of the command wins.
 *
 * Mirrors the chainable `.quiet().nothrow()` then-awaitable contract.
 */
function routingShell(routes: Array<[match: string, result: ShellResult]>): PluginInput["$"] {
  const fn = (strings: TemplateStringsArray, ...subs: unknown[]) => {
    const command = strings.reduce((acc, s, i) => acc + s + (i < subs.length ? String(subs[i]) : ""), "")
    const route = routes.find(([m]) => command.includes(m))
    const result: ShellResult = route ? route[1] : { exitCode: 1, stdout: "" }
    const thenable: any = {
      quiet: () => thenable,
      nothrow: () => thenable,
      then: (onF: (v: unknown) => unknown, onR: (e: unknown) => unknown) =>
        result instanceof Error
          ? Promise.reject(result).then(onF, onR)
          : Promise.resolve({ exitCode: result.exitCode, stdout: Buffer.from(result.stdout) }).then(onF, onR),
    }
    return thenable
  }
  return fn as unknown as PluginInput["$"]
}

/** Single-command fake shell (for listClaudePlugins / listMarketplaces in isolation). */
function fakeShell(result: ShellResult): PluginInput["$"] {
  return routingShell([["", result]])
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

// ── samePath ──────────────────────────────────────────────────────────────────

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
})

// ── listClaudePlugins ───────────────────────────────────────────────────────────

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

  test("returns null when the CLI is missing (shell rejects)", async () => {
    const { logger } = recordingLogger()
    const result = await listClaudePlugins(fakeShell(new Error("command not found: claude")), logger)
    expect(result).toBeNull()
  })

  test("returns null on a non-zero exit", async () => {
    const { logger } = recordingLogger()
    const result = await listClaudePlugins(fakeShell({ exitCode: 1, stdout: "" }), logger)
    expect(result).toBeNull()
  })

  test("returns null on invalid JSON", async () => {
    const { logger } = recordingLogger()
    const result = await listClaudePlugins(fakeShell({ exitCode: 0, stdout: "not json" }), logger)
    expect(result).toBeNull()
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

  test("returns null when the output is not an array (object)", async () => {
    const { logger } = recordingLogger()
    const result = await listClaudePlugins(fakeShell({ exitCode: 0, stdout: '{"notArray": true}' }), logger)
    expect(result).toBeNull()
  })

  test("a missing CLI no longer hard-errors under a strict logger (non-fatal warning)", async () => {
    const strict = createLogger(
      { app: { log: async () => ({ data: true }) } } as unknown as PluginInput["client"],
      true,
    )
    // listClaudePlugins is now a supplementary source, so its failure is non-fatal
    // even in strict mode — it returns null instead of throwing.
    const result = await listClaudePlugins(fakeShell(new Error("command not found")), strict)
    expect(result).toBeNull()
  })
})

// ── listMarketplaces ─────────────────────────────────────────────────────────

describe("listMarketplaces", () => {
  test("parses a well-formed marketplace array into a name→installLocation map", async () => {
    const { logger } = recordingLogger()
    const json = JSON.stringify([
      { name: "kio-plugins", source: "directory", installLocation: "/m/kio" },
      { name: "official", source: "github", installLocation: "/m/official" },
    ])
    const result = await listMarketplaces(fakeShell({ exitCode: 0, stdout: json }), logger)
    expect(result.get("kio-plugins")).toBe("/m/kio")
    expect(result.get("official")).toBe("/m/official")
  })

  test("returns empty map (non-fatal warn) on non-zero exit", async () => {
    const { logger, warnings } = recordingLogger()
    const result = await listMarketplaces(fakeShell({ exitCode: 1, stdout: "" }), logger)
    expect(result.size).toBe(0)
    expect(warnings.length).toBeGreaterThan(0)
  })

  test("returns empty map on invalid JSON", async () => {
    const { logger } = recordingLogger()
    const result = await listMarketplaces(fakeShell({ exitCode: 0, stdout: "nope" }), logger)
    expect(result.size).toBe(0)
  })

  test("skips entries missing name or installLocation", async () => {
    const { logger } = recordingLogger()
    const json = JSON.stringify([
      { name: "ok", installLocation: "/m/ok" },
      { name: "noLoc" },
      { installLocation: "/m/noName" },
    ])
    const result = await listMarketplaces(fakeShell({ exitCode: 0, stdout: json }), logger)
    expect([...result.keys()]).toEqual(["ok"])
  })
})

// ── filesystem-backed suites ────────────────────────────────────────────────

function testBase(): string {
  const override = process.env["OCB_TMPDIR"] ?? process.env["TMPDIR"]
  if (override) {
    const abs = path.resolve(override)
    mkdirSync(abs, { recursive: true })
    return abs
  }
  return tmpdir()
}

describe("readEnabledPlugins", () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(path.join(testBase(), "read-ep-")) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  test("returns {} when the file is absent", async () => {
    expect(await readEnabledPlugins(path.join(tmp, "nope.json"))).toEqual({})
  })

  test("returns {} when the file is not JSON", async () => {
    const f = path.join(tmp, "settings.json")
    writeFileSync(f, "not json {{")
    expect(await readEnabledPlugins(f)).toEqual({})
  })

  test("returns {} when there is no enabledPlugins key", async () => {
    const f = path.join(tmp, "settings.json")
    writeFileSync(f, JSON.stringify({ model: "x" }))
    expect(await readEnabledPlugins(f)).toEqual({})
  })

  test("keeps only boolean entries", async () => {
    const f = path.join(tmp, "settings.json")
    writeFileSync(f, JSON.stringify({ enabledPlugins: { "a@m": true, "b@m": false, "c@m": "yes" } }))
    expect(await readEnabledPlugins(f)).toEqual({ "a@m": true, "b@m": false })
  })
})

describe("mergeEnabledPlugins", () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(path.join(testBase(), "merge-ep-")) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  function writeSettings(dir: string, file: string, enabledPlugins: Record<string, boolean>) {
    const d = path.join(dir, ".claude")
    mkdirSync(d, { recursive: true })
    writeFileSync(path.join(d, file), JSON.stringify({ enabledPlugins }))
  }

  test("merges global + project + local with later layers overriding earlier", async () => {
    const home = path.join(tmp, "home")
    const cwd = path.join(tmp, "proj")
    mkdirSync(home, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    // global enables a, b
    writeSettings(home, "settings.json", { "a@m": true, "b@m": true })
    // project disables b, enables c
    writeSettings(cwd, "settings.json", { "b@m": false, "c@m": true })
    // local enables d
    writeSettings(cwd, "settings.local.json", { "d@m": true })

    const merged = await mergeEnabledPlugins(home, cwd)
    expect(merged["a@m"]).toEqual({ enabled: true, scope: "user" })
    expect(merged["b@m"]).toEqual({ enabled: false, scope: "project" }) // overridden by project
    expect(merged["c@m"]).toEqual({ enabled: true, scope: "project" })
    expect(merged["d@m"]).toEqual({ enabled: true, scope: "project" })
  })

  test("global-only enablement is scope user", async () => {
    const home = path.join(tmp, "home")
    const cwd = path.join(tmp, "proj")
    mkdirSync(home, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    writeSettings(home, "settings.json", { "g@m": true })
    const merged = await mergeEnabledPlugins(home, cwd)
    expect(merged["g@m"]).toEqual({ enabled: true, scope: "user" })
  })
})

describe("resolvePluginPathFromMarketplace", () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(path.join(testBase(), "mf-")) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  function writeManifest(installLocation: string, plugins: unknown[]) {
    const d = path.join(installLocation, ".claude-plugin")
    mkdirSync(d, { recursive: true })
    writeFileSync(path.join(d, "marketplace.json"), JSON.stringify({ name: "m", plugins }))
  }

  test("resolves a relative string source to <installLocation>/<source>", async () => {
    const loc = path.join(tmp, "market")
    writeManifest(loc, [{ name: "kio-jvm", source: "./plugins/kio-jvm" }])
    const resolved = await resolvePluginPathFromMarketplace(loc, "kio-jvm")
    expect(resolved).toBe(path.join(loc, "plugins", "kio-jvm"))
  })

  test("returns undefined for a git-subdir/object source", async () => {
    const loc = path.join(tmp, "market")
    writeManifest(loc, [{ name: "ext", source: { source: "git-subdir", url: "https://x", path: "p" } }])
    expect(await resolvePluginPathFromMarketplace(loc, "ext")).toBeUndefined()
  })

  test("returns undefined when the plugin is not listed", async () => {
    const loc = path.join(tmp, "market")
    writeManifest(loc, [{ name: "other", source: "./plugins/other" }])
    expect(await resolvePluginPathFromMarketplace(loc, "missing")).toBeUndefined()
  })

  test("returns undefined when the manifest is absent", async () => {
    expect(await resolvePluginPathFromMarketplace(path.join(tmp, "nope"), "x")).toBeUndefined()
  })

  test("returns undefined when the manifest is not JSON", async () => {
    const loc = path.join(tmp, "market")
    const d = path.join(loc, ".claude-plugin")
    mkdirSync(d, { recursive: true })
    writeFileSync(path.join(d, "marketplace.json"), "broken {{")
    expect(await resolvePluginPathFromMarketplace(loc, "x")).toBeUndefined()
  })
})

describe("resolveEnabledPlugins", () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(path.join(testBase(), "resolve-")) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  /** Write a settings file with enabledPlugins under <dir>/.claude/<file>. */
  function writeSettings(dir: string, file: string, enabledPlugins: Record<string, boolean>) {
    const d = path.join(dir, ".claude")
    mkdirSync(d, { recursive: true })
    writeFileSync(path.join(d, file), JSON.stringify({ enabledPlugins }))
  }

  /** Create a marketplace installLocation with a manifest mapping name→relative source, plus the plugin dir on disk. */
  function makeMarketplace(name: string, plugins: Array<{ name: string; source: string }>): string {
    const loc = path.join(tmp, "markets", name)
    const manifestDir = path.join(loc, ".claude-plugin")
    mkdirSync(manifestDir, { recursive: true })
    writeFileSync(path.join(manifestDir, "marketplace.json"), JSON.stringify({ name, plugins }))
    // Materialize each plugin's source dir so fs.existsSync passes.
    for (const p of plugins) {
      mkdirSync(path.join(loc, p.source), { recursive: true })
    }
    return loc
  }

  function marketplaceListJson(entries: Array<{ name: string; installLocation: string }>): string {
    return JSON.stringify(entries.map((e) => ({ ...e, source: "directory" })))
  }

  test("resolves a plugin enabled via project settings.json (not in claude plugin list)", async () => {
    const home = path.join(tmp, "home")
    const cwd = path.join(tmp, "proj")
    mkdirSync(home, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    writeSettings(cwd, "settings.json", { "kio-jvm@kio-plugins": true })

    const loc = makeMarketplace("kio-plugins", [{ name: "kio-jvm", source: "./plugins/kio-jvm" }])
    const $ = routingShell([
      ["marketplace list", { exitCode: 0, stdout: marketplaceListJson([{ name: "kio-plugins", installLocation: loc }]) }],
      ["plugin list", { exitCode: 0, stdout: "[]" }], // CLI knows nothing about it
    ])

    const { logger } = recordingLogger()
    const result = await resolveEnabledPlugins($, cfg(), cwd, logger, home)
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe("kio-jvm@kio-plugins")
    expect(result[0]!.installPath).toBe(path.join(loc, "plugins", "kio-jvm"))
    expect(result[0]!.scope).toBe("project")
    expect(result[0]!.projectPath).toBe(cwd)
  })

  test("falls back to claude plugin list installPath when marketplace cannot resolve", async () => {
    const home = path.join(tmp, "home")
    const cwd = path.join(tmp, "proj")
    mkdirSync(home, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    writeSettings(cwd, "settings.json", { "ext@official": true })

    // CLI provides a resolved installPath; marketplace manifest has an object source (unresolvable).
    const cliInstall = path.join(tmp, "cli-cache", "ext")
    mkdirSync(cliInstall, { recursive: true })
    const loc = path.join(tmp, "markets", "official")
    const md = path.join(loc, ".claude-plugin")
    mkdirSync(md, { recursive: true })
    writeFileSync(path.join(md, "marketplace.json"), JSON.stringify({
      name: "official",
      plugins: [{ name: "ext", source: { source: "git-subdir", url: "https://x", path: "p" } }],
    }))

    const $ = routingShell([
      ["marketplace list", { exitCode: 0, stdout: marketplaceListJson([{ name: "official", installLocation: loc }]) }],
      ["plugin list", { exitCode: 0, stdout: JSON.stringify([
        { id: "ext@official", version: "2.0.0", scope: "user", enabled: true, installPath: cliInstall },
      ]) }],
    ])

    const { logger } = recordingLogger()
    const result = await resolveEnabledPlugins($, cfg(), cwd, logger, home)
    expect(result).toHaveLength(1)
    expect(result[0]!.installPath).toBe(cliInstall)
    expect(result[0]!.version).toBe("2.0.0")
  })

  test("excludes blocked plugins", async () => {
    const home = path.join(tmp, "home")
    const cwd = path.join(tmp, "proj")
    mkdirSync(home, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    writeSettings(cwd, "settings.json", { "kio-jvm@kio-plugins": true })
    const loc = makeMarketplace("kio-plugins", [{ name: "kio-jvm", source: "./plugins/kio-jvm" }])
    const $ = routingShell([
      ["marketplace list", { exitCode: 0, stdout: marketplaceListJson([{ name: "kio-plugins", installLocation: loc }]) }],
      ["plugin list", { exitCode: 0, stdout: "[]" }],
    ])
    const { logger } = recordingLogger()
    const result = await resolveEnabledPlugins($, cfg({ blockedPlugins: ["kio-jvm@kio-plugins"] }), cwd, logger, home)
    expect(result).toHaveLength(0)
  })

  test("excludes plugins disabled by a later settings layer", async () => {
    const home = path.join(tmp, "home")
    const cwd = path.join(tmp, "proj")
    mkdirSync(home, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    writeSettings(home, "settings.json", { "kio-jvm@kio-plugins": true })
    writeSettings(cwd, "settings.local.json", { "kio-jvm@kio-plugins": false })
    const loc = makeMarketplace("kio-plugins", [{ name: "kio-jvm", source: "./plugins/kio-jvm" }])
    const $ = routingShell([
      ["marketplace list", { exitCode: 0, stdout: marketplaceListJson([{ name: "kio-plugins", installLocation: loc }]) }],
      ["plugin list", { exitCode: 0, stdout: "[]" }],
    ])
    const { logger } = recordingLogger()
    const result = await resolveEnabledPlugins($, cfg(), cwd, logger, home)
    expect(result).toHaveLength(0)
  })

  test("skips a malformed id with no @marketplace suffix", async () => {
    const home = path.join(tmp, "home")
    const cwd = path.join(tmp, "proj")
    mkdirSync(home, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    writeSettings(cwd, "settings.json", { "noscope": true })
    const $ = routingShell([
      ["marketplace list", { exitCode: 0, stdout: "[]" }],
      ["plugin list", { exitCode: 0, stdout: "[]" }],
    ])
    const { logger, infos } = recordingLogger()
    const result = await resolveEnabledPlugins($, cfg(), cwd, logger, home)
    expect(result).toHaveLength(0)
    expect(infos.some((m) => m.includes("malformed"))).toBe(true)
  })

  test("skips when neither marketplace nor CLI can resolve installPath", async () => {
    const home = path.join(tmp, "home")
    const cwd = path.join(tmp, "proj")
    mkdirSync(home, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    writeSettings(cwd, "settings.json", { "ghost@nowhere": true })
    const $ = routingShell([
      ["marketplace list", { exitCode: 0, stdout: "[]" }],
      ["plugin list", { exitCode: 0, stdout: "[]" }],
    ])
    const { logger, infos } = recordingLogger()
    const result = await resolveEnabledPlugins($, cfg(), cwd, logger, home)
    expect(result).toHaveLength(0)
    expect(infos.some((m) => m.includes("could not resolve"))).toBe(true)
  })

  test("works when claude plugin list is entirely unavailable (CLI missing)", async () => {
    const home = path.join(tmp, "home")
    const cwd = path.join(tmp, "proj")
    mkdirSync(home, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    writeSettings(cwd, "settings.json", { "kio-jvm@kio-plugins": true })
    const loc = makeMarketplace("kio-plugins", [{ name: "kio-jvm", source: "./plugins/kio-jvm" }])
    // plugin list errors; marketplace list still works.
    const $ = routingShell([
      ["marketplace list", { exitCode: 0, stdout: marketplaceListJson([{ name: "kio-plugins", installLocation: loc }]) }],
      ["plugin list", new Error("command not found")],
    ])
    const { logger } = recordingLogger()
    const result = await resolveEnabledPlugins($, cfg(), cwd, logger, home)
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe("kio-jvm@kio-plugins")
  })

  test("de-duplicates by id and sorts ascending", async () => {
    const home = path.join(tmp, "home")
    const cwd = path.join(tmp, "proj")
    mkdirSync(home, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    writeSettings(cwd, "settings.json", { "c@kio-plugins": true, "a@kio-plugins": true, "b@kio-plugins": true })
    const loc = makeMarketplace("kio-plugins", [
      { name: "a", source: "./plugins/a" },
      { name: "b", source: "./plugins/b" },
      { name: "c", source: "./plugins/c" },
    ])
    const $ = routingShell([
      ["marketplace list", { exitCode: 0, stdout: marketplaceListJson([{ name: "kio-plugins", installLocation: loc }]) }],
      ["plugin list", { exitCode: 0, stdout: "[]" }],
    ])
    const { logger } = recordingLogger()
    const result = await resolveEnabledPlugins($, cfg(), cwd, logger, home)
    expect(result.map((p) => p.id)).toEqual(["a@kio-plugins", "b@kio-plugins", "c@kio-plugins"])
  })

  test("global-scope enablement yields scope user and null projectPath", async () => {
    const home = path.join(tmp, "home")
    const cwd = path.join(tmp, "proj")
    mkdirSync(home, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    writeSettings(home, "settings.json", { "kio-jvm@kio-plugins": true })
    const loc = makeMarketplace("kio-plugins", [{ name: "kio-jvm", source: "./plugins/kio-jvm" }])
    const $ = routingShell([
      ["marketplace list", { exitCode: 0, stdout: marketplaceListJson([{ name: "kio-plugins", installLocation: loc }]) }],
      ["plugin list", { exitCode: 0, stdout: "[]" }],
    ])
    const { logger } = recordingLogger()
    const result = await resolveEnabledPlugins($, cfg(), cwd, logger, home)
    expect(result).toHaveLength(1)
    expect(result[0]!.scope).toBe("user")
    expect(result[0]!.projectPath).toBeNull()
  })
})
