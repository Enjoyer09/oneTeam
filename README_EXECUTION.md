# oneTeam — İstifadəçi və Başlatma Təlimatı

Xoş gəlmisiniz! Bu təlimat layihə rəhbəri (Product Owner) üçün hazırlanmışdır və heç bir texniki proqramlaşdırma biliyi tələb etmir. Bütün sistem artıq quraşdırılıb və 100% işlək vəziyyətdədir.

---

## 1. Veb İdarəetmə Panelini (Dashboard) Necə Açmaq Olar?

Sistemi kompüterinizdə dərhal canlı görmək üçün aşağıdakı addımı edin:

### Addım 1: Terminalda Başlatma Əmrini Verin
Layihə qovluğunda terminalı açıb sadəcə bu əmri yazın:

```bash
npm start
```
*(və ya `npm run start:all`)*

Bu əmr eyni anda həm **Veb Paneli**, həm də **Telegram Botunu** işə salacaq.

### Addım 2: Brauzerdə Açın
Əmri verdikdən sonra Google Chrome, Safari və ya istənilən brauzerdə bu ünvana keçin:

👉 **[http://localhost:5173](http://localhost:5173)**

*Qeyd: Əgər 5173 portu məşğul olarsa, terminalda göstərilən alternativ linkə (məsələn: `http://localhost:5174`) daxil olun.*

---

## 2. Real Telegram Botunu Necə Qoşmaq Olar?

Hazırda bot test rejimində işləyir. Şəxsi Telegram hesabınızla sahə işçisi kimi real test etmək üçün:

1. **Telegram-da `@BotFather` botuna daxil olun**:
   - `/newbot` əmrini verərək yeni bot yaradın və sizə verilən **Token**-i kopyalayın (məsələn: `7123456789:AAH...`).
2. Layihə qovluğunda olan **`.env`** faylını açın.
3. Həmin faylda **`TELEGRAM_BOT_TOKEN`** sətrini tapın və öz tokeninizi yapışdırın:
   ```env
   TELEGRAM_BOT_TOKEN=<BotFather-dan aldığınız tokeni buraya yapışdırın>
   ```
4. Faylı yadda saxlayın (`Ctrl + S` və ya `Cmd + S`).
5. Yenidən `npm start` yazaraq botu işə salın.
6. Telegram-da botunuza daxil olub **/start** yazın və mağaza kodunu daxil edin (məsələn: `BRAVO_28MAY_01`).

---

## 3. Sistemdə Nələri Yoxlaya Bilərsiniz? (Canlı Demo Ssenariləri)

Veb İdarəetmə Panelində (**http://localhost:5173**) **"Rəf Yoxlamaları" (Review Center)** bölməsinə keçərək 3 fərqli real FMCG rəf ssenarisini canlı araşdıra bilərsiniz:

1. **⭐ Ssenari A: İdeal Uyğun Rəf (95% AI Balı — Avto-Təsdiq)**:
   - **Mağaza:** Bravo Supermarket - 28 Mall
   - **Vəziyyət:** Bütün Coca-Cola Classic (4 facing), Zero Sugar (3 facing) və Fanta (3 facing) məhsulları ideal sayda və loqolar qabağa düzülüb. Boşluq yoxdur.
   - **AI Fəaliyyəti:** Süni İntellekt tərəfindən avtomatik təsdiqlənib (`⚡ AI Avtomatik Təsdiqi`).

2. **⚠️ Ssenari B: Rəfdə Boşluq/Gap Aşkarlandı (70% AI Balı — Supervayzer Yoxlaması Gözləyir)**:
   - **Mağaza:** Araz Superstore - Gənclik
   - **Vəziyyət:** Rəfdə 2 ədəd boşluq (out of stock) var. AI hər boşluq üçün -15% (cəmi -30%) cərimə tətbiq edib.
   - **Görüntü:** "Planogramla Müqayisə Et" kliklədikdə qırmızı qırıq xəttli **`⚠️ BOŞLUQ`** qutularını və çatışmazlığı dərhal görə bilərsiniz.

3. **❌ Ssenari C: Çatışmayan SKU (55% AI Balı — İmtina Qutusu Hazır Doldurulub)**:
   - **Mağaza:** Rahat Gourmet - Park Bulvar
   - **Vəziyyət:** Planogramda tələb olunan Sprite 0.5L məhsulları rəfdə ümumiyyətlə yoxdur (0/2 facing).
   - **Supervayzer Təcrübəsi:** Müqayisə etdikdə avtomatik olaraq imtina qutusu açılır və səbəb artıq hazır yazılmış olur: *"Tələb olunan Sprite 0.5L məhsulları rəfdə tamamilə yoxdur (0/2 facing)..."*. Supervayzer bir kliklə imtina qərarını təsdiqləyə bilər.

---

## 4. Testləri Avtomatlaşdırılmış Rejimdə Yoxlamaq

Əgər bütün sistemin (Telegram Bot + Veb Panel + iOS Mobil Müştəri) işləkliyini 1 saniyə ərzində yoxlamaq istəsəniz, terminalda bu əmri icra edin:

```bash
npm run test:all
```

Bütün 4 modul üzrə testlər avtomatik keçəcək və ekranda yaşıl işarələrlə təsdiqlənəcəkdir.
