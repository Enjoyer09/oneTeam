# oneTeam — veb, Telegram və iOS UI/UX auditi

Tarix: 12 oktyabr 2026. Mənbə: hazırkı lokal iş ağacı, o cümlədən mövcud commit olunmamış dəyişikliklər.

## Qərar

Məhsulun yaxşı funksional bazası var, amma hazırkı təcrübəni beynəlxalq səviyyədə hazır məhsul saymaq üçün əsas iş axınları tamamlanmalıdır. Əsas sərmayə ardıcıllığı: **işin itməməsi → doğru vəziyyətin göstərilməsi → auditin nəticəsinə qayıdış → əlçatanlıq → vahid vizual sistem**.

Veb daha zəngin idarəetmə alətidir; Telegram işçiyə addım-addım kömək edir; iOS isə çəkilişə fokuslanır, amma nəticənin izlənməsi və cavabların qorunması tərəfdən geridə qalır. Üç kanalda eyni piksel dizaynı yox, eyni terminlər, eyni nəticə və aydın davam etmə qaydası lazımdır.

## Audit əhatəsi və sübut səviyyəsi

- Veb: App, naviqasiya, giriş, icmal, audit yoxlaması, tapşırıq, mağaza, məhsul və rəf komponentlərinin struktur və seçilmiş axın analizi; CSS və modal əlçatanlıq mexanizmi.
- iOS: React Native giriş, siyahı, detal, kamera, offline növbə və tarixçə controller-i; Root naviqasiyası.
- Telegram: menyu, start, günün icmalı, tapşırıqlar, çeklist, foto təsdiqi, status və kömək axınları.
- Lokal veb ayrıca 5187 portunda açıldı. İcmalın bağlantı xətası, tapşırıq yaratma forması və əlçatanlıq ağacı müşahidə edildi. Məlumatlı dashboard və real audit qərarı canlı sınaqdan keçirilmədi: həmin lokal instansiyada API məlumatı yüklənmədi.
- iOS fiziki cihaz/simulyator və Telegram real hesab üzərindən sınaqdan keçirilmədi. Bu kanallarda tapıntılar kod analizidir; sensor davranışı, vizual kəsilmə, real gecikmə və VoiceOver nəticəsi kimi təqdim edilmir.
- `npm run test:labels`: 52/52 yoxlama keçdi. `npm run test:web`: 1 faylda 5 giriş testi keçdi. Bunlar bütöv əlçatanlıq və ya məhsul UX sertifikasiyası deyil.
- Köhnə `ui-audit` hesabatı cari vəziyyətin sübutu kimi istifadə edilmədi.

Prioritetlər: P1 — əsas iş axını, etibar və ya məlumatın qorunması üçün yüksək; P2 — istifadə rahatlığı və miqyas üçün orta; P3 — cilalama. Bu auditdə təsdiqlənmiş P0 elan edilmir. Müddətlər komanda tutumuna bağlıdır; aşağıdakı mərhələlər təqvim vədi deyil.

## Qorunmalı yaxşı tərəflər

- Vebdə semantik status xəritəsi, işıq/tünd tema, responsive cədvəl yanaşması, azaldılmış animasiya qaydası və modal fokusunun idarəsi artıq var.
- Mutasiya xətaları üçün forma daxili mesajlar və uğursuzluqda modalın açıq qalmasına yönəlmiş mexanizm mövcuddur.
- Telegram-da davamlı menyu, inline düymələr, addım göstəricisi, eyni tapşırığa təkrar basanda axına qayıdış və cavab tipinə uyğun çeklist var.
- iOS-da real lokasiya, kamera icazəsi izahı, kamera parametrlərinə keçid, çəkilmiş fotoya baxış, keyfiyyət xəbərdarlığı və davamlı offline növbə bazası var.
- Foto göndərilməzdən əvvəl təsdiq və təkrar göndərməni idarə edən idempotency mexanizmləri yaxşı məhsul davranışının bazasıdır.

## Veb tapıntıları

### W01 · P1 · Xəta boş siyahı kimi görünə bilir — brauzerdə və kodda təsdiqləndi

İcmalda “Məlumat yüklənə bilmədi” göründükdən sonra “Yeni Təlimat Yarat” açıldı; arxadakı tapşırıq səhifəsi “Hələ planogram tapşırığı yoxdur” yazdı. İstifadəçi mövcud işi yox hesab edib təkrar yarada bilər.

Səbəb: `web/src/App.tsx:170` yeddi sorğunu bir `Promise.all` ilə yükləyir; `phase` yalnız `DashboardOverview`-a ötürülür (`:679`), digər bölmələr boş massivləri alır (`:699–746`).

**Düzəliş:** hər resurs üçün loading / loaded-empty / loaded-data / error / stale vəziyyəti. Məlumat yüklənməyibsə “yoxdur” deməmək. Bir modulun xətası digərlərini bloklamamalıdır. **Qəbul:** məhsul sorğusu 500 qaytardıqda tapşırıqlar açılır; tapşırıq sorğusu 500 qaytardıqda yalnız həmin bölmədə təkrar cəhd görünür.

### W02 · P1 · Giriş vəziyyəti naməlum olanda panel “açıqdır” deyir — kod və müşahidə

`App.tsx:108` ətrafında auth-status xətası `required: false` kimi saxlanılır; `:583` bunu açıq panel xəbərdarlığına çevirir. Lokal bağlantı xətası ilə birlikdə “Hələ heç bir giriş açarı yoxdur” göründü. Bu, sistemin bilmədiyi bir şeyi təsdiqləməsidir; real icazə bypass-ı sübutu deyil.

**Düzəliş:** `unknown/unavailable` ayrıca auth vəziyyəti; “Giriş vəziyyətini yoxlamaq mümkün olmadı” və retry. **Qəbul:** auth-status 503 olduqda açarların olmadığı barədə iddia və ilk açar yaratma çağırışı göstərilmir.

### W03 · P1 · Audit fotoşəkli kəsilir, sübutun oxunması zəifləyir — kod

`AuditReviewCenter.tsx:523` və `:602` şəkilləri 4:3 konteynerdə `object-cover` ilə göstərir. Başqa nisbətli fotonun hissələri görünməyə bilər. Bounding box-lar konteyner faizlərinə bağlanır (`:625`); koordinatlar orijinal fotoya nisbətən gəlirsə, crop zamanı uyğunluq pozula bilər. Bu ikinci risk müxtəlif nisbətli nümunələrlə ölçülməlidir.

**Düzəliş:** tam foto üçün `contain`, zoom/pan/tam ekran; box koordinatlarını faktiki render olunmuş şəklin ölçü və offset-inə çevirmək. **Qəbul:** 9:16, 16:9 və 4:3 fotolarda bütün rəf və işarələr düzgün görünür.

### W04 · P2 · Nümunə foto yoxdursa logo “ideal planogram” olur — kod

`AuditReviewCenter.tsx:523`: `reference_image_url || '/logo.jpg'`. Əməliyyat sübutunun yerinə logo qoyulması qarşılaşdırmanın mənasını dəyişir.

**Düzəliş:** “Bu tapşırığa nümunə foto əlavə edilməyib” vəziyyəti; mövcud mətn təlimatını göstərmək. **Qəbul:** logo heç vaxt rəf standartı kimi təqdim edilmir.

### W05 · P1 · Yeni tapşırıqda bütün mağazalar əvvəlcədən seçilir — kod və forma

`TaskManager.tsx:161`: `selectedStores = ['all']`. Dar əhatəli iş yaratmaq istəyən operator səhvən bütün şəbəkəni hədəfləyə bilər.

**Düzəliş:** boş seçim və ya istifadəçinin aktiv mağaza konteksti; dərcdən əvvəl alıcı sayı, filiallar, tarix və bildiriş təsirinin xülasəsi. **Qəbul:** alıcı seçilmədən dərc mümkün deyil; kütləvi göndərişdə alıcı sayı son düymədə görünür.

### W06 · P1 · Bağlı mobil menyu əlçatanlıq ağacında qalır — kod və ağac

`Sidebar.tsx:94` ətrafında menyu yalnız translate ilə ekrandan çıxarılır. Bağlı olduğu dar pəncərədə altı naviqasiya düyməsi accessibility ağacında görünürdü. Drawer üçün modal fokus kilidi yoxdur; `App.tsx:307` yalnız Escape-i işləyir. Bu, tam klaviatura/VoiceOver sınağı ilə də yoxlanmalıdır.

**Düzəliş:** breakpoint-ə uyğun hidden/inert idarəsi, açılarkən fokusun keçməsi, bağlanarkən geri qayıtması, hamburgerdə `aria-expanded`. **Qəbul:** bağlı drawer elementləri Tab və screen reader ardıcıllığında yoxdur.

### W07 · P2 · Naviqasiya URL-də yaşamır — kod

`App.tsx:60` aktiv bölməni lokal state-də saxlayır. Bölməyə link paylaşmaq, refresh-dən sonra konteksti bərpa etmək və browser Back davranışı məhduddur.

**Düzəliş:** route-lar, URL-də filtr/sıralama, seçilmiş audit ID-si. **Qəbul:** `/reviews/<id>` açıldıqda uyğun icazə yoxlanaraq həmin audit göstərilir; Back siyahının filtr və mövqeyini qaytarır.

### W08 · P2 · Vizual sıxlıq və termin yükü yüksəkdir — dizayn qiymətləndirməsi

`index.css:145` baza 13px; bəzi köməkçi yazılar 10–11px; `Header.tsx` uzun başlıqlar və texniki altbaşlıqlar daşıyır. “FMCG Retail Engine”, “məhsul identiteti”, “ghost overlay”, “facing” işçinin dilini ağırlaşdırır. Kiçik şrift özlüyündə WCAG pozuntusu demək deyil, amma oxunaqlıq riskidir.

**Düzəliş:** veb əsas mətn 14–16px, əsas qərar məlumatı ən azı 14px; başlıqlar “İcmal”, “Auditlər”, “Tapşırıqlar”, “Mağazalar”, “Məhsullar”, “Rəf planı”. Şüşə effektini əsasən naviqasiya qatında saxlamaq; cədvəl və fotolar üçün sakit səthlər.

### W09 · P2 · AI balı qərarın səbəblərindən daha güclü vurğulanır — kod

`AuditReviewCenter.tsx:439–499`: faiz, “Avto-Təsdiqə Uyğun” və “Bir Kliklə AI Təsdiqi” ön plandadır. Bu, operatoru foto və digər yoxlamalardan əvvəl bala bağlaya bilər. Backend qərarının yanlış olduğu nəticəsi çıxarılmır.

**Düzəliş:** “Uyğunluq balı” və “model etibarlılığı” anlayışlarını ayırmaq; qərar səbəbləri, lokasiya/keyfiyyət məhdudiyyətləri və insan qərarını eyni görünüşdə göstərmək. **Qəbul:** operator faizdən əlavə hansı sübutun qərarı dəstəklədiyini görə bilir.

## iOS tapıntıları

### I01 · P1 · Kameradan geri dönəndə çeklist cavabları itir — kodla deterministik axın

`TaskDetailScreen.tsx:75` cavabları yalnız komponent state-ində saxlayır. `Root.tsx:283` kameradan geri dönərkən cavabları ötürmür və detal yenidən mount olunur. Addımlar: sualları cavabla → kamera aç → “Ləğv et” → boş çeklist.

**Düzəliş:** task ID ilə draft saxlanması; ekranlararası state və lazım olduqda diskdə davamlı yaddaş. **Qəbul:** kamera/geri, fon/ön plan və tətbiqin yenidən açılması cavabları qoruyur; istifadəçi draftı özü silə bilir.

### I02 · P1 · Audit tarixçəsinə və rədd cavabına görünən yol yoxdur — kod

`Root.tsx:105–116` yalnız login/list/detail/camera ekranlarını tanıyır. `AuditHistoryScreen.tsx` controller-i mövcuddur, amma tarixçə UI-si naviqasiyaya qoşulmayıb.

**Düzəliş:** “Auditlərim” ekranı: cihazda saxlanan, göndərilən, yoxlamada, təsdiqlənən və düzəliş tələb edən işlər; rəy və həmin tapşırığa qayıdış. **Qəbul:** işçi tətbiqdən çıxmadan göndərdiyi işin taleyini və düzəliş tələbini görə bilir.

### I03 · P1 · Bütün çeklist tipləri mətn sahəsinə çevrilir — kod

`TaskDetailScreen.tsx:216` bütün suallara multiline TextInput verir; `:219` yalnız `question.question` göstərir. Halbuki Telegram boolean, seçim, rəqəm və mətn tiplərini ayırır. `label` ilə gələn köhnə sual üçün başlıq boş qala bilər.

**Düzəliş:** ortaq schema-dan tipə uyğun renderer; Bəli/Xeyr, seçim siyahısı, rəqəm klaviaturası və sərhədlər; `question ?? label`; optional/required semantikası. **Qəbul:** eyni tapşırıq iOS və botda eyni sualı, seçimləri və qəbul edilən cavabları yaradır.

### I04 · P1 · Offline növbənin görünən nəzarəti natamamdır — kod

`TaskListScreenUI.tsx:62` pending sayı yalnız load/manual-sync zamanı yenilənir. Avtomatik sinxronizasiya tamamlandıqda UI-yə subscription görünmür. Yüklənməmiş queue xətası `0` olur. Üstəlik işçi yalnız ümumi say görür, hansı auditin problemli olduğunu seçə bilmir.

**Düzəliş:** queue hadisələrinə qoşulmaq, naməlum sayı sıfır kimi göstərməmək; hər audit üçün status, son cəhd, səbəb və retry. **Qəbul:** internet bərpa olunanda say öz-özünə yenilənir; uğursuz bir element ayrıca tapılır.

### I05 · P2 · Giriş və lokasiya bərpası ağırdır — kod

`LoginScreenUI.tsx:103` icazəni ekran açılan kimi istəyir; rədd ediləndə uzun Settings yolu verir, birbaşa keçid yoxdur. GPS gələnədək giriş bağlıdır (`:180`). `Root.tsx:157` hər başlanğıcda login göstərir; mağaza konteksti UI-də bərpa olunmur.

**Düzəliş:** məqsədi əvvəl izah etmək; “Parametrləri aç”, timeout/retry və zəif dəqiqlik halları; etibarlı sessiya daxilində son mağaza/qaralamanı bərpa etmək. Geofence siyasətini dizayn adı ilə zəiflətməmək. **Qəbul:** icazə rəddindən aydın bərpa yolu var; offline girişin sərhədi açıq izah edilir.

### I06 · P2 · Lokal dil və tarix formatı yarımçıqdır — kod

`TaskListScreenUI.tsx:203,218` prioriteti `toUpperCase()` və tarixi xam formada göstərir; detalda da eyni model var. “HIGH” kimi daxili enum işçinin dilinə çevrilmir.

**Düzəliş:** vahid az-AZ formatter, Asia/Baku vaxtı; “Bu gün, 17:00”, “2 saat gecikir”, “Yüksək”. **Qəbul:** istifadəçi ekranlarında enum və ISO timestamp yoxdur.

### I07 · P1 · Oxunaqlıq və toxunma semantikası — kod, cihaz ölçümü tələb olunur

Login və tapşırıq ekranlarında #888888 mətn ağ səthdə təxminən **3.54:1** kontrast verir; adi kiçik mətn üçün 4.5:1 hədəfinin altındadır. 10pt prioritet etiketi var. Bəzi TouchableOpacity-lərdə role/state yoxdur; geri düyməsinin hündürlüyü yalnız mətnlə müəyyənləşir. Bu, “bütün app VoiceOver ilə işləmir” iddiası deyil.

**Düzəliş:** kontrastı yoxlanmış semantik rənglər, miqyaslana bilən şrift, minimum 44×44pt layihə hədəfi, role/label/state, dəyişən nəticələr üçün elan. **Qəbul:** böyük Dynamic Type ilə başlıq və CTA kəsilmir; VoiceOver ilə girişdən nəticəyə qədər axın tamamlanır.

### I08 · P2 · Referans foto detaldan əvvəl görünmür — kod

`TaskDetailScreen.tsx:155` şəkil yerinə “kamera ekranında ghost overlay ilə görünəcək” yazır. İşçi necə düzülüş tələb olunduğunu kamera açmadan rahat yoxlaya bilmir.

**Düzəliş:** detalda böyüdülə bilən nümunə foto və “Nümunəni göstər” etiketi; kamerada overlay əlavə kömək olaraq qalsın. **Qəbul:** işçi çəkilişə başlamadan nümunəni tam ölçüdə görə bilir.

## Telegram tapıntıları

### T01 · P1 · Başqa tapşırığa keçid cavabları əvvəlcədən soruşmadan silir — kod

`handlers/tasks.ts:235` ətrafında cavabların artıq silindiyi xəbər verilir, ardınca `beginTaskFlow` state-i sıfırlayır. Xəbərdarlıq itkidən sonra gəlir.

**Düzəliş:** “Davam et / Qaralamanı saxlayıb keç / Silib keç”; yaxud task-a bağlı draft. **Qəbul:** köhnə kartdakı başqa tapşırığa səhv toxunuş heç bir cavabı itirmir.

### T02 · P2 · Tapşırıq siyahısı mesaj axını yaradır — kod

`handlers/tasks.ts:52`: hər tapşırığa ayrıca kart göndərilir, səhifələmə yoxdur. 30 tapşırıq 30 detal mesajı deməkdir.

**Düzəliş:** 5–8 elementlik səhifələr, prioritet/vaxt üzrə sıralama; detalları yalnız seçiləndə göstərmək. **Qəbul:** 50 tapşırıq olan mağazada tələb olunan işi qısa siyahıdan açmaq olur, söhbət kartlarla dolmur.

### T03 · P2 · “Bu gün göndərilən” tam günün sayı olmaya bilər — kod

`handlers/today.ts:97` son 20 submission-u alır və günə görə lokal filtr edir. Gün ərzində 20-dən çox audit varsa göstərici tam deyil; sorğu chat-a görədir, cari mağazaya ayrıca lokal filtr görünmür. Mağaza dəyişəndə “Bugün — mağaza” başlığı ilə sayın əhatəsi dəqiqləşdirilməlidir.

**Düzəliş:** tarix və mağazaya görə server agregatı; ya da “Son 20 qeyd arasında” açıq etiketi. **Qəbul:** 25 auditli günün sayı və iki mağaza arasında keçid ayrıca yoxlanır.

### T04 · P2 · Rədd edilən auditdən düzəlişə birbaşa keçid yoxdur — kod

`handlers/status.ts` son 5 nəticəni mətn kimi göstərir; hər rədd cavabı yanında həmin task-a qaytaran düymə yoxdur. İşçi yenidən siyahıda axtarmalıdır.

**Düzəliş:** səbəb + “Düzəliş et” inline düyməsi + əvvəlki auditlə əlaqəli yeni cəhd. **Qəbul:** rədd mesajından 1 toxunuşla uyğun tapşırıq açılır; köhnə nəticə tarixçədə qalır.

### T05 · P2 · Addım dili və hərəkət etiketləri uyğunlaşdırılmalıdır — mətn analizi

Kömək “6 addım”, axın “1/3” deyir; “Rəf Şəklini Göndər” düyməsi birbaşa göndərmir, lokasiya/çeklist axınını açır. Bunlar funksional blok deyil, gözlənti uyğunsuzluğudur.

**Düzəliş:** “Auditə başla”; əsas 3 mərhələ — Məkan, Yoxlama, Foto; çeklist daxilində ayrıca “Sual 2/5”. “Bugün” → “Bu gün”, “Statusum” → “Auditlərim”. **Qəbul:** düymə növbəti real addımı deyir və saylar bir-birinə zidd görünmür.

## Platformalararası məhsul qərarları

**C01 · P1: eyni iş üçün fərqli lokasiya qaydası.** Bot lokasiyasız sübutu xəbərdarlıqla qəbul edir (`taskFlow.ts:172`); iOS girişdə lokasiya/geofence tələb edir. Bu fərq məqsədli ola bilər, amma məhsul siyasətində izah olunmalıdır. Tövsiyə: sübut səviyyələrini açıq müəyyənləşdirmək — təsdiqlənmiş, təsdiqlənməmiş, yoxlama tələb edən; nəzarətçiyə eyni terminlə göstərmək. Təhlükəsizlik qaydasını avtomatik yumşaltmaq təklif edilmir.

**C02 · P2: vahid lüğət və vəziyyət modeli.** “Göndərildi”, “Tamamlandı”, “Gözləyir”, “İmtina edildi” eyni şeyi ifadə etməməlidir. Şəbəkəyə ötürülmə və nəzarətçinin qərarı iki ayrı vəziyyətdir:

| Ölçü | İstifadəçi etiketi | Növbəti hərəkət |
|---|---|---|
| Göndəriş | Qaralama | Davam et |
| Göndəriş | Cihazda saxlanılıb | İnternet olduqda avtomatik göndəriləcək |
| Göndəriş | Göndərilir | Gözlə, fotonu yenidən yaratma |
| Göndəriş | Göndərilmədi | Səbəbə bax / Yenidən göndər |
| Yoxlama | Yoxlama gözləyir | Auditə bax |
| Yoxlama | Təsdiqləndi | Nəticəyə bax |
| Yoxlama | Düzəliş tələb olunur | Rəyə bax / Düzəliş et |

Backend enum-larını dəyişmək zəruri deyil; təqdimat və keçid müqaviləsi ortaq olmalıdır. Eyni insanın bot və cihaz hesabının əlaqəsi ayrıca məhsul qərarıdır; hazırda kanallar arasında draftın avtomatik davam etdiyi fərz edilmir.

## Hədəf UI/UX quruluşu

### Veb — nəzarətçinin qərar iş yeri

Əsas naviqasiya: **İcmal · Auditlər · Tapşırıqlar · Mağazalar**. Məhsullar və rəf planı “Kataloq”, istifadəçi/açar idarəsi “Parametrlər” altında qruplaşdırıla bilər.

İcmalın ilk hissəsi dörd suala cavab versin: nəyi indi yoxlamalıyam, hansı iş gecikir, hansı mağazada düzəliş var, məlumat nə vaxt yenilənib? KPI klikləri filtrli iş siyahısına aparsın.

Auditlər: solda növbə, mərkəzdə tam foto/nümunə, sağda sübut və qərar. Filtrlər mağaza, vaxt, vəziyyət, risk; saxlanmış görünüşlər və “Növbəti audit”. Rədd səbəbi üçün şablon + əlavə mətn; qərar saxlanmayanda ekran və yazı qalsın.

Tapşırıq yaratma: **Məzmun → Mağazalar → Yoxla və göndər**. Təkrar işlər üçün şablon, qaralama və dəyişiklikdən çıxış qorunması. Böyük siyahılar üçün server səhifələməsi və saxlanan filtr vəziyyəti.

### iOS — işçinin gündəlik işi

Aşağı naviqasiya: **Bu gün · Auditlərim · Hesab**. “Bu gün”də aktiv mağaza, növbəti iş, gecikmə və offline status. Kartda başlıq, konkret vaxt, prioritet və davam edən draft.

Axın: mağazanı təsdiqlə → tapşırıq/nümunə → tipə uyğun çeklist → kamera → foto və cavabları yoxla → göndər → nəticə qəbzi. Hər geri keçid işi qoruyur. Göndəriş qəbzi “nə saxlandı, hara göndərildi, indi nə olacaq?” suallarına cavab verir.

Kamera: bir əsas çəkiliş düyməsi; səviyyə/kadr təlimatı; overlay aç/bağla; lazım olmayan barkod və texniki koordinatları ikinci səviyyəyə çəkmək. Offline halında “Cihazda saxlanılıb” nəticəsi uğurlu server göndərişindən fərqli göstərilməlidir.

### Telegram — qısa, yönləndirilən kanal

Daimi menyu: **Bu gün · Tapşırıqlar · Auditlərim · Kömək**. Mağaza dəyişmək görünən ayrıca hərəkət olsun. Bir mesaj bir qərar istəsin; kritik cavablar həm düymə, həm aydın mətnlə verilsin. Şəklin təsdiqi, köhnə düymələrin təhlükəsiz cavabı və cari addıma qayıdış qorunsun.

## Dizayn sistemi üçün konkret müqavilə

- Semantik tokenlər: background/surface/text/secondary/border/focus/brand/success/warning/danger; veb CSS və RN üçün eyni adlar, platformaya uyğun dəyərlər.
- Qırmızı brend vurğusu ilə xəta/qadağa semantikasını ikon, mətn və səthlə ayırmaq. Hər şeyi qırmızı etməmək.
- 4/8 əsaslı boşluq ritmi; 8/12/16/24/32 ölçüləri. Veb body 14–16px, iOS body üçün 17pt başlanğıc; istifadəçi miqyaslamasına uyğunlaşma. Bunlar layihə tövsiyəsidir, sertifikasiya həddi deyil.
- Bir ekranda dominant bir əsas CTA; təhlükəli hərəkətlər ayrıca. iOS əsas toxunma hədəfi ən az 44×44pt; veb touch idarələr üçün 44px layihə hədəfi.
- Komponentlər: Button, Input, Select, StatusBadge, TaskCard, EvidenceViewer, QueueItem, EmptyState, ErrorState, Skeleton, Dialog, Toast. Hər birinin disabled/loading/error/focus halları dizayn edilsin.
- Texniki xəta istifadəçiyə nəticə + düzəliş addımı ilə çevrilsin; diaqnostika kodu ikinci səviyyədə. Keçici toast əsas xəta üçün yeganə məlumat mənbəyi olmasın.

## Standart və qəbul hədləri

Veb üçün hədəf **WCAG 2.2 AA**: adi mətn 4.5:1, böyük mətn 3:1 kontrast; klaviatura ilə tam axın; görünən və örtülməyən fokus; uyğun etiketlər; ekran oxuyucusuna vəziyyət elanları. AA target minimumu **24×24 CSS px və ya nəzərdə tutulan istisnalar**dır; 44px bizim daha rahat toxunma hədəfimizdir. [Kontrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html), [hədəf ölçüsü](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html), [fokus](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum).

iOS üçün Apple HIG üzrə platformaya uyğun naviqasiya, Dynamic Type, VoiceOver, safe area, icazə izahı və sistem görünüşlərinə uyğunlaşma yoxlanmalıdır. [Apple Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility), [Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons).

Telegram-da command menu, reply və inline keyboard-ların imkanları platforma sənədlərinə uyğun istifadə edilməlidir; bot öz şrift və native düymə ölçüsünü idarə etmir. [Telegram Bot Features](https://core.telegram.org/bots/features).

Bunlar məhsulun artıq standartlara uyğunluğu barədə bəyanat deyil. Kontrast, fokus, zoom/reflow və assistiv texnologiya üçün ayrıca ölçülən yoxlama nəticəsi lazımdır.

## İcra ardıcıllığı

| Mərhələ | İş | Çıxış meyarı |
|---|---|---|
| 1 — Etibar və məlumat | W01–03, W05–06, I01–04, T01, C01 | İş itmir, naməlum vəziyyət boş/uğurlu göstərilmir, sübut kəsilmir, nəticəyə qayıdış var |
| 2 — Əsas təcrübə | Tipli formalar, giriş bərpası, audit workspace, URL naviqasiyası, bot səhifələmə | İşçi və nəzarətçi əsas ssenariləri köməksiz tamamlayır |
| 3 — Vahid vizual sistem | Tokenlər, komponentlər, lüğət, kontrast, ölçülər, adaptive görünüş | Üç kanalda eyni anlayış və status; WCAG/HIG yoxlama matrisi |
| 4 — Real istifadəçi yoxlaması | Sahə pilotu, ölçmələr, iterasiya | Əvvəlki versiya ilə müqayisədə tamamlanma və səhv göstəriciləri yaxşılaşır |

İlk implementasiya paketi: **vebdə xəta/boş vəziyyət ayrımı + iOS draft qorunması + Auditlərim ekranı + tipli çeklist + botda tapşırıq dəyişmə qorunması**. Vizual yeniləmə bu işlərlə birləşdirilsin, amma onları əvəz etməsin.

## Növbəti yoxlama matrisi

1. Yeni işçi: mağaza kodu, rədd edilmiş lokasiya, zəif dəqiqlik, giriş açarı tələb olunan hal.
2. 5 suallıq qarışıq çeklist: boolean/seçim/rəqəm/mətn; kamera → geri; tətbiqi bağlayıb açmaq.
3. İnternet olmadan foto: saxla → tətbiqi bağla → interneti qaytar → bir dəfə göndərildiyini və UI-nin yeniləndiyini gör.
4. Nəzarətçi rədd edir: işçi səbəbi tapır → doğru tapşırıqda düzəliş edir → hər iki cəhd tarixçədə qalır.
5. API timeout/401/403/500: heç bir hal “iş yoxdur” və ya yalan uğur yaratmır.
6. 320/390/768/1440 CSS px, 200% mətn böyütmə, 400% zoom/reflow; işıq/tünd tema; yalnız klaviatura.
7. iPhone kiçik və böyük ekran, ən böyük əlçatan mətn ölçüləri, VoiceOver, Reduce Motion, gün işığında kamera.
8. Telegram: 50 tapşırıq, 25 gündəlik audit, köhnə düymə, iki mağaza, səhv cavab və tapşırıq dəyişmə.
9. Foto: 9:16/16:9/4:3, nümunəsiz və şəkli açılmayan audit; overlay koordinatları.

Pilot üçün hər əsas roldan 5–8 iştirakçı ilə ilkin müşahidə; bu say statistik uyğunluq sübutu deyil. Təklif olunan məhsul hədəfləri: kritik ssenarilərdə ən azı 90% köməksiz tamamlanma; sınaq ssenarilərində sıfır draft itkisi; rədd səbəbini 10 saniyə daxilində tapmaq; göndəriş nəticəsinin hər dəfə aydın olması. Foto/audit vaxtı üçün əvvəlcə real baseline ölçülsün.

Ölçüləcək hadisələr: task_opened, draft_resumed, checklist_completed, photo_retake, submit_started, queued, upload_succeeded, upload_failed, review_decided, correction_started. Analitikaya xam foto, dəqiq GPS və yazılmış cavabları əlavə etmədən mərhələ/səbəb/sürə ölçmək kifayətdir.

## Auditdən sonra qalan qeyri-müəyyənlik

Məlumatlı veb ekranlarının real ölçüləri və performansı, fiziki iOS cihazındakı klaviatura/gesture/Dynamic Type davranışı, Telegram-dakı mesaj uzunluğu və real çat gecikməsi hələ yoxlanmalıdır. Bu sənəd implementasiya backlog-u üçün sübutlu auditdir; canlı istifadəçi araşdırmasını və tam accessibility uyğunluq auditini əvəz etmir.
