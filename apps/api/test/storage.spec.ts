/**
 * oneTeam — photo storage test suite
 * ============================================================================
 *
 * HOW THIS IS ACTUALLY VERIFIED, AND WHAT IS NOT PROOF OF ANYTHING
 * ---------------------------------------------------------------
 * A hand-written AWS Signature Version 4 signer is exactly the kind of code
 * that looks right and returns 403, and the failure is invisible: the server
 * rejects the request without saying which part of the canonical request was
 * wrong. So it is worth being precise about what each tier below does and does
 * not establish.
 *
 * TIER 1 — unit checks. Always run, no network. These cover the parts that are
 * easy to get subtly wrong and cheap to check: data URL decoding, URL
 * construction for both addressing styles, the `x-amz-date` format, and the
 * decision not to return a `Host` header that `fetch` would silently drop.
 *
 * It also pins one signature for fixed inputs. THAT IS A REGRESSION LOCK, NOT
 * PROOF OF CORRECTNESS — the expected value was produced by this
 * implementation. It catches an accidental change to canonicalisation; it
 * cannot tell you the algorithm is right.
 *
 * TIER 2 — a real bucket. This is the only tier that proves the signature is
 * correct, because it is the only one where something other than this code
 * decides. MinIO implements SigV4 itself and answers `SignatureDoesNotMatch`
 * when the canonical request is wrong, so an accepted upload is independent
 * evidence.
 *
 * The negative control in tier 2 is the part that makes that evidence worth
 * anything: it signs the same request with a deliberately wrong secret and
 * asserts the upload is REFUSED. Without it, "the upload succeeded" could
 * equally mean the server is not checking signatures at all.
 *
 * Run tier 1 alone:  npm run test:storage
 * Run both:          ONETEAM_TEST_S3_ENDPOINT=http://localhost:9000 npm run test:storage
 */

import 'reflect-metadata';
import { StorageService } from '../src/modules/storage/storage.service';
import {
  S3Target,
  decodeDataUrl,
  isInlineDataUrl,
  signS3Put,
  signS3PresignedPut,
} from '../src/modules/storage/s3-signature';

let passed = 0;
let total = 0;

function check(condition: boolean, name: string, detail?: string) {
  total++;
  if (condition) {
    console.log(`  ✅ [PASS] ${name}`);
    passed++;
  } else {
    console.error(`  ❌ [FAIL] ${name}`);
    if (detail) console.error(`         ${detail}`);
  }
}

const FIXED_TARGET: S3Target = {
  endpoint: 'https://s3.example.com',
  region: 'eu-central-1',
  bucket: 'photos',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secret-example',
  forcePathStyle: true,
};

/** Tier 1: the pure functions, and a lock on the signature's current shape. */
function testSigner() {
  console.log('\n📐 Tier 1 — signer unit checks\n');

  const signed = signS3Put({
    target: FIXED_TARGET,
    key: 'tasks/task-1/photo.jpg',
    body: Buffer.from('hello'),
    contentType: 'image/jpeg',
    now: new Date('2026-01-02T03:04:05Z'),
  });

  check(
    signed.url === 'https://s3.example.com/photos/tasks/task-1/photo.jpg',
    'builds a path-style URL with the bucket in the path',
    signed.url,
  );

  check(
    signed.headers['x-amz-date'] === '20260102T030405Z',
    'formats x-amz-date as the specification requires',
    signed.headers['x-amz-date'],
  );

  // Independently checkable: `printf 'hello' | shasum -a 256`.
  check(
    signed.headers['x-amz-content-sha256'] ===
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    'hashes the payload with sha256',
    signed.headers['x-amz-content-sha256'],
  );

  // Regression lock. See the note at the top of this file about what this
  // does and does not prove.
  check(
    signed.headers.Authorization ===
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260102/eu-central-1/s3/aws4_request, ' +
        'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, ' +
        'Signature=db6ed69b38d578383163f7b35721667adc3e83d41041d2d022e0994779fe7838',
    'signature is unchanged for fixed inputs (regression lock)',
    signed.headers.Authorization,
  );

  check(
    signed.headers.host === undefined && signed.headers.Host === undefined,
    'does not return a Host header that fetch would silently drop',
  );

  // Virtual-host addressing puts the bucket in the authority instead.
  const virtual = signS3Put({
    target: { ...FIXED_TARGET, forcePathStyle: false },
    key: 'tasks/task-1/photo.jpg',
    body: Buffer.from('hello'),
    contentType: 'image/jpeg',
    now: new Date('2026-01-02T03:04:05Z'),
  });

  check(
    virtual.url === 'https://photos.s3.example.com/tasks/task-1/photo.jpg',
    'builds a virtual-host URL with the bucket in the authority',
    virtual.url,
  );

  check(
    !virtual.headers.Authorization.includes('/photos/'),
    'does not double the bucket into the virtual-host path',
  );

  // A key with characters that must be percent-encoded, and a `/` that must not.
  const awkward = signS3Put({
    target: FIXED_TARGET,
    key: 'tasks/a b/c+d(1).jpg',
    body: Buffer.from('x'),
    contentType: 'image/jpeg',
    now: new Date('2026-01-02T03:04:05Z'),
  });

  check(
    awkward.url.endsWith('/photos/tasks/a%20b/c%2Bd%281%29.jpg'),
    'encodes the key per RFC 3986 and keeps path separators',
    awkward.url,
  );
}

/** Tier 1: the small helpers. */
function testDataUrlHelpers() {
  console.log('\n🔍 Data URL handling\n');

  check(isInlineDataUrl('data:image/png;base64,AAAA'), 'recognises a data URL');
  check(!isInlineDataUrl('https://bucket.example.com/a.png'), 'does not treat a URL as inline');
  check(!isInlineDataUrl(''), 'does not treat an empty string as inline');

  const decoded = decodeDataUrl('data:image/jpeg;base64,SGVsbG8=');
  check(
    decoded?.contentType === 'image/jpeg' && decoded?.body.toString('utf8') === 'Hello',
    'decodes a base64 data URL',
    String(decoded?.body.toString('utf8')),
  );

  check(decodeDataUrl('not a data url') === null, 'refuses a value that is not a data URL');
  check(decodeDataUrl('data:image/png;base64,') === null, 'refuses an empty payload');
}

/** Tier 1: the presigned direct-upload URL, and a lock on its current shape. */
function testPresigner() {
  console.log('\n🔗 Tier 1 — presigned upload URL\n');

  const presigned = signS3PresignedPut({
    target: FIXED_TARGET,
    key: 'tasks/task-1/photo.jpg',
    expiresSeconds: 300,
    now: new Date('2026-01-02T03:04:05Z'),
  });

  check(
    presigned.url.startsWith('https://s3.example.com/photos/tasks/task-1/photo.jpg?'),
    'presigns a path-style URL for the object',
    presigned.url,
  );

  check(
    presigned.url.includes('X-Amz-Algorithm=AWS4-HMAC-SHA256') &&
      presigned.url.includes('X-Amz-Expires=300') &&
      presigned.url.includes('X-Amz-SignedHeaders=host'),
    'carries the SigV4 query parameters, signing only host',
    presigned.url,
  );

  check(
    presigned.url.includes('X-Amz-Credential=AKIDEXAMPLE%2F20260102%2Feu-central-1%2Fs3%2Faws4_request'),
    'percent-encodes the slashes in the credential scope',
    presigned.url,
  );

  // Regression lock — see the note at the top of this file. Produced by this
  // implementation; catches a change to presign canonicalisation, does not
  // prove the algorithm. Tier 2 is what proves it against a real bucket.
  check(
    presigned.url.endsWith(
      '&X-Amz-Signature=72ac66f3bf5d2a628d72d5dc1069af748a49059f2e88b2632521312baedaf56d',
    ),
    'presigned signature is unchanged for fixed inputs (regression lock)',
    presigned.url,
  );

  check(
    presigned.expiresAt === '2026-01-02T03:09:05.000Z',
    'reports the expiry as now + expiresSeconds',
    presigned.expiresAt,
  );

  // Virtual-host style puts the bucket in the authority, not the path.
  const virtual = signS3PresignedPut({
    target: { ...FIXED_TARGET, forcePathStyle: false },
    key: 'a.jpg',
    expiresSeconds: 60,
    now: new Date('2026-01-02T03:04:05Z'),
  });
  check(
    virtual.url.startsWith('https://photos.s3.example.com/a.jpg?'),
    'presigns a virtual-host URL with the bucket in the authority',
    virtual.url,
  );
}

/**
 * Tier 2 — a real bucket, and the only tier that proves anything.
 *
 * Skipped unless `ONETEAM_TEST_S3_ENDPOINT` is set, so the default suite does
 * not depend on a container being up.
 */
async function testAgainstRealBucket() {
  const endpoint = process.env.ONETEAM_TEST_S3_ENDPOINT;
  if (!endpoint) {
    console.log(
      '\n⏭️  Tier 2 skipped — set ONETEAM_TEST_S3_ENDPOINT to run the only tier that\n' +
        '    actually proves the signature works.\n',
    );
    return;
  }

  console.log(`\n🪣 Tier 2 — real upload to ${endpoint}\n`);

  const bucket = process.env.ONETEAM_TEST_S3_BUCKET || 'oneteam-photos';
  const accessKeyId = process.env.ONETEAM_TEST_S3_ACCESS_KEY || 'oneteam';
  const secretAccessKey = process.env.ONETEAM_TEST_S3_SECRET_KEY || 'oneteam123';

  process.env.STORAGE_DRIVER = 's3';
  process.env.S3_ENDPOINT = endpoint;
  process.env.S3_REGION = process.env.ONETEAM_TEST_S3_REGION || 'us-east-1';
  process.env.S3_BUCKET = bucket;
  process.env.S3_ACCESS_KEY_ID = accessKeyId;
  process.env.S3_SECRET_ACCESS_KEY = secretAccessKey;
  process.env.S3_FORCE_PATH_STYLE = '1';

  const storage = new StorageService();
  check(storage.description.driver === 's3', 'selects the s3 driver when configured');

  // A real 1x1 PNG, so both the content type and the extension are exercised.
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const dataUrl = `data:image/png;base64,${png}`;

  const stored = await storage.persistPhoto({ value: dataUrl, scope: 'tests' });

  check(stored.driver === 's3', 'reports the photo as offloaded');
  check(stored.url.startsWith(endpoint), 'returns a URL under the configured endpoint', stored.url);
  check(stored.url.endsWith('.png'), 'keeps the extension of the media type', stored.url);
  check(!stored.url.startsWith('data:'), 'does not return the data URL');

  const response = await fetch(stored.url);
  check(
    response.ok,
    'the uploaded object is readable at the returned URL',
    `HTTP ${response.status}`,
  );

  if (response.ok) {
    const fetched = Buffer.from(await response.arrayBuffer());
    const original = Buffer.from(png, 'base64');
    check(
      fetched.equals(original),
      'the stored bytes are identical to the submitted bytes',
      `${fetched.length} bytes back vs ${original.length} sent`,
    );
    check(
      response.headers.get('content-type') === 'image/png',
      'the object keeps its content type',
      String(response.headers.get('content-type')),
    );
  }

  // --------------------------------------------------------------- NEGATIVE
  // The control that gives the checks above their meaning. If the server
  // accepted this, it is not verifying signatures and nothing else here counts.
  const wrongSecret = signS3Put({
    target: {
      endpoint,
      region: process.env.S3_REGION!,
      bucket,
      accessKeyId,
      secretAccessKey: 'definitely-not-the-secret',
      forcePathStyle: true,
    },
    key: 'tests/negative-control.jpg',
    body: Buffer.from('should be refused'),
    contentType: 'image/jpeg',
  });

  const refused = await fetch(wrongSecret.url, {
    method: 'PUT',
    headers: wrongSecret.headers,
    body: new Uint8Array(Buffer.from('should be refused')),
  });

  check(
    !refused.ok,
    'a request signed with the wrong secret is REFUSED (the control)',
    `HTTP ${refused.status} — if this succeeded, the bucket is not checking signatures`,
  );

  // A non-data value must pass through untouched — this is what stops the
  // offload path from rewriting a URL it did not produce.
  const untouched = await storage.persistPhoto({ value: 'https://example.com/a.jpg' });
  check(
    untouched.url === 'https://example.com/a.jpg' && untouched.driver === 's3',
    'leaves an already-uploaded URL alone',
  );

  // ------------------------------------------------------- PRESIGNED UPLOAD
  // The direct path: mint a presigned PUT, upload the bytes to it with a plain
  // fetch (no signing on this side, as a client would), and read them back.
  const realTarget: S3Target = {
    endpoint,
    region: process.env.S3_REGION!,
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: true,
  };
  const pngBytes = new Uint8Array(Buffer.from(png, 'base64'));

  const presigned = signS3PresignedPut({
    target: realTarget,
    key: 'tests/presigned.png',
    expiresSeconds: 300,
  });
  const put = await fetch(presigned.url, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png' },
    body: pngBytes,
  });
  check(put.ok, 'a presigned PUT is accepted by the bucket', `HTTP ${put.status}`);

  const readBack = await fetch(`${endpoint}/${bucket}/tests/presigned.png`);
  check(readBack.ok, 'the presigned object is readable', `HTTP ${readBack.status}`);
  if (readBack.ok) {
    const got = Buffer.from(await readBack.arrayBuffer());
    check(got.equals(Buffer.from(png, 'base64')), 'presigned bytes round-trip unchanged');
  }

  // Negative control: a presigned URL signed with the wrong secret is REFUSED —
  // without this, "the PUT worked" could mean the bucket is not checking at all.
  const badPresigned = signS3PresignedPut({
    target: { ...realTarget, secretAccessKey: 'definitely-not-the-secret' },
    key: 'tests/presigned-bad.png',
    expiresSeconds: 300,
  });
  const badPut = await fetch(badPresigned.url, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png' },
    body: pngBytes,
  });
  check(
    !badPut.ok,
    'a presigned PUT signed with the wrong secret is REFUSED (the control)',
    `HTTP ${badPut.status}`,
  );
}

/** Tier 1: `ownsPublicUrl`, the guard for a client-supplied photo URL. */
function testOwnsPublicUrl() {
  console.log('\n🛡️  ownsPublicUrl — the client-URL guard\n');

  // With an explicit public base — how R2 typically serves reads.
  process.env.STORAGE_DRIVER = 's3';
  process.env.S3_ENDPOINT = 'https://acct.r2.cloudflarestorage.com';
  process.env.S3_REGION = 'auto';
  process.env.S3_BUCKET = 'oneteam-photos';
  process.env.S3_ACCESS_KEY_ID = 'k';
  process.env.S3_SECRET_ACCESS_KEY = 's';
  process.env.S3_PUBLIC_BASE_URL = 'https://cdn.oneteam.az';
  const withBase = new StorageService();
  check(withBase.ownsPublicUrl('https://cdn.oneteam.az/tasks/x/a.jpg'), 'accepts a URL under the public base');
  check(!withBase.ownsPublicUrl('https://evil.example.com/a.jpg'), 'rejects an external URL');
  check(!withBase.ownsPublicUrl(''), 'rejects an empty URL');

  // Without a public base: falls back to the endpoint/bucket prefix.
  delete process.env.S3_PUBLIC_BASE_URL;
  const noBase = new StorageService();
  check(
    noBase.ownsPublicUrl('https://acct.r2.cloudflarestorage.com/oneteam-photos/tasks/x/a.jpg'),
    'accepts a URL under the endpoint/bucket prefix',
  );
  check(
    !noBase.ownsPublicUrl('https://acct.r2.cloudflarestorage.com/other-bucket/a.jpg'),
    'rejects a URL in a different bucket',
  );

  // Inline storage owns no URL — there is no bucket to own one.
  process.env.STORAGE_DRIVER = 'inline';
  const inline = new StorageService();
  check(!inline.ownsPublicUrl('https://cdn.oneteam.az/a.jpg'), 'inline storage owns no URL');
}

async function run() {
  console.log('========================================================================');
  console.log('  🗄️  ONETEAM PHOTO STORAGE TESTS');
  console.log('========================================================================');

  testSigner();
  testPresigner();
  testDataUrlHelpers();
  testOwnsPublicUrl();
  await testAgainstRealBucket();

  console.log('\n------------------------------------------------------------------------');
  console.log(`  ${passed}/${total} checks passed`);
  console.log('------------------------------------------------------------------------\n');

  if (passed !== total) process.exit(1);
}

run().catch((error) => {
  console.error('\n💥 Storage test suite crashed:', error);
  process.exit(1);
});
