#!/usr/bin/env node

import { parseArgs } from 'util';
import chalk from 'chalk';
import { createAgent } from './agent/index.js';
import { createProvider, listModels } from './model/index.js';
import { executeTool } from './tools/index.js';
import { loadConfig, getProviders, setActiveProvider } from './config/index.js';
import { listSessions, loadSession, saveSession } from './session.js';
import { readFile } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

interface CliFlags {
  help: boolean;
  version: boolean;
  model: string | null;
  config: string | null;
  yes: boolean;
}

interface CliArgs {
  command: string | null;
  task: string | null;
  flags: CliFlags;
}

function parseCliArgs(args: string[]): CliArgs {
  const parsed = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      model: { type: 'string', short: 'm' },
      config: { type: 'string', short: 'c' },
      yes: { type: 'boolean', short: 'y' },
    },
    allowPositionals: true,
  });

  return {
    command: parsed.positionals[0] ?? null,
    task: parsed.positionals[1] ?? null,
    flags: {
      help: parsed.values.help ?? false,
      version: parsed.values.version ?? false,
      model: parsed.values.model ?? null,
      config: parsed.values.config ?? null,
      yes: parsed.values.yes ?? false,
    },
  };
}

function showHelp() {
  console.log(chalk.cyan(`
╔═══════════════════════════════════════════════════════════════════╗
║                    Forge CLI v0.1.0                           ║
║            Local Autonomous Coding Agent                        ║
╚═══════════════════════════════════════════════════════════════════╝

Usage:
  forge [command] [options]

Commands:
  run <task>              Run a task in autonomous mode
  repl                    Start interactive REPL session
  model list             List available models for current provider
  model use <provider>  Switch active model provider
  model providers       List configured providers
  undo                   Undo last file change
  session resume <id>    Resume interrupted session
  session list           List previous sessions
  session show <id>     Show session details
  config show            Show current configuration
  config edit           Edit configuration
  help                   Show this help message

Options:
  -h, --help             Show this help message
  -v, --version          Show version
  -m, --model <name>    Specify model to use
  -c, --config <path>   Use custom config file
  -y, --yes             Skip confirmations (auto-approve)

Examples:
  forge run "Fix the authentication bug in login.ts"
  forge run "Add a new API endpoint for user management"
  forge model list
  forge model use openrouter
  `));
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));

  if (args.flags.help) {
    showHelp();
    process.exit(0);
  }

  if (args.flags.version) {
    console.log(chalk.green('Forge CLI v0.1.0'));
    process.exit(0);
  }

  const command = args.command ?? 'repl';

  switch (command) {
    case 'run':
      await handleRun(args);
      break;

    case 'repl':
      await handleRepl(args);
      break;

    case 'model':
      await handleModel(args);
      break;

    case 'undo':
      await handleUndo(args);
      break;

    case 'session':
      await handleSession(args);
      break;

    case 'config':
      await handleConfig(args);
      break;

    case 'help':
      showHelp();
      break;

    default:
      console.error(chalk.red(`Unknown command: ${command}`));
      showHelp();
      process.exit(1);
  }
}

async function handleRun(args: CliArgs) {
  if (!args.task) {
    console.error(chalk.red('Error: Please provide a task to run'));
    console.log(chalk.yellow('Usage: forge run "<task>"'));
    process.exit(1);
  }

  const confirmCallback = args.flags.yes
    ? async () => true
    : async (message: string) => {
        const readline = await import('readline');
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        return new Promise<boolean>((resolve) => {
          rl.question(chalk.yellow(`${message} (y/n): `), (answer) => {
            rl.close();
            resolve(answer.toLowerCase() === 'y');
          });
        });
      };

  const outputCallback = (message: string) => process.stdout.write(message);

  const agent = await createAgent({
    confirmCallback,
    outputCallback,
  });

  console.log(chalk.cyan(`\n🤖 Starting autonomous task: ${args.task}\n`));

  const result = await agent.run(args.task);

  if (result.success) {
    console.log(chalk.green('\n✅ Task completed successfully!'));
  } else {
    console.log(chalk.red('\n❌ Task failed'));
    process.exit(1);
  }
}

async function handleRepl(args: CliArgs) {
  console.log(chalk.cyan(`
╔═══════════════════════════════════════════════════════════════════╗
║                    REPL Mode                                   ║
║            Interactive Coding Agent                          ║
╚═══════════════════════════════════════════════════════════════════╝

Type your request and press Enter. The agent will:
- Read relevant files
- Plan and execute changes
- Verify results

Commands:
- :quit or :exit - Exit REPL
- :plan - Show current plan
- :undo - Undo last change
- :help - Show this help

Note: Full REPL implementation coming in Phase 6.
  `));

  // For now, just show a message
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.question(chalk.yellow('\nPress Enter to continue...'), () => {
    rl.close();
    process.exit(0);
  });
}

async function handleModel(args: CliArgs) {
  const subcommand = args.task; // This is actually the subcommand like "list", "use", "providers"

  switch (subcommand) {
    case 'list': {
      try {
        const provider = await createProvider();
        console.log(chalk.cyan('\nAvailable models:'));

        const models = await provider.listModels();

        if (models.length === 0) {
          console.log(chalk.yellow('No models found. Make sure the provider is running.'));
        } else {
          for (const model of models) {
            console.log(chalk.white(`  - ${model}`));
          }
        }
      } catch (error: any) {
        console.error(chalk.red(`Error: ${error.message}`));
      }
      break;
    }

    case 'providers': {
      const providers = await getProviders();
      console.log(chalk.cyan('\nConfigured providers:'));

      const config = await loadConfig();
      const active = config.active;

      for (const p of providers) {
        const marker = p.name === active ? ' *' : '';
        console.log(chalk.white(`  ${p.name}${marker}`));
        console.log(chalk.gray(`    Model: ${p.config.model}`));
        console.log(chalk.gray(`    URL: ${p.config.baseURL}`));
      }
      break;
    }

    case 'use': {
      // args.task is "use", so we need to get the provider name from a different place
      // Actually we need to fix the argument parsing
      console.log(chalk.yellow('Usage: forge model use <provider>'));
      break;
    }

    default: {
      console.log(chalk.yellow('Usage:'));
      console.log(chalk.gray('  forge model list'));
      console.log(chalk.gray('  forge model providers'));
      console.log(chalk.gray('  forge model use <provider>'));
      break;
    }
  }
}

async function handleUndo(args: CliArgs) {
  // This would need access to agent state
  console.log(chalk.yellow('Undo functionality requires an active session.'));
  console.log(chalk.gray('Start a task with "forge run" to use undo.'));
}

async function handleSession(args: CliArgs) {
  const subcommand = args.task;

  switch (subcommand) {
    case 'list': {
      const sessions = await listSessions();
      console.log(chalk.cyan('\nPrevious sessions:'));

      if (sessions.length === 0) {
        console.log(chalk.yellow('No sessions found.'));
      } else {
        for (const s of sessions) {
          const statusColor =
            s.status === 'completed'
              ? chalk.green
              : s.status === 'failed'
              ? chalk.red
              : chalk.yellow;
          console.log(chalk.white(`  ${s.sessionId}`));
          console.log(chalk.gray(`    Task: ${s.task.substring(0, 50)}...`));
          console.log(statusColor(`    Status: ${s.status}`));
          console.log(chalk.gray(`    Updated: ${s.updatedAt}`));
        }
      }
      break;
    }

    case 'resume': {
      console.log(chalk.yellow('Session resume coming in Phase 5.'));
      break;
    }

    case 'show': {
      console.log(chalk.yellow('Session show coming in Phase 5.'));
      break;
    }

    default: {
      console.log(chalk.yellow('Usage:'));
      console.log(chalk.gray('  forge session list'));
      console.log(chalk.gray('  forge session show <id>'));
      console.log(chalk.gray('  forge session resume <id>'));
      break;
    }
  }
}

async function handleConfig(args: CliArgs) {
  const subcommand = args.task;

  switch (subcommand) {
    case 'show': {
      const config = await loadConfig();
      console.log(chalk.cyan('\nCurrent configuration:'));
      console.log(chalk.white(JSON.stringify(config, null, 2)));
      break;
    }

    case 'edit': {
      console.log(chalk.yellow('Open ~/.coderc.json in your editor...'));
      const editor = process.env.EDITOR || 'vi';
      const { exec } = await import('child_process');
      exec(`${editor} ${join(homedir(), '.coderc.json')}`);
      break;
    }

    default: {
      console.log(chalk.yellow('Usage:'));
      console.log(chalk.gray('  forge config show'));
      console.log(chalk.gray('  forge config edit'));
      break;
    }
  }
}

main().catch((error) => {
  console.error(chalk.red('Fatal error:'), error);
  process.exit(1);
});