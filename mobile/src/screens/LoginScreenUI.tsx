/**
 * oneTeam mobile — Login screen (React Native UI)
 * ============================================================================
 *
 * WHAT THIS IS
 * ------------
 * The first screen a field worker sees: enter the store code, get a GPS fix,
 * and sign in. Every business rule lives in `LoginScreenController`; this file
 * only renders the controller's state and calls its methods.
 *
 * WHY THE GPS IS NOT A BUTTON
 * ---------------------------
 * The controller refuses to run without a real fix (`userGPS === null` →
 * error). The screen therefore polls for location automatically and only
 * enables the sign-in button once the platform has reported one. A "get
 * location" button would let the worker press it before the fix is ready and
 * see a confusing error.
 */

import { useEffect, useState, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { LoginScreenController } from './LoginScreen';
import type { MobileStore, GPSCoordinates } from '../types';

export interface LoginScreenProps {
  onLoginSuccess: (result: {
    store: MobileStore;
    tasks: unknown[];
    claimedTaskCount: number;
  }) => void;
}

export function LoginScreenUI({ onLoginSuccess }: LoginScreenProps) {
  const [controller] = useState(() => new LoginScreenController());
  const [storeCode, setStoreCode] = useState(controller.getState().storeCodeInput);
  const [gps, setGps] = useState<GPSCoordinates | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Poll for GPS. In a shipping build this uses expo-location; here we
  // simulate a fix after a short delay so the screen is testable.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      // Simulated fix — in production, replace with Location.getCurrentPositionAsync
      const simulated: GPSCoordinates = {
        latitude: 40.4093,
        longitude: 49.8671,
        accuracy: 10,
      };
      setGps(simulated);
      controller.setUserLocation(simulated);
    }, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [controller]);

  const handleLogin = useCallback(async () => {
    setError(null);
    setLoading(true);
    controller.setStoreCode(storeCode);

    const result = await controller.authenticateAndVerifyStore();
    setLoading(false);

    if (result.success && result.store) {
      onLoginSuccess({
        store: result.store,
        tasks: [],
        claimedTaskCount: result.claimedTaskCount ?? 0,
      });
    } else {
      setError(result.error ?? 'Giriş alınmadı');
    }
  }, [controller, storeCode, onLoginSuccess]);

  const canSubmit = gps !== null && storeCode.trim().length > 0 && !loading;

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>oneTeam</Text>
        <Text style={styles.subtitle}>Coca-Cola rəf monitorinqi</Text>

        <View style={styles.card}>
          <Text style={styles.label}>Mağaza kodu</Text>
          <TextInput
            style={styles.input}
            value={storeCode}
            onChangeText={setStoreCode}
            placeholder="Məsələn: BRAVO_YASAMAL_01"
            placeholderTextColor="#AAAAAA"
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!loading}
          />

          <Text style={styles.label}>Cihaz lokasiyası</Text>
          {gps ? (
            <View style={styles.gpsRow}>
              <Text style={styles.gpsOk}>📍 Lokasiya alındı</Text>
              <Text style={styles.gpsDetail}>
                {gps.latitude.toFixed(4)}, {gps.longitude.toFixed(4)} (±{gps.accuracy ?? '?'}m)
              </Text>
            </View>
          ) : gpsError ? (
            <Text style={styles.gpsError}>❌ {gpsError}</Text>
          ) : (
            <View style={styles.gpsRow}>
              <ActivityIndicator size="small" color="#0066CC" />
              <Text style={styles.gpsLoading}>Lokasiya axtarılır…</Text>
            </View>
          )}

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          <TouchableOpacity
            style={[styles.loginButton, !canSubmit && styles.loginButtonDisabled]}
            onPress={handleLogin}
            disabled={!canSubmit}
            activeOpacity={0.8}
          >
            {loading ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.loginButtonText}>Daxil ol</Text>
            )}
          </TouchableOpacity>
        </View>

        <Text style={styles.hint}>
          Mağaza kodunuz yoxdursa, zəhmət olmasa nəzarətçinizlə əlaqə saxlayın.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 24,
    paddingTop: 80,
    paddingBottom: 40,
  },
  title: {
    fontSize: 32,
    fontWeight: '800',
    color: '#111111',
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 15,
    color: '#666666',
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 40,
  },
  card: {
    backgroundColor: '#F8F8F8',
    borderRadius: 16,
    padding: 20,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: '#555555',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
    marginTop: 16,
  },
  input: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E0E0E0',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: '#111111',
  },
  gpsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  gpsOk: {
    fontSize: 15,
    color: '#2E7D32',
    fontWeight: '500',
  },
  gpsDetail: {
    fontSize: 13,
    color: '#888888',
  },
  gpsLoading: {
    fontSize: 15,
    color: '#666666',
    marginLeft: 8,
  },
  gpsError: {
    fontSize: 15,
    color: '#B00020',
  },
  errorText: {
    marginTop: 16,
    fontSize: 14,
    color: '#B00020',
    lineHeight: 20,
    textAlign: 'center',
  },
  loginButton: {
    marginTop: 24,
    backgroundColor: '#0066CC',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  loginButtonDisabled: {
    backgroundColor: '#CCCCCC',
  },
  loginButtonText: {
    fontSize: 17,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  hint: {
    marginTop: 20,
    fontSize: 13,
    color: '#888888',
    textAlign: 'center',
    lineHeight: 19,
  },
});
