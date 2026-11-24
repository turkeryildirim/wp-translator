import { describe, expect, it } from 'vitest';
import { analyzeCommits, incrementVersion, parseSemVer } from '../scripts/bump-version.ts';

describe('SemVer parsing and incrementing', () => {
  it('parses semver versions correctly', () => {
    expect(parseSemVer('0.1.0')).toEqual([0, 1, 0]);
    expect(parseSemVer('v1.2.3')).toEqual([1, 2, 3]);
    expect(parseSemVer('v0.1.0-build.6')).toEqual([0, 1, 0]);
    expect(parseSemVer('2.0.0-beta.1')).toEqual([2, 0, 0]);
  });

  it('increments patch version', () => {
    expect(incrementVersion('0.1.0', 'patch')).toBe('0.1.1');
    expect(incrementVersion('1.2.9', 'patch')).toBe('1.2.10');
  });

  it('increments minor version and resets patch', () => {
    expect(incrementVersion('0.1.5', 'minor')).toBe('0.2.0');
    expect(incrementVersion('1.0.0', 'minor')).toBe('1.1.0');
  });

  it('increments major version and resets minor and patch', () => {
    expect(incrementVersion('0.2.5', 'major')).toBe('1.0.0');
    expect(incrementVersion('1.5.3', 'major')).toBe('2.0.0');
  });
});

describe('Conventional Commit analysis', () => {
  it('detects patch when only fix commits exist', () => {
    const commits = [
      'fix(queue): resolve false-positive rejections',
      'fix(wporg): decode numeric HTML entities',
    ];
    expect(analyzeCommits(commits)).toBe('patch');
  });

  it('detects minor when at least one feat commit exists', () => {
    const commits = [
      'fix(queue): resolve false-positive rejections',
      'feat: add plural scope support to multi-project find and replace',
      'fix(wporg): decode numeric HTML entities',
    ];
    expect(analyzeCommits(commits)).toBe('minor');
  });

  it('detects major when breaking change exists', () => {
    const commitsWithExclamation = [
      'feat!: redesign entire translation engine',
      'fix: minor typo',
    ];
    expect(analyzeCommits(commitsWithExclamation)).toBe('major');

    const commitsWithFooter = [
      'feat: new engine\n\nBREAKING CHANGE: changes database layout',
    ];
    expect(analyzeCommits(commitsWithFooter)).toBe('major');
  });

  it('defaults to patch for chore or doc commits', () => {
    const commits = ['chore: update dependencies', 'docs: update README'];
    expect(analyzeCommits(commits)).toBe('patch');
  });
});
