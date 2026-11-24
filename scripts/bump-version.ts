import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { appendFileSync } from 'node:fs';

export type BumpType = 'major' | 'minor' | 'patch';

export interface VersionInfo {
  currentVersion: string;
  bumpType: BumpType;
  nextVersion: string;
}

export function parseSemVer(ver: string): [number, number, number] {
  const clean = ver.replace(/^v/, '').split('-')[0]!;
  const parts = clean.split('.').map((p) => parseInt(p, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

export function incrementVersion(ver: string, type: BumpType): string {
  const [major, minor, patch] = parseSemVer(ver);
  if (type === 'major') {
    return `${major + 1}.0.0`;
  }
  if (type === 'minor') {
    return `${major}.${minor + 1}.0`;
  }
  return `${major}.${minor}.${patch + 1}`;
}

export function analyzeCommits(commits: string[]): BumpType {
  let hasMinor = false;

  for (const commit of commits) {
    const trimmed = commit.trim();
    if (!trimmed) continue;

    // Check breaking change
    if (/^[a-z]+(\([^)]+\))?!:/i.test(trimmed) || /BREAKING CHANGE:/i.test(trimmed)) {
      return 'major';
    }

    // Check feat
    if (/^feat(\([^)]+\))?:/i.test(trimmed)) {
      hasMinor = true;
    }
  }

  if (hasMinor) return 'minor';
  return 'patch';
}

export function getCommitsSinceLastTag(): { commits: string[]; lastTag?: string } {
  try {
    // Find latest tag
    const tag = execSync('git describe --tags --abbrev=0 2>/dev/null', { encoding: 'utf8' }).trim();
    if (tag) {
      const log = execSync(`git log ${tag}..HEAD --pretty=format:"%s%n%b"`, { encoding: 'utf8' });
      const commits = log.split('\n').filter(Boolean);
      return { commits, lastTag: tag };
    }
  } catch {}

  // Fallback: examine last 50 commits if no tag
  try {
    const log = execSync('git log -n 50 --pretty=format:"%s%n%b"', { encoding: 'utf8' });
    const commits = log.split('\n').filter(Boolean);
    return { commits };
  } catch {
    return { commits: [] };
  }
}

export function getHighestReleasedVersion(): string {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  let baseVer = pkg.version || '0.1.0';

  try {
    const allTags = execSync('git tag -l "v*"', { encoding: 'utf8' })
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean);

    let maxSemver = parseSemVer(baseVer);

    for (const tag of allTags) {
      const parsed = parseSemVer(tag);
      if (
        parsed[0] > maxSemver[0] ||
        (parsed[0] === maxSemver[0] && parsed[1] > maxSemver[1]) ||
        (parsed[0] === maxSemver[0] && parsed[1] === maxSemver[1] && parsed[2] > maxSemver[2])
      ) {
        maxSemver = parsed;
        baseVer = `${parsed[0]}.${parsed[1]}.${parsed[2]}`;
      }
    }
  } catch {}

  return baseVer;
}

export function computeNextVersion(): VersionInfo {
  const currentVersion = getHighestReleasedVersion();
  const { commits } = getCommitsSinceLastTag();
  const bumpType = commits.length > 0 ? analyzeCommits(commits) : 'patch';
  const nextVersion = incrementVersion(currentVersion, bumpType);

  return { currentVersion, bumpType, nextVersion };
}

function main() {
  const isDryRun = process.argv.includes('--dry-run');
  const info = computeNextVersion();

  console.log(`Current version: ${info.currentVersion}`);
  console.log(`Bump type      : ${info.bumpType.toUpperCase()}`);
  console.log(`Next version   : ${info.nextVersion}`);

  if (isDryRun) {
    console.log('[dry-run] package.json not modified.');
    return;
  }

  // Update package.json
  const pkgPath = 'package.json';
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.version = info.nextVersion;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log(`✓ Updated package.json version to ${info.nextVersion}`);

  // Write to GitHub Actions outputs if present
  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    appendFileSync(ghOutput, `version=${info.nextVersion}\n`);
    appendFileSync(ghOutput, `bump_type=${info.bumpType}\n`);
    appendFileSync(ghOutput, `tag_name=v${info.nextVersion}\n`);
    console.log(`✓ Written outputs to GITHUB_OUTPUT: version=${info.nextVersion}, tag_name=v${info.nextVersion}`);
  }
}

// Only execute main when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
