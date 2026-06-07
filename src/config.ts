import { DEFAULT_BRIDGE_CONFIG, type BridgeConfig } from "./types.js"

export interface ParsedBridgeConfig {
  config: BridgeConfig
  /**
   * Validation warnings collected while parsing. These are strict-promotable: the
   * caller replays them through the logger (which throws under `strict`). Parsing
   * itself is pure and never throws, so `strict` can be resolved first and the
   * logger built from it.
   */
  warnings: string[]
}

const DOCUMENTED_KEYS = new Set(["mode", "blockedPlugins", "strict"])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Parse the `opencode.json` plugin-tuple options into a {@link BridgeConfig}, honoring
 * only the documented keys (§4.2). Unknown keys and ill-typed values are dropped to
 * their defaults and reported as warnings. Pure and total — never throws.
 */
export function parseBridgeConfig(options: unknown): ParsedBridgeConfig {
  const config: BridgeConfig = {
    ...DEFAULT_BRIDGE_CONFIG,
    blockedPlugins: [...DEFAULT_BRIDGE_CONFIG.blockedPlugins],
  }
  const warnings: string[] = []

  if (options === undefined || options === null) {
    return { config, warnings }
  }
  if (!isPlainObject(options)) {
    warnings.push(
      `ignoring plugin options: expected an object, got ${Array.isArray(options) ? "array" : typeof options}`,
    )
    return { config, warnings }
  }

  if ("mode" in options) {
    if (options["mode"] !== "mirror-claude") {
      warnings.push(
        `unsupported mode ${JSON.stringify(options["mode"])}; only "mirror-claude" is supported, using it`,
      )
    }
    // mode is effectively hardcoded; nothing to assign beyond the default.
  }

  for (const key of ["strict"] as const) {
    if (key in options) {
      const value = options[key]
      if (typeof value === "boolean") {
        config[key] = value
      } else {
        warnings.push(`ignoring "${key}": expected boolean, got ${typeof value}`)
      }
    }
  }

  if ("blockedPlugins" in options) {
    const value = options["blockedPlugins"]
    if (Array.isArray(value)) {
      const strings = value.filter((v): v is string => typeof v === "string")
      if (strings.length !== value.length) {
        warnings.push(`ignoring non-string entries in "blockedPlugins"`)
      }
      config.blockedPlugins = strings
    } else {
      warnings.push(`ignoring "blockedPlugins": expected string[], got ${typeof value}`)
    }
  }

  for (const key of Object.keys(options)) {
    if (!DOCUMENTED_KEYS.has(key)) {
      warnings.push(`ignoring unknown option "${key}"`)
    }
  }

  return { config, warnings }
}
