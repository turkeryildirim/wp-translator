import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface ResolveDbPathOptions {
  /** If true and local file exists or WPT_DB is not set, prefers local directory (for dev). */
  preferLocal?: boolean;
}

/**
 * Returns the OS-standard database path for wp-translator:
 * - Linux:   ~/.config/wp-translator/wp-translator.sqlite (or $XDG_CONFIG_HOME)
 * - Windows: %APPDATA%\wp-translator\wp-translator.sqlite
 * - Custom:  process.env.WPT_DB if set
 */
export function getStandardDbPath(): string {
  if (process.env.WPT_DB) {
    return process.env.WPT_DB;
  }

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'wp-translator', 'wp-translator.sqlite');
  }

  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(configHome, 'wp-translator', 'wp-translator.sqlite');
}

/**
 * Resolves the database path, ensuring its parent directory exists on disk.
 */
export function resolveDbPath(options: ResolveDbPathOptions = {}): string {
  if (process.env.WPT_DB) {
    const path = process.env.WPT_DB;
    mkdirSync(dirname(path), { recursive: true });
    return path;
  }

  if (options.preferLocal) {
    return 'wp-translator.sqlite';
  }

  const standardPath = getStandardDbPath();
  mkdirSync(dirname(standardPath), { recursive: true });
  return standardPath;
}
