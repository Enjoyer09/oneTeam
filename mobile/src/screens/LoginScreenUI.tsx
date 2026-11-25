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
 * error). The screen therefore acquires a fix automatically and only enables
 * the sign-in button once the platform has reported one. A "get location"
 * button would let the worker press it before the fix is ready and see a
 * confusing error.
 *
 * THE FIX IS REAL, AND THAT CHANGED WHAT THIS SCREEN DOES
 * -------------------------------------------------------
 * Until 2026-09-20 this file did not ask the platform for anything. It waited
 * 1.5 seconds and then returned `{ latitude: 40.4093, longitude: 49.8671 }` —
 * the coordinates of the one store the demo was built around. The geofence
 * comparison downstream was therefore comparing the store against itself, and
 * could not fail. The button was enabled by a timer, and the check that the
 * product is sold on ("the worker was really in the shop") verified nothing.
 *
 * `expo-location` was declared in `package.json` the whole time and is compiled
 * into the installed app (see `ios/Podfile.lock`), so nothing had to be built to
 * make this real — only written.
 *
 * The permission is requested on mount rather than behind a button, because the
 * screen has exactly one job and the worker has already opened it to do that
 * job. A refusal is reported as itself: no coordinates are invented, and the
 * sign-in button stays disabled, because a sign-in that cannot prove where it
 * happened is the thing this screen exists to prevent.
 */

import { useState, useCallback, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
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
  Linking,
} from 'react-native';
import * as Location from 'expo-location';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LoginScreenController } from './LoginScreen';
import type { MobileStore, GPSCoordinates } from '../types';
import { palette, spacing, typography } from '../theme';

const LAST_STORE_CODE_KEY = 'oneteam.last-store-code';

export interface LoginScreenProps {
  onLoginSuccess: (result: {
    store: MobileStore;
    tasks: unknown[];
    claimedTaskCount: number;
    /**
     * The fix the geofence was evaluated against.
     *
     * THIS FIELD EXISTS BECAUSE ITS ABSENCE WAS A DEFECT. The payload used to
     * carry only the store, so the real fix died at this boundary — and
     * `Root.tsx` filled the gap with a hardcoded `{40.4093, 49.8671}`, which is
     * the old fake login's coordinates. Every audit photo was therefore stamped
     * with a constant no matter where the worker stood, while the geofence at
     * sign-in was genuinely enforced. Passing the fix on is what makes the
     * stamp in the evidence the position the worker was actually verified at.
     */
    userGPS: GPSCoordinates;
  }) => void;
}

export function LoginScreenUI({ onLoginSuccess }: LoginScreenProps) {
  const insets = useSafeAreaInsets();
  const [controller] = useState(() => new LoginScreenController());
  const [storeCode, setStoreCode] = useState(controller.getState().storeCodeInput);
  const [enrollmentSecret, setEnrollmentSecret] = useState(
    controller.getState().enrollmentSecretInput,
  );
  const [gps, setGps] = useState<GPSCoordinates | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [locating, setLocating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void AsyncStorage.getItem(LAST_STORE_CODE_KEY)
      .then((saved) => {
        if (mounted && saved?.trim()) setStoreCode(saved);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  /**
   * Asks the platform where this device is, and reports every way that can fail
   * as itself.
   *
   * The three failure modes are kept apart on purpose, because they need
   * different actions from the worker: a refused permission is a settings
   * change, a device with location services switched off is a different
   * settings change, and a timeout is worth simply retrying. Collapsing them
   * into "lokasiya alınmadı" would leave the worker with nothing to do.
   */
  const acquireFix = useCallback(async () => {
    setGpsError(null);
    setPermissionDenied(false);
    setLocating(true);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) {
        setGps(null);
        setPermissionDenied(true);
        setGpsError(
          'Lokasiya icazəsi verilməyib. Parametrlər → Gizlilik və Təhlükəsizlik → ' +
            'Məkan Xidmətləri bölməsindən bu tətbiqə icazə verin.',
        );
        return;
      }

      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });

      // The fix is handed to the controller, which is the only thing allowed to
      // decide whether it is good enough to sign in with.
      const fix: GPSCoordinates = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy:
          typeof position.coords.accuracy === 'number' ? position.coords.accuracy : undefined,
        // The platform's mock-location flag (Android). Carried through so a
        // spoofed sign-in fix can be flagged; `undefined` on iOS.
        mocked: typeof position.mocked === 'boolean' ? position.mocked : undefined,
        // `expo-location` reports when the fix was taken. Forwarded so the server can
        // tell a present fix from one replayed hours later — it refuses a submission
        // whose coordinates are older than a few minutes.
        timestamp: typeof position.timestamp === 'number' ? position.timestamp : undefined,
      };
      setGps(fix);
      controller.setUserLocation(fix);
    } catch (cause) {
      setGps(null);
      setGpsError(
        'Lokasiya alına bilmədi: ' +
          (cause instanceof Error ? cause.message : String(cause)) +
          '. Yenidən cəhd edin.',
      );
    } finally {
      setLocating(false);
    }
  }, [controller]);

  const handleLogin = useCallback(async () => {
    setError(null);
    setLoading(true);
    controller.setStoreCode(storeCode);
    controller.setEnrollmentSecret(enrollmentSecret);

    const result = await controller.authenticateAndVerifyStore();
    setLoading(false);

    if (result.success && result.store) {
      void AsyncStorage.setItem(LAST_STORE_CODE_KEY, storeCode.trim()).catch(() => undefined);
      // The sign-in button is already gated on a fix (`canSubmit`), so this is
      // a belt-and-braces check rather than the real guard. It is here because
      // the alternative — inventing a position, or letting the caller invent
      // one — is the defect this whole file was rewritten to remove. There is
      // no fallback coordinate, deliberately.
      if (gps === null) {
        setError('Lokasiya olmadan giriş təsdiqlənmir. Yenidən cəhd edin.');
        return;
      }
      onLoginSuccess({
        store: result.store,
        tasks: [],
        claimedTaskCount: result.claimedTaskCount ?? 0,
        userGPS: gps,
      });
    } else {
      setError(result.error ?? 'Giriş alınmadı');
    }
  }, [controller, storeCode, enrollmentSecret, onLoginSuccess, gps]);

  const canSubmit = gps !== null && storeCode.trim().length > 0 && !loading;

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 40 },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>oneTeam</Text>
        <Text style={styles.subtitle}>oneTeam Retail rəf monitorinqi</Text>

        <View style={styles.card}>
          <Text style={styles.label}>Mağaza kodu</Text>
          <TextInput
            testID="login.storeCodeInput"
            style={styles.input}
            value={storeCode}
            onChangeText={setStoreCode}
            placeholder="Məsələn: BRAVO_YASAMAL_01"
            placeholderTextColor="#4B5563"
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!loading}
          />

          {/* Shown always rather than only when the server complains, because
              the app cannot ask the API whether a secret is required without
              first enrolling — the refusal would arrive after the geofence
              check, as a failed sign-in. An optional field with a one-time
              hint is the honest version of that.

              `secureTextEntry` is deliberate. This is the deployment's second
              factor, and the thing it guards against is a worker photographing
              the screen and installing the app on a second phone. Pasting still
              works, so hiding it costs the operator nothing. */}
          <Text style={styles.label}>Quraşdırma açarı (istəyə bağlı)</Text>
          <TextInput
            testID="login.enrollmentSecretInput"
            style={styles.input}
            value={enrollmentSecret}
            onChangeText={setEnrollmentSecret}
            placeholder="Yalnız ilk quraşdırmada"
            placeholderTextColor="#4B5563"
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            editable={!loading}
          />
          <Text style={styles.fieldHint}>
            Mağazanız açar tələb edirsə, bir dəfə yazın — uğurlu girişdən sonra yadda saxlanılır.
          </Text>

          <Text style={styles.label}>Cihaz lokasiyası</Text>
          <Text style={styles.fieldHint}>
            Mağazada olduğunuzu və auditin düzgün mağazaya aid olduğunu yoxlamaq üçün lokasiya tələb
            olunur.
          </Text>
          {/* One always-present status line, and it carries the `testID`. The UI
              test reads it as a static text, which it can only do if the element
              exists in every state — an element that is present only on success
              makes "still looking" indistinguishable from "the screen is gone". */}
          <View style={styles.gpsRow}>
            {locating ? <ActivityIndicator size="small" color="#0066CC" /> : null}
            <Text
              testID="login.gpsStatus"
              style={gps ? styles.gpsOk : gpsError ? styles.gpsError : styles.gpsLoading}
            >
              {gps
                ? '📍 Lokasiya təsdiqləndi'
                : gpsError
                  ? `❌ ${gpsError}`
                  : 'Lokasiya paylaşılmayıb'}
            </Text>
          </View>
          {gps ? (
            <Text style={styles.gpsDetail}>
              {gps.latitude.toFixed(4)}, {gps.longitude.toFixed(4)}
              {gps.accuracy === undefined ? '' : ` (±${Math.round(gps.accuracy)}m)`}
            </Text>
          ) : null}
          {permissionDenied ? (
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() => {
                void Linking.openSettings();
              }}
              style={[styles.retryButton, { minHeight: 44, justifyContent: 'center' }]}
            >
              <Text style={styles.retryButtonText}>Parametrləri aç</Text>
            </TouchableOpacity>
          ) : null}
          {!gps && !locating ? (
            <TouchableOpacity
              testID="login.retryLocationButton"
              accessibilityRole="button"
              style={styles.retryButton}
              onPress={() => {
                void acquireFix();
              }}
              activeOpacity={0.8}
            >
              <Text style={styles.retryButtonText}>
                {gpsError ? 'Yenidən cəhd et' : 'Lokasiyanı təsdiqlə'}
              </Text>
            </TouchableOpacity>
          ) : null}

          {error ? (
            <Text testID="login.errorText" style={styles.errorText}>
              {error}
            </Text>
          ) : null}

          <TouchableOpacity
            testID="login.submitButton"
            // `accessibilityRole` is what makes XCTest see a button at all.
            // TouchableOpacity forwards the prop but defaults it to nothing, so
            // without this the control is an "other" element and
            // `app.buttons["login.submitButton"]` matches nothing.
            //
            // `accessibilityState` is what makes `isEnabled` mean something:
            // React Native maps `disabled` to UIAccessibilityTraitNotEnabled
            // (React/Views/RCTViewManager.m), which is exactly what XCUI
            // reports as `isEnabled == false`. The UI test asserts on it.
            accessibilityRole="button"
            accessibilityState={{ disabled: !canSubmit }}
            style={[styles.loginButton, !canSubmit && styles.loginButtonDisabled]}
            onPress={() => {
              void handleLogin();
            }}
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
    backgroundColor: palette.background,
  },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: spacing.lg,
  },
  title: {
    fontSize: 32,
    fontWeight: '800',
    color: '#111111',
    textAlign: 'center',
  },
  subtitle: {
    fontSize: typography.secondary,
    color: palette.textSecondary,
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 40,
  },
  card: {
    backgroundColor: palette.surface,
    borderRadius: 16,
    padding: 20,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: palette.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
    marginTop: 16,
  },
  input: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: palette.text,
  },
  fieldHint: {
    marginTop: 6,
    fontSize: 12,
    color: '#666666',
    lineHeight: 17,
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
    color: '#666666',
  },
  gpsLoading: {
    fontSize: 15,
    color: '#666666',
    marginLeft: 8,
  },
  gpsError: {
    fontSize: 15,
    color: '#B00020',
    // The refusal message is a sentence, not a label, and it sits in a row.
    // Without this it is laid out at its intrinsic width and runs off the card.
    flexShrink: 1,
  },
  retryButton: {
    marginTop: 12,
    alignSelf: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#0066CC',
  },
  retryButtonText: {
    fontSize: 14,
    color: '#0066CC',
    fontWeight: '500',
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
    color: '#666666',
    textAlign: 'center',
    lineHeight: 19,
  },
});
