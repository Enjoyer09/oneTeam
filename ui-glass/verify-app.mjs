/**
 * oneTeam — real tətbiq üçün şüşə dizayn yoxlaması
 * Yalnız Node daxili modulları istifadə edir (fetch + WebSocket).
 *
 * İstifadə:
 *   node ui-glass/verify-app.mjs
 *
 * Tələb: 127.0.0.1:5199-da statik server (web/dist) və
 *        Chrome --remote-debugging-port=9225 ilə işləyir.
 */
import fs from 'node:fs';
import path from 'node:path';

const CDP_PORT = 9225;
const BASE = 'http://127.0.0.1:5201/';
const OUT = '/Users/macbookair/GitHub/oneTeam/ui-glass/shots-app';

fs.mkdirSync(OUT, { recursive: true });

/* ────────────────────────────── CDP köməkçisi ───────────────────────────── */
let ws;
let msgId = 0;
const pending = new Map();
const events = [];

function send(method, params = {}, sessionId) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }
    }, 30000);
  });
}

async function connect() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('Aktiv "page" hədəfi tapılmadı');

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(`${m.error.message} (${JSON.stringify(m.error.data ?? '')})`));
      else resolve(m.result);
    } else if (m.method) {
      events.push(m);
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(
      `Səhv: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`
    );
  }
  return r.result.value;
}

async function setViewport(width, height, mobile = false) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
  });
  await sleep(450);
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(r.data, 'base64');
  fs.writeFileSync(path.join(OUT, `${name}.png`), buf);
  return buf.length;
}

async function clickNav(label) {
  const ok = await evaluate(`(() => {
    const btns = [...document.querySelectorAll('aside button')];
    const b = btns.find(x => (x.getAttribute('title') || x.textContent || '').includes(${JSON.stringify(label)}));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(700);
  return ok;
}

/* ────────────────────────────── Yoxlamalar ──────────────────────────────── */
const results = [];

function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail });
}

async function main() {
  await connect();

  const consoleErrors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(m.params.exceptionDetails?.exception?.description || 'exception');
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      consoleErrors.push(m.params.entry.text);
    }
  });

  await send('Page.navigate', { url: BASE });
  await sleep(2500);

  /* Əvvəlki buraxılışdan qalan tema seçimini təmizlə — yoxlama həmişə
     işıq temadan başlamalıdır, əks halda ölçmələr tünd qiymətləri oxuyur. */
  await evaluate(`(() => {
    try { localStorage.removeItem('oneteam-theme'); } catch (e) {}
    document.documentElement.setAttribute('data-theme', 'light');
    return true;
  })()`);
  await send('Page.reload', { ignoreCache: true });
  await sleep(3000);

  /* ── 0. Şüşə qat iyerarxiyası (tema-asiq) ──────────────────────────────── */
  const layers = await evaluate(`(() => {
    const cs = getComputedStyle(document.documentElement);
    const g = (n) => cs.getPropertyValue(n).trim();
    const alpha = (v) => {
      const m = /rgba?\\([^,]+,[^,]+,[^,]+,\\s*([\\d.]+)\\)/.exec(v);
      return m ? parseFloat(m[1]) : 1;
    };
    const raw = { chrome: g('--g-chrome'), panel: g('--g-panel'), card: g('--g-card'), pop: g('--g-pop') };
    return {
      raw,
      a: { chrome: alpha(raw.chrome), panel: alpha(raw.panel), card: alpha(raw.card), pop: alpha(raw.pop) },
    };
  })()`);

  check(
    'Şüşə qat iyerarxiyası düzgün sıradadır (chrome < panel < card < pop)',
    layers.a.chrome < layers.a.panel &&
      layers.a.panel < layers.a.card &&
      layers.a.card < layers.a.pop,
    `chrome ${layers.a.chrome} < panel ${layers.a.panel} < card ${layers.a.card} < pop ${layers.a.pop}`
  );
  check(
    'Ən nazik qat (chrome) ≤45% şəffaflıqdadır',
    layers.a.chrome <= 0.45,
    `chrome alpha = ${layers.a.chrome}`
  );
  check(
    'Mətn daşıyan qat (card) ≥62% — kontrast zəmanəti',
    layers.a.card >= 0.62,
    `card alpha = ${layers.a.card}`
  );

  /* ── 1. MASAÜSTÜ ───────────────────────────────────────────────────────── */
  await setViewport(1440, 900);

  const shell = await evaluate(`(() => {
    const sb = document.querySelector('aside');
    const tb = document.querySelector('header');
    const main = document.querySelector('main');
    const cs = (el, p) => el ? getComputedStyle(el)[p] : null;
    return {
      sidebarWidth: sb ? sb.getBoundingClientRect().width : 0,
      sidebarBg: cs(sb, 'backgroundColor'),
      sidebarBlur: cs(sb, 'backdropFilter'),
      toolbarHeight: tb ? tb.getBoundingClientRect().height : 0,
      toolbarBg: cs(tb, 'backgroundColor'),
      toolbarBlur: cs(tb, 'backdropFilter'),
      sceneChildren: document.querySelectorAll('.bg-scene > i').length,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      theme: document.documentElement.getAttribute('data-theme'),
    };
  })()`);

  check(
    'Yan panel 252px (masaüstü)',
    Math.abs(shell.sidebarWidth - 252) < 2,
    `${shell.sidebarWidth.toFixed(1)}px`
  );
  check(
    'Yan panel şüşədir (blur + şəffaf fon)',
    typeof shell.sidebarBlur === 'string' &&
      shell.sidebarBlur.includes('blur') &&
      /rgba?\(/.test(shell.sidebarBg),
    `bg=${shell.sidebarBg} blur=${shell.sidebarBlur}`
  );
  check('Toolbar hündürlüyü 60px', Math.abs(shell.toolbarHeight - 60) < 1.5, `${shell.toolbarHeight}px`);
  check(
    'Toolbar şüşədir (blur işləyir)',
    typeof shell.toolbarBlur === 'string' && shell.toolbarBlur.includes('blur'),
    `bg=${shell.toolbarBg} blur=${shell.toolbarBlur}`
  );
  check('Fon səhnəsində 4 ləkə var', shell.sceneChildren === 4, `${shell.sceneChildren}`);
  check('Tema atributu qurulub', !!shell.theme, `data-theme=${shell.theme}`);

  /* ── 2. Kartlar ────────────────────────────────────────────────────────── */
  const cards = await evaluate(`(() => {
    // Yalnız MƏZMUN sahəsindəki kartlar. Yan paneldəki sürüşən aktiv
    // göstərici də .glass-card sinfini daşıyır, amma radiusu 11px-dir —
    // onu ölçsək, yoxlama yanlış mənfi verir.
    const list = [...document.querySelectorAll('main .glass-card')];
    if (!list.length) return { count: 0, tag: '-', cls: '-' };
    const s = getComputedStyle(list[0]);
    return {
      count: list.length,
      bg: s.backgroundColor,
      blur: s.backdropFilter,
      radius: s.borderTopLeftRadius,
      shadow: s.boxShadow.slice(0, 60),
      tag: list[0].tagName,
      cls: list[0].className.replace(/\\s+/g, ' ').trim().slice(0, 90),
    };
  })()`);

  check('Şüşə kartlar mövcuddur', cards.count >= 4, `${cards.count} kart`);
  check(
    'Kart qatı ≥62% (mətn oxunaqlığı)',
    (() => {
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(cards.bg || '');
      return m ? parseFloat(m[4]) >= 0.6 : false;
    })(),
    cards.bg
  );
  check(
    'Kart radiusu 18px',
    cards.radius === '18px',
    `${cards.radius} — <${cards.tag}> "${cards.cls}"`
  );

  /* ── 3. Üfüqi sürüşmə ──────────────────────────────────────────────────── */
  const overflowDesktop = await evaluate(`(() => {
    const d = document.documentElement;
    return d.scrollWidth - d.clientWidth;
  })()`);
  check('Masaüstü: üfüqi sürüşmə yoxdur', overflowDesktop <= 1, `${overflowDesktop}px`);

  /* ── 4. Ekran görüntüləri: masaüstü ────────────────────────────────────── */
  await shot('web-icmal');
  for (const [label, file] of [
    ['Rəf Auditi', 'web-yoxlama'],
    ['Planogram Tapşırıqları', 'web-tapsiriqlar'],
    ['Mağazalar Şəbəkəsi', 'web-magazalar'],
  ]) {
    const ok = await clickNav(label);
    check(`Naviqasiya: ${label}`, ok, ok ? 'keçid işləyir' : 'düymə tapılmadı');
    await shot(file);
  }

  /* ── 5. Cədvəl rejimi ──────────────────────────────────────────────────── */
  await clickNav('İcmal');
  await sleep(500);
  const tblDesktop = await evaluate(`(() => {
    const t = document.querySelector('table');
    if (!t) return null;
    const tr = t.querySelector('tbody tr');
    return {
      tableWidth: Math.round(t.getBoundingClientRect().width),
      trDisplay: tr ? getComputedStyle(tr).display : null,
      theadDisplay: getComputedStyle(t.querySelector('thead')).display,
    };
  })()`);
  check('Masaüstü: cədvəl cədvəl kimi qalır', tblDesktop && tblDesktop.trDisplay === 'table-row', JSON.stringify(tblDesktop));

  /* ── 5b. Müqayisə modalı ───────────────────────────────────────────────── */
  await clickNav('Rəf Auditi');
  await sleep(600);
  const opened = await evaluate(`(() => {
    const card = document.querySelector('main .glass-card');
    const btn = [...document.querySelectorAll('main button')].find((b) =>
      (b.textContent || '').includes('Müqayisə')
    );
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await sleep(900);

  const modal = await evaluate(`(() => {
    const veil = document.querySelector('.modal-veil');
    if (!veil) return { open: false };
    const panel = veil.querySelector('.glass-pop');
    const ps = panel ? getComputedStyle(panel) : null;
    const vs = getComputedStyle(veil);
    const closeBtn = [...veil.querySelectorAll('button')].find((b) => {
      const a = b.getAttribute('aria-label') || '';
      return a.includes('bağla') || a.includes('Bağla');
    });
    return {
      open: true,
      panelBg: ps ? ps.backgroundColor : null,
      panelRadius: ps ? ps.borderTopLeftRadius : null,
      panelBlur: ps ? ps.backdropFilter : null,
      veilBlur: vs.backdropFilter,
      veilBg: vs.backgroundColor,
      bodyScrollLocked: getComputedStyle(document.body).overflow,
    };
  })()`);

  check('Modal açılır', !!opened && modal.open, JSON.stringify({ opened, open: modal.open }));
  check(
    'Modal şüşədir (pop qatı + blur)',
    !!modal.panelBlur && modal.panelBlur.includes('blur'),
    `bg=${modal.panelBg} blur=${modal.panelBlur}`
  );
  check('Modal radiusu 18px', modal.panelRadius === '18px', modal.panelRadius);
  check(
    'Modal pərdəsi bulanıqdır',
    typeof modal.veilBlur === 'string' && modal.veilBlur.includes('blur'),
    `veil=${modal.veilBlur} / ${modal.veilBg}`
  );

  /* Pərdə BÜTÜN ekranı örtməlidir.
     Əvvəl `.view-g` giriş animasiyası `transform` animasiya etdiyi üçün
     `position: fixed` modalın "containing block"-u dəyişirdi: pərdə yalnız
     məzmun sahəsinə sıxılırdı, yan panel qaralmırdı və arxa fon kliklənirdi.
     Modal artıq portal ilə <body> altındadır — bu yoxlama reqressiyanın
     qarşısını alır. */
  const veilCover = await evaluate(`(() => {
    const veil = document.querySelector('.modal-veil');
    if (!veil) return { coversViewport: false, leaks: -1, rect: [], viewport: [], sample: [] };
    const panel = veil.querySelector('.glass-pop');
    const pr = panel.getBoundingClientRect();
    const leaks = [];
    for (let x = 8; x < innerWidth; x += 48) {
      for (let y = 8; y < innerHeight; y += 48) {
        if (x >= pr.left && x <= pr.right && y >= pr.top && y <= pr.bottom) continue;
        const el = document.elementFromPoint(x, y);
        if (!el) continue;
        if (!(el === veil || veil.contains(el))) leaks.push(x + ',' + y + ' ' + el.tagName);
      }
    }
    const vr = veil.getBoundingClientRect();
    return {
      coversViewport: Math.round(vr.width) >= innerWidth && Math.round(vr.height) >= innerHeight,
      rect: [Math.round(vr.x), Math.round(vr.y), Math.round(vr.width), Math.round(vr.height)],
      viewport: [innerWidth, innerHeight],
      leaks: leaks.length,
      sample: leaks.slice(0, 4),
    };
  })()`);

  check(
    'Modal pərdəsi bütün ekranı örtür',
    veilCover.coversViewport,
    `pərdə ${veilCover.rect.join(' × ')} / ekran ${veilCover.viewport.join(' × ')}`
  );
  check(
    'Pərdədən kənarda kliklənən sahə yoxdur',
    veilCover.leaks === 0,
    `${veilCover.leaks} sızma${veilCover.sample.length ? ' — ' + JSON.stringify(veilCover.sample) : ''}`
  );

  await shot('web-modal-muqayise');

  /* Fokus tələsi: Tab basanda fokus modalın İÇİNDƏ qalmalıdır */
  await send('Page.bringToFront');
  for (let i = 0; i < 14; i++) {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 9, key: 'Tab' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab' });
  }
  await sleep(300);
  const trapped = await evaluate(`(() => {
    const veil = document.querySelector('.modal-veil');
    const el = document.activeElement;
    return { inside: !!(veil && el && veil.contains(el)), tag: el ? el.tagName : null };
  })()`);
  check('Modal fokusu içəridə saxlayır (14 Tab)', trapped.inside, JSON.stringify(trapped));

  /* Escape modalı bağlamalıdır */
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(700);
  const modalClosed = await evaluate(`!document.querySelector('.modal-veil')`);
  check('Escape modalı bağlayır', modalClosed, String(modalClosed));

  /* ── 6. PLANŞET (768–1279) ─────────────────────────────────────────────── */
  // Cədvəl yoxlamaları üçün İcmal ekranına qayıdırıq (modal Rəf Auditində idi)
  await clickNav('İcmal');
  await sleep(600);
  await setViewport(1024, 820);
  const tablet = await evaluate(`(() => {
    const sb = document.querySelector('aside');
    // Yalnız YARPAQ spanlar — valideyn <span class="flex"> textContent-i
    // gizlədilmiş uşaqdan da götürür, ona görə onu saymırıq.
    const labels = [...document.querySelectorAll('aside nav span')].filter((s) => {
      if (s.children.length > 0) return false;
      if (getComputedStyle(s).display === 'none') return false;
      return s.textContent.trim().length > 3;
    }).length;
    return {
      sidebarWidth: sb.getBoundingClientRect().width,
      visibleLabels: labels,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
  check(
    'Planşet: yan panel 74px relsə düşür',
    Math.abs(tablet.sidebarWidth - 74) < 2,
    `${tablet.sidebarWidth.toFixed(1)}px`
  );
  check('Planşet: mətn etiketləri gizlədilib', tablet.visibleLabels === 0, `${tablet.visibleLabels} görünən`);
  check('Planşet: üfüqi sürüşmə yoxdur', tablet.overflow <= 1, `${tablet.overflow}px`);
  await shot('web-planset-icmal');

  /* ── 7. TELEFON (<768) ─────────────────────────────────────────────────── */
  await setViewport(390, 844, true);
  const phone = await evaluate(`(() => {
    const sb = document.querySelector('aside');
    const r = sb.getBoundingClientRect();
    const ham = document.querySelector('header button[aria-label*="menyu"], header button[aria-label*="Menyu"]');
    const tr = document.querySelector('table tbody tr');
    return {
      sidebarVisible: r.right > 0 && r.left < 390,
      sidebarLeft: Math.round(r.left),
      hamburger: !!ham && getComputedStyle(ham).display !== 'none',
      trDisplay: tr ? getComputedStyle(tr).display : null,
      theadDisplay: document.querySelector('table thead') ? getComputedStyle(document.querySelector('table thead')).display : null,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);

  check('Telefon: çekmece gizlidir', phone.sidebarLeft < 0, `left=${phone.sidebarLeft}px`);
  check('Telefon: hamburger düyməsi görünür', phone.hamburger, String(phone.hamburger));
  check('Telefon: cədvəl karta çevrilir (grid)', phone.trDisplay === 'grid', String(phone.trDisplay));
  check('Telefon: cədvəl başlığı gizlədilib', phone.theadDisplay === 'none', String(phone.theadDisplay));
  check('Telefon: üfüqi sürüşmə yoxdur', phone.overflow <= 1, `${phone.overflow}px`);
  await shot('web-telefon-icmal');

  /* Çekmece aç */
  await evaluate(`(() => {
    const b = document.querySelector('header button[aria-label*="menyu"], header button[aria-label*="Menyu"]');
    if (b) b.click();
  })()`);
  await sleep(600);
  const drawer = await evaluate(`(() => {
    const sb = document.querySelector('aside');
    const r = sb.getBoundingClientRect();
    return { left: Math.round(r.left), width: Math.round(r.width) };
  })()`);
  check('Telefon: çekmece açılır', drawer.left === 0 && drawer.width === 252, JSON.stringify(drawer));
  await shot('web-telefon-cekmece');

  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await sleep(500);
  const closed = await evaluate(`Math.round(document.querySelector('aside').getBoundingClientRect().left)`);
  check('Escape çekməni bağlayır', closed < 0, `left=${closed}px`);

  /* ── 8. TÜND TEMA ──────────────────────────────────────────────────────── */
  await setViewport(1440, 900);
  await evaluate(`(() => {
    const b = document.querySelector('header button[aria-label*="tünd"], header button[aria-label*="Tünd"], header button[aria-label*="İşıq"]');
    if (b) b.click();
  })()`);
  await sleep(700);
  const dark = await evaluate(`(() => {
    const s = getComputedStyle(document.body);
    const sb = document.querySelector('aside');
    const card = document.querySelector('.glass-card');
    return {
      theme: document.documentElement.getAttribute('data-theme'),
      bodyBg: s.backgroundColor,
      ink: getComputedStyle(document.documentElement).getPropertyValue('--ink').trim(),
      cardBg: card ? getComputedStyle(card).backgroundColor : null,
      sidebarBg: sb ? getComputedStyle(sb).backgroundColor : null,
    };
  })()`);
  check('Tünd tema işə düşür', dark.theme === 'dark', `data-theme=${dark.theme}`);
  check('Tünd temada mətn işıqdır', /^#f/i.test(dark.ink), `--ink=${dark.ink}`);
  await shot('web-tund-icmal');

  /* ── 9. KONTRAST ───────────────────────────────────────────────────────── */
  // Bir dəfə yazılan ifadə, sonra hər ekran üçün təkrar işlədilir
  const CONTRAST_EXPR = `(() => {
    function lum(c) {
      const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(c);
      if (!m) return null;
      const [r, g, b] = [+m[1], +m[2], +m[3]].map((v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    // Arxa fonu (şəffaflıqları qarışdıraraq) təxmin edən köməkçi
    function effBg(el) {
      let node = el, stack = [];
      while (node && node !== document.documentElement) {
        const bg = getComputedStyle(node).backgroundColor;
        const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/.exec(bg);
        if (m) {
          const a = m[4] === undefined ? 1 : parseFloat(m[4]);
          if (a > 0) {
            stack.push([+m[1], +m[2], +m[3], a]);
            if (a >= 0.98) break;
          }
        }
        node = node.parentElement;
      }
      const base = getComputedStyle(document.body).backgroundColor;
      const bm = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(base) || [0, 233, 237, 244];
      let [r, g, b] = [+bm[1], +bm[2], +bm[3]];
      for (let i = stack.length - 1; i >= 0; i--) {
        const [sr, sg, sb, a] = stack[i];
        r = sr * a + r * (1 - a);
        g = sg * a + g * (1 - a);
        b = sb * a + b * (1 - a);
      }
      return [r, g, b];
    }

    const nodes = [...document.querySelectorAll('p, span, h1, h2, h3, h4, td, th, button, b')];
    let worst = 99, worstText = '', n = 0, fails = [];
    for (const el of nodes) {
      const t = (el.textContent || '').trim();
      if (!t || t.length < 2) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      if (el.children.length > 0 && !/^(BUTTON|TD|TH|B|SPAN)$/.test(el.tagName)) continue;
      const cs = getComputedStyle(el);
      const size = parseFloat(cs.fontSize);
      const weight = parseInt(cs.fontWeight, 10) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const fg = cs.color;
      const fgm = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(fg);
      if (!fgm) continue;
      const bgc = effBg(el);
      const l1 = lum('rgb(' + [+fgm[1], +fgm[2], +fgm[3]].join(',') + ')');
      const l2 = lum('rgb(' + bgc.map(Math.round).join(',') + ')');
      const a = l1 > l2 ? l1 : l2, b2 = l1 > l2 ? l2 : l1;
      const cr2 = (a + 0.05) / (b2 + 0.05);
      n++;
      if (cr2 < worst) { worst = cr2; worstText = t.slice(0, 34); }
      const need = large ? 3 : 4.5;
      if (cr2 < need) fails.push({ t: t.slice(0, 30), cr: +cr2.toFixed(2), need });
    }
    return { n, worst: +worst.toFixed(2), worstText, fails: fails.slice(0, 8), failCount: fails.length };
  })()`;

  /* ── 9b. KONTRAST — BÜTÜN EKRANLAR ─────────────────────────────────────── */
  // Tək ekranda ölçmək kifayət etmir: hər ekranın öz nişanları var
  // (prioritet çipləri, uyğunluq zolaqları, status nişanları).
  await evaluate(`document.documentElement.setAttribute('data-theme','light')`);
  await sleep(400);

  const tabs = ['İcmal', 'Rəf Auditi', 'Planogram Tapşırıqları', 'Mağazalar Şəbəkəsi'];
  for (const tab of tabs) {
    await clickNav(tab);
    await sleep(650);
    const c = await evaluate(CONTRAST_EXPR);
    check(
      `Kontrast (${tab}): ${c.n} nümunə`,
      c.failCount === 0,
      `ən aşağı ${c.worst}:1 ("${c.worstText}")` +
        (c.failCount ? ` — uğursuz: ${JSON.stringify(c.fails)}` : '')
    );
  }

  // Tünd temada da eyni ölçmə
  await evaluate(`document.documentElement.setAttribute('data-theme','dark')`);
  await clickNav('İcmal');
  await sleep(650);
  const cDark = await evaluate(CONTRAST_EXPR);
  check(
    `Kontrast (tünd tema): ${cDark.n} nümunə`,
    cDark.failCount === 0,
    `ən aşağı ${cDark.worst}:1 ("${cDark.worstText}")` +
      (cDark.failCount ? ` — uğursuz: ${JSON.stringify(cDark.fails)}` : '')
  );

  await evaluate(`document.documentElement.setAttribute('data-theme','light')`);
  await sleep(300);

  /* ── 10. Fokus halqası ─────────────────────────────────────────────────── */
  await send('Page.bringToFront');
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 9, key: 'Tab' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab' });
  await sleep(350);
  const focusRing = await evaluate(`(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return { ok: false, tag: el ? el.tagName : null };
    const s = getComputedStyle(el);
    return { ok: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0, tag: el.tagName, outline: s.outline };
  })()`);
  check('Klaviatura fokus halqası görünür', focusRing.ok, JSON.stringify(focusRing));

  /* ── 11. Xarici asılılıq və səhv ──────────────────────────────────────── */
  const ext = await evaluate(`(() => {
    const links = [...document.querySelectorAll('link[href^="http"], script[src^="http"]')];
    return { count: links.length, urls: links.map(l => l.href || l.src).slice(0, 5) };
  })()`);
  check('Xarici CDN asılılığı yoxdur', ext.count === 0, `${ext.count} xarici resurs`);

  const imgs = await evaluate(`(() => {
    const all = [...document.querySelectorAll('img')];
    return { total: all.length, broken: all.filter(i => i.complete && i.naturalWidth === 0).length };
  })()`);
  check('Sınıq şəkil yoxdur', imgs.broken === 0, `${imgs.total} şəkil, ${imgs.broken} sınıq`);

  /* ── Nəticə ────────────────────────────────────────────────────────────── */
  const pass = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass);

  console.log('\n' + '═'.repeat(78));
  console.log(`  oneTeam şüşə dizayn yoxlaması — ${pass}/${results.length} keçdi`);
  console.log('═'.repeat(78));
  for (const r of results) {
    console.log(`  ${r.pass ? '✓' : '✗'}  ${r.name.padEnd(48)} ${r.detail ?? ''}`);
  }
  console.log('═'.repeat(78));
  if (fail.length) {
    console.log(`\n  UĞURSUZ: ${fail.length}`);
    for (const f of fail) console.log(`   ✗ ${f.name} — ${f.detail}`);
  }
  console.log(`\n  Konsol səhvləri: ${consoleErrors.length}`);
  consoleErrors.slice(0, 6).forEach((e) => console.log(`   ! ${String(e).split('\n')[0].slice(0, 130)}`));
  console.log(`\n  Ekran görüntüləri: ${OUT}`);
  console.log('═'.repeat(78) + '\n');

  process.exit(fail.length || consoleErrors.length ? 1 : 0);
}

main().catch((e) => {
  console.error('YOXLAMA XƏTASI:', e.message);
  process.exit(2);
});
