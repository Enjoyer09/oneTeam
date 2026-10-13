/**
 * oneTeam mobile field client — the credential policy
 * ============================================================================
 *
 * WHAT WAS WRONG
 * --------------
 * This client had no storage layer at all, and it said so. Two consequences
 * followed from that, and only one of them was visible.
 *
 * The visible one: the device token lived in a module-level variable, so it was
 * gone on every process start and the app enrolled again every launch. The API
 * answers that by revoking the installation's previous live token and issuing a
 * new one — one `device_tokens` row per launch, and the device is a different
 * credential every time it opens.
 *
 * The invisible one is worse. `deviceId()` fell back to the literal string
 * `demo-device-01` when nothing was configured:
 *
 *     return (env.ONETEAM_DEVICE_ID || 'demo-device-01').trim();
 *
 * The API keys both the user row and the credential on that value, and the
 * schema allows exactly ONE live token per `device_id`
 * (`device_tokens_active_device_idx`). So every unconfigured installation in a
 * deployment was the same device: they shared one user row, one audit history,
 * and — because each enrolment revokes the previous live token for that
 * `device_id` — **each phone silently signed the others out.** A merchandiser
 * enrolling would cut off the colleague standing next to them.
 *
 * It also meant `getSubmissionsForStore` asked for "the audits this device has
 * filed" and received every device's audits, because every device was the same
 * device.
 *
 * WHAT THIS FILE DOES
 * -------------------
 * Mints an installation identity once and keeps it, and keeps the credential
 * the API issued to that identity. The identity is the part that must never
 * change; the credential is expected to be replaced whenever the device enrols,
 * because the API revokes the old one as it issues the new one.
 *
 * WHY THE STORAGE IS AN INTERFACE
 * -------------------------------
 * The policy above is the part worth testing, and it cannot be tested on a
 * device from here. So the policy takes a `SecureKeyValueStore` and the platform
 * supplies one: `keychain.ts` for the app, `MemorySecureStore` for tests and for
 * the Node harness. That keeps every rule in this file — mint once, persist
 * before use, replace on enrolment, survive a local-data clear — reachable by a
 * test that runs without a phone.
 */

/** The seam between this policy and the platform. */
export interface SecureKeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/**
 * Storage that forgets everything when the process ends.
 *
 * The default, deliberately. A build that never wires the keychain still works
 * — it behaves exactly as the app did before this file existed — and a test can
 * drive the whole policy without a device.
 */
export class MemorySecureStore implements SecureKeyValueStore {
  private readonly values = new Map<string, string>();

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory double for the Promise-returning SecureKeyValueStore interface.
  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory double for the Promise-returning SecureKeyValueStore interface.
  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory double for the Promise-returning SecureKeyValueStore interface.
  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

/**
 * Where the installation identity is kept.
 *
 * Namespaced, because a keychain is shared by everything the app stores and a
 * bare `deviceToken` would collide with any future library that picks the same
 * word.
 */
export const DEVICE_ID_KEY = 'oneteam.deviceId';
export const DEVICE_TOKEN_KEY = 'oneteam.deviceToken';
export const ENROLLMENT_SECRET_KEY = 'oneteam.enrollmentSecret';

/**
 * A fresh installation identity.
 *
 * NOT drawn from a cryptographic source, and that is a deliberate choice rather
 * than an oversight. This value is an IDENTIFIER, not a secret: the API treats
 * it as a name to hang a user row on, and the thing that actually authenticates
 * is the token, which is 32 random bytes generated server-side. What this needs
 * is to be unique across installations and stable over time, not to be
 * unpredictable.
 *
 * Said plainly because the opposite claim would be easy to make here and would
 * be false. If this value ever becomes a secret, it needs `expo-crypto`.
 *
 * The timestamp is in the name so a support conversation can tell when an
 * installation first appeared without a database query.
 */
export function mintDeviceId(): string {
  const stamp = Date.now().toString(36);
  const noise = Array.from({ length: 4 }, () =>
    Math.floor(Math.random() * 0x100000000).toString(36),
  ).join('');
  return `dev-${stamp}-${noise}`;
}

export interface CredentialSnapshot {
  deviceId: string;
  hasToken: boolean;
  hasEnrollmentSecret: boolean;
}

/**
 * The installation's identity and the credential issued for it.
 *
 * One instance is exported at the bottom of this file; the app swaps its
 * storage for the keychain at startup and every other caller uses the singleton.
 */
export class CredentialStore {
  private storage: SecureKeyValueStore;
  private readonly mint: () => string;

  /**
   * The in-flight or settled identity lookup.
   *
   * Cached as a PROMISE, not as a value, and that matters: `deviceId()` is
   * awaited from several call sites and two of them can overlap on a cold start.
   * Caching the resolved string would let both callers miss the cache, mint an
   * identity each, and write them in whichever order they finished — leaving the
   * device with one id in storage and the other in memory, which is exactly the
   * split identity this file exists to prevent.
   */
  private identity: Promise<string> | null = null;

  constructor(storage: SecureKeyValueStore, mint: () => string = mintDeviceId) {
    this.storage = storage;
    this.mint = mint;
  }

  /**
   * Points the store at a different backing store.
   *
   * Called once by the app entry with the keychain. The cached identity is
   * dropped, because it was read from the previous storage and would otherwise
   * be returned without ever consulting the new one.
   */
  useStorage(storage: SecureKeyValueStore): void {
    this.storage = storage;
    this.identity = null;
  }

  /**
   * This installation's identity, minted on first use and then never changed.
   *
   * Persisted BEFORE it is returned. A mint that is only in memory is a mint
   * that happens again after the next crash — and a device that changes identity
   * loses its task history and, on the API side, looks like a new installation
   * every time, which spends the store's new-device budget.
   */
  async deviceId(): Promise<string> {
    if (!this.identity) {
      this.identity = this.resolveDeviceId().catch((error) => {
        // Do not cache a failure. A transient keychain error would otherwise
        // pin this installation to a broken identity for the life of the
        // process, and every later call would report the first failure.
        this.identity = null;
        throw error;
      });
    }
    return this.identity;
  }

  private async resolveDeviceId(): Promise<string> {
    const stored = (await this.storage.get(DEVICE_ID_KEY))?.trim();
    if (stored) return stored;

    const minted = this.mint();
    await this.storage.set(DEVICE_ID_KEY, minted);
    return minted;
  }

  /** The credential the API issued to this installation, or null. */
  async deviceToken(): Promise<string | null> {
    const token = (await this.storage.get(DEVICE_TOKEN_KEY))?.trim();
    return token ? token : null;
  }

  /**
   * Records the credential that has just been issued.
   *
   * MUST be called after every successful enrolment, not only the first. The API
   * revokes the installation's previous live token as it issues a new one, so a
   * device that enrols and keeps the old value is holding a credential that has
   * already stopped working.
   */
  async saveDeviceToken(token: string): Promise<void> {
    const trimmed = token.trim();
    if (!trimmed) {
      throw new Error('Refusing to store an empty device token.');
    }
    await this.storage.set(DEVICE_TOKEN_KEY, trimmed);
  }

  /**
   * Forgets the credential, and keeps the identity.
   *
   * The split is the point. Losing the token costs one enrolment; losing the
   * identity costs the device's whole audit history and spends the store's
   * new-device allowance. So a credential that has been revoked — a 401, or an
   * operator cutting the device off — is cleared with this, and the next
   * enrolment comes back as the same device.
   */
  async clearDeviceToken(): Promise<void> {
    await this.storage.remove(DEVICE_TOKEN_KEY);
  }

  /**
   * The deployment's enrolment second factor, if one was entered.
   *
   * Kept here rather than baked into the bundle. It has to be somewhere, because
   * the app cannot enrol without it, and a keychain entry is strictly better
   * than a string compiled into a downloadable IPA: the same secret, not
   * extractable from the binary, and replaceable without a new build.
   */
  async enrollmentSecret(): Promise<string | null> {
    const secret = (await this.storage.get(ENROLLMENT_SECRET_KEY))?.trim();
    return secret ? secret : null;
  }

  async saveEnrollmentSecret(secret: string): Promise<void> {
    const trimmed = secret.trim();
    if (!trimmed) {
      throw new Error('Refusing to store an empty enrolment secret.');
    }
    await this.storage.set(ENROLLMENT_SECRET_KEY, trimmed);
  }

  /**
   * What this installation currently holds, for a startup log or a test.
   *
   * Never returns the token or the secret themselves — only whether they are
   * there. A diagnostic that prints a credential is a credential leak with a
   * friendly name.
   */
  async snapshot(): Promise<CredentialSnapshot> {
    return {
      deviceId: await this.deviceId(),
      hasToken: (await this.deviceToken()) !== null,
      hasEnrollmentSecret: (await this.enrollmentSecret()) !== null,
    };
  }
}

/**
 * The installation this app is running as.
 *
 * Backed by `MemorySecureStore` until `keychain.ts` is wired in at startup, so
 * importing this module never fails and never touches a native API.
 */
export const credentialStore = new CredentialStore(new MemorySecureStore());
