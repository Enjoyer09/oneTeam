#!/bin/bash
#
# oneTeam — Tətbiqi FİZİKİ iPhone-da işlətmək üçün köməkçi.
#
# NİYƏ BU SKRİPT VAR
# -------------------
# Telefonda test etmək simulyatordan üç fərqlə ayrılır və hər üçü səssizcə
# uğursuz ola bilər:
#
#   1. Metro paketi telefona ŞƏBƏKƏ üzərindən getməlidir (`--host lan`),
#      `localhost` telefonda telefonun özünü göstərir, kompüteri yox.
#   2. API ünvanı da kompüterin şəbəkə IP-si olmalıdır — `localhost:3001`
#      telefonda işləmir. Bu, paketə `EXPO_PUBLIC_ONETEAM_API_URL` ilə
#      yazılır, yəni Metro həmin dəyərlə başlamalıdır.
#   3. iOS 14+ yerli şəbəkəyə qoşulmaq üçün icazə soruşur; icazə mətni
#      (`NSLocalNetworkUsageDescription`) `app.json`-dadır və tətbiqin
#      yenidən qurulmasını tələb edir.
#
# Bu skript birinci və ikincini özü həll edir, üçüncü üçün isə nə etmək
# lazım olduğunu deyir.
#
# NECƏ İŞLƏTMƏLİ
# --------------
# Terminal-ı aç və bu bir sətri yapışdır:
#
#   bash scripts/dev/run-on-device.sh
#
# Skript API-ni yoxlayır, Xcode-u açır və Metro-nu düzgün ünvanla başladır.
# Sonra Xcode-da "Run" düyməsini sıxırsan (təlimat ekranda yazılacaq).
# Metro-nu dayandırmaq üçün Terminal-da Control+C bas.
#

set -u

cd "$(dirname "$0")/../.." || exit 1

API_PORT="${API_PORT:-3001}"
METRO_PORT="${METRO_PORT:-8081}"

# --- 1. Kompüterin şəbəkə IP-si ---------------------------------------------
# Telefon bu ünvana qoşulacaq. Wi-Fi adapteri adətən en0, bəzən en1 olur.
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"

echo ""
echo "=============================================="
echo " oneTeam — telefonda test"
echo "=============================================="
echo ""

if [ -z "$LAN_IP" ]; then
  echo "⛔ Şəbəkə IP-si tapılmadı."
  echo "   Kompüterin Wi-Fi-a qoşulduğuna əmin ol və yenidən cəhd et."
  exit 1
fi

echo "Kompüterin şəbəkə ünvanı: $LAN_IP"
echo "  → Telefon bu ünvanla danışacaq. Telefon da EYNİ Wi-Fi-da olmalıdır."
echo ""

# --- 2. API işləyirmi? -------------------------------------------------------
api_is_up() {
  curl -s -o /dev/null --max-time 2 "http://127.0.0.1:${API_PORT}/api/health"
}

API_STARTED_BY_US=0
if api_is_up; then
  echo "✓ API artıq işləyir (port $API_PORT) — mövcud serverdən istifadə olunur."
else
  echo "API işləmir — arxa planda başladılır (port $API_PORT)..."
  # `api:dev` əvvəlcə TypeScript-i yığır, sonra işə salır. NestJS dekorator
  # metadatası üçün tsc lazımdır (tsx onu buraxmır), ona görə `tsx` yox bu.
  (npm run api:dev > /tmp/oneteam-api.log 2>&1) &
  API_PID=$!
  API_STARTED_BY_US=1

  for _ in $(seq 1 45); do
    if api_is_up; then break; fi
    sleep 2
  done

  if api_is_up; then
    echo "✓ API hazırdır."
  else
    echo "⚠️  API cavab vermir. Log: /tmp/oneteam-api.log"
    echo "   Test davam edə bilər, amma tətbiq məlumat yükləyə bilməyəcək."
  fi
fi
echo ""

# --- 3. Xcode layihəsini aç --------------------------------------------------
# .xcworkspace AÇILMALIDIR, .xcodeproj YOX — CocoaPods kitabxanaları yalnız
# workspace-də birləşir; .xcodeproj açılsa build "module not found" verir.
WORKSPACE="mobile/ios/oneTeamFieldAudit.xcworkspace"
if [ -d "$WORKSPACE" ]; then
  echo "Xcode açılır: $WORKSPACE"
  open "$WORKSPACE"
else
  echo "⛔ $WORKSPACE tapılmadı."
  echo "   Əvvəlcə bunu işlət:  bash scripts/dev/setup-ios.sh"
  exit 1
fi
echo ""

# --- 4. Metro-nu düzgün ünvanla başlat ---------------------------------------
echo "=============================================="
echo " XCODE-DA NƏ ETMƏLİ"
echo "=============================================="
echo ""
echo "  1. Xcode-da yuxarı solda cihaz seç:  (simulyator yox) SƏNİN iPhonun."
echo "     Telefon USB ilə qoşulmalı və ya eyni Wi-Fi-da olmalıdır."
echo ""
echo "  2. Əgər bu ilk dəfədirsə — imzalama:"
echo "       • Solda layihə adına kliklə → TARGETS → oneTeamFieldAudit"
echo "       • 'Signing & Capabilities' sekmesi"
echo "       • 'Team' açılan siyahısından Apple ID-ni seç"
echo "       • 'Automatically manage signing' işarəli olsun"
echo ""
echo "  3. Yuxarı solda ▶ (Run) düyməsini sıx."
echo ""
echo "  4. Telefonda ilk dəfə:"
echo "       • 'Untrusted Developer' xəbəri çıxsa →"
echo "         Settings → General → VPN & Device Management →"
echo "         developer adına etibar et"
echo "       • Settings → Privacy & Security → Developer Mode → ON"
echo "         (telefon yenidən başlayacaq)"
echo "       • Tətbiq açılanda kamera, GPS və YERLİ ŞƏBƏKƏ icazələrini ver"
echo ""
echo "=============================================="
echo " Metro başladılır (bu pəncərə açıq qalmalıdır)"
echo " Dayandırmaq üçün:  Control+C"
echo "=============================================="
echo ""

# Metro-nun paketə yazacağı API ünvanı — kompüterin IP-si ilə.
export EXPO_PUBLIC_ONETEAM_API_URL="http://${LAN_IP}:${API_PORT}"
export EXPO_NO_TYPESCRIPT_SETUP=1

echo "Tətbiqin danışacağı API: $EXPO_PUBLIC_ONETEAM_API_URL"
echo ""

cd mobile || exit 1
# `--host lan` olmadan paket yalnız kompüterin özünə verilir və telefon
# "No script URL provided" göstərir.
npx expo start --host lan --port "$METRO_PORT"
METRO_STATUS=$?

# --- 5. Təmizlik -------------------------------------------------------------
# Metro dayandıqdan sonra bizim başlatdığımız API-ni də dayandır.
if [ "$API_STARTED_BY_US" = "1" ] && [ -n "${API_PID:-}" ]; then
  echo ""
  echo "Metro dayandı — başlatdığımız API də dayandırılır."
  kill "$API_PID" 2>/dev/null
fi

exit "$METRO_STATUS"
