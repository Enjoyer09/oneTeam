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
 *   - native storage packages are installed and no source files are excluded
 *     from the mobile type-check;
 *   - the build-time variables Expo actually substitutes are read the only way
 *     Metro substitutes them (a direct `process.env.EXPO_PUBLIC_*` member
 *     expression), and that no credential has been given a public name;
 *   - the app entry still wires the keychain into the credential store, wires
 *     AsyncStorage into the offline queue, and restores both at startup — four
 *     things nothing else would notice, because the entry is outside the
 *     type-check.
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

/**
 * Drops comment-only lines, so a scan looks at code rather than prose.
 *
 * Needed because the modules here EXPLAIN the failure they guard against — the
 * header of `portalApi.ts` names `process.env[name]` while saying why it must not
 * be used, and a raw text scan counted that sentence as a violation. The first
 * run of this check failed on its own documentation, which is the same mistake
 * the break-detector harness made in plan item 3.2: a marker satisfied by a
 * comment proves nothing about the code.
 *
 * Whole-line only: a JSDoc block's every line begins with `*`, and a `//`
 * comment begins with `//`. A TRAILING comment on a line of code is still
 * scanned, which is the safe direction — it can produce a loud false failure,
 * never a silent pass.
 */
function codeLines(text) {
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*'));
    })
    .join('\n');
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
// WHY THIS IS CHECKED — measured on 2026-09-18. Without a team id the app
// builds for the simulator but NOT for a physical iPhone:
//   error: Signing for "oneTeamFieldAudit" requires a development team.
// The fix is not "pick a team in Xcode", because `ios/` is generated and
// prebuild overwrites the project file — the choice made by hand disappears.
// `appleTeamId` is the source of truth that prebuild writes into
// DEVELOPMENT_TEAM, so losing it silently costs a build and reads as an
// Xcode problem rather than a config problem.
check(
  'ios.appleTeamId is set (physical-device builds need it)',
  typeof app.ios?.appleTeamId === 'string' && /^[A-Z0-9]{10}$/.test(app.ios.appleTeamId),
  `a physical-device build fails without it; found ${String(app.ios?.appleTeamId ?? '<missing>')}`,
);

console.log('\nPrivacy strings (what iOS shows the user)');
// `NSLocalNetworkUsageDescription` is the one that is easy to miss: without it
// iOS 14+ silently refuses the LAN connection the app needs to reach the Core
// API and Metro from a phone, and the app looks like it simply cannot load.
for (const key of [
  'NSCameraUsageDescription',
  'NSLocationWhenInUseUsageDescription',
  'NSLocalNetworkUsageDescription',
]) {
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
// Native dependencies are installed in the mobile workspace. Keep the complete
// application source in the type-check so screens and native adapters are
// checked against the real package APIs.
// ---------------------------------------------------------------------------
console.log('\nType-check coverage');

const NATIVE_PACKAGES = ['expo-secure-store', '@react-native-async-storage/async-storage'];

const tsconfigPath = join(MOBILE, 'tsconfig.json');
check('mobile/tsconfig.json exists', existsSync(tsconfigPath));
if (existsSync(tsconfigPath)) {
  const tsconfig = readTsconfig(tsconfigPath);
  const excluded = tsconfig.exclude ?? [];

  check(
    'no mobile source is excluded from the type-check',
    excluded.length === 0,
    excluded.join(', ') || 'all source files are checked',
  );
  for (const packageName of NATIVE_PACKAGES) {
    check(
      `${packageName} is installed for native type checking`,
      Boolean(pkg.dependencies?.[packageName]) &&
        existsSync(join(MOBILE, 'node_modules', packageName)),
      pkg.dependencies?.[packageName] ?? '<not declared>',
    );
  }
}

// ---------------------------------------------------------------------------
// The build-time variables.
//
// Expo/Metro substitutes `process.env.EXPO_PUBLIC_*` and nothing else, and it
// does so by matching the LITERAL SOURCE TEXT of a direct member expression.
// Two failure modes follow, both measured in plan item 3.1:
//
//   - `process.env[name]` and reads through a `const env = process.env` alias
//     are not substituted, so the value is `undefined` on the device and the API
//     address falls back to `http://localhost:3001` — silently;
//   - anything given an `EXPO_PUBLIC_` name is compiled into the downloadable
//     bundle and can be extracted from it.
//
// Neither shows up as a test failure or a build error. So both are asserted.
// ---------------------------------------------------------------------------
console.log('\nBuild-time variables');

const variableScanTargets = [
  ...listFiles(join(MOBILE, 'src')),
  join(MOBILE, 'Root.tsx'),
  join(MOBILE, 'index.ts'),
].filter((file) => existsSync(file));

const publicNames = new Set();
const computedKeyUsers = [];
for (const file of variableScanTargets) {
  const code = codeLines(readFileSync(file, 'utf8'));
  for (const match of code.matchAll(/process\.env\.(EXPO_PUBLIC_[A-Z0-9_]+)/g)) {
    publicNames.add(match[1]);
  }
  if (/process\.env\[/.test(code)) {
    computedKeyUsers.push(relative(MOBILE, file).split(sep).join('/'));
  }
}

check(
  'the API address is read as a direct process.env.EXPO_PUBLIC_ONETEAM_API_URL member expression',
  publicNames.has('EXPO_PUBLIC_ONETEAM_API_URL'),
  'without the direct expression Metro does not substitute it and the address falls back to localhost',
);

check(
  'no computed process.env[key] access is used for a build-time variable',
  computedKeyUsers.length === 0,
  computedKeyUsers.join(', ') || 'none',
);

// The allow-list is exactly one entry, and it is not a credential. A device
// token or the enrolment secret given a public name would ship inside the IPA.
const allowedPublicNames = new Set(['EXPO_PUBLIC_ONETEAM_API_URL']);
const forbidden = [...publicNames].filter((name) => !allowedPublicNames.has(name));
check(
  'no credential has a public (EXPO_PUBLIC_) name',
  forbidden.length === 0,
  forbidden.length > 0
    ? `these would be compiled into the bundle: ${forbidden.join(', ')}`
    : [...publicNames].join(', '),
);

// ---------------------------------------------------------------------------
// The startup wiring.
//
// `mobile/Root.tsx` is outside the type-check for the same reason the two
// excluded service files are — it imports `react-native` — so nothing else in
// this repo would notice if either storage stopped being connected. Both
// failures are quiet and expensive: the credential store falls back to memory
// and spends the store's new-device allowance on every launch, and the queue
// falls back to memory so a captured audit dies with the app. So both wirings
// are asserted.
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
  check(
    'Root.tsx points the offline queue at AsyncStorage',
    /offlineQueueService\.useStorage\(\s*asyncStorageQueue\s*\)/.test(root),
    'without this the queue stays memory-only and a captured audit dies with the app',
  );
  check(
    'Root.tsx reads the queue back before anything can enqueue',
    /initializeQueue\(\)/.test(root),
    'without this getQueue() refuses, and an enqueue could overwrite what is on disk',
  );
}

// ---------------------------------------------------------------------------
// `@oneteam/types` must resolve to SOURCE, not to a build artefact.
//
// This is the defect CI found the first time it was allowed to run at all. The
// import resolved through `node_modules/@oneteam/types` — a symlink to
// `packages/types` — whose `types` field points at `./dist/index.d.ts`, and
// `packages/*/dist/` is GITIGNORED. So the mobile type check silently required a
// build step that CI never performs: it passed on every machine where `dist/`
// happened to exist from an earlier build, and failed on the first clean
// checkout with `Cannot find module '@oneteam/types'`.
//
// A guard is warranted rather than a comment because the failure is INVISIBLE
// locally: removing this mapping turns the check red only on a clean checkout,
// which is the one place nobody is looking when they remove it.
// ---------------------------------------------------------------------------
console.log('\nShared types resolution');
const mobileTsconfigPath = join(MOBILE, 'tsconfig.json');
check('mobile/tsconfig.json exists', existsSync(mobileTsconfigPath));
if (existsSync(mobileTsconfigPath)) {
  const tsconfig = readFileSync(mobileTsconfigPath, 'utf8');
  check(
    'mobile/tsconfig.json maps @oneteam/types to packages/types/src',
    /"@oneteam\/types"\s*:\s*\[\s*"\.\.\/packages\/types\/src"\s*\]/.test(tsconfig),
    'without this the import resolves to a GITIGNORED dist/, so the check passes only where somebody has built',
  );
  check(
    'and sets baseUrl, which `paths` is resolved against',
    /"baseUrl"\s*:\s*"\."/.test(tsconfig),
    '`paths` entries are relative to baseUrl',
  );
}

// `mobile` is not a workspace member (it has its own lockfile and is installed
// separately), so `@oneteam/types` is NOT in its dependencies — it resolves only
// because `mobile/` happens to sit inside the monorepo. The import is therefore
// kept type-only so the bundler erases it, instead of emitting a runtime
// `require` for a package the app cannot install on its own.
const mobileTypesPath = join(MOBILE, 'src/types/index.ts');
check('mobile/src/types/index.ts exists', existsSync(mobileTypesPath));
if (existsSync(mobileTypesPath)) {
  const mobileTypes = readFileSync(mobileTypesPath, 'utf8');
  check(
    'the @oneteam/types import is type-only, so it is erased at bundle time',
    /import\s+type\s*\{[^}]*\}\s*from\s*'@oneteam\/types'/.test(mobileTypes),
    'a value import emits a runtime require for a package mobile does not depend on',
  );
}

console.log(failures === 0 ? '\nAll config checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
