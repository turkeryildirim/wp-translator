import { describe, expect, it } from 'vitest';
import { activeJobCount, hasActiveJobs, readJob, startJob } from '../src/server/jobs.ts';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('work collected by ticket', () => {
  it('tracks active background jobs count and status', async () => {
    let completeJob: () => void;
    const pendingPromise = new Promise((resolve) => {
      completeJob = () => resolve('finished');
    });

    const id = startJob(() => pendingPromise);
    expect(hasActiveJobs()).toBe(true);
    expect(activeJobCount()).toBeGreaterThanOrEqual(1);

    completeJob!();
    await settle();

    readJob(id);
  });

  it('is not done the moment it is started', () => {
    // The point of the ticket: the request that asked returns at once, so the
    // extension's background worker is never carrying a minute-long request.
    const id = startJob(() => new Promise((resolve) => setTimeout(() => resolve('ok'), 50)));

    expect(readJob(id)).toEqual({ done: false });
  });

  it('hands back the answer once there is one', async () => {
    const id = startJob(() => Promise.resolve({ judgements: [] }));
    await settle();

    expect(readJob(id)).toEqual({ done: true, result: { judgements: [] } });
  });

  it('hands back the reason when the work failed', async () => {
    const id = startJob(() => Promise.reject(new Error('agy did not answer within 240s')));
    await settle();

    expect(readJob(id)?.error).toMatch(/did not answer/);
  });

  it('keeps an answer until it is collected, then forgets it', async () => {
    // A lost poll has to be able to find the answer; a collected one must not
    // accumulate, because nobody comes back for it.
    const id = startJob(() => Promise.resolve('once'));
    await settle();

    expect(readJob(id)).toMatchObject({ result: 'once' });
    expect(readJob(id)).toBeUndefined();
  });

  it('does not know a ticket it never issued', () => {
    expect(readJob('00000000-0000-0000-0000-000000000000')).toBeUndefined();
  });
});
