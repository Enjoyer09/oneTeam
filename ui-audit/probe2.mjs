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
  new Promise((res, rej) => { const id = ++idc; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'http://localhost:5173/' });
await sleep(4500);

await evaluate(`[...document.querySelectorAll('aside nav button')][1].click()`);
await sleep(1600);
// open first card's comparison
await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Planogramla Müqayisə Et')).click()`);
await sleep(1600);
// click "Before" toggle
await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Before')).click()`);
await sleep(1200);

// report all broken images on the page
console.log('BROKEN_IMAGES=' + (await evaluate(`
  JSON.stringify([...document.images].filter(i => !i.complete || i.naturalWidth === 0).map(i => i.src))
`)));

const { data } = await send('Page.captureScreenshot', {
  format: 'png',
  clip: { x: 660, y: 180, width: 420, height: 380, scale: 2 },
});
writeFileSync(resolve('shots', 'zoom-before-broken.png'), Buffer.from(data, 'base64'));
console.log('saved zoom-before-broken.png');
ws.close();
process.exit(0);
