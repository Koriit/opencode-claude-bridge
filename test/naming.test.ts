import { describe, expect, test } from "bun:test"
import { NameAllocator, splitPluginId, shortHash } from "../src/naming.js"
import {
  BUILTIN_AGENT_NAMES,
  BUILTIN_COMMAND_NAMES,
  BUILTIN_SKILL_NAMES,
} from "../src/opencode-builtins.js"

// ── splitPluginId ─────────────────────────────────────────────────────────────

describe("splitPluginId", () => {
  test("splits a well-formed id at the @ sign", () => {
    expect(splitPluginId("kio-development@kontakt")).toEqual({
      plugin: "kio-development",
      marketplace: "kontakt",
    })
  })

  test("handles an id with multiple @ signs (takes the first)", () => {
    expect(splitPluginId("plugin@market@extra")).toEqual({
      plugin: "plugin",
      marketplace: "market@extra",
    })
  })

  test("returns unknown marketplace when @ is absent", () => {
    expect(splitPluginId("standalone")).toEqual({
      plugin: "standalone",
      marketplace: "unknown",
    })
  })
})

// ── shortHash ─────────────────────────────────────────────────────────────────

describe("shortHash", () => {
  test("returns exactly 8 hex characters", () => {
    const h = shortHash("mkt", "plugin", "name")
    expect(h).toMatch(/^[0-9a-f]{8}$/)
  })

  test("is deterministic across calls", () => {
    const h1 = shortHash("marketplace", "myplugin", "command")
    const h2 = shortHash("marketplace", "myplugin", "command")
    expect(h1).toBe(h2)
  })

  test("differs for different inputs", () => {
    const h1 = shortHash("m", "p", "name")
    const h2 = shortHash("m", "p", "other")
    expect(h1).not.toBe(h2)
  })
})

// ── NameAllocator — basic claims ──────────────────────────────────────────────

describe("NameAllocator — bare name available", () => {
  test("returns the bare name unchanged when nothing collides", () => {
    const alloc = new NameAllocator(new Set())
    expect(alloc.claim("plugin@mkt", "audit")).toEqual({ name: "audit", renamed: false })
  })

  test("records the claimed name so a second claim sees it as taken", () => {
    const alloc = new NameAllocator(new Set())
    alloc.claim("a@mkt", "audit")
    const second = alloc.claim("b@mkt", "audit")
    expect(second.renamed).toBe(true)
    expect(second.name).not.toBe("audit")
  })
})

// ── NameAllocator — collision with native cfg items ───────────────────────────

describe("NameAllocator — collision with native config items", () => {
  test("rung-1 collision with a cfg.command key → rung-2 plugin-prefix", () => {
    // cfg.command already has "deploy"
    const alloc = new NameAllocator(new Set(["deploy"]))
    const result = alloc.claim("myplug@acme", "deploy")
    expect(result).toEqual({ name: "myplug-deploy", renamed: true })
  })

  test("rung-1 collision with a cfg.agent key → rung-2 plugin-prefix", () => {
    const alloc = new NameAllocator(new Set(["review-agent"]))
    const result = alloc.claim("myplug@acme", "review-agent")
    expect(result).toEqual({ name: "myplug-review-agent", renamed: true })
  })

  test("native item remains untouched — only the new claim is renamed", () => {
    const existing = new Set(["deploy"])
    const alloc = new NameAllocator(existing)
    alloc.claim("plug@mkt", "deploy")
    // The original "deploy" is still in the snapshot (it was seeded, not added by claim)
    expect(alloc.snapshot().has("deploy")).toBe(true)
  })
})

// ── NameAllocator — collision with built-ins (not in cfg) ────────────────────

describe("NameAllocator — collision with built-ins", () => {
  test("a bridge command named 'init' (built-in) is prefixed", () => {
    const alloc = new NameAllocator(BUILTIN_COMMAND_NAMES)
    const result = alloc.claim("tool@acme", "init")
    expect(result.renamed).toBe(true)
    expect(result.name).toBe("tool-init")
  })

  test("a bridge command named 'review' (built-in) is prefixed", () => {
    const alloc = new NameAllocator(BUILTIN_COMMAND_NAMES)
    const result = alloc.claim("mytool@mkt", "review")
    expect(result.renamed).toBe(true)
    expect(result.name).toBe("mytool-review")
  })

  test("a bridge agent named 'build' (built-in) is prefixed", () => {
    const alloc = new NameAllocator(BUILTIN_AGENT_NAMES)
    const result = alloc.claim("ci@mkt", "build")
    expect(result.renamed).toBe(true)
    expect(result.name).toBe("ci-build")
  })

  test("a bridge agent named 'general' (built-in) is prefixed", () => {
    const alloc = new NameAllocator(BUILTIN_AGENT_NAMES)
    const result = alloc.claim("assistant@hub", "general")
    expect(result.renamed).toBe(true)
    expect(result.name).toBe("assistant-general")
  })

  test("a bridge skill named 'customize-opencode' (built-in) is prefixed", () => {
    const alloc = new NameAllocator(BUILTIN_SKILL_NAMES)
    const result = alloc.claim("myplugin@mkt", "customize-opencode")
    expect(result.renamed).toBe(true)
    expect(result.name).toBe("myplugin-customize-opencode")
  })

  test("non-colliding built-in names do not interfere", () => {
    const alloc = new NameAllocator(BUILTIN_COMMAND_NAMES)
    const result = alloc.claim("plug@mkt", "deploy")
    expect(result).toEqual({ name: "deploy", renamed: false })
  })
})

// ── NameAllocator — intra-bridge collisions ───────────────────────────────────

describe("NameAllocator — intra-bridge collisions (two plugins, same bare name)", () => {
  test("first plugin (sorted first by id) keeps the bare name; later plugin is prefixed", () => {
    // selectEnabledPlugins sorts by id, so "a@mkt" < "b@mkt"
    const alloc = new NameAllocator(new Set())
    const first = alloc.claim("a@mkt", "audit")
    const second = alloc.claim("b@mkt", "audit")
    expect(first).toEqual({ name: "audit", renamed: false })
    expect(second).toEqual({ name: "b-audit", renamed: true })
  })

  test("deterministic: same inputs always produce the same order-dependent outcome", () => {
    const run = () => {
      const alloc = new NameAllocator(new Set())
      return {
        first: alloc.claim("alpha@mkt", "deploy"),
        second: alloc.claim("beta@mkt", "deploy"),
      }
    }
    const r1 = run()
    const r2 = run()
    expect(r1.first.name).toBe(r2.first.name)
    expect(r1.second.name).toBe(r2.second.name)
  })

  test("three plugins all claiming the same name yield three distinct names", () => {
    const alloc = new NameAllocator(new Set())
    const r1 = alloc.claim("a@mkt", "check")
    const r2 = alloc.claim("b@mkt", "check")
    const r3 = alloc.claim("c@mkt", "check")
    const names = [r1.name, r2.name, r3.name]
    expect(new Set(names).size).toBe(3)
    expect(r1.renamed).toBe(false)
    expect(r2.renamed).toBe(true)
    expect(r3.renamed).toBe(true)
  })
})

// ── NameAllocator — full rename ladder ───────────────────────────────────────

describe("NameAllocator — full rename ladder escalation", () => {
  // To force every rung we pre-seed all the intermediate names.
  // Plugin id: "myplugin@mymarket"
  // bare name: "lint"
  // rung-1: "lint"
  // rung-2: "myplugin-lint"
  // rung-3: "mymarket-myplugin-lint"
  // rung-4: "mymarket-myplugin-lint-<hash>"

  const PLUGIN_ID = "myplugin@mymarket"
  const BARE = "lint"
  const RUNG2 = "myplugin-lint"
  const RUNG3 = "mymarket-myplugin-lint"
  const RUNG4 = `mymarket-myplugin-lint-${shortHash("mymarket", "myplugin", "lint")}`

  test("rung-1 → bare name when no collision", () => {
    const alloc = new NameAllocator(new Set())
    expect(alloc.claim(PLUGIN_ID, BARE)).toEqual({ name: BARE, renamed: false })
  })

  test("rung-2 → plugin-prefix when bare name is taken", () => {
    const alloc = new NameAllocator(new Set([BARE]))
    expect(alloc.claim(PLUGIN_ID, BARE)).toEqual({ name: RUNG2, renamed: true })
  })

  test("rung-3 → marketplace-plugin-prefix when rungs 1 and 2 are taken", () => {
    const alloc = new NameAllocator(new Set([BARE, RUNG2]))
    expect(alloc.claim(PLUGIN_ID, BARE)).toEqual({ name: RUNG3, renamed: true })
  })

  test("rung-4 → hash tiebreak when rungs 1, 2, and 3 are all taken", () => {
    const alloc = new NameAllocator(new Set([BARE, RUNG2, RUNG3]))
    expect(alloc.claim(PLUGIN_ID, BARE)).toEqual({ name: RUNG4, renamed: true })
  })

  test("rung-4 name has the expected format (marketplace-plugin-bare-8hexchars)", () => {
    expect(RUNG4).toMatch(/^mymarket-myplugin-lint-[0-9a-f]{8}$/)
  })

  test("rung-4 is deterministic — same name on every call", () => {
    const alloc1 = new NameAllocator(new Set([BARE, RUNG2, RUNG3]))
    const alloc2 = new NameAllocator(new Set([BARE, RUNG2, RUNG3]))
    expect(alloc1.claim(PLUGIN_ID, BARE).name).toBe(alloc2.claim(PLUGIN_ID, BARE).name)
  })
})

// ── NameAllocator — snapshot ──────────────────────────────────────────────────

describe("NameAllocator — snapshot", () => {
  test("snapshot includes seeded names plus all claimed names", () => {
    const alloc = new NameAllocator(new Set(["existing"]))
    alloc.claim("p@m", "new-item")
    const snap = alloc.snapshot()
    expect(snap.has("existing")).toBe(true)
    expect(snap.has("new-item")).toBe(true)
  })

  test("snapshot is a copy — mutating it does not affect the allocator", () => {
    const alloc = new NameAllocator(new Set())
    alloc.claim("p@m", "a")
    const snap = alloc.snapshot() as Set<string>
    snap.add("injected")
    // The allocator should not see "injected"
    const result = alloc.claim("p@m", "injected")
    expect(result).toEqual({ name: "injected", renamed: false })
  })
})

// ── NameAllocator — cross-claim tracking ────────────────────────────────────

describe("NameAllocator — cross-plugin claim tracking", () => {
  test("a name claimed by one plugin is seen as taken by subsequent plugins", () => {
    const alloc = new NameAllocator(new Set())
    alloc.claim("a@m", "feature")
    // "b@m" wants the same bare name — "a@m" already claimed it
    const result = alloc.claim("b@m", "feature")
    expect(result.name).not.toBe("feature")
    expect(result.renamed).toBe(true)
  })

  test("plugin-prefixed rung-2 is also tracked across subsequent claims", () => {
    // If "b@m" claimed "b-feature" at rung-2, "c@m" cannot also get "b-feature"
    const alloc = new NameAllocator(new Set(["feature"]))
    alloc.claim("b@m", "feature") // gets "b-feature"
    const result = alloc.claim("b@m", "feature") // tries again — "b-feature" already taken
    expect(result.name).not.toBe("b-feature")
  })
})
