/**
 * Audit metadata sanitizer (Phase 1E).
 *
 * Recursively strips any key that looks like a secret/credential and any
 * string value that looks like an API key/secret before audit serialization.
 * The goal: a leaked audit log cannot mint credentials or reveal secrets.
 */

const SECRET_KEY_PATTERNS = [
  /^(.*[_-]?)?secret([_-]?.*)?$/i,
  /^(.*[_-]?)?password([_-]?.*)?$/i,
  /^(.*[_-]?)?passwd([_-]?.*)?$/i,
  /^(.*[_-]?)?credential([_-]?.*)?$/i,
  /^(.*[_-]?)?token([_-]?.*)?$/i,
  /^(.*[_-]?)?apikey([_-]?.*)?$/i,
  /^(.*[_-]?)?api_key([_-]?.*)?$/i,
  /^(.*[_-]?)?accesstoken([_-]?.*)?$/i,
  /^(.*[_-]?)?authorization([_-]?.*)?$/i,
  /^(.*[_-]?)?privatekey([_-]?.*)?$/i,
  /^(.*[_-]?)?bearer([_-]?.*)?$/i,
]

/** Looks like a Vaulltcore API key secret: `vc_live_<…>_<body>` or any long
 *  base64url secret body. Conservative: only redact long opaque-looking strings. */
function looksLikeSecretValue(value: string): boolean {
  if (value.length < 16) return false
  if (/^vc_[a-z]+_[A-Za-z0-9_-]{20,}$/i.test(value)) return true
  // Long base64url/hex blobs that are almost certainly secrets, not prose.
  return /^[A-Za-z0-9_-]{32,}$/.test(value) && /[A-Z]/.test(value) && /[a-z]/.test(value) && /[0-9]/.test(value)
}

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((pattern) => pattern.test(key))
}

/** Recursively redact secret-bearing keys and secret-looking string values. */
export function sanitizeMetadata(input: unknown): Readonly<Record<string, unknown>> {
  return sanitizeValue(input, 0) as Readonly<Record<string, unknown>>
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > 16) return "[redacted:depth-limit]"
  if (value === null || value === undefined) return value
  if (typeof value === "string") {
    return looksLikeSecretValue(value) ? "[redacted:secret]" : value
  }
  if (typeof value !== "object") return value
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretKey(key)) {
      out[key] = "[redacted:secret]"
    } else {
      out[key] = sanitizeValue(val, depth + 1)
    }
  }
  return out
}
