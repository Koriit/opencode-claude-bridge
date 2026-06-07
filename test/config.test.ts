import { describe, expect, test } from "bun:test"
import { parseBridgeConfig } from "../src/config.js"
import { DEFAULT_BRIDGE_CONFIG } from "../src/types.js"

describe("parseBridgeConfig", () => {
  test("undefined options yield defaults with no warnings", () => {
    const { config, warnings } = parseBridgeConfig(undefined)
    expect(config).toEqual(DEFAULT_BRIDGE_CONFIG)
    expect(warnings).toEqual([])
  })

  test("null options yield defaults with no warnings", () => {
    const { config, warnings } = parseBridgeConfig(null)
    expect(config).toEqual(DEFAULT_BRIDGE_CONFIG)
    expect(warnings).toEqual([])
  })

  test("returned blockedPlugins is a fresh array, not the shared default", () => {
    const { config } = parseBridgeConfig(undefined)
    expect(config.blockedPlugins).not.toBe(DEFAULT_BRIDGE_CONFIG.blockedPlugins)
    config.blockedPlugins.push("x")
    expect(DEFAULT_BRIDGE_CONFIG.blockedPlugins).toEqual([])
  })

  test("a non-object (string) is rejected with a warning and falls back to defaults", () => {
    const { config, warnings } = parseBridgeConfig("nope")
    expect(config).toEqual(DEFAULT_BRIDGE_CONFIG)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("expected an object")
  })

  test("an array is rejected (arrays are not plain options objects)", () => {
    const { warnings } = parseBridgeConfig([1, 2])
    expect(warnings[0]).toContain("got array")
  })

  test("honors the documented boolean and array keys", () => {
    const { config, warnings } = parseBridgeConfig({
      strict: true,
      blockedPlugins: ["a@mkt", "b@mkt"],
    })
    expect(warnings).toEqual([])
    expect(config).toEqual({
      mode: "mirror-claude",
      strict: true,
      blockedPlugins: ["a@mkt", "b@mkt"],
    })
  })

  test("an unsupported mode warns but still resolves to mirror-claude", () => {
    const { config, warnings } = parseBridgeConfig({ mode: "union" })
    expect(config.mode).toBe("mirror-claude")
    expect(warnings.some((w) => w.includes("union"))).toBe(true)
  })

  test("the documented mode produces no warning", () => {
    const { warnings } = parseBridgeConfig({ mode: "mirror-claude" })
    expect(warnings).toEqual([])
  })

  test("ill-typed booleans are dropped to defaults with a warning", () => {
    const { config, warnings } = parseBridgeConfig({ strict: 1 })
    expect(config.strict).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings.some((w) => w.includes("strict"))).toBe(true)
  })

  test("blockedPlugins that is not an array is dropped with a warning", () => {
    const { config, warnings } = parseBridgeConfig({ blockedPlugins: "a@mkt" })
    expect(config.blockedPlugins).toEqual([])
    expect(warnings[0]).toContain("blockedPlugins")
  })

  test("non-string entries in blockedPlugins are filtered out with a warning", () => {
    const { config, warnings } = parseBridgeConfig({ blockedPlugins: ["keep", 5, null, "also"] })
    expect(config.blockedPlugins).toEqual(["keep", "also"])
    expect(warnings.some((w) => w.includes("non-string"))).toBe(true)
  })

  test("unknown keys are reported and ignored", () => {
    const { config, warnings } = parseBridgeConfig({ strict: true, bogus: 1, mode2: "x" })
    expect(config.strict).toBe(true)
    expect(warnings.filter((w) => w.includes("unknown option"))).toHaveLength(2)
  })
})
