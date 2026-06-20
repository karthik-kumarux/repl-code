import { readFile, writeFile, mkdir, access, readdir } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import { homedir, cpus } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export interface ProviderConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface Config {
  providers: {
    ollama?: ProviderConfig;
    lmstudio?: ProviderConfig;
    openrouter?: ProviderConfig;
  };
  active?: string;
  fallback?: {
    enabled: boolean;
    provider: string;
    triggerAfterFailures: number;
  };
  tools?: {
    run_command?: {
      allowlist: string[];
    };
  };
  verification?: {
    onFileChange?: string[];
  };
}

export interface ResolvedConfig extends Config {
  activeProvider: ProviderConfig | null;
}

const DEFAULT_CONFIG: Config = {
  providers: {
    ollama: {
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      model: 'qwen2.5-coder:32b',
    },
    lmstudio: {
      baseURL: 'http://localhost:1234/v1',
      apiKey: 'lm-studio',
      model: 'local-model',
    },
    openrouter: {
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: '${OPENROUTER_API_KEY}',
      model: 'blackboxai/minimax/minimax-m2.7',
    },
  },
  active: 'ollama',
  fallback: {
    enabled: true,
    provider: 'openrouter',
    triggerAfterFailures: 3,
  },
  tools: {
    run_command: {
      allowlist: ['npm', 'npx', 'pnpm', 'git', 'node', 'bun', 'pnpm', 'yarn'],
    },
  },
  verification: {
    onFileChange: ['npx eslint --fix', 'npx tsc --noEmit'],
  },
};

function interpolateEnvVars(value: string): string {
  const envPattern = /\$\{([^}]+)\}/g;
  return value.replace(envPattern, (_, varName) => {
    return process.env[varName] ?? '';
  });
}

function resolveConfigValue(value: any, env: Record<string, string> = process.env as Record<string, string>): any {
  if (typeof value === 'string') {
    return interpolateEnvVars(value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveConfigValue(v, env));
  }
  if (value && typeof value === 'object') {
    const resolved: any = {};
    for (const [key, val] of Object.entries(value)) {
      resolved[key] = resolveConfigValue(val, env);
    }
    return resolved;
  }
  return value;
}

async function ensureDir(path: string): Promise<void> {
  if (!existsSync(path)) {
    await mkdir(path, { recursive: true });
  }
}

export async function loadConfig(configPath?: string): Promise<ResolvedConfig> {
  const globalConfigPath = join(homedir(), '.coderc.json');
  const localConfigPath = join(process.cwd(), '.agent', 'config.json');
  const envPath = join(process.cwd(), '.env');

  let config: Config = { ...DEFAULT_CONFIG };

  // Load global config
  if (existsSync(globalConfigPath)) {
    try {
      const globalConfigRaw = await readFile(globalConfigPath, 'utf-8');
      const globalConfig = JSON.parse(globalConfigRaw);
      config = deepMerge(config, globalConfig);
    } catch (e) {
      console.warn(`Failed to load global config: ${e}`);
    }
  }

  // Load local config (overrides global)
  if (existsSync(localConfigPath)) {
    try {
      const localConfigRaw = await readFile(localConfigPath, 'utf-8');
      const localConfig = JSON.parse(localConfigRaw);
      config = deepMerge(config, localConfig);
    } catch (e) {
      console.warn(`Failed to load local config: ${e}`);
    }
  }

  // Use custom config path if provided
  if (configPath && existsSync(configPath)) {
    try {
      const customConfigRaw = await readFile(configPath, 'utf-8');
      const customConfig = JSON.parse(customConfigRaw);
      config = deepMerge(config, customConfig);
    } catch (e) {
      console.warn(`Failed to load custom config: ${e}`);
    }
  }

  // Load .env file if exists
  if (existsSync(envPath)) {
    const envResult = dotenv.config({ path: envPath });
    if (envResult.error) {
      console.warn(`Failed to load .env file: ${envResult.error}`);
    }
  }

  // Resolve environment variables in config
  const resolved = resolveConfigValue(config);

  // Get active provider
  const activeProviderName = resolved.active || 'ollama';
  const activeProvider = (resolved.providers as any)?.[activeProviderName] || null;

  return {
    ...resolved,
    activeProvider,
  };
}

export async function saveConfig(config: Config, local: boolean = true): Promise<void> {
  const configPath = local
    ? join(process.cwd(), '.agent', 'config.json')
    : join(homedir(), '.coderc.json');

  const dir = dirname(configPath);
  await ensureDir(dir);

  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

export async function getProviders(): Promise<{ name: string; config: ProviderConfig }[]> {
  const config = await loadConfig();
  const providers: { name: string; config: ProviderConfig }[] = [];

  for (const [name, providerConfig] of Object.entries(config.providers || {})) {
    if (providerConfig) {
      providers.push({ name, config: providerConfig as ProviderConfig });
    }
  }

  return providers;
}

export async function setActiveProvider(providerName: string): Promise<void> {
  const config = await loadConfig() as any;

  if (!config.providers?.[providerName]) {
    throw new Error(`Provider '${providerName}' not found in config`);
  }

  config.active = providerName;

  // Save locally if .agent directory exists, otherwise globally
  const localConfigPath = join(process.cwd(), '.agent', 'config.json');
  if (existsSync(dirname(localConfigPath))) {
    await saveConfig(config, true);
  } else {
    await saveConfig(config, false);
  }
}

function deepMerge(target: any, source: any): any {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    if (isObject(source[key]) && isObject(target[key])) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }

  return result;
}

function isObject(value: any): value is Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value);
}

export function getDefaultConfig(): Config {
  return { ...DEFAULT_CONFIG };
}