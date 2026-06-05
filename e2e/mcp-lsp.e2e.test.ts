import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { startBridge, type BridgeServer } from "./harness.js"

/**
 * End-to-end MCP and LSP injection tests.
 *
 * MCP observable surface: `GET /mcp` returns ALL configured entries (both connected
 * and failed), verified against OpenCode source (mcp/index.ts `status()` iterates
 * cfg.mcp and returns `s.status[key] ?? { status: "disabled" }` for every key).
 * A fixture with a no-op command that fails to start still appears in `/mcp` with
 * `status:"failed"` — the entry is present, confirming injection happened.
 *
 * LSP has no API route, so we assert via the per-run summary log line.
 */

const TEST_TIMEOUT = 90_000

// ── Fixture helpers ────────────────────────────────────────────────────────────

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
  const dir = mkdtempSync(path.join(fixtureBase(), "ocb-mcp-lsp-fixture-"))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function writeFixtureFile(baseDir: string, relPath: string, content: string): void {
  const full = path.join(baseDir, relPath)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, content)
}

function writeMcpJson(dir: string, content: object): void {
  writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify(content, null, 2))
}

function writeLspJson(dir: string, content: object): void {
  writeFileSync(path.join(dir, ".lsp.json"), JSON.stringify(content, null, 2))
}

function userPlugin(id: string, installPath: string, enabled = true, version = "1.0.0") {
  return { id, version, scope: "user", enabled, installPath }
}

type McpStatusRecord = Record<string, { status: string; error?: string }>

// ── Test suite: MCP injection disabled by default ─────────────────────────────

describe("bridge e2e — MCP policy off (default)", () => {
  let fixture: { dir: string; cleanup: () => void }
  let server: BridgeServer | undefined

  beforeAll(async () => {
    fixture = makePluginDir()
    writeMcpJson(fixture.dir, {
      mcpServers: {
        "test-server": { type: "http", url: "https://mcp.example.com/v1" },
      },
    })

    server = await startBridge({
      // No options → allowMcp defaults to false
      isolateHome: true,
      isolateCache: true,
      claude: { plugins: [userPlugin("mcp-test@official", fixture.dir)] },
    })
    await server.triggerHook()
  }, TEST_TIMEOUT)

  afterAll(async () => {
    await server?.stop()
    fixture.cleanup()
  })

  test("server stays healthy with MCP off", async () => {
    const health = await server!.get("/global/health")
    expect(health.status).toBe(200)
  })

  test("MCP server not present in GET /mcp when allowMcp is false", async () => {
    const res = await server!.get("/mcp")
    expect(res.status).toBe(200)
    const mcp = res.body as McpStatusRecord
    // No bridge-injected key should be present — none were injected
    expect(Object.keys(mcp).some((k) => k.includes("mcp-test"))).toBe(false)
  })

  test("policy skip is logged", () => {
    expect(server!.logHas("policy")).toBe(true)
  })
})

// ── Test suite: MCP injection enabled ─────────────────────────────────────────

describe("bridge e2e — MCP injection with allowMcp:true", () => {
  let fixture: { dir: string; cleanup: () => void }
  let server: BridgeServer | undefined

  beforeAll(async () => {
    fixture = makePluginDir()
    // Use a local command that will fail immediately (command "false" exits 1).
    // OpenCode calls create() for each cfg.mcp entry on first instance request
    // and records status: "failed". The entry still appears in GET /mcp, confirming
    // the bridge-injected key is present in cfg.mcp. The test does NOT hang because
    // the connection attempt fails fast and OpenCode records the failure.
    writeMcpJson(fixture.dir, {
      mcpServers: {
        "my-mcp-server": {
          command: "false",  // exits immediately with failure
          args: [],
        },
      },
    })

    server = await startBridge({
      options: { allowMcp: true },
      isolateHome: true,
      isolateCache: true,
      claude: { plugins: [userPlugin("mcp-plugin@official", fixture.dir)] },
    })
    await server.triggerHook()
  }, TEST_TIMEOUT)

  afterAll(async () => {
    await server?.stop()
    fixture.cleanup()
  })

  test("server stays healthy with MCP on", async () => {
    const health = await server!.get("/global/health")
    expect(health.status).toBe(200)
  })

  test("injected MCP entry appears in GET /mcp with bridge-namespaced key", async () => {
    // The bridge names the entry "<plugin>-<server>" = "mcp-plugin-my-mcp-server".
    // Even though the command fails to connect, OpenCode records it as status:"failed".
    // GET /mcp returns all configured entries — verifying the injection took effect.
    const res = await server!.get("/mcp")
    expect(res.status).toBe(200)
    const mcp = res.body as McpStatusRecord
    expect(mcp["mcp-plugin-my-mcp-server"]).toBeDefined()
    // Entry is present; status is "failed" or "disabled" (connection failed, that's expected)
    expect(["failed", "disabled", "connected"].includes(mcp["mcp-plugin-my-mcp-server"]!.status)).toBe(true)
  })

  test("summary log confirms 1 MCP server injected", () => {
    expect(server!.logHas("1 MCP server(s)")).toBe(true)
  })

  test("no MCP policy skip message when allowMcp is true", () => {
    expect(server!.logHas("MCP (policy)")).toBe(false)
  })
})

// ── Test suite: LSP injection disabled by default ─────────────────────────────

describe("bridge e2e — LSP policy off (default)", () => {
  let fixture: { dir: string; cleanup: () => void }
  let server: BridgeServer | undefined

  beforeAll(async () => {
    fixture = makePluginDir()
    writeLspJson(fixture.dir, {
      "rust-analyzer": {
        command: "rust-analyzer",
        extensionToLanguage: { ".rs": "rust" },
      },
    })

    server = await startBridge({
      // No options → allowLsp defaults to false
      isolateHome: true,
      isolateCache: true,
      claude: { plugins: [userPlugin("rust-lsp@official", fixture.dir)] },
    })
    await server.triggerHook()
  }, TEST_TIMEOUT)

  afterAll(async () => {
    await server?.stop()
    fixture.cleanup()
  })

  test("server stays healthy with LSP off", async () => {
    const health = await server!.get("/global/health")
    expect(health.status).toBe(200)
  })

  test("LSP server is not injected when allowLsp is false (summary log)", () => {
    expect(server!.logHas("0 LSP server(s)")).toBe(true)
  })

  test("LSP policy skip is logged", () => {
    expect(server!.logHas("policy")).toBe(true)
  })
})

// ── Test suite: LSP injection enabled ─────────────────────────────────────────

describe("bridge e2e — LSP injection with allowLsp:true", () => {
  let fixture: { dir: string; cleanup: () => void }
  let server: BridgeServer | undefined

  beforeAll(async () => {
    fixture = makePluginDir()
    writeLspJson(fixture.dir, {
      "my-lsp": {
        command: "true",  // OpenCode defers LSP startup to first file-open; no hang
        args: [],
        extensionToLanguage: { ".foo": "foo" },
      },
    })

    server = await startBridge({
      options: { allowLsp: true },
      isolateHome: true,
      isolateCache: true,
      claude: { plugins: [userPlugin("lsp-plugin@official", fixture.dir)] },
    })
    await server.triggerHook()
  }, TEST_TIMEOUT)

  afterAll(async () => {
    await server?.stop()
    fixture.cleanup()
  })

  test("server stays healthy with LSP on", async () => {
    const health = await server!.get("/global/health")
    expect(health.status).toBe(200)
  })

  test("LSP server injection is logged in summary (1 LSP server)", () => {
    expect(server!.logHas("1 LSP server(s)")).toBe(true)
  })

  test("OpenCode logs 'enabled LSP servers' after the bridge injected (OpenCode-side oracle)", () => {
    // This string comes from OpenCode's lsp/lsp.ts:188 — not the bridge. Checking it
    // proves OpenCode itself saw the injected cfg.lsp entry (not just that the bridge
    // logged its own summary line).
    expect(server!.logHas("enabled LSP servers")).toBe(true)
  })
})

// ── Test suite: cfg.lsp === false — user disabled all LSP ─────────────────────

describe("bridge e2e — cfg.lsp === false respected", () => {
  let fixture: { dir: string; cleanup: () => void }
  let server: BridgeServer | undefined

  beforeAll(async () => {
    fixture = makePluginDir()

    // Plugin has an LSP server
    writeLspJson(fixture.dir, {
      "my-lsp": {
        command: "true",
        args: [],
        extensionToLanguage: { ".foo": "foo" },
      },
    })

    // Plugin also has a command so we can confirm commands still inject
    writeFixtureFile(fixture.dir, "commands/test-cmd.md", "---\ndescription: test\n---\nHello")

    // Use the factory form to overwrite opencode.json with lsp:false at the top level.
    // The harness writes opencode.json, then calls the factory — so our overwrite runs
    // after the initial write but before opencode is spawned.
    server = await startBridge({
      options: { allowLsp: true },
      isolateHome: true,
      isolateCache: true,
      claude: (projectDir) => {
        writeFileSync(
          path.join(projectDir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            lsp: false,
            plugin: [
              [
                `file://${path.resolve(import.meta.dir, "../src/index.ts")}`,
                { allowLsp: true },
              ],
            ],
          }, null, 2),
        )
        return { plugins: [userPlugin("lsp-plugin@official", fixture.dir)] }
      },
    })
    await server.triggerHook()
  }, TEST_TIMEOUT)

  afterAll(async () => {
    await server?.stop()
    fixture.cleanup()
  })

  test("server stays healthy when cfg.lsp is false", async () => {
    const health = await server!.get("/global/health")
    expect(health.status).toBe(200)
  })

  test("bridge respects cfg.lsp === false (user-disabled log emitted)", () => {
    expect(server!.logHas("cfg.lsp is false")).toBe(true)
  })

  test("summary shows 0 LSP servers injected", () => {
    expect(server!.logHas("0 LSP server(s)")).toBe(true)
  })

  test("OpenCode logs 'all LSPs are disabled' when cfg.lsp is false (OpenCode-side oracle)", () => {
    // This string comes from OpenCode's lsp/lsp.ts:156 — not the bridge. Checking it
    // proves OpenCode itself saw the false value (not just that the bridge logged its own message).
    expect(server!.logHas("all LSPs are disabled")).toBe(true)
  })

  test("commands still inject even when cfg.lsp is false", async () => {
    const res = await server!.get("/command")
    expect(res.status).toBe(200)
    const commands = res.body as Array<{ name: string }>
    const cmd = commands.find((c) => c.name === "test-cmd" || c.name.includes("test-cmd"))
    expect(cmd).toBeDefined()
  })
})

// ── Test suite: both MCP and LSP disabled (no servers) ───────────────────────

describe("bridge e2e — plugin with no MCP/LSP files", () => {
  let fixture: { dir: string; cleanup: () => void }
  let server: BridgeServer | undefined

  beforeAll(async () => {
    fixture = makePluginDir()
    // Plugin has only a command, no .mcp.json or .lsp.json
    writeFixtureFile(fixture.dir, "commands/hello.md", "---\ndescription: hello\n---\nHello $ARGUMENTS")

    server = await startBridge({
      options: { allowMcp: true, allowLsp: true },
      isolateHome: true,
      isolateCache: true,
      claude: { plugins: [userPlugin("hello-plugin@official", fixture.dir)] },
    })
    await server.triggerHook()
  }, TEST_TIMEOUT)

  afterAll(async () => {
    await server?.stop()
    fixture.cleanup()
  })

  test("server stays healthy", async () => {
    const health = await server!.get("/global/health")
    expect(health.status).toBe(200)
  })

  test("GET /mcp returns empty object when no MCP servers were injected", async () => {
    const res = await server!.get("/mcp")
    expect(res.status).toBe(200)
    expect(Object.keys(res.body as McpStatusRecord).length).toBe(0)
  })

  test("0 MCP and 0 LSP servers in summary log (no MCP/LSP files)", () => {
    expect(server!.logHas("0 MCP server(s)")).toBe(true)
    expect(server!.logHas("0 LSP server(s)")).toBe(true)
  })

  test("command still appears", async () => {
    const res = await server!.get("/command")
    const commands = res.body as Array<{ name: string }>
    const cmd = commands.find((c) => c.name === "hello" || c.name.includes("hello"))
    expect(cmd).toBeDefined()
  })
})

// ── Test suite: MCP intra-bridge collision (two plugins, same server name) ────

describe("bridge e2e — MCP intra-bridge collision (two plugins share server name)", () => {
  let fixtureA: { dir: string; cleanup: () => void }
  let fixtureB: { dir: string; cleanup: () => void }
  let server: BridgeServer | undefined

  beforeAll(async () => {
    fixtureA = makePluginDir()
    fixtureB = makePluginDir()

    // Both plugins export a server called "api". Base names: "a-api" and "b-api" — no collision.
    // The bridge always prefixes MCP with "<plugin>-<server>", so intra-bridge names are
    // "<plugin>-<server>" and never collide unless two plugins have the same plugin-part.
    // Test: two different plugin-ids → two distinct base names → both appear in /mcp.
    writeMcpJson(fixtureA.dir, {
      mcpServers: { api: { type: "http", url: "https://a-api.example.com" } },
    })
    writeMcpJson(fixtureB.dir, {
      mcpServers: { api: { type: "http", url: "https://b-api.example.com" } },
    })

    server = await startBridge({
      options: { allowMcp: true },
      isolateHome: true,
      isolateCache: true,
      claude: {
        plugins: [
          userPlugin("plugin-a@official", fixtureA.dir),
          userPlugin("plugin-b@official", fixtureB.dir),
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

  test("both bridge-namespaced MCP entries appear in GET /mcp", async () => {
    const res = await server!.get("/mcp")
    expect(res.status).toBe(200)
    const mcp = res.body as McpStatusRecord
    // "plugin-a-api" and "plugin-b-api" — distinct base names, no collision needed.
    expect(mcp["plugin-a-api"]).toBeDefined()
    expect(mcp["plugin-b-api"]).toBeDefined()
  })

  test("2 MCP servers injected in summary", () => {
    expect(server!.logHas("2 MCP server(s)")).toBe(true)
  })
})

// ── Test suite: MCP native collision (native cfg.mcp entry collides with bridge) ──

describe("bridge e2e — MCP native collision (native cfg.mcp entry wins)", () => {
  let fixture: { dir: string; cleanup: () => void }
  let server: BridgeServer | undefined

  beforeAll(async () => {
    fixture = makePluginDir()

    // Plugin exports a server named "my-server". Bridge base name: "mcp-plugin-my-server".
    // We pre-populate cfg.mcp with "mcp-plugin-my-server" as a native entry.
    // The bridge must rename its copy to the next rung (collision).
    writeMcpJson(fixture.dir, {
      mcpServers: {
        "my-server": { command: "false", args: [] },
      },
    })

    server = await startBridge({
      options: { allowMcp: true },
      isolateHome: true,
      isolateCache: true,
      claude: (projectDir) => {
        writeFileSync(
          require("node:path").join(projectDir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            // Pre-populate cfg.mcp with the name the bridge would otherwise use.
            mcp: {
              "mcp-plugin-my-server": { type: "local", command: ["native-tool"] },
            },
            plugin: [
              [
                `file://${require("node:path").resolve(import.meta.dir, "../src/index.ts")}`,
                { allowMcp: true },
              ],
            ],
          }, null, 2),
        )
        return { plugins: [userPlugin("mcp-plugin@official", fixture.dir)] }
      },
    })
    await server.triggerHook()
  }, TEST_TIMEOUT)

  afterAll(async () => {
    await server?.stop()
    fixture.cleanup()
  })

  test("native 'mcp-plugin-my-server' entry is preserved (untouched) in GET /mcp", async () => {
    const res = await server!.get("/mcp")
    expect(res.status).toBe(200)
    const mcp = res.body as McpStatusRecord
    expect(mcp["mcp-plugin-my-server"]).toBeDefined()
  })

  test("bridge's renamed entry appears under a collision-prefixed key", async () => {
    const res = await server!.get("/mcp")
    const mcp = res.body as McpStatusRecord
    // The bridge renames: "mcp-plugin-my-server" is taken → rung2 = "<plugin>-<baseName>".
    // plugin-part of "mcp-plugin@official" = "mcp-plugin", baseName = "mcp-plugin-my-server"
    // → rung2 key = "mcp-plugin-mcp-plugin-my-server".
    expect(mcp["mcp-plugin-mcp-plugin-my-server"]).toBeDefined()
  })

  test("summary shows 1 renamed (collision)", () => {
    expect(server!.logHas("renamed 1 (collision)")).toBe(true)
  })
})
