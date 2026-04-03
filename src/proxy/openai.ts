/**
 * OpenAI ↔ Anthropic format translation.
 *
 * Pure functions — no I/O, no side effects. Used by the /v1/chat/completions
 * and /v1/models routes in server.ts.
 *
 * Design note: OpenAI clients always send the full conversation history on
 * every request. Feeding that directly into Meridian's session system would
 * classify every turn as "undo" or "diverged" (since the message list keeps
 * changing). Instead:
 *   1. The last user message becomes the actual SDK request
 *   2. Prior turns are packed into a <conversation_history> block in the
 *      system prompt so Claude has context
 *   3. Each chat completions request gets a fresh SDK session
 * This is intentional — OpenAI-format clients replay full history themselves
 * and don't benefit from Meridian's session resumption.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OpenAiRole = "system" | "user" | "assistant"

export interface OpenAiContentPart {
  type: string
  text?: string
}

export interface OpenAiMessage {
  role: OpenAiRole
  content: string | OpenAiContentPart[]
}

export interface OpenAiChatRequest {
  model?: string
  messages?: OpenAiMessage[]
  stream?: boolean
  max_tokens?: number
  max_completion_tokens?: number
  temperature?: number
  top_p?: number
}

export interface AnthropicMessage {
  role: "user" | "assistant"
  content: string
}

export interface AnthropicRequestBody {
  model: string
  messages: AnthropicMessage[]
  max_tokens: number
  stream: boolean
  system?: string
  temperature?: number
  top_p?: number
}

export interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
}

export interface AnthropicContentBlock {
  type: string
  text?: string
}

export interface AnthropicResponse {
  content?: AnthropicContentBlock[]
  stop_reason?: string
  usage?: AnthropicUsage
}

export interface OpenAiStreamChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<{
    index: 0
    delta: { role?: "assistant"; content?: string }
    finish_reason: "stop" | "length" | null
  }>
}

export interface OpenAiCompletion {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: Array<{
    index: 0
    message: { role: "assistant"; content: string }
    finish_reason: "stop" | "length"
  }>
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export interface OpenAiModel {
  id: string
  object: "model"
  created: number
  owned_by: string
  display_name: string
  context_window: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise an OpenAI message content field to a plain string.
 * Handles both string content and structured content arrays.
 */
export function extractOpenAiContent(content: string | OpenAiContentPart[]): string {
  if (typeof content === "string") return content
  return content
    .filter(p => p.type === "text" && typeof p.text === "string")
    .map(p => p.text!)
    .join("")
}

// ---------------------------------------------------------------------------
// Request translation: OpenAI → Anthropic
// ---------------------------------------------------------------------------

/**
 * Translate an OpenAI /v1/chat/completions request body into an Anthropic
 * /v1/messages request body.
 *
 * Returns null if the request has no messages (caller should return 400).
 */
export function translateOpenAiToAnthropic(body: OpenAiChatRequest): AnthropicRequestBody | null {
  const messages = body.messages ?? []
  if (messages.length === 0) return null

  // Separate system messages from conversation turns
  const systemParts: string[] = []
  const turns: AnthropicMessage[] = []

  for (const msg of messages) {
    const text = extractOpenAiContent(msg.content ?? "")
    if (msg.role === "system") {
      if (text) systemParts.push(text)
    } else {
      turns.push({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: text,
      })
    }
  }

  // Pack prior turns into system context so each request is a fresh session.
  // OpenAI clients resend full history; Meridian's session system would
  // misclassify repeated history as undo/diverged. This avoids that.
  let systemPrompt = systemParts.join("\n")
  let messagesToSend: AnthropicMessage[] = turns

  if (turns.length > 1) {
    const history = turns.slice(0, -1)
      .map(m => `${m.role}: ${m.content}`)
      .join("\n")
    const historyBlock =
      `<conversation_history>\n${history}\n</conversation_history>\n\n` +
      `Continue this conversation naturally. Respond to the user's latest message.`
    systemPrompt = systemPrompt
      ? `${systemPrompt}\n\n${historyBlock}`
      : historyBlock
    messagesToSend = turns.slice(-1)
  }

  const result: AnthropicRequestBody = {
    model: body.model ?? "claude-sonnet-4-6",
    messages: messagesToSend,
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 8192,
    stream: body.stream ?? false,
  }

  if (systemPrompt) result.system = systemPrompt
  if (body.temperature !== undefined) result.temperature = body.temperature
  if (body.top_p !== undefined) result.top_p = body.top_p

  return result
}

// ---------------------------------------------------------------------------
// Response translation: Anthropic → OpenAI (non-streaming)
// ---------------------------------------------------------------------------

/**
 * Map an Anthropic stop_reason to an OpenAI finish_reason.
 */
function toFinishReason(stopReason: string | undefined): "stop" | "length" {
  if (stopReason === "max_tokens") return "length"
  return "stop"
}

/**
 * Translate a complete Anthropic /v1/messages response to OpenAI format.
 * Thinking blocks are filtered out — only text blocks are included.
 */
export function translateAnthropicToOpenAi(
  response: AnthropicResponse,
  completionId: string,
  model: string,
  created: number
): OpenAiCompletion {
  const content = (response.content ?? [])
    .filter(b => b.type === "text" && typeof b.text === "string")
    .map(b => b.text!)
    .join("")

  const promptTokens = response.usage?.input_tokens ?? 0
  const completionTokens = response.usage?.output_tokens ?? 0

  return {
    id: completionId,
    object: "chat.completion",
    created,
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content },
      finish_reason: toFinishReason(response.stop_reason),
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  }
}

// ---------------------------------------------------------------------------
// Stream translation: Anthropic SSE event → OpenAI SSE chunk
// ---------------------------------------------------------------------------

interface AnthropicSseEvent {
  type: string
  delta?: { type?: string; text?: string; stop_reason?: string }
  message?: { id?: string }
}

/**
 * Translate one parsed Anthropic SSE event into an OpenAI stream chunk.
 * Returns null for events that should be skipped (pings, block starts, etc).
 */
export function translateAnthropicSseEvent(
  event: AnthropicSseEvent,
  completionId: string,
  model: string,
  created: number
): OpenAiStreamChunk | null {
  // Initial chunk: role announcement
  if (event.type === "message_start") {
    return {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    }
  }

  // Text content delta
  if (
    event.type === "content_block_delta" &&
    event.delta?.type === "text_delta" &&
    typeof event.delta.text === "string"
  ) {
    return {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { content: event.delta.text }, finish_reason: null }],
    }
  }

  // Finish chunk
  if (event.type === "message_delta" && event.delta?.stop_reason) {
    return {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: toFinishReason(event.delta.stop_reason) }],
    }
  }

  // All other events (ping, content_block_start, content_block_stop,
  // message_stop, thinking_delta, etc.) are skipped
  return null
}

// ---------------------------------------------------------------------------
// Model list
// ---------------------------------------------------------------------------

/**
 * Return the static list of available Claude models in OpenAI format.
 * Context windows reflect subscription capabilities.
 */
export function buildModelList(isMaxSubscription: boolean, now = Math.floor(Date.now() / 1000)): OpenAiModel[] {
  const extendedContext = isMaxSubscription ? 1_000_000 : 200_000
  return [
    {
      id: "claude-sonnet-4-6",
      object: "model",
      created: now,
      owned_by: "anthropic",
      display_name: "Claude Sonnet 4.6",
      context_window: extendedContext,
    },
    {
      id: "claude-opus-4-6",
      object: "model",
      created: now,
      owned_by: "anthropic",
      display_name: "Claude Opus 4.6",
      context_window: extendedContext,
    },
    {
      id: "claude-haiku-4-5-20251001",
      object: "model",
      created: now,
      owned_by: "anthropic",
      display_name: "Claude Haiku 4.5",
      context_window: 200_000,
    },
  ]
}
