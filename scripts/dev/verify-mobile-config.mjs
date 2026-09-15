#!/usr/bin/env node
/**
 * Verifies `mobile/app.json` and `mobile/package.json` against what
 * `npx expo prebuild --platform ios` actually needs.
 *
 * WHY THIS EXISTS
 * ---------------
 * The acceptance criterion for plan item 3.1 is "`npx expo prebuild --platform
 * ios` creates `ios/` with no error". That command needs a ~470-package
 * dependency tree, and the environment where this was written refuses to
 * install one, so the command itself could not be run. Rather than assert that
 * the config is correct and move on, this script checks the parts of that
 * criterion that do not need the toolchain:
 *
 *   - the config parses and carries every key the plan names;
 *   - each config plugin the plan names is present AND has its package declared
 *     in `package.json` — a plugin with no package is a prebuild failure;
 *   - every asset the config points at exists;
 *   - the icon is square and has no alpha channel, and the splash mark is
 *     square, because iOS rejects an app icon that is either;
 *   - the permission strings that iOS shows to the user are non-empty;
 *   - the one file excluded from `mobile/tsconfig.json` is the only file that
 *     needs to be, so the exclusion cannot quietly widen;
 *   - the app entry still wires the keychain into the credential store and still
 *     restores the credential at startup — two things nothing else would notice,
 *     because the entry is outside the type-check.
 *
 * It is a substitute for the parts it can reach, not for the whole thing. It
 * cannot tell you that prebuild succeeds; it tells you that nothing obvious in
 * the config is going to make it fail.
 *
 * USAGE
 * -----
 *     node scripts/dev/verify-mobile-config.mjs
 *
 * Exits non-zero if any check fails, so it can gate a commit.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOBILE = join(REPO_ROOT, 'mobile');

let failures = 0;

function check(label, passed, detail = '') {
  console.log(`  ${passed ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!passed) failures++;
}

/**
 * Reads a PNG's IHDR chunk.
 *
 * A PNG starts with an 8-byte signature, then a chunk header of 4-byte length +
 * 4-byte type, so the IHDR payload always begins at byte 16. Width and height
 * are the first two big-endian uint32s; the colour type follows at byte 25.
 * Colour type 6 is RGBA, 2 is RGB, 0 is greyscale, 3 is palette.
 *
 * Parsed by hand rather than with an image library because this script is part
 * of the quality gate and the gate must not need an install to run.
 */
function readPngHeader(file) {
  const buffer = readFileSync(file);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buffer.subarray(0, 8).equals(signature)) return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    colourType: buffer[25],
    hasAlpha: buffer[25] === 4 || buffer[25] === 6,
  };
}

/**
 * Reads a tsconfig, which is JSON with comments.
 *
 * `tsc` and Prettier both accept `//` in a tsconfig, and the `exclude` in this
 * repo's mobile config is explained with them, so a bare `JSON.parse` is not
 * enough. Only WHOLE-LINE comments are stripped. That is all this repo's
 * configs use, and it cannot corrupt a string that happens to contain `//` —
 * a URL, a path, a glob.
 */
function readTsconfig(file) {
  const stripped = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
  return JSON.parse(stripped);
}

/** Every file under `dir`, recursively. Used to count importers. */
function listFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(full));
    else found.push(full);
  }
  return found;
}

// ---------------------------------------------------------------------------

const appJsonPath = join(MOBILE, 'app.json');
const pkgPath = join(MOBILE, 'package.json');

console.log('mobile/app.json and mobile/package.json\n');

check('mobile/app.json exists', existsSync(appJsonPath));
check('mobile/package.json exists', existsSync(pkgPath));
if (!existsSync(appJsonPath) || !existsSync(pkgPath)) {
  console.log('\nCannot continue without both files.');
  process.exit(1);
}

const app = JSON.parse(readFileSync(appJsonPath, 'utf8')).expo;
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

console.log('\nIdentity');
check('name is set', typeof app.name === 'string' && app.name.length > 0, app.name);
check('slug is set', typeof app.slug === 'string' && app.slug.length > 0, app.slug);
check('version is set', typeof app.version === 'string' && app.version.length > 0, app.version);

console.log('\niOS');
check(
  'ios.bundleIdentifier is set',
  typeof app.ios?.bundleIdentifier === 'string' && app.ios.bundleIdentifier.includes('.'),
  app.ios?.bundleIdentifier,
);
check(
  'ios.supportsTablet is false',
  app.ios?.supportsTablet === false,
  `plan item 3.1 requires false; found ${String(app.ios?.supportsTablet)}`,
);

console.log('\nPrivacy strings (what iOS shows the user)');
for (const key of ['NSCameraUsageDescription', 'NSLocationWhenInUseUsageDescription']) {
  const value = app.ios?.infoPlist?.[key];
  check(key, typeof value === 'string' && value.trim().length > 10, value ?? '<missing>');
}

console.log('\nConfig plugins');
const pluginNames = (app.plugins ?? []).map((entry) => (Array.isArray(entry) ? entry[0] : entry));
for (const name of ['expo-camera', 'expo-location', 'expo-secure-store']) {
  check(`plugin "${name}" is listed`, pluginNames.includes(name));
  check(
    `package "${name}" is a dependency`,
    Boolean(pkg.dependencies?.[name]),
    pkg.dependencies?.[name] ?? '<not declared — prebuild will fail>',
  );
}

console.log('\nAssets');
const assetRefs = [
  { label: 'icon', ref: app.icon, mustBeOpaque: true },
  ...(app.plugins ?? [])
    .filter((entry) => Array.isArray(entry) && entry[1]?.image)
    .map((entry) => ({
      label: `plugin ${entry[0]} image`,
      ref: entry[1].image,
      mustBeOpaque: false,
    })),
];

for (const { label, ref, mustBeOpaque } of assetRefs) {
  if (typeof ref !== 'string') {
    check(`${label} is configured`, false, '<missing>');
    continue;
  }
  const file = join(MOBILE, ref.replace(/^\.\//, ''));
  if (!existsSync(file)) {
    check(`${label} (${ref}) exists`, false, '<file not found>');
    continue;
  }
  const header = readPngHeader(file);
  if (!header) {
    check(`${label} (${ref}) is a PNG`, false, '<not a PNG, or unreadable>');
    continue;
  }
  check(
    `${label} (${ref}) is square`,
    header.width === header.height,
    `${header.width}x${header.height}`,
  );
  if (mustBeOpaque) {
    // iOS masks the app icon itself and rejects one that carries transparency.
    check(
      `${label} has no alpha channel`,
      !header.hasAlpha,
      header.hasAlpha ? `colour type ${header.colourType} (alpha present)` : 'RGB',
    );
  }
}

console.log('\nExpo runtime dependencies');
for (const name of ['expo', 'react', 'react-native']) {
  check(
    `${name} is a dependency`,
    Boolean(pkg.dependencies?.[name]),
    pkg.dependencies?.[name] ?? '',
  );
}

console.log('\nEntry point');
check('main is declared', typeof pkg.main === 'string', pkg.main ?? '<missing>');
if (typeof pkg.main === 'string') {
  const entry = join(MOBILE, pkg.main);
  check(`main (${pkg.main}) exists`, existsSync(entry));
}

// ---------------------------------------------------------------------------
// What the type-check actually sees.
//
// `keychain.ts` is excluded from `mobile/tsconfig.json`, because it imports
// `expo-secure-store` and the package cannot be installed here. An exclusion is
// only honest while it covers exactly the files it claims to and no more, and
// nothing else in the repo would notice if that stopped being true — a second
// file importing the same package would simply be reported as a missing module
// by `mobile:check`, which reads like an install problem rather than a scope
// problem. These checks make the exclusion say what it means.
// ---------------------------------------------------------------------------
console.log('\nType-check coverage');
const tsconfigPath = join(MOBILE, 'tsconfig.json');
check('mobile/tsconfig.json exists', existsSync(tsconfigPath));
if (existsSync(tsconfigPath)) {
  const tsconfig = readTsconfig(tsconfigPath);
  const excluded = tsconfig.exclude ?? [];
  check(
    'keychain.ts is excluded from the type-check (expo-secure-store is not installed)',
    excluded.includes('src/services/keychain.ts'),
    excluded.join(', ') || '<nothing excluded>',
  );

  const nativeImporters = listFiles(join(MOBILE, 'src'))
    .filter((file) => /from\s+['"]expo-secure-store['"]/.test(readFileSync(file, 'utf8')))
    .map((file) => relative(MOBILE, file).split(sep).join('/'));

  check(
    'exactly one file under src/ imports expo-secure-store, and it is the excluded one',
    nativeImporters.length === 1 && nativeImporters[0] === 'src/services/keychain.ts',
    nativeImporters.join(', ') || '<no file imports it — remove the exclusion>',
  );
}

// ---------------------------------------------------------------------------
// The startup wiring.
//
// `mobile/Root.tsx` is outside the type-check for the same reason `keychain.ts`
// is — it imports `react-native` — so nothing else in this repo would notice if
// the keychain stopped being connected to the credential store. The failure that
// would cause is quiet and expensive: the store falls back to its in-memory
// default, the app still works, and it re-enrols on every launch, spending the
// store's new-device allowance each time. So the wiring is asserted here.
// ---------------------------------------------------------------------------
console.log('\nStartup wiring');
const rootPath = join(MOBILE, 'Root.tsx');
check('mobile/Root.tsx exists', existsSync(rootPath));
if (existsSync(rootPath)) {
  const root = readFileSync(rootPath, 'utf8');
  check(
    'Root.tsx points the credential store at the keychain',
    /credentialStore\.useStorage\(\s*keychainStore\s*\)/.test(root),
    'without this the store stays memory-only and the device re-enrols every launch',
  );
  check(
    'Root.tsx restores the credential before anything can call the API',
    /initializeCredentials\(\)/.test(root),
    'without this deviceId() throws and every API call fails',
  );
}

console.log(failures === 0 ? '\nAll config checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
