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

        // Running version (1.15.x) is in range -> no version warning.
        expect(server.logHas("untested OpenCode version")).toBe(false)

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
        expect(server.logHas("[opencode-claude-bridge] warning:")).toBe(true)
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

        // alpha is blocked; only zeta survives.
        expect(server.logHas("resolved 1 enabled Claude plugin(s): zeta@mkt")).toBe(true)
        expect(server.logHas("alpha@mkt")).toBe(false)
      } finally {
        await server?.stop()
      }
    },
    TEST_TIMEOUT,
  )
})
