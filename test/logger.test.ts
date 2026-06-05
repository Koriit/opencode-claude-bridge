import { describe, expect, test } from "bun:test"
import { BridgeError, createLogger } from "../src/logger.js"

describe("createLogger", () => {
  test("non-strict: warn never throws", () => {
    const logger = createLogger(false)
    expect(() => logger.warn("something")).not.toThrow()
  })

  test("strict: a default warning is promoted to BridgeError", () => {
    const logger = createLogger(true)
    expect(() => logger.warn("parse failure")).toThrow(BridgeError)
  })

  test("strict: fatalInStrict=false stays a soft warning", () => {
    const logger = createLogger(true)
    expect(() => logger.warn("advisory", { fatalInStrict: false })).not.toThrow()
  })

  test("info never throws, in either mode", () => {
    expect(() => createLogger(true).info("hi")).not.toThrow()
    expect(() => createLogger(false).info("hi")).not.toThrow()
  })

  test("the thrown error carries the message", () => {
    try {
      createLogger(true).warn("boom")
      throw new Error("expected a throw")
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeError)
      expect((err as BridgeError).message).toBe("boom")
    }
  })

  test("hadWarnings returns false when no warn has been called", () => {
    const logger = createLogger(false)
    expect(logger.hadWarnings()).toBe(false)
  })

  test("hadWarnings returns true after warn is called", () => {
    const logger = createLogger(false)
    logger.warn("something")
    expect(logger.hadWarnings()).toBe(true)
  })

  test("hadWarnings returns true even when fatalInStrict:false (soft warning)", () => {
    const logger = createLogger(false)
    logger.warn("advisory", { fatalInStrict: false })
    expect(logger.hadWarnings()).toBe(true)
  })

  test("hadWarnings returns true in strict mode even when warn throws", () => {
    const logger = createLogger(true)
    try { logger.warn("strict-warn") } catch { /* expected */ }
    expect(logger.hadWarnings()).toBe(true)
  })

  test("info calls do not affect hadWarnings", () => {
    const logger = createLogger(false)
    logger.info("some info")
    expect(logger.hadWarnings()).toBe(false)
  })
})
