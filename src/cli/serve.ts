import { openDb } from '../db/open.ts';
import { startServer } from '../server/http.ts';

const dbPath = process.env.WPT_DB ?? 'wp-translator.sqlite';
const port = Number(process.env.WPT_PORT ?? 4173);
const panelDir = process.env.WPT_PANEL ?? 'dist/panel';

startServer({ db: openDb(dbPath), port, panelDir });
console.log(`wp-translator http://127.0.0.1:${port}  (db: ${dbPath})`);
