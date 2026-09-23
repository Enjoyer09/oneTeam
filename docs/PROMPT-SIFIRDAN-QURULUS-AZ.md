# oneTeam — layihəni SIFIRDAN qurmaq üçün tam təlimat

> Bu sənəd bir AI agentə (və ya yeni bir komandaya) verilir ki, **oneTeam** platformasını
> heç nədən — boş bir qovluqdan — qura bilsin. Üç kanal tam təsvir olunur:
> **Telegram botu**, **iOS mobil tətbiqi**, **veb panel**.
> Dil: Azərbaycan. Bütün istifadəçiyə görünən mətnlər Azərbaycan dilində olmalıdır.

---

## 1. MƏHSUL NƏDİR

**oneTeam** — FMCG (Coca-Cola distribusiyası) üçün **rəf monitorinqi və planogram
uyğunluğu** platforması. İş axını belədir:

1. **Supervayzer** (ofisdə, veb paneldə) mağazalara tapşırıq yaradır: "Bu rəfi belə
   düz, şəklini çək, göndər".
2. **Sahə işçisi / merchandiser** (mağazada, telefonla və ya Telegram-la) tapşırığı
   açır, rəfin **canlı fotosunu** çəkir, çeklisti doldurur, göndərir.
3. **Supervayzer** veb paneldə şəklə baxır və **təsdiq edir** və ya **rədd edir**
   (rədd edəndə yazılı təlimat yazır).

Əsas dəyər təklifi: sübutun **doğruluğu**. Şəkilin həqiqətən həmin mağazada, həmin
anda, canlı kamerayla çəkildiyini sübut etmək. Ona görə platformada saxtakarlığa
qarşı mexanizmlər (geofence, canlı kamera məcburiyyəti, metadata) məhsulun özəyidir.

**Coğrafiya:** Azərbaycan, Bakı. Mağaza şəbəkələri: Bravo, Araz, Bazarstore, Rahat.

---

## 2. ÜÇ KANAL VƏ ROLLARI

| Kanal | Kim istifadə edir | Nə edir |
|---|---|---|
| **Veb panel** (`web/`) | Supervayzer, Admin | Mağaza/tapşırıq yaratmaq, auditlərə baxıb təsdiq/rədd etmək, istifadəçi və açar idarəsi |
| **iOS mobil** (`mobile/`) | Sahə merchandiser | Mağaza kodla giriş, tapşırıq siyahısı, çeklist, **canlı kamera ilə rəf auditi**, barkod skanı |
| **Telegram bot** (`src/bot/`) | Sahə işçisi (əsas kanal) | Eyni işi chat içində: tapşırığı aç, şəkil göndər, çeklisti cavabla |

**Ən vacib qayda:** üç kanalın heç biri birbaşa verilənlər bazası ilə danışmır.
**Tək həqiqət mənbəyi Core API-dir** (`apps/api`, NestJS). Hər üç kanal yalnız API-yə
HTTP sorğu göndərir. Bot da, panel də, mobil tətbiq də eyni endpoint-ləri çağırır.

---

## 3. VERİLƏNLƏR BAZASI (Prisma, PostgreSQL)

Sxema: `packages/database/prisma/schema.prisma`. Sütun adları `snake_case`-dir
(Prisma `@map` ilə). Cədvəllər:

### `users`
`id` (uuid), `email` (unique), `full_name`, `role` (enum), `telegram_chat_id` (unique,
nullable), `phone`, `created_at`, `updated_at`

### `regions`
`id`, `name`, `code` (unique), zaman damğaları

### `stores`
`id`, `store_code` (unique), `name`, `region_id` (FK), `chain_name` (default `Bravo`),
`store_format` (default `supermarket`), `address`, `city` (default `Baku`),
`latitude` (Float), `longitude` (Float), `is_active`

> **Koordinatlar məcburidir.** Geofence iki real mövqe olmadan işləyə bilməz.

### `campaigns`
`id`, `name`, `description`, `start_date`, `end_date`, `is_active`

### `task_templates` (şablon — mağazaya görə DEYİL)
`id`, `campaign_id` (nullable FK), `title`, `description`, `reference_image_url`,
`priority` (enum), `planogram_rules` (Json), `requires_before_after_photo` (bool),
`checklist_schema` (Json)

### `store_tasks` (şablonun bir mağazaya təyinatı)
`id`, `template_id` (FK), `store_id` (FK), `assigned_user_id` (nullable FK),
`status` (enum `TaskState`, default `DRAFT`), `deadline`,
`published_at`, `delivered_at`, `acknowledged_at`, `submitted_at`, `reviewed_at`

> **Diqqət:** tapşırıq **iki cədvəldə** yaşayır. Məzmun (başlıq, çeklist, planogram)
> `task_templates`-də; **deadline və təyinat isə `store_tasks`-də**, yəni mağaza üzrə.
> Bir şablonu redaktə etmək hər mağazaya təsir edir; bir mağazanın deadline-ını
> dəyişmək yalnız ona təsir edir. **`task_type` adlı sütun yoxdur.**

### `task_evidences` (göndərilən sübut)
`id`, `store_task_id` (FK, Cascade), `submitted_by_id` (FK), `photo_url`, `photo_type`,
`checklist_answers` (Json), `latitude`, `longitude`, `gps_distance_meters`,
`ai_score`, `ai_detections` (Json), `ai_summary`, `reviewer_feedback`, `submitted_at`

### `audit_logs`
`id`, `entity_type`, `entity_id`, `action`, `from_state`, `to_state`, `actor_id`,
`payload` (Json), `created_at`

### Enum-lar
- `UserRole`: `ADMIN`, `SUPERVISOR`, `MERCHANDISER`, `STORE_STAFF`
- `TaskPriority`: `LOW`, `MEDIUM`, `HIGH`, `URGENT`
- `TaskState`: `DRAFT`, `PUBLISHED`, `DELIVERED`, `ACKNOWLEDGED`, `IN_PROGRESS`,
  `SUBMITTED`, `APPROVED`, `REJECTED`

---

## 4. TAPŞIRIQ HAZIRKİ VƏZİYYƏT MAŞINI (məcburi)

`packages/types/src/state-machine.ts`. **Yalnız bu keçidlərə icazə var**, qalanları
HTTP 400 ilə rədd edilir:

```
DRAFT        -> PUBLISHED
PUBLISHED    -> DELIVERED
DELIVERED    -> ACKNOWLEDGED
ACKNOWLEDGED -> IN_PROGRESS
IN_PROGRESS  -> SUBMITTED
SUBMITTED    -> APPROVED | REJECTED
APPROVED     -> (terminal, heç nəyə)
REJECTED     -> IN_PROGRESS     (supervayzer yenidən audit tələb edə bilər)
```

İmtina olunmuş tapşırıqdan yenidən göndərmək olar. Bu, "dövrü bağlamaq" üçün
vacibdir: sahə işçisi düzəliş edib yenidən çəkir.

---

## 5. AUTENTİFİKASİYA — ÜÇ KREDENSİAL

Hər sorğu `Authorization: Bearer <token>` daşıyır. Üç növ var:

| Token | Format | Kim daşıyır | Səlahiyyət |
|---|---|---|---|
| **service** | `oneteam-user:<user_id>` | Server (Telegram botu) | **Başqa istifadəçi adından danışa bilər** — hansı istifadəçini göstərirsə |
| **device** | `otd_<43 simvol>` | Bir mobil qurğu | Yalnız öz istifadəçisi |
| **panel** | `otp_<43 simvol>` | Bir insan, brauzerdə | Yalnız öz istifadəçisi |

API hər sorğuda `AuthenticatedPrincipal` yaradır:
`{ userId, role, telegramChatId?, via: 'service'|'device'|'panel', deviceId? }`

**Kritik qayda:** yalnız `via === 'service'` olan kredensial başqa istifadəçi adından
danışa bilər. `device` və `panel` bunu edə bilməz — cəhd etsə 403 alır.

### Üç qapı (hamısı serverdə)
1. **`mayUseRoute`** — hansı kredensial hansı yola daxil ola bilər. Məsələn, panel
   açarı sahə (field) yollarına girə bilməz.
2. **`canUserAccessTask`** — istifadəçi bu tapşırığa daxil ola bilərmi.
3. **`require*Editor`** — yazma hüququ (mağaza/tapşırıq redaktəsi admin+supervayzer).

### Panel girişi
Panel ilk dəfə **açıqdır** (heç bir açar yoxdursa giriş tələb olunmur) və bu ekranda
açıq şəkildə yazılır. İlk açar `ONETEAM_PANEL_BOOTSTRAP_KEY` ilə yaradılır.
**Bu açar daimi kredensialdır — `.env` faylına yazılmaz.**

### Mobil cihaz qeydiyyatı (enroll)
Mobil tətbiq ilk açılışda mağaza kodu + qeydiyyat sirri ilə özünü tanıdır və
`otd_` token alır. **Qeydiyyat sirri paketə yazıla bilməz** (Metro yalnız
`EXPO_PUBLIC_*` dəyişənlərini göndərir) — ona görə ekranda sahə var, token isə
keychain-də saxlanır.

### Telegram
Bot kanalı **sirrsiz işləyir**: mağaza kodunu bilən hər kəs həmin mağazanın açıq
tapşırığını götürə bilər. Bu, məlum və qəbul edilmiş bir zəiflikdir.

---

## 6. API ENDPOINT-LƏRİ (NestJS, `apps/api/src`)

Baza prefiksi: `/api`. Modullar: `portal`, `tasks`, `evidences`, `storage`,
`notifications`, `health`.

### Sağlamlıq
- `GET /api/health` → `{ status, persistence, ... }`. `persistence` sahəsi deyir ki,
  API həqiqətən Postgres-ə yazır, yoxsa yaddaşa düşüb.

### Panel (supervayzer/admin) — `/api/portal`
- `GET /api/portal/bootstrap`
- `GET|POST /api/portal/stores`, `PATCH|DELETE /api/portal/stores/:id`
- `GET /api/portal/tasks`, `POST /api/portal/tasks`, `PATCH|DELETE /api/portal/tasks/:id`
- `GET /api/portal/submissions`
- `POST /api/portal/submissions/:id/review` (təsdiq/rədd)
- `POST /api/portal/submissions/:id/auto-approve`
- `GET /api/portal/metrics`

### Panel autentifikasiyası və idarəsi — `/api/panel`
- `GET /api/panel/auth-status`, `GET /api/panel/me`, `POST /api/panel/logout`
- `GET|POST /api/panel/keys`, `POST /api/panel/keys/:prefix/revoke`
- `POST /api/panel/users/:userId/revoke-keys`
- `GET /api/panel/devices`, `POST /api/panel/devices/:deviceId/revoke`
- `GET|POST /api/panel/users`, `PATCH|DELETE /api/panel/users/:userId`

### Sahə (mobil + bot) — `/api/portal/field`
- `GET /api/portal/field/store` · `GET /api/portal/field/store-lookup`
- `GET /api/portal/field/whoami` · `GET /api/portal/field/session`
- `POST /api/portal/field/bind` (Telegram çatını bağla)
- `POST /api/portal/field/enroll` (mobil cihaz qeydiyyatı)
- `GET|PUT|DELETE /api/portal/field/flow` (botun çoxaddımlı axını)
- `GET /api/portal/field/tasks`, `GET /api/portal/field/tasks/:id`
- `POST /api/portal/field/tasks/:id/acknowledge`
- `GET|POST /api/portal/field/submissions`
- `POST /api/portal/field/photos` (şəkil yükləmə)
- `GET /api/portal/field/notifications`
- `POST /api/portal/field/notifications/:id/delivered|failed`

### Tapşırıqlar — `/api/tasks`
- `GET /api/tasks`, `GET /api/tasks/:id`, `POST /api/tasks/:id/transition`
- `POST /api/tasks/bulk-dispatch` (bir şablonu çoxlu mağazaya göndər)

### Sübutlar — `/api/evidences`
- `GET /api/evidences`, `POST /api/evidences`

### Veb-kanca
- `POST /api/webhooks/telegram`

**Sübut metadata-sı:** `POST .../submissions` açıq `Record<string, unknown>` qəbul
edir və onu audit loguna yazır (`action: 'EVIDENCE_CHANNEL_METADATA'`). Yəni mobil
tətbiq yeni metadata sahəsi əlavə etmək istəsə, **serveri dəyişmək lazım deyil**.

---

## 7. DOMEN İNVARİANTLARI (POZULMAMALIDIR)

1. **Geofence: 100 metr.** Sahə işçisi mağazadan 100 m-dən uzaqdadırsa, giriş və
   audit **rədd edilir**. Haversine ilə hesaplanır. Bu, **serverdə də** tətbiq olunur —
   onu yalnız mobil tərəfdə yumşaltmaq mümkün deyil və edilməməlidir.
2. **Yalnız canlı kamera.** Qalereyadan köhnə şəkil seçmək qadağandır. Kamera
   bayt qaytarmasa, şəkil uydurulmur — işçiyə "yenidən çəkin" deyilir.
3. **Sübut bütövlüyü.** Hər auditə yazılır: mövqe, vaxt, cihaz, canlı kamera
   göstəricisi (`capture_mode`), ghost overlay-in həqiqətən göstərilib-göstərilmədiyi,
   barkodlar, şəkil keyfiyyəti. **Heç bir sahə "təxmin edilə" bilməz** — məsələn
   cihaz modeli oxunmadısa `"unknown"` yazılır, `"iPhone 15 Pro"` yox.
4. **Yazı sırası.** Xarici açarı olan hər yazı gözlənilməlidir (await). Bəzi
   əməliyyatlar (ləğvetmə, sübut yaratma) atıb-qaytarıla bilər.
5. **Asılılıqlı silmə RESTRICT-dir.** Sübutu olan tapşırığı, tapşırığı olan mağazanı
   silmək olmaz → `409 STORE_HAS_TASKS` / `409 TASK_HAS_EVIDENCE`.
6. **Təsdiq yalnız `SUBMITTED` vəziyyətindən mümkündür.**
7. **Offline davranış.** Mobil tətbiq siqnal olmadan da çəkiliş edir və növbəyə
   (queue) salır; sonradan sinxronlaşdırır. Şəkil baytları növbəyə **yol ilə birgə**
   yazılır, çünki telefon müvəqqəti faylı silə bilər.

---

## 8. TEXNİKİ YIĞIN

### Ortaq
- **TypeScript** hər yerdə. Node.js 22.
- Monorepo: kökdə `package.json` (npm workspaces: `apps/*`, `packages/*`).
- `packages/types` — ortaq tiplər və state machine (hər üç kanal istifadə edir).
- `packages/database` — Prisma klienti + miqrasiyalar + write-through qatı.

### API (`apps/api`)
- **NestJS 12**, Express, `class-validator`.
- Postgres (Prisma). `DATABASE_URL` yoxdursa API **səssizcə yaddaşa düşür** —
  buna görə `/api/health`-də `persistence` sahəsi var.
- Bildirişlər: outbox nümunəsi (notification cədvəli + dispatcher).

### Veb panel (`web/`)
- **React 19 + Vite**, Tailwind CSS. Şüşə (glass) dizayn dili.
- Dörd bölmə (tab): **Dashboard** (metriklər), **Audit Review Center** (şəklə baxıb
  təsdiq/rədd), **Task Manager** (tapşırıq yarat/redaktə/sil, kütləvi göndərmə),
  **Store Directory** (mağaza CRUD).
- Panel açarı brauzerdə saxlanır (localStorage). 401/403 gələndə açar silinir və
  giriş ekranı göstərilir.
- Rol yoxlaması **yalnız UI-də göstərmək/gizlətmək üçündür**; əsl qapı API-dədir.

### iOS mobil (`mobile/`)
- **Expo 57**, React Native 0.86, React 19.
- `expo-camera` (kamera, işıq/torch, zoom, barkod skanı), `expo-location` (GPS),
  `expo-secure-store` (keychain), `@react-native-async-storage/async-storage` (növbə).
- **Naviqasiya kitabxanası yoxdur** — sadə `useState` ekran yığını:
  `Login → TaskList → TaskDetail → Camera → (geriyə TaskList)`.
- Ekranlar: `LoginScreenUI`, `TaskListScreenUI`, `TaskDetailScreen`,
  `CameraAuditScreenUI` (+ `CameraAuditScreen` = React-siz controller sinfi),
  `AuditHistoryScreen`.
- **Kamera funksiyaları:** canlı preview, ghost overlay (planogram referansı
  şəffaf çəkilir), grid, **işıq (torch)**, **zoom** (maksimumun faizi: 0/25/50/75/100%),
  **barkod skanı** (ean13, ean8, upc_a, upc_e, code128, code39, qr), **şəkil keyfiyyəti
  yoxlaması** (EXIF-dən: qaranlıq/parıltı/yüksək ISO/yavaş şutter).
- Çəkiliş anında təzə GPS mövqeyi alınır (5 saniyəlik taym-autla); alınmasa girişdəki
  mövqe istifadə olunur və **bu işçiyə açıq deyilir**.

### Telegram bot (`src/bot/`)
- **grammy** (Telegram Bot API). Webhook və ya polling.
- Əmrlər: `/start`, `/tasks`, `/mystatus`, `/help`.
- Callback-lər (düymələr): `menu`, `tasks`, `status`, `help`, `open`, `restart`,
  `chk` (çeklist), `confirm`, `retake`.
- Çoxaddımlı axın serverdə saxlanır (`GET/PUT/DELETE /api/portal/field/flow`),
  yəni bot yenidən başlasa da işçi qaldığı yerdən davam edir.
- Sessiya: `sessionStorage.ts`. Bildiriş: `notifications.ts`.

---

## 9. KANAL-SPESİFİK TƏLƏBLƏR

### Veb panel
- Boş ekran göstərmək ən pis nəticədir. Məlumat yüklənməsə səbəb yazılır.
- Uğursuzluq "toast" kimi görünür; amma **form səhvləri formanın içində** görünür
  (məsələn "bu mağaza kodu artıq istifadə olunur").
- Mağaza koordinatları formada mətn kimi saxlanılır, API-yə rəqəm kimi gedir.
- Panel açıqdırsa (açar yoxdursa) bu, qırmızı xəbərdarlıq zolağı ilə deyilir.
- Supervayzer şəklə baxanda **orijinal şəkil, GPS məsafəsi və metadata** görünür.

### iOS mobil
- Giriş: mağaza kodu + qeydiyyat sirri. GPS real alınır; alınmasa giriş düyməsi
  **bağlı qalır**. Heç bir sabit koordinat yoxdur.
- Tapşırıq siyahısı → tapşırıq detalı (çeklist) → kamera.
- Çeklist tamamlanmadan kamera düyməsi açılmır.
- Kamera: bayt gəlməsə şəkil uydurulmur. Şəkil keyfiyyətsizsə işçiyə Azərbaycanca
  deyilir, yenidən çəkmək təklif olunur, amma istəyirsə göndərə bilər (qərar
  auditə yazılır).
- Barkod sayı ekranda görünür (`📊 N barkod skan edildi`).
- Bütün ekranlarda `testID` var — XCUI testləri üçün (`mobile/uitests/testids.json`).

### Telegram bot
- İşçi `/start` yazır → mağaza kodu verir → açıq tapşırıqlarını görür.
- `open` → tapşırığı açır → çeklist (düymələrlə) → şəkil göndərir.
- `retake` → şəkli yenidən çəkir. `confirm` → təsdiqləyib göndərir.
- Bot **yalnız serverlə danışır**, öz bazası yoxdur.

---

## 10. SIRA İLƏ YIĞMA PLANI

1. **Baza + tiplər.** Prisma sxemasını yaz, miqrasiya et. `packages/types`-ə state
   machine və domen tiplərini qoy. *Əvvəl bunu et: hər şey buradan asılıdır.*
2. **Core API.** Autentifikasiya (3 kredensial + 3 qapı), sonra `/api/health`.
   Sonra portal CRUD, sonra sahə endpoint-ləri, sonra sübutlar.
3. **Veb panel.** Giriş → Dashboard → Review → Tasks → Stores.
4. **Telegram bot.** `/start` → bind → tapşırıq axını → şəkil → təsdiq.
5. **iOS mobil.** Kredensial maşınlığı → giriş → siyahı → detal → kamera.
6. **Sübut bütövlüyü.** Geofence, canlı kamera məcburiyyəti, metadata, keyfiyyət.
7. **Testlər və qoruyucular.** Hər "qapı" üçün test yaz ki, **sındırılanda
   həqiqətən düşsün** — yaşıl test sübut deyil.

---

## 11. TƏLƏLƏR — BUNLARI ETMƏ

1. **`README.md` köhnədir.** O, Supabase + PostgREST arxitekturasını təsvir edir.
   **Həqiqətdə** sistem NestJS + Prisma + PostgreSQL-dir. README-yə baxıb yazma;
   koda bax.
2. **`src/services/aiVision.ts` SİMULYASİYADIR** — heç bir real model yoxdur.
   Onu "işlək AI" kimi təqdim etmə və qoşma.
3. **Geofence-i yumşaltmaq olmaz.** Serverdə də tətbiq olunur; yumşaltmaq sübutun
   bütövlüyünü məhv edir.
4. **Heç bir metadata sahəsini "təxmin etmə".** Cihaz modeli, OS versiyası, mövqe —
   oxunmadısa `"unknown"` və ya giriş mövqeyi yazılır, uydurma dəyər yox.
   Tarixçə: bir dəfə `Root.tsx` hər auditə sabit koordinat yazırdı və bu, dördüncü
   "saxta funksiya" oldu.
5. **Qalereyadan şəkil qəbul etmə.** Yalnız canlı kamera.
6. **Boş siyahı ilə "yoxdursa" fərqini pozma.** Məsələn barkod: siyahı boşdursa bu
   "skan etdim, heç nə tapmadım" deməkdir; sahənin özü yoxdursa "skan etmədim".
   İkisini eyni yazmaq sonradan saxta iddiaya yol açır.
7. **`isAcceptable` boolean-nı tək istifadə etmə.** Şəkil keyfiyyətində üç hal var:
   `ok`, `flagged`, `no_signal`. "Qiymətləndirilməyib"i "yaxşı" kimi göstərmək ən
   təhlükəli səhvdir.
8. **Naviqasiya kitabxanası əlavə etmə** mobil tətbiqə — mövcud dizayn şüurlu
   şəkildə sadə `useState` yığınıdır.
9. **Mobil qeydiyyat sirrini paketə yazma** — Metro onu göndərməz.
10. **Yaşıl test sübut deyil.** Hər yeni qayda üçün onu **qəsdən sındıran** bir
    mutasiya yaz və testin düşdüyünü gör.

---

## 12. DEMO VƏ YOXLAMA

- `npm run test:all` — bütün oflayn qapılar.
- `npm run mobile:check` — mobil TypeScript yoxlaması (ağac böyükdür, **background-da
  işlət**, əks halda proses öldürülür).
- `npm run test:ui-ids` — mobil `testID` müqaviləsi (həm kontraktdakı hər id
  mənbədə var, həm də mənbədəki hər id kontraktda).
- `npm run test:capture` — "çəkiliş yalan deyə bilərmi?" dəsti.
- `GET /api/health` → `persistence` sahəsi `postgres` olmalıdır.
- Demo mağaza: `IPHONE_TEST` (Bakı). Demo hesablar `npm run demo:accounts` ilə
  yaradılır.

---

## 13. TƏSLİM MEYARLARI

Layihə "qurulmuş" sayılır, yəni:

- Supervayzer paneldən mağaza və tapşırıq yarada bilir.
- Sahə işçisi həm Telegram-dan, həm iOS tətbiqindən tapşırığı görür.
- İşçi rəfin **canlı** fotosunu çəkir; GPS və vaxt real yazılır.
- Supervayzer şəkli görür, təsdiq və ya rədd edir; rədd edəndə təlimat yazır.
- Rədd edilmiş tapşırıq yenidən `IN_PROGRESS`-ə düşür və işçi yenidən çəkə bilir.
- Sübutların heç bir sahəsi uydurulmuş deyil.
