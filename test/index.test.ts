/**
 * Unit tests for src/index.ts — the hook orchestration layer.
 *
 * Tests the §9 version-compat warning at the hook level, using a real logger
 * capture (monkey-patching console.warn for the duration of the test) to
 * observe what the bridge emits without requiring a real OpenCode server.
 */

import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { parseBooleanEnv } from "../src/index.js"

// ── Helpers ────────────────────────────────────────────────────────────────────

function testBase(): string {
  const override = process.env["OCB_TMPDIR"] ?? process.env["TMPDIR"]
  if (override) {
    const abs = path.resolve(override)
    mkdirSync(abs, { recursive: true })
    return abs
  }
  return tmpdir()
}

/** Fake BunShell that resolves with a fixed stdout / exitCode. */
function fakeShell(exitCode: number, stdout: string): PluginInput["$"] {
  const build = () => {
    const thenable: any = {
      quiet: () => thenable,
      nothrow: () => thenable,
      then: (onF: (v: unknown) => unknown) =>
        Promise.resolve({
          exitCode,
          stdout: Buffer.from(stdout),
        }).then(onF),
    }
    return thenable
  }
  return (() => build()) as unknown as PluginInput["$"]
}

/** Stub globalThis.fetch to return a fixed JSON body. */
function stubFetch(responseBody: Record<string, unknown> | null, status = 200) {
  const fakeFetch = async (_url: string | URL) => {
    if (responseBody === null) throw new Error("network error")
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => responseBody,
    } as Response
  }
  globalThis.fetch = fakeFetch as unknown as typeof fetch
}

/**
 * Capture console.warn output while `fn` runs, then restore console.warn.
 * Returns an array of all warning strings emitted.
 */
async function captureWarnings(fn: () => Promise<void>): Promise<string[]> {
  const captured: string[] = []
  const orig = console.warn
  console.warn = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "))
  }
  try {
    await fn()
  } finally {
    console.warn = orig
  }
  return captured
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("opencode-claude-bridge hook — §9 version-compat warning at hook level", () => {
  let tmpDir: string
  let origFetch: typeof globalThis.fetch

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(testBase(), "ocb-index-test-"))
    origFetch = globalThis.fetch
  })

  afterEach(async () => {
    globalThis.fetch = origFetch
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("emits 'untested OpenCode version' warning when version is out of range", async () => {
    stubFetch({ healthy: true, version: "1.16.5" })

    const { server } = await import("../src/index.js")
    const input = {
      $: fakeShell(0, "[]"),
      serverUrl: new URL("http://localhost:4096/"),
      directory: tmpDir,
    } as unknown as PluginInput

    const mod = await server(input, undefined)
    const warnings = await captureWarnings(async () => {
      await mod!.config!({} as any)
    })

    expect(warnings.some((w) => w.includes("untested OpenCode version 1.16.5"))).toBe(true)
  })

  test("emits 'could not determine' warning when health endpoint is unreachable", async () => {
    stubFetch(null) // throws → null version

    const { server } = await import("../src/index.js")
    const input = {
      $: fakeShell(0, "[]"),
      serverUrl: new URL("http://localhost:4096/"),
      directory: tmpDir,
    } as unknown as PluginInput

    const mod = await server(input, undefined)
    const warnings = await captureWarnings(async () => {
      await mod!.config!({} as any)
    })

    expect(warnings.some((w) => w.includes("could not determine"))).toBe(true)
  })

  test("no version warning emitted when version is in the supported range", async () => {
    stubFetch({ healthy: true, version: "1.15.10" })

    const { server } = await import("../src/index.js")
    const input = {
      $: fakeShell(0, "[]"),
      serverUrl: new URL("http://localhost:4096/"),
      directory: tmpDir,
    } as unknown as PluginInput

    const mod = await server(input, undefined)
    const warnings = await captureWarnings(async () => {
      await mod!.config!({} as any)
    })

    const versionWarnings = warnings.filter(
      (w) => w.includes("untested OpenCode version") || w.includes("could not determine"),
    )
    expect(versionWarnings).toHaveLength(0)
  })

  test("non-strict mode: malformed plugin entry warns but hook does not throw", async () => {
    stubFetch({ healthy: true, version: "1.15.10" })

    const { server } = await import("../src/index.js")
    const input = {
      $: fakeShell(0, JSON.stringify([{ id: "bad" }])), // malformed entry → warns + skips
      serverUrl: new URL("http://localhost:4096/"),
      directory: tmpDir,
    } as unknown as PluginInput

    const mod = await server(input, undefined)
    const warnings = await captureWarnings(async () => {
      // Must resolve (not reject) in non-strict mode.
      await expect(mod!.config!({} as any)).resolves.toBeUndefined()
    })

    expect(warnings.some((w) => w.includes("malformed"))).toBe(true)
  })

  test("strict mode: a fatal warning from a malformed plugin entry propagates as a hard error", async () => {
    // In strict mode, logger.warn (with default fatalInStrict:true) throws BridgeError.
    // A malformed `claude plugin list` entry calls logger.warn("skipping a malformed entry"),
    // which throws inside listClaudePlugins, propagates to the outer catch (index.ts:76),
    // and is re-thrown at line 79 because bridge.strict is true.
    stubFetch({ healthy: true, version: "1.15.10" })

    const { server } = await import("../src/index.js")
    const input = {
      $: fakeShell(0, JSON.stringify([{ id: "bad" }])), // malformed → warns → throws in strict
      serverUrl: new URL("http://localhost:4096/"),
      directory: tmpDir,
    } as unknown as PluginInput

    // Pass strict: true as bridge options (second arg of the plugin tuple).
    const mod = await server(input, { strict: true })
    // The config hook must reject in strict mode when a fatal warning fires.
    await expect(mod!.config!({} as any)).rejects.toThrow()
  })
})

// ── parseBooleanEnv ───────────────────────────────────────────────────────────

describe("parseBooleanEnv — mirrors Effect Config.boolean accepted truthy set", () => {
  test("returns true for '1'", () => {
    expect(parseBooleanEnv("1")).toBe(true)
  })

  test("returns true for 'true'", () => {
    expect(parseBooleanEnv("true")).toBe(true)
  })

  test("returns true for 'yes'", () => {
    expect(parseBooleanEnv("yes")).toBe(true)
  })

  test("returns true for 'on'", () => {
    expect(parseBooleanEnv("on")).toBe(true)
  })

  test("is case-insensitive — TRUE, YES, ON, 1 all truthy", () => {
    expect(parseBooleanEnv("TRUE")).toBe(true)
    expect(parseBooleanEnv("YES")).toBe(true)
    expect(parseBooleanEnv("ON")).toBe(true)
    expect(parseBooleanEnv("True")).toBe(true)
  })

  test("returns false for 'false'", () => {
    expect(parseBooleanEnv("false")).toBe(false)
  })

  test("returns false for '0'", () => {
    expect(parseBooleanEnv("0")).toBe(false)
  })

  test("returns false for 'no'", () => {
    expect(parseBooleanEnv("no")).toBe(false)
  })

  test("returns false for 'off'", () => {
    expect(parseBooleanEnv("off")).toBe(false)
  })

  test("returns false for undefined (env var not set)", () => {
    expect(parseBooleanEnv(undefined)).toBe(false)
  })

  test("returns false for empty string", () => {
    expect(parseBooleanEnv("")).toBe(false)
  })
})

// ── chat.message hook — diagnostics toast ────────────────────────────────────

describe("opencode-claude-bridge hook — diagnostics toast via chat.message", () => {
  let tmpDir: string
  let origFetch: typeof globalThis.fetch

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(testBase(), "ocb-toast-test-"))
    origFetch = globalThis.fetch
  })

  afterEach(async () => {
    globalThis.fetch = origFetch
    rmSync(tmpDir, { recursive: true, force: true })
  })

  /** Build a mock client whose tui.showToast is a tracked stub. */
  function makeClientWithToast() {
    const calls: Array<Record<string, unknown>> = []
    const client = {
      tui: {
        showToast: async (opts: unknown) => {
          calls.push(opts as Record<string, unknown>)
          return { data: true }
        },
      },
    }
    return { client, calls }
  }

  test("when warnings fire during config, the first chat.message calls showToast once", async () => {
    // Trigger a warning by providing an out-of-range OpenCode version.
    stubFetch({ healthy: true, version: "1.16.5" })

    const { server } = await import("../src/index.js")
    const { client, calls } = makeClientWithToast()
    const input = {
      $: fakeShell(0, "[]"),
      serverUrl: new URL("http://localhost:4096/"),
      directory: tmpDir,
      client,
    } as unknown as PluginInput

    const mod = await server(input, undefined)
    await captureWarnings(async () => {
      await mod!.config!({} as any)
    })

    expect(calls).toHaveLength(0) // no toast yet

    // First chat.message — toast should fire
    await mod!["chat.message"]!({} as any, {} as any)
    expect(calls).toHaveLength(1)
    expect((calls[0] as any)?.body?.variant).toBe("warning")
    expect((calls[0] as any)?.body?.message).toContain("opencode-claude-bridge encountered issues")

    // Second chat.message — once-guard prevents a second toast
    await mod!["chat.message"]!({} as any, {} as any)
    expect(calls).toHaveLength(1)
  })

  test("when no warnings fire, chat.message never calls showToast", async () => {
    stubFetch({ healthy: true, version: "1.15.10" })

    const { server } = await import("../src/index.js")
    const { client, calls } = makeClientWithToast()
    const input = {
      $: fakeShell(0, "[]"), // empty plugin list — no warnings
      serverUrl: new URL("http://localhost:4096/"),
      directory: tmpDir,
      client,
    } as unknown as PluginInput

    const mod = await server(input, undefined)
    await mod!.config!({} as any)

    await mod!["chat.message"]!({} as any, {} as any)
    expect(calls).toHaveLength(0)
  })

  test("a showToast failure does not throw out of chat.message", async () => {
    stubFetch({ healthy: true, version: "1.16.5" }) // triggers version warning

    const { server } = await import("../src/index.js")
    const client = {
      tui: {
        showToast: async () => { throw new Error("TUI not available") },
      },
    }
    const input = {
      $: fakeShell(0, "[]"),
      serverUrl: new URL("http://localhost:4096/"),
      directory: tmpDir,
      client,
    } as unknown as PluginInput

    const mod = await server(input, undefined)
    await captureWarnings(async () => {
      await mod!.config!({} as any)
    })

    // Must resolve without throwing even though showToast throws
    await expect(mod!["chat.message"]!({} as any, {} as any)).resolves.toBeUndefined()
  })
})
