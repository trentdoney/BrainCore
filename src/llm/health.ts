/**
 * health.ts — vLLM endpoint health checker.
 * Probes /models on each configured endpoint with a fast timeout.
 */

import { config } from "../config";

export interface EndpointHealth {
  name: string;
  url: string;
  healthy: boolean;
  model?: string;
  latencyMs?: number;
  error?: string;
}

export async function checkEndpoint(endpoint: { name: string; url: string }): Promise<EndpointHealth> {
  const start = performance.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.vllm.healthTimeout);

    const res = await fetch(`${endpoint.url}/models`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return {
        name: endpoint.name,
        url: endpoint.url,
        healthy: false,
        latencyMs: Math.round(performance.now() - start),
        error: `HTTP ${res.status}`,
      };
    }

    const body = (await res.json()) as { data?: Array<{ id: string }> };
    const model = body.data?.[0]?.id;

    return {
      name: endpoint.name,
      url: endpoint.url,
      healthy: true,
      model,
      latencyMs: Math.round(performance.now() - start),
    };
  } catch (e: any) {
    return {
      name: endpoint.name,
      url: endpoint.url,
      healthy: false,
      latencyMs: Math.round(performance.now() - start),
      error: e.message || "Unknown error",
    };
  }
}

export async function checkAllEndpoints(): Promise<EndpointHealth[]> {
  const endpoints = config.vllm.endpoints
    .slice()
    .sort((a, b) => a.priority - b.priority);

  const results = await Promise.all(endpoints.map(checkEndpoint));
  return results;
}
