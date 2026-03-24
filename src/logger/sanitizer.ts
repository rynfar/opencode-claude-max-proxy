const MAX_STRING_LENGTH = 512;

const REDACTED = new Set([
  "authorization",
  "cookie",
  "x-api-key",
  "apiKey",
  "apikey",
  "prompt",
  "messages",
  "content",
]);

export function sanitize(v: unknown): unknown {
  if (v == null) return v;
  if (typeof v === "string") {
    return v.length > MAX_STRING_LENGTH
      ? `${v.slice(0, MAX_STRING_LENGTH)}... [truncated=${v.length}]`
      : v;
  }
  if (typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(sanitize);
  const o: Record<string, unknown> = {};
  for (const k in v)
    o[k] = REDACTED.has(k)
      ? "[REDACTED]"
      : sanitize((v as Record<string, unknown>)[k]);
  return o;
}
