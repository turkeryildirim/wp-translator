import { spawn } from 'node:child_process';
import { buildPrompt } from './prompt.ts';
import { jsonArray, reconcile } from './opencode.ts';
import type { ResponseItem, TranslationProvider, TranslationRequest } from './types.ts';

export interface ClaudeOptions {
  model?: string;
  binary?: string;
  timeoutMs?: number;
  onLine?: (line: string) => void;
}

export const DEFAULT_TIMEOUT_MS = 240_000;

export class ClaudeProvider implements TranslationProvider {
  readonly name = 'claude';
  private readonly options: ClaudeOptions;

  constructor(options: ClaudeOptions = {}) {
    this.options = options;
  }

  async translate(request: TranslationRequest, signal?: AbortSignal): Promise<ResponseItem[]> {
    const prompt = `${buildPrompt(request.context)}\n\nJSON:\n${JSON.stringify(request.items)}`;
    const stdout = await invokeClaude({ ...this.options, prompt, signal });
    return reconcile(request, parseClaudeResponse(stdout));
  }
}

export interface ClaudeCall extends ClaudeOptions {
  prompt: string;
  signal?: AbortSignal | undefined;
}

/** Run claude once and return raw stdout. */
export function invokeClaude(call: ClaudeCall): Promise<string> {
  const args = ['-p', '--tools', ''];
  if (call.model) args.push('--model', call.model);
  args.push(call.prompt);

  const timeoutMs = call.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<string>((resolve, reject) => {
    const child = spawn(call.binary ?? 'claude', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(call.signal ? { signal: call.signal } : {}),
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      reject(new Error(`claude timed out after ${(timeoutMs / 1000).toFixed(0)}s`));
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
        reject(new Error(`claude exited ${code}: ${errorText || 'unknown error'}`));
        return;
      }
      resolve(Buffer.concat(out).toString('utf-8'));
    });
  });
}

export function parseClaudeResponse(text: string): ResponseItem[] {
  try {
    const parsed = JSON.parse(text.trim()) as { items?: unknown };
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.items)) {
      return parsed.items as ResponseItem[];
    }
  } catch {}
  return jsonArray(text) as ResponseItem[];
}
