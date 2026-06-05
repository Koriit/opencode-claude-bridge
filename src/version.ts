import type { Logger } from "./logger.js"

/**
 * Supported OpenCode version range. The injection approach relies on OpenCode-*internal*
 * behavior (a shared mutable config object + lazy-after-`plugin.init()` service init) that
 * is not a documented public contract, so the bridge pins a conservative same-minor window
 * and warns outside it. Widen only when the e2e canary passes against a new version (§9).
 */
export const SUPPORTED_OPENCODE_RANGE = ">=1.15.0 <1.16.0"

/** The OpenCode version the design and range were verified against (§9). */
export const VERIFIED_OPENCODE_VERSION = "1.15.10"

interface Semver {
  major: number
  minor: number
  patch: number
}

/**
 * Parse a `major.minor.patch` string, tolerating a leading `v` and ignoring any
 * prerelease/build suffix (`-rc.1`, `+build`). Returns `null` if the core triple is
 * not three integers.
 */
export function parseSemver(version: string): Semver | null {
  // Anchored end so trailing garbage ("1.2.3abc", "1.2.3.4") is rejected rather than
  // silently truncated to a bogus triple; only a `-prerelease` / `+build` suffix is allowed.
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

function compare(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

const COMPARATORS: Record<string, (cmp: number) => boolean> = {
  ">=": (c) => c >= 0,
  "<=": (c) => c <= 0,
  ">": (c) => c > 0,
  "<": (c) => c < 0,
  "=": (c) => c === 0,
}

/**
 * Test `version` against a space-separated AND range of simple comparator clauses
 * (e.g. `">=1.15.0 <1.16.0"`). Returns `false` if `version` is unparseable or any
 * clause is malformed — callers treat that as "outside the supported range".
 */
export function satisfiesRange(version: string, range: string): boolean {
  const parsed = parseSemver(version)
  if (!parsed) return false

  const clauses = range.trim().split(/\s+/).filter(Boolean)
  for (const clause of clauses) {
    const match = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(clause)
    if (!match) return false
    const op = match[2] === undefined ? null : (match[1] ?? "=")
    const bound = parseSemver(match[2]!)
    if (op === null || !bound) return false
    if (!COMPARATORS[op]!(compare(parsed, bound))) return false
  }
  return true
}

/**
 * Read the running OpenCode version from the live HTTP server's health endpoint.
 *
 * This is the only mechanism available to an external plugin: the v1 `input.client`
 * exposes no version method, there is no `OPENCODE_VERSION` env var at runtime, and the
 * build-time define global is not visible outside OpenCode's own bundle. The endpoint is
 * mounted at the server root (`GET /global/health` → `{ healthy, version }`) and the HTTP
 * server is already running before `plugin.init()` fires, so calling it from the config
 * hook is safe and touches none of the lazy component services.
 *
 * Returns `null` on any failure (network, parse, missing field) — the caller degrades to
 * "version unknown" rather than blocking injection.
 */
export async function fetchOpencodeVersion(serverUrl: URL): Promise<string | null> {
  try {
    const res = await fetch(new URL("/global/health", serverUrl))
    if (!res.ok) return null
    const body = (await res.json()) as { version?: unknown }
    return typeof body.version === "string" ? body.version : null
  } catch {
    return null
  }
}

/**
 * Compare the running version against {@link SUPPORTED_OPENCODE_RANGE} and emit the §9
 * advisory warning when it falls outside. This warning is **always soft** — even under
 * `strict`, the bridge still attempts injection (the e2e suite is the real canary). A
 * `null` version (health unreachable) is reported as an inability to verify, not a failure.
 */
export function checkVersion(version: string | null, logger: Logger): void {
  if (version === null) {
    logger.warn(
      `could not determine the running OpenCode version; proceeding (supported range ${SUPPORTED_OPENCODE_RANGE})`,
      { fatalInStrict: false },
    )
    return
  }
  if (!satisfiesRange(version, SUPPORTED_OPENCODE_RANGE)) {
    logger.warn(
      `untested OpenCode version ${version} (supported range ${SUPPORTED_OPENCODE_RANGE}) — bridge may misbehave; attempting injection anyway`,
      { fatalInStrict: false },
    )
  }
}
