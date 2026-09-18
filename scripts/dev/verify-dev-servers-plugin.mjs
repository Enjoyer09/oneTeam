#!/usr/bin/env node
/**
 * `withDevServers` plaginini iki səviyyədə yoxlayır: sxem düzəlişinin özü
 * (sürətli, təcrid olunmuş) və plagini HƏQİQİ `expo prebuild`-də işlətməklə.
 *
 * NİYƏ İKİ SƏVİYYƏ — 18 SENTYABR 2026 DƏRSİ
 * -----------------------------------------
 * Əvvəlcə bu skript yalnız `patchScheme`-i TƏK BAŞINA çağırırdı və yaşıl idi.
 * Həmin commit-in CI-ı isə qırmızı oldu:
 *
 *     TypeError: [ios.xcodeproj]: withIosXcodeprojBaseMod:
 *     Cannot destructure property 'modRequest' of 'undefined'
 *
 * Səbəb: plaginin `withXcodeProject` geri çağırışı `cfg`-i qaytarmırdı.
 * `withMod`-un `interceptingMod`-u action-ın QAYTARDIĞI dəyəri növbəti moda
 * ötürür; `undefined` ötürüləndə zəncir qırılır və xəta mesajı günahkar faylın
 * adını ÇƏKMİR. Yəni test yaşıl idi, çünki **plagini plagin kimi heç vaxt
 * işlətmirdi**. Buna görə 7-ci addım əlavə olundu: o, temp qovluqda həqiqi
 * prebuild işlədir və nəticəni generasiya olunan sxemdə yoxlayır.
 *
 * YOXLADIKLARI
 * ------------
 *   1. `LaunchAction`-a PreActions bloku əlavə olunur.
 *   2. Blok `ensure-dev-servers.sh`-ə işarə edir.
 *   3. Nəticə düzgün XML-dir (`xmllint` varsa onunla təsdiqlənir).
 *   4. İkinci tətbiq heç nə etmir — iki PreActions bloku yaranmır.
 *   5. `withUITests`-in yazdığı `<Testables>` bloku toxunulmaz qalır.
 *   6. `<LaunchActionEntries>` kimi oxşar adlı element səhvən dəyişdirilmir.
 *   7. Həqiqi `expo prebuild` uğurla bitir və generasiya olunan sxemdə blok var.
 *
 * İŞLƏTMƏK
 * --------
 *     node scripts/dev/verify-dev-servers-plugin.mjs            # hamısı
 *     node scripts/dev/verify-dev-servers-plugin.mjs --fast     # 7-ci addım yox
 *
 * Uğursuzluqda çıxış kodu 1-dir.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

const plugin = require(path.join(repoRoot, 'mobile/plugins/withDevServers.js'));

let failures = 0;

function check(label, ok, detail) {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}`);
    if (detail !== undefined) console.log(`      ${detail}`);
  }
}

const iosRoot = path.join(repoRoot, 'mobile/ios');
const schemeDir = fs
  .readdirSync(iosRoot)
  .filter((entry) => entry.endsWith('.xcodeproj'))
  .map((entry) => entry.replace(/\.xcodeproj$/, ''))[0];

if (!schemeDir) {
  console.log('⚠️  mobile/ios-də .xcodeproj yoxdur — əvvəlcə prebuild işlət.');
  process.exit(1);
}

const realScheme = path.join(
  iosRoot,
  `${schemeDir}.xcodeproj`,
  'xcshareddata',
  'xcschemes',
  `${schemeDir}.xcscheme`,
);

if (!fs.existsSync(realScheme)) {
  console.log(`⚠️  Sxem tapılmadı: ${realScheme}`);
  process.exit(1);
}

console.log(`\nSxem: ${path.relative(repoRoot, realScheme)}`);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oneteam-scheme-'));
const tempScheme = path.join(tempDir, `${schemeDir}.xcscheme`);

try {
  // --- 1. Tətbiq ------------------------------------------------------------
  //
  // Həqiqi sxemin KOPİYASI götürülür, sonra artıq tətbiq olunmuş PreActions
  // bloku (varsa) çıxarılır. Bu vacibdir: `ios/` generasiya olunduğu üçün
  // sxem bəzən artıq düzəldilmiş olur, bəzən yox — test hər iki halda "əlavə
  // etmə" yolunu yoxlamalıdır, canlı vəziyyətdən asılı qalmamalıdır.
  const raw = fs.readFileSync(realScheme, 'utf8');
  const unpatched = raw.replace(/\n?\s*<PreActions>[\s\S]*?<\/PreActions>/, '');
  check('sxemdə <LaunchAction> var', /<LaunchAction\s/.test(unpatched));

  fs.writeFileSync(tempScheme, unpatched);
  const before = unpatched;

  console.log('\nDüzəliş tətbiq olunur');
  const outcome = plugin.patchScheme(tempScheme, schemeDir, 'TESTUUID123');
  check('patchScheme "added" qaytardı', outcome === 'added', `alındı: ${outcome}`);

  const after = fs.readFileSync(tempScheme, 'utf8');

  check('PreActions bloku əlavə olundu', after.includes('<PreActions>'));
  check('blok ensure-dev-servers.sh-ə işarə edir', after.includes('ensure-dev-servers.sh'));
  check(
    'skript yolu repo kökünü düzgün hesablayır ($SRCROOT/../..)',
    after.includes('$SRCROOT/../../scripts/dev/ensure-dev-servers.sh'),
  );
  check(
    'PreActions LaunchAction-dan SONRA gəlir',
    after.indexOf('<PreActions>') > after.indexOf('<LaunchAction'),
  );

  // --- 2. Testables toxunulmaz ---------------------------------------------
  console.log('\nwithUITests-in yazdığı blok qorunur');
  const testablesOf = (text) => (text.match(/<Testables>[\s\S]*?<\/Testables>/) || [''])[0];
  check('<Testables> bloku dəyişməyib', testablesOf(before) === testablesOf(after));

  // --- 3. XML düzgündür? ---------------------------------------------------
  console.log('\nXML düzgünlüyü');
  const xmllint = spawnSync('xmllint', ['--noout', tempScheme], { encoding: 'utf8' });
  if (xmllint.error && xmllint.error.code === 'ENOENT') {
    console.log('  – xmllint yoxdur, yoxlama ötürüldü');
  } else {
    check('xmllint faylı qəbul edir', xmllint.status === 0, (xmllint.stderr || '').trim());
  }

  // --- 4. Təkrar tətbiq heç nə etmir ---------------------------------------
  console.log('\nTəkrar tətbiq (idempotentlik)');
  const second = plugin.patchScheme(tempScheme, schemeDir, 'TESTUUID123');
  const afterSecond = fs.readFileSync(tempScheme, 'utf8');

  check(
    'ikinci çağırış "already present" qaytardı',
    second === 'already present',
    `alındı: ${second}`,
  );
  check('iki PreActions bloku yaranmadı', (afterSecond.match(/<PreActions>/g) || []).length === 1);
  check('fayl dəyişməz qaldı', afterSecond === after);

  // --- 5. Oxşar adlı element qarışdırılmır ---------------------------------
  console.log('\nOxşar adlı elementlərin qarışdırılmaması');
  const decoy = path.join(tempDir, 'decoy.xcscheme');
  const decoyText =
    '<?xml version="1.0" encoding="UTF-8"?>\n<Scheme>\n   <BuildAction>\n' +
    '      <LaunchActionEntries>\n      </LaunchActionEntries>\n   </BuildAction>\n' +
    '   <LaunchAction\n      buildConfiguration = "Debug">\n   </LaunchAction>\n</Scheme>\n';
  fs.writeFileSync(decoy, decoyText);
  plugin.patchScheme(decoy, schemeDir, 'TESTUUID123');
  const decoyAfter = fs.readFileSync(decoy, 'utf8');
  check(
    '<LaunchActionEntries> toxunulmadı',
    decoyAfter.includes('<LaunchActionEntries>\n      </LaunchActionEntries>'),
  );
  check(
    'düzgün <LaunchAction> dəyişdirildi',
    /<LaunchAction\s[^>]*>\n\s*<PreActions>/.test(decoyAfter),
  );

  // --- 6. Canlı sxem -------------------------------------------------------
  //
  // `prebuild` sxemi sıfırdan yazır və plagin onu dərhal düzəldir; iki dəfə
  // işləsə belə tək blok qalmalıdır. İki blok olsa Xcode hansını işlədəcəyini
  // bilməz — ona görə bu, ayrıca yoxlanılır.
  console.log('\nCanlı sxem');
  const liveCount = (raw.match(/<PreActions>/g) || []).length;
  check('canlı sxemdə ən çoxu bir PreActions bloku var', liveCount <= 1, `say: ${liveCount}`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

// --- 7. Həqiqi prebuild ------------------------------------------------------
//
// Yuxarıdakı yoxlamalar plagini PLAQİN KİMİ işlətmir — onlar yalnız
// `patchScheme` funksiyasını çağırır. Plaginin Expo ilə bağlanma nöqtəsi
// (`withXcodeProject` geri çağırışının qaytardığı dəyər) isə burada yoxlanılır.
// 18 sentyabr 2026-da CI məhz bu nöqtədə qırıldı; o vaxt bu addım yox idi.
//
// `ios/` generasiya olunduğu üçün real `mobile/` qovluğunda prebuild işlətmək
// istifadəçinin imzalama parametrlərini silərdi. Buna görə `mobile/` (native
// qovluq olmadan) temp qovluğa köçürülür, `node_modules` isə symlink edilir —
// paketlər təkrar quraşdırılmır.
console.log('\nHəqiqi prebuild (temp qovluqda)');

const mobileDir = path.join(repoRoot, 'mobile');

if (process.argv.includes('--fast')) {
  console.log('  – --fast verildi, bu addım ötürüldü');
} else if (!fs.existsSync(path.join(mobileDir, 'node_modules'))) {
  console.log('  – mobile/node_modules yoxdur — addım ötürüldü (əvvəlcə `cd mobile && npm ci`)');
} else {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'oneteam-prebuild-'));

  try {
    const copy = spawnSync(
      'rsync',
      [
        '-a',
        '--exclude',
        'node_modules',
        '--exclude',
        'ios',
        '--exclude',
        'dist',
        '--exclude',
        '.expo',
        `${mobileDir}/`,
        `${stage}/`,
      ],
      { encoding: 'utf8' },
    );
    check('mobil qovluq temp-ə köçürüldü', copy.status === 0, (copy.stderr || '').trim());

    fs.symlinkSync(path.join(mobileDir, 'node_modules'), path.join(stage, 'node_modules'));

    const prebuild = spawnSync('npx', ['expo', 'prebuild', '--platform', 'ios', '--no-install'], {
      cwd: stage,
      encoding: 'utf8',
      env: { ...process.env, CI: 'true', EXPO_NO_TYPESCRIPT_SETUP: '1' },
    });

    const output = `${prebuild.stdout || ''}${prebuild.stderr || ''}`.trim();
    const prebuildOk = prebuild.status === 0;
    check(
      'prebuild uğurla bitdi',
      prebuildOk,
      output.split('\n').slice(-12).join('\n') || `exit ${prebuild.status}`,
    );

    // Prebuild uğursuzsa `stage/ios` YARIMÇIQ artefaktdır: modların bir qismi
    // işləyib, qalanı yox. Onun üzərində iddia yoxlamaq "keçdi" deyə bilər və
    // bu, yalançı yaşıl olar — buna görə yalnız uğurlu prebuilddən sonra
    // nəticə yoxlanılır.
    if (!prebuildOk) {
      console.log('      (prebuild uğursuz olduğu üçün nəticə yoxlanılmır)');
    } else {
      const generated = path.join(
        stage,
        'ios',
        `${schemeDir}.xcodeproj`,
        'xcshareddata',
        'xcschemes',
        `${schemeDir}.xcscheme`,
      );

      if (!fs.existsSync(generated)) {
        check('generasiya olunan sxem tapıldı', false, generated);
      } else {
        const text = fs.readFileSync(generated, 'utf8');
        check('generasiya olunan sxemdə PreActions var', text.includes('<PreActions>'));
        check(
          'generasiya olunan blok ensure-dev-servers.sh-ə işarə edir',
          text.includes('$SRCROOT/../../scripts/dev/ensure-dev-servers.sh'),
        );
        check(
          'generasiya olunan sxemdə tək PreActions bloku var',
          (text.match(/<PreActions>/g) || []).length === 1,
        );
        // `withUITests` də həmin sxemi düzəldir və bu plaqindən SONRA qeydiyyata
        // salınıb. Zəncir qırılsa o, heç vaxt işləmir — 18 sentyabr 2026-da
        // məhz belə oldu, ona görə bu, ayrıca yoxlanılır.
        check(
          'generasiya olunan sxemdə UI test hədəfi qorunub',
          text.includes('oneTeamFieldAuditUITests'),
        );

        const lint = spawnSync('xmllint', ['--noout', generated], { encoding: 'utf8' });
        if (!(lint.error && lint.error.code === 'ENOENT')) {
          check('generasiya olunan XML düzgündür', lint.status === 0, (lint.stderr || '').trim());
        }
      }
    }
  } finally {
    // `node_modules` symlink-dir; `rmSync` onu silir, hədəfi yox.
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

console.log('');
if (failures === 0) {
  console.log('Hamısı keçdi.');
  process.exit(0);
}
console.log(`${failures} yoxlama uğursuz oldu.`);
process.exit(1);
