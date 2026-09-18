#!/usr/bin/env node
/**
 * `withDevServers` plagininin sxem düzəlişini HƏQİQİ fayl üzərində yoxlayır.
 *
 * NİYƏ BU TEST VAR
 * ----------------
 * Plagin yalnız `expo prebuild` zamanı işləyir, prebuild isə `ios/`-u sıfırdan
 * yazır. Yəni "plagin işləyir" iddiasını yoxlamaq üçün hər dəfə bütün native
 * layihəni yenidən qurmaq lazım gələrdi — və səhv olsa, bunu CI-ın prebuild
 * addımında öyrənərdik. Bu skript düzəlişin özünü ayırıb həqiqi sxem faylının
 * KOPİYASI üzərində sınayır.
 *
 * YOXLADIKLARI
 * ------------
 *   1. `LaunchAction`-a PreActions bloku əlavə olunur.
 *   2. Blok `ensure-dev-servers.sh`-ə işarə edir.
 *   3. Nəticə düzgün XML-dir (`xmllint` varsa onunla təsdiqlənir).
 *   4. İkinci tətbiq heç nə etmir — iki PreActions bloku yaranmır.
 *   5. `withUITests`-in yazdığı `<Testables>` bloku toxunulmaz qalır.
 *   6. `<LaunchActionEntries>` kimi oxşar adlı element səhvən dəyişdirilmir.
 *
 * İŞLƏTMƏK
 * --------
 *     node scripts/dev/verify-dev-servers-plugin.mjs
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

console.log('');
if (failures === 0) {
  console.log('Hamısı keçdi.');
  process.exit(0);
}
console.log(`${failures} yoxlama uğursuz oldu.`);
process.exit(1);
