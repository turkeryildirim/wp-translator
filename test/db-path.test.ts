import { afterEach, describe, expect, it } from 'vitest';
import { getStandardDbPath, resolveDbPath } from '../src/db/path.ts';

describe('db path resolution', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('honors WPT_DB environment variable', () => {
    process.env.WPT_DB = '/tmp/custom-test-wp.sqlite';
    expect(getStandardDbPath()).toBe('/tmp/custom-test-wp.sqlite');
    expect(resolveDbPath()).toBe('/tmp/custom-test-wp.sqlite');
  });

  it('returns preferLocal path when option is passed', () => {
    delete process.env.WPT_DB;
    expect(resolveDbPath({ preferLocal: true })).toBe('wp-translator.sqlite');
  });

  it('resolves OS standard path on Linux/Unix', () => {
    delete process.env.WPT_DB;
    delete process.env.XDG_CONFIG_HOME;
    const path = getStandardDbPath();
    expect(path).toContain('.config/wp-translator/wp-translator.sqlite');
  });

  it('honors XDG_CONFIG_HOME when present', () => {
    delete process.env.WPT_DB;
    process.env.XDG_CONFIG_HOME = '/tmp/my-xdg-config';
    expect(getStandardDbPath()).toBe('/tmp/my-xdg-config/wp-translator/wp-translator.sqlite');
  });

  it('resolves path for Windows platform when platform is win32', () => {
    delete process.env.WPT_DB;
    const originalPlatform = process.platform;
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      process.env.APPDATA = 'C:\\Users\\Test\\AppData\\Roaming';
      const p = getStandardDbPath();
      expect(p).toContain('wp-translator');
      expect(p).toContain('wp-translator.sqlite');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('ensures directory exists when calling resolveDbPath with standard path', () => {
    delete process.env.WPT_DB;
    process.env.XDG_CONFIG_HOME = '/tmp/wpt-test-mkdir';
    const path = resolveDbPath();
    expect(path).toBe('/tmp/wpt-test-mkdir/wp-translator/wp-translator.sqlite');
  });
});
