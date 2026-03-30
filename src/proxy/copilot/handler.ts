/**
 * GitHub Copilot proxy handler for POST /v1/chat/completions.
 *
 * Supports two upstream endpoints:
 *  - /chat/completions  — for Claude models (claude-opus-4.6, claude-sonnet-4.6)
 *  - /responses         — for Codex models  (gpt-5.3-codex)
 *
 * Streaming: SSE is passed through directly for chat, and translated from
 * Responses API event format to OpenAI chat SSE format for Codex.
 */

import type { Context } from "hono"
import { getCopilotJWT, clearJWTCache } from "./auth"
import { isCopilotModel, usesResponsesEndpoint } from "./models"
import { randomUUID } from "crypto"

const COPILOT_HEADERS = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
  "Openai-Intent": "conversation-panel",
  "X-Github-Api-Version": "2025-04-01",
}

/**
 * Direct passthrough for POST /v1/responses (Responses API format).
 * Droid routes gpt-5.3-codex here when it detects a Responses API model.
 * Body is already in Responses API format — forward as-is to Copilot.
 */
export async function handleResponsesDirect(c: Context): Promise<Response> {
  let body: any
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: { type: "invalid_request", message: "Invalid JSON body" } }, 400)
  }

  let jwt: { token: string; endpoint: string }
  try {
    jwt = await getCopilotJWT()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ error: { type: "authentication_error", message: msg } }, 401)
  }

  const requestId = randomUUID()
  const url = `${jwt.endpoint}/responses`
  const upstream = await fetchCopilot(url, jwt.token, requestId, body)

  if (!upstream.ok) {
    if (upstream.status === 401) clearJWTCache()
    const errBody = await upstream.text()
    return c.json({ error: { type: "upstream_error", message: errBody } }, upstream.status as any)
  }

  const stream = body.stream ?? true
  if (!stream) {
    const data = await upstream.json()
    return c.json(data)
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Request-Id": requestId,
    },
  })
}

export async function handleChatCompletions(c: Context): Promise<Response> {
  let body: any
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: { type: "invalid_request", message: "Invalid JSON body" } }, 400)
  }

  const model: string = body.model || ""
  if (!isCopilotModel(model)) {
    return c.json({
      error: {
        type: "not_found",
        message: `Model '${model}' is not a supported Copilot model. Supported: claude-opus-4.6, claude-sonnet-4.6, gpt-5.3-codex`,
      }
    }, 404)
  }

  let jwt: { token: string; endpoint: string }
  try {
    jwt = await getCopilotJWT()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ error: { type: "authentication_error", message: msg } }, 401)
  }

  const requestId = randomUUID()

  if (usesResponsesEndpoint(model)) {
    return proxyToResponses(body, jwt, requestId, c)
  }

  return proxyToChat(body, jwt, requestId, c)
}

// ---------------------------------------------------------------------------
// Chat endpoint passthrough (claude-opus-4.6, claude-sonnet-4.6)
// ---------------------------------------------------------------------------

async function proxyToChat(
  body: any,
  jwt: { token: string; endpoint: string },
  requestId: string,
  c: Context
): Promise<Response> {
  const url = `${jwt.endpoint}/chat/completions`

  const upstream = await fetchCopilot(url, jwt.token, requestId, body)

  if (!upstream.ok) {
    // On 401, invalidate JWT cache so next request re-fetches
    if (upstream.status === 401) clearJWTCache()
    const errBody = await upstream.text()
    return c.json({ error: { type: "upstream_error", message: errBody } }, upstream.status as any)
  }

  const stream = body.stream ?? true
  if (!stream) {
    const data = await upstream.json()
    return c.json(data)
  }

  // Streaming: pass SSE through directly
  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Request-Id": requestId,
    },
  })
}

// ---------------------------------------------------------------------------
// Responses endpoint (gpt-5.3-codex): request + response translation
// ---------------------------------------------------------------------------

async function proxyToResponses(
  body: any,
  jwt: { token: string; endpoint: string },
  requestId: string,
  c: Context
): Promise<Response> {
  const translatedBody = chatToResponsesRequest(body)
  const url = `${jwt.endpoint}/responses`

  const upstream = await fetchCopilot(url, jwt.token, requestId, translatedBody)

  if (!upstream.ok) {
    if (upstream.status === 401) clearJWTCache()
    const errBody = await upstream.text()
    return c.json({ error: { type: "upstream_error", message: errBody } }, upstream.status as any)
  }

  const stream = body.stream ?? true
  const model: string = body.model || "gpt-5.3-codex"

  if (!stream) {
    const data = await upstream.json()
    return c.json(responsesNonStreamToChat(data, model))
  }

  // Translate Responses SSE → OpenAI chat SSE
  const responseStream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      const reader = upstream.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let state: ResponsesStreamState = makeStreamState(model)

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""

          for (const line of lines) {
            const chunks = translateResponsesLine(line, state)
            for (const chunk of chunks) {
              controller.enqueue(encoder.encode(chunk))
            }
          }
        }
        // Process any remaining buffer
        if (buffer) {
          const chunks = translateResponsesLine(buffer, state)
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk))
          }
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      } catch (err) {
        controller.error(err)
      } finally {
        controller.close()
      }
    }
  })

  return new Response(responseStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Request-Id": requestId,
    },
  })
}

// ---------------------------------------------------------------------------
// Request translation: OpenAI chat messages → Responses API input
// ---------------------------------------------------------------------------

function chatToResponsesRequest(body: any): any {
  const messages: any[] = body.messages ?? []
  const input: any[] = []

  for (const msg of messages) {
    const role: string = msg.role
    const content = msg.content

    if (role === "system") {
      const text = typeof content === "string" ? content : extractText(content)
      if (text) {
        input.push({
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text }],
        })
      }
      continue
    }

    if (role === "user") {
      if (typeof content === "string") {
        input.push({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: content }],
        })
      } else if (Array.isArray(content)) {
        const parts: any[] = []
        for (const block of content) {
          if (block.type === "text") {
            parts.push({ type: "input_text", text: block.text })
          } else if (block.type === "tool_result") {
            // Flush message parts before tool result
            if (parts.length > 0) {
              input.push({ type: "message", role: "user", content: [...parts] })
              parts.length = 0
            }
            input.push({
              type: "function_call_output",
              call_id: block.tool_use_id,
              output: typeof block.content === "string"
                ? block.content
                : extractText(block.content),
            })
          }
        }
        if (parts.length > 0) {
          input.push({ type: "message", role: "user", content: parts })
        }
      }
      continue
    }

    if (role === "assistant") {
      if (typeof content === "string") {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: content }],
        })
      } else if (Array.isArray(content)) {
        const parts: any[] = []
        for (const block of content) {
          if (block.type === "text") {
            parts.push({ type: "output_text", text: block.text })
          } else if (block.type === "tool_use") {
            if (parts.length > 0) {
              input.push({ type: "message", role: "assistant", content: [...parts] })
              parts.length = 0
            }
            input.push({
              type: "function_call",
              call_id: block.id,
              name: block.name,
              arguments: typeof block.input === "string"
                ? block.input
                : JSON.stringify(block.input ?? {}),
            })
          }
        }
        if (parts.length > 0) {
          input.push({ type: "message", role: "assistant", content: parts })
        }
      }
      continue
    }

    // tool role (OpenAI format tool results)
    if (role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id,
        output: typeof content === "string" ? content : JSON.stringify(content),
      })
    }
  }

  const translated: any = {
    model: body.model,
    input,
    stream: body.stream ?? true,
  }

  // Forward supported fields
  if (body.max_tokens !== undefined) translated.max_output_tokens = body.max_tokens
  if (body.temperature !== undefined) translated.temperature = body.temperature

  // Translate tools
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    translated.tools = body.tools.map((t: any) => {
      if (t.type === "function") return t
      return {
        type: "function",
        name: t.name ?? t.function?.name,
        description: t.description ?? t.function?.description,
        parameters: t.parameters ?? t.function?.parameters ?? t.input_schema,
      }
    })
  }

  return translated
}

function extractText(content: any): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === "text" || b.type === "input_text" || b.type === "output_text")
      .map((b: any) => b.text ?? "")
      .join("")
  }
  return ""
}

// ---------------------------------------------------------------------------
// Non-streaming response translation: Responses API → OpenAI chat completion
// ---------------------------------------------------------------------------

function responsesNonStreamToChat(data: any, model: string): any {
  const id = data.id ?? `chatcmpl-${randomUUID()}`
  const content: string[] = []
  const toolCalls: any[] = []

  for (const item of data.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text") content.push(part.text)
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id ?? item.id,
        type: "function",
        function: { name: item.name, arguments: item.arguments ?? "{}" },
      })
    }
  }

  const finishReason = toolCalls.length > 0
    ? "tool_calls"
    : data.stop_reason === "max_tokens" ? "length" : "stop"

  const message: any = { role: "assistant", content: content.join("") || null }
  if (toolCalls.length > 0) message.tool_calls = toolCalls

  return {
    id,
    object: "chat.completion",
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: data.usage?.input_tokens ?? 0,
      completion_tokens: data.usage?.output_tokens ?? 0,
      total_tokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
    },
  }
}

// ---------------------------------------------------------------------------
// Streaming SSE translation: Responses events → OpenAI chat SSE chunks
// ---------------------------------------------------------------------------

interface ToolState {
  index: number
  id: string
  name: string
}

interface ResponsesStreamState {
  model: string
  id: string
  started: boolean
  toolByOutputIndex: Map<number, ToolState>
  toolByItemId: Map<string, ToolState>
  nextToolIndex: number
  hasToolCalls: boolean
}

function makeStreamState(model: string): ResponsesStreamState {
  return {
    model,
    id: `chatcmpl-${randomUUID()}`,
    started: false,
    toolByOutputIndex: new Map(),
    toolByItemId: new Map(),
    nextToolIndex: 0,
    hasToolCalls: false,
  }
}

function sseChunk(data: any): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

function makeChunkBase(state: ResponsesStreamState): any {
  return {
    id: state.id,
    object: "chat.completion.chunk",
    model: state.model,
    choices: [],
  }
}

function translateResponsesLine(line: string, state: ResponsesStreamState): string[] {
  if (!line.startsWith("data: ")) return []
  const raw = line.slice(6).trim()
  if (!raw || raw === "[DONE]") return []

  let payload: any
  try {
    payload = JSON.parse(raw)
  } catch {
    return []
  }

  const event: string = payload.type ?? ""
  const results: string[] = []

  const emit = (delta: any, finishReason: string | null = null) => {
    if (!state.started) {
      state.started = true
      // Emit initial role chunk
      const roleChunk = makeChunkBase(state)
      roleChunk.choices = [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]
      results.push(sseChunk(roleChunk))
    }
    const chunk = makeChunkBase(state)
    chunk.choices = [{ index: 0, delta, finish_reason: finishReason }]
    results.push(sseChunk(chunk))
  }

  switch (event) {
    case "response.created": {
      const responseId = payload.response?.id
      if (responseId) state.id = responseId
      break
    }

    case "response.output_text.delta": {
      const text: string = payload.delta ?? ""
      if (text) emit({ content: text })
      break
    }

    case "response.output_item.added": {
      const item = payload.item ?? {}
      if (item.type !== "function_call") break
      state.hasToolCalls = true
      const toolIndex = state.nextToolIndex++
      const toolId = item.call_id ?? item.id ?? randomUUID()
      const toolName: string = item.name ?? ""
      const toolState: ToolState = { index: toolIndex, id: toolId, name: toolName }
      const outputIndex: number = payload.output_index ?? 0
      state.toolByOutputIndex.set(outputIndex, toolState)
      if (item.id) state.toolByItemId.set(item.id, toolState)
      emit({
        tool_calls: [{
          index: toolIndex,
          id: toolId,
          type: "function",
          function: { name: toolName, arguments: "" },
        }]
      })
      break
    }

    case "response.function_call_arguments.delta": {
      const itemId: string = payload.item_id ?? ""
      const outputIndex: number = payload.output_index ?? 0
      const tool = state.toolByItemId.get(itemId) ?? state.toolByOutputIndex.get(outputIndex)
      if (!tool) break
      const delta: string = payload.delta ?? ""
      if (delta) {
        emit({ tool_calls: [{ index: tool.index, function: { arguments: delta } }] })
      }
      break
    }

    case "response.completed": {
      const finishReason = state.hasToolCalls
        ? "tool_calls"
        : (payload.response?.stop_reason === "max_tokens" ? "length" : "stop")
      const usage = payload.response?.usage
      const finalChunk = makeChunkBase(state)
      finalChunk.choices = [{ index: 0, delta: {}, finish_reason: finishReason }]
      if (usage) {
        finalChunk.usage = {
          prompt_tokens: usage.input_tokens ?? 0,
          completion_tokens: usage.output_tokens ?? 0,
          total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
        }
      }
      if (!state.started) {
        state.started = true
        const roleChunk = makeChunkBase(state)
        roleChunk.choices = [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]
        results.push(sseChunk(roleChunk))
      }
      results.push(sseChunk(finalChunk))
      break
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Shared fetch helper
// ---------------------------------------------------------------------------

async function fetchCopilot(
  url: string,
  token: string,
  requestId: string,
  body: any
): Promise<globalThis.Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      ...COPILOT_HEADERS,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Request-Id": requestId,
    },
    body: JSON.stringify(body),
  })
}
