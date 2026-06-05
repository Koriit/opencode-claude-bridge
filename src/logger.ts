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
 * Internal output logger that writes to process.stderr in OpenCode's structured
 * log format: `LEVEL  ISO-timestamp +Xms service=opencode-claude-bridge <message>`
 *
 * Suppressed when --print-logs is absent — the plugin API has no log facility,
 * so this is the only way to match OpenCode's own log-visibility behaviour.
 */
const log = (() => {
  const enabled = process.argv.includes("--print-logs")
  let last = Date.now()

  function write(level: "INFO" | "WARN", msg: string): void {
    if (!enabled) return
    const now = Date.now()
    const ts = new Date(now).toISOString().split(".")[0]
    const diff = now - last
    last = now
    process.stderr.write(`${level.padEnd(5)} ${ts} +${diff}ms service=opencode-claude-bridge ${msg}\n`)
  }

  return {
    info: (msg: string) => write("INFO", msg),
    warn: (msg: string) => write("WARN", msg),
  }
})()

/**
 * Create a logger bound to the resolved `strict` flag. The hook itself is
 * responsible for catching {@link BridgeError} in non-strict paths; in strict
 * mode the error propagates so OpenCode surfaces a hard failure.
 */
export function createLogger(strict: boolean): Logger {
  let warningCount = 0
  return {
    info(msg) {
      log.info(msg)
    },
    warn(msg, opts) {
      const fatalInStrict = opts?.fatalInStrict ?? true
      warningCount++
      if (strict && fatalInStrict) throw new BridgeError(msg)
      log.warn(msg)
    },
    hadWarnings() {
      return warningCount > 0
    },
  }
}
