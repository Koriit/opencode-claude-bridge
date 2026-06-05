/**
 * Type declarations for @opencode-ai/core — a private package bundled into the
 * OpenCode binary and not published to npm. Only the subset the bridge actually
 * uses is declared here; the full API is larger.
 *
 * Resolved at runtime via dynamic import against Bun's module registry, which
 * already holds the host worker's pre-initialized instance.
 */
declare module "@opencode-ai/core/util/log" {
  export interface Logger {
    debug(message?: unknown, extra?: Record<string, unknown>): void
    info(message?: unknown, extra?: Record<string, unknown>): void
    warn(message?: unknown, extra?: Record<string, unknown>): void
    error(message?: unknown, extra?: Record<string, unknown>): void
  }

  export function create(tags?: Record<string, unknown>): Logger
}
