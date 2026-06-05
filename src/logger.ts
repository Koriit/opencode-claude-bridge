import { readFileSync } from "node:fs"

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
 * Detect whether --print-logs was passed to the parent OpenCode process.
 *
 * process.argv is stripped in Bun Workers (only ["bun", "<worker_script>"] is
 * present), so we cannot check it directly. However, Workers run in the same
 * OS process as the host, so /proc/self/cmdline contains the real command line.
 * Falls back to false on non-Linux platforms or if the file is unreadable.
 */
function detectPrintLogs(): boolean {
  try {
    const args = readFileSync("/proc/self/cmdline").toString().split("\0")
    return args.includes("--print-logs")
  } catch {
    return false
  }
}

const printLogs = detectPrintLogs()

/**
 * Try to import @opencode-ai/core/util/log from the host Bun Worker's module
 * registry. If available, its already-initialized logger routes output to
 * stderr (with --print-logs) or the log file (default) without any extra
 * argv inspection. Falls back to null when the module is unavailable.
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
  if (!printLogs) return
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
