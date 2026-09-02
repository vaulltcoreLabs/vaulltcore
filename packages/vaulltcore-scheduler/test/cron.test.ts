/**
 * Cron parser tests (Phase 2B): parsing, ranges, steps, L, tz-aware next-run,
 * determinism.
 */
import { describe, it, expect } from "vitest"
import { parseCron, nextRun, validateTimezone, CronParseError } from "../src/cron"

describe("parseCron", () => {
  it("parses standard fields", () => {
    const p = parseCron("0 9 * * 1")
    expect([...p.minute.values]).toEqual([0])
    expect([...p.hour.values]).toEqual([9])
    expect(p.dom.values.size).toBe(31) // *
    expect(p.month.values.size).toBe(12)
    expect([...p.dow.values]).toEqual([1])
  })

  it("supports lists, ranges, steps", () => {
    const p = parseCron("0,30 9-17/2 * * *")
    expect([...p.minute.values]).toEqual([0, 30])
    expect([...p.hour.values]).toEqual([9, 11, 13, 15, 17])
  })

  it("supports */n steps", () => {
    const p = parseCron("*/15 * * * *")
    expect([...p.minute.values]).toEqual([0, 15, 30, 45])
  })

  it("supports L (last day of month)", () => {
    const p = parseCron("0 0 L * *")
    expect(p.dom.values.has(-1)).toBe(true)
  })

  it("rejects malformed expressions", () => {
    expect(() => parseCron("0 9 * *")).toThrow(CronParseError)
    expect(() => parseCron("60 9 * * *")).toThrow(CronParseError)
    expect(() => parseCron("0 25 * * *")).toThrow(CronParseError)
    expect(() => parseCron("0 9 * * 7")).toThrow(CronParseError)
    expect(() => parseCron("0 9 * * * extra")).toThrow(CronParseError)
  })
})

describe("nextRun", () => {
  it("computes the next matching minute deterministically", () => {
    const p = parseCron("30 9 * * *")
    // 2026-01-01T00:00:00Z → next 09:30 in UTC
    const t = nextRun(p, Date.UTC(2026, 0, 1, 0, 0, 0), "UTC")
    const expected = Date.UTC(2026, 0, 1, 9, 30, 0)
    expect(t).toBe(expected)
  })

  it("is strictly after `from`", () => {
    const p = parseCron("0 9 * * *")
    const from = Date.UTC(2026, 0, 1, 9, 0, 0)
    const t = nextRun(p, from, "UTC")
    expect(t).toBeGreaterThan(from)
    expect(t).toBe(Date.UTC(2026, 0, 2, 9, 0, 0))
  })

  it("respects day-of-week with OR semantics when dom is restricted", () => {
    // 0 0 1 * 1 = midnight on the 1st OR Mondays
    const p = parseCron("0 0 1 * 1")
    const t = nextRun(p, Date.UTC(2026, 0, 1, 0, 0, 0), "UTC")
    // next match: 2026-01-05 is a Monday (dow 1)
    expect(t).toBe(Date.UTC(2026, 0, 5, 0, 0, 0))
  })

  it("timezone-aware: America/New_York offset", () => {
    const p = parseCron("0 9 * * *")
    // In January, EST is UTC-5, so 09:00 EST = 14:00 UTC.
    const t = nextRun(p, Date.UTC(2026, 0, 1, 0, 0, 0), "America/New_York")
    expect(new Date(t).toISOString()).toBe(new Date(Date.UTC(2026, 0, 1, 14, 0, 0)).toISOString())
  })

  it("validateTimezone accepts IANA, rejects garbage", () => {
    expect(() => validateTimezone("UTC")).not.toThrow()
    expect(() => validateTimezone("America/New_York")).not.toThrow()
    expect(() => validateTimezone("Mars/Olympus")).toThrow(CronParseError)
  })
})
