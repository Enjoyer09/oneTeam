# oneTeam — Glass İnterfeys: Dizayn Əsaslandırması

**Deliverable:** `ui-glass/oneTeam-Glass-Prototype.html` — tək fayl, build tələb etmir, xarici asılılıq yoxdur
**Ölçmə aləti:** `ui-glass/verify.mjs` → nəticələr `ui-glass/shots/` (21 ekran görüntüsü)
**Əhatə:** Web portal (macOS pəncərəsi) **+** iOS sahə klienti (iPhone)
**Əvvəlki sənədlər:** `DESIGN.md` v1.1 (token müqaviləsi) · `ui-design/DESIGN-V2-RATIONALE.md` (v2 əsaslandırması) · `ui-audit/` (sübut bazası)

> Bu sənəd **v3**-dür. v2-nin bütün tapıntılarını saxlayır, üzərinə "şüşə" (glass) material
> qatını və hərəkət sistemini əlavə edir. Vizual dil dəyişir, **məzmun və iş axını dəyişmir** —
> istifadəçi yenidən öyrənməli deyil.

---

## 1. Əvvəlcə: "şüşə" nə vaxt işləyir, nə vaxt zövqsüz olur

macOS/iOS şüşə üslubu təqlid ediləndə ən çox edilən səhv — şəffaf ağ qatları boş ağ
fonun üstünə yığmaq. Nəticə: heç nə bulanıq görünmür, sadəcə solğun və oxunmaz olur.

Şüşə **yalnız arxasında məzmun olanda** şüşədir. Ona görə prototipin ən altında
rəngli bir "səhnə" var (`bg-scene`) — yumşaq pastel ləkələr. Bütün şüşə qatları onun
üzərində oturur. Şüşəni söksən, məzmun dağılır; şüşəni qoysan, məzmun canlanır.

Bunu Dizayn Sistemi səhifəsində **canlı** görmək olar: material nümunələrinin arxasına
rəngli zolaqlar qoyulub. `chrome · 34%` qatında zolaqlar aydın görünür, `pop · 80%`
qatında demək olar yox olur. Bu, material iyerarxiyasının bütün mənasıdır.

### Dörd material qatı

| Token | Şəffaflıq | Nə üçün |
|---|---|---|
| `--g-chrome` | 34% | Başlıq zolağı, tab bar — məzmun altından keçdiyi görünməlidir |
| `--g-panel` | 46% | Panellər, siyahı sətirləri, daxili bloklar |
| `--g-card` | 62% | Məzmun kartları — **mətn daşıyan ən şəffaf qat** |
| `--g-pop` | 80% | Popover, modal, menyu — diqqət tələb edir, fon yayınmamalıdır |

### Şüşə "döşəməsi" qaydası (ən vacib qərar)

> **Mətn daşıyan heç bir səth 62%-dən şəffaf ola bilməz.**

Səbəb: kontrast. Şüşə üzərindəki boz mətn (`--muted`, 10.5px) ağ fonun üzərində 5.31:1 verir.
Şəffaflıq 62%-dən aşağı düşəndə arxa fondakı rəngli ləkə işə qarışır və kontrast
proqnozlaşdırıla bilən olmaqdan çıxır. 62% "döşəmə" bu riski kəsir — prototipdə
**101 mətn nümunəsindən 0-ı 4.5:1 həddini keçmir** (WCAG 2.2 AA).

Şəffaflığı daha da aşağı salmaq istəyirsənsə, alternativ var: fonu daha az doydurulmuş
etmək (`bg-scene` ləkələrinin opasitetini azaltmaq). Şüşəni yox, **arxa fonu** dəyiş.

### `backdrop-filter` dəstəklənmirsə

```css
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){
  .glass,.win,.sb,.tb,.tabbar,.pal-panel,.ovl-card{background:var(--g-solid) !important}
}
```

Şəffaflıq tamamilə söndürülür və qatı səthə keçir. Oxunmaz şüşə, şüşə deyil.

---

## 2. İstifadəçi rahatlığı — hansı qaydaya əsaslanır

oneTeam FMCG supervayzerləri və sahə təmsilçiləri üçündür: gündə onlarla dəfə,
ayaq üstə, mağaza zəminində açılır. Bu, dizayn qərarlarını sərbəst seçim olmaqdan
çıxarıb **məcburiyyətə** çevirir.

| # | Qayda | Mənbə | Prototipdə necə |
|---|---|---|---|
| 1 | **Tanıma > xatırlama** — naviqasiya heç vaxt gizlənmir, yeri dəyişmir | Nielsen #6 | Planşetdə drawer yerinə 74px ikon relsi; hover tooltip etiketi qaytarır |
| 2 | **Sistem vəziyyəti həmişə görünür** | Nielsen #1 | Göndəriş növbəsi, "2 gözləyir" nişanları, sinxronizasiya vəziyyətləri, canlı saat |
| 3 | **İstifadəçi nəzarəti** | Nielsen #3 | `Esc` hər overlay-i bağlayır; drawer scrim-lə bağlanır; hər əməliyyat geri alına bilər |
| 4 | **Səhvin qarşısını al** | Nielsen #5 | İmtina etmə təsdiq tələb edir; "Gecikir" vəziyyəti ayrıca göstərilir |
| 5 | **Status heç vaxt yalnız rənglə** | WCAG 1.4.1 | Həmişə **rəng + dolu nöqtə + mətn**. Günəşli mağazada və rəng korluğunda da oxunur |
| 6 | **Toxunma hədəfi ≥ 44×44px** | Apple HIG | iOS tab 80×48, shutter 70×70, kamera düymələri 44×44, siyahı sətri 55px |
| 7 | **Görünən fokus halqası** | WCAG 2.4.7 | Qlobal `:focus-visible` — `2px solid #F40009`, `outline-offset:2px` |
| 8 | **Fokus tələsi + geri qaytarılma** | WCAG 2.4.3 | Modal açılanda fokus içəri keçir, bağlananda çağıran düyməyə qayıdır |
| 9 | **Boş / yüklənmə / xəta halları** | Nielsen #9 | `EmptyState`, `Skeleton`, şəkil fallback-i — boş ekran heç vaxt göstərilmir |
| 10 | **Hərəkəti azaltma** | WCAG 2.3.3 | `prefers-reduced-motion` avtomatik oxunur + prototipdə əl ilə açar |
| 11 | **Klaviatura ilə tam idarə** | WCAG 2.1.1 | `⌘K` palet · `⌘1–5` ekranlar · `Esc` bağla · `Tab` dövrə |
| 12 | **Estetik minimalizm** | Nielsen #8 | Brend qırmızısı yalnız aksent; dekorativ animasiya yoxdur |

### Brend qırmızısı — şüurlu məhdudiyyət

`brand-500` (#F40009) yalnız **iki** yerdə tam doydurulmuş halda işlənir: ekran başına
bir əsas hərəkət düyməsi, və iOS "Bu gün" ekranındaki hero kartı. Hero kartı şəffaf
şüşəyə çevrildi (əvvəlki versiyada düz qırmızı səth idi) — belə həm brend qalır,
həm də digər kartlarla eyni material ailəsindən olur.

---

## 3. Hərəkət kataloqu — "smooth" nə deməkdir

Hamısı ölçülmüş dəyərlərdir. Prototipin Dizayn Sistemi səhifəsində `150 / 250 / 400 / 600ms`
düymələrini basıb fərqi gözlə görmək olar.

| Keçid | Müddət | Əyri | Niyə |
|---|---|---|---|
| Ekran dəyişmə (web) | 250ms | `--e-out` | Yalnız opacity + 7px qalxma. Diqqəti yayındırmır |
| Ekran dəyişmə (iOS) | 400ms | `--e-apple` | Məkan hissi: 10px qalxma + 1.5% kiçilmə |
| Kart siyahısı (stagger) | 400ms, 40ms addım | `--e-out` | 6 elementdən sonra dayanır — daha çoxu yorucu olur |
| Sidebar relsi açılıb-yığılması | 400ms | `--e-apple` | Apple-ın standart məkan əyrisi |
| Naviqasiya göstəricisi (pill) | 250ms | `--e-apple` | Yeri dəyişir, yenidən çəkilmir — göz izləyə bilir |
| iOS tab göstəricisi | 250ms | `--e-spring` | Yay effekti: toxunma cavab verir |
| Modal / palet açılışı | 250ms | `--e-spring` | 0.965 → 1 miqyas; "içəridən böyüyür" |
| iOS sheet | 400ms | `--e-apple` | Aşağıdan sürüşür — məkan davamlılığı |
| Düymə basılması | 150ms | `--e-out` | `scale(.97)`. Barmaq üçün ani cavab |
| Toast | 400ms / 250ms | `--e-spring` / `--e-out` | Yayla girir, yumşaq çıxır |
| Toolbar şüşəsi (scroll) | 250ms | `--e-out` | Məzmun altına keçəndə qat qalınlaşır |
| Before/After slayder | izləyir | — | Sürtgəc birbaşa barmağı izləyir, animasiya yoxdur |

**Üç qayda:**
1. **150ms** — toxunma cavabı (yalnız hiss olunur, görünmür)
2. **250ms** — vəziyyət dəyişikliyi (görünür, amma gözlətmir)
3. **400ms** — məkan dəyişikliyi (ekran, sheet, rels)

Bundan yuxarısı istifadəçini gözlədir. Prototipdə `600ms` düyməsi məhz bunu
göstərmək üçün var — bas, fərqi hiss edəcəksən.

**Giriş animasiyası yoxdur.** Səhifə açılanda heç nə hərəkət etmir. Gündə 30 dəfə
açılan bir alətdə "xoş gəldin" animasiyası 30 dəfə vaxt oğurluğudur.

---

## 4. Nə dəyişdi — əvvəlki versiyalara nisbətən

### Web (macOS pəncərəsi)
- **Yan panel şüşədir** (`--g-side`), üzərində traffic-light düymələri — Finder/Notes modeli
- **Toolbar məzmunun altına keçir və bulanır** — `backdrop-filter` + scroll-a bağlı qalınlaşma
- **Aktiv naviqasiya elementi sürüşən şüşə göstərici ilə** işarələnir (yenidən çəkilmir)
- **Cədvəl tam eni tutur**; iki ikinci dərəcəli kart onun altına düşür. Əvvəlki versiyada
  cədvəl 651px-ə sıxılırdı və planogram adları 4 sətrə bölünürdü
- **Planşetdə** (1000px) "Təmsilçi" və "Vaxt" sütunları düşür → üfüqi sürüşmə yoxdur
- **Telefonda** eyni `<tr>` CSS grid ilə **karta** çevrilir. Markup təkrarlanmır
- **`⌘K` komanda paleti** — 12 əməliyyat, ox düymələri ilə naviqasiya, qruplaşdırılmış nəticələr
- **Before/After müqayisəsi** — sürüşdürülə bilən ayırıcı (əvvəl sadəcə yan-yana iki şəkil idi)

### iOS (iPhone)
- **Real status zolağı** — saat, siqnal, Wi-Fi, batareya. Dynamic Island onun üzərinə düşür (real iPhone kimi)
- **Böyük başlıq scroll ilə kiçilir** — 27.5px → 17px, naviqasiya zolağı şüşələnir
- **Şüşə tab bar** + sürüşən seçim göstəricisi + göndəriş nişanı
- **Hero kartı şəffaf şüşəyə çevrildi** (düz qırmızıdan) — brend qalır, material ailəsi vahid olur
- **Kamera ekranı**: ghost planogram qatı, canlı telemetriya möhürləri (GPS ±4m, mağaza kodu, vaxt, cihaz)
- **Göndərişlər**: offline banner, vəziyyətə görə ayrılmış siyahılar, xəta halında "Yenidən" düyməsi
- **Tapşırıq detalları** aşağıdan açılan sheet kimi (drag handle, Escape, fon klik)

---

## 5. Web kod bazasına keçid

### 5.1 Tailwind token bloku

`web/tailwind.config.js` faylına əlavə et (⚠️ **root** faylına yox — `web/vite.config.ts`
açıq şəkildə `web/tailwind.config.js` yükləyir; yalnız kökü düzəltmək səssiz no-op-dur):

```js
// web/tailwind.config.js
theme: {
  extend: {
    backdropBlur: { glass: '26px', 'glass-lg': '44px' },
    backdropSaturate: { glass: '1.8' },
    boxShadow: {
      xs:     '0 1px 2px 0 rgb(0 0 0 / 0.05)',
      subtle: '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.06)',
      card:   '0 1px 2px rgba(10,16,32,.05), 0 1px 3px rgba(10,16,32,.05)',
      hover:  '0 10px 26px -14px rgba(10,16,32,.22), 0 2px 8px -4px rgba(10,16,32,.10)',
      pop:    '0 32px 72px -26px rgba(10,16,32,.34), 0 12px 30px -16px rgba(10,16,32,.18)',
    },
    spacing: { 18: '4.5rem' },
    transitionTimingFunction: {
      out:    'cubic-bezier(.22,1,.36,1)',
      apple:  'cubic-bezier(.32,.72,0,1)',
      spring: 'cubic-bezier(.34,1.28,.64,1)',
    },
    transitionDuration: { 1: '150ms', 2: '250ms', 3: '400ms' },
    borderRadius: { win: '22px', card: '18px', in: '13px', ctl: '11px' },
  }
}
```

### 5.2 CSS dəyişənləri

`web/src/index.css` faylına `:root` bloku (`ui-glass/oneTeam-Glass-Prototype.html`
faylının 1-ci bölməsindən olduğu kimi kopyala) + `html[data-theme="dark"]` variantı.

### 5.3 Çıxarılacaq komponentlər

`web/src/components/ui/` altında — bugün 14+ yerdə inline təkrarlanan nişanlar:

| Komponent | Nə edir |
|---|---|
| `GlassSurface` | Material qatını (`chrome/panel/card/pop`) tək yerdən idarə edir |
| `StatusBadge` | `ok / warn / bad / neutral` — rəng + nöqtə + mətn, bir dəfə yazılır |
| `ScenarioChip` | Ssenari A/B/C nişanı |
| `KpiCard` | Rəqəm + sparkline + ikon |
| `EmptyState` | İkon + izah + bir hərəkət |
| `Skeleton` | KPI/kart həndəsəsinə uyğun yüklənmə |
| `Modal` | Fokus tələsi, Escape, `aria-modal` — hazır |
| `Toast` | `aria-live` ilə |

### 5.4 Təmizlənməli texniki borc (v1 auditindən hələ açıq)

- `backdrop-blur-xs` → `backdrop-blur-sm` (7 yer, v4 utiliti v3-də no-op-dur)
- `web/index.html`-dən `bg-zinc-50 text-zinc-900` silinsin — `slate` kanonikdir
- `h-18` → `spacing.18` və ya `h-[4.5rem]`
- Google Fonts CDN asılılığı → sistem şrift stack-i (`-apple-system, "SF Pro Text", …`).
  Bu həm sürətlidir, həm də **macOS/iOS üslubunun özüdür** — prototip artıq belədir

---

## 6. iOS kod bazasına keçid (SwiftUI)

`mobile/src/` hazırda yalnız controller/service-dir — render olunan UI yoxdur.
Aşağıdakı xəritə həmin boşluğu doldurur.

### 6.1 Materiallar

```swift
// Şüşə qatları — CSS tokenlərinin SwiftUI qarşılığı
extension ShapeStyle where Self == Material {
    static var glassChrome: Material { .ultraThinMaterial }  //  34%
    static var glassPanel:  Material { .thinMaterial }       //  46%
    static var glassCard:   Material { .regularMaterial }    //  62%  ← mətn üçün ən şəffaf
    static var glassPop:    Material { .thickMaterial }      //  80%
}
```

iOS 26-da `glassEffect` mövcuddursa, onu üstün tut:

```swift
.glassEffect(.regular.tint(.white.opacity(0.1)), in: .rect(cornerRadius: 18))
```

**Qayda eynidir:** mətn daşıyan səth `.regularMaterial`-dən şəffaf olmamalıdır.
`Reduce Transparency` açıqdırsa iOS materialları avtomatik qatılaşdırır — bu,
`@supports` fallback-inin platforma qarşılığıdır və əlavə kod tələb etmir.

### 6.2 Hərəkət

```swift
// Ekran keçidi
withAnimation(.snappy(duration: 0.4, extraBounce: 0.06)) { screen = newScreen }

// Naviqasiya göstəricisi — yenidən çəkmə yox, yerini dəyiş
.matchedGeometryEffect(id: "navIndicator", in: ns)

// Sheet
.sheet(isPresented: $showTask) { TaskDetailView() }
    .presentationDetents([.medium, .large])
    .presentationCornerRadius(26)
    .presentationDragIndicator(.visible)

// Haptik cavab (yalnız nəticə vacib olduqda)
.sensoryFeedback(.success, trigger: submissionState)
```

### 6.3 Sistem davranışları

| Lazım olan | SwiftUI |
|---|---|
| Boş hal | `ContentUnavailableView("Rəf fotosu yoxdur", systemImage: "photo.on.rectangle")` |
| Böyük başlıq kiçilməsi | `.navigationBarTitleDisplayMode(.large)` + `ScrollView` (avtomatik) |
| Tab bar | `TabView` — iOS 26-da şüşə avtomatik; 4 tab (maks. 5) |
| Siyahı | `List` + `.listStyle(.insetGrouped)` |
| Açar | `Toggle` + `.tint(.green)` |
| Şüşə düymə | `.buttonStyle(.glass)` (iOS 26) / `.borderedProminent` + `.tint(.brand)` |

### 6.4 Status → rəng xəritəsi (dəyişməz)

```
✅ Təsdiqləndi / Aktiv / Tamamlandı   → ok    (#046b45 / #5fdcae)
⏳ Gözləyir / Davam edir              → warn  (#7f4803 / #f7c46a)
⛔ İmtina edildi / Gecikir            → bad   (#9b0d31 / #ff8ea8)
○  Prioritet yoxdur / Qaralama        → neutral
```

Hər biri **rəng + nöqtə + mətn** üçlüsü kimi verilir. Yalnız rəng heç vaxt kifayət deyil.

---

## 7. Yoxlama nəticələri (ölçülmüş, gözlə deyil)

`node ui-glass/verify.mjs` — headless Chrome + CDP. **Bütün yoxlamalar keçir.**

| Kateqoriya | Yoxlama | Nəticə |
|---|---|---|
| Şüşə | `backdrop-filter` kartda / toolbar-da | `saturate(1.8) blur(26px)` |
| Şüşə | kart fonu | `rgba(255,255,255,.62)` |
| Qabıq | sidebar masaüstü / planşet | **252px / 74px** |
| Qabıq | toolbar hündürlüyü | **60px** (hər rejimdə sabit) |
| Cədvəl | tam eni: cədvəl eni / daşma | **1028px / 0px** |
| Cədvəl | planşet daşması | **0px** (2 sütun düşür) |
| Cədvəl | telefonda `table` / `thead` | `block` / `none` (kart rejimi) |
| Telefon | pəncərə eni | **430px** |
| Telefon | üfüqi daşma — 5 ekranın hamısı | **0 / 0 / 0 / 0 / 0** |
| Telefon | sidebar gizli → hamburger → scrim | işləyir |
| iOS | status zolağı / tab bar | **50px / 60px** |
| iOS | Dynamic Island status zolağında | bəli (43px / 50px) |
| iOS | tab hədəfləri | **80×48** ×4 |
| iOS | shutter / kamera düymələri | **70×70** / **44×44** |
| iOS | siyahı sətri min. hündürlük | **55px** |
| iOS | böyük başlıq kiçilməsi | **27.5px → 17px** |
| Əlçatanlıq | fokus halqası (real `Tab` ilə) | `2px solid rgb(244,0,9)` |
| Əlçatanlıq | modal `role` / `aria-modal` | `dialog` / `true` |
| Əlçatanlıq | Escape modalı bağlayır / fokus qayıdır | bəli / bəli |
| Əlçatanlıq | `aria-live` regionu | var |
| Əlçatanlıq | 10px-dən aşağı mətn | **0** |
| Əlçatanlıq | hərəkəti azaltma | keçid **1e-06s**-ə düşür |
| **Kontrast** | şüşə üzərində mətn < 4.5:1 | **0 / 101** |
| Təmizlik | fallback-sız şəkil | **0** |
| Təmizlik | xarici CDN asılılığı | **0** |
| Təmizlik | konsol xətası / istisna | **0** |

**Ən aşağı kontrast:** 5.31:1 (boz köməkçi mətn, 10.5px). Hədd 4.5:1-dir.

### Yoxlama zamanı tapılan və düzəldilən 6 real problem

1. **Cədvəl 651px-ə sıxılırdı** — planogram adları 4 sətrə bölünür, mağaza adları kəsilirdi.
   Səbəb: `.cols` grid nisbəti (1.65fr/1fr) + `table-layout:fixed` altında yüzdə-lik sütun
   enlərinin cəmi konteyneri aşması. Həll: cədvəl tam eni tutur, ikinci dərəcəli kartlar altına düşür.
2. **Qalereyada ssenari nişanları boz rəngdə idi** — `.gcard .meta span{color:var(--muted)}`
   selektoru `.chip.a/.b/.c` rəngini əzirdi (spesifiklik 0,2,1 > 0,2,0). Kontrast 4.41:1 →
   4.5 həddinin altı. Həll: `.meta > span:last-child`.
3. **Telefonda toolbar 29px geniş çıxırdı** və sağdan kəsilirdi. Səbəb: `flex-direction:column`
   ilə `flex-wrap:wrap` birlikdə — `align-items:stretch` konteynerin eninə deyil, "sətrin"
   eninə uzanır. Həll: `flex-wrap:nowrap` + uşaqlara `width:100%;min-width:0`.
4. **9.5px və 9px şriftlər** — 22 element öz qoyduğumuz 10px döşəməsini pozurdu. Həll: hamısı 10px.
5. **iOS kamera flash düyməsi 38px** idi — 44px-ə qaldırıldı.
6. **`closeOvl` görünməyən elementə fokus verirdi** — indi `offsetParent` yoxlanılır.

> **Qeyd:** `ui-glass/` altındaki HTML faylı xarici önizləmə aləti tərəfindən avtomatik
> yenidən yazılır — elementlərə `data-page-node-id` atributları əlavə olunur. Bu, render-ə
> təsir etmir, amma `Edit` alətinin sətir uyğunlaşdırmasını poza bilər. Toplu dəyişiklik
> lazım olanda `sed`/`perl` ilə atributsuz hissəyə hücum et.

---

## 8. Növbəti addımlar

**Ən yüksək dəyər / ən az iş:**
1. `web/tailwind.config.js` faylına §5.1 blokunu əlavə et — tək dəyişiklik, bütün düz kart
   problemi həll olur, komponent kodu toxunulmur.
2. `web/src/index.css` faylına `:root` tokenlərini və `html[data-theme="dark"]` variantını köçür.
3. `Sidebar.tsx` / `App.tsx`-də üç səviyyəli şüşə qabığı tətbiq et (prototipdəki `.sb` + `.tb`).

**Sonra:**
4. `web/src/components/ui/` altında §5.3 komponentlərini çıxar — nişanlar bir daha sürüşə bilməz.
5. `EmptyState` / `Skeleton` / şəkil fallback-ini hər siyahıya tətbiq et.
6. `ui-glass/verify.mjs`-i CI-ya qoş — kontrast və ölçü yoxlamaları avtomatik qaçsın.
7. iOS: `mobile/` altında real SwiftUI tətbiq skeleti qur (§6 xəritəsi ilə), başlanğıc
   ekranı "Bu gün" olsun.

**Hələ açıq (bu tapşırığa daxil deyil):**
- `README.md` və `OPERATIONAL_GUIDE_AZ.md` hələ də mobil tətbiqi mövcud kimi təsvir edir — düzəldilməlidir
- Web portaldə login/auth yoxdur (audit P0-2) — şüşə qabıq bunu həll etmir
- `ui-design/` və `ui-audit/` arasında HTML prototipləri təkrarlanır — biri arxivə salınsın
