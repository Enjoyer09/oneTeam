import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CDP = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let idc = 0;

const list = await (await fetch(`${CDP}/json/list`)).json();
const target = list.find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));

const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
});
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++idc;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'http://localhost:5173/' });
await sleep(4500);

// desktop metrics
console.log('DESKTOP=' + (await evaluate(`JSON.stringify({
  header: document.querySelector('header')?.getBoundingClientRect().height,
  headerClass: document.querySelector('header')?.className,
  computedHeaderHeight: getComputedStyle(document.querySelector('header')).height,
  shadowSubtleCard: getComputedStyle(document.querySelector('main .bg-white')).boxShadow,
  sidebarWidth: document.querySelector('aside')?.getBoundingClientRect().width,
  mainScrollWidth: document.querySelector('main')?.scrollWidth,
  mainClientWidth: document.querySelector('main')?.clientWidth,
  htmlOverflowX: getComputedStyle(document.documentElement).overflowX,
  bodyBg: getComputedStyle(document.body).backgroundColor,
  fontFamily: getComputedStyle(document.body).fontFamily,
})`)));

// Review tab + card geometry
await evaluate(`[...document.querySelectorAll('aside nav button')][1].click()`);
await sleep(1800);

console.log('CARDS=' + (await evaluate(`
  JSON.stringify([...document.querySelectorAll('main .grid > div')].slice(0,2).map(c => {
    const img = c.querySelector('.relative');
    const badge = c.querySelector('.absolute.top-2\\\\.5');
    const h4 = c.querySelector('h4');
    return {
      cardH: Math.round(c.getBoundingClientRect().height),
      imgH: img ? Math.round(img.getBoundingClientRect().height) : null,
      imgW: img ? Math.round(img.getBoundingClientRect().width) : null,
      badgeH: badge ? Math.round(badge.getBoundingClientRect().height) : null,
      badgeBottom: badge ? Math.round(badge.getBoundingClientRect().bottom) : null,
      imgBottom: img ? Math.round(img.getBoundingClientRect().bottom) : null,
      badgeOverflowsImage: badge && img ? badge.getBoundingClientRect().bottom > img.getBoundingClientRect().bottom : null,
      h4Top: h4 ? Math.round(h4.getBoundingClientRect().top) : null,
      h4Text: h4?.textContent,
      imgSrc: img?.querySelector('img')?.src,
    };
  }), null, 1)
`)));

// zoomed clip of second card
const { data } = await send('Page.captureScreenshot', {
  format: 'png',
  clip: { x: 410, y: 105, width: 300, height: 260, scale: 3 },
});
writeFileSync(resolve('shots', 'zoom-card2.png'), Buffer.from(data, 'base64'));
console.log('zoom-card2 saved');

// zoomed clip of card 1 (3 badges)
const { data: d2 } = await send('Page.captureScreenshot', {
  format: 'png',
  clip: { x: 193, y: 105, width: 300, height: 260, scale: 3 },
});
writeFileSync(resolve('shots', 'zoom-card1.png'), Buffer.from(d2, 'base64'));
console.log('zoom-card1 saved');

// font check: is Plus Jakarta Sans actually applied?
console.log('FONTS=' + (await evaluate(`
  JSON.stringify({
    loaded: document.fonts ? [...document.fonts].map(f => f.family + ':' + f.status).slice(0,6) : [],
    h1font: getComputedStyle(document.querySelector('h1')).fontFamily,
  })
`)));

ws.close();
process.exit(0);
