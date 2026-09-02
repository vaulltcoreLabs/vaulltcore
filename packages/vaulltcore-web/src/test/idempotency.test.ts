import { describe, it, expect, beforeEach } from "vitest";
import { generateIdempotencyKey, getIdempotencyKey, clearIdempotencyKey } from "@/lib/idempotency";

describe("idempotency key management", () => {
  beforeEach(() => {
    // Clear all keys before each test
    clearIdempotencyKey("test-action-1");
    clearIdempotencyKey("test-action-2");
  });

  it("generates a UUID-format key", () => {
    const key = generateIdempotencyKey("test-action-1");
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("returns the same key for the same action ID", () => {
    const key1 = generateIdempotencyKey("test-action-1");
    const key2 = generateIdempotencyKey("test-action-1");
    expect(key1).toBe(key2);
  });

  it("returns different keys for different action IDs", () => {
    const key1 = generateIdempotencyKey("test-action-1");
    const key2 = generateIdempotencyKey("test-action-2");
    expect(key1).not.toBe(key2);
  });

  it("retrieves existing key", () => {
    generateIdempotencyKey("test-action-1");
    const retrieved = getIdempotencyKey("test-action-1");
    expect(retrieved).toBeTruthy();
    expect(typeof retrieved).toBe("string");
  });

  it("returns undefined for non-existent action", () => {
    const result = getIdempotencyKey("non-existent-action");
    expect(result).toBeUndefined();
  });

  it("clears key successfully", () => {
    generateIdempotencyKey("test-action-1");
    expect(getIdempotencyKey("test-action-1")).toBeTruthy();
    clearIdempotencyKey("test-action-1");
    expect(getIdempotencyKey("test-action-1")).toBeUndefined();
  });

  it("generates new key after clear", () => {
    const key1 = generateIdempotencyKey("test-action-1");
    clearIdempotencyKey("test-action-1");
    const key2 = generateIdempotencyKey("test-action-1");
    expect(key1).not.toBe(key2);
  });

  it("generates unique keys across many calls", () => {
    const keys = new Set<string>();
    for (let i = 0; i < 100; i++) {
      keys.add(generateIdempotencyKey(`unique-${i}`));
    }
    expect(keys.size).toBe(100);
  });
});
