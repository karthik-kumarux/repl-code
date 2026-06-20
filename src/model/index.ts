import OpenAI from 'openai';
import { loadConfig } from '../config/index.js';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  name?: string;
}

export interface ModelCapabilities {
  supportsToolCalls: boolean;
  checkedAt: string;
}

export type ProviderConfig = {
  baseURL: string;
  apiKey: string;
  model: string;
};

export interface ChatOptions {
  messages: ChatMessage[];
  tools?: any[];
  model?: string;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

export class ModelProvider {
  private client: OpenAI;
  private config: ProviderConfig;
  private capabilityCache: Map<string, ModelCapabilities> = new Map();

  constructor(config: ProviderConfig) {
    this.config = config;
    this.client = new OpenAI({
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      maxRetries: 3,
      timeout: 120000,
    });
  }

  async listModels(): Promise<string[]> {
    try {
      const models = await this.client.models.list();
      return models.data.map((m) => m.id);
    } catch (error) {
      console.error('Failed to list models:', error);
      return [];
    }
  }

  async chat(options: ChatOptions): Promise<{
    content: string;
    toolCalls: ToolCall[];
  }> {
    const model = options.model || this.config.model;

    const requestOptions: any = {
      model,
      messages: options.messages,
      temperature: options.temperature ?? 0.7,
      max_completion_tokens: options.max_tokens ?? 4096,
    };

    if (options.tools && options.tools.length > 0) {
      // Check if model supports tool calls
      const supportsTools = await this.checkToolSupport(model);
      if (supportsTools) {
        requestOptions.tools = options.tools;
      } else {
        // Use prompted format - inject tool instructions into system message
        requestOptions.messages = this.injectToolInstructions(
          options.messages,
          options.tools
        );
      }
    }

    if (options.stream) {
      // TODO: Enable streaming when openai SDK types are compatible
      // For now, use non-streaming approach
      // return this.chatStream(requestOptions);
    }

    try {
      const response = await this.client.chat.completions.create(requestOptions);

      const message = response.choices[0]?.message;

      if (!message) {
        return { content: '', toolCalls: [] };
      }

      // Check for tool calls in response
      const toolCalls: ToolCall[] = [];

      if (message.tool_calls && message.tool_calls.length > 0) {
        for (const tc of message.tool_calls) {
          toolCalls.push({
            id: tc.id || `call_${Date.now()}`,
            type: 'function',
            function: {
              name: tc.function.name,
              arguments:
                typeof tc.function.arguments === 'string'
                  ? tc.function.arguments
                  : JSON.stringify(tc.function.arguments),
            },
          });
        }
      }

      return {
        content: message.content || '',
        toolCalls,
      };
    } catch (error) {
      console.error('Chat completion failed:', error);
      throw error;
    }
  }

  private async chatStream(requestOptions: any): Promise<{
    content: string;
    toolCalls: ToolCall[];
  }> {
    const response = await this.client.chat.completions.create({
      ...requestOptions,
      stream: true,
    });

    let content = '';
    const toolCalls: ToolCall[] = [];

    // Handle streaming - use proper async iterator
    try {
      // Cast response to any to handle the async iterator check
      const streamResp = response as any;
      const hasAsyncIterator = typeof streamResp[Symbol.asyncIterator] === 'function';

      // Use for...of with the iterator
      const iterator: any = hasAsyncIterator
        ? streamResp[Symbol.asyncIterator]()
        : (function*() { for (const chunk of streamResp) { yield chunk; } })();

      for await (const chunk of iterator) {
        const delta = chunk.choices[0]?.delta;

        if (delta?.content) {
          process.stdout.write(delta.content);
          content += delta.content;
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const existingIndex = toolCalls.findIndex((t) => t.id === tc.id);
            if (existingIndex >= 0) {
              toolCalls[existingIndex].function.arguments +=
                tc.function?.arguments || '';
            } else {
              toolCalls.push({
                id: tc.id || `call_${Date.now()}`,
                type: 'function',
                function: {
                  name: tc.function?.name || '',
                  arguments: tc.function?.arguments || '',
                },
              });
            }
          }
        }
      }
    } catch (e) {
      // If streaming fails, return empty
      console.error('Streaming error:', e);
    }

    console.log(); // Newline after streaming
    return { content, toolCalls };
  }

  private injectToolInstructions(
    messages: ChatMessage[],
    tools: any[]
  ): ChatMessage[] {
    const toolDescriptions = tools
      .map(
        (t) =>
          `- ${t.function.name}: ${t.function.description}`
      )
      .join('\n');

    const instruction = `\nYou have access to the following tools:
${toolDescriptions}

To use a tool, respond with:
\`\`\`tool_call
{"name": "function_name", "args": {"arg1": "value1"}}
\`\`\`
`;

    // Find or create system message
    const systemMessageIndex = messages.findIndex((m) => m.role === 'system');

    if (systemMessageIndex >= 0) {
      const updated = [...messages];
      updated[systemMessageIndex] = {
        ...updated[systemMessageIndex],
        content:
          updated[systemMessageIndex].content + instruction,
      };
      return updated;
    }

    return [
      { role: 'system', content: instruction },
      ...messages,
    ];
  }

  async checkToolSupport(modelName: string): Promise<boolean> {
    // Check cache first
    const cached = this.capabilityCache.get(modelName);
    if (cached) {
      return cached.supportsToolCalls;
    }

    // Try to detect capability
    const supported = await this.probeToolSupport(modelName);

    // Cache result
    this.capabilityCache.set(modelName, {
      supportsToolCalls: supported,
      checkedAt: new Date().toISOString(),
    });

    // Also save to disk
    await this.saveCapabilityToDisk(modelName, supported);

    return supported;
  }

  private async probeToolSupport(modelName: string): Promise<boolean> {
    try {
      // Simple probe: ask the model to use a dummy tool
      const response = await this.client.chat.completions.create({
        model: modelName,
        messages: [
          {
            role: 'user',
            content: 'Respond with exactly this JSON: {"test": "ok"}',
          },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'test_tool',
              description: 'A test tool',
              parameters: {
                type: 'object',
                properties: {
                  test: { type: 'string' },
                },
                required: ['test'],
              },
            },
          },
        ],
        max_completion_tokens: 100,
      });

      const message = response.choices[0]?.message;

      // If tool_calls is present, the model supports tools
      return !!(message?.tool_calls && message.tool_calls.length > 0);
    } catch {
      return false;
    }
  }

  private async saveCapabilityToDisk(
    modelName: string,
    supports: boolean
  ): Promise<void> {
    const cacheDir = join(homedir(), '.agent');
    const cacheFile = join(cacheDir, 'model-capabilities.json');

    try {
      let capabilities: Record<string, ModelCapabilities> = {};

      if (existsSync(cacheFile)) {
        const content = await readFile(cacheFile, 'utf-8');
        capabilities = JSON.parse(content);
      }

      capabilities[modelName] = {
        supportsToolCalls: supports,
        checkedAt: new Date().toISOString(),
      };

      try {
        await mkdir(cacheDir, { recursive: true });
      } catch {
        // Dir might already exist
      }
      await writeFile(cacheFile, JSON.stringify(capabilities, null, 2), 'utf-8');
    } catch (error) {
      console.warn('Failed to save model capability:', error);
    }
  }

  getModelName(): string {
    return this.config.model;
  }

  getBaseURL(): string {
    return this.config.baseURL;
  }
}

export async function createProvider(
  providerName?: string
): Promise<ModelProvider> {
  const config = await loadConfig();

  const name = providerName || config.active || 'ollama';
  const providerConfig = (config.providers as any)?.[name];

  if (!providerConfig) {
    throw new Error(`Provider '${name}' not found in config`);
  }

  return new ModelProvider(providerConfig);
}

export async function createProviderFromConfig(
  providerConfig: ProviderConfig
): Promise<ModelProvider> {
  return new ModelProvider(providerConfig);
}

export async function listModels(): Promise<string[]> {
  const config = await loadConfig();
  const provider = await createProvider(config.active || 'ollama');
  return provider.listModels();
}

export function createToolDefinitions() {
  return [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read the contents of a file',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to the file' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_dir',
        description: 'List contents of a directory',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to directory' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'glob_search',
        description: 'Find files matching a pattern',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Glob pattern (e.g., "**/*.ts")' },
          },
          required: ['pattern'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'grep_search',
        description: 'Search file contents using ripgrep',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Regex pattern to search' },
            path: { type: 'string', description: 'Directory to search in' },
            ignoreCase: { type: 'boolean', description: 'Case insensitive' },
          },
          required: ['pattern'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Create or overwrite a file',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to the file' },
            content: { type: 'string', description: 'File contents' },
          },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'edit_file',
        description: 'Edit a file using find/replace',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to the file' },
            find: { type: 'string', description: 'Text to find' },
            replace: { type: 'string', description: 'Text to replace with' },
          },
          required: ['path', 'find'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'run_command',
        description: 'Execute a shell command',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Command to run' },
          },
          required: ['command'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'git_diff',
        description: 'Show git diff of changes',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'git_status',
        description: 'Show git status',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'git_commit',
        description: 'Commit changes',
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'Commit message' },
          },
          required: ['message'],
        },
      },
    },
  ];
}