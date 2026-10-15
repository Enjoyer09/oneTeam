# oneTeam — Arxitektura Auditi

- **Tarix:** 2026-09-26
- **Əhatə:** `apps/api` (NestJS), `packages/{database,types}`, `web`, `mobile`, `src/bot`, `src/services`, DB sxemləri, CI/CD, deploy, sənədləşmə (~34k sətir TypeScript)
- **Metod:** yalnız-oxu statik audit; heç bir fayl dəyişdirilməyib. Tapıntılar `fayl:sətir` sübutu ilə verilir.
- **Rollar:** backend API, data layer & təhlükəsizlik, web portal, mobil/bot/AI vision, devops/test/deploy — beş istiqamətdə ayrıca araşdırma.

---

## 0. Xülasə: sənəd ≠ kod

README sistemi **Supabase-direct BaaS** kimi təsvir edir (PostgREST, Supabase Auth/Storage, RLS). **Kod bunu artıq etmir.** Real memarlıq:

- **NestJS API təbəqəsi** (`apps/api`) — web, bot və mobil hamısı bu API-ni çağırır.
- API **"in-memory-first" replika** üzərində işləyir, PostgreSQL-ə write-through edir (`persistence='memory'`).
- Web portal nginx ilə **same-origin** API-yə gedir; Supabase klienti tamamilə çıxarılıb.

Sistem README yazandan xeyli irəlidə və daha ciddidir. Amma bu **uyğunsuzluğun özü riskdir**: `README.md:13-199` köhnəlib və yeni mühəndisi səhv backend qurmağa aparır; kod şərhləri isə güncəldir — daxili ziddiyyət.

---

## Şiddət xülasəsi

| #   | Tapıntı                                                       | Şiddət    | Sahə          |
| --- | ------------------------------------------------------------- | --------- | ------------- |
| K1  | İmzasız, əbədi admin service credential (`oneteam-user:<id>`) | 🔴 Kritik | Auth          |
| K2  | AI Vision əslində işləmir (simulyasiya + stok YOLO)           | 🔴 Kritik | Məhsul        |
| K3  | Orphaned + drift etmiş Prisma sxemi, quraşdırılmış Prisma CLI | 🔴 Kritik | Data          |
| K4  | Offline queue heç vaxt boşalmır → data itkisi                 | 🔴 Kritik | Mobil         |
| Y1  | Üç uyğunsuz sxem nəsli                                        | 🟠 Yüksək | Data          |
| Y2  | Soft delete yoxdur; CASCADE sübutu məhv edir                  | 🟠 Yüksək | Data          |
| Y3  | DB-tier authz yoxdur (superuser, RLS yox)                     | 🟠 Yüksək | Təhlükəsizlik |
| Y4  | Store-code binding-də authorization yoxdur                    | 🟠 Yüksək | Auth          |
| Y5  | GPS anti-fraud dağıdıla bilir                                 | 🟠 Yüksək | Mobil         |
| Y6  | Device-token revoke endpoint-i yoxdur                         | 🟠 Yüksək | Auth          |
| Y7  | CI testlərin yalnız bir hissəsini qaçırır; coverage yox       | 🟠 Yüksək | Test          |
| Y8  | SAST/dependency scan/CodeQL/Dependabot yoxdur                 | 🟠 Yüksək | Təhlükəsizlik |
| Y9  | CD pipeline yoxdur, deploy reproduksiya olunmur               | 🟠 Yüksək | DevOps        |
| Y10 | DB backup/PITR/retention yoxdur                               | 🟠 Yüksək | DevOps        |
| Y11 | Keçmişdə commit olunmuş SSH private key                       | 🟠 Yüksək | Təhlükəsizlik |
| Y12 | README kritik dərəcədə köhnəlib                               | 🟠 Yüksək | Sənəd         |

Orta şiddətli tapıntılar (O1–O14) §2.3-də sadalanır.

---

## 1. Güclü tərəflər (qorunmalı olanlar)

Bu, mərhələsinə görə **qeyri-adi intizamlı** kod bazasıdır.

**Təhlükəsizlik memarlığı**

- **Fail-closed auth**: DB xətası olanda device/panel token yoxlaması `null` (rədd) qaytarır — "yoxlaya bilmədim" heç vaxt "yoxladım, təmizdir"-ə çevrilmir (`apps/api/src/common/auth/auth.guard.ts`).
- **Privilege escalation qapısı**: `fromUserId`-də `via` arqumenti məcburidir — əvvəllər səssiz səlahiyyət yüksəlişinə səbəb olan default silinib.
- **Route-level authority gate**: supervisor route-ları device credential-i rədd edir; panel açarı mövcud olanda edge-inject service token-i də rədd edir (kompromitasiya olunmuş botun panel açarı yaratma dəliyini bağlayır).
- **Token-lar plaintext saxlanmır**: SHA-256 hash + `timingSafeEqual`. Webhook secret və bootstrap key də constant-time.
- **`.env`-də real secret yoxdur**, `.gitignore`/`.dockerignore` düzgün, mənbədə hardcoded credential yoxdur. Güclü **secret-scanner** (`scripts/quality/secret-scan.mjs`, 15+ detektor) CI + pre-commit-ə bağlıdır.
- **S3 SigV4 əl ilə yazılıb** (`apps/api/src/modules/storage/s3-signature.ts`), hədəf yalnız env-dən gəlir → **SSRF yoxdur**.

**Data & migrasiya intizamı**

- Migrasiya runner-i (`packages/database/src/migrations.ts`): transaction-lu DDL, advisory-lock (replikalar ikiqat tətbiq etmir), per-migration SHA checksum + drift aşkarlanması, konflikt olan legacy cədvəli görəndə imtina edir.
- Yaxşı index gigiyenası: partial index-lər (`WHERE revoked_at IS NULL`), JSONB üçün GIN, məntiqli UNIQUE-lər, append-only `audit_logs`.

**Notification & resilience**

- **Outbox pattern**: API `dedupeKey` ilə növbəyə qoyur, bot lease/claim ilə drenaj edir (at-least-once). Dürüst hesablama — botla danışmamış merçendayzer "recipient yoxdur" kimi bildirilir, səssizcə itmir.
- Bot: global `bot.catch`, graceful shutdown, 409 polling backoff, Postgres-backed persistent session-lar.

**Frontend & mobil**

- Web: təmiz same-origin data təbəqəsi (`web/src/lib/portalApi.ts`), **şəxsi panel açarları** (bir dəfə göstərilir, geri çağırıla bilir), **XSS səthi sıfır**, a11y focus-trap hook (`web/src/lib/useModalA11y.ts`, WCAG 2.4.3), rəng-kontrast dizayn token-lərinə həkk olunub.
- Mobil offline queue yaxşı mühəndislənib (`mobile/src/services/offlineQueue.ts`): 50MB dolanda **köhnəni atmır, imtina edir**, retry, UTF-8 bayt uçotu. Keychain `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, identity/credential ayrılığı.
- **"Break detector"** (`scripts/dev/break-detector-*.mjs`): hər testin iddia etdiyi defekti bir-bir koda geri salıb uyğun yoxlamanın qırmızı olduğunu təsdiqləyən mutasiya-testi. Real, ciddi meta-test.

---

## 2. Zəif tərəflər və risklər

### 2.1 🔴 Kritik

**K1. İmzasız, əbədi admin service credential.**
`oneteam-user:<userId>` token-i imzasız, şifrələnməmiş, müddətsiz plaintext-dir və **istənilən istifadəçini (o cümlədən admin-i) təqlid edir** (`auth.guard.ts:178-179`). Botun default token-i `oneteam-user:usr-admin-001`-dir (`src/services/portalApi.ts:74`), `package.json:16`-da da hardcoded. Kim bu sətri əldə etsə — əbədi admin. Bütün təhlükəsizlik nginx edge-inin və bot token-inin sirr qalmasına dayanır. JWT yox, imza yox, expiry yox, rotasiya yox.

**K2. AI Vision əslində işləmir — məhsulun əsas dəyər vədi aspirasionaldır.**
Planogram uyğunluğu hələ şəkildən avtomatik təsdiqlənmir. Keçmiş `yolo_inference.py` rəng heuristikası ilə generic COCO `bottle` qutularını marka kimi göstərirdi; həmin Ultralytics skripti çıxarılıb. Worker indi TorchVision istifadə edir, amma checkpoint yoxdursa `disabled` qalır. SKU-ya öyrədilmiş, holdout datasında qiymətləndirilmiş production modeli yoxdur; rəf qərarı insan review-u tələb edir. API-nin qayda-əsaslı balı metadata siqnallarından (`portal.service.ts` `autoApproveSubmission`) gəlir və piksel analizi deyil; `ai_score` submit-də `null` qalır.

**K3. Orphaned Prisma sxemi = production-a tuşlanmış dolu tapança.**
`packages/database/prisma/schema.prisma` runtime-da istifadə olunmur (paket yalnız `pg`-yə bağlıdır), amma **kök `package.json:87,95`-də Prisma CLI quraşdırılıb** və eyni `DATABASE_URL`-a çıxışı var. Sxem authoritative bazadan **drift edib** (6 cədvəl yox, PK tipləri fərqli). Təsadüfi bir `prisma db push` authoritative DB-ni korlaya bilər.

**K4. Offline queue heç vaxt boşalmır — data itkisi riski.**
Bağlantı aşkarlanması (`setOnlineStatus`) production-da **heç çağırılmır** və növbəni boşaltmaq üçün əlçatan UI yoxdur (`mobile/src/services/offlineQueue.ts`). Offline çəkilən auditlər səssizcə ilişib qala bilər.

### 2.2 🟠 Yüksək

- **Y1. Üç uyğunsuz sxem nəsli**: Supabase legacy (`init_schema.sql` + `supabase/migrations`), authoritative API (`db/api-schema.sql` + `db/migrations`), və orphaned Prisma. Yalnız API nəsli canlıdır.
- **Y2. Soft delete yoxdur; CASCADE uyğunluq sübutunu məhv edir.** `store_task` silinəndə `task_evidences` (şəkillər, GPS, AI verdikti) da silinir (`api-schema.sql:176`).
- **Y3. DB təbəqəsində authorization yoxdur.** API `postgres` **superuser** ilə qoşulur (`.env:15`), authoritative sxemdə RLS yoxdur, legacy RLS ölü koddur. `DATABASE_URL` sızsa — məhdudiyyətsiz çıxış.
- **Y4. Store-code binding-də authorization yoxdur.** İstənilən Telegram istifadəçisi istənilən mağaza koduna bağlanıb tapşırıqlarını götürə bilər (`src/bot/handlers/start.ts`).
- **Y5. GPS anti-fraud dağıdıla bilir.** Server client koordinatlarına etibar edir (mock-location aşkarlanması yox, `accuracy` nəzərə alınmır), `locationUnverified:true` **qəbul olunan bypass-dır** (`field.service.ts:809`).
- **Y6. Device-token revoke endpoint-i yoxdur** — sızmış `otd_` token-i öldürülə bilmir.
- **Y7. CI testlərin yalnız bir hissəsini qaçırır.** `test:live` qrupu (roles, auth, CRUD, notifications) CI-də heç qaçmır (`ci.yml:154`); break-detector də yox; **coverage ölçülmür**; real HTTP/e2e/Postgres integration testi yoxdur.
- **Y8. SAST / dependency audit / CodeQL / Dependabot yoxdur.** `npm ci --no-audit` audit-i söndürür.
- **Y9. CD pipeline yoxdur**, repo-da Railway config yoxdur — deploy əllə, reproduksiya olunmur.
- **Y10. DB backup / PITR / retention yoxdur** — yalnız lokal named volume.
- **Y11. Keçmişdə commit olunmuş SSH private key** — history taraması qəsdən sönülüdür; açar kompromitasiya sayılıb rotasiya olunmalıdır.
- **Y12. README kritik dərəcədə köhnəlib** — səhv backend qurmağa aparır.

### 2.3 🟡 Orta

- **O1.** Global exception filter yoxdur → uyğunsuz error formatları (bəzi handler string, bəzi struktur obyekt).
- **O2.** Global `ValidationPipe` / DTO validasiyası yoxdur — controller body-ləri `any`, validasiya əllə.
- **O3.** Rate limiting yalnız enrollment-də var, o da **per-replica in-memory** (çox replikada bypass); auth cəhdləri throttle olunmur.
- **O4.** API not-found/forbidden üçün **HTTP 200** qaytarır (`tasks.controller.ts:51`) — REST semantikasını pozur.
- **O5.** API versiyalama, pagination, idempotency key-lər yoxdur.
- **O6.** Web god-komponentlər (`TaskManager.tsx` 1341 sətir, `App.tsx` 611 sətir), qalıq hardcoded demo data, `alert()`-əsaslı validasiya, real-time yoxdur, virtualizasiya yoxdur, error boundary yoxdur, CSP yoxdur.
- **O7.** API sxemində `updated_at` trigger-i yoxdur — sahə yalnız app xatırlasa yenilənir.
- **O8.** PII/GPS plaintext, at-rest şifrələmə yoxdur, retention siyasəti yoxdur (yalnız `bot_sessions` TTL).
- **O9.** Konteynerlər **root** ilə işləyir, resource limit yoxdur, `Dockerfile.bot` production-da runtime `tsx` ilə transpile edir, DB portu default host-a açılır.
- **O10.** Monorepo çaşqınlığı: npm workspaces işlədilir, amma `pnpm-workspace.yaml` + `turbo.json` ölü konfiqdir (turbo quraşdırılmayıb; `turbo.json` köhnə `"pipeline"` açarı ilə səhv Turbo major üçün).
- **O11.** Metrics/tracing/structured log/request-ID yoxdur.
- **O12.** Şəkillər **inline data URL** kimi saxlanır, real object storage-də yox.
- **O13.** Test izolyasiyası zəif (paylaşılan in-memory `db`, teardown yox).
- **O14.** Server-side idempotency/dedup yoxdur — `createEvidence` şərtsiz yazır.

---

## 3. Əskik funksionallıqlar

**Məhsul səviyyəsində**

- Real kompüter görməsi ilə uyğunluq: SKU-ya öyrədilmiş model, barkod/planogram uyğunlaşdırması, facing & shelf-share sayımı.
- Supervisor portalında: axtarış, real-time yeniləmə, bulk review, hesabat/eksport (CSV/PDF), UI-də audit-log baxışı.
- Anti-fraud: mock-location aşkarlanması/attestation, foto authenticity (liveness/provenance), real blur/piksel analizi.

**Platforma səviyyəsində**

- İmzalı/expiry-li token-lar + rotasiya; device-token revoke endpoint-i.
- Soft delete / sübut qorunması.
- DB backup + PITR + rollback proseduru + retention siyasəti.
- CD pipeline + repo-da deploy config.
- Coverage ölçmə + real e2e/Postgres integration testləri CI-də; dependency/SAST scanning.
- Observability: metrics, tracing, structured logs.
- Object storage inteqrasiyası; idempotency guard; GDPR/PII (consent, DSAR, at-rest şifrələmə).

---

## 4. Tövsiyələr (prioritetli yol xəritəsi)

### P0 — dərhal (təhlükəsizlik & data bütövlüyü)

1. **Orphaned Prisma-nı zərərsizləşdir**: `packages/database/prisma/schema.prisma`-nı sil və kök `package.json`-dan işlənməyən `prisma`/`@prisma/client`-ı çıxar. Ən ucuz-ən böyük risk azaldılması.
2. **Service credential-i imzalı token-ə keçir**: qısa-ömürlü JWT (və ya HMAC-imzalı, expiry+rotasiya-lı). Bot və edge üçün ayrı, revoke edilə bilən identifikatorlar. Aralıq addım: default `usr-admin-001`-i sil, token-i env-dən məcburi et.
3. **Sızmış SSH açarını rotasiya et** və git-history secret remediation planla.
4. **Offline queue drenajını düzəlt**: bağlantı aşkarlanması + boşaltma UI-si (aktiv data itkisi riski).
5. **Least-privilege DB rolu**: API-ni superuser yox, məhdud `app` rolu ilə qoşdur.
6. **Server-side idempotency** əlavə et (evidence yaradılmasında dedup açarı).
7. **Device-token revoke endpoint-i** əlavə et; `locationUnverified` bypass-ını bağla və ya açıq gate et.

### P1 — məhsul dəyəri & möhkəmlik

8. **AI vision barədə strateji qərar**: ya real CV qur (retail-öyrədilmiş model, barkod/facing/shelf-share), ya da məhsulu dürüstcə "köməkçi əl-ilə baxış" kimi mövqeləndir.
9. **Soft delete / sübut qorunması** (CASCADE compliance-ı silməsin).
10. **Global `ValidationPipe` + DTO-lar**, **global exception filter**, HTTP status semantikasını düzəlt (404/403).
11. **Store-code binding authorization** (invite/allow-list).
12. **Distributed rate limiting** (auth + enrollment; paylaşılan store).
13. **CI-ni tamlaşdır**: `test:live` + break-detector qaçır, coverage, real Postgres/e2e integration, SAST + Dependabot + CodeQL.
14. **CD pipeline + repo-da deploy config**; **DB backup/PITR + retention siyasəti**.
15. **README-ni realla uyğunlaşdır**; ADR + CHANGELOG əlavə et.

### P2 — keyfiyyət & miqyas

16. Web: god-komponentləri parçala, demo data-nı sil, `alert()`-i inline validasiya ilə əvəz et, **error boundary + CSP**, virtualizasiya, real-time, axtarış/eksport/bulk-review; **React Query/SWR**.
17. `updated_at` trigger-ləri; **object storage** (inline data URL əvəzinə); at-rest şifrələmə (GPS/PII).
18. Konteyner sərtləşdirmə: non-root user, resource limit, `Dockerfile.bot` multi-stage + compiled, `--omit=dev`.
19. **Monorepo alətini bir et**: ya npm-workspaces qal (ölü `pnpm-workspace.yaml`+`turbo.json`-u sil), ya pnpm+turbo-ya tam keç.
20. Observability: Prometheus/OTel, tracing, request-ID-li structured log; mobil-də real navigation stack + ölü `MobileAppCoordinator`-i sil; i18n framework.

---

## Yekun qiymət

Mühəndislik keyfiyyəti — backend intizamı, secret gigiyenası, migrasiya runner-i, outbox, test meta-riqoru — bu mərhələ üçün gözlənildiyindən yüksəkdir. İki fundamental problem məhsulu production-a yaxınlaşmaqdan saxlayır: **(1) imzasız əbədi admin token** (bütün auth modelinin təməli bir sirrdə), və **(2) əsas dəyər vədi olan avtomatik CV uyğunluğunun real olmaması**. Bunların yanında sxem nəsli çoxluğu, orphaned Prisma, offline queue drenajı və DB-tier authz — həll olunası, amma aydın risklərdir.

_Bu audit yalnız-oxu analizə əsaslanır; heç bir fayl dəyişdirilməyib. `fayl:sətir` istinadları auditin aparıldığı andakı vəziyyəti əks etdirir._
