/** Thrown when a soft warning is promoted to a hard error under `strict` mode. */
export class BridgeError extends Error {
  override name = "BridgeError"
}

export interface WarnOptions {
  /**
   * Whether this warning should be promoted to a hard error under `strict`.
   * Defaults to `true` (parse failures, missing CLI). Set `false` for advisory
   * warnings that must never abort the hook even in strict mode.
   */
  fatalInStrict?: boolean
}

export interface Logger {
  /** Informational line (run summaries, resolved-plugin sets). Never throws. */
  info(msg: string): void
  /**
   * A warning. Under `strict` it throws {@link BridgeError} unless
   * `fatalInStrict: false` is passed.
   */
  warn(msg: string, opts?: WarnOptions): void
  /** Returns `true` if at least one `warn()` call was made on this logger instance. */
  hadWarnings(): boolean
}

/**
 * True when the process was launched with `--print-logs`.
 *
 * The plugin API has no logging facility — the bridge's only output channel is
 * stdout/stderr (console.log/warn). Writing unconditionally would make bridge
 * output appear in the terminal on every OpenCode launch regardless of whether
 * the user asked for logs. Gating on `--print-logs` mirrors how OpenCode itself
 * controls log visibility, even though the bridge cannot write into OpenCode's
 * structured log pipeline directly.
 */
const PRINT_LOGS = process.argv.includes("--print-logs")

/** Timestamp of the most recent emit, for computing the +Xms delta (mirrors OpenCode's log.ts). */
let lastEmitMs = Date.now()

/**
 * Emit one log line in OpenCode's structured log format:
 *   LEVEL  ISO-timestamp +Xms service=opencode-claude-bridge <message>
 *
 * Writes to process.stderr (same channel OpenCode uses with --print-logs).
 * Suppressed silently when --print-logs is absent, matching OpenCode's behaviour
 * of writing to the log file instead of the terminal in that case.
 */
function emit(level: "INFO" | "WARN", msg: string): void {
  if (!PRINT_LOGS) return
  const now = Date.now()
  const diff = now - lastEmitMs
  lastEmitMs = now
  // ISO timestamp without milliseconds — same truncation OpenCode uses.
  const ts = new Date(now).toISOString().split(".")[0]
  process.stderr.write(`${level.padEnd(5)} ${ts} +${diff}ms service=opencode-claude-bridge ${msg}\n`)
}

/**
 * Create a logger bound to the resolved `strict` flag. The hook itself is responsible
 * for catching {@link BridgeError} in non-strict paths; in strict mode it lets the
 * error propagate so OpenCode surfaces a hard failure.
 */
export function createLogger(strict: boolean): Logger {
  let warningCount = 0
  return {
    info(msg: string): void {
      emit("INFO", msg)
    },
    warn(msg: string, opts?: WarnOptions): void {
      const fatalInStrict = opts?.fatalInStrict ?? true
      warningCount++
      if (strict && fatalInStrict) {
        throw new BridgeError(msg)
      }
      emit("WARN", msg)
    },
    hadWarnings(): boolean {
      return warningCount > 0
    },
  }
}
