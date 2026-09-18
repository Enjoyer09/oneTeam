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
# Metro-nun hansı API ünvanı ilə başladıldığını yazırıq. Səbəb aşağıda, Metro
# bölməsində izah olunub — bir sətirdə: paket YIĞILARKƏN ünvan ora yazılır,
# ona görə "işləyən Metro" ilə "düzgün ünvanlı Metro" eyni şey deyil.
METRO_ENV_FILE="/tmp/oneteam-metro.env"

# Xcode pre-action-ı QİYMƏTLƏNDİRMƏ MÜHİTİNDƏ işləyir: PATH yalnız
# /usr/bin:/bin:/usr/sbin:/sbin olur və `node` tapılmır. Ona görə node-un
# bu maşında ola biləcəyi yerləri açıq şəkildə əlavə edirik.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# --- --stop -----------------------------------------------------------------
#
# ÖLÇÜLDÜ (18 sentyabr 2026): `npm run` SIGTERM-i öz uşağına ÖTÜRÜR — qeydə
# alınan PID-i öldürmək serveri həqiqətən dayandırır (sınaqda `npm run web:dev`
# ilə başlayan `vite` uşağı npm ilə birlikdə getdi və port azad oldu).
#
# Buna baxmayaraq uşaqlar da açıq şəkildə öldürülür, iki səbəbə görə:
#   • `npx expo start` üçün siqnal ötürməsi ÖLÇÜLMƏDİ — `npx` npm-dən fərqli
#     bir örtükdür və ötürməyə zəmanət yoxdur;
#   • portu tutan proses uşaqdır, ona görə əmin olmaq istədiyimiz şey elə odur.
stop_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    stop_tree "$child"
  done
  kill "$pid" 2>/dev/null
}

if [ "${1:-}" = "--stop" ]; then
  stopped=0
  for file in "$API_PID_FILE" "$METRO_PID_FILE"; do
    [ -f "$file" ] || continue
    pid="$(cat "$file")"
    name="$(basename "$file" .pid)"
    if kill -0 "$pid" 2>/dev/null; then
      stop_tree "$pid"
      echo "✓ Dayandırıldı: $name (PID $pid)"
      stopped=$((stopped + 1))
    else
      echo "– $name artıq işləmirdi (PID $pid)"
    fi
    rm -f "$file"
  done

  # Metro-nun "hansı API ünvanı ilə başladıldı" qeydi də silinməlidir: köhnə
  # qeyd qalsa, növbəti işə salma onu canlı Metro kimi sayıb yanılardı.
  rm -f "$METRO_ENV_FILE"

  if [ "$stopped" -eq 0 ]; then
    echo "İşləyən server yoxdur."
  fi

  # "Dayandırdım" demək kifayət deyil — portun həqiqətən azad olduğunu göstər.
  # Tutulubsa, bunu de: səssiz qalmaq istifadəçini yanlış inandırar.
  for port in "$API_PORT" "$METRO_PORT"; do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "⚠️  Port $port hələ də tutulub (bizim serverimiz olmaya da bilər):"
      lsof -nP -iTCP:"$port" -sTCP:LISTEN | tail -n +2 | awk '{print "     " $1 " (PID " $2 ")"}'
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
  local port="${1:-$API_PORT}" body
  body="$(curl -s --max-time 2 "http://127.0.0.1:${port}/api/health" 2>/dev/null)"
  printf '%s' "$body" | grep -q 'oneteam-api'
}

port_is_free() {
  ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

# --- 2. API portu -----------------------------------------------------------
#
# Portu ƏVVƏLCƏDƏN seçirik, API-ni isə sonra başladırıq. Səbəb ÖLÇÜLMÜŞDÜR
# (18 sentyabr 2026): bu maşında 3001 portunu layihədən olmayan bir proqram
# tutur. API `npm run api:dev` bitəndən SONRA `EADDRINUSE` ilə ölür — yəni
# istifadəçi ~60 saniyə boş ekrana baxır və səbəbi yalnız loqda görünür.
#
# Portu tutan BİZİM API-dirsə dəyişmirik (aşağıda təkrar istifadə olunacaq).
# Əks halda növbəti boş port götürülür. Bu, telefonda test axını üçün
# təhlükəsizdir: ünvan tətbiqə Metro paketi ilə verilir, yəni tətbiq hansı
# portu istifadə etdiyimizi bilir.
REQUESTED_API_PORT="$API_PORT"
if ! port_is_free "$REQUESTED_API_PORT" && ! api_is_up "$REQUESTED_API_PORT"; then
  echo "⚠️  Port $REQUESTED_API_PORT tutulub və cavab verən oneTeam API deyil."
  for candidate in $(seq $((REQUESTED_API_PORT + 10)) $((REQUESTED_API_PORT + 20))); do
    if port_is_free "$candidate"; then
      API_PORT="$candidate"
      break
    fi
  done
  if [ "$API_PORT" = "$REQUESTED_API_PORT" ]; then
    echo "   Boş port tapılmadı — $API_PORT ilə davam edilir, API qalxmaya bilər."
  else
    echo "   oneTeam API port $API_PORT-də başladılacaq."
  fi
fi

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
    # API portu tuta bilmirsə, qalan ~60 saniyəni gözləməyin mənası yoxdur.
    # `>` loqu başlamazdan əvvəl sıfırlayır, ona görə burada tapdığımız hər şey
    # BU işə salmaya aiddir — köhnə xəta bizi vaxtsız dayandıra bilməz.
    if grep -q 'EADDRINUSE' "$API_LOG" 2>/dev/null; then break; fi
    sleep 2
  done
  if api_is_up; then
    echo "✓ API hazırdır."
  else
    echo "⚠️  API cavab vermir. Log: $API_LOG"
    if grep -q 'EADDRINUSE' "$API_LOG" 2>/dev/null; then
      echo "   API $API_PORT portunu tuta bilmədi — orada başqa proqram var."
      echo "   Həll: həmin proqramı dayandır, ya da portu açıq ver:"
      echo "     API_PORT=3011 bash scripts/dev/ensure-dev-servers.sh"
    fi
  fi
fi

# --- 3. Metro ---------------------------------------------------------------
#
# "İşləyən Metro var" YETƏRLİ DEYİL, və bu, ölçülmüş bir tələdir.
#
# `EXPO_PUBLIC_ONETEAM_API_URL` paket YIĞILARKƏN JS-in içinə yazılır. Deməli
# artıq işləyən Metro-nu təkrar istifadə etmək yalnız o Metro İSTƏNİLƏN ünvanla
# başladılıbsa doğrudur. Əks halda tətbiq köhnə ünvana qoşulmağa çalışır və
# ekranda səbəb görünmür.
#
# 18 sentyabr 2026-da bu, real olaraq baş verdi: 8081-də cavab verən Metro
# başqa bir git worktree-dən (`.claude/worktrees/...`) işləyirdi və KÖHNƏ
# checkout-u verirdi. Skript onu "Metro artıq işləyir" deyə təkrar istifadə
# etdi — yəni telefon köhnə kodu yükləyəcəkdi.
#
# Ona görə indi üç şey yoxlanılır: portda Metro var? onu BİZ başlatmışıq?
# və istənilən ünvanla? Üçü də "hə" olmasa, Metro yenidən başladılır.
WANT_API_URL="http://${LAN_IP}:${API_PORT}"

metro_is_ours() {
  [ -f "$METRO_PID_FILE" ] || return 1
  kill -0 "$(cat "$METRO_PID_FILE")" 2>/dev/null || return 1
  [ "$(cat "$METRO_ENV_FILE" 2>/dev/null || true)" = "$WANT_API_URL" ]
}

# 8081-i tutan prosesi dayandırır. Yalnız `metro_is_up` doğru olanda çağırılır,
# yəni prosesin həqiqətən Metro olduğu artıq təsdiqlənib — Metro isə yenidən
# başladıla bilən dev serverdir, ona görə bunu avtomatik etmək təhlükəsizdir.
stop_metro_holder() {
  local pids pid
  pids="$(lsof -nP -tiTCP:"$METRO_PORT" -sTCP:LISTEN 2>/dev/null || true)"
  [ -n "$pids" ] || return 0
  for pid in $pids; do
    stop_tree "$pid"
  done
  for _ in $(seq 1 15); do
    metro_is_up || break
    sleep 1
  done
}

start_metro() {
  (
    cd "$REPO_ROOT/mobile" || exit 1
    # `--host lan` OLMADAN paket yalnız kompüterin özünə verilir və telefonda
    # "No script URL provided" görünür.
    EXPO_PUBLIC_ONETEAM_API_URL="$WANT_API_URL" \
      EXPO_NO_TYPESCRIPT_SETUP=1 \
      nohup npx expo start --host lan --port "$METRO_PORT" > "$METRO_LOG" 2>&1 < /dev/null &
    echo $! > "$METRO_PID_FILE"
  )
  printf '%s' "$WANT_API_URL" > "$METRO_ENV_FILE"

  # Soyuq Metro ~15-30 saniyə çəkir; gözləməsək tətbiq ondan əvvəl açılıb
  # "qoşula bilmədi" göstərə bilər.
  for _ in $(seq 1 30); do
    if metro_is_up; then break; fi
    sleep 2
  done
  if metro_is_up; then
    echo "✓ Metro hazırdır."
  else
    echo "⚠️  Metro hələ cavab vermir. Log: $METRO_LOG"
  fi
}

METRO_JUST_STARTED=0
if metro_is_up && metro_is_ours; then
  echo "✓ Metro artıq işləyir və API ünvanı düzdür ($WANT_API_URL)."
else
  if metro_is_up; then
    echo "→ Metro $METRO_PORT portunda işləyir, amma ondan istifadə etmək olmaz:"
    if [ -f "$METRO_PID_FILE" ] && kill -0 "$(cat "$METRO_PID_FILE")" 2>/dev/null; then
      echo "   • başqa API ünvanı ilə başladılıb: $(cat "$METRO_ENV_FILE" 2>/dev/null || echo 'bilinmir')"
      echo "     (istənilən: $WANT_API_URL)"
    else
      echo "   • onu bu skript başlatmayıb — hansı checkout-u verdiyini və"
      echo "     paketə hansı API ünvanını yazdığını bilmirik"
    fi
    echo "   Paket yığılarkən API ünvanı JS-in içinə yazılır, ona görə köhnə"
    echo "   Metro köhnə ünvanı (və köhnə kodu) verərdi. Yenidən başladılır."
    stop_metro_holder
  fi
  echo "→ Metro başladılır (log: $METRO_LOG)..."
  start_metro
  METRO_JUST_STARTED=1
fi

# --- 4. Yekun ---------------------------------------------------------------
echo ""
echo "Tətbiqin danışacağı API: http://${LAN_IP}:${API_PORT}"
if [ "$METRO_JUST_STARTED" = "1" ]; then
  echo "Metro yenicə başladı — ilk paket yığılması 1-2 dəqiqə çəkə bilər."
fi
echo "Telefon kompüterlə eyni Wi-Fi-da olmalıdır."
