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
# Runtime vəziyyətin (loqlar, PID faylları, vəziyyət faylı) yeri. Default
# `/tmp`-dir. Dəyişdirilə bilər ki, testlər istifadəçinin HƏQİQİ serverlərinin
# qeydlərini üzərinə yazmasın — yoxsa testdən sonra `run-on-device.sh` testin
# portunu istifadəçinin portu kimi göstərərdi.
STATE_DIR="${ONETEAM_DEV_STATE_DIR:-/tmp}"
mkdir -p "$STATE_DIR"
API_LOG="$STATE_DIR/oneteam-api.log"
METRO_LOG="$STATE_DIR/oneteam-metro.log"
API_PID_FILE="$STATE_DIR/oneteam-api.pid"
METRO_PID_FILE="$STATE_DIR/oneteam-metro.pid"
# Metro-nun hansı API ünvanı ilə başladıldığını yazırıq. Səbəb aşağıda, Metro
# bölməsində izah olunub — bir sətirdə: paket YIĞILARKƏN ünvan ora yazılır,
# ona görə "işləyən Metro" ilə "düzgün ünvanlı Metro" eyni şey deyil.
METRO_ENV_FILE="$STATE_DIR/oneteam-metro.env"
# Bu skriptin SEÇDİYİ nəticəni yazırıq (port, ünvan, API cavab verir ya yox).
# Lazımdır, çünki `run-on-device.sh` bu skripti UŞAQ proses kimi çağırır: uşaqda
# təyin edilən dəyişən valideynə keçmir, ona görə valideyn seçilmiş portu başqa
# cür öyrənə bilmir. Əvvəllər `run-on-device.sh` öz defoltunu (3001) çap edirdi,
# halbuki API 3011-də işləyirdi — yəni ekranda YANLIŞ ünvan görünürdü.
STATE_FILE="$STATE_DIR/oneteam-dev-servers.env"

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

# --- Fonda başlatma: proses qrupundan QOPMUŞ şəkildə -------------------------
#
# `nohup cmd &` KİFAYƏT DEYİL — və bu, ÖLÇÜLDÜ (18 sentyabr 2026).
#
# Xcode-un pre-action-ını təqlid edən sınaqda (`env -i` + yalnız
# /usr/bin:/bin:/usr/sbin:/sbin PATH-i, SRCROOT ilə) API və Metro DÜZGÜN qalxdı,
# skript "✓ API hazırdır. ✓ Metro hazırdır." yazdı, çıxış kodu 0 oldu — sonra isə
# hər ikisi skripti çağıran qabıq bitəndə ÖLDÜ. Loqlarda dayanma mesajı yoxdur,
# PID-lər ölüdür: yəni proseslər xəta ilə deyil, QRUPLA birlikdə ləğv edilib.
#
# Səbəb: `nohup` yalnız SIGHUP-ı bloklayır. Proses QRUPLARININ ləğv edilməsi isə
# siqnal deyil, ona görə `nohup` oradan qorumur. Nəticəsi istifadəçi üçün ən pis
# cür görünür: server ölür, telefon paketi ala bilmir, ekranda isə səbəb yoxdur.
#
# Ona görə prosesi YENİ SESSİYADA başladırıq (`setsid()` semantikası). Node bu
# maşında mütləqdir — skript onsuz da `npx` işlədir — və `detached: true` elə
# `setsid()`-dir. Üstünlüyü: qeydə alınan PID WRAPPER deyil, birbaşa prosesdir.
#
# Loq "w" rejimində açılır, yəni sıfırlanır: `EADDRINUSE` yoxlaması yalnız BU
# işə salmaya baxmalıdır, köhnə xəta bizi vaxtsız dayandırmamalıdır.
spawn_detached() {
  local cwd="$1" log="$2"
  shift 2
  node -e '
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    const [cwd, log, cmd, ...args] = process.argv.slice(1);
    const out = fs.openSync(log, "w");
    const child = spawn(cmd, args, {
      cwd,
      detached: true,                 // = setsid(): yeni sessiya + yeni proses qrupu
      stdio: ["ignore", out, out],
      env: process.env,
    });
    child.unref();
    process.stdout.write(String(child.pid));
  ' "$cwd" "$log" "$@"
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
  # Vəziyyət faylı da silinir — qalsa, `run-on-device.sh` dayandırılmış
  # serverlərin portunu "tətbiqin danışacağı API" kimi çap edərdi.
  rm -f "$STATE_FILE"

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

if api_is_up "$REQUESTED_API_PORT" || port_is_free "$REQUESTED_API_PORT"; then
  : # istənilən port ya BİZİM API-dir, ya boşdur — portu dəyişmirik
else
  echo "⚠️  Port $REQUESTED_API_PORT tutulub və cavab verən oneTeam API deyil."
  FOUND=""
  for candidate in $(seq $((REQUESTED_API_PORT + 10)) $((REQUESTED_API_PORT + 20))); do
    # ƏVVƏLCƏ TƏKRAR İSTİFADƏ, sonra yeni port. Namizəd portda artıq bizim API
    # işləyə bilər: skript bir dəfə işlədilib, sonra təkrar çağırılır. Bu
    # yoxlama olmasa, ikinci çağırış işləyən API-ni görməz və NÖVBƏTİ boş portu
    # götürərdi — yəni hər çağırışda yeni API başlardı, köhnəsi isə qalardı.
    # Ölçüldü (18 sentyabr 2026): birinci çağırış 3011, ikinci çağırış 3012.
    if api_is_up "$candidate"; then
      API_PORT="$candidate"
      FOUND="reuse"
      echo "   Artıq işləyən oneTeam API tapıldı: port $candidate."
      break
    fi
    if port_is_free "$candidate"; then
      API_PORT="$candidate"
      FOUND="new"
      echo "   oneTeam API port $candidate-də başladılacaq."
      break
    fi
  done
  if [ -z "$FOUND" ]; then
    echo "   Boş port tapılmadı — $API_PORT ilə davam edilir, API qalxmaya bilər."
  fi
fi

# `export` MÜTLƏQDİR, sadəcə təyin etmək kifayət deyil.
#
# API portu `apps/api/src/main.ts`-də `process.env.PORT || process.env.API_PORT`
# ilə oxunur, yəni uşaq prosessin MÜHİTİNDƏ olmalıdır. Skript daxilində təyin
# edilən dəyişən isə mühitə düşmür: 18 sentyabr 2026-da bu, səssiz uğursuzluq
# yaratdı — skript "API port 3011-də başladılacaq" yazdı, API isə 3001-i
# yoxlayıb `EADDRINUSE` ilə öldü, yəni çıxış YALAN danışırdı.
#
# (`API_PORT=3011 bash ...` ilə işlədəndə dəyişən artıq mühitdən gəlir və
# `export`-suz da işləyir — ona görə bu, yalnız avtomatik seçim yolunda
# görünürdü.)
export API_PORT

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
  spawn_detached "$REPO_ROOT" "$API_LOG" npm run api:dev > "$API_PID_FILE"
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
  # `export` lazımdır: `spawn_detached` uşağa `process.env`-i ötürür, ona görə
  # paketə yazılacaq ünvan uşaq yaradılmazdan ƏVVƏL mühitdə olmalıdır.
  export EXPO_PUBLIC_ONETEAM_API_URL="$WANT_API_URL"
  export EXPO_NO_TYPESCRIPT_SETUP=1
  # `--host lan` OLMADAN paket yalnız kompüterin özünə verilir və telefonda
  # "No script URL provided" görünür.
  spawn_detached "$REPO_ROOT/mobile" "$METRO_LOG" \
    npx expo start --host lan --port "$METRO_PORT" > "$METRO_PID_FILE"
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
#
# Seçilmiş nəticəni FAYLA yazırıq. Səbəb: bu skript `run-on-device.sh`-dən və
# Xcode-un pre-action-ından UŞAQ proses kimi çağırılır, uşaqda təyin edilən
# dəyişən isə valideynə keçmir. Əvvəllər `run-on-device.sh` öz defoltunu (3001)
# çap edirdi, halbuki API 3011-də işləyirdi — yəni ekranda YANLIŞ ünvan
# görünürdü. Ölçüldü (18 sentyabr 2026).
#
# `API_UP` də yazılır: "ünvan belədir" demək "API işləyir" demək DEYİL, və
# işləməyən API-ni işləyir kimi göstərmək istifadəçini yanlış yönəldərdi.
if api_is_up; then API_UP="yes"; else API_UP="no"; fi
{
  printf 'API_PORT=%s\n' "$API_PORT"
  printf 'API_UP=%s\n' "$API_UP"
  printf 'METRO_PORT=%s\n' "$METRO_PORT"
  printf 'LAN_IP=%s\n' "$LAN_IP"
  printf 'API_URL=%s\n' "$WANT_API_URL"
} > "$STATE_FILE"

echo ""
echo "Tətbiqin danışacağı API: http://${LAN_IP}:${API_PORT}"
if [ "$METRO_JUST_STARTED" = "1" ]; then
  echo "Metro yenicə başladı — ilk paket yığılması 1-2 dəqiqə çəkə bilər."
fi
echo "Telefon kompüterlə eyni Wi-Fi-da olmalıdır."
