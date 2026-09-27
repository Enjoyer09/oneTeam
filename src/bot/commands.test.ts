#!/usr/bin/env node
/**
 * Tests for the published command menu (`BOT_COMMANDS`).
 * ============================================================================
 *
 * Telegram rejects `setMyCommands` for a name that is not lowercase `[a-z0-9_]`
 * of 1–32 chars, or a description outside 1–256 chars — and rejects the whole
 * batch, so one bad entry unpublishes the menu. That failure is logged and
 * swallowed at runtime (a menu is not worth crashing the bot for), which is
 * exactly why it needs catching here instead: a silently-unpublished menu looks
 * like the feature was never built.
 *
 * It also checks that every published command has a matching `bot.command(...)`
 * route, so the menu can never advertise a command the bot does not answer.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOT_COMMANDS } from './commands';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✅ [PASS] ${label}`);
  } else {
    failed++;
    console.log(`  ❌ [FAIL] ${label}`);
    if (detail) console.log(`         ${detail}`);
  }
}

console.log('BOT_COMMANDS — the published command menu\n');

const NAME_RE = /^[a-z0-9_]{1,32}$/;

check('the menu is non-empty', BOT_COMMANDS.length > 0, `length=${BOT_COMMANDS.length}`);

for (const { command, description } of BOT_COMMANDS) {
  check(
    `command "${command}" is a valid Telegram command name`,
    NAME_RE.test(command),
    `"${command}" must be lowercase [a-z0-9_], 1–32 chars`,
  );
  check(
    `command "${command}" has a 1–256 char description`,
    description.length >= 1 && description.length <= 256,
    `description length=${description.length}`,
  );
}

// No duplicate names — Telegram keeps only the last, so a duplicate silently
// drops a command from the menu.
const names = BOT_COMMANDS.map((c) => c.command);
check(
  'no duplicate command names',
  new Set(names).size === names.length,
  `names: ${JSON.stringify(names)}`,
);

// Every advertised command must be wired in the router, or the menu points at
// nothing. Checked by reading router.ts and looking for the `bot.command('x'`
// registration — coarse, but it catches the menu drifting away from the routes.
// The npm scripts run from the repo root, so the router path is resolved from
// there rather than from `import.meta.url` (which NodeNext forbids in this
// CommonJS-typed package).
const routerSrc = readFileSync(join(process.cwd(), 'src/bot/router.ts'), 'utf8');
for (const { command } of BOT_COMMANDS) {
  check(
    `command "${command}" is registered in router.ts`,
    routerSrc.includes(`bot.command('${command}'`),
    `no bot.command('${command}' found in router.ts`,
  );
}

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
