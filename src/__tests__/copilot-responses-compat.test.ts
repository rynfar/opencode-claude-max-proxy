import { describe, expect, it } from "bun:test"
import { chatNonStreamToResponses, responsesToChatRequest } from "../proxy/copilot/handler"

describe("responsesToChatRequest", () => {
  it("converts responses text input to a chat user message", () => {
    const converted = responsesToChatRequest({
      model: "claude-sonnet-4.6",
      input: "Hello from responses",
      stream: false,
    })

    expect(converted.model).toBe("claude-sonnet-4.6")
    expect(converted.stream).toBe(false)
    expect(converted.messages).toEqual([
      { role: "user", content: "Hello from responses" },
    ])
  })

  it("converts function_call_output items to chat tool messages", () => {
    const converted = responsesToChatRequest({
      model: "claude-opus-4.6",
      input: [
        {
          type: "function_call_output",
          call_id: "call_123",
          output: "result payload",
        },
      ],
    })

    expect(converted.messages).toEqual([
      {
        role: "tool",
        tool_call_id: "call_123",
        content: "result payload",
      },
    ])
  })
})

describe("chatNonStreamToResponses", () => {
  it("converts non-stream chat completion with tool calls to responses format", () => {
    const converted = chatNonStreamToResponses({
      id: "chatcmpl_1",
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: "I'll call a tool",
          tool_calls: [{
            id: "call_abc",
            type: "function",
            function: {
              name: "search",
              arguments: "{\"q\":\"hello\"}",
            },
          }],
        },
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    }, "claude-opus-4.6")

    expect(converted.object).toBe("response")
    expect(converted.model).toBe("claude-opus-4.6")
    expect(converted.stop_reason).toBe("tool_calls")
    expect(converted.usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    })
    expect(converted.output.some((item: any) => item.type === "message")).toBe(true)
    expect(converted.output.some((item: any) => item.type === "function_call")).toBe(true)
  })
})
