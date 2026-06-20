import { readFile, writeFile, readdir, stat, mkdir, rm, copyFile, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { join, relative, isAbsolute, dirname } from 'path';
import { execa } from 'execa';
import simpleGit, { SimpleGit } from 'simple-git';
import fg from 'fast-glob';
import chalk from 'chalk';

export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
}

// Safety: ensure path is within allowed directory
function sanitizePath(path: string, baseDir: string): string | null {
  const resolved = isAbsolute(path) ? path : join(baseDir, path);
  const relativePath = relative(baseDir, resolved);

  // Check for path traversal
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return null;
  }

  return resolved;
}

// Tool: read_file
export async function readFileTool(
  path: string,
  baseDir: string = process.cwd()
): Promise<ToolResult> {
  const safePath = sanitizePath(path, baseDir);

  if (!safePath) {
    return { success: false, error: 'Path traversal detected' };
  }

  try {
    const content = await readFile(safePath, 'utf-8');
    return { success: true, data: content };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// Tool: list_dir
export async function listDirTool(
  path: string,
  baseDir: string = process.cwd()
): Promise<ToolResult> {
  const safePath = sanitizePath(path, baseDir);

  if (!safePath) {
    return { success: false, error: 'Path traversal detected' };
  }

  try {
    const entries = await readdir(safePath, { withFileTypes: true });
    const files = entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
      isSymbolicLink: entry.isSymbolicLink(),
    }));

    return { success: true, data: files };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// Tool: glob_search
export async function globSearchTool(
  pattern: string,
  baseDir: string = process.cwd()
): Promise<ToolResult> {
  const safePattern = isAbsolute(pattern) ? pattern : join(baseDir, pattern);

  try {
    const files = await fg(safePattern, {
      cwd: baseDir,
      absolute: false,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
    });

    return { success: true, data: files };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// Tool: grep_search
// Uses ripgrep via execa
export async function grepSearchTool(
  pattern: string,
  options: {
    path?: string;
    glob?: string;
    ignoreCase?: boolean;
    context?: number;
    baseDir?: string;
  } = {}
): Promise<ToolResult> {
  const base = options.baseDir || process.cwd();

  const args: string[] = [
    '--hidden', // Include hidden files
  ];

  if (options.ignoreCase) {
    args.push('-i');
  }

  if (options.context) {
    args.push(`-C${options.context}`);
  }

  if (options.glob) {
    args.push('--glob', options.glob);
  }

  args.push(pattern);
  args.push(base);

  try {
    const result = await execa('rg', args);
    return { success: true, data: result.stdout };
  } catch (error: any) {
    // ripgrep returns exit code 1 when no matches found
    if (error.exitCode === 1) {
      return { success: true, data: '' };
    }
    return { success: false, error: error.message };
  }
}

// Tool: write_file
export async function writeFileTool(
  path: string,
  content: string,
  baseDir: string = process.cwd(),
  options: { createDirs?: boolean } = {}
): Promise<ToolResult> {
  const safePath = sanitizePath(path, baseDir);

  if (!safePath) {
    return { success: false, error: 'Path traversal detected' };
  }

  try {
    // Create parent directories if needed
    if (options.createDirs) {
      const parent = dirname(safePath);
      if (!existsSync(parent)) {
        await mkdir(parent, { recursive: true });
      }
    }

    await writeFile(safePath, content, 'utf-8');
    return {
      success: true,
      data: { path: safePath, bytes: content.length },
    };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// Tool: edit_file (unified diff or find/replace)
export async function editFileTool(
  path: string,
  edit: {
    find?: string;
    replace?: string;
    diff?: string;
  },
  baseDir: string = process.cwd()
): Promise<ToolResult> {
  const safePath = sanitizePath(path, baseDir);

  if (!safePath) {
    return { success: false, error: 'Path traversal detected' };
  }

  try {
    if (!existsSync(safePath)) {
      return { success: false, error: 'File not found' };
    }

    const original = await readFile(safePath, 'utf-8');
    let modified = original;

    if (edit.diff) {
      // Apply unified diff
      modified = applyUnifiedDiff(original, edit.diff);
    } else if (edit.find && edit.replace) {
      // Find and replace
      modified = original.replace(edit.find, edit.replace);
    } else {
      return { success: false, error: 'No edit instruction provided' };
    }

    // Write the modified content
    await writeFile(safePath, modified, 'utf-8');

    return {
      success: true,
      data: {
        path: safePath,
        originalLength: original.length,
        modifiedLength: modified.length,
      },
    };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// Helper: apply unified diff
function applyUnifiedDiff(original: string, diff: string): string {
  const lines = original.split('\n');
  const diffLines = diff.split('\n');

  let result = [...lines];

  for (const line of diffLines) {
    // Skip diff headers
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@') || line.startsWith('Index:')) {
      continue;
    }

    if (line.startsWith('+')) {
      // Addition
      // This is a simplified diff parser - real implementation would be more robust
      result.push(line.substring(1));
    } else if (line.startsWith('-')) {
      // Deletion - would need more sophisticated handling
    }
  }

  return result.join('\n');
}

// Tool: run_command
export async function runCommandTool(
  command: string,
  options: {
    allowlist?: string[];
    cwd?: string;
    timeout?: number;
  } = {}
): Promise<ToolResult> {
  const allowlist = options.allowlist || ['npm', 'npx', 'pnpm', 'git', 'node', 'bun', 'yarn', 'tsc', 'eslint', 'jest'];
  const cwd = options.cwd || process.cwd();
  const timeout = options.timeout || 60000;

  // Parse command to check if it's in allowlist
  const [cmd, ...args] = command.split(' ');

  if (!allowlist.includes(cmd)) {
    return {
      success: false,
      error: `Command '${cmd}' not in allowlist. Allowed: ${allowlist.join(', ')}`,
    };
  }

  try {
    const result = await execa(cmd, args, {
      cwd,
      timeout,
      reject: false,
      cleanup: true,
    });

    return {
      success: result.exitCode === 0,
      data: {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      },
    };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// Tool: git_diff
export async function gitDiffTool(
  baseDir: string = process.cwd()
): Promise<ToolResult> {
  try {
    const git: SimpleGit = simpleGit(baseDir);
    const diff = await git.diff();
    return { success: true, data: diff };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// Tool: git_status
export async function gitStatusTool(
  baseDir: string = process.cwd()
): Promise<ToolResult> {
  try {
    const git: SimpleGit = simpleGit(baseDir);
    const status = await git.status();
    return { success: true, data: status };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// Tool: git_commit
export async function gitCommitTool(
  message: string,
  baseDir: string = process.cwd()
): Promise<ToolResult> {
  try {
    const git: SimpleGit = simpleGit(baseDir);
    const result = await git.commit(message);
    return {
      success: true,
      data: {
        commit: result.commit,
        branch: result.branch,
      },
    };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// Snapshot for undo functionality
export interface FileSnapshot {
  path: string;
  content: string;
  timestamp: string;
}

const snapshots: Map<string, FileSnapshot> = new Map();

export async function snapshotFile(
  path: string,
  baseDir: string = process.cwd()
): Promise<FileSnapshot> {
  const safePath = sanitizePath(path, baseDir);
  if (!safePath) throw new Error('Invalid path');

  const content = await readFile(safePath, 'utf-8');
  const snapshot: FileSnapshot = {
    path: safePath,
    content,
    timestamp: new Date().toISOString(),
  };

  snapshots.set(safePath, snapshot);
  return snapshot;
}

export async function restoreSnapshot(path: string): Promise<ToolResult> {
  const snapshot = snapshots.get(path);

  if (!snapshot) {
    return { success: false, error: 'No snapshot found for this file' };
  }

  try {
    await writeFile(snapshot.path, snapshot.content, 'utf-8');
    return { success: true, data: { restored: snapshot.path } };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// Tool definitions for the model
export const toolDefinitions = [
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

// Tool executor
export async function executeTool(
  toolName: string,
  args: any,
  options: { baseDir?: string; allowlist?: string[] } = {}
): Promise<ToolResult> {
  const baseDir = options.baseDir || process.cwd();
  const allowlist = options.allowlist;

  switch (toolName) {
    case 'read_file':
      return readFileTool(args.path, baseDir);

    case 'list_dir':
      return listDirTool(args.path || '.', baseDir);

    case 'glob_search':
      return globSearchTool(args.pattern, baseDir);

    case 'grep_search':
      return grepSearchTool(args.pattern, {
        path: args.path,
        ignoreCase: args.ignoreCase,
        baseDir,
      });

    case 'write_file':
      return writeFileTool(args.path, args.content, baseDir, { createDirs: true });

    case 'edit_file':
      return editFileTool(args.path, { find: args.find, replace: args.replace }, baseDir);

    case 'run_command':
      // Check allowlist
      const cmd = args.command.split(' ')[0];
      if (allowlist && !allowlist.includes(cmd)) {
        return {
          success: false,
          error: `Command '${cmd}' not in allowlist`,
        };
      }
      return runCommandTool(args.command, { cwd: baseDir });

    case 'git_diff':
      return gitDiffTool(baseDir);

    case 'git_status':
      return gitStatusTool(baseDir);

    case 'git_commit':
      return gitCommitTool(args.message, baseDir);

    default:
      return { success: false, error: `Unknown tool: ${toolName}` };
  }
}