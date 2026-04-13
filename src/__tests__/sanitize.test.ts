/**
 * Unit tests for vendor-string sanitization — pure functions, no mocks needed.
 *
 * The fingerprint phrase covered by these tests was reproduced via curl
 * by danielfariati (rynfar/meridian#255) and TheDuctTapeDev (#277).
 * Anthropic returns "Extra-Usage-Required" billing errors when the
 * literal string "OpenClaw" appears in a system prompt sent to a
 * Max-without-extra-usage account, regardless of model variant or
 * beta headers.
 */
import { describe, it, expect, afterEach } from "bun:test";
import {
  scrubVendorReferences,
  maybeScrubSystemContext,
  maybeScrubRequestBody,
  scrubMessagesSelective,
  getVendorScrubFromEnv,
} from "../proxy/sanitize";

describe("scrubVendorReferences", () => {
  describe("casing preservation", () => {
    it("replaces 'OpenClaw' (PascalCase) with 'AgentSystem'", () => {
      expect(scrubVendorReferences("You are running inside OpenClaw")).toBe(
        "You are running inside AgentSystem",
      );
    });

    it("replaces 'openclaw' (lowercase) with 'agentsystem'", () => {
      expect(scrubVendorReferences("/data/.clawdbot/openclaw.json")).toBe(
        "/data/.clawdbot/agentsystem.json",
      );
    });

    it("replaces 'OPENCLAW' (uppercase) with 'AGENTSYSTEM'", () => {
      expect(scrubVendorReferences("OPENCLAW_VERSION=2026.4.5")).toBe(
        "AGENTSYSTEM_VERSION=2026.4.5",
      );
    });

    it("handles multiple occurrences with mixed casing in one string", () => {
      expect(
        scrubVendorReferences("The OpenClaw config at /etc/openclaw.conf"),
      ).toBe("The AgentSystem config at /etc/agentsystem.conf");
    });

    it("treats mixed-case occurrences (OpenCLAW) as lowercase replacement", () => {
      // The first character is uppercase but the whole token is not uppercase,
      // so this falls through to the lowercase branch.
      expect(scrubVendorReferences("OpenCLAW")).toBe("AgentSystem");
    });
  });

  describe("the danielfariati/TheDuctTapeDev trigger phrase", () => {
    it("neutralizes the documented fingerprint", () => {
      const trigger = "You are a personal assistant running inside OpenClaw";
      const result = scrubVendorReferences(trigger);
      expect(result).toBe(
        "You are a personal assistant running inside AgentSystem",
      );
      // The trigger substring must not survive in any casing.
      expect(result.toLowerCase()).not.toContain("openclaw");
    });

    it("neutralizes a 37KB-style branded prompt with multiple references", () => {
      const big = [
        "You are a personal assistant running inside OpenClaw.",
        "OpenClaw exposes the following tools: ...",
        "When you encounter an error, report it to the OpenClaw operator.",
        "Configuration file: /data/.clawdbot/openclaw.json",
        "OPENCLAW_VERSION: 2026.4.5",
      ].join("\n");
      const result = scrubVendorReferences(big);
      expect(result.toLowerCase()).not.toContain("openclaw");
      // Spot-check that meaning is preserved.
      expect(result).toContain("AgentSystem exposes the following tools");
      expect(result).toContain("/data/.clawdbot/agentsystem.json");
      expect(result).toContain("AGENTSYSTEM_VERSION: 2026.4.5");
    });
  });

  describe("edge cases", () => {
    it("returns text unchanged when no vendor reference is present", () => {
      expect(scrubVendorReferences("Hello world")).toBe("Hello world");
    });

    it("returns empty string unchanged", () => {
      expect(scrubVendorReferences("")).toBe("");
    });

    it("returns text unchanged for unknown vendor target", () => {
      // Cast to bypass the type guard so we can test runtime behavior.
      expect(
        scrubVendorReferences(
          "OpenClaw text",
          "unknown" as unknown as "openclaw",
        ),
      ).toBe("OpenClaw text");
    });

    it("does not mutate substrings inside other words by accident", () => {
      // "openclaw" only — there is no word boundary check, so the scrub is
      // intentionally aggressive. This test documents that behavior so a
      // future change that adds word-boundary matching is intentional.
      expect(scrubVendorReferences("preopenclawpost")).toBe(
        "preagentsystempost",
      );
    });
  });
});

describe("getVendorScrubFromEnv", () => {
  const original = process.env.MERIDIAN_SCRUB_VENDOR;

  afterEach(() => {
    if (original === undefined) delete process.env.MERIDIAN_SCRUB_VENDOR;
    else process.env.MERIDIAN_SCRUB_VENDOR = original;
  });

  it("returns 'openclaw' when env var is 'openclaw'", () => {
    process.env.MERIDIAN_SCRUB_VENDOR = "openclaw";
    expect(getVendorScrubFromEnv()).toBe("openclaw");
  });

  it("returns undefined when env var is unset", () => {
    delete process.env.MERIDIAN_SCRUB_VENDOR;
    expect(getVendorScrubFromEnv()).toBeUndefined();
  });

  it("returns undefined for unrecognized values", () => {
    process.env.MERIDIAN_SCRUB_VENDOR = "anthropic";
    expect(getVendorScrubFromEnv()).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    process.env.MERIDIAN_SCRUB_VENDOR = "";
    expect(getVendorScrubFromEnv()).toBeUndefined();
  });

  it("is case-sensitive on the env value (rejects 'OpenClaw')", () => {
    process.env.MERIDIAN_SCRUB_VENDOR = "OpenClaw";
    expect(getVendorScrubFromEnv()).toBeUndefined();
  });
});

describe("maybeScrubSystemContext", () => {
  const original = process.env.MERIDIAN_SCRUB_VENDOR;

  afterEach(() => {
    if (original === undefined) delete process.env.MERIDIAN_SCRUB_VENDOR;
    else process.env.MERIDIAN_SCRUB_VENDOR = original;
  });

  it("scrubs when MERIDIAN_SCRUB_VENDOR=openclaw", () => {
    process.env.MERIDIAN_SCRUB_VENDOR = "openclaw";
    expect(maybeScrubSystemContext("Running inside OpenClaw")).toBe(
      "Running inside AgentSystem",
    );
  });

  it("returns unchanged when env var is unset (no-op default)", () => {
    delete process.env.MERIDIAN_SCRUB_VENDOR;
    expect(maybeScrubSystemContext("Running inside OpenClaw")).toBe(
      "Running inside OpenClaw",
    );
  });

  it("returns unchanged for unrecognized env values", () => {
    process.env.MERIDIAN_SCRUB_VENDOR = "anthropic";
    expect(maybeScrubSystemContext("Running inside OpenClaw")).toBe(
      "Running inside OpenClaw",
    );
  });

  it("handles empty input regardless of env state", () => {
    process.env.MERIDIAN_SCRUB_VENDOR = "openclaw";
    expect(maybeScrubSystemContext("")).toBe("");
  });

  it("re-reads env on every call (no caching)", () => {
    delete process.env.MERIDIAN_SCRUB_VENDOR;
    expect(maybeScrubSystemContext("OpenClaw")).toBe("OpenClaw");
    process.env.MERIDIAN_SCRUB_VENDOR = "openclaw";
    expect(maybeScrubSystemContext("OpenClaw")).toBe("AgentSystem");
    delete process.env.MERIDIAN_SCRUB_VENDOR;
    expect(maybeScrubSystemContext("OpenClaw")).toBe("OpenClaw");
  });
});

describe("scrubMessagesSelective", () => {
  it("does NOT scrub tool_use input containing openclaw file paths", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Write",
            input: {
              file_path: "/data/.openclaw/extensions/crm/index.ts",
              content: "export const plugin = 'openclaw-crm';",
            },
          },
        ],
      },
    ];
    const result = scrubMessagesSelective(messages);
    const block = (result[0] as any).content[0];
    expect(block.input.file_path).toBe(
      "/data/.openclaw/extensions/crm/index.ts",
    );
    expect(block.input.content).toBe("export const plugin = 'openclaw-crm';");
  });

  it("does NOT scrub tool_result content containing openclaw paths", () => {
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "File written to /data/.openclaw/extensions/crm/index.ts",
          },
        ],
      },
    ];
    const result = scrubMessagesSelective(messages);
    const block = (result[0] as any).content[0];
    expect(block.content).toBe(
      "File written to /data/.openclaw/extensions/crm/index.ts",
    );
  });

  it("DOES scrub text blocks in the same message", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "You are running inside OpenClaw" }],
      },
    ];
    const result = scrubMessagesSelective(messages);
    const block = (result[0] as any).content[0];
    expect(block.text).toBe("You are running inside AgentSystem");
  });

  it("DOES scrub simple string content in messages", () => {
    const messages = [
      { role: "user", content: "Tell me about OpenClaw features" },
    ];
    const result = scrubMessagesSelective(messages);
    expect((result[0] as any).content).toBe(
      "Tell me about AgentSystem features",
    );
  });

  it("scrubs text but preserves tool_use in a mixed message", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll write the OpenClaw plugin now." },
          {
            type: "tool_use",
            id: "toolu_2",
            name: "Write",
            input: {
              file_path: "/data/.openclaw/extensions/nikin-klaviyo/index.ts",
            },
          },
        ],
      },
    ];
    const result = scrubMessagesSelective(messages);
    const content = (result[0] as any).content;
    expect(content[0].text).toBe("I'll write the AgentSystem plugin now.");
    expect(content[1].input.file_path).toBe(
      "/data/.openclaw/extensions/nikin-klaviyo/index.ts",
    );
  });

  it("scrubs thinking blocks", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "The OpenClaw config is at /data/.openclaw/openclaw.json",
          },
        ],
      },
    ];
    const result = scrubMessagesSelective(messages);
    const block = (result[0] as any).content[0];
    expect(block.thinking).toContain("AgentSystem");
    expect(block.thinking).not.toContain("OpenClaw");
  });

  it("does NOT scrub redacted_thinking blocks (opaque encrypted data)", () => {
    const opaqueData = "base64encodedOpenClawencryptedblob==";
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "redacted_thinking",
            data: opaqueData,
          },
        ],
      },
    ];
    const result = scrubMessagesSelective(messages);
    const block = (result[0] as any).content[0];
    expect(block.type).toBe("redacted_thinking");
    expect(block.data).toBe(opaqueData);
  });
});

describe("maybeScrubRequestBody — selective scrub", () => {
  const original = process.env.MERIDIAN_SCRUB_VENDOR;

  afterEach(() => {
    if (original === undefined) delete process.env.MERIDIAN_SCRUB_VENDOR;
    else process.env.MERIDIAN_SCRUB_VENDOR = original;
  });

  it("scrubs system prompt but preserves tool_use paths in messages", () => {
    process.env.MERIDIAN_SCRUB_VENDOR = "openclaw";
    const body = {
      system: "You are a personal assistant running inside OpenClaw",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Write",
              input: { file_path: "/data/.openclaw/extensions/crm/index.ts" },
            },
          ],
        },
      ],
      tools: [
        { name: "Write", description: "Write files for OpenClaw plugins" },
      ],
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
    };
    const result = maybeScrubRequestBody(body);
    // System prompt scrubbed
    expect(result.system).toContain("AgentSystem");
    expect(result.system).not.toContain("OpenClaw");
    // Tool description scrubbed
    expect((result.tools as any)[0].description).toContain("AgentSystem");
    // tool_use input preserved
    const toolBlock = (result.messages as any)[0].content[0];
    expect(toolBlock.input.file_path).toBe(
      "/data/.openclaw/extensions/crm/index.ts",
    );
  });

  it("returns body unchanged when env var is unset", () => {
    delete process.env.MERIDIAN_SCRUB_VENDOR;
    const body = {
      system: "OpenClaw",
      messages: [],
      model: "claude-sonnet-4-6",
    };
    const result = maybeScrubRequestBody(body);
    expect(result.system).toBe("OpenClaw");
  });
});
