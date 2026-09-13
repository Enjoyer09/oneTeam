import {writeFileSync} from 'node:fs';
const CDP='http://127.0.0.1:9222';const sleep=ms=>new Promise(r=>setTimeout(r,ms));let idc=0;
const list=await(await fetch(`${CDP}/json/list`)).json();
const ws=new WebSocket(list.find(t=>t.type==='page').webSocketDebuggerUrl);
await new Promise(r=>ws.addEventListener('open',r));
const p=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&p.has(m.id)){const{res,rej}=p.get(m.id);p.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);}});
const send=(method,params={})=>new Promise((res,rej)=>{const id=++idc;p.set(id,{res,rej});ws.send(JSON.stringify({id,method,params}));});
const ev=async e=>(await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true})).result.value;
await send('Page.enable');await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride',{width:1600,height:1000,deviceScaleFactor:1,mobile:false});
await send('Page.navigate',{url:'http://localhost:5173/'});await sleep(4500);
const box=JSON.parse(await ev(`
 (()=>{const b=[...document.querySelectorAll('main tbody button')].find(x=>x.textContent.includes('Müqayisə Et'));
 const r=b.getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height});})()
`));
console.log('BOX',JSON.stringify(box));
const {data}=await send('Page.captureScreenshot',{format:'png',clip:{x:box.x-14,y:box.y-14,width:box.w+28,height:box.h+28,scale:4}});
writeFileSync('shots/zoom-table-action.png',Buffer.from(data,'base64'));
console.log('saved');
ws.close();process.exit(0);
