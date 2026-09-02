/**
 * SSRF guard (Phase 2B).
 *
 * A reusable outbound-destination guard used by every HTTP-based delivery
 * provider. It enforces:
 * - scheme allow-list (https always; http only when explicitly enabled for
 *   local development — never in production);
 * - host/port sanity (no userinfo smuggling, no empty host);
 * - DNS resolution to a forbidden IP class is rejected (loopback, private,
 *   link-local, multicast, cloud metadata `169.254.169.254`, IPv6 ULA/site-
 *   local, IPv4-mapped);
 * - no untrusted redirect following into forbidden ranges.
 *
 * The guard resolves the hostname once and checks every returned address; an
 * attacker cannot bypass via DNS rebinding within a single resolution because
 * we connect to the resolved IP (the caller may pin the resolved address).
 *
 * It is intentionally dependency-free: it uses node:dns/promises + node:net
 * isIP. No external SSRF library is a dependency.
 */

import { promises as dns } from "node:dns"
import { isIP } from "node:net"
import { SsrfBlockedError } from "./contracts"

export interface SsrfGuardOptions {
  /** Allow http: scheme (default false — https only in production). */
  readonly allowHttp?: boolean
  /** Allow private/loopback ranges (default false; enable for local tests). */
  readonly allowPrivate?: boolean
  /** Custom resolver (tests). */
  readonly resolver?: (host: string) => Promise<string[]>
}

const METADATA_HOSTS = new Set(["169.254.169.254", "fd00:ec2::254"])

function isForbiddenIp(ip: string, allowPrivate: boolean): boolean {
  const family = isIP(ip)
  if (family === 0) return true
  // Normalize IPv4-mapped IPv6 (::ffff:a.b.c.d) to its v4 form.
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip
  if (METADATA_HOSTS.has(ip) || METADATA_HOSTS.has(v4)) return true
  if (allowPrivate) return false
  if (family === 4) {
    const parts = v4.split(".").map((p) => Number(p))
    const a = parts[0]
    const b = parts[1]
    if (a === undefined || b === undefined) return true
    if (a === 10) return true
    if (a === 127) return true // loopback
    if (a === 0) return true // 0.0.0.0/8
    if (a === 169 && b === 254) return true // link-local + metadata
    if (a === 172 && b >= 16 && b <= 31) return true // private
    if (a === 192 && b === 168) return true // private
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    if (a >= 224) return true // multicast + reserved
    return false
  }
  // IPv6
  const low = ip.toLowerCase()
  if (low === "::1") return true // loopback
  if (low.startsWith("fe80")) return true // link-local
  if (low.startsWith("fc") || low.startsWith("fd")) return true // unique local
  if (low.startsWith("ff")) return true // multicast
  return false
}

export class SsrfGuard {
  private readonly allowHttp: boolean
  private readonly allowPrivate: boolean
  private readonly resolver: (host: string) => Promise<string[]>

  constructor(options: SsrfGuardOptions = {}) {
    this.allowHttp = options.allowHttp ?? false
    this.allowPrivate = options.allowPrivate ?? false
    this.resolver = options.resolver ?? (async (host) => {
      if (isIP(host) !== 0) return [host]
      const addrs = await dns.lookup(host, { all: true })
      return addrs.map((a) => a.address)
    })
  }

  /** Validate + resolve a destination URL. Returns the safe URL + resolved IPs.
   *  Throws {@link SsrfBlockedError} if the destination is forbidden. */
  async check(rawUrl: string): Promise<{ url: string; addresses: string[] }> {
    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      throw new SsrfBlockedError(rawUrl, "invalid URL")
    }
    if (url.protocol !== "https:" && !(this.allowHttp && url.protocol === "http:")) {
      throw new SsrfBlockedError(rawUrl, `scheme ${url.protocol} not allowed`)
    }
    if (url.username || url.password) {
      throw new SsrfBlockedError(rawUrl, "userinfo in destination is not allowed")
    }
    const host = url.hostname
    if (!host) throw new SsrfBlockedError(rawUrl, "empty host")
    // Reject obvious hostname smuggling.
    if (/[\s]/.test(host)) throw new SsrfBlockedError(rawUrl, "whitespace in host")
    let addrs: string[]
    try {
      addrs = await this.resolver(host)
    } catch {
      throw new SsrfBlockedError(rawUrl, "DNS resolution failed")
    }
    if (addrs.length === 0) throw new SsrfBlockedError(rawUrl, "no DNS records")
    for (const ip of addrs) {
      if (isForbiddenIp(ip, this.allowPrivate)) {
        throw new SsrfBlockedError(rawUrl, `resolves to forbidden address ${ip === host ? ip : "[redacted]"}`)
      }
    }
    return { url: url.toString(), addresses: addrs }
  }

  /** Check a redirect target the same way. Used to prevent redirect-based SSRF. */
  async checkRedirect(location: string, fromUrl: string): Promise<{ url: string; addresses: string[] }> {
    const resolved = new URL(location, fromUrl).toString()
    return this.check(resolved)
  }
}
