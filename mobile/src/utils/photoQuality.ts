/**
 * oneTeam mobile — photo quality assessment (Dalğa 0.2)
 * ============================================================================
 *
 * WHY THIS IS NOT A SINGLE THRESHOLD
 * ----------------------------------
 * "Bulanıq" yoxlamağı piksel tələb edir (Laplacian variance). EXIF isə piksel
 * yoxdur — yalnız kameranın capture zamanı qərar verdiyi parametrləri verir.
 * Amma EXIF, hələlik, bir neçə ŞƏRTİ qarşılaya bilir:
 *
 *   - Çox qaranlıq mühit: `ISO` yüksəkdir (>1600) və/və ya `ExposureTime`
 *     uzundur (1/30 saniyə və ya daha yavaş — yəni rəqəm 0.0333-dən böyük).
 *     Nəticə: foto çox güman ki, bulanıq və ya dənəlidir.
 *   - Çox parlaq mühit: EXIF `BrightnessValue` yüksəkdir (>13, APEX units).
 *     Nəticə: foto çox güman ki, parıltılıdır (ağ rəf).
 *   - Hər şey normal: `ISO` aşağı, `ExposureTime` qısa, `BrightnessValue`
 *     orta. Heuristic "qəbul edir".
 *
 * Piksel analizi Dalğa 0.2-nin 2-ci hissəsidir (həqiqi bulanıq yoxlama).
 *
 * WHY EXIF ABSENCE IS NOT A FAILURE
 * ---------------------------------
 * Bəzi cihazlar/üçüncü tərəf kameralar EXIF yazmır. Operatoru bloklamaq
 * UX-ı pozar; bunun əvəzinə keyfiyyət statusu "no_exif" olaraq audit trail-ə
 * yazılır və keçir. Bu, false negative riskidir, amma qəbul edilir — çünki
 * EXIF-in olmaması şəklin keyfiyyətsiz olduğunu sübut etmir.
 *
 * WHY THE RESULT REASONS ARE TURKISH/AZERBAIJANI
 * ----------------------------------------------
 * Bu funksiya nəticəsi birbaşa UI-da göstərilmir; operatora Alert göndərilir
 * (camera screen) və ya audit metadata-ya yazılır (server üçün). Səbəblər
 * audit üçün İngilis saxlanılır (server tərəfi gözləyir), operator üçün
 * UI Alert Azərbaycan dilində qurulur.
 */

export interface PhotoQualityMetrics {
  /** ISO speed rating, if EXIF reported it. */
  iso?: number;
  /** Exposure time in seconds, if EXIF reported it. */
  exposureTimeSeconds?: number;
  /** Aperture F-number, if EXIF reported it. */
  fNumber?: number;
  /** EXIF BrightnessValue in APEX units (Bv = log2(cd/m²)). */
  brightnessValue?: number;
}

export interface PhotoQualityAssessment {
  /** Whether the photo passes the heuristic. False means "do not send". */
  isAcceptable: boolean;
  /**
   * One short code per reason the photo failed. Stable, server-friendly.
   *
   *   - `too_dark`        — EXIF BrightnessValue < 2
   *   - `overexposed`     — EXIF BrightnessValue > 13
   *   - `high_iso`        — ISO > 1600
   *   - `slow_shutter`    — ExposureTime >= 1/30 s (a longer exposure)
   *   - `no_exif`         — no decision metric could be read from EXIF
   */
  reasons: string[];
  metrics: PhotoQualityMetrics;
}

/**
 * The three outcomes, as a single field.
 *
 * `isAcceptable` alone cannot express this: a photo whose EXIF could not be
 * read is `isAcceptable: true` AND carries the reason `no_exif`. That is the
 * honest answer to "should we block it?" — no — but it is a terrible answer to
 * "was this photo judged?". Collapsing the two into one boolean is how a
 * supervisor ends up reading "acceptable" on a photo nobody ever assessed.
 */
export type PhotoQualityStatus = 'ok' | 'flagged' | 'no_signal';

export function photoQualityStatus(assessment: PhotoQualityAssessment): PhotoQualityStatus {
  // `no_exif` is emitted alone (the function returns early), so this check
  // cannot mask a real failure — there is no path where a genuine reason and
  // `no_exif` are reported together.
  if (assessment.reasons.includes('no_exif')) return 'no_signal';
  return assessment.isAcceptable ? 'ok' : 'flagged';
}

/** APEX BrightnessValue thresholds, derived from EXIF 2.3 §10.3.1. */
const TOO_DARK_BV = 2;
const OVEREXPOSED_BV = 13;

/** ISO above which the sensor is producing noise (≈ grainy / dark photo). */
const HIGH_ISO = 1600;

/** Shutter speed below which hand-held motion blur is plausible. */
const SLOW_SHUTTER_SECONDS = 1 / 30;

/**
 * Parses an EXIF rational — `numerator/denominator`, sometimes a plain number —
 * and returns the float, or undefined if it cannot be read.
 *
 * EXIF rationals are strings in `expo-camera`'s output (`"1/30"`, `"1600/1"`,
 * `"2.8"`). A naïve `Number(value)` would treat "1/30" as `1`; that is not a
 * rounding problem, it is a different number, and it would silently mis-class
 * every shutter speed.
 */
function parseRational(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const slash = value.indexOf('/');
  if (slash >= 0) {
    const numerator = Number(value.slice(0, slash));
    const denominator = Number(value.slice(slash + 1));
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) {
      return numerator / denominator;
    }
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Assesses photo quality from capture-time EXIF.
 *
 * Called immediately after `takePictureAsync({ exif: true })` so the worker
 * sees the verdict before they press Send. Pure — no I/O, no platform calls —
 * so it is testable as a unit and cheap to run on every shutter.
 */
export function assessPhotoQuality(
  exif: Record<string, unknown> | null | undefined,
): PhotoQualityAssessment {
  // EXIF absent. We do not block — a photo without EXIF can still be honest —
  // but the audit trail records that the heuristic had no signal. The decision
  // to allow the photo through is the lesser evil here; the alternative is a
  // device-class denial of service.
  if (exif === null || exif === undefined) {
    return {
      isAcceptable: true,
      reasons: ['no_exif'],
      metrics: {},
    };
  }

  // EXIF BrightnessValue is APEX; ISO/ISOSpeedRatings are integers; ExposureTime
  // and FNumber are rationals. The keys the platform actually writes are not
  // guaranteed across iOS/Android versions, so we try both common spellings.
  const isoRaw = exif.ISO ?? exif.ISOSpeedRatings ?? exif.PhotographicSensitivity;
  const iso = parseRational(isoRaw);
  const exposureTime = parseRational(exif.ExposureTime);
  const fNumber = parseRational(exif.FNumber);
  const brightnessRaw = parseRational(exif.BrightnessValue);
  const brightnessValue =
    typeof brightnessRaw === 'number' && brightnessRaw >= 0 && brightnessRaw <= 20
      ? brightnessRaw
      : undefined;

  // If none of the three DECISION metrics could be read, the heuristic has no
  // signal — the same state as missing EXIF, and it is reported the same way.
  // Note the direction: this is about the values we could parse, not about
  // whether the object had keys. `{ ISO: 'abc' }` is a non-empty object with
  // an unreadable value, and it is exactly as blind as `{}`.
  if (iso === undefined && exposureTime === undefined && brightnessValue === undefined) {
    return {
      isAcceptable: true,
      reasons: ['no_exif'],
      metrics: { fNumber },
    };
  }

  const reasons: string[] = [];

  if (brightnessValue !== undefined && brightnessValue < TOO_DARK_BV) {
    reasons.push('too_dark');
  }
  if (brightnessValue !== undefined && brightnessValue > OVEREXPOSED_BV) {
    reasons.push('overexposed');
  }
  if (iso !== undefined && iso > HIGH_ISO) {
    reasons.push('high_iso');
  }
  // SLOW means a LONGER exposure, i.e. a LARGER number of seconds. `1/500` is
  // 0.002 s — a fast shutter, and the opposite of the risk this rule is about.
  // The comparison is `>=` rather than `>` because 1/30 s is the classic
  // hand-held limit itself, not a value safely below it.
  if (exposureTime !== undefined && exposureTime > 0 && exposureTime >= SLOW_SHUTTER_SECONDS) {
    reasons.push('slow_shutter');
  }

  return {
    isAcceptable: reasons.length === 0,
    reasons,
    metrics: {
      iso,
      exposureTimeSeconds: exposureTime,
      fNumber,
      brightnessValue,
    },
  };
}
