import { randomUUID } from 'node:crypto';

export interface JobState {
  done: boolean;
  /** The answer, once there is one. */
  result?: unknown;
  /** Why there will not be one. */
  error?: string;
}

/**
 * Work the caller collects later, by ticket.
 *
 * The review script reaches the server through the browser extension's background
 * worker, which Chrome puts to sleep — a request held open for a minute dies with
 * it and the answer is lost. Handing back a ticket keeps every request short, so
 * the worker is never carrying one when it goes, and the work survives being
 * disconnected from.
 */
const jobs = new Map<string, JobState>();

/** Finished tickets nobody collected, kept so a lost poll can still find its answer. */
const KEEP = 64;

export function startJob(run: () => Promise<unknown>): string {
  const id = randomUUID();
  jobs.set(id, { done: false });

  void run().then(
    (result) => finish(id, { done: true, result }),
    (problem: unknown) =>
      finish(id, {
        done: true,
        error: problem instanceof Error ? problem.message : String(problem),
      }),
  );

  return id;
}

/** The ticket's state. A collected answer is dropped: there is one reader. */
export function readJob(id: string): JobState | undefined {
  const job = jobs.get(id);
  if (job?.done) jobs.delete(id);
  return job;
}

/** Check if there are any pending / in-progress background jobs. */
export function hasActiveJobs(): boolean {
  for (const [, state] of jobs) {
    if (!state.done) return true;
  }
  return false;
}

/** Number of currently active background jobs. */
export function activeJobCount(): number {
  let count = 0;
  for (const [, state] of jobs) {
    if (!state.done) count++;
  }
  return count;
}

function finish(id: string, state: JobState): void {
  // Only if it is still wanted: a ticket collected between starting and finishing
  // cannot happen, but one evicted by the cap can.
  if (!jobs.has(id)) return;
  jobs.set(id, state);

  const finished = [...jobs].filter(([, job]) => job.done);
  for (const [old] of finished.slice(0, Math.max(0, finished.length - KEEP))) jobs.delete(old);
}
