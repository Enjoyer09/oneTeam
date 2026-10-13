# UI/UX — ikinci icra paketi

13 oktyabr 2026. Birinci audit paketinin ardınca web, Telegram botu və iOS üçün əsas istifadə axınlarındakı konkret sürtünmələr düzəldildi. Dəyişikliklər lokal iş ağacındadır.

## Tamamlanan iş

- W03: Audit nəticəsi ekranında əvvəl/sonra fotoları artıq kəsilmir. Orijinal nisbət saxlanır, böyütmə və sıfırlama var, foto böyüdülmüş və sürüşdürülmüş halda aşkarlama çərçivələri şəkillə eyni koordinatlarda qalır. Yox, yüklənmə və istinad fotosunun olmaması ayrıca göstərilir.
- W04: Yeni tapşırığın mağaza seçimi boş başlayır; hamı avtomatik seçilmir. Alıcı seçilməyibsə dərcetmə mümkün deyil, seçim sayı və təsdiq düyməsində alıcı sayı görünür.
- W05: Mobil ölçüdə yan menyu modal drawer kimi işləyir: fonla qarşılıqlı əlaqə bağlanır, Escape və bağlama düyməsi işləyir, fokus menyuda saxlanır və bağlananda hamburgerə qayıdır.
- T02: Telegram tapşırıqları 6-lıq səhifələrə bölünür; əvvəlki/növbəti düymələri və səhifə göstəricisi əlavə edildi.
- I05: Tapşırıq prioriteti və son tarix Azərbaycan dilində göstərilir; tarix Bakı saat qurşağına görə formatlanır.
- I06: Tapşırıq detalında planogram istinad fotosu və xəta vəziyyəti var.
- I07: iOS məkan icazəsi rədd edildikdə istifadəçiyə sistem parametrlərini açmaq imkanı verilir.
- Əlçatanlıq: əsas ikon düymələrinə etiket, seçimlərə elan edilən vəziyyət, 44pt hədəf və oxunaqlı neytral mətn kontrastı əlavə edildi.

## Yoxlamalar

- `npm run type-check`, `npm run web:check`, `npm run mobile:check` keçdi.
- `npm run test:web`: 17 yoxlama keçdi.
- Telegram səhifələmə yoxlaması və router mövcud yoxlamaları (69) keçdi.
- Birinci paketdəki yoxlamalar da keçmişdi; bu paketdə offline queue və draft axınlarında dəyişiklik edilmədi.
- Dəyişdirilən source faylları üzrə ESLint və `git diff --check` keçdi.
- Sintetik şəkillə brauzer preview-də portret fotonun tam hündürlüyü və detection alignment yoxlandı.
- Fiziki iOS cihazı/VoiceOver, canlı Telegram istifadəçi hesabı və son istifadəçi usability testi keçirilməyib. Bu iş WCAG uyğunluğuna sertifikat və ya bütün UI-nin vizual yenidən dizaynı deyil.

## Qalan audit işi

Qalan prioritetlər: bütün məhsul üzrə vahid rəng/spacing/type tokenləri; tam tapşırıq və audit nəticəsi məlumat iyerarxiyası; iOS-da real cihaz və VoiceOver sınağı; Telegram-da canlı axın sınağı; WCAG 2.2 AA üzrə kontrast, klaviatura, fokus, ekran oxuyucu və mobil ölçmə; istifadəçi sınaqları. Bu paketdə production deploy edilməyib.
