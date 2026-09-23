export interface FetchOptions {
  /** Pause between requests. translate.wordpress.org rate-limits a tight loop. */
  pauseMs?: number;
  /** Attempts per URL, including the first. */
  attempts?: number;
  /** Wait after a 429 before retrying. Doubles each attempt. */
  backoffMs?: number;
  signal?: AbortSignal;
}

const DEFAULTS = { pauseMs: 400, attempts: 4, backoffMs: 5_000 } as const;

export class RateLimited extends Error {
  constructor(url: string, attempts: number) {
    super(`translate.wordpress.org rate-limited ${url} after ${attempts} attempts`);
    this.name = 'RateLimited';
  }
}

/**
 * Fetch a PO export, pacing and retrying.
 *
 * The service advertises no rate-limit headers and sends no `Retry-After`, but
 * the limit is real: fetching 41 trusted sources back to back returned one 429,
 * which succeeded again twenty seconds later. So the pacing is deliberate rather
 * than defensive, and a 429 is a wait rather than a failure.
 */
export async function fetchExport(url: string, options: FetchOptions = {}): Promise<string> {
  const { attempts, backoffMs } = { ...DEFAULTS, ...options };
  let wait = backoffMs;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url, options.signal ? { signal: options.signal } : {});

    if (response.ok) return response.text();

    if (response.status === 429) {
      if (attempt === attempts) throw new RateLimited(url, attempts);
      await sleep(retryAfterMs(response) ?? wait, options.signal);
      wait *= 2;
      continue;
    }

    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }

  throw new RateLimited(url, attempts);
}

/**
 * Fetch several exports in order, pausing between them.
 *
 * Sequential on purpose: the point is to stay under the limit, and a trusted
 * source sync is not latency-sensitive.
 */
export async function* fetchExports(
  urls: readonly string[],
  options: FetchOptions = {},
): AsyncGenerator<{ url: string; po: string }> {
  const pauseMs = options.pauseMs ?? DEFAULTS.pauseMs;

  for (const [index, url] of urls.entries()) {
    if (index > 0) await sleep(pauseMs, options.signal);
    yield { url, po: await fetchExport(url, options) };
  }
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });
}
