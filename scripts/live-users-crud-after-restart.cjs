/**
 * oneTeam — LIVE user-management verification against production (part 2 of 2).
 * ============================================================================
 *
 * Run this ONLY after `railway redeploy --service api --yes` has finished and
 * `/api/health` reports a fresh `uptimeSeconds`.
 *
 * WHY THE RESTART IS THE PROOF
 * ----------------------------
 * HTTP cannot show that a write landed, because the read path is the in-memory
 * array — a row can be answered `201`, rendered in the panel, and never reach
 * PostgreSQL. It looks correct until the next deploy, and then it is gone.
 *
 * A process that has just started has no array from before, so anything still
 * visible after a restart came out of PostgreSQL. This script asserts that for
 * three different writes at once:
 *
 *   1. the person created in part 1,
 *   2. the *edit* to that person. A surviving row is only evidence if the edit
 *      survived too — that is what separates "the row was written" from "the
 *      row was written correctly",
 *   3. a NEW key minted for that person in the fresh process. `panel_tokens`
 *      carries a foreign key to `users`, so if the user row had not reached
 *      PostgreSQL the insert would be refused as `KEY_NOT_STORED`. The mint
 *      succeeding is therefore a foreign-key proof of the user row — the chain,
 *      not just the last link.
 *
 * It then cleans up after itself and asserts the counts are back where part 1
 * found them.
 *
 * Usage:
 *   ONETEAM_API_URL=... ONETEAM_PANEL_KEY=... node scripts/live-users-crud-after-restart.cjs
 */

const API = (process.env.ONETEAM_API_URL || '').replace(/\/+$/, '');
const KEY = process.env.ONETEAM_PANEL_KEY || '';
const STATE_PATH = process.env.ONETEAM_LIVE_STATE || '/tmp/oneteam-live-users-state.json';
const MERCH_USER_ID = process.env.ONETEAM_MERCH_USER || 'usr-merch-003';
const fs = require('fs');

if (!API || !KEY) {
  console.error('ONETEAM_API_URL and ONETEAM_PANEL_KEY are both required');
  process.exit(2);
}
if (!fs.existsSync(STATE_PATH)) {
  console.error(`State faylı yoxdur: ${STATE_PATH} — əvvəlcə hissə 1-i işlədin.`);
  process.exit(2);
}

const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));

let passed = 0;
let failed = 0;
const failures = [];

function check(label, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  ✗ ${label}${detail === undefined ? '' : `  → ${detail}`}`);
  }
}

async function call(method, path, body, token) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token || KEY}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let payload = null;
  const text = await response.text();
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text.slice(0, 300) };
  }
  return { status: response.status, body: payload };
}

async function health() {
  const response = await fetch(`${API}/api/health`);
  const payload = await response.json();
  const detail = String(payload.persistenceDetail || '');
  const counts = {};
  for (const match of detail.matchAll(/(\d+)\s+(\w+)/g)) counts[match[2]] = Number(match[1]);
  return { uptimeSeconds: payload.uptimeSeconds, detail, counts };
}

/**
 * `persistenceDetail` is a LAGGING LABEL, not a live count.
 *
 * It is recomputed only when the replica poll reloads the arrays, so a count
 * read immediately after a write can be one interval (1000ms) behind — and with
 * `ONETEAM_REFRESH_MS=0` it never updates at all. Reading it once after a write
 * produced a false "the delete did not happen" here, so wait for it to settle
 * before treating it as evidence. The resource endpoint is the live answer; this
 * is the cross-check.
 */
async function settledCounts(maxWaitMs = 8000) {
  const deadline = Date.now() + maxWaitMs;
  let previous = null;
  let current = await health();
  while (Date.now() < deadline) {
    if (
      previous &&
      previous.users === current.counts.users &&
      previous.stores === current.counts.stores &&
      previous.tasks === current.counts.tasks &&
      previous.evidences === current.counts.evidences
    ) {
      return current;
    }
    previous = { ...current.counts };
    await sleep(1200);
    current = await health();
  }
  return current;
}

async function rowOf(userId) {
  const listed = await call('GET', '/api/panel/users');
  return (listed.body?.data?.users || []).find((row) => row.id === userId);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const stamp = Date.now().toString(36);
  console.log(`\n=== Faza 1.5 canlı yoxlama — HİSSƏ 2 (yenidən başlatmadan SONRA) ===\n`);
  console.log(`Hissə 1 başladı: ${state.startedAt}`);
  console.log(`Hissə 1-də uptime: ${state.afterPart1?.uptimeSeconds}s`);

  // ----------------------------------------------- 0. THE MANDATORY CONTROLS
  console.log('\n0) Nəzarətlər — bunlar olmadan nəticə mənasızdır');
  const first = await health();
  await sleep(4000);
  const second = await health();

  check(
    'proses TƏZƏdir (uptime kiçikdir) — yoxsa yenidən başlatma olmayıb',
    second.uptimeSeconds < 600,
    `${second.uptimeSeconds}s`,
  );
  check(
    'uptime ARTIR (proses həqiqətən işləyir, donmayıb)',
    second.uptimeSeconds > first.uptimeSeconds,
    `${first.uptimeSeconds}s → ${second.uptimeSeconds}s`,
  );
  check(
    'yenidən başlatma HƏQİQƏTƏN baş verib (uptime hissə 1-dən kiçikdir)',
    second.uptimeSeconds < (state.afterPart1?.uptimeSeconds ?? Infinity),
    `${state.afterPart1?.uptimeSeconds}s → ${second.uptimeSeconds}s`,
  );

  // -------------------------------------------- 1. write-through: the person
  console.log('\n1) Adam sağ qalıb? — yaddaş deyil, BAZA');
  const list = await call('GET', '/api/panel/users');
  const rows = list.body?.data?.users || [];
  const fixture = rows.find((row) => row.id === state.userId);

  check(
    'yaradılan adam yenidən başlatmadan SONRA da var',
    !!fixture,
    `id ${state.userId} tapılmadı; hazırda ${rows.length} adam var`,
  );
  check(
    'REDAKTƏ də sağ qalıb — ad',
    fixture?.fullName === state.expectedUser.fullName,
    `${fixture?.fullName} ≠ ${state.expectedUser.fullName}`,
  );
  check(
    'REDAKTƏ də sağ qalıb — telefon',
    fixture?.phone === state.expectedUser.phone,
    `${fixture?.phone} ≠ ${state.expectedUser.phone}`,
  );
  check('rol sağ qalıb', fixture?.role === state.expectedUser.role, String(fixture?.role));
  check(
    'ikinci fikstur adam (e-poçt sahibi) da sağ qalıb',
    !!rows.find((row) => row.id === state.duplicateOwnerId),
    String(state.duplicateOwnerId),
  );
  check(
    'adam sayı hissə 1-in gözləntisi ilə üst-üstə düşür',
    rows.length === state.expectedUserCount,
    `${rows.length} ≠ ${state.expectedUserCount}`,
  );

  // ------------------------------------ 2. write-through via the FOREIGN KEY
  console.log('\n2) Xarici açar sübutu — təzə prosesdə fikstur adama açar mint etmək');
  const fkMint = await call('POST', '/api/panel/keys', {
    userId: state.userId,
    label: `live-check-fk-${stamp}`,
  });
  const fkPrefix = fkMint.body?.data?.hashPrefix ?? null;
  check(
    'mint 201 qaytarır — `panel_tokens.user_id` xarici açarı sətri BAZADA tapdı',
    fkMint.status === 201,
    `${fkMint.status} ${JSON.stringify(fkMint.body)?.slice(0, 200)}`,
  );
  check(
    'uğursuzluq `KEY_NOT_STORED` DEYİL (yəni adam bazada həqiqətən var)',
    fkMint.body?.error !== 'KEY_NOT_STORED',
    String(fkMint.body?.error),
  );

  // ------------------------------------------ 3. the gate in the fresh process
  console.log('\n3) Təsdiq qapısı TƏZƏ prosesdə də işləyir');
  const remint = await call('POST', '/api/panel/keys', {
    userId: MERCH_USER_ID,
    label: `live-check-merch-after-${stamp}`,
  });
  const merchKey2 = remint.body?.data?.token ?? '';
  const merchPrefix2 = remint.body?.data?.hashPrefix ?? null;
  check(
    'merchandiser açarı təzə prosesdə mint olunur',
    remint.status === 201 && !!merchKey2,
    `${remint.status}`,
  );

  const ghost = 'sub-live-yoxdur-000';
  const gateMerch = await call(
    'POST',
    `/api/portal/submissions/${ghost}/review`,
    { status: 'approved' },
    merchKey2,
  );
  const gateAdmin = await call('POST', `/api/portal/submissions/${ghost}/review`, {
    status: 'approved',
  });
  check(
    'TƏZƏ prosesdə MERCHANDISER → 403 `REVIEW_FORBIDDEN`',
    gateMerch.status === 403 && gateMerch.body?.error === 'REVIEW_FORBIDDEN',
    `${gateMerch.status} ${gateMerch.body?.error}`,
  );
  check(
    'TƏZƏ prosesdə ADMIN → 404 (qapı keçilir, yalnız axtarış dayanır)',
    gateAdmin.status === 404,
    `${gateAdmin.status} ${gateAdmin.body?.error}`,
  );
  check('ikisi arasındakı fərq roldur, id deyil', gateMerch.status !== gateAdmin.status);

  const gateAuto = await call(
    'POST',
    `/api/portal/submissions/${ghost}/auto-approve`,
    undefined,
    merchKey2,
  );
  check(
    'avtomatik təsdiqdə də MERCHANDISER → 403 `REVIEW_FORBIDDEN`',
    gateAuto.status === 403 && gateAuto.body?.error === 'REVIEW_FORBIDDEN',
    `${gateAuto.status} ${gateAuto.body?.error}`,
  );

  // ---------------------------------------------------------------- 4. cleanup
  console.log('\n4) Özümüzdən sonra təmizlik');
  const revoke = await call('POST', `/api/panel/users/${state.userId}/revoke-keys`);
  check(
    'fikstur adamın açarları ləğv olunur',
    revoke.status === 200,
    `${revoke.status} ${JSON.stringify(revoke.body)?.slice(0, 160)}`,
  );
  const afterRevoke = await rowOf(state.userId);
  check(
    'ləğvdən sonra canlı açar sayı 0-dır',
    afterRevoke?.liveKeys === 0,
    String(afterRevoke?.liveKeys),
  );

  const delFixture = await call('DELETE', `/api/panel/users/${state.userId}`);
  check(
    'fikstur adam silinir',
    delFixture.status === 200,
    `${delFixture.status} ${JSON.stringify(delFixture.body)?.slice(0, 160)}`,
  );
  check('silmədən sonra siyahıda yoxdur', !(await rowOf(state.userId)));

  const delEmailOwner = await call('DELETE', `/api/panel/users/${state.duplicateOwnerId}`);
  check('e-poçt sahibi də silinir', delEmailOwner.status === 200, `${delEmailOwner.status}`);

  for (const prefix of [state.merchKeyPrefix, state.userKeyPrefix, fkPrefix, merchPrefix2].filter(
    Boolean,
  )) {
    const revoked = await call('POST', `/api/panel/keys/${prefix}/revoke`);
    check(
      `müvəqqəti açar ləğv olunur (${prefix})`,
      revoked.status === 200 || revoked.status === 404,
      `${revoked.status}`,
    );
  }

  const final = await settledCounts();
  const finalList = await call('GET', '/api/panel/users');
  const finalCount = (finalList.body?.data?.users || []).length;
  check(
    'adam sayı BAŞLANĞIC VƏZİYYƏTƏ qayıdıb (canlı endpoint)',
    finalCount === state.baselineUserCount,
    `${finalCount} ≠ ${state.baselineUserCount}`,
  );
  check(
    'health-in gecikən etiketi də uzlaşır',
    final.counts.users === state.baseline.counts.users,
    `${final.counts.users} ≠ ${state.baseline.counts.users}`,
  );
  check(
    'mağaza/tapşırıq/sübut sayları TOXUNULMAYIB',
    final.counts.stores === state.baseline.counts.stores &&
      final.counts.tasks === state.baseline.counts.tasks &&
      final.counts.evidences === state.baseline.counts.evidences,
    JSON.stringify(final.counts),
  );
  check(
    'sübut sayı dəyişməyib (heç bir audit təqdimatı yaradılmadı)',
    final.counts.evidences === state.baseline.counts.evidences,
    `${final.counts.evidences} ≠ ${state.baseline.counts.evidences}`,
  );

  console.log(`\n   health: ${final.detail}`);
  console.log(
    '\nQEYD: audit qeydləri SAYĞACI artıb — bu düzgündür, çünki hər yazı `logAuditEvent` çağırır.\n' +
      '   Audit sətirləri silinmir: onlar jurnaldır, zibil deyil.',
  );

  state.finishedAt = new Date().toISOString();
  state.finalCounts = final.counts;
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

  console.log(`\n=== HİSSƏ 2: ${passed} keçdi, ${failed} düşdü ===`);
  if (failed) console.log(`Düşənlər:\n  - ${failures.join('\n  - ')}`);
  console.log(
    '\nNÖVBƏTİ ADDIM: müvəqqəti bootstrap açarını SİL və API-ni yenidən başlat:\n' +
      '  railway variable delete ONETEAM_PANEL_BOOTSTRAP_KEY --service api\n' +
      '  railway redeploy --service api --yes\n',
  );
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error('Skript çökdü:', error);
  process.exit(3);
});
