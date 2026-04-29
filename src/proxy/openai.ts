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

export type OpenAiRole = "system" | "user" | "assistant" | "tool"

export interface OpenAiTextPart {
  type: "text"
  text?: string
}

export interface OpenAiImageUrlPart {
  type: "image_url"
  image_url?: {
    url?: string
  }
}

export interface OpenAiContentPart {
  type: string
  text?: string
  image_url?: {
    url?: string
  }
}

export interface OpenAiMessage {
  role: OpenAiRole
  tool_call_id?: string
  content: string | OpenAiContentPart[]
  tool_calls?: OpenAiCompletionToolCall[]
}

export interface OpenAiChatToolFunction {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: unknown // Any JSON schema
    strict?: boolean
  }
}

export interface OpenAiChatToolCustom {
  type: "custom"
}

export type OpenAiChatTool = OpenAiChatToolFunction | OpenAiChatToolCustom

export interface OpenAiChatRequest {
  model?: string
  messages?: OpenAiMessage[]
  stream?: boolean
  max_tokens?: number
  max_completion_tokens?: number
  temperature?: number
  top_p?: number
  tools?: OpenAiChatTool[]
}

export interface AnthropicTextBlock {
  type: "text"
  text: string
}

export interface AnthropicImageBlock {
  type: "image"
  source: {
    type: "base64"
    media_type: string
    data: string
  }
}

export interface AnthropicMessage {
  role: "user" | "assistant"
  content: string | AnthropicContentBlock[]
}

export interface AnthropicTool {
  name: string
  description: string
  input_schema: unknown // Any JSON schema
  strict?: boolean
}

export interface AnthropicRequestBody {
  model: string
  messages: AnthropicMessage[]
  max_tokens: number
  stream: boolean
  system?: string
  temperature?: number
  top_p?: number
  tools?: AnthropicTool[]
}

export interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
}

export interface AnthropicContentBlockText {
  type: "text"
  text?: string
}

export interface AnthropicToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
}

export interface AnthropicToolResultBlock {
  type: "tool_result"
  tool_use_id: string
  content: string | AnthropicContentBlock[]
}

export interface AnthropicThinkingBlock {
  type: "thinking"
  thinking: string
}

export type AnthropicContentBlock =
  AnthropicTextBlock |
  AnthropicImageBlock |
  AnthropicThinkingBlock |
  AnthropicToolResultBlock |
  AnthropicToolUseBlock

export interface AnthropicResponse {
  content?: AnthropicContentBlock[]
  stop_reason?: string
  usage?: AnthropicUsage
}

/**
 * Streaming tool-call delta as emitted in chat.completion.chunk events.
 *
 * The OpenAI streaming protocol splits a single tool call across multiple
 * chunks: a "start" chunk announces the call (id + function name), and
 * subsequent "args" chunks append `function.arguments` fragments. `index`
 * correlates fragments back to their parent call. Fields are optional rather
 * than `DeepPartial<OpenAiCompletionToolCall>` so the type can't represent
 * nonsense like `{ function: { arguments: undefined } }`.
 */
export interface OpenAiStreamingToolCallDelta {
  index: number
  type?: "function"
  id?: string
  function?: {
    name?: string
    arguments?: string
  }
}

export interface OpenAiStreamChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<{
    index: 0
    delta: {
      role?: "assistant"
      content?: string
      tool_calls?: OpenAiStreamingToolCallDelta[]
      reasoning_content?: string
    }
    finish_reason: "stop" | "length" | "tool_calls" | null
  }>
}

export interface OpenAiCompletionFunctionToolCall {
  type: "function"
  index?: number
  id: string
  function: {
    name: string
    arguments: string
  }
}

export interface OpenAiCompletionCustomToolCall {
  type: "custom"
}

export type OpenAiCompletionToolCall = 
  OpenAiCompletionFunctionToolCall |
  OpenAiCompletionCustomToolCall

export interface OpenAiCompletion {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: Array<{
    index: 0
    message: {
      role: "assistant"
      content: string | null
      reasoning_content?: string
      tool_calls?: OpenAiCompletionToolCall[]
    }
    finish_reason: "stop" | "length" | "tool_calls"
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
 * Non-text blocks are summarized so history packing does not silently erase
 * multimodal context.
 */
export function extractOpenAiContent(content: string | OpenAiContentPart[]): string {
  if (typeof content === "string") return content
  return content
    .map((p) => {
      if (p.type === "text" && typeof p.text === "string") return p.text
      if (p.type === "image_url") return "[Image attached]"
      return ""
    })
    .filter(Boolean)
    .join("")
}

function parseDataUrlImage(url: string): AnthropicImageBlock | null {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(url)
  if (!match) return null
  const mediaType = match[1]
  const data = match[2]
  if (!mediaType || !data) return null
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mediaType,
      data,
    },
  }
}

function translateOpenAiContentToAnthropic(content: string | OpenAiContentPart[]): AnthropicContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }]

  const parts: AnthropicContentBlock[] = []

  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text })
      continue
    }

    if (part.type === "image_url") {
      const url = part.image_url?.url
      if (typeof url === "string") {
        const parsed = parseDataUrlImage(url)
        if (parsed) {
          parts.push(parsed)
          continue
        }
      }
      parts.push({ type: "text", text: "[Unsupported image_url omitted: only data URLs are currently supported]" })
    }
  }

  return parts
}

function summarizeAnthropicContent(content: string | AnthropicContentBlock[]): string {
  if (typeof content === "string") return content
  return content
    .map((part) => {
      if (part.type === "text") return part.text
      if (part.type === "thinking") return "\n<think>\n" + part.thinking + "\n</think>\n"
      if (part.type === "tool_use")
        return "\n<tool_call name=\"" + part.name + "\">\n" + JSON.stringify(part.input) + "\n</tool_call>\n"
      if (part.type === "tool_result") {
        if (typeof part.content === "string")
          return "\n<tool_result>\n" + part.content + "\n</tool_result>\n"
        else
          return part.content
            .map(c => c.type === "text" ? `\n<tool_result>\n${c.text}\n</tool_result>\n` : "")
            .join("")
      }
      if (part.type === "image") return "[Image attached]"
      return ""
    })
    .filter(Boolean)
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
  const tools: AnthropicTool[] = []

  for (const msg of messages) {
    const text = extractOpenAiContent(msg.content ?? "")
    if (msg.role === "system") {
      if (text) systemParts.push(text)
    } else if (msg.role === "tool") {
      turns.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: msg.tool_call_id ?? "",
          content: translateOpenAiContentToAnthropic(msg.content ?? "")
        }]
      })
    } else if (msg.role === "assistant") {
      const msgContent = translateOpenAiContentToAnthropic(msg.content ?? "")
      const content: AnthropicContentBlock[] = []
      const toolCalls = msg.tool_calls ?? null

      const firstBlock = msgContent[0]
      const endOfThink = firstBlock?.type === "text" && firstBlock.text.startsWith("<think>")
        ? firstBlock.text.indexOf("</think>")
        : -1
      if (firstBlock?.type === "text" && firstBlock.text.startsWith("<think>") && endOfThink !== -1) {
        // Extract <think>...</think> to thinking block. Skip a single optional
        // trailing newline after </think> for readability, but tolerate its
        // absence rather than dropping the first character of the answer.
        const thinking = firstBlock.text.substring("<think>".length, endOfThink)
        let textStart = endOfThink + "</think>".length
        if (firstBlock.text[textStart] === "\n") textStart += 1
        const text = firstBlock.text.substring(textStart)
        content.push({ type: "thinking", thinking })
        if (text.length) content.push({ type: "text", text })
        // Append remaining blocks (e.g. images) untouched
        if (msgContent.length > 1) content.push(...msgContent.slice(1))
      } else {
        // No <think> block, or malformed (no closing tag) — keep as plain text
        content.push(...msgContent)
      }
      if (toolCalls) {
        const calls: AnthropicContentBlock[] = toolCalls
          .filter(call => call.type === "function")
          .map(call => {
            // OpenAI clients sometimes resend partial/streamed tool-call
            // arguments. Don't crash the request on malformed JSON — surface
            // the original string under __raw so the model can still see it.
            let input: Record<string, unknown>
            try {
              const parsed = JSON.parse(call.function.arguments) as unknown
              input = (parsed && typeof parsed === "object" && !Array.isArray(parsed))
                ? parsed as Record<string, unknown>
                : { __raw: call.function.arguments }
            } catch {
              input = { __raw: call.function.arguments }
            }
            return {
              type: "tool_use",
              id: call.id,
              name: call.function.name,
              input,
            }
          })
        content.push(...calls)
      }

      // Flatten content to single string if only one text block
      let finalContent: string | AnthropicContentBlock[] = content
      if (content.length === 1 && content[0]?.type === "text") {
        finalContent = content[0].text
      }

      turns.push({
        role: "assistant",
        content: finalContent
      })
    } else {
      turns.push({
        role: "user",
        content: translateOpenAiContentToAnthropic(msg.content ?? ""),
      })
    }
  }

  const reqTools = body.tools ?? []

  // Convert OpenAI tool definitions to Anthropic format
  for (const reqTool of reqTools) {
    if (reqTool.type === "function") {
      const tool = reqTool.function
      tools.push({
        name: tool.name,
        // OpenAI's function.description is optional; default to empty string
        // so AnthropicTool.description stays a non-undefined value.
        description: tool.description ?? "",
        input_schema: tool.parameters,
        strict: tool.strict
      })
    } else {
      // Other tool types than "function" not supported for now
      return null
    }
  }

  // Pack prior turns into system context so each request is a fresh session.
  // OpenAI clients resend full history; Meridian's session system would
  // misclassify repeated history as undo/diverged. This avoids that.
  let systemPrompt = systemParts.join("\n")
  let messagesToSend: AnthropicMessage[] = turns

  if (turns.length > 1) {
    const history = turns.slice(0, -1)
      .map(m => `${m.role}: ${summarizeAnthropicContent(m.content)}`)
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
    tools: tools,
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
function toFinishReason(stopReason: string | undefined): "stop" | "length" | "tool_calls" {
  if (stopReason === "max_tokens") return "length"
  else if (stopReason === "tool_use") return "tool_calls"
  return "stop"
}

/**
 * Translate a complete Anthropic /v1/messages response to OpenAI format.
 * Currently supports only text, thinking and function call blocks.
 *
 * When `thinkingPassthrough` is false, thinking blocks are not
 * mapped to `reasoning_content` (stripped from the response).
 */
export function translateAnthropicToOpenAi(
  response: AnthropicResponse,
  completionId: string,
  model: string,
  created: number,
  options?: { thinkingPassthrough?: boolean },
): OpenAiCompletion {
  const contentBlocks = response.content ?? []

  const content = contentBlocks
    .filter(b => b.type === "text" && typeof b.text === "string")
    .map(b  => (b as AnthropicContentBlockText).text!)
    .join("")

  const toolCalls: OpenAiCompletionToolCall[] = contentBlocks
    .filter(b => b.type === "tool_use")
    .map(b => ({
        type: "function",
        id: b.id,
        function: {
          name: b.name,
          arguments: JSON.stringify(b.input)
        }
      }))

  const thinkingPassthrough = options?.thinkingPassthrough
  const thinking = thinkingPassthrough !== false
    ? contentBlocks
        .filter(b => b.type === "thinking")
        .map(b => (b as AnthropicThinkingBlock).thinking!)
        .join("")
    : ""

  const promptTokens = response.usage?.input_tokens ?? 0
  const completionTokens = response.usage?.output_tokens ?? 0

  return {
    id: completionId,
    object: "chat.completion",
    created,
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: content || null,
        reasoning_content: thinking.length ? thinking : undefined,
        tool_calls: toolCalls.length ? toolCalls : undefined
      },
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

/**
 * Wire-format SSE event from Anthropic's `/v1/messages` streaming API.
 *
 * `content_block` may describe a text block, a tool_use block, or a thinking
 * block depending on the stream position — only `type` is guaranteed.
 */
export interface AnthropicSseEvent {
  type: string
  index?: number
  delta?: {
    type?: string
    text?: string
    stop_reason?: string
    partial_json?: string
    thinking?: string
  }
  content_block?:
    | { type: "text"; text?: string }
    | { type: "thinking"; thinking?: string }
    | AnthropicToolUseBlock
  message?: { id?: string }
}

export interface SseTranslator {
  (event: AnthropicSseEvent): OpenAiStreamChunk | null
}

export interface SseTranslatorContext {
  completionId: string
  model: string
  created: number
  /** When false, thinking blocks are stripped from the response */
  thinkingPassthrough?: boolean
}

/**
 * A stateful translator for one OpenAI streaming response.
 *
 * Each completion stream gets its own translator instance to keep state out
 * of server.ts. Internally tracks the current tool-call index so that
 * `content_block_start` (tool_use) events are emitted as OpenAI tool_call
 * deltas with monotonically increasing `index` values, matching how
 * `function.arguments` fragments must correlate back to their parent call.
 *
 * Anthropic's wire format signals start/end of each content block; OpenAI's
 * does not, so we manufacture an index per stream.
 */
export function createSseTranslator(ctx: SseTranslatorContext): SseTranslator {
  let toolCallIndex = -1 // -1 means "no tools used yet", becomes 0 on first block
  return (event) => {
    // Increment must use the same condition the pure translator uses to
    // decide a tool-start chunk gets emitted, otherwise indexes drift if a
    // malformed event is skipped.
    if (
      event.type === "content_block_start" &&
      event.content_block?.type === "tool_use" &&
      typeof event.content_block.name === "string"
    ) {
      toolCallIndex++
    }

    return translateAnthropicSseEvent(
      event,
      ctx.completionId,
      ctx.model,
      ctx.created,
      toolCallIndex,
      ctx.thinkingPassthrough,
    )
  }
}

/**
 * Translate one parsed Anthropic SSE event into an OpenAI stream chunk.
 * Returns null for events that should be skipped (pings, message_stop,
 * content_block_stop, text-block content_block_start, etc).
 *
 * `toolCallNum` is the OpenAI `tool_calls[].index` value to emit on tool-call
 * chunks. Callers tracking multiple tools per stream must increment it on
 * each `content_block_start` with `type: "tool_use"` *before* calling this
 * function. Use `createSseTranslator` to handle this automatically.
 *
 * When `thinkingPassthrough` is false, thinking_delta events are skipped
 * so the client does not receive reasoning_content.
 */
export function translateAnthropicSseEvent(
  event: AnthropicSseEvent,
  completionId: string,
  model: string,
  created: number,
  toolCallNum: number,
  thinkingPassthrough?: boolean
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

  // Tool call start
  if (
    event.type === "content_block_start" &&
    event.content_block?.type === "tool_use" &&
    typeof event.content_block?.name === "string"
  ) {
    return {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            type: "function",
            index: toolCallNum,
            id: event.content_block?.id,
            function: {
              name: event.content_block.name,
              arguments: ""
            }
          }]
        },
        finish_reason: null
      }],
    }
  }

  // Tool call input
  if (
    event.type === "content_block_delta" &&
    event.delta?.type === "input_json_delta" &&
    typeof event.delta?.partial_json === "string"
  ) {
    return {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: toolCallNum,
            function: {
              arguments: event.delta.partial_json
            }
          }]
        },
        finish_reason: null
      }],
    }
  }

  // Reasoning
  if (
    event.type === "content_block_delta" &&
    event.delta?.type === "thinking_delta"
  ) {
    // Skip thinking content only when passthrough is explicitly disabled.
    // Default (undefined or true) passes thinking through for backward compatibility.
    if (thinkingPassthrough === false) {
      return null
    }
    if (typeof event.delta?.thinking === "string") {
      return {
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{
          index: 0,
          delta: {
            reasoning_content: event.delta?.thinking
          },
          finish_reason: null
        }],
      }
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
  return [
    {
      id: "claude-sonnet-4-6",
      object: "model",
      created: now,
      owned_by: "anthropic",
      display_name: "Claude Sonnet 4.6",
      context_window: 200_000,
    },
    {
      id: "claude-opus-4-6",
      object: "model",
      created: now,
      owned_by: "anthropic",
      display_name: "Claude Opus 4.6",
      context_window: isMaxSubscription ? 1_000_000 : 200_000,
    },
    {
      id: "claude-opus-4-7",
      object: "model",
      created: now,
      owned_by: "anthropic",
      display_name: "Claude Opus 4.7",
      context_window: isMaxSubscription ? 1_000_000 : 200_000,
    },
    {
      id: "claude-haiku-4-5",
      object: "model",
      created: now,
      owned_by: "anthropic",
      display_name: "Claude Haiku 4.5",
      context_window: 200_000,
    },
  ]
}
