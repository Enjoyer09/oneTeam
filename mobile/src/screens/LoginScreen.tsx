import { MobileStore, GPSCoordinates, GeofenceResult } from '../types';
import { verifyStoreGeofence } from '../utils/geofence';
import { mobileApi, MobileApiError, deviceId, enroll } from '../services/portalApi';
import { credentialStore } from '../services/credentialStore';

export interface LoginScreenState {
  selectedStore: MobileStore | null;
  storeCodeInput: string;
  /**
   * The deployment's enrolment second factor, as typed on this screen.
   *
   * WHY IT IS A FIELD AND NOT A BUILD-TIME VALUE
   * -------------------------------------------
   * The API's `enroll` resolves the secret as: an explicit argument, then
   * `credentialStore`, then the environment. Only the second of those can work
   * on a real phone. The environment one cannot: Metro inlines only
   * `EXPO_PUBLIC_*` names, and `ONETEAM_ENROLLMENT_SECRET` deliberately does not
   * have one — it is read through a `process.env` alias, so in a bundle it is
   * `undefined` (measured, not assumed). Baking it in would also mean compiling
   * the deployment's second factor into a downloadable bundle, which is the
   * thing the keychain entry exists to avoid.
   *
   * So the operator types it once, it is stored in the keychain, and later
   * launches leave this empty and still work.
   */
  enrollmentSecretInput: string;
  /**
   * The device's position, or null until the platform reports one.
   *
   * This used to default to a hardcoded pair of coordinates that happened to sit
   * a few metres from the *mock* store. Against the real catalogue that is not a
   * convenience, it is a fabrication: a geofence check compares the position it
   * is given against the store, and a made-up position makes the answer
   * meaningless while looking authoritative.
   *
   * So there is no default. `authenticateAndVerifyStore` refuses to run without
   * a real fix, and the caller must supply one.
   */
  userGPS: GPSCoordinates | null;
  geofenceStatus: GeofenceResult | null;
  errorMessage: string | null;
}

export class LoginScreenController {
  private state: LoginScreenState = {
    selectedStore: null,
    storeCodeInput: 'BRAVO_YASAMAL_01',
    enrollmentSecretInput: '',
    userGPS: null,
    geofenceStatus: null,
    errorMessage: null,
  };

  /** The user row this device was bound to, once the login has succeeded. */
  public profileId: string | null = null;

  /** How many of the store's open tasks this device claimed at login. */
  public claimedTaskCount = 0;

  getState(): LoginScreenState {
    return { ...this.state };
  }

  setStoreCode(code: string) {
    this.state.storeCodeInput = code;
  }

  setEnrollmentSecret(secret: string) {
    this.state.enrollmentSecretInput = secret;
  }

  setUserLocation(gps: GPSCoordinates) {
    this.state.userGPS = gps;

    // Only re-check when the store is known and it actually has coordinates.
    const store = this.state.selectedStore;
    if (store && store.latitude !== null && store.longitude !== null) {
      this.state.geofenceStatus = verifyStoreGeofence(gps, {
        latitude: store.latitude,
        longitude: store.longitude,
      });
    }
  }

  /**
   * Resolves the store, checks the device is really there, and enrols the device.
   *
   * The order is deliberate. The geofence is checked BEFORE enrolling, because
   * enrolling claims the store's open work — claiming from a car park would
   * assign a merchandiser tasks they cannot do, and un-claiming is a supervisor
   * action. Enrolling also issues the credential the rest of the app carries, so
   * this is the one call that must not happen from the wrong place.
   */
  async authenticateAndVerifyStore(): Promise<{
    success: boolean;
    store?: MobileStore;
    geofence?: GeofenceResult;
    claimedTaskCount?: number;
    error?: string;
  }> {
    if (!this.state.userGPS) {
      this.state.errorMessage =
        '📡 Cihazın lokasiyası alınmadı. Zəhmət olmasa lokasiya xidmətini yandırıb yenidən cəhd edin.';
      return { success: false, error: this.state.errorMessage };
    }

    let store: MobileStore | null;
    try {
      store = await mobileApi.getStoreByCode(this.state.storeCodeInput);
    } catch (error) {
      const detail = error instanceof MobileApiError ? error.message : String(error);
      this.state.errorMessage = `❌ Sistemə qoşulmaq mümkün olmadı: ${detail}`;
      return { success: false, error: this.state.errorMessage };
    }

    if (!store) {
      this.state.errorMessage = '❌ Mağaza kodu tapılmadı!';
      return { success: false, error: this.state.errorMessage };
    }

    this.state.selectedStore = store;

    // A store without coordinates cannot be geofenced. Refusing is the only
    // honest option: the alternative is to skip the check and let the audit look
    // verified when nothing was verified.
    if (store.latitude === null || store.longitude === null) {
      this.state.errorMessage =
        `❌ "${store.name}" mağazasının koordinatları sistemdə qeyd olunmayıb.\n\n` +
        `Geolokasiya yoxlaması aparıla bilmədiyi üçün auditə başlamaq mümkün deyil. ` +
        `Zəhmət olmasa nəzarətçinizə məlumat verin.`;
      return { success: false, store, error: this.state.errorMessage };
    }

    const geofence = verifyStoreGeofence(this.state.userGPS, {
      latitude: store.latitude,
      longitude: store.longitude,
    });
    this.state.geofenceStatus = geofence;

    if (!geofence.isWithinGeofence) {
      this.state.errorMessage = geofence.message;
      return { success: false, store, geofence, error: geofence.message };
    }

    // Enrol this installation, which also claims the store's open work — the
    // same single call the chat channel makes, so both channels agree on who may
    // claim what. This is what issues the credential every later request carries;
    // see `mobileApi.enroll`.
    const typedSecret = this.state.enrollmentSecretInput.trim();
    try {
      const enrolled = await enroll({
        storeCode: this.state.storeCodeInput,
        fullName: `Sahə işçisi (${deviceId()})`,
        // Empty means "no secret was typed on this screen" — not "the secret is
        // empty". Passing `''` through would override a keychain entry that a
        // previous installation step had already stored, and turn a working
        // sign-in into a 401 the operator cannot explain.
        ...(typedSecret ? { enrollmentSecret: typedSecret } : {}),
      });
      this.profileId = enrolled.userId;
      this.claimedTaskCount = enrolled.claimedTaskIds.length;

      // Remembered ONLY after the server accepted it. Storing it up front would
      // make a typo permanent: every later launch would replay the wrong value
      // from the keychain, and the operator would have no field left to correct
      // it in — the failure would look like the store code.
      //
      // A storage failure must not fail the sign-in. The device is enrolled
      // either way, so the session is real; the only cost is retyping the secret
      // next launch.
      if (typedSecret) {
        try {
          await credentialStore.saveEnrollmentSecret(typedSecret);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          console.warn(
            `⚠️ [oneTeam Mobile] Qeydiyyat uğurlu oldu, amma quraşdırma açarı ` +
              `yadda saxlanılmadı (${detail}). Bu sessiya işləyəcək; növbəti ` +
              `açılışda açarı yenidən yazmalı olacaqsınız.`,
          );
        }
      }
    } catch (error) {
      const detail = error instanceof MobileApiError ? error.message : String(error);
      this.state.errorMessage = `❌ Qeydiyyat tamamlanmadı: ${detail}`;
      return { success: false, store, geofence, error: this.state.errorMessage };
    }

    this.state.errorMessage = null;
    return {
      success: true,
      store,
      geofence,
      claimedTaskCount: this.claimedTaskCount,
    };
  }
}
