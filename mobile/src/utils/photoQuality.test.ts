/**
 * oneTeam mobile — photo quality heuristic tests (Dalğa 0.2)
 * ============================================================================
 *
 * This is the Part A contract for the quality gate. The heuristic is pure —
 * no platform calls, no I/O — so it is tested as a unit rather than through
 * the screen.
 *
 * Why the EXIF parsing tests are not optional:
 * `takePictureAsync({ exif: true })` returns rationals as STRINGS — `"1/30"`,
 * `"1600/1"`, `"2.8"`. A naïve `Number(value)` silently rounds `"1/30"` to
 * `1`, which is thirty times the truth, and would let every shutter-speed
 * trip pass. The parseRational function is the only thing that turns that
 * string into the right number; if it ever drifts, every test below still
 * passes (the threshold constant has not moved) but every shutter-speed
 * assessment becomes wrong. So the parsing is asserted directly.
 */

import { assessPhotoQuality } from '../utils/photoQuality';

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  bright: '\x1b[1m',
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
      console.log(`         got: ${JSON.stringify(detail)?.slice(0, 400)}`);
    }
  }
}

console.log(`${colors.bright}oneTeam — photo quality heuristic${colors.reset}`);

// ---------------------------------------------------------------------------
// Happy paths — clearly acceptable photos.
// ---------------------------------------------------------------------------

{
  const a = assessPhotoQuality({
    ISO: '100',
    ExposureTime: '1/500',
    FNumber: '2.8',
    BrightnessValue: '8/1',
  });
  check('a normal indoor photo is acceptable', a.isAcceptable === true, a.reasons);
  check('and reports no failure reasons', a.reasons.length === 0, a.reasons);
  check(
    'metrics are parsed, not left as strings',
    a.metrics.iso === 100 &&
      a.metrics.exposureTimeSeconds === 0.002 &&
      a.metrics.fNumber === 2.8 &&
      a.metrics.brightnessValue === 8,
    a.metrics,
  );
}

// ---------------------------------------------------------------------------
// Each reason in isolation — one EXIF metric trips the gate.
// ---------------------------------------------------------------------------

{
  const tooDark = assessPhotoQuality({
    BrightnessValue: '1/1',
    ISO: '100',
    ExposureTime: '1/500',
  });
  check(
    'BrightnessValue < 2 is rejected as too_dark',
    tooDark.isAcceptable === false,
    tooDark.reasons,
  );
  check(
    '  and the reason is exactly too_dark',
    JSON.stringify(tooDark.reasons) === JSON.stringify(['too_dark']),
    tooDark.reasons,
  );
}

{
  const overexposed = assessPhotoQuality({
    BrightnessValue: '14/1',
    ISO: '100',
    ExposureTime: '1/500',
  });
  check(
    'BrightnessValue > 13 is rejected as overexposed',
    overexposed.isAcceptable === false,
    overexposed.reasons,
  );
  check(
    '  and the reason is exactly overexposed',
    JSON.stringify(overexposed.reasons) === JSON.stringify(['overexposed']),
    overexposed.reasons,
  );
}

{
  const highIso = assessPhotoQuality({
    ISO: '3200',
    ExposureTime: '1/60',
    BrightnessValue: '6/1',
  });
  check('ISO > 1600 is rejected as high_iso', highIso.isAcceptable === false, highIso.reasons);
  check(
    '  and the reason is exactly high_iso',
    JSON.stringify(highIso.reasons) === JSON.stringify(['high_iso']),
    highIso.reasons,
  );
}

// The single most important regression test. EXIF reports exposure as the
// string "1/30". A naïve parse would read that as the number 1, which is
// thirty times the truth. Slow shutter should trip; the assertion is the
// negative of that.
{
  const slowShutter = assessPhotoQuality({
    ISO: '200',
    ExposureTime: '1/30',
    BrightnessValue: '8/1',
  });
  check(
    'ExposureTime "1/30" is parsed as 1/30 second and trips slow_shutter',
    slowShutter.isAcceptable === false,
    slowShutter.reasons,
  );
  check(
    '  and the parsed exposureTimeSeconds is 0.0333, not 1',
    Math.abs((slowShutter.metrics.exposureTimeSeconds ?? 0) - 1 / 30) < 1e-6,
    slowShutter.metrics.exposureTimeSeconds,
  );
}

{
  const fastShutter = assessPhotoQuality({
    ISO: '200',
    ExposureTime: '1/250',
    BrightnessValue: '8/1',
  });
  check(
    'a 1/250 second shutter does NOT trip slow_shutter',
    !fastShutter.reasons.includes('slow_shutter'),
    fastShutter.reasons,
  );
  check('  and the photo is acceptable', fastShutter.isAcceptable === true, fastShutter.reasons);
}

// ---------------------------------------------------------------------------
// Multiple reasons stack, not replace.
// ---------------------------------------------------------------------------

{
  // too_dark and overexposed cannot co-occur — one needs Bv < 2 and the other
  // Bv > 13, and no single reading satisfies both. So the stacking case uses
  // the three that CAN: dark, noisy, and a long exposure.
  const everything = assessPhotoQuality({
    BrightnessValue: '0/1',
    ISO: '6400',
    ExposureTime: '1/15',
  });
  check(
    'every reason that can co-occur is recorded, not just the first',
    JSON.stringify(everything.reasons.slice().sort()) ===
      JSON.stringify(['high_iso', 'slow_shutter', 'too_dark'].sort()),
    everything.reasons,
  );
  check(
    '  and the photo is unacceptable',
    everything.isAcceptable === false,
    everything.isAcceptable,
  );
}

{
  // The two brightness rules are mutually exclusive by construction; assert it
  // so a future refactor cannot quietly make them overlap.
  const bothBrightness = assessPhotoQuality({ BrightnessValue: '0/1' });
  check(
    'a dark photo is never also reported as overexposed',
    bothBrightness.reasons.includes('too_dark') && !bothBrightness.reasons.includes('overexposed'),
    bothBrightness.reasons,
  );
}

// ---------------------------------------------------------------------------
// EXIF absence is not a hard fail — the worker is allowed through, but the
// audit trail records that no signal was available.
// ---------------------------------------------------------------------------

{
  const noExif = assessPhotoQuality(null);
  check(
    'null EXIF passes the gate (we do not block on absence)',
    noExif.isAcceptable === true,
    noExif.isAcceptable,
  );
  check(
    '  and records the absence as no_exif',
    JSON.stringify(noExif.reasons) === JSON.stringify(['no_exif']),
    noExif.reasons,
  );
}

{
  const undefinedExif = assessPhotoQuality(undefined);
  check(
    'undefined EXIF is treated the same as null',
    undefinedExif.isAcceptable === true,
    undefinedExif.isAcceptable,
  );
}

{
  const emptyExif = assessPhotoQuality({});
  check(
    'an EXIF object with no relevant fields is acceptable',
    emptyExif.isAcceptable === true,
    emptyExif.isAcceptable,
  );
  check(
    '  but records no_exif so the audit trail knows the heuristic had no signal',
    JSON.stringify(emptyExif.reasons) === JSON.stringify(['no_exif']),
    emptyExif.reasons,
  );
}

// ---------------------------------------------------------------------------
// Pathological values — defend against the bad EXIF that.
// ---------------------------------------------------------------------------

{
  const zeroShutter = assessPhotoQuality({
    ExposureTime: '0/1',
    ISO: '100',
    BrightnessValue: '8/1',
  });
  check(
    'ExposureTime "0/1" is not a slow shutter',
    !zeroShutter.reasons.includes('slow_shutter'),
    zeroShutter.reasons,
  );
  check('  and the photo is acceptable', zeroShutter.isAcceptable === true, zeroShutter.reasons);
}

{
  const junkRational = assessPhotoQuality({ ISO: 'abc', ExposureTime: 'oops' });
  check(
    'non-numeric EXIF does not throw',
    junkRational.isAcceptable === true,
    junkRational.isAcceptable,
  );
  check(
    '  and the photo passes — junk data is treated as missing',
    JSON.stringify(junkRational.reasons) === JSON.stringify(['no_exif']),
    junkRational.reasons,
  );
}

{
  const zeroDenominator = assessPhotoQuality({ ExposureTime: '1/0' });
  check(
    '"1/0" (zero denominator) is treated as missing, not Infinity',
    zeroDenominator.isAcceptable === true,
    zeroDenominator.isAcceptable,
  );
  check(
    '  and is recorded as no_exif',
    JSON.stringify(zeroDenominator.reasons) === JSON.stringify(['no_exif']),
    zeroDenominator.reasons,
  );
}

{
  const numericIso = assessPhotoQuality({ ISO: 800, ExposureTime: 0.01, BrightnessValue: 7 });
  check(
    'numeric EXIF values (some platforms) are accepted as well as strings',
    numericIso.isAcceptable === true &&
      numericIso.metrics.iso === 800 &&
      numericIso.metrics.exposureTimeSeconds === 0.01,
    numericIso.metrics,
  );
}

// ---------------------------------------------------------------------------
// Boundary: the 1/30 s limit itself trips, one step faster does not.
// ---------------------------------------------------------------------------

{
  const atLimit = assessPhotoQuality({ ExposureTime: '1/30', ISO: '200', BrightnessValue: '8/1' });
  const oneStepFaster = assessPhotoQuality({
    ExposureTime: '1/60',
    ISO: '200',
    BrightnessValue: '8/1',
  });
  check(
    '1/30 s (the hand-held limit itself) trips slow_shutter',
    atLimit.reasons.includes('slow_shutter'),
    atLimit.reasons,
  );
  check(
    '1/60 s (one step faster) does not',
    !oneStepFaster.reasons.includes('slow_shutter'),
    oneStepFaster.reasons,
  );
  check(
    '  so the boundary is exclusive on the fast side, not fuzzy',
    oneStepFaster.isAcceptable === true,
    oneStepFaster.reasons,
  );
}

console.log(
  `\n${passed + failed} checks: ${passed} passed${failed > 0 ? `, ${failed} FAILED` : ''}`,
);
process.exit(failed === 0 ? 0 : 1);
