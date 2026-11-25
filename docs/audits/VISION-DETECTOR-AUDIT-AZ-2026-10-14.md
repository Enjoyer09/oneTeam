# Vision detektorunun auditı — 14 oktyabr 2026

## Nəticə

İstifadəçinin otaq fotosunda bitki və yanğınsöndürən “Lemon Soda”/“oneTeam Retail” kimi görünürdü. Səbəb modelin bu markaları tanıması deyildi. `yolo11n.pt` ümumi COCO obyektlərini aşkarlayırdı; ayrıca kod istənilən tapılan qutunu rənginə və ekrandakı sırasına əsasən dörd içki SKU-sundan birinə çevirirdi. Heç nə tapılmayanda isə uydurma rəf və qutular yaradırdı. Sonrakı qat həmin etiketləri real məhsul sübutu kimi qiymətləndirə bilirdi.

İstifadəçinin verdiyi 906×1020 ekran görüntüsünü eyni `yolo11n.pt`, `conf=0.25` ilə lokal yoxladım: yalnız `refrigerator` (0.365) və `book` (0.252) sinifləri çıxdı, `bottle` çıxmadı. Görüntü panel işarələrini də ehtiva edir və orijinal audit fotosu deyil; buna görə bu nəticə həmin konkret screenshot üçün təkrarlanan diaqnostikadır, istehsal dəqiqliyinin ölçüsü deyil. İstehsal konfiqurasiyası Railway-də `hybrid`, `yolo11n.pt`, `conf=0.25` olaraq yoxlandı.

## Kök səbəblər və təsir

1. **Saxta SKU təsnifatı:** `scripts/yolo_inference.py` hər COCO qutusunu marka kimi işarələyirdi. Yaşıl səhnə parçası Lemon Soda, qırmızı parça oneTeam Retail ola bilirdi; rəng uyğun gəlməyəndə sıraya görə marka seçilirdi.
2. **Saxta nəticə:** şəkil oxunmayanda qara test şəkli, deteksiya olmayanda sintetik butulkalar/boşluqlar yaradılırdı. `synthetic_fallback` işarəsi olsa belə, bu nəticələr sistemə inandırıcı görünürdü.
3. **Yanlış əminlik:** obyekt qutusunun confidence dəyəri SKU və planogram qərarının confidence dəyəri kimi işlədilirdi. Bunlar fərqli ehtimallardır.
4. **Kontekst itkisi:** LLM üçün tələblər hesablanırdı, amma prompta ötürülmürdü; model konkret planogramı görmürdü. İçki rəfi olub-olmaması ayrıca təsdiqlənmirdi.
5. **Paneldə tarixi yanlışlıq:** admin panel köhnə SKU qutularını marka təsdiqlənmiş kimi göstərirdi. Qeyd edilmiş keçmiş AI balları da insan qərarı üçün etibarlı sübut deyil.

## Edilən düzəlişlər

- Worker yalnız ümumi `bottle` qutusunu `unverified_bottle` kimi qaytarır. Marka, boşluq və uyğunluq balı icad etmir. Şəkil açılmırsa xəta, butulka yoxdursa boş siyahı qaytarır.
- Bot köhnə worker payloadındakı rənglə təxmin edilmiş SKU-ları rədd edir. YOLO nəticəsinin verdict confidence dəyəri sıfırdır və insan yoxlaması tələb edir.
- Hibrid LLM-ə real planogram tələblərini göndərir və `isBeverageShelf` təsdiqi istəyir. Əmin olmayan və ya rəf kimi təsdiqlənməyən görüntü, eləcə də üçdən az ümumi butulka olan görüntü avtomatik AI qərarı almır. Belə nəticə API-yə saxta AI balı kimi yazılmır.
- Admin panel köhnə etibarsız marka qutularını gizlədir və xəbərdarlıq göstərir. Orijinal fotolar və tarixi qeydlər saxlanılır; əvvəlki təsdiqlər geriyə dönük dəyişdirilmir.
- HTTP worker yalnız 8 MB-a qədər inline şəkil qəbul edir, kənar URL və müştərinin model override cəhdini rədd edir.

## Yoxlama və sərhəd

Lokal regresiya testləri Python worker, YOLO/LLM/hibrid provayderləri, bot və admin panel üçün keçirildi. İstifadəçinin screenshotunda yeni worker 0 butulka qaytardı. `shelf-01.jpg` sous butulkalarında 11, `shelf-02.jpg` konserv rəfində isə 1 **markası təsdiqlənməmiş** butulka qutusu qaytardı. Sonuncu səhv ümumi COCO detektorunun hələ də obyekt səviyyəsində yanıldığını göstərir. Bu dəyişiklik Lemon Soda/oneTeam Retail tanıma qabiliyyəti yaratmır; yalnız əsassız marka və avtomatik qərar iddiasını dayandırır.

## Əsl SKU modelinə keçid meyarı

Mağaza, cihaz, işıq, parıltı, paket variantı, qismən örtülmə və rəf olmayan neqativ fotoları əhatə edən icazəli annotasiyalı dataset lazımdır. Marka/SKU qutuları və “naməlum” sinfi ayrıca işarələnməli, train/test mağaza və çəkiliş sessiyası üzrə ayrılmalıdır. Ayrı test dəstində SKU üzrə precision/recall, neqativ fotolarda false-positive faizi və confidence kalibrlənməsi ölçülməli, sonra insan qərarları ilə shadow-mode müqayisəsi aparılmalıdır. Bunlar olmadan avtomatik SKU uyğunluğu və auto-approval etibarlı sayılmamalıdır. Keçmiş AI təsdiqləri prioritetlə insan tərəfindən yenidən baxılmalıdır.
