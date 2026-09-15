/**
 * The application shell.
 * ============================================================================
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 * --------------------------------
 * This is the app's root component: the thing Expo boots, that holds the status
 * bar and the safe area, and that later screens will be mounted inside.
 *
 * It is NOT the field UI. The Login, TaskList, TaskDetail, Checklist and Camera
 * screens named in the Phase 3 plan do not exist yet — `mobile/src/screens/*`
 * holds `*Controller` classes with no React in them at all, and there is no JSX,
 * no `react-native` import and no `StyleSheet` anywhere under `mobile/src`. So
 * there is nothing to "preserve unchanged" (plan item 3.5) and nothing to mount
 * yet; those screens have to be written.
 *
 * Rather than ship a screen that looks like a working login and is not one, this
 * shell reports the app's actual state: where it will send its requests, and
 * whether this installation holds a credential. Both are read from the same
 * module the real screens will use, so what is on screen cannot drift from what
 * the app would do.
 *
 * It is deliberately plain. No brand colour is invented here — a guessed hex
 * would be a claim about the brand that nobody checked.
 *
 * WHY THIS FILE SITS AT THE PACKAGE ROOT AND NOT UNDER `src/`
 * -----------------------------------------------------------
 * `mobile/tsconfig.json` includes only the `src` tree, and that include is what
 * `npm run mobile:check` type-checks in CI. This file imports `react-native`,
 * which is not installed — the Expo dependency tree could not be installed in
 * the environment where it was written (see the Phase 3.1 notes in
 * `docs/PRODUCT-PLAN-AZ.md`). Putting it under `src/` would therefore have
 * turned a green check red for a reason that has nothing to do with the code.
 *
 * The cost is real and is recorded rather than hidden: **this file is not
 * type-checked.** Once `npm install` has been run in `mobile/`, add `index.ts`
 * and `Root.tsx` to `include` in `mobile/tsconfig.json` so that it is.
 */

import { StatusBar } from 'expo-status-bar';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { mobileApp } from './src/App';
import { hasDeviceToken } from './src/services/portalApi';

/** One line of the status readout. */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

export function Root() {
  // Read once, at render. Both are module-level facts that do not change while
  // this screen is open — a credential arrives through the login screen, which
  // will remount this tree when it exists.
  const apiTarget = mobileApp.describeApiTarget();
  const enrolled = hasDeviceToken();

  return (
    <View style={styles.screen}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>oneTeam Field Audit</Text>
        <Text style={styles.subtitle}>Coca-Cola rəf monitorinqi — sahə tətbiqi</Text>

        <View style={styles.card}>
          <Row label="API ünvanı" value={apiTarget} />
          <Row label="Cihaz qeydiyyatı" value={enrolled ? 'var' : 'yoxdur'} />
        </View>

        <Text style={styles.note}>
          Bu, tətbiqin karkasıdır. Sahə ekranları — giriş, tapşırıq siyahısı, çeklist və kamera —
          hələ yazılmayıb. Onlar Faza 3.2 və 3.5-də bu qabığın içinə qurulacaq.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  content: {
    padding: 24,
    paddingTop: 72,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#111111',
  },
  subtitle: {
    marginTop: 4,
    fontSize: 14,
    color: '#666666',
  },
  card: {
    marginTop: 24,
    borderWidth: 1,
    borderColor: '#E0E0E0',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 4,
  },
  row: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E0E0E0',
  },
  rowLabel: {
    fontSize: 12,
    color: '#888888',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  rowValue: {
    marginTop: 2,
    fontSize: 15,
    color: '#111111',
  },
  note: {
    marginTop: 24,
    fontSize: 14,
    lineHeight: 21,
    color: '#444444',
  },
});
