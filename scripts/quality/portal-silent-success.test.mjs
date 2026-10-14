#!/usr/bin/env node
/**
 * Portal "silent success" guard — the break detector for the fixed handlers.
 * ============================================================================
 *
 * THE DEFECT THIS GUARDS
 * ----------------------
 * `App.runAction` swallowed write failures: it showed a toast and returned
 * `void`. Its callers therefore could not tell success from failure, and each
 * one destroyed the user's work on the assumption it had succeeded:
 *
 *   - `TaskManager.handleSubmit` closed the modal and called `setTitle('')` /
 *     `setDescription('')` — a briefing written over several minutes was wiped
 *     because the server returned 500.
 *   - `handleBulkSubmit` closed its modal and lost every filter selection.
 *   - `AuditReviewCenter` advanced the review modal on a failed approve, and on a
 *     failed reject it also cleared `rejectFeedback` — the rejection reason the
 *     supervisor had just typed.
 *
 * All of them are "the UI told the user it worked when it did not", which is
 * worse than an error message: the user acts on the false success.
 *
 * WHY A SOURCE-LEVEL GUARD INSTEAD OF A COMPONENT TEST
 * ---------------------------------------------------
 * Component tests now cover the visible behaviour. This guard additionally
 * asserts the *contract* those three handlers depend on — that `runAction`
 * returns a boolean, and that each handler gates its destructive work on that
 * boolean being `true`.
 *
 * It is a specification test alongside behavioural coverage. It helps ensure nobody silently
 * restores the old shape, which is the regression that matters here.
 *
 *   npm run test:portal-silent-success
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(ROOT, 'web', 'src');

const app = readFileSync(join(WEB, 'App.tsx'), 'utf8');
const audit = readFileSync(join(WEB, 'components', 'AuditReviewCenter.tsx'), 'utf8');
const tasks = readFileSync(join(WEB, 'components', 'TaskManager.tsx'), 'utf8');

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✅ [PASS] ${label}`);
  } else {
    failed++;
    console.log(`  ❌ [FAIL] ${label}`);
    if (detail) console.log(`         ${detail}`);
  }
}

/** The body of a function, from its declaration to its matching closing brace. */
function bodyOf(source, signature) {
  const start = source.indexOf(signature);
  if (start === -1) return '';
  const open = source.indexOf('{', start);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return '';
}

console.log('portal silent-success guard\n');

// --- 1. The contract itself -------------------------------------------------
const runAction = bodyOf(app, 'const runAction = async');
check('runAction exists', runAction.length > 0);
check(
  'runAction returns a boolean (the contract callers depend on)',
  /return true/.test(runAction) && /return false/.test(runAction),
  'both the success and the failure path must return an explicit verdict',
);
check(
  'the auth-failure path returns too, instead of falling through',
  /isAuthFailure[\s\S]*?return false/.test(runAction),
);

// --- 2. TaskManager: no work destroyed without a verdict ---------------------
const create = bodyOf(tasks, 'const handleSubmit = async');
const bulk = bodyOf(tasks, 'const handleBulkSubmit = async');

check('handleSubmit exists', create.length > 0);
check('handleSubmit gates its reset on a verdict', /if \(ok\)/.test(create), create.slice(0, 200));
check(
  'handleSubmit clears the title only inside that gate',
  /if \(ok\)[\s\S]*?setTitle\(''\)/.test(create),
);
check(
  'handleSubmit closes the modal only inside that gate',
  /if \(ok\)[\s\S]*?setIsCreateModalOpen\(false\)/.test(create),
);
check('handleBulkSubmit exists', bulk.length > 0);
check(
  'handleBulkSubmit closes its modal only on success',
  /if \(ok\)[\s\S]*?setIsBulkModalOpen\(false\)/.test(bulk),
);
check(
  'neither handler catches and hides its own error',
  !/catch/.test(create) && !/catch/.test(bulk),
  'a swallowed error is exactly what produced the false success',
);

// --- 3. AuditReviewCenter: the decision modal must survive a failure ---------
for (const [name, signature] of [
  ['handleApproveClick', 'const handleApproveClick = async'],
  ['handleRejectSubmit', 'const handleRejectSubmit = async'],
]) {
  const body = bodyOf(audit, signature);
  check(`${name} exists`, body.length > 0);
  check(
    `${name} advances or closes the review modal only on success`,
    /if \(ok\)[\s\S]*?setSelectedSubmission\((?:null|nextPending\(id\))\)/.test(body),
    body.slice(0, 260),
  );
}

const reject = bodyOf(audit, 'const handleRejectSubmit = async');
check(
  'a failed rejection keeps the typed reason',
  /if \(ok\)[\s\S]*?setRejectFeedback\(''\)/.test(reject),
  'clearing this on failure makes the supervisor retype a paragraph',
);

// --- 4. Prop types declare the contract, so the compiler enforces it ---------
check(
  'AuditReviewCenter props are typed Promise<boolean>',
  /onApprove: \(id: string\) => Promise<boolean>/.test(audit) &&
    /onReject: \(id: string, feedback: string\) => Promise<boolean>/.test(audit),
);
check(
  'TaskManager props are typed Promise<boolean>',
  /onCreateTask: \(taskData: \{[\s\S]*?\) => Promise<boolean>/.test(tasks) &&
    /onBulkDispatch\?: \(data: \{[\s\S]*?\) => Promise<boolean>/.test(tasks),
);

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
