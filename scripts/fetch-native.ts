import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const target = process.argv[2] ?? 'node';

const require = createRequire(import.meta.url);
const betterSqliteDir = dirname(require.resolve('better-sqlite3/package.json'));
const releaseDir = join(betterSqliteDir, 'build', 'Release');
mkdirSync(releaseDir, { recursive: true });

const version = 'v12.11.1';

let filename: string;
if (target === 'win' || target === 'win32') {
  filename = `better-sqlite3-${version}-electron-v146-win32-x64.tar.gz`;
} else if (target === 'linux' || target === 'electron-linux') {
  filename = `better-sqlite3-${version}-electron-v146-linux-x64.tar.gz`;
} else {
  // Node.js runtime (Node 24 ABI v137)
  filename = `better-sqlite3-${version}-node-v137-linux-x64.tar.gz`;
}

const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/${version}/${filename}`;

console.log(`[fetch-native] Downloading ${filename} for ${target}...`);
execFileSync('sh', [
  '-c',
  `curl -fSL --retry 3 "${url}" | tar -xzf - -C "${betterSqliteDir}"`,
]);
console.log(`[fetch-native] Successfully updated native binding in ${releaseDir}`);
