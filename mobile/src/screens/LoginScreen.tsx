import { MobileStore, GPSCoordinates, GeofenceResult } from '../types';
import { verifyStoreGeofence } from '../utils/geofence';
import { mobileSupabase } from '../services/supabaseMobile';

export interface LoginScreenState {
  selectedStore: MobileStore | null;
  storeCodeInput: string;
  userGPS: GPSCoordinates;
  geofenceStatus: GeofenceResult | null;
  errorMessage: string | null;
}

export class LoginScreenController {
  private state: LoginScreenState = {
    selectedStore: null,
    storeCodeInput: 'BRAVO_28MAY_01',
    userGPS: { latitude: 40.37991, longitude: 49.84753, accuracy: 4 }, // ~3m from Bravo 28 Mall
    geofenceStatus: null,
    errorMessage: null,
  };

  getState(): LoginScreenState {
    return { ...this.state };
  }

  setStoreCode(code: string) {
    this.state.storeCodeInput = code;
  }

  setUserLocation(gps: GPSCoordinates) {
    this.state.userGPS = gps;
    if (this.state.selectedStore) {
      this.state.geofenceStatus = verifyStoreGeofence(gps, {
        latitude: this.state.selectedStore.latitude,
        longitude: this.state.selectedStore.longitude,
      });
    }
  }

  async authenticateAndVerifyStore(): Promise<{
    success: boolean;
    store?: MobileStore;
    geofence?: GeofenceResult;
    error?: string;
  }> {
    const store = await mobileSupabase.getStoreByCode(this.state.storeCodeInput);
    if (!store) {
      this.state.errorMessage = '❌ Mağaza kodu tapılmadı!';
      return { success: false, error: this.state.errorMessage };
    }

    this.state.selectedStore = store;
    const geofence = verifyStoreGeofence(this.state.userGPS, {
      latitude: store.latitude,
      longitude: store.longitude,
    });
    this.state.geofenceStatus = geofence;

    if (!geofence.isWithinGeofence) {
      this.state.errorMessage = geofence.message;
      return {
        success: false,
        store,
        geofence,
        error: geofence.message,
      };
    }

    this.state.errorMessage = null;
    return {
      success: true,
      store,
      geofence,
    };
  }
}
