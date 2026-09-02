/**
 * Monotonic-ish unique ID generator.
 *
 * Extracted and adapted from opencode `packages/schema/src/identifier.ts`
 * (MIT License, Copyright (c) 2025 opencode). Kept dependency-free; the
 * original lives at https://github.com/anomalyco/opencode.
 */

const length = 26
const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
let lastTimestamp = 0
let counter = 0

export function ascending(): string {
  return create(false)
}

export function create(descending: boolean, timestamp = Date.now()): string {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp
    counter = 0
  }
  counter++

  const current = BigInt(timestamp) * 0x1000n + BigInt(counter)
  const value = descending ? ~current : current
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn).toString(16).padStart(2, "0"),
  ).join("")
  const bytes = crypto.getRandomValues(new Uint8Array(length - 12))
  return time + Array.from(bytes, (byte) => chars[byte % 62]).join("")
}

export const newJobId = (): string => "job_" + ascending()
export const newExecutionId = (): string => "exe_" + ascending()
export const newLeaseToken = (): string => "lease_" + ascending()
export const newWorkspaceId = (): string => "wks_" + ascending()
export const newSnapshotId = (): string => "snap_" + ascending()
/** Random suffix of `len` chars from the base62 alphabet (Phase 1D worker ids). */
export const randomId = (len = 12): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(len)), (byte) => chars[byte % 62]).join("")
export const newWorkerId = (): string => "wk_" + ascending()
export const newBootToken = (): string => "bt_" + ascending()
