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
| 2.1 | **Inline keyboard state machine:** `main → store-list → task-list → checklist → photo → confirm → done`. Hər düymə `callback_data` ilə `action:id` formatında. | Basılma dublikat heç bir səhv yaratmır (idempotent).                           | 1.5 gün | ✅       |
| 2.2 | **Bot session store (Redis / in-memory TTL):** `chatId → {step, storeId, taskId, checklistAnswers[]}`. 15 dəq TTL, yenilənmə.                                  | Yenidən başlatma ilə state itmir; `chatId` yenidən yazanda əvvəlki davam edir. | 1 gün   | ✅       |
| 2.3 | **Notification:** tapşırıq yaradılması / vaxt bitməsi / rədd 15 dəq əvvəl → `sendMessage` + inline `Open` düyməsi.                                             | Supervayzer panelində yaradanda bot bildiriş alır.                             | 0.5 gün | ⏳       |
| 2.4 | **Fallback (text):** `/start`, `/help`, `/mystatus` — inline olmadıqda işləsin.                                                                                | `/help` → menyu göstərir.                                                      | 0.5 gün | ✅       |

#### 2.1 — nə edildi, nə ilə sübut olundu

**Əvvəlcə ən vacib tapıntı: axın Telegram-da ÜMUMİYYƏTLƏ işləmirdi.**

Faza 2.1-ə başlayanda `src/bot/index.ts` dörd handler-i **import edirdi və heç birini çağırmırdı**:

- `message:location` marşrutu **heç yox idi** → paylaşılan lokasiya Telegram-ın dispatcher-ində düşürdü və bot
  **heç nə demirdi**;
- mətn marşrutu mağaza kodu budağından o tərəfə keçmirdi (`handleChecklistText`, `handleLocationSkip` ölü);
- tək callback marşrutu yalnız `submit_` anlayırdı → **çeklist düymələri cavabsız udulurdu** (düymə 30 saniyə
  fırlanır və dayanır, nə xəta, nə cavab).

Nəticə: merçendayzer tapşırığı aça bilirdi, lokasiya soruşulurdu, paylaşırdı — **cavab gəlmirdi** — və sonra
şəkil _"əvvəlcə lokasiya lazımdır"_ deyə **rədd olunurdu**, çünki addım heç vaxt irəliləməmişdi. Yəni
lokasiya + çeklist + foto axını canlıda **çıxılmaz** idi. `bot:test` isə bütün bu müddətdə **yaşıl** idi,
çünki handler-ləri **birbaşa** çağırır — sınıq olan qatın (router-in) ətrafından keçir.

**İkinci tapıntı: `test-runner.ts` heç nə təmizləmirdi.** Başlığı "özünü təkrarlaya bilən" olduğunu iddia
edirdi; hər iş bir tapşırıq + şablon + audit buraxırdı. Bir neçə fazada heç kim görmədi, çünki qalıqlar
seed mağazasında keçərli sətirlərdir və növbəti dəstin "əvvəl" sayı sadəcə bir az yüksək oxunurdu.

**Nə quruldu:**

- **`callbacks.ts`** — `callback_data` formatı təkdır: **`<action>:<id>`**. Router ilk iki nöqtəyə görə bölür,
  `id`-ni hərəkətin öz handler-i oxuyur (çeklist `chk:2:true` ilə iki dəyər daşıyır). Telegram 64 bayt limitini
  **encode zamanı** yoxlayırıq — səhv orada ucuz tapılır, düymə basılanda isə "işləməyən düymə" kimi görünür.
- **`router.ts`** — bütün marşrutlar bir funksiyada. Sıra təsadüfi deyil və hər addım izah edilib.
- **`confirm` addımı** — şəkil artıq dərhal göndərilmir. Bot yalnız Telegram-ın `file_id`-ni saxlayır,
  **şəkli geri göstərir** və iki düymə verir. Təsdiqlənməyincə nə bayt endirilir, nə sətir yazılır. Səhv
  kadr bir **yenidən çəkməyə** başa gəlir, nəzarətçinin növbəsində yanlış audita yox.
- **`open` və `restart` ayrı hərəkətlərdir.** "Tapşırığı aç" iki səbəbdən iki dəfə gəlir (qəsdən ikinci basma
  və şəbəkənin təkrarı) və məlumatdan bunlar **fərqlənmir**. Tək hərəkət məcburən təxmin edərdi və təxminin
  dağıdıcı oxunuşu **verilmiş cavabları silərdi**. Ona görə: `open` heç nə dağıtmır (axın gedirsə, cari
  addımın sualını təkrar göstərir), `restart` isə həmişə dağıdır və düyməsinin üzərində bunu yazır.
- **İdempotentlik qapıdır, vaxt möhürü deyil.** Qapı "təsir artıq olubmu?" sualını verir. Bu yalnız ona görə
  işləyir ki, grammy update-ləri **ardıcıl** emal edir və sessiyanı aralarında yazır — `bot.js:191` və
  `session.js:67`. İki sətir istinadı kodda yazılıb, çünki bu xassə grammy-nindir, bizim deyil.

**Sübut — `npm run test:router` → 44/0.** Dəst **real botu** `bot.handleUpdate` ilə sürür: middleware,
sessiya, router, handler-lər — hamısı əsl, yalnız Telegram-ın HTTP API-si əvəzlənib. Zəncirin hamısı
yoxlanılır: `/start` → mağaza kodu → `/tasks` → `open` → lokasiya → çeklist → foto → **confirm** → göndərildi.
Əlavə olaraq: təsdiqdən əvvəl **heç nə yazılmır**, təkrar basma **ikinci audit yazmır**, axın sonda `idle`-a
qayıdır, `pending_photo` təmizlənir, və **heç bir düymə köhnə prefiks işlətmir**.

**Detektoru sındırma:**

- Düzəlişdən **əvvəl** (eyni dəst, köhnə kod): **17/11/3** — düşən 11 məhz lokasiya marşrutu, çeklist
  düymələri, təsdiq addımı və `action:id` formatıdır.
- `message:location` marşrutunu sildim → **20/9/3**. Lokasiyadan sonrakı hər şey qırmızı; `/start`, mağaza
  kodu, tapşırıq siyahısı və format yoxlamaları **yaşıl qaldı** — yəni çöküş ümumi deyil, marşruta xasdır.
- Axının `idle`-a sıfırlanmasını sildim (realist ssenari: "sıfırlamağı unutmaq") → **39/5**, və ən vacibi
  `got: {"before":1,"after":2}` — təkrar basma **həqiqətən ikinci audit yazdı**. `heç bir xəta udulmadı`
  yoxlaması yaşıl qaldı, yəni uğursuzluq **sakit** idi — ən pis növü, və dəst onu tutur.

**`bot:test` indi yaşıl və özünü təmizləyir.** Əvvəl qırmızı idi, çünki fixtura `question` göndərirdi —
API isə `label` qəbul edir (bax #73). Fixtura düzəldildi (panel də `label` göndərir) və runner-a təmizlik
əlavə olundu: `task_evidences.store_task_id` RESTRICT olduğu üçün API bu silməni **edə bilmir**, ona görə
birbaşa `pg` ilə, digər dəstlər kimi.

**`store-list` addımı qəsdən kataloq deyil.** Plan `main → store-list` yazır. Mağazaların siyahısını
göstərmək **istənilən Telegram istifadəçisinə** istənilən mağazanın açıq işini öz üzərinə götürməyə imkan
verərdi (`claimStoreTasks`) — yəni mağaza kodu yeganə qapıdır və o qapı açılmamalıdır. `store-list` addımı
"çatın bağlı olduğu mağaza" kimi qalır; kod yenə əl ilə yazılır. **Bu, plandan qəsdən kənara çıxmadır.**

**#73 üçün körpü qoyuldu (qərar hələ də sizindir).** `questionText()` artıq `question ?? label` oxuyur,
yəni merçendayzer "undefined" yerinə həqiqi sualı görür. Bu, **müqaviləni həll etmir** — hansı adın kanonik
olduğu və köhnə sətirlərin necə doldurulacağı açıqdır. Səbəb: bu fayl 2.1 üçün yenidən yazılırdı və
`question.question`-i **bilmə-yə-bilmə** yeni koda yazmaq "dəyişikliyi kiçik saxlamaq" deyil, qüsuru qəsdən
göndərməkdir. Simptom indi testlə qorunur.

#### 2.4 — nə edildi, nə ilə sübut olundu

**Bir texniki fakt bütün 2.4-ü müəyyən edir: Telegram mesajında `reply_markup` TƏKDİR.** Ya reply keyboard,
ya inline — **ikisi bir mesajda göndərilə bilmir**. Yəni "menyunu əlavə et" hər mesajda **seçimdir**.

Bu seçimin qaydası indi `keyboards.ts`-in başlığında yazılıb:

- **Yazılmış əmri cavablandıran** və ya axını bitirən mesaj → **reply keyboard**. O, davamlıdır, yuxarı sürüşüb
  itmir, və — 2.4-ün əsl tələbi — **yazmaqla geri qaytarıla bilən yeganə növdür**.
- **Addımın özü olan** mesaj → **inline**, çünki düymələr o mesaja aiddir (bu sualın cavabları, bu fotonun
  təsdiqi).

**Əsl problem bu idi:** lokasiya addımı `locationRequestKeyboard()` göndərir və o, `oneTime()`-dır — yəni
istifadə olunan anda **yox olur**. Ondan sonra botun heç bir yeri reply keyboard-u geri qoymurdusa,
merçendayzerin əlində **heç bir düymə qalmır**; yeganə çıxış yolu `/tasks` yazmaqdır — faza hədəfi isə
"sahə işçisi heç bir `/komanda` yazmır". `/help`, `/tasks`, `/mystatus` isə **heç bir klaviatura**
əlavə etmirdi, yəni yazmaq da kömək etmirdi.

**Üç tapıntı:**

1. **`menu:home` ölü hərəkət idi.** `CALLBACK_ACTIONS`-da var, router cavablandırır, `handleMenuHome` yazılıb
   — və **heç bir düymə onu yaratmırdı**. Bu, 2.1-in tapdığı qüsurun **eyni sinfidir** (dörd handler import
   olunub çağırılmırdı), bir səviyyə aşağıda.
2. **`/start` qeydiyyatdan keçmiş merçendayzeri yenidən qapıya göndərirdi.** `/start` Telegram-da ən çox
   yazılan əmrdir (çat siyahıdan açılarkən klient özü göndərir). Handler isə **şərtsiz** mağaza kodu
   soruşurdu və `step`-i yazırdı — yəni çeklistin ortasında `/start` yazan adam həm artıq cavabı bilinən
   sualla qarşılaşırdı, həm də **axını pozulurdu**. İndi: çat qeydiyyatdadırsa `/start` = "məni evə apar",
   yəni `handleMenuHome`.
3. **`/help` qəbul meyarı özü bir qüsuru gizlədirdi** — aşağıda "detektoru sındırma" bölməsində.

**Nə quruldu:** `MENU_HOME_LABEL` + `menu:home` düyməsi axının hər addımında və foto təsdiqində; `/start`,
`/help`, `/tasks`, `/mystatus` və axının son qəbzi hamısı **reply keyboard** qaytarır; `handleMenuHome`
mağazanı dəyişməyin yolunu **deyir** (yeni kodu yazmaq — ayrı `/store` əmri qəsdən yoxdur, çünki yadda
saxlanacaq şey bir deyil, iki olardı).

**Sübut — `npm run test:router` → 67/0** (2.1-də 44 idi; +23 yeni yoxlama). 2.4 üçün xüsusi olaraq: `/help`
menyunu göstərir, hər mətn əmri menyunu geri qaytarır, qeydiyyatlı çatda `/start` qapını təkrarlamır və
sessiyaya `awaiting_store_code` yazmır, axının ortasında `/start` addımı **dəyişmir**.

**Detektoru sındırma — dörd iş:**

| Sındırılan şey                               | Nəticə   | Nə qırmızı oldu                                                          |
| -------------------------------------------- | -------- | ------------------------------------------------------------------------ |
| `/start` yenidən şərtsiz mağaza kodu soruşur | **62/5** | məhz beş `/start` yoxlaması                                              |
| `/help` inline menyu göndərir                | **66/1** | yalnız "menyunu göstərir" (digər əmrlər yaşıl qaldı — çöküş əmra xasdır) |
| Çeklist menyu düyməsini itirir               | **66/1** | yalnız çeklistin "menyuya qayıtma" yoxlaması                             |
| Menyu düyməsi hər yerdən silinir             | **64/3** | iki sürülən yoxlama **+ statik** yoxlama                                 |

**Ən dəyərli nəticə: 2.4 öz testimdəki bir qüsuru üzə çıxardı.** `/start` yoxlaması əvvəl
`/mağaza kodunu göndərin/i` mətnini axtarırdı — **heç vaxt uyğun gələ bilməzdi**, çünki həqiqi mətn
"təmsil etdiyiniz `*Mağaza Kodunu*` göndərin"dir (böyük hərflər və arada `*`). Yəni davranış sınıq ikən
yoxlama **yaşıl** keçirdi. Detektoru sındırma bunu tutdu. İndi qeydiyyat mesajı "Xoş Gəlmisiniz" ilə
tanınır. **Dərsi:** **heç vaxt uğursuz ola bilməyən yoxlama yoxlamadan pisdir** — çünki sübut kimi sayılır.

**Bir yoxlama qəsdən botu SÜRMÜR.** "heç bir callback hərəkəti çatılmaz deyil" yoxlaması mənbə faylları
oxuyur. Səbəb: sürmə yalnız **artıq çatıla bilən** hərəkətlərə çatır, ona görə heç bir gəzinti "heç kimin
yaratmadığı hərəkəti" tapa bilməz — `menu:home` elə belə yaşayırdı. Amma bu statik yoxlama **natamamdır**:
`encodeCallback('menu', …)` **çağırılmayan** bir köməkçidə də olarsa, o, keçər. Ona görə iki sürülən yoxlama
əlavə olundu ("axın menyuya qayıtma yolu təklif edir", "burada da menyu düyməsi var") — **biri "heç kim
yaratmır"-ı, digəri "yaradan qoşulmayıb"-ı tutur**. (Qeyd: ilk yazdığım `homeButton()` köməkçisi **heç
haradan çağırılmırdı** — statik yoxlamanın tuta bilmədiyi elə həmin haldır.)

**2.3-ə keçid üçün açıq qalan şey:** `NotificationDispatcherService` hələ də **heç nə göndərmir**.

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

| Borc                                                                          | Hal-hazırkı vəziyyət                                                                                                                                                                                                                                      | Planlaşdırılan həll                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mobile/package.json: dependencies: {}`                                       | Expo config və native modullar yoxdur                                                                                                                                                                                                                     | Mərhələ 3.1-də `expo`, `expo-camera`, `expo-location`, `expo-secure-store`, `expo-router` quraşdırılır                                                                                                                  |
| `yolov8n.pt` — generic COCO                                                   | SKU tanıma yoxdur                                                                                                                                                                                                                                         | Mərhələ 4.3-də ROI crop + Vision LLM ilə kompensasiya edilir (fine-tune yox)                                                                                                                                            |
| ~~`/api/panel/*` → `oneteam-user:` token qəbul edirdi~~                       | Panel açarı yaradıldıqda belə qəbul edilirdi                                                                                                                                                                                                              | **Həll olundu** (1.1, `29aa4d3`)                                                                                                                                                                                        |
| ~~Audit təsdiqində rol yoxlaması yox idi~~                                    | Fotonu göndərən işçi öz auditini təsdiqləyə bilirdi                                                                                                                                                                                                       | **Həll olundu** (1.5, `ed8f9b7`) — `requireReviewer`                                                                                                                                                                    |
| ~~Yeni istifadəçi yaratmaq mümkün deyildi~~                                   | "Hər adama öz açarı" yalnız seed-dəki 3 nəfər üçün işləyirdi                                                                                                                                                                                              | **Həll olundu** (1.5, `ed8f9b7`) — `/api/panel/users` + panel ekranı                                                                                                                                                    |
| ~~Bot state-machine yoxdur~~                                                  | `text` command + switch                                                                                                                                                                                                                                   | **Həll olundu** (2.1) — `callbacks.ts` (`action:id`) + `router.ts`. Həm də: axının **dörd handler-i heç çağırılmırdı** və `message:location` marşrutu yox idi → lokasiya+çeklist+foto axını canlıda çatılmaz idi        |
| OpenRouter env yoxdur                                                         | `OPENROUTER_API_KEY` Railway-da yoxdur                                                                                                                                                                                                                    | Mərhələ 4.1-dən əvvəl qoyulmalıdır                                                                                                                                                                                      |
| iOS Xcode scheme / signing yoxdur                                             | `mobile/` altında `.xcodeproj` yoxdur                                                                                                                                                                                                                     | `expo prebuild` yaradacaq                                                                                                                                                                                               |
| `pnpm-workspace.yaml` var, amma `node_modules` `npm`-dədir                    | Lockfile uyğunsuzluğu (`npm install --dry-run` → 304 silinir)                                                                                                                                                                                             | `pnpm install --frozen-lockfile` və ya `package-lock.json` bərpası                                                                                                                                                      |
| Geofence radiusu mağaza üzrə deyil                                            | `GEOFENCE_MAX_DISTANCE_METERS` sabiti (`packages/types`)                                                                                                                                                                                                  | Mərhələ 3-də mağaza üzrə sütun + mobil tərəfin uyğunlaşdırılması                                                                                                                                                        |
| `/api/health` → `persistenceDetail` **gecikən etiketdir**                     | Yalnız replika poll-u yükləyəndə hesablanır → yazıdan sonra bir interval **köhnə** say göstərir (`ONETEAM_REFRESH_MS=0` olsa heç vaxt yenilənmir)                                                                                                         | Oxu anında hesablanmalı, ya da adı "son yükləmə" olduğunu deməli. **Kiçik, amma yanlış məlumat verir** — 1.5 canlı yoxlamasında saxta "silmə baş vermədi" nəticəsi verdi                                                |
| Çeklist sual mətni **`label`** kimi saxlanılır, bot isə **`question`** oxuyur | **2.1-də körpü qoyuldu:** `questionText()` artıq `question ?? label` oxuyur, yəni merçendayzer həqiqi sualı görür və `bot:test` **yaşıldır**. Amma **müqavilə hələ də sınıqdır** — `ChecklistQuestion.question` tipdə `?` edildi ki, tip yalan danışmasın | Hansı ad kanonikdir: `label` → `question` adlandırılsın (backfill ilə), yoxsa `label` kanonikdir və tip düzəldilsin. **Qərar gözləyir (bahaI)** — tapşırıq #73. Körpü tək yerdədir: `handlers/taskFlow.ts:questionText` |

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
