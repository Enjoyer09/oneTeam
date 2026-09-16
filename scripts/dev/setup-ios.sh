#!/bin/bash
#
# oneTeam — iOS layihəsini yaratmaq üçün BİR DƏFƏLİK quraşdırma.
#
# NİYƏ BU SKRİPT VAR
# -------------------
# Xcode 26.6 və iOS 26.5 simulyatorları bu kompüterdə quraşdırılıb və
# `xcodebuild` komanda sətri ilə işləyir — yəni agent özü build edib test
# yaza bilər. Amma agentin iş mühiti `npm install` zamanı yüzlərlə qovluq
# yaratmaq istəyəndə rədd edilir:
#
#   npm error code CODEBUDDY_BROKER_DENY
#   npm error Brokered host mkdir requires an available runtime file rule
#
# Bu, "kodu səhvdir" demək deyil — sadəcə agentin qabığı o qədər fayl yaza
# bilmir. Buna görə paketləri QURAŞDIRMAQ istifadəçinin öz Terminal-ında
# baş verir, qalan hər şeyi isə agent edir.
#
# NECƏ İŞLƏTMƏLİ
# --------------
# Terminal-ı aç və bu bir sətri yapışdır:
#
#   bash scripts/dev/setup-ios.sh
#
# Skript bir neçə dəqiqə çəkə bilər. "CocoaPods" addımında Mac şifrəni
# soruşa bilər — bu normaldır.
#
set -e

cd "$(dirname "$0")/../../mobile"

echo ""
echo "1/3  Paketlər quraşdırılır (2-6 dəqiqə çəkə bilər)..."
echo "     (node_modules qovluğu yaranır)"
npm install

echo ""
echo "2/3  CocoaPods quraşdırılır (iOS kitabxanalarını birləşdirir)..."
if command -v pod >/dev/null 2>&1; then
  echo "     CocoaPods artıq quraşdırılıb: $(pod --version)"
else
  if command -v brew >/dev/null 2>&1; then
    brew install cocoapods || sudo gem install cocoapods
  else
    sudo gem install cocoapods
  fi
fi

echo ""
echo "3/3  Xcode layihəsi yaradılır (mobile/ios/)..."
echo "     (bu addım həm də pod install işlədir)"
npx expo prebuild --platform ios --clean

echo ""
echo "=============================================="
echo "HAZIRDIR."
echo ""
echo "İndi agentə xəbər ver. O, qalanını özü edəcək:"
echo "  - mobile/ios/ qovluğunu oxuyacaq"
echo "  - xcodebuild ilə simulyatorda build edəcək"
echo "  - xətaları tapıb düzəldəcək"
echo "  - 3.4 bəndinin UI testlərini yazacaq"
echo "=============================================="
