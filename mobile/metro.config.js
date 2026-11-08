const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// `mobile` is not a workspace member (root `workspaces` lists apps/* and
// packages/*), so Expo's monorepo auto-detection finds nothing:
// resolve-workspace-root returns null and the default config carries no root
// watch folder and no root node_modules path. The app imports `@oneteam/types`
// at runtime (clock/log), resolved through the root workspace symlink, so the
// root is wired in explicitly. This needs root `npm ci` + `build:packages`;
// the CI UI-test job runs both. Measured 2026-11-08: without this, Metro fails
// with "Unable to resolve '@oneteam/types'" and every UI test dies with
// "login.storeCodeInput never appeared".
const path = require('path');
const monorepoRoot = path.resolve(__dirname, '..');
config.watchFolders = [monorepoRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

// Guard: Metro 0.84.5's Bundler crashes silently in CI when
// transformerPath or transformer is missing from the config.
// This throws early with a clear message instead of the confusing
// "Cannot read properties of undefined (reading 'transformFile')"
// that surfaces minutes later as a redbox error.
if (!config.transformerPath) {
  throw new Error(
    'metro.config.js: transformerPath is not set. ' +
      'Run `cd mobile && npm ci` to reinstall dependencies.',
  );
}

// Force single-worker mode in CI. Worker threads (jest-worker) silently
// fail to initialize in the macOS CI runner, leaving `_transformer`
// undefined and producing the "transformFile" crash. This bypasses the
// worker farm entirely and uses the in-process worker instead.
config.maxWorkers = 1;

// Drop watch folders that do not exist. Metro's Transformer constructor runs
// `watchFolders.forEach(verifyRootExists)`, and `verifyRootExists` calls
// `fs.statSync(root)` — ENOENT for a missing directory. That constructor runs
// inside a promise chain whose `.catch()` only logs, so the throw is swallowed:
// `_transformer` is never assigned and every later bundle request dies with the
// opaque "Cannot read properties of undefined (reading 'transformFile')".
// The explicit root above exists in any checkout, so this is a guard for
// unusual layouts rather than part of normal operation.
const fs = require('fs');

const missingWatchFolders = config.watchFolders.filter((folder) => !fs.existsSync(folder));

if (missingWatchFolders.length > 0) {
  console.warn(
    `[metro.config.js] Mövcud olmayan ${missingWatchFolders.length} watch qovluğu siyahıdan çıxarıldı:\n` +
      missingWatchFolders.map((f) => `  - ${f}`).join('\n'),
  );
  config.watchFolders = config.watchFolders.filter((folder) => fs.existsSync(folder));
}

module.exports = config;
