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

| #   | İş paketi                                                                                                                                                                                                                                                                                                                                                              | Qəbul meyarı                                                                                                                  | Müddət  | Vəziyyət                            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------- |
| 1.1 | **Panel təhlükəsizliyi:** `/api/panel/*` üçün `mayUseRoute` yoxlamasını `/api/portal/` şərtindən azad et, `oneteam-user:` tokenini paneldə rədd et.                                                                                                                                                                                                                    | `curl -H "Authorization: Bearer oneteam-user:usr-admin-001" /api/panel/me` → 403                                              | 0.5 gün | ✅ `29aa4d3`                        |
| 1.2 | **Logout sonuncu açarı silə bilməsin** — _premisa yoxlanıldı və yanlış çıxdı_: heç bir administrativ ləğv yolu paneli boşalda bilmir (`CANNOT_REVOKE_OWN_SESSION`, `CANNOT_REVOKE_OWN_KEYS`). Əvəzində **əsl** problem tapıldı: `logout` sonuncu açarı ləğv edəndə panel yenidən **açılır**.                                                                           | Qərar gözləyir — §8-ə bax                                                                                                     | 0.5 gün | ⚠️ qərar                            |
| 1.3 | **Mağaza CRUD (Web):** yarat / redaktə et / sil + React forması.                                                                                                                                                                                                                                                                                                       | Yeni mağaza yaradılır → siyahıda görünür → kod unikal → silinə bilir                                                          | 1.5 gün | ✅ `e17941e`,`8302945`              |
| 1.4 | **Tapşırıq CRUD (Web):** mağaza, başlıq, növ (`CHECKLIST`, `PHOTO`, `AUDIT`), planlı tarix, müddət, çeklist sxemi (JSON). Ələ keçirmə yalnız sahibinə.                                                                                                                                                                                                                 | Tapşırıq yaradılır → ələ keçirilir → mobil/botda görünür → başqa istifadəçi ələ keçirə bilmir                                 | 1.5 gün | ✅ `31bc886` \*                     |
| 1.5 | **İstifadəçi rolları və istifadəçi idarəetməsi:** `SUPERVISOR` (mağaza/tapşırıq yaradır, auditi təsdiqləyir), `MERCHANDISER` (icra edir, öz işini təsdiqləyə bilmir), `ADMIN` (açarlar, rollar, istifadəçilər). İki boşluq bağlandı: audit təsdiqində **rol yoxlaması yox idi**, və **yeni adam yaratmaq mümkün deyildi** (sistemdə yalnız seed-dəki 3 nəfər var idi). | Sahədən foto göndərən işçi öz işini **təsdiqləyə bilmir**; ADMIN yeni adam yaradır → ona açar verir → açar onun adına işləyir | 1 gün   | ✅ `ed8f9b7` · canlı `4f4a238` \*\* |

**Mərhələ 1 nəticəsi:** Web panel **tam idarəetmə mərkəzi** olur; təhlükəsizlik boşluqları bağlanır.

**\* 1.4 qeydi — canlı yoxlama tamamlandı.** Kod `31bc886`-da deploy olundu, sonra **istehsalat
serverində** bütün yollar yoxlanıldı:

| Yoxlama                                                        | Nəticə                 |
| -------------------------------------------------------------- | ---------------------- |
| HTTP yolları (yaratma, paylama, redaktə, silmə, bütün rəddlər) | **36 keçdi / 0 düşdü** |
| Yenidən başlatmadan sonra sağ qalma                            | **12 keçdi / 0 düşdü** |

**Yazının həqiqətən bazaya düşdüyü necə sübut olundu:** server **yenidən başladıldı** və tapşırıq
yenə orada idi. Təzə başlamış prosesin əvvəlki yaddaşı olmur — deməli, görünən sətir **PostgreSQL-dən**
gəlib. Nəzarət olmadan bu sübut mənasız olardı, ona görə skript əvvəlcə `uptimeSeconds`-in
həqiqətən sıfırlandığını yoxlayır. Yoxlama skriptləri: `scripts/live-task-crud.cjs` +
`scripts/live-task-crud-after-restart.cjs`.

**Yoxlama zamanı iki dəfə "buq" göründü, ikisi də skriptin öz səhvi idi** — və ikisi də dərsdir:
(1) oxu yolu `priority: 'medium'` qaytarır, mən `'MEDIUM'` gözləyirdim — panelin öz tipi kiçik hərfdir,
giriş isə registrə həssas deyil; (2) qardaş mağazanın tapşırığı _digər_ tapşırığa etdiyim tarix
redaktəsini daşımalı sanmışdım — halbuki o, öz tarixini düzgün saxlamışdı. **Yoxlamanı təxmin
edilmiş müqavilə üzərində yazmaq yalançı mənfi nəticə verir.**

**Həmçinin 1.4-də aydınlaşdı:** plandaki `CHECKLIST` / `PHOTO` / `AUDIT` **saxlanan sütun deyil** —
`task_type` sütunu yoxdur. Növlər mövcud sahələrdən **törədilir** (`deriveTaskKind`), yəni etiket
məlumatdan sürüşə bilməz. Plan mətnini buna uyğun oxumaq lazımdır.

**\*\* 1.5 qeydi — iki boşluq, ikisi də "görünməyən" növdən.** Bu cür səhvin nəticəsi **yoxluqdur**:
çatışmayan yoxlama **200** qaytarır, 200 isə uğur kimi görünür.

| #   | Boşluq                                                                        | Nəticə                                                           |
| --- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | `reviewSubmission` / `autoApproveSubmission` **principal-ın rolunu oxumurdu** | Foto göndərən işçi öz auditini təsdiqləyə bilirdi                |
| 2   | **Yeni istifadəçi yaratmaq mümkün deyildi**                                   | "Hər adama öz açarı" yalnız seed-dəki **3 nəfər** üçün işləyirdi |

**1 nömrəli boşluq "istənilən merchandiser" deyildi — dəqiq bir adam idi.** İki qoruyucu bunu
örtdüyü təsəvvürünü yaradırdı, ikisi də örtmürdü: `mayUseRoute` cihaz açarını bu yollardan kənar
saxlayır, amma panel açarını administrator **hər kəsə** verə bilər; `canUserAccessTask` isə
MERCHANDISER-ə yalnız **ona təyin edilmiş** tapşırığı açır. Və qeydiyyat yolu
(`FieldService.bind` → `claimStoreTasks`) mağazanın açıq işini **mağaza kodu ilə qeydiyyatdan keçən
adama** verir — yəni **təqdimatın müəllifi həmin tapşırığın icraçısıdır.** Deməli bu yola çata bilən
tək merchandiser **elə qiymətləndirilən fotonun sahibi** idi. Yeni `requireReviewer` qapısı ADMIN və
SUPERVISOR-dan başqasını rədd edir.

**İkinci boşluq "hər adama öz açarı" qərarını yarımçıq qoyurdu:** `GET /api/panel/keys` artıq açar
veriləcək şəxslərin siyahısını qaytarırdı, amma siyahıya **əlavə etmək** üçün heç bir yol yox idi.

**Yoxlama və detektoru sındırma.** `npm run test:roles` → **78 keçdi / 0 düşdü**. Daşıyıcı yoxlamalar
status kodları deyil: (a) fikstur tapşırığın həqiqətən **fotonu çəkən işçiyə təyin olunduğu**,
(b) rədd edilmiş təsdiqin **tapşırığı tərpətmədiyi**, (c) yaradılmış adamın və açarının **ayrı
bağlantı ilə PostgreSQL-dən oxunduğu**. Sonra iki dəfə sındırıldı:

- **Qapı silindi** → **7 yoxlama qırmızı**, o cümlədən _"müəllif öz təqdimatını təsdiqləyə bilməz"_
  **200** qaytardı (`status: approved`) və tapşırıq `published → completed` getdi.
- **`createUser`-in baza yazısı silindi** → **8 yoxlama qırmızı**, o cümlədən **eyni e-poçt 201 ilə
  qəbul olundu** — çünki unikallıq qaydası bazadadır, yaddaş yolunda isə heç bir yoxlama yoxdur.

**Testin ilk versiyası yanlış səbəbdən yaşıl idi.** O, seed-dəki merchandiser-i işlədirdi — o adam
həmin tapşırığın icraçısı deyil — deməli **qapı silinsə də yaşıl qalacaqdı**. Bunu detektoru sındırma
mərhələsi üzə çıxardı; test indi **icraçının özü** kimi daxil olur və hücumun real olmasını təmin edən
ilkin şərti ayrıca yoxlayır.

**Qəsdən edilməyən dəyişiklik:** plan `mayActAsAnotherUser` yoxlamasını `SUPERVISOR`-a genişləndirməyi
yazırdı. **Edilmədi** — həmin funksiya hazırda yalnız `via: 'service'` üçün `true` qaytarır, yəni
genişləndirmək **supervayzerə başqa istifadəçi adından hərəkət etmək** hüququ verərdi. Planın
premisası kod deyil; yoxlanıldı və rədd edildi.

**Qorunan iki kilidlənmə (hər ikisi "narahatçılıq" deyil, "çıxılmaz vəziyyət" sinfindəndir):** son
administrator **endirilə və silinə bilməz** (istifadəçi və açar idarəetməsi ADMIN-only-dir → adminsiz
deployment bir daha idarə oluna bilməz); öz rolunu dəyişmək və öz hesabını silmək **qadağandır**
(rolu dəyişən administrator işləyən açarı saxlayır, amma həmin açarın açdığı bütün ekranları itirir).

**Canlı yoxlama tamamlandı** — kod deploy olundu, sonra **istehsalatda** bütün yollar yoxlanıldı (1.4-də
olduğu kimi). Yeni resurs əlavə olunduğu üçün bu, doktrina ilə **məcburidir**:

| Yoxlama                                                                            | Nəticə                 |
| ---------------------------------------------------------------------------------- | ---------------------- |
| Bütün yollar: yaratma, redaktə, silmə, 11 rədd halı, rol qapısı, **təsdiq qapısı** | **60 keçdi / 0 düşdü** |
| Yenidən başlatmadan sonra sağ qalma + təmizlik                                     | **29 keçdi / 0 düşdü** |

**Təsdiq qapısının canlı sübutu rol fərqi ilə alınır:** eyni (mövcud olmayan) təqdimat id-si ilə
MERCHANDISER **403 `REVIEW_FORBIDDEN`** alır, ADMIN isə **404** alır. Fərq **roldur, id deyil** — yəni
qapı axtarışdan **əvvəl** işləyir. Bu, təzə başlamış prosesdə də təkrarlanır.

**Yazının bazaya düşdüyü üç şeylə sübut olundu:** (1) yaradılan adam yenidən başlatmadan sonra da var;
(2) **redaktə** də sağ qaldı (ad **və** telefon ayrı-ayrı) — "sətir yazıldı" ilə "sətir düzgün
yazıldı"-nı bu ayırır; (3) təzə prosesdə həmin adama **yeni açar mint olundu** — `panel_tokens.user_id`
xarici açarı sətri bazada tapmasa, bu `KEY_NOT_STORED` ilə düşərdi. Yəni zəncir sübut olunur, təkcə son
halqa deyil.

**`LAST_ADMIN` budağı HTTP ilə ÇATILMAZ — konstruksiyaya görə.** Yol administrator tələb edir, qoruyucu
isə yalnız hədəf **tək** administrator olanda işə düşür — bu halda çağıran elə həmin adamdır, ona görə
`CANNOT_CHANGE_OWN_ROLE` / `CANNOT_DELETE_SELF` **əvvəl** cavab verir. Qoruyucu iki administratorun eyni
anda bir-birini endirməsinə qarşıdır və bir HTTP müştərisi ilə səhnələşdirilə bilməz. Yerli test onu
yaddaş ilə bazanı qəsdən uyğunsuzlaşdıraraq açır.

**Yoxlama zamanı üç "buq" göründü, üçü də skriptin öz səhvi idi.** `submissions` təqdimatı olmayan adam
üçün **`0`-dır, `null` deyil** (`countEvidencesByUser` LEFT JOIN edir; `null` yalnız baza olmayanda
"naməlum" deməkdir). `/api/panel/me` **`userId`** qaytarır, `/api/panel/users` sətirləri isə **`id`** —
eyni principal, iki forma. Və `/api/health`-in `persistenceDetail` sətri **canlı sayğac deyil, GECİKƏN
ETİKETDİR**: yalnız replika poll-u massivləri yenidən yükləyəndə hesablanır, ona görə yazıdan dərhal
sonra oxunanda **əvvəlki** vəziyyəti göstərir və saxta "silmə baş vermədi" nəticəsi verdi. Skript indi
onun oturmasını gözləyir, canlı cavab kimi isə resurs endpointini götürür.

**İstehsalat yoxlama əvvəlki vəziyyətdə buraxıldı:** 3 istifadəçi, 3 mağaza, 4 tapşırıq, 0 sübut.
Müvəqqəti giriş kredensialı silindi, konteyner yenidən başladıldı ki, köhnə mühit qalmasın, və həmin
açar oxuma / yazma / təsdiq yollarında **401** alır. Skriptlər: `scripts/live-users-crud.cjs` +
`scripts/live-users-crud-after-restart.cjs`.

---

### MƏRHƏLƏ 2 — Telegram bot peşəkar menyu (Həftə 3)

| #   | İş paketi                                                                                                                                                      | Qəbul meyarı                                                                   | Müddət  | Vəziyyət |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------- | -------- |
| 2.1 | **Inline keyboard state machine:** `main → store-list → task-list → checklist → photo → confirm → done`. Hər düymə `callback_data` ilə `action:id` formatında. | Basılma dublikat heç bir səhv yaratmır (idempotent).                           | 1.5 gün | ⏳       |
| 2.2 | **Bot session store (Redis / in-memory TTL):** `chatId → {step, storeId, taskId, checklistAnswers[]}`. 15 dəq TTL, yenilənmə.                                  | Yenidən başlatma ilə state itmir; `chatId` yenidən yazanda əvvəlki davam edir. | 1 gün   | ✅       |
| 2.3 | **Notification:** tapşırıq yaradılması / vaxt bitməsi / rədd 15 dəq əvvəl → `sendMessage` + inline `Open` düyməsi.                                             | Supervayzer panelində yaradanda bot bildiriş alır.                             | 0.5 gün | ⏳       |
| 2.4 | **Fallback (text):** `/start`, `/help`, `/mystatus` — inline olmadıqda işləsin.                                                                                | `/help` → menyu göstərir.                                                      | 0.5 gün | ⏳       |

#### 2.2 — nə edildi, nə ilə sübut olundu

**Redis yoxdur, Postgres var.** Plan "Redis / in-memory TTL" yazmışdı. Bu deployment-də Redis yoxdur və
bir neçə yüz baytlıq sessiya üçün botla öz vəziyyəti arasına üçüncü servis qoymaq düzgün olmazdı. Sessiya
`bot_sessions` cədvəlindədir — bot yenə də **birbaşa bazaya qoşulmur**, Core API-dən keçir (tək məlumat yolu).

**TTL sürüşkəndir, oxu onu irəli itələyir.** `readBotSession` tək `UPDATE … RETURNING *`-dır: işləyən
merçendayzer mağazasını itirmir, bir saat əvvəl gedən itirir. Vaxtı keçmiş sətir **oxunmur, amma
silinmir** — oxuyarkən silmək `SELECT`-i yazıya çevirir və iki paralel oxu yarışar. Saatda bir işləyən
təmizləmə onları yığır (1 saat lütf müddəti ilə — ki "bu adam nə edirdi" sualı bir müddət cavablı qalsın).

**Sübut — 61 yoxlama, hamısı yaşıl:**
- `npm run test:flow` → **47/0**. Dəst **öz API prosesini qaldırır (port 3111), öldürür, təzəsini qaldırır**
  və axını geri oxuyur. Çünki "200 cavabı gəldi" heç nə sübut etmir — proses yaddaşındaki `Map` da 200
  qaytarır. Yükdaşıyan yoxlama budur: **bir prosesin yazdığı axını BAŞQA proses oxuyur.** Əlavə olaraq:
  TTL sürüşkənliyi, vaxtı keçmişin oxunmaması, təmizləmənin yalnız lütf müddətindən kənarı silməsi,
  `user_id`-nin çatdan törədilməsi (gövdədəki saxta `userId` bazaya düşmür), 5 rədd halı, və "axın mövcud
  olmayan tapşırığa işarə edə bilər" (xarici açar qəsdən yoxdur — supervayzer tapşırığı siləndə axın sınmasın).
- `npm run test:bot-storage` → **14/0**. Adapterin üç görünməz qərarı: boş sessiya silinir, **amma
  "mağazaya bağlı, tapşırıq açıq deyil" saxlanılır** (bu hal itərsə bot yenə mağaza kodu soruşur); API-dən
  gələn `null` `undefined`-a çevrilir; və **API əlçatmaz olanda `read` XƏTA ATIR**, `undefined` qaytarmır —
  yoxsa baza nasazlığı "bu çat heç vaxt başlamayıb" kimi görünər və merçendayzerin yaddaşdaki işi itər.

**Detektoru sındırma (məcburi standart):**
- Sessiyanı proses yaddaşındaki `Map`-a qaytardım (baza yazılarını yerində saxlayaraq) → **42/5**. Qırmızı
  olan 5: «əvvəlki prosesin yazdığı axın geri oxunur», «hər sahə geri gəldi», «bağlı çat şəxsi saxlayır»,
  «oxu TTL-i irəli itələyir», «vaxtı keçmiş axın davam etmir». **"Sətir bazadadır" yoxlamaları YAŞIL
  qaldı** — yəni yenidən başlatma yoxlaması təkrar deyil, həqiqətən yükdaşıyandır.
- Adapterdə `read`-in xətasını udub `undefined` qaytardım → **12/2**; qırmızı olan ikisi məhz "uğursuzluq
  'sessiya yoxdur' kimi görünməməlidir" müqaviləsini saxlayan yoxlamalardır.

**`ONETEAM_BOT_SWEEP_MS`** — təmizləmə dövrü (default 15 dəq, `0` söndürür). Təmizləmə **API prosesindədir**,
botda deyil: bot bazaya yalnız API-dən çatır, ona görə təmizləmə orada ola bilməz.

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

| Borc                                                       | Hal-hazırkı vəziyyət                                                                                                                              | Planlaşdırılan həll                                                                                                                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mobile/package.json: dependencies: {}`                    | Expo config və native modullar yoxdur                                                                                                             | Mərhələ 3.1-də `expo`, `expo-camera`, `expo-location`, `expo-secure-store`, `expo-router` quraşdırılır                                                                   |
| `yolov8n.pt` — generic COCO                                | SKU tanıma yoxdur                                                                                                                                 | Mərhələ 4.3-də ROI crop + Vision LLM ilə kompensasiya edilir (fine-tune yox)                                                                                             |
| ~~`/api/panel/*` → `oneteam-user:` token qəbul edirdi~~    | Panel açarı yaradıldıqda belə qəbul edilirdi                                                                                                      | **Həll olundu** (1.1, `29aa4d3`)                                                                                                                                         |
| ~~Audit təsdiqində rol yoxlaması yox idi~~                 | Fotonu göndərən işçi öz auditini təsdiqləyə bilirdi                                                                                               | **Həll olundu** (1.5, `ed8f9b7`) — `requireReviewer`                                                                                                                     |
| ~~Yeni istifadəçi yaratmaq mümkün deyildi~~                | "Hər adama öz açarı" yalnız seed-dəki 3 nəfər üçün işləyirdi                                                                                      | **Həll olundu** (1.5, `ed8f9b7`) — `/api/panel/users` + panel ekranı                                                                                                     |
| Bot state-machine yoxdur                                   | `text` command + switch                                                                                                                           | Mərhələ 2.1-də inline keyboard                                                                                                                                           |
| OpenRouter env yoxdur                                      | `OPENROUTER_API_KEY` Railway-da yoxdur                                                                                                            | Mərhələ 4.1-dən əvvəl qoyulmalıdır                                                                                                                                       |
| iOS Xcode scheme / signing yoxdur                          | `mobile/` altında `.xcodeproj` yoxdur                                                                                                             | `expo prebuild` yaradacaq                                                                                                                                                |
| `pnpm-workspace.yaml` var, amma `node_modules` `npm`-dədir | Lockfile uyğunsuzluğu (`npm install --dry-run` → 304 silinir)                                                                                     | `pnpm install --frozen-lockfile` və ya `package-lock.json` bərpası                                                                                                       |
| Geofence radiusu mağaza üzrə deyil                         | `GEOFENCE_MAX_DISTANCE_METERS` sabiti (`packages/types`)                                                                                          | Mərhələ 3-də mağaza üzrə sütun + mobil tərəfin uyğunlaşdırılması                                                                                                         |
| `/api/health` → `persistenceDetail` **gecikən etiketdir**  | Yalnız replika poll-u yükləyəndə hesablanır → yazıdan sonra bir interval **köhnə** say göstərir (`ONETEAM_REFRESH_MS=0` olsa heç vaxt yenilənmir) | Oxu anında hesablanmalı, ya da adı "son yükləmə" olduğunu deməli. **Kiçik, amma yanlış məlumat verir** — 1.5 canlı yoxlamasında saxta "silmə baş vermədi" nəticəsi verdi |
| Çeklist sual mətni **`label`** kimi saxlanılır, bot isə **`question`** oxuyur | `POST /api/portal/tasks` domain formasını (`question`) **400** ilə rədd edir; `label` ilə yaradılan çeklist bazada `question` saxlamır → bot sual yerinə `*undefined*` göstərir. Ona görə `npm run bot:test` (və deməli `test:live`) **qırmızıdır** | `readChecklistSchema` girişdə `label ?? question ?? …` qəbul etsin, çıxışda `question` yazsın; panel `question` oxusun; mövcud sətirlər backfill olunsun. **Qərar gözləyir (bahaI)** — tapşırıq #73 |

---

## 5. Qəbul meyarı cədvəli (Definition of Done — hər mərhələ üçün)

| Mərhələ | Avtomatik yoxlama                                              | Manual yoxlama                                         | Operator təsdiqi        |
| ------- | -------------------------------------------------------------- | ------------------------------------------------------ | ----------------------- |
| 1       | `npm run test:all` + `test:live` → green                       | Panelə gir → mağaza yarat → tapşırıq yarat → ələ keçir | ✅ (1.1, 1.3, 1.4, 1.5) |
| 2       | Bot unit test (state machine) → green                          | Botdan 3 mağaza, 5 tapşırıq icra et                    | ⏳                      |
| 3       | `xcodebuild test` CI → green                                   | Real iPhone-da Login → Enroll → Photo → Submit         | ⏳                      |
| 4       | 100 test şəkli → AI worker → JSON valid + `fallback` rate < 5% | 10 şəkil → paneldə skor + anomaliya görünür            | ⏳                      |
| 5       | `k6` load test nightly → green                                 | Demo video + executive summary                         | ⏳                      |

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
