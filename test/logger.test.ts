import { describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { BridgeError, createLogger } from "../src/logger.js"

/** A fake client that records every app.log call. */
function fakeClient() {
  const calls: Array<{ service: string; level: string; message: string }> = []
  const client = {
    app: {
      log: async (opts: { body: { service: string; level: string; message: string } }) => {
        calls.push(opts.body)
        return { data: true }
      },
    },
  } as unknown as PluginInput["client"]
  return { client, calls }
}

describe("createLogger", () => {
  test("non-strict: warn never throws", () => {
    const { client } = fakeClient()
    const logger = createLogger(client, false)
    expect(() => logger.warn("something")).not.toThrow()
  })

  test("strict: a default warning is promoted to BridgeError", () => {
    const { client } = fakeClient()
    const logger = createLogger(client, true)
    expect(() => logger.warn("parse failure")).toThrow(BridgeError)
  })

  test("strict: fatalInStrict=false stays a soft warning", () => {
    const { client } = fakeClient()
    const logger = createLogger(client, true)
    expect(() => logger.warn("advisory", { fatalInStrict: false })).not.toThrow()
  })

  test("info never throws, in either mode", () => {
    const { client } = fakeClient()
    expect(() => createLogger(client, true).info("hi")).not.toThrow()
    expect(() => createLogger(client, false).info("hi")).not.toThrow()
  })

  test("the thrown error carries the message", () => {
    const { client } = fakeClient()
    try {
      createLogger(client, true).warn("boom")
      throw new Error("expected a throw")
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeError)
      expect((err as BridgeError).message).toBe("boom")
    }
  })

  test("hadWarnings returns false when no warn has been called", () => {
    const { client } = fakeClient()
    const logger = createLogger(client, false)
    expect(logger.hadWarnings()).toBe(false)
  })

  test("hadWarnings returns true after warn is called", () => {
    const { client } = fakeClient()
    const logger = createLogger(client, false)
    logger.warn("something")
    expect(logger.hadWarnings()).toBe(true)
  })

  test("hadWarnings returns true even when fatalInStrict:false (soft warning)", () => {
    const { client } = fakeClient()
    const logger = createLogger(client, false)
    logger.warn("advisory", { fatalInStrict: false })
    expect(logger.hadWarnings()).toBe(true)
  })

  test("hadWarnings returns true in strict mode even when warn throws", () => {
    const { client } = fakeClient()
    const logger = createLogger(client, true)
    try { logger.warn("strict-warn") } catch { /* expected */ }
    expect(logger.hadWarnings()).toBe(true)
  })

  test("info calls do not affect hadWarnings", () => {
    const { client } = fakeClient()
    const logger = createLogger(client, false)
    logger.info("some info")
    expect(logger.hadWarnings()).toBe(false)
  })

  test("info writes through client.app.log with the bridge service and info level", () => {
    const { client, calls } = fakeClient()
    createLogger(client, false).info("hello")
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ service: "opencode-claude-bridge", level: "info", message: "hello" })
  })

  test("non-strict warn writes through client.app.log at warn level", () => {
    const { client, calls } = fakeClient()
    createLogger(client, false).warn("careful")
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ service: "opencode-claude-bridge", level: "warn", message: "careful" })
  })

  test("a client.app.log failure never escapes the logger", () => {
    const client = {
      app: { log: async () => { throw new Error("server down") } },
    } as unknown as PluginInput["client"]
    const logger = createLogger(client, false)
    expect(() => logger.info("x")).not.toThrow()
    expect(() => logger.warn("y")).not.toThrow()
  })
})
