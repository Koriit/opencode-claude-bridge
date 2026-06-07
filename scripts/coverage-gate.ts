/**
 * Coverage gate for the opencode-claude-bridge unit suite.
 *
 * Runs `bun test --coverage test/` (with OCB_TMPDIR=.tmp), parses the coverage
 * table, and exits non-zero if:
 *   - global function coverage OR global line coverage falls below GLOBAL_THRESHOLD (90%)
 *   - any individual `src/...` file's function or line coverage falls below
 *     PER_FILE_THRESHOLD (70%), unless that file is in ALLOWLIST
 *
 * The per-file floor catches whole untested features that hide under the global 90%
 * aggregate. Files in ALLOWLIST are excluded from the per-file check due to V8
 * instrumentation artifacts — class-field initializers and async catch-handlers are
 * counted as separate "functions" by V8 even though both are fully exercised. Keep
 * a file on the allowlist only as long as necessary; add a comment explaining why.
 *
 * Usage: bun run scripts/coverage-gate.ts
 * Exit 0: all floors met
 * Exit 1: any threshold missed, or the coverage table could not be parsed
 */

import { spawnSync } from "node:child_process"

const GLOBAL_THRESHOLD = 0.90
const PER_FILE_THRESHOLD = 0.70

/**
 * Files exempt from the per-file 70% floor because V8 instrumentation artifacts
 * inflate their "uncovered functions" count even when the code is fully exercised.
 */
const ALLOWLIST = new Set([
  "src/logger.ts",  // V8 counts the class-field initializer as a separate function
  "src/index.ts",   // V8 counts async catch-handler branches as separate functions
])

const ALL_FILES_RE = /^All files\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|/m
// Matches individual src/ rows: " src/foo.ts | 95.00 | 100.00 | ..."
const SRC_FILE_RE = /^\s+(src\/[^\s|]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|/

const result = spawnSync(
  "bun",
  ["test", "--coverage", "test/"],
  {
    env: { ...process.env, OCB_TMPDIR: ".tmp" },
    encoding: "utf8",
    // Bun writes coverage table to stderr in some versions; capture both.
    stdio: ["inherit", "pipe", "pipe"],
  },
)

// Surface all output to the terminal so the test results are visible.
if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)

// If bun test itself reported a test failure, propagate that immediately.
// The coverage check is additive — a failing suite never passes the gate.
if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

const combined = (result.stdout ?? "") + (result.stderr ?? "")

// ── Global floor ──────────────────────────────────────────────────────────────

const globalMatch = ALL_FILES_RE.exec(combined)

if (!globalMatch) {
  console.error(
    "coverage-gate: could not find the 'All files' summary row in bun test --coverage output.\n" +
    "The coverage table format may have changed on a Bun upgrade. Update scripts/coverage-gate.ts\n" +
    "to match the new format before loosening or removing the gate.",
  )
  process.exit(1)
}

const globalFuncs = parseFloat(globalMatch[1]!) / 100
const globalLines = parseFloat(globalMatch[2]!) / 100

const funcsPct = (globalFuncs * 100).toFixed(2)
const linesPct = (globalLines * 100).toFixed(2)
const globalThreshPct = (GLOBAL_THRESHOLD * 100).toFixed(0)

let failed = false

if (globalFuncs < GLOBAL_THRESHOLD) {
  console.error(`coverage-gate: FAIL — global function coverage ${funcsPct}% < ${globalThreshPct}% threshold`)
  failed = true
}
if (globalLines < GLOBAL_THRESHOLD) {
  console.error(`coverage-gate: FAIL — global line coverage ${linesPct}% < ${globalThreshPct}% threshold`)
  failed = true
}

// ── Per-file floor ────────────────────────────────────────────────────────────

const perFileThreshPct = (PER_FILE_THRESHOLD * 100).toFixed(0)

for (const line of combined.split("\n")) {
  const m = SRC_FILE_RE.exec(line)
  if (!m) continue

  const [, filePath, rawFuncs, rawLines] = m
  if (!filePath || rawFuncs === undefined || rawLines === undefined) {
    console.error(
      `coverage-gate: FAIL — could not parse coverage row: ${JSON.stringify(line)}\n` +
      "The coverage table format may have changed. Update scripts/coverage-gate.ts to match.",
    )
    failed = true
    continue
  }

  if (ALLOWLIST.has(filePath)) continue

  const fileFuncs = parseFloat(rawFuncs) / 100
  const fileLines = parseFloat(rawLines) / 100

  if (fileFuncs < PER_FILE_THRESHOLD) {
    console.error(
      `coverage-gate: FAIL — ${filePath} function coverage ${(fileFuncs * 100).toFixed(2)}% < ${perFileThreshPct}% per-file floor`,
    )
    failed = true
  }
  if (fileLines < PER_FILE_THRESHOLD) {
    console.error(
      `coverage-gate: FAIL — ${filePath} line coverage ${(fileLines * 100).toFixed(2)}% < ${perFileThreshPct}% per-file floor`,
    )
    failed = true
  }
}

if (!failed) {
  console.log(
    `coverage-gate: PASS — global functions ${funcsPct}%, lines ${linesPct}% (threshold ${globalThreshPct}%); per-file floor ${perFileThreshPct}% met`,
  )
}

process.exit(failed ? 1 : 0)
