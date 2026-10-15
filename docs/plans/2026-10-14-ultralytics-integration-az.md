# Ultralytics inteqrasiya planı — 14 oktyabr 2026

## Qərar

YOLO26-nı istehsala dərhal keçirməyək. Əvvəlcə Ultralytics lisenziyasını və kommersiya istifadəsini hüquqi cəhətdən dəqiqləşdirək, öz SKU şəkillərimizi hüquqları aydın olan datasetdə toplayıb etiketləyək, sonra YOLO11n və YOLO26n-i eyni ayrılmış test dəstində müqayisə edək. Model adı dəyişmək öz-özünə Coca-Cola/Sprite tanıma yaratmır.

## Cari irəliləyiş

- Worker modeli proses yaddaşında saxlayır və startup zamanı əvvəlcədən yükləyir; `/health` çəkilərin yükləndiyini və Ultralytics versiyasını bildirir.
- Ultralytics paketi mövcud lokal mühitin `8.4.165` versiyasına pin edilib.
- Benchmark CLI `yolo11n.pt` və `yolo26n.pt` üçün model load vaxtını və warm inference p50/p95 göstərə bilir. Annotasiyasız fixture-larda SKU dəqiqliyi iddiası vermir; müqayisə hələ işlədilməyib.
- Fine-tune skriptinin namizəd modeli YOLO26n-dir. İstehsalın `ONETEAM_YOLO_MODEL` konfiqurasiyası dəyişməyib.

## Mövcud vəziyyət

- İstehsalda `yolo11n.pt` işləyir. Bu COCO modelində marka sinifləri yoxdur; birbaşa marka/planogram nəticəsi verə bilməz.
- Worker-in `run_inference()` funksiyası hər çağırışda `YOLO(model_path)` yaradır. HTTP server inference funksiyasını import edir, amma model çəkisini startup-da yükləmir; buna görə warm-start iddiası və `/health`-dəki `ready` göstəricisi faktiki çəkilərin hazır olduğunu sübut etmir.
- `scripts/train_yolo.py` xüsusi datasetlə fine-tune etməyə imkan verir, lakin modelin standartı `yolov8n.pt`-dir. `scripts/yolo_benchmark.py` də `yolov8n`/`yolo11n` adlarına sabitlənib.
- `vision-worker/requirements.txt` Ultralytics versiyasını pin etmir. Eyni source commit fərqli tarixlərdə fərqli paket versiyası ilə build oluna bilər.
- `src/services/vision/roi.ts` təhlükəsiz crop hesablayır, lakin nəticəsi hazırda vision sorğusunda istifadə olunmur.
- Dataset qovluğu gitignore-dadır. İki hazır fixture annotasiyasızdır; onlardan precision/recall çıxarmaq olmaz.
- Lokal Python mühitində Ultralytics `8.4.165` qurulub və YOLO26 arxitekturası paketdə mövcuddur. Worker image-in build zamanı istifadə etdiyi versiyanı ayrıca qeydə almaq lazımdır.

## Mərhələ 0 — lisenziya qapısı

Ultralytics-in öz lisenziya səhifəsi YOLO kodu, modelləri, fine-tune edilmiş modelləri və training pipeline üçün AGPL-3.0 və ya Enterprise seçimini göstərir. Onların izahına görə qapalı kommersiya SaaS istifadəsində layihənin uyğun AGPL mənbəyini bütöv açıqlamaq istənmirsə Enterprise lisenziyası tələb oluna bilər. OneTeam mənbə kodu qapalı kommersiya məhsulu kimi işlədiyinə görə əvvəlcə mövcud `ultralytics` kodu və `yolo11n.pt` çəkisi üçün hüquqi uyğunluğu təsdiqləmək lazımdır. Bu, hüquqi rəy deyil; vendorun lisenziya şərtləri hüquqşünas tərəfindən nəzərdən keçirilməlidir.

Mənbə: [Ultralytics License](https://www.ultralytics.com/license), [AGPL-3.0](https://www.ultralytics.com/legal/agpl-3-0-software-license), [Enterprise Software License](https://www.ultralytics.com/legal/enterprise-software-license).

Bu qapı həll olunana qədər yeni Ultralytics əsaslı model və datasetlə production deployment etməyək. Açıq mənbəli lisenziyanı qəbul etmək və ya Enterprise almaq arasında qərar verilməlidir; alternativ olaraq uyğun lisenziyalı başqa detektor ayrıca araşdırıla bilər.

## Mərhələ 1 — worker-i ölçülə bilən etmək

1. Model obyektini worker prosesi boyunca cache et; startup zamanı model çəkisini yüklə və bir boş/fixture inference ilə hazır olduğunu təsdiqlə. `/health` yalnız model həqiqətən yüklənibsə `ready: true` qaytarsın.
2. `ultralytics` versiyasını dəqiq pin et; `model name`, `package version`, weights SHA-256 və inference ölçüsünü health və audit metadata-sında göstər.
3. Worker modeli yalnız allowlist-dən seçsin. Arbitrary model path müştəri payload-ından gəlməsin.
4. Eyni, annotasiyasız fixture-larda `yolo11n` və `yolo26n` üçün soyuq start, warm inference median/p95, yaddaş, qutu sayı və səhv çıxışları müqayisə et. Bu mərhələnin nəticəsi yalnız əməliyyat/performance müqayisəsidir, SKU dəqiqliyi deyil.
5. `YOLO26n`-in `nms=False` yolu və ONNX CPU export-u ayrıca ölçülə bilər. Rəsmi YOLO26 sənədlərində bu seçimlər var, amma COCO benchmark nəticəsi OneTeam rəf performansı kimi təqdim edilməməlidir.

Worker cache-i xüsusilə vacibdir: hazırkı server bir prosesi saxlayır, amma hər `/detect` çağırışında model çəkisini yenidən yaradır. Bu, əvvəlcə düzəldilməli olan gecikmə və resource problemidir; yeni arxitektura buna ehtiyac yaratmır.

## Mərhələ 2 — SKU datası və etiket qaydası

İlk real dataset yalnız hüquqları aydın olan OneTeam/mağaza fotolarından yaradılsın. Hər fotoda çəkiliş icazəsi, mağaza/cihaz/vaxt metadatası ayrıca saxlanılsın. Dataset və şəxsi/kommersiya məlumatı olan fotolar Ultralytics Platform-a hüquqi və məxfilik yoxlaması olmadan yüklənməsin.

İlkin sinif taksonomiyası məhsulun qablaşdırma variantını ayırmalıdır: `coca_cola_classic_pet_500ml`, `coca_cola_zero_pet_500ml`, `sprite_pet_500ml`, `fanta_pet_500ml`, uyğun banka/SKU variantları, `competitor_beverage` və `unknown_beverage`. Etiket yalnız qablaşdırmada görünən məhsul dəlili ilə qoyulsun; səhnənin rəngi, rəf yeri və qonşu məhsul etiket sayılmasın. Qismən görünən, bulanıq və tanınmayan məhsul “unknown” kimi etiketlənsin və SKU kimi auto-count edilməsin.

Train/validation/test bölünməsi şəkil səviyyəsində təsadüfi deyil, mağaza və çəkiliş sessiyası səviyyəsində ayrılsın. Beləliklə eyni mağazanın eyni şəraitdə çəkilmiş kadrları train və test-ə düşüb nəticəni süni şişirtməz. Test dəstində içki rəfi olmayan otaqlar, yanğınsöndürən, bitki, elektronika, reklam, başqa marka, banka və boş vitrin nümunələri də olsun.

50–200 şəkil annotasiya prototipini və label qaydalarını yoxlamaq üçün pilotdur, production modelini sübut etmir. Etibarlı həcm siniflərin və vizual variasiyaların sayına görə müəyyən edilməlidir; nadir qablaşdırma və çətin mənfi nümunələr üçün daha çox şəkil tələb olunur.

## Mərhələ 3 — model müqayisəsi və qərar

Eyni dataset, split, image size və training parametrləri ilə YOLO11n və YOLO26n fine-tune edilsin. Test hesabatı SKU üzrə precision/recall, macro-F1, confidence kalibrlənməsi, naməlum sinifə abstain etmə, neqativ fotolarda false-positive, warm p50/p95 latency və memory istifadəni göstərsin. Hədlər pilot nəticəsinə baxandan sonra deyil, modelə baxmadan əvvəl məhsul riski ilə razılaşdırılsın.

Seçilən model əvvəlcə shadow mode-da işləsin: mövcud insan qərarını dəyişmədən modelin proqnozu saxlanılsın. Səhv marka etiketləri, mağaza/telefon/işıq üzrə fərqlər və abstention davranışı yoxlanılsın. Yalnız ayrıca qəbul meyarlarını keçəndən sonra supervisor workflow-da SKU təklifləri görünsün; avtomatik rədd və təsdiq üçün əlavə audit və açıq operator qərarı lazımdır.

## Mərhələ 4 — tətbiq inteqrasiyası

Fine-tune çəkisi hazır olanda Python worker qutunun model sinifini real SKU enum-a map edə bilsin. COCO modelində `bottle` sinfi `unverified_bottle` olaraq qalmalıdır. Naməlum model class-ı, model hash-i manifestlə uyğun gəlməyəndə və ya confidence SKU həddini keçməyəndə nəticə insan yoxlamasına getsin. Obyekt confidence-i planogram/verdict confidence kimi istifadə olunmasın.

ROI crop yalnız SKU detektoru stabil olandan sonra aktivləşdirilsin. Mövcud crop helper-i xam YOLO qutularını birləşdirir, amma etibarsız qutu ilə LLM kontekstini kəsmək risklidir; crop və tam foto nəticələri eyni test dəstində müqayisə edilməlidir. Refusal və ya deteksiya yoxdursa tam foto göndərilsin.

## Ultralytics funksiyalarının uyğunluğu

| Funksiya                              | OneTeam üçün dəyəri                                | Qərar                                                    |
| ------------------------------------- | -------------------------------------------------- | -------------------------------------------------------- |
| Custom object detection / fine-tuning | SKU üzrə ayrı məhsul qutuları və say               | Əsas ehtiyac; yalnız dataset + lisenziya ilə             |
| YOLO26                                | Yeni model namizədi, eksport və latency müqayisəsi | Benchmark et; dəqiqlik üstünlüyünü əvvəlcədən fərz etmə  |
| YOLOE open-vocabulary                 | Etiketləmə təklifi və araşdırma prototipi          | Manual review ilə sına; auto-grade üçün etibarlı sayma   |
| Instance segmentation                 | Üst-üstə düşən qablaşdırmada kontur                | Detection çətinliyini ölçəndən sonra bax                 |
| Tracking / pose / OBB / depth         | Statik bir audit fotosunda az fayda                | Hazırda inteqrasiya prioriteti deyil                     |
| ONNX / CoreML / TensorRT export       | CPU/server və mümkün iOS edge performansı          | Eyni trained weights ilə benchmark nəticəsinə əsasən seç |

Rəsmi sənədlər: [YOLO26](https://docs.ultralytics.com/models/yolo26), [task-lar](https://docs.ultralytics.com/tasks), [end-to-end/NMS-free inference](https://docs.ultralytics.com/guides/end2end-detection).
