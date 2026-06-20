import chalk from 'chalk';
import { ModelProvider, createProvider, ChatMessage, createToolDefinitions } from '../model/index.js';
import { executeTool, toolDefinitions as toolDefs, FileSnapshot, snapshotFile, restoreSnapshot } from '../tools/index.js';
import { loadConfig } from '../config/index.js';

export interface TaskStep {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'done' | 'failed';
  toolCalls: any[];
  result?: any;
  retries: number;
}

export interface Plan {
  id: string;
  task: string;
  steps: TaskStep[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentState {
  plan: Plan | null;
  history: ChatMessage[];
  currentStep: number;
  sessionId: string;
}

export interface VerificationResult {
  passed: boolean;
  output: string;
  errors?: string[];
}

export const MAX_RETRIES = 3;

export class Agent {
  private provider: ModelProvider;
  private state: AgentState;
  private config: any;
  private confirmCallback: (message: string) => Promise<boolean>;
  private outputCallback: (message: string) => void;
  private snapshots: Map<string, FileSnapshot> = new Map();

  constructor(options: {
    provider: ModelProvider;
    confirmCallback?: (message: string) => Promise<boolean>;
    outputCallback?: (message: string) => void;
  }) {
    this.provider = options.provider;
    this.confirmCallback = options.confirmCallback || this.defaultConfirm;
    this.outputCallback = options.outputCallback || console.log;

    this.state = {
      plan: null,
      history: [],
      currentStep: 0,
      sessionId: this.generateSessionId(),
    };

    this.config = {};
  }

  private generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  private async defaultConfirm(message: string): Promise<boolean> {
    const readline = await import('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      rl.question(chalk.yellow(`${message} (y/n): `), (answer) => {
        rl.close();
        resolve(answer.toLowerCase() === 'y');
      });
    });
  }

  async initialize(): Promise<void> {
    this.config = await loadConfig();

    // Add system message
    this.state.history.push({
      role: 'system',
      content: `You are an autonomous coding agent. Your role is to help the user with coding tasks.

Available tools:
- read_file: Read file contents
- list_dir: List directory contents
- glob_search: Find files by pattern
- grep_search: Search file contents
- write_file: Create or overwrite a file
- edit_file: Edit a file using find/replace
- run_command: Execute a shell command
- git_diff: Show git diff
- git_status: Show git status
- git_commit: Commit changes

For file modifications, use edit_file with find/replace rather than write_file when possible to minimize unintended changes.
Always verify your work by running tests/lint/build commands after making changes.
`,
    });
  }

  async run(task: string): Promise<{ success: boolean; plan: Plan }> {
    this.outputCallback(chalk.cyan(`\n🤖 Starting task: ${task}\n`));

    // Phase 1: Planning
    const plan = await this.createPlan(task);
    this.state.plan = plan;

    this.outputCallback(chalk.green(`\n📋 Created plan with ${plan.steps.length} steps\n`));

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      this.state.currentStep = i;
      step.status = 'in_progress';

      this.outputCallback(chalk.cyan(`\n→ Step ${i + 1}/${plan.steps.length}: ${step.description}\n`));

      // Phase 2: Execute step
      const result = await this.executeStep(step);

      if (result.success) {
        step.status = 'done';
        this.outputCallback(chalk.green('✓ Step completed\n'));
      } else {
        step.status = 'failed';
        step.retries++;

        if (step.retries >= MAX_RETRIES) {
          this.outputCallback(chalk.red(`✗ Step failed after ${MAX_RETRIES} retries. Stopping.\n`));
          return { success: false, plan };
        }

        this.outputCallback(chalk.yellow(`⚠ Step failed, retrying (${step.retries}/${MAX_RETRIES})...\n`));

        // Re-plan with the error context
        const newPlan = await this.createPlan(task, {
          context: `Previous attempt failed: ${result.error}. Continue with the remaining steps.`,
          existingPlan: plan,
        });

        // Update plan with retry
        plan.steps = newPlan.steps;
        i--; // Retry same step
      }
    }

    // Phase 3: Final verification
    this.outputCallback(chalk.cyan('\n🔍 Running final verification...\n'));

    const verification = await this.verify();

    if (verification.passed) {
      this.outputCallback(chalk.green('\n✅ Task completed successfully!\n'));
      return { success: true, plan };
    } else {
      this.outputCallback(chalk.red('\n❌ Verification failed:\n'));
      this.outputCallback(chalk.red(verification.output));
      return { success: false, plan };
    }
  }

  private async createPlan(
    task: string,
    options: { context?: string; existingPlan?: Plan } = {}
  ): Promise<Plan> {
    const systemMessage = options.context
      ? `Task: ${task}\n\nContext from previous attempts: ${options.context}`
      : `Task: ${task}`;

    const messages: ChatMessage[] = [
      ...this.state.history,
      {
        role: 'user',
        content: `${systemMessage}

You need to break down this task into discrete steps. For each step, respond with a JSON array of steps in this format:
[
  {"id": "1", "description": "Description of the step", "action": "tool_name", "args": {"key": "value"}}
]

Respond with ONLY the JSON array, no other text.`,
      },
    ];

    this.outputCallback(chalk.gray('Planning...'));

    const response = await this.provider.chat({
      messages,
      temperature: 0.3,
      max_tokens: 2048,
    });

    try {
      // Parse JSON from response
      const jsonMatch = response.content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const steps = JSON.parse(jsonMatch[0]);

      return {
        id: this.generateSessionId(),
        task,
        steps: steps.map((s: any, i: number) => ({
          id: s.id || String(i + 1),
          description: s.description,
          status: 'pending' as const,
          toolCalls: [{ name: s.action, args: s.args }],
          retries: 0,
        })),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    } catch (error) {
      // Fallback: treat entire response as single step
      return {
        id: this.generateSessionId(),
        task,
        steps: [
          {
            id: '1',
            description: task,
            status: 'pending',
            toolCalls: [],
            retries: 0,
          },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
  }

  private async executeStep(step: TaskStep): Promise<{ success: boolean; error?: string }> {
    // Get tool call info
    const toolCall = step.toolCalls[0];

    if (!toolCall) {
      // No tool specified, just respond
      return { success: true };
    }

    const toolName = toolCall.name;
    const args = toolCall.args || {};

    // Check if confirmation is needed for destructive tools
    const needsConfirmation = ['write_file', 'edit_file', 'run_command', 'git_commit'].includes(toolName);

    if (needsConfirmation) {
      // Snapshot file before modification
      if (toolName === 'edit_file' || toolName === 'write_file') {
        try {
          const snapshot = await snapshotFile(args.path);
          this.snapshots.set(args.path, snapshot);
        } catch {
          // File might not exist yet
        }
      }

      const confirmed = await this.confirmCallback(
        `Allow ${toolName} with args: ${JSON.stringify(args)}?`
      );

      if (!confirmed) {
        return { success: false, error: 'User rejected the operation' };
      }
    }

    // Execute the tool
    this.outputCallback(chalk.gray(`Executing ${toolName}...`));

    const result = await executeTool(toolName, args, {
      baseDir: process.cwd(),
      allowlist: this.config?.tools?.run_command?.allowlist,
    });

    // Add to history
    this.state.history.push({
      role: 'user',
      content: `Tool ${toolName} result: ${JSON.stringify(result)}`,
    });

    if (!result.success) {
      return { success: false, error: result.error };
    }

    step.result = result.data;
    return { success: true };
  }

  private async verify(): Promise<VerificationResult> {
    const verificationCommands = this.config?.verification?.onFileChange || ['npx eslint .', 'npx tsc --noEmit'];

    const errors: string[] = [];

    for (const cmd of verificationCommands) {
      this.outputCallback(chalk.gray(`Running: ${cmd}`));

      const result = await executeTool('run_command', { command: cmd });

      if (!result.success || result.data?.exitCode !== 0) {
        errors.push(`${cmd} failed: ${result.data?.stderr || result.error}`);
      }
    }

    return {
      passed: errors.length === 0,
      output: errors.join('\n'),
      errors,
    };
  }

  async undo(): Promise<{ success: boolean; error?: string }> {
    // Restore most recent snapshot
    const snapshots = Array.from(this.snapshots.values());

    if (snapshots.length === 0) {
      return { success: false, error: 'No snapshots to undo' };
    }

    const lastSnapshot = snapshots[snapshots.length - 1];
    const result = await restoreSnapshot(lastSnapshot.path);

    this.snapshots.delete(lastSnapshot.path);

    return result;
  }

  getHistory(): ChatMessage[] {
    return this.state.history;
  }

  getPlan(): Plan | null {
    return this.state.plan;
  }

  getSessionId(): string {
    return this.state.sessionId;
  }
}

export async function createAgent(options?: {
  provider?: ModelProvider;
  confirmCallback?: (message: string) => Promise<boolean>;
  outputCallback?: (message: string) => void;
}): Promise<Agent> {
  const provider = options?.provider || await createProvider();

  const agent = new Agent({
    provider,
    confirmCallback: options?.confirmCallback,
    outputCallback: options?.outputCallback,
  });

  await agent.initialize();

  return agent;
}