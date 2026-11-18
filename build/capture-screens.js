// Captures real app screenshots via Electron CDP.
// Usage: node build/capture-screens.js <outDir> [port]
const fs = require('fs');
const path = require('path');
const outDir = process.argv[2] || 'screenshots';
const port = process.argv[3] || '9222';
fs.mkdirSync(outDir, { recursive: true });

const shots = [
  ['01-dashboard', "showView('dashboard')"],
  ['02-repositories', "showView('repos')"],
  ['03-clone', "showView('clone')"],
  ['04-analytics', "showView('analytics')"],
  ['05-settings', "showView('settings')"],
  ['07-repo-detail', "openRepo(S.repos[0].name)"],
  ['06-onboarding', "showView('dashboard');openOnboarding()"],
];

(async () => {
  const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await evalJs("(()=>{const ts=document.getElementById('themeSelect');if(ts){ts.value='dark';ts.dispatchEvent(new Event('change',{bubbles:true}));}return document.documentElement.getAttribute('data-theme');})()");
  await wait(500);

  for (const [name, expr] of shots) {
    await evalJs(expr);
    await wait(900);
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(outDir, name + '.png');
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log('saved', file, (fs.statSync(file).size / 1024).toFixed(0) + 'KB');
    if (name === '06-onboarding') { await evalJs("(()=>{const c=document.getElementById('obCancel');if(c)c.click();return true;})()"); await wait(300); }
  }
  await send('Emulation.clearDeviceMetricsOverride');
  ws.close();
  console.log('done');
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });