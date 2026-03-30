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
 * Handles POST /v1/responses (Responses API format).
 * - Codex models: passthrough to Copilot /responses
 * - Copilot Claude models: translated to Copilot /chat/completions and back
 */
export async function handleResponsesDirect(c: Context): Promise<Response> {
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
    return proxyResponsesDirect(body, jwt, requestId, c)
  }

  return proxyResponsesViaChat(body, jwt, requestId, c)
}

async function proxyResponsesDirect(
  body: any,
  jwt: { token: string; endpoint: string },
  requestId: string,
  c: Context
): Promise<Response> {
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

async function proxyResponsesViaChat(
  body: any,
  jwt: { token: string; endpoint: string },
  requestId: string,
  c: Context
): Promise<Response> {
  const translatedBody = responsesToChatRequest(body)
  const model: string = body.model || ""
  const url = `${jwt.endpoint}/chat/completions`
  const upstream = await fetchCopilot(url, jwt.token, requestId, translatedBody)

  if (!upstream.ok) {
    if (upstream.status === 401) clearJWTCache()
    const errBody = await upstream.text()
    return c.json({ error: { type: "upstream_error", message: errBody } }, upstream.status as any)
  }

  const stream = body.stream ?? true
  if (!stream) {
    const data = await upstream.json()
    return c.json(chatNonStreamToResponses(data, model))
  }

  const responseStream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      const reader = upstream.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let state: ChatToResponsesStreamState = makeChatToResponsesState(model)

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""

          for (const line of lines) {
            const chunks = translateChatLineToResponses(line, state)
            for (const chunk of chunks) {
              controller.enqueue(encoder.encode(chunk))
            }
          }
        }
        if (buffer) {
          const chunks = translateChatLineToResponses(buffer, state)
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
    },
  })

  return new Response(responseStream, {
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
// Request translation: OpenAI Responses input → OpenAI chat messages
// ---------------------------------------------------------------------------

export function responsesToChatRequest(body: any): any {
  const messages: any[] = []

  if (typeof body.instructions === "string" && body.instructions.trim()) {
    messages.push({ role: "system", content: body.instructions })
  }

  const input = body.input
  const items = typeof input === "string"
    ? [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }]
    : Array.isArray(input)
      ? input
      : (input ? [input] : [])

  for (const item of items) {
    if (!item || typeof item !== "object") continue

    if (item.type === "message") {
      const rawRole = item.role ?? "user"
      const role = rawRole === "developer" ? "system" : rawRole
      const content = extractText(item.content)
      messages.push({ role, content })
      continue
    }

    if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: item.call_id ?? item.id ?? randomUUID(),
          type: "function",
          function: {
            name: item.name ?? "",
            arguments: item.arguments ?? "{}",
          },
        }],
      })
      continue
    }

    if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id ?? item.id ?? randomUUID(),
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
      })
    }
  }

  if (messages.length === 0) {
    messages.push({ role: "user", content: "" })
  }

  const translated: any = {
    model: body.model,
    messages,
    stream: body.stream ?? true,
  }

  if (body.max_output_tokens !== undefined) translated.max_tokens = body.max_output_tokens
  if (body.temperature !== undefined) translated.temperature = body.temperature
  if (body.top_p !== undefined) translated.top_p = body.top_p

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    translated.tools = body.tools.map((tool: any) => ({
      type: "function",
      function: {
        name: tool.name ?? tool.function?.name,
        description: tool.description ?? tool.function?.description,
        parameters: tool.parameters ?? tool.function?.parameters ?? tool.input_schema ?? { type: "object", properties: {} },
      },
    }))
  }

  if (body.tool_choice !== undefined) translated.tool_choice = body.tool_choice

  return translated
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
// Non-streaming response translation: OpenAI chat completion → Responses API
// ---------------------------------------------------------------------------

export function chatNonStreamToResponses(data: any, model: string): any {
  const choice = data?.choices?.[0] ?? {}
  const message = choice.message ?? {}
  const usage = data?.usage ?? {}
  const output: any[] = []

  const text = typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content
        .filter((part: any) => part?.type === "text")
        .map((part: any) => part.text ?? "")
        .join("")
      : ""

  if (text) {
    output.push({
      type: "message",
      id: `msg_${randomUUID()}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    })
  }

  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      output.push({
        type: "function_call",
        id: call.id ?? `fc_${randomUUID()}`,
        call_id: call.id ?? `call_${randomUUID()}`,
        name: call.function?.name ?? "",
        arguments: call.function?.arguments ?? "{}",
      })
    }
  }

  const now = Math.floor(Date.now() / 1000)
  const stopReason = choice.finish_reason === "length"
    ? "max_output_tokens"
    : choice.finish_reason === "tool_calls"
      ? "tool_calls"
      : "stop"

  return {
    id: data?.id ?? `resp_${randomUUID()}`,
    object: "response",
    created_at: now,
    status: "completed",
    model,
    output,
    output_text: text || null,
    parallel_tool_calls: Array.isArray(message.tool_calls) && message.tool_calls.length > 1,
    stop_reason: stopReason,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? ((usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)),
    },
  }
}

// ---------------------------------------------------------------------------
// Streaming SSE translation: Responses events → OpenAI chat SSE chunks
// ---------------------------------------------------------------------------

interface ChatToResponsesToolState {
  outputIndex: number
  itemId: string
  callId: string
  name: string
  arguments: string
}

interface ChatToResponsesStreamState {
  id: string
  model: string
  createdAt: number
  started: boolean
  completed: boolean
  nextOutputIndex: number
  messageOutputIndex: number | null
  messageItemId: string
  messageText: string
  toolByIndex: Map<number, ChatToResponsesToolState>
  usage: { input_tokens: number; output_tokens: number; total_tokens: number } | null
}

function makeChatToResponsesState(model: string): ChatToResponsesStreamState {
  return {
    id: `resp_${randomUUID()}`,
    model,
    createdAt: Math.floor(Date.now() / 1000),
    started: false,
    completed: false,
    nextOutputIndex: 0,
    messageOutputIndex: null,
    messageItemId: `msg_${randomUUID()}`,
    messageText: "",
    toolByIndex: new Map(),
    usage: null,
  }
}

function makeResponsesSSEChunk(payload: any): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function ensureChatResponsesCreated(state: ChatToResponsesStreamState, out: string[]): void {
  if (state.started) return
  state.started = true
  out.push(makeResponsesSSEChunk({
    type: "response.created",
    response: {
      id: state.id,
      object: "response",
      created_at: state.createdAt,
      model: state.model,
      status: "in_progress",
      output: [],
    },
  }))
}

function finishReasonChatToResponses(reason: string | null | undefined): string {
  if (reason === "length") return "max_output_tokens"
  if (reason === "tool_calls") return "tool_calls"
  return "stop"
}

function translateChatLineToResponses(line: string, state: ChatToResponsesStreamState): string[] {
  if (!line.startsWith("data: ")) return []
  const raw = line.slice(6).trim()
  if (!raw || raw === "[DONE]") return []

  let payload: any
  try {
    payload = JSON.parse(raw)
  } catch {
    return []
  }

  const out: string[] = []

  state.id = payload.id ?? state.id
  state.model = payload.model ?? state.model

  const choices: any[] = Array.isArray(payload.choices) ? payload.choices : []
  if (choices.length === 0) return out

  ensureChatResponsesCreated(state, out)

  for (const choice of choices) {
    const delta = choice.delta ?? {}

    if (typeof delta.content === "string" && delta.content.length > 0) {
      if (state.messageOutputIndex === null) {
        state.messageOutputIndex = state.nextOutputIndex++
      }
      state.messageText += delta.content
      out.push(makeResponsesSSEChunk({
        type: "response.output_text.delta",
        output_index: state.messageOutputIndex,
        item_id: state.messageItemId,
        content_index: 0,
        delta: delta.content,
      }))
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const toolDelta of delta.tool_calls) {
        const index: number = toolDelta.index ?? 0
        let tool = state.toolByIndex.get(index)
        if (!tool) {
          tool = {
            outputIndex: state.nextOutputIndex++,
            itemId: `fc_${randomUUID()}`,
            callId: toolDelta.id ?? `call_${randomUUID()}`,
            name: toolDelta.function?.name ?? "",
            arguments: "",
          }
          state.toolByIndex.set(index, tool)
          out.push(makeResponsesSSEChunk({
            type: "response.output_item.added",
            output_index: tool.outputIndex,
            item: {
              type: "function_call",
              id: tool.itemId,
              call_id: tool.callId,
              name: tool.name,
              arguments: "",
            },
          }))
        }

        if (toolDelta.function?.name && !tool.name) {
          tool.name = toolDelta.function.name
        }

        const argDelta = toolDelta.function?.arguments
        if (typeof argDelta === "string" && argDelta.length > 0) {
          tool.arguments += argDelta
          out.push(makeResponsesSSEChunk({
            type: "response.function_call_arguments.delta",
            item_id: tool.itemId,
            output_index: tool.outputIndex,
            delta: argDelta,
          }))
        }
      }
    }

    if (choice.finish_reason !== null && choice.finish_reason !== undefined && !state.completed) {
      state.completed = true
      const usage = payload.usage
      if (usage) {
        state.usage = {
          input_tokens: usage.prompt_tokens ?? 0,
          output_tokens: usage.completion_tokens ?? 0,
          total_tokens: usage.total_tokens ?? ((usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)),
        }
      }

      const outputItems: Array<{ index: number; value: any }> = []
      if (state.messageOutputIndex !== null) {
        outputItems.push({
          index: state.messageOutputIndex,
          value: {
            type: "message",
            id: state.messageItemId,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: state.messageText, annotations: [] }],
          },
        })
      }
      for (const tool of state.toolByIndex.values()) {
        outputItems.push({
          index: tool.outputIndex,
          value: {
            type: "function_call",
            id: tool.itemId,
            call_id: tool.callId,
            name: tool.name,
            arguments: tool.arguments,
          },
        })
      }
      outputItems.sort((a, b) => a.index - b.index)

      out.push(makeResponsesSSEChunk({
        type: "response.completed",
        response: {
          id: state.id,
          object: "response",
          created_at: state.createdAt,
          model: state.model,
          status: "completed",
          stop_reason: finishReasonChatToResponses(choice.finish_reason),
          output: outputItems.map((item) => item.value),
          usage: state.usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        },
      }))
    }
  }

  return out
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
