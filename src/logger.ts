/** Thrown when a soft warning is promoted to a hard error under `strict` mode. */
export class BridgeError extends Error {
  override name = "BridgeError"
}

/** Prefix every line the bridge emits so its output is greppable in OpenCode's logs. */
export const LOG_PREFIX = "[opencode-claude-bridge]"

export interface WarnOptions {
  /**
   * Whether this warning should be promoted to a hard error under `strict`.
   * Defaults to `true` (parse failures, missing CLI). Set `false` for advisory
   * warnings that must never abort the hook even in strict mode (e.g. the §9
   * version-range notice, which always still attempts injection).
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
 * Create a logger bound to the resolved `strict` flag. The hook itself is responsible
 * for catching {@link BridgeError} in non-strict paths; in strict mode it lets the
 * error propagate so OpenCode surfaces a hard failure (design §10).
 */
export function createLogger(strict: boolean): Logger {
  let warningCount = 0
  return {
    info(msg: string): void {
      console.log(`${LOG_PREFIX} ${msg}`)
    },
    warn(msg: string, opts?: WarnOptions): void {
      const fatalInStrict = opts?.fatalInStrict ?? true
      warningCount++
      if (strict && fatalInStrict) {
        throw new BridgeError(msg)
      }
      console.warn(`${LOG_PREFIX} warning: ${msg}`)
    },
    hadWarnings(): boolean {
      return warningCount > 0
    },
  }
}
