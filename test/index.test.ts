/**
 * Unit tests for src/index.ts — the hook orchestration layer.
 */

import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import type { PluginInput, Config } from "@opencode-ai/plugin"
import { parseBooleanEnv, server } from "../src/index.js"

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

/** Fake client whose app.log is a no-op (the bridge logs through it). */
function fakeClient(): PluginInput["client"] {
  return { app: { log: async () => ({ data: true }) } } as unknown as PluginInput["client"]
}

// ── Malformed plugin entry ────────────────────────────────────────────────────

describe("opencode-claude-bridge hook — malformed plugin entry handling", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(testBase(), "ocb-index-test-"))
  })

  afterEach(async () => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("non-strict mode: malformed plugin entry warns but hook does not throw", async () => {
    const { server } = await import("../src/index.js")
    const input = {
      $: fakeShell(0, JSON.stringify([{ id: "bad" }])), // malformed entry → warns + skips
      directory: tmpDir,
      client: fakeClient(),
    } as unknown as PluginInput

    const mod = await server(input, undefined)
    // Must resolve (not reject) in non-strict mode.
    await expect(mod!.config!({} as any)).resolves.toBeUndefined()
  })

  test("strict mode: a fatal warning from a malformed plugin entry propagates as a hard error", async () => {
    const { server } = await import("../src/index.js")
    const input = {
      $: fakeShell(0, JSON.stringify([{ id: "bad" }])), // malformed → warns → throws in strict
      directory: tmpDir,
      client: fakeClient(),
    } as unknown as PluginInput

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

// ── experimental.chat.system.transform (I3) ───────────────────────────────────

describe("experimental.chat.system.transform — session-ID injection", () => {
  test("pushes 'Session ID: <id>' when sessionID is present", async () => {
    const input = {
      $: fakeShell(0, "[]"),
      directory: tmpdir(),
      client: fakeClient(),
    } as unknown as PluginInput

    const mod = await server(input, undefined)
    const transform = mod!["experimental.chat.system.transform"]
    expect(transform).toBeDefined()

    const output = { system: [] as string[] }
    await transform!({ sessionID: "abc-123" } as any, output)
    expect(output.system).toContain("Session ID: abc-123")
  })

  test("does not push anything when sessionID is absent", async () => {
    const input = {
      $: fakeShell(0, "[]"),
      directory: tmpdir(),
      client: fakeClient(),
    } as unknown as PluginInput

    const mod = await server(input, undefined)
    const transform = mod!["experimental.chat.system.transform"]

    const output = { system: [] as string[] }
    await transform!({} as any, output)
    expect(output.system).toHaveLength(0)
  })

  test("does not push anything when sessionID is empty string", async () => {
    const input = {
      $: fakeShell(0, "[]"),
      directory: tmpdir(),
      client: fakeClient(),
    } as unknown as PluginInput

    const mod = await server(input, undefined)
    const transform = mod!["experimental.chat.system.transform"]

    const output = { system: [] as string[] }
    await transform!({ sessionID: "" } as any, output)
    expect(output.system).toHaveLength(0)
  })
})

// ── Idempotency guard (I2) ────────────────────────────────────────────────────

describe("config hook idempotency guard", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(testBase(), "ocb-idem-test-"))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("invoking the hook twice on the same cfg does not duplicate skill paths", async () => {
    const mod = await server(
      {
        $: fakeShell(0, "[]"), // no plugins — hook completes normally
        directory: tmpDir,
        client: fakeClient(),
      } as unknown as PluginInput,
      undefined,
    )

    const cfg = { skills: { paths: [] } } as unknown as Config

    await mod!.config!(cfg)
    await mod!.config!(cfg)

    const paths = (cfg as unknown as { skills: { paths: string[] } }).skills.paths
    // Second invocation is a no-op: paths array should not have grown
    expect(paths.length).toBe((cfg as unknown as { skills: { paths: string[] } }).skills.paths.length)
  })
})
