// oneTeam — Expo config plugin that wires the iOS UI test target (plan 3.4).
// ============================================================================
//
// Why a plugin and not "File > New > Target" in Xcode: `ios/` is generated.
// Anything a human clicks in Xcode disappears on the next `expo prebuild`,
// which means it also cannot exist on a CI machine. Putting the target in a
// config plugin makes it reproducible: prebuild -> xcodebuild test.
//
// The `xcode` package (3.x) only supports `unit_test_bundle` as a target type,
// so the target is created that way and `productType` is then rewritten to the
// real `com.apple.product-type.bundle.ui-testing` identifier. Everything the
// library gets wrong on the way there is corrected explicitly below, and every
// correction says what breaks without it.
//
// This plugin only writes inside the generated `ios/` directory. The tracked
// file it is registered from is `app.json`.
//

const fs = require('node:fs');
const path = require('node:path');
const { withXcodeProject } = require('expo/config-plugins');

const TEST_TARGET = 'oneTeamFieldAuditUITests';
const SOURCE_NAME = 'FieldAuditUITests.swift';
const SOURCE_DIR = 'uitests';
const BUNDLE_ID = 'az.oneteam.cocacola.fieldaudit.uitests';
const UI_TEST_PRODUCT_TYPE = 'com.apple.product-type.bundle.ui-testing';

/** Names in a pbxproj section are stored quoted; compare unquoted. */
function unquote(value) {
  return String(value === undefined ? '' : value).replace(/^"(.*)"$/, '$1');
}

function findInSection(section, field, name) {
  for (const [uuid, entry] of Object.entries(section)) {
    if (uuid.endsWith('_comment')) continue;
    if (entry && unquote(entry[field]) === name) return uuid;
  }
  return null;
}

/**
 * The group everything else hangs from. `xcode`'s `getFirstProject()` does not
 * expose `mainGroup`, so it is read off the PBXProject object itself.
 */
function mainGroupOf(objects) {
  for (const [uuid, entry] of Object.entries(objects.PBXProject)) {
    if (uuid.endsWith('_comment')) continue;
    if (entry && entry.mainGroup) return objects.PBXGroup[entry.mainGroup];
  }
  return null;
}

/**
 * The generated Xcode project is named after the app, so read it from disk
 * instead of hardcoding it — `ios/` is the only place that knows.
 */
function readProjectName(iosRoot) {
  const found = fs.readdirSync(iosRoot).find((entry) => entry.endsWith('.xcodeproj'));
  if (!found) throw new Error(`No .xcodeproj inside ${iosRoot} — run prebuild first.`);
  return path.basename(found, '.xcodeproj');
}

/**
 * Point the shared scheme's Test action at the real test target.
 *
 * The Expo template ships a scheme that already has a `<Testables>` entry for
 * `oneTeamFieldAuditTests`, a target that does not exist in the generated
 * project. Left alone, `xcodebuild test` fails on that dangling blueprint, so
 * the whole block is replaced with our own.
 */
function patchScheme(schemePath, projectName, testUuid) {
  if (!fs.existsSync(schemePath)) {
    throw new Error(`Shared scheme is missing: ${schemePath}`);
  }
  const original = fs.readFileSync(schemePath, 'utf8');
  const reference = [
    '         <TestableReference',
    '            skipped = "NO">',
    '            <BuildableReference',
    '               BuildableIdentifier = "primary"',
    `               BlueprintIdentifier = "${testUuid}"`,
    `               BuildableName = "${TEST_TARGET}.xctest"`,
    `               BlueprintName = "${TEST_TARGET}"`,
    `               ReferencedContainer = "container:${projectName}.xcodeproj">`,
    '            </BuildableReference>',
    '         </TestableReference>',
  ].join('\n');
  const next = original.replace(
    /<Testables>[\s\S]*?<\/Testables>/,
    `<Testables>\n${reference}\n      </Testables>`,
  );
  if (next === original) {
    throw new Error(`Scheme has no <Testables> block to replace: ${schemePath}`);
  }
  fs.writeFileSync(schemePath, next);
}

module.exports = function withUITests(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const projectRoot = cfg.modRequest.projectRoot;
    const iosRoot = path.join(projectRoot, 'ios');
    const objects = project.hash.project.objects;
    const projectName = readProjectName(iosRoot);

    // 1. The Swift file lives in the repo (`uitests/`) and is copied into the
    //    generated project. Prebuild wipes `ios/`, so this runs every time.
    const targetDir = path.join(iosRoot, TEST_TARGET);
    fs.mkdirSync(targetDir, { recursive: true });
    const srcSwift = path.join(projectRoot, SOURCE_DIR, SOURCE_NAME);
    if (!fs.existsSync(srcSwift)) {
      throw new Error(
        `${SOURCE_DIR}/${SOURCE_NAME} is missing — the test contract has nothing to address.`,
      );
    }
    fs.copyFileSync(srcSwift, path.join(targetDir, SOURCE_NAME));

    const appUuid = findInSection(objects.PBXNativeTarget, 'name', projectName);
    if (!appUuid)
      throw new Error(`App target "${projectName}" not found in the generated project.`);

    // Prebuild is not always clean; running twice must not create two targets.
    let testUuid = findInSection(objects.PBXNativeTarget, 'name', TEST_TARGET);

    if (!testUuid) {
      // 2. `unit_test_bundle` is the only test type `xcode` exposes.
      const target = project.addTarget(TEST_TARGET, 'unit_test_bundle', TEST_TARGET, BUNDLE_ID);
      testUuid = target.uuid;

      const nativeTarget = objects.PBXNativeTarget[testUuid];
      if (!nativeTarget) {
        throw new Error(
          'addTarget created no PBXNativeTarget entry — the project file is not writable.',
        );
      }
      // Without this the bundle stays a unit-test bundle and XCTest refuses to
      // drive a second app from it.
      nativeTarget.productType = `"${UI_TEST_PRODUCT_TYPE}"`;

      // 3. `addTarget` makes the APP depend on the test bundle. That is
      //    backwards: the bundle needs the finished app at `TEST_HOST` before
      //    it can link, so the app would wait on the very thing waiting on it.
      //    Drop that dependency (and the proxy objects it left behind) and put
      //    it the right way round.
      const dependencies = objects.PBXTargetDependency || {};
      const proxies = objects.PBXContainerItemProxy || {};
      for (const [uuid, dep] of Object.entries(dependencies)) {
        if (uuid.endsWith('_comment') || !dep || dep.target !== testUuid) continue;
        delete dependencies[uuid];
        delete dependencies[`${uuid}_comment`];
        if (dep.targetProxy) {
          delete proxies[dep.targetProxy];
          delete proxies[`${dep.targetProxy}_comment`];
        }
      }
      objects.PBXNativeTarget[appUuid].dependencies = (
        objects.PBXNativeTarget[appUuid].dependencies || []
      ).filter((entry) => {
        const dep = dependencies[entry.value];
        return !(dep && dep.target === testUuid);
      });
      project.addTargetDependency(testUuid, [appUuid]);

      // 4. `addTarget` leaves `buildPhases` empty, so the Swift file would
      //    have nowhere to be compiled.
      const sources = project.addBuildPhase([], 'PBXSourcesBuildPhase', 'Sources', testUuid);
      project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', testUuid);
      project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', testUuid);

      // 5. The product file `addTarget` created is still typed for a unit-test
      //    bundle and is named `…Tests.mdimporter`. Xcode looks for
      //    `<target>.xctest`, so both the type and the name are corrected.
      //    (Skipping this makes the scheme's buildable unresolvable.)
      const productFile = objects.PBXFileReference[nativeTarget.productReference];
      if (productFile) {
        productFile.explicitFileType = 'wrapper.cfbundle';
        productFile.path = `${TEST_TARGET}.xctest`;
        productFile.name = `${TEST_TARGET}.xctest`;
      }

      // 6. A group keeps the file visible in Xcode and, more importantly,
      //    gives the file reference its directory: a `sourceTree = <group>`
      //    file with no parent group resolves to `ios/FieldAuditUITests.swift`
      //    instead of `ios/oneTeamFieldAuditUITests/…`, and the build fails
      //    with "Build input file cannot be found".
      //
      //    Built by hand rather than with `addPbxGroup`, which does not
      //    survive the write in `xcode` 3.0.1.
      let groupUuid = findInSection(objects.PBXGroup, 'name', TEST_TARGET);
      if (!groupUuid) {
        groupUuid = project.generateUuid();
        objects.PBXGroup[groupUuid] = {
          isa: 'PBXGroup',
          children: [],
          name: TEST_TARGET,
          path: TEST_TARGET,
          sourceTree: '"<group>"',
        };
        objects.PBXGroup[`${groupUuid}_comment`] = TEST_TARGET;
        const mainGroup = mainGroupOf(objects);
        if (!mainGroup)
          throw new Error('The project has no main group to attach the test group to.');
        mainGroup.children.push({ value: groupUuid, comment: TEST_TARGET });
      }

      // 7. Wire the Swift file: file reference -> build file -> Sources phase.
      //    Done directly because `addSourceFile` attaches to the first target's
      //    build phase, which would compile the UI test into the app.
      const fileRef = project.generateUuid();
      objects.PBXFileReference[fileRef] = {
        isa: 'PBXFileReference',
        lastKnownFileType: 'sourcecode.swift',
        path: SOURCE_NAME,
        sourceTree: '"<group>"',
      };
      objects.PBXFileReference[`${fileRef}_comment`] = SOURCE_NAME;
      const buildFile = project.generateUuid();
      objects.PBXBuildFile[buildFile] = {
        isa: 'PBXBuildFile',
        fileRef,
        fileRef_comment: SOURCE_NAME,
      };
      objects.PBXBuildFile[`${buildFile}_comment`] = `${SOURCE_NAME} in Sources`;
      sources.buildPhase.files.push({ value: buildFile, comment: `${SOURCE_NAME} in Sources` });
      objects.PBXGroup[groupUuid].children.push({ value: fileRef, comment: SOURCE_NAME });

      // 8. `addTarget` stamps an INFOPLIST_FILE for a plist that does not
      //    exist; Xcode must generate it instead.
      const configList = objects.XCConfigurationList[nativeTarget.buildConfigurationList];
      for (const entry of configList.buildConfigurations) {
        const buildConfig = objects.XCBuildConfiguration[entry.value];
        const settings = buildConfig.buildSettings;
        delete settings.INFOPLIST_FILE;
        Object.assign(settings, {
          GENERATE_INFOPLIST_FILE: 'YES',
          PRODUCT_BUNDLE_IDENTIFIER: `"${BUNDLE_ID}"`,
          IPHONEOS_DEPLOYMENT_TARGET: '16.4',
          SWIFT_VERSION: '5.0',
          CODE_SIGN_STYLE: 'Automatic',
          // `TEST_TARGET_NAME` is what tells the runner which app to drive.
          // `TEST_HOST`/`BUNDLE_LOADER` are deliberately NOT set: for a
          // runner-based UI test bundle (USES_XCTRUNNER) Xcode rejects them
          // with "sets both USES_XCTRUNNER and either TEST_HOST or
          // RUNTIME_TEST_HOST". A hosted unit-test bundle is the one that
          // needs them; this is not that.
          TEST_TARGET_NAME: `"${projectName}"`,
          USES_XCTRUNNER: 'YES',
          LD_RUNPATH_SEARCH_PATHS: [
            '"$(inherited)"',
            '"@executable_path/Frameworks"',
            '"@loader_path/Frameworks"',
          ],
        });
      }
    }

    patchScheme(
      path.join(
        iosRoot,
        `${projectName}.xcodeproj`,
        'xcshareddata',
        'xcschemes',
        `${projectName}.xcscheme`,
      ),
      projectName,
      testUuid,
    );

    return cfg;
  });
};
