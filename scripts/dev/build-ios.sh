#!/bin/bash
#
# oneTeam — iOS tətbiqini simulyator üçün BUILD edir.
#
# NİYƏ BU SKRİPT VAR
# -------------------
# Agent özü `xcodebuild` işlədə BİLMİR. Səbəb təxmin deyil, ölçülüb:
# tətbiqin asılılıqlarından biri (ExpoModulesJSI) build zamanı Swift
# paketlərini çözməlidir və agentin mühitində bu addım belə ölür:
#
#   xcodebuild: error: Could not resolve package dependencies:
#     sandbox-exec: sandbox_apply: Operation not permitted
#
# Eyni əmr birbaşa qabıqdan da, sandbox söndürülmüş halda da eyni xətanı
# verir — yəni bu layihənin yox, agent iş mühitinin məhdudiyyətidir.
# İstifadəçinin öz Terminal-ında belə məhdudiyyət yoxdur.
#
# NECƏ İŞLƏTMƏLİ
# --------------
# Terminal-ı aç və bu bir sətri yapışdır:
#
#   bash scripts/dev/build-ios.sh
#
# Skript 5-15 dəqiqə çəkə bilər. Sonda ekranda "BUILD SUCCEEDED" və ya
# "BUILD FAILED" görəcəksən. Hər iki halda agentə xəbər ver — o, logu
# oxuyub növbəti addımı deyəcək.
#

cd "$(dirname "$0")/../../mobile" || exit 1

# CocoaPods native ARM Homebrew ilə quraşdırılıb; lazım olsa PATH-a salaq.
export PATH="/opt/homebrew/bin:$PATH"
export LANG="en_US.UTF-8"

LOG="$HOME/ios-build.log"

echo ""
echo "Build başlayır. Bu 5-15 dəqiqə çəkə bilər..."
echo "Log: $LOG"
echo ""

xcodebuild \
  -workspace ios/oneTeamFieldAudit.xcworkspace \
  -scheme oneTeamFieldAudit \
  -configuration Debug \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath ios/build \
  build > "$LOG" 2>&1
STATUS=$?

echo ""
echo "=============================================="
if [ "$STATUS" -eq 0 ]; then
  echo "BUILD SUCCEEDED — tətbiq simulyator üçün quruldu."
else
  echo "BUILD FAILED (çıxış kodu: $STATUS)"
  echo ""
  echo "Xətalar (son 25 sətir):"
  echo "----------------------------------------------"
  grep -E "error:|FAILED|failed" "$LOG" | tail -25
  echo "----------------------------------------------"
fi
echo "Tam log: $LOG"
echo "İndi agentə xəbər ver."
echo "=============================================="
exit "$STATUS"
