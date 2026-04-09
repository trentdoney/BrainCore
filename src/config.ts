/**
 * config.ts — BrainCore configuration from environment variables.
 * All secrets and infrastructure addresses come from env vars.
 * Copy .env.example to .env and fill in your values.
 *
 * Config is exposed as a lazy Proxy: requiredEnv() calls are deferred
 * until a property is actually read. This lets commands like
 * `bun src/cli.ts --help` succeed even without a populated .env.
 */

function requiredEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function env(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

interface Config {
  tenant: string;
  postgres: { dsn: string };
  archive: { root: string; redundancyTarget: string };
  opsvault: { root: string };
  vllm: {
    endpoints: Array<{ name: string; url: string; priority: number }>;
    healthTimeout: number;
    requestTimeout: number;
  };
  embed: { url: string };
  telegram: { botToken: string; chatId: string };
  grafana: { baseUrl: string; apiKey: string };
}

function buildConfig(): Config {
  return {
    tenant: env("BRAINCORE_TENANT", "default"),
    postgres: {
      dsn: requiredEnv("BRAINCORE_POSTGRES_DSN"),
    },
    archive: {
      root: env("BRAINCORE_ARCHIVE_ROOT", "./data/archive"),
      redundancyTarget: env("BRAINCORE_ARCHIVE_BACKUP", "./data/archive-backup"),
    },
    opsvault: {
      root: env("BRAINCORE_VAULT_ROOT", "./data/vault"),
    },
    vllm: {
      endpoints: (process.env.BRAINCORE_VLLM_ENDPOINTS || "work=http://localhost:8006/v1")
        .split(",")
        .map((entry, i) => {
          const [name, url] = entry.includes("=") ? entry.split("=", 2) : [`endpoint-${i}`, entry];
          return { name: name.trim(), url: url.trim(), priority: i + 1 };
        }),
      healthTimeout: parseInt(env("BRAINCORE_VLLM_HEALTH_TIMEOUT", "3000"), 10),
      requestTimeout: parseInt(env("BRAINCORE_VLLM_REQUEST_TIMEOUT", "120000"), 10),
    },
    embed: {
      url: env("BRAINCORE_EMBED_URL", "http://localhost:8900/embed"),
    },
    telegram: {
      botToken: env("BRAINCORE_TELEGRAM_BOT_TOKEN", ""),
      chatId: env("BRAINCORE_TELEGRAM_CHAT_ID", ""),
    },
    grafana: {
      baseUrl: env("BRAINCORE_GRAFANA_URL", "http://localhost:3010"),
      apiKey: env("BRAINCORE_GRAFANA_API_KEY", ""),
    },
  };
}

let _config: Config | null = null;

export const config = new Proxy({} as Config, {
  get(_target, prop) {
    if (_config === null) _config = buildConfig();
    return (_config as any)[prop];
  },
  has(_target, prop) {
    if (_config === null) _config = buildConfig();
    return prop in (_config as any);
  },
  ownKeys(_target) {
    if (_config === null) _config = buildConfig();
    return Reflect.ownKeys(_config as any);
  },
  getOwnPropertyDescriptor(_target, prop) {
    if (_config === null) _config = buildConfig();
    return Object.getOwnPropertyDescriptor(_config, prop);
  },
});

/** Known device names for entity extraction (customizable) */
export const knownDevices = env("BRAINCORE_KNOWN_DEVICES", "server-a,server-b,workstation").split(",").map(d => d.trim());

/** Regex pattern for device name matching */
export const devicePattern = new RegExp(`\\b(${knownDevices.join("|")})\\b`, "gi");
