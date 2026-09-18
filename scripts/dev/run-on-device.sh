#!/bin/bash
#
# oneTeam — Tətbiqi FİZİKİ iPhone-da işlətmək üçün bir əmrlə hazırlıq.
#
# NİYƏ BU SKRİPT VAR
# -------------------
# Telefonda test simulyatordan üç fərqlə ayrılır və hər üçü səssizcə uğursuz ola bilər:
#
#   1. Metro paketi telefona ŞƏBƏKƏ üzərindən getməlidir (`--host lan`).
#      `localhost` telefonda telefonun özünü göstərir, kompüteri yox.
#   2. API ünvanı kompüterin şəbəkə IP-si olmalıdır — `localhost:3001`
#      telefonda işləmir. Bu, paketə `EXPO_PUBLIC_ONETEAM_API_URL` ilə yazılır,
#      yəni Metro həmin dəyərlə başlamalıdır.
#   3. iOS 14+ yerli şəbəkəyə qoşulmaq üçün icazə soruşur; icazə mətni
#      `app.json`-dadır (`NSLocalNetworkUsageDescription`).
#
# Serverləri başlatmaq işini `ensure-dev-servers.sh` görür — Xcode-un "Run"
# düyməsi də HƏMİN skripti çağırır (bax: `mobile/plugins/withDevServers.js`),
# yəni burada təkrar məntiq yoxdur.
#
# NECƏ İŞLƏTMƏLİ
# --------------
# Terminal-ı aç və bu bir sətri yapışdır:
#
#   bash scripts/dev/run-on-device.sh
#
# Sonra Xcode-da "Run" düyməsini sıx. Xcode-da Run sıxdıqdan sonra bu skripti
# bir daha işlətmək lazım DEYİL — pre-action serverləri özü qaldırır.
#
# Serverləri dayandırmaq üçün:
#
#   bash scripts/dev/ensure-dev-servers.sh --stop
#

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# `ensure-dev-servers.sh` SEÇDİYİ nəticəni bu fayla yazır. Öz defoltumuzu (3001)
# çap etmək yanlış olardı: bu maşında 3001-i layihədən olmayan proqram tutur və
# API 3011-də işləyir. Uşaq prosesdə seçilən port valideynə keçmədiyi üçün
# həqiqəti öyrənməyin yeganə yolu budur. Ölçüldü (18 sentyabr 2026).
STATE_FILE="/tmp/oneteam-dev-servers.env"

echo ""
echo "=============================================="
echo " oneTeam — telefonda test"
echo "=============================================="
echo ""

# --- 1. Serverlər -----------------------------------------------------------
# API + Metro. Skript təkrar çağırışa davamlıdır: işləyənləri saxlayır,
# işləməyənləri arxa planda başladır.
bash "$REPO_ROOT/scripts/dev/ensure-dev-servers.sh"

# --- 2. Xcode ---------------------------------------------------------------
# .xcworkspace AÇILMALIDIR, .xcodeproj YOX — CocoaPods kitabxanaları yalnız
# workspace-də birləşir; .xcodeproj açılsa build "module not found" verir.
WORKSPACE="$REPO_ROOT/mobile/ios/oneTeamFieldAudit.xcworkspace"
if [ -d "$WORKSPACE" ]; then
  echo ""
  echo "Xcode açılır..."
  open "$WORKSPACE"
else
  echo ""
  echo "⛔ $WORKSPACE tapılmadı."
  echo "   Əvvəlcə bunu işlət:  bash scripts/dev/setup-ios.sh"
  exit 1
fi

# --- 3. Təlimat --------------------------------------------------------------
echo ""
echo "=============================================="
echo " XCODE-DA NƏ ETMƏLİ"
echo "=============================================="
echo ""
echo "  1. Yuxarı solda cihaz seç:  simulyatoru yox, SƏNİN iPhonunu."
echo "     Telefon USB ilə qoşulmalı, Mac ilə eyni Wi-Fi-da olmalıdır."
echo ""
echo "  2. İlk dəfədirsə — imzalama (bir dəfəlik):"
echo "       • Solda layihə adına kliklə → TARGETS → oneTeamFieldAudit"
echo "       • 'Signing & Capabilities' sekmesi"
echo "       • 'Team' siyahısından Apple ID-ni seç"
echo ""
echo "  3. ▶ (Run) düyməsini sıx."
echo "     Serverlər artıq işlədiyi üçün tətbiq dərhal paketi alacaq."
echo ""
echo "  4. Telefonda ilk dəfə:"
echo "       • 'Untrusted Developer' → Settings → General →"
echo "         VPN & Device Management → developer adına etibar et"
echo "       • Settings → Privacy & Security → Developer Mode → ON"
echo "       • Tətbiq açılanda kamera, GPS və YERLİ ŞƏBƏKƏ icazələrini ver"
echo ""
echo "----------------------------------------------"
echo " Metro log-u:          tail -f /tmp/oneteam-metro.log"
echo " API log-u:            tail -f /tmp/oneteam-api.log"
echo " Serverləri dayandır:  bash scripts/dev/ensure-dev-servers.sh --stop"
echo "=============================================="
echo ""

# Tətbiqin hansı API-yə danışacağını tətbiqin öz status ekranı göstərir.
# Burada isə serverlərin HƏQİQƏTƏN seçdiyi ünvanı göstəririk — öz təxminimizi
# yox. "Ünvan belədir" demək "API işləyir" demək DEYİL, ona görə ikisi ayrıca
# yoxlanılır: işləməyən API-ni işləyir kimi göstərmək istifadəçini çaşdırardı.
if [ -f "$STATE_FILE" ]; then
  # shellcheck source=/dev/null
  . "$STATE_FILE"
  if [ "${API_UP:-no}" = "yes" ]; then
    echo "Tətbiqin danışacağı API: ${API_URL:-bilinmir}"
  else
    echo "⚠️  API cavab vermir — tətbiq açılacaq, amma məlumat gətirməyəcək."
    echo "   Səbəb üçün loqa bax: /tmp/oneteam-api.log"
  fi
else
  echo "⚠️  Serverlərin seçdiyi ünvan məlum deyil (vəziyyət faylı yoxdur)."
fi
echo ""
