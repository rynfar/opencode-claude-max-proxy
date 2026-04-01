/**
 * Proactive rate limit prevention and token budget tracking.
 *
 * Tracks token usage per session and implements proactive backoff
 * to prevent hitting Claude Max rate limits.
 */

import type { TokenBudget } from "./models"
import { DEFAULT_TOKEN_BUDGET } from "./models"

export interface RateLimitState {
  budget: TokenBudget
  lastErrorAt: number | null
  consecutiveErrors: number
  backoffUntil: number | null
}

export function createRateLimitState(): RateLimitState {
  return {
    budget: DEFAULT_TOKEN_BUDGET(),
    lastErrorAt: null,
    consecutiveErrors: 0,
    backoffUntil: null,
  }
}

export function isBackedOff(state: RateLimitState): boolean {
  return state.backoffUntil !== null && Date.now() < state.backoffUntil
}

export function getBackoffDelayMs(consecutiveErrors: number): number {
  return Math.min(1000 * Math.pow(2, consecutiveErrors - 1), 30_000)
}

export function recordRateLimitError(state: RateLimitState): void {
  state.lastErrorAt = Date.now()
  state.consecutiveErrors++
  state.backoffUntil = Date.now() + getBackoffDelayMs(state.consecutiveErrors)
}

export function recordSuccess(state: RateLimitState): void {
  if (state.consecutiveErrors > 0) {
    state.consecutiveErrors = Math.max(0, state.consecutiveErrors - 1)
  }
  if (state.consecutiveErrors === 0) {
    state.backoffUntil = null
  }
}

export function accumulateTokenUsage(existing: TokenBudget, usage: Partial<TokenBudget>): TokenBudget {
  const inputTokens = (existing.inputTokens || 0) + (usage.inputTokens || 0)
  const cacheReadInputTokens = (existing.cacheReadInputTokens || 0) + (usage.cacheReadInputTokens || 0)
  const cacheCreationInputTokens = (existing.cacheCreationInputTokens || 0) + (usage.cacheCreationInputTokens || 0)
  const outputTokens = (existing.outputTokens || 0) + (usage.outputTokens || 0)
  const usedTokens = (existing.usedTokens || 0) + (usage.usedTokens || 0)
  const maxTokens = Math.max(existing.maxTokens || 0, usage.maxTokens || 0)
  const totalProcessedTokens = (existing.totalProcessedTokens || 0) + (usage.totalProcessedTokens || 0)
  const toolUses = (existing.toolUses || 0) + (usage.toolUses || 0)
  const durationMs = (existing.durationMs || 0) + (usage.durationMs || 0)

  return {
    inputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    outputTokens,
    usedTokens,
    maxTokens,
    totalProcessedTokens,
    toolUses,
    durationMs,
  }
}

export function maxClaudeContextWindowFromModelUsage(modelUsage: any): number {
  if (!modelUsage) return 200_000
  if (typeof modelUsage.maxTokens === "number" && modelUsage.maxTokens > 0) {
    return modelUsage.maxTokens
  }
  if (typeof modelUsage.contextWindow === "number" && modelUsage.contextWindow > 0) {
    return modelUsage.contextWindow
  }
  if (typeof modelUsage.context_window === "number" && modelUsage.context_window > 0) {
    return modelUsage.context_window
  }
  if (modelUsage.subscriptionType === "max" || modelUsage.subscriptionType === "maxplan") {
    return 1_000_000
  }
  return 200_000
}

export function budgetPercentUsed(budget: TokenBudget, maxContextWindow: number): number {
  if (maxContextWindow <= 0) return 0
  return Math.round((budget.totalProcessedTokens / maxContextWindow) * 100)
}

export function shouldProactivelyBackoff(budget: TokenBudget, maxContextWindow: number, threshold = 85): boolean {
  return budgetPercentUsed(budget, maxContextWindow) >= threshold
}
