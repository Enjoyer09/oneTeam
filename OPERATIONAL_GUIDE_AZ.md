# 🔴 oneTeam (Coca-Cola FMCG) — İcraçı Əməliyyat Bələdçisi (Operational Runbook)

> **Məqsəd:** Bu sənəd layihə rəhbəri (Product Owner), Kommersiya Direktoru və Pərakəndə Əməliyyat Menecerləri üçün hazırlanmışdır. Heç bir texniki proqramlaşdırma biliyi tələb etmədən platformanın bütün imkanlarını asanlıqla idarə etməyə imkan verir.

---

## 📌 Mündəricat

1. [Sistemin 1 Kliklə İşə Salınması (Local Demo Rejimi)](#1-sistemin-1-kliklə-işə-salınması-local-demo-rejimi)
2. [Menecer Portalı: Mağaza Seqmentasiyası və Kütləvi Tapşırıq Paylanması](#2-menecer-portalı-mağaza-seqmentasiyası-və-kütləvi-tapşırıq-paylanması)
3. [Sahə Merçendayzeri: Telegram Bildirişi, GPS Mühafizəsi və Rəf Auditi](#3-sahə-merçendayzeri-telegram-bildirişi-gps-mühafizəsi-və-rəf-auditi)
4. [Supervayzer Yoxlama Mərkəzi: AI Planogram Təhlili, Əvvəl/Sonra Müqayisəsi və Təsdiq](#4-supervayzer-yoxlama-mərkəzi-ai-planogram-təhlili-əvvəlsonra-müqayisəsi-və-təsdiq)
5. [İstehsalat və Bulud Yerləşdirməsi (Docker & Railway)](#5-istehsalat-və-bulud-yerləşdirməsi-docker--railway)

---

## 1. Sistemin 1 Kliklə İşə Salınması (Local Demo Rejimi)

Bütün platformanı (Veb Panel, Telegram Bot Xidməti və Core API mühərrikini) dərhal canlı görmək üçün sadəcə 1 əmr kifayətdir:

### Addım 1: Terminalı Açın və Başladın

Layihə qovluğunda terminal açaraq bu əmri daxil edin:

```bash
npm start
```

_(Alternativ olaraq: `npm run start:all`)_

### Addım 2: Brauzerdə Portala Keçin

Əmr verildikdən sonra brauzerinizdə (Chrome, Safari, Edge) aşağıdakı ünvana daxil olun:

👉 **[http://localhost:5173](http://localhost:5173)**

Arxa fonda avtomatik işə düşən modullar:

- ⚡ **Core API (NestJS):** Bütün məlumatın yeganə mənbəyi. Həm veb panel, həm də Telegram botu yalnız bu API ilə danışır (`http://localhost:3001/api/health`). Panel və bot heç vaxt birbaşa bazaya qoşulmur.
- 🌐 **Veb İdarəetmə Paneli (React & Tailwind):** Menecerlər və supervayzerlər üçün analitik idarəetmə masası (`http://localhost:5173`).
- 🤖 **Telegram Bot Xidməti:** Merçendayzerlərin smartfondan tapşırıq qəbul etməsi və foto yükləməsi üçün canlı qovşaq.

> ⚠️ **Qeyd:** TorchVision worker inteqrasiya olunub, lakin lisenziyası ayrıca yoxlanmış hazır COCO çəkisi də, OneTeam-a məxsus etiketli SKU datası da yoxdur. Buna görə worker `disabled` rejimində saxlanılır və planogram nəticələri insan yoxlaması tələb edir. Əvvəlki YOLO rəng təxminləri və uydurma qutular çıxarılıb. API balı şəkil tanıma nəticəsi deyil; supervayzer yoxlaması əsas qərardır (Bölmə 4).

---

## 2. Menecer Portalı: Mağaza Seqmentasiyası və Kütləvi Tapşırıq Paylanması

Coca-Cola kateqoriya menecerləri yüzlərlə mağazaya tək-tək tapşırıq vermək əvəzinə, saniyələr içində ağıllı filtrlərlə kütləvi kampaniyalar başladır.

```
[Menecer Paneli] ──► [Region / Şəbəkə / Format Filtrləri] ──► [Bir Transaksiyada Kütləvi Yaradılma] ──► [Canlı Bildiriş]
```

### Addım-addım Kampaniya Yaradılması:

1. **Veb Portala daxil olun** və yuxarı menyudan **"Tapşırıqlar" (Task Manager)** bölməsinə keçin.
2. Sağ yuxarı küncdəki qırmızı **"+ Kütləvi Kampaniya Başlat"** düyməsinə klikləyin.
3. Açılan pəncərədə hədəf parametrlərini seçin:
   - **Region:** Məsələn, `Baku` (və ya Sumqayıt, Gəncə).
   - **Market Şəbəkəsi:** Məsələn, `Bravo` (və ya Araz, Rahat, Bazarstore).
   - **Mağaza Formatı:** `Hypermarket`, `Supermarket` və ya `Express`.
4. **Hədəf Mağaza Sayğacını Müşahidə Edin:**
   - Siz filtrləri dəyişdikcə sistem dərhal neçə mağazanın seçildiyini canlı göstərir (məsələn: _🎯 Hədəf Mağazalar: 2 mağaza seçildi_).
5. **Kampaniya Məlumatlarını Qeyd Edin:**
   - **Tapşırıq Şablonu:** Məsələn, _Qırmızı Qiymət Kampaniyası (End-Cap Display)_.
   - **Prioritet:** _Təcili (Urgent)_ və ya _Yüksək (High)_.
   - **Son İcra Tarixi:** Təqvimdən müvafiq tarixi seçin.
6. **"Kampaniyanı Təsdiqlə və Payla"** düyməsini sıxın:
   - Sistem bir verilənlər bazası transaksiyasında bütün hədəf mağazalara fərdi tapşırıq qeydləri yaradır.
   - Həmin mağazalara təhkim olunmuş merçendayzerlərin Telegram hesablarına anında bildiriş ötürülür.

---

## 3. Sahə Merçendayzeri: Telegram Bildirişi, GPS Mühafizəsi və Rəf Auditi

Sahədə çalışan işçilər heç bir mürəkkəb təlim keçmədən birbaşa Telegram botu və ya mobil müştəri vasitəsilə işləyirlər.

```
[Telegram Bildirişi] ──► [✅ Qəbul Et] ──► [GPS Geofence Yoxlanışı] ──► [Əvvəl/Sonra Şəkli + Çeklist]
```

### 1. Ani Bildiriş və Qəbul Etmə (Task State Machine):

- Menecer kampaniyanı başlatdıqda merçendayzerin telefonuna Telegram-da səsli mesaj gəlir:
  > _"🔔 YENİ RƏF TAPŞIRIĞI: Coca-Cola Qırmızı Qiymət Kampaniyası. Mağaza: Bravo 28 Mall. Son icra: 18:00."_
- Merçendayzer mesajın altındakı **`[✅ Qəbul Et]`** düyməsinə klikləyir.
- Tapşırığın statusu avtomatik olaraq `assigned` vəziyyətindən `in_progress` vəziyyətinə keçir. Menecer panelində işçinin artıq icraya başladığı dərhal əks olunur.

### 2. Saxtakarlığın Qarşısının Alınması (Anti-Fraud GPS Geofencing):

- Merçendayzer audit göndərmək istədikdə sistem cihazın cari GPS koordinatlarını yoxlayır.
- Əgər işçi mağazadan 100 metrdən daha uzaqdadırsa (məsələn, evdə və ya kafedə oturaraq saxta audit göndərmək istəyirsə), sistem qəti şəkildə imtina edir:
  > _"⚠️ Siz mağaza ərazisində deyilsiniz (Məsafə: 1.3 km). Rəf auditi yalnız mağaza daxilində (maksimum 100m radius) təsdiqlənə bilər."_

### 3. Qalereyadan Köhnə Şəkil Yükləməyə Qadağa (Anti-Gallery Enforcement):

- Köhnə şəkillərin təkrar istifadəsinin qarşısını almaq üçün sistem yalnız birbaşa canlı kamera çəkilişini qəbul edir.

### 4. "Əvvəl və Sonra" (Before & After) Rəf Şəkilləri:

- **Əvvəl Şəkli (Before):** Merçendayzer mağazaya girərkən rəfin ilkin dağınıq vəziyyətini çəkir.
- **Düzəliş:** Planograma uyğun olaraq Coca-Cola Classic, Zero Sugar, Fanta və Sprite şüşələrini ön cərgəyə düzür, boşluqları doldurur.
- **Sonra Şəkli (After):** İdeal qaydaya salınmış rəfin son şəklini çəkir.

### 5. Dinamik Mağaza Çeklistinin Doldurulması:

Şəkillərlə yanaşı, merçendayzer 3 qısa sualı cavablandırır:

1. _Soyuducunun daxili temperaturu (°C):_ `3.4`
2. _Rəf və soyuducu şüşəsi təmizdirmi?:_ `Bəli`
3. _Promosiya POSM materialları quraşdırılıbmı?:_ `Mövcuddur və yerləşdirilib`

---

## 4. Supervayzer Yoxlama Mərkəzi: Foto, Çeklist və Təsdiq

Bütün daxil olan auditlər Veb Portaldakı **"Rəf Yoxlamaları" (Audit Review Center)** bölməsində toplanır.

```
                    ┌──► Bal >= 70 ──► [⚡ Avtomatik Təsdiq]
[Daxil Olan Audit] ─┤
                    └──► Bal < 70  ──► [Supervayzer Qərarı]
```

### 1. Avtomatik yoxlama nəyə əsaslanır — və nəyə əsaslanmır:

**Vacib:** bu, süni intellekt deyil və şəkli analiz etmir. Sistem yalnız qeyddə həqiqətən mövcud olan siqnalları ballayır:

| Siqnal                                                | Bal |
| ----------------------------------------------------- | --- |
| Çəkiliş mağaza ərazisindədir (<= 50 m)                | 0   |
| Çəkiliş mağazadan uzaqdadır (> 50 m)                  | −25 |
| Çeklist cavabları yoxdur                              | −20 |
| "Əvvəl/Sonra" tapşırığında yalnız "before" fotosu var | −10 |

Nəticə 70 və yuxarıdırsa audit avtomatik təsdiqlənir; aşağıdırsa səbəbi ilə birlikdə imtina olunur ki, supervayzer niyə belə olduğunu görsün.

Şəkildəki məhsulları avtomatik tanıyan funksiya **hələ yoxdur**. Belə bir funksiyanın olması təəssüratı yaradan əvvəlki təsvirlər (rəngli çərçivələr, 95%/70%/55% ssenarilər) reallığa uyğun deyildi və silinib.

### 2. Supervayzer nə görür:

- **Fotoşəkil:** merçendayzerin göndərdiyi rəf fotosu.
- **"Əvvəl və Sonra" rejimi:** tapşırıq hər iki foto tələb edirsə, hər iki şəkil yan-yana göstərilir.
- **Geolokasiya məsafəsi:** çəkilişin mağazadan neçə metr aralıda aparıldığı.
- **Çeklist cavabları:** varsa, cədvəl şəklində.

### 3. Telegram kanalının iki məlum zəifliyi (açıq şəkildə qeyd olunur):

- **Geolokasiya təsdiqlənmir.** Telegram foto ilə birlikdə koordinat göndərmir. Ona görə bot `GEOFENCE_NOT_VERIFIED` qeydi yazır və supervayzer bunun mobil tətbiqdən gələn auditdən daha zəif sübut olduğunu görür.
- **Çeklist soruşulmur.** Bot hələ çeklist suallarını vermir, ona görə `CHECKLIST_NOT_COLLECTED` qeydi yazılır. Sualların Telegram-da soruşulması növbəti təkmilləşdirmədir.

Hər iki halda sistem vəziyyəti **gizlətmir** — yalandan "hər şey qaydasındadır" demək əvəzinə, boşluğu audit jurnalına yazır.

---

## 5. İstehsalat və Bulud Yerləşdirməsi (Docker & Railway)

Platforma konteynerləşdirilmiş arxitekturaya malikdir və istənilən bulud provayderində (Railway, Render, AWS, VPS) dərhal işə salına bilər.

### Konteynerlərin İstehsalatda İşə Salınması (Docker Compose):

```bash
# 1. İstehsalat mühiti faylını hazırlayın
cp .env.production.example .env.production

# 2. Bütün servisləri arxa fonda qurun və işə salın
docker-compose -f docker-compose.prod.yml up -d --build
```

Bu əmr aşağıdakı konteynerləri avtomatik qaldırır:

- `oneteam-postgres` (PostgreSQL Verilənlər Bazası - Port 5432)
- `oneteam-api` (NestJS Core API Engine - Port 3001)
- `oneteam-web` (Nginx + React SPA Veb Paneli - Port 80 və 5173)
- `oneteam-bot` (Telegram Bot Sahə Xidməti)

### Konteynerlərin Vəziyyətini Yoxlamaq:

```bash
docker-compose -f docker-compose.prod.yml ps
```

### Logları Canlı İzləmək:

```bash
docker-compose -f docker-compose.prod.yml logs -f api
```

---

## 6. Avtomatlaşdırılmış Testlərin Yoxlanması

### A) API-siz işləyən testlər (hər zaman işlədilə bilər):

```bash
npm run test:all
```

Bu əmr 4 dəst icra edir:

1. ✅ **Core API & Status Maşını:** 25/25 test keçir.
2. ✅ **Kütləvi Paylanma & Əvvəl/Sonra Fotolar:** 14/14 test keçir.
3. ✅ **Rəf detectoru:** TorchVision worker müqavilə testləri işləyir. Real SKU modeli və hüquqları aydın dataset olmadığından worker default olaraq `disabled` rejimindədir; nəticələr avtomatik təsdiqlənmir. `.env.production.example` Bölmə 6.
4. ✅ **iOS Mobil Klient:** 4/4 test keçir.

### B) Canlı API tələb edən testlər:

```bash
npm run api:dev          # ayrı terminalda, əvvəlcə bunu işə salın
npm run test:live
```

Bu testlər **real API-yə qoşulur** və **real qeydlər yaradır**, ona görə:

- `NODE_ENV=production` olduqda bot testi **qəsdən dayanır** və xəta verir.
- Panel testi susmaya görə yalnız **oxuyur**; yazma yollarını yoxlamaq üçün `ONETEAM_SMOKE_WRITES=1` lazımdır.

**Vacib:** bu testlər əvvəllər saxta (mock) məlumatla işləyirdi və nəticədən asılı olmayaraq "100% PASSED" yazırdı. İndi nəyi yoxladığını açıq deyir, API yoxdursa uğursuz olur.

> 📱 **Məlum boşluq:** mobil tətbiq (`mobile/`) hələ də köhnə saxta Supabase müştərisindən oxuyur. Veb panel və bot artıq real API-dədir, mobil isə yox.

---

_oneTeam Platforması — Coca-Cola Pərakəndə İcraatında Müasir Keyfiyyət Standartı._
