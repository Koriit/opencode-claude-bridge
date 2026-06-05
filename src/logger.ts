/** Minimal duck-type for the OpenCode client — only the log() method we use. */
export interface LoggingClient {
  log(params: { service?: string; level?: "debug" | "info" | "warn" | "error"; message?: string }): unknown
}

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
 * Fallback output logger used when no real OpenCode client is available (tests,
 * edge-case early errors). Writes to process.stderr in OpenCode's structured
 * format and only when --print-logs is in argv — matching OpenCode's own
 * log-visibility behaviour.
 */
const fallbackLog = (() => {
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
 * Create a logger bound to the resolved `strict` flag and the OpenCode client.
 *
 * When a client is provided, log entries are posted to the server via
 * `client.log()` — they flow through OpenCode's own log pipeline, appear in
 * the log file, and respect `--print-logs` automatically.
 *
 * When no client is provided (tests, early-startup errors) the fallback logger
 * writes to process.stderr in the same format, gated on `--print-logs`.
 */
export function createLogger(strict: boolean, client?: LoggingClient): Logger {
  let warningCount = 0

  function logInfo(msg: string): void {
    if (typeof client?.log === "function") {
      void client.log({ service: "opencode-claude-bridge", level: "info", message: msg })
    } else {
      fallbackLog.info(msg)
    }
  }

  function logWarn(msg: string): void {
    if (typeof client?.log === "function") {
      void client.log({ service: "opencode-claude-bridge", level: "warn", message: msg })
    } else {
      fallbackLog.warn(msg)
    }
  }

  return {
    info(msg) {
      logInfo(msg)
    },
    warn(msg, opts) {
      const fatalInStrict = opts?.fatalInStrict ?? true
      warningCount++
      if (strict && fatalInStrict) throw new BridgeError(msg)
      logWarn(msg)
    },
    hadWarnings() {
      return warningCount > 0
    },
  }
}
