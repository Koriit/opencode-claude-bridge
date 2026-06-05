import { describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { listClaudePlugins, samePath, selectEnabledPlugins } from "../src/selection.js"
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

  test("a missing CLI becomes a hard error under a strict logger", async () => {
    const strict = createLogger(true)
    await expect(
      listClaudePlugins(fakeShell(new Error("command not found")), strict),
    ).rejects.toThrow()
  })
})
