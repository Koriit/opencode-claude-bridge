import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  injectMcp,
  mapClaudeMcpServer,
  type McpEntry,
  type McpLocalEntry,
  type McpRemoteEntry,
} from "../src/mcp-inject.js"
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
  const dir = mkdtempSync(path.join(testBase(), "ocb-mcp-test-"))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function writeMcpJson(dir: string, content: object): void {
  writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify(content))
}

// ── mapClaudeMcpServer ────────────────────────────────────────────────────────

describe("mapClaudeMcpServer — http/remote mapping", () => {
  test("type:http with url maps to remote entry", () => {
    const result = mapClaudeMcpServer(
      { type: "http", url: "https://mcp.example.com/v1" },
      "/plugin",
    ) as McpRemoteEntry
    expect(result).not.toBeNull()
    expect(result.type).toBe("remote")
    expect(result.url).toBe("https://mcp.example.com/v1")
  })

  test("type:http with headers maps headers", () => {
    const result = mapClaudeMcpServer(
      {
        type: "http",
        url: "https://mcp.example.com",
        headers: { Authorization: "Bearer ${CLAUDE_PLUGIN_ROOT}/token" },
      },
      "/myplug",
    ) as McpRemoteEntry
    expect(result.headers?.["Authorization"]).toBe("Bearer /myplug/token")
  })

  test("type:http with oauth passes through camelCase fields", () => {
    const result = mapClaudeMcpServer(
      {
        type: "http",
        url: "https://mcp.slack.com/mcp",
        oauth: { clientId: "abc123", callbackPort: 3118 },
      },
      "/plugin",
    ) as McpRemoteEntry
    expect(result.oauth).not.toBe(false)
    expect(result.oauth).not.toBeUndefined()
    const oauth = result.oauth as { clientId?: string; callbackPort?: number }
    expect(oauth.clientId).toBe("abc123")
    expect(oauth.callbackPort).toBe(3118)
  })

  test("type:http with oauth:false passes through false", () => {
    const result = mapClaudeMcpServer(
      { type: "http", url: "https://mcp.example.com", oauth: false },
      "/plugin",
    ) as McpRemoteEntry
    expect(result.oauth).toBe(false)
  })

  test("type:http missing url returns null", () => {
    const result = mapClaudeMcpServer({ type: "http" }, "/plugin")
    expect(result).toBeNull()
  })

  test("resolves ${CLAUDE_PLUGIN_ROOT} in url", () => {
    const result = mapClaudeMcpServer(
      { type: "http", url: "${CLAUDE_PLUGIN_ROOT}/mcp" },
      "/abs/path",
    ) as McpRemoteEntry
    expect(result.url).toBe("/abs/path/mcp")
  })
})

describe("mapClaudeMcpServer — stdio/local mapping", () => {
  test("command server maps to local entry with command array", () => {
    const result = mapClaudeMcpServer(
      { command: "my-server", args: ["--port", "9000"] },
      "/plugin",
    ) as McpLocalEntry
    expect(result).not.toBeNull()
    expect(result.type).toBe("local")
    expect(result.command).toEqual(["my-server", "--port", "9000"])
  })

  test("command with no args maps to single-element command array", () => {
    const result = mapClaudeMcpServer({ command: "npx", args: ["@company/mcp"] }, "/p") as McpLocalEntry
    expect(result.command).toEqual(["npx", "@company/mcp"])
  })

  test("env is mapped to environment and ${CLAUDE_PLUGIN_ROOT} resolved", () => {
    const result = mapClaudeMcpServer(
      {
        command: "server",
        env: { ROOT: "${CLAUDE_PLUGIN_ROOT}/scripts", KEY: "val" },
      },
      "/myroot",
    ) as McpLocalEntry
    expect(result.environment).toEqual({ ROOT: "/myroot/scripts", KEY: "val" })
  })

  test("resolves ${CLAUDE_PLUGIN_ROOT} in command and args", () => {
    const result = mapClaudeMcpServer(
      { command: "${CLAUDE_PLUGIN_ROOT}/bin/server", args: ["${CLAUDE_PLUGIN_ROOT}/config.json"] },
      "/abs",
    ) as McpLocalEntry
    expect(result.command).toEqual(["/abs/bin/server", "/abs/config.json"])
  })

  test("missing command returns null", () => {
    const result = mapClaudeMcpServer({ type: "stdio" }, "/plugin")
    expect(result).toBeNull()
  })
})

// ── injectMcp ─────────────────────────────────────────────────────────────────

describe("injectMcp — allowMcp:false (policy gate)", () => {
  let tmp: { dir: string; cleanup: () => void }

  beforeEach(() => { tmp = makeTempDir() })
  afterEach(() => { tmp.cleanup() })

  test("injects nothing when allowMcp is false", async () => {
    writeMcpJson(tmp.dir, {
      mcpServers: { myserver: { type: "http", url: "https://example.com" } },
    })
    const cfg = asConfig({})
    const logger = makeLogger()
    const summary = await injectMcp(
      [fakePlugin("alpha@mkt", tmp.dir)],
      cfg,
      false,
      logger,
    )
    expect(summary.servers).toBe(0)
    expect((cfg as unknown as { mcp?: unknown }).mcp).toBeUndefined()
  })

  test("logs policy summary when allowMcp is false and servers exist", async () => {
    writeMcpJson(tmp.dir, {
      mcpServers: {
        s1: { type: "http", url: "https://a.com" },
        s2: { type: "http", url: "https://b.com" },
      },
    })
    const logger = makeLogger()
    const summary = await injectMcp(
      [fakePlugin("alpha@mkt", tmp.dir)],
      asConfig({}),
      false,
      logger,
    )
    expect(summary.skippedPolicy).toBe(2)
    expect(logger.infos.some((m) => m.includes("policy"))).toBe(true)
  })

  test("no policy log line when there are no MCP servers at all", async () => {
    // Plugin dir exists but has no .mcp.json
    const logger = makeLogger()
    const summary = await injectMcp([fakePlugin("alpha@mkt", tmp.dir)], asConfig({}), false, logger)
    expect(summary.skippedPolicy).toBe(0)
    expect(logger.infos.length).toBe(0)
  })
})

describe("injectMcp — allowMcp:true (injection)", () => {
  let tmp: { dir: string; cleanup: () => void }

  beforeEach(() => { tmp = makeTempDir() })
  afterEach(() => { tmp.cleanup() })

  test("injects a remote server from .mcp.json", async () => {
    writeMcpJson(tmp.dir, {
      mcpServers: { atlassian: { type: "http", url: "https://mcp.atlassian.com/v1/mcp" } },
    })
    const cfg = asConfig({}) as unknown as { mcp?: Record<string, McpEntry> }
    const logger = makeLogger()
    const summary = await injectMcp([fakePlugin("atlassian@official", tmp.dir)], cfg as unknown as Config, true, logger)

    expect(summary.servers).toBe(1)
    expect(summary.renamed).toBe(0)
    const mcp = cfg.mcp!
    // name: <plugin>-<server> = "atlassian-atlassian"
    expect(mcp["atlassian-atlassian"]).toBeDefined()
    const entry = mcp["atlassian-atlassian"] as McpRemoteEntry
    expect(entry.type).toBe("remote")
    expect(entry.url).toBe("https://mcp.atlassian.com/v1/mcp")
  })

  test("injects a local server from .mcp.json", async () => {
    writeMcpJson(tmp.dir, {
      mcpServers: { mylocal: { command: "node", args: ["server.js", "--port", "8080"] } },
    })
    const cfg = asConfig({}) as unknown as { mcp?: Record<string, McpEntry> }
    const logger = makeLogger()
    await injectMcp([fakePlugin("myplugin@mkt", tmp.dir)], cfg as unknown as Config, true, logger)

    const entry = cfg.mcp!["myplugin-mylocal"] as McpLocalEntry
    expect(entry.type).toBe("local")
    expect(entry.command).toEqual(["node", "server.js", "--port", "8080"])
  })

  test("injects multiple servers from one plugin", async () => {
    writeMcpJson(tmp.dir, {
      mcpServers: {
        zoom: { type: "http", url: "https://mcp.zoom.us/zoom" },
        zoom2: { type: "http", url: "https://mcp.zoom.us/zoom2" },
      },
    })
    const cfg = asConfig({}) as unknown as { mcp?: Record<string, McpEntry> }
    const logger = makeLogger()
    const summary = await injectMcp([fakePlugin("zoom@official", tmp.dir)], cfg as unknown as Config, true, logger)
    expect(summary.servers).toBe(2)
    expect(cfg.mcp!["zoom-zoom"]).toBeDefined()
    expect(cfg.mcp!["zoom-zoom2"]).toBeDefined()
  })

  test("resolves ${CLAUDE_PLUGIN_ROOT} in injected values", async () => {
    writeMcpJson(tmp.dir, {
      mcpServers: { local: { command: "${CLAUDE_PLUGIN_ROOT}/server", args: [] } },
    })
    const cfg = asConfig({}) as unknown as { mcp?: Record<string, McpEntry> }
    const logger = makeLogger()
    await injectMcp([fakePlugin("myplugin@mkt", tmp.dir)], cfg as unknown as Config, true, logger)
    const entry = cfg.mcp!["myplugin-local"] as McpLocalEntry
    expect(entry.command[0]).toBe(path.join(tmp.dir, "server"))
  })

  test("plugin with no .mcp.json contributes nothing (silent)", async () => {
    const cfg = asConfig({})
    const logger = makeLogger()
    const summary = await injectMcp([fakePlugin("noop@mkt", tmp.dir)], cfg, true, logger)
    expect(summary.servers).toBe(0)
    expect(logger.warnings.length).toBe(0)
  })

  test("malformed .mcp.json is skipped with a warning", async () => {
    writeFileSync(path.join(tmp.dir, ".mcp.json"), "{ not json !!!!")
    const cfg = asConfig({})
    const logger = makeLogger()
    const summary = await injectMcp([fakePlugin("bad@mkt", tmp.dir)], cfg, true, logger)
    expect(summary.servers).toBe(0)
    expect(logger.warnings.some((w) => w.includes("bad@mkt"))).toBe(true)
  })

  test("malformed server entry is skipped with a warning, others still injected", async () => {
    writeMcpJson(tmp.dir, {
      mcpServers: {
        good: { type: "http", url: "https://good.com" },
        bad: { type: "http" }, // missing url
      },
    })
    const cfg = asConfig({}) as unknown as { mcp?: Record<string, McpEntry> }
    const logger = makeLogger()
    const summary = await injectMcp([fakePlugin("p@mkt", tmp.dir)], cfg as unknown as Config, true, logger)
    expect(summary.servers).toBe(1)
    expect(cfg.mcp!["p-good"]).toBeDefined()
    expect(logger.warnings.some((w) => w.includes("bad"))).toBe(true)
  })

  test("does not overwrite existing cfg.mcp keys (naming allocator)", async () => {
    writeMcpJson(tmp.dir, {
      mcpServers: { server: { type: "http", url: "https://new.com" } },
    })
    // Pre-populate cfg.mcp with the base name that the injector would choose.
    // The base name is "<plugin>-<server>" = "myplugin-server".
    const existing: Record<string, unknown> = {
      "myplugin-server": { type: "remote", url: "https://existing.com" },
    }
    const cfg = asConfig({ mcp: existing }) as unknown as { mcp?: Record<string, McpEntry> }
    const logger = makeLogger()
    const summary = await injectMcp([fakePlugin("myplugin@mkt", tmp.dir)], cfg as unknown as Config, true, logger)
    // Collision on "myplugin-server" → rung2 = "<plugin>-<bareName>" = "myplugin-myplugin-server"
    expect(summary.renamed).toBe(1)
    // Existing entry untouched
    expect((cfg.mcp!["myplugin-server"] as McpRemoteEntry).url).toBe("https://existing.com")
    // Renamed entry at rung 2
    expect(cfg.mcp!["myplugin-myplugin-server"]).toBeDefined()
  })

  test("two plugins with same server name — first wins, second is prefixed", async () => {
    const tmpA = makeTempDir()
    const tmpB = makeTempDir()
    try {
      writeMcpJson(tmpA.dir, { mcpServers: { myserver: { type: "http", url: "https://a.com" } } })
      writeMcpJson(tmpB.dir, { mcpServers: { myserver: { type: "http", url: "https://b.com" } } })

      const cfg = asConfig({}) as unknown as { mcp?: Record<string, McpEntry> }
      const logger = makeLogger()
      // a@mkt < b@mkt sorted alphabetically
      await injectMcp(
        [fakePlugin("a@mkt", tmpA.dir), fakePlugin("b@mkt", tmpB.dir)],
        cfg as unknown as Config,
        true,
        logger,
      )
      // "a-myserver" claimed by first; "b-myserver" claimed by second (no collision)
      expect(cfg.mcp!["a-myserver"]).toBeDefined()
      expect((cfg.mcp!["a-myserver"] as McpRemoteEntry).url).toBe("https://a.com")
      expect(cfg.mcp!["b-myserver"]).toBeDefined()
      expect((cfg.mcp!["b-myserver"] as McpRemoteEntry).url).toBe("https://b.com")
    } finally {
      tmpA.cleanup()
      tmpB.cleanup()
    }
  })

  test("oauth fields are passed through with camelCase names (no rename)", async () => {
    writeMcpJson(tmp.dir, {
      mcpServers: {
        slack: {
          type: "http",
          url: "https://mcp.slack.com/mcp",
          oauth: { clientId: "123.456", callbackPort: 3118 },
        },
      },
    })
    const cfg = asConfig({}) as unknown as { mcp?: Record<string, McpEntry> }
    await injectMcp([fakePlugin("slack@official", tmp.dir)], cfg as unknown as Config, true, makeLogger())
    const entry = cfg.mcp!["slack-slack"] as McpRemoteEntry
    const oauth = entry.oauth as { clientId: string; callbackPort: number }
    expect(oauth.clientId).toBe("123.456")
    expect(oauth.callbackPort).toBe(3118)
  })

  test("cfg.mcp is initialized if absent", async () => {
    writeMcpJson(tmp.dir, {
      mcpServers: { s: { type: "http", url: "https://s.com" } },
    })
    const cfg = asConfig({})
    const logger = makeLogger()
    await injectMcp([fakePlugin("p@mkt", tmp.dir)], cfg, true, logger)
    expect((cfg as unknown as { mcp?: unknown }).mcp).toBeDefined()
  })
})

describe("injectMcp — allowMcp:false quiet path", () => {
  let tmp: { dir: string; cleanup: () => void }

  beforeEach(() => { tmp = makeTempDir() })
  afterEach(() => tmp.cleanup())

  test("malformed .mcp.json under allowMcp:false emits zero warnings", async () => {
    writeFileSync(path.join(tmp.dir, ".mcp.json"), "{ not json !!!!")
    const logger = makeLogger()
    const summary = await injectMcp([fakePlugin("bad@mkt", tmp.dir)], asConfig({}), false, logger)
    expect(summary.servers).toBe(0)
    expect(summary.skippedPolicy).toBe(0)
    expect(logger.warnings).toHaveLength(0)
  })

  test("valid file but mcpServers is a non-object under allowMcp:false emits zero warnings", async () => {
    writeFileSync(path.join(tmp.dir, ".mcp.json"), JSON.stringify({ mcpServers: "not-an-object" }))
    const logger = makeLogger()
    const summary = await injectMcp([fakePlugin("p@mkt", tmp.dir)], asConfig({}), false, logger)
    expect(summary.skippedPolicy).toBe(0)
    expect(logger.warnings).toHaveLength(0)
  })
})

describe("injectMcp — I/O error skip-and-warn branches", () => {
  if (process.platform === "win32") return

  let tmp: { dir: string; cleanup: () => void }

  beforeEach(() => { tmp = makeTempDir() })
  afterEach(() => {
    try { require("node:fs").chmodSync(path.join(tmp.dir, ".mcp.json"), 0o644) } catch {}
    tmp.cleanup()
  })

  test("unreadable .mcp.json is skipped with a warning", async () => {
    writeMcpJson(tmp.dir, { mcpServers: { s: { type: "http", url: "https://s.com" } } })
    require("node:fs").chmodSync(path.join(tmp.dir, ".mcp.json"), 0o000)

    const logger = makeLogger()
    const summary = await injectMcp([fakePlugin("p@mkt", tmp.dir)], asConfig({}), true, logger)

    expect(summary.servers).toBe(0)
    expect(logger.warnings.some((w) => w.includes("could not read"))).toBe(true)
    require("node:fs").chmodSync(path.join(tmp.dir, ".mcp.json"), 0o644)
  })
})
