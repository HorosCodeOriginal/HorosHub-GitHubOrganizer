const http = require('http'), fs = require('fs'), path = require('path');
const PORT = +process.argv[2] || 9355;
function list() { return new Promise((res, rej) => { http.get({ host: '127.0.0.1', port: PORT, path: '/json/list' }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej); }); }
const EXPR = `(async()=>{const sizes=[16,24,32,48,64,128,256,512];const out={};for(const s of sizes){const svg=logoSVG('tile',s);const url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));const img=new Image();await new Promise((res,rej)=>{img.onload=res;img.onerror=rej;img.src=url;});const c=document.createElement('canvas');c.width=s;c.height=s;const ctx=c.getContext('2d');ctx.drawImage(img,0,0,s,s);URL.revokeObjectURL(url);const rgba=ctx.getImageData(0,0,s,s).data;let bin='';for(let i=0;i<rgba.length;i+=8192){bin+=String.fromCharCode.apply(null,rgba.subarray(i,i+8192));}out[s]={png:c.toDataURL('image/png'),rgba:btoa(bin)};}return JSON.stringify(out);})()`;
(async () => {
  let pages = []; for (let i = 0; i < 60; i++) { try { pages = await list(); if (pages.length) break; } catch (e) {} await new Promise(r => setTimeout(r, 400)); }
  const p = pages.find(x => x.type === 'page'); if (!p) { console.log('NO PAGE'); process.exit(1); }
  const ws = new WebSocket(p.webSocketDebuggerUrl); let id = 0; const pend = {};
  const send = (m, params = {}) => new Promise(res => { const i = ++id; pend[i] = res; ws.send(JSON.stringify({ id: i, method: m, params })); });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; } };
  await new Promise(r => ws.onopen = r);
  await send('Runtime.enable');
  const r = await send('Runtime.evaluate', { expression: EXPR, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) { console.log('EVAL ERR', JSON.stringify(r.result.exceptionDetails)); process.exit(1); }
  const map = JSON.parse(r.result.result.value);
  fs.writeFileSync(path.join(__dirname, 'icon-sources.json'), JSON.stringify(map));
  console.log('icon-sources written (png+rgba) sizes:', Object.keys(map).join(','));
  ws.close(); process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });