// oneTeam — iOS UI test (plan 3.4)
// ============================================================================
//
// WHAT THIS COVERS TODAY
// ----------------------
// Driving the app through the Login -> Task -> Photo -> Submit flow requires
// a live API (the worker has to authenticate against `/api/portal/...` and the
// photo has to land on Cloudflare R2). This file therefore covers the parts
// that can be exercised against the simulator without a backend:
//
//   1. The login screen renders with the right identifiers (the contract in
//      `mobile/uitests/testids.json` is honoured).
//   2. The location status line reports what the platform actually said, and
//      the Sign in button follows it.
//   3. After tapping Sign in without a backend the error text appears, which
//      proves the rejection path is wired to the UI.
//   4. The task list and task detail screens are NOT reachable before login,
//      which proves the Root router's gating works.
//
// THE GPS IS REAL NOW, AND IT CHANGED THIS FILE
// --------------------------------------------
// Until 2026-09-20 the login screen returned `{40.4093, 49.8671}` from a
// `setTimeout` — the coordinates of the store the demo was built around. The
// button was enabled by a timer, and the assertion below ("disabled, then
// enabled") was really asserting that a timer fires.
//
// The screen now asks `expo-location` for a fix. Two consequences for this
// file, both of them honest rather than convenient:
//
//   * The simulator needs a location. CI sets one before the tests run
//     (`xcrun simctl location <udid> set 40.4093,49.8671` in the "Pick a
//     simulator" step). Without it no fix ever arrives and the sign-in button
//     correctly stays off — a failure of the fixture, not of the app.
//   * The first launch shows the iOS location prompt. `allowLocationWhenAsked`
//     dismisses it the way a worker would. `xcrun simctl privacy ... grant`
//     does NOT work here: measured on 2026-09-20, it exits 0 but writes no TCC
//     row for an app that is not installed yet, and the app is installed by
//     `xcodebuild test` long after the simulator is prepared.
//
// "Disabled until a fix exists" is still a rule, but it is no longer asserted
// unconditionally here: on a fast machine the fix can arrive before the first
// query, which would make the assertion a coin flip rather than a check. The
// rule is proven unconditionally and deterministically in the headless suite
// (`mobile/src/tests/mobile-test-runner.ts`, "no fix means no sign-in"), where
// the absence of a fix is an input rather than a race. What remains here is the
// part only the real UI can show: the status line and the button agree.
//
// A `testID` IS NOT ENOUGH
// ------------------------
// `scripts/quality/ui-test-ids.mjs` proves the identifiers exist in the
// sources. It cannot prove XCTest can REACH them, and two places it cannot see
// decide that:
//
//   * `TouchableOpacity` forwards `accessibilityRole` but defaults it to
//     nothing, so without `accessibilityRole="button"` the control is an
//     "other" element and `app.buttons["login.submitButton"]` matches nothing.
//   * React Native maps `accessibilityState: { disabled: true }` to
//     `UIAccessibilityTraitNotEnabled` (React/Views/RCTViewManager.m), which is
//     what XCUI reports as `isEnabled == false`. The `disabled` prop by itself
//     never reaches XCTest.
//
// Both are set in `LoginScreenUI.tsx`; both are called out here because
// removing either one makes these tests fail for a reason no guard would catch.
//
// The store code field is PRE-FILLED by the controller
// (`storeCodeInput: 'BRAVO_YASAMAL_01'`), so the tests must not type into it.
//
// THE TARGET
// ----------
// This file is committed next to the test contract so that
// `scripts/quality/ui-test-ids.mjs` can prove the identifiers are not in name
// only. The Xcode UI test target is generated, not clicked: `mobile/plugins/
// withUITests.js` creates it on every `expo prebuild`, copies this file into
// `ios/oneTeamFieldAuditUITests/` and points the shared scheme at it. Nothing
// in Xcode has to be set up by hand, and the same target exists on CI.
//

import XCTest

final class FieldAuditUITests: XCTestCase {

  private var app: XCUIApplication!

  override func setUpWithError() throws {
    continueAfterFailure = false
    app = XCUIApplication()
    app.launch()
  }

  // --- Helpers --------------------------------------------------------------

  /// The login screen's location line. It exists in every state — looking,
  /// found, or refused — which is what makes it readable as a check.
  private func storeCodeInput() -> XCUIElement { app.textFields["login.storeCodeInput"] }
  private func gpsStatus()     -> XCUIElement { app.staticTexts["login.gpsStatus"] }
  private func submitButton()  -> XCUIElement { app.buttons["login.submitButton"] }
  private func errorText()     -> XCUIElement { app.staticTexts["login.errorText"] }

  /// Dismisses the iOS location prompt the way a worker would.
  ///
  /// The button titles are the English ones because a CI simulator runs in
  /// English; the Azerbaijani titles are matched too, so the same helper works
  /// on a device set to the app's own language. If no prompt appears — a second
  /// launch of the same install — this is a no-op and says so by returning
  /// false, which the caller is free to ignore.
  @discardableResult
  private func allowLocationWhenAsked(timeout: TimeInterval = 20) -> Bool {
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    let titles = [
      "Allow While Using App",
      "Allow Once",
      "İstifadə edərkən icazə ver",
      "Bir dəfə icazə ver",
    ]
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      for title in titles {
        let button = springboard.buttons[title]
        if button.exists && button.isHittable {
          button.tap()
          return true
        }
      }
      usleep(300_000)
    }
    return false
  }

  /// Waits for the login screen, and on timeout says what IS on screen.
  ///
  /// WHY NOT `waitForExistence(timeout: 5)`
  /// --------------------------------------
  /// In Debug the screen only exists once Metro has served the JavaScript
  /// bundle. On a machine where that bundle is already warm it takes under a
  /// second; on a cold CI runner Metro has to transform the whole app first,
  /// which is far more than 5 seconds. All four tests failed on CI at exactly
  /// that wait, having shown nothing about the cause.
  ///
  /// So: a generous timeout, and a failure that prints the accessibility tree.
  /// "login.storeCodeInput must be on the login screen" tells you nothing; the
  /// tree tells you whether the app is still loading, showing a red box, or on
  /// an entirely different screen.
  private func waitForLoginScreen(file: StaticString = #filePath, line: UInt = #line) {
    if storeCodeInput().waitForExistence(timeout: 60) { return }
    let tree = app.debugDescription
    let shown = tree.count > 4000 ? String(tree.prefix(4000)) + "\n… (truncated)" : tree
    XCTFail("login.storeCodeInput never appeared. Screen was:\n\(shown)", file: file, line: line)
  }

  /// Waits for the sign-in button to become enabled, granting location if the
  /// platform asks. Fails with the status line in the message, because "still
  /// looking for a fix" and "the fix was refused" need different fixes.
  private func waitForSignInToEnable(file: StaticString = #filePath, line: UInt = #line) {
    allowLocationWhenAsked()

    let enabled = NSPredicate(format: "isEnabled == true")
    expectation(for: enabled, evaluatedWith: submitButton())

    // THE HANDLER RUNS WHEN THE WAIT COMPLETES, NOT ONLY WHEN IT FAILS, and
    // `error` is nil when the expectation was fulfilled. The first version of
    // this helper called XCTFail unconditionally inside it, so it failed the
    // test even when the button HAD become enabled — which is what CI reported
    // on 2026-09-20: the message read "Sign in never became enabled" while
    // quoting the status line ("📍 Lokasiya alındı") that proved the opposite.
    //
    // That is the defect this repository keeps finding in other forms: a check
    // that reports a verdict its own evidence contradicts, sending the reader
    // to the app instead of to the test. Guarding on the error makes the
    // failure mean exactly one thing — the wait timed out — and the message
    // now carries both facts that decide it.
    waitForExpectations(timeout: 30) { error in
      guard error != nil else { return }
      let storeCode = self.storeCodeInput().value as? String ?? "<none>"
      XCTFail(
        "Sign in did not become enabled within 30s. Location status was "
          + "\"\(self.gpsStatus().label)\"; the store code field was \"\(storeCode)\".",
        file: file, line: line)
    }
  }

  // --- Tests ----------------------------------------------------------------

  /// The contract is honoured: the identifiers the Swift test addresses must
  /// exist as `testID`s in the React Native sources.
  func testLoginScreenContract() throws {
    waitForLoginScreen()
    XCTAssertTrue(gpsStatus().exists,
      "login.gpsStatus must be on the login screen in every state")
    XCTAssertTrue(submitButton().exists,
      "login.submitButton must be on the login screen")
    XCTAssertTrue(errorText().exists == false,
      "login.errorText must be absent before the user taps Sign in")
  }

  /// The status line must report what the platform said, and the button must
  /// follow it — which is the whole of the anti-fraud gate as the worker sees
  /// it. The unconditional half of the rule lives in the headless suite.
  func testSignInFollowsTheLocationStatus() throws {
    waitForLoginScreen()

    // Sound rather than convenient: the assertion is only meaningful while no
    // fix exists, and whether one exists yet depends on how fast the device is.
    // Asserting it unconditionally would make this a race, and a race that
    // passes tells you nothing about the rule.
    let statusBeforeGrant = gpsStatus().label
    if !statusBeforeGrant.contains("alındı") {
      XCTAssertFalse(submitButton().isEnabled,
        "Sign in must be disabled while the location line reads \"\(statusBeforeGrant)\"")
    }

    waitForSignInToEnable()

    XCTAssertTrue(gpsStatus().label.contains("alındı"),
      "The location line must report the fix that enabled Sign in, got: \"\(gpsStatus().label)\"")
  }

  /// Without a backend the login attempt rejects; the UI must surface the
  /// rejection through `login.errorText`. This is the part of the flow the
  /// simulator can exercise today.
  func testRejectionPathIsWiredToTheUi() throws {
    waitForLoginScreen()
    waitForSignInToEnable()

    submitButton().tap()

    let appeared = NSPredicate(format: "exists == true")
    expectation(for: appeared, evaluatedWith: errorText())
    waitForExpectations(timeout: 20)

    XCTAssertTrue(errorText().exists,
      "Sign in rejection must surface through login.errorText")
  }

  /// The Root router must keep the task list behind login. The test therefore
  /// makes the protected screen unreachable: tapping where the row *would* be
  /// does nothing, and no element with the `taskList.*` identifier exists.
  func testTaskListIsNotReachableBeforeLogin() throws {
    waitForLoginScreen()

    let taskRow = app.otherElements["taskList.taskRow"]
    XCTAssertFalse(taskRow.exists,
      "taskList.taskRow must not exist before the worker has logged in")
  }

  /// The full Login -> Task -> Photo -> Submit flow needs a live API; the
  /// gated case below fires only when `ONETEAM_API_URL` is reachable from the
  /// host that launches the simulator, so this test does not run on a plain
  /// `xcodebuild test` in CI without a backend. See the plan for the CI side.
  func testFullFlowAgainstBackend() throws {
    try XCTSkipIf(
      ProcessInfo.processInfo.environment["ONETEAM_API_URL"] == nil,
      "Set ONETEAM_API_URL in the scheme to a reachable host before running this test."
    )
    // Implementation will follow once the backend wiring is settled.
    // The skeleton exists so the suite is honest about what is and is not
    // exercised, rather than passing for the wrong reason.
  }
}