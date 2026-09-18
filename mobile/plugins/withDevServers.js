// oneTeam — Expo config plugin: Xcode-un "Run" düyməsi dev serverləri özü başladır.
// ============================================================================
//
// NİYƏ PLAQİN, XCODE-DA ƏL İLƏ DÜYMƏ YOX
// --------------------------------------
// `ios/` generasiya olunur. Xcode-da əl ilə edilən hər dəyişiklik növbəti
// `expo prebuild`-də yox olur — yəni CI maşınında heç vaxt mövcud olmur.
// Sxemi buradan yazmaq onu təkrarlana bilən edir: prebuild → Run → işləyir.
//
// NƏ EDİR
// -------
// Paylaşılan sxemin (`xcshareddata/xcschemes/*.xcscheme`) `LaunchAction`-una
// bir "Pre-action" əlavə edir. Xcode "Run" sıxılanda bu addımı BUILD-dən ƏVVƏL
// işlədir, yəni Metro və API tətbiq açılmazdan əvvəl hazır olur.
//
// NİYƏ YALNIZ `LaunchAction`
// --------------------------
// `xcodebuild test` (CI-ın UI test addımı) `TestAction`-u işlədir, `LaunchAction`-u
// yox. Pre-action yalnız Run-a bağlandığı üçün CI-ın Metro idarəsində heç nə
// dəyişmir — orada serveri `scripts/dev/test-ios.sh` özü başladır.
//
// `ensure-dev-servers.sh` özü də təkrar çağırışa davamlıdır və CI-da dərhal
// çıxır, yəni bu addım orada zərərsizdir.
//
// Bu plagin yalnız generasiya olunan `ios/` qovluğuna yazır. Onu qeydiyyata
// salan fayl `app.json`-dur.
//

const fs = require('node:fs');
const path = require('node:path');
const { withXcodeProject } = require('expo/config-plugins');

/** Nisbi yol `ios/`-dan hesablanır: ios/ → mobile/ → repo kökü. */
const SERVERS_SCRIPT = '$SRCROOT/../../scripts/dev/ensure-dev-servers.sh';

/** XML mətnində təhlükəli simvolları qaçırır. */
function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Generasiya olunan layihənin adını diskdən oxuyur (`ios/` yeganə biləndir). */
function readProjectName(iosRoot) {
  const found = fs.readdirSync(iosRoot).find((entry) => entry.endsWith('.xcodeproj'));
  if (!found) throw new Error(`No .xcodeproj inside ${iosRoot} — run prebuild first.`);
  return path.basename(found, '.xcodeproj');
}

/**
 * Sxemin `LaunchAction`-una PreActions bloku əlavə edir.
 *
 * Təkrar işlədildikdə ikinci blok yaratmır: əvvəlcə mövcudluğunu yoxlayır.
 * `prebuild` hər dəfə sxemi sıfırdan yazdığı üçün bu, adətən lazım olmur —
 * amma `--clean` olmadan işlədilən prebuild sxemi saxlaya bilər, və o halda
 * iki PreActions bloku Xcode-u qarışdırar.
 */
function patchScheme(schemePath, projectName, appUuid) {
  if (!fs.existsSync(schemePath)) {
    throw new Error(`Shared scheme is missing: ${schemePath}`);
  }

  const original = fs.readFileSync(schemePath, 'utf8');

  if (original.includes('<PreActions>')) {
    return 'already present';
  }

  const preActions = [
    '      <PreActions>',
    '         <ExecutionAction',
    '            ActionType = "Xcode.IDEStandardExecutionActionsCore.ExecutionActionType.ShellScriptAction">',
    '            <ActionContent',
    '               title = "Start oneTeam dev servers (API + Metro)"',
    `               scriptText = "bash ${xmlEscape(SERVERS_SCRIPT)}&#10;"`,
    '               shellToInvoke = "/bin/bash">',
    '               <EnvironmentBuildable>',
    '                  <BuildableReference',
    '                     BuildableIdentifier = "primary"',
    `                     BlueprintIdentifier = "${appUuid}"`,
    `                     BuildableName = "${projectName}.app"`,
    `                     BlueprintName = "${projectName}"`,
    `                     ReferencedContainer = "container:${projectName}.xcodeproj">`,
    '                  </BuildableReference>',
    '               </EnvironmentBuildable>',
    '            </ActionContent>',
    '         </ExecutionAction>',
    '      </PreActions>',
  ].join('\n');

  // `<LaunchAction` + boşluq: `<LaunchActionEntries>` kimi başqa elementlərlə
  // səhvən uyğunlaşmasın. Atributların içində `>` olmadığı üçün ilk `>`-a qədər
  // oxumaq açılış teqini tam verir.
  const next = original.replace(/(<LaunchAction\s[^>]*>)/, `$1\n${preActions}`);

  if (next === original) {
    throw new Error(`Scheme has no <LaunchAction> to extend: ${schemePath}`);
  }

  fs.writeFileSync(schemePath, next);
  return 'added';
}

function withDevServers(config) {
  return withXcodeProject(config, (cfg) => {
    const projectRoot = cfg.modRequest.projectRoot;
    const iosRoot = path.join(projectRoot, 'ios');
    const projectName = readProjectName(iosRoot);

    const objects = cfg.modResults.hash.project.objects;
    let appUuid = null;
    for (const [uuid, entry] of Object.entries(objects.PBXNativeTarget || {})) {
      if (uuid.endsWith('_comment')) continue;
      const name = String(entry?.name ?? '').replace(/^"(.*)"$/, '$1');
      if (name === projectName) {
        appUuid = uuid;
        break;
      }
    }
    if (!appUuid) {
      throw new Error(`App target "${projectName}" not found in the generated project.`);
    }

    const schemePath = path.join(
      iosRoot,
      `${projectName}.xcodeproj`,
      'xcshareddata',
      'xcschemes',
      `${projectName}.xcscheme`,
    );

    patchScheme(schemePath, projectName, appUuid);

    // The mod chain threads the config from one mod to the next: `withMod`'s
    // `interceptingMod` awaits the action and hands its *return value* on. An
    // action that returns nothing makes the next mod receive `undefined`, and
    // prebuild dies with
    //   "Cannot destructure property 'modRequest' of 'undefined'"
    // — a message that names the base mod, not this file. `withUITests.js`
    // ends the same way, and `scripts/dev/verify-dev-servers-plugin.mjs` runs
    // a real prebuild so this cannot regress silently again.
    return cfg;
  });
}

module.exports = withDevServers;

// Test üçün açıqdır. `prebuild` yalnız default export-u çağırır, ona görə bu
// əlavə ixrac heç nəyi dəyişmir — amma sxem düzəlişini həqiqi fayl üzərində
// ayrıca yoxlamağa imkan verir (`scripts/dev/verify-dev-servers-plugin.mjs`).
module.exports.patchScheme = patchScheme;
module.exports.xmlEscape = xmlEscape;
module.exports.SERVERS_SCRIPT = SERVERS_SCRIPT;
