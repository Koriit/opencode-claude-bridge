import { describe, expect, test } from "bun:test"
import { parseFrontmatter, FRONTMATTER_PARSE_ERROR, type ParsedFrontmatter } from "../src/frontmatter.js"

/** Narrow to ParsedFrontmatter, failing the test if the result is null or parse-error. */
function ok(r: ReturnType<typeof parseFrontmatter>): ParsedFrontmatter {
  if (r === null || r === FRONTMATTER_PARSE_ERROR) throw new Error(`expected ParsedFrontmatter, got ${String(r)}`)
  return r
}

describe("parseFrontmatter — absent frontmatter", () => {
  test("returns null when file does not start with ---", () => {
    expect(parseFrontmatter("just markdown")).toBeNull()
  })

  test("returns null when file starts with plain text before any fence", () => {
    expect(parseFrontmatter("Some text\n---\nkey: val\n---\nbody")).toBeNull()
  })

  test("returns FRONTMATTER_PARSE_ERROR when opening fence has no closing fence", () => {
    expect(parseFrontmatter("---\nkey: val\nbody")).toBe(FRONTMATTER_PARSE_ERROR)
  })

  test("returns null for empty string", () => {
    expect(parseFrontmatter("")).toBeNull()
  })
})

describe("parseFrontmatter — string scalars", () => {
  test("parses a bare string value", () => {
    const r = ok(parseFrontmatter("---\ndescription: My command\n---\nbody text"))
    expect(r.data["description"]).toBe("My command")
  })

  test("parses a double-quoted string", () => {
    const r = ok(parseFrontmatter('---\ndescription: "hello world"\n---\nbody'))
    expect(r.data["description"]).toBe("hello world")
  })

  test("parses a single-quoted string", () => {
    const r = ok(parseFrontmatter("---\ndescription: 'hello world'\n---\nbody"))
    expect(r.data["description"]).toBe("hello world")
  })

  test("single-char quote is NOT stripped (prevents empty-string slice)", () => {
    // A lone `"` satisfies both startsWith and endsWith for a 1-char string;
    // the length >= 2 guard prevents slicing it to an empty string.
    const r = ok(parseFrontmatter("---\nkey: \"\n---\nbody"))
    expect(r.data["key"]).toBe('"')
  })

  test("single-char single-quote is NOT stripped", () => {
    const r = ok(parseFrontmatter("---\nkey: '\n---\nbody"))
    expect(r.data["key"]).toBe("'")
  })
})

describe("parseFrontmatter — booleans", () => {
  test("parses true", () => {
    const r = ok(parseFrontmatter("---\nsubtask: true\n---\nbody"))
    expect(r.data["subtask"]).toBe(true)
  })

  test("parses false", () => {
    const r = ok(parseFrontmatter("---\nsubtask: false\n---\nbody"))
    expect(r.data["subtask"]).toBe(false)
  })

  test("parses True (case-insensitive)", () => {
    const r = ok(parseFrontmatter("---\nsubtask: True\n---\nbody"))
    expect(r.data["subtask"]).toBe(true)
  })
})

describe("parseFrontmatter — numbers", () => {
  test("parses an integer", () => {
    const r = ok(parseFrontmatter("---\nsteps: 10\n---\nbody"))
    expect(r.data["steps"]).toBe(10)
  })

  test("parses a float", () => {
    const r = ok(parseFrontmatter("---\ntemperature: 0.7\n---\nbody"))
    expect(r.data["temperature"]).toBe(0.7)
  })

  test("parses a negative number", () => {
    const r = ok(parseFrontmatter("---\noffset: -5\n---\nbody"))
    expect(r.data["offset"]).toBe(-5)
  })
})

describe("parseFrontmatter — unknown/complex keys are ignored", () => {
  test("skips list values (starting with [)", () => {
    const r = ok(parseFrontmatter("---\ntools: [bash, edit]\ndescription: ok\n---\nbody"))
    expect(r.data["tools"]).toBeUndefined()
    expect(r.data["description"]).toBe("ok")
  })

  test("skips map values (starting with {)", () => {
    const r = ok(parseFrontmatter("---\nmetadata: {key: val}\ndescription: ok\n---\nbody"))
    expect(r.data["metadata"]).toBeUndefined()
    expect(r.data["description"]).toBe("ok")
  })

  test("skips block scalar (|)", () => {
    const r = ok(parseFrontmatter("---\ncontent: |\n  block\ndescription: ok\n---\nbody"))
    expect(r.data["content"]).toBeUndefined()
    expect(r.data["description"]).toBe("ok")
  })

  test("skips indented lines (nested YAML)", () => {
    const r = ok(parseFrontmatter("---\n  nested: value\ndescription: top\n---\nbody"))
    expect(r.data["nested"]).toBeUndefined()
    expect(r.data["description"]).toBe("top")
  })

  test("unknown keys with scalar values are preserved", () => {
    const r = ok(parseFrontmatter("---\nallowed-tools: bash\n---\nbody"))
    expect(r.data["allowed-tools"]).toBe("bash")
  })
})

describe("parseFrontmatter — body extraction", () => {
  test("body is everything after the closing ---", () => {
    const r = ok(parseFrontmatter("---\nkey: val\n---\nHello world"))
    expect(r.body).toBe("Hello world")
  })

  test("body is trimmed", () => {
    const r = ok(parseFrontmatter("---\nkey: val\n---\n\n  Hello world  \n"))
    expect(r.body).toBe("Hello world")
  })

  test("empty body is an empty string", () => {
    const r = ok(parseFrontmatter("---\nkey: val\n---\n"))
    expect(r.body).toBe("")
  })

  test("body with multiple lines is preserved", () => {
    const r = ok(parseFrontmatter("---\nkey: val\n---\nLine 1\nLine 2\nLine 3"))
    expect(r.body).toBe("Line 1\nLine 2\nLine 3")
  })
})

describe("parseFrontmatter — multiple keys", () => {
  test("parses multiple keys from the same frontmatter block", () => {
    const r = ok(parseFrontmatter(
      "---\ndescription: A command\nsubtask: true\nsteps: 5\nmodel: anthropic/claude-3\n---\nBody",
    ))
    expect(r.data["description"]).toBe("A command")
    expect(r.data["subtask"]).toBe(true)
    expect(r.data["steps"]).toBe(5)
    expect(r.data["model"]).toBe("anthropic/claude-3")
    expect(r.body).toBe("Body")
  })
})

describe("parseFrontmatter — Windows line endings", () => {
  test("handles \\r\\n line endings", () => {
    const r = ok(parseFrontmatter("---\r\ndescription: hi\r\n---\r\nbody"))
    expect(r.data["description"]).toBe("hi")
    expect(r.body).toBe("body")
  })
})
