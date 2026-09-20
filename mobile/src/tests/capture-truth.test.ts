/**
 * oneTeam mobile field client — the capture must not be able to lie
 * ============================================================================
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * Measured on 2026-09-20, this repository contained a shelf-audit product in
 * which nobody could take a photo and the "where was this taken?" check could
 * not fail:
 *
 *   - `CameraAuditScreenUI.tsx` drew a dark rectangle where the camera should
 *     have been, under a comment saying `expo-camera` "is not installed yet".
 *     It was installed, declared in `package.json`, listed as a plugin in
 *     `app.json`, and compiled into the app (`ios/Podfile.lock` lists
 *     ExpoCamera 57.0.5 and ExpoLocation 57.0.18).
 *   - `LoginScreenUI.tsx` waited 1.5 seconds and then returned
 *     `{ latitude: 40.4093, longitude: 49.8671 }` — the coordinates of the one
 *     store the demo was built around. The 100 m geofence downstream was
 *     therefore comparing that store against itself.
 *
 * A THIRD fake turned up while these two were being verified, one layer down
 * and the same family: the ghost overlay. The toggle was real, the badge was
 * real, and `ghost_overlay_used: true` was written into every audit — but
 * `task.reference_image_url` was never drawn. The planogram reference, which is
 * the whole reason a "smart camera" exists, was never on screen. So the
 * evidence asserted a comparison the worker had not been offered.
 *
 * None of the three was a crash. All three survived a green test suite, a
 * working demo and a shipping build. What they had in common is that nothing
 * anywhere asked the question "did this really happen?".
 *
 * So this suite asks it in two halves, because each of these fakes had the same
 * two halves:
 *
 *   PART A — the contract. `CameraAuditController.captureLiveAudit` must report
 *   `simulated: true` when it has no bytes and `false` when it does, and the
 *   stamp it returns must carry the CALLER'S fix. `simulated` is derived from
 *   the bytes and from nothing else, so it cannot drift back to a timer.
 *
 *   PART B — the wiring. A contract nobody calls proves nothing. Part B reads
 *   the two screens out of the tree and asserts they really import the camera,
 *   really ask `takePictureAsync` for base64, really hand those bytes to the
 *   controller, really ask the platform for a position instead of naming one,
 *   and really draw the planogram reference. This is the half that would have
 *   caught the actual defect — and it is the half that caught the third one.
 *
 * WHY PART B READS SOURCE INSTEAD OF RENDERING
 * --------------------------------------------
 * There is no React renderer in this process, and adding one would not help:
 * `expo-camera` is a native module and returns nothing in Node. The failure
 * being guarded against is not "the component rendered wrong" — it is "the
 * screen was never wired to a camera at all", which is a fact about the text.
 * Reading the text is the honest way to check a fact about the text.
 *
 * The comments are STRIPPED before every assertion, and that is load-bearing.
 * The header of `CameraAuditScreenUI.tsx` explains the fix and therefore
 * contains the words `expo-camera`, `takePictureAsync` and `base64: true`. A
 * guard that grepped the raw file would pass on its own documentation — it
 * would certify the comment, not the code. `selfTest` below includes a case
 * that puts those words ONLY in a comment and requires the guard to fail.
 *
 * WHAT THIS CANNOT TELL YOU
 * -------------------------
 * That the phone's camera works. Nothing here has run on a device, and no
 * bytes have been through a sensor. What is proven is that the code asks for
 * real bytes and refuses to pretend when it does not get them.
 *
 * Run with: `npm run test:capture`
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CameraAuditController } from '../screens/CameraAuditScreen';
import { assertLiveCameraCapture } from '../components/SmartCameraOverlay';
import type { MobileStore, MobileTask, GPSCoordinates } from '../types';

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
};

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++;
    console.log(`  ${colors.green}✅ [PASS]${colors.reset} ${label}`);
  } else {
    failed++;
    console.log(`  ${colors.red}❌ [FAIL]${colors.reset} ${label}`);
    if (detail !== undefined) {
      console.log(
        `         ${colors.yellow}got:${colors.reset} ${JSON.stringify(detail)?.slice(0, 400)}`,
      );
    }
  }
}

function section(title: string) {
  console.log(`\n${colors.cyan}${colors.bright}${title}${colors.reset}`);
}

/** Runs `fn` and returns the error it threw, or null if it did not throw. */
function caught(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

// ===========================================================================
// The tree, located relative to this file rather than to the shell's cwd.
// `mobile/src/tests/` -> `../../..` is the repository root.
// ===========================================================================
const REPO_ROOT = join(__dirname, '..', '..', '..');

const SCREEN_DIR = join(REPO_ROOT, 'mobile', 'src', 'screens');
const CAMERA_SCREEN_PATH = join(SCREEN_DIR, 'CameraAuditScreenUI.tsx');
const LOGIN_SCREEN_PATH = join(SCREEN_DIR, 'LoginScreenUI.tsx');
const PACKAGE_JSON_PATH = join(REPO_ROOT, 'mobile', 'package.json');
const APP_JSON_PATH = join(REPO_ROOT, 'mobile', 'app.json');

// ---------------------------------------------------------------------------
// Part A fixtures.
// ---------------------------------------------------------------------------

const STORE_LAT = 40.385012;
const STORE_LON = 49.810541;

/**
 * The device's position, deliberately NOT the store's.
 *
 * Roughly 11 m away: inside the 100 m geofence, but distinguishable from the
 * store's own coordinates. If the stamp ever echoed the store's position back
 * instead of the caller's, this is what would notice.
 */
const USER_LAT = 40.3851;
const USER_LON = 49.8106;

/** Fountain Square — about 1.3 km from the store. */
const FAR_LAT = 40.3705;
const FAR_LON = 49.837;

const STORE: MobileStore = {
  id: 'str-bravo-yasamal',
  store_code: 'BRAVO_YASAMAL_01',
  name: 'Bravo Hypermarket - Yasamal',
  address: null,
  city: 'Bakı',
  latitude: STORE_LAT,
  longitude: STORE_LON,
  is_active: true,
};

const TASK: MobileTask = {
  id: 'task-capture-truth',
  title: 'Cooler Check',
  description: 'Soyuducu auditi',
  reference_image_url: null,
  priority: 'high',
  status: 'published',
  deadline: new Date(Date.now() + 86_400_000).toISOString(),
  planogram_rules: [],
  checklist_schema: [],
};

/**
 * The same task, but carrying the planogram reference the ghost overlay draws.
 *
 * This pair is the point: `ghost_overlay_used` is a claim about a comparison
 * the worker was shown, so it must depend on whether there was anything to
 * show — not on the toggle's position alone.
 */
const TASK_WITH_REFERENCE: MobileTask = {
  ...TASK,
  reference_image_url: 'https://example.test/planogram-cooler.jpg',
};

const INSIDE_GPS: GPSCoordinates = { latitude: USER_LAT, longitude: USER_LON, accuracy: 3.5 };
const FAR_GPS: GPSCoordinates = { latitude: FAR_LAT, longitude: FAR_LON, accuracy: 10 };

/**
 * A stand-in for what the platform camera returns. Not a real JPEG.
 *
 * SHORT ON PURPOSE. It was a 44-character base64 blob of
 * "fake-jpeg-bytes-from-the-sensor" until CI's secret scan reported it as a
 * possible encoded credential — correctly, by its own rule: any quoted run of
 * 40+ `[A-Za-z0-9+/=_-]` characters with enough diversity is treated as a
 * secret (`scripts/quality/secret-scan.mjs`, detector `high-entropy-string`).
 *
 * The fix is to stop looking like a credential, not to teach the scanner to
 * ignore this file. A fixture has no reason to be long, and this one is real
 * base64 that decodes to "fake-bytes".
 */
const REAL_BYTES = 'ZmFrZS1ieXRlcw==';

// ===========================================================================
// Part B — the wiring, as a pure function over source text.
//
// Kept as an exported, side-effect-free function so `selfTest` can run it over
// deliberately broken copies. A guard that cannot be pointed at a broken tree
// is a guard nobody has ever seen fail.
// ===========================================================================

export interface WiringSources {
  cameraScreen: string;
  loginScreen: string;
  packageJson: string;
  appJson: string;
}

/**
 * Removes `//` and block comments, leaving string literals intact.
 *
 * WHY THIS IS NOT A ONE-LINE REGEX
 * --------------------------------
 * The obvious `.replace(/\/\/.*$/gm, '')` also eats the `//` in every
 * `https://` URL and inside every string, and it cannot see `/* *\/` at all.
 * Either mistake makes the guard read a mutilated file, which is a new way for
 * a check to be wrong rather than a way for it to be right.
 *
 * The state machine is small on purpose: it walks the text once, copying
 * strings verbatim (including their escape sequences) and dropping everything
 * else that is a comment.
 */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ch;
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') {
          out += source[i];
          i++;
          if (i < n) {
            out += source[i];
            i++;
          }
          continue;
        }
        out += source[i];
        i++;
      }
      if (i < n) {
        out += source[i];
        i++;
      }
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

interface WiringRule {
  id: string;
  what: string;
  /** Evaluated against comment-stripped sources. */
  holds: (clean: WiringSources) => boolean;
}

/** `import { CameraView, useCameraPermissions } from 'expo-camera';` */
const CAMERA_VIEW_IMPORT = /import\s*\{[^}]*\bCameraView\b[^}]*\}\s*from\s*['"]expo-camera['"]/;

/** `takePictureAsync({ base64: true, ... })` */
const TAKE_PICTURE_WITH_BASE64 = /takePictureAsync\s*\(\s*\{[^}]*\bbase64\s*:\s*true/;

/** The object literal handed to `captureLiveAudit`, which must carry `base64`. */
const PASSES_BYTES_TO_CONTROLLER = /captureLiveAudit\s*\(\s*\{[^}]*\bbase64\s*:/;

/** `if (!shot?.base64) { throw ... }` — the refusal to file a made-up image. */
const REFUSES_BYTE_LESS_CAPTURE = /if\s*\(\s*!\s*shot\??\.base64\s*\)/;

/**
 * `source={{ uri: task.reference_image_url }}` — the overlay's actual image.
 *
 * Deliberately the SOURCE expression and not the `testID`, because the badge
 * next to it also carries a `testID` and a condition on `reference_image_url`.
 * A guard that accepted either would pass on the label alone, which is exactly
 * the defect: the label was there and the image was not.
 */
const GHOST_OVERLAY_IMAGE = /source=\{\{\s*uri:\s*task\.reference_image_url\s*\}\}/;

/**
 * `{task.reference_image_url ? '👻 Ghost overlay aktiv' : 'Ghost: istinad şəkli yoxdur'}`
 *
 * The badge must be able to say "there is nothing to overlay". A single
 * unconditional label is exactly how the third fake read on screen: a claim
 * that a comparison was active, with nothing behind it.
 *
 * The regex requires a quote immediately after the `?`, which is what keeps it
 * off the image's own condition (`... && task.reference_image_url ? (`).
 */
const GHOST_BADGE_IS_HONEST = /task\.reference_image_url\s*\?\s*'[^']*'\s*:\s*'[^']*'/;

/** A coordinate NAMED in code rather than read from the platform. */
const INVENTED_COORDINATE = /(latitude|longitude)\s*:\s*-?\d/;

const WIRING_RULES: WiringRule[] = [
  {
    id: 'camera-imports-camera-view',
    what: 'the camera screen must import CameraView from expo-camera',
    holds: (c) => CAMERA_VIEW_IMPORT.test(c.cameraScreen),
  },
  {
    id: 'camera-renders-the-preview',
    what: 'the camera screen must actually render <CameraView>, not a placeholder',
    holds: (c) => /<CameraView\b/.test(c.cameraScreen),
  },
  {
    id: 'camera-asks-for-base64',
    what: 'takePictureAsync must be called with base64: true, or there are no bytes to send',
    holds: (c) => TAKE_PICTURE_WITH_BASE64.test(c.cameraScreen),
  },
  {
    id: 'camera-passes-the-bytes-on',
    what: 'the bytes must reach captureLiveAudit, which is what makes simulated false',
    holds: (c) => PASSES_BYTES_TO_CONTROLLER.test(c.cameraScreen),
  },
  {
    id: 'camera-refuses-a-byte-less-capture',
    what: 'a capture with no bytes must be a failure, not a silent placeholder',
    holds: (c) => REFUSES_BYTE_LESS_CAPTURE.test(c.cameraScreen),
  },
  {
    id: 'camera-renders-the-ghost-overlay',
    what: 'the ghost overlay must draw the reference image, or ghost_overlay_used claims a comparison nobody saw',
    holds: (c) => GHOST_OVERLAY_IMAGE.test(c.cameraScreen),
  },
  {
    id: 'camera-badge-does-not-outrun-the-image',
    what: 'the ghost badge must be able to say "no reference image", or it asserts a comparison that is not happening',
    holds: (c) => GHOST_BADGE_IS_HONEST.test(c.cameraScreen),
  },
  {
    id: 'login-imports-expo-location',
    what: 'the login screen must import expo-location',
    holds: (c) => /from\s*['"]expo-location['"]/.test(c.loginScreen),
  },
  {
    id: 'login-reads-the-platform-position',
    what: 'the login screen must call getCurrentPositionAsync',
    holds: (c) => /\bgetCurrentPositionAsync\b/.test(c.loginScreen),
  },
  {
    id: 'login-does-not-invent-coordinates',
    what: 'the login screen must not name a coordinate literal — that is the defect this guards',
    holds: (c) => !INVENTED_COORDINATE.test(c.loginScreen),
  },
  {
    id: 'package-declares-the-native-modules',
    what: 'expo-camera and expo-location must be declared dependencies',
    holds: (c) => {
      const deps = JSON.parse(c.packageJson)?.dependencies ?? {};
      return typeof deps['expo-camera'] === 'string' && typeof deps['expo-location'] === 'string';
    },
  },
  {
    id: 'app-json-configures-the-plugins',
    what: 'both native modules must be configured as Expo plugins, which is what prebuild reads',
    holds: (c) => {
      const plugins = JSON.parse(c.appJson)?.expo?.plugins ?? [];
      const names = plugins.map((entry: unknown) =>
        Array.isArray(entry) ? entry[0] : entry,
      ) as unknown[];
      return names.includes('expo-camera') && names.includes('expo-location');
    },
  },
  {
    id: 'app-json-permission-strings',
    what: 'iOS must carry both usage descriptions, or the prompt cannot be shown at all',
    holds: (c) => {
      const info = JSON.parse(c.appJson)?.expo?.ios?.infoPlist ?? {};
      return (
        typeof info.NSLocationWhenInUseUsageDescription === 'string' &&
        typeof info.NSCameraUsageDescription === 'string'
      );
    },
  },
];

/** Every rule that does NOT hold, as `id: what` lines. */
export function findWiringProblems(sources: WiringSources): string[] {
  const clean: WiringSources = {
    cameraScreen: stripComments(sources.cameraScreen),
    loginScreen: stripComments(sources.loginScreen),
    packageJson: stripComments(sources.packageJson),
    appJson: stripComments(sources.appJson),
  };
  return WIRING_RULES.filter((rule) => !rule.holds(clean)).map(
    (rule) => `${rule.id}: ${rule.what}`,
  );
}

function readTree(): WiringSources {
  return {
    cameraScreen: readFileSync(CAMERA_SCREEN_PATH, 'utf8'),
    loginScreen: readFileSync(LOGIN_SCREEN_PATH, 'utf8'),
    packageJson: readFileSync(PACKAGE_JSON_PATH, 'utf8'),
    appJson: readFileSync(APP_JSON_PATH, 'utf8'),
  };
}

// ---------------------------------------------------------------------------
// The self-test. Each mutation must make exactly one rule fire.
//
// `apply` returns null when its anchor is gone, which is reported as a STALE
// self-test rather than as a pass. A mutation that quietly stopped mutating
// anything would otherwise turn this whole section into decoration.
// ---------------------------------------------------------------------------

interface Mutation {
  rule: string;
  how: string;
  apply: (sources: WiringSources) => WiringSources | null;
}

/** Replace `pattern` in one field, or report that the anchor is gone. */
function replaceIn(
  sources: WiringSources,
  key: keyof WiringSources,
  pattern: RegExp,
  replacement: string,
): WiringSources | null {
  const before = sources[key];
  if (!pattern.test(before)) return null;
  return { ...sources, [key]: before.replace(pattern, replacement) };
}

const MUTATIONS: Mutation[] = [
  {
    rule: 'camera-imports-camera-view',
    how: 'the expo-camera import is removed',
    apply: (s) => replaceIn(s, 'cameraScreen', CAMERA_VIEW_IMPORT, ''),
  },
  {
    // THE CASE THAT MATTERS MOST. This is the original defect's exact shape:
    // the words are present, and they are only a comment.
    rule: 'camera-imports-camera-view',
    how: 'expo-camera is mentioned ONLY in a comment, as it was before the fix',
    apply: (s) => {
      const withoutImport = replaceIn(s, 'cameraScreen', CAMERA_VIEW_IMPORT, '');
      if (withoutImport === null) return null;
      return {
        ...withoutImport,
        cameraScreen: `// import { CameraView } from 'expo-camera';\n${withoutImport.cameraScreen}`,
      };
    },
  },
  {
    rule: 'camera-renders-the-preview',
    how: 'the preview is swapped back for a plain view',
    apply: (s) => replaceIn(s, 'cameraScreen', /<CameraView\b/g, '<View'),
  },
  {
    rule: 'camera-asks-for-base64',
    how: 'takePictureAsync stops asking for base64',
    apply: (s) => replaceIn(s, 'cameraScreen', /\bbase64\s*:\s*true/, 'base64: false'),
  },
  {
    rule: 'camera-passes-the-bytes-on',
    how: 'the bytes are not handed to captureLiveAudit',
    apply: (s) => replaceIn(s, 'cameraScreen', /\n\s*base64:\s*shot\.base64,/, '\n'),
  },
  {
    rule: 'camera-refuses-a-byte-less-capture',
    how: 'the byte-less capture is allowed through as a placeholder',
    apply: (s) =>
      replaceIn(s, 'cameraScreen', REFUSES_BYTE_LESS_CAPTURE, 'if (false && !shot?.base64)'),
  },
  {
    // The third fake, reintroduced. The badge survives, so the screen still
    // SAYS "Ghost overlay aktiv" — which is precisely why this rule is written
    // against the image's source expression and not against the label.
    rule: 'camera-renders-the-ghost-overlay',
    how: 'the overlay keeps its badge but stops drawing the reference image',
    apply: (s) =>
      replaceIn(s, 'cameraScreen', /\s*source=\{\{\s*uri:\s*task\.reference_image_url\s*\}\}/, ''),
  },
  {
    rule: 'camera-badge-does-not-outrun-the-image',
    how: 'the badge becomes an unconditional "Ghost overlay aktiv"',
    apply: (s) => replaceIn(s, 'cameraScreen', GHOST_BADGE_IS_HONEST, "'👻 Ghost overlay aktiv'"),
  },
  {
    rule: 'login-imports-expo-location',
    how: 'the expo-location import is removed',
    apply: (s) =>
      replaceIn(s, 'loginScreen', /import\s+\*\s+as\s+Location\s+from\s*'expo-location';/, ''),
  },
  {
    rule: 'login-reads-the-platform-position',
    how: 'the screen stops asking the platform where it is',
    apply: (s) => replaceIn(s, 'loginScreen', /\bgetCurrentPositionAsync\b/g, 'getNothing'),
  },
  {
    // The defect, reintroduced verbatim.
    rule: 'login-does-not-invent-coordinates',
    how: 'the demo coordinates are hardcoded again',
    apply: (s) => ({
      ...s,
      loginScreen: `${s.loginScreen}\nconst invented = { latitude: 40.4093, longitude: 49.8671 };\n`,
    }),
  },
  {
    rule: 'package-declares-the-native-modules',
    how: 'expo-camera is dropped from package.json',
    apply: (s) => {
      const parsed = JSON.parse(s.packageJson);
      if (!parsed.dependencies?.['expo-camera']) return null;
      delete parsed.dependencies['expo-camera'];
      return { ...s, packageJson: JSON.stringify(parsed) };
    },
  },
  {
    rule: 'app-json-configures-the-plugins',
    how: 'expo-camera is dropped from the Expo plugins',
    apply: (s) => {
      const parsed = JSON.parse(s.appJson);
      const plugins = parsed.expo?.plugins;
      if (!Array.isArray(plugins)) return null;
      const filtered = plugins.filter((entry: unknown) =>
        Array.isArray(entry) ? entry[0] !== 'expo-camera' : entry !== 'expo-camera',
      );
      if (filtered.length === plugins.length) return null;
      parsed.expo.plugins = filtered;
      return { ...s, appJson: JSON.stringify(parsed) };
    },
  },
  {
    rule: 'app-json-permission-strings',
    how: 'the iOS camera usage description is removed',
    apply: (s) => {
      const parsed = JSON.parse(s.appJson);
      if (!parsed.expo?.ios?.infoPlist?.NSCameraUsageDescription) return null;
      delete parsed.expo.ios.infoPlist.NSCameraUsageDescription;
      return { ...s, appJson: JSON.stringify(parsed) };
    },
  },
];

function selfTest(realSources: WiringSources): string[] {
  const failures: string[] = [];

  // A guard that always fails "detects" everything, so the clean tree is part
  // of the self-test rather than a separate assertion.
  const realProblems = findWiringProblems(realSources);
  if (realProblems.length > 0) {
    failures.push(
      `the real tree is not clean, so the mutations below prove nothing: ${realProblems.join(' | ')}`,
    );
  }

  // EVERY MUTATION RUNS AGAINST COMMENT-STRIPPED SOURCE, and that is a fix this
  // self-test forced rather than a stylistic choice.
  //
  // The first version mutated the raw file. The mutation "takePictureAsync
  // stops asking for base64" replaced `base64: true` with `base64: false` and
  // the guard STILL PASSED. The reason is worth keeping: the first occurrence
  // of `base64: true` in `CameraAuditScreenUI.tsx` is inside the header comment
  // that documents the fix. `String.replace` rewrote the prose, `stripComments`
  // then deleted it, and the code was never touched — so the mutation had
  // tested nothing, and the self-test would have reported a false alarm on a
  // rule that works.
  //
  // Stripping first makes every mutation a mutation of code by construction.
  const code: WiringSources = {
    cameraScreen: stripComments(realSources.cameraScreen),
    loginScreen: stripComments(realSources.loginScreen),
    packageJson: stripComments(realSources.packageJson),
    appJson: stripComments(realSources.appJson),
  };

  for (const mutation of MUTATIONS) {
    const mutated = mutation.apply(code);
    if (mutated === null) {
      failures.push(`STALE: "${mutation.how}" no longer applies — its anchor is gone`);
      continue;
    }
    const problems = findWiringProblems(mutated);
    if (!problems.some((problem) => problem.startsWith(`${mutation.rule}:`))) {
      failures.push(
        `"${mutation.how}" did not make the guard fail on ${mutation.rule} ` +
          `(it reported: ${problems.length === 0 ? 'nothing' : problems.join(' | ')})`,
      );
    }
  }

  return failures;
}

// ===========================================================================
// The suite body.
//
// One async function rather than top-level await: `tsx` compiles this file to
// CommonJS, which has no top-level await. Every other suite in this repo is
// shaped this way for the same reason.
// ===========================================================================
async function main() {
  console.log(
    `${colors.bright}========================================================================${colors.reset}`,
  );
  console.log(
    `${colors.bright}  oneTeam — CAN THE CAPTURE LIE?                                          ${colors.reset}`,
  );
  console.log(
    `${colors.bright}========================================================================${colors.reset}`,
  );

  // ===========================================================================
  // PART A — the contract.
  // ===========================================================================
  section('A1. A capture with real bytes is NOT simulated, and carries them');

  {
    const controller = new CameraAuditController(TASK, STORE);

    const withBytes = await controller.captureLiveAudit({
      source: 'camera',
      userGPS: INSIDE_GPS,
      base64: REAL_BYTES,
    });

    check(
      'a capture handed bytes reports simulated: false',
      withBytes.simulated === false,
      withBytes.simulated,
    );
    check(
      'and the bytes come back out, so the upload has something to send',
      withBytes.base64 === REAL_BYTES,
      typeof withBytes.base64 === 'string'
        ? `${withBytes.base64.slice(0, 16)}… (${withBytes.base64.length} chars)`
        : withBytes.base64,
    );
    check(
      'and the identifier says these are sensor bytes, not a file on disk',
      withBytes.photoUri.startsWith('camera://live/'),
      withBytes.photoUri,
    );

    // The other direction, from the same controller instance, so the two
    // answers are comparable.
    const withoutBytes = await controller.captureLiveAudit({
      source: 'camera',
      userGPS: INSIDE_GPS,
    });

    check(
      'a capture with no bytes reports simulated: true',
      withoutBytes.simulated === true,
      withoutBytes.simulated,
    );
    check(
      'and carries no bytes at all, rather than an empty string that would read as "some"',
      withoutBytes.base64 === undefined,
      withoutBytes.base64,
    );
    check(
      'and the two captures are distinguishable by scheme, not just by a flag',
      withoutBytes.photoUri.startsWith('file://') && !withBytes.photoUri.startsWith('file://'),
      { withBytes: withBytes.photoUri, withoutBytes: withoutBytes.photoUri },
    );

    // The discriminator is the bytes and nothing else. A timer, a flag or a
    // build constant would show up here as "same bytes, different answer".
    const again = await controller.captureLiveAudit({
      source: 'camera',
      userGPS: INSIDE_GPS,
      base64: REAL_BYTES,
    });
    check(
      'and the answer depends only on the bytes — the same input gives the same verdict',
      again.simulated === withBytes.simulated && again.base64 === withBytes.base64,
      { simulated: again.simulated },
    );
  }

  section("A2. The stamp records the CALLER'S fix, not the store's");

  {
    const controller = new CameraAuditController(TASK, STORE);

    const fromNearby = await controller.captureLiveAudit({
      source: 'camera',
      userGPS: INSIDE_GPS,
      base64: REAL_BYTES,
    });

    check(
      "the stamped latitude is the caller's fix",
      fromNearby.metadata.gps.latitude === USER_LAT,
      { stamped: fromNearby.metadata.gps.latitude, caller: USER_LAT, store: STORE_LAT },
    );
    check(
      "the stamped longitude is the caller's fix",
      fromNearby.metadata.gps.longitude === USER_LON,
      { stamped: fromNearby.metadata.gps.longitude, caller: USER_LON, store: STORE_LON },
    );
    check(
      'the stamped position is NOT the store position, which would make the geofence vacuous',
      fromNearby.metadata.gps.latitude !== STORE_LAT,
      { stamped: fromNearby.metadata.gps.latitude, store: STORE_LAT },
    );
    check(
      'and the distance is the real ~11 m, not 0',
      fromNearby.metadata.distance_from_store_meters > 5 &&
        fromNearby.metadata.distance_from_store_meters < 50,
      fromNearby.metadata.distance_from_store_meters,
    );

    const fromFarAway = await controller.captureLiveAudit({
      source: 'camera',
      userGPS: FAR_GPS,
      base64: REAL_BYTES,
    });
    check(
      'a fix 1.3 km away is stamped as 1.3 km away',
      fromFarAway.metadata.distance_from_store_meters > 1000,
      fromFarAway.metadata.distance_from_store_meters,
    );
  }

  section('A3. Negative control: this suite can see the defect it was written for');

  {
    // The defect was a caller that passed the STORE'S OWN coordinates as the
    // device's position. That is reproducible in one line, and its fingerprint
    // is a distance of 0. If the assertions in A2 could not detect this, they
    // would be decoration — so it is asserted here, on purpose.
    const controller = new CameraAuditController(TASK, STORE);

    const selfComparison = await controller.captureLiveAudit({
      source: 'camera',
      userGPS: { latitude: STORE_LAT, longitude: STORE_LON },
      base64: REAL_BYTES,
    });

    check(
      'when the caller passes the store position, the distance collapses to 0',
      selfComparison.metadata.distance_from_store_meters === 0,
      selfComparison.metadata.distance_from_store_meters,
    );
    // Widened to `number`, and the two comparisons are evaluated on separate
    // lines. Both constants are `const`, so TypeScript infers literal types for
    // them; inside a single `a === STORE_LAT && a !== USER_LAT` expression it
    // narrows `a` to `40.385012` on the right-hand side and then rejects the
    // second comparison as provably disjoint (TS2367). The assertion is still
    // the right one — the two positions ARE different — so the expression is
    // split rather than the check weakened.
    const stampedLatitude: number = selfComparison.metadata.gps.latitude;
    const stampedIsTheStorePosition = stampedLatitude === STORE_LAT;
    const stampedDiffersFromTheCaller = stampedLatitude !== USER_LAT;

    check(
      'and that is exactly the fingerprint A2 rules out — so A2 is not vacuous',
      stampedIsTheStorePosition && stampedDiffersFromTheCaller,
      { stamped: stampedLatitude, store: STORE_LAT, caller: USER_LAT },
    );
  }

  section('A4. The anti-gallery rule and the missing-coordinate refusal still hold');

  {
    check(
      'a gallery photo is still refused',
      caught(() => assertLiveCameraCapture('gallery')) !== null,
      caught(() => assertLiveCameraCapture('gallery')),
    );

    // A store with no coordinates must be refused outright. Comparing against
    // 0,0 would put the store in the Atlantic and the geofence would silently
    // answer "no" for a reason nobody could see.
    const noCoordinates: MobileStore = { ...STORE, latitude: null, longitude: null };
    const controller = new CameraAuditController(TASK, noCoordinates);
    const refusal = await controller
      .captureLiveAudit({ source: 'camera', userGPS: INSIDE_GPS, base64: REAL_BYTES })
      .then(() => null)
      .catch((error: unknown) => error);

    check(
      'a store with no coordinates is refused instead of compared against 0,0',
      refusal !== null && String(refusal).includes('koordinatları yoxdur'),
      refusal === null ? '<no error thrown>' : String(refusal),
    );
  }

  section('A5. The ghost overlay is recorded only when it was really offered');

  {
    // The third fake of the same family, found on 2026-09-20. The toggle, the
    // badge and the metadata were all real; the reference image was never
    // rendered. So `ghost_overlay_used: true` went into the audit trail for
    // every submission while the worker had been shown nothing to compare
    // against — a claim in the evidence, not a cosmetic bug.
    const withoutReference = new CameraAuditController(TASK, STORE);
    const noReferenceCapture = await withoutReference.captureLiveAudit({
      source: 'camera',
      userGPS: INSIDE_GPS,
      base64: REAL_BYTES,
    });
    check(
      'a task with no reference image records ghost_overlay_used: false, even with the toggle on',
      noReferenceCapture.metadata.ghost_overlay_used === false,
      {
        recorded: noReferenceCapture.metadata.ghost_overlay_used,
        toggleOn: withoutReference.getState().ghostOverlayActive,
        reference: TASK.reference_image_url,
      },
    );

    const withReference = new CameraAuditController(TASK_WITH_REFERENCE, STORE);
    const referenceCapture = await withReference.captureLiveAudit({
      source: 'camera',
      userGPS: INSIDE_GPS,
      base64: REAL_BYTES,
    });
    check(
      'a task that carries a reference image records ghost_overlay_used: true',
      referenceCapture.metadata.ghost_overlay_used === true,
      referenceCapture.metadata.ghost_overlay_used,
    );

    withReference.toggleGhost();
    const toggledOff = await withReference.captureLiveAudit({
      source: 'camera',
      userGPS: INSIDE_GPS,
      base64: REAL_BYTES,
    });
    check(
      'and turning the overlay off records false, so the field tracks the worker not the build',
      toggledOff.metadata.ghost_overlay_used === false,
      toggledOff.metadata.ghost_overlay_used,
    );
  }

  // ===========================================================================
  // PART B — the wiring.
  // ===========================================================================
  section('B1. The camera screen is really wired to a camera');

  const sources = readTree();
  const clean = {
    cameraScreen: stripComments(sources.cameraScreen),
    loginScreen: stripComments(sources.loginScreen),
  };

  {
    // The comment-stripper has to be trusted before its output is, so it is
    // asserted on a case whose answer is known by inspection.
    check(
      'the comment stripper removes a line comment',
      stripComments('const a = 1; // CameraView\nconst b = 2;') === 'const a = 1; \nconst b = 2;',
    );
    check(
      'the comment stripper removes a JSDoc block',
      stripComments('/**\n * expo-camera\n */\nconst a = 1;').trim() === 'const a = 1;',
    );
    check(
      'and it does NOT remove a // inside a string — that is the trap',
      stripComments("const u = 'https://example.test/x';").includes('https://example.test/x'),
    );

    check(
      'CameraAuditScreenUI.tsx imports CameraView from expo-camera in CODE, not only in its header',
      CAMERA_VIEW_IMPORT.test(clean.cameraScreen),
    );
    check(
      'it renders <CameraView> rather than a placeholder rectangle',
      /<CameraView\b/.test(clean.cameraScreen),
    );
    check(
      'it asks takePictureAsync for base64: true',
      TAKE_PICTURE_WITH_BASE64.test(clean.cameraScreen),
    );
    check(
      'it hands those bytes to captureLiveAudit',
      PASSES_BYTES_TO_CONTROLLER.test(clean.cameraScreen),
    );
    check(
      'it refuses a capture that returned no bytes instead of filing a placeholder',
      REFUSES_BYTE_LESS_CAPTURE.test(clean.cameraScreen),
    );
    check(
      'it actually draws the planogram reference over the preview — the thing ghost_overlay_used claims',
      GHOST_OVERLAY_IMAGE.test(clean.cameraScreen),
    );
    check(
      'and the ghost badge can say "no reference image", so it cannot outrun the image',
      GHOST_BADGE_IS_HONEST.test(clean.cameraScreen),
    );
    check(
      'the capture is no longer marked simulated in the UI path',
      !/simulated:\s*true/.test(clean.cameraScreen),
    );
  }

  section('B2. The login screen asks the platform where it is');

  {
    check(
      'LoginScreenUI.tsx imports expo-location',
      /from\s*['"]expo-location['"]/.test(clean.loginScreen),
    );
    check(
      'it calls getCurrentPositionAsync',
      /\bgetCurrentPositionAsync\b/.test(clean.loginScreen),
    );
    check(
      'it requests foreground permission, so a refusal is a real state and not a crash',
      /\brequestForegroundPermissionsAsync\b/.test(clean.loginScreen),
    );
    check(
      'and NO coordinate literal survives in the code — the header may describe the old one',
      !INVENTED_COORDINATE.test(clean.loginScreen),
      clean.loginScreen
        .split('\n')
        .filter((line) => INVENTED_COORDINATE.test(line))
        .slice(0, 3),
    );
    check(
      'the sign-in button is gated on a fix existing',
      /gps\s*!==\s*null/.test(clean.loginScreen),
    );
    check(
      'there is no timer standing in for a location lookup',
      !/\bsetTimeout\b/.test(clean.loginScreen),
    );
  }

  section('B3. The native modules are declared where prebuild reads them');

  {
    const parsedPackage = JSON.parse(sources.packageJson);
    const parsedApp = JSON.parse(sources.appJson);

    check(
      'expo-camera is a declared dependency',
      typeof parsedPackage.dependencies?.['expo-camera'] === 'string',
      parsedPackage.dependencies?.['expo-camera'],
    );
    check(
      'expo-location is a declared dependency',
      typeof parsedPackage.dependencies?.['expo-location'] === 'string',
      parsedPackage.dependencies?.['expo-location'],
    );
    check(
      'both are Expo plugins, which is what makes prebuild link them natively',
      (parsedApp.expo?.plugins ?? [])
        .map((entry: unknown) => (Array.isArray(entry) ? entry[0] : entry))
        .filter((name: unknown) => name === 'expo-camera' || name === 'expo-location').length === 2,
    );
    check(
      'and iOS carries both usage descriptions, without which the prompt cannot appear',
      typeof parsedApp.expo?.ios?.infoPlist?.NSCameraUsageDescription === 'string' &&
        typeof parsedApp.expo?.ios?.infoPlist?.NSLocationWhenInUseUsageDescription === 'string',
    );
  }

  // ===========================================================================
  // PART C — the guard itself.
  // ===========================================================================
  section('C1. The guard bites: every rule is made to fail on purpose');

  {
    const failures = selfTest(sources);
    check(
      `all ${MUTATIONS.length} mutations were detected, and none went stale`,
      failures.length === 0,
      failures,
    );
  }

  // ===========================================================================

  console.log(
    `\n${colors.bright}${passed + failed} checks: ${colors.green}${passed} passed${colors.reset}` +
      (failed > 0 ? `, ${colors.red}${failed} FAILED${colors.reset}` : ''),
  );
  console.log(
    `  ${colors.yellow}Not covered here:${colors.reset} the camera itself. No sensor has been read ` +
      `and no\n  bytes have been through one — what is proven is that the code asks for real ` +
      `bytes and\n  refuses to pretend when it does not get them.`,
  );

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`${colors.red}The suite itself failed:${colors.reset}`, error);
  process.exit(1);
});
