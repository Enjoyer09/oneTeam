# UI/UX — üçüncü icra paketi

13 oktyabr 2026. Auditdə qalan, kodla həll edilə bilən əsas veb, Telegram və iOS istifadə axınları tamamlandı.

## Tamamlanan iş

- W07: Veb bölmələri URL-də saxlanır; audit `/reviews/<id>` ilə birbaşa açıla bilir. Audit statusu və axtarış query parametrində saxlanır, browser Back/Forward siyahı vəziyyətini bərpa edir. Nginx SPA fallback deep-link sorğularını index-ə yönəldir.
- W08: əsas mətn ölçüsü 13px-dən 15px-ə qaldırıldı; mətn daşıyan kartlarda fon daha sakit və qeyri-şəffaf edildi. Başlıq və altbaşlıqlar qısa, iş dilində yazıldı; “FMCG Retail Engine” və “məhsul identiteti” kimi texniki etiketlər təmizləndi.
- W09: AI nəticəsi “uyğunluq balı” kimi izah edilir, rənglə qərar siqnalı verilmir və yekun statusdan ayrılır. Nəzarətçinin modalda əl ilə AI təsdiqi düyməsi çıxarıldı. Backend-in ayrıca, qaydaya bağlı avtomatik təsdiq siyasəti dəyişdirilmədi; “Yoxlama gözləyir” statusunda nəzarətçi sübutlara baxıb qərar verir.
- I05: lokasiya icazəsi məqsəd izah edildikdən sonra, istifadəçi düyməyə basanda soruşulur. Rədd ediləndə Parametrlərə, digər xətalarda yenidən cəhdə keçid var. Son uğurlu mağaza kodu cihazda yadda saxlanıb növbəti açılışda göstərilir; giriş/geofence yenə işə başlamazdan əvvəl yoxlanır.
- I07: iOS üçün web tokenləri ilə eyni məna daşıyan rəng, boşluq və mətn ölçüsü tokenləri yaradılıb, əsas login, tapşırıq, audit tarixçəsi və detal ekranlarına tətbiq edilib. Tapşırıq kartı və əsas əməliyyatlar VoiceOver rolu, aydın etiket və disabled/checked vəziyyəti elan edir.
- T03: “Bu gün” sayğacı son 20 qeydin içindəki auditlər olduğunu bildirir; 20 qeyd sərhədinə çatanda ümumi sayın daha böyük ola biləcəyi açıq yazılır.
- T04: rədd edilmiş auditlər status siyahısında səbəb və birbaşa “Düzəliş et” düyməsi ilə göstərilir. Düymə əvvəlki cəhdi saxlayıb tapşırıq axınını yenidən açır.
- T05: bot menyusunda “Bu gün” və “Auditlərim” işlədilir. Kömək axınını yanlış 6 addım əvəzinə 3 mərhələ kimi izah edir; tapşırıq düyməsi “Auditə başla” adlanır.

## Yoxlamalar

- Root, web və mobile TypeScript yoxlamaları keçdi.
- Dəyişdirilən TypeScript fayllarında ESLint xətası yoxdur; `git diff --check` təmizdir.
- Avtomatlaşdırılmış testlər bu paketdə yenidən başladılmayıb.
- Bu dəyişikliklər production-a deploy edilməyib.

## Açıq, koddan kənar yoxlamalar

WCAG 2.2 AA uyğunluğunu iddia etmək üçün bütün ekranlarda ölçülmüş kontrast, klaviatura/fokus və ekran oxuyucu ssenarilərini yoxlamaq lazımdır. Kod review-u bunu əvəz etmir. iOS VoiceOver və Dynamic Type real simulyator/cihazda, Telegram axını canlı bot hesabında və hər iki rol istifadəçi sınağında yoxlanmalıdır. Bunlar üçün cihaz, Telegram sessiyası və iştirakçılar lazımdır; repo dəyişiklikləri ilə nəticəni uydurmaq olmaz.
