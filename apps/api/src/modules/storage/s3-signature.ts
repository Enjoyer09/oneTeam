/**
 * oneTeam — minimal AWS Signature Version 4 signer for S3 uploads
 * ============================================================================
 *
 * WHY THIS IS HAND-WRITTEN
 * ------------------------
 * The alternative is `@aws-sdk/client-s3`, which brings a large dependency tree
 * into the API image to perform one operation: sign a PUT. This project already
 * declined Prisma for the same reason (`prisma generate` does not work here and
 * a code-generation step is a build-time failure waiting to happen), and the
 * same reasoning applies. What is needed is a deterministic function from
 * (key, body, timestamp) to a set of headers, and that is about a hundred lines
 * of HMAC.
 *
 * The risk of hand-writing a signature is that it is easy to be subtly wrong
 * and impossible to notice — a bad signature is a 403 from a server you cannot
 * see. That risk is handled by testing it against a real S3 implementation
 * (MinIO) rather than by trusting the code, which is why the signer is a pure
 * function with no I/O: it can be exercised directly.
 *
 * WHAT IT SIGNS
 * -------------
 * A single PUT with these signed headers, and no others:
 *
 *     content-type;host;x-amz-content-sha256;x-amz-date
 *
 * Deliberately minimal. Every header added to the signed set must be present
 * and byte-identical on the wire, so each one is a new way to get a 403.
 *
 * References: AWS "Signature Version 4 signing process", and the S3-specific
 * rule that the canonical URI is the path encoded once (not twice), with `/`
 * left as a separator.
 */

import { createHash, createHmac } from 'crypto';

export interface S3Target {
  /** Base endpoint, e.g. `https://s3.eu-central-1.amazonaws.com` or `http://localhost:9000`. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * `http://endpoint/bucket/key` (true) or `http://bucket.endpoint/key` (false).
   *
   * Defaults to true. Every self-hosted and S3-compatible provider this project
   * targets — MinIO, Cloudflare R2, Railway Buckets — accepts path style, and
   * several do not implement virtual-host addressing at all.
   */
  forcePathStyle: boolean;
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * RFC 3986 encoding, which is what AWS specifies and what `encodeURIComponent`
 * only approximates.
 *
 * `encodeURIComponent` leaves `!`, `'`, `(`, `)`, `*` and `~` alone. AWS's
 * unreserved set is `A-Za-z0-9-_.~`, so the other five must be escaped or the
 * signature will not match for any key containing them.
 */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/** Encodes a path, keeping `/` as a separator and encoding each segment. */
function encodePath(path: string): string {
  return path.split('/').map(uriEncode).join('/');
}

function sha256Hex(payload: Buffer | string): string {
  return createHash('sha256').update(payload).digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

/** `20260914T074200Z` — the `x-amz-date` format, and the string-to-sign form. */
function amzDate(now: Date): { full: string; short: string } {
  const full = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { full, short: full.slice(0, 8) };
}

/**
 * Splits an endpoint into the authority to sign and any path prefix to keep.
 *
 * A prefix matters: some providers hand out endpoints like
 * `https://account.r2.cloudflarestorage.com/my-bucket`, where part of the path
 * is fixed. Dropping it would sign the wrong resource.
 */
function parseEndpoint(endpoint: string): {
  scheme: string;
  host: string;
  prefix: string;
} {
  const url = new URL(endpoint);
  return {
    scheme: url.protocol,
    host: url.host,
    prefix: url.pathname.replace(/\/+$/, ''),
  };
}

/**
 * Builds and signs a PUT for one object.
 *
 * `now` is a parameter rather than a call to `new Date()` so the signer stays a
 * pure function and a test can pin the timestamp.
 *
 * WHY THE `Host` HEADER IS SIGNED BUT NOT RETURNED
 * -----------------------------------------------
 * `Host` is a forbidden header in the Fetch standard: `fetch` ignores any
 * attempt to set it, and takes the value from the URL instead. Returning it
 * would therefore have produced a header that is silently dropped, leaving the
 * signature to match or not depending on which HTTP client sent the request.
 *
 * So the URL is built to carry the authority the signature was computed over —
 * `scheme://host/...` in path style, `scheme://bucket.host/...` in virtual-host
 * style — and the two agree by construction.
 */
export function signS3Put(params: {
  target: S3Target;
  key: string;
  body: Buffer;
  contentType: string;
  /**
   * Additional headers to sign and send, e.g. `x-amz-storage-class`.
   *
   * Signing an extra header is not free — it must be sent byte-identical — so
   * this stays empty unless something needs it. It exists because the signer
   * would otherwise be unable to reproduce the published AWS signing examples,
   * and being able to check this code against an official test vector is worth
   * more than the option being unused.
   */
  extraHeaders?: Record<string, string>;
  now?: Date;
}): SignedRequest {
  const { target, key, body, contentType, extraHeaders } = params;
  const now = params.now ?? new Date();

  const { scheme, host, prefix } = parseEndpoint(target.endpoint);
  const encodedKey = encodePath(key);

  const requestHost = target.forcePathStyle ? host : `${target.bucket}.${host}`;
  const path = target.forcePathStyle
    ? `${prefix}/${uriEncode(target.bucket)}/${encodedKey}`
    : `${prefix}/${encodedKey}`;

  const { full, short } = amzDate(now);
  const payloadHash = sha256Hex(body);

  // ---------------------------------------------------------------- canonical
  // Every header that is sent has to be listed here, lowercased, sorted by
  // name, and repeated in `signedHeaders` in that same order. The fixed set is
  // applied last so a caller cannot accidentally shadow the payload hash or the
  // timestamp with a stale value.
  const toSign: Record<string, string> = {};
  for (const [name, value] of Object.entries(extraHeaders ?? {})) {
    toSign[name.toLowerCase()] = normaliseHeaderValue(value);
  }
  toSign['content-type'] = normaliseHeaderValue(contentType);
  toSign['host'] = requestHost;
  toSign['x-amz-content-sha256'] = payloadHash;
  toSign['x-amz-date'] = full;

  const signedHeaderNames = Object.keys(toSign).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${toSign[name]}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalRequest = [
    'PUT',
    path,
    '', // no query string
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  // ------------------------------------------------------------ string to sign
  const scope = `${short}/${target.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', full, scope, sha256Hex(canonicalRequest)].join('\n');

  // -------------------------------------------------------------- signing key
  const signingKey = hmac(
    hmac(hmac(hmac('AWS4' + target.secretAccessKey, short), target.region), 's3'),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  const headers: Record<string, string> = {};
  for (const name of signedHeaderNames) {
    // `host` is carried by the URL; `fetch` refuses to set it. See above.
    if (name !== 'host') headers[name] = toSign[name];
  }
  headers.Authorization =
    `AWS4-HMAC-SHA256 Credential=${target.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { url: `${scheme}//${requestHost}${path}`, headers };
}

export interface PresignedUpload {
  /** The URL a client PUTs the bytes to directly. Carries the signature in its query. */
  url: string;
  /** ISO instant the URL stops being valid. */
  expiresAt: string;
}

/**
 * Builds a presigned PUT URL, so a client uploads the bytes DIRECTLY to the
 * bucket and the API never holds the image.
 *
 * SAME MACHINERY, TWO DIFFERENCES FROM `signS3Put`
 * ------------------------------------------------
 * The canonical request, string-to-sign and signing key are computed exactly as
 * for a header-signed PUT. What changes:
 *
 *   1. The signature travels in the QUERY STRING (`X-Amz-Signature`) rather than
 *      in an `Authorization` header — that is what lets a plain `PUT url` work
 *      with no signing on the client.
 *   2. The payload is signed as the literal `UNSIGNED-PAYLOAD`, because the
 *      bytes are not known when the URL is minted.
 *
 * ONLY `host` IS SIGNED
 * ---------------------
 * `host` is the single signed header. `Content-Type` is deliberately left
 * unsigned: the client may send any body and any content type without having to
 * reproduce a header byte-identically, which removes the most common way a
 * presigned upload earns a silent 403. The bucket still stores whatever
 * `Content-Type` the client sends.
 */
export function signS3PresignedPut(params: {
  target: S3Target;
  key: string;
  expiresSeconds: number;
  now?: Date;
}): PresignedUpload {
  const { target, key, expiresSeconds } = params;
  const now = params.now ?? new Date();

  const { scheme, host, prefix } = parseEndpoint(target.endpoint);
  const encodedKey = encodePath(key);

  const requestHost = target.forcePathStyle ? host : `${target.bucket}.${host}`;
  const path = target.forcePathStyle
    ? `${prefix}/${uriEncode(target.bucket)}/${encodedKey}`
    : `${prefix}/${encodedKey}`;

  const { full, short } = amzDate(now);
  const scope = `${short}/${target.region}/s3/aws4_request`;
  const signedHeaders = 'host';

  // Every query parameter is set BEFORE signing and folded into the canonical
  // query string; `X-Amz-Signature` is the only one appended afterwards.
  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${target.accessKeyId}/${scope}`,
    'X-Amz-Date': full,
    'X-Amz-Expires': String(expiresSeconds),
    'X-Amz-SignedHeaders': signedHeaders,
  };

  // Canonical query string: keys sorted, both name and value RFC-3986 encoded
  // (so the `/`s inside the credential become `%2F`, as the signature expects).
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((name) => `${uriEncode(name)}=${uriEncode(query[name])}`)
    .join('&');

  const canonicalHeaders = `host:${requestHost}\n`;

  const canonicalRequest = [
    'PUT',
    path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = ['AWS4-HMAC-SHA256', full, scope, sha256Hex(canonicalRequest)].join('\n');

  const signingKey = hmac(
    hmac(hmac(hmac('AWS4' + target.secretAccessKey, short), target.region), 's3'),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return {
    url: `${scheme}//${requestHost}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    expiresAt: new Date(now.getTime() + expiresSeconds * 1000).toISOString(),
  };
}

/**
 * The canonical form of a header value.
 *
 * The specification requires leading and trailing whitespace removed and
 * internal runs of whitespace collapsed to one space. Skipping this is a
 * classic source of a signature that is correct for every value the author
 * tried and wrong for the one a client actually sends.
 */
function normaliseHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/**
 * Whether a value looks like an inline image rather than a reference to one.
 *
 * Used to decide whether a photo needs offloading. Checking for the `data:`
 * scheme rather than for an `http` prefix is the safer direction: an
 * unrecognised value is left alone, and the failure mode is "the URL was not
 * offloaded" rather than "the URL was replaced by something else".
 */
export function isInlineDataUrl(value: string): boolean {
  return typeof value === 'string' && value.startsWith('data:');
}

/** Splits `data:image/jpeg;base64,AAAA` into its media type and decoded bytes. */
export function decodeDataUrl(dataUrl: string): { contentType: string; body: Buffer } | null {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) return null;

  const contentType = match[1] || 'application/octet-stream';
  const isBase64 = Boolean(match[2]);
  const payload = match[3] ?? '';

  const body = isBase64
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8');

  if (body.length === 0) return null;
  return { contentType, body };
}
