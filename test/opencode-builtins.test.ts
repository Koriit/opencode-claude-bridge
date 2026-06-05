import { describe, expect, test } from "bun:test"
import {
  BUILTIN_AGENT_NAMES,
  BUILTIN_COMMAND_NAMES,
  BUILTIN_SKILL_NAMES,
  EXTERNAL_SKILL_GLOB,
  EXTERNAL_SKILL_ROOTS,
  OPENCODE_SKILL_GLOB,
  PATHS_SKILL_GLOB,
  PINNED_OPENCODE_VERSION,
} from "../src/opencode-builtins.js"

// These tests serve as a machine-checkable manifest of the version-pinned
// constants and catch accidental edits. When the pinned version changes, these
// tests must be updated as part of the §9 re-validation process.

describe("PINNED_OPENCODE_VERSION", () => {
  test("records the verified version as a semver string", () => {
    expect(PINNED_OPENCODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe("BUILTIN_AGENT_NAMES", () => {
  test("contains all seven built-in agents verified at v1.15.10", () => {
    const expected = ["build", "plan", "general", "explore", "compaction", "title", "summary"]
    for (const name of expected) {
      expect(BUILTIN_AGENT_NAMES.has(name)).toBe(true)
    }
  })

  test("has exactly seven entries", () => {
    expect(BUILTIN_AGENT_NAMES.size).toBe(7)
  })
})

describe("BUILTIN_COMMAND_NAMES", () => {
  test("contains the two built-in commands verified at v1.15.10", () => {
    expect(BUILTIN_COMMAND_NAMES.has("init")).toBe(true)
    expect(BUILTIN_COMMAND_NAMES.has("review")).toBe(true)
  })

  test("has exactly two entries", () => {
    expect(BUILTIN_COMMAND_NAMES.size).toBe(2)
  })
})

describe("BUILTIN_SKILL_NAMES", () => {
  test("contains the one built-in skill verified at v1.15.10", () => {
    expect(BUILTIN_SKILL_NAMES.has("customize-opencode")).toBe(true)
  })

  test("has exactly one entry", () => {
    expect(BUILTIN_SKILL_NAMES.size).toBe(1)
  })
})

describe("Skill discovery glob patterns", () => {
  test("EXTERNAL_SKILL_GLOB matches the OpenCode source constant", () => {
    expect(EXTERNAL_SKILL_GLOB).toBe("skills/**/SKILL.md")
  })

  test("OPENCODE_SKILL_GLOB matches the OpenCode source constant", () => {
    expect(OPENCODE_SKILL_GLOB).toBe("{skill,skills}/**/SKILL.md")
  })

  test("PATHS_SKILL_GLOB matches the OpenCode source constant", () => {
    expect(PATHS_SKILL_GLOB).toBe("**/SKILL.md")
  })

  test("EXTERNAL_SKILL_ROOTS contains both external dir names", () => {
    expect(EXTERNAL_SKILL_ROOTS).toContain(".claude")
    expect(EXTERNAL_SKILL_ROOTS).toContain(".agents")
    expect(EXTERNAL_SKILL_ROOTS).toHaveLength(2)
  })
})
