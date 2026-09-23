import type { Db } from '../db/open.ts';
import { sourceHash } from './key.ts';

/** `https://translate.wordpress.org/locale/tr/default/glossary/-export/` */
export const OFFICIAL_GLOSSARY_CSV =
  'https://translate.wordpress.org/locale/tr/default/glossary/-export/';

export interface GlossaryTerm {
  en: string;
  tr: string;
  /** noun, verb, adjective, expression, … — a real distinction, see below. */
  pos: string;
  description: string;
}

export interface ImportResult {
  /** Readings the glossary gained since the last import. */
  added: number;
  /** Readings that were already present. */
  kept: number;
  /** Readings dropped upstream and therefore dropped here. */
  removed: number;
  /** Rows with an empty English or Turkish side. */
  skipped: number;
}

/**
 * Import the official WordPress Turkish glossary.
 *
 * This is the term list the Turkish translation team maintains by hand, and it
 * is what R19 argued the system was missing: exact full-string matching reaches
 * about a tenth of a project, while terminology reaches 70–100 % of it.
 *
 * Terms are stored as ordinary glossary entries under `origin = 'owner'`, so a
 * trusted-source sweep never removes them — they do not belong to any project.
 *
 * `pos` and the translation are both part of the key. The glossary distinguishes
 * by part of speech (`archive` is `arşiv` as a noun, `arşivle` as a verb) and it
 * also offers alternatives under one part of speech (`author` is both `yazar`
 * and `geliştirici`). Keying on the term alone would make the import overwrite
 * itself, so a re-run would never settle.
 *
 * The import **replaces** the term rows under `tagId`: a reading dropped
 * upstream is dropped here too. Because of that the tag should be dedicated to
 * this import rather than shared with the owner's own terms.
 */
export function importOfficialGlossary(
  db: Db,
  terms: readonly GlossaryTerm[],
  tagId: number,
): ImportResult {
  const insert = db.prepare(
    `INSERT INTO glossary_entries
       (source_hash, source_text, msgctxt, pos, note, tag_id, translation, origin)
     VALUES (@hash, @en, NULL, @pos, @note, @tagId, @tr, 'owner')
     ON CONFLICT (source_hash, pos, translation, tag_id) WHERE pos IS NOT NULL DO UPDATE SET
       note = excluded.note,
       updated_at = datetime('now')
     RETURNING id`,
  );

  const countTerms = db.prepare(
    `SELECT count(*) AS n FROM glossary_entries WHERE tag_id = ? AND pos IS NOT NULL`,
  );
  const termCount = (): number => (countTerms.get(tagId) as { n: number }).n;

  return db.transaction((): ImportResult => {
    const before = termCount();
    // Identity rather than a timestamp: `datetime('now')` has second
    // granularity, so two imports in the same second are indistinguishable and
    // the sweep silently does nothing.
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS seen_terms (id INTEGER PRIMARY KEY)`);
    db.exec(`DELETE FROM seen_terms`);
    const remember = db.prepare(`INSERT OR IGNORE INTO seen_terms (id) VALUES (?)`);

    let skipped = 0;
    for (const term of terms) {
      const en = term.en.trim();
      const tr = term.tr.trim();
      if (!en || !tr) {
        skipped += 1;
        continue;
      }

      const row = insert.get({
        hash: sourceHash(en),
        en,
        pos: term.pos.trim() || null,
        note: term.description.trim() || null,
        tagId,
        tr,
      }) as { id: number } | undefined;
      if (row) remember.run(row.id);
    }

    const added = termCount() - before;
    const removed = db
      .prepare(
        `DELETE FROM glossary_entries
          WHERE tag_id = ? AND pos IS NOT NULL AND id NOT IN (SELECT id FROM seen_terms)`,
      )
      .run(tagId).changes;

    const kept = (db.prepare(`SELECT count(*) AS n FROM seen_terms`).get() as { n: number }).n;
    return { added, kept: kept - added, removed, skipped };
  })();
}

/**
 * Parse the CSV GlotPress serves at `-export/`.
 *
 * Hand-written rather than pulled in as a dependency: the format is four
 * columns, and descriptions contain embedded newlines inside quotes, which is
 * the only part that needs care.
 */
export function parseGlossaryCsv(csv: string): GlossaryTerm[] {
  const rows = parseRows(csv);
  const header = rows.shift();
  if (!header || header[0] !== 'en' || header[1] !== 'tr') {
    throw new Error(`Unexpected glossary CSV header: ${header?.join(', ') ?? '(empty)'}`);
  }

  return rows
    .filter((row) => row.length >= 2 && row[0])
    .map((row) => ({
      en: row[0] ?? '',
      tr: row[1] ?? '',
      pos: row[2] ?? '',
      description: row[3] ?? '',
    }));
}

function parseRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i];

    if (quoted) {
      if (char !== '"') field += char;
      else if (csv[i + 1] === '"') { field += '"'; i += 1; }
      else quoted = false;
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (char !== '\r') field += char;
  }

  if (field || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}
