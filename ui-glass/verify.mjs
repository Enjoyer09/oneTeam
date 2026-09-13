// oneTeam Glass UI — headless render + measurement verifier.
// Uses only Node built-ins (fetch + WebSocket) and a CDP-driven Chrome.
// Usage:  node ui-glass/verify.mjs
// Chrome must be started first on port 9224:
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//     --headless=new --remote-debugging-port=9224 \
//     --user-data-dir=/tmp/chrome-glass-profile about:blank
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(__dir, 'shots');
mkdirSync(SHOTS, { recursive: true });

const FILE = 'file://' + resolve(__dir, 'oneTeam-Glass-Prototype.html');
const PORT = 9224;

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = list.find(t => t.type === 'page');
if (!target) throw new Error('no page target on CDP ' + PORT);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));

let id = 0;
const pending = new Map();
ws.addEventListener('message', ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve: res, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : res(msg.result);
  }
});
const send = (method, params = {}) => new Promise((res, reject) => {
  const i = ++id;
  pending.set(i, { resolve: res, reject });
  ws.send(JSON.stringify({ id: i, method, params }));
});

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + expr);
  return r.result.value;
};
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(resolve(SHOTS, name + '.png'), Buffer.from(data, 'base64'));
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 1680, height: 1080, deviceScaleFactor: 2, mobile: false,
});

const consoleErrors = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.exceptionThrown') consoleErrors.push('EXC ' + m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push('ERR ' + m.params.args.map(a => a.value).join(' '));
  }
});

await send('Page.navigate', { url: FILE });
await new Promise(r => setTimeout(r, 2200));

const click = (sel) => evaluate(`document.querySelector(${JSON.stringify(sel)}).click(); true`);
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- screenshots: every platform x screen x theme ----------
const WEB = ['icmal', 'yoxlama', 'tapsiriqlar', 'magazalar', 'sistem'];
const IOS = ['bugun', 'kamera', 'gonderis', 'hesab'];

await click('#seg-platform button[data-p="web"]');
for (const v of WEB) {
  await evaluate(`document.querySelector('#seg-web button[data-v="${v}"]').click()`);
  await wait(450);
  await shot('web-' + v);
}
// dark pass
await click('#seg-theme button[data-th="dark"]');
await evaluate(`document.querySelector('#seg-web button[data-v="icmal"]').click()`);
await wait(500); await shot('web-dark-icmal');
await evaluate(`document.querySelector('#seg-web button[data-v="sistem"]').click()`);
await wait(500); await shot('web-dark-sistem');
await click('#seg-theme button[data-th="light"]');

// responsive widths — the active view must be reset explicitly for each pass
for (const [size, label] of [['compact', 'tablet'], ['narrow', 'mobile']]) {
  await click(`#seg-size button[data-s="${size}"]`);
  await evaluate(`document.querySelector('#seg-web button[data-v="icmal"]').click()`);
  await wait(700); await shot('web-' + label + '-icmal');
  await evaluate(`document.querySelector('#seg-web button[data-v="yoxlama"]').click()`);
  await wait(500); await shot('web-' + label + '-yoxlama');
}
await click('#seg-size button[data-s="full"]');
await evaluate(`document.querySelector('#seg-web button[data-v="icmal"]').click()`);
await wait(700);

// overlays
await evaluate(`document.querySelector('[data-ovl]').click()`);
await wait(500); await shot('web-modal-compare');
await evaluate(`document.querySelector('#ovl [data-close]').click()`);
await wait(350);

// command palette
await evaluate(`document.querySelector('#btn-pal').click()`);
await wait(450); await shot('web-command-palette');
await evaluate(`document.querySelector('#pal .bg').click()`);
await wait(300);

// empty state
await evaluate(`document.querySelector('#seg-web button[data-v="yoxlama"]').click()`);
await wait(400);
await evaluate(`document.querySelector('#btn-empty').click()`);
await wait(400); await shot('web-empty-state');
await evaluate(`document.querySelector('#btn-empty').click()`);
await wait(300);

// iOS
await click('#seg-platform button[data-p="ios"]');
await wait(500);
for (const v of IOS) {
  await evaluate(`document.querySelector('#seg-ios button[data-v="${v}"]').click()`);
  await wait(450); await shot('ios-' + v);
}
await evaluate(`document.querySelector('#seg-ios button[data-v="bugun"]').click()`);
await wait(400);
await evaluate(`document.querySelector('[data-sheet]').click()`);
await wait(600); await shot('ios-sheet-task');
await evaluate(`document.querySelector('#ovl [data-close]').click()`);
await wait(300);

// reduced motion
await evaluate(`document.querySelector('#btn-motion').click()`);
await wait(300); await shot('web-reduced-motion');
await evaluate(`document.querySelector('#btn-motion').click()`);

// ---------- measurements ----------
const settle = (ms = 620) => new Promise(r => setTimeout(r, ms));

const M = await evaluate(`(async () => {
  const out = {};
  const r = (el) => { const b = el.getBoundingClientRect(); return {w:+b.width.toFixed(1), h:+b.height.toFixed(1)}; };
  const px = (el, p) => getComputedStyle(el)[p] || getComputedStyle(el)['webkit' + p[0].toUpperCase() + p.slice(1)];
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const click = (s) => document.querySelector(s).click();

  click('#seg-platform button[data-p="web"]');
  click('#seg-web button[data-v="icmal"]');
  click('#seg-size button[data-s="full"]');
  await wait(700);

  out.winSize = r(document.querySelector('#win'));
  out.sidebarWidth = r(document.querySelector('.sb')).w;
  out.toolbarHeight = r(document.querySelector('#tb')).h;
  out.cardBackdrop = px(document.querySelector('.card'), 'backdropFilter');
  out.toolbarBackdrop = px(document.querySelector('#tb'), 'backdropFilter');
  out.cardBackground = getComputedStyle(document.querySelector('.card')).backgroundColor;
  out.dashboardTableWidth = Math.round(document.querySelector('#v-icmal table').getBoundingClientRect().width);
  out.tableOverflow = (() => { const s = document.querySelector('.tbl-scroll'); return s.scrollWidth - s.clientWidth; })();

  // typography floor
  const tiny = [];
  document.querySelectorAll('#wrap-web *, #wrap-ios *').forEach(el => {
    if (!el.children.length && el.textContent.trim()) {
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs < 10) tiny.push(el.textContent.trim().slice(0, 22) + ' @' + fs);
    }
  });
  out.subTenPx = tiny;

  // tablet
  click('#seg-size button[data-s="compact"]'); await wait(750);
  out.tabletSidebarWidth = +document.querySelector('.sb').getBoundingClientRect().width.toFixed(1);
  out.tabletLabelDisplay = getComputedStyle(document.querySelector('.nav .hide-c')).display;
  out.tabletTableOverflow = (() => { const s = document.querySelector('.tbl-scroll'); return s.scrollWidth - s.clientWidth; })();
  out.tabletWhoColHidden = getComputedStyle(document.querySelector('.c-who')).display;

  // phone
  click('#seg-size button[data-s="narrow"]'); await wait(750);
  const win = document.querySelector('#win');
  out.narrowWinWidth = +win.getBoundingClientRect().width.toFixed(1);
  out.narrowDocOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  out.narrowScrollOverflow = (() => { const s = document.querySelector('#w-scroll'); return s.scrollWidth - s.clientWidth; })();
  out.narrowTableOverflow = (() => { const s = document.querySelector('.tbl-scroll'); return s.scrollWidth - s.clientWidth; })();
  out.narrowTableDisplay = getComputedStyle(document.querySelector('#v-icmal table')).display;
  out.narrowTheadDisplay = getComputedStyle(document.querySelector('#v-icmal thead')).display;
  const sb = document.querySelector('.sb');
  out.narrowSidebarHidden = sb.getBoundingClientRect().right <= win.getBoundingClientRect().left + 1;
  // horizontal overflow must be zero on EVERY web screen, not just the dashboard
  out.narrowOverflowByView = {};
  for (const v of ['icmal','yoxlama','tapsiriqlar','magazalar','sistem']) {
    click('#seg-web button[data-v="' + v + '"]');
    await wait(420);
    const s = document.querySelector('#w-scroll');
    out.narrowOverflowByView[v] = s.scrollWidth - s.clientWidth;
  }
  click('#seg-web button[data-v="icmal"]'); await wait(400);
  click('#hamb'); await wait(420);
  out.narrowDrawerRevealed = sb.getBoundingClientRect().left >= win.getBoundingClientRect().left - 1;
  click('#scrim'); await wait(420);
  out.narrowDrawerClosed = sb.getBoundingClientRect().right <= win.getBoundingClientRect().left + 1;

  click('#seg-size button[data-s="full"]'); await wait(750);

  // iOS targets — must switch to the owning screen first
  click('#seg-platform button[data-p="ios"]'); await wait(700);
  out.iosTabBarH = r(document.querySelector('.tabbar')).h;
  out.iosTabSizes = [...document.querySelectorAll('.tab')].map(e => r(e));
  out.iosStatusBarH = r(document.querySelector('.istatus')).h;
  out.iosIslandBottom = (() => {
    const ip = document.querySelector('.iphone').getBoundingClientRect();
    return +(document.querySelector('.island').getBoundingClientRect().bottom - ip.top).toFixed(1);
  })();
  out.iosIslandOverStatusBar = (() => {
    const ip = document.querySelector('.iphone').getBoundingClientRect();
    const isl = document.querySelector('.island').getBoundingClientRect();
    const st = document.querySelector('.istatus').getBoundingClientRect();
    // island is horizontally centred; the status bar's own content sits at the edges
    return isl.top - ip.top >= st.top - ip.top - 1 && isl.bottom - ip.top <= st.bottom - ip.top + 1;
  })();

  click('#seg-ios button[data-v="kamera"]'); await wait(500);
  out.iosShutter = r(document.querySelector('.shutter'));
  out.iosCamBtns = [...document.querySelectorAll('.cbtn')].map(e => r(e));

  click('#seg-ios button[data-v="hesab"]'); await wait(500);
  const rows = [...document.querySelectorAll('.irow')].map(e => r(e).h);
  out.iosRowHeights = rows;
  out.iosMinRow = Math.min(...rows);
  out.iosSwitch = r(document.querySelector('.sw'));

  // large-title collapse on scroll
  click('#seg-ios button[data-v="bugun"]'); await wait(500);
  const before = document.querySelector('#ios-title').getBoundingClientRect().height;
  document.querySelector('#ios-scroll').scrollTop = 200;
  document.querySelector('#ios-scroll').dispatchEvent(new Event('scroll'));
  await wait(450);
  const after = document.querySelector('#ios-title').getBoundingClientRect().height;
  out.iosTitleCollapse = +before.toFixed(1) + 'px -> ' + +after.toFixed(1) + 'px';
  out.iosNavCompact = document.querySelector('#inav').classList.contains('small');
  document.querySelector('#ios-scroll').scrollTop = 0;
  document.querySelector('#ios-scroll').dispatchEvent(new Event('scroll'));
  await wait(300);

  // floating tab bar must not permanently hide the last element of any screen
  out.iosBottomReach = {};
  for (const v of ['bugun','kamera','gonderis','hesab']) {
    click('#seg-ios button[data-v="' + v + '"]'); await wait(420);
    const sc = document.querySelector('#ios-scroll');
    sc.scrollTop = sc.scrollHeight;
    await wait(120);
    const tbTop = document.querySelector('.tabbar').getBoundingClientRect().top;
    const view = document.querySelector('#iv-' + v);
    const last = view.lastElementChild.lastElementChild.getBoundingClientRect();
    out.iosBottomReach[v] = +(tbTop - last.bottom).toFixed(1);   // >= 0 means fully clear of the bar
  }
  click('#seg-ios button[data-v="bugun"]');
  document.querySelector('#ios-scroll').scrollTop = 0;
  await wait(300);

  click('#seg-platform button[data-p="web"]'); await wait(600);
  out.ariaCount = document.querySelectorAll('[aria-label],[aria-current],[aria-selected],[role],[aria-modal],[aria-live]').length;
  out.imgsWithoutFallback = [...document.images].filter(i => !i.onerror).length;
  out.externalRefs = document.querySelectorAll('link[href^="http"], script[src^="http"]').length;
  out.ariaLive = !!document.querySelector('[aria-live]');
  return out;
})()`);

// focus-visible must be a REAL keyboard focus, not .focus()
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await send('Page.bringToFront');
await evaluate(`document.querySelector('#seg-platform button[data-p="web"]').click(); document.querySelector('#seg-web button[data-v="icmal"]').click(); document.body.focus();`);
await new Promise(r => setTimeout(r, 500));
for (let i = 0; i < 4; i++) {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
  await new Promise(r => setTimeout(r, 120));
}
const focusRing = await evaluate(`(() => {
  const el = document.activeElement;
  const cs = getComputedStyle(el);
  return { tag: el.tagName, label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30),
           style: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor, offset: cs.outlineOffset };
})()`);

// Escape closes overlays
const escTest = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const res = {};
  document.querySelector('#seg-platform button[data-p="web"]').click();
  document.querySelector('#seg-web button[data-v="icmal"]').click();
  await wait(450);
  const trigger = document.querySelector('#v-icmal [data-ovl]');
  trigger.focus(); trigger.click(); await wait(350);
  res.modalOpened = document.querySelector('#ovl').classList.contains('on');
  res.modalRole = document.querySelector('#ovl').getAttribute('role');
  res.modalAriaModal = document.querySelector('#ovl').getAttribute('aria-modal');
  res.focusMovedInside = document.querySelector('#ovl').contains(document.activeElement);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(300);
  res.escClosedModal = !document.querySelector('#ovl').classList.contains('on');
  res.focusRestored = document.activeElement === trigger;
  document.querySelector('#btn-pal').click(); await wait(300);
  res.paletteOpened = document.querySelector('#pal').classList.contains('on');
  res.paletteItems = document.querySelectorAll('.pal-item').length;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(250);
  res.escClosedPalette = !document.querySelector('#pal').classList.contains('on');
  return res;
})()`);

// reduced motion actually disables transitions
const rmTest = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('#btn-motion').click(); await wait(300);
  const attr = document.documentElement.getAttribute('data-motion');
  const d = getComputedStyle(document.querySelector('.gcard')).transitionDuration;
  document.querySelector('#btn-motion').click();
  return { attr, transitionDuration: d };
})()`);


// ---------- contrast check on glass ----------
const contrast = await evaluate(`(() => {
  const lum = (rgb) => {
    const c = rgb.map(v => { v/=255; return v <= .03928 ? v/12.92 : Math.pow((v+.055)/1.055, 2.4); });
    return .2126*c[0] + .7152*c[1] + .0722*c[2];
  };
  const parse = (s) => { const m = s.match(/[\\d.]+/g).map(Number); return m.slice(0,3); };
  const ratio = (a,b) => { const l1 = lum(a), l2 = lum(b); const hi = Math.max(l1,l2), lo = Math.min(l1,l2);
    return +((hi+.05)/(lo+.05)).toFixed(2); };
  const res = [];
  const DARK_SURFACE = [26, 32, 45];   // .cam base tone
  document.querySelectorAll('.card h3, .ttl, .kpi-sub, .st, .chip, .card p, .m-row .v, .irow .rt b, .irow .rt span').forEach(el => {
    if (el.closest('.shot')) return;           // sits on a photo gradient — dark backing by design, checked visually
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    let bg;
    if (el.closest('.cam')) {
      bg = DARK_SURFACE;
    } else {
      bg = [255,255,255]; let node = el;
      while (node && node !== document.documentElement) {
        const b = getComputedStyle(node).backgroundColor;
        if (b && b !== 'rgba(0, 0, 0, 0)' && b !== 'transparent') {
          const p = parse(b); const a = parseFloat((b.match(/[\\d.]+/g) || [])[3] ?? '1');
          // composite over white — the glass floor is >= .62 alpha so this is a close approximation
          bg = p.map((v,i) => Math.round(v*a + 255*(1-a)));
          break;
        }
        node = node.parentElement;
      }
    }
    const r = ratio(fg, bg);
    res.push({ text: el.textContent.trim().slice(0,24), fs: parseFloat(cs.fontSize), weight: cs.fontWeight, ratio: r });
  });
  return res;
})()`);

const ok = (b) => b ? 'PASS' : '** FAIL **';
const line = (label, value, pass) => console.log((pass === undefined ? '  ' : (pass ? '  OK  ' : '  !!  ')) + label.padEnd(34) + value);

console.log('\n================ oneTeam Glass UI — VERIFICATION ================\n');
console.log('— Şüşə materialları —');
line('window', JSON.stringify(M.winSize));
line('card backdrop-filter', M.cardBackdrop);
line('toolbar backdrop-filter', M.toolbarBackdrop);
line('card background', M.cardBackground);
console.log('\n— Qabıq (responsive shell) —');
line('sidebar full / tablet', M.sidebarWidth + 'px / ' + M.tabletSidebarWidth + 'px', M.sidebarWidth > 200 && M.tabletSidebarWidth < 100);
line('tablet labels hidden', M.tabletLabelDisplay, M.tabletLabelDisplay === 'none');
line('tablet low-priority cols', M.tabletWhoColHidden, M.tabletWhoColHidden === 'none');
line('toolbar height', M.toolbarHeight + 'px', Math.abs(M.toolbarHeight - 60) < 3);
console.log('\n— Cədvəl davranışı —');
line('full: table width / overflow', M.dashboardTableWidth + 'px / ' + M.tableOverflow + 'px', M.tableOverflow <= 0);
line('tablet: overflow', M.tabletTableOverflow + 'px', M.tabletTableOverflow <= 0);
line('phone: table display', M.narrowTableDisplay, M.narrowTableDisplay === 'block');
line('phone: thead display', M.narrowTheadDisplay, M.narrowTheadDisplay === 'none');
line('phone: table overflow', M.narrowTableOverflow + 'px', M.narrowTableOverflow <= 0);
console.log('\n— Telefon qabığı —');
line('window width', M.narrowWinWidth + 'px', M.narrowWinWidth <= 440);
line('doc / scroll overflow', M.narrowDocOverflow + ' / ' + M.narrowScrollOverflow, M.narrowDocOverflow <= 0 && M.narrowScrollOverflow <= 0);
line('per-view overflow (phone)', JSON.stringify(M.narrowOverflowByView),
     Object.values(M.narrowOverflowByView).every(v => v <= 0));
line('sidebar hidden by default', M.narrowSidebarHidden, M.narrowSidebarHidden);
line('hamburger reveals drawer', M.narrowDrawerRevealed, M.narrowDrawerRevealed);
line('scrim closes drawer', M.narrowDrawerClosed, M.narrowDrawerClosed);
console.log('\n— iOS —');
line('status bar / tab bar height', M.iosStatusBarH + 'px / ' + M.iosTabBarH + 'px');
line('Dynamic Island sits in status bar', 'island bottom ' + M.iosIslandBottom + 'px of 50px', M.iosIslandOverStatusBar);
line('tab targets (min 44x44)', M.iosTabSizes.map(t => t.w + 'x' + t.h).join(' '), M.iosTabSizes.every(t => t.w >= 44 && t.h >= 44));
line('shutter target', M.iosShutter.w + 'x' + M.iosShutter.h, M.iosShutter.w >= 44);
line('camera buttons', M.iosCamBtns.map(t => t.w + 'x' + t.h).join(' '), M.iosCamBtns.every(t => t.w >= 44 && t.h >= 44));
line('list row min height', M.iosMinRow + 'px', M.iosMinRow >= 44);
line('switch size', M.iosSwitch.w + 'x' + M.iosSwitch.h, M.iosSwitch.h >= 28);
line('large title collapse', M.iosTitleCollapse, M.iosNavCompact);
line('floating tab bar clears content', JSON.stringify(M.iosBottomReach),
     Object.values(M.iosBottomReach).every(v => v >= 0));
console.log('\n— Əlçatanlıq —');
line('focus-visible ring', focusRing.width + ' ' + focusRing.style + ' ' + focusRing.color + ' on ' + focusRing.tag, focusRing.style !== 'none' && parseFloat(focusRing.width) >= 2);
line('modal role / aria-modal', escTest.modalRole + ' / ' + escTest.modalAriaModal, escTest.modalRole === 'dialog' && escTest.modalAriaModal === 'true');
line('modal opens + focus moves in', escTest.modalOpened + ' / ' + escTest.focusMovedInside, escTest.modalOpened && escTest.focusMovedInside);
line('Escape closes modal', escTest.escClosedModal, escTest.escClosedModal);
line('focus restored after close', escTest.focusRestored, escTest.focusRestored);
line('command palette items', escTest.paletteItems, escTest.paletteItems > 6);
line('Escape closes palette', escTest.escClosedPalette, escTest.escClosedPalette);
line('aria live region present', M.ariaLive, M.ariaLive);
line('aria/role attributes', M.ariaCount, M.ariaCount > 40);
line('text below 10px', M.subTenPx.length + (M.subTenPx.length ? ' -> ' + JSON.stringify(M.subTenPx) : ''), M.subTenPx.length === 0);
line('reduced motion disables transitions', rmTest.attr + ', ' + rmTest.transitionDuration, rmTest.attr === 'reduced' && parseFloat(rmTest.transitionDuration) < 0.01);
console.log('\n— Təmizlik —');
line('images without fallback', M.imgsWithoutFallback, M.imgsWithoutFallback === 0);
line('external CDN references', M.externalRefs, M.externalRefs === 0);
line('console errors / exceptions', consoleErrors.length + (consoleErrors.length ? ' -> ' + consoleErrors.slice(0,4).join(' | ') : ''), consoleErrors.length === 0);
console.log('\n— Kontrast (şüşə üzərində mətn) —');
const fail = contrast.filter(c => c.ratio < 4.5);
line('samples below 4.5:1', fail.length + ' / ' + contrast.length, fail.length === 0);
if (fail.length) console.log('     ', fail.map(c => c.ratio + ' ' + c.fs + 'px "' + c.text + '"').join(' | '));
const worst = contrast.slice().sort((a,b) => a.ratio - b.ratio).slice(0,5);
console.log('      worst:', worst.map(c => c.ratio + ' (' + c.fs + 'px) "' + c.text + '"').join(' | '));
console.log('\nScreenshots ->', SHOTS);
console.log('=================================================================\n');
ws.close();
process.exit(0);
