#!/usr/bin/env node
/**
 * oneTeam — One-Click Local Launcher
 * Starts both the Supervisor Web Dashboard and the Telegram Bot Service simultaneously.
 */

import { spawn } from 'child_process';
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

console.log(`${colors.bright}${colors.cyan}========================================================================${colors.reset}`);
console.log(`${colors.bright}${colors.cyan}         oneTeam (Coca-Cola FMCG) — BİRGƏ BAŞLATMA SKRİPTİ             ${colors.reset}`);
console.log(`${colors.bright}${colors.cyan}========================================================================${colors.reset}\n`);

// 1. Start Web Dashboard (Vite)
console.log(`${colors.bright}🚀 1. Veb İdarəetmə Paneli (Dashboard) işə salınır...${colors.reset}`);
const webProcess = spawn(
  process.execPath,
  ['./web/node_modules/vite/bin/vite.js', 'web', '--port', '5173', '--host'],
  {
    cwd: rootDir,
    stdio: 'inherit',
  }
);

// 2. Start Telegram Bot Service
console.log(`${colors.bright}🤖 2. Telegram Bot Xidməti işə salınır...${colors.reset}`);
const botProcess = spawn(
  process.execPath,
  ['./node_modules/tsx/dist/cli.mjs', 'src/bot/index.ts'],
  {
    cwd: rootDir,
    stdio: 'inherit',
  }
);

console.log(`\n${colors.bright}${colors.green}------------------------------------------------------------------------${colors.reset}`);
console.log(`${colors.bright}${colors.green}  ✅ oneTeam PLATFORMASI UĞURLA İŞƏ SALINDI!                            ${colors.reset}`);
console.log(`${colors.bright}${colors.green}------------------------------------------------------------------------${colors.reset}`);
console.log(`  🌐 Veb Portala daxil olmaq üçün brauzerdə açın:`);
console.log(`     ${colors.bright}${colors.yellow}👉 http://localhost:5173${colors.reset}\n`);
console.log(`  ⏹ Dayandırmaq üçün terminalda [Ctrl + C] basın.\n`);

// Handle graceful shutdown
const shutdown = () => {
  console.log(`\n${colors.yellow}Sistem dayandırılır...${colors.reset}`);
  webProcess.kill('SIGINT');
  botProcess.kill('SIGINT');
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
