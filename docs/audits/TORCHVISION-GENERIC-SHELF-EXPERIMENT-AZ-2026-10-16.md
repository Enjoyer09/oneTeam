# TorchVision generic rəf modeli — sınaq hesabatı, 16 oktyabr 2026

## Məqsəd və sərhəd

Humans in the Loop-un CC0 1.0 Supermarket Shelves dataseti ilə pipeline-ı və generic rəf məhsulu lokallaşdırmasını sınadıq. Datasetdə `Product` və `Price` sinifləri var; Lemon Soda, oneTeam Retail və ya başqa SKU etiketi yoxdur. Bu nəticələr brend tanıma, mağaza performansı və production hazırlığı haqqında sübut sayılmır.

## Dataset hazırlığı

- Mənbə: [Humans in the Loop Supermarket Shelves](https://humansintheloop.org/resources/datasets/supermarket-shelves-dataset/), CC0 1.0.
- Arxivdə 45 şəkil və 11,743 qutu var. 004.jpg və 035.jpg eyni SHA-256 olduğuna görə 035.jpg təkrarlanma kimi çıxarıldı.
- 009.jpg üçün 45 qutu real şəkil sərhədindən kənara çıxır. Koordinat transformasiyasını təxmin etmədik və bu şəkli splitdən tam çıxardıq.
- Sıfır eni/hündürlüyü olan 56 qutu atıldı. Qalan qutular sərhəd və ölçü yoxlamasından keçdi.
- Son split: train 31 şəkil / 7,400 annotasiya; validation 6 / 1,510; test 6 / 2,007. Splitlər exact SHA-256 üzrə kəsişmir.

## Təlim və nəticə

Faster R-CNN MobileNetV3 FPN sıfırdan, pretrained çəkisiz, 320–640 input ölçüsü və hər şəkilə 500 detection limiti ilə 20 epoch öyrədildi (5 ilkin + 15 resume). Train loss 2.26-dan təxminən 1.51-ə düşdü, amma bu, təkbaşına keyfiyyət sübutu deyil.

Toxunulmamış 6 şəkilli test splitində, IoU 0.5:

| Confidence | Sinif   |  TP |    FP |    FN | Precision | Recall |
| ---------- | ------- | --: | ----: | ----: | --------: | -----: |
| 0.50       | product |   5 |   167 | 1,574 |     2.91% |  0.32% |
| 0.50       | price   |   0 |     0 |   428 |        0% |     0% |
| 0.05       | product |  90 | 1,831 | 1,489 |     4.69% |  5.70% |
| 0.05       | price   |   1 |   262 |   427 |     0.38% |  0.23% |

Bu, COCO mAP deyil; kiçik holdout setində class-wise precision/recall ölçüsüdür. Həm default, həm aşağı confidence həddində model yararsızdır. Checkpoint-in deployment approval sahəsi `false` olaraq qaldı; onu Railway-ə yerləşdirmədik.

## Yekun

Mövcud sıfırdan training yolu 31 train şəkli ilə yetərli öyrənmə vermədi. Bu dataset modeli “oneTeam Retail/Lemon Soda” kimi öyrədə bilməz. Növbəti məhsuldar addım OneTeam-in icazəli real mağaza şəkillərini SKU üzrə annotasiya etmək və daha geniş holdout toplamaqdır. Generic backbone-dan transfer learning ayrıca araşdırıla bilər, ancaq model və dataset hüquqları yoxlanmadan istifadə olunmamalıdır.

Checkpoint və splitlər yalnız lokal ignored `datasets/hitl-supermarket/` qovluğunda saxlanır. Checkpoint SHA-256: `0b0f372997b9f7f09dee4fc6e859a97d56710296191aee769a6304fa25c7809a`.
