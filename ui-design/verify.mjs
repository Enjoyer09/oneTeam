// Verify the oneTeam redesign prototype renders correctly in all three shell modes.
// Reuses the dependency-free CDP approach from ui-audit/shoot.mjs.
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, 'verify-shots');
mkdirSync(OUT, { recursive: true });

const CDP = 'http://127.0.0.1:9223';
const URL = pathToFileURL(resolve(HERE, 'oneTeam-Redesign-Prototype.html')).href;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let idc = 0;
class CDPClient {
  constructor(ws) {
    this.ws = ws;
    this.pending = new Map();
    this.consoleErrors = [];
    this.pageErrors = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : res(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.pageErrors.push(msg.params.exceptionDetails.text);
      }
    });
  }
  send(method, params = {}) {
    const id = ++idc;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`${CDP}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch {}
    await sleep(500);
  }
  throw new Error('Chrome CDP not reachable on 9223');
}

const target = await connect();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.addEventListener('open', r);
  ws.addEventListener('error', j);
});
const cdp = new CDPClient(ws);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');

async function viewport(w, h) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
}
async function shot(name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(resolve(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  console.log('shot ->', name);
}
async function evaluate(expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

await viewport(1600, 1050);
await cdp.send('Page.navigate', { url: URL });
await sleep(3500);

// --- desktop, each view ---
await shot('01-desktop-dashboard');
for (const [v, n] of [['review', '02-desktop-review'], ['tasks', '03-desktop-tasks'], ['stores', '04-desktop-stores'], ['mobile', '05-desktop-fieldclient'], ['system', '06-desktop-system']]) {
  await evaluate(`document.querySelector('#seg-view button[data-v="${v}"]').click()`);
  await sleep(700);
  await shot(n);
}

// --- comparison modal ---
await evaluate(`document.querySelector('#seg-view button[data-v="review"]').click()`);
await sleep(500);
await evaluate(`document.querySelector('.gcard').click()`);
await sleep(900);
await shot('07-desktop-comparison-modal');
await evaluate(`document.getElementById('modal').classList.remove('on')`);

// --- tablet rail ---
await evaluate(`document.querySelector('#seg-mode button[data-m="tablet"]').click()`);
await evaluate(`document.querySelector('#seg-view button[data-v="dashboard"]').click()`);
await sleep(900);
await shot('08-tablet-rail');
const railMeasure = await evaluate(`JSON.stringify({
  sidebar: document.querySelector('.sb').getBoundingClientRect().width,
  header: document.querySelector('.hd').getBoundingClientRect().height,
  app: document.querySelector('.app').getBoundingClientRect().width
})`);
console.log('TABLET_MEASURE=' + railMeasure);

// --- mobile, drawer closed then open ---
await evaluate(`document.querySelector('#seg-mode button[data-m="mobile"]').click()`);
await sleep(900);
await shot('09-mobile-drawer-closed');
const mClosed = await evaluate(`(() => {
  const app = document.querySelector('.app').getBoundingClientRect();
  const sb = document.querySelector('.sb').getBoundingClientRect();
  const tr = document.querySelector('.tbl-scroll tr');
  return JSON.stringify({
    sidebarLeftRelToApp: Math.round(sb.left - app.left),
    sidebarVisibleInApp: sb.right > app.left + 1,
    header: document.querySelector('.hd').getBoundingClientRect().height,
    hamburgerShown: getComputedStyle(document.getElementById('hamb')).display !== 'none',
    appWidth: Math.round(app.width),
    contentWidth: Math.round(document.querySelector('.main').getBoundingClientRect().width),
    tableIsCardLayout: tr ? getComputedStyle(tr).display : null,
    theadHidden: getComputedStyle(document.querySelector('.tbl-scroll thead')).display
  });
})()`);
console.log('MOBILE_CLOSED=' + mClosed);

await evaluate(`document.getElementById('hamb').click()`);
await sleep(800);
await shot('10-mobile-drawer-open');
const mOpen = await evaluate(`JSON.stringify({
  sidebarLeft: Math.round(document.querySelector('.sb').getBoundingClientRect().left),
  scrimVisible: getComputedStyle(document.getElementById('scrim')).opacity
})`);
console.log('MOBILE_OPEN=' + mOpen);

await evaluate(`document.getElementById('scrim').click()`);
await sleep(600);

// --- mobile field client ---
await evaluate(`document.querySelector('#seg-view button[data-v="mobile"]').click()`);
await sleep(800);
await shot('11-mobile-fieldclient');

// --- real 390px browser check (true media-query behaviour) ---
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
await sleep(900);
await shot('12-real-390px');
const real = await evaluate(`JSON.stringify({
  docScrollWidth: document.documentElement.scrollWidth,
  winWidth: window.innerWidth,
  horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1
})`);
console.log('REAL_390=' + real);

console.log('CONSOLE_ERRORS=' + JSON.stringify(cdp.consoleErrors));
console.log('PAGE_ERRORS=' + JSON.stringify(cdp.pageErrors));
ws.close();
process.exit(0);
