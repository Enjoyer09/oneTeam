#!/bin/bash
#
# oneTeam — iOS UI testlərini işlədir (plan 3.4).
#
# NİYƏ BU SKRİPT VAR
# -------------------
# Tətbiq iOS-da iki hissədən ibarətdir: Xcode-un qurduğu tətbiq və JavaScript
# kodu. Debug quruluşunda JS kodu Metro adlı serverdən gəlir. Metro işləməsə
# tətbiq açılır, amma ekranda "No script URL provided" yazısı çıxır və
# testlər uğursuz olur. Bu skript hər ikisini özü qaydaya salır:
#
#   1. Metro işləyib-işləmədiyini yoxlayır, işləmirsə başladır.
#   2. Tətbiqi və UI test hədəfini qurur.
#   3. Testləri simulyatorda işlədir.
#   4. Nəticəni ekrana yazır.
#
# NECƏ İŞLƏTMƏLİ
# --------------
# Terminal-ı aç və bu bir sətri yapışdır:
#
#   bash scripts/dev/test-ios.sh
#
# İlk dəfə 10-20 dəqiqə çəkə bilər (tətbiq yenidən qurulur). Sonda
# "TESTS SUCCEEDED" və ya "TESTS FAILED" görəcəksən. Hər iki halda agentə
# xəbər ver — o, logu oxuyub növbəti addımı deyəcək.
#

cd "$(dirname "$0")/../../mobile" || exit 1

# CocoaPods native ARM Homebrew ilə quraşdırılıb; lazım olsa PATH-a salaq.
export PATH="/opt/homebrew/bin:$PATH"
export LANG="en_US.UTF-8"
# `expo start` əks halda tsconfig.json-u səssizcə yenidən yazır.
export EXPO_NO_TYPESCRIPT_SETUP=1

LOG="$HOME/ios-uitest.log"
METRO_LOG="$HOME/metro.log"
DESTINATION='platform=iOS Simulator,name=iPhone 17 Pro'

echo ""
echo "=============================================="
echo " oneTeam — iOS UI testləri"
echo "=============================================="

# --- 1. Metro ---------------------------------------------------------------
METRO_WAS_RUNNING=1
if ! curl -s -o /dev/null --max-time 2 "http://127.0.0.1:8081/status"; then
  METRO_WAS_RUNNING=0
  echo "Metro işləmir — başladılır (log: $METRO_LOG)..."
  npx expo start --host lan > "$METRO_LOG" 2>&1 &
  METRO_PID=$!
  for _ in $(seq 1 45); do
    if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:8081/status"; then
      break
    fi
    sleep 2
  done
  if ! curl -s -o /dev/null --max-time 2 "http://127.0.0.1:8081/status"; then
    echo "Metro başlada bilmədi. $METRO_LOG faylına bax və agentə göndər."
    exit 1
  fi
  echo "Metro hazırdır."
else
  echo "Metro artıq işləyir — mövcud serverdən istifadə olunur."
fi

# --- 2. Testlər -------------------------------------------------------------
echo ""
echo "Testlər işləyir. Bu 5-15 dəqiqə çəkə bilər..."
echo "Log: $LOG"
echo ""

xcodebuild \
  -workspace ios/oneTeamFieldAudit.xcworkspace \
  -scheme oneTeamFieldAudit \
  -configuration Debug \
  -destination "$DESTINATION" \
  -derivedDataPath ios/build \
  test > "$LOG" 2>&1
STATUS=$?

if [ "$METRO_WAS_RUNNING" = "0" ]; then
  kill "$METRO_PID" 2>/dev/null
fi

# --- 3. Nəticə --------------------------------------------------------------
echo ""
echo "=============================================="
if [ "$STATUS" -eq 0 ]; then
  echo "TESTS SUCCEEDED"
else
  echo "TESTS FAILED (çıxış kodu: $STATUS)"
fi
echo "----------------------------------------------"
grep -E "Test Case .* (passed|failed|skipped)|Executed [0-9]+ test" "$LOG" | tail -30
if [ "$STATUS" -ne 0 ]; then
  echo "----------------------------------------------"
  echo "Xətalar:"
  grep -E "error:|failed - |XCTAssert" "$LOG" | tail -20
fi
echo "----------------------------------------------"
echo "Tam log: $LOG"
echo "İndi agentə xəbər ver."
echo "=============================================="
exit "$STATUS"
