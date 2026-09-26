import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPrompt } from './prompt.ts';
import { reconcile } from './opencode.ts';
import type { ResponseItem, TranslationProvider, TranslationRequest } from './types.ts';

export interface AgyOptions {
  /** e.g. `gemini-3.8-flash-low`. Left to agy's own default when unset. */
  model?: string;
  binary?: string;
  timeoutMs?: number;
  /** Called with each line agy writes, so a run can be watched. */
  onLine?: (line: string) => void;
}

export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * The shape a translation answer must take.
 *
 * Top-level must be an object: the backing model refuses a bare array. The
 * wrapper is unwrapped again on the way out.
 */
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

/**
 * Translate through the Antigravity CLI.
 *
 * Unlike opencode, agy enforces the answer's shape with `--json-schema` and
 * hands it back already parsed under `structured_output`, so nothing has to be
 * scraped out of prose or fenced code.
 */
export class AgyProvider implements TranslationProvider {
  readonly name = 'agy';

  private readonly options: AgyOptions;

  constructor(options: AgyOptions = {}) {
    this.options = options;
  }

  async translate(request: TranslationRequest, signal?: AbortSignal): Promise<ResponseItem[]> {
    const directory = await mkdtemp(join(tmpdir(), 'wp-translator-agy-'));
    const schemaPath = join(directory, 'schema.json');

    try {
      await writeFile(schemaPath, JSON.stringify(SCHEMA), 'utf-8');
      // The payload rides in the prompt: agy takes no attachment flag.
      const prompt = `${buildPrompt(request.context)}\n\nJSON:\n${JSON.stringify(request.items)}`;
      const stdout = await invokeAgy({ ...this.options, schemaPath, prompt, signal });
      return reconcile(request, parseAgyResponse(stdout));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

export interface AgyCall extends AgyOptions {
  schemaPath: string;
  prompt: string;
  signal?: AbortSignal | undefined;
}

/** Run agy once and hand back its raw stdout. */
export function invokeAgy(call: AgyCall): Promise<string> {
  const args = ['--output-format', 'json', '--json-schema', call.schemaPath];
  if (call.model) args.push('--model', call.model);
  // `-p` must carry its own value or agy reads the next flag as the prompt.
  args.push(`-p=${call.prompt}`);

  const timeoutMs = call.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<string>((resolve, reject) => {
    const child = spawn(call.binary ?? 'agy', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(call.signal ? { signal: call.signal } : {}),
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      for (const line of chunk.split('\n')) if (line.trim()) call.onLine?.(line.trim());
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`agy did not answer within ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`agy exited with ${code}: ${stderr.trim().slice(0, 400)}`));
    });
  });
}

/**
 * Read the translations out of agy's reply.
 *
 * `structured_output` is the schema-checked answer. A run that failed still
 * exits zero and reports itself in `status`, `error` and `denied_actions`, so
 * those are read rather than assumed.
 */
export function agyItems(stdout: string): unknown[] {
  let reply: {
    status?: string;
    error?: string;
    structured_output?: { items?: unknown };
    denied_actions?: { display_name?: string; action?: string }[];
  };
  try {
    reply = JSON.parse(stdout.trim()) as typeof reply;
  } catch {
    throw new Error(`agy did not return JSON: ${stdout.trim().slice(0, 200)}`);
  }

  if (reply.status && reply.status !== 'SUCCESS') {
    throw new Error(`agy reported ${reply.status}: ${String(reply.error ?? '').slice(0, 200)}`);
  }

  const items = reply.structured_output?.items;
  if (Array.isArray(items)) return items;

  // A denied tool call is the common way to get here, and it looks like SUCCESS
  // with an empty response. Naming the tool separates it from a model that
  // answered in the wrong shape.
  const denied = (reply.denied_actions ?? [])
    .map((entry) => entry.display_name ?? entry.action ?? 'bilinmeyen')
    .join(', ');
  if (denied) {
    throw new Error(
      `agy did not answer: the model spent its turn on a tool call (${denied}), which was denied.`,
    );
  }
  throw new Error('agy returned no structured output; the model ignored the schema.');
}

export function parseAgyResponse(stdout: string): ResponseItem[] {
  return agyItems(stdout).map((raw) => {
    const item = raw as { i?: unknown; t?: unknown; tp?: unknown };
    if (typeof item.i !== 'number' || typeof item.t !== 'string') {
      throw new Error(`agy returned an unusable item: ${JSON.stringify(raw).slice(0, 120)}`);
    }
    return typeof item.tp === 'string' && item.tp
      ? { i: item.i, t: item.t, tp: item.tp }
      : { i: item.i, t: item.t };
  });
}
