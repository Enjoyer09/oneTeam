# oneTeam Telegram Bot — İstifadəçi Təlimatı

> **Kimə üçündür:** Mağazalarda rəf və soyuducu yoxlamalarını aparan
> **merçendayzerlər** (sahəyə çıxan işçilər) üçün.
> **Nə üçündür:** Yoxlamanı şəkillə birlikdə nəzarətçiyə göndərmək — telefonda,
> bir neçə toxunuşla, heç bir əmr yazmadan.

Bu bot oneTeam Retail FMCG rəf monitorinq platformasının saha hissəsidir. Aşağıdakı
addımları bir dəfə oxuyun — sonra hər şey menyudan gedəcək.

---

## 1. İlk dəfə: mağazaya qoşulmaq

1. Telegram-da botu açın və **START** düyməsinə basın (və ya `/start` yazın).
2. Bot sizdən **Mağaza Kodu** istəyəcək.
3. Nəzarətçinizin sizə verdiyi kodu yazıb göndərin.
   - Kodun formatı: `ŞƏBƏKƏ_FİLİAL_NÖMRƏ` kimi görünür (məsələn `MARKET_28MAY_014`).
   - **Kodu bilmirsinizsə** — mağazanı sizə təyin edən nəzarətçinizdən soruşun.
     Bot kodu özü göstərmir, çünki kod eyni zamanda o mağazanın işinin sizə
     təhkim olunması deməkdir.
4. Kod düz olduqda bot mağazanı təsdiqləyir və sizə neçə tapşırıq təyin
   edildiyini bildirir. Ekranın altında **menyu düymələri** çıxır.

> Bir dəfə qoşulduqdan sonra bot sizi yadda saxlayır. Növbəti dəfə botu
> açanda birbaşa menyu ilə qarşılaşacaqsınız — kodu yenidən yazmaq lazım deyil.

**Başqa mağazaya keçmək** üçün sadəcə yeni mağaza kodunu yazıb göndərin
(və ya `/start` yazın).

---

## 2. Menyu və əmrlər

Ekranın altındakı düymələr əsas yoldur — heç nə yazmaq lazım deyil:

| Düymə              | Nə edir                                                     |
| ------------------ | ----------------------------------------------------------- |
| 🗓 **Bugün**        | Bu günə baxış: açıq tapşırıqlar + bu gün göndərdikləriniz   |
| 📋 **Tapşırıqlar** | Mağazanın aktiv tapşırıqları                                |
| 📊 **Statusum**    | Göndərdiyiniz şəkillərin nəzarətçi cavabı (təsdiq / imtina) |
| ❓ **Kömək**       | Botun necə işlədiyi                                         |

Mesaj qutusundakı **"/" düyməsi** eyni əmrləri siyahı kimi göstərir:

- `/bugun` — bugünkü tapşırıqlar və göndərilənlər
- `/tasks` — aktiv tapşırıqlar
- `/mystatus` — göndərdiyiniz şəkillərin statusu
- `/start` — mağazanı dəyişmək / yenidən başlamaq
- `/help` — bu kömək mesajı

> **Düymələr yoxa çıxıbsa** (məsələn lokasiya paylaşdıqdan sonra) — narahat
> olmayın: **istənilən mətn yazıb göndərin** və ya `/help` yazın, menyu geri
> qayıdacaq.

---

## 3. 🗓 Bugün — günə bir baxış

Növbənin əvvəlində açmaq üçün ən rahat ekran. Bir mesajda iki sualın cavabını
verir:

- **Açıq tapşırıq:** mağaza üçün bu gün nə qalıb.
- **Bu gün göndərilən:** bu gün neçə şəkil göndərmisiniz və onların vəziyyəti
  (✅ təsdiqləndi · ⏳ baxılır · ❌ imtina).

Altında **⚡ Sürətli keçid** düymələri çıxır — tapşırığın adına toxunmaqla
birbaşa onun yoxlanışına başlaya bilərsiniz.

> ❌ imtina edilən audit varsa, bot sizi `/mystatus`-a yönləndirir — orada
> səbəbə baxıb şəkli yenidən göndərə bilərsiniz.

---

## 4. Yoxlamanı göndərmək — 6 addım

Bot sizi addım-addım aparır. Sıra qəsdən belədir: **şəkil ən sonda gəlir** ki,
yoxlama məhz mağazada, məhz lokasiyada aparıldığı təsdiqlənsin.

1️⃣ **📋 Tapşırıqlar** düyməsinə basın (və ya 🗓 Bugün-də tapşırığa toxunun).

2️⃣ Siyahıdan **tapşırığı seçin** — bot tapşırığın təfərrüatını və (varsa)
nümunə planogram şəklini göstərir.

3️⃣ **📍 Lokasiyanızı paylaşın.** Bot çıxardığı **"Lokasiyanı paylaş"**
düyməsinə basın. Bu, yoxlamanın düzgün mağazada aparıldığını təsdiqləyir.

4️⃣ **📋 Çeklist suallarını cavablandırın.** Suallar düymə ilə (məsələn Bəli /
Xeyr) və ya rəqəm yazmaqla cavablandırılır. Bot növbəti suala keçir.

5️⃣ **📸 Rəfin fotosunu göndərin.** Telefonun kamerası ilə rəfin/soyuducunun
şəklini çəkib göndərin. Bot şəkli **hələ göndərmir** — əvvəlcə sizə göstərir.

6️⃣ **✅ Şəkli təsdiqləyin.** Şəkil yaxşıdırsa **Təsdiqlə** düyməsinə basın —
yalnız bu andan sonra yoxlama nəzarətçiyə göndərilir. Şəkil pisdirsə
**🔄 Yenidən çək** ilə təzəsini göndərə bilərsiniz.

> **Vacib:** iş yalnız 6-cı addımda — siz **Təsdiqlə**-yə basanda — göndərilir.
> Ona qədər heç nə itmir; botu bağlasanız belə, geri qayıdanda qaldığınız
> yerdən davam edəcəksiniz.

---

## 5. Tapşırıq linkləri (deep link)

Nəzarətçiniz sizə birbaşa bir tapşırığa aparan link göndərə bilər
(`t.me/...?start=task_...` şəklində). Linkə toxunanda bot açılır və **həmin
tapşırığın yoxlanışını dərhal başladır** — siyahıdan axtarmağa ehtiyac qalmır.

- Hələ mağazaya qoşulmamısınızsa, bot əvvəlcə mağaza kodunu istəyəcək
  (bax: bölmə 1), sonra tapşırıqlara menyudan bir toxunuşla çata bilərsiniz.
- Link köhnəlibsə (tapşırıq artıq bağlanıb), bot bunu açıq deyir — səssiz
  qalmır.

---

## 6. 📊 Statusum — nəzarətçi cavabı

Göndərdiyiniz şəkillərin aqibətini `/mystatus` və ya **📊 Statusum** düyməsi ilə
görürsünüz:

- ⏳ **Baxılır** — nəzarətçi hələ baxmayıb.
- ✅ **Təsdiqləndi** — iş qəbul olundu.
- ❌ **İmtina edildi** — səbəb yazılır. Rəfi düzəldib **yenidən şəkil göndərin**.

---

## 7. Tez-tez verilən suallar

**Kod işləmir / "Mağaza tapılmadı" deyir.**
Kodu diqqətlə yenidən yazın (böyük-kiçik hərf fərq etmir). Yenə olmursa,
nəzarətçinizdən dəqiq kodu soruşun.

**Düymələr yoxa çıxdı.**
İstənilən mətn yazın və ya `/help` göndərin — menyu geri qayıdır.

**Səhv şəkil göndərdim.**
Təsdiqləmədən əvvəl **🔄 Yenidən çək**. Artıq təsdiqləmisinizsə və nəzarətçi
imtina edərsə, `/mystatus`-dan yenidən göndərə bilərsiniz.

**"Sistem cavab vermir" mesajı gördüm.**
Müvəqqəti problemdir — **işiniz itmir**. Bir az sonra yenidən yazın, qaldığınız
yerdən davam edəcək.

**Yanlış mağazadayam / mağaza dəyişdi.**
Yeni mağaza kodunu yazıb göndərin (və ya `/start`).

---

_Sual və problemlər üçün mağazanı sizə təyin edən nəzarətçinizlə əlaqə saxlayın._
