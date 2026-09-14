import { MobileStore, GPSCoordinates, GeofenceResult } from '../types';
import { verifyStoreGeofence } from '../utils/geofence';
import { mobileApi, MobileApiError, deviceId } from '../services/portalApi';

export interface LoginScreenState {
  selectedStore: MobileStore | null;
  storeCodeInput: string;
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
   * Resolves the store, checks the device is really there, and binds the device.
   *
   * The order is deliberate. The geofence is checked BEFORE the bind, because
   * binding claims the store's open work — claiming from a car park would assign
   * a merchandiser tasks they cannot do, and un-claiming is a supervisor action.
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

    // Bind the device, and claim this store's open work in the same call — see
    // mobileApi.bindDevice for why the claim is required rather than optional.
    try {
      const profile = await mobileApi.bindDevice({
        fullName: `Sahə işçisi (${deviceId()})`,
        storeId: store.id,
      });
      this.profileId = profile.id;
      this.claimedTaskCount = profile.claimedTaskIds.length;
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
