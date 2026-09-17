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

module.exports = config;
