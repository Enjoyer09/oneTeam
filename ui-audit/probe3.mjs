import { writeFileSync } from 'node:fs';

const CDP = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let idc = 0;
const list = await (await fetch(`${CDP}/json/list`)).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
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
  new Promise((res, rej) => { const id = ++idc; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'http://localhost:5173/' });
await sleep(4500);

const measure = (label, sel, filter) => `
  (() => {
    const els = [...document.querySelectorAll(${JSON.stringify(sel)});
    return null;
  })()
`;

// header primary action
console.log('HEADER_CTA=' + (await evaluate(`
  (() => {
    const b = [...document.querySelectorAll('header button')].find(x => x.textContent.includes('Yeni Təlimat'));
    if (!b) return 'NOT_FOUND';
    const r = b.getBoundingClientRect();
    return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height) });
  })()
`)));

// sidebar nav item
console.log('NAV_ITEM=' + (await evaluate(`
  (() => {
    const b = document.querySelector('aside nav button');
    if (!b) return 'NOT_FOUND';
    const r = b.getBoundingClientRect();
    return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height) });
  })()
`)));

// go to review center for filter chips + table action
await evaluate(`[...document.querySelectorAll('aside nav button')][1].click()`);
await sleep(1800);

console.log('FILTER_CHIP=' + (await evaluate(`
  (() => {
    const b = [...document.querySelectorAll('main button')].find(x => x.textContent.includes('Bütün Fotolar'));
    if (!b) return 'NOT_FOUND';
    const r = b.getBoundingClientRect();
    return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height) });
  })()
`)));

console.log('CARD_CTA=' + (await evaluate(`
  (() => {
    const b = [...document.querySelectorAll('main button')].find(x => x.textContent.includes('Planogramla Müqayisə Et'));
    if (!b) return 'NOT_FOUND';
    const r = b.getBoundingClientRect();
    return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height) });
  })()
`)));

console.log('SEARCH_INPUT=' + (await evaluate(`
  (() => {
    const i = document.querySelector('main input[type="text"]');
    if (!i) return 'NOT_FOUND';
    const r = i.getBoundingClientRect();
    const cs = getComputedStyle(i);
    return JSON.stringify({ h: Math.round(r.height), bg: cs.backgroundColor, radius: cs.borderRadius, pl: cs.paddingLeft });
  })()
`)));

// dashboard table action button
await evaluate(`[...document.querySelectorAll('aside nav button')][0].click()`);
await sleep(1500);
console.log('TABLE_ACTION=' + (await evaluate(`
  (() => {
    const b = [...document.querySelectorAll('main tbody button')].find(x => x.textContent.includes('Müqayisə Et'));
    if (!b) return 'NOT_FOUND';
    const r = b.getBoundingClientRect();
    return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height) });
  })()
`)));

// thumbnail size
console.log('THUMBNAIL=' + (await evaluate(`
  (() => {
    const t = document.querySelector('main tbody .w-11');
    if (!t) return 'NOT_FOUND';
    const r = t.getBoundingClientRect();
    return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height) });
  })()
`)));

// toast classes (read from source of truth: React state not active, read the DOM after triggering)
console.log('FOCUS_RING_PRESENT=' + (await evaluate(`
  (() => {
    const s = [...document.styleSheets].flatMap(sh => { try { return [...sh.cssRules]; } catch { return []; } });
    return s.filter(r => r.selectorText && r.selectorText.includes('focus-visible')).length;
  })()
`)));

ws.close();
process.exit(0);
