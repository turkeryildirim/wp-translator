import { reactive } from 'vue';

export interface Note {
  id: number;
  kind: 'ok' | 'error';
  text: string;
  /** Repeats of the same message collapse into one row carrying a count. */
  count: number;
  /**
   * Groups notes that stop being true on their own, so they can be withdrawn.
   * A failed save has none: nothing makes it untrue but the owner reading it.
   */
  tag?: string;
}

export const notes = reactive<Note[]>([]);

let nextId = 0;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/** Successes are confirmations, not decisions: they clear themselves. */
const SUCCESS_MS = 4000;
/** Enough to see what happened, short enough not to become wallpaper. */
const MAX_VISIBLE = 4;

/**
 * Show a message in the corner.
 *
 * Reviewing runs on the keyboard, and one approval is one write, so a run of
 * approvals would otherwise stack a toast per keystroke. An identical message
 * arriving again increments the one already showing instead.
 *
 * Errors stay until dismissed. A save that failed and scrolled away on a timer
 * is worse than no message at all — the owner would believe the edit landed.
 */
export function notify(kind: Note['kind'], text: string, tag?: string): void {
  const last = notes[notes.length - 1];
  if (last && last.kind === kind && last.text === text) {
    last.count += 1;
    schedule(last);
    return;
  }

  const note: Note = { id: (nextId += 1), kind, text, count: 1, ...(tag ? { tag } : {}) };
  notes.push(note);
  while (notes.length > MAX_VISIBLE) dismiss(notes[0]!.id);
  schedule(note);
}

export function dismiss(id: number): void {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);

  const at = notes.findIndex((note) => note.id === id);
  if (at !== -1) notes.splice(at, 1);
}

function schedule(note: Note): void {
  if (note.kind === 'error') return;
  const existing = timers.get(note.id);
  if (existing) clearTimeout(existing);
  timers.set(
    note.id,
    setTimeout(() => dismiss(note.id), SUCCESS_MS),
  );
}

/**
 * Withdraw notes of a group that is no longer true.
 *
 * "The server cannot be reached" outlives its own truth: an error stays until
 * dismissed, so one shown while the server restarted would sit there reading as
 * the present state. The next answered request is what retires it.
 */
export function withdraw(tag: string): void {
  for (const note of [...notes]) if (note.tag === tag) dismiss(note.id);
}
