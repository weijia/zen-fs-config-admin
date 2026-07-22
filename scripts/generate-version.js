/**
 * Generate version.json before build.
 * Reads git info and current time, writes to src/version.json.
 * Works both locally and in CI.
 */
import { execSync } from 'child_process';
import { writeFileSync, readFileSync } from 'fs';

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function readPkgVersion(name) {
  try {
    const json = JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf-8'));
    return json.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

const sha = run('git rev-parse --short HEAD') || 'unknown';
const branch = run('git rev-parse --abbrev-ref HEAD') || 'unknown';
const tag = run('git describe --tags --exact-match 2>/dev/null') || '';

const version = tag || `${branch}-${sha}`;
const buildTime = new Date().toLocaleString('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const payload = {
  version, buildTime, sha, branch, tag,
  deps: {
    'zen-fs-config': readPkgVersion('zen-fs-config'),
    'zen-fs-sync': readPkgVersion('zen-fs-sync'),
    'zen-fs-remotestoragejs': readPkgVersion('zen-fs-remotestoragejs'),
    'zen-fs-cache': readPkgVersion('zen-fs-cache'),
    '@zenfs/core': readPkgVersion('@zenfs/core'),
    '@zenfs/dom': readPkgVersion('@zenfs/dom'),
  },
};

writeFileSync(
  new URL('../src/version.json', import.meta.url),
  JSON.stringify(payload, null, 2) + '\n'
);

console.log('Generated version.json:', payload);
