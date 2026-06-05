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
 * Resolve the core log module at runtime by hitting Bun's module registry.
 *
 * @opencode-ai/core is private and not on npm, but the host Bun Worker already
 * executed `import * as Log from "@opencode-ai/core/util/log"` and called
 * `Log.init({ print: ... })`. A dynamic import of the same specifier returns
 * the cached, fully-configured instance — so output correctly goes to stderr
 * (with --print-logs) or the log file (default), with no argv check needed.
 *
 * Falls back to direct stderr writes when the import fails (tests, or if the
 * module path changes in a future OpenCode version).
 */
async function resolveCoreLog() {
  try {
    return await import("@opencode-ai/core/util/log")
  } catch {
    return null
  }
}

const coreLogPromise = resolveCoreLog()

function fallbackWrite(level: "INFO" | "WARN", msg: string): void {
  const ts = new Date().toISOString().split(".")[0]
  process.stderr.write(`${level.padEnd(5)} ${ts} service=opencode-claude-bridge ${msg}\n`)
}

async function emit(level: "INFO" | "WARN", msg: string): Promise<void> {
  const core = await coreLogPromise
  if (core) {
    const svc = core.create({ service: "opencode-claude-bridge" })
    if (level === "INFO") svc.info(msg)
    else svc.warn(msg)
  } else {
    fallbackWrite(level, msg)
  }
}

/**
 * Create a logger bound to the resolved `strict` flag. The hook itself is
 * responsible for catching {@link BridgeError} in non-strict paths; in strict
 * mode the error propagates so OpenCode surfaces a hard failure.
 */
export function createLogger(strict: boolean): Logger {
  let warningCount = 0
  return {
    info(msg) {
      void emit("INFO", msg)
    },
    warn(msg, opts) {
      const fatalInStrict = opts?.fatalInStrict ?? true
      warningCount++
      if (strict && fatalInStrict) throw new BridgeError(msg)
      void emit("WARN", msg)
    },
    hadWarnings() {
      return warningCount > 0
    },
  }
}
