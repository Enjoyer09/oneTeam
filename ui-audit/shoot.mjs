// UI audit screenshot runner — drives headless Chrome over CDP (no external deps)
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const CDP = 'http://127.0.0.1:9222';
const OUT = resolve(process.argv[2] || 'shots');
const URL = 'http://localhost:5173/';
mkdirSync(OUT, { recursive: true });

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
      if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
        this.consoleErrors.push(
          `[${msg.params.type}] ` +
            msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')
        );
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.pageErrors.push(msg.params.exceptionDetails.text + ' ' +
          (msg.params.exceptionDetails.exception?.description || ''));
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
  throw new Error('Chrome CDP not reachable on 9222');
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
await cdp.send('Log.enable');

async function viewport(w, h, mobile = false) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: w, height: h, deviceScaleFactor: 1, mobile,
  });
}

async function shot(name, fullPage = false) {
  const opts = { format: 'png' };
  if (fullPage) opts.captureBeyondViewport = true;
  const { data } = await cdp.send('Page.captureScreenshot', opts);
  writeFileSync(resolve(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  console.log('shot ->', name);
}

async function evaluate(expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

const clickByText = (sel, text) => evaluate(`
  (() => {
    const els = [...document.querySelectorAll(${JSON.stringify(sel)})];
    const el = els.find(e => (e.textContent || '').includes(${JSON.stringify(text)}));
    if (!el) return 'NOT_FOUND';
    el.click();
    return 'CLICKED';
  })()
`);

const clickNth = (sel, n) => evaluate(`
  (() => {
    const els = [...document.querySelectorAll(${JSON.stringify(sel)})];
    if (!els[${n}]) return 'NOT_FOUND';
    els[${n}].click();
    return 'CLICKED';
  })()
`);

// ---------- DESKTOP ----------
await viewport(1600, 1000);
await cdp.send('Page.navigate', { url: URL });
await sleep(4000);
await shot('01-dashboard');

// Review center
console.log(await clickNth('aside nav button', 1));
await sleep(1800);
await shot('02-review-center');

// Comparison modal
console.log(await clickByText('button', 'Planogramla Müqayisə Et'));
await sleep(1800);
await shot('03-comparison-modal');

// scroll modal body to bottom to capture checklist + actions
await evaluate(`
  (() => {
    const m = document.querySelector('.overflow-y-auto.flex-1');
    if (m) m.scrollTop = m.scrollHeight;
    return 'ok';
  })()
`);
await sleep(900);
await shot('04-comparison-modal-scrolled');

// close modal
console.log(await clickNth('button[class*="rounded-full"]', 0));
await sleep(900);

// Tasks
console.log(await clickNth('aside nav button', 2));
await sleep(1500);
await shot('05-tasks');

// Bulk dispatch modal
console.log(await clickByText('button', 'Kütləvi Təlimat Göndər'));
await sleep(1500);
await shot('06-bulk-dispatch-modal');
console.log(await clickByText('button', 'Ləğv Et'));
await sleep(900);

// Create task modal
console.log(await clickByText('button', 'Yeni Təlimat Yarat'));
await sleep(1500);
await shot('07-create-task-modal');
console.log(await clickByText('button', 'Ləğv Et'));
await sleep(900);

// Stores
console.log(await clickNth('aside nav button', 3));
await sleep(1500);
await shot('08-stores');

// ---------- TABLET 1024 ----------
await viewport(1024, 900);
await sleep(1200);
await shot('09-tablet-1024-stores');

// ---------- MOBILE 390 ----------
await viewport(390, 844, true);
await sleep(1500);
await shot('10-mobile-390-stores');

// back to dashboard on mobile
console.log(await clickNth('aside nav button', 0));
await sleep(1500);
await shot('11-mobile-390-dashboard');

// measure overflow
const overflow = await evaluate(`
  JSON.stringify({
    docWidth: document.documentElement.scrollWidth,
    winWidth: window.innerWidth,
    sidebarWidth: document.querySelector('aside')?.getBoundingClientRect().width,
    headerHeight: document.querySelector('header')?.getBoundingClientRect().height,
  })
`);
console.log('MOBILE_MEASURE=' + overflow);

// ---------- 320px ----------
await viewport(320, 800, true);
await sleep(1200);
await shot('12-mobile-320-dashboard');
const overflow320 = await evaluate(`
  JSON.stringify({
    docWidth: document.documentElement.scrollWidth,
    winWidth: window.innerWidth,
  })
`);
console.log('MOBILE320_MEASURE=' + overflow320);

console.log('CONSOLE_ISSUES=' + JSON.stringify(cdp.consoleErrors, null, 1));
console.log('PAGE_ERRORS=' + JSON.stringify(cdp.pageErrors, null, 1));
ws.close();
process.exit(0);
