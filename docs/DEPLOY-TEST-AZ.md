# oneTeam — Test Deploy Təlimatı (Railway)

> Bu sənəd texniki bilik tələb etmir. Hər addımda **nə edəcəyiniz** və **nə yazacağınız**
> göstərilib. Şübhə etdiyiniz yerdə dayanın və soruşun — tələm-tələsik davam etməkdənsə
> bir addımı yavaş getmək yaxşıdır.

---

## ✅ CANLI VƏZİYYƏT — deploy artıq edilib

Bu təlimatı **əllə izləmək lazım deyil.** Deploy tamamlandı və hazırda işləyir.
Son yoxlama: **14 sentyabr 2026** — üç servis də eyni kod versiyasında
(`b0beeba`), `/api/health` sxemi **tamam** göstərir (101 sütun, 5 miqrasiya
tətbiq olunub), kənar giriş isə rədd olunur.

### İşləyən ünvanlar

| Nə                                 | Ünvan                                                            | Vəziyyət       |
| ---------------------------------- | ---------------------------------------------------------------- | -------------- |
| **Veb panel** (istifadəçilər üçün) | https://web-production-1392e.up.railway.app                      | ✅ işləyir     |
| **API** (proqramlar üçün)          | https://api-production-c17b.up.railway.app                       | ✅ işləyir     |
| API sağlamlıq yoxlaması            | https://web-production-1392e.up.railway.app/api/health           | ✅ cavab verir |
| Railway idarəetmə paneli           | https://railway.com/project/f400d4fb-57dc-4346-9512-294f616ec363 | —              |
| Kod (private)                      | https://github.com/Enjoyer09/oneTeam                             | —              |

### Nə qurulub

Dörd hissə də **bir layihə içindədir** (Railway → `oneTeam`):

| Servis     | Nədir                                    | Vəziyyət                           |
| ---------- | ---------------------------------------- | ---------------------------------- |
| `postgres` | Verilənlər bazası (PostgreSQL 16 + disk) | ✅ sxem və nümunə məlumat yüklənib |
| `api`      | Backend (NestJS)                         | ✅ **bazaya yazır və oxuyur**      |
| `web`      | Veb panel (React + nginx)                | ✅                                 |
| `bot`      | Telegram bot                             | ✅ işləyir — **@oneTeamCCIbot**    |

### Verilənlər bazası artıq həqiqətən istifadə olunur

Əvvəl API hər şeyi **yaddaşda** saxlayırdı: tapşırıqlar, sübutlar və audit
qeydləri heç bir yerdə saxlanmırdı və hər yenidən başlatmada **itirdi**.
Bazaya qoşulmaq olurdu, amma heç bir cədvəl uyğun gəlmirdi — ona görə API
səssizcə yaddaşa keçirdi.

İndi:

- API işə düşəndə məlumatı **bazadan** oxuyur;
- hər dəyişiklik (tapşırıq yaratmaq, status dəyişmək, sübut yükləmək, audit
  qeydi) **bazaya yazılır**;
- `/api/health` cavabında `persistence` sahəsi hansı rejimdə işlədiyini göstərir.

Yoxlanılıb: yeni tapşırıq yaradıldı, status dəyişdirildi, API yenidən başladıldı
— hər ikisi **yerində qaldı**.

> **Diqqət:** köhnə baza diski (Supabase tipli cədvəllər) silinib və yerinə yeni
> disk yaradılıb. Köhnə diskin içində yalnız nümunə məlumat var idi və heç bir
> proqram onu oxumurdu, ona görə itki yoxdur.

### Kodu yeniləmək

1. Dəyişikliyi GitHub-a göndərin (`Enjoyer09/oneTeam`) — **bu kifayətdir.**
2. Railway kodu GitHub-dan **avtomatik oxuyur** və dörd servisi də özü yeniləyir.

Yoxlanılıb: GitHub-a göndərdikdən ~4 saniyə sonra Railway deploy-a başlayır.
Əllə heç nə etmək lazım deyil.

### Canlı yoxlama zamanı tapılan və düzəldilən iki nasazlıq

Hər şey işləyirdi, amma yoxlama zamanı iki gizli problem tapıldı:

**1. Telegram bot əslində ölü idi.** Konteyner işləyirdi, loglar «connected»
yazırdı — amma bot heç nə cavablandırmırdı. Səbəb: hər deploy zamanı köhnə və
yeni nüsxə qısa müddət eyni vaxtda işləyir, Telegram isə yalnız birinə icazə
verir. Yenisi rədd cavabı (409) alırdı və bu xəta tutulmadığı üçün proqram
dərhal sönürdü. İndi belə halda bot gözləyir və yenidən cəhd edir — sönmür.
Commit `d597b9e`.

**2. API baza ilə «yarışı» uduzurdu.** Deploy zamanı API `15:36:38`-də, baza isə
`15:36:40`-da hazır olur — **2 saniyə fərq**. API bu 2 saniyəyə düşəndə bazaya
birdəfəlik qoşula bilmirdi və səssizcə yaddaş rejimində qalırdı. İndi ilk
qoşulma 12 dəfə təkrarlanır. Commit `225186b`.

**Yekun yoxlama (canlı):** veb 200 · veb → API 200 · API bazaya qoşulub
(4 tapşırıq, 6 audit qeydi — yəni əvvəlki yazılar 4 deploy-dan sonra da
yerindədir) · giriş qoruması 401 · bot canlı.

---

## 0. Qısa cavab: hansı servis?

**Railway** (`railway.com`).

Səbəblər:

| Səbəb                                          | Nə deməkdir                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Layihənin 4 hissəsi **bir proyektdə** yaşayır  | PostgreSQL + API + Veb panel + Bot — bir panel, bir hesab, bir hesab-faktura               |
| Servislər bir-birini **daxili şəbəkədə** görür | Bazaya qoşulmaq üçün port açmaq, IP yazmaq lazım deyil                                     |
| **GitHub-a push edəndə avtomatik yenilənir**   | Kodu dəyişdikdən sonra heç nə etmək lazım deyil                                            |
| **Server idarəçiliyi yoxdur**                  | Linux yeniləmələri, sertifikatlar, gecə saat 2-də disk dolması — bunlar sizin işiniz deyil |
| Artıq **tanışsınız**                           | BahAI-Agent layihəsini də Railway-da saxlayırsınız                                         |

**Alternativlər və niyə seçmədik:**

- **Render** — veb üçün həqiqətən pulsuzdur, lakin **pulsuz PostgreSQL bazası 30 gündən sonra
  silinir**. Test deploy-u bir aydan çox yaşamalıdırsa, bu yaramaz.
- **Hetzner (€9.51/ay)** — ən ucuz variant, lakin bütün Linux serverini özünüz idarə etməli
  olursunuz: SSH, yeniləmələr, ehtiyat nüsxələr. Texniki olmayan operator üçün deyil.

---

## 1. Nə deploy edirik? (4 hissə)

```
┌─────────────────────────────────────────────────────────────┐
│                     BİR RAILWAY PROYEKTİ                     │
│                                                              │
│   ┌──────────────┐        ┌──────────────┐                  │
│   │  PostgreSQL  │◄───────│  API (NestJS)│◄────┐             │
│   │  verilənlər  │        │  backend     │     │             │
│   │  bazası       │        └──────────────┘     │             │
│   └──────────────┘                              │             │
│                                                  │             │
│   ┌──────────────┐        ┌──────────────┐      │             │
│   │  Veb panel   │        │  Telegram    │──────┘             │
│   │  (React)     │        │  bot         │                    │
│   └──────────────┘        └──────────────┘                    │
└─────────────────────────────────────────────────────────────┘
```

| Hissə            | Nə edir                                         | İstifadəçi nə görür              |
| ---------------- | ----------------------------------------------- | -------------------------------- |
| **PostgreSQL**   | Bütün məlumatı saxlayır                         | görmür                           |
| **API**          | Biznes məntiqi, tapşırıqlar, yoxlamalar         | görmür (bot ondan istifadə edir) |
| **Veb panel**    | Nəzarətçi üçün idarəetmə ekranı                 | **link açır, panel görür**       |
| **Telegram bot** | Sahə işçisi tapşırığı qəbul edir, foto göndərir | **Telegram-da botla danışır**    |

---

## 2. Başlamazdan əvvəl bilməli olduğunuz 3 şey

### 2.1. Kod hələ GitHub-da deyil

Railway kodu GitHub-dan oxuyur. Layihə hələ GitHub-da olmadığı üçün **Addım 0** məcburidir.

### 2.2. Veb panel hazırda **demo məlumat** göstərir

Veb panel məlumatı birbaşa **Supabase** adlı xarici xidmətdən oxuyur — API-dən yox.
Supabase qurulmayıbsa, panel açılır və işləyir, lakin gördüyünüz bütün mağazalar,
tapşırıqlar və yoxlamalar **uydurma nümunə məlumatdır**.

Bu test deploy üçün normaldır: məqsəd "proqram onlayn işləyir" olduğunu görməkdir.
Real məlumat istəyirsinizsə, bu **Bölmə 6**-da əlavə addımdır.

### 2.3. Şifrələr dəyişdirilməlidir

Köhnə `docker-compose.prod.yml` faylında **sabit, hamıya məlum** bir baza şifrəsi var idi
(`coca_cola_secret_2026`). Bu artıq düzəldildi: indi şifrə verilməzsə sistem **ümumiyyətlə
işə düşmür**. Aşağıdakı addımlarda öz şifrənizi yaradacaqsınız.

### 2.4. Hazırda məlumat bazada saxlanmır — yaddaşda saxlanır

Bunu bilməyiniz vacibdir, çünki pul ödədiyiniz şeyə təsir edir.

Hazırda API və bot bütün məlumatı **yaddaşda** saxlayır. Nəticələr:

- Servis yenidən başladıqda (deploy, restart, nasazlıq) **bütün məlumat silinir**.
- Postgres bazası qoşulub işləyir, lakin **heç bir proqram kodu ona qoşulmur**.
- Yeganə real baza yolu **Supabase**-dir — veb panel birbaşa oradan oxuyur.

Yəni test deploy üçün bu normaldır, lakin real istifadəyə keçməzdən əvvəl API-nin bazaya
qoşulması ayrı bir işdir (Bölmə 6).

> **Nəticə:** «hər şey bir yerdə» API, bot və veb panel üçün doğrudur. Məlumatın özü isə
> hələlik yaddaşdadır və ya Supabase-dədir.

---

## 3. Addım-addım deploy

### Addım 0 — Kodu GitHub-a yerləşdirin

Layihə qovluğu artıq git üçün hazırdır (ilk commit edilib). İndi onu GitHub-a göndərmək lazımdır.

**Ən asan yol — GitHub Desktop:**

1. `desktop.github.com` ünvanından **GitHub Desktop** proqramını endirib quraşdırın.
2. Proqramı açın və GitHub hesabınızla daxil olun.
3. Yuxarı menyudan: **File → Add local repository…**
4. Qovluq seçin: `/Users/macbookair/GitHub/oneTeam`
5. Proqram "This directory does not appear to be a Git repository" yazsa, **"create a repository"**
   linkinə basın və **Create repository** düyməsini basın.
6. Yuxarıda **Publish repository** düyməsini basın.
7. Açılan pəncərədə:
   - **Name:** `oneteam`
   - **☑ Keep this code private** — bu işarəni **mütləq qoyun**.
8. **Publish repository** düyməsini basın.

> **Niyə "private"?** Layihədə həssas məlumat ola bilər. Public repo = hamının gördüyü repo.

---

### Addım 1 — Railway hesabı

1. `railway.com` ünvanına gedin.
2. Sağ yuxarıda **Login** düyməsinə basın.
3. **Login with GitHub** seçin və icazə verin.
4. Hesabınıza **ödəniş kartı** əlavə etməli olacaqsınız (Bölmə 4-ə baxın).

---

### Addım 2 — Yeni proyekt yaradın

1. `railway.com/dashboard` səhifəsinə gedin.
2. Sağ yuxarıda **+ New Project** düyməsinə basın.
3. **Empty Project** seçin.
4. Proyektin adını dəyişin: yuxarıdaki ada basıb **oneteam-test** yazın.

Boş bir "kanvas" görəcəksiniz. Servisləri bura əlavə edəcəyik.

---

### Addım 3 — Verilənlər bazası (PostgreSQL)

1. Kanvasda **+ New** düyməsinə basın.
2. **Database** → **Add PostgreSQL** seçin.
3. Railway bazanı yaradır və adını **Postgres** qoyur.

**Bu addımı dəyişməyin.** Servisin adı `Postgres` qalmalıdır, çünki növbəti addımlarda
ona adı ilə istinad edəcəyik.

> **Qeyd:** Railway-in bazaları "idarə olunmayan" (unmanaged) servislərdir — avtomatik
> ehtiyat nüsxə (backup) yoxdur. Test üçün problem deyil; real istifadəyə keçəndə
> ehtiyat nüsxə ayrıca qurulmalıdır.

---

### Addım 4 — Backend (API) servisi

1. Kanvasda **+ New** → **GitHub Repo** seçin.
2. Siyahıdan **oneteam** reposunu seçin.
3. Servisin adını dəyişin: **api**

İndi servisin **Settings** bölməsinə keçin:

**a) Dockerfile yolu**

- **Settings → Build** bölməsini açın.
- **Dockerfile Path** sahəsinə yazın:

  ```
  apps/api/Dockerfile
  ```

**b) Dəyişənlər (Variables)**

- Servisin **Variables** tabına keçin.
- Sağ yuxarıda **RAW Editor** düyməsinə basın.
- Aşağıdakı sətirləri olduğu kimi yapışdırın və `<...>` yerlərini öz dəyərlərinizlə dəyişin:

  ```
  NODE_ENV=production
  PORT=3001
  DATABASE_URL=${{Postgres.DATABASE_URL}}
  TELEGRAM_BOT_TOKEN=<BotFather-dan aldığınız token>
  TELEGRAM_WEBHOOK_SECRET=<Bölmə 3.1-də yaratdığınız gizli açar>
  CORS_ALLOWED_ORIGINS=https://<veb-panel-ünvanı>
  SUPABASE_URL=https://mock-oneteam.supabase.co
  SUPABASE_ANON_KEY=mock-anon-key
  SUPABASE_SERVICE_ROLE_KEY=mock-service-role-key
  ```

  - `${{Postgres.DATABASE_URL}}` hissəsini **olduğu kimi** saxlayın. Railway bunu
    avtomatik olaraq bazanın ünvanı ilə əvəz edir.
  - `CORS_ALLOWED_ORIGINS` — bunu Addım 5-i bitirdikdən **sonra** doldurun.

**c) Ünvan yaratmaq**

- **Settings → Networking** bölməsini açın.
- **Generate Domain** düyməsinə basın.
- Port soruşsa: **3001**

Bu ünvanı kopyalayın — Telegram botu bura müraciət edəcək. Belə görünəcək:
`api-production-xxxx.up.railway.app`

---

### Addım 5 — Veb panel servisi

1. Kanvasda **+ New** → **GitHub Repo** → yenə **oneteam** reposunu seçin.
2. Servisin adını dəyişin: **web**
3. **Settings → Build → Dockerfile Path** sahəsinə yazın:

   ```
   web/Dockerfile
   ```

4. **Variables** tabına keçin. Bu dəyişənlər **build vaxtı** istifadə olunur
   (Vite onları fayllara "yazır"), ona görə düzgün adla yazılmalıdır:

   ```
   VITE_SUPABASE_URL=https://mock-oneteam.supabase.co
   VITE_SUPABASE_ANON_KEY=mock-anon-key
   ```

   > Supabase qurmasanız da bu iki sətri yazın. Boş qalsa panel yenə açılır,
   > sadəcə demo məlumatla.

5. **Settings → Networking → Generate Domain**. Port soruşsa: **80**

6. Bu ünvanı kopyalayın — **bu, panelinizin linkidir**. Komandaya göndərəcəyiniz link budur.

7. İndi **Addım 4-b**-ə qayıdın və `CORS_ALLOWED_ORIGINS` dəyərini bu ünvanla doldurun:

   ```
   CORS_ALLOWED_ORIGINS=https://<burada-panel-ünvanı>
   ```

   > Niyə? Təhlükəsizlik üçün API yalnız **icazə verdiyiniz ünvandan** gələn
   > sorğuları qəbul edir. Ünvanı yazmasanız, brauzerdən heç bir sorğu keçməyəcək.

---

### Addım 6 — Telegram bot servisi (istəyə bağlı)

> Bu addımı **atlayıb sonra əlavə edə bilərsiniz**. Yalnız paneli görmək istəyirsinizsə,
> birbaşa Addım 7-yə keçin. Botu atlamaq aylıq xərci də azaldır.

1. **+ New** → **GitHub Repo** → **oneteam**
2. Servisin adı: **bot**
3. **Settings → Build → Dockerfile Path**:

   ```
   Dockerfile.bot
   ```

4. **Variables**:

   ```
   NODE_ENV=production
   TELEGRAM_BOT_TOKEN=<BotFather-dan aldığınız token>
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   API_BASE_URL=http://api.railway.internal:3001
   SUPABASE_URL=https://mock-oneteam.supabase.co
   SUPABASE_ANON_KEY=mock-anon-key
   ```

   - `http://api.railway.internal:3001` — bu, Railway-in daxili şəbəkə ünvanıdır.
     `api` servisin adıdır, `3001` isə onun portu. **Dəyişməyin.**

5. Bu servisə **ünvan (domain) lazım deyil**. Bot özü Telegram-a qoşulur.

6. Telegram-a webhook-u bildirin. Terminal açın və yapışdırın
   (`<TOKEN>` və `<API-ÜNVANI>` yerlərini doldurun):

   ```bash
   curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
        -d "url=https://<API-ÜNVANI>/api/notifications/telegram/webhook" \
        -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
   ```

   Cavabda `{"ok":true, ...}` görməlisiniz.

---

### Addım 3.1 — Gizli açarı yaratmaq (TELEGRAM_WEBHOOK_SECRET)

Terminal açmaq üçün: `Cmd + Space` basın, **Terminal** yazın, Enter.

Terminalda bu əmri yapışdırıb Enter basın:

```bash
openssl rand -hex 32
```

Ekranda 64 simvollu təsadüfi bir mətn çıxacaq, məsələn:

```
9f3a7c1e5b8d2046a1c9e7f3b5d8024e6a9c1f7b3d5e8024a6c9f1b3d5e7a902
```

Bu mətni kopyalayın. **Bu, `TELEGRAM_WEBHOOK_SECRET` dəyəridir.** Onu:

- Addım 4-də API servisinin dəyişənlərinə,
- Addım 6-da botun webhook əmrində `secret_token=` hissəsinə

yazacaqsınız. Hər iki yerdə **eyni** olmalıdır.

> **Niyə bu lazımdır?** Telegram webhook ünvanını bilən hər kəs saxta sorğu göndərə bilər.
> Bu açar olmadan API **heç bir** webhook-u qəbul etmir — bu, qəsdən belədir.

---

### Addım 7 — Yoxlama

**7.1. Servislərin işə düşdüyünü yoxlayın**

Kanvasda hər servisin üzərindəki rəngə baxın: **yaşıl** = işləyir, **qırmızı** = xəta.
Qırmızıdırsa, servisin üzərinə basıb **Deploy Logs** bölməsindəki son 20 sətri oxuyun.

**7.2. Veb paneli yoxlayın**

Brauzerdə panel ünvanını açın. Gözlənilən: mağazalar, tapşırıqlar və yoxlamalar olan
idarəetmə paneli açılır.

**7.3. API-ni yoxlayın**

Brauzerdə API ünvanının sonuna `/api/health` əlavə edin:

```
https://<api-ünvanı>/api/health
```

Gözlənilən cavab:

```json
{ "status": "ok", "service": "oneteam-api", "uptimeSeconds": 42, "timestamp": 1789306800000 }
```

> **Diqqət:** `/api/tasks` ünvanını açsanız **401 Unauthorized** görəcəksiniz. Bu **xəta deyil** —
> tapşırıq siyahısı giriş tələb edir və 401 girişin işlədiyini sübut edir. Yoxlama üçün
> `/api/health` istifadə edin.

**7.4. Botu yoxlayın**

Telegram-da botunuza girib **/start** yazın. Cavab gəlməlidir.

---

## 4. Nə qədər pul gedəcək?

| Xərc                                     | Məbləğ                                  |
| ---------------------------------------- | --------------------------------------- |
| Railway **Hobby** planı                  | **$5/ay** (içində $5 istifadə daxildir) |
| Yeni hesab üçün birdəfəlik sınaq krediti | **$5** (ilk günlər pulsuz)              |
| Bu layihənin real istehlakı              | təxminən **$5–15/ay**                   |

Yekun gözlənti: **aylıq təxminən $5–15**. Dəqiq rəqəmi Railway panelində
**Usage** bölməsində görəcəksiniz — orada günlük xərc canlı göstərilir.

**Xərci azaltmağın yolları:**

- Bot servisini hələlik əlavə etməyin (Addım 6-nı atlayın).
- Servis yatmırsa (idle) belə pul gedir. Test bitdikdən sonra servisləri
  **Settings → Danger → Delete Service** ilə silin və ya proyekti **paused** edin.

> **Kart mütləqdir.** Railway 2026-cı ilin mart ayından ödəniş kartı tələb edir.
> Kart əlavə etməsəniz deploy başlamayacaq.

---

## 5. Nə isə səhv olsa

| Əlamət                                                | Səbəb və həll                                                                                                                                        |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Servis qırmızı, logda `EUNSUPPORTEDPROTOCOL`          | `package.json` faylındaki `workspace:*` düzəldilməyib. Bu, artıq düzəldilib — köhnə commit deploy olunursa yaranır. Yenidən push edin.               |
| Servis qırmızı, logda `POSTGRES_PASSWORD is required` | Dəyişənlər yazılmayıb. Addım 4-b-yə qayıdın.                                                                                                         |
| Panel açılır, amma boşdur                             | Normal — demo məlumat. Bölmə 6-ya baxın.                                                                                                             |
| Brauzer konsolunda `CORS` xətası                      | `CORS_ALLOWED_ORIGINS` düzgün yazılmayıb. Protokol (`https://`) daxil olmaqla, panel ünvanını yazın.                                                 |
| Bot `/start`-a cavab vermir                           | (1) `TELEGRAM_BOT_TOKEN` düzgündürmü? (2) Addım 6-6-daki webhook əmri icra olunubmu? (3) API logunda `503` varsa — `TELEGRAM_WEBHOOK_SECRET` boşdur. |
| Log: `PORT` ilə bağlı xəta                            | API servisində `PORT=3001` dəyəri yoxdur. Əlavə edin.                                                                                                |

---

## 6. Sonrakı addımlar — qalan işlər

> **14 sentyabr 2026: canlı sistem yoxlanıldı.** Bu siyahı həmin yoxlamanın
> nəticəsidir. Əvvəlki versiyada olan "API bazaya qoşulmayıb" və "Supabase
> lazımdır" maddələri **artıq keçərli deyil** — API real bazaya qoşulub və sxemi
> özü yaradır.

### ✅ Artıq edilib — təkrar etməyin

| Nə               | Vəziyyət                                                 |
| ---------------- | -------------------------------------------------------- |
| Kod GitHub-da    | ✅ `Enjoyer09/oneTeam`, `main` budağı                    |
| Avtomatik deploy | ✅ hər push üç servisə də çatır (hamısı eyni commit-də)  |
| API → real baza  | ✅ `/api/health` → `persistence: postgres`               |
| Baza sxemi       | ✅ API işə düşəndə özü yaradır və tamamlayır (101 sütun) |
| Giriş qoruması   | ✅ kənar kredensial `/api/portal/...`-da **401** alır    |
| Ehtiyat nüsxə    | ✅ PITR aktiv + gündəlik cədvəl qurulub                  |
| Bot              | ✅ işləyir — **@oneTeamCCIbot**                          |

### 1. 🔴 TƏCİLİ — Telegram bot açarını dəyişin

**Niyə təcili:** hazırkı açar (`8802362949:…`) söhbət tarixçəsinə düşüb. Bot
işlədiyi üçün bu, **aktiv sızma**dır — açarı bilən hər kəs botunuz kimi danışa bilər.

**Necə:**

1. Telegram-da **@BotFather**-i açın.
2. `/revoke` yazın → botunuzu seçin → təsdiqləyin.
3. BotFather yeni açar verəcək (`1234567890:AAH...` kimi). Kopyalayın.
4. Railway → `oneTeam` → **`bot`** servisi → **Variables**.
5. `TELEGRAM_BOT_TOKEN` sətrini tapın → dəyəri yeni açarla əvəz edin → **Save**.
6. Servis özü yenidən başlayacaq. Logda `✅ connected as @oneTeamCCIbot` görməlisiniz.

### 2. 🔴 Panelə giriş açarı yaradın — panel hələ açıqdır

**Niyə:** panel hazırda **heç bir açar tələb etmir**; ünvanı bilən hər kəs girə bilər.
Yoxlanıldı: `liveKeys: 0`, `bootstrapConfigured: false`.

**Necə:**

1. Panelı açın: https://web-production-1392e.up.railway.app
2. Yuxarı sağ küncdəki **açar** düyməsini basın → özünüzə şəxsi açar yaradın.
3. Açarı **təhlükəsiz saxlayın** — bu, sizin girişinizdir.

Açar yaratdığınız **anda** giriş ekranı avtomatik qoşulacaq və kənar giriş bağlanacaq.
Açarı itirsəniz: Railway → `api` → `ONETEAM_PANEL_BOOTSTRAP_KEY` (ən azı 24 simvol)
qoyun, sonra yeni açar yaradın.

### 3. Mağaza kodunu gücləndirin — `ONETEAM_ENROLLMENT_SECRET`

**Niyə:** hazırda cihaz qeydiyyatı üçün **yalnız mağaza kodu** kifayətdir. Mağaza
kodu yarı-açıq məlumatdır (brifinqdə çap olunur, həmkarlar arasında paylaşılır).
Mağaza üzrə limit artıq var, amma əsl həll bu gizli açardır.

**Vacib:** bu, **iki tərəfli** dəyişiklikdir — eyni açar mobil tətbiqin içinə də
yazılmalıdır. Mobil tətbiq hələ real telefonlara çıxmadığı üçün **indi qoymaq
təhlükəsizdir**.

### 4. Foto saxlancı — mağaza sayı artanda

**Niyə:** fotolar hazırda **bazanın içində** saxlanılır (yoxlanıldı:
`photoStorage.driver: "inline"`). 1.5 MB limit var və baza sürətlə böyüyür —
1000+ mağaza üçün uyğun deyil.

**Nə lazım:** Railway-də bucket yaradıb `STORAGE_DRIVER=s3` və `S3_*` dəyişənlərini
`api` servisinə yazmaq.

### 5. Öz domeniniz

Railway → `web` servisi → **Settings → Networking → Custom Domain**.

### 6. Mobil tətbiq — əsl telefonlar üçün

Hazırkı mobil kod **başsız kontroller qatıdır**, əsl telefon tətbiqi deyil: native
kamera və qalıcı saxlanc yoxdur, ona görə hər açılışda yenidən qeydiyyat lazımdır.
**Server tərəfi buna hazırdır** — təkrar qeydiyyat limitə sayılmır, yəni qalıcı
saxlanc əlavə olunanda serverdə heç nə dəyişmir.

---

_Son yenilənmə: 14 sentyabr 2026_
