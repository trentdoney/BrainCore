import { describe, expect, test } from "bun:test";
import { LLMClient } from "../llm/client";

describe("LLMClient fallback behavior", () => {
  test("does not fall back to Claude CLI unless explicitly enabled", async () => {
    process.env.BRAINCORE_POSTGRES_DSN ??= "postgres://test:test@localhost:5432/test";
    delete process.env.BRAINCORE_ALLOW_EXTERNAL_LLM_FALLBACK;

    const client = new LLMClient() as any;
    let claudeCalled = false;
    let codexCalled = false;
    let telegramCalled = false;

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
    client.sendTelegramAlert = async () => {
      telegramCalled = true;
    };

    await expect(
      client.complete({
        systemPrompt: "system",
        userMessage: "user",
        jsonMode: true,
      }),
    ).rejects.toThrow("external LLM fallback is disabled");

    expect(claudeCalled).toBe(false);
    expect(codexCalled).toBe(false);
    expect(telegramCalled).toBe(false);
  });

  test("falls back from unhealthy vLLM endpoints when env opt-in is set", async () => {
    process.env.BRAINCORE_POSTGRES_DSN ??= "postgres://test:test@localhost:5432/test";
    process.env.BRAINCORE_ALLOW_EXTERNAL_LLM_FALLBACK = "1";

    try {
      const client = new LLMClient() as any;
      let claudeCalled = false;

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

      const response = await client.complete({
        systemPrompt: "system",
        userMessage: "user",
        jsonMode: true,
      });

      expect(response.provider).toBe("claude-cli");
      expect(claudeCalled).toBe(true);
    } finally {
      delete process.env.BRAINCORE_ALLOW_EXTERNAL_LLM_FALLBACK;
    }
  });
});
