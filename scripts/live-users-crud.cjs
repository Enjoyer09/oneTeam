/**
 * oneTeam — LIVE user-management verification against production (part 1 of 2).
 * ============================================================================
 *
 * WHY THIS EXISTS SEPARATELY FROM `test:roles`
 * --------------------------------------------
 * `test:roles` is the better test: it reads PostgreSQL back with a second
 * connection, so it can prove a row landed *before* the API answered. This
 * script cannot do that — the production database sits on Railway's private
 * network and is unreachable from a laptop. And HTTP alone proves nothing about
 * a write, because the read path is the in-memory array.
 *
 * So this script does what HTTP can do, and then hands off. It leaves its
 * fixtures in place and writes their ids to a state file; part 2 runs after the
 * API has been RESTARTED, and the restart is the real proof. A process that has
 * just started has no array from before, so a row that is still visible came
 * out of PostgreSQL.
 *
 * WHAT ELSE IT PROVES, WHICH IS THE POINT OF PHASE 1.5
 * ---------------------------------------------------
 * That the review gate is live and answers *first*. `requireReviewer` runs
 * before the submission is even looked up, so a merchandiser asking to review a
 * submission id that does not exist gets `403 REVIEW_FORBIDDEN`, while an
 * administrator asking about the same id gets `404`. That pair is the proof:
 * the difference is the role, not the id.
 *
 * THE BRANCH IT CANNOT REACH, AND WHY
 * -----------------------------------
 * `LAST_ADMIN` is unreachable over HTTP by construction. The route requires an
 * administrator (`requireAdmin`), and the guard only fires when the target is
 * the *only* administrator — which means the caller is that administrator, and
 * `CANNOT_CHANGE_OWN_ROLE` / `CANNOT_DELETE_SELF` answer first. It is a
 * belt-and-braces guard against two administrators demoting each other at the
 * same moment, which is not something a single-threaded script can stage. It is
 * covered locally, by making memory and the database disagree on purpose.
 *
 * IT CLEANS UP, BUT ONLY IN PART 2. If part 2 never runs, the fixture user stays
 * behind — deliberately, because it is the evidence.
 *
 * Usage:
 *   ONETEAM_API_URL=... ONETEAM_PANEL_KEY=... node scripts/live-users-crud.cjs
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
  let payload;
  const text = await response.text();
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text.slice(0, 300) };
  }
  return { status: response.status, body: payload };
}

/** The counts `/api/health` reports, so cleanup can be compared against them. */
async function health() {
  const response = await fetch(`${API}/api/health`);
  const payload = await response.json();
  const detail = String(payload.persistenceDetail || '');
  const counts = {};
  for (const match of detail.matchAll(/(\d+)\s+(\w+)/g)) counts[match[2]] = Number(match[1]);
  return {
    uptimeSeconds: payload.uptimeSeconds,
    detail,
    counts,
    photoStorage: payload.photoStorage?.driver ?? null,
  };
}

/** A row as `GET /api/panel/users` reports it, or undefined. */
async function rowOf(userId) {
  const listed = await call('GET', '/api/panel/users');
  return (listed.body?.data?.users || []).find((user) => user.id === userId);
}

async function main() {
  const stamp = Date.now().toString(36);
  const state = { startedAt: new Date().toISOString(), checks: {} };

  console.log(`\n=== Faza 1.5 canlı yoxlama — HİSSƏ 1 (${API}) ===\n`);

  // ---------------------------------------------------------------- 0. baseline
  console.log('0) Başlanğıc vəziyyəti');
  const before = await health();
  state.baseline = before;
  console.log(`   health: ${before.detail}`);
  console.log(`   uptimeSeconds: ${before.uptimeSeconds}, saxlanc: ${before.photoStorage}`);
  check(
    'API cavab verir və baza rejimindədir',
    before.counts.users !== undefined && before.uptimeSeconds > 0,
    JSON.stringify(before.counts),
  );

  const me = await call('GET', '/api/panel/me');
  const adminId = me.body?.data?.id ?? me.body?.data?.userId ?? null;
  const adminRole = me.body?.data?.role ?? null;
  state.adminId = adminId;
  check('müvəqqəti açarla `/api/panel/me` işləyir', me.status === 200 && !!adminId, `${me.status}`);
  check('bu açar ADMIN rolundadır', adminRole === 'ADMIN', String(adminRole));

  // ------------------------------------------------------- 1. the list contract
  console.log('\n1) `GET /api/panel/users` müqaviləsi');
  const list = await call('GET', '/api/panel/users');
  const rows = list.body?.data?.users || [];
  state.baselineUserCount = rows.length;

  check('siyahı 200 qaytarır', list.status === 200, `${list.status}`);
  check(
    'hər sətirdə operatorun qərar verə bildiyi sahələr var',
    rows.every(
      (row) =>
        typeof row.id === 'string' &&
        typeof row.fullName === 'string' &&
        typeof row.role === 'string' &&
        typeof row.deletable === 'boolean' &&
        'blockedBy' in row &&
        typeof row.liveKeys === 'number',
    ),
  );
  check(
    'dörd rol da elan olunur',
    ['ADMIN', 'SUPERVISOR', 'MERCHANDISER', 'STORE_STAFF'].every((role) =>
      (list.body?.data?.roles || []).includes(role),
    ),
    JSON.stringify(list.body?.data?.roles),
  );
  const selfRow = rows.find((row) => row.id === adminId);
  check('öz sətri `isSelf` ilə işarələnir', selfRow?.isSelf === true);
  check(
    'öz sətrində silmə `SELF` səbəbi ilə bağlıdır',
    selfRow?.blockedBy === 'SELF',
    String(selfRow?.blockedBy),
  );
  check(
    '`adminCount` bazadan gəlir və ən azı 1-dir',
    (list.body?.data?.adminCount ?? 0) >= 1,
    String(list.body?.data?.adminCount),
  );
  check(
    'sintez olunmuş `.local` ünvan real poçt kimi göstərilmir',
    rows.every((row) => !String(row.email || '').endsWith('@oneteam.local')),
  );

  // ------------------------------------------------------------- 2. create
  console.log('\n2) Adam yaratmaq — MİNİMAL body (yalnız ad + rol)');
  const created = await call('POST', '/api/panel/users', {
    fullName: `Canlı Yoxlama ${stamp}`,
    role: 'MERCHANDISER',
  });
  const userId = created.body?.data?.id ?? null;
  state.userId = userId;
  check(
    'minimal body ilə 201 qaytarır',
    created.status === 201,
    `${created.status} ${JSON.stringify(created.body)?.slice(0, 160)}`,
  );
  check('id serverdə yaranır', typeof userId === 'string' && userId.length > 0, String(userId));
  check(
    'e-poçt verilməyibsə `null` qaytarılır',
    created.body?.data?.email === null,
    JSON.stringify(created.body?.data?.email),
  );
  check(
    'rol verildiyi kimi qaytarılır',
    created.body?.data?.role === 'MERCHANDISER',
    String(created.body?.data?.role),
  );

  const afterCreate = await rowOf(userId);
  check('yeni adam siyahıda görünür', !!afterCreate, String(userId));
  check(
    '`joinedVia` `null`-dur (panel yaradıb)',
    afterCreate?.joinedVia === null,
    String(afterCreate?.joinedVia),
  );
  check('hələ açarı yoxdur', afterCreate?.liveKeys === 0, String(afterCreate?.liveKeys));
  // `countEvidencesByUser` LEFT JOINs, so a person with no submissions comes
  // back as `0`, not as a missing entry. `null` means "nothing is known", which
  // only happens when there is no database to ask.
  check(
    'təqdimatı yoxdur — `submissions` 0-dır (naməlum deyil)',
    afterCreate?.submissions === 0,
    String(afterCreate?.submissions),
  );
  check('silinə bilər', afterCreate?.deletable === true, String(afterCreate?.blockedBy));

  // -------------------------------------------------- 3. create refusals
  console.log('\n3) Yaratma rəddləri');
  const noName = await call('POST', '/api/panel/users', { role: 'MERCHANDISER' });
  check(
    'adsız → 400 `FULL_NAME_REQUIRED`',
    noName.status === 400 && noName.body?.error === 'FULL_NAME_REQUIRED',
    `${noName.status} ${noName.body?.error}`,
  );

  const badRole = await call('POST', '/api/panel/users', { fullName: 'Test', role: 'BOSS' });
  check(
    'yanlış rol → 400 `INVALID_ROLE`',
    badRole.status === 400 && badRole.body?.error === 'INVALID_ROLE',
    `${badRole.status} ${badRole.body?.error}`,
  );
  check(
    '`INVALID_ROLE` mesajı qəbul edilən rolları sayır',
    String(badRole.body?.message || '').includes('MERCHANDISER'),
  );

  const badEmail = await call('POST', '/api/panel/users', {
    fullName: 'Test',
    role: 'MERCHANDISER',
    email: 'bu-poçt-deyil',
  });
  check(
    'poçt formatı → 400 `INVALID_EMAIL`',
    badEmail.status === 400 && badEmail.body?.error === 'INVALID_EMAIL',
    `${badEmail.status} ${badEmail.body?.error}`,
  );

  const sharedEmail = `live-users-${stamp}@example.invalid`;
  const first = await call('POST', '/api/panel/users', {
    fullName: `E-poçt Sahibi ${stamp}`,
    role: 'SUPERVISOR',
    email: sharedEmail,
  });
  const duplicateOwnerId = first.body?.data?.id ?? null;
  check('e-poçtla yaratmaq 201 qaytarır', first.status === 201, `${first.status}`);
  check(
    'verilən e-poçt geri qaytarılır',
    first.body?.data?.email === sharedEmail,
    String(first.body?.data?.email),
  );

  const duplicate = await call('POST', '/api/panel/users', {
    fullName: `Eyni Poçt ${stamp}`,
    role: 'MERCHANDISER',
    email: sharedEmail,
  });
  check(
    'EYNİ e-poçt → 409 `EMAIL_TAKEN`',
    duplicate.status === 409 && duplicate.body?.error === 'EMAIL_TAKEN',
    `${duplicate.status} ${duplicate.body?.error}`,
  );

  check(
    'rədd olunan adam siyahıya DÜŞMƏYİB (yaddaşda qalmayıb)',
    (await call('GET', '/api/panel/users')).body?.data?.users?.length ===
      state.baselineUserCount + 2,
    'say gözləniləndən fərqlidir',
  );

  const supervisorRow = await rowOf(duplicateOwnerId);
  check(
    'SUPERVISOR rolu ilə yaranıb',
    supervisorRow?.role === 'SUPERVISOR',
    String(supervisorRow?.role),
  );

  // ------------------------------------------------------------- 4. edit
  console.log('\n4) Redaktə');
  const newName = `Canlı Yoxlama ${stamp} (redaktə)`;
  const edited = await call('PATCH', `/api/panel/users/${userId}`, {
    fullName: newName,
    phone: '+994501112233',
  });
  check(
    'ad + telefon redaktəsi 200 qaytarır',
    edited.status === 200,
    `${edited.status} ${JSON.stringify(edited.body)?.slice(0, 160)}`,
  );
  check(
    'cavab yeni adı daşıyır',
    edited.body?.data?.fullName === newName,
    String(edited.body?.data?.fullName),
  );
  check(
    'cavab yeni telefonu daşıyır',
    edited.body?.data?.phone === '+994501112233',
    String(edited.body?.data?.phone),
  );

  const editedRow = await rowOf(userId);
  check(
    'redaktə siyahıda görünür (ad)',
    editedRow?.fullName === newName,
    String(editedRow?.fullName),
  );
  check(
    'redaktə siyahıda görünür (telefon)',
    editedRow?.phone === '+994501112233',
    String(editedRow?.phone),
  );
  check(
    'rol TOXUNULMAYIB (qismən redaktə bütöv sətri əvəz etmir)',
    editedRow?.role === 'MERCHANDISER',
    String(editedRow?.role),
  );

  // ------------------------------------------------------ 5. edit refusals
  console.log('\n5) Redaktə rəddləri');
  const unknownEdit = await call('PATCH', '/api/panel/users/usr-yoxdur-123', { fullName: 'X' });
  check(
    'tanınmayan id → 404 `USER_NOT_FOUND`',
    unknownEdit.status === 404 && unknownEdit.body?.error === 'USER_NOT_FOUND',
    `${unknownEdit.status} ${unknownEdit.body?.error}`,
  );

  const nothing = await call('PATCH', `/api/panel/users/${userId}`, {});
  check(
    'boş body → 400 `NOTHING_TO_CHANGE`',
    nothing.status === 400 && nothing.body?.error === 'NOTHING_TO_CHANGE',
    `${nothing.status} ${nothing.body?.error}`,
  );

  const blankName = await call('PATCH', `/api/panel/users/${userId}`, { fullName: '   ' });
  check(
    'boş ad → 400 `FULL_NAME_REQUIRED`',
    blankName.status === 400 && blankName.body?.error === 'FULL_NAME_REQUIRED',
    `${blankName.status} ${blankName.body?.error}`,
  );

  const ownRole = await call('PATCH', `/api/panel/users/${adminId}`, { role: 'MERCHANDISER' });
  check(
    'ÖZ rolunu dəyişmək → 400 `CANNOT_CHANGE_OWN_ROLE`',
    ownRole.status === 400 && ownRole.body?.error === 'CANNOT_CHANGE_OWN_ROLE',
    `${ownRole.status} ${ownRole.body?.error}`,
  );
  const stillAdmin = await rowOf(adminId);
  check('rədd edilən cəhd rolu DƏYİŞMƏYİB', stillAdmin?.role === 'ADMIN', String(stillAdmin?.role));

  const sameRole = await call('PATCH', `/api/panel/users/${adminId}`, { role: 'ADMIN' });
  check(
    'eyni rolu yenidən yazmaq QADAĞAN DEYİL (qadağa dəyişikliyə aiddir, adama yox)',
    sameRole.status === 200,
    `${sameRole.status} ${sameRole.body?.error}`,
  );

  // ------------------------------------------------------- 6. delete refusals
  console.log('\n6) Silmə rəddləri');
  const selfDelete = await call('DELETE', `/api/panel/users/${adminId}`);
  check(
    'özünü silmək → 400 `CANNOT_DELETE_SELF`',
    selfDelete.status === 400 && selfDelete.body?.error === 'CANNOT_DELETE_SELF',
    `${selfDelete.status} ${selfDelete.body?.error}`,
  );
  check('rədd edilən silmədən sonra hesab yerindədir', !!(await rowOf(adminId)));

  const unknownDelete = await call('DELETE', '/api/panel/users/usr-yoxdur-123');
  check(
    'tanınmayan id silinəndə → 404 `USER_NOT_FOUND`',
    unknownDelete.status === 404 && unknownDelete.body?.error === 'USER_NOT_FOUND',
    `${unknownDelete.status} ${unknownDelete.body?.error}`,
  );

  // ------------------------------------------- 7. the role gate on /api/panel
  console.log('\n7) Rol qapısı: MERCHANDISER panel açarı `/api/panel/users`-ə çatmır');
  const merchMint = await call('POST', '/api/panel/keys', {
    userId: MERCH_USER_ID,
    label: `live-check-merch-${stamp}`,
  });
  const merchKey = merchMint.body?.data?.token ?? '';
  const merchPrefix = merchMint.body?.data?.hashPrefix ?? null;
  state.merchKeyPrefix = merchPrefix;
  check(
    'merchandiser üçün açar mint olundu (201)',
    merchMint.status === 201 && !!merchKey,
    `${merchMint.status} ${JSON.stringify(merchMint.body)?.slice(0, 160)}`,
  );

  const merchList = await call('GET', '/api/panel/users', undefined, merchKey);
  check(
    'merchandiser siyahını görə BİLMİR → 403 `ADMIN_REQUIRED`',
    merchList.status === 403 && merchList.body?.error === 'ADMIN_REQUIRED',
    `${merchList.status} ${merchList.body?.error}`,
  );

  const merchCreate = await call(
    'POST',
    '/api/panel/users',
    { fullName: 'Qaçaq', role: 'ADMIN' },
    merchKey,
  );
  check(
    'merchandiser adam yarada BİLMİR → 403 `ADMIN_REQUIRED`',
    merchCreate.status === 403 && merchCreate.body?.error === 'ADMIN_REQUIRED',
    `${merchCreate.status} ${merchCreate.body?.error}`,
  );

  const merchDelete = await call('DELETE', `/api/panel/users/${userId}`, undefined, merchKey);
  check(
    'merchandiser adam silə BİLMİR → 403 `ADMIN_REQUIRED`',
    merchDelete.status === 403 && merchDelete.body?.error === 'ADMIN_REQUIRED',
    `${merchDelete.status} ${merchDelete.body?.error}`,
  );

  const escaped = await rowOf(userId);
  check('rədd edilən hücumlardan sonra fikstur adamı yerindədir', !!escaped);

  // ------------------------------- 8. THE FIX: the review gate answers FIRST
  console.log('\n8) ƏSAS DÜZƏLİŞ: təsdiq qapısı axtarışdan ƏVVƏL cavab verir');
  const ghost = 'sub-live-yoxdur-000';
  const merchReview = await call(
    'POST',
    `/api/portal/submissions/${ghost}/review`,
    { status: 'approved' },
    merchKey,
  );
  check(
    'MERCHANDISER təsdiq yolunda → 403 `REVIEW_FORBIDDEN`',
    merchReview.status === 403 && merchReview.body?.error === 'REVIEW_FORBIDDEN',
    `${merchReview.status} ${merchReview.body?.error}`,
  );
  check(
    'rədd kodu `REVIEW_FORBIDDEN`-dir, `PANEL_KEY_REQUIRED` deyil',
    merchReview.body?.error !== 'PANEL_KEY_REQUIRED',
    String(merchReview.body?.error),
  );

  const adminReview = await call('POST', `/api/portal/submissions/${ghost}/review`, {
    status: 'approved',
  });
  check(
    'eyni id ilə ADMIN qapıdan KEÇİR və yalnız axtarışda dayanır → 404',
    adminReview.status === 404,
    `${adminReview.status} ${adminReview.body?.error}`,
  );
  check(
    'ikisi arasındakı fərq roldur, id deyil — qapı axtarışdan əvvəl işləyir',
    merchReview.status !== adminReview.status,
  );

  const merchAuto = await call(
    'POST',
    `/api/portal/submissions/${ghost}/auto-approve`,
    undefined,
    merchKey,
  );
  check(
    'avtomatik təsdiq yolunda da MERCHANDISER → 403 `REVIEW_FORBIDDEN`',
    merchAuto.status === 403 && merchAuto.body?.error === 'REVIEW_FORBIDDEN',
    `${merchAuto.status} ${merchAuto.body?.error}`,
  );

  const adminAuto = await call('POST', `/api/portal/submissions/${ghost}/auto-approve`);
  check(
    'avtomatik təsdiqdə ADMIN 404 alır (qapı keçilib, axtarış dayanıb)',
    adminAuto.status === 404,
    `${adminAuto.status} ${adminAuto.body?.error}`,
  );

  // ------------------------------------------- 9. the new person gets a key
  console.log('\n9) Yeni adama açar vermək (xarici açar zənciri canlıda)');
  const userMint = await call('POST', '/api/panel/keys', {
    userId,
    label: `live-check-user-${stamp}`,
  });
  const userKey = userMint.body?.data?.token ?? '';
  state.userKeyPrefix = userMint.body?.data?.hashPrefix ?? null;
  check(
    'yeni yaradılan adama açar mint olunur (201) — yəni sətir bazada HƏQİQƏTƏN var',
    userMint.status === 201 && !!userKey,
    `${userMint.status} ${JSON.stringify(userMint.body)?.slice(0, 200)}`,
  );

  const asUser = await call('GET', '/api/panel/me', undefined, userKey);
  // `/api/panel/me` answers with `userId`; `/api/panel/users` rows carry `id`.
  // Read the contract out of the code rather than assuming one shape.
  check(
    'açar yeni adamın kimliyinə çözülür',
    (asUser.body?.data?.userId ?? asUser.body?.data?.id) === userId,
    JSON.stringify(asUser.body?.data)?.slice(0, 160),
  );
  check(
    'yeni adamın rolu açarın gücünü müəyyən edir (MERCHANDISER)',
    asUser.body?.data?.role === 'MERCHANDISER',
    String(asUser.body?.data?.role),
  );

  const asUserList = await call('GET', '/api/panel/users', undefined, userKey);
  check(
    'yeni merchandiser də siyahıya çatmır → 403 `ADMIN_REQUIRED`',
    asUserList.status === 403 && asUserList.body?.error === 'ADMIN_REQUIRED',
    `${asUserList.status} ${asUserList.body?.error}`,
  );

  const userRowNow = await rowOf(userId);
  check(
    'siyahı artıq 1 canlı açar göstərir',
    userRowNow?.liveKeys === 1,
    String(userRowNow?.liveKeys),
  );

  // ------------------------------------------------------ 10. leave evidence
  console.log('\n10) Fiksturlar YERİNDƏ buraxılır (hissə 2 üçün sübut)');
  const after = await health();
  state.afterPart1 = after;
  state.duplicateOwnerId = duplicateOwnerId;
  state.expectedUserCount = state.baselineUserCount + 2;
  state.expectedUser = { fullName: newName, phone: '+994501112233', role: 'MERCHANDISER' };

  const finalList = await call('GET', '/api/panel/users');
  const finalCount = (finalList.body?.data?.users || []).length;
  check(
    'yekunda gözlənilən adam sayı',
    finalCount === state.expectedUserCount,
    `${finalCount} ≠ ${state.expectedUserCount}`,
  );
  console.log(`   health: ${after.detail}`);
  console.log(`   fikstur adam: ${userId}`);
  console.log(`   e-poçt sahibi: ${duplicateOwnerId}`);

  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(`   state → ${STATE_PATH}`);

  console.log(`\n=== HİSSƏ 1: ${passed} keçdi, ${failed} düşdü ===`);
  if (failed) console.log(`Düşənlər:\n  - ${failures.join('\n  - ')}`);
  console.log(
    '\nNÖVBƏTİ ADDIM: API-ni yenidən başlat, sonra hissə 2-ni işlət:\n' +
      '  node scripts/live-users-crud-after-restart.cjs\n',
  );
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error('Skript çökdü:', error);
  process.exit(3);
});
