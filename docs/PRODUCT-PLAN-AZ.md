# oneTeam — Məhsul və Texniki Plan (AZ)

> **Status: TƏSDİQLƏNİB və İCRADADIR.** İstifadəçi "başlayaq" dedi.
> İcra vəziyyəti hər iş paketinin yanındaki **Vəziyyət** sütunundadır.

---

## 1. Mövcud vəziyyət — qısaca

| Sahə                          | Hazırdır                                                                        | Boşluq                                                                                  | Risk                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **API (NestJS)**              | Mağaza CRUD, tapşırıq axını, çeklist, geofence, audit, foto (R2), status maşını | Admin panel uç nöqtələri (`/api/panel/*`) sadədir (yalnız `me`, `keys`, `logout`)       | ~~`oneteam-user:` kredensialı `/api/panel/*` girişində qəbul olunurdu~~ — **bağlandı** (1.1) |
| **Telegram Bot**              | Polling, location + checklist, enrolment, photo                                 | Menyular sadə `text`-dir, inline keyboard yoxdur, state idempotent deyil                | Yeni mağaza yaratma, tapşırıq təyinatı botdan yoxdur                                         |
| **Web Panel (React)**         | Giriş (şəxsi açar), mağaza siyahısı + CRUD, tapşırıq detalları, şəkil upload    | Tapşırıq **yaratma/redaktə** UI tam deyil; rol idarəetməsi yoxdur                       | Supervayzer rolları yalnız `mayUseRoute`-da yoxlanılır                                       |
| **Mobil (React Native/Expo)** | `LoginScreen`, `portalApi`, headless controller qatı                            | **Native kamera yoxdur**, qalıcı saxlanc yoxdur, Expo config yoxdur, Xcode testi yoxdur | Hər açılışda yenidən enrolment lazımdır                                                      |
| **AI / YOLO**                 | `yolov8n.pt` faylı mövcuddur, `test:ai` skripti işləyir                         | **Heç bir SKU/planogram modeli yoxdur** (yalnız COCO), OpenRouter inteqrasiyası yoxdur  | Pulsuz model rate-limit, məxfilik, fallback dəyəri yoxdur                                    |

**Təsdiqlənmiş canlı işlər:**

- Bot tokeni dəyişdirildi ✅
- Panel açarı yaradıldı (`liveKeys=1`) ✅
- Enrolment secret qoyuldu ✅
- Cloudflare R2 şəkil saxlancı aktivdir ✅
- Panel API-si servis kredensialına bağlandı ✅ (1.1)
- Mağaza CRUD (yarat / redaktə et / sil) ✅ (1.3)

---

## 2. Arxitektura qərarı (TƏSDİQLƏNİB)

| Sual                                   | Qərar                                                                                                                                                        | Niyə                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| **Mağaza kim yaradır?**                | **Web panel** (supervayzer). Bot və mobil **yalnız tapşırıq icra edir**.                                                                                     | Mağaza kodu, geofence radiusu, ünvan, rəf quruluşu — bunlar səhv olsa etibarsız olur.         |
| **Tapşırıq kim yaradır / kimə verir?** | **Web panel** yaradır → konkret **mağaza + konkret istifadəçi (deviceId/chatId)**. Mobil/Bot **yalnız icra edir**.                                           | Birlikdə başlayan tapşırıqlarla qarışıqlıq yaranmır.                                          |
| **Telegram menyusu necə olsun?**       | **Inline keyboard** (state-machine: `main → store → task → checklist → photo → confirm`). Hər basılma **idempotent**.                                        | Sadə `text` komandalar səs-küyə çevrilir; inline peşəkar keyfiyyətdir.                        |
| **iOS necə test edəcəyik?**            | `expo prebuild` → Xcode-də **Development Build** → simulyator və ya real cihaz. `mobile/dependencies: {}` olduğu üçün **Expo SDK 52+** ilə başlamaq.         | `eject`/`bare` workflow mürəkkəbdir; prebuild + EAS Build / `xcodebuild` uyğundur.            |
| **AI necə işləyəcək?**                 | **Hibrid:** YOLOv8 (COCO) → region extraction → OpenRouter **pulsuz vision model** → JSON planogram skoru + anomaliya. **Heç bir SKU modeli train etmirik**. | SKU modeli 5000+ şəkil və 2–3 ay tələb edir. OpenRouter pulsuz variant pilot üçün kifayətdir. |
| **OpenRouter model?**                  | `google/gemma-3n-e4b-it:free` (image, 4B, 128k ctx) **və ya** `meta-llama/llama-3.2-11b-vision-instruct:free` (image, 11B). Rate limit: 20 RPM / 1000 RPD.   | İki variantı test edib biri seçiləcək; ikisi də pulsuz, image input, JSON output verir.       |

---

## 3. Mərhələli icra planı (8 həftə, 5 mərhələ)

### MƏRHƏLƏ 1 — Əsas boşluqlar və təhlükəsizlik (Həftə 1–2)

| #   | İş paketi                                                                                                                                                                                                                                                                                    | Qəbul meyarı                                                                                  | Müddət  | Vəziyyət               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------- | ---------------------- |
| 1.1 | **Panel təhlükəsizliyi:** `/api/panel/*` üçün `mayUseRoute` yoxlamasını `/api/portal/` şərtindən azad et, `oneteam-user:` tokenini paneldə rədd et.                                                                                                                                          | `curl -H "Authorization: Bearer oneteam-user:usr-admin-001" /api/panel/me` → 403              | 0.5 gün | ✅ `29aa4d3`           |
| 1.2 | **Logout sonuncu açarı silə bilməsin** — _premisa yoxlanıldı və yanlış çıxdı_: heç bir administrativ ləğv yolu paneli boşalda bilmir (`CANNOT_REVOKE_OWN_SESSION`, `CANNOT_REVOKE_OWN_KEYS`). Əvəzində **əsl** problem tapıldı: `logout` sonuncu açarı ləğv edəndə panel yenidən **açılır**. | Qərar gözləyir — §8-ə bax                                                                     | 0.5 gün | ⚠️ qərar               |
| 1.3 | **Mağaza CRUD (Web):** yarat / redaktə et / sil + React forması.                                                                                                                                                                                                                             | Yeni mağaza yaradılır → siyahıda görünür → kod unikal → silinə bilir                          | 1.5 gün | ✅ `e17941e`,`8302945` |
| 1.4 | **Tapşırıq CRUD (Web):** mağaza, başlıq, növ (`CHECKLIST`, `PHOTO`, `AUDIT`), planlı tarix, müddət, çeklist sxemi (JSON). Ələ keçirmə yalnız sahibinə.                                                                                                                                       | Tapşırıq yaradılır → ələ keçirilir → mobil/botda görünür → başqa istifadəçi ələ keçirə bilmir | 1.5 gün | ✅ `31bc886` \*        |
| 1.5 | **İstifadəçi rolları:** `SUPERVISOR` (mağaza/tapşırıq yaradır), `MERCHANDISER` (icra edir), `ADMIN` (açarlar, rollar). `mayActAsAnotherUser` yoxlamasını `SUPERVISOR`-a genişləndir.                                                                                                         | Supervayzer yaradanda `SUPERVISOR` roluna düşür → ələ keçirir; ADMIN panelə girir             | 1 gün   | ⏳                     |

**Mərhələ 1 nəticəsi:** Web panel **tam idarəetmə mərkəzi** olur; təhlükəsizlik boşluqları bağlanır.

**\* 1.4 qeydi — bir addım hələ açıqdır.** Kod yazıldı, yerli suite yaşıl (**69/0/0**), commit
`31bc886` deploy olundu və yeni endpoint-lərin canlıda **həqiqətən mövcud olduğu** sübut edildi
(`PATCH /api/portal/tasks/:id` → **401**, mövcud olmayan oxşar yol → **404**). Amma **create / redaktə /
sil real məlumatla canlı yoxlanılmadı**, çünki panel tam kilidlidir (`required: true`, `liveKeys: 1`) və
yoxlama üçün panel açarı lazımdır. Servis və cihaz kredensialları bu yollarda qəbul olunmur.
Bu, layihənin öz qaydasıdır: **mağaza funksiyası da lokal suite-i keçmişdi, real buqu isə yalnız ilk
canlı create tutdu.** Yoxlama tamamlanana qədər 1.4-ü bağlanmış saymaq olmaz.

**Həmçinin 1.4-də aydınlaşdı:** plandaki `CHECKLIST` / `PHOTO` / `AUDIT` **saxlanan sütun deyil** —
`task_type` sütunu yoxdur. Növlər mövcud sahələrdən **törədilir** (`deriveTaskKind`), yəni etiket
məlumatdan sürüşə bilməz. Plan mətnini buna uyğun oxumaq lazımdır.

---

### MƏRHƏLƏ 2 — Telegram bot peşəkar menyu (Həftə 3)

| #   | İş paketi                                                                                                                                                      | Qəbul meyarı                                                                   | Müddət  | Vəziyyət |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------- | -------- |
| 2.1 | **Inline keyboard state machine:** `main → store-list → task-list → checklist → photo → confirm → done`. Hər düymə `callback_data` ilə `action:id` formatında. | Basılma dublikat heç bir səhv yaratmır (idempotent).                           | 1.5 gün | ⏳       |
| 2.2 | **Bot session store (Redis / in-memory TTL):** `chatId → {step, storeId, taskId, checklistAnswers[]}`. 15 dəq TTL, yenilənmə.                                  | Yenidən başlatma ilə state itmir; `chatId` yenidən yazanda əvvəlki davam edir. | 1 gün   | ⏳       |
| 2.3 | **Notification:** tapşırıq yaradılması / vaxt bitməsi / rədd 15 dəq əvvəl → `sendMessage` + inline `Open` düyməsi.                                             | Supervayzer panelində yaradanda bot bildiriş alır.                             | 0.5 gün | ⏳       |
| 2.4 | **Fallback (text):** `/start`, `/help`, `/mystatus` — inline olmadıqda işləsin.                                                                                | `/help` → menyu göstərir.                                                      | 0.5 gün | ⏳       |

**Mərhələ 2 nəticəsi:** Bot **peşəkar, rahat** interfeys; sahə işçisi heç bir `/komanda` yazmır.

---

### MƏRHƏLƏ 3 — iOS tətbiqi (Expo prebuild + Xcode) (Həftə 4–5)

| #   | İş paketi                                                                                                                                                                                               | Qəbul meyarı                                                                                        | Müddət  | Vəziyyət |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------- | -------- |
| 3.1 | **Expo config:** `app.json` / `app.config.ts` — `bundleIdentifier`, `name`, `icon`, `splash`, `ios: {supportsTablet: false}`, `plugins: ["expo-camera", "expo-location", "expo-secure-store"]`.         | `npx expo prebuild --platform ios` → `ios/` qovluğu yaranır, heç bir xəta yoxdur.                   | 1 gün   | ⏳       |
| 3.2 | **Native camera + secure storage:** `expo-camera` → icazə izahı; `expo-secure-store` → `deviceToken`, `enrollmentSecret` yaz/oxu. Silinmədə `deviceToken` qalır.                                        | Kamera açılır → şəkil çəkilir → base64 API-yə gedir. Yenidən açılışda enrolment **avtomatik** olur. | 1.5 gün | ⏳       |
| 3.3 | **Offline queue (AsyncStorage):** şəkil + metadata lokal növbəyə → onlayn olanda göndərilir. 50 MB limit, avtomatik təkrar cəhd.                                                                        | Avia-rejimdə 3 şəkil çək → onlayn ol → 3 upload (sıralı).                                           | 1 gün   | ⏳       |
| 3.4 | **Xcode test:** `xcodebuild -workspace oneTeam.xcworkspace -scheme oneTeam -destination 'platform=iOS Simulator,name=iPhone 16' build test` → **UI testləri** (Login → Enroll → Task → Photo → Submit). | CI (GitHub Actions) hər PR-da `xcodebuild test` keçir.                                              | 1 gün   | ⏳       |
| 3.5 | **Mövcud React Native UI saxlanılır:** `mobile/src/screens/*` faylları **yenidən yazılmadan** `expo-router` / `React Navigation` ilə quraşdırılır. Dizayn dəyişmir.                                     | Mövcud ekranlar (Login, TaskList, TaskDetail, Checklist, Camera) birebir görünür.                   | 1 gün   | ⏳       |

**Mərhələ 3 nəticəsi:** Real iPhone-da / Simulyatorda **yaddaşda saxlanılan açarla**, kamerası və offline queue ilə işləyən tətbiq.

---

### MƏRHƏLƏ 4 — YOLO + OpenRouter AI hibrid (Həftə 6–7)

| #   | İş paketi                                                                                                                                                                                               | Qəbul meyarı                                                                                           | Müddət  | Vəziyyət |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------- | -------- |
| 4.1 | **OpenRouter client:** `packages/ai/openrouter.ts` — `fetch` + `Authorization: Bearer ${OPENROUTER_KEY}`, `HTTP-Referer`, `X-Title`. Rate-limit: token bucket (20 RPM / 1000 RPD), exponential backoff. | 100 paralel sorğu → heç biri 429 qaytarmır; 429 gələndə 60 saniyə gözləyir.                            | 1 gün   | ⏳       |
| 4.2 | **Vision prompt template:** JSON schema (`zod`) — `planogramScore(0-100)`, `missingSKUs[]`, `extraItems[]`, `anomalies[]`, `confidence(0-1)`. Prompt: "Sən Coca-Cola rəf auditçisisən. JSON qaytar."    | Schema validasiyası uğurlu; JSON parse xətası < 0.1%.                                                  | 1 gün   | ⏳       |
| 4.3 | **YOLO pre-filter:** `yolov8n.pt` (COCO) → `bottle`, `cup`, `wine glass` klassları → bounding box → crop → base64 → OpenRouter. Yalnız **ROI** göndərilir → token xərci ~70% azalır.                    | 100 test şəkli → ortalama 1.2s / şəkil; token < 1500/sorğu.                                            | 1 gün   | ⏳       |
| 4.4 | **Worker pipeline:** `apps/api/src/workers/ai-worker.ts` — BullMQ queue (`ai:analyze`), concurrency 2, retry 3, dead-letter. Giriş: `evidenceId`, Çıxış: `aiResult` (JSON) + `planogramScore` yazılır.  | 50 evidence yaradılır → queue dolar → worker bitirir → `/api/portal/evidence/:id` `aiResult` göstərir. | 1.5 gün | ⏳       |
| 4.5 | **Fallback və dürüstlük:** Model 429 / 5xx / timeout → `aiResult: {fallback: true, reason, yoloOnlyScore}`; **heç vaxt "yumşaldılmış" nəticə yazılmır**.                                                | Rate-limit halında `fallback: true` gəlir; supervayzer "AI yoxlanmadı" görür.                          | 0.5 gün | ⏳       |
| 4.6 | **Məxfilik / Data Processing Addendum:** OpenRouter-a göndərilən şəkillər **heç bir şəkildə** model təliminə istifadə edilmir (OpenRouter Terms §3.2). `X-OpenRouter-User-Id` göndərilmir.              | Sənəddə qeyd edilir; operator imzalayır.                                                               | 0.5 gün | ⏳       |

**Mərhələ 4 nəticəsi:** Hər yüklənən audit şəkli **avtomatik** YOLO + Vision LLM ilə qiymətləndirilir, skor və anomaliya paneldə görünür.

---

### MƏRHƏLƏ 5 — İnteqrasiya testi, sənədləşmə, təqdimat (Həftə 8)

| #   | İş paketi                                                                                                                                                                | Qəbul meyarı                                                               | Vəziyyət |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | -------- |
| 5.1 | **End-to-end:** Web mağaza yarat → tapşırıq yarat → bot bildirişi al → mobil ələ keçir → çeklist doldur → foto çək → AI skoru al → panelə bax → skoru təsdiqlə / düzəlt. | 1 tam dövr (5 mağaza, 3 istifadəçi) heç bir manual müdaxilə olmadan keçir. | ⏳       |
| 5.2 | **Load test:** 50 eyni vaxtlı foto upload → R2 + AI worker + DB → p95 < 3s, 5xx < 0.1%.                                                                                  | `k6` skripti, GitHub Actions-da hər gecə.                                  | ⏳       |
| 5.3 | **OPERATIONAL_GUIDE_AZ.md** yenilənməsi: hər mərhələ üçün operator addımları (token rotasiyası, model dəyişməsi, rate-limit artırma).                                    | Operator heç bir addımı soruşmadan edə bilər.                              | ⏳       |
| 5.4 | **Təqdimat:** 10 dəqiqəlik demo video + 1 səhifəlik executive summary.                                                                                                   | bahaI maraqlı tərəflərə göstərir.                                          | ⏳       |

---

## 4. Texniki borclar

| Borc                                                       | Hal-hazırkı vəziyyət                                          | Planlaşdırılan həll                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `mobile/package.json: dependencies: {}`                    | Expo config və native modullar yoxdur                         | Mərhələ 3.1-də `expo`, `expo-camera`, `expo-location`, `expo-secure-store`, `expo-router` quraşdırılır |
| `yolov8n.pt` — generic COCO                                | SKU tanıma yoxdur                                             | Mərhələ 4.3-də ROI crop + Vision LLM ilə kompensasiya edilir (fine-tune yox)                           |
| ~~`/api/panel/*` → `oneteam-user:` token qəbul edirdi~~    | Panel açarı yaradıldıqda belə qəbul edilirdi                  | **Həll olundu** (1.1, `29aa4d3`)                                                                       |
| Bot state-machine yoxdur                                   | `text` command + switch                                       | Mərhələ 2.1-də inline keyboard                                                                         |
| OpenRouter env yoxdur                                      | `OPENROUTER_API_KEY` Railway-da yoxdur                        | Mərhələ 4.1-dən əvvəl qoyulmalıdır                                                                     |
| iOS Xcode scheme / signing yoxdur                          | `mobile/` altında `.xcodeproj` yoxdur                         | `expo prebuild` yaradacaq                                                                              |
| `pnpm-workspace.yaml` var, amma `node_modules` `npm`-dədir | Lockfile uyğunsuzluğu (`npm install --dry-run` → 304 silinir) | `pnpm install --frozen-lockfile` və ya `package-lock.json` bərpası                                     |
| Geofence radiusu mağaza üzrə deyil                         | `GEOFENCE_MAX_DISTANCE_METERS` sabiti (`packages/types`)      | Mərhələ 3-də mağaza üzrə sütun + mobil tərəfin uyğunlaşdırılması                                       |

---

## 5. Qəbul meyarı cədvəli (Definition of Done — hər mərhələ üçün)

| Mərhələ | Avtomatik yoxlama                                              | Manual yoxlama                                         | Operator təsdiqi |
| ------- | -------------------------------------------------------------- | ------------------------------------------------------ | ---------------- |
| 1       | `npm run test:all` + `test:live` → green                       | Panelə gir → mağaza yarat → tapşırıq yarat → ələ keçir | ✅ (1.1, 1.3)    |
| 2       | Bot unit test (state machine) → green                          | Botdan 3 mağaza, 5 tapşırıq icra et                    | ⏳               |
| 3       | `xcodebuild test` CI → green                                   | Real iPhone-da Login → Enroll → Photo → Submit         | ⏳               |
| 4       | 100 test şəkli → AI worker → JSON valid + `fallback` rate < 5% | 10 şəkil → paneldə skor + anomaliya görünür            | ⏳               |
| 5       | `k6` load test nightly → green                                 | Demo video + executive summary                         | ⏳               |

---

## 6. Müddət və resurslar

| Rol                        | Həftə 1–2                    | Həftə 3                      | Həftə 4–5                       | Həftə 6–7                             | Həftə 8                |
| -------------------------- | ---------------------------- | ---------------------------- | ------------------------------- | ------------------------------------- | ---------------------- |
| **Sən (bahaI — operator)** | Railway env, token, DPA imza | BotFather menyu təsdiqi      | TestFlight / real cihaz         | OpenRouter key, rate-limit artırma    | Demo izlə, imzala      |
| **Mən (Agent — kod)**      | Panel CRUD, auth, rollar     | Bot inline keyboard, session | Expo prebuild, native, Xcode CI | OpenRouter client, YOLO worker, queue | Load test, sənəd, demo |

**Toplam Agent-kod müddəti:** ~18–20 iş günü (8 həftə, həftədə 2–3 gün effektiv kod).

---

## 7. İcra qaydası

Hər mərhələ bitdikdə: `git commit` → `git push` → `railway deploy` → **canlıda yoxlama**.
Yaşıl test sübut deyil — **detektoru pozmaqla** yoxlanılır: düzəliş geri qaytarılır,
gözlənilən assertion-un qırmızı olduğu görülür, sonra bərpa edilir.

---

## 8. Açıq qərar gözləyən məsələ — logout paneli yenidən açır

`POST /api/panel/logout` tək açarı olan istifadəçi üçün paneli **sıfır açara** salır.
Onda `required` yenidən `false` olur və panel URL-i bilən hər kəsə **açılır** — yəni
"Çıxış" düyməsi giriş qorumasını söndürür. Test bunu təsdiqləyir
(_"with no keys left, the panel is open again"_).

**İki yol:**

| Variant                                      | Nə edir                                                                                                            | Riski                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| **(a) Xəbərdarlıq + audit**                  | Panel sıfıra düşəndə istifadəçiyə xəbərdarlıq göstərilir və `PANEL_OPENED` audit qeydi yazılır. Davranış dəyişmir. | Yalnız görünürlük artır; problem qalır.                                                                      |
| **(b) "Bir dəfə quruldu, həmişə quruludur"** | `required` yalnız canlı açarlardan asılı olmur; bir dəfə qurulandan sonra həmişə `true` qalır.                     | Davranış dəyişir — bərpa yolu (`ONETEAM_PANEL_BOOTSTRAP_KEY`) qoyulmayıbsa panel birdəfəlik kilidlənə bilər. |

**Qərar tələb olunur.**

---

_Plan versiyası: 0.2 — 15 sentyabr 2026 — TƏSDİQLƏNİB, icra davam edir._
