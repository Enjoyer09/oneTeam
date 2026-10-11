#!/usr/bin/env node
/**
 * A client cannot point the audit record at a photo it did not upload.
 * ============================================================================
 *
 * THE HOLE
 * --------
 * `POST /api/field/photos/presign` mints the object key SERVER-SIDE — a caller
 * cannot choose its path, overwrite a sibling object, or traverse. That control
 * is real. But the key is then handed to the client, the client PUTs its bytes,
 * and the client submits the returned `publicUrl` back as its `photoUrl`.
 *
 * Nothing on the way back checks that the URL came from us, and
 * `StorageService.persistPhoto` is where it slips through:
 *
 *     if (!isInlineDataUrl(value)) {
 *       return { url: value, ... };   // <- a foreign URL passes through untouched
 *     }
 *
 * That line is defensible on its own — it is the documented "never replace a
 * photo with something that is not it" choice. What it does not know is that
 * `field.service.ts` calls it with a CLIENT-SUPPLIED value, and writes the
 * result straight into `task_evidences.photo_url`.
 *
 *     put your photo nowhere  ->  presign (or skip it entirely)
 *                            ->  submit photoUrl = "https://cdn.example/x.png"
 *                            ->  auditor opens a shelf-compliance record showing
 *                                an image from anywhere on the internet
 *
 * This is substitution, which defeats the point of the photo path: the record
 * can no longer be read as evidence that anyone stood in that store.
 *
 * WHY `ownsPublicUrl` AND NOT A NEW POLICY
 * ----------------------------------------
 * It exists, it is tested, and its doc comment describes a job it is not doing:
 *
 *     The caller submits the returned `publicUrl` afterwards, which
 *     `ownsPublicUrl` can then verify belongs to us.
 *
 * `git grep ownsPublicUrl` finds one definition and its own unit tests; no
 * production path calls it. The guard was written, tested, and never wired up.
 *
 * WHAT IS DELIBERATELY NOT REJECTED
 * ---------------------------------
 * A `data:` URL. With no bucket configured, `photo_url` legitimately holds an
 * inline image; refusing it would break every non-S3 deployment. Only a value
 * that CLAIMS to be remote is checked, because only that one is an assertion
 * about where the bytes live.
 *
 * These cases drive the real `StorageService`, not a copy of its logic — a
 * mirror of the rule would pass no matter what the service does.
 */

import { StorageService } from '../src/modules/storage/storage.service';
import { isInlineDataUrl, decodeDataUrl } from '../src/modules/storage/s3-signature';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    console.log(`  ✅ [PASS] ${label}`);
  } else {
    failed++;
    console.log(`  ❌ [FAIL] ${label}`);
    if (detail) console.log(`         ${detail}`);
  }
}

const PUBLIC_BASE = 'https://cdn.oneteam.az/';

/**
 * `StorageService` reads its configuration from the environment in its
 * constructor and takes no arguments, so the environment has to be set before
 * each build and restored afterwards — otherwise this suite would decide what
 * every later suite in `test:all` sees.
 */
const S3_ENV = [
  'STORAGE_DRIVER',
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_PUBLIC_BASE_URL',
  'S3_FORCE_PATH_STYLE',
] as const;

let savedEnv: Record<string, string | undefined> = {};

function withEnv(vars: Record<string, string | undefined>): void {
  for (const key of S3_ENV) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
}

/** Storage with a bucket base. No live client is contacted on the paths below. */
function storageWithBucket(): StorageService {
  withEnv({
    STORAGE_DRIVER: 's3',
    S3_ENDPOINT: 'https://s3.example.com',
    S3_REGION: 'auto',
    S3_BUCKET: 'oneteam-photos',
    S3_ACCESS_KEY_ID: 'test',
    S3_SECRET_ACCESS_KEY: 'test',
    S3_PUBLIC_BASE_URL: PUBLIC_BASE,
  });
  return new StorageService();
}

/** Storage with no bucket at all — the default self-hosted deployment. */
function storageInline(): StorageService {
  withEnv({ STORAGE_DRIVER: 'inline' });
  return new StorageService();
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv = {};
}

async function run(): Promise<void> {
  try {
    console.log('\n--- [PHOTO PROVENANCE] A submitted photo must be one we stored ---');

    const s3 = storageWithBucket();

    // 1. THE REGRESSION. A URL from anywhere else must not become our photo_url.
    let foreign: string | null = null;
    try {
      const stored = await s3.persistPhoto({
        value: 'https://cdn.example.com/not-our-photo.png',
        scope: 'tasks/t-1',
      });
      foreign = stored.url;
    } catch {
      foreign = null; // refused — which is the fix
    }
    check('a foreign photo URL is refused, not passed through', foreign === null, `got ${foreign}`);

    // 2. The control. Our own bucket URL must still be accepted, or every
    //    honest client using the presigned flow breaks.
    let own: string | null = null;
    try {
      own = (await s3.persistPhoto({ value: `${PUBLIC_BASE}tasks/t-1/a.jpg` })).url;
    } catch {
      own = null;
    }
    check('our own bucket URL is accepted', own === `${PUBLIC_BASE}tasks/t-1/a.jpg`, `got ${own}`);

    // 3. With no bucket configured, an inline data: URL is the legitimate case
    //    and must keep working.
    const inline = storageInline();
    const dataUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
    let inlineOk = false;
    try {
      inlineOk = (await inline.persistPhoto({ value: dataUrl })).url === dataUrl;
    } catch {
      inlineOk = false;
    }
    check('an inline data: URL is still accepted when no bucket is configured', inlineOk);

    // 4. And with a bucket configured, an inline data: URL is still DECODED and
    //    offloaded rather than rejected — that path must be unaffected by the new
    //    check. It is asserted on the decode step (`isInlineDataUrl` +
    //    `decodeDataUrl`) rather than on a completed upload, because reaching S3
    //    here would mean making a network call to a host that does not exist.
    check(
      'an inline data: URL is still recognised on the S3 path',
      isInlineDataUrl(dataUrl) && decodeDataUrl(dataUrl) !== null,
      'the new guard must not disturb data: handling',
    );

    // 5. The guard this suite exists to wire up must itself be honest.
    check(
      'StorageService.ownsPublicUrl rejects a foreign URL',
      !s3.ownsPublicUrl('https://cdn.example.com/not-our-photo.png'),
    );
    check(
      'StorageService.ownsPublicUrl accepts our bucket URL',
      s3.ownsPublicUrl(`${PUBLIC_BASE}tasks/t-1/a.jpg`),
    );
  } finally {
    restoreEnv();
  }

  console.log(`\n${passed}/${passed + failed} photo-provenance checks passed`);
  if (failed > 0) process.exitCode = 1;
}

run().catch((err) => {
  console.error('❌ photo-provenance suite failed:', err);
  process.exitCode = 1;
});
