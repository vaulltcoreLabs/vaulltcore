/**
 * Self-contained 5-field cron parser + tz-aware next-run calculator (Phase 2B).
 *
 * No external cron dependency. Supports the standard 5-field syntax:
 *   minute hour day-of-month month day-of-week
 * with star, comma lists, ranges (a-b), step values (star-slash-n, a-b-slash-n),
 * and the L (last day-of-month) shorthand. Timezone awareness is provided by the
 * Intl DateTimeFormat API (no `tzdata` dependency; uses the host's IANA tz).
 *
 * Next-run calculation is deterministic: given a `from` epoch ms and a tz, it
 * returns the next matching epoch ms strictly after `from`. This determinism is
 * what makes schedule firing idempotent — a scheduler crash + restart recomputes
 * the same occurrence and the durable schedule+occurrence identity decides
 * whether a run was already admitted.
 *
 * This is NOT a general workflow engine. It computes the next occurrence of a
 * single schedule; the scheduler admits at most one run per occurrence.
 */

export interface CronField {
  readonly values: ReadonlySet<number>
}

export interface ParsedCron {
  readonly minute: CronField
  readonly hour: CronField
  readonly dom: CronField
  readonly month: CronField
  readonly dow: CronField
}

export class CronParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CronParseError"
  }
}

const FIELD_RANGES: Array<{ readonly min: number; readonly max: number; readonly name: string }> = [
  { min: 0, max: 59, name: "minute" },
  { min: 0, max: 23, name: "hour" },
  { min: 1, max: 31, name: "day-of-month" },
  { min: 1, max: 12, name: "month" },
  { min: 0, max: 6, name: "day-of-week" },
]

function parseField(field: string, range: { readonly min: number; readonly max: number; readonly name: string }): CronField {
  if (field === "") throw new CronParseError(`Empty ${range.name} field`)
  const values = new Set<number>()
  for (const part of field.split(",")) {
    if (part === "") throw new CronParseError(`Empty ${range.name} list element`)
    // step value
    const stepMatch = part.match(/^(.*)\/(\d+)$/)
    let base = part
    let step = 1
    if (stepMatch) {
      base = stepMatch[1] ?? ""
      step = Number(stepMatch[2])
      if (!Number.isInteger(step) || step < 1) throw new CronParseError(`Invalid step in ${range.name}: ${part}`)
    }
    let lo: number
    let hi: number
    if (base === "*") {
      lo = range.min
      hi = range.max
    } else {
      const rangeMatch = base.match(/^(\d+)-(\d+)$/)
      if (rangeMatch) {
        lo = Number(rangeMatch[1])
        hi = Number(rangeMatch[2])
      } else if (/^\d+$/.test(base)) {
        lo = Number(base)
        hi = stepMatch ? range.max : lo
      } else if (base.toUpperCase() === "L" && range.name === "day-of-month") {
        // "L" = last day of month; handled specially in nextRun via a sentinel.
        // Represent as a marker: we store -1 and resolve at calc time.
        values.add(-1)
        continue
      } else {
        throw new CronParseError(`Invalid ${range.name} value: ${part}`)
      }
    }
    if (lo < range.min || hi > range.max || lo > hi) {
      throw new CronParseError(`${range.name} value out of range: ${part} (allowed ${range.min}-${range.max})`)
    }
    for (let v = lo; v <= hi; v += step) values.add(v)
  }
  if (values.size === 0) throw new CronParseError(`No values for ${range.name}`)
  return { values }
}

export function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) throw new CronParseError(`Cron expression must have 5 fields, got ${parts.length}: ${expr}`)
  const fields = parts.map((p, i) => parseField(p, FIELD_RANGES[i]!))
  const minute = fields[0]!
  const hour = fields[1]!
  const dom = fields[2]!
  const month = fields[3]!
  const dow = fields[4]!
  return { minute, hour, dom, month, dow }
}

/** Format a Date's parts in a given IANA timezone. */
function tzParts(epochMs: number, tz: string): { readonly year: number; readonly month: number; readonly day: number; readonly hour: number; readonly minute: number; readonly dow: number; readonly daysInMonth: number } {
  // Use Intl to get the wall-clock fields in the target tz.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  })
  const parts = fmt.formatToParts(new Date(epochMs))
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? ""
  const year = Number(get("year"))
  const month = Number(get("month"))
  const day = Number(get("day"))
  const hourRaw = Number(get("hour"))
  const hour = hourRaw === 24 ? 0 : hourRaw
  const minute = Number(get("minute"))
  const weekday = get("weekday")
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  const dow = dowMap[weekday] ?? 0
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return { year, month, day, hour, minute, dow, daysInMonth }
}

const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as const

/** Compute the next matching epoch ms strictly after `fromMs` in `tz`. */
export function nextRun(parsed: ParsedCron, fromMs: number, tz: string): number {
  // Start one minute after `from`, iterate forward. Bounded: cron has a max
  // period of ~1 year (a Feb-29-like annual), so we cap at 366 days of minutes.
  const start = fromMs + 60_000
  let p = tzParts(start, tz)
  let cursor = start
  const cap = 366 * 24 * 60 // minutes
  for (let i = 0; i < cap; i++) {
    const domValue = p.day
    const isLastDom = p.day === p.daysInMonth
    const domMatches = parsed.dom.values.has(domValue) || (parsed.dom.values.has(-1) && isLastDom)
    const monthMatches = parsed.month.values.has(p.month)
    const dowMatches = parsed.dow.values.has(p.dow)
    // Standard cron: if both dom and dow are restricted (not both *), match
    // either; otherwise both must match. We detect "restricted" as values set
    // not equal to the full range.
    const domRestricted = !isFullRange(parsed.dom, 1, 31)
    const dowRestricted = !isFullRange(parsed.dow, 0, 6)
    const dayMatches = domRestricted && dowRestricted ? (domMatches || dowMatches) : (domMatches && dowMatches)
    if (monthMatches && dayMatches && parsed.hour.values.has(p.hour) && parsed.minute.values.has(p.minute)) {
      return cursor
    }
    cursor += 60_000
    p = tzParts(cursor, tz)
  }
  throw new CronParseError(`No matching run within 366 days for cron (tz=${tz})`)
}

function isFullRange(field: CronField, min: number, max: number): boolean {
  if (field.values.size !== max - min + 1) return false
  for (let v = min; v <= max; v++) if (!field.values.has(v)) return false
  return true
}

/** Validate an IANA timezone string. Throws if not supported. */
export function validateTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date())
  } catch {
    throw new CronParseError(`Unsupported timezone: ${tz}`)
  }
}
