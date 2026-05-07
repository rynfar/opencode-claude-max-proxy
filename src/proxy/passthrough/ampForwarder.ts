/**
 * Amp HTTP forward proxy.
 *
 * Selectively passes through non-inference Amp traffic (threads, attachments,
 * telemetry, login, internal config) to a configurable upstream — by default
 * https://ampcode.com — so the entire Amp app remains usable when AMP_URL is
 * pointed at Meridian. The inference path (/api/provider/anthropic/*) is NOT
 * routed here; it goes through the regular /v1/messages handler.
 */

import type { Context } from "hono"

const DEFAULT_UPSTREAM = "https://ampcode.com"

/**
 * Hop-by-hop headers per RFC 7230 §6.1, plus proxy-* per common practice.
 * These must not be forwarded across a proxy hop.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

export function getAmpUpstreamUrl(): string {
  const v = process.env.AMP_UPSTREAM_URL?.trim()
  if (v && v.length > 0) return v.replace(/\/+$/, "")
  return DEFAULT_UPSTREAM
}

function isForwardingDisabled(): boolean {
  const v = (process.env.MERIDIAN_AMP_FORWARD_DISABLED ?? "").toLowerCase()
  return v === "1" || v === "true" || v === "yes"
}

function filterHeaders(src: Headers | Record<string, string>): Headers {
  const out = new Headers()
  const entries = src instanceof Headers
    ? Array.from(src.entries())
    : Object.entries(src)
  for (const [k, v] of entries) {
    const lk = k.toLowerCase()
    if (HOP_BY_HOP.has(lk)) continue
    // Drop Host so fetch sets it for the upstream automatically.
    if (lk === "host") continue
    // Drop content-length; let fetch recompute (body may be re-encoded).
    if (lk === "content-length") continue
    out.set(k, v)
  }
  return out
}

/**
 * Forward an inbound Hono request to the configured Amp upstream.
 * Returns a Response whose body streams the upstream response body.
 */
export async function ampForwardRequest(c: Context): Promise<Response> {
  if (isForwardingDisabled()) {
    return new Response(
      JSON.stringify({ error: "amp_forward_disabled", message: "MERIDIAN_AMP_FORWARD_DISABLED is set" }),
      { status: 503, headers: { "content-type": "application/json" } },
    )
  }

  const upstreamBase = getAmpUpstreamUrl()
  const inboundReq = c.req.raw // native Request
  const inboundUrl = new URL(inboundReq.url)
  const upstreamUrl = upstreamBase + inboundUrl.pathname + inboundUrl.search

  const method = inboundReq.method
  const headers = filterHeaders(inboundReq.headers)

  const hasBody = method !== "GET" && method !== "HEAD"
  // Use a typed extension rather than `as any` — `duplex` is required by
  // undici/Bun when streaming a request body but isn't in the standard TS lib yet.
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers,
    redirect: "manual",
  }
  if (hasBody) {
    init.body = inboundReq.body ?? undefined
    init.duplex = "half"
  }

  const upstreamRes = await fetch(upstreamUrl, init)

  const respHeaders = new Headers()
  upstreamRes.headers.forEach((v, k) => {
    if (HOP_BY_HOP.has(k.toLowerCase())) return
    respHeaders.set(k, v)
  })

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: respHeaders,
  })
}
