import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPrompt } from './prompt.ts';
import { unescapeEchoedQuotes } from '../text/escapes.ts';
import type { RequestItem, ResponseItem, TranslationProvider, TranslationRequest } from './types.ts';

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
  /** Called with each line opencode writes, so a run can be watched. */
  onLine?: (line: string) => void;
}

/**
 * How long a single request may take before it is killed.
 *
 * Wide because the variance is wide and not proportional to the work: measured on
 * one project, chunks of 800 to 1 800 characters of source came back in 38, 81,
 * 84 and 125 seconds, and the whole 6 038 in 174. A limit tight enough to catch a
 * stall promptly is one that kills ordinary answers, which is worse — a stall
 * costs one chunk, a killed answer costs every chunk. `DEFAULT_CHUNK_CHARS` is
 * what bounds the work; this only has to outlast it.
 */
export const DEFAULT_TIMEOUT_MS = 240_000;

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

      // A refused request can still exit zero, leaving no text and no clue in the
      // exit code. The stream's own error is the only thing that names the cause.
      const text = collectText(stdout);
      if (!text.trim()) {
        const reported = providerError(stdout);
        if (reported) throw new Error(`opencode: ${reported}`);
      }

      return reconcile(request, parseResponse(text));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private invoke(
    payloadPath: string,
    prompt: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    return invokeOpencode({ ...this.options, payloadPath, prompt, ...(signal ? { signal } : {}) });
  }

}

export interface OpencodeCall extends OpencodeOptions {
  /** A JSON file attached with `--file`, where the task has a payload. */
  payloadPath?: string;
  prompt: string;
  signal?: AbortSignal | undefined;
}

/** Run opencode once and hand back its raw event stream. */
export function invokeOpencode(call: OpencodeCall): Promise<string> {
  const args = ['run', '--format', 'json'];
  if (call.payloadPath) args.push('--file', call.payloadPath);
  if (call.model) args.push('--model', call.model);
  if (call.agent) args.push('--agent', call.agent);
  args.push(call.prompt);

  const timeoutMs = call.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<string>((resolve, reject) => {
    const child = spawn(call.binary ?? 'opencode', args, {
      // `opencode run --format json` never returns unless stdin is closed, which
      // is why this uses spawn: execFile cannot set stdio.
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(call.signal ? { signal: call.signal } : {}),
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');

    // Reported as it arrives. A stalled request looks identical to a slow one from
    // the outside; its output is the difference.
    const watch = call.onLine;
    const feed = (render: (line: string) => string | null): ((chunk: string) => void) => {
      let rest = '';
      return (chunk: string) => {
        if (!watch) return;
        const lines = (rest + chunk).split('\n');
        rest = lines.pop() ?? '';
        for (const line of lines) {
          const shown = line.trim() ? render(line) : null;
          if (shown) watch(shown);
        }
      };
    };
    const toOut = feed(describeEvent);
    const toErr = feed((line) => `hata: ${line.trim()}`);

    child.stdout.on('data', (chunk: string) => { stdout += chunk; toOut(chunk); });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; toErr(chunk); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`opencode did not answer within ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout);

      const reported = providerError(stdout);
      reject(
        new Error(
          reported
            ? `opencode: ${reported}`
            : `opencode exited with ${code}: ${stderr.trim().slice(0, 400) || '(hiçbir şey yazmadı)'}`,
        ),
      );
    });
  });
}

/**
 * The provider's own complaint, where the stream carried one.
 *
 * opencode reports a refused request as an `error` event on stdout and leaves
 * stderr empty, so neither the exit code nor stderr says anything. The usual
 * cause is the free roster: a model stops accepting requests from the CLI and
 * every chunk then fails identically.
 */
export function providerError(ndjson: string): string | null {
  for (const line of ndjson.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: { error?: { message?: string; type?: string } };
    try {
      event = JSON.parse(trimmed) as typeof event;
    } catch {
      continue;
    }

    const error = event.error;
    if (!error) continue;
    return error.message ?? error.type ?? JSON.stringify(error).slice(0, 200);
  }
  return null;
}

/**
 * Turn one line of opencode's event stream into something a person can read.
 *
 * The raw events are JSON objects full of ids and snapshots; what matters while
 * a run goes is the text the model is producing and whether anything is
 * arriving at all. Returns null for events with nothing to say.
 */
export function describeEvent(line: string): string | null {
  let event: { type?: string; part?: { type?: string; text?: string }; error?: unknown };
  try {
    event = JSON.parse(line) as typeof event;
  } catch {
    // Not an event: opencode's own chatter, worth showing as it is.
    return line.trim().slice(0, 200);
  }

  if (event.error) return `hata: ${JSON.stringify(event.error).slice(0, 200)}`;

  const text = event.part?.text;
  if (typeof text === 'string' && text.trim()) {
    return `» ${text.replace(/\s+/g, ' ').trim()}`;
  }

  const kind = event.part?.type ?? event.type;
  switch (kind) {
    case 'step-start':
    case 'step_start':
      return '· istek gönderildi, model düşünüyor…';
    case 'step-finish':
    case 'step_finish':
      return '· model yanıtı tamamladı';
    default:
      return null;
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

export const parseResponse = (text: string): ResponseItem[] => jsonArray(text) as ResponseItem[];

/**
 * Pull the JSON array out of a reply, tolerating a markdown fence or stray prose.
 *
 * opencode cannot be told to answer in a shape, unlike agy, so whatever the model
 * wrapped the array in has to be cut away here.
 */
export function jsonArray(text: string): unknown[] {
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

function tryParse(candidate: string): unknown[] | undefined {
  try {
    const parsed: unknown = JSON.parse(candidate);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Check the reply covers exactly what was sent. A missing or invented id fails
 * the chunk rather than being guessed at, which is also how a truncated reply
 * is caught.
 *
 * It is also where an answer meets the string it was asked about, so it is where
 * the payload's own escaping is taken back off — both providers come through
 * here, and a wording is repaired before anything checks or remembers it.
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

  return request.items.map((item) => unescaped(item, byId.get(item.i)!));
}

/** One answer with the quotes it echoed out of the payload put back as quotes. */
function unescaped(asked: RequestItem, answer: ResponseItem): ResponseItem {
  const repaired: ResponseItem = { i: answer.i, t: unescapeEchoedQuotes(asked.s, answer.t) };
  if (answer.tp !== undefined) {
    repaired.tp = unescapeEchoedQuotes(asked.p ?? asked.s, answer.tp);
  }
  return repaired;
}
