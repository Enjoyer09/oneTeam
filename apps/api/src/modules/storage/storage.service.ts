/**
 * oneTeam — where field photos are kept
 * ============================================================================
 *
 * THE PROBLEM
 * -----------
 * There is no object store in this project, so a shelf photo travels as a
 * `data:` URL and is written into `task_evidences.photo_url` — the image itself,
 * base64, inside a database row. Telegram compresses a field photo to roughly
 * 50–150 KB, so the flow works today, and a hard cap of 1.5 MB stops it growing
 * without bound.
 *
 * It is the wrong shape for the business this is built for. At a thousand
 * stores submitting daily, every database backup carries every photo, and a
 * `SELECT *` on `task_evidences` drags megabytes through the connection. The
 * photos are also the only part of the record that is not text, which makes
 * them the only part that cannot be queried, indexed, or moved.
 *
 * WHAT THIS DOES
 * --------------
 * Two drivers behind one interface, chosen by `STORAGE_DRIVER`:
 *
 *   `inline`  (default) — behaviour is exactly what it was: the data URL is
 *            stored as it arrived. The default, because a storage driver that
 *            silently changes where data lives is worse than no driver, and
 *            because an unconfigured deployment must keep working.
 *
 *   `s3`      — the bytes are uploaded to any S3-compatible bucket (Railway
 *            Buckets, Cloudflare R2, MinIO, AWS S3) and only the resulting URL
 *            is stored.
 *
 * WHY THE CLIENTS DID NOT HAVE TO CHANGE
 * --------------------------------------
 * Offloading happens inside `submitSubmission`, on the value the client already
 * sends. The bot and the mobile app keep posting a data URL; the API decides
 * where it ends up. That was a deliberate choice over adding an upload step to
 * both clients: it closes the storage gap for every existing channel at once,
 * it cannot be skipped by a client that forgets to call the new endpoint, and
 * it leaves the `photo_url` column meaning the same thing in both modes — a
 * URL that resolves to the image.
 *
 * `POST /api/portal/field/photos` exists as well, for a client that would
 * rather not push megabytes through the API twice. It is an optimisation, not a
 * requirement.
 *
 * FAILURE IS LOUD, NOT FATAL
 * --------------------------
 * If an upload fails, the submission is refused rather than quietly stored
 * inline. Falling back would mean the operator who configured a bucket
 * believing photos are in it, and finding out otherwise much later — and the
 * evidence row is not yet written at that point, so refusing costs the field
 * worker one retry and costs the audit trail nothing.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  S3Target,
  decodeDataUrl,
  isInlineDataUrl,
  signS3Put,
  signS3PresignedPut,
} from './s3-signature';

export type StorageDriver = 'inline' | 's3';

export interface StoredPhoto {
  /** What to write into `task_evidences.photo_url`. */
  url: string;
  /** `inline` when the data URL was kept, `s3` when it was offloaded. */
  driver: StorageDriver;
  bytes: number;
  key?: string;
}

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

  private readonly driver: StorageDriver;
  private readonly target: S3Target | null;
  /** Public base URL for reading objects back, when it differs from the API endpoint. */
  private readonly publicBaseUrl: string | null;
  /** Why the driver is what it is — reported through /api/health. */
  private readonly reason: string;
  /** How long a presigned upload URL stays valid, in seconds. */
  private readonly presignExpirySeconds: number;

  constructor() {
    // Assigned first, so both the inline early-return and the s3 path have it.
    this.presignExpirySeconds = resolvePresignExpiry(process.env.S3_PRESIGN_EXPIRY_SECONDS);

    const requested = (process.env.STORAGE_DRIVER || 'inline').trim().toLowerCase();

    if (requested !== 's3') {
      this.driver = 'inline';
      this.target = null;
      this.publicBaseUrl = null;
      this.reason =
        'STORAGE_DRIVER is not "s3" — photos are stored inline in the database as data URLs.';
      return;
    }

    const missing = ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].filter(
      (name) => !process.env[name]?.trim(),
    );

    if (missing.length > 0) {
      // Refusing to guess is the point. Half-configured storage that silently
      // degrades to inline is exactly how an operator comes to believe photos
      // are in a bucket when they are in a table.
      this.driver = 'inline';
      this.target = null;
      this.publicBaseUrl = null;
      this.reason =
        `STORAGE_DRIVER=s3 but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} ` +
        'not set — falling back to inline storage. Photos are NOT being uploaded.';
      this.logger.error('⛔ [STORAGE] ' + this.reason);
      return;
    }

    this.driver = 's3';
    this.target = {
      endpoint: (process.env.S3_ENDPOINT || 'https://s3.amazonaws.com').trim(),
      region: (process.env.S3_REGION || 'us-east-1').trim(),
      bucket: process.env.S3_BUCKET!.trim(),
      accessKeyId: process.env.S3_ACCESS_KEY_ID!.trim(),
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!.trim(),
      // Path style by default: every S3-compatible provider this targets
      // accepts it, and several implement nothing else.
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== '0',
    };
    this.publicBaseUrl = (process.env.S3_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '') || null;
    this.reason = `s3 — bucket "${this.target.bucket}" at ${this.target.endpoint}`;
    this.logger.log('🗄️  [STORAGE] ' + this.reason);
  }

  /** One line describing where photos go. Surfaced through /api/health. */
  get description(): { driver: StorageDriver; detail: string } {
    return { driver: this.driver, detail: this.reason };
  }

  /**
   * The URL an object is readable at.
   *
   * `S3_PUBLIC_BASE_URL` wins when set, because the endpoint used for uploads
   * is frequently not the host that serves reads — Railway Buckets and R2 both
   * hand out a separate public domain or a CDN in front of the bucket.
   */
  private publicUrlFor(key: string): string {
    if (this.publicBaseUrl) return `${this.publicBaseUrl}/${key}`;
    if (!this.target) return key;

    const base = this.target.endpoint.replace(/\/+$/, '');
    return this.target.forcePathStyle
      ? `${base}/${this.target.bucket}/${key}`
      : `${base.replace('://', `://${this.target.bucket}.`)}/${key}`;
  }

  /**
   * Uploads one object and returns its URL.
   *
   * Uses `fetch` rather than an S3 client library — see s3-signature.ts for why
   * the signer is hand-written. `fetch` is global on Node 22, so this adds no
   * dependency at all.
   */
  async upload(params: {
    key: string;
    body: Buffer;
    contentType: string;
  }): Promise<{ url: string; key: string }> {
    if (!this.target) {
      throw new Error('Storage is not configured for uploads (STORAGE_DRIVER is not "s3").');
    }

    const signed = signS3Put({
      target: this.target,
      key: params.key,
      body: params.body,
      contentType: params.contentType,
    });

    const response = await fetch(signed.url, {
      method: 'PUT',
      headers: signed.headers,
      body: new Uint8Array(params.body),
    });

    if (!response.ok) {
      // The body carries the S3 error code, which is the only thing that says
      // whether this is a credential problem, a bucket that does not exist, or
      // a signature mismatch. Dropping it would leave "upload failed".
      const detail = await response.text().catch(() => '');
      throw new Error(
        `S3 upload failed with HTTP ${response.status} for key "${params.key}"` +
          (detail ? `: ${detail.slice(0, 500)}` : ''),
      );
    }

    return { url: this.publicUrlFor(params.key), key: params.key };
  }

  /**
   * Uploads base64 that arrived on its own, rather than inside a submission.
   *
   * Shares `mintKey` with `persistPhoto` so that both entry points produce the
   * same shape of key. They did not, at first: this path built its own name and
   * omitted the file extension, so the same image was stored as `.png` through a
   * submission and with no extension through a direct upload — which is exactly
   * the sort of inconsistency that only shows up when something downstream
   * decides how to serve the object.
   */
  async uploadBase64(params: {
    base64: string;
    contentType: string;
    scope?: string;
  }): Promise<{ url: string; key: string; bytes: number }> {
    const body = Buffer.from(params.base64.replace(/^data:[^,]*,/, ''), 'base64');
    if (body.length === 0) {
      throw new Error('The uploaded photo was empty after decoding.');
    }

    const key = this.mintKey(params.scope, params.contentType);
    const uploaded = await this.upload({ key, body, contentType: params.contentType });

    return { url: uploaded.url, key: uploaded.key, bytes: body.length };
  }

  /**
   * Turns whatever a client sent into what should be stored.
   *
   * The single decision point for photo storage, so that every channel — bot,
   * mobile, and any future one — is offloaded by the same rule rather than by
   * each client remembering to.
   *
   * A value that is already a URL, or that cannot be decoded, is returned
   * unchanged. That is the safe direction: the worst outcome is a photo stored
   * inline that could have been offloaded, never a photo replaced by something
   * that is not it.
   */
  async persistPhoto(params: {
    value: string;
    /** Namespaces the object key, so a task's photos are findable together. */
    scope?: string;
  }): Promise<StoredPhoto> {
    const { value, scope } = params;

    if (!isInlineDataUrl(value)) {
      // A value that is already a URL is returned unchanged — but only if it is
      // OUR url.
      //
      // This method is called from `field.service.ts` with a CLIENT-SUPPLIED
      // value, and the result is written straight into `task_evidences.photo_url`.
      // `/photos/presign` mints the key server-side, so a caller cannot choose a
      // path or overwrite a sibling object — but the client then hands the URL
      // back to us, and until now nothing checked where it came from. So a
      // merchandiser could skip the upload entirely and submit
      // `https://cdn.example/x.png`, leaving an auditor to review an image from
      // anywhere on the internet as a shelf-compliance record. That is
      // substitution: the record stops being evidence that anyone was in the
      // store.
      //
      // `ownsPublicUrl` has existed, and has had this exact job described in its
      // own doc comment, for the whole life of the presigned flow. It had no
      // caller. This is that call site.
      //
      // `data:` values are untouched below: with no bucket configured, storing an
      // inline image in `photo_url` is the supported behaviour, and refusing it
      // would break every non-S3 deployment. Only a value that CLAIMS to be
      // remote is a claim about where the bytes live, and only that is checked.
      if (!this.ownsPublicUrl(value)) {
        throw new Error(
          `Refusing to record a photo at ${value.slice(0, 120)} — it is not a URL from ` +
            'our own bucket. Upload the photo through POST /api/field/photos/presign, ' +
            'or send it inline as a data: URL.',
        );
      }
      return { url: value, driver: this.driver, bytes: 0 };
    }

    if (this.driver !== 's3') {
      return { url: value, driver: 'inline', bytes: value.length };
    }

    const decoded = decodeDataUrl(value);
    if (!decoded) {
      this.logger.warn(
        '⚠️  [STORAGE] A value began with "data:" but could not be decoded; ' +
          'storing it unchanged.',
      );
      return { url: value, driver: 'inline', bytes: value.length };
    }

    const key = this.mintKey(scope, decoded.contentType);
    const uploaded = await this.upload({
      key,
      body: decoded.body,
      contentType: decoded.contentType,
    });

    this.logger.log(
      `⬆️  [STORAGE] Offloaded ${Math.round(decoded.body.length / 1024)} KB to ${uploaded.key}`,
    );

    return {
      url: uploaded.url,
      driver: 's3',
      bytes: decoded.body.length,
      key: uploaded.key,
    };
  }

  /**
   * Mints a presigned PUT URL so a client uploads the bytes DIRECTLY to the
   * bucket, and the API never proxies the image (see
   * docs/PRESIGNED-UPLOAD-PLAN-AZ.md).
   *
   * The key is minted HERE, not chosen by the caller: a client that could name
   * its own key could overwrite another object. The caller submits the returned
   * `publicUrl` afterwards, which `ownsPublicUrl` can then verify belongs to us.
   */
  createPresignedUpload(params: { contentType: string; scope?: string; expiresSeconds?: number }): {
    uploadUrl: string;
    publicUrl: string;
    key: string;
    expiresAt: string;
    requiredHeaders: Record<string, string>;
  } {
    if (!this.target) {
      throw new Error('Storage is not configured for uploads (STORAGE_DRIVER is not "s3").');
    }

    const contentType = params.contentType?.trim() || 'image/jpeg';
    const key = this.mintKey(params.scope, contentType);
    const { url, expiresAt } = signS3PresignedPut({
      target: this.target,
      key,
      expiresSeconds: params.expiresSeconds ?? this.presignExpirySeconds,
    });

    return {
      uploadUrl: url,
      publicUrl: this.publicUrlFor(key),
      key,
      expiresAt,
      // `host` is the only signed header, so the client just sends the bytes.
      // `Content-Type` is unsigned and stored by the bucket as sent.
      requiredHeaders: { 'Content-Type': contentType },
    };
  }

  /**
   * Whether a URL points into our own bucket.
   *
   * The guard for accepting a client-supplied `photoUrl` once clients upload
   * directly: a client that presigned then submits sends a URL we minted, so it
   * must start with the same public base the upload path produces; an arbitrary
   * external URL does not and can be refused. Compared against `publicUrlFor('')`
   * so it can never drift from how upload URLs are actually built.
   */
  ownsPublicUrl(url: string): boolean {
    if (typeof url !== 'string' || !url) return false;
    if (!this.target && !this.publicBaseUrl) return false;
    const prefix = this.publicUrlFor('');
    return prefix.length > 0 && url.startsWith(prefix);
  }

  /**
   * Builds an object key: optional scope, a sortable timestamp, a random suffix,
   * and the extension implied by the media type.
   *
   * The random suffix is not decoration. A timestamp alone collides when two
   * photos of the same task are submitted in the same millisecond, and S3
   * overwrites silently — so the second submission would replace the first with
   * no error and no trace.
   */
  private mintKey(scope: string | undefined, contentType: string): string {
    const clean = (scope ?? '').replace(/^\/+|\/+$/g, '');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const random = Math.random().toString(36).slice(2, 10);
    return `${clean ? clean + '/' : ''}${stamp}-${random}${extensionFor(contentType)}`;
  }
}

/**
 * File extension for a media type.
 *
 * Falls back to `.bin` rather than to `.jpg`: guessing that an unknown type is
 * a JPEG is how a PNG ends up served as a JPEG and renders as a broken image.
 */
function extensionFor(contentType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/heic': '.heic',
    'image/gif': '.gif',
  };
  return map[contentType.toLowerCase()] ?? '.bin';
}

/**
 * Presigned URL lifetime, in seconds, from `S3_PRESIGN_EXPIRY_SECONDS`.
 *
 * Defaults to 5 minutes and is clamped to a sane band: long enough for a slow
 * mobile connection to finish a PUT, short enough that a leaked URL is useless
 * quickly. SigV4 itself allows up to 7 days; nothing here needs that.
 */
function resolvePresignExpiry(raw: string | undefined): number {
  const parsed = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(parsed)) return 300;
  return Math.min(3600, Math.max(30, parsed));
}
