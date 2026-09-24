import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPrompt } from './prompt.ts';
import type { ResponseItem, TranslationProvider, TranslationRequest } from './types.ts';

export interface OpencodeOptions {
  /**
   * `provider/model`, e.g. `opencode/space-bunny-free`.
   *
   * Left unset by default: opencode's free roster rotates, so pinning a model
   * turns a provider-side change into a broken tool.
   */
  model?: string;
  /**
   * An opencode agent with tools disabled.
   *
   * Without one the model can attempt a tool call, which raises a permission
   * request that nothing will answer, and the run hangs. opencode's agents are
   * read-only over its API, so this is a setup step the tool cannot do itself.
   */
  agent?: string;
  binary?: string;
  timeoutMs?: number;
}

export class OpencodeProvider implements TranslationProvider {
  readonly name = 'opencode';

  // Not a constructor parameter property: Node's type stripping refuses those.
  private readonly options: OpencodeOptions;

  constructor(options: OpencodeOptions) {
    this.options = options;
  }

  async translate(request: TranslationRequest, signal?: AbortSignal): Promise<ResponseItem[]> {
    const directory = await mkdtemp(join(tmpdir(), 'wp-translator-'));
    const payloadPath = join(directory, 'batch.json');

    try {
      await writeFile(payloadPath, JSON.stringify(request.items), 'utf-8');
      const stdout = await this.invoke(payloadPath, buildPrompt(request.context), signal);
      return reconcile(request, parseResponse(collectText(stdout)));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async invoke(
    payloadPath: string,
    prompt: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const args = ['run', '--format', 'json', '--file', payloadPath];
    if (this.options.model) args.push('--model', this.options.model);
    if (this.options.agent) args.push('--agent', this.options.agent);
    args.push(prompt);

    const timeoutMs = this.options.timeoutMs ?? 300_000;

    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.options.binary ?? 'opencode', args, {
        // `opencode run --format json` never returns unless stdin is closed,
        // which is why this uses spawn: execFile cannot set stdio.
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(signal ? { signal } : {}),
      });

      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf-8');
      child.stderr.setEncoding('utf-8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`opencode did not answer within ${timeoutMs / 1000}s`));
      }, timeoutMs);

      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`opencode exited with ${code}: ${stderr.trim().slice(0, 400)}`));
      });
    });
  }
}

/**
 * Assemble the assistant's text from opencode's event stream.
 *
 * `--format json` emits newline-delimited events, not one document: `step_start`,
 * `text`, and so on, each carrying a `part`.
 */
export function collectText(ndjson: string): string {
  const texts: string[] = [];

  for (const line of ndjson.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: { type?: string; part?: { text?: string } };
    try {
      event = JSON.parse(trimmed) as typeof event;
    } catch {
      continue;
    }
    if (event.type === 'text' && typeof event.part?.text === 'string') texts.push(event.part.text);
  }

  // The model may stream a part per chunk or emit one whole text part, so join
  // them all and let the extractor find the array.
  return texts.join('');
}

/** Pull the JSON array out of the reply, tolerating a markdown fence or stray prose. */
export function parseResponse(text: string): ResponseItem[] {
  const withoutFence = text.replace(/```(?:json)?/gi, '').trim();

  const direct = tryParse(withoutFence);
  if (direct) return direct;

  const start = withoutFence.indexOf('[');
  const end = withoutFence.lastIndexOf(']');
  const sliced = start >= 0 && end > start ? tryParse(withoutFence.slice(start, end + 1)) : undefined;
  if (sliced) return sliced;

  throw new Error(
    `The model did not return a JSON array. First 200 characters: ${withoutFence.slice(0, 200)}`,
  );
}

function tryParse(candidate: string): ResponseItem[] | undefined {
  try {
    const parsed: unknown = JSON.parse(candidate);
    return Array.isArray(parsed) ? (parsed as ResponseItem[]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Check the reply covers exactly what was sent. A missing or invented id fails
 * the chunk rather than being guessed at, which is also how a truncated reply
 * is caught.
 */
export function reconcile(
  request: TranslationRequest,
  items: readonly ResponseItem[],
): ResponseItem[] {
  const expected = new Set(request.items.map((item) => item.i));
  const byId = new Map<number, ResponseItem>();

  for (const item of items) {
    if (typeof item?.i !== 'number' || typeof item?.t !== 'string') {
      throw new Error(`Malformed element in the reply: ${JSON.stringify(item).slice(0, 120)}`);
    }
    if (!expected.has(item.i)) throw new Error(`The reply contains id ${item.i}, which was not sent.`);
    byId.set(item.i, item);
  }

  const missing = [...expected].filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(
      `The reply is missing ${missing.length} of ${expected.size} ids, starting with ${missing.slice(0, 5).join(', ')}.`,
    );
  }

  return request.items.map((item) => byId.get(item.i)!);
}
