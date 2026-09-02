import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  formatDate,
  formatDateTime,
  formatRelativeTime,
  formatDuration,
  formatTokens,
  formatNumber,
  formatPercent,
  maskDestination,
} from "@/lib/formatting";

describe("formatDate", () => {
  it("formats epoch-ms to readable date", () => {
    const result = formatDate(1700000000000);
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
  });

  it("handles zero", () => {
    const result = formatDate(0);
    expect(result).toBeTruthy();
  });
});

describe("formatDateTime", () => {
  it("formats epoch-ms to date+time string", () => {
    const result = formatDateTime(1700000000000);
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
  });
});

describe("formatRelativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'just now' for recent timestamps", () => {
    expect(formatRelativeTime(Date.now() - 30000)).toBe("just now");
  });

  it("returns minutes ago", () => {
    expect(formatRelativeTime(Date.now() - 120000)).toBe("2m ago");
  });

  it("returns hours ago", () => {
    expect(formatRelativeTime(Date.now() - 3600000)).toBe("1h ago");
  });

  it("returns days ago", () => {
    expect(formatRelativeTime(Date.now() - 172800000)).toBe("2d ago");
  });

  it("returns formatted date for older timestamps", () => {
    const result = formatRelativeTime(Date.now() - 604800000 * 2);
    expect(result).toBeTruthy();
    expect(result).not.toContain("ago");
  });
});

describe("formatDuration", () => {
  it("formats milliseconds", () => {
    expect(formatDuration(500)).toBe("500ms");
  });

  it("formats seconds", () => {
    expect(formatDuration(5000)).toBe("5s");
  });

  it("formats minutes", () => {
    expect(formatDuration(125000)).toBe("2m 5s");
  });

  it("formats hours", () => {
    expect(formatDuration(3661000)).toBe("1h 1m");
  });
});

describe("formatTokens", () => {
  it("formats small numbers", () => {
    expect(formatTokens(42)).toBe("42");
  });

  it("formats thousands", () => {
    expect(formatTokens(1500)).toBe("1.5K");
  });

  it("formats millions", () => {
    expect(formatTokens(2500000)).toBe("2.5M");
  });

  it("formats exact thousand", () => {
    expect(formatTokens(1000)).toBe("1.0K");
  });
});

describe("formatNumber", () => {
  it("formats with commas", () => {
    expect(formatNumber(1234567)).toBe("1,234,567");
  });

  it("formats small numbers", () => {
    expect(formatNumber(42)).toBe("42");
  });
});

describe("formatPercent", () => {
  it("formats decimal to percent", () => {
    expect(formatPercent(0.891)).toBe("89.1%");
  });

  it("formats zero", () => {
    expect(formatPercent(0)).toBe("0.0%");
  });

  it("formats 100%", () => {
    expect(formatPercent(1)).toBe("100.0%");
  });
});

describe("maskDestination", () => {
  it("masks long URLs", () => {
    const result = maskDestination("https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX");
    expect(result).toContain("...");
    expect(result.length).toBeLessThan("https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX".length);
  });

  it("leaves short URLs unchanged", () => {
    const short = "https://example.com/hook";
    expect(maskDestination(short)).toBe(short);
  });

  it("handles non-URL strings", () => {
    const result = maskDestination("short-string");
    expect(result).toBe("short-string");
  });

  it("handles long non-URL strings", () => {
    const long = "a".repeat(50);
    const result = maskDestination(long);
    expect(result.length).toBeLessThan(50);
    expect(result).toContain("...");
  });
});
