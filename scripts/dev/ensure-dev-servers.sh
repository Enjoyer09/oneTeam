#!/bin/bash
#
# oneTeam — API və Metro-nu FONDA işə salır (təkrar çağırışa davamlı).
#
# NİYƏ BU SKRİPT VAR
# -------------------
# Xcode-da "Run" düyməsini sıxanda tətbiq işə düşür, amma onun iki xarici
# asılılığı var: JS paketini verən Metro və məlumatı verən Core API. İkisi də
# işləmirsə tətbiq açılır, boş ekran göstərir və səbəb görünmür. Bu skript hər
# ikisini yoxlayır, lazım olsa arxa planda başladır və dərhal qayıdır — yəni
# Xcode-un "Pre-action" addımı kimi çağırıla bilər.
#
# NECƏ İŞLƏYİR
# ------------
#   1. Kompüterin şəbəkə ünvanını tapır (telefon bu ünvanla danışacaq).
#   2. API cavab verirsə heç nə etmir; vermirsə arxa planda başladır.
#   3. Metro cavab verirsə heç nə etmir; vermirsə arxa planda başladır.
#   4. Metro-nun hazır olmasını gözləyir (yalnız özü başladıbsa).
#
# Təkrar çağırışa davamlıdır: ikinci dəfə çağırılanda heç nə başlatmır.
# Xcode hər "Run"-da bunu çağırır, ona görə sürətli olmalıdır.
#
# ƏL İLƏ İŞLƏTMƏK
# ---------------
#     bash scripts/dev/ensure-dev-servers.sh
#
# Dayandırmaq üçün:  bash scripts/dev/ensure-dev-servers.sh --stop
#

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
API_PORT="${API_PORT:-3001}"
METRO_PORT="${METRO_PORT:-8081}"
API_LOG="/tmp/oneteam-api.log"
METRO_LOG="/tmp/oneteam-metro.log"
API_PID_FILE="/tmp/oneteam-api.pid"
METRO_PID_FILE="/tmp/oneteam-metro.pid"

# Xcode pre-action-ı QİYMƏTLƏNDİRMƏ MÜHİTİNDƏ işləyir: PATH yalnız
# /usr/bin:/bin:/usr/sbin:/sbin olur və `node` tapılmır. Ona görə node-un
# bu maşında ola biləcəyi yerləri açıq şəkildə əlavə edirik.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# --- --stop -----------------------------------------------------------------
if [ "${1:-}" = "--stop" ]; then
  for file in "$API_PID_FILE" "$METRO_PID_FILE"; do
    if [ -f "$file" ]; then
      pid="$(cat "$file")"
      if kill "$pid" 2>/dev/null; then
        echo "Dayandırıldı: PID $pid ($(basename "$file"))"
      fi
      rm -f "$file"
    fi
  done
  exit 0
fi

# --- CI-də işləməsin ---------------------------------------------------------
# CI-də serverləri test skripti özü idarə edir; burada ikinci bir Metro
# başlatmaq yarış şəraiti yaradar.
if [ "${CI:-}" = "true" ]; then
  echo "CI mühiti — serverlər burada başladılmır."
  exit 0
fi

# --- 1. Şəbəkə ünvanı -------------------------------------------------------
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
if [ -z "$LAN_IP" ]; then
  echo "⚠️  Şəbəkə ünvanı tapılmadı — API ünvanı 'localhost' olaraq qalır."
  echo "   Telefon bu halda API-yə çata bilməyəcək."
  LAN_IP="localhost"
fi

# Yoxlama HTTP KODUNA və CAVABA görə aparılır, `curl`-un çıxış koduna görə YOX.
#
# Səbəb ölçülüb: bəzi mühitlərdə (məsələn, qum qutusu) `localhost` proksidən
# keçir və bağlı port üçün də HTTP cavabı qaytarır — o zaman `curl` "uğurlu"
# olur və skript işləməyən serveri işləyən sayır. Bundan əlavə, portu tamam
# başqa bir proqram tuta bilər; cavabın içindəki `service` sahəsi bizim API
# olduğunu təsdiqləyir.
api_is_up() {
  local body
  body="$(curl -s --max-time 2 "http://127.0.0.1:${API_PORT}/api/health" 2>/dev/null)"
  printf '%s' "$body" | grep -q 'oneteam-api'
}

metro_is_up() {
  local body
  body="$(curl -s --max-time 2 "http://127.0.0.1:${METRO_PORT}/status" 2>/dev/null)"
  [ "$body" = "packager-status:running" ]
}

# --- 2. API -----------------------------------------------------------------
if api_is_up; then
  echo "✓ API artıq işləyir (port $API_PORT)."
else
  echo "→ API başladılır (log: $API_LOG)..."
  # `api:dev` əvvəlcə TypeScript-i yığır. NestJS dekorator metadatası üçün
  # `tsc` lazımdır (`tsx` onu buraxmır), ona görə bu skript `tsx` işlətmir.
  (
    cd "$REPO_ROOT" || exit 1
    nohup npm run api:dev > "$API_LOG" 2>&1 < /dev/null &
    echo $! > "$API_PID_FILE"
  )
  for _ in $(seq 1 30); do
    if api_is_up; then break; fi
    sleep 2
  done
  if api_is_up; then
    echo "✓ API hazırdır."
  else
    echo "⚠️  API cavab vermir. Log: $API_LOG"
    if lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "   Port $API_PORT başqa bir proqram tərəfindən tutulub — API ora qoşula bilmir."
      echo "   Ya həmin proqramı dayandır, ya da fərqli port ver:"
      echo "     API_PORT=3011 bash scripts/dev/ensure-dev-servers.sh"
    fi
  fi
fi

# --- 3. Metro ---------------------------------------------------------------
METRO_JUST_STARTED=0
if metro_is_up; then
  echo "✓ Metro artıq işləyir (port $METRO_PORT)."
else
  echo "→ Metro başladılır (log: $METRO_LOG)..."
  # `--host lan` OLMADAN paket yalnız kompüterin özünə verilir və telefonda
  # "No script URL provided" görünür.
  #
  # `EXPO_PUBLIC_ONETEAM_API_URL` BURADA verilir, çünki Expo bu dəyəri paket
  # YIĞILARKƏN yerinə qoyur (runtime-da oxumur). Metro səhv ünvanla başlasa,
  # tətbiq telefonda özünün 'localhost'-una qoşulmağa çalışır və alınmır.
  (
    cd "$REPO_ROOT/mobile" || exit 1
    EXPO_PUBLIC_ONETEAM_API_URL="http://${LAN_IP}:${API_PORT}" \
      EXPO_NO_TYPESCRIPT_SETUP=1 \
      nohup npx expo start --host lan --port "$METRO_PORT" > "$METRO_LOG" 2>&1 < /dev/null &
    echo $! > "$METRO_PID_FILE"
  )
  METRO_JUST_STARTED=1

  # Yalnız özümüz başlatdıqda gözləyirik: soyuq Metro ~15-30 saniyə çəkir və
  # gözləməsək tətbiq ondan əvvəl açılıb "qoşula bilmədi" göstərə bilər.
  for _ in $(seq 1 30); do
    if metro_is_up; then break; fi
    sleep 2
  done
  if metro_is_up; then
    echo "✓ Metro hazırdır."
  else
    echo "⚠️  Metro hələ cavab vermir. Log: $METRO_LOG"
  fi
fi

# --- 4. Yekun ---------------------------------------------------------------
echo ""
echo "Tətbiqin danışacağı API: http://${LAN_IP}:${API_PORT}"
if [ "$METRO_JUST_STARTED" = "1" ]; then
  echo "Metro yenicə başladı — ilk paket yığılması 1-2 dəqiqə çəkə bilər."
fi
echo "Telefon kompüterlə eyni Wi-Fi-da olmalıdır."
