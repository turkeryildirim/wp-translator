import { openDb } from '../db/open.ts';
import { resolveDbPath } from '../db/path.ts';
import { startServer } from '../server/http.ts';

const dbPath = resolveDbPath({ preferLocal: true });
const port = Number(process.env.WPT_PORT ?? 4173);
const panelDir = process.env.WPT_PANEL ?? 'dist/panel';

startServer({ db: openDb(dbPath), port, panelDir });
console.log(`wp-translator http://127.0.0.1:${port}  (db: ${dbPath})`);
