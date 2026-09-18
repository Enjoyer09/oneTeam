const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

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

// Drop watch folders that do not exist.
//
// THIS IS THE ROOT CAUSE OF THE CI CRASH. Metro's Transformer constructor
// runs `watchFolders.forEach(verifyRootExists)`, and `verifyRootExists`
// calls `fs.statSync(root)` — which throws ENOENT for a missing directory.
// That constructor runs inside a promise chain whose `.catch()` only logs,
// so the throw is swallowed: `_transformer` is never assigned, and every
// later bundle request dies with the opaque
// "Cannot read properties of undefined (reading 'transformFile')".
//
// Expo's monorepo detection adds the *repository root's* node_modules to
// watchFolders. The UI-test job installs `mobile/` only — root `npm ci`
// never runs — so that folder is absent on CI and present locally. Hence
// a crash that reproduces on CI and never on a developer's machine.
//
// Dropping it is safe: the app's runtime dependencies all live in
// `mobile/node_modules`, and its only cross-package import
// (`@oneteam/types`) is `import type`, erased before the bundle is built.
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
