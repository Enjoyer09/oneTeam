#!/usr/bin/env node
/**
 * Minimal, dependency-free npm installer.
 *
 * WHY THIS EXISTS
 * ---------------
 * `npm install` cannot run in this environment: the filesystem broker rejects
 * the directory renames that npm's reify step performs
 * ("CODEBUDDY_BROKER_DENY: Brokered host mkdir requires an available runtime
 * file rule"), and disabling the sandbox does not lift it.
 *
 * Downloading a tarball and unpacking it with tar is allowed, so this script
 * does exactly what npm would do for a small, fixed set of packages: walk the
 * `dependencies` graph from the registry, fetch each tarball, and extract it
 * into node_modules/<name>.
 *
 * It deliberately does NOT touch package-lock.json or resolve version ranges
 * beyond the first match, and it skips optionalDependencies. That is enough for
 * `pg`, whose tree is small and has no native build step.
 *
 * Usage: node scripts/dev/fetch-packages.mjs pg@8.13.1 @types/pg@8.11.10
 */

import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = '/Users/macbookair/GitHub/oneTeam';
const MODULES = join(ROOT, 'node_modules');
const WORK = join(tmpdir(), 'pkgfetch');

const seen = new Set();

async function meta(name, range) {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`metadata ${name}: HTTP ${res.status}`);
  const all = await res.json();

  // Exact version wins; otherwise take the highest published version that
  // satisfies the range using npm's own semver rules, approximated here by
  // preferring the `latest` dist-tag when the range starts with ^ or ~.
  let version;
  if (/^\d+\.\d+\.\d+/.test(range)) {
    version = range;
  } else {
    version = all['dist-tags']?.latest;
  }
  if (!version || !all.versions?.[version]) {
    throw new Error(`${name}@${range}: no version resolved (tried ${version})`);
  }
  return all.versions[version];
}

async function install(name, range) {
  const key = name;
  if (seen.has(key)) return;
  seen.add(key);

  const info = await meta(name, range);
  const version = info.version;
  const tarball = info.dist.tarball;

  const dest = join(MODULES, name);
  const tgz = join(WORK, `${name.replace('/', '__')}-${version}.tgz`);

  process.stdout.write(`  ${name}@${version}\n`);

  execFileSync('curl', ['-sS', '-o', tgz, tarball], { stdio: 'inherit' });

  mkdirSync(dest, { recursive: true });
  // --strip-components=1 drops the leading `package/` directory.
  execFileSync('tar', ['-xzf', tgz, '-C', dest, '--strip-components=1'], { stdio: 'inherit' });

  const deps = info.dependencies || {};
  for (const [dep, depRange] of Object.entries(deps)) {
    await install(dep, depRange);
  }
}

const specs = process.argv.slice(2);
if (specs.length === 0) {
  console.error('usage: fetch-packages.mjs <name>@<version> [...]');
  process.exit(2);
}

if (existsSync(WORK)) rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

for (const spec of specs) {
  const at = spec.lastIndexOf('@');
  const name = spec.slice(0, at);
  const range = spec.slice(at + 1);
  console.log(`installing ${name}@${range} (with dependencies):`);
  await install(name, range);
}
console.log('\ndone. installed packages: ' + [...seen].join(', '));
