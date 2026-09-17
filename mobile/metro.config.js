const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

console.log('Metro config using:', config.resolver.assetExts, config.resolver.sourceExts);

module.exports = config;
