/**
 * oneTeam Mobile — presigned photo upload, offline
 * ============================================================================
 *
 * WHY THIS SUITE EXISTS, AND WHY THE LIVE HARNESS IS NOT ENOUGH
 * ------------------------------------------------------------
 * `mobile-test-runner.ts` runs against a real API, but it can NEVER exercise
 * the presigned PUT: the harness has no camera, so every capture it makes is a
 * placeholder (`base64 === undefined`), and the placeholder deliberately takes
 * the inline path. The one branch that actually moves a photo to the bucket —
 * request a presigned URL, then PUT the decoded bytes to it — is therefore
 * reached only on a real device or here, with `fetch` stubbed.
 *
 * So this is where that branch is proven: that a real capture presigns and
 * PUTs, that a bucketless API (`STORAGE_NOT_CONFIGURED`) and a failed PUT both
 * fall back to the inline `data:` URL rather than losing the audit, that the
 * placeholder is never presigned, and that the bytes on the wire are the
 * decoded image and not a data URL. No network, no API — run it anywhere.
 *
 *   node ./node_modules/tsx/dist/cli.mjs mobile/src/services/photoUpload.test.ts
 */

// Must be set BEFORE portalApi is imported: `deviceToken` is read from this at
// module load, and without it `callApi` short-circuits with NOT_ENROLLED before
// any request is built.
process.env.ONETEAM_DEVICE_TOKEN = 'otd-test-token';

let passed = 0;
let total = 0;

function check(condition: boolean, name: string, detail?: unknown) {
  total++;
  if (condition) {
    console.log(`  ✅ [PASS] ${name}`);
    passed++;
  } else {
    console.error(`  ❌ [FAIL] ${name}`);
    if (detail !== undefined) console.error('         ', detail);
  }
}

// A real 1x1 PNG — same bytes as the API storage suite, so the decode is a real
// image and not a synthetic string.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

interface FetchCall {
  url: string;
  init: RequestInit;
}

let fetchCalls: FetchCall[] = [];
let handler: (url: string, init: RequestInit) => Promise<Response>;
let warnings: string[] = [];

function installFetch(h: (url: string, init: RequestInit) => Promise<Response>) {
  handler = h;
  fetchCalls = [];
  (globalThis as any).fetch = (url: any, init: RequestInit = {}) => {
    fetchCalls.push({ url: String(url), init });
    return handler(String(url), init);
  };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const PRESIGN_OK = {
  success: true,
  data: {
    uploadUrl: 'https://bucket.example.com/obj-key?X-Amz-Signature=abc',
    publicUrl: 'https://cdn.oneteam.az/obj-key',
    key: 'obj-key',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    requiredHeaders: { 'Content-Type': 'image/png' },
  },
};

const isPresign = (url: string) => url.includes('/photos/presign');

async function main() {
  console.log('\n=== mobile presigned photo upload (offline) ===\n');

  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };

  // `.js` extension because tsc's nodenext resolution requires it on a dynamic
  // import (tsx maps it back to the .ts). Dynamic, not static, because the
  // device token above must be in `process.env` BEFORE portalApi loads.
  const { mobileApi, MobileApiError } = await import('./portalApi.js');

  // ---------------------------------------------------------------- SUCCESS
  console.log('presigned direct upload');
  warnings = [];
  installFetch(async (url) => {
    if (isPresign(url)) return json(PRESIGN_OK, 201);
    return new Response('', { status: 200 }); // the PUT
  });

  const ok = await mobileApi.uploadPhoto({
    base64: PNG_B64,
    fileName: 'audits/store-1/task-9_123.jpg',
    contentType: 'image/png',
  });

  check(
    ok.photoUrl === PRESIGN_OK.data.publicUrl,
    'returns the bucket publicUrl, not a data URL',
    ok.photoUrl,
  );
  check(ok.origin === 'device', 'reports the photo as a real device capture', ok.origin);
  check(fetchCalls.length === 2, 'makes exactly two calls: presign then PUT', fetchCalls.length);

  const presignReq = fetchCalls[0];
  const presignBody = JSON.parse(String(presignReq.init.body));
  check(isPresign(presignReq.url), 'first call is the presign request', presignReq.url);
  check(presignBody.contentType === 'image/png', 'presign carries the content type', presignBody);
  check(
    presignBody.scope === 'audits/store-1',
    'presign scope is the fileName directory, not the file',
    presignBody.scope,
  );

  const putReq = fetchCalls[1];
  check(putReq.url === PRESIGN_OK.data.uploadUrl, 'PUTs to the signed uploadUrl', putReq.url);
  check(
    (putReq.init.method || '').toUpperCase() === 'PUT',
    'the direct upload is a PUT',
    putReq.init.method,
  );
  const putHeaders = (putReq.init.headers || {}) as Record<string, string>;
  check(
    putHeaders['Content-Type'] === 'image/png',
    'PUT sends the signed Content-Type',
    putHeaders,
  );
  check(
    !('Authorization' in putHeaders),
    'the PUT carries NO Authorization — the signature is in the URL',
    putHeaders,
  );
  const sentBytes = Buffer.from(putReq.init.body as Uint8Array);
  check(
    sentBytes.equals(Buffer.from(PNG_B64, 'base64')),
    'the PUT body is the decoded image bytes, not a data URL',
    `${sentBytes.length} bytes`,
  );
  check(warnings.length === 0, 'a clean success logs no warning', warnings);

  // ------------------------------------------------- FALLBACK: no bucket
  console.log('\nfallback: API has no object store');
  warnings = [];
  installFetch(async (url) => {
    if (isPresign(url)) return json({ error: 'STORAGE_NOT_CONFIGURED', message: 'no bucket' }, 503);
    return new Response('', { status: 200 });
  });

  const noBucket = await mobileApi.uploadPhoto({
    base64: PNG_B64,
    fileName: 'audits/store-1/task-9.jpg',
    contentType: 'image/png',
  });
  check(
    noBucket.photoUrl.startsWith('data:image/png;base64,'),
    'falls back to an inline data URL',
    noBucket.photoUrl.slice(0, 32),
  );
  check(noBucket.origin === 'device', 'the fallback still reports a real capture', noBucket.origin);
  check(fetchCalls.length === 1, 'no PUT is attempted when there is no bucket', fetchCalls.length);
  check(warnings.length === 0, 'STORAGE_NOT_CONFIGURED is expected and logs nothing', warnings);

  // ------------------------------------------------- FALLBACK: PUT rejected
  console.log('\nfallback: the bucket rejects the PUT');
  warnings = [];
  installFetch(async (url) => {
    if (isPresign(url)) return json(PRESIGN_OK, 201);
    return new Response('denied', { status: 500 });
  });

  const putFailed = await mobileApi.uploadPhoto({
    base64: PNG_B64,
    fileName: 'audits/store-1/task-9.jpg',
    contentType: 'image/png',
  });
  check(
    putFailed.photoUrl.startsWith('data:'),
    'a rejected PUT falls back to inline rather than losing the audit',
    putFailed.photoUrl.slice(0, 16),
  );
  check(
    putFailed.origin === 'device',
    'the fallback still reports a real capture',
    putFailed.origin,
  );
  check(
    warnings.length === 1,
    'a real upload failure IS logged (so a broken path is visible)',
    warnings,
  );

  // ------------------------------------------------- FALLBACK: unreachable
  console.log('\nfallback: the presign request cannot be reached');
  warnings = [];
  installFetch(async () => {
    throw new Error('network down');
  });
  const unreachable = await mobileApi.uploadPhoto({
    base64: PNG_B64,
    fileName: 'audits/store-1/task-9.jpg',
    contentType: 'image/png',
  });
  check(
    unreachable.photoUrl.startsWith('data:'),
    'an unreachable API falls back to inline',
    unreachable.photoUrl.slice(0, 16),
  );
  check(warnings.length === 1, 'the unreachable failure is logged', warnings);

  // ------------------------------------------------- PLACEHOLDER never presigns
  console.log('\nplaceholder and missing capture');
  warnings = [];
  installFetch(async () => {
    throw new Error('the placeholder must not call fetch');
  });
  const placeholder = await mobileApi.uploadPhoto({ placeholder: true, fileName: 'audits/x.jpg' });
  check(
    placeholder.origin === 'placeholder',
    'a placeholder is marked as a placeholder',
    placeholder.origin,
  );
  check(
    placeholder.photoUrl.startsWith('data:'),
    'the placeholder is an inline data URL',
    placeholder.photoUrl.slice(0, 16),
  );
  check(
    fetchCalls.length === 0,
    'the placeholder never presigns — no network at all',
    fetchCalls.length,
  );

  // ------------------------------------------------- NEITHER: still refused
  let refused: unknown;
  try {
    await mobileApi.uploadPhoto({ fileName: 'audits/x.jpg' });
  } catch (error) {
    refused = error;
  }
  check(
    refused instanceof MobileApiError && (refused as any).code === 'CAPTURE_NOT_AVAILABLE',
    'neither bytes nor placeholder is still refused, unchanged',
    refused,
  );
  check(fetchCalls.length === 0, 'a refused capture makes no request', fetchCalls.length);

  console.warn = origWarn;

  console.log(`\n------------------------------------------------------------`);
  console.log(`  ${passed}/${total} checks passed`);
  console.log(`------------------------------------------------------------\n`);
  if (passed !== total) process.exit(1);
}

main().catch((error) => {
  console.error('\n💥 photo upload suite crashed:', error);
  process.exit(1);
});
