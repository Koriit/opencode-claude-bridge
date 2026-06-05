import { createHash } from "node:crypto"

/**
 * The result of a name-claim operation.
 *
 * @property name - The final allocated name (may be prefixed if the bare name collided).
 * @property renamed - `true` when the bare name was not available and a prefix was applied.
 */
export interface ClaimResult {
  readonly name: string
  readonly renamed: boolean
}

/**
 * A family-agnostic name allocator that enforces the §7 no-shadowing invariant.
 *
 * Seed it with the set of already-existing names (native config items + built-ins + any
 * names already registered by earlier allocator instances), then call `claim` for each
 * component in the id-sorted plugin order that `selectEnabledPlugins` produces. The
 * allocator accumulates claimed names so that later claims in the same run see all prior
 * allocations — giving deterministic first-wins-by-id semantics across plugins.
 *
 * The rename ladder (§7), tried in order until a free slot is found:
 *   1. `bareName`
 *   2. `<plugin>-<bareName>`
 *   3. `<marketplace>-<plugin>-<bareName>`
 *   4. `<marketplace>-<plugin>-<bareName>-<shortHash>` (deterministic tiebreak)
 *
 * `<plugin>` and `<marketplace>` are derived by splitting the plugin id `name@marketplace`.
 * The short hash is the first 8 hex characters of a SHA-256 over
 * `${marketplace}/${plugin}/${bareName}`, so it is deterministic across runs for the same
 * triple — a collision at rung 3 always resolves to the same name.
 *
 * Native/existing items are never renamed — only the bridge's claimant is prefixed.
 */
export class NameAllocator {
  /** All names currently considered taken (native + previously claimed). */
  private readonly taken: Set<string>

  /**
   * @param existing - Names already in use (native config keys + built-in lists).
   *   A snapshot is taken; mutations to the passed set after construction are ignored.
   */
  constructor(existing: ReadonlySet<string> | Iterable<string>) {
    this.taken = new Set(existing)
  }

  /**
   * Attempt to allocate `bareName` on behalf of `pluginId`.
   *
   * `pluginId` must be in `name@marketplace` format. If the bare name is already taken,
   * the rename ladder is walked until a free slot is found (the hash rung is the final
   * fallback and always produces a unique name). The winning name is recorded as taken so
   * subsequent claims see it.
   */
  claim(pluginId: string, bareName: string): ClaimResult {
    const { plugin, marketplace } = splitPluginId(pluginId)

    // Rung 1: bare name
    if (!this.taken.has(bareName)) {
      this.taken.add(bareName)
      return { name: bareName, renamed: false }
    }

    // Rung 2: <plugin>-<bareName>
    const rung2 = `${plugin}-${bareName}`
    if (!this.taken.has(rung2)) {
      this.taken.add(rung2)
      return { name: rung2, renamed: true }
    }

    // Rung 3: <marketplace>-<plugin>-<bareName>
    const rung3 = `${marketplace}-${plugin}-${bareName}`
    if (!this.taken.has(rung3)) {
      this.taken.add(rung3)
      return { name: rung3, renamed: true }
    }

    // Rung 4: <marketplace>-<plugin>-<bareName>-<shortHash> (deterministic final tiebreak)
    const hash = shortHash(marketplace, plugin, bareName)
    const rung4 = `${marketplace}-${plugin}-${bareName}-${hash}`
    this.taken.add(rung4)
    return { name: rung4, renamed: true }
  }

  /**
   * Return a snapshot of all currently-taken names, including everything registered
   * by prior `claim` calls. Useful for seeding a child allocator or for inspection.
   */
  snapshot(): ReadonlySet<string> {
    return new Set(this.taken)
  }
}

/**
 * Split a plugin id of the form `name@marketplace` into its two parts.
 *
 * If the id is malformed (no `@`), the whole string is used as the plugin part
 * and marketplace defaults to `"unknown"` — matching how the bridge logs unknown
 * marketplace entries rather than hard-failing.
 */
export function splitPluginId(pluginId: string): { plugin: string; marketplace: string } {
  const at = pluginId.indexOf("@")
  if (at === -1) return { plugin: pluginId, marketplace: "unknown" }
  return {
    plugin: pluginId.slice(0, at),
    marketplace: pluginId.slice(at + 1),
  }
}

/**
 * Compute the 8-hex-character short hash used in rung-4 tiebreak names.
 *
 * Deterministic: for the same `(marketplace, plugin, bareName)` triple this always
 * returns the same string, across runs and machines. Uses SHA-256 from `node:crypto`.
 */
export function shortHash(marketplace: string, plugin: string, bareName: string): string {
  return createHash("sha256")
    .update(`${marketplace}/${plugin}/${bareName}`)
    .digest("hex")
    .slice(0, 8)
}
