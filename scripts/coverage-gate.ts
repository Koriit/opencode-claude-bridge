/**
 * Global coverage gate for the opencode-claude-bridge unit suite.
 *
 * Runs `bun test --coverage test/` (with OCB_TMPDIR=.tmp), parses the
 * "All files" summary row from the text reporter, and exits non-zero if
 * global function coverage OR global line coverage falls below THRESHOLD.
 *
 * This script exists because Bun 1.3.14 applies both the scalar and table
 * forms of `bunfig.toml`'s `coverageThreshold` per-file. Two source files
 * (src/logger.ts, src/index.ts) report ~75% function coverage due to V8
 * instrumentation artifacts (a class-field initializer and an async
 * catch-handler counted as separate "functions" by V8 even though both are
 * fully exercised). A per-file threshold of ≥0.90 would always fail on those
 * artifacts. This script enforces the global 0.90 floor instead.
 *
 * Usage: bun run scripts/coverage-gate.ts
 * Exit 0: global funcs ≥ 0.90 AND global lines ≥ 0.90
 * Exit 1: threshold missed, or the coverage table could not be parsed
 */

import { spawnSync } from "node:child_process"

const THRESHOLD = 0.90
const ALL_FILES_RE = /^All files\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|/m

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

// Parse "All files" row from combined output.
const combined = (result.stdout ?? "") + (result.stderr ?? "")
const match = ALL_FILES_RE.exec(combined)

if (!match) {
  console.error(
    "coverage-gate: could not find the 'All files' summary row in bun test --coverage output.\n" +
    "The coverage table format may have changed on a Bun upgrade. Update scripts/coverage-gate.ts\n" +
    "to match the new format before loosening or removing the gate.",
  )
  process.exit(1)
}

const globalFuncs = parseFloat(match[1]!) / 100
const globalLines = parseFloat(match[2]!) / 100

const funcsPct = (globalFuncs * 100).toFixed(2)
const linesPct = (globalLines * 100).toFixed(2)
const threshPct = (THRESHOLD * 100).toFixed(0)

let failed = false

if (globalFuncs < THRESHOLD) {
  console.error(`coverage-gate: FAIL — global function coverage ${funcsPct}% < ${threshPct}% threshold`)
  failed = true
}
if (globalLines < THRESHOLD) {
  console.error(`coverage-gate: FAIL — global line coverage ${linesPct}% < ${threshPct}% threshold`)
  failed = true
}

if (!failed) {
  console.log(
    `coverage-gate: PASS — global functions ${funcsPct}%, lines ${linesPct}% (threshold ${threshPct}%)`,
  )
}

process.exit(failed ? 1 : 0)
