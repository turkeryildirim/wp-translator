import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from '../db/open.ts';
import { resolveDbPath } from '../db/path.ts';
import { listStyleRules, saveStyleRule } from '../server/tags.ts';

/**
 * Bring an existing database's general style guide up to date with the file.
 *
 * The guide is seeded once, on a database's first open, so a database created
 * before an edit to `style-guide/tr-genel.md` keeps the older text. Re-seeding
 * automatically would overwrite whatever the owner has since written in the
 * panel, which is worse than being out of date.
 *
 * So this refuses when the stored text carries lines the file does not: that is
 * the signature of a hand edit. `--force` overrides, after printing what would
 * be lost.
 */
const guidePath = fileURLToPath(new URL('../../style-guide/tr-genel.md', import.meta.url));

const dbPath = resolveDbPath({ preferLocal: true });
const force = process.argv.includes('--force');

const file = readFileSync(guidePath, 'utf-8');
const db = openDb(dbPath);
const stored = listStyleRules(db).find((rule) => rule.tagId === null)?.body ?? '';

if (stored === file) {
  console.log('Üslup rehberi zaten güncel.');
  process.exit(0);
}

const fileLines = new Set(file.split('\n'));
const ownEdits = stored.split('\n').filter((line) => line.trim() && !fileLines.has(line));

if (ownEdits.length > 0 && !force) {
  console.error(
    `Veritabanındaki rehberde dosyada bulunmayan ${ownEdits.length} satır var — elle düzenlenmiş görünüyor.\n` +
      'Üzerine yazmak için --force ekleyin. Kaybolacak satırlardan bazıları:\n',
  );
  for (const line of ownEdits.slice(0, 10)) console.error(`  ${line}`);
  process.exit(1);
}

saveStyleRule(db, null, file);

console.log(
  `Üslup rehberi güncellendi: ${stored.length} → ${file.length} karakter` +
    (ownEdits.length > 0 ? ` (${ownEdits.length} elle eklenmiş satır --force ile silindi)` : ''),
);
