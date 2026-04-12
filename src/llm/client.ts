/**
 * client.ts — LLM client with automatic CLI fallbacks.
 * Tries local vLLM endpoints in priority order. If ALL are unhealthy,
 * automatically falls back to Codex GPT-5.4 Mini, then Claude Haiku.
 */

import { config } from "../config";
import { checkEndpoint, type EndpointHealth } from "./health";

export interface LLMResponse {
  content: string;
  model: string;
  provider: "vllm" | "codex-cli" | "claude-cli";
  durationMs: number;
  endpoint?: string;
}

export interface CompletionOpts {
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
}

export class LLMClient {
  private endpointCache: Map<string, { health: EndpointHealth; cachedAt: number }> = new Map();
  private cacheMaxAge = 30_000; // 30s health cache

  /**
   * Health check a single endpoint. Caches results for 30 seconds.
   */
  async healthCheck(endpoint: { name: string; url: string }): Promise<EndpointHealth> {
    const cached = this.endpointCache.get(endpoint.url);
    if (cached && Date.now() - cached.cachedAt < this.cacheMaxAge) {
      return cached.health;
    }
    const health = await checkEndpoint(endpoint);
    this.endpointCache.set(endpoint.url, { health, cachedAt: Date.now() });
    return health;
  }

  /**
   * Try local vLLM endpoints in priority order. First healthy endpoint wins.
   * If ALL endpoints are unhealthy, fall back to Codex first, then Claude CLI.
   */
  async complete(opts: CompletionOpts): Promise<LLMResponse> {
    const endpoints = config.vllm.endpoints
      .slice()
      .sort((a, b) => a.priority - b.priority);

    for (const ep of endpoints) {
      const health = await this.healthCheck(ep);
      if (!health.healthy) {
        console.error(`  [llm] ${ep.name} (${ep.url}): unhealthy — ${health.error}`);
        continue;
      }

      console.error(`  [llm] Using ${ep.name} (${health.model || "unknown model"})`);

      try {
        const result = await this.callVLLM(ep, health.model || "unknown", opts);
        return result;
      } catch (e: any) {
        console.error(`  [llm] ${ep.name} request failed: ${e.message}`);
        this.endpointCache.delete(ep.url);
        continue;
      }
    }

    // ALL endpoints failed — automatic fallback to Codex CLI first.
    console.error("  [llm] All vLLM endpoints unhealthy. Falling back to Codex CLI.");
    await this.sendTelegramAlert("Local LLM offline, falling back to Codex GPT-5.4 Mini for extraction");

    try {
      return await this.completeWithCodex(opts);
    } catch (e: any) {
      console.error(`  [llm] Codex CLI fallback failed: ${e.message}`);
      console.error("  [llm] Falling back to Claude CLI.");
      await this.sendTelegramAlert("Codex fallback failed, falling back to Claude CLI for extraction");
      return this.completeWithCLI(opts);
    }
  }

  private buildCliPrompt(opts: CompletionOpts): string {
    return [
      "You are a non-interactive BrainCore extraction backend.",
      "Do not inspect files, run shell commands, or use tools. Produce only the requested response.",
      opts.systemPrompt,
      opts.userMessage,
    ].join("\n\n");
  }

  /**
   * Automatic fallback to Claude CLI (Haiku model).
   * Pipes the prompt via stdin to avoid shell escaping issues.
   */
  async completeWithCLI(opts: CompletionOpts): Promise<LLMResponse> {
    const start = performance.now();
    const fullPrompt = this.buildCliPrompt(opts);

    const proc = Bun.spawn(
      ["claude", "--print", "--model", "claude-haiku-4-5-20251001", "--max-turns", "1", "-p", "-"],
      {
        stdout: "pipe",
        stderr: "pipe",
        stdin: new Blob([fullPrompt]),
        env: { ...process.env },
      },
    );

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    const durationMs = Math.round(performance.now() - start);

    if (exitCode !== 0) {
      throw new Error(`Claude CLI exited ${exitCode}: ${stderr.slice(0, 500)}`);
    }

    console.error(`  [llm] Claude CLI fallback completed in ${durationMs}ms`);

    return {
      content: stdout.trim(),
      model: "claude-haiku-4-5-20251001",
      provider: "claude-cli",
      durationMs,
    };
  }

  /**
   * Primary cloud fallback to Codex CLI (GPT-5.4 Mini).
   * Pipes the prompt via stdin and runs read-only/ephemeral to avoid repo edits.
   */
  async completeWithCodex(opts: CompletionOpts): Promise<LLMResponse> {
    const start = performance.now();
    const fullPrompt = this.buildCliPrompt(opts);
    let timedOut = false;

    const proc = Bun.spawn(
      [
        config.codex.bin,
        "exec",
        "--model",
        config.codex.model,
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--ephemeral",
        "--color",
        "never",
        "-",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        stdin: new Blob([fullPrompt]),
        env: { ...process.env },
      },
    );

    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, config.codex.timeout);

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    clearTimeout(timeout);
    const durationMs = Math.round(performance.now() - start);

    if (timedOut) {
      throw new Error(`Codex CLI timed out after ${config.codex.timeout}ms`);
    }
    if (exitCode !== 0) {
      throw new Error(`Codex CLI exited ${exitCode}: ${stderr.slice(0, 500)}`);
    }

    console.error(`  [llm] Codex CLI fallback completed in ${durationMs}ms`);

    return {
      content: stdout.trim(),
      model: config.codex.model,
      provider: "codex-cli",
      durationMs,
    };
  }

  /**
   * Explicit escalation to Claude CLI (Sonnet/Opus level).
   * Only called when the operator deliberately requests --use-claude.
   */
  async completeWithClaude(opts: CompletionOpts): Promise<LLMResponse> {
    const start = performance.now();
    const fullPrompt = this.buildCliPrompt(opts);

    const proc = Bun.spawn(
      ["claude", "--print", "--output-format", "json", "--max-turns", "1", "-p", "-"],
      {
        stdout: "pipe",
        stderr: "pipe",
        stdin: new Blob([fullPrompt]),
        env: { ...process.env },
      },
    );

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    const durationMs = Math.round(performance.now() - start);

    if (exitCode !== 0) {
      throw new Error(`Claude CLI exited ${exitCode}: ${stderr.slice(0, 500)}`);
    }

    let content: string;
    try {
      const parsed = JSON.parse(stdout);
      content = parsed.result || parsed.content || stdout;
    } catch {
      content = stdout.trim();
    }

    return { content, model: "claude-cli", provider: "claude-cli", durationMs };
  }

  /**
   * Send a Telegram alert (optional, for monitoring).
   */
  private async sendTelegramAlert(message: string): Promise<void> {
    try {
      const token = config.telegram.botToken;
      const chatId = config.telegram.chatId;
      if (!token || !chatId) return;

      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: `BrainCore: ${message}` }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // Best-effort
    }
  }

  /**
   * Call a vLLM endpoint with OpenAI-compatible chat completions API.
   */
  private async callVLLM(
    endpoint: { name: string; url: string },
    model: string,
    opts: CompletionOpts,
  ): Promise<LLMResponse> {
    const start = performance.now();

    const body: Record<string, any> = {
      model,
      messages: [
        { role: "system", content: opts.systemPrompt },
        { role: "user", content: opts.userMessage },
      ],
      max_tokens: opts.maxTokens ?? 4096,
      temperature: opts.temperature ?? 0.1,
    };

    if (opts.jsonMode) {
      body.response_format = { type: "json_object" };
    }

    if (model.toLowerCase().includes("qwen")) {
      body.chat_template_kwargs = { enable_thinking: false };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.vllm.requestTimeout);

    try {
      const res = await fetch(`${endpoint.url}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 300)}`);
      }

      const data = (await res.json()) as {
        choices: Array<{ message: { content: string } }>;
        model: string;
      };

      const content = data.choices?.[0]?.message?.content || "";
      const durationMs = Math.round(performance.now() - start);

      return {
        content,
        model: data.model || model,
        provider: "vllm",
        durationMs,
        endpoint: endpoint.name,
      };
    } catch (e) {
      clearTimeout(timeout);
      throw e;
    }
  }
}
