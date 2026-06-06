import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  injectLsp,
  mapClaudeLspServer,
  type LspEntry,
  type MapLspResult,
} from "../src/lsp-inject.js"
import type { Logger } from "../src/logger.js"
import type { ClaudePlugin } from "../src/types.js"
import type { Config } from "@opencode-ai/plugin"

// ── Helpers ────────────────────────────────────────────────────────────────────

function testBase(): string {
  const override = process.env["OCB_TMPDIR"] ?? process.env["TMPDIR"]
  if (override) {
    const abs = path.resolve(override)
    mkdirSync(abs, { recursive: true })
    return abs
  }
  return require("node:os").tmpdir()
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

function asConfig(c: Record<string, unknown>): Config {
  return c as unknown as Config
}

function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(testBase(), "ocb-lsp-test-"))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function writeLspJson(dir: string, content: object): void {
  writeFileSync(path.join(dir, ".lsp.json"), JSON.stringify(content))
}

// ── mapClaudeLspServer ────────────────────────────────────────────────────────

/** Narrow to a successful MapLspResult, failing if not ok. */
function okLsp(r: MapLspResult): LspEntry {
  if (!r.ok) throw new Error(`expected ok MapLspResult, got reason="${r.reason}"`)
  return r.entry
}

describe("mapClaudeLspServer — basic mapping", () => {
  test("command string + args array merged into command array", () => {
    const result = mapClaudeLspServer(
      { command: "rust-analyzer", args: [], extensionToLanguage: { ".rs": "rust" } },
      "/plugin",
      "/tmp",
    )
    expect(result.ok).toBe(true)
    expect(okLsp(result).command).toEqual(["rust-analyzer"])
  })

  test("command + args with multiple items merged correctly", () => {
    const result = mapClaudeLspServer(
      { command: "typescript-language-server", args: ["--stdio"], extensionToLanguage: { ".ts": "typescript" } },
      "/plugin",
      "/tmp",
    )
    expect(okLsp(result).command).toEqual(["typescript-language-server", "--stdio"])
  })

  test("extensionToLanguage keys become extensions array", () => {
    const result = mapClaudeLspServer(
      {
        command: "pyright-langserver",
        args: ["--stdio"],
        extensionToLanguage: { ".py": "python", ".pyi": "python" },
      },
      "/plugin",
      "/tmp",
    )
    expect(okLsp(result).extensions).toEqual([".py", ".pyi"])
  })

  test("no extensionToLanguage returns no-extensions reason", () => {
    const result = mapClaudeLspServer({ command: "ls", args: [] }, "/plugin", "/tmp")
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe("no-extensions")
  })

  test("empty extensionToLanguage returns no-extensions reason", () => {
    const result = mapClaudeLspServer({ command: "ls", extensionToLanguage: {} }, "/plugin", "/tmp")
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe("no-extensions")
  })

  test("socket transport returns socket-transport reason", () => {
    const result = mapClaudeLspServer(
      { command: "ls", extensionToLanguage: { ".x": "x" }, transport: "socket" },
      "/plugin",
      "/tmp",
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe("socket-transport")
  })

  test("env is mapped and ${CLAUDE_PLUGIN_ROOT} resolved", () => {
    const result = mapClaudeLspServer(
      {
        command: "server",
        extensionToLanguage: { ".x": "x" },
        env: { ROOT: "${CLAUDE_PLUGIN_ROOT}/scripts", KEY: "val" },
      },
      "/myroot",
      "/tmp",
    )
    expect(okLsp(result).env).toEqual({ ROOT: "/myroot/scripts", KEY: "val" })
  })

  test("initializationOptions mapped to initialization", () => {
    const result = mapClaudeLspServer(
      { command: "server", extensionToLanguage: { ".x": "x" }, initializationOptions: { setting: true } },
      "/plugin",
      "/tmp",
    )
    expect(okLsp(result).initialization).toEqual({ setting: true })
  })

  test("settings mapped to initialization when initializationOptions absent", () => {
    const result = mapClaudeLspServer(
      { command: "server", extensionToLanguage: { ".x": "x" }, settings: { key: "value" } },
      "/plugin",
      "/tmp",
    )
    expect(okLsp(result).initialization).toEqual({ key: "value" })
  })

  test("initializationOptions takes precedence over settings", () => {
    const result = mapClaudeLspServer(
      { command: "server", extensionToLanguage: { ".x": "x" }, initializationOptions: { from: "init" }, settings: { from: "settings" } },
      "/plugin",
      "/tmp",
    )
    expect(okLsp(result).initialization).toEqual({ from: "init" })
  })

  test("resolves ${CLAUDE_PLUGIN_ROOT} in command and args", () => {
    const result = mapClaudeLspServer(
      { command: "${CLAUDE_PLUGIN_ROOT}/bin/lsp", args: ["${CLAUDE_PLUGIN_ROOT}/config.json"], extensionToLanguage: { ".x": "x" } },
      "/abs/path",
      "/tmp",
    )
    expect(okLsp(result).command).toEqual(["/abs/path/bin/lsp", "/abs/path/config.json"])
  })

  test("missing command returns missing-command reason", () => {
    const result = mapClaudeLspServer({ args: ["--stdio"] }, "/plugin", "/tmp")
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe("missing-command")
  })

  test("non-string command returns missing-command reason", () => {
    const result = mapClaudeLspServer({ command: 42 as unknown as string }, "/plugin", "/tmp")
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe("missing-command")
  })
})

// ── injectLsp — cfg.lsp === false guard ────────────────────────────────────────

describe("injectLsp — cfg.lsp === false (user disabled)", () => {
  let tmp: { dir: string; cleanup: () => void }

  beforeEach(() => { tmp = makeTempDir() })
  afterEach(() => { tmp.cleanup() })

  test("cfg.lsp === false: LSP not injected, cfg.lsp remains false", async () => {
    writeLspJson(tmp.dir, { "rust-analyzer": { command: "rust-analyzer", extensionToLanguage: { ".rs": "rust" } } })
    const cfg = asConfig({ lsp: false })
    const logger = makeLogger()
    const summary = await injectLsp([fakePlugin("rust@official", tmp.dir)], cfg, true, logger)
    expect(summary.skippedUserDisabled).toBe(true)
    expect(summary.servers).toBe(0)
    // cfg.lsp must still be false — we did not modify it
    expect((cfg as unknown as { lsp: unknown }).lsp).toBe(false)
  })

  test("cfg.lsp === false still injects nothing even when allowLsp is true", async () => {
    writeLspJson(tmp.dir, { server: { command: "ls", extensionToLanguage: { ".x": "x" } } })
    const cfg = asConfig({ lsp: false })
    const logger = makeLogger()
    await injectLsp([fakePlugin("p@mkt", tmp.dir)], cfg, true, logger)
    expect((cfg as unknown as { lsp: unknown }).lsp).toBe(false)
  })

  test("cfg.lsp === false: user-disabled log is emitted", async () => {
    const cfg = asConfig({ lsp: false })
    const logger = makeLogger()
    await injectLsp([], cfg, true, logger)
    expect(logger.infos.some((m) => m.includes("cfg.lsp is false"))).toBe(true)
  })
})

// ── injectLsp — cfg.lsp normalization ─────────────────────────────────────────

describe("injectLsp — cfg.lsp normalization", () => {
  let tmp: { dir: string; cleanup: () => void }

  beforeEach(() => { tmp = makeTempDir() })
  afterEach(() => { tmp.cleanup() })

  test("cfg.lsp === undefined is normalized to {}", async () => {
    writeLspJson(tmp.dir, { "my-lsp": { command: "ls", extensionToLanguage: { ".x": "x" } } })
    const cfg = asConfig({}) // no lsp key
    const logger = makeLogger()
    await injectLsp([fakePlugin("p@mkt", tmp.dir)], cfg, true, logger)
    expect(typeof (cfg as unknown as { lsp: unknown }).lsp).toBe("object")
  })

  test("cfg.lsp === true is normalized to {} before adding entries", async () => {
    writeLspJson(tmp.dir, { "my-lsp": { command: "ls", extensionToLanguage: { ".x": "x" } } })
    const cfg = asConfig({ lsp: true })
    const logger = makeLogger()
    await injectLsp([fakePlugin("p@mkt", tmp.dir)], cfg, true, logger)
    const lsp = (cfg as unknown as { lsp: unknown }).lsp
    expect(typeof lsp).toBe("object")
    expect(lsp).not.toBe(true)
  })
})

// ── injectLsp — allowLsp:false (policy gate) ──────────────────────────────────

describe("injectLsp — allowLsp:false (policy gate)", () => {
  let tmp: { dir: string; cleanup: () => void }

  beforeEach(() => { tmp = makeTempDir() })
  afterEach(() => { tmp.cleanup() })

  test("injects nothing when allowLsp is false", async () => {
    writeLspJson(tmp.dir, { "rust-analyzer": { command: "rust-analyzer", extensionToLanguage: { ".rs": "rust" } } })
    const cfg = asConfig({})
    const logger = makeLogger()
    const summary = await injectLsp([fakePlugin("rust@official", tmp.dir)], cfg, false, logger)
    expect(summary.servers).toBe(0)
    expect((cfg as unknown as { lsp?: unknown }).lsp).toBeUndefined()
  })

  test("logs policy summary when allowLsp is false and servers exist", async () => {
    writeLspJson(tmp.dir, {
      "s1": { command: "ls", extensionToLanguage: { ".a": "a" } },
      "s2": { command: "cat", extensionToLanguage: { ".b": "b" } },
    })
    const logger = makeLogger()
    const summary = await injectLsp([fakePlugin("p@mkt", tmp.dir)], asConfig({}), false, logger)
    expect(summary.skippedPolicy).toBe(2)
    expect(logger.infos.some((m) => m.includes("policy"))).toBe(true)
  })

  test("no policy log when there are no LSP servers", async () => {
    const logger = makeLogger()
    const summary = await injectLsp([fakePlugin("p@mkt", tmp.dir)], asConfig({}), false, logger)
    expect(summary.skippedPolicy).toBe(0)
    expect(logger.infos.length).toBe(0)
  })
})

// ── injectLsp — allowLsp:true (injection) ─────────────────────────────────────

describe("injectLsp — allowLsp:true (injection)", () => {
  let tmp: { dir: string; cleanup: () => void }

  beforeEach(() => { tmp = makeTempDir() })
  afterEach(() => { tmp.cleanup() })

  test("injects a server from .lsp.json", async () => {
    writeLspJson(tmp.dir, {
      "rust-analyzer": {
        command: "rust-analyzer",
        extensionToLanguage: { ".rs": "rust" },
      },
    })
    const cfg = asConfig({}) as unknown as { lsp?: Record<string, LspEntry> }
    const logger = makeLogger()
    const summary = await injectLsp([fakePlugin("rust@official", tmp.dir)], cfg as unknown as Config, true, logger)

    expect(summary.servers).toBe(1)
    expect(summary.renamed).toBe(0)
    const lsp = cfg.lsp!
    const entry = lsp["rust-rust-analyzer"]
    // name: <plugin>-<server> = "rust-rust-analyzer"
    expect(entry).toBeDefined()
    expect(entry?.command).toEqual(["rust-analyzer"])
    expect(entry?.extensions).toEqual([".rs"])
  })

  test("injects multiple servers", async () => {
    writeLspJson(tmp.dir, {
      "ts-server": { command: "typescript-language-server", args: ["--stdio"], extensionToLanguage: { ".ts": "typescript" } },
      "eslint": { command: "vscode-eslint-language-server", args: ["--stdio"], extensionToLanguage: { ".ts": "typescript" } },
    })
    const cfg = asConfig({}) as unknown as { lsp?: Record<string, LspEntry> }
    const logger = makeLogger()
    const summary = await injectLsp([fakePlugin("ts@official", tmp.dir)], cfg as unknown as Config, true, logger)
    expect(summary.servers).toBe(2)
    expect(cfg.lsp!["ts-ts-server"]).toBeDefined()
    expect(cfg.lsp!["ts-eslint"]).toBeDefined()
  })

  test("resolves ${CLAUDE_PLUGIN_ROOT} in command", async () => {
    writeLspJson(tmp.dir, {
      "my-lsp": { command: "${CLAUDE_PLUGIN_ROOT}/bin/lsp", args: [], extensionToLanguage: { ".x": "x" } },
    })
    const cfg = asConfig({}) as unknown as { lsp?: Record<string, LspEntry> }
    await injectLsp([fakePlugin("p@mkt", tmp.dir)], cfg as unknown as Config, true, makeLogger())
    const entry = cfg.lsp!["p-my-lsp"]
    expect(entry?.command[0]).toBe(path.join(tmp.dir, "bin/lsp"))
  })

  test("plugin with no .lsp.json contributes nothing (silent)", async () => {
    const logger = makeLogger()
    const summary = await injectLsp([fakePlugin("noop@mkt", tmp.dir)], asConfig({}), true, logger)
    expect(summary.servers).toBe(0)
    expect(logger.warnings.length).toBe(0)
  })

  test("malformed .lsp.json is skipped with a warning", async () => {
    writeFileSync(path.join(tmp.dir, ".lsp.json"), "{ not json !!!!")
    const logger = makeLogger()
    const summary = await injectLsp([fakePlugin("bad@mkt", tmp.dir)], asConfig({}), true, logger)
    expect(summary.servers).toBe(0)
    expect(logger.warnings.some((w) => w.includes("bad@mkt"))).toBe(true)
  })

  test("malformed server entry (missing command) is skipped with warning, others injected", async () => {
    writeLspJson(tmp.dir, {
      "good": { command: "ls", extensionToLanguage: { ".x": "x" } },
      "bad": { args: ["--stdio"] }, // missing command
    })
    const cfg = asConfig({}) as unknown as { lsp?: Record<string, LspEntry> }
    const logger = makeLogger()
    const summary = await injectLsp([fakePlugin("p@mkt", tmp.dir)], cfg as unknown as Config, true, logger)
    expect(summary.servers).toBe(1)
    expect(cfg.lsp!["p-good"]).toBeDefined()
    expect(logger.warnings.some((w) => w.includes("bad"))).toBe(true)
  })

  test("server missing extensionToLanguage is skipped with warning", async () => {
    writeLspJson(tmp.dir, {
      "no-ext": { command: "ls" }, // no extensionToLanguage
      "with-ext": { command: "cat", extensionToLanguage: { ".x": "x" } },
    })
    const cfg = asConfig({}) as unknown as { lsp?: Record<string, LspEntry> }
    const logger = makeLogger()
    const summary = await injectLsp([fakePlugin("p@mkt", tmp.dir)], cfg as unknown as Config, true, logger)
    expect(summary.servers).toBe(1)
    expect(cfg.lsp!["p-with-ext"]).toBeDefined()
    expect(cfg.lsp!["p-no-ext"]).toBeUndefined()
    expect(logger.warnings.some((w) => w.includes("no-ext"))).toBe(true)
  })

  test("server with socket transport is skipped with warning", async () => {
    writeLspJson(tmp.dir, {
      "socket-server": { command: "ls", extensionToLanguage: { ".x": "x" }, transport: "socket" },
    })
    const logger = makeLogger()
    const summary = await injectLsp([fakePlugin("p@mkt", tmp.dir)], asConfig({}), true, logger)
    expect(summary.servers).toBe(0)
    expect(logger.warnings.some((w) => w.includes("socket"))).toBe(true)
  })

  test("collision: existing cfg.lsp key causes rename", async () => {
    writeLspJson(tmp.dir, { "rust-analyzer": { command: "rust-analyzer", extensionToLanguage: { ".rs": "rust" } } })
    // Pre-populate cfg.lsp with the base name that the injector would choose.
    // The base name is "<plugin>-<server>" = "rust-rust-analyzer".
    const existing: Record<string, unknown> = {
      "rust-rust-analyzer": { command: ["existing"] },
    }
    const cfg = asConfig({ lsp: existing }) as unknown as { lsp?: Record<string, LspEntry> }
    const logger = makeLogger()
    const summary = await injectLsp([fakePlugin("rust@official", tmp.dir)], cfg as unknown as Config, true, logger)
    expect(summary.renamed).toBe(1)
    // Existing entry untouched
    expect((cfg.lsp!["rust-rust-analyzer"] as LspEntry).command).toEqual(["existing"])
    // Renamed entry at rung 2: "<plugin>-<bareName>" = "rust-rust-rust-analyzer"
    expect(cfg.lsp!["rust-rust-rust-analyzer"]).toBeDefined()
  })

  test("cfg.lsp initialized as {} when absent", async () => {
    writeLspJson(tmp.dir, { "s": { command: "ls", extensionToLanguage: { ".x": "x" } } })
    const cfg = asConfig({})
    await injectLsp([fakePlugin("p@mkt", tmp.dir)], cfg, true, makeLogger())
    expect(typeof (cfg as unknown as { lsp?: unknown }).lsp).toBe("object")
  })
})

describe("injectLsp — allowLsp:false quiet path", () => {
  let tmp: { dir: string; cleanup: () => void }

  beforeEach(() => { tmp = makeTempDir() })
  afterEach(() => tmp.cleanup())

  test("malformed .lsp.json under allowLsp:false emits zero warnings", async () => {
    writeFileSync(path.join(tmp.dir, ".lsp.json"), "{ not json !!!!")
    const logger = makeLogger()
    const summary = await injectLsp([fakePlugin("bad@mkt", tmp.dir)], asConfig({}), false, logger)
    expect(summary.servers).toBe(0)
    expect(summary.skippedPolicy).toBe(0)
    expect(logger.warnings).toHaveLength(0)
  })

  test("valid file but lsp is an array under allowLsp:false emits zero warnings", async () => {
    writeFileSync(path.join(tmp.dir, ".lsp.json"), JSON.stringify([{ command: "ls" }]))
    const logger = makeLogger()
    const summary = await injectLsp([fakePlugin("p@mkt", tmp.dir)], asConfig({}), false, logger)
    expect(summary.skippedPolicy).toBe(0)
    expect(logger.warnings).toHaveLength(0)
  })
})

describe("injectLsp — I/O error skip-and-warn branches", () => {
  if (process.platform === "win32") return

  let tmp: { dir: string; cleanup: () => void }

  beforeEach(() => { tmp = makeTempDir() })
  afterEach(() => {
    try { require("node:fs").chmodSync(path.join(tmp.dir, ".lsp.json"), 0o644) } catch {}
    tmp.cleanup()
  })

  test("unreadable .lsp.json is skipped with a warning", async () => {
    writeLspJson(tmp.dir, { "s": { command: "ls", extensionToLanguage: { ".x": "x" } } })
    require("node:fs").chmodSync(path.join(tmp.dir, ".lsp.json"), 0o000)

    const logger = makeLogger()
    const summary = await injectLsp([fakePlugin("p@mkt", tmp.dir)], asConfig({}), true, logger)

    expect(summary.servers).toBe(0)
    expect(logger.warnings.some((w) => w.includes("could not read"))).toBe(true)
    require("node:fs").chmodSync(path.join(tmp.dir, ".lsp.json"), 0o644)
  })
})
