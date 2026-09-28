# oneTeam — Presigned Birbaşa Yükləmə (§3.1) İcra Planı (AZ)

> **Status:** Plan — hələ tətbiq edilməyib. Bu, `PHOTO-STORAGE-PLAN-AZ.md`
> §3.1-in konkret icra sənədidir. Məqsəd: şəkil baytlarını API-dən **keçirməmək**,
> client birbaşa Cloudflare R2-yə yükləsin, submission-a yalnız URL getsin.
>
> **Son yenilənmə:** 2026-09-28
> **Əlaqəli sənəd:** `docs/PHOTO-STORAGE-PLAN-AZ.md` §3.1
> **Əlaqəli kod:** `apps/api/src/modules/storage/s3-signature.ts`,
> `apps/api/src/modules/storage/storage.service.ts`,
> `apps/api/src/modules/portal/field.{controller,service}.ts`,
> `src/services/portalApi.ts`, `apps/api/src/main.ts`

---

## 0. TL;DR

Hazırda şəkil `client → API (base64 body) → R2` yolu ilə gedir; API hər sorğuda
şəkli yaddaşda saxlayır və 5 MB body-limit bunun üçün qaldırılıb (commit `cbc6ba1`).
Presigned yükləmədə axın `client → R2 (birbaşa PUT)` olur, API yalnız qısa-müddətli
imzalı URL verir. Nəticə: API megabaytları proxy etmir, body-limit hack-inə ehtiyac
qalmır, miqyas ucuzlaşır.

---

## 1. Vacib texniki fərq (niyə mövcud kod bəs etmir)

İki şeyi qarışdırmaq olmaz:

- **`signS3Put` (mövcud)** — *header*-ləri imzalayır və **konkret payload hash**
  tələb edir (`x-amz-content-sha256 = sha256(body)`). Bu, **server** baytları
  əlində tutub özü PUT edəndə işləyir. Client-ə vermək olmaz, çünki imza anında
  baytların hash-i lazımdır — client hələ onları göndərməyib.
- **Presigned URL (yeni lazımdır)** — imza **query string**-də olur
  (`X-Amz-Signature`, `X-Amz-Credential`, `X-Amz-Date`, `X-Amz-Expires`,
  `X-Amz-SignedHeaders`), payload isə `UNSIGNED-PAYLOAD` kimi imzalanır. Belə URL-i
  client istənilən baytla PUT edə bilər; server baytları görmür.

`/api/portal/field/photos` endpoint-i də presigned deyil — o, base64-ü **API-dən
keçirib** `uploadBase64` ilə server tərəfdə yükləyir. Yəni proxy problemi qalır.
Deməli §3.1 üçün **yeni imzalayıcı funksiya + yeni endpoint** yazılmalıdır.

---

## 2. Server dəyişiklikləri

### 2.1 — `s3-signature.ts`: `signS3PresignedPut` əlavə et
Yeni, təmiz (pure) funksiya, mövcud `signS3Put`-a toxunmadan:

- İmza SigV4 query-string formasında (`X-Amz-*` query paramları).
- `X-Amz-SignedHeaders=host` (yalnız host imzalanır — client yalnız `Content-Type`
  göndərə bilsin deyə host-la məhdudlaşırıq; istəsək `content-type`-ı da imzalı
  siyahıya sala bilərik, onda client eyni `Content-Type`-ı byte-identik göndərməlidir).
- Payload: `UNSIGNED-PAYLOAD`.
- Parametrlər: `{ target, key, contentType, expiresSeconds, now? }` → `{ url }`.
- `now` parametr olaraq qalsın (pure test üçün, `signS3Put` kimi).
- Path-style / RFC3986 encode məntiqini mövcud `uriEncode`/`encodePath`/`amzDate`/
  `parseEndpoint` köməkçiləri ilə **paylaş** — kopyalama yox.

### 2.2 — `storage.service.ts`: `createPresignedUpload` əlavə et
```
createPresignedUpload({ contentType, scope }): {
  uploadUrl: string;   // client bura PUT edir
  publicUrl: string;   // submission-da bu göndərilir (publicUrlFor(key))
  key: string;         // mintKey(scope, contentType) — SERVER təyin edir
  expiresAt: string;   // ISO
  requiredHeaders: { 'Content-Type': string };
}
```
- **Key-i həmişə server minləsin** (`mintKey`) — client key seçə bilməməlidir
  (təhlükəsizlik: əks halda başqa obyektin üstünə yaza bilər).
- `driver !== 's3'` olduqda `uploadPhoto`-dakı kimi `STORAGE_NOT_CONFIGURED`
  (503) at — inline rejimdə presigned mənasızdır.
- Expiry: yeni env `S3_PRESIGN_EXPIRY_SECONDS` (default 300s = 5 dəq).

### 2.3 — `field.controller.ts` + `field.service.ts`: yeni endpoint
- `POST /api/portal/field/photos/presign` — **service actor** tələb olunur
  (`requireServiceActor`, mövcud `/photos` kimi).
- Body: `{ contentType?: string; scope?: string }`.
- Service: `createPresignedUpload`-a ötür, inline guard-ı saxla.
- Köhnə `/photos` (server-side upload) **silinmir** — geriyə uyğunluq üçün qalır.

---

## 3. Client dəyişiklikləri

### 3.1 — Bot (`src/services/portalApi.ts`)
Hazırkı axın: `uploadShelfPhoto` → data URL (base64) → `createSubmission` body-də inline.

Yeni axın:
1. `requestPresignedUpload({ contentType, scope: taskId })` → API-dən `uploadUrl` +
   `publicUrl` + `requiredHeaders` al.
2. Şəkil baytlarını **birbaşa** `uploadUrl`-ə `PUT` et (`Content-Type` başlığı ilə).
   Bot server tərəfdə Node `fetch` işlədir → **CORS problemi yoxdur**.
3. `createSubmission`-da `photoUrl` olaraq artıq base64 yox, `publicUrl` göndər.
- `MAX_PHOTO_BYTES` client-tərəf ölçü yoxlaması kimi qala bilər (vision xərci və
  sağlamlıq üçün), amma daha body-limitə bağlı deyil.

### 3.2 — Mobil app
Eyni üç addım. **Diqqət:** əgər mobil browser/WebView-dən birbaşa PUT edirsə, R2
bucket-ində **CORS** icazəsi lazımdır (PUT + `Content-Type` header, mobil origin).
Native HTTP klient (React Native fetch/OkHTTP/URLSession) CORS-a tabe deyil.

---

## 4. Təhlükəsizlik və doğrulama

- **Client ixtiyari URL göndərə bilməz problemi:** submission `photoUrl`-u indi
  client verir. API `photoUrl`-un bizim bucket public prefiksi (`S3_PUBLIC_BASE_URL`
  və ya endpoint/bucket) ilə başladığını **yoxlamalıdır** — kənar URL rədd edilsin.
- **İstəyə görə HEAD yoxlaması:** submit anında obyektin həqiqətən mövcud olduğunu
  R2-də `HEAD` ilə təsdiqləmək olar (client PUT-u uğursuz olubsa boş URL keçməsin).
  Zəhmət/dəyər nisbətinə görə v1-də buraxıla bilər.
- **Key server tərəfdən minlənir** → client obyekt adını idarə edə bilmir.
- Presigned URL qısa-müddətlidir (5 dəq) — sızsa belə tez etibarsız olur.

---

## 5. Rollout sırası (təhlükəsiz, additive)

1. Server: `signS3PresignedPut` + `createPresignedUpload` + `/photos/presign`
   endpoint (heç bir mövcud davranışı pozmur — yalnız əlavə).
2. Botu presigned axına keçir; canlı sınaq (real şəkil → R2-də obyekt → submission).
3. Mobili keçir (lazımsa R2 CORS konfiqi).
4. Hər iki client presigned işlədəndən **sonra**: `main.ts`-dəki 5 MB body-limiti
   geri kiçilt (inline base64 artıq body-dən keçmir). Bunu erkən etmə — köhnə
   client versiyaları hələ inline göndərə bilər.
5. Köhnə inline offload yolu (`persistPhoto`) fallback kimi qalsın.

---

## 6. Test planı

- **Unit:** `signS3PresignedPut`-u pin-lənmiş `now` ilə real S3 (MinIO) və/və ya
  AWS-in rəsmi presign test-vektoruna qarşı yoxla — `signS3Put`-un test üsulu ilə eyni.
- **Integration:** `/photos/presign` service actor tələb edir; inline rejimdə 503.
- **E2E:** presign al → baytları PUT et → `publicUrl`-u GET et → submission yarat →
  `task_evidences.photo_url` = publicUrl.
- **Regression:** köhnə inline submission yolu hələ işləyir.

---

## 7. Konfiqurasiya (env)

Yeni env yalnız biri (qalanı mövcud R2 dəyərləridir):

| Env | Rol |
|---|---|
| `S3_PRESIGN_EXPIRY_SECONDS` | Presigned URL ömrü (default 300) |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_BASE_URL`, `S3_FORCE_PATH_STYLE` | Mövcud — dəyişmir |

R2 bucket CORS (yalnız browser/WebView client üçün): `PUT` metodu, `Content-Type`
başlığı, uyğun origin-lər.

---

## 8. Fayl xəritəsi (harada nə dəyişir)

| Nə | Fayl |
|---|---|
| Query-string presign imzalayıcı (YENİ) | `apps/api/src/modules/storage/s3-signature.ts` → `signS3PresignedPut` |
| Presign URL minləyən servis metodu (YENİ) | `apps/api/src/modules/storage/storage.service.ts` → `createPresignedUpload` |
| `POST /photos/presign` endpoint (YENİ) | `apps/api/src/modules/portal/field.controller.ts` |
| Endpoint service wrapper + inline guard (YENİ) | `apps/api/src/modules/portal/field.service.ts` |
| Bot: presign al → birbaşa PUT → URL submit | `src/services/portalApi.ts` (`uploadShelfPhoto`, `createSubmission`) |
| Mobil: eyni axın (+ lazımsa R2 CORS) | mobil upload kodu |
| 5 MB body-limitin geri kiçildilməsi (client-lər keçəndən SONRA) | `apps/api/src/main.ts` |

---

## 9. Effort / risk

- **Effort:** server ~yarım gün (imzalayıcı + endpoint + test), bot ~1-2 saat,
  mobil ~1-2 saat + CORS.
- **Əsas risk:** presigned SigV4 imzasında subtle səhv → R2-dən 403 (səbəbi
  görünmür). Ona görə MinIO/real-vektor testi **məcburidir**, kod-oxumaya güvənmə.
- **Blast radius:** additive — köhnə inline yol toxunulmadan qaldığı üçün geriyə
  dönüş asandır (client-i köhnə axına qaytar).
