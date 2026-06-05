import { afterEach, describe, expect, test } from "bun:test"
import { createLogger } from "../src/logger.js"
import {
  checkVersion,
  fetchOpencodeVersion,
  parseSemver,
  satisfiesRange,
  SUPPORTED_OPENCODE_RANGE,
  VERIFIED_OPENCODE_VERSION,
} from "../src/version.js"

describe("parseSemver", () => {
  test("parses a plain triple", () => {
    expect(parseSemver("1.15.10")).toEqual({ major: 1, minor: 15, patch: 10 })
  })
  test("tolerates a leading v and a prerelease/build suffix", () => {
    expect(parseSemver("v2.0.1-rc.3+build.5")).toEqual({ major: 2, minor: 0, patch: 1 })
  })
  test("rejects a non-triple", () => {
    expect(parseSemver("1.15")).toBeNull()
    expect(parseSemver("nonsense")).toBeNull()
  })
  test("rejects trailing garbage rather than truncating it", () => {
    expect(parseSemver("1.15.0abc")).toBeNull()
    expect(parseSemver("1.15.10.99")).toBeNull()
  })
  test("tolerates a +build suffix without a prerelease component", () => {
    expect(parseSemver("1.2.3+build.1")).toEqual({ major: 1, minor: 2, patch: 3 })
  })
})

describe("satisfiesRange against the supported window", () => {
  test("the verified version is in range", () => {
    expect(satisfiesRange(VERIFIED_OPENCODE_VERSION, SUPPORTED_OPENCODE_RANGE)).toBe(true)
  })
  test("the lower bound is inclusive", () => {
    expect(satisfiesRange("1.15.0", SUPPORTED_OPENCODE_RANGE)).toBe(true)
  })
  test("the upper bound is exclusive", () => {
    expect(satisfiesRange("1.16.0", SUPPORTED_OPENCODE_RANGE)).toBe(false)
  })
  test("a lower minor is out of range", () => {
    expect(satisfiesRange("1.14.99", SUPPORTED_OPENCODE_RANGE)).toBe(false)
  })
  test("a higher major is out of range", () => {
    expect(satisfiesRange("2.0.0", SUPPORTED_OPENCODE_RANGE)).toBe(false)
  })
  test("an unparseable version is treated as out of range", () => {
    expect(satisfiesRange("dev", SUPPORTED_OPENCODE_RANGE)).toBe(false)
  })
})

describe("satisfiesRange comparator coverage", () => {
  test("bare version is treated as equality", () => {
    expect(satisfiesRange("1.2.3", "1.2.3")).toBe(true)
    expect(satisfiesRange("1.2.4", "1.2.3")).toBe(false)
  })
  test("<= and >= boundaries", () => {
    expect(satisfiesRange("1.2.3", ">=1.0.0 <=1.2.3")).toBe(true)
    expect(satisfiesRange("1.2.4", ">=1.0.0 <=1.2.3")).toBe(false)
  })
  test("a malformed clause fails closed", () => {
    expect(satisfiesRange("1.2.3", ">=??")).toBe(false)
  })
})

describe("checkVersion warnings", () => {
  let warnings: string[]
  const logger = {
    info: () => {},
    warn: (msg: string) => { warnings.push(msg) },
    hadWarnings: () => warnings.length > 0,
  }
  // reset before each via fresh array
  function collect(version: string | null): string[] {
    warnings = []
    checkVersion(version, logger)
    return warnings
  }

  test("in-range version emits no warning", () => {
    expect(collect(VERIFIED_OPENCODE_VERSION)).toEqual([])
  })
  test("out-of-range version warns", () => {
    const w = collect("1.16.5")
    expect(w).toHaveLength(1)
    expect(w[0]).toContain("untested OpenCode version 1.16.5")
  })
  test("unknown version warns about inability to verify", () => {
    const w = collect(null)
    expect(w).toHaveLength(1)
    expect(w[0]).toContain("could not determine")
  })

  test("the version warning is never fatal, even under strict", () => {
    const strictLogger = createLogger(true)
    // Control: this strict logger really does promote a default warning to a throw,
    // so the assertions below prove checkVersion opts out (fatalInStrict: false), not
    // that the logger is somehow lenient.
    expect(() => strictLogger.warn("control")).toThrow()
    expect(() => checkVersion("1.16.5", strictLogger)).not.toThrow()
    expect(() => checkVersion(null, strictLogger)).not.toThrow()
  })
})

describe("package.json supportedRange stays in sync with SUPPORTED_OPENCODE_RANGE", () => {
  test("package.json opencode.supportedRange matches the code constant", async () => {
    // This assertion fails CI when someone bumps the constant in version.ts but
    // forgets to update the package.json field (or vice versa).
    const pkg = await import("../package.json", { with: { type: "json" } })
    const recorded = (pkg.default as { opencode?: { supportedRange?: string } }).opencode?.supportedRange
    expect(recorded).toBe(SUPPORTED_OPENCODE_RANGE)
  })
})

describe("fetchOpencodeVersion", () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test("returns the version string from a healthy response", async () => {
    let requested: string | undefined
    globalThis.fetch = (async (input: string | URL | Request) => {
      requested = input.toString()
      return new Response(JSON.stringify({ healthy: true, version: "1.15.10" }), { status: 200 })
    }) as unknown as typeof fetch
    const v = await fetchOpencodeVersion(new URL("http://localhost:4096/"))
    expect(v).toBe("1.15.10")
    expect(requested).toBe("http://localhost:4096/global/health")
  })

  test("returns null on a non-ok response", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch
    expect(await fetchOpencodeVersion(new URL("http://localhost:4096/"))).toBeNull()
  })

  test("returns null when the body lacks a string version", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ healthy: true }), { status: 200 })) as unknown as typeof fetch
    expect(await fetchOpencodeVersion(new URL("http://localhost:4096/"))).toBeNull()
  })

  test("returns null when fetch throws", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch
    expect(await fetchOpencodeVersion(new URL("http://localhost:4096/"))).toBeNull()
  })
})
