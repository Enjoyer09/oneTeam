#!/usr/bin/env node
/**
 * Label association guard — the break detector for form labels.
 * ============================================================================
 *
 * THE DEFECT THIS GUARDS
 * ----------------------
 * 43 `<label>` elements existed in `web/src` and exactly ONE carried `htmlFor`.
 * 35 were plain text sitting next to a separate `<input>`/`<select>`: no
 * `htmlFor`, no control inside, so the browser had nothing to associate and
 * clicking the visible caption did nothing. The other 7 were fine — they wrap
 * their own control (the checkbox rows), which is the second legal shape.
 *
 * What that costs: a screen reader announces an unlabeled control ("edit text,
 * blank"), and a mouse user aiming at the caption gets nothing because the
 * caption is not a control. Invisible in a screenshot, obvious with a keyboard
 * or a reader — which is how it survived a 43-to-1 review.
 *
 * WHY A SOURCE-LEVEL GUARD INSTEAD OF A COMPONENT TEST
 * ----------------------------------------------------
 * Same reason as portal-silent-success: no React test runner in this repo (no
 * jsdom, no testing-library; `web/` carries its own lockfile). This reads the
 * source and asserts the contract instead — narrow and honest. It cannot prove
 * a label focuses its field in a browser; it proves no new label ships without
 * one, which is the regression that matters.
 *
 * THE FOUR RULES
 * --------------
 *  1. Every `<label>` has `htmlFor` OR wraps a labelable control. A label that
 *     does neither is an orphan — usually a section heading wearing a label.
 *     Point it at its field, or make it a `<span>` if it really is a heading.
 *     Both are accepted; being an orphan is not.
 *  2. Every `htmlFor="literal"` resolves to an `id="literal"` in the same file.
 *     A typo'd target associates nothing while looking correct.
 *  3. No duplicate `id="..."` in any file — a repeated id silently binds the
 *     label to the first match, so the second form's caption clicks the wrong
 *     field.
 *  4. No `div`/`span` with an `onClick` and no `role`/`tabIndex`/`onKeyDown`.
 *     A click handler on a non-interactive element is unreachable by keyboard;
 *     use `<button>`, which is focusable and announced for free.
 *
 * Self-checks keep the walker from passing vacuously: a scan that parsed zero
 * labels would satisfy rule 1 trivially, so the population is asserted too.
 *
 *   npm run test:labels
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(ROOT, 'web', 'src');

/** What a `<label for>` may name — the HTML labelable element set. */
const LABELABLE = /<(input|select|textarea|button|meter|output|progress)\b/;

/**
 * Elements the browser focuses natively. A `div`/`span` carrying only `onClick`
 * is mouse-only — it cannot be reached with Tab, so it does not exist for a
 * keyboard user. Three of those shipped here (a fake checkbox group), which is
 * the same invisible class of defect as the orphan labels.
 */
const CLICK_ONLY = /<(div|span)\b([^>]*)onClick/g;
const KEYBOARD_ESCAPE = /\brole\s*=|\btabIndex\s*=|\bonKeyDown\s*=/;

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

/**
 * Blank out `//` and block comments while preserving every newline, so the
 * line numbers reported in a failure stay true. Quote-aware: a `//` inside
 * `placeholder="https://…"` must not eat the rest of the line.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      if (c === '\\') {
        out += c + (src[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const start = i;
      while (i < src.length && src[i] !== '\n') i++;
      out += ' '.repeat(i - start);
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** Every `<label>` with the bits the rules need; `body` spans to its `</label>`. */
function findLabels(src) {
  const found = [];
  const open = /<label\b/g;
  let m;
  while ((m = open.exec(src))) {
    const start = m.index;
    const gt = src.indexOf('>', start);
    if (gt < 0) continue;
    if (src[gt - 1] === '/') continue; // self-closing: renders nothing to label
    const tag = src.slice(start, gt + 1);

    let body = '';
    let depth = 1;
    let i = gt + 1;
    while (depth > 0) {
      const n = /<\/?label\b/.exec(src.slice(i));
      if (!n) break;
      const at = i + n.index;
      depth += src.startsWith('</label', at) ? -1 : 1;
      i = at + n[0].length;
      if (depth === 0) body = src.slice(gt + 1, at);
    }

    const lit = /\bhtmlFor\s*=\s*"([^"]*)"/.exec(tag);
    found.push({
      line: src.slice(0, start).split('\n').length,
      body,
      hasHtmlFor: /\bhtmlFor\s*=/.test(tag),
      htmlForValue: lit ? lit[1] : null,
      htmlForDynamic: /\bhtmlFor\s*=\s*\{/.test(tag),
      wraps: LABELABLE.test(body),
    });
  }
  return found;
}

const allFiles = walk(WEB);
const files = allFiles.filter((f) => readFileSync(f, 'utf8').includes('<label'));
console.log('\nLabel association coverage (web/src)\n');

let totalLabels = 0;
let orphans = 0;
let wrapped = 0;
let resolved = 0;

for (const file of files) {
  const rel = relative(ROOT, file);
  const src = stripComments(readFileSync(file, 'utf8'));
  const ids = [...src.matchAll(/\bid\s*=\s*"([^"]*)"/g)].map((mm) => mm[1]);

  for (const label of findLabels(src)) {
    totalLabels++;
    const at = `${rel}:${label.line}`;

    if (label.wraps) {
      wrapped++;
      check(`wraps its control: ${at}`, true);
    } else if (!label.hasHtmlFor) {
      orphans++;
      check(`associated: ${at}`, false, 'label neither has htmlFor nor wraps a control');
    } else if (label.htmlForValue === null) {
      if (label.htmlForDynamic) check(`associated (dynamic htmlFor): ${at}`, true);
      else {
        orphans++;
        check(`associated: ${at}`, false, 'htmlFor is not a value');
      }
    } else if (ids.includes(label.htmlForValue)) {
      resolved++;
      check(`htmlFor resolves: ${at}`, true);
    } else {
      check(
        `htmlFor resolves: ${at}`,
        false,
        `htmlFor="${label.htmlForValue}" has no matching id in ${rel}`,
      );
    }
  }
}

// Rule 3 over every .tsx that declares an id (not only the ones with labels).
for (const file of allFiles) {
  const src = stripComments(readFileSync(file, 'utf8'));
  const ids = [...src.matchAll(/\bid\s*=\s*"([^"]*)"/g)].map((mm) => mm[1]);
  if (ids.length === 0) continue;
  const dupes = ids.filter((id, idx) => ids.indexOf(id) !== idx);
  check(
    `unique ids in ${relative(ROOT, file)}`,
    dupes.length === 0,
    `duplicate id=${JSON.stringify([...new Set(dupes)])} — the label binds to the first one only`,
  );
}

// Rule 4 over every .tsx: click handling has to be keyboard-reachable.
let clickOnly = 0;
for (const file of allFiles) {
  const src = stripComments(readFileSync(file, 'utf8'));
  const rel = relative(ROOT, file);
  CLICK_ONLY.lastIndex = 0;
  let m;
  while ((m = CLICK_ONLY.exec(src))) {
    // The opening tag ends at its first `>`; interpolated `{…}` may hold one, so
    // this is best-effort — but a `role`/`tabIndex` anywhere in that window
    // still clears the element, and a `<button>` never reaches here at all.
    const gt = src.indexOf('>', m.index);
    const tag = src.slice(m.index, gt < 0 ? src.length : gt + 1);
    if (KEYBOARD_ESCAPE.test(tag)) continue;
    clickOnly++;
    check(
      `keyboard-reachable: ${rel}:${src.slice(0, m.index).split('\n').length}`,
      false,
      `<${m[1]}> has onClick but no role/tabIndex/onKeyDown — unreachable by Tab; use <button>`,
    );
  }
}
// Rule 4 cannot assert a population of offenders — zero of them is the goal, so
// there is nothing to be vacuous about. It asserts the scan ran instead.
check(
  `rule 4 walked every component file (${allFiles.length} >= 12)`,
  allFiles.length >= 12,
  `only ${allFiles.length} .tsx files walked — the scan stopped finding files`,
);

// Anti-vacuous: a walker that parses nothing passes every rule above.
check(
  `walker found the label population (${totalLabels} >= 35)`,
  totalLabels >= 35,
  `only ${totalLabels} labels parsed — the scan is broken, not the source`,
);
check(
  `labels found across ${files.length} files (>= 5)`,
  files.length >= 5,
  `only ${files.length} files contain a label`,
);
check(
  `control-wrapping labels detected (${wrapped} >= 5)`,
  wrapped >= 5,
  `only ${wrapped} — wrapper detection stopped working`,
);

console.log(
  `\n  ${passed}/${passed + failed} checks passed  ` +
    `(labels: ${totalLabels}, orphan: ${orphans}, wrapped: ${wrapped}, ` +
    `resolved: ${resolved}, click-only: ${clickOnly})`,
);
process.exit(failed === 0 ? 0 : 1);
