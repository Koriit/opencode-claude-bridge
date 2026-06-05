/**
 * Minimal zero-dependency frontmatter parser for Claude command/agent/skill files.
 *
 * Claude frontmatter is a flat key-value YAML block. The fields we care about are all
 * scalar strings, booleans, or numbers. We parse only those and silently ignore anything
 * that requires full YAML parsing (nested maps, sequences, multi-line block scalars, etc.),
 * consistent with the lenient approach used in `skill-scan.ts` for skill name extraction.
 *
 * This deliberately avoids adding a `gray-matter` or any other npm dependency.
 */

const FENCE = "---"

/**
 * A parsed frontmatter block: the extracted flat scalar values and the markdown body
 * (everything after the closing `---` fence, trimmed).
 *
 * Fields that were present but not parseable as flat scalars are omitted (not reported
 * as errors — consistent with the lenient parse posture).
 */
export interface ParsedFrontmatter {
  data: Record<string, string | boolean | number>
  body: string
}

/**
 * Sentinel returned when the file has an opening `---` fence but no closing one.
 * Callers should skip the file and warn rather than treating the broken YAML as
 * a no-frontmatter plain-markdown file (§10).
 */
export const FRONTMATTER_PARSE_ERROR: unique symbol = Symbol("FRONTMATTER_PARSE_ERROR")
export type FrontmatterParseError = typeof FRONTMATTER_PARSE_ERROR

/**
 * Parse a markdown file's YAML frontmatter and return the flat scalar fields plus the body.
 *
 * Handles:
 *   - Bare values: `key: value`
 *   - Single- and double-quoted strings: `key: "value"` / `key: 'value'`
 *   - Booleans: `true` / `false` (case-insensitive)
 *   - Numbers: integer and floating-point decimal strings
 *
 * Ignores:
 *   - Lines that start with whitespace (nested YAML — inside a block scalar or map)
 *   - Lines whose value starts with `{`, `[`, or `|` (maps, sequences, block scalars)
 *   - YAML comments (`#`)
 *   - Anything that looks like a multi-line scalar continuation
 *
 * Returns:
 *   - `null` if the file does not begin with a `---` fence (no frontmatter — treat
 *     the whole file as the body).
 *   - `FRONTMATTER_PARSE_ERROR` if an opening fence is found but never closed —
 *     the caller must skip and warn rather than injecting broken YAML as body text (§10).
 *   - `ParsedFrontmatter` on success.
 */
export function parseFrontmatter(
  content: string,
): ParsedFrontmatter | null | FrontmatterParseError {
  const lines = content.split(/\r?\n/)

  // The file must start with the `---` fence at column 0.
  if (lines[0]?.trim() !== FENCE) return null

  // Find the closing fence.
  let closingIdx = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === FENCE) {
      closingIdx = i
      break
    }
  }
  // An unclosed fence means the file is malformed — returning null would silently
  // inject the broken YAML as the template/prompt body, violating §10.
  if (closingIdx === -1) return FRONTMATTER_PARSE_ERROR

  const data: Record<string, string | boolean | number> = {}
  const fmLines = lines.slice(1, closingIdx)

  for (const line of fmLines) {
    // Skip blank lines, indented lines (nested values), and YAML comments.
    if (!line || /^\s/.test(line) || line.trimStart().startsWith("#")) continue

    // Match `key: value` — key must start at column 0.
    const colonIdx = line.indexOf(":")
    if (colonIdx < 1) continue

    const key = line.slice(0, colonIdx).trim()
    if (!key) continue

    const rawValue = line.slice(colonIdx + 1).trim()

    // Skip empty values, block scalars (|, >), sequences ([), maps ({).
    if (!rawValue || rawValue[0] === "|" || rawValue[0] === ">" || rawValue[0] === "[" || rawValue[0] === "{")
      continue

    data[key] = parseScalar(rawValue)
  }

  const bodyLines = lines.slice(closingIdx + 1)
  const body = bodyLines.join("\n").trim()

  return { data, body }
}

/**
 * Parse a YAML scalar value into a TypeScript primitive.
 *
 * Handles quoted strings, booleans, and numbers. Anything that doesn't fit is
 * returned as a trimmed string (safe fallback for unknown values).
 */
function parseScalar(raw: string): string | boolean | number {
  // Quoted string: strip surrounding quotes (single or double).
  // Require both opening and closing quote to be the same character and the
  // string to be at least 2 chars long (a lone `"` or `'` is not a valid
  // YAML scalar — treat it as a bare string to avoid a silent empty result).
  const startsDouble = raw.startsWith('"')
  const startsSingle = raw.startsWith("'")
  const endsDouble = raw.endsWith('"')
  const endsSingle = raw.endsWith("'")
  if (raw.length >= 2) {
    if (startsDouble && endsDouble) return raw.slice(1, -1)
    if (startsSingle && endsSingle) return raw.slice(1, -1)
  }
  // Unbalanced quotes (e.g. `"missing closing`) are returned as-is — the
  // caller receives the literal value including the opening quote, which is
  // a better outcome than stripping half a pair and silently producing a
  // wrong name.

  // Boolean literals.
  const lower = raw.toLowerCase()
  if (lower === "true") return true
  if (lower === "false") return false

  // Numeric literal (integer or float; no octal/hex — YAML 1.2 only has these forms).
  // The regex already guarantees a finite decimal, so Number() cannot return NaN here.
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw)

  return raw
}
