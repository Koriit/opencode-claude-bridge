import { spawn, type Subprocess } from "bun"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * Reusable end-to-end harness: launch a real `opencode serve` with the bridge plugin loaded,
 * drive its `claude plugin list --json` dependency with a fake CLI on PATH (so resolution is
 * deterministic and independent of the machine's actual Claude state), trigger the config hook,
 * and inspect both the live HTTP API and the bridge's log output.
 *
 * Later milestones reuse `startBridge` to assert injected commands/agents/skills/MCP/LSP appear
 * in `/command`, `/agent`, `/skill`, `/mcp` against the same real server.
 */

/** Absolute path to the bridge plugin entry (TS source — OpenCode/Bun imports it directly). */
const PLUGIN_ENTRY = `file://${path.resolve(import.meta.dir, "../src/index.ts")}`

/**
 * Base directory for all harness temp files.
 *
 * The system `/tmp` is a tmpfs that can fill up when the host is busy. Using a
 * directory on the main filesystem (honoured via the `OCB_TMPDIR` env var, or
 * falling back to `TMPDIR`, or finally `os.tmpdir()`) prevents ENOSPC failures
 * in `mkdtempSync` / `writeFileSync` calls that cascade into misleading test
 * failures on the second back-to-back run.
 *
 * The returned path is always absolute: relative values of `OCB_TMPDIR` are
 * resolved against `process.cwd()` at call time. This matters because fixture
 * paths (e.g. plugin `installPath`) end up in JSON sent to the bridge, which
 * runs with a different cwd — relative paths would silently resolve to the wrong
 * location.
 */
function harnessBase(): string {
  const override = process.env["OCB_TMPDIR"] ?? process.env["TMPDIR"]
  if (override) {
    const abs = path.resolve(override)
    mkdirSync(abs, { recursive: true })
    return abs
  }
  return tmpdir()
}

export interface FakeClaude {
  /** Plugin entries the fake `claude plugin list --json` should print. */
  plugins?: unknown[]
  /** Raw stdout override (takes precedence over `plugins`). */
  stdout?: string
  /** Exit code; non-zero simulates a failing/absent CLI. Defaults to 0. */
  exitCode?: number
}

export interface StartOptions {
  /** Bridge tuple options (the `{ ...bridgeConfig }` second element). Omit for bare-string form. */
  options?: Record<string, unknown>
  /**
   * Fake `claude` behavior, or a factory given the generated project dir (for projectPath wiring).
   * Pass `false` to omit the fake `claude` binary entirely (and remove the fake bin dir from PATH),
   * simulating a host where the `claude` CLI is not installed — exercises the "is it on PATH?" catch
   * branch in `selection.ts`.
   */
  claude: FakeClaude | ((projectDir: string) => FakeClaude) | false
  /**
   * Override the bridge-cache root for this server. When set, the cache dir is created as a
   * temp dir, injected via the `OPENCODE_CLAUDE_BRIDGE_CACHE_ROOT` env var, and removed on
   * `stop()`. Pass `true` to auto-create a temp cache; pass a string to use a specific path.
   *
   * IMPORTANT: passing a string (caller-supplied path) means `stop()` will NOT delete it —
   * the caller is responsible for cleanup. Only `true` (harness-created temp dir) is auto-removed.
   */
  isolateCache?: boolean | string
  /**
   * Spawn the opencode server with an isolated `HOME` (an empty temp dir) so
   * `collectExistingSkillNames` does not scan the real user's `~/.claude/skills`,
   * `~/.agents/skills`, or XDG opencode skill dirs. This makes skill collision tests
   * hermetic regardless of the host's real skills.
   *
   * `XDG_CONFIG_HOME` and `XDG_DATA_HOME` are also redirected into the isolated
   * home so the bridge's XDG skill scan cannot read the real `~/.config/opencode`
   * directories on hosts where those variables are exported.
   *
   * The isolated home is available as `BridgeServer.homeDir` before `triggerHook()` is called,
   * so tests can plant native skills/config before the hook runs.
   */
  isolateHome?: boolean
  /**
   * Optional callback to populate the isolated HOME before the server spawns.
   * Only called when `isolateHome` is true. Receives the absolute path of the
   * empty temp HOME dir; may write files into it (e.g. native skills for
   * collision testing).
   */
  populateHome?: (homeDir: string) => Promise<void>
}

export interface BridgeServer {
  baseUrl: string
  projectDir: string
  /**
   * The bridge-cache root used for collision-renamed skill copies, if `isolateCache`
   * was set in `StartOptions`. Useful for e2e assertions on cache contents.
   */
  cacheDir?: string
  /**
   * The isolated HOME dir, if `isolateHome` was set in `StartOptions`.
   */
  homeDir?: string
  /**
   * Issue a request to an instance route, forcing the config hook to fire.
   * Waits (polling, bounded) until the bridge's hook-completion log line appears
   * so assertions don't depend on a wall-clock guess.
   */
  triggerHook(): Promise<void>
  /** GET helper returning parsed JSON for an API path. */
  get(p: string): Promise<{ status: number; body: unknown }>
  /** Accumulated stdout+stderr from the server process. */
  log(): string
  /** True if the bridge emitted a line containing `needle`. */
  logHas(needle: string): boolean
  stop(): Promise<void>
}

function writeFakeClaude(behavior: FakeClaude): string {
  const dir = mkdtempSync(path.join(harnessBase(), "ocb-claude-"))
  const stdout = behavior.stdout ?? JSON.stringify(behavior.plugins ?? [])
  const exitCode = behavior.exitCode ?? 0
  // A shim that answers `claude plugin list --json` with fixed output. Single-quote-escape the
  // payload so arbitrary JSON survives the heredoc-free echo.
  const escaped = stdout.replace(/'/g, `'\\''`)
  const script = `#!/usr/bin/env bash\nprintf '%s' '${escaped}'\nexit ${exitCode}\n`
  const file = path.join(dir, "claude")
  writeFileSync(file, script)
  chmodSync(file, 0o755)
  return dir
}

async function pump(stream: ReadableStream<Uint8Array> | null, onChunk: (s: string) => void): Promise<void> {
  if (!stream) return
  const reader = stream.getReader()
  const dec = new TextDecoder()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) onChunk(dec.decode(value))
  }
}

/**
 * Poll `baseUrl` health endpoint until it responds 200 or the deadline expires.
 * Using a longer timeout (75s) as insurance under load — opencode serve can be
 * slow on first-run transpilation.
 */
async function waitForHealth(baseUrl: string, timeoutMs = 75_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await fetch(new URL("/global/health", baseUrl))
      if (res.ok) return
    } catch {
      // server not up yet
    }
    if (Date.now() > deadline) throw new Error(`opencode server did not become healthy at ${baseUrl}`)
    await Bun.sleep(200)
  }
}

/**
 * Parse the actual bound port from opencode's startup log line:
 *   `opencode server listening on http://<host>:<port>`
 *
 * Polls `getLog` until the line appears or the deadline expires.
 * Returns the port number, or throws on timeout.
 */
async function waitForPort(getLog: () => string, timeoutMs = 30_000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  const re = /opencode server listening on http:\/\/[^:]+:(\d+)/
  for (;;) {
    const m = re.exec(getLog())
    if (m) return parseInt(m[1]!, 10)
    if (Date.now() > deadline) throw new Error("timed out waiting for opencode server port announcement")
    await Bun.sleep(50)
  }
}

/**
 * Wait until the bridge's hook-completion marker appears in the log.
 * The hook always emits one of these markers per run:
 *   - `"injected N command(s)"` (resolution + injection succeeded)
 *   - `"injecting nothing this run"` (CLI failed / returned non-zero)
 *   - `"hook complete (strict failure)"` (strict mode + fatal warning)
 *
 * So we wait for any of those strings, or fall back to a 10s cap so we don't
 * hang forever if an unexpected code path emits nothing.
 */
async function waitForHookComplete(logHas: (needle: string) => boolean, timeoutMs = 10_000): Promise<void> {
  const MARKERS = ["injected ", "injecting nothing this run", "hook complete (strict failure)"]
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (MARKERS.some((m) => logHas(m))) return
    if (Date.now() > deadline) return // timeout: proceed; test assertions will clarify
    await Bun.sleep(50)
  }
}

export async function startBridge(opts: StartOptions): Promise<BridgeServer> {
  const base = harnessBase()
  const projectDir = mkdtempSync(path.join(base, "ocb-proj-"))

  // Resolve an isolated cache root when requested (keeps skills e2e hermetic).
  // Injected via env var so the bridge config surface stays at the 5 spec keys.
  let cacheDir: string | undefined
  let cacheDirOwned = false // true only when the harness created the temp dir
  if (opts.isolateCache === true) {
    cacheDir = mkdtempSync(path.join(base, "ocb-cache-"))
    cacheDirOwned = true
  } else if (typeof opts.isolateCache === "string") {
    // Caller-supplied path: use as-is, do NOT delete on stop() — caller's responsibility.
    cacheDir = opts.isolateCache
  }

  // Resolve an isolated HOME when requested. An empty tmp dir prevents
  // collectExistingSkillNames from scanning the real user's skill dirs, making
  // no-collision / collision assertions hermetic on any host.
  let homeDir: string | undefined
  if (opts.isolateHome) {
    homeDir = mkdtempSync(path.join(base, "ocb-home-"))
    // Allow the caller to pre-populate the isolated HOME (e.g. plant native skills
    // for bridge-vs-native collision tests) before the server spawns.
    if (opts.populateHome) await opts.populateHome(homeDir)
  }

  const pluginEntry: string | [string, Record<string, unknown>] = opts.options
    ? [PLUGIN_ENTRY, opts.options]
    : PLUGIN_ENTRY
  writeFileSync(
    path.join(projectDir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: [pluginEntry] }, null, 2),
  )

  // When claude is false, skip planting the fake binary. claudeBin is set to an empty
  // string so it can still be passed to rmSync on stop() without ill effect.
  let claudeBin: string
  if (opts.claude === false) {
    claudeBin = ""
  } else {
    const behavior = typeof opts.claude === "function" ? opts.claude(projectDir) : opts.claude
    claudeBin = writeFakeClaude(behavior)
  }

  // When claude:false, strip any PATH entry that contains a real `claude` binary so
  // the child cannot find one on the host. We filter by the presence of a `claude`
  // file in each colon-separated directory — that makes the absence hermetic even
  // on developer machines that have the real Claude CLI installed.
  function stripClaudeFromPath(envPath: string): string {
    return envPath
      .split(path.delimiter)
      .filter((dir) => !existsSync(path.join(dir, "claude")))
      .join(path.delimiter)
  }

  let buffer = ""
  const append = (s: string) => {
    buffer += s
  }

  // Use --port 0 (OS-assigned port) to avoid collisions across back-to-back runs.
  // The actual bound port is discovered from the server's own startup log line.
  //
  // Spawn in its own process group (`detached: true`) so teardown can kill the
  // entire group (including any child workers) with `process.kill(-pgid, ...)`.
  // Without this, a child spawned by opencode may survive after the parent exits,
  // leaving orphan "opencode serve" processes across back-to-back test runs.
  const hostPath = process.env["PATH"] ?? ""
  const childEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    // When claude is false, strip all PATH entries containing a `claude` binary so
    // the child cannot accidentally pick up the real Claude CLI from the host.
    PATH: claudeBin
      ? `${claudeBin}:${hostPath}`
      : stripClaudeFromPath(hostPath),
  }
  if (cacheDir) childEnv["OPENCODE_CLAUDE_BRIDGE_CACHE_ROOT"] = cacheDir
  if (homeDir) {
    childEnv["HOME"] = homeDir
    // Redirect XDG dirs into the isolated home so skill scans that respect
    // XDG_CONFIG_HOME (e.g. collectExistingSkillNames reading ~/.config/opencode)
    // don't leak the real host config into the hermetic test environment.
    childEnv["XDG_CONFIG_HOME"] = path.join(homeDir, ".config")
    childEnv["XDG_DATA_HOME"] = path.join(homeDir, ".local", "share")
  }

  const proc: Subprocess = spawn(
    ["opencode", "serve", "--port", "0", "--hostname", "127.0.0.1", "--print-logs", "--log-level", "INFO"],
    {
      cwd: projectDir,
      env: childEnv,
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    },
  )
  void pump(proc.stdout as ReadableStream<Uint8Array>, append)
  void pump(proc.stderr as ReadableStream<Uint8Array>, append)

  // Discover the actual port from the startup log before polling /health.
  const port = await waitForPort(() => buffer).catch((err) => {
    proc.kill()
    throw err
  })
  const baseUrl = `http://127.0.0.1:${port}`

  await waitForHealth(baseUrl)

  const logHasFn = (needle: string) => buffer.includes(needle)

  const server: BridgeServer = {
    baseUrl,
    projectDir,
    cacheDir,
    homeDir,
    async triggerHook() {
      // `/command` is an instance route, so hitting it bootstraps the instance and fires the hook.
      await fetch(new URL("/command", baseUrl)).catch(() => {})
      // Poll for the bridge hook-completion marker rather than sleeping a fixed amount.
      await waitForHookComplete(logHasFn)
    },
    async get(p: string) {
      const res = await fetch(new URL(p, baseUrl))
      let body: unknown = null
      try {
        body = await res.json()
      } catch {
        body = null
      }
      return { status: res.status, body }
    },
    log() {
      return buffer
    },
    logHas(needle: string) {
      return buffer.includes(needle)
    },
    async stop() {
      // Kill the entire process group so any child workers spawned by opencode
      // are also reaped. The process was spawned with `detached: true`, giving
      // it a new process group whose pgid equals its pid. We send SIGTERM to
      // the group first and escalate to SIGKILL after 3 s.
      //
      // `proc.pid` may be undefined if the process never started; guard it.
      const pgid = proc.pid
      const killGroup = (sig: string) => {
        if (pgid !== undefined) {
          try {
            process.kill(-pgid, sig)
          } catch {
            // process group already gone — ignore
          }
        }
      }
      killGroup("SIGTERM")
      const killTimeout = setTimeout(() => killGroup("SIGKILL"), 3_000)
      try {
        await proc.exited
      } catch {
        // ignore — process already exited or could not be waited on
      } finally {
        clearTimeout(killTimeout)
      }
      rmSync(projectDir, { recursive: true, force: true })
      if (claudeBin) rmSync(claudeBin, { recursive: true, force: true })
      // Only remove cache dir if the harness created it; caller-supplied paths are
      // the caller's responsibility to clean up.
      if (cacheDir && cacheDirOwned) rmSync(cacheDir, { recursive: true, force: true })
      if (homeDir) rmSync(homeDir, { recursive: true, force: true })
    },
  }
  return server
}
