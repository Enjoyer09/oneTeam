/**
 * Tətbiq hesabatını tək fayllı HTML kimi yaradır (şəkillər içəriyə gömülür).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SHOTS = '/Users/macbookair/GitHub/oneTeam/ui-glass/shots-app';
const TMP = '/tmp/oneteam-report-shots';
const OUT = '/Users/macbookair/GitHub/oneTeam/ui-glass/tetbiq-hesabati.html';

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const SHOT_LIST = [
  ['web-icmal', 'İcmal & Əsas Göstəricilər', 'Şüşə KPI kartları, diqqət banneri və cədvəl.'],
  ['web-yoxlama', 'Rəf Auditi & Yoxlama Mərkəzi', 'Foto qalereyası — status və AI balı nişanları şəklin üzərində.'],
  ['web-tapsiriqlar', 'Planogram Tapşırıqları', 'Tapşırıq kartları, prioritet və son tarix nişanları.'],
  ['web-magazalar', 'Mağazalar Şəbəkəsi', 'Axtarış paneli və uyğunluq zolaqları olan cədvəl.'],
  ['web-modal-muqayise', 'Müqayisə pəncərəsi (modal)', 'Pərdə bütün ekranı örtür; fokus pəncərənin içində qalır.'],
  ['web-planset-icmal', 'Planşet ölçüsü (768–1279px)', 'Yan panel 74px ikon relsinə düşür — məzmuna yer açılır.'],
  ['web-telefon-icmal', 'Telefon ölçüsü (<768px)', 'Cədvəl kartlara çevrilir, üfüqi sürüşmə yoxdur.'],
  ['web-telefon-cekmece', 'Telefon — naviqasiya çekmecesi', 'Hamburger düyməsi menyunu açır, Escape bağlayır.'],
  ['web-tund-icmal', 'Tünd tema', 'Eyni sistem rəngləri avtomatik tünd varianta keçir.'],
];

function toDataUri(file) {
  const src = path.join(SHOTS, `${file}.png`);
  const dst = path.join(TMP, `${file}.jpg`);
  // Kiçildirik və JPEG-ə çeviririk ki, HTML faylı yüngül olsun
  execFileSync(
    'sips',
    ['-Z', '1200', '-s', 'format', 'jpeg', '-s', 'formatOptions', '82', src, '--out', dst],
    { stdio: 'ignore' }
  );
  const b64 = fs.readFileSync(dst).toString('base64');
  return `data:image/jpeg;base64,${b64}`;
}

const cards = SHOT_LIST.map(([file, title, note], i) => {
  const uri = toDataUri(file);
  return `
    <figure class="shot">
      <img src="${uri}" alt="${title}" loading="lazy" />
      <figcaption>
        <span class="num">${String(i + 1).padStart(2, '0')}</span>
        <span>
          <b>${title}</b>
          <em>${note}</em>
        </span>
      </figcaption>
    </figure>`;
}).join('\n');

const html = `<!doctype html>
<html lang="az">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>oneTeam — Şüşə interfeys tətbiq hesabatı</title>
<style>
  :root{
    --ink:#0a1020; --ink-2:#33425e; --muted:#5d6c86;
    --coke:#F40009; --ok:#046b45; --ok-bg:rgba(16,185,129,.15);
    --g-card:rgba(255,255,255,.66); --g-panel:rgba(255,255,255,.5);
    --hair:rgba(10,16,32,.09); --spec:rgba(255,255,255,.7);
    --sh-1:0 1px 2px rgba(10,16,32,.05),0 1px 3px rgba(10,16,32,.05);
    --sh-2:0 10px 26px -14px rgba(10,16,32,.22),0 2px 8px -4px rgba(10,16,32,.10);
    --e-out:cubic-bezier(.22,1,.36,1);
  }
  *{box-sizing:border-box}
  body{
    margin:0; padding:0; color:var(--ink);
    font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue","Segoe UI",system-ui,sans-serif;
    font-size:14px; line-height:1.55; -webkit-font-smoothing:antialiased;
    background:#e9edf4; overflow-x:hidden;
  }
  .scene{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none}
  .scene i{position:absolute;display:block;border-radius:50%;filter:blur(60px);opacity:.5}
  .scene i:nth-child(1){width:46vw;height:46vw;left:-8vw;top:-10vw;background:radial-gradient(circle at 35% 35%,#ff9a9e,#ffcfd2 60%,transparent 72%)}
  .scene i:nth-child(2){width:40vw;height:40vw;right:-6vw;top:6vh;background:radial-gradient(circle at 40% 40%,#a5c8ff,#cfe0ff 58%,transparent 72%)}
  .scene i:nth-child(3){width:38vw;height:38vw;left:18vw;bottom:-14vw;background:radial-gradient(circle at 45% 45%,#b8f0dd,#d9f7ee 58%,transparent 72%)}
  .scene i:nth-child(4){width:30vw;height:30vw;right:12vw;bottom:-8vw;background:radial-gradient(circle at 45% 45%,#ffe6a8,#fff3d1 58%,transparent 72%)}
  .scene b{position:absolute;inset:0;background:linear-gradient(180deg,rgba(255,255,255,.3),rgba(255,255,255,0) 40%),radial-gradient(120% 90% at 50% 0%,rgba(255,255,255,.42),transparent 60%)}

  .wrap{position:relative;z-index:1;max-width:1180px;margin:0 auto;padding:44px 22px 80px}

  .glass{
    background:var(--g-card); border:1px solid var(--hair); border-radius:18px;
    -webkit-backdrop-filter:saturate(180%) blur(26px); backdrop-filter:saturate(180%) blur(26px);
    box-shadow:var(--sh-1), inset 0 1px 0 var(--spec);
  }

  header.hero{padding:30px 30px 26px;margin-bottom:22px}
  .eyebrow{font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
  h1{margin:8px 0 8px;font-size:30px;line-height:1.15;letter-spacing:-.035em;font-weight:800}
  .lede{margin:0;color:var(--ink-2);max-width:70ch;font-size:14.5px}
  .brand{display:inline-flex;align-items:center;gap:8px;margin-bottom:14px}
  .mark{width:34px;height:34px;border-radius:11px;background:var(--coke);display:grid;place-items:center;color:#fff;font-weight:800;font-size:12px;box-shadow:0 3px 10px -3px rgba(244,0,9,.35)}
  .tag{font-size:10px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;padding:3px 8px;border-radius:6px;color:#8a1418;background:rgba(244,0,9,.10);border:1px solid rgba(244,0,9,.24)}

  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:22px 0 0}
  .stat{padding:14px 16px;border-radius:14px;background:var(--g-panel);border:1px solid var(--hair)}
  .stat b{display:block;font-size:26px;font-weight:800;letter-spacing:-.04em;line-height:1.1}
  .stat span{display:block;font-size:11px;color:var(--muted);margin-top:3px}
  .stat.good b{color:var(--ok)}

  h2{font-size:17px;font-weight:800;letter-spacing:-.025em;margin:34px 0 12px}
  h2:first-of-type{margin-top:30px}

  .card{padding:22px 24px;margin-bottom:14px}
  ul.clean{margin:0;padding:0;list-style:none}
  ul.clean li{position:relative;padding:7px 0 7px 26px;border-bottom:1px solid rgba(10,16,32,.05)}
  ul.clean li:last-child{border-bottom:0}
  ul.clean li::before{
    content:"";position:absolute;left:6px;top:15px;width:7px;height:7px;border-radius:50%;
    background:var(--coke);opacity:.85
  }
  ul.clean li b{font-weight:750}
  ul.clean li em{font-style:normal;color:var(--muted)}

  .shots{display:grid;gap:20px}
  .shot{margin:0;padding:14px 14px 16px;border-radius:18px;background:var(--g-card);
        border:1px solid var(--hair);box-shadow:var(--sh-1), inset 0 1px 0 var(--spec);
        -webkit-backdrop-filter:saturate(180%) blur(26px);backdrop-filter:saturate(180%) blur(26px)}
  .shot img{display:block;width:100%;height:auto;border-radius:11px;border:1px solid var(--hair)}
  figcaption{display:flex;gap:12px;align-items:flex-start;margin-top:13px}
  figcaption .num{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;font-weight:700;
                  color:var(--coke);background:rgba(244,0,9,.09);border:1px solid rgba(244,0,9,.2);
                  padding:2px 7px;border-radius:6px;flex:none;margin-top:2px}
  figcaption b{display:block;font-size:14px;font-weight:750;letter-spacing:-.02em}
  figcaption em{display:block;font-style:normal;font-size:12.5px;color:var(--muted);margin-top:2px}

  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;font-size:10px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;
     color:var(--muted);padding:0 12px 9px;border-bottom:1px solid var(--hair)}
  td{padding:10px 12px;border-top:1px solid rgba(10,16,32,.05);vertical-align:top;color:var(--ink-2)}
  td b{color:var(--ink);font-weight:700}
  .pill{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;font-weight:800;
        padding:3px 9px;border-radius:999px;border:1px solid var(--hair);background:var(--g-panel);color:var(--ink-2)}
  .pill.ok{color:var(--ok);background:var(--ok-bg);border-color:rgba(16,185,129,.3)}

  footer{margin-top:38px;padding:20px 24px;font-size:12.5px;color:var(--muted)}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;
       background:rgba(10,16,32,.05);padding:1px 6px;border-radius:5px;color:var(--ink-2)}
  @media (max-width:640px){ h1{font-size:23px} .wrap{padding:26px 14px 60px} header.hero{padding:22px 20px} }
</style>
</head>
<body>
<div class="scene" aria-hidden="true"><i></i><i></i><i></i><i></i><b></b></div>

<div class="wrap">

  <header class="hero glass">
    <div class="brand">
      <span class="mark">1T</span>
      <span class="tag">Coca-Cola · Rəf Monitorinq</span>
    </div>
    <p class="eyebrow">Tətbiq hesabatı</p>
    <h1>Şüşə interfeys artıq real proqramda işləyir</h1>
    <p class="lede">
      Təsdiqlədiyiniz macOS üslubundaki şüşə dizayn prototipdən çıxarılıb
      <code>web/</code> tətbiqinə köçürüldü. Bütün dörd ekran, modal pəncərələr,
      cədvəllər, düymələr və nişanlar yeni sistemə keçirildi — və hər şey
      <b>ölçmə ilə</b> yoxlanıldı, sadəcə gözlə deyil.
    </p>

    <div class="stats">
      <div class="stat good"><b>45/45</b><span>avtomatik yoxlama keçdi</span></div>
      <div class="stat good"><b>0</b><span>konsol xətası</span></div>
      <div class="stat good"><b>4.5:1+</b><span>minimum mətn təzadı (WCAG AA)</span></div>
      <div class="stat good"><b>0px</b><span>üfüqi sürüşmə — hər ölçüdə</span></div>
    </div>
  </header>

  <h2>Nə dəyişdi</h2>
  <div class="card glass">
    <ul class="clean">
      <li><b>Şüşə material iyerarxiyası.</b> <em>Dörd qat: başlıq zolağı 34%, panellər 46%, məzmun kartları 62%, açılan pəncərələr 80% şəffaflıqda. Qayda: mətn daşıyan səth heç vaxt 62%-dən şəffaf olmur — beləcə yazı həmişə oxunaqlı qalır.</em></li>
      <li><b>Canlı arxa fon.</b> <em>Şüşə yalnız arxada real məzmun olanda "şüşə" kimi görünür. Ona görə ekranın arxasına yumşaq pastel ləkələr əlavə edildi — kartların arasından görünür.</em></li>
      <li><b>Üç səviyyəli yan panel.</b> <em>Masaüstündə 252px tam panel, planşetdə 74px ikon relsi, telefonda açılıb-yığılan çekmece. Əvvəl panel telefonda ekranın üçdə ikisini tuturdu.</em></li>
      <li><b>Yumşaq keçidlər.</b> <em>Apple-ın hərəkət əyriləri: toxunma 150ms, vəziyyət dəyişikliyi 250ms, məkan dəyişikliyi 400ms. Sistemin "hərəkəti azalt" parametri hörmətlə qarşılanır.</em></li>
      <li><b>Telefonda cədvəl karta çevrilir.</b> <em>Eyni sətir CSS grid ilə karta dönür — məlumat təkrarlanmır, üfüqi sürüşmə tamamilə yox olur.</em></li>
      <li><b>Tünd tema.</b> <em>Başlıqdaki düymə işıq/tünd keçidi edir və seçim yadda saxlanılır. Səhifə açılarkən ağ "flaş" olmasın deyə tema erkən tətbiq olunur.</em></li>
      <li><b>Açılan pəncərələr düzgün davranır.</b> <em>Escape bağlayır, klaviatura fokusu pəncərənin içində qalır, bağlananda fokus əvvəlki yerinə qayıdır.</em></li>
      <li><b>Yüngüllük.</b> <em>Google Fonts asılılığı çıxarıldı — sistem şrifti istifadə olunur, xarici CDN qalmadı. Şəkil yüklənməzsə neytral tutucu göstərilir.</em></li>
    </ul>
  </div>

  <h2>Ölçmə nə tapdı — və düzəldildi</h2>
  <div class="card glass">
    <table>
      <thead>
        <tr><th style="width:34%">Problem</th><th style="width:33%">Səbəb</th><th>Düzəliş</th></tr>
      </thead>
      <tbody>
        <tr>
          <td><b>Başlıqdaki qırmızı düymə</b><br /><span class="pill">4.33:1 → 6.27:1</span></td>
          <td>Ağ mətn Coca-Cola qırmızısı üzərində AA həddini (4.5:1) bir az keçmirdi.</td>
          <td>Düymənin dolğu bir pillə dərinləşdirildi. Brend rəngi üst kənarda qaldı — marka tanınırlığı dəyişmədi.</td>
        </tr>
        <tr>
          <td><b>Yaşıl və qırmızı düymələr</b><br /><span class="pill">3.36:1 → 5.4:1</span></td>
          <td>Eyni səbəb: ağ mətn açıq yaşıl/qırmızı üzərində zəif oxunurdu.</td>
          <td>Hər ikisinin tonu dərinləşdirildi. Rəng mənası dəyişmədi.</td>
        </tr>
        <tr>
          <td><b>Cədvəl başlıqları</b><br /><span class="pill">2.68:1 → 5.31:1</span></td>
          <td>Dizaynın ən açıq boz tonu mətn üçün çox solğun idi.</td>
          <td>Üç pilləli boz iyerarxiyası qorundu, amma açıq ton yalnız ikon və ayırıcılara verildi. Oxunan hər mətn bir ton tündləşdi.</td>
        </tr>
        <tr>
          <td><b>Modal pərdəsi ekranı örtmürdü</b><br /><span class="pill">121 sızma → 0</span></td>
          <td>Giriş animasiyası <code>transform</code> animasiya etdiyi üçün brauzer modalın koordinat mərkəzini dəyişirdi. Pərdə yalnız məzmun sahəsini örtürdü: yan panel qaralmırdı və arxadakı düymələr kliklənə bilirdi.</td>
          <td>Modallar birbaşa səhifə gövdəsinə render olunur (React portal). Pərdə indi tam ekranı örtür, arxada heç nə kliklənmir.</td>
        </tr>
        <tr>
          <td><b>Foto üzərindəki nişanlar</b><br /><span class="pill">2.56:1 → 9.6:1</span></td>
          <td>Narıncı fon üzərində ağ mətn oxunmurdı; üstəlik fon şəklin özü olduğu üçün nəticə gözlənilməz idi.</td>
          <td>Neytral tünd pərdə + status rəngini daşıyan nöqtə. Rəng qaldı, oxunaqlıq zəmanətli oldu — istənilən foto üzərində.</td>
        </tr>
        <tr>
          <td><b>Sınıq şəkillər</b><br /><span class="pill">1 → 0</span></td>
          <td>Yüklənməyən şəkil brauzerin "sınıq" ikonkasını göstərirdi.</td>
          <td>Qlobal ehtiyat: yüklənməyən hər şəkil üçün neytral, tema uyğun tutucu göstərilir.</td>
        </tr>
      </tbody>
    </table>
  </div>

  <h2>Ekranlar</h2>
  <div class="shots">
${cards}
  </div>

  <h2>Yoxlama nəyi ölçdü</h2>
  <div class="card glass">
    <ul class="clean">
      <li><b>Şüşə qatları</b> — <em>dörd qatın şəffaflıq sırası və 62% mətn həddi</em></li>
      <li><b>Qabıq ölçüləri</b> — <em>yan panel 252 / 74 / çekmece; başlıq zolağı dəqiq 60px</em></li>
      <li><b>Üfüqi sürüşmə</b> — <em>masaüstü, planşet və telefonda 0px</em></li>
      <li><b>Cədvəl davranışı</b> — <em>masaüstündə cədvəl, telefonda kart (eyni markup)</em></li>
      <li><b>Modal</b> — <em>şüşə qat, 18px radius, tam ekran pərdəsi, fokus tələsi, Escape</em></li>
      <li><b>Mətn təzadı</b> — <em>bütün 4 ekranda + tünd temada, cəmi 383 nümunə, hamısı AA</em></li>
      <li><b>Klaviatura</b> — <em>Tab basanda fokus halqası görünür</em></li>
      <li><b>Təmizlik</b> — <em>xarici CDN yoxdur, konsol xətası yoxdur, sınıq şəkil yoxdur</em></li>
    </ul>
  </div>

  <footer class="glass">
    <b style="color:var(--ink)">Növbəti addımlar.</b>
    iOS tərəfi hələ toxunulmayıb — <code>mobile/</code> qovluğunda hazırda yalnız xidmət qatı var, render olunan ekran yoxdur.
    SwiftUI köçürmə xəritəsi <code>ui-glass/GLASS-DESIGN-RATIONALE.md</code> sənədinin 6-cı bölməsindədir.
    Bundan başqa açıq qalan mövzular: portalda giriş/autentifikasiya yoxdur, və
    <code>ui-audit/</code>, <code>ui-design/</code>, <code>ui-glass/</code> qovluqları bir-birini təkrarlayır.
  </footer>

</div>
</body>
</html>`;

fs.writeFileSync(OUT, html, 'utf8');
const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log(`Hesabat hazırdır: ${OUT} (${kb} KB)`);
