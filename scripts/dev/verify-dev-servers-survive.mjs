#!/usr/bin/env node
/**
 * `ensure-dev-servers.sh`-in başlatdığı serverlər çağıran prosesi tərk edəndə
 * SAĞ QALIRMI — bunu yoxlayır.
 *
 * NİYƏ BU TEST VAR
 * ----------------
 * Xcode "Run" sıxılanda sxemin pre-action-ı bu skripti çağırır, skript
 * serverləri fonda başladıb ÇIXIR. Əgər serverlər çağıranın arxasınca ölürsə,
 * telefon paketi ala bilmir və ekranda SƏBƏB GÖRÜNMÜR — istifadəçi yalnız boş
 * ekran görür. Səssiz uğursuzluqdur: skript "✓ hazırdır" yazır, çıxış kodu 0
 * olur, problem isə tamam başqa yerdə görünür.
 *
 * ÖLÇÜLDÜ (18 sentyabr 2026): `nohup cmd &` bu vəziyyətdə KİFAYƏT DEYİL.
 * `nohup` yalnız SIGHUP-ı bloklayır; proses QRUPLARININ ləğvi isə siqnal deyil,
 * ona görə oradan qorumur. Sınaqda API və Metro düzgün qalxdı, skript
 * "✓ API hazırdır. ✓ Metro hazırdır." yazdı, çıxış kodu 0 oldu — sonra hər ikisi
 * qrup ləğv ediləndə öldü (loqlarda dayanma mesajı YOXDUR, PID-lər ölü: yəni
 * xəta ilə deyil, qrupla ləğv ediliblər). Düzəliş: `spawn_detached` — proses
 * YENİ SESSİYADA (`setsid()`) başladılır.
 *
 * NƏYİ SİMULYASİYA EDİR — VƏ NƏYİ ETMİR
 * -------------------------------------
 * "Düşmən" çağıranı təqlid edir: skripti AYRI proses qrupunda başladır,
 * bitməsini gözləyir, sonra həmin QRUPA `SIGKILL` göndərir. Agent harness-ları
 * və bəzi IDE-lər öz uşaqlarını elə təmizləyir.
 *
 * BU, XCODE-UN BELƏ ETDİYİNİ İDDİA ETMİR — o, ÖLÇÜLMƏYİB. Test yalnız skriptin
 * belə bir çağırana davamlı olduğunu təsdiqləyir. Bu, `setsid()`-in verdiyi
 * zəmanətdir və heç bir halda zərər vermir.
 *
 * İKİ MƏRHƏLƏ — ikincisi testin ÖZÜNÜ yoxlayır
 * --------------------------------------------
 *   1. Cari skript: qrup ləğvindən sonra serverlər SAĞ olmalıdır.
 *   2. Nəzarət (`nohup` + `&`, eyni qrup): proses ÖLMƏLİDİR. Ölmürsə, bu testin
 *      öncülü səhvdir və o, heç nəyi qorumur — o halda test özü uğursuz sayılır.
 *      (Bu, `break-the-detector` doktrinasıdır: testin dişlədiyini göstər.)
 *
 * AYRICA: vəziyyət faylının müqaviləsini yoxlayır (`/tmp/oneteam-dev-servers.env`).
 * `run-on-device.sh` seçilmiş portu oradan oxuyur; fayl yanlış olsa, istifadəçi
 * YANLIŞ ünvan görər.
 *
 * İŞLƏTMƏK
 * --------
 *     node scripts/dev/verify-dev-servers-survive.mjs
 *
 * Serverləri TOXUNMUR: öz portlarını (3299 / 8181) açıq şəkildə verir, ona görə
 * istifadəçinin 3011/8081-də işləyən serverləri yerində qalır. 3299 seçilib, çünki
 * 3199-u `test:break:device-revoke` artıq işlədir (bax: `RULES.md`).
 *
 * CI-da işləmir: `ensure-dev-servers.sh` `CI=true` görəndə dərhal çıxır
 * (serverləri CI-da test skripti özü idarə edir). Ona görə bu, lokal
 * harness-dır — `test:break*` skriptləri kimi.
 *
 * Uğursuzluqda çıxış kodu 1-dir.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const ensureScript = path.join(repoRoot, 'scripts/dev/ensure-dev-servers.sh');

// ÖZ vəziyyət qovluğumuz. MÜTLƏQDİR: skript loqları, PID fayllarını və vəziyyət
// faylını `/tmp`-də saxlayır. Onları paylaşsaq, test istifadəçinin HƏQİQİ
// serverlərinin qeydlərini üzərinə yazardı — və testdən sonra `run-on-device.sh`
// testin portunu istifadəçinin portu kimi göstərərdi, yəni düzəltməyə
// çalışdığımız yalanı özümüz yaradardıq.
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oneteam-survive-'));
const stateFile = path.join(stateDir, 'oneteam-dev-servers.env');

// Testin öz portları. Açıq verilir ki, (a) istifadəçinin serverlərinə toxunmasın,
// (b) test deterministik olsun — portu əvvəlcədən bilirik və əvvəlcə boş olduğunu
// yoxlaya bilirik. Əks halda köhnə bir server "sağ qaldı" kimi görünə bilərdi.
// 3199 SEÇİLMƏDİ: onu `test:break:device-revoke` artıq işlədir (bax: `RULES.md`).
const API_PORT = 3299;
const METRO_PORT = 8181;

let failures = 0;

function check(label, ok, detail) {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}`);
    if (detail !== undefined && detail !== '') console.log(`      ${detail}`);
  }
}

function listening(port) {
  const out = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  return out.status === 0 && (out.stdout || '').trim().length > 0;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Skripti ayrı proses qrupunda başladır, bitməsini gözləyir, sonra qrupu öldürür. */
function runThenKillGroup(args, env) {
  return new Promise((resolve) => {
    const child = spawn('bash', [ensureScript, ...args], {
      cwd: repoRoot,
      detached: true, // ayrı sessiya + ayrı proses qrupu (pgid === child.pid)
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (d) => {
      output += d;
    });
    child.stderr.on('data', (d) => {
      output += d;
    });

    child.on('close', async () => {
      // Çağıranın "təmizlik" davranışı: bütün proses qrupunu ləğv et.
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* qrup artıq yoxdursa — problem deyil */
      }
      await sleep(1500); // portların azad olması üçün kiçik fasilə
      resolve(output);
    });
  });
}

// --- CI-da işləmir ----------------------------------------------------------
if (process.env.CI === 'true') {
  console.log('CI mühiti — bu harness server başlatdığı üçün burada işlədilmir.');
  process.exit(0);
}

if (!fs.existsSync(path.join(repoRoot, 'mobile/node_modules'))) {
  console.log('mobile/node_modules yoxdur — Metro başlada bilməz. Əvvəlcə: cd mobile && npm ci');
  process.exit(0);
}

console.log('\nServerlər çağıranın arxasınca ölürmü?');
console.log(
  `(test portları: API ${API_PORT}, Metro ${METRO_PORT} — istifadəçinin serverlərinə toxunulmur)`,
);

// --- 0. Zəmin: test portları boş olmalıdır ----------------------------------
console.log('\nZəmin');
const apiBusy = listening(API_PORT);
const metroBusy = listening(METRO_PORT);
check(`port ${API_PORT} boşdur`, !apiBusy, 'bu portda artıq nəsə işləyir — test yanlış keçə bilər');
check(
  `port ${METRO_PORT} boşdur`,
  !metroBusy,
  'bu portda artıq nəsə işləyir — test yanlış keçə bilər',
);

if (apiBusy || metroBusy) {
  console.log('\nTest dayandırıldı: zəmin təmiz deyil.');
  process.exit(1);
}

// --- 1. Cari skript: qrup ləğvindən sonra SAĞ qalmalıdır ---------------------
console.log('\n1. Cari skript (setsid) — qrup ləğv edildikdən sonra');
const startedOutput = await runThenKillGroup([], {
  API_PORT: String(API_PORT),
  METRO_PORT: String(METRO_PORT),
  ONETEAM_DEV_STATE_DIR: stateDir,
});
process.stdout.write(
  startedOutput
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => `      │ ${line}`)
    .join('\n') + '\n',
);

check(
  `API ${API_PORT} portunda hələ də cavab verir`,
  listening(API_PORT),
  'server çağıranla birlikdə öldü',
);
check(
  `Metro ${METRO_PORT} portunda hələ də cavab verir`,
  listening(METRO_PORT),
  'server çağıranla birlikdə öldü',
);

// PID faylları da sağ olmalıdır: `--stop` və "təkrar istifadə" onlara güvənir.
for (const [name, file] of [
  ['API', path.join(stateDir, 'oneteam-api.pid')],
  ['Metro', path.join(stateDir, 'oneteam-metro.pid')],
]) {
  const pid = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8').trim()) : NaN;
  check(
    `${name} PID faylı canlı prosesə işarə edir`,
    Number.isFinite(pid) && alive(pid),
    `${file} = ${pid}`,
  );
}

// --- 2. Vəziyyət faylının müqaviləsi ---------------------------------------
console.log('\n2. Vəziyyət faylı (run-on-device.sh buradan oxuyur)');
const state = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : '';
const field = (key) => (state.match(new RegExp(`^${key}=(.*)$`, 'm')) || [])[1] ?? '';

check('vəziyyət faylı yaradıldı', state !== '', stateFile);
check(
  `API_PORT=${API_PORT}`,
  field('API_PORT') === String(API_PORT),
  `faylda: ${field('API_PORT')}`,
);
check(
  `METRO_PORT=${METRO_PORT}`,
  field('METRO_PORT') === String(METRO_PORT),
  `faylda: ${field('METRO_PORT')}`,
);
check('API_UP=yes', field('API_UP') === 'yes', `faylda: ${field('API_UP')}`);
check(
  `API_URL portu ${API_PORT} ilə üst-üstə düşür`,
  field('API_URL').endsWith(`:${API_PORT}`),
  `faylda: ${field('API_URL')}`,
);
check(
  'API_URL localhost deyil (telefon onu tapa bilməz)',
  !/localhost|127\.0\.0\.1/.test(field('API_URL')),
  field('API_URL'),
);

// --- 3. Nəzarət: test həqiqətən dişləyirmi? --------------------------------
// Köhnə üsul (`nohup cmd &`, eyni proses qrupu) qrup ləğv ediləndə ÖLMƏLİDİR.
// Ölmürsə, 1-ci addım heç nəyi sübut etmir — çünki hər iki üsul sağ qalırdı.
console.log('\n3. Nəzarət — test dişləyirmi? (nohup + &, eyni qrup)');
const controlPid = await new Promise((resolve) => {
  const child = spawn('bash', ['-c', 'nohup sleep 300 > /dev/null 2>&1 & echo $!'], {
    cwd: repoRoot,
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let out = '';
  child.stdout.on('data', (d) => {
    out += d;
  });
  child.on('close', async () => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* artıq yoxdur */
    }
    await sleep(800);
    resolve(Number(out.trim()));
  });
});

check(
  'köhnə üsulla başladılan proses qrup ləğvində ÖLDÜ',
  Number.isFinite(controlPid) && !alive(controlPid),
  'nohup prosesi sağ qaldı — o zaman bu testin öncülü səhvdir və 1-ci addım heç nəyi sübut etmir',
);

// --- Nəticə -----------------------------------------------------------------
console.log('');
if (failures === 0) {
  console.log('Hamısı keçdi.');
} else {
  console.log(`${failures} yoxlama uğursuz oldu.`);
}

// Təmizlik: testin ÖZ serverlərini dayandır və müvəqqəti qovluğu sil. Onları
// işlək saxlamaq maşında iki API və iki Metro yaradardı və hansının hansı
// olduğu qarışardı. İstifadəçinin serverlərinə toxunulmur.
spawnSync('bash', [ensureScript, '--stop'], {
  cwd: repoRoot,
  env: {
    ...process.env,
    ONETEAM_DEV_STATE_DIR: stateDir,
    API_PORT: String(API_PORT),
    METRO_PORT: String(METRO_PORT),
  },
  stdio: 'ignore',
});
fs.rmSync(stateDir, { recursive: true, force: true });
console.log('(testin öz serverləri dayandırıldı; istifadəçinin serverlərinə toxunulmadı)');

process.exit(failures === 0 ? 0 : 1);
