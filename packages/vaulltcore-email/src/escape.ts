/** HTML-escape user-controlled fields before interpolation into templates. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;")
}

/** Only http(s) absolute URLs that match the configured canonical origin are ever emitted. */
export function assertSameOriginLink(url: string, canonicalOrigin: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error("email link is not a valid URL")
  }
  const expected = new URL(canonicalOrigin)
  if (parsed.origin !== expected.origin) {
    throw new Error("email link origin does not match the configured canonical origin")
  }
}