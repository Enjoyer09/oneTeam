#!/usr/bin/env node
/**
 * ============================================================================
 *  oneTeam — demo hesablar: yarat, yoxla, çap et.
 * ============================================================================
 *
 * NİYƏ BU SKRİPT VAR
 * ------------------
 * Telefonda və Telegram-da testə başlamaq üçün üç ayrı kanalın hər birinə
 * girmək lazımdır və hər kanalın "girişi" başqa şeydir:
 *
 *   • Mobil tətbiq  — MAĞAZA KODU yazılır, tətbiq özü cihaz açarı (otd_) alır.
 *   • Telegram      — bota /start yazılır, sonra mağaza kodu göndərilir.
 *   • Veb panel     — bir dəfə verilən panel açarı (otp_) yapışdırılır.
 *
 * Bu üçünü hər dəfə əl ilə yığmaq asan unudulan bir işdir və ən pis halı
 * səssizdir: açar verilir, işləmir, səbəb görünmür. Ona görə bu skript
 * yaradır, YOXLAYIR və nəticəni bir kart kimi çap edir.
 *
 * İKİ YAZMA YOLU — VƏ NİYƏ MƏHZ BU İKİSİ
 * --------------------------------------
 *   • Panel açarları BAZADAN verilir (`db.issuePanelToken`).
 *     HTTP ilə verilə bilməz: `POST /api/panel/keys` administrator açarı
 *     tələb edir, administrator açarı isə yoxdur — məhz onu yaratmaq üçün bu
 *     skript işlədilir. Bu, "toyuq-yumurta" halıdır və `ONETEAM_PANEL_BOOTSTRAP_KEY`
 *     məhz bunun üçündür; biz isə bootstrap açarını `.env`-də saxlamırıq, çünki
 *     o, daimi bir kredensialdır.
 *
 *   • Cihaz qeydiyyatı HTTP İLƏ aparılır (`POST /api/portal/field/enroll`).
 *     Təkrar yazmaq olardı, amma olmaz: qeydiyyat mağazanın açıq tapşırıqlarını
 *     öz üzərinə götürür və audit qeydi yazır. Bu qaydalar `field.service.bind()`
 *     daxilindədir; skriptdə təkrarlansa, ikisi vaxtla bir-birindən sürüşərdi.
 *     Ona görə skript telefonun getdiyi YOLUN EYNİSİNİ gedir.
 *
 * NƏYİ DƏYİŞMİR
 * ------------
 * Skript mövcud tapşırıqlara TOXUNMUR — nə təyinatı dəyişir, nə statusu.
 * Yalnız özünün yaratdığı `demo:auto` etiketli panel açarlarını ləğv edib
 * yenidən verir ki, hər işlədilmədə açar yığılmasın.
 *
 * İSTİFADƏ
 * --------
 *   bash scripts/dev/ensure-dev-servers.sh      # əvvəlcə serverlər
 *   node scripts/dev/demo-accounts.mjs
 *
 * Açarları fərqli mühitə yönəltmək üçün:
 *   ONETEAM_API_URL=http://127.0.0.1:3011 node scripts/dev/demo-accounts.mjs
 */

// `dotenv/config` BİRİNCİ importdur və bu, təsadüfi deyil: ESM importları sıra
// ilə qiymətləndirilir, `db.init()` isə `DATABASE_URL`-i `process.env`-dən
// oxuyur. Sıra dəyişsə, skript səssizcə YADDAŞ rejimində işləyərdi — yəni
// açarlar "yaradılır", heç yerdə saxlanmır və yenidən başlatmadan sonra yox
// olurdu. Bu, məhz düzəltdiyimiz uğursuzluq sinfidir.
import 'dotenv/config';
import fs from 'node:fs';
import { db } from '@oneteam/database';

/** Demo kanallarının konfiqurasiyası — dəyişmək üçün yeganə yer. */
const DEMO = {
  mobile: {
    storeCode: 'BRAVO_YASAMAL_01',
    deviceId: 'demo-device-bravo-01',
    fullName: 'Demo Merçendayzer (Bravo Yasamal)',
  },
  telegram: { storeCode: 'BAZAR_PORTBAKU_03' },
  panel: [
    { userId: 'usr-admin-001', who: 'Administrator' },
    { userId: 'usr-super-002', who: 'Supervisor' },
  ],
};

/**
 * Bu skriptin verdiyi açarların etiketi.
 *
 * Lazımdır ki, təkrar işlədilmədə KÖHNƏ açarlar tanınıb ləğv edilsin. Etiket
 * olmasa hər çağırış bir açar daha yığardı və bir müddət sonra hansının canlı
 * olduğu bilinməzdi.
 */
const KEY_LABEL = 'demo:auto';

const STATE_DIR = process.env.ONETEAM_DEV_STATE_DIR || '/tmp';

/** Tapşırığın "iş görülə bilər" sayılan halları — `field.service` ilə eyni siyahı. */
const OPEN_TASK_STATES = new Set([
  'PUBLISHED',
  'DELIVERED',
  'ACKNOWLEDGED',
  'IN_PROGRESS',
  'SUBMITTED',
]);

function fail(lines) {
  console.error('');
  console.error('⛔ ' + lines[0]);
  for (const line of lines.slice(1)) console.error(line);
  console.error('');
  process.exit(1);
}

function heading(text) {
  console.log('');
  console.log('─'.repeat(64));
  console.log(' ' + text);
  console.log('─'.repeat(64));
}

/**
 * API ünvanını tapır — və tapmasa, TƏXMİN ETMİR.
 *
 * `src/services/portalApi.ts` defolt olaraq `http://localhost:3001` işlədir.
 * Bu maşında həmin portu layihədən olmayan proqram tutur, ona görə "3001"
 * ehtimalını işlətmək istifadəçini əminliklə yanlış sistemə yönəldərdi:
 * sorğular uğurlu görünər, cavablar isə başqa layihədən gələrdi.
 */
function resolveApiBase() {
  const fromEnv = (process.env.ONETEAM_API_URL || '').trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, '');

  const stateFile = `${STATE_DIR}/oneteam-dev-servers.env`;
  if (fs.existsSync(stateFile)) {
    const port = /^API_PORT=(.+)$/m.exec(fs.readFileSync(stateFile, 'utf8'))?.[1]?.trim();
    if (port) return `http://127.0.0.1:${port}`;
  }

  fail([
    'API ünvanı bilinmir.',
    '',
    `  ONETEAM_API_URL təyin edilməyib və vəziyyət faylı yoxdur: ${stateFile}`,
    '',
    '3001-i təxmin etmirik: bu maşında o portu başqa proqram tutur.',
    '',
    'Əvvəlcə serverləri qaldır:',
    '  bash scripts/dev/ensure-dev-servers.sh',
  ]);
}

/** Telegram tokeninin REAL olub-olmadığını deyir — dəyərini ÇAP ETMİR. */
function telegramTokenState() {
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) return { ok: false, reason: 'TELEGRAM_BOT_TOKEN boşdur' };
  if (token.includes('mockBotToken')) {
    return { ok: false, reason: 'yer tutucudur (içində "mockBotToken" var)' };
  }
  return { ok: true, reason: '' };
}

// ---------------------------------------------------------------------------
// 1. Baza
// ---------------------------------------------------------------------------
//
// ƏN VACİB YOXLAMA BUDUR. `db.init()` `DATABASE_URL` yoxdursa səssizcə yaddaş
// rejiminə düşür: `persistence` "memory" olur, açarlar isə... verilmir, çünki
// `issuePanelToken`/`issueDeviceToken` bazasız kredensial verməkdən İMTİNA edir.
// Yəni skript ya açarsız qalır, ya da — daha pisi — açar verib "hazırdır" deyir,
// halbuki o açar növbəti yenidən başlatmada yox olur.
//
// Ona görə burada dayanırıq və səbəbi açıq yazırıq.
await db.init();

if (db.persistence !== 'postgres') {
  fail([
    'Baza qoşulmayıb — demo hesablar YARADILMADI.',
    '',
    `  Cari rejim: ${db.persistence} (${db.persistenceDetail})`,
    '',
    'Səbəb adətən budur: `.env`-də `DATABASE_URL` yoxdur, ya da API/skript onu',
    'oxumur. Yaddaş rejimində verilən açar yenidən başlatmadan sonra işləməz,',
    'ona görə heç nə verməmək düzgün cavabdır.',
    '',
    'Yoxla:  grep -c DATABASE_URL .env',
  ]);
}

// ---------------------------------------------------------------------------
// 2. API
// ---------------------------------------------------------------------------
const API = resolveApiBase();

async function getJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!text) return { status: response.status, body: null };
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    // Cavab JSON deyilsə, onu udmuruq: ekranda göstərilən mətn səbəbi izah edir,
    // boş obyekt isə "heç nə" kimi oxunardı.
    return { status: response.status, body: { raw: text.slice(0, 200) } };
  }
}

const health = await getJson(`${API}/api/health`);
if (health.status !== 200 || health.body?.service !== 'oneteam-api') {
  fail([
    `API cavab vermir və ya bu, oneTeam API deyil: ${API}/api/health`,
    '',
    `  HTTP ${health.status} · ${JSON.stringify(health.body)?.slice(0, 160)}`,
    '',
    'Portu başqa proqram tuta bilər. Serverləri qaldır və ya portu açıq ver:',
    '  bash scripts/dev/ensure-dev-servers.sh',
    '  ONETEAM_API_URL=http://127.0.0.1:3011 node scripts/dev/demo-accounts.mjs',
  ]);
}
if (health.body.persistence !== 'postgres') {
  fail([
    'API YADDAŞ rejimindədir — demo hesablar davamlı olmayacaq.',
    '',
    `  persistence: ${health.body.persistence}`,
    '',
    'API `.env`-i yükləmir. `apps/api/src/main.ts`-də `import "dotenv/config"` var?',
  ]);
}

// ---------------------------------------------------------------------------
// 3. Mağazalar və açıq iş
// ---------------------------------------------------------------------------
//
// Mağaza kodları seed-dəndir; burada yalnız YOXLAYIRIQ ki, kod həqiqətən var və
// həmin mağazada iş var. "Kod var" və "iş var" ayrı şeylərdir: DRAFT statuslu
// tapşırıq sahə işçisinə GÖRÜNMÜR, yəni mağaza açıq olsa da test boş keçərdi.
heading('MAĞAZALAR');
const storeFacts = [];
for (const channel of ['mobile', 'telegram']) {
  const code = DEMO[channel].storeCode;
  const store = db.getStoreByCode(code);
  if (!store) {
    fail([
      `Mağaza kodu tapılmadı: ${code}`,
      '',
      'Seed işlədilməyib. Yoxla:',
      '  psql "$DATABASE_URL" -f db/api-seed.sql',
    ]);
  }
  const open = db.storeTasks.filter(
    (task) => task.storeId === store.id && OPEN_TASK_STATES.has(task.status),
  );
  storeFacts.push({ channel, code, store, open });
  console.log(
    `  ${channel === 'mobile' ? 'Mobil   ' : 'Telegram'} · ${code.padEnd(20)} ` +
      `${store.name} — ${open.length} açıq tapşırıq`,
  );
}

// ---------------------------------------------------------------------------
// 4. Panel açarları (bazadan)
// ---------------------------------------------------------------------------
heading('PANEL AÇARLARI');

// Əvvəlki çağırışın açarlarını ləğv edirik. Etiketə görə tapılır, ona görə
// skript öz işini yadda saxlamalı deyil.
const allKeys = await db.listPanelTokens(true);
const stale = allKeys.filter((row) => row.label === KEY_LABEL && !row.revokedAt);
for (const row of stale) {
  await db.revokePanelTokenByHash(row.tokenHash);
}
if (stale.length > 0) {
  console.log(`  (əvvəlki ${stale.length} demo açarı ləğv edildi)`);
}

const panelKeys = [];
for (const person of DEMO.panel) {
  const issued = await db.issuePanelToken({ userId: person.userId, label: KEY_LABEL });
  if (!issued) {
    fail([
      `Panel açarı verilə bilmədi: ${person.userId}`,
      '',
      'Bazaya yazıla bilmədi, ya da bu identifikatorla istifadəçi yoxdur.',
      'Yaddaşda saxlanılan açar yenidən başlatmadan sonra işləməz, ona görə',
      'yarımçıq kredensial vermirik.',
    ]);
  }
  panelKeys.push({ ...person, token: issued.token });
  console.log(`  ✓ ${person.who.padEnd(14)} → ${person.userId}`);
}

// ---------------------------------------------------------------------------
// 5. Mobil kanal — REAL qeydiyyat sorğusu
// ---------------------------------------------------------------------------
//
// Tətbiqin getdiyi yolun eynisi. Nəticə iki şeyi sübut edir: mağaza kodu
// işləyir və server cihaz açarı verə BİLİR (bazasız bu, 503
// `ENROLMENT_UNAVAILABLE` olardı).
heading('MOBİL KANAL');

const enroll = await getJson(`${API}/api/portal/field/enroll`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    storeCode: DEMO.mobile.storeCode,
    deviceId: DEMO.mobile.deviceId,
    fullName: DEMO.mobile.fullName,
  }),
});

if (enroll.status !== 200 || !enroll.body?.data?.token) {
  fail([
    'Mobil qeydiyyat alınmadı.',
    '',
    `  HTTP ${enroll.status} · ${JSON.stringify(enroll.body)?.slice(0, 200)}`,
    '',
    'Ən çox rast gəlinən səbəb: server bazaya qoşulmayıb (503 ENROLMENT_UNAVAILABLE).',
  ]);
}

const deviceToken = enroll.body.data.token;
console.log(`  ✓ Qeydiyyat işlədi → ${enroll.body.data.userId}`);
console.log(`    öz üzərinə götürdüyü tapşırıq: ${enroll.body.data.claimedTaskIds?.length ?? 0}`);

// ---------------------------------------------------------------------------
// 6. Kart
// ---------------------------------------------------------------------------
const telegram = telegramTokenState();

heading('DEMO GİRİŞ MƏLUMATLARI');

console.log('  MOBİL TƏTBİQ (iPhone)');
console.log(`    Mağaza kodu ......: ${DEMO.mobile.storeCode}`);
console.log(`    Ad və soyad ......: ${DEMO.mobile.fullName}`);
console.log('    Yəni: tətbiqi aç → "Mağaza kodu" sahəsinə yuxarıdakı kodu yaz → davam et.');
console.log(`    (yoxlama üçün cihaz açarı: ${deviceToken.slice(0, 12)}…)`);
console.log('');

console.log('  VEB PANEL');
for (const key of panelKeys) {
  console.log(`    ${key.who.padEnd(14)}: ${key.token}`);
}
console.log('    Yəni: paneli aç → giriş ekranına açarı yapışdır.');
console.log('');

console.log('  TELEGRAM');
if (telegram.ok) {
  console.log('    ✓ Token real görünür — bot Telegram-a qoşula bilər.');
} else {
  console.log(`    ⛔ HAZIR DEYİL — ${telegram.reason}.`);
  console.log('       Token olmadan bot Telegram-a qoşulmur; bot "Standby/Test rejimi"');
  console.log('       yazıb dayanır. @BotFather-dan real token al və `.env`-ə yaz.');
}
console.log(`    Mağaza kodu ......: ${DEMO.telegram.storeCode}`);
console.log('    Yəni: bota /start yaz → mağaza kodunu göndər → menyu açılır.');
console.log('');

console.log('  Qeyd: panel açarları hər işlədilmədə yenidən verilir və köhnəsi ləğv olunur.');
console.log('        Yuxarıdakı açarlardan başqasını saxlamısansa, o artıq keçərsizdir.');
console.log('');

await db.close();
