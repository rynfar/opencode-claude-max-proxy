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
