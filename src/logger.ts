import type { PluginInput } from "@opencode-ai/plugin"

/** The subset of the OpenCode client the logger needs: `app.log`. */
type LogClient = PluginInput["client"]

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
 * Create a logger that writes through OpenCode's `client.app.log` endpoint —
 * the proper plugin logging channel. Entries land in the server logs under the
 * `opencode-claude-bridge` service and honor OpenCode's own log configuration.
 *
 * Logging is fire-and-forget: the POST is not awaited and any failure is
 * swallowed so logging can never disrupt the config hook.
 *
 * The hook itself is responsible for catching {@link BridgeError} in non-strict
 * paths; in strict mode the error propagates so OpenCode surfaces a hard failure.
 */
export function createLogger(client: LogClient, strict: boolean): Logger {
  let warningCount = 0

  const emit = (level: "info" | "warn", message: string): void => {
    try {
      void client.app
        .log({ body: { service: "opencode-claude-bridge", level, message } })
        .catch(() => {})
    } catch {
      // Best-effort: never let a logging failure escape into the hook.
    }
  }

  return {
    info(msg) {
      emit("info", msg)
    },
    warn(msg, opts) {
      const fatalInStrict = opts?.fatalInStrict ?? true
      warningCount++
      emit("warn", msg)
      if (strict && fatalInStrict) throw new BridgeError(msg)
    },
    hadWarnings() {
      return warningCount > 0
    },
  }
}
