#!/usr/bin/env node
/**
 * oneTeam — One-Click Local Launcher
 * Starts both the Supervisor Web Dashboard and the Telegram Bot Service simultaneously.
 */

import { spawn, spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

console.log(
  `${colors.bright}${colors.cyan}========================================================================${colors.reset}`,
);
console.log(
  `${colors.bright}${colors.cyan}         oneTeam (oneTeam Retail FMCG) — BİRGƏ BAŞLATMA SKRİPTİ             ${colors.reset}`,
);
console.log(
  `${colors.bright}${colors.cyan}========================================================================${colors.reset}\n`,
);

// 1. Build and start the Core API
//
// The API is the only thing that talks to the database. Without it the panel
// and the bot have nothing to read, and this launcher used to start only those
// two — so "npm start" produced a dashboard showing no data and a bot that
// could not find a single store, with nothing in the output saying why.
//
// It is compiled rather than run through tsx on purpose: the API is a NestJS
// app, and tsx transpiles with esbuild, which does not emit decorator metadata.
// Without it Nest cannot see constructor parameter types and injects nothing,
// so every controller receives `undefined` for its services and the first
// request fails with "Cannot read properties of undefined". `tsc` emits the
// metadata, which is also why production runs the compiled output.
console.log(`${colors.bright}⚡ 1. Core API (NestJS) yığılır və işə salınır...${colors.reset}`);
const buildResult = spawnSync(
  process.execPath,
  ['./node_modules/typescript/bin/tsc', '--build', 'apps/api/tsconfig.json'],
  { cwd: rootDir, stdio: 'inherit' },
);

if (buildResult.status !== 0) {
  console.error(
    `\n${colors.red}❌ API yığıla bilmədi. Yuxarıdaki xətaları düzəldin və yenidən cəhd edin.${colors.reset}\n`,
  );
  process.exit(1);
}

const apiProcess = spawn(process.execPath, ['apps/api/dist/main.js'], {
  cwd: rootDir,
  stdio: 'inherit',
});

// 2. Start Web Dashboard (Vite)
console.log(`${colors.bright}🚀 2. Veb İdarəetmə Paneli (Dashboard) işə salınır...${colors.reset}`);
const webProcess = spawn(
  process.execPath,
  ['./web/node_modules/vite/bin/vite.js', 'web', '--port', '5173', '--host'],
  {
    cwd: rootDir,
    stdio: 'inherit',
  },
);

// 3. Start Telegram Bot Service
console.log(`${colors.bright}🤖 3. Telegram Bot Xidməti işə salınır...${colors.reset}`);
const botProcess = spawn(
  process.execPath,
  ['./node_modules/tsx/dist/cli.mjs', 'src/bot/index.ts'],
  {
    cwd: rootDir,
    stdio: 'inherit',
  },
);

console.log(
  `\n${colors.bright}${colors.green}------------------------------------------------------------------------${colors.reset}`,
);
console.log(
  `${colors.bright}${colors.green}  ✅ oneTeam PLATFORMASI UĞURLA İŞƏ SALINDI!                            ${colors.reset}`,
);
console.log(
  `${colors.bright}${colors.green}------------------------------------------------------------------------${colors.reset}`,
);
console.log(
  `  ⚡ Core API:            ${colors.bright}http://localhost:3001/api/health${colors.reset}`,
);
console.log(`  🌐 Veb Portala daxil olmaq üçün brauzerdə açın:`);
console.log(`     ${colors.bright}${colors.yellow}👉 http://localhost:5173${colors.reset}\n`);
console.log(`  ⏹ Dayandırmaq üçün terminalda [Ctrl + C] basın.\n`);

// Handle graceful shutdown
const shutdown = () => {
  console.log(`\n${colors.yellow}Sistem dayandırılır...${colors.reset}`);
  apiProcess.kill('SIGINT');
  webProcess.kill('SIGINT');
  botProcess.kill('SIGINT');
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
