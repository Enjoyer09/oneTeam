# oneTeam — Məhsul və Texniki Plan (AZ)

> **Qeyd:** Bu sənəd hələ **daxilindədir**. Kod dəyişməyib. Planı təsdiqləsinizsə, onda kodlamağa başlayaq.

---

## 1. Mövcud vəziyyət — qısaca (avtomat yoxlamanın nəticəsi)

| Sahə | Hazırdır | Boşluq | Risk |
|------|----------|--------|------|
| **API (NestJS)** | Mağaza CRUD, tapşırıq axını, çeklist, geofence, audit, photo (R2), status maşını | Admin panel uç nöqtələri (`/api/panel/*`) hələ sadə (yalnız `me`, `keys`, `logout`) | `oneteam-user:` kredensialı `/api/panel/*` girişində hələ qəbul olunur (yalnız `/api/portal/` yoxlanır) |
| **Telegram Bot** | Polling, location + checklist, enrolment, photo | Menyular sade `text`-dir, inline keyboard yoxdur, state idempotent deyil | Yeni mağaza yaratma, tapşırıq təyinatı botdan yoxdur |
| **Web Panel (React)** | Giriş (şəxsi açar), mağaza siyahısı, tapşırıq detalları, şəkil upload | Mağaza/tapşırıq **yaratma/redaktə** UI yoxdur, yalnız oxumaq | Supervayzer rolları tapılmır (yalnız ADMIN) |
| **Mobil (React Native/Expo)** | `LoginScreen`, `portalApi`, headless controller qatı | **Nativecamera yoxdur**, qalıcı saxlanc yoxdur, Expo config yoxdur, Xcode testi yoxdur | Hər açılışda yenidən enrolment lazımdır |
| **AI / YOLO** | `yolov8n.pt` faylı mövcuddur, `test:ai` skripti işləyir | **Heç birSKU/planogram modeli yoxdur** (yalnız COCO), OpenRouter inteqrasiyası yoxdur | Pulsuz model rate-limit, məxfilik, fallback dəyəri yoxdur |

**Təsdiqlənmiş canlı işlər:**
- Bot tokeni dəyişdirildi ✅
- Panel açarı yaradıldı (`liveKeys=1`) ✅
- Enrolment secret qoyuldu ✅
- Cloudflare R2 şəkil saxlancı aktivdir ✅

---

## 2. Arxitektura qararı (təsdiq tələb edir)

| Sual | Tövsiyə | Niyə |
|------|---------|------|
| **Mağaza kim yaradır?** | **Web panel** (supervayzer) — başlanğıc məlumatların dəqiqliyi üçün. Bot və mobil **yalnız tapşırıq icrası**. | Mağaza kodu, geofence radiusu, адрес, rəf quruluşu — bunlar səhv etibarsız olmamalıdır. |
| **Tapşırıq kim yaradır / kimə verir?** | **Web panel** yaradır → konkret **mağaza + konkret istifadəçi (deviceId/chatId)**. Mobil/Bot **yalnız icra**. | Birlikdə başlayan tapşırıqlarla qarışıqlıq yaranmır. |
| **Telegram menyusu necə olsun?** | **Inline keyboard** (state-machine: `main → store → task → checklist → photo → confirm`). Hər basılma **idempotent**. | Sadə `text` komandalar bazar səsliyə çevrilir; inline pro kahfiyyətdir. |
| **iOS necə test edəcəyik?** | `expo prebuild` → Xcode-də **Development Build** → simulyator və ya real cihaz. `mobile/dependencies: {}` olarakı **Expo SDK 52+** ilə başlamaq. | `eject`/`bare` workflow murakıb; prebuild + EAS Build / `xcodebuild` uyğundur. |
| **AI necə işləyəcək?** | **Hibrid:** YOLOv8 (COCO) → region extraction → OpenRouter **pulsuz vision model** (mhmdx64/qpt-4.1-mini) → JSON planogram skor + anomaliya. **Heç bir SKU modeli train etməyirik**. | SKU modeli 5000+ şəkil, 2-3 ay. OpenRouter pulsuz 1K req/dəq, 1M token/ay — pilot üçün kifayət. |
| **OpenRouter model?** | `google/gemma-3n-e4b-it:free` (image, 4B, 128k ctx) **və ya** `meta-llama/llama-3.2-11b-vision-instruct:free` (image, 11B). Rate limit: 20 RPM / 1000 RPD. | İki variant test edib bəsəriyin; ikisi də pulsuz, image input, JSON output. |

---

## 3. Mərhələli icra planı (8 həftə, 4 mərhələ)

### MƏRHƏLƏ 1 — Əsas boşluqlar və təhlükəsizlik (Həftə 1–2)

| # | İş paketi | Qəbul meyarı | Müddət |
|---|-----------|--------------|--------|
| 1.1 | **Panel təhlükəsizliyi:** `/api/panel/*` üçün `mayUseRoute` yoxlamasını `/api/portal/` şərtindən azad et, `oneteam-user:` token-i paneldə **tamamilə rədd et** (yalnız `otp_` qəbul et). | `curl -H "Authorization: Bearer oneteam-user:usr-admin-001" /api/panel/me → 403`. | 0.5 gün |
| 1.2 | **Logout sonuncu açarı silə bilməsin:** `POST /api/panel/keys/<prefix>/revoke` sonuncu canlı açarı silməyə cəhd edəndə `400 LAST_KEY_CANNOT_REVOKE` qaytarsın (bootstrap key ilə bərpa yolu qalmalıdır). | `revoke` sonuncu açar → 400; bootstrap key qoyulanda yenidən açar yaratmaq olar. | 0.5 gün |
| 1.3 | **Mağaza CRUD (Web):** `POST/PATCH/DELETE /api/panel/stores` + React form (ad, kod, ünvan, geofence radius, rəf sayını seçici). | Yeni mağaza yaradılır → siyahıda görünür → kod unikal → silinmə Sonnyu açar silmir. | 1.5 gün |
| 1.4 | **Tapşırıq CRUD (Web):** `POST/PATCH/DELETE /api/panel/tasks` — mağaza, başlıq, növ (`CHECKLIST`, `PHOTO`, `AUDIT`), planlı tarix, müddət, çəkięzyuxası (JSON),Claim yalnız sahibə. | Tapşırıq yaradılır →Claim et → mobil/bot-da görünür → başqa istifadəçi claim edə bilməz. | 1.5 gün |
| 1.5 | **İstifadəçi rolları:** `SUPERVISOR` (mağaza/tapşırıq yaradır), `MERCHANDISER` (icra), `ADMIN` (açarlar, rollar). `mayActAsAnotherUser` yoxlamasını `SUPERVISOR`-a genişləndir. | Supervayzer yaradanda `SUPERVISOR` roluna düşür → claim edir; ADMIN panelə girir. | 1 gün |

**Mərhələ 1 nəticəsi:** Web panel **tam idarəetmə mərkəzi** olur; təhlükəsizlik boşluqları bağlanır.

---

### MƏRHƏLƏ 2 — Telegram bot peşəkar menyu (Həftə 3)

| # | İş paketi | Qəbul meyarı | Müddət |
|---|-----------|--------------|--------|
| 2.1 | **Inline keyboard state machine:** `main → store-list → task-list → checklist → photo → confirm → done`. Hər düymə `callback_data` ilə `action:id` formatında. | Basılma dublikat heç bir səhv yaratmır (idempotent). | 1.5 gün |
| 2.2 | **Bot session store (Redis / in-memory TTL):** `chatId → {step, storeId, taskId, checklistAnswers[]}`. 15 dəq TTL, yenilənmə. | Yenidən başlatma ilə state itmir; `chatId` yenidən yazanda əvvəlki davam edir. | 1 gün |
| 2.3 | **Notification:** tapşırıq yaradılma / vaxt bitmə / rədd 15 dəq əvvəl → `sendMessage` + inline `Open` düyməsi. | Supervayzer panelində yaradanda bot Bildiriş alır. | 0.5 gün |
| 2.4 | **Fallback (text):** `/start`, `/help`, `/mystatus` — inline olmadıqda işləsin. | `/help` → menyu göstərir. | 0.5 gün |

**Mərhələ 2 nəticəsi:** Bot **peşəkar, rahat, səsli** interfeys; sahə işçisi heç bir `/komanda` yazmır.

---

### MƏRHƏLƏ 3 — iOS tətbiqi (Expo prebuild + Xcode) (Həftə 4–5)

| # | İş paketi | Qəbul meyarı | Müddət |
|---|-----------|--------------|--------|
| 3.1 | **Expo config:** `app.json` / `app.config.ts` — `bundleIdentifier`, `name`, `icon`, `splash`, `ios: {supportsTablet: false}`, `plugins: ["expo-camera", "expo-location", "expo-secure-store"]`. | `npx expo prebuild --platform ios` → `ios/` qovluğu yaradılır, heç bir xəta yoxdur. | 1 gün |
| 3.2 | **Native camera + secure storage:** `expo-camera` → permission rationale; `expo-secure-store` → `deviceToken`, `enrollmentSecret` yaz/oxu. Silinməstwa deviceToken qalır. | Kamera açılır → şəkil çəkilir → base64 API-yə gedir. Yenidən açılışda enrolment **avtomatik** (token yaddaşda). | 1.5 gün |
| 3.3 | **Offline queue (AsyncStorage):** şəkil + metadata local queue → onlayn olduqda flush. 50 MB limit, auto-retry. | Avia-rejimdə 3 şəkil çək → onlayn → 3 upload (sıralı). | 1 gün |
| 3.4 | **Xcode test:** `xcodebuild -workspace oneTeam.xcworkspace -scheme oneTeam -destination 'platform=iOS Simulator,name=iPhone 16' build test` → **mürəkkəb UI testləri** (Login → Enroll → Task → Photo → Submit). | CI (GitHub Actions) hər PR-da `xcodebuild test` keçir. | 1 gün |
| 3.5 | **Mövcud React Native UI saxlanmaq:** `mobile/src/screens/*` fayllarını **yenidən yazmadan** `expo-router` / `React Navigation` ilə quraşdır. Dizayn dəyişməsin. | Mövcud ekranlar (Login, TaskList, TaskDetail, Checklist, Camera) birebir görünür. | 1 gün |

**Mərhələ 3 nəticəsi:** Real iPhone-da / Simulyatorda **yaddaşda saxlanılan açarla**, kamerası və offline queue ilə işləyən tətbiq.

---

### MƏRHƏLƏ 4 — YOLO + OpenRouter AI hibrid (Həftə 6–7)

| # | İş paketi | Qəbul meyarı | Müddət |
|---|-----------|--------------|--------|
| 4.1 | **OpenRouter client:** `packages/ai/openrouter.ts` — `fetch` + `Authorization: Bearer ${OPENROUTER_KEY}`, `HTTP-Referer`, `X-Title`. Rate-limit: token bucket (20 RPM / 1000 RPD), exponential backoff. | 100 parallel request → heç biri 429 qaytarmır; 429 gələndə 60 sn gözləyir. | 1 gün |
| 4.2 | **Vision prompt template:** JSON schema (`zod`) — `planogramScore(0-100)`, `missingSKUs[]`, `extraItems[]`, `anomalies[]`, `confidence(0-1)`. Prompt: "Sen Coca-Cola rəf auditçisisən. JSON qaytar." | Schema validation uğurlu; JSON parse xətası < 0.1%. | 1 gün |
| 4.3 | **YOLO pre-filter:** `yolov8n.pt` (COCO) → `bottle`, `cup`, `wine glass` klassları → bounding box → crop → base64 → OpenRouter. Yalnız **roi** göndər → token xərci 70% azalır. | 100 test şəkli → ortalama 1.2s / şəkil; token < 1500/request. | 1 gün |
| 4.4 | **Worker pipeline:** `apps/api/src/workers/ai-worker.ts` — BullMQ queue (`ai:analyze`), concurrency 2, retry 3, dead-letter. Input: `evidenceId`, Output: `aiResult` (JSON) + `planogramScore` yazılır. | 50 evidence yaradılır → queue dolub → worker bitirir → `/api/portal/evidence/:id` `aiResult` göstərir. | 1.5 gün |
| 4.5 | **Fallback & honesty:** Model 429 / 5xx / timeout → `aiResult: {fallback: true, reason, yoLoOnlyScore}`; **sahibkarlıq**: heç vaxt "bağışlayıcı" nəticə yazma. | Rate-limit çağırışında `fallback: true` gəlir; supervayzer "AI yoxlanmadı" görür. | 0.5 gün |
| 4.6 | **Məxfilik / Data Processing Addendum:** OpenRouter-a göndərilən şəkillər **heç bir şəkildə** model eğitiminə istifadə edilmir (OpenRouter Terms §3.2). `X-OpenRouter-User-Id` göndərmirik. | Doc-da qeyd edilir; operator imzalayır. | 0.5 gün |

**Mərhələ 4 nəticəsi:** Hər yüklənən audit şəkli **avtomatik** YOLO+Vision LLM ilə qiymətləndirilir, skor + anomaliya paneldə görünür.

---

### MƏRHƏLƏ 5 — İnteqrasiya testi, sənədləşmə, təqdimat (Həftə 8)

| # | İş paketi | Qəbul meyarı |
|---|-----------|--------------|
| 5.1 | **End-to-end:** Web mağaza yarat → tapşırıq yarad → bot bildirişi al → mobil claim et → çeklist doldur → photo çek → AI score al → panelə bax → skoru təsdiq et / düzəlt. | 1 tam dövr (5 mağaza, 3 istifadəçi) heç bir manual müdaxiləsiz keçir. |
| 5.2 | **Load test:** 50 eyni vaxtlı photo upload → R2 + AI worker + DB → p95 < 3s, 5xx < 0.1%. | `k6` skripti, GitHub Actions-da hər gecə. |
| 5.3 | **OPERATIONAL_GUIDE_AZ.md** yeniləməsi: hər mərhələ üçün operator addımları (token rotation, model dəyişməsi, rate-limit artırmaq). | Operator heç bir addımı soruşmadan edə bilər. |
| 5.4 | **Təqdimat:** 10 dəqiqə demo video + 1 səhifə executive summary. | bahaI stakeholder-a göstərir. |

---

## 4. Texniki borclar və əvvəlcədən qarşısını almaq

| Borc | Hal-hazırkı vəziyyət | Planlaşdırılan həll |
|------|----------------------|---------------------|
| `mobile/package.json: dependencies: {}` | Expo config, native modules yoxdur | Mərhələ 3.1-də `expo`, `expo-camera`, `expo-location`, `expo-secure-store`, `expo-router` quraşdırılır |
| `yolov8n.pt` — generic COCO | SKU tanıma yoxdur | Mərhələ 4.3-də ROI crop + Vision LLM iləbərtərəf edirik (fine-tune yox) |
| `/api/panel/*` → `oneteam-user:` token qəbul | Panel açarı yaradıldıqda belə də qabuledilir | Mərhələ 1.1-də həll |
| Bot state-machine yoxdur | `text` command + switch | Mərhələ 2.1-də inline keyboard |
| OpenRouter env yoxdur | `OPENROUTER_API_KEY` Railway-da yoxdur | Mərhələ 4.1-dən əvvəl qoyulmalıdır |
| iOS Xcode scheme / signing yoxdur | `mobile/` altında `.xcodeproj` yoxdur | `expo prebuild` yaradacaq |
| `pnpm-workspace.yaml` var, amma `node_modules`ומת `npm`-də | Lockfile mismatch (`npm install --dry-run` → 304 removed) | Mərhələ 0: `pnpm install --frozen-lockfile` və ya `package-lock.json` bərpa |

---

## 5. Qəbul meyarı cədvəli (Definition of Done — hər mərhələ üçün)

| Mərhələ | Automated check | Manual check | Operator sign-off |
|--------|------------------|--------------|-------------------|
| 1 | `npm test` (unit + e2e panel) → green | Panelə gir → mağaza yarat → tapşırıq yarad → Claim et | ✅ |
| 2 | Bot unit test (state machine) → green | Botdan 3 mağaza, 5 tapşırıq icra et | ✅ |
| 3 | `xcodebuild test` CI → green | Real iPhone-da Login → Enroll → Photo → Submit | ✅ |
| 4 | 100 test şəkli → AI worker → JSON valid + `fallback` rate < 5% | 10 şəkil → paneldə score + anomaliya görünür | ✅ |
| 5 | `k6` load test nightly → green | Demo video + executive summary | ✅ |

---

## 6. Müddət və resurslar

| Rol | Həftə 1–2 | Həftə 3 | Həftə 4–5 | Həftə 6–7 | Həftə 8 |
|-----|-----------|---------|-----------|-----------|--------|
| **Sən (bahaI — operator)** | Railway env, token, DPA imza | BotFather menyu təsdiq | TestFlight / real cihaz | OpenRouter key, rate-limit artırmaq | Demo izlə, imzala |
| **Mən (Agent — kod)** | Panel CRUD, auth, roles | Bot inline keyboard, session | Expo prebuild, native, Xcode CI | OpenRouter client, YOLO worker, queue | Load test, doc, video |

**Toplam Agent-kod müddəti:** ~18–20 iş günü (8 həftə, həftədə 2–3 gün effektiv kod).

---

## 7. Növbəti addım — sizin təsdiqiniz

Bu planı oxuyun. **Hər hansı bir sətiri dəyişdirmək istəyirsinizsə** (məs. mağaza yaradılmasında bot da olsun, və ya SKU modeli train etmək istəyirsiniz) — indi deyin, düzəldək.

**Təsdiq verdikdə** Mərhələ 1.1-dən başlayaraq kodlamağa başlayaq. Hər mərhələ bitdikdə `git commit` + `railway deploy` + canlı yoxlama edəcəyik.

---
_Plan versiyası: 0.1 — 14 sentyabr 2026 — Təsdiq gözləyir_