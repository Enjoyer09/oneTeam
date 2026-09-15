#!/usr/bin/env node
/**
 * oneTeam — pre-commit secret scanner.
 * ============================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * A review of this repository found a real SSH *private* key
 * (`.ssh/id_ed25519`) plus Railway, AWS SSO and Docker credentials committed
 * to a git repository that has a GitHub remote. They were committed by
 * accident, because nothing in the toolchain was looking for them.
 *
 * A .gitignore only stops *untracked* files from being added. It does nothing
 * about a file that is already tracked, or about a secret pasted into a source
 * file. This scanner closes that gap: it inspects the content that is about to
 * be committed and refuses the commit if it looks like a credential.
 *
 * DESIGN RULES
 * ------------
 *  1. Never print the secret itself — only a masked preview. CI logs and
 *     terminal scrollback are themselves a leak vector.
 *  2. Exit non-zero on a finding, so a pre-commit hook or CI job actually
 *     blocks. A scanner that only warns is decoration.
 *  3. Prefer false positives over false negatives. A noisy scanner that
 *     someone bypasses is still better than a silent one.
 *
 * USAGE
 * -----
 *   node scripts/quality/secret-scan.mjs              # scan staged files
 *   node scripts/quality/secret-scan.mjs --all        # scan the whole tree
 *   node scripts/quality/secret-scan.mjs --files a b  # scan specific files
 *
 * Exit codes: 0 = clean, 1 = findings, 2 = scanner error.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const MAX_BYTES = 2 * 1024 * 1024; // skip files larger than 2 MB — they are never source

// ---------------------------------------------------------------------------
// Detectors. Each entry documents what it catches and why it matters.
// ---------------------------------------------------------------------------

/**
 * Is this value a template rather than a credential?
 *
 * WHY THIS EXISTS
 * ---------------
 * `.env.production.example` and the README legitimately contain placeholder
 * connection strings and a dummy bot token. Flagging those is not "cautious",
 * it is noise — and noise is what teaches a team to reach for `--no-verify`,
 * which throws away the real findings along with the false ones.
 *
 * The test is deliberately narrow. A live credential does not contain a shell
 * expansion, an angle-bracket slot, or the word "your", so none of these
 * patterns can hide a real secret.
 *
 * Note that `.example` files are still scanned. A placeholder-shaped file is
 * exactly where someone pastes a real key "just to test" and forgets to remove
 * it, so skipping those files outright would trade a false positive for a
 * false negative.
 */
function looksLikeTemplate(value) {
  return /\$\{|\$[A-Z_]|<[^>]*>|your[-_]|_your|xxx|placeholder|changeme|redacted|example|dummy/i.test(
    value,
  );
}

/**
 * Words that only ever appear in a value that is *telling you it is not real*.
 *
 * WHY THIS EXISTS
 * ---------------
 * CI was red on every single push because of three test fixtures that are
 * obviously fake to a human and were invisible to the detector. The files are
 * named here and the values are described rather than quoted: reproducing the
 * literal text in this comment made the scanner flag its own source, which is
 * the same trap as a marker that a doc comment can satisfy.
 *
 *     apps/api/test/panel-auth.spec.ts        a panel key whose value ends with
 *                                             the words "definitely not a real
 *                                             key at all", run together
 *     apps/api/test/panel-auth.spec.ts        a device token whose value ends
 *                                             with "not a real device token",
 *                                             run together
 *     apps/api/test/device-credential.spec.ts a header built by interpolating a
 *                                             runtime token into a literal
 *                                             service-credential prefix
 *
 * The previous test was ANCHORED to the start of the value (`/^(?:fake|dummy)/`)
 * and every one of those has a real-looking prefix in FRONT of the giveaway, so
 * none matched. Matching anywhere is what makes the giveaway visible — and the
 * giveaway is written both with and without separators, so all three spellings
 * are covered.
 *
 * The list is made of phrases a live credential cannot contain. Note that `test`
 * is deliberately NOT here — a real key can legitimately contain that word, and
 * exempting it would trade a false positive for a false negative.
 */
const SELF_DESCRIBING_FAKE =
  /not[a-z_-]*real|definitelynot|dummy|placeholder|example|sample|bogus|invalid|redacted|fake/i;

/**
 * Hosts that cannot reach a remote system.
 *
 * A database URL pointing at loopback is a local development default, not a
 * leaked credential: the password in it is useless against anything except the
 * developer's own machine. Five localhost fallbacks in the test suites, plus one
 * commented-out line in `.env.example`, are the whole reason the CRITICAL count
 * was 6. The URL text itself is not quoted here, so that this file does not
 * report itself.
 *
 * Deliberately loopback ONLY. A compose service name such as `postgres` or `db`
 * is NOT exempt, because that same password is routinely reused against
 * production — flagging it is the correct direction to be wrong in.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/** The host of a `scheme://user:pass@host:port/...` URL, or '' if there is none. */
function hostOf(value) {
  const afterAt = value.split('@')[1];
  if (!afterAt) return '';
  const authority = afterAt.split('/')[0];
  // Bracketed IPv6 (`[::1]:5432`) cannot be split on ':'.
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    return close === -1 ? authority.toLowerCase() : authority.slice(0, close + 1).toLowerCase();
  }
  return authority.split(':')[0].toLowerCase();
}

/**
 * A URL path, which is not a credential.
 *
 * `/api/portal/field/tasks/any-task/acknowledge` is 43 characters of varied
 * punctuation, so it cleared the entropy threshold and was reported as a
 * possible key.
 *
 * The discriminator is case: a path is written in lowercase, while base64 mixes
 * case heavily. Requiring three or more lowercase-only segments is what keeps
 * this from becoming a hole — `/9j/4AAQSkZJRgABAQ…` has uppercase in it and is
 * therefore still scanned.
 */
const URL_PATH = /^\/[a-z0-9\-._~%]+(?:\/[a-z0-9\-._~%]+){2,}$/;

/**
 * Base64-encoded image payloads.
 *
 * `high-entropy-string` fires on any 40+ character base64 blob, and a photo
 * encoded as base64 is exactly that — which is why the simulated capture in
 * `portalApi.ts` and the 1x1 PNG fixture in `storage.spec.ts` were reported.
 *
 * Only the FIRST chunk of a multi-line concatenation carries the format
 * signature, so matching the candidate on its own is not enough:
 *
 *     '/9j/4AAQSkZJRgABAQEAYABgAAD…' +     <- has the JPEG signature
 *     'HBwgJC4nICIsIxwcKDcpLDAxNDQ0…' +     <- does not, but is the same image
 *
 * The signature is therefore looked for across the whole concatenation.
 */
const BASE64_IMAGE_PREFIX = /\/9j\/|iVBORw0KGgo|R0lGOD|UklGR|Qk0[A-Za-z0-9+/]/;

/** True when `index` in `text` sits inside a concatenation carrying an image signature. */
function insideImageLiteral(text, index) {
  const lines = text.split('\n');
  const lineNo = text.slice(0, index).split('\n').length - 1;
  const continues = (line) => /[+]\s*$/.test((line ?? '').trimEnd());
  let start = lineNo;
  let end = lineNo;
  while (start > 0 && continues(lines[start - 1])) start--;
  while (end < lines.length - 1 && continues(lines[end])) end++;
  return BASE64_IMAGE_PREFIX.test(lines.slice(start, end + 1).join('\n'));
}

const DETECTORS = [
  {
    id: 'private-key',
    // PEM blocks. An SSH or TLS private key in a repository is a total
    // compromise of every host that trusts the matching public key.
    re: /-----BEGIN\s+(?:RSA|DSA|EC|OPENSSH|PGP|ENCRYPTED)?\s*PRIVATE KEY-----/g,
    severity: 'CRITICAL',
    why: 'Private key material. Anyone with this file can impersonate the server or user.',
  },
  {
    id: 'ssh-private-key-file',
    // A private key without a PEM header (some formats are headerless).
    re: /^(?!.*\.pub$).*id_(?:rsa|dsa|ecdsa|ed25519)$/gm,
    severity: 'CRITICAL',
    why: 'SSH private key filename. Only *.pub files are safe to commit.',
    filenameOnly: true,
  },
  {
    id: 'openai-key',
    re: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    severity: 'CRITICAL',
    why: 'OpenAI-style API key. Billable, and often grants access to fine-tuned data.',
  },
  {
    id: 'anthropic-key',
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    severity: 'CRITICAL',
    why: 'Anthropic API key.',
  },
  {
    id: 'github-token',
    re: /\b(?:gho|ghu|ghs|ghr|ghp)_[A-Za-z0-9]{20,}\b/g,
    severity: 'CRITICAL',
    why: 'GitHub token. Grants repository read/write depending on scope.',
  },
  {
    id: 'github-pat-fine-grained',
    re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    severity: 'CRITICAL',
    why: 'Fine-grained GitHub personal access token.',
  },
  {
    id: 'aws-access-key-id',
    re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
    severity: 'CRITICAL',
    why: 'AWS access key ID. Pair it with a secret key and the account is reachable.',
  },
  {
    id: 'google-api-key',
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    severity: 'CRITICAL',
    why: 'Google API key. Often unrestricted and billable.',
  },
  {
    id: 'slack-token',
    re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,
    severity: 'CRITICAL',
    why: 'Slack token. Grants access to workspace messages.',
  },
  {
    id: 'stripe-key',
    re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{20,}\b/g,
    severity: 'CRITICAL',
    why: 'Stripe secret key. Allows charges and refunds.',
  },
  {
    id: 'telegram-bot-token',
    // This project runs a Telegram bot, so this one matters directly.
    re: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g,
    severity: 'CRITICAL',
    why: 'Telegram bot token. Grants full control of the bot, including sending messages as it.',
    // The official docs use `1234567890:AAH_your_official_bot_token` as their
    // example, and that example is quoted verbatim in this project's README.
    allowIf: looksLikeTemplate,
  },
  {
    id: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    severity: 'HIGH',
    why: 'JSON Web Token. May be a long-lived credential or contain personal data.',
  },
  {
    id: 'supabase-service-key',
    re: /\bsb(?:p|_secret)_[A-Za-z0-9_-]{20,}\b/g,
    severity: 'CRITICAL',
    why: 'Supabase service-role key. Bypasses row-level security entirely.',
  },
  {
    id: 'postgres-url-with-password',
    re: /\bpostgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/g,
    severity: 'CRITICAL',
    why: 'Database URL containing an inline password.',
    // A slot to be filled in is a placeholder; a live password is not. The test
    // is applied to the `user:password` part ONLY, never to the whole URL — and
    // that distinction is load-bearing. `looksLikeTemplate` exempts the word
    // "example", so testing the whole URL silently exempted
    // `…@db.customer.example.com/…`, a remote host with a real password in it.
    // The positive controls in `secret-scan.test.mjs` caught exactly that.
    //
    // A loopback host is a local default rather than a leak; see LOOPBACK_HOSTS.
    allowIf: (value) => {
      const credentials = value.split('@')[0].split('://')[1] ?? '';
      return looksLikeTemplate(credentials) || LOOPBACK_HOSTS.has(hostOf(value));
    },
  },
  {
    id: 'generic-assigned-secret',
    // Catch-all for the pattern that causes most real leaks:
    //   const API_KEY = "…"
    // Requires a value long enough to be a real credential, and excludes
    // obvious placeholders so the scanner stays usable.
    re: /\b(?:api[_-]?key|apikey|secret|password|passwd|pwd|token|access[_-]?token|auth[_-]?token|private[_-]?key|client[_-]?secret)\b\s*[:=]\s*['"`]([^'"`\n]{16,})['"`]/gi,
    severity: 'HIGH',
    why: 'A credential-looking value assigned in source. Move it to an environment variable.',
    allowIf: (value) =>
      SELF_DESCRIBING_FAKE.test(value) ||
      // A template literal is built at runtime, so it cannot BE a secret — and
      // `oneteam-user:${token}` is precisely that. Tested anywhere in the value,
      // because the interpolation is rarely at the start.
      value.includes('${') ||
      /^(?:your[-_]|my[-_]|xxx|test|changeme|redacted|\*{3,}|<[^>]+>|process\.env|import\.meta)/i.test(
        value,
      ) ||
      /^[A-Z_]{4,}$/.test(value), // SCREAMING_CASE means it is a variable name, not a value
  },
  {
    id: 'high-entropy-string',
    // Base64/hex blobs that look random. Deliberately conservative: requires
    // 40+ chars and high character diversity, so it does not fire on hashes in
    // lockfiles or normal long identifiers.
    re: /['"`]([A-Za-z0-9+/=_-]{40,})['"`]/g,
    severity: 'MEDIUM',
    why: 'High-entropy string that may be an encoded credential or key.',
    allowIf: (value, context) => {
      if (/^[0-9a-f]{40}$/i.test(value)) return true; // git SHA
      if (/^[0-9a-f]{64}$/i.test(value)) return true; // sha256
      if (URL_PATH.test(value)) return true; // a route, not a key
      if (context && insideImageLiteral(context.text, context.index)) return true; // base64 photo
      const uniq = new Set(value).size;
      return uniq / value.length < 0.35; // low diversity -> not a real secret
    },
  },
];

// Directories we never descend into or scan. Vendored code, build output,
// virtualenvs and generated prototype artefacts are noise; scanning them
// buries real findings and makes a full-tree walk take minutes.
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  '.pnpm-store',
  '.cache',
  'shots',
  'shots-app',
  '.gemini',
  '.codex',
  '.claude',
  '.workbuddy-ai',
  // Generated UI prototype/report output — rebuilt on demand, not source.
  'ui-audit',
  'ui-design',
  'ui-glass',
]);

const SKIP_FILE_RE = /(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|\.map|\.min\.(?:js|css))$/;

// Binary-ish extensions that cannot contain a readable secret anyway.
const BINARY_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.svgz',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.7z',
  '.rar',
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
  '.wav',
  '.webm',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.pt',
  '.pth',
  '.onnx',
  '.h5',
  '.safetensors',
  '.ckpt',
  '.bin',
  '.node',
  '.wasm',
  '.exe',
  '.dll',
  '.dylib',
  '.so',
  '.class',
  '.jar',
]);

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------
function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function stagedFiles() {
  const out = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']);
  return out.split('\0').filter(Boolean);
}

function trackedFiles() {
  const out = git(['ls-files', '-z']);
  return out.split('\0').filter(Boolean);
}

/**
 * Recursive directory walk.
 *
 * Needed because `git ls-files` is useless when the working tree is not
 * tracked — which is exactly the situation this repository was found in.
 * Relying on git alone would have made `--all` silently scan nothing and
 * report success, the worst possible failure mode for a security tool.
 */
function walkFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function shouldScan(path) {
  // Match on whole path segments so `dist/` skips `dist/x.js` but never
  // `src/distribute.ts`.
  const segments = path.split('/');
  if (segments.some((s) => SKIP_DIRS.has(s))) return false;
  if (SKIP_FILE_RE.test(path)) return false;
  if (BINARY_EXT.has(extname(path).toLowerCase())) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Masking — never echo a live credential
// ---------------------------------------------------------------------------
function mask(value) {
  const v = String(value);
  if (v.length <= 12) return '*'.repeat(v.length);
  return `${v.slice(0, 4)}${'*'.repeat(Math.min(24, v.length - 8))}${v.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------
function scanFile(path) {
  const hits = [];
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return hits;
  }
  if (!stat.isFile() || stat.size > MAX_BYTES) return hits;

  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return hits; // unreadable or binary
  }
  // A NUL byte in the first block means binary content.
  if (text.includes('\0')) return hits;

  const lines = text.split('\n');

  for (const detector of DETECTORS) {
    detector.re.lastIndex = 0;
    let match;
    while ((match = detector.re.exec(text)) !== null) {
      const raw = match[0];
      const candidate = match[1] ?? raw;

      // `context` lets a detector look at the surrounding source, which is the
      // only way to tell a base64 photo from a base64 key. See insideImageLiteral.
      if (detector.allowIf && detector.allowIf(candidate, { text, index: match.index })) continue;

      const lineNo = text.slice(0, match.index).split('\n').length;
      const lineText = (lines[lineNo - 1] ?? '').trim();

      // A file that only *contains* the word id_ed25519 (e.g. documentation)
      // is fine; the filename check is what matters there.
      if (detector.filenameOnly && !/id_(rsa|dsa|ecdsa|ed25519)$/.test(path)) continue;

      hits.push({
        id: detector.id,
        severity: detector.severity,
        why: detector.why,
        file: path,
        line: lineNo,
        preview: mask(candidate),
        context: lineText.length > 120 ? `${lineText.slice(0, 120)}…` : lineText,
      });

      if (detector.re.lastIndex === match.index) detector.re.lastIndex++; // guard against zero-width loops
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const argv = process.argv.slice(2);
  let files;
  let mode;

  if (argv.includes('--files')) {
    files = argv.slice(argv.indexOf('--files') + 1);
    mode = 'explicit file list';
  } else if (argv.includes('--dir')) {
    const dir = argv[argv.indexOf('--dir') + 1] || '.';
    files = walkFiles(dir);
    mode = `directory walk (${dir})`;
  } else if (argv.includes('--all')) {
    // Prefer git's view of the tree, but fall back to a filesystem walk when
    // git knows nothing about these files (untracked tree). Silently scanning
    // zero files and reporting success would be the worst failure mode.
    try {
      files = trackedFiles();
    } catch {
      files = [];
    }
    if (files.length === 0) {
      files = walkFiles('.');
      mode = 'filesystem walk (git reports no tracked files)';
    } else {
      mode = 'git tracked files';
    }
  } else {
    try {
      files = stagedFiles();
      mode = 'staged files';
    } catch {
      console.error('secret-scan: not a git repository, or git is unavailable.');
      process.exit(2);
    }
  }

  const targets = files.map((f) => f.replace(/^\.\//, '')).filter(shouldScan);

  if (targets.length === 0) {
    console.log('✓ secret-scan: nothing to check.');
    process.exit(0);
  }

  const all = [];
  for (const f of targets) all.push(...scanFile(f));

  // De-duplicate: the catch-all detectors (generic assignment, high entropy)
  // re-report values that a specific detector already caught on the same line.
  // Scanner noise is the main reason teams switch a scanner off, so suppress
  // the generic finding whenever a more specific one already covers it.
  const specific = new Set(
    all.filter((h) => h.severity === 'CRITICAL').map((h) => `${h.file}:${h.line}`),
  );
  const deduped = all.filter(
    (h) =>
      !(
        (h.id === 'high-entropy-string' || h.id === 'generic-assigned-secret') &&
        specific.has(`${h.file}:${h.line}`)
      ),
  );

  const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 };
  deduped.sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file));

  console.log('─'.repeat(78));
  console.log(`  oneTeam secret scan — ${targets.length} file(s) checked (${mode})`);
  console.log('─'.repeat(78));

  if (deduped.length === 0) {
    console.log('  ✓ No credentials detected.');
    console.log('─'.repeat(78));
    process.exit(0);
  }

  for (const h of deduped) {
    console.log(`  ✗ [${h.severity}] ${h.id}`);
    console.log(`      file : ${h.file}:${h.line}`);
    console.log(`      value: ${h.preview}`);
    console.log(`      why  : ${h.why}`);
  }

  const critical = deduped.filter((h) => h.severity === 'CRITICAL').length;

  console.log('─'.repeat(78));
  console.log(`  ${deduped.length} finding(s) — ${critical} CRITICAL.`);
  console.log('');
  console.log('  What to do:');
  console.log('    1. Remove the value from the file. Read it from an environment');
  console.log('       variable instead (process.env.NAME) and add it to .env,');
  console.log('       which is already gitignored.');
  console.log('    2. If the value was EVER committed, deleting it is not enough —');
  console.log('       it lives in git history forever. Treat it as compromised:');
  console.log('       ROTATE the credential at the provider, then purge history.');
  console.log('    3. If this is a false positive, prefer narrowing the detector');
  console.log('       in scripts/quality/secret-scan.mjs over skipping the scan.');
  console.log('─'.repeat(78));

  process.exit(1);
}

main();
