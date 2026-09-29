# oneTeam — Şəkil Saxlama (Photo Storage) Planı və Bələdçi (AZ)

> **Status:** Qərar verilib — **Cloudflare R2-də qalırıq.** Bu sənəd cari
> vəziyyəti, səbəbləri və production-a keçid üçün mərhələli planı təsvir edir.
> İşi başqa mühəndis/agent götürəndə buradan başlasın.
>
> **Son yenilənmə:** 2026-09-28
> **Əlaqəli kod:** `apps/api/src/modules/storage/`, `src/services/portalApi.ts`,
> `apps/api/src/modules/evidences/evidence.service.ts`, `apps/api/src/main.ts`

---

## 0. TL;DR (bir abzasda)

Şəkillər indi Telegram → bot → (inline base64) → API → **Cloudflare R2** yolu ilə
gedir; production `STORAGE_DRIVER=s3` ilə R2 bucket `oneteam-photos`-a yükləyir və
DB-də yalnız URL saxlanır. Bu iş yükü (oxu-ağır şəkil paylama) üçün R2 **düzgün
production seçimidir**, çünki egress pulsuzdur — S3-ə keçmək bahalaşdırardı. "Pro"
yüksəliş provider dəyişmək yox, R2-nin üstünə arxitektura qurmaqdır: presigned
birbaşa yükləmə, thumbnail üçün Cloudflare Images, imzalı read URL, retention.

---

## 1. Cari vəziyyət (yoxlanılıb, 2026-09-28)

**Transport axını:**

1. Bot Telegram-dan şəkli endirir.
2. `src/services/portalApi.ts` → `uploadShelfPhoto` şəkli `data:image/...;base64,...`
   URL-ə çevirir. Sərt limit: `MAX_PHOTO_BYTES = 1_500_000` (~1.5 MB).
3. Bot həmin data URL-i **inline** olaraq submission JSON body-sində göndərir:
   `POST /api/portal/field/submissions` (`createSubmission`).
4. API `StorageService` (`apps/api/src/modules/storage/storage.service.ts`)
   `STORAGE_DRIVER`-ə görə qərar verir:
   - `inline` (kod default-u) — data URL birbaşa Postgres `task_evidences.photo_url`-a.
   - `s3` — **production bunu işlədir** — baytlar R2-yə yüklənir, DB-də yalnız URL.
5. Offload server tərəfdə, `submitSubmission` içində baş verir → **client dəyişmir**,
   hələ də base64 göndərir; API onu R2-yə köçürür.

**Canlı təsdiq:** `GET /api/health` → `photoStorage: { driver: "s3", detail: "s3 —
bucket \"oneteam-photos\" at ...r2.cloudflarestorage.com" }`.

**Body-limit düzəlişi (commit `cbc6ba1`, 2026-09-28):** inline base64 API body-sindən
keçdiyi üçün Express-in default 100 KB JSON limiti real şəkli `PayloadTooLargeError`
ilə rədd edirdi. `apps/api/src/main.ts`-də app `bodyParser: false` ilə yaradılıb,
JSON/urlencoded parser-lər **5 MB** limitlə əl ilə qeydə salınıb. (`bodyParser: false`
vacibdir: Nest-in default 100 KB parser-i əvvəl işləsə, ikinci parser heç vaxt çatmır.)

---

## 2. Niyə R2-də qalırıq (S3-ə keçmirik)

Yanlış təsəvvür: "S3 pro, R2 ucuz/test variantı". Əslində bizim iş yükü üçün R2
production-un düzgün seçimidir. Şəkillər dəfələrlə **oxunur** (supervisor panel,
vision pipeline, hesabatlar) — bu iş yükündə əsas xərc **egress**-dir (trafiki geri
göndərmək).

|                     | Saxlama       | Egress (geri oxuma)     |
| ------------------- | ------------- | ----------------------- |
| **Cloudflare R2**   | ~$0.015/GB-ay | **$0 (pulsuz)**         |
| **AWS S3 Standard** | ~$0.023/GB-ay | ~$0.09/GB (hər baxışda) |

Miqyas nümunəsi (mənbələrdən): 10 TB saxlama + 50 TB endirmə → R2 ~$150/ay, S3
~$4,730/ay. Fərq bütövlükdə egress-dir. R2-də həmçinin per-region əlavə haqq və
minimum öhdəlik yoxdur.

**R2-dən nə vaxt çıxmaq olar (dürüst caveat-lar) — heç biri bizə hazırda aid deyil:**

- Konkret sertifikatlaşma / data-residency tələbi (data mütləq müəyyən ölkədə qalmalı) və R2 onu vermir.
- Bütün stack artıq dərin AWS/GCP ekosistemindədir və hər şey bir IAM/billing altında istənir.
- Çox yüksək **yazma** əməliyyat həcmi (Class A) — 1000 mağaza/gün bunun yanından keçmir.

---

## 3. Production upgrade planı (prioritet sırası ilə)

Bunlar R2-ni **əvəz etmir**, üstünə qurulur. Sıra dəyər/zəhmət nisbətinə görədir.

### 3.1 — Presigned birbaşa yükləmə (client → R2) ⭐ ƏN YÜKSƏK PRIORITET

**Problem:** indi base64 API-dən keçir (client → API → R2). API hər sorğuda ~1.5 MB-ı
yaddaşda saxlayır, trafik iki dəfə keçir, body-limit problemi buradan doğdu.
**Həll:** client R2-yə **birbaşa** yükləsin (presigned PUT URL), API-yə yalnız
key/URL getsin.
**Kodda bünövrə var:** `apps/api/src/modules/storage/s3-signature.ts` → `signS3Put`,
və `POST /api/portal/field/photos` endpoint-i (`field.controller.ts:392`,
`field.service.ts:1208` → `uploadPhoto`). Bot/mobil hazırda bunu **işlətmir** —
inline yolu işlədir. Addım: client-ə presigned URL alıb birbaşa PUT etmək gücü ver,
sonra submission-da yalnız URL göndər.
**Bonus:** 5 MB body-limit hack-inə ehtiyac qalmır (base64 daha body-dən keçmir).

### 3.2 — Thumbnail / Cloudflare Image Transformations

**Problem:** panel siyahısında hər şəkil tam ölçüdə (1.5 MB) açılır — yavaş və israf.
**Həll:** original R2-də qalır, Cloudflare uçotda ölçüləndirir (resize/webp/avif).
Pulsuz plan **ayda 5000 unikal transformasiya** verir, sonrası **$0.50/1000**.
Ayrı Cloudflare Images məhsuluna keçmək məcburi deyil — R2-dəki original üzərində
Transformations işləyir.

### 3.3 — İmzalı, müddətli read URL-lər (təhlükəsizlik)

**Problem:** şəkillərdə kommersiya datası və təsadüfi PII ola bilər (qiymət etiketi,
kadrda kənar adam) — bunu `src/services/vision/index.ts` özü qeyd edir.
**Həll:** bucket **public olmamalı**; şəkillər signed, expiring URL ilə verilməli.
Provider-dən asılı deyil — production təhlükəsizlik tələbidir.

### 3.4 — Retention / lifecycle siyasəti

**Sual:** audit şəkilləri nə qədər qalmalıdır? Əbədi, yoxsa N aydan sonra?
**Həll:** R2 Infrequent Access tier (~$0.01/GB) və ya müddət sonu avtomatik silmə.
Bu, hüquqi/compliance qərarıdır — məhsul sahibi ilə təsdiqlənməli.

---

## 4. Xərc təxmini (oneTeam üçün)

Real rəqəm kiçikdir: 1000 mağaza × gündə 1 şəkil × ~100–150 KB (Telegram şəkli sıxır)
≈ **~4–5 GB/ay**. Bir illik ~55 GB → saxlama **ayda bir neçə dollar**, egress $0,
əməliyyatlar cüzi. Yəni "R2 pullu versiya" burada praktiki olaraq cib xərcidir.

⚠️ **Dəqiq bill üçün** Cloudflare-in öz kalkulyatorundan istifadə et — bu rəqəmlər
təxminidir və qiymətlər dəyişə bilər:

- R2 pricing: https://developers.cloudflare.com/r2/pricing/
- R2 kalkulyator: https://r2-calculator.cloudflare.com/
- Cloudflare Images/Transformations pricing: https://developers.cloudflare.com/images/pricing

---

## 5. Açıq qərarlar (məhsul sahibi ilə təsdiqlənməli)

- [ ] Audit şəkilləri üçün **saxlama müddəti** (retention) nə qədərdir?
- [ ] Presigned birbaşa yükləmə mobil + bot-un hər ikisində eyni vaxtda tətbiq olunsun?
- [ ] Thumbnail üçün Cloudflare Transformations bəs edir, yoxsa tam Images məhsulu?
- [ ] R2 bucket-ə çıxış açarları (`STORAGE_*` env) rotasiya siyasəti varmı?

---

## 6. Fayl xəritəsi (haradan başlamalı)

| Nə                                                     | Fayl                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Storage driver seçimi (inline/s3), health-ə report     | `apps/api/src/modules/storage/storage.service.ts`                              |
| S3/R2 imza + data URL decode                           | `apps/api/src/modules/storage/s3-signature.ts`                                 |
| Presigned yükləmə endpoint-i (hazırda client işlətmir) | `apps/api/src/modules/portal/field.controller.ts:392`, `field.service.ts:1208` |
| Evidence yazılışı (photo_url burada saxlanır)          | `apps/api/src/modules/evidences/evidence.service.ts:321`                       |
| Bot tərəfi: şəkil → data URL, submission               | `src/services/portalApi.ts` (`uploadShelfPhoto`, `createSubmission`)           |
| API body-limit (5 MB, `bodyParser: false`)             | `apps/api/src/main.ts`                                                         |
| Konfiqurasiya                                          | Railway `api` servisində `STORAGE_DRIVER`, `STORAGE_*` env                     |

---

## 7. Xülasə tövsiyə

Mass production-da da **R2-də qalın.** Ardıcıllıq:

1. Presigned birbaşa yükləmə (§3.1) — API artıq megabaytları proxy etməsin.
2. Panel üçün thumbnail / Transformations (§3.2).
3. Signed read URL + retention (§3.3, §3.4).

S3-ə "daha korporativ görünür" deyə keçmək bu iş yükündə sadəcə bahaya başa gələr.
Provider deyil, yuxarıdakı arxitektura qatları əsl "pro" fərqi yaradır.
