# oneTeam — Məhsul və Texniki Plan (AZ)

> **Status: TƏSDİQLƏNİB və İCRADADIR.** İstifadəçi "başlayaq" dedi.
> İcra vəziyyəti hər iş paketinin yanındaki **Vəziyyət** sütunundadır.

---

## 1. Mövcud vəziyyət — qısaca

| Sahə                          | Hazırdır                                                                                                         | Boşluq                                                                                               | Risk                                                                                                                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **API (NestJS)**              | Mağaza CRUD, tapşırıq axını, çeklist, geofence, audit, foto (R2), status maşını                                  | Admin panel uç nöqtələri (`/api/panel/*`) sadədir (yalnız `me`, `keys`, `logout`)                    | ~~`oneteam-user:` kredensialı `/api/panel/*` girişində qəbul olunurdu~~ — **bağlandı** (1.1)                                                                                                         |
| **Telegram Bot**              | Polling, location + checklist, enrolment, photo                                                                  | Menyular sadə `text`-dir, inline keyboard yoxdur, state idempotent deyil                             | Yeni mağaza yaratma, tapşırıq təyinatı botdan yoxdur                                                                                                                                                 |
| **Web Panel (React)**         | Giriş (şəxsi açar), mağaza siyahısı + CRUD, tapşırıq detalları, şəkil upload                                     | Tapşırıq **yaratma/redaktə** UI tam deyil; rol idarəetməsi yoxdur                                    | Supervayzer rolları yalnız `mayUseRoute`-da yoxlanılır                                                                                                                                               |
| **Mobil (React Native/Expo)** | `portalApi`, headless controller qatı, cihaz identifikasiyası + kredensial saxlancı, offline növbə (**yazıldı**) | **Native kamera yoxdur**, **ekran qatı yoxdur** (3.5), `prebuild` icra olunmayıb, Xcode testi yoxdur | ~~Hər açılışda yenidən enrolment lazımdır~~ — **bağlandı** (3.2). ~~**itirilmiş telefon paneldən kəsilə bilmir**~~ — **bağlandı** (`POST /api/panel/devices/:deviceId/revoke`, 33 yoxlama + 6 pozma) |
| **AI / YOLO**                 | `yolov8n.pt` faylı mövcuddur, `test:ai` skripti işləyir                                                          | **Heç bir SKU/planogram modeli yoxdur** (yalnız COCO), OpenRouter inteqrasiyası yoxdur               | Pulsuz model rate-limit, məxfilik, fallback dəyəri yoxdur                                                                                                                                            |

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
| 2.3 | **Notification:** tapşırıq yaradılması / vaxt bitməsi / rədd 15 dəq əvvəl → `sendMessage` + inline `Open` düyməsi.                                             | Supervayzer panelində yaradanda bot bildiriş alır.                             | 0.5 gün | ✅       |
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

#### 2.3 — nə edildi, nə ilə sübut olundu

**Əvvəlcə ən vacib tapıntı: `NotificationDispatcherService` HEÇ NƏ GÖNDƏRMİRDİ — sadəcə elə
davranırdı ki, guya göndərir.**

`dispatchTaskPublished` `TelegramNotificationPayload` qururdu, onu **ictimai massivə** atırdı
(`dispatchedTelegramMessages`), push üçün APNs yükü düzəldirdi (**nə icazəsi, nə cihaz qeydiyyatı
olan** mobil müştəri üçün), audit yazırdı, `[DISPATCH COMPLETE]` loglayırdı və
`{ telegram: true, pushNotification: true }` qaytarırdı. **Prosesdən bayt çıxmırdı.** Massivlər hər
deploy-da sıfırlanırdı. Çat id kimi **platforma istifadəçi id-si** işlədilirdi
(`task.assignedUserId || '998877665'`). Mətn isə tapşırıqdan asılı olmayaraq hardcode idi
("Classic Beverage, Zero Sugar və Orange Soda"). **İki mövcud dəst bu uydurmanı təsdiqləyirdi və
yaşıl keçirdi** (`phase2.spec.ts` → `telegram === 2`; `integration.spec.ts` → `telegram === true`).

**Nə quruldu — outbox naxışı.** API Telegram-la danışmır: `TELEGRAM_BOT_TOKEN` tək servisdədir və
tapşırıq yaratmaq Telegram-ın əlçatanlığından asılı olmamalıdır. Ona görə API **niyyəti**
`notifications` cədvəlinə yazır, **bot onu boşaldır** — `bot_sessions` ilə eyni forma. Bot yenə də
birbaşa bazaya qoşulmur, Core API-dən keçir.

- **İdempotentliyi YOXLAMA deyil, BAZA təmin edir.** `dedupe_key` UNIQUE +
  `ON CONFLICT (dedupe_key) DO NOTHING`. Vaxt bitmə siyahısı **hər tick** işlədiyi üçün eyni mesajı
  iki dəfə növbəyə qoya bilməz. `SELECT`-sonra-`INSERT` eyni görünür və **yarışır**. Açarlar:
  `TASK_ASSIGNED:<taskId>`, `DEADLINE_SOON:<taskId>`, `TASK_REJECTED:<evidenceId>`.
- **Rədd açarı TAPŞIRIĞIN deyil, SÜBUTUN id-sidir.** `REJECTED → IN_PROGRESS → SUBMITTED → REJECTED`
  qanuni yoldur və hər rədd **başqa foto** haqqındadır; tapşırıq üzrə açarsaq birinci rədd çatar,
  sonrakılar **sükutla udulur**.
- **Götürmə icarədir, oxu deyil.** `claimNotifications` `FOR UPDATE SKIP LOCKED` **və** vaxt möhürlü
  icarə işlədir (`claimed_at` + `leaseSeconds`, default 120) — **tranzaksiya kilidi deyil**, çünki
  göndərmə tranzaksiyadan kənardadır (Telegram-a çağırışdır). Deploy-da iki bot nüsxəsi üst-üstə
  düşür; götürmə olmasa **ikisi də eyni mesajı göndərərdi**. Göndərmə ortasında ölən botun icarəsi
  vaxtı keçir və sətir yenidən əlçatan olur. Təkrar xatırlatma kiçik narahatlıqdır; **itirilmiş**
  xatırlatma isə cədvəlin mövcud olma səbəbidir.
- **`chat_id` növbəyə yazılarkən həll olunur və NULL ola bilər.** NULL = "bu adam bota heç vaxt
  yazmayıb, göndərəcək yer yoxdur". Atılmır, saxlanılır — sükutla silmək vəziyyəti "heç nə olmadı"
  kimi göstərərdi. Belə sətir **heç vaxt götürülə bilməz** (`chat_id IS NOT NULL` tələbi), yəni
  gözləyən mesaj deyil, **qeyddir**.
- **Göndərmə uğursuzluğu iki növdür.** 403 (bot bloklanıb / hesab silinib) və 400 (çat yoxdur)
  **qəti**dir → `markNotificationFailed`. Qalan hər şey — 429, 5xx, `error_code`-suz şəbəkə xətası —
  **təxirə salınır**: heç nə işarələnmir, icarə vaxtı keçir, mesaj təkrar cəhd olunur. Qətisi
  təkrar sayğacı deyil, çünki onları sonsuz təkrarlamaq **heç vaxt boşalmayan növbə** yaradardı.
- **Təmizləmə üç saat işlədir.** `sweepNotifications` (1) çatdırılmış, (2) uğursuz və (3) **`chat_id`
  NULL olan** çatdırılmamış sətirləri silir — üçüncüsü ona görə ki, onlar heç vaxt götürülə bilməz və
  əbədi yığılardı. Çatı olub nə çatdırılmış, nə uğursuz olan sətir isə **heç vaxt** silinmir: o,
  göndərilməmiş mesajdır.
- **Mesaj mətnləri SADƏ MƏTNDİR və bot `parse_mode` göndərmir.** Şablon başlığı supervayzerin
  yazdığı sərbəst mətndir və Telegram-ın köhnə Markdown-u bir uyğunsuz `*` və ya `_` üzündən
  **bütün mesajı** rədd edir — "Zero_Sugar yoxlaması" adlı tapşırıq **heç vaxt çatmazdı**. Qaçış
  (escaping) nə qədər diqqətli olsa da, problemi heç yaratmamaq qədər təhlükəsiz deyil.

**Qəbul meyarı PANEL haqqındadır — və bu seçim əsl qüsur tapdı.** Meyar "supervayzer **panelində**
yaradanda bot bildiriş alır" olduğu üçün dəst tapşırığı `POST /api/portal/tasks` ilə yaradır — yəni
panelin formasının yazdığı yol ilə. Nəticə: **`dispatchToExplicitStores` ümumiyyətlə heç nə növbəyə
qoymurdu.** Onun öz sənəd şərhi "`bulkDispatchTasks`-ı **eynilə** təkrarlayır" deyirdi — kod isə
təkrarlamırdı. Yəni supervayzerin **həqiqətən getdiyi tək yol**, merçendayzerə heç nə deməyən tək yol
idi. Düzəldildi və assertion-la bağlandı.

**Bot tərəfi — `src/bot/notifications.ts`.** `NotificationDrain` növbəni boşaldır: götür → göndər →
işarələ. `ONETEAM_NOTIFY_POLL_MS` (default 5 s, `0` söndürür). Sübut üçün `drainOnce()` **ictimaidir**,
yəni dəst dövrü özü sürə bilir. Düymə yalnız `taskId` varsa qoşulur (`🔓 Tapşırığı aç` →
`open:<taskId>`), çünki boşluğa işarə edən düymə düyməsizlikdən pisdir. Vaxt bitmə siyahısı API-dədir
(`NotificationSchedulerService`, `ONETEAM_NOTIFY_SWEEP_MS`, default 60 s) — botda deyil, çünki bot
bazaya yalnız API-dən çatır.

**Sübut — `npm run test:notify` → 61/0.** Dəst **öz API prosesini qaldırır** (port 3141) və
**real botu** sürür — yalnız `bot.api.config.use` ilə Telegram-ın HTTP API-si əvəzlənib, yəni
`sendMessage` botun öz ara qatından keçir. Yoxlamalar **prosesdən uzun ömürlü** şeylər üzərindədir:
outbox sətri birbaşa `pg` bağlantısı ilə oxunur, göndərmə isə botun özündən.

**Detektoru sındırma — altı iş:**

| Sındırılan şey                               | Nəticə          | Nə qırmızı oldu                              |
| -------------------------------------------- | --------------- | -------------------------------------------- |
| Panel yolu heç nə növbəyə qoymur             | **37/22**       | bütün bildiriş zənciri — və **başqa heç nə** |
| Bot `parse_mode` göndərir                    | **58/1**        | yalnız "və `parse_mode` yoxdur"              |
| Vaxt bitmə açarı hər çağırışda unikal edilir | **53/6**        | məhz altı vaxt bitmə yoxlaması               |
| Götürmə icarəyə baxmır                       | **42/17**       | (assertion düzəlişindən sonra)               |
| Hər göndərmə xətası qəti sayılır             | **56/3**        | məhz üç keçici uğursuzluq yoxlaması          |
| Götürmə `chat_id IS NOT NULL`-ı atır         | **59/0 → 60/1** | **əvvəlcə HEÇ NƏ** — aşağıda                 |

**Ən dəyərli nəticə: 2.3 öz testimdəki İKİ qüsuru üzə çıxardı.**

1. **Beşinci sındırma (icarə) bir assertion-un yalançı yaşıl olduğunu göstərdi.** "İkinci götürmə
   heç nə qaytarmır" yoxlaması `data.length === 0` oxuyurdu — bu isə **endpoint 500 qaytaranda da
   doğrudur** (sadəcə `data` yoxdur). `emptyClaim()` köməkçisi əlavə olundu: `status === 200` **və**
   massivdir **və** boşdur. Düzəlişdən sonra həmin iş **17 qırmızı** verdi — əvvəl sükutla keçən
   yoxlama daxil olmaqla.
2. **Altıncı sındırma TAM YAŞIL keçdi (59/0) — dəstin görə BİLMƏDİYİ bir qoruyucu.** Götürmə
   sorğusundan `chat_id IS NOT NULL`-ı sildim: bot `"null"` çatına göndərməyə çalışardı və **heç nə
   bunu görmədi**, çünki dəstdəki **bütün digər götürmələr çat üzrədir** və çat üzrə götürmə NULL-ı
   bərabərliklə istisna edir. Ona görə son bölmə əlavə olundu — **"botun HƏQİQƏTƏN etdiyi götürmə"** —
   və o, iki yarısını birlikdə yoxlayır: **çatı olan sətirlər gəlir** _və_ **çatsız sətirlər yerində
   qalır**. Təkrar sındırmada **60/1**, qırmızı olan məhz yeni yoxlamadır. ("Heç nə qayıtmadı" birinci
   yarını təkbaşına ödəyərdi — səbəb dəstin bu bölməsinin yazılmasıdır.)

**Öz təmizliyi — və burada `bot:test`-in yeni bir qüsuru tapıldı.** 2.3 `notifications` cədvəlini
gətirdi və o cədvəlin `store_task_id` sütununda **xarici açar qəsdən yoxdur** (`bot_sessions` ilə eyni
səbəb: supervayzer tapşırığı silə bilməlidir). Nəticə: silmə **cascade etmir**, yəni
`bot:test`-in təmizliyi tapşırığı və auditini silirdi, **elə tapşırıq üçün yazılmış bildiriş sətrini
isə yox** — və "🧹 Removed the provisioned task" yazmağa davam edirdi.

**Ölçüldü, güman edilmədi:** bir iş `notifications`-ı **3 sətirdən 4-ə** çıxardı və `audit_logs`-u
**10-dan 12-yə**, halbuki uğur elan edirdi. Düzəlişdən sonra: **4 → 4**, təmiz bazada isə **0 → 0**.
`bot:test` artıq "its queued notice" də silir.

**Eyni boşluq `test:router`-də də vardı** — o da panel vasitəsilə tapşırıq yaradır, tapşırığı,
şablonu və auditləri təmizləyir, bir `TASK_ASSIGNED` sətrini isə buraxırdı; halbuki "every fixture row
this suite created is gone again" yazırdı. Ölçüldü: bir iş `notifications`-ı **0-dan 1-ə** çıxardı.
İndi `notifications` **before/after müqayisəsinin özünə daxildir**, yəni boşluq güman edilmir,
**iddia olunur**. Əlavə olaraq dəst son sayını **API dayandırıldıqdan SONRA** götürür: vaxt bitmə
siyahısı taymerlə işləyir və silinmiş fiksturu bir yenilənmə intervalı boyunca replikada görür — yəni
təmizlik ilə say arasında düşən tick bir sətir daha yaza bilər və "təmiz" yoxlaması **təmizliklə
əlaqəsi olmayan səbəbdən** qırmızı olar. **İşləyən yazıçı "bir daha yazılmayacaq"ı sübut edə bilməz.**

**Daha vacibi — bu, sadəcə test qalığı deyildi, MƏHSUL qüsuru idi.** `deleteStoreTaskRow` tapşırığı
silir, `notifications` sətirlərini isə buraxırdı. Ardıcıllıq adi haldır: supervayzer tapşırığı
paylaşır, fikrini dəyişir, **silir** — bot isə bir an sonra merçendayzerə "sizə tapşırıq verildi"
göndərir və düymənin üzərində **`🔓 Tapşırığı aç`** yazır, `callback_data` isə **artıq mövcud olmayan**
tapşırığın id-sidir. Yəni ən mötəbər kanal adamı **olmayan işə** göndərir və düymə heç nə açmır.
Silinən tapşırığın növbədəki bildirişi **gecikmiş mesaj deyil — YANLIŞ mesajdır**. Hər iki əməliyyat
**bir tranzaksiyada**dır: bildirişlər silinib tapşırıq qalanda **qanuni bildiriş itir**, tapşırıq
silinib bildiriş qalanda isə **yanlış mesaj gedir**; ikisi də qəbuledilməzdir.

**Sübut — `npm run test:notify` → 66/0** (beş yeni yoxlama). **Nəzarət birinci yoxlanılır:** "silmədən
sonra sətir yoxdur" təkbaşına dəyərsizdir — heç nə növbəyə qoymayan tapşırıq da, sükutla uğursuz olan
silmə də onu ödəyərdi. Ona görə əvvəlcə **sətrin həqiqətən orada olduğu** təsdiqlənir. Detektoru
sındırma: bildiriş silməsi söndürüldükdə **65/1** — qırmızı olan məhz "and its queued notice went with
it" və **başqa heç nə**. Dəstin öz təmizlik yoxlaması sındırma boyu **yaşıl qaldı**, çünki öz sətirlərini
tapşırıq id-si ilə silir — yəni məhsul düzəlişindən asılı deyil.

**Açıq qalan (2.3-dən KƏNAR, 2.1-dən bəri mövcud):** `bot:test` hər işdə **2** `TASK_SELF_ASSIGNED`
auditi buraxır. Səbəb: həmin qeyd **mağazanın** id-si ilə yazılır (`entity_id = storeId`), tapşırığın
yox — çünki mövzu "bu mağazanı kim götürdü"-dür. Təmizlik isə `entity_id = ANY([taskId, ...])` ilə
silir, yəni **heç vaxt uyğun gələ bilməz**. İki qeyddən **yalnız ikincisi** `payload.taskIds`-də
tapşırığı adlandırır; birincisi təkcə seed tapşırığını çəkir. Düzəliş "bu iş hansı mağazaya hansı
istifadəçi kimi bağlandı"nı izləməyi tələb edir — **ayrı iş**, texniki borclar cədvəlindədir.

**Regressiya (hamısı yaşıl):** `test:core` 24/24 · `test:phase2` 14/14 · `test:storage` 14/14 ·
`test:ai` 19/19 · `test:flow` 47/0 · **`test:notify` 66/0** · `test:bot-storage` 14/0 ·
`test:router` 67/0 · **bütün `test:live` dəsti:** `test:tasks` 69/0 · `test:stores` 45/0 ·
`test:panel` 58/0 · `test:roles` 78/0 · `test:device` 45/0 · `test:replica` 9/0 ·
`bot:test` **real API-yə qarşı keçir** · hamısından sonra **sıfır bildiriş qalığı** ·
`npx tsc --noEmit` və `prettier --check` təmiz · baza seed vəziyyətinə qaytarıldı.

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

| #   | İş paketi                                                                                                                                                                                                                                                                                                                                                                                                                     | Qəbul meyarı                                                                                                                                                               | Müddət  | Vəziyyət                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------- |
| 3.1 | **Expo config:** `app.json` / `app.config.ts` — `bundleIdentifier`, `name`, `icon`, `splash`, `ios: {supportsTablet: false}`, `plugins: ["expo-camera", "expo-location", "expo-secure-store"]`.                                                                                                                                                                                                                               | `npx expo prebuild --platform ios` → `ios/` qovluğu yaranır, heç bir xəta yoxdur.                                                                                          | 1 gün   | 🔶                                                       |
| 3.2 | **Native camera + secure storage:** `expo-camera` → icazə izahı; `expo-secure-store` → `deviceToken`, `enrollmentSecret` yaz/oxu. Silinmədə `deviceToken` qalır.                                                                                                                                                                                                                                                              | Kamera açılır → şəkil çəkilir → base64 API-yə gedir. Yenidən açılışda enrolment **avtomatik** olur.                                                                        | 1.5 gün | 🔶                                                       |
| 3.3 | **Offline queue (AsyncStorage):** şəkil + metadata lokal növbəyə → onlayn olanda göndərilir. 50 MB limit, avtomatik təkrar cəhd.                                                                                                                                                                                                                                                                                              | Avia-rejimdə 3 şəkil çək → onlayn ol → 3 upload (sıralı).                                                                                                                  | 1 gün   | 🔶 `20a7140`                                             |
| 3.4 | **Xcode test:** `xcodebuild -workspace oneTeam.xcworkspace -scheme oneTeam -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build test` → **UI testləri** (Login → Enroll → Task → Photo → Submit).                                                                                                                                                                                                                   | CI (GitHub Actions) hər PR-da `xcodebuild test` keçir.                                                                                                                     | 1 gün   | 🔶 `21b3b8a` (kod) + `977b232` (lint) + hədəf avtomatdır |
| 3.5 | **~~Mövcud React Native UI saxlanılır~~ — YANLIŞ:** `mobile/src` altında RN kodu yox idi (yalnız `*Controller` sinifləri, JSX/StyleSheet yox). Buna görə **5 ekran sıfırdan yazıldı**: `LoginScreenUI`, `TaskListScreenUI`, `TaskDetailScreen` (+Checklist), `CameraAuditScreenUI`. Naviqasiya üçün `expo-router`/`React Navigation` quraşdırılmadı → `Root.tsx`-də `useState` ekran steki. Dizayn sxemi dəyişməz saxlanıldı. | 5 ekran kod olaraq mövcuddur; real Expo build bu mühitdə mümkün deyil (3.1-dəki toolchain bloku) → "birebir" görünüş təsdiqi bahaI-nin `npx expo prebuild` addımına qalır. | 1.5 gün | 🔶 `27e92e8`                                             |

#### 3.1 — nə edildi, nə ilə sübut olundu (🔶 QİSMƏN)

**Nəticə əvvəlcə:** `mobile/app.json` və `mobile/package.json` planın tələb etdiyi hər açarı daşıyır və
bu, **ölçmə ilə** təsdiqləndi. Amma qəbul meyarının özü — `npx expo prebuild --platform ios` — **bu
mühitdə icra oluna bilmədi**, çünki ~470 paketlik asılılıq ağacı quraşdırıla bilmir. Səbəb təxmin
deyil; ölçüldü.

**Ölçmə: fayl yaratma qaynağı tükənir və bərpa olunmur.**

| Sınaq                                          | Nəticə                                                  |
| ---------------------------------------------- | ------------------------------------------------------- |
| 400 **ardıcıl** `mkdir` (Node, repo daxilində) | ✅ hamısı keçdi                                         |
| 50 **paralel** `mkdir`                         | ✅ keçdi                                                |
| 200 / 500 / 1000 **paralel** `mkdir`           | ❌ `CODEBUDDY_BROKER_DENY`                              |
| Eyni 200 yolu 4 dəfə təkrar                    | ❌ hər dəfə rədd — **qaynaq bərpa olunmur**             |
| Kiçik quraşdırma (`left-pad`, 1 paket)         | ✅ keçdi                                                |
| `npm install` (`mobile/`)                      | ❌ `reify:createSparse` → `mkdir` rədd                  |
| `pnpm install` (`mobile/`)                     | ❌ 458/468 paket endi, `linkNewPackages` → `mkdir` rədd |

npm bütün ağacı **bir** `Promise.all` ilə qurur; pnpm də `linkNewPackages`-də eyni şeyi edir. Kiçik
quraşdırmanın keçməsi **səbəbi görünməz edirdi**: problem paket sayı deyil, **eyni anda göndərilən
əməliyyat sayıdır**. Diaqnostika zamanı qaynaq tam tükəndi — sonra 40-lıq partiyalar da, **təzə
prosesdə də** rədd olundu.

**CocoaPods da quraşdırıla bilmədi.** `brew install cocoapods` →
`sandbox-exec: sandbox_apply: Operation not permitted`. brew öz quraşdırmasını `sandbox-exec` içində
aparır, iç-içə sandbox isə qadağandır. `HOMEBREW_AVOID_NESTED_SANDBOXING=1` (brew-un bunun üçün
nəzərdə tutduğu dəyişən) bu halda kömək etmədi.

**16 sentyabrda yenidən ölçüldü — tıxac Xcode deyil, layihənin yaradılmasıdır.** Ölçmə göstərdi ki,
**Xcode 26.6 quraşdırılıb** (`/Applications/Xcode.app`), `xcodebuild -version` agentin qabığında
**işləyir**, və **iOS 26.5 simulyatorları** hazırdır (iPhone 17 Pro / Air / 17, iPad). Yəni agent
Xcode-u komanda sətri ilə idarə edə bilər. Dəyişməyən tək şey `npm install`-dır: yenidən
`CODEBUDDY_BROKER_DENY` / "Brokered host mkdir requires an available runtime file rule" ilə öldü —
hətta sandbox söndürülmüş halda da. Deməli bu tapıntı köhnəlməyib, sadəcə **bölgü dəqiqləşib**:
insan layihəni yaradır, agent onu build edir. Bunun üçün `scripts/dev/setup-ios.sh` yazıldı
(`342b21c`) — insanın payı bir sətrdir: `bash scripts/dev/setup-ios.sh` (`npm install` → CocoaPods →
`expo prebuild --platform ios --clean` → `mobile/ios/`).

**Bir tələ də ölçüldü:** yarımçıq `npm install` (123/470 paket) `mobile/node_modules/@types/react`-i
boş qoyur, TypeScript isə `@types` altındakı hər şeyi avtomatik yüklədiyi üçün `mobile:check`
`TS2688: Cannot find type definition file for 'react'` ilə **qırmızı** olur. Səbəb kodda deyil,
yarımçıq quraşdırmadadır — qovluq silinəndə yaşıl qayıdır. Ona görə ya quraşdırma **tamamlanmalıdır**,
ya da `mobile/node_modules` **ümumiyyətlə olmamalıdır**; arası yoxdur.

**Buna görə qəbul meyarının toolchain tələb etməyən hissəsi avtomatlaşdırıldı:**
`scripts/dev/verify-mobile-config.mjs` — icrada **23 yoxlama** (3.3-dən sonra **39**). O, `prebuild`-in keçəcəyini **demir**; konfiqurasiyada
uğursuzluğa səbəb olacaq heç nə olmadığını deyir. **Dərhal bir real qüsur tapdı:** ikon RGB yazılmalı
idi (iOS app ikonunda alpha kanalı **qadağandır**), skriptin düzəlişindən sonra yenidən yaradılmamışdı →
`✗ icon has no alpha channel`. Yenidən yaradıldı, indi yaşıldır.

**Yazılanlar:**

- **`mobile/app.json`** — `bundleIdentifier: az.oneteam.retail.fieldaudit`; `ios.supportsTablet:
**false**` (planda belədir, faylda `true` idi); `plugins`: `expo-camera`, `expo-location`,
  **`expo-secure-store`** (əvvəl **yox idi**), `expo-splash-screen`. Kamera/lokasiya icazə mətnləri
  saxlanıldı.
- **`mobile/assets/icon.png`** (1024×1024, **RGB**) və **`splash-icon.png`** (1024×1024, RGBA) —
  `scripts/dev/make-mobile-assets.py` ilə `logo.jpg`-dən düzəldildi.
- **`mobile/package.json`** — SDK 57-nin **rəsmi** versiyaları ilə (aşağıda).
- **`mobile/index.ts`** və **`mobile/Root.tsx`** — tətbiq qabığı.
- **`.gitignore`** — `mobile/ios/` və `mobile/android/` **generasiya olunur**; commit edilmir.
- **`mobile/ios/` git-dən çıxarıldı** — içindəki `Podfile` **sınıq idi** (`react-native-permissions`
  yoluna istinad edirdi, o paket isə repoda yoxdur) və `Info.plist` mövcud olmayan bir Xcode
  layihəsinə aid idi. İkisinin də dəyəri `app.json`-a köçürüldü.
- **`README.md`** — "iOS Native Configuration" bölməsi köhnə vəziyyəti təsvir edirdi; düzəldildi.

**Loqo kvadrat deyildi — ölçüldü, təxmin edilmədi.** `logo.jpg` **690×462**-dir. iOS app ikonunu
kvadrat kətan üzərində maskalayır, ona görə uzanmış mənbə ya rədd olunur, ya da **markanın üzərindən
kəsilir**. Həll loqonu dartmaq deyil: **ölçülmüş** fon rəngində kvadrat kətan düzəltməkdir. Altı kənar
nöqtəsi ölçüldü → hamısı `rgb(240,240,240)`, kanal fərqi **0**. İlk yazdığım `app.json` splash fonu
`#F40009` (oneTeam Retail qırmızısı) idi — boz fonlu loqonu qırmızı sahəyə qoyub **görünən düzbucaqlı**
yaradardı. Ölçmə bir əmrlə bunun qarşısını aldı.

**SDK versiyaları təxmin edilmədi.** npm-də `react-native`-in ən sonu **0.87.1**-dir, SDK 57 isə
**0.86.3** tələb edir. `expo@57.0.22`-nin öz `bundledNativeModules.json` faylı açıldı və versiyalar
oradan götürüldü: `expo-camera ~57.0.5`, `expo-location ~57.0.17`, `expo-secure-store ~57.0.4`,
`expo-splash-screen ~57.0.9`, `expo-status-bar ~57.0.1`, `react 19.2.3`, `react-native 0.86.3`,
`@react-native-async-storage/async-storage 2.2.0` (3.3 üçün).

**`main` sınıq idi.** `package.json` `"main": "src/App.tsx"` deyirdi, `src/App.tsx` isə komponent
deyil, **`MobileAppCoordinator` sinfini** ixrac edir. Heç nə bu sahəni oxumurdu, ona görə heç nə
şikayət etmirdi; Expo onu yüklədiyi anda React render edə bilməyəcəyi bir dəyər alır. `mobile/index.ts`

- `mobile/Root.tsx` elə buna görə yazıldı.

**bahaI-dən tələb olunan üç əmr** (agent mühitində sandbox bunları bloklayır, adi Terminalda
bloklanmır):

```bash
/opt/homebrew/bin/brew install cocoapods  # DÜZ brew — aşağıdakı qeydə bax
cd mobile && npm install                  # ~470 paket
npx expo prebuild --platform ios          # 3.1-in qəbul meyarı
```

> **Ölçülmüş düzəliş (16 sentyabr 2026).** Bu kompüterdə **İKİ Homebrew** var. `brew` komandası
> `/usr/local/bin/brew` (Intel/Rosetta qalığı) tapır və o, Ruby-ni **mənbədən** qurmağa çalışır —
> bu, `pkgconf.rb exited with 71` ilə ölür. Doğru olanı native ARM Homebrew-dur:
> **`/opt/homebrew/bin/brew`** — o, Ruby 4.0.7 və CocoaPods 1.17.0-ı hazır paket (bottle) kimi
> quraşdırır, 35 saniyə çəkir. Sistem Ruby-si 2.6.10-dur və `gem install cocoapods` onunla
> **mümkün deyil** (`ffi` Ruby ≥ 3.0 tələb edir).
> Bu gün ölçülən iş bölgüsü: `pod install` **uğurla bitdi** (`EXIT=0`,
> `ios/oneTeamFieldAudit.xcworkspace` yarandı), amma `xcodebuild` agent mühitində **ölür** —
> bax: 3.4.

Sonra `node scripts/dev/verify-mobile-config.mjs` ilə konfiqurasiya yenidən yoxlanıla bilər.

**Növbəti bəndlərə təsir edən tapıntılar (ölçüldü, düzəldilmədi):**

1. **`EXPO_PUBLIC_` prefiksi yoxdur.** `mobile/src/services/portalApi.ts` `process.env.ONETEAM_API_URL`
   oxuyur, Expo/Metro isə `process.env`-i **yalnız `EXPO_PUBLIC_*` adları üçün** build zamanı yerinə
   qoyur. Nəticə: real build-da dəyər `undefined` olur və ünvan **sükutla `http://localhost:3001`**-ə
   düşür. `const env = process.env` alias-ı vəziyyəti pisləşdirir — Metro yalnız `process.env.X`
   şəklindəki ifadəni yerinə qoyur. **3.2-də düzəldilməlidir** (`EXPO_PUBLIC_ONETEAM_*` adları birbaşa
   oxunmalıdır).
2. **`OfflineQueueManager` yaddaşdadır, README isə əksini deyir.** `mobile/src/services/offlineQueue.ts`
   `private queue: QueueItem[] = []` saxlayır — **heç bir saxlanc yoxdur**. `triggerAutoSync()` isə
   **boş metoddur**: `setOnlineStatus(false→true)` onu çağırır, o isə heç nə etmir. README
   ("Submissions are queued securely in local storage", "Automatically detects network reconnection and
   triggers background uploads") hər iki halda **yanlışdır**. 50 MB limit də yoxdur. Yəni 3.3 "mövcud
   queue-nu AsyncStorage-a köçürmək" deyil, **queue-nu yazmaqdır**.
3. **3.5-in öz müqəddiməsi yanlışdır.** "Mövcud React Native UI saxlanılır" deyir, amma `mobile/src`
   altında **bir sətir də RN kodu yoxdur**: `react-native` importu yox, JSX yox, `StyleSheet` yox. Bütün
   "ekranlar" `*Controller` sinifləridir. Saxlanılacaq UI **yoxdur** — Login, TaskList, TaskDetail,
   Checklist və Camera ekranları **yazılmalıdır**. Bu, 3.5-i "quraşdırma"dan "ekranları yazmaq"a
   çevirir və **ölçüsünü böyüdür**.
4. **`mobile/Root.tsx` tiplə yoxlanılmır.** `mobile/tsconfig.json` yalnız `src` ağacını əhatə edir;
   `Root.tsx` isə `react-native` idxal edir, hansı ki quraşdırılmayıb. Onu `src/` altına qoysaydım,
   `npm run mobile:check` **heç nə ilə əlaqəsi olmayan səbəbdən** qırmızı olardı. Ona görə fayl paket
   kökündədir və **bu boşluq gizlədilmir: `npm install`-dan sonra `include`-a `index.ts` və `Root.tsx`
   əlavə olunmalıdır.**

#### 3.2 — nə edildi, nə ilə sübut olundu (🔶 QİSMƏN)

**Nəticə əvvəlcə:** açarın (kredensialın) saxlanması qatı yazıldı və **37 yoxlama** ilə sübut olundu;
hər qayda **detektoru pozmaqla** yoxlanıldı — 13 pozma, 13-ü də **öz** yoxlamasını qırmızı etdi
(`npm run test:break:credentials`; harness **repodadır**). Amma
qəbul meyarının ~~**kamera yarısı icra olunmadı** (`expo-camera` hələ quraşdırılmayıb, çəkiliş hələ də
`simulated`-dur və bunu açıq deyir)~~ — **kamera yarısı 20 sentyabr 2026-da icra olundu**: məlum oldu ki
`expo-camera` (57.0.5) və `expo-location` (57.0.18) **artıq tətbiqə yığılmışdı** (`ios/Podfile.lock`),
yəni yenidən qurmaq lazım deyildi, yalnız kod. İndi ekran real `CameraView` render edir, baytları
`captureLiveAudit`-ə ötürür və baytsız çəkiliş **rədd olunur**. Qalan tək maneə: **əsl iOS açar
saxlayıcısı bu mühitdə yoxlanıla bilməz**. Ona görə 3.2 hələ də ✅ deyil, 🔶-dir — amma səbəb artıq
kamerasız deyil, **yalnız cihazdaki açar saxlayıcısıdır** (§9.1-dəki dörd saxta məhz bu boşluqda yaşayırdı).

**Ən böyük tapıntı: hər quraşdırma EYNİ cihaz idi.**

`portalApi.ts`-də bu sətir var idi:

```ts
return (env.ONETEAM_DEVICE_ID || 'demo-device-01').trim();
```

Şərh özü təhlükəni **adlandırırdı** ("iki cihaz eyni default id-ni paylaşsa, eyni identifikasiya və eyni
audit tarixçəsini paylaşar") və yenə də belə göndərilmişdi — çünki real identifikasiyanı qoymaq üçün
**saxlanc qatı yox idi**.

Təhlükə o cümlədən **daha pis**dir. Baza `device_id` üzrə **yalnız BİR canlı token** saxlayır:

```sql
CREATE UNIQUE INDEX device_tokens_active_device_idx ON device_tokens (device_id) WHERE revoked_at IS NULL;
```

və `insertDeviceToken` yeni sətri yazarkən **köhnəsini həmin tranzaksiyada ləğv edir**. Yəni:

- bir dəploymentdə konfiqurasiya olunmamış **hər telefon eyni cihaz** idi — bir istifadəçi sətri, bir
  audit tarixçəsi;
- hər qeydiyyat **digərlərini sükutla çıxarırdı**. İki merçendayzer bir yerdə növbəyə başlasa, **ikisi
  də daxil ola bilmirdi**;
- `getSubmissionsForStore` "bu cihazın təqdim etdiyi auditi" soruşur, **hamınınkını** alırdı.

**Düzəliş:** identifikasiya **bir dəfə** yaradılır və **saxlanılır**; `deviceId()` artıq uydurmur —
`DEVICE_ID_NOT_RESTORED` **atır**. Kimsə açarı oxumayıbsa, dürüst cavab "mən hələ cihaz deyiləm"dir.

**İki şeyi ayırmaq qaydası (kodda və testdə yazılıb):**

|                                     | İdentifikasiya (`deviceId`)                                     | Kredensial (`deviceToken`)                     |
| ----------------------------------- | --------------------------------------------------------------- | ---------------------------------------------- |
| Nə vaxt dəyişir                     | **heç vaxt**                                                    | **hər qeydiyyatda** (server köhnəni ləğv edir) |
| İtirməyin qiyməti                   | cihazın **bütün audit tarixçəsi** + mağazanın yeni-cihaz limiti | **bir** qeydiyyat                              |
| "Lokal məlumatı təmizlə" onu silir? | **XEYR**                                                        | **XEYR** (qəsdən)                              |

**Açar saxlayıcı `WHEN_UNLOCKED_THIS_DEVICE_ONLY`.** Cihaz kredensialı bir quraşdırmaya aiddir və server
onu başqa quraşdırma adına qəbul etmir, ona görə onu iCloud-a sinxronlaşdırmaq **yalnız işləməyən**
kredensial yarada bilər — və `device_id` üzrə bir canlı token qaydasına görə, bərpa olunan nüsxə
**əsl telefonu çıxarardı**. `ALWAYS` deyil, `WHEN_UNLOCKED`: bu tətbiq yalnız ekran açıqkən işlənir.

**Saxlanc interfeys kimi (`SecureKeyValueStore`).** Siyasət `credentialStore.ts`-dədir və saxlancı
**kənardan alır**; `keychain.ts` isə iOS-u verir. Bu ayrılıq siyasəti **telefonsuz** yoxlanıla bilən edir
— və `demo-device-01` məhz buna görə bu qədər yaşadı: siyasət `expo-secure-store`-u özü idxal etsəydi,
**heç nə onu test edə bilməzdi**.

**Tapıntı → bağlandı: cihaz açarını ləğv edən route artıq VAR.** Əvvəl `panel-auth.controller.ts`-də
`keys/:prefix/revoke` və `users/:userId/revoke-keys` var idi — **ikisi də panel açarları üçün**. Cihaz
kredensialını ələ keçirməyin iki yolu var idi, ikisi də baha: (a) cihaz özü yenidən qeydiyyatdan keçsin —
**telefon lazımdır**; (b) istifadəçi silinsin — audit təqdim etmiş merçendayzer üçün
**`409 USER_HAS_SUBMISSIONS`** bloklayır. Yəni **itirilmiş telefonu paneldən kəsmək mümkün deyildi.**
(_Öz şərhimdə əvvəlcə mövcud olmayan bir route adı yazmışdım; koda baxıb düzəltdim._)

**İndi:** `GET /api/panel/devices` (cihazları sadalayır, ləğv olunmuşlar **daxil**) və
`POST /api/panel/devices/:deviceId/revoke` (canlı kredensialı kəsir). Rol qapısı **supervayzer**-dir,
admin deyil: itirilmiş telefon **təcili** haldır və admin gözləmək yanlış olardı. İkinci ləğv
**`404 DEVICE_NOT_FOUND`** qaytarır — "kəsdim" və "canlı heç nə yox idi" **fərqli cümlələrdir**. Ləğv
olunmuş sətir **siyahıda qalır** (`revokedAt` ilə), çünki bu, audit izidir. Hərəkət
`DEVICE_CREDENTIAL_REVOKED` kimi audit-ə yazılır. Route **mağaza üzrə məhdudlaşdırılmamışdır** — kod
bazasında supervayzerə mağaza çoxluğu verən heç nə yoxdur; bu, gizlədilməyib yazılıb.

**Sübut:** `npm run test:device-revoke` → **33 yoxlama, 0 uğursuz, 0 atlandı**; `npm run
test:break:device-revoke` → **6 hal, hamısı öz yoxlamasını qırmızı etdi**. Pozma harness-ı **repodadır**
(`scripts/dev/break-detector-device-revoke.mjs`), `/tmp`-də deyil.

**Harness öz işini gördü — D6 əvvəlcə TUTMADI.** Sərhəd yoxlaması açarlar qoşulduqdan _sonra_ işləyirdi,
panel kilidli idi, və cihaz kredensialı **başqa səbəbdən** eyni 403-ü alırdı — yəni qoruyucu silinsə də
yoxlama **yaşıl qalırdı**. Düzəliş: yoxlama **heç bir açar qoşulmadan əvvəl** işləyir, orada iki imtina
(`PANEL_KEY_REQUIRED` və `SUPERVISOR_REQUIRED`) **ayırd edilir**; panel artıq kilidlidirsə, yoxlama
**ucadan atlanır**. Qeyd: `format:check` harness-in `find` sətirlərini **etibarsız edir** — formatlamadan
sonra harness yenidən işlədilməlidir.

**Yazılanlar:**

- **`mobile/src/services/credentialStore.ts`** (yeni) — siyasət: identifikasiya bir dəfə, yazmadan əvvəl
  saxlama, hər qeydiyyatda kredensialı **əvəz etmək**, boş kredensialı **rədd etmək**, təmizləmədə
  identifikasiyanı **saxlamaq**, `snapshot()` heç vaxt sirri qaytarmır.
- **`mobile/src/services/keychain.ts`** (yeni) — iOS açar saxlayıcısı, üç sətirlik adapter + qərarların izahı.
- **`mobile/src/services/credentialStore.test.ts`** (yeni) — **37 yoxlama**, 5 bölmə.
- **`mobile/src/services/portalApi.ts`** — `restoreCredential()`, `forgetCredential()`, `EnrollmentOutcome`
  (`credentialPersisted`), `currentDeviceId()`; `deviceId()` artıq **atır**.
- **`mobile/src/App.tsx`** — `initializeCredentials()`, `clearLocalData()` (lokal məlumatı təmizləyən
  **yeganə yer**; açar saxlayıcıya toxunmur).
- **`mobile/Root.tsx`** — açar saxlayıcını qoşur və başlanğıcda açarı oxuyur. **Əvvəl heç nə `keychain.ts`-i
  idxal etmirdi**, yəni 3.2-nin bütün mənası **işlək deyildi**: saxlanc yaddaşda qalırdı və tətbiq hər
  açılışda yenidən qeydiyyatdan keçərdi.
- **`mobile/tsconfig.json`** — `keychain.ts` tip yoxlamasından **çıxarıldı** (paket quraşdırılmadığı üçün).
  Əl ilə `declare module` yazmaq **rədd edildi**: belə bəyannamə kodun özü ilə **eyni yaddaşdan** yazılardı,
  yəni tuta biləcəyi yeganə şeyi — yanlış API çağırışını — **tuta bilməzdi**.
- **`scripts/dev/verify-mobile-config.mjs`** — **6 yeni yoxlama** (icrada 23 → **29**): `tsconfig`
  istisnasının həqiqətən tək faylı əhatə etdiyi **və** `Root.tsx`-in qoşulmanı saxladığı.
- **`mobile/src/tests/mobile-test-runner.ts`** — başlanğıcda `restoreCredential()`; harness özünü
  `ONETEAM_DEVICE_ID` ilə **sabit** adlandırır (`test-device-mobile`). Əvvəl hər iş **`demo-device-01`**
  kimi qeydiyyatdan keçirdi; indi hər iş təzə identifikasiya yaradıb bazaya **xəyal cihaz** yığmır.
- **`package.json`** — `test:credentials`; `test:all`-a əlavə olundu (yəni `quality` onu tutur);
  `quality`-yə `mobile:check` əlavə olundu (əvvəl **yox idi** — mobil mənbə qapıdan keçmirdi).

**Sübut: 37 yoxlama + 13 pozma.**

| Bölmə | Nə yoxlanılır                                                                                                                                   | Yoxlama |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 0     | Açar oxunmadan əvvəl: `deviceId()` **atır**, uydurmur                                                                                           | 2       |
| 1     | İdentifikasiya bir dəfə yaradılır, saxlancda qalır, iki quraşdırma **fərqli** id alır, paralel çağırışlar tək id alır, uğursuzluq **keşlənmir** | 9       |
| 2     | Kredensial saxlanılır / **əvəz olunur** / boş **rədd olunur**; təmizləmə identifikasiyanı **saxlayır**; `snapshot()` sirri qaytarmır            | 11      |
| 3     | `clearLocalData()` növbəni təmizləyir, kredensialı **və identifikasiyanı saxlayır**                                                             | 5       |
| 4     | `restoreCredential` / `forgetCredential` / `deviceId` naqilləri                                                                                 | 6       |
| 5     | `ONETEAM_DEVICE_ID` harness üstlüyü: işləyir, saxlancı **üstündən yazmır**, götürüldükdə cihaz **öz** identifikasiyasına qayıdır                | 4       |

Pozma halları (`npm run test:break:credentials`): default-un qayıtması · identifikasiyanın yazılmaması ·
uğursuzluğun keşlənməsi · təmizləmədə identifikasiyanın silinməsi · növbənin təmizlənməməsi ·
`forgetCredential`-ın saxlanca toxunmaması · üstlüyün sayılmaması · boş kredensialın qəbulu ·
`snapshot()`-ın sirri sızdırması · `Root.tsx`-in açar saxlayıcını qoşmaması · `Root.tsx`-in açarı
oxumaması · `tsconfig` istisnasının götürülməsi · `src/` altında **ikinci** native idxalçının yaranması.

**Harness sonradan repoya köçürüldü** (əvvəl `/tmp/break-detector.mjs` idi və zəif idi — borc cədvəlinə
bax): `scripts/dev/break-detector-credentials.mjs`, `npm run test:break:credentials`. Hər hal indi
**öz** yoxlamasını adba-ad göstərir və üstünə **baza yoxlaması** əlavə olundu.

**Pozma yoxlaması öz dəstimdə bir deşik tapdı.** "Təmizləmə identifikasiyanı saxlayır" qaydasını
pozduqda dəst **34/34 yaşıl** qaldı. Səbəb: `deviceId()` cavabı **keşləyir**, ona görə "identifikasiya
sağ qaldımı?" sualını **eyni obyektə** verirdim — o isə cavabı artıq bilirdi. Yəni qayda **heç
yoxlanılmırdı**, sadəcə yaşıl görünürdü. Düzəliş: sual **təzə** obyektə verilir (`restartOf`) — bu,
"növbəti açılış" deməkdir. Dəst 34 → **37** oldu və pozma indi **qırmızı** verir.

**Köçürmə zamanı yeni bir deşik sinfi üzə çıxdı: köhnəlmiş hal.** Harness repoya salınanda iki hal artıq
kodu təsvir etmirdi — E halı 3.3-də yenidən yazılmış `App.tsx`-i, L halı isə ikinci fayl əlavə olunmuş
`exclude` siyahısını gözləyirdi. Köhnə harness bunları **sükutla "nəticə"** kimi çap edərdi; yeni harness
hər `find` üçün **tam bir uyğunluq** tələb edir və ikisini də ayrıca `PATCH-FAILED` kimi sayır — yoxlanıldı:
E-nin köhnə mətni geri qoyulanda harness `PATCH-FAILED` verir və **sıfırdan fərqli** çıxır.

**Hələ sübut olunmayanlar (gizlədilmir):** kamera (`expo-camera` quraşdırılmayıb; çəkiliş simulyasiyadır
və bunu deyir) · **əsl iOS açar saxlayıcısı** (`keychain.ts` native modul idxal edir, Node altında
yüklənə bilmir — dəst onu **idxal etmir** və bunu çap edir) · `npx expo prebuild --platform ios` hələ
də icra olunmayıb (3.1-dəki üç əmr gözləyir).

**Növbəti bəndlərə təsir:** `EXPO_PUBLIC_` prefiksi **3.2-də düzəldilmədi** — borc 3.3-ə keçdi və **3.3-də
düzəldildi**. `mobile:test` indi `test-device-mobile` identifikasiyası ilə işləyir, yəni canlı dəst bazada
**sabit** bir cihaz saxlayır.

#### 3.3 — nə edildi, nə ilə sübut olundu (🔶 QİSMƏN)

**Nəticə əvvəlcə:** növbə **yazıldı** — köçürülmədi, çünki 3.1 ölçdü ki, saxlanc heç yox idi. **83 yoxlama**
ilə sübut olundu və **23 pozma**nın **23-ü də** öz yoxlamasını qırmızı etdi. Qəbul meyarının **avia-rejim
yarısı icra olunmadı**: `@react-native-async-storage/async-storage` quraşdırılmayıb, ona görə növbənin
cihazda işləməsi yoxlanılmadı — dəst **yaddaş adapterini** yoxlayır və bunu özü çap edir.

**Üç yalan düzəldildi — hamısı 3.1-də ölçülmüşdü, indi kodla bağlandı:**

| Əvvəl (ölçülmüş)                                               | İndi                                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `private queue: QueueItem[] = []` — **heç bir saxlanc yoxdur** | `QueueStorage` arakəsməsi; `queueStorage.ts` AsyncStorage verir; `Root.tsx` qoşur və `load()` çağırır               |
| `triggerAutoSync()` **boş metoddur** (çağırılır, heç nə etmir) | `setOnlineStatus(false→true)` həqiqətən drain edir; `autoSync` promise-i **gözlənilə bilər**, ona görə sübut olunur |
| **50 MB limit yoxdur**                                         | `MAX_QUEUE_BYTES`; limit **yeni auditı rədd edir**, köhnəsini **silmir**                                            |
| README: "queued **securely** in local storage"                 | README düzəldildi — AsyncStorage **şifrələnmir** (aşağıda borc kimi)                                                |
| README: "automatically detects network reconnection"           | README düzəldildi — taymer **yoxdur**: qoşulma, ya da əl ilə sinxronizasiya                                         |

**Dörd davamlılıq qaydası** — hər biri auditin **itməsi** və ya **təkrarlanması** yoludur:

1. **`persist()` gözlənilir və atır.** Diskdə olmayan növbə növbəyə salınmayıb; yazı düşməsə, element
   **yaddaşdan geri qaytarılır** və çağırana deyilir ki, **növbəyə salınmadı**. Bu, baza qatındaki
   `enqueue` qaydasının eynisidir.
2. **50 MB limiti YENİ elementi rədd edir.** Ən köhnəni **silə** də bilərdi; silmədi, çünki ən köhnə element
   kiminsə auditidir və sükutla yox olması bu növbənin mövcudluq səbəbidir.
3. **`syncing` işarəsi yükləmədən ƏVVƏL diskə yazılır**, element isə uğurdan **sonra** silinir. Arada proses
   ölsə, növbə "toxunulmamış" görünmür — **nəyin uçduğunu** yazır.
4. **Yarımçıq element avtomatik təkrar cəhdə QAYTARILMIR.** `syncing`-də qalan element `failed` kimi
   bərpa olunur, `retry_count` həddə qoyulur və mesaj deyir ki, **o, artıq qeydə alınmış ola bilər**.
   Səbəb ölçüldü, təxmin edilmədi: **API-də təkrar təqdimata qarşı qoruyucu yoxdur** —
   `EvidenceService.submitEvidence` qeydi şərtsiz yaradır, yalnız status keçidi şərtlidir. Ona görə
   "yenidən cəhd et" **ikinci evidence sətri** yaradardı.

**`EXPO_PUBLIC_` borcu bağlandı (3.1-dən qalan).** `portalApi.ts` ünvanı artıq **birbaşa member
ifadəsi** kimi oxuyur (`process.env.EXPO_PUBLIC_ONETEAM_API_URL`). Bu vacibdir, çünki Metro mətnin
**özünü** yerinə qoyur: `process.env[ad]` və `const env = process.env` alias-ı **heç vaxt** əvəz
olunmur, yəni real build-da ünvan **sükutla `http://localhost:3001`**-ə düşürdü. **Yalnız ünvanın
publik adı var** — `ONETEAM_DEVICE_TOKEN`, `ONETEAM_DEVICE_ID` və `ONETEAM_ENROLLMENT_SECRET`
alias-dan oxunur və `mobile:config` **qadağan edir** ki, onlardan biri `EXPO_PUBLIC_` adı alsın
(belə ad IPA-nın içindən çıxarıla bilər).

**Yoxlama dəsti (`npm run test:queue`) — 83 yoxlama:**

| Bölmə | Nə yoxlanılır                                                                                       | Yoxlama |
| ----- | --------------------------------------------------------------------------------------------------- | ------- |
| 0     | Oxunmadan əvvəl növbə **rədd edir**, boş massiv qaytarmır (ən əvvəl işləyir)                        | 4       |
| 1     | Yazı gözlənilir; uğursuzluqda **geri qaytarılır**; **təzə** menecer auditi görür                    | 8       |
| 2     | `utf8Bytes` düzgünlüyü + limit **rədd edir, silmir** + tək elementdən böyük audit da rədd olunur    | 9       |
| 3     | Sıra, `syncing` işarəsinin **diskdə** olması, silmənin yazılması                                    | 8       |
| 4     | Uğursuz yükləmə növbədə qalır: status, `retry_count`, səbəb — **diskdə də**                         | 6       |
| 5     | Avtomatik cəhd həddə dayanır; **əl ilə** sinxronizasiya həddi saymır                                | 6       |
| 6     | Qoşulma **həqiqətən** drain edir; handler yoxdursa `no-handler`; xəta **unhandled rejection olmur** | 9       |
| 7     | Proses ölən element `queued` kimi **qaytarılmır**; avtomatik drain onu **keçir**                    | 12      |
| 8     | Zədəli payload **atılmır**, bildirilir; yalnız düzgün elementlər qəbul olunur                       | 6       |
| 9     | Təmizləmə **diski** təmizləyir və sayı qaytarır                                                     | 5       |
| 10    | Naqil: koordinator handler-i qeyd edir; `clearLocalData` növbəyə **çatır**                          | 5       |
| 11    | Saxlanc açarı sabitdir (dəyişsə, sahədəki bütün auditlər yetim qalar)                               | 2       |

**Pozma halları** (`npm run test:break`, 23 hal): oxunmadan cavab vermə · geri qaytarmama ·
yazı xətasını udmaq · limitin işləməməsi · limitin **köhnəni silməsi** · `syncing` işarəsinin yazılmaması ·
nəticənin yazılmaması · avtomatik həddin sayılmaması · əl ilə həddin sayılması · qoşulmanın drain etməməsi ·
handler-sizin sükuta dönməsi · yarımçıq elementin `queued` qaytarılması · zədənin bildirilməməsi · zədəli
elementin qəbulu · təmizləmənin yazılmaması · surrogate cütünün 2 bayt sayılması · saxlanc açarının
dəyişməsi · handler-in qeyd olunmaması · saxta "təmizləndi" sayı · `queueStorage` istisnasının götürülməsi ·
`Root.tsx`-in AsyncStorage-ı qoşmaması · `EXPO_PUBLIC_` ifadəsinin alias-a çevrilməsi · **sirrə publik ad
verilməsi**.

**Pozma yoxlaması bu dəfə də öz dəstində bir deşik tapdı.** Q14-də (`looksLikeQueueItem` qoruyucusu)
dəst **yaşıl qaldı**: qoruyucu götürüləndə zədəli elementlər növbəyə düşür və `null` üzərində
`sync_status` oxunması **atır** — yəni `load()` reject olur, yoxlama isə **heç vaxt işləmir**. Düzəliş:
yoxlama `load()`-u `caught()` ilə tutur, ona görə həmin qəza **öz yoxlamasının qırmızısı** olur.

**Pozma harness-ının özü üçüncü dəfə yalan dedi.** Q9-un ilk yamağı sintaksis xətası yaratdı; hədəf
**bir sətir də check çap etmədən** öldü — və "qırmızı sətir yoxdur" "dəst yaşıl qaldı" ilə eyni görünür.
Harness bunu **deşik** kimi bildirdi; deşik yox idi. Ona görə harness indi hədəfin **yekun sətrinə
çatdığını** tələb edir (`N checks: M passed` / `All config checks passed.`), əks halda həmin halı
**sübut saymır**. Bu, 3.2-də tapılan iki yalanın yanında **üçüncüsüdür** və `TESTING.md`-ə əlavə olundu.

**Harness indi REPODADIR.** 3.2 və 3.3-ün harness-ları `/tmp`-də yazılmışdı — yəni sübut **yenidən icra
oluna bilmirdi** və maşın təmizlənəndə **itəcəkdi**. 3.3-də bu bağlandı: `scripts/dev/break-detector-queue.mjs`

- **`npm run test:break`** (yol faylın öz yerindən törədilir). `quality`-yə **salınmadı**, çünki qəsdən kodu
  sındırır — nəzarətli əməliyyatdır. Commit: `20a7140`.

**3.2-nin harness-ı da repoya köçürüldü.** İndi `scripts/dev/break-detector-credentials.mjs` →
**`npm run test:break:credentials`**. Dörd zəiflik bağlandı: hər hal üçün **gözlənti** (`expect` — "nə isə
qızardı" yox, **hansı** yoxlamanın qızarması), **`COMPLETION`** yoxlaması (hədəf öz yekun sətrinə çatmalıdır,
yoxsa sintaksis xətası "deşik" kimi oxunur), **tək uyğunluq** yoxlaması (`find` tam bir dəfə tapılmalıdır),
və **çıxış kodu** (sıfırdan fərqli — commit/CI qapısı kimi işlədilə bilər). Əlavə olaraq **baza yoxlaması**:
heç nə pozulmadan əvvəl hər iki hədəf yaşıl deyilsə, aşağıdaki nəticələrin **heç biri** şərh oluna bilməz.

Nəticə: **13/13 hal öz yoxlamasını qırmızı etdi**, baza və bərpa sonrası hər iki hədəf yaşıl, `mobile`
faylları toxunulmamış qalır (`git status` təsdiqləyir — harness hər halda faylları geri qaytarır).
`test:all`-a və `quality`-yə **salınmadı**: reponun öz qaydası budur — CI **dəstləri** işlədir
(`test:all`-da `test:credentials` var), pozma harness-larını yox. Bunu CI-a salmaq **qərar gözləyir**
(bahaI): faydası budur ki, dəstin qorumağı dayandırdığı anda qapı bağlanır; qiyməti budur ki, dəstdə hər
ad dəyişikliyi CI-ı qırmızı edir.

**Hələ sübut olunmayanlar (gizlədilmir):** **AsyncStorage-ın özü** (`queueStorage.ts` native modul
idxal edir, Node altında yüklənə bilmir — dəst onu **idxal etmir** və bunu çap edir) · növbənin **real
cihazda** avia-rejimdə sınanması (üç şəkil → onlayn → üç sıralı upload) · `npx expo prebuild --platform
ios` hələ də icra olunmayıb (3.1-dəki üç əmr gözləyir).

#### 3.5 — nə edildi, nə ilə sübut olundu (🔶 QİSMƏN)

**Nəticə əvvəlcə:** 3.5-in plan premissi ("Mövcud React Native UI saxlanılır") **yanlış idi** — 3.1 və 3.5 qeydində artıq yazılmışdı ki, `mobile/src` altında **bir sətir də RN kodu yoxdur**. Bütün "ekranlar" yalnız başsız `*Controller` sinifləridir. Ona görə 3.5 "quraşdırma" deyil, **5 ekranın sıfırdan yazılması** oldu (`27e92e8`).

**Yazılanlar:**

- **`mobile/src/screens/LoginScreenUI.tsx`** (yeni) — `LoginScreenController`-i render edir. Mağaza kodu üçün `TextInput`; GPS **simulyasiya** olunur (1.5 s sonra düzəlir); "Daxil ol" düyməsi yalnız `gps !== null && storeCode.trim().length > 0` olduqda aktivdir.
- **`mobile/src/screens/TaskListScreenUI.tsx`** (yeni) — `TaskListController`. `FlatList` prioritet nişanı ilə (urgent=qırmızı, high=narıncı, normal=boz), pull-to-refresh (`RefreshControl`), loading/error/empty halları.
- **`mobile/src/screens/TaskDetailScreen.tsx`** (yeni) — `TaskDetailController` + Checklist-i **bir** ekrana birləşdirir. Hər çeklist sualı üçün `TextInput`; "📷 Kamera aç" düyməsi **bütün suallar cavablanmayınca** boz/söndürülüdür. `ChecklistAnswer` tipi ixrac olunur.
- **`mobile/src/screens/CameraAuditScreenUI.tsx`** (yeni) — `CameraAuditController`. Simulyasiya önizləmə (rule-of-thirds grid, ghost/grid açarları), sonra **review** vəziyyəti (çəklist cavablarının xülasəsi + metadata + Yüklə/Təkrar çək). `captured.simulated` olduqda **banner** göstərilir.
- **`mobile/Root.tsx`** (yenidən yazıldı) — status qabığı deyil, **ekran routeri**: login → taskList → taskDetail → camera → geri. Naviqasiya `useState` ekran steki ilədir, **`expo-router`/`React Navigation` yox** (o asılılıq ağacı burada quraşdırıla bilməz — 3.1-dəki toolchain bloku).

**Kamera GSIMULATED-dir** (3.2-dəki kimi): `expo-camera` quraşdırılmayıb, `CameraAuditController.captureLiveAudit` `simulated: true` qaytarır və bunu açıq deyir. Real çəkiliş bahaI-nin `npx expo prebuild` addımıla gəlir.

**Qəbul meyarının "birebir görünür" hissəsi sübut oluna bilmədi:** real Expo build bu mühitdə mümkün deyil. **Qapılar yaşıl (5/5):** `mobile:check` (tsc), `mobile:config` (39 yoxlama), `test:credentials` (37), `test:break:credentials` (13/13), `prettier --check` — hamısı exit 0. İlk yazılışda `mobile:check` qırmızı idi: JSX-də **real tipl səhvləri** vardı — `ChecklistQuestion` `../types`-dən ixrac olunmurdu (o, `@oneteam/types`-dədir), `PlanogramRule` sahə adları səhv idi (`sku_name`/`min_facings`/`cooling_required` əvəzinə `sku`/`label`/`minFacings`; `maxFacings`/`cooling_required` mövcud deyil), və `ChecklistQuestion.question` seçimli olduğundan `?? q.label ?? ''` lazım idi. Bunlar düzəldildi və 4 `*UI.tsx` faylı `tsconfig` `exclude`-na əlavə olundu (`Root.tsx` kimi — `react-native` bu mühitdə quraşdırılmayıb). Pozma harness-ı **case K və case L**-i yenidən yazılmış fayllara uyğunlaşdırdı (stale break-case təhlükəsi təsdiqləndi: `find` uyğunluğu 0 oldu, düzəldildi).

**Sübut olunmayanlar (16 sentyabr 2026 saat 18:09-a olan vəziyyət):** tip yoxlaması artıq
**həqiqətən işləyir** — CI `npm ci` quraşdırır, `mobile/tsconfig.json`-dakı exclude sırf native
modullar üçündür (5 ekran artıq daxildir) və `mobile:check` ekran fayllarını yoxlayır
(commit `48d536c`); `useState` naviqasiyasının vizual təsdiqi isə **var**: tətbiq simulyatorda
işə düşdü, giriş ekranı Azərbaycan mətni ilə göründü, GPS simulyasiyası işlədi, düymə aktivləşdi
(`~/sim-login3.png`). `taskList`/`taskDetail`/`camera` ekranlarının real naviqasiyası API
bağlantısını tələb edir (18 sentyabr `20a7140`-də planlaşan canlı yoxlama üçün nəzərdə tutulub).

**3.4 (Xcode UI testi) — 16 sentyabr 2026.** UI test hədəfi artıq **əl ilə yaradılmır,
avtomatik yaranır.** Səbəbi sadədir: `ios/` qovluğu generasiya olunur — Xcode-da əl ilə
yaradılan hədəf növbəti `expo prebuild`-də yox olur və CI maşınında heç vaxt mövcud olmur.
Ona görə hədəf konfiq plugin-in içindədir.

| Addım                                       | Nəticə                                                                                             |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Tətbiq qurulur + işə düşür                  | ✅ `bash scripts/dev/build-ios.sh` → `BUILD SUCCEEDED`; simulyatorda açılır (`~/sim-login3.png`)   |
| `testID` müqaviləsi                         | ✅ 7 identifikator + hər iki istiqamətli yoxlayıcı (`scripts/quality/ui-test-ids.mjs` + self-test) |
| XCTest skeleti                              | ✅ `mobile/uitests/FieldAuditUITests.swift` (4 backend-siz test + 1 backend-li, `XCTSkipIf` ilə)   |
| UI test hədəfi (`oneTeamFieldAuditUITests`) | ✅ avtomatik — `mobile/plugins/withUITests.js`; `xcodebuild -list` iki hədəf göstərir              |
| Testləri işlətmək                           | ⏳ **bahaI:** `bash scripts/dev/test-ios.sh`                                                       |
| CI `xcodebuild test`                        | ⏳ `macos-latest` runner — yuxarıdakı əmr yaşıl olduqdan sonra                                     |

**Plugin-in düzəltdiyi dörd şey** (`xcode@3.0.1` kitabxanası ya səhv edir, ya da etmir; hər biri
ölçülüb və hər biri olmasa build düşür):

1. `unit_test_bundle` kimi yaradıb `productType`-ı `com.apple.product-type.bundle.ui-testing`-ə
   çevirir — kitabxanada bu tip yoxdur, amma XCTest ikinci tətbiqi idarə etmək üçün onu tələb edir.
2. Asılılığı tərsinə çevirir: kitabxana **tətbiqi** test hədəfindən asılı edir, halbuki test
   hədəfi tətbiqdən asılı olmalıdır (`TEST_TARGET_NAME`). Tərsinə qalsaydı, ikisi bir-birini
   gözləyəcəkdi.
3. Qrupu və fayl referansını özü yaradır. `addPbxGroup` yazılmır (ölçüldü), fayl isə qrup
   olmadan `ios/FieldAuditUITests.swift`-ə düşürdü → `Build input file cannot be found`.
4. `TEST_HOST` və `BUNDLE_LOADER` **qoymur**: Xcode 26 `sets both USES_XCTRUNNER and either
TEST_HOST or RUNTIME_TEST_HOST` xətası verir. Əvəzinə `USES_XCTRUNNER = YES`.

**Testləri işlətmək — bir əmr:**

```
bash scripts/dev/test-ios.sh
```

Skript Metro-nu özü başladır (Debug quruluşunda JS kodu Metro-dan gəlir; olmasa tətbiq
"No script URL provided" göstərir və testlər uğursuz olur), sonra `xcodebuild test` işlədir.

**Agent bu əmri özü işlədə bilmir** — ölçülüb: CocoaPods-un `ExpoCameraBarcodeScanning`
skripti 10 057 faylı silir və agent mühitinin kütləvi-silmə qoruyucusu bunu dayandırır
(`SAFE_DELETE_BULK_CONFIRM_REQUIRED`, threshold 50). Bu layihənin yox, agent iş mühitinin
məhdudiyyətidir — bahaI-nin Terminal-ında və CI-də belə qoruyucu yoxdur.

**Mərhələ 3 nəticəsi:** Real iPhone-da / Simulyatorda **yaddaşda saxlanılan açarla**, kamerası və offline queue ilə işləyən tətbiq.

---

### MƏRHƏLƏ 4 — YOLO + OpenRouter AI hibrid (Həftə 6–7)

| #   | İş paketi                                                                                                                                                                                                 | Qəbul meyarı                                                                                           | Müddət  | Vəziyyət |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------- | -------- |
| 4.1 | **OpenRouter client:** `packages/ai/openrouter.ts` — `fetch` + `Authorization: Bearer ${OPENROUTER_KEY}`, `HTTP-Referer`, `X-Title`. Rate-limit: token bucket (20 RPM / 1000 RPD), exponential backoff.   | 100 paralel sorğu → heç biri 429 qaytarmır; 429 gələndə 60 saniyə gözləyir.                            | 1 gün   | ⏳       |
| 4.2 | **Vision prompt template:** JSON schema (`zod`) — `planogramScore(0-100)`, `missingSKUs[]`, `extraItems[]`, `anomalies[]`, `confidence(0-1)`. Prompt: "Sən oneTeam Retail rəf auditçisisən. JSON qaytar." | Schema validasiyası uğurlu; JSON parse xətası < 0.1%.                                                  | 1 gün   | ⏳       |
| 4.3 | **YOLO pre-filter:** `yolov8n.pt` (COCO) → `bottle`, `cup`, `wine glass` klassları → bounding box → crop → base64 → OpenRouter. Yalnız **ROI** göndərilir → token xərci ~70% azalır.                      | 100 test şəkli → ortalama 1.2s / şəkil; token < 1500/sorğu.                                            | 1 gün   | ⏳       |
| 4.4 | **Worker pipeline:** `apps/api/src/workers/ai-worker.ts` — BullMQ queue (`ai:analyze`), concurrency 2, retry 3, dead-letter. Giriş: `evidenceId`, Çıxış: `aiResult` (JSON) + `planogramScore` yazılır.    | 50 evidence yaradılır → queue dolar → worker bitirir → `/api/portal/evidence/:id` `aiResult` göstərir. | 1.5 gün | ⏳       |
| 4.5 | **Fallback və dürüstlük:** Model 429 / 5xx / timeout → `aiResult: {fallback: true, reason, yoloOnlyScore}`; **heç vaxt "yumşaldılmış" nəticə yazılmır**.                                                  | Rate-limit halında `fallback: true` gəlir; supervayzer "AI yoxlanmadı" görür.                          | 0.5 gün | ⏳       |
| 4.6 | **Məxfilik / Data Processing Addendum:** OpenRouter-a göndərilən şəkillər **heç bir şəkildə** model təliminə istifadə edilmir (OpenRouter Terms §3.2). `X-OpenRouter-User-Id` göndərilmir.                | Sənəddə qeyd edilir; operator imzalayır.                                                               | 0.5 gün | ⏳       |

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

| Borc                                                                                                                  | Hal-hazırkı vəziyyət                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Planlaşdırılan həll                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~`mobile/package.json: dependencies: {}`~~                                                                           | Expo config və native modullar yoxdur                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | **Həll olundu** (3.1) — SDK 57-in rəsmi versiyaları yazıldı. **Quraşdırma icra olunmadı**, səbəb aşağıda                                                                                                                                                                                                                                                          |
| **Agent mühiti ~470 paketlik quraşdırmanı bloklayır**                                                                 | **3.1-də ölçüldü:** fayl yaratma qaynağı paralel əməliyyatlarda tükənir və **bərpa olunmur** (ardıcıl 400 ✅, paralel 200 ❌). `npm install` və `pnpm install` ikisi də `reify`/`linkNewPackages` mərhələsində dayanır. `brew install cocoapods` isə iç-içə `sandbox-exec` səbəbindən keçmir. Nəticə: **`expo prebuild` agent tərəfindən icra oluna bilmir**                                                                                                                                                                                                                                                                   | bahaI adi Terminalda üç əmr işlədir: `brew install cocoapods`, `cd mobile && npm install`, `npx expo prebuild --platform ios`                                                                                                                                                                                                                                     |
| `mobile/Root.tsx`, `keychain.ts` **və `queueStorage.ts` tip yoxlamasından kənardır**                                  | `mobile/tsconfig.json` yalnız `src` ağacını əhatə edir; `Root.tsx` isə hələ quraşdırılmamış `react-native` idxal edir. `src/` altına qoyulsa `mobile:check` **əlaqəsiz səbəbdən** qırmızı olardı. **3.2-də `keychain.ts`, 3.3-də `queueStorage.ts`** eyni səbəbdən `exclude`-a əlavə olundu. Əl ilə `declare module` yazmaq **rədd edildi**: belə bəyannamə kodun özü ilə **eyni yaddaşdan** yazılardı, yəni tuta biləcəyi yeganə şeyi — yanlış API çağırışını — **tuta bilməzdi**. `npm run mobile:config` üçünü də **struktur olaraq** qoruyur (39 yoxlama), amma bu, **tip yoxlaması deyil**                                | `npm install`-dan sonra `exclude`-u sil, `include`-a `index.ts` və `Root.tsx` əlavə olunmalıdır                                                                                                                                                                                                                                                                   |
| ~~`portalApi.ts` **`EXPO_PUBLIC_` prefiksini bilmirdi**~~                                                             | Expo/Metro `process.env`-i yalnız `EXPO_PUBLIC_*` adları üçün yerinə qoyur; `ONETEAM_API_URL` real build-da `undefined` olurdu və ünvan **sükutla `http://localhost:3001`**-ə düşürdü. `const env = process.env` alias-ı kömək etmirdi — Metro yalnız birbaşa `process.env.X` ifadəsini yerinə qoyur. **3.1-də ölçüldü, 3.2-də düzəldilmədi**                                                                                                                                                                                                                                                                                  | **Həll olundu** (3.3) — ünvan birbaşa `process.env.EXPO_PUBLIC_ONETEAM_API_URL` kimi oxunur; `mobile:config` bu **ifadə formasını** və sirrlərə publik ad verilməməsini yoxlayır                                                                                                                                                                                  |
| ~~`OfflineQueueManager` **yaddaşda idi**, README isə əksini deyirdi~~                                                 | **3.1-də ölçüldü:** `private queue: QueueItem[] = []` — heç bir saxlanc yoxdur. `triggerAutoSync()` **boş metoddur** (çağırılır, heç nə etmir). README-dəki "queued securely in local storage" və "automatically detects network reconnection" **yanlışdır**. 50 MB limit yoxdur. Yəni 3.3 "köçürmə" deyil, yazmadır                                                                                                                                                                                                                                                                                                           | **Həll olundu** (3.3) — `QueueStorage` arakəsməsi, `queueStorage.ts`, 50 MB limit, həqiqi reconnection drain-i, dörd davamlılıq qaydası; 83 yoxlama + 23 pozma. README-dəki iki cümlə düzəldildi. **Real cihazda sınanmadı**                                                                                                                                      |
| **Növbənin fon taymeri yoxdur**                                                                                       | **3.3-də qərar verildi.** Təkrar cəhd **qoşulma** ilə, ya da əl ilə baş verir; `setInterval` yoxdur. Yəni cihaz artıq onlayn olanda uğursuz olan element növbəti qoşulmaya qədər gözləyir. Bu, sükutla gizlədilmir: dəst onu çap edir, README-də yazılıb                                                                                                                                                                                                                                                                                                                                                                       | Mobil taymer **komponent həyat dövrünə** aid olmalıdır — 3.5-də ekran qatı ilə gəlir. O vaxta qədər bu, **məlum məhdudiyyətdir**                                                                                                                                                                                                                                  |
| **`AsyncStorage` şifrələnmir**                                                                                        | **3.3-də koda baxıb təsdiqləndi.** iOS-da bu, tətbiq konteynerindəki fayldır: OS onu sandbox və cihaz parolu ilə qoruyur, amma **açar yoxdur** — jailbreak edilmiş cihaz, ya da şifrələnməmiş tam ehtiyat nüsxə onu oxuya bilər. Planın "queued **securely** in local storage" ifadəsi bunu **artıq deyirdi**; README düzəldildi                                                                                                                                                                                                                                                                                               | `expo-secure-store` bu iş üçün **uyğun deyil** (KB həddi, auditlər isə MB). Seçim: (a) belə qalsın və sənədləşdirilsin (indi belədir), (b) növbə faylı `expo-crypto` ilə şifrələnsin. **Qərar gözləyir (bahaI)**                                                                                                                                                  |
| **API-də təkrar təqdimata qarşı qoruyucu yoxdur**                                                                     | **3.3-də koda baxıb təsdiqləndi.** `EvidenceService.submitEvidence` evidence sətrini **şərtsiz** yaradır; yalnız `task.status` keçidi şərtlidir (`ACKNOWLEDGED → IN_PROGRESS → SUBMITTED`). Ona görə eyni tapşırıq üçün **sınırsız** evidence sətri yarana bilər — before/after axını üçün bu **dizaynla** belədir, amma təkrar göndərilən bir audit üçün də belədir                                                                                                                                                                                                                                                           | Növbə tərəfində **kompensasiya edildi**: yarımçıq element avtomatik cəhdə qaytarılmır (qayda 4). API tərəfində qərar: `409` + `Idempotency-Key`, yoxsa belə qalsın. **Qərar gözləyir**                                                                                                                                                                            |
| ~~**Pozma harness-ı repoda deyil**~~                                                                                  | `node /tmp/break-detector-queue.mjs` — 23 hal, 3.3-ü sübut edən yeganə vasitə idi. `/tmp`-də olduğu üçün **yenidən icra oluna bilmirdi** və maşın təmizlənəndə **sübut itəcəkdi**                                                                                                                                                                                                                                                                                                                                                                                                                                              | **Həll olundu** (3.3) — `scripts/dev/break-detector-queue.mjs` + `npm run test:break`; yol faylın öz yerindən törədilir, sərt yazılmır. `quality`-yə **salınmadı**: qəsdən kodu sındırır                                                                                                                                                                          |
| ~~**3.2-nin pozma harness-ı hələ də `/tmp`-dədir**~~                                                                  | `node /tmp/break-detector.mjs` (13 hal, `test:credentials` + `mobile:config`). 3.3-ünkündən **zəifdir**: hər hal üçün "**hansı** yoxlama qızarmalıdır" gözləntisi yoxdur (bütün uğursuz sətirləri sadəcə çap edir), `COMPLETION` yoxlaması yoxdur (sintaksis xətası "deşik" kimi oxuna bilər), qeyri-sıfır çıxış kodu yoxdur, ehtiyat nüsxəni `/tmp/bd`-də saxlayır                                                                                                                                                                                                                                                            | **Həll olundu** — `scripts/dev/break-detector-credentials.mjs` + `npm run test:break:credentials`: `expect` + `COMPLETION` + tək uyğunluq + çıxış kodu + baza yoxlaması. **13/13**. Köçürmə iki **köhnəlmiş** halı üzə çıxardı (E və L) — köhnə harness onları sükutla "nəticə" kimi verərdi                                                                      |
| `mobile/ios/` **sınıq köhnə karkas idi**                                                                              | `Podfile` mövcud olmayan `react-native-permissions` yoluna istinad edirdi; `Info.plist` isə mövcud olmayan Xcode layihəsinə aid idi. İkisi də commit olunmuşdu                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | **Həll olundu** (3.1) — git-dən çıxarıldı, dəyəri `app.json`-a köçürüldü, `mobile/ios/` artıq **generasiya olunur** və `.gitignore`-dadır                                                                                                                                                                                                                         |
| npm keşində **6 fayl `root`-a məxsusdur**                                                                             | **3.1-də ölçüldü:** `~/.npm/_cacache` daxilində 2151 fayldan 6-sı `root`-undur (keçmişdə `sudo npm` işlədilib) → `npm install` `EACCES` verir. Agent sudo işlətmədi, ayrı keş qovluğu istifadə etdi                                                                                                                                                                                                                                                                                                                                                                                                                            | bahaI: `sudo chown -R $(whoami) ~/.npm` — bir dəfəlik                                                                                                                                                                                                                                                                                                             |
| `yolov8n.pt` — generic COCO                                                                                           | SKU tanıma yoxdur                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Mərhələ 4.3-də ROI crop + Vision LLM ilə kompensasiya edilir (fine-tune yox)                                                                                                                                                                                                                                                                                      |
| ~~`/api/panel/*` → `oneteam-user:` token qəbul edirdi~~                                                               | Panel açarı yaradıldıqda belə qəbul edilirdi                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | **Həll olundu** (1.1, `29aa4d3`)                                                                                                                                                                                                                                                                                                                                  |
| ~~Audit təsdiqində rol yoxlaması yox idi~~                                                                            | Fotonu göndərən işçi öz auditini təsdiqləyə bilirdi                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | **Həll olundu** (1.5, `ed8f9b7`) — `requireReviewer`                                                                                                                                                                                                                                                                                                              |
| ~~Yeni istifadəçi yaratmaq mümkün deyildi~~                                                                           | "Hər adama öz açarı" yalnız seed-dəki 3 nəfər üçün işləyirdi                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | **Həll olundu** (1.5, `ed8f9b7`) — `/api/panel/users` + panel ekranı                                                                                                                                                                                                                                                                                              |
| ~~Bot state-machine yoxdur~~                                                                                          | `text` command + switch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | **Həll olundu** (2.1) — `callbacks.ts` (`action:id`) + `router.ts`. Həm də: axının **dörd handler-i heç çağırılmırdı** və `message:location` marşrutu yox idi → lokasiya+çeklist+foto axını canlıda çatılmaz idi                                                                                                                                                  |
| OpenRouter env yoxdur                                                                                                 | `OPENROUTER_API_KEY` Railway-da yoxdur                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Mərhələ 4.1-dən əvvəl qoyulmalıdır                                                                                                                                                                                                                                                                                                                                |
| iOS Xcode scheme / signing yoxdur                                                                                     | `mobile/` altında `.xcodeproj` yoxdur                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `expo prebuild` yaradacaq                                                                                                                                                                                                                                                                                                                                         |
| `pnpm-workspace.yaml` var, amma `node_modules` `npm`-dədir                                                            | Lockfile uyğunsuzluğu (`npm install --dry-run` → 304 silinir)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `pnpm install --frozen-lockfile` və ya `package-lock.json` bərpası                                                                                                                                                                                                                                                                                                |
| Geofence radiusu mağaza üzrə deyil                                                                                    | `GEOFENCE_MAX_DISTANCE_METERS` sabiti (`packages/types`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Mərhələ 3-də mağaza üzrə sütun + mobil tərəfin uyğunlaşdırılması                                                                                                                                                                                                                                                                                                  |
| `/api/health` → `persistenceDetail` **gecikən etiketdir**                                                             | Yalnız replika poll-u yükləyəndə hesablanır → yazıdan sonra bir interval **köhnə** say göstərir (`ONETEAM_REFRESH_MS=0` olsa heç vaxt yenilənmir)                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Oxu anında hesablanmalı, ya da adı "son yükləmə" olduğunu deməli. **Kiçik, amma yanlış məlumat verir** — 1.5 canlı yoxlamasında saxta "silmə baş vermədi" nəticəsi verdi                                                                                                                                                                                          |
| Çeklist sual mətni **`label`** kimi saxlanılır, bot isə **`question`** oxuyur                                         | **2.1-də körpü qoyuldu:** `questionText()` artıq `question ?? label` oxuyur, yəni merçendayzer həqiqi sualı görür və `bot:test` **yaşıldır**. Amma **müqavilə hələ də sınıqdır** — `ChecklistQuestion.question` tipdə `?` edildi ki, tip yalan danışmasın                                                                                                                                                                                                                                                                                                                                                                      | Hansı ad kanonikdir: `label` → `question` adlandırılsın (backfill ilə), yoxsa `label` kanonikdir və tip düzəldilsin. **Qərar gözləyir (bahaI)** — tapşırıq #73. Körpü tək yerdədir: `handlers/taskFlow.ts:questionText`                                                                                                                                           |
| `bot:test` hər işdə **2** `TASK_SELF_ASSIGNED` audit sətri buraxır                                                    | **2.3-də ölçüldü** (əvvəlcədən 2.1-dən bəri var idi): qeyd **mağazanın** id-si ilə yazılır (`entity_id = storeId`), təmizlik isə tapşırığın id-si ilə silir → **heç vaxt uyğun gəlmir**. İki qeyddən yalnız ikincisi `payload.taskIds`-də tapşırığı adlandırır. Yəni `bot:test` "hər şey təmizləndi" deyir, baza isə bir az sürüşür. **Bildiriş sətri 2.3-də düzəldildi** (3 → 4 idi, indi 0 → 0)                                                                                                                                                                                                                              | Təmizlik "bu iş hansı mağazaya hansı istifadəçi kimi bağlandı"nı izləməlidir. **Qəsdən 2.3-ə salınmadı:** bu, tapşırığın deyil, **bağlanmanın** qalığıdır və silmənin nə qədər geniş olacağı ayrı qərardır                                                                                                                                                        |
| `test:tasks` hər işdə öz brifinqlərini **və ~17 audit sətri** buraxır                                                 | **2.3-ün canlı regressiyasında ölçüldü.** Dəst təmizliyində mağaza, mağaza-tapşırıq və şablon saylarını yoxlayır — **audit-i yox**. Şablonlar üçün öz assertion-u var ("the only templates left behind are this run's briefings"), yəni qalıq **qəsdən təsdiqlənir**, çünki şablonu silən endpoint yoxdur                                                                                                                                                                                                                                                                                                                      | Dəst digərləri kimi `pg` ilə birbaşa silməlidir — bu, artıq mövcud olan **"yetim şablonlar"** borcunun bir hissəsidir — və audit sayı before/after obyektinə əlavə olunmalıdır                                                                                                                                                                                    |
| `test:device` fikstur istifadəçisini buraxır; `test:panel`/`test:roles` ləğv edilmiş `panel_tokens` sətirləri buraxır | **2.3-də ölçüldü:** `usr-dev-dev-credential-suite` bazada qalır — təmizlik `task_evidences.submitted_by_id` RESTRICT olanda **`skip`** edir (`TESTING.md`-də yazılıb). Token sətirləri isə **ləğv olunub** (`revoked_at` dolu), yəni bu, sızma deyil, **saxlamadır**                                                                                                                                                                                                                                                                                                                                                           | İstifadəçi üçün: silmənin niyə atlandığını dəst **özü deməlidir**. Token üçün: qərar verilməlidir — ləğv edilmiş test token-ləri silinsin, yoxsa bu, normal saxlamadır                                                                                                                                                                                            |
| ~~**Cihaz açarını ləğv edən route YOXDUR**~~                                                                          | **3.2-də koda baxıb təsdiqləndi.** `panel-auth.controller.ts`-dəki `keys/:prefix/revoke` və `users/:userId/revoke-keys` **panel** açarları üçündür. Cihaz kredensialını ələ keçirməyin iki yolu var, ikisi də baha: cihaz **özü** yenidən qeydiyyatdan keçməlidir (**telefon lazımdır**), ya da istifadəçi silinməlidir — audit təqdim etmiş merçendayzer üçün **`409 USER_HAS_SUBMISSIONS`** bloklayır. Nəticə: **itirilmiş telefon paneldən kəsilə bilmir**                                                                                                                                                                  | `GET /api/panel/devices` + `POST /api/panel/devices/:deviceId/revoke` — supervayzer rol qapısı ilə. **BAĞLANDI:** 33 yoxlama + 6 pozma (`npm run test:break:device-revoke`). **Bu, 3.2-nin qəbulunu məhdudlaşdıran yeganə API boşluğu idi**                                                                                                                       |
| **Açar saxlayıcı uninstall-da təmizlənmir**                                                                           | **3.2-də qərar verildi.** iOS-da açar saxlayıcı app bundle-ına bağlı deyil, ona görə silinib yenidən qurulan tətbiq **qeydiyyatlı qalır** — bu, planın tələbidir ("silinmədə `deviceToken` qalır"), amma **ötürülən telefon əvvəlki işçinin identifikasiyasını daşıyır**                                                                                                                                                                                                                                                                                                                                                       | Yuxarıdaki revoke route-u bunun qarşılığıdır. O gələnə qədər **əl ilə müdaxilə yoxdur**                                                                                                                                                                                                                                                                           |
| ~~**Sirr skanı öz yalançı siqnalı ilə borunu bağlamışdı**~~                                                           | Addımın adı **"Scan entire history for committed credentials"** idi və `fetch-depth: 0` tələb edirdi — **hər iki iddia yalan**: skaner `git ls-files` oxuyur, yəni **bu commit-dəki izlənən faylları**, tarix rejimi isə **ümumiyyətlə yoxdur**. Üstəlik skaner öz **test korpusunu** tapırdı, yəni özünü qırmızı edirdi                                                                                                                                                                                                                                                                                                       | **Həll olundu** (`35d0a02` + `a113d8c`) — addımın adı düzəldildi (_"Scan tracked files"_); tarix skanı **qəsdən yoxdur** və bu, faylda **adı ilə** yazılıb (`git log -p --all` ilə əl ilə yoxlanılır); skanerin öz test korpusu istisna edildi                                                                                                                    |
| ~~`mobile` tip yoxlaması **gitignored** artefaktdan asılı idi~~                                                       | `@oneteam/types` gitignored `packages/*/dist/`-dən oxunurdu → `mobile:check` **yalnız laptopda** yaşıl, təmiz klonda qırmızı. **Bu, sinfin 1-ci təkrarıdır**                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | **Həll olundu** (`5793fb7`) — yoxlama reponun izlədiyi mənbədən oxuyur                                                                                                                                                                                                                                                                                            |
| ~~**CI heç vaxt keçməmişdi**~~                                                                                        | `gh run list` → **50 uğursuz, 1 ləğv, 0 uğurlu**. Hər push **5-ci addımda** (sirr skanı) ölürdü; GitHub qalan addımları **`-` (atlanmış)** kimi göstərirdi — ona görə borc **görünməz** idi: `type-check`, `lint`, `format:check`, `test:all` və `web:build` **heç vaxt icra olunmamışdı**. Addımlar bir-bir açıldı və **hər biri öz qüsuru ilə**: run `34980023173` → **Lint X** (228 xəta), `format:check` yenə atlandı; run `34983128531` → **Verify ilk dəfə ✓ (1m0s)**, amma **Build X** + **Test X** — o iki iş **ilk dəfə** işləyirdi. §5 cədvəlinin 3-cü sətri (`xcodebuild test` CI → green) buna görə mümkün deyildi | **Həll olundu** (`6a4d007` + `c9bef8f` + `4114782` + `a6349ac`) — run `34983792832`: **Verify 55s ✓ · Test 17s ✓ · Build 36s ✓**, tarixdə ilk dəfə                                                                                                                                                                                                                |
| **`web/` npm workspace üzvü deyil**                                                                                   | `workspaces` yalnız `apps/*` və `packages/*` sadalayır → CI `web/node_modules`-u **heç vaxt quraşdırmır**, ona görə portalın istehsalat bundle-ı **yalnız laptopda** qurulurdu. Eyni sinif: _reponun izləmədiyi artefaktdan asılı yoxlama_ — `mobile`-in gitignored `dist/`-i ilə **eyni xəta**; bu, həmin sinfin **3-cü** təkrarıdır                                                                                                                                                                                                                                                                                          | CI-in `Build` işinə açıq `cd web && npm ci` addımı əlavə olundu. **Qərar gözləyir:** `web` workspace üzvü edilsin? (tək kök lockfile, `web/package-lock.json` silinir) — bu, asılılıq idarəsi qərarıdır, CI düzəlişi deyil                                                                                                                                        |
| ~~`scripts/**/*.cjs` ESLint konfiqurasiyasında yox idi~~                                                              | **Bir glob-un əskikliyi 124 xəta verdi** (120 `no-undef` + 4 `no-require-imports`), hamısı `scripts/live-*.cjs` zondlarında. `process`, `console`, `fetch`, `setTimeout`, `module` "təyin olunmamış" oxunurdu; eyni yoxlama CommonJS faylında `require()`-i **qadağan idxal** adlandırırdı — yəni `require`-in **modul sistemi olduğu yerdə**                                                                                                                                                                                                                                                                                  | **Həll olundu** — `scripts/**/*.cjs` globu + `@typescript-eslint/no-require-imports: off`; səbəb konfiqurasiyanın özündə yazılıb                                                                                                                                                                                                                                  |
| ~~**5 fayl heç bir tsconfig-də deyildi**~~                                                                            | `mobile/Root.tsx`, `mobile/index.ts`, `mobile/src/services/keychain.ts`, `mobile/src/services/queueStorage.ts`, `web/vite.config.ts`. typescript-eslint onları **lint edə bilmirdi** və bunu `Parsing error: … was not found by the project service` kimi verirdi — bu **XƏTADIR**, sükutla ötürmə deyil                                                                                                                                                                                                                                                                                                                       | **Həll olundu** — `projectService.allowDefaultProject` (5 qlob; `**` icazəli deyil, default limit 8 fayl). **Qiyməti açıq yazılıb:** bu fayllar yalnız **sintaksis** qaydaları ilə yoxlanılır — tip-ə baxan qaydalar **atlanır**                                                                                                                                  |
| ~~`no-return-await` **ESLint nüvə qaydası** idi~~                                                                     | ESLint 8.46-da **köhnəlmiş**; `try` blokundakı `return await`-i işarələyirdi — halbuki `catch`-in işə düşməsi üçün `await` **məhz orada lazımdır**, yəni məsləhəti **ən vacib halda yanlış** idi                                                                                                                                                                                                                                                                                                                                                                                                                               | **Həll olundu** — `@typescript-eslint/return-await` (`in-try-catch`) ilə əvəz olundu. 18 yerin hamısı yenə bildirildi və hamısı **koddan** düzəldildi                                                                                                                                                                                                             |
| **`npm run lint` yerli maşında işlədilə BİLMİR**                                                                      | `node_modules/eslint` **yoxdur** — baxmayaraq ki `eslint@^10.10.0` `package.json`-da elan olunub və lock-da var; `node_modules/globals` da yoxdur. Ona görə **228 düzəlişin heç biri yerli lint ilə yoxlanılmadı** — hər biri qaydaların rəsmi sənədi və bildirilən sətirlər oxunaraq hazırlandı. **CI ilk real yoxlama oldu** və 2 xəta tapdı (`prefer-const` — **öz düzəlişimin yaratdığı**)                                                                                                                                                                                                                                 | `sudo chown -R $(whoami) ~/.npm` → təmiz `npm install` (ya da lockfile bərpası). **Açıq** — növbəti lint dəyişikliyi də **yalnız CI ilə** yoxlana bilər                                                                                                                                                                                                           |
| ~~`test:ai`-nin worker yoxlamaları reponun izləmədiyi artefaktlardan asılı idi~~                                      | Gitignored `.venv` (`.gitignore:74`) və **izlənməyən** model çəkisi. Yəni 3 yoxlama CI-da **heç vaxt keçə bilməzdi** → boru **daimi qırmızı** olardı, sonra isə heç kim oxumazdı. CI faylının öz sözü ilə: _"öz gücünü şişirdən təhlükəsizlik nəzarəti dar nəzarətdən pisdir, çünki adamlar baxmağı dayandırır"_                                                                                                                                                                                                                                                                                                               | **Həll olundu** — **dar və təkistiqamətli** `skip`: yalnız `worker-unavailable` (Python mühiti **ümumiyyətlə yoxdur**) halında atlanır və **ucadan** çap olunur. Worker varsa və çökürsə, boş siyahı qaytarırsa, ya büdcəni aşırsa — **yenə QIRMIZI**. İki hal da ölçüldü: `.venv` ilə 19/19 exit 0; `.venv` kənara çəkildikdə **16/19 keçdi, 3 SKIPPED, exit 0** |
| **`yolov8n.pt` repoda izlənmir və CI `.venv` qurmur**                                                                 | `git ls-files --error-unmatch yolov8n.pt` → _did not match any file(s) known to git_; model çəkisi **yalnız bu laptopdadır** (§1 onu "faylı mövcuddur" kimi göstərir). CI-da isə Python mühiti yoxdur, ona görə 3 yoxlama `worker-unavailable` yolundan **atlanır** — dürüst, amma YOLO zənciri CI-da **sübut olunmur**                                                                                                                                                                                                                                                                                                        | Qərar: fayl repoya salınsın (Git LFS, ~6 MB) və CI `.venv` qursun (hər push-da torch endirməsi — ya **keşlənmiş** venv), yoxsa ikisi də **məlum məhdudiyyət** kimi sənədləşsin. **Qərar gözləyir (bahaI)**                                                                                                                                                        |

---

## 5. Qəbul meyarı cədvəli (Definition of Done — hər mərhələ üçün)

| Mərhələ | Avtomatik yoxlama                                              | Manual yoxlama                                         | Operator təsdiqi        |
| ------- | -------------------------------------------------------------- | ------------------------------------------------------ | ----------------------- |
| 1       | `npm run test:all` + `test:live` → green                       | Panelə gir → mağaza yarat → tapşırıq yarat → ələ keçir | ✅ (1.1, 1.3, 1.4, 1.5) |
| 2       | Bot unit test (state machine) → green                          | Botdan 3 mağaza, 5 tapşırıq icra et                    | ⏳                      |
| 3       | `xcodebuild test` CI → green                                   | Real iPhone-da Login → Enroll → Photo → Submit         | ⏳                      |
| 4       | 100 test şəkli → AI worker → JSON valid + `fallback` rate < 5% | 10 şəkil → paneldə skor + anomaliya görünür            | ⏳                      |
| 5       | `k6` load test nightly → green                                 | Demo video + executive summary                         | ⏳                      |

**Ümumi önşərt — CI artıq işləyir.** `.github/workflows/ci.yml` üç işlə (`Verify`, `Test`, `Build`)
qurulub və **15 sentyabr 2026-da tarixdə ilk dəfə üçü də yaşıl oldu** (run `34983792832`). O vaxta
qədər hər push **5-ci addımda** (sirr skanı) ölürdü — yəni bu cədvəlin "Avtomatik yoxlama" sütununun
arxasında **heç bir yoxlama yox idi**: `type-check`, `lint`, `format:check`, `test:all` və `web:build`
heç vaxt icra olunmamışdı. İlk icra olunduqda **dörd fərqli səbəbdən 228 lint xətası** və **iki heç
vaxt işləməmiş iş** üzə çıxdı (səbəblər və düzəlişlər §4-də).

Buna görə **3-cü sətrin "CI → green" yarısı artıq şərt deyil** — boru işləyir. Qalan hissə
**`xcodebuild test`**-dir və o, `npx expo prebuild --platform ios` icra olunmadan **mövcud deyil**,
çünki `mobile/` altında Xcode layihəsi yoxdur. Yəni 3-cü sətrin qalan şərti **3.1-in üç Terminal
əmrindən** asılıdır, CI-dan yox.

**3-cü sətrin manual yarısı üçün bir maneə qalxmışdı və bağlandı.** 3.2 cihaz kredensialını telefonda
saxlayır, amma **onu ləğv edən route yox idi** — itirilmiş telefonu paneldən kəsmək mümkün deyildi, yəni
"Real iPhone-da Login → Enroll" ssenarisinin **əksisti** (cihaz itdi) idarə oluna bilmirdi. İndi
`POST /api/panel/devices/:deviceId/revoke` var (supervayzer qapısı ilə), `GET /api/panel/devices` isə
canlı və ləğv olunmuş cihazları göstərir. Sübut: **33 yoxlama + 6 pozma**; təfərrüat §4-də və 3.2
bölməsində.

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

## 9. Dünya praktikası ilə müqayisə və məhsul yol xəritəsi

> **Mənbələr (2026):** Clobotics — retail execution platform müqayisəsi və "evidence integrity" bölməsi;
> FieldAssist — FMCG rəf auditinin 2026 standartı. **Buradaki bütün rəqəmlər vendor iddialarıdır**,
> müstəqil ölçmə deyil. Ona görə onları **hədəf** kimi götürürük, **sübut** kimi yox.

### 9.1 Sənayenin iki struktur dərsi

**Dərs 1 — Sübut bütövlüyü, tanımadan ƏVVƏL yoxlanılır.** Clobotics-in öz cümləsi:

> _"A model can identify every visible product correctly and still produce the wrong business
> conclusion. If an image is old, duplicated, taken from the wrong outlet, or captures only part of
> the required display, the compliance score is compromised before recognition begins."_

Yəni **model qüsursuz işləsə də, şəkil yalandırsa nəticə yalandır.** Sənayenin yoxladığı siyahı
dəqiq altı bənddir: **location · time · duplication · quality · completeness · visit integrity.**

Bu, 20–21 sentyabr 2026-da tapdığımız **dörd saxtanın** dərsidir və təsadüf deyil: dördü də məhz bu
siyahıdan idi. Girişdəki mövqe saxta idi (`location`), auditə yazılan mövqe sabit rəqəm idi
(`location` yenə), ghost overlay göstərilmədiyi halda `ghost_overlay_used: true` yazılırdı
(`completeness`), kamera heç çağırılmırdı (`quality`). **Dördünün hamısı "model" qatından aşağıda,
sübut qatında idi** — və dördü də yaşıl test dəsti ilə birlikdə yaşamışdı.

**Dərs 2 — "Data without a workflow".** Clobotics bunu belə ifadə edir: _"A perfect SKU-level audit
that doesn't trigger a corrective action in tomorrow's beat plan is data without a workflow."_
Bizim bugünkü axınımız tam olaraq budur: **işçi auditi göndərir və mağazadan heç nə ilə çıxır.**
Supervisor sonra paneldən baxır. Sənayedə isə düzəliş **mağaza içində, işçi çıxmamışdan əvvəl**
qaytarılır (same-visit corrective action) — çünki 3 dəqiqə gecikən nəticə hesabat üçün yararlıdır,
**düzəliş üçün yox**.

### 9.2 Bizdə nə var, sənayedə nə var (ölçülmüş)

| Sahə                       | Sənaye standartı (2026)                                           | oneTeam bu gün                                            | Boşluq                                      |
| -------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------- |
| Foto çəkilişi              | Guided capture + keyfiyyət qapısı                                 | **Real kamera** (`expo-camera`), grid, ghost overlay      | Keyfiyyət/qəbul yoxlaması yox               |
| Mövqe sübutu               | location + time + visit integrity                                 | Real GPS (`expo-location`) + 100 m geofence               | Çəkiliş anında təzə fix yox; vaxt telefonda |
| Təkrarlanma                | duplicate detection                                               | Yoxdur                                                    | Şəkil hash-i yoxdur                         |
| Çəkiliş tamlığı            | completeness (primary / secondary / POSM)                         | Yoxdur                                                    | Tələb olunan baxış siyahısı yox             |
| SKU tanıma                 | SKU-level detection, kateqoriya üzrə **92–97%**                   | **YOXDUR** — `aiVision.ts` simulyasiyadır, qoşulmamalıdır | **Ən böyük boşluq**                         |
| Metriklər                  | Share of shelf · OSA · facings · planogram · POSM · qiymət/aksiya | Yoxdur                                                    | Yoxdur                                      |
| Barkod                     | Skaner (SKU-nu dəqiq tanıyır)                                     | **Modul tətbiqə YIĞILIB, istifadə olunmur**               | Ən ucuz qazanı                              |
| Dövr (closed loop)         | Same-visit corrective action                                      | Yoxdur — audit göndərilir, işçi heç nə almır              | Yoxdur                                      |
| Offline                    | Capture continues without signal                                  | Növbə **yazılıb**, real cihazda sübut olunmayıb           | Sübut                                       |
| Marşrut / beat plan        | Problemli mağaza sabahkı plana düşür                              | Yoxdur                                                    | Yoxdur                                      |
| Video (uzun rəf, soyuducu) | Guided video → stitch → analiz                                    | Yoxdur                                                    | Yoxdur                                      |

### 9.3 Yol xəritəsi — dörd dalğa

Sıralama üç meyarla: **(a)** yalanı və ya riski bağlayır, **(b)** indi ucuzdur, **(c)** sonrakını açır.

**Dalğa 0 — Sübutun dürüstlüyü. Model LAZIM DEYİL, hamısı indi edilə bilər.**

| #   | Maddə                                            | Nə edir                                                                                   | Sübut                                                                                 |
| --- | ------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 0.1 | Çəkiliş anında **təzə fix** + köhnəlmə yoxlaması | Möhür girişdəki yox, **çəkiliş anındaki** mövqe olur; köhnədirsə xəbərdarlıq              | **EDİLDİ** (21 sentyabr) — `resolveCapturePosition` + `A6`; **56 yoxlama + 24 pozma** |
| 0.2 | **Şəkil keyfiyyəti** qapısı                      | Bulanıqlıq / qaranlıq / parıltı ölçülür; qəbul olunmazsa çəkiliş təkrarlanır              | Sinifdə məlum olan şəkillərlə (bulanıq/kəskin) test                                   |
| 0.3 | **Təkrarlanma** aşkarlanması                     | Eyni fotonun ikinci dəfə təqdim edilməsi tutulur (perceptual hash)                        | Eyni şəkil iki dəfə → ikincisi rədd                                                   |
| 0.4 | **Çəkiliş tamlığı**                              | Tapşırıq hansı baxışları tələb edir (əsas rəf / ikinci vitrin / POSM) və hamısı çəkilibmi | Natamam dəst göndərilə bilmir                                                         |
| 0.5 | **Vaxt serverdən**                               | Möhürün vaxtı serverdə qoyulur; telefon saatı dəyişdirilə bilməz                          | Telefon saatı irəli/geri → möhür dəyişmir                                             |

**Dalğa 1 — Barkod və kataloq. Model LAZIM DEYİL.**

| #   | Maddə                       | Nə edir                                                                                                          |
| --- | --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1.1 | Barkod skaneri              | `ExpoCameraBarcodeScanning` **artıq tətbiqə yığılıb** — yeni asılılıq yoxdur. SKU-nu model olmadan dəqiq tanıyır |
| 1.2 | SKU kataloqu                | Barkod → məhsul (ad, ölçü, variant). Panel CRUD, mövcud CRUD naxışı ilə                                          |
| 1.3 | Rəf xəritəsi                | Bölmə / səviyyə / mövqe — sonrakı planogram müqayisəsinin bazası                                                 |
| 1.4 | Əl ilə OSA / share of shelf | İşçi sayır, sistem faizi hesablayır. **Model gələndə müqayisə bazası olur**                                      |

**Dalğa 2 — Tanıma (model). Planın MƏRHƏLƏ 4-ü buradadır.**

| #   | Maddə                | Nə edir                                                                      |
| --- | -------------------- | ---------------------------------------------------------------------------- |
| 2.1 | SKU aşkarlama (YOLO) | Şəkildən SKU-ların tapılması — `present / missing / misplaced / under-faced` |
| 2.2 | Metriklər            | Share of shelf · OSA · facings · planogram uyğunluğu                         |
| 2.3 | POSM + qiymət/aksiya | Vitrin materiallarının və qiymət etiketlərinin tanınması (OCR)               |
| 2.4 | Guided video         | Uzun rəflər və sıx soyuducular üçün; kadrlara bölünür, sonra tikilir         |

**Dalğa 3 — Dövrü bağlamaq (closed loop).**

| #   | Maddə                 | Nə edir                                                                   |
| --- | --------------------- | ------------------------------------------------------------------------- |
| 3.1 | Mağaza içində düzəliş | Auditdən sonra **işçi çıxmamışdan əvvəl** düzəliş təklifi ekranda görünür |
| 3.2 | Düzəlişin təsdiqi     | "Əvvəl / sonra" foto cütü — düzəlişin həqiqətən edildiyinin sübutu        |
| 3.3 | Beat plan             | Uyğunsuz mağaza avtomatik sabahkı marşruta düşür                          |
| 3.4 | Panel trendləri       | Mağaza / distribyutor üzrə uyğunluq trendi, trade-spend hesabatı          |

### 9.4 Modeli və ya vendoru qiymətləndirmə meyarları

Sənayenin öz xəbərdarlığı: **"ümumi dəqiqlik" aldadıcıdır.** Bir platform 95% ümumi dəqiqlik göstərib,
gəlirin 60%-ni gətirən üç SKU-da yararsız ola bilər. Ona görə:

- **Kateqoriya səviyyəsində, öz top-30 SKU-nuz üzrə** dəqiqlik tələb olunur — laboratoriya yox, **sahə şəraiti**.
  Hədəf: **≥ 90%**. Clobotics "soyuq başlanğıc"ı ~70%-dən başlayıb **bir həftə içində >90%** kimi təsvir edir.
- **Sürət:** 80 facings olan bir şəkil üçün tanıma **5 saniyədən aşağı** (Clobotics). Müqayisə üçün:
  3 dəqiqəlik nəticə hesabat üçün yararlıdır, **mağaza içində düzəliş üçün gecdir**.
- **Şərait:** aşağı işıq, sıx rəf, maili bucaq, maneələr (qiymət etiketi, asılmış POSM, müştəri əli).
  Model bunların hamısında işləməlidir, ideal şəraitdə yox.

### 9.5 Nəyi ETMƏMƏK lazım

- **`aiVision.ts`-i qoşmaq olmaz.** O, simulyasiyadır və koddaki şərhi bunu deyir. Onu "işlək" kimi
  göstərmək beşinci saxta olardı.
- **Geofence-i yumşaltmaq olmaz.** O, həm tətbiqdə, həm də `evidence.service.ts`-də serverdə tətbiq
  olunur. Mağaza uzaq görünürsə, düzgün cavab **radiusu böyütmək deyil, mağazanın koordinatını
  düzəltməkdir** (bax §9.6).
- **"Ümumi dəqiqlik"ə arxalanmaq olmaz** — yuxarıdaki meyarlara bax.
- **Yaşıl test sübut deyil.** Bu planın §7-si bunu artıq deyir; 20–21 sentyabr hadisəsi onu bir daha
  təsdiqlədi: dörd saxta funksiya **yaşıl test dəsti ilə** birlikdə yaşayırdı.

### 9.6 Dərhal ediləcək əməliyyat işi (kod deyil)

`IPHONE_TEST` mağazası **köhnə demo koordinatlarında** (40.4093 / 49.8671) qeydiyyatdadır. Telefon isə
realdır: **40.3740, 49.8417**. Fərq **4475 m**-dir və 100 m geofence düzgün olaraq imtina edir.
Düzəliş: Panel → **Mağazalar Şəbəkəsi** → `IPHONE_TEST` sətrinin sağındaki **qələm ikonu** →
`Enlem (lat)` = `40.3740`, `Uzunluq (lon)` = `49.8417` → **Yadda saxla**.

> Diqqət: panelin **"Cari mövqeyimi götür"** düyməsi **kompüterin** mövqeyini götürür, telefonun yox.
> Kompüter telefonla eyni yerdə deyilsə, rəqəmləri **əl ilə** yazmaq lazımdır.

---

_Plan versiyası: 0.11 — 21 sentyabr 2026 — TƏSDİQLƏNİB, icra davam edir._

**CI — həll olundu və bu, planın ən köhnə görünməz borcu idi.** `.github/workflows/ci.yml` **tarixdə ilk
dəfə** tam yaşıldır (run `34983792832`: Verify 55s · Test 17s · Build 36s). O vaxta qədər hər push 5-ci
addımda ölürdü, yəni `type-check`, `lint`, `format:check`, `test:all` və `web:build` **heç vaxt icra
olunmamışdı**; ilk icra olunduqda **228 lint xətası** (dörd fərqli səbəbdən — üçü kodda deyil,
**konfiqurasiyada**) və **iki heç vaxt işləməmiş iş** üzə çıxdı. Təfərrüat §4-ün sonundadır. Ən vacib
nəticə bir **naxışdır, xəta deyil**: **üç dəfə** təkrarlandı ki, bir yoxlama **yalnız reponun
izləmədiyi yerli artefakt** sayəsində yaşıl qalır — `mobile`-in gitignored `dist/`-i, `web/node_modules`
(və `web` npm workspace üzvü deyil), gitignored `.venv` + izlənməyən `yolov8n.pt`.

3.1 🔶: config hazırdır və yoxlanıldı, `expo prebuild` agent mühitində bloklandığı üçün bahaI-nin
Terminalında icra olunmalıdır. 3.2 🔶: açarın saxlanması qatı yazıldı və 37 yoxlama + 13 pozma ilə sübut
olundu; pozma harness-ı **repodadır** (`npm run test:break:credentials`), yəni sübut yenidən icra oluna
bilir; ~~kamera yarısı və əsl açar saxlayıcı hələ sübut olunmayıb~~ — **kamera yarısı BAĞLANDI**
(20 sentyabr 2026): real `CameraView`, `takePictureAsync({ base64: true })`, baytsız çəkiliş rədd olunur,
ghost overlay planogram istinadını həqiqətən çəkir. Sübut: `npm run test:capture` — **46 yoxlama + 19
pozma, hamısı tutulur**; dörd saxta funksiya bu dəstlə bağlandı (§9.1). **Əsl açar saxlayıcı
(`keychain.ts`) hələ də real cihazda sübut olunmayıb** — yalnız bu qalır. ~~API boşluğu: cihaz açarını ləğv
edən route yoxdur~~ — **bağlandı**: `GET /api/panel/devices` + `POST /api/panel/devices/:deviceId/revoke`,
**33 yoxlama + 6 pozma** (`npm run test:break:device-revoke`), harness repodadır. 3.3 🔶 `20a7140`: növbə **yazıldı** (köçürülmədi) və 83 yoxlama + 23 pozma ilə
sübut olundu; `EXPO_PUBLIC_` borcu bağlandı; pozma harness-ı repoya salındı (`npm run test:break`) —
**`/tmp`-də saxlanılan sübut sübut deyil**. **AsyncStorage-ın özü və real cihazda avia-rejim sınağı sübut
olunmayıb.** İki qərar gözləyir: növbə faylının şifrələnməsi və API-də təkrar təqdimat qoruyucusu._
