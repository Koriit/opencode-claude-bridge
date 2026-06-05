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
 * Minimal duck-type for the OpenCode core logger service we resolve at runtime.
 * `@opencode-ai/core` is private/unpublished; we access it via dynamic import
 * against the Bun module registry that the host worker already populated.
 */
interface CoreLog {
  create(tags?: Record<string, unknown>): {
    info(msg: string): void
    warn(msg: string): void
  }
}

/**
 * Resolve the core log module at runtime by hitting Bun's module registry.
 * The Bun Worker that hosts plugins already executed
 *   `import * as Log from "@opencode-ai/core/util/log"`
 * and called `Log.init({ print: ... })`, so the registry holds a fully
 * configured instance. A dynamic import of the same specifier returns it.
 *
 * Falls back to a plain stderr writer if the import fails (tests, non-OpenCode
 * environments) — in that case output is always emitted so tests can capture it.
 */
async function resolveCoreLog(): Promise<CoreLog | null> {
  try {
    // @opencode-ai/core is a private package bundled into the OpenCode binary.
    // The dynamic import resolves against Bun's module registry at runtime —
    // the host worker already loaded and initialized it.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — not in node_modules; resolved from the Bun bundle at runtime
    return await import("@opencode-ai/core/util/log") as CoreLog
  } catch {
    return null
  }
}

// Kick off resolution immediately so it's ready before the first log call.
const coreLogPromise = resolveCoreLog()

/**
 * Fallback writer used when the core log module is unavailable.
 * Always writes to stderr — correct for test environments.
 */
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
