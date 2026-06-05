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
