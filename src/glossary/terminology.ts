import type { Db } from '../db/open.ts';

export interface Term {
  source: string;
  /** Every reading the glossary holds for this term, across the project's tags. */
  readings: TermReading[];
}

export interface TermReading {
  translation: string;
  /** noun, verb, … from the official glossary. `archive` is arşiv or arşivle by this. */
  pos?: string;
  /** The official glossary's own note, where it has one. */
  note?: string;
}

/** Terms are short by definition; anything longer is a sentence, not a term. */
const MAX_WORDS = 3;
const MAX_LENGTH = 30;

/** Word-ish tokens. Deliberately ASCII: the source strings are English. */
const WORD = /[A-Za-z][A-Za-z'-]*/g;

/**
 * Collect the glossary terms that appear inside a batch of source strings.
 *
 * This is where consistency comes from. Exact full-string matching reaches about
 * a tenth of a project, but 70–100 % of strings contain at least one term the
 * glossary knows, three to six on average, and most of those strings carry a
 * term the glossary translates more than one way (R19). Handing those to the
 * model is what makes `item` come out as `ürün` in one project and `öge` in
 * another.
 *
 * Measured on Astra: a 500-string batch matches 344 terms in about 6 ms.
 */
export function collectTerms(db: Db, projectId: number, sources: readonly string[]): Term[] {
  const candidates = new Set<string>();
  for (const source of sources) {
    for (const ngram of ngrams(source)) candidates.add(ngram);
  }
  if (candidates.size === 0) return [];

  const rows = db
    .prepare(
      `SELECT g.source_text AS source, g.translation, g.pos, g.note
         FROM glossary_entries g
        WHERE g.tag_id IN (SELECT tag_id FROM project_tags WHERE project_id = ?)
          AND length(g.source_text) <= ${MAX_LENGTH}
        ORDER BY g.source_text, g.pos, g.translation`,
    )
    .all(projectId) as { source: string; translation: string; pos: string | null; note: string | null }[];

  const found = new Map<string, Map<string, TermReading>>();
  for (const row of rows) {
    if (!candidates.has(row.source.toLowerCase())) continue;
    const readings = found.get(row.source) ?? found.set(row.source, new Map()).get(row.source)!;
    const key = `${row.pos ?? ''}\u0000${row.translation}`;
    if (readings.has(key)) continue;

    const reading: TermReading = { translation: row.translation };
    if (row.pos) reading.pos = row.pos;
    if (row.note) reading.note = row.note;
    readings.set(key, reading);
  }

  return [...found]
    .map(([source, readings]) => ({ source, readings: [...readings.values()] }))
    .sort((a, b) => a.source.localeCompare(b.source));
}

/** Every 1–3 word run in a string, lowercased. */
function ngrams(text: string): string[] {
  const words = text.match(WORD) ?? [];
  const out: string[] = [];
  for (let size = 1; size <= MAX_WORDS; size += 1) {
    for (let start = 0; start + size <= words.length; start += 1) {
      out.push(words.slice(start, start + size).join(' ').toLowerCase());
    }
  }
  return out;
}
