# YOLO-dan TorchVision-a keçid auditi — 14–15 oktyabr 2026

## Cari keçid vəziyyəti — 15 oktyabr 2026

Ultralytics inference və training skriptləri repodan çıxarılıb. `vision-worker/server.py` və Docker image TorchVision adapterindən istifadə edir; worker `disabled` rejimində başlayır və checkpoint yoxdursa `/detect` HTTP 503 qaytarır. Bot provider adı `torchvision` qəbul edir; köhnə `yolo` environment dəyəri yalnız keçid uyğunluğu üçün saxlanıb. COCO pretrained checkpoint yalnız açıq şəkildə `mode=coco` seçilərsə istifadə oluna bilər və lisenziya yoxlanmadan production üçün aktivləşdirilməməlidir. Custom checkpoint üçün training skripti sıfırdan random initialization istifadə edir və checkpoint hash/provenance manifesti tələb olunur.

Hibrid LLM nəticələri model təsdiqlənənə qədər insan review-unda qalır. Hazırda OneTeam datasetində label yoxdur; bu repoda production-ready SKU modeli və checkpoint yoxdur. Taamaattumik TorchVision runtime/code migration tamamlanıb, amma SKU detection capability migration data toplanıb model qiymətləndirilənədək qəsdən söndürülüb.

## Qərar

OneTeam qapalı kommersiya SaaS olaraq qalacaqsa, Ultralytics-in hazırkı lisenziya izahı ilə production YOLO istifadə etmək hüquqi risk daşıyır. İlk alternativ kimi BSD-3-Clause lisenziyalı PyTorch/TorchVision kodu ilə ayrıca detector prototipi qurmaq məqsədəuyğundur. Lisenziya “heç bir öhdəlik yoxdur” demək deyil: lisenziya bildirişləri və üçüncü tərəf komponentlərinin şərtləri yenə yoxlanır. Məqsəd AGPL/Enterprise qapısını aradan qaldırmaq və kommersiya istifadəsi üçün açıq şərtli kod bazasına keçməkdir.

Bu sənəd texniki və lisenziya auditi xarakteri daşıyır, hüquqi rəy deyil. Vendorun öz mövqeyi və lisenziyanın konkret layihəyə tətbiqi hüquqşünasla yoxlanmalıdır.

## Repodakı mövcud axın

- **Model kodu:** `scripts/torchvision_inference.py` şəkli decode edir, TorchVision modelini çağırır və təsdiqlənməmiş generic butulkaları SKU kimi göstərmir. Köhnə Ultralytics skripti keçid zamanı silinib.
- **İstehsal worker-i:** `vision-worker/server.py` HTTP `/detect` və `/health` verir. Docker image `vision-worker/Dockerfile`-da CPU Torch/TorchVision quraşdırır; OpenCV/Ultralytics və build-time model download yoxdur.
- **Bot inteqrasiyası:** `src/services/aiVision.ts` lokal proses və remote worker nəqliyyatını idarə edir. `src/services/vision/engineProviders.ts` deteksiyanı `unverified_bottle` kimi göstərir və obyekt confidence-ini verdict confidence saymır.
- **Admin/web/iOS:** ayrıca SKU detectoru görünmür; şəkil analizi server/bot qatında aparılır, UI isə nəticə və review vəziyyətini göstərir. Buna görə TorchVision adapteri API cavabının eyni JSON formasını saxlamalıdır ki, digər klientlər dəyişmədən işləsin.
- **Təlim datası:** `datasets/README.md`-də OneTeam-a məxsus etiketli SKU datasetinin olmadığını qeyd edir. İki fixture annotasiyasızdır və keyfiyyət ölçüsü çıxarmağa imkan vermir.
- **İşlək mühit:** bu keçid zamanı lokal `.venv`-də Torch/TorchVision quraşdırılıb və adapter benchmarkı aparılıb; deploy image yenilənib, lakin burada deploy edilməyib.

## Lisenziya xəritəsi

| Hissə                             | İlkin vəziyyət                                                                                   | Yoxlanmalı məsələ                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Ultralytics kodu və YOLO çəkiləri | Ultralytics AGPL-3.0 və ya Enterprise tələb etdiyini bildirir; qapalı SaaS üçün Enterprise deyir | Bu vendor mövqeyinə əsasən mövcud qapalı istifadənin hüquqi uyğunluğu; yeni production deploydan qabaq yazılı təsdiq   |
| PyTorch və TorchVision kodu       | PyTorch/TorchVision repoları BSD lisenziyalıdır                                                  | Paket wheel-lərinin üçüncü tərəf bildirişlərini və istifadə etdiyimiz opsional asılılıqları yoxlamaq                   |
| Hazır TorchVision çəkiləri        | Kod lisenziyası ilə eyni deyil                                                                   | Konkret weight enum-u, təlim datası və weight kartının istifadə şərtləri; icazə aydın deyilsə çəkidən istifadə etməmək |
| OneTeam təlim datası              | Hazırda SKU annotasiyası yoxdur                                                                  | Mağaza/foto icazəsi, şəxsi məlumat və görüntü hüquqları; foto və etiketlər üçün data provenance                        |
| Özümüzün öyrətdiyimiz çəkilər     | Çəkini kim yaratdı və hansı başlanğıc çəkidən istifadə etdi ona bağlıdır                         | Yalnız hüquqları olan dataset; sıfırdan training və ya icazəsi sübut edilmiş pretrained checkpoint                     |

Ultralytics-in [lisenziya səhifəsi](https://www.ultralytics.com/license) YOLO kodu, arxitekturası, training pipeline-ı və onunla öyrədilmiş modellər üçün AGPL və ya Enterprise seçimini göstərir. Enterprise müqaviləsi isə konkret lisenziya sahibini müəyyən hüquqi şəxsə bağlayır. PyTorch-un [TorchVision repozitoriyası](https://github.com/pytorch/vision) BSD-3-Clause kimi işarələnib. TorchVision-un [model sənədləri](https://github.com/pytorch/vision/blob/main/docs/source/models.rst) hazır çəkilərin əlavə lisenziya və ya data şərtləri ola biləcəyini açıq deyir.

## Təklif olunan texniki quruluş

1. **Mövcud API müqaviləsini saxla.** Worker `success`, `engine`, `model`, `image_dimensions`, `detected_count`, `synthetic_fallback: false` və `detections[]` qaytarsın. Marka yoxdursa `unverified_bottle` qalsın. Mövcud bot/parser, panel və mobil klientlər yeni detectorun daxili implementasiyasını görməsin.
2. **Framework-u Ultralytics-dən ayır.** Yeni modul `scripts/torchvision_inference.py` olsun; worker onu import etsin. Model factory, image decode, box clamp/normalizasiya və confidence filtri ayrıca unit testlənsin.
3. **Benchmark namizədi.** `fasterrcnn_mobilenet_v3_large_fpn` CPU resursu üçün kiçik müqayisə namizədidir; `fasterrcnn_resnet50_fpn` daha ağır keyfiyyət/reference namizədidir. Bunlar generic object detector arxitekturalarıdır, oneTeam Retail/Lemon Soda siniflərini hazır vermirlər. TorchVision-un rəsmi [custom object detection təlimatı](https://docs.pytorch.org/tutorials/intermediate/torchvision_tutorial.html) öz datasetlə fine-tune axınını göstərir.
4. **Checkpoint manifesti tələb et.** Model yolu sabit bir `ONETEAM_DETECTOR_WEIGHTS` setting-dən gəlsin, payload-იდან arbitrary path qəbul edilməsin. Manifestdə architecture, class map, train data/version, checkpoint SHA-256 və weight/data license provenance saxlanılsın. Hash və class-map uyğun gəlmirsə worker ready olmasın.
5. **Training data formatını framework-dan ayır.** Mənbə annotasiyalar COCO JSON kimi saxlanılsın; YOLO TXT yalnız Ultralytics-dən ixrac formatı kimi qalmasın. Split mağaza və capture session üzrə aparılsın, yoxsa eyni rəfin oxşar kadrları train və test nəticəsini şişirdər.
6. **Review davranışı dəyişməsin.** Detector tapıntısı SKU-nu sübut etmir. Model qeyri-müəyyən olduqda, unknown sinifə düşəndə və ya foto rəf/OOD olmadıqda insan yoxlamasına göndərilsin. SKU üzrə auto-approve bu prototipin əhatəsinə daxil deyil.

## Qurulmuş prototip və ilkin ölçmə — 15 oktyabr 2026

`scripts/torchvision_inference.py` TorchVision worker-in inference adapteridir; production konfiqurasiyasında rejim `disabled` qalıb. TorchVision Faster R-CNN MobileNetV3 COCO checkpoint-i ilə yalnız ümumi `bottle` qutularını qaytarır. `scripts/test_torchvision_inference.py` JSON sahələrini, confidence filtrini, koordinatları, ölçü limitlərini və remote URL rəddini offline yoxlayır. Local `.venv`-də Torch 2.14.0 və TorchVision 0.29.0 işləyir; ayrıca paket quraşdırmaq lazım gəlmədi. COCO checkpoint ilk çalışmada TorchVision-ın rəsmi download URL-indən lokal cache-ə endirildi, repoya/model service-ə commit edilmədi.

Eyni Mac Apple Silicon CPU-da `conf=0.25` ilə beş warm run ölçüldü. İlk checkpoint download/load vaxtı warm nəticələrə daxil deyil:

| Şəkil                             | TorchVision qutu sayı | YOLO11n qutu sayı | TorchVision warm p50 / max (5 run) | YOLO11n warm p50 / max (5 run) |
| --------------------------------- | --------------------: | ----------------: | ---------------------------------: | -----------------------------: |
| `shelf-01.jpg` — sous butulkaları |                    12 |                11 |                       321 / 341 ms |                     30 / 32 ms |
| `shelf-02.jpg` — konserv rəfi     |                     3 |                 1 |                       325 / 353 ms |                     29 / 29 ms |
| istifadəçinin otaq screenshot-u   |                     1 |                 0 |                       374 / 428 ms |                     62 / 73 ms |

Screenshot-da TorchVision-ın yeganə “bottle” qutusu yanğınsöndürənə düşdü (confidence 0.441): bu, yanlış müsbətdir. Konserv rəfində TorchVision eyni görünən konserv qrupu üçün üç qutu yaratdı; ümumi sinifdə qaldığı üçün heç biri marka/SKU sübutu deyil. YOLO11n həmin screenshot-da qutu tapmadı. Bu üç şəkil annotasiyasızdır və müqayisə mAP, precision/recall və ya model üstünlüyü demək deyil. İlkin nəticə yalnız budur: TorchVision kodu və çəki faylı ödənişsiz əldə edilir, amma bu generic COCO checkpoint-i həmin məhsul üçün birbaşa əvəz deyil; warm CPU latency də təxminən 5–12 dəfə zəifdir.

COCO pretrained checkpoint-in lisenziya şərti hələ təsdiqlənməyib. TorchVision özü weights-in datasetdən qaynaqlanan ayrıca terms ola biləcəyini deyir. Bu checkpoint lokal texniki prototip üçün istifadə olundu; kommersiya deployment icazəsi barədə nəticə çıxarılmır. TorchVision kodunun permissive olması checkpoint hüquqlarını avtomatik həll etmir.

## Keçid mərhələləri və qəbul meyarları

### A. Hüquq və data

- Ultralytics-in hazırkı production istifadəsi üçün hüquqi qərarı sənədləşdir.
- Detector kodu, hazır weights, training başlanğıc weights və dataset üçün ayrıca SBOM/provenance cədvəli yarat.
- Mağaza fotoları üçün yazılı toplama/istifadə icazəsini, şəxsi məlumat saxlanma və silinmə qaydasını müəyyən et.

### B. TorchVision smoke prototype

- TorchVision backend-i worker-a qoş və təhlükəsiz `disabled` default-u saxla. (Tamamlandı)
- Eyni image API kontraktında malformed/oversized image halları üçün offline testlər əlavə et. (Tamamlandı)
- `/health` engine/backend, Torch/TorchVision versiyası, model architecture, checkpoint hash, class-map versiyası və `ready` bildirsin.
- Fixture-lar annotasiyasız olduğundan smoke test yalnız decode, format, latency, box koordinatı və deterministik cavabı yoxlasın; dəqiqlik iddiası etməsin.

### C. Dataset və SKU ölçümü

- Əvvəlcə SKU/variant taksonomiyasını razılaşdır: qab ölçüsü və qablaşdırma forması vacibdirsə onları ayrıca sinif et; oxunmayan və qismən örtülən məhsullar `unknown` olsun.
- Bütün mağaza, cihaz, bucaq, parıltı, məsafə və qismən örtülmə variasiyalarından icazəli foto topla. İçki rəfi olmayan otaqlar, yanğınsöndürən, bitki, elektronika, sous və konserv rəfləri hard-negative dəstə daxil olsun.
- Mağaza/session üzrə ayrılmış holdout testdə SKU precision/recall, macro-F1, səhv müsbət faizi, kalibrlənmə və unknown/OOD abstention ölç.
- Eyni hardware-da warm p50/p95 latency, cold start, peak memory və model ölçüsünü müqayisə et. Minimum məhsul hədlərini nəticələri görməzdən əvvəl təyin et.

### D. Shadow deploy və rollback

- YOLO və TorchVision nəticələrini auditdə paralel saxla; supervisor qərarını dəyişmə.
- Səhvləri mağaza/cihaz/işıq və SKU üzrə incələ, sistematic drift yoxla.
- Yalnız holdout və shadow meyarları keçiləndən, lisenziya/data provenance təsdiqlənəndən sonra backend flag-ını dəyiş. Köhnə worker image/config ilə dərhal rollback imkanı saxla.

## Növbəti iş və blok

- Cari datasetlə SKU modelini öyrətmək mümkün deyil: etiket yoxdur.
- Hazır COCO weights-i kommersiyada istifadə etməyi “BSD kod var, deməli weight də sərbəstdir” kimi qəbul etmək olmaz.
- Növbəti addım hüquqları aydın mağaza fotoları toplamaq və COCO annotasiya qaydasını razılaşdırmaqdır. Training skripti və manifest yoxlaması hazırdır; dataset, holdout qiymətləndirmə və production checkpoint hələ yoxdur.
- Worker və Telegram bot TorchVision adapterinə keçib; bot UI, web panel və iOS API müqaviləsi qorunub. Production-da model söndürülüdür.

## İstifadə olunan ilkin mənbələr

- [Ultralytics License](https://www.ultralytics.com/license)
- [Ultralytics Enterprise Software License Terms](https://www.ultralytics.com/legal/enterprise-software-license)
- [PyTorch/TorchVision GitHub repository and license marker](https://github.com/pytorch/vision)
- [TorchVision model weights license/data warning](https://github.com/pytorch/vision/blob/main/docs/source/models.rst)
- [PyTorch custom object detection tutorial](https://docs.pytorch.org/tutorials/intermediate/torchvision_tutorial.html)
- [TorchVision Faster R-CNN API](https://docs.pytorch.org/vision/main/models/generated/torchvision.models.detection.fasterrcnn_resnet50_fpn.html)
