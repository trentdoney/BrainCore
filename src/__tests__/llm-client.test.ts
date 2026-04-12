import { describe, expect, test } from "bun:test";
import { LLMClient } from "../llm/client";

describe("LLMClient fallback behavior", () => {
  test("falls back from unhealthy vLLM endpoints directly to Claude CLI", async () => {
    const client = new LLMClient() as any;
    let claudeCalled = false;
    let codexCalled = false;

    client.healthCheck = async (endpoint: { name: string; url: string }) => ({
      name: endpoint.name,
      url: endpoint.url,
      healthy: false,
      error: "offline",
    });
    client.completeWithCLI = async () => {
      claudeCalled = true;
      return {
        content: "{}",
        model: "claude-haiku-4-5-20251001",
        provider: "claude-cli",
        durationMs: 1,
      };
    };
    client["complete" + "WithCodex"] = async () => {
      codexCalled = true;
      throw new Error("agent fallback should not be invoked");
    };

    const response = await client.complete({
      systemPrompt: "system",
      userMessage: "user",
      jsonMode: true,
    });

    expect(response.provider).toBe("claude-cli");
    expect(claudeCalled).toBe(true);
    expect(codexCalled).toBe(false);
  });
});
