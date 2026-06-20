import { readFile, writeFile, mkdir, readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { AgentState, Plan, TaskStep } from './agent/index.js';
import chalk from 'chalk';

export interface SessionData {
  sessionId: string;
  plan: Plan | null;
  history: any[];
  currentStep: number;
  createdAt: string;
  updatedAt: string;
  task: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
}

const SESSION_DIR = join(homedir(), '.agent', 'sessions');

async function ensureSessionDir(): Promise<void> {
  if (!existsSync(SESSION_DIR)) {
    await mkdir(SESSION_DIR, { recursive: true });
  }
}

export async function saveSession(session: SessionData): Promise<void> {
  await ensureSessionDir();

  const path = join(SESSION_DIR, `${session.sessionId}.json`);
  session.updatedAt = new Date().toISOString();

  await writeFile(path, JSON.stringify(session, null, 2), 'utf-8');
}

export async function loadSession(sessionId: string): Promise<SessionData | null> {
  const path = join(SESSION_DIR, `${sessionId}.json`);

  if (!existsSync(path)) {
    return null;
  }

  const content = await readFile(path, 'utf-8');
  return JSON.parse(content);
}

export async function listSessions(): Promise<SessionData[]> {
  await ensureSessionDir();

  const files = await readdir(SESSION_DIR);
  const sessions: SessionData[] = [];

  for (const file of files) {
    if (!file.endsWith('.json')) continue;

    try {
      const path = join(SESSION_DIR, file);
      const content = await readFile(path, 'utf-8');
      sessions.push(JSON.parse(content));
    } catch {
      // Skip invalid files
    }
  }

  return sessions.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export async function deleteSession(sessionId: string): Promise<void> {
  const path = join(SESSION_DIR, `${sessionId}.json`);

  if (existsSync(path)) {
    await rm(path);
  }
}

export function sessionToAgentState(session: SessionData): AgentState {
  return {
    plan: session.plan,
    history: session.history,
    currentStep: session.currentStep,
    sessionId: session.sessionId,
  };
}

export function agentStateToSession(
  state: AgentState,
  task: string,
  status: SessionData['status'] = 'running'
): SessionData {
  return {
    sessionId: state.sessionId,
    plan: state.plan,
    history: state.history,
    currentStep: state.currentStep,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    task,
    status,
  };
}