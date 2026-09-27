import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dismiss, notes, notify, withdraw } from '../panel/src/notify.ts';

beforeEach(() => {
  vi.useFakeTimers();
  while (notes.length) dismiss(notes[0]!.id);
});
afterEach(() => vi.useRealTimers());

describe('the corner report', () => {
  it('collapses a run of identical messages instead of stacking them', () => {
    // Review is keyboard-driven and one approval is one write. Without this,
    // approving ten strings leaves ten toasts covering the screen.
    for (let i = 0; i < 10; i += 1) notify('ok', 'Kaydedildi');

    expect(notes).toHaveLength(1);
    expect(notes[0]!.count).toBe(10);
  });

  it('keeps an error until it is dismissed', () => {
    // A failed save that clears itself on a timer is worse than silence: the
    // owner goes on believing the edit landed.
    notify('error', 'Kaydedilemedi: 500');
    vi.advanceTimersByTime(60_000);

    expect(notes).toHaveLength(1);
    dismiss(notes[0]!.id);
    expect(notes).toHaveLength(0);
  });

  it('clears a success on its own', () => {
    notify('ok', 'Kaydedildi');
    vi.advanceTimersByTime(60_000);

    expect(notes).toHaveLength(0);
  });

  it('restarts the countdown when a repeat arrives', () => {
    notify('ok', 'Kaydedildi');
    vi.advanceTimersByTime(3000);
    notify('ok', 'Kaydedildi');
    vi.advanceTimersByTime(3000);

    // Still showing: the second one has not timed out yet.
    expect(notes).toHaveLength(1);
    vi.advanceTimersByTime(3000);
    expect(notes).toHaveLength(0);
  });

  it('does not let a long session grow an unbounded stack', () => {
    for (let i = 0; i < 12; i += 1) notify('error', `hata ${i}`);

    expect(notes).toHaveLength(4);
    expect(notes.at(-1)!.text).toBe('hata 11');
  });
});

describe('a message that stops being true on its own', () => {
  it('is withdrawn when the thing it reported recovers', () => {
    // The server is a local process the owner restarts. An error stays until
    // dismissed — right for a failed save, wrong for "cannot reach the server",
    // which would then sit on screen reading as the present state.
    notify('error', 'Sunucuya ulaşılamadı.', 'offline');
    expect(notes.length).toBe(1);

    withdraw('offline');

    expect(notes.length).toBe(0);
  });

  it('leaves an untagged error alone, because nothing makes it untrue', () => {
    notify('error', 'Kaydedilemedi.');

    withdraw('offline');

    expect(notes.length).toBe(1);
  });
})
