import { describe, expect, test } from "bun:test"
import { startBridge, type BridgeServer } from "./harness.js"

/**
 * End-to-end smoke tests against a real `opencode serve`. The bridge resolves the enabled
 * Claude-plugin set and injects their commands and agents. These fixtures use non-existent
 * install paths so zero components are injected; the assertions target the resolution log and
 * the failure/version posture. Component-injection assertions are in injection.e2e.test.ts.
 */

// Real `opencode serve` startup (first-run plugin transpile) can take several seconds per server.
const TEST_TIMEOUT = 60_000

function userPlugin(id: string, enabled = true) {
  return { id, version: "1.0.0", scope: "user", enabled, installPath: `/fake/${id}` }
}
function projectPlugin(id: string, projectPath: string, enabled = true) {
  return { id, version: "1.0.0", scope: "project", enabled, installPath: `/fake/${id}`, projectPath }
}

describe("bridge e2e — resolution & posture", () => {
  test(
    "loads in real opencode, server stays healthy, and resolves the enabled in-scope set",
    async () => {
      let server: BridgeServer | undefined
      try {
        server = await startBridge({
          claude: (projectDir) => ({
            plugins: [
              userPlugin("alpha@mkt"), // enabled, user scope -> selected
              userPlugin("beta@mkt", false), // disabled -> excluded
              projectPlugin("gamma@mkt", "/some/other/project"), // wrong project -> excluded
              projectPlugin("delta@mkt", projectDir), // this project -> selected
            ],
          }),
        })

        // Server is up and healthy (the hook did not throw and abort startup).
        const health = await server.get("/global/health")
        expect(health.status).toBe(200)
        expect((health.body as { healthy?: boolean }).healthy).toBe(true)

        await server.triggerHook()

        // Resolved set is exactly the enabled, in-scope plugins, sorted by id, and logged.
        expect(server.logHas("resolved 2 enabled Claude plugin(s): alpha@mkt, delta@mkt")).toBe(true)
        // Excluded plugins are not part of the resolved set line.
        expect(server.logHas("beta@mkt")).toBe(false)
        expect(server.logHas("gamma@mkt")).toBe(false)

        // Commands, agents, and skills injection summary is emitted.
        expect(server.logHas("injected 0 command(s), 0 agent(s), 0 skill(s)")).toBe(true)
      } finally {
        await server?.stop()
      }
    },
    TEST_TIMEOUT,
  )

  test(
    "a failing claude CLI degrades gracefully: warn, inject nothing, server still healthy",
    async () => {
      let server: BridgeServer | undefined
      try {
        server = await startBridge({
          claude: { exitCode: 1, stdout: "" }, // simulate a broken / unavailable CLI
        })

        await server.triggerHook()

        // The server came up despite the CLI failure (hook never throws in non-strict mode).
        const health = await server.get("/global/health")
        expect(health.status).toBe(200)

        // A clear warning was emitted and nothing was resolved.
        expect(server.logHas("injecting nothing this run")).toBe(true)
        expect(server.logHas("exited 1")).toBe(true)
      } finally {
        await server?.stop()
      }
    },
    TEST_TIMEOUT,
  )

  test(
    "blockedPlugins (a tuple option) excludes an otherwise-enabled plugin",
    async () => {
      let server: BridgeServer | undefined
      try {
        server = await startBridge({
          options: { blockedPlugins: ["alpha@mkt"] },
          claude: { plugins: [userPlugin("alpha@mkt"), userPlugin("zeta@mkt")] },
        })

        await server.triggerHook()

        // alpha is blocked; only zeta survives. The bridge's resolution line is
        // the authoritative check — OpenCode's own Claude integration may independently
        // log about all discovered plugins, so a broad buffer check is unreliable.
        expect(server.logHas("resolved 1 enabled Claude plugin(s): zeta@mkt")).toBe(true)
      } finally {
        await server?.stop()
      }
    },
    TEST_TIMEOUT,
  )

  test(
    "I5: truly-missing claude CLI (not on PATH) degrades gracefully",
    async () => {
      // claude:false omits the fake binary and strips known claude dirs from PATH.
      // On machines where claude and bun share a directory that cannot be stripped
      // without breaking the runtime, Bun's $-shell may still locate claude via the
      // startup PATH — in that case the "exited N" branch fires rather than the
      // catch-branch "is it on PATH?" path. Both demonstrate graceful degradation.
      let server: BridgeServer | undefined
      try {
        server = await startBridge({ claude: false })

        await server.triggerHook()

        // The server is still healthy despite the absent/unreachable CLI.
        const health = await server.get("/global/health")
        expect(health.status).toBe(200)

        // Either the catch-branch ("is it on PATH?") or the exit-code branch
        // ("injecting nothing this run") fires — both are degradation paths.
        expect(
          server.logHas("is it on PATH?") || server.logHas("injecting nothing this run"),
        ).toBe(true)
      } finally {
        await server?.stop()
      }
    },
    TEST_TIMEOUT,
  )

  test(
    "I6: strict mode with a missing CLI surfaces a failure and the server still comes up",
    async () => {
      // strict:true + missing CLI → the hook throws; OpenCode surfaces the failure but
      // the server itself stays up (the hook failure is isolated to the instance init).
      let server: BridgeServer | undefined
      try {
        server = await startBridge({ options: { strict: true }, claude: false })

        await server.triggerHook()

        // The "hook complete (strict failure)" marker is emitted so the harness returns promptly.
        expect(server.logHas("hook complete (strict failure)")).toBe(true)

        // The server itself is still healthy — hook failure is per-instance, not process-level.
        const health = await server.get("/global/health")
        expect(health.status).toBe(200)
      } finally {
        await server?.stop()
      }
    },
    TEST_TIMEOUT,
  )
})
