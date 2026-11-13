import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPrompt } from './prompt.ts';
import { jsonArray, reconcile } from './opencode.ts';
import type { ResponseItem, TranslationProvider, TranslationRequest } from './types.ts';

export interface CodexOptions {
  model?: string;
  binary?: string;
  timeoutMs?: number;
  onLine?: (line: string) => void;
}

export const DEFAULT_TIMEOUT_MS = 240_000;

const SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i: { type: 'integer' },
          t: { type: 'string' },
          tp: { type: 'string' },
        },
        required: ['i', 't'],
      },
    },
  },
  required: ['items'],
};

export class CodexProvider implements TranslationProvider {
  readonly name = 'codex';
  private readonly options: CodexOptions;

  constructor(options: CodexOptions = {}) {
    this.options = options;
  }

  async translate(request: TranslationRequest, signal?: AbortSignal): Promise<ResponseItem[]> {
    const directory = await mkdtemp(join(tmpdir(), 'wp-translator-codex-'));
    const schemaPath = join(directory, 'schema.json');

    try {
      await writeFile(schemaPath, JSON.stringify(SCHEMA), 'utf-8');
      const prompt = `${buildPrompt(request.context)}\n\nJSON:\n${JSON.stringify(request.items)}`;
      const stdout = await invokeCodex({ ...this.options, schemaPath, prompt, signal });
      return reconcile(request, parseCodexResponse(stdout));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

export interface CodexCall extends CodexOptions {
  schemaPath?: string;
  prompt: string;
  signal?: AbortSignal | undefined;
}

/** Run codex once and return raw stdout. */
export function invokeCodex(call: CodexCall): Promise<string> {
  const args = ['exec', '--sandbox', 'read-only'];
  if (call.model) args.push('-m', call.model);
  if (call.schemaPath) args.push('--output-schema', call.schemaPath);
  args.push(call.prompt);

  const timeoutMs = call.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<string>((resolve, reject) => {
    const child = spawn(call.binary ?? 'codex', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      ...(call.signal ? { signal: call.signal } : {}),
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      reject(new Error(`codex timed out after ${(timeoutMs / 1000).toFixed(0)}s`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      out.push(chunk);
      if (call.onLine) {
        for (const line of chunk.toString('utf-8').split('\n')) {
          if (line.trim()) call.onLine(line);
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));

    child.on('error', (problem) => {
      clearTimeout(timer);
      reject(problem);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (code !== 0) {
        const errorText = Buffer.concat(err).toString('utf-8').trim();
        reject(new Error(`codex exited ${code}: ${errorText || 'unknown error'}`));
        return;
      }
      resolve(Buffer.concat(out).toString('utf-8'));
    });
  });
}

export function parseCodexResponse(text: string): ResponseItem[] {
  try {
    const parsed = JSON.parse(text.trim()) as { items?: unknown };
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.items)) {
      return parsed.items as ResponseItem[];
    }
  } catch {}
  return jsonArray(text) as ResponseItem[];
}
