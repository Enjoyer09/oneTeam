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
*(Alternativ olaraq: `npm run start:all`)*

### Addım 2: Brauzerdə Portala Keçin
Əmr verildikdən sonra brauzerinizdə (Chrome, Safari, Edge) aşağıdakı ünvana daxil olun:

👉 **[http://localhost:5173](http://localhost:5173)**

Arxa fonda avtomatik işə düşən modullar:
- 🌐 **Veb İdarəetmə Paneli (Next.js/React & Tailwind):** Menecerlər və supervayzerlər üçün analitik idarəetmə masası (`http://localhost:5173`).
- 🤖 **Telegram Bot Xidməti:** Merçendayzerlərin smartfondan tapşırıq qəbul etməsi və foto yükləməsi üçün canlı qovşaq.
- ⚡ **Süni İntellekt (YOLOv8) Rəf Tanıma:** Şəkilləri dərhal analiz edən kompüter görməsi mühərriki.

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
   - Siz filtrləri dəyişdikcə sistem dərhal neçə mağazanın seçildiyini canlı göstərir (məsələn: *🎯 Hədəf Mağazalar: 2 mağaza seçildi*).
5. **Kampaniya Məlumatlarını Qeyd Edin:**
   - **Tapşırıq Şablonu:** Məsələn, *Qırmızı Qiymət Kampaniyası (End-Cap Display)*.
   - **Prioritet:** *Təcili (Urgent)* və ya *Yüksək (High)*.
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
  > *"🔔 YENİ RƏF TAPŞIRIĞI: Coca-Cola Qırmızı Qiymət Kampaniyası. Mağaza: Bravo 28 Mall. Son icra: 18:00."*
- Merçendayzer mesajın altındakı **`[✅ Qəbul Et]`** düyməsinə klikləyir.
- Tapşırığın statusu avtomatik olaraq `assigned` vəziyyətindən `in_progress` vəziyyətinə keçir. Menecer panelində işçinin artıq icraya başladığı dərhal əks olunur.

### 2. Saxtakarlığın Qarşısının Alınması (Anti-Fraud GPS Geofencing):
- Merçendayzer audit göndərmək istədikdə sistem cihazın cari GPS koordinatlarını yoxlayır.
- Əgər işçi mağazadan 100 metrdən daha uzaqdadırsa (məsələn, evdə və ya kafedə oturaraq saxta audit göndərmək istəyirsə), sistem qəti şəkildə imtina edir:
  > *"⚠️ Siz mağaza ərazisində deyilsiniz (Məsafə: 1.3 km). Rəf auditi yalnız mağaza daxilində (maksimum 100m radius) təsdiqlənə bilər."*

### 3. Qalereyadan Köhnə Şəkil Yükləməyə Qadağa (Anti-Gallery Enforcement):
- Köhnə şəkillərin təkrar istifadəsinin qarşısını almaq üçün sistem yalnız birbaşa canlı kamera çəkilişini qəbul edir.

### 4. "Əvvəl və Sonra" (Before & After) Rəf Şəkilləri:
- **Əvvəl Şəkli (Before):** Merçendayzer mağazaya girərkən rəfin ilkin dağınıq vəziyyətini çəkir.
- **Düzəliş:** Planograma uyğun olaraq Coca-Cola Classic, Zero Sugar, Fanta və Sprite şüşələrini ön cərgəyə düzür, boşluqları doldurur.
- **Sonra Şəkli (After):** İdeal qaydaya salınmış rəfin son şəklini çəkir.

### 5. Dinamik Mağaza Çeklistinin Doldurulması:
Şəkillərlə yanaşı, merçendayzer 3 qısa sualı cavablandırır:
1. *Soyuducunun daxili temperaturu (°C):* `3.4`
2. *Rəf və soyuducu şüşəsi təmizdirmi?:* `Bəli`
3. *Promosiya POSM materialları quraşdırılıbmı?:* `Mövcuddur və yerləşdirilib`

---

## 4. Supervayzer Yoxlama Mərkəzi: AI Planogram Təhlili, Əvvəl/Sonra Müqayisəsi və Təsdiq

Bütün daxil olan auditlər Veb Portaldakı **"Rəf Yoxlamaları" (Audit Review Center)** bölməsində toplanır.

```
                    ┌──► Bal >= 90% ──► [⚡ 1-Klik AI Avtomatik Təsdiq]
[Daxil Olan Audit] ─┤
                    └──► Bal < 90%  ──► [Supervayzer Əvvəl/Sonra Müqayisəsi və Rəy]
```

### 1. Süni İntellekt (YOLOv8) Rəf Tanıma Nəticələri:
Sistem şəkildəki hər bir məhsulu fərdi rəngli çərçivələrlə aşkar edir:
- 🔴 **Coca-Cola Classic:** Qırmızı çərçivə
- ⚫ **Coca-Cola Zero Sugar:** Qara/Boz çərçivə
- 🟠 **Fanta Orange:** Narıncı çərçivə
- 🟢 **Sprite:** Yaşıl çərçivə
- ⚠️ **Rəf Boşluğu (Out of Stock Gap):** Qırmızı qırıq xəttli çərçivə

### 2. Canlı Rəf Ssenariləri:
- **Ssenari A (95% Bal — İdeal Rəf):** Bütün SKU-lar planograma tam uyğundur, boşluq yoxdur. Supervayzer sadəcə **`⚡ AI Avtomatik Təsdiqi`** düyməsinə klikləyərək 1 saniyədə təsdiqləyir.
- **Ssenari B (70% Bal — Boşluq Var):** Rəfdə 2 ədəd boşluq aşkarlanıb. AI cərimə tətbiq edib. Supervayzer səbəbi ekranda dərhal görür.
- **Ssenari C (55% Bal — Çatışmayan Məhsul):** Sprite məhsulları ümumiyyətlə düzülməyib. Sistem imtina qutusunu hazır izahatla açır: *"Tələb olunan Sprite 0.5L məhsulları rəfdə yoxdur (0/2 facing)"*. Supervayzer bir toxunuşla tapşırığı merçendayzerə geri qaytarır.

### 3. "Əvvəl və Sonra" Müqayisə Rejimi (Dual Mode):
- Supervayzer **`🔄 Əvvəl və Sonra Fotosunu Müqayisə Et`** düyməsini sıxaraq işçinin gördüyü real işi əyani görür.
- Sol tərəfdə dağınıq ilkin rəf, sağ tərəfdə isə səliqəyə salınmış son rəf nümayiş etdirilir.

### 4. Təqdim Edilmiş Çeklist Məlumatları:
- Ekranda temperatur göstəricisi (`3.4°C`), təmizlik statusu və promo POSM-lərin mövcudluğu cədvəl şəklində əks olunur.

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

## 6. Avtomatlaşdırılmış Bütün Testlərin Yoxlanması

Sistemin tam bütövlüyünü və dayanıqlığını yoxlamaq üçün tək bir əmr kifayətdir:

```bash
npm run test:all
```

Bu əmr 6 müstəqil test dəstini icra edir:
1. ✅ **Core NestJS API & State Machine:** 19/19 test keçir.
2. ✅ **Bulk Segmentation & Dual Photo Evidences:** 14/14 test keçir.
3. ✅ **AI YOLOv8 Shelf Vision & Compliance:** 16/16 test keçir.
4. ✅ **Telegram Bot End-to-End Execution:** 7/7 test keçir.
5. ✅ **Web Portal Service Smoke Test:** 9/9 test keçir.
6. ✅ **iOS Mobile Client (GPS Geofence & Offline Queue):** 4/4 test keçir.

**Ümumi:** Bütün 69 test 100% uğurla tamamlanır!

---

*oneTeam Platforması — Coca-Cola Pərakəndə İcraatında Müasir Keyfiyyət Standartı.*
