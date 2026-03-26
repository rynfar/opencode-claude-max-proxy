export function normalizeRequiredApiKeys(keys?: string[]): string[] {
  return (keys ?? []).map((key) => key.trim()).filter(Boolean)
}

export function extractRequestApiKey(xApiKey?: string, authorization?: string): string | undefined {
  if (xApiKey?.trim()) return xApiKey.trim()

  const bearerMatch = authorization?.match(/^Bearer\s+(.+)$/i)
  const bearerToken = bearerMatch?.[1]?.trim()
  return bearerToken || undefined
}

export function isApiKeyAuthEnabled(requiredApiKeys?: string[]): boolean {
  return normalizeRequiredApiKeys(requiredApiKeys).length > 0
}

export function isApiKeyAuthorized(providedApiKey: string | undefined, requiredApiKeys?: string[]): boolean {
  const normalizedKeys = normalizeRequiredApiKeys(requiredApiKeys)
  if (normalizedKeys.length === 0) return true
  if (!providedApiKey) return false
  return normalizedKeys.includes(providedApiKey)
}
