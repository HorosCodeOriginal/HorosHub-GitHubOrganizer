// Usage: node build/cdp-check.js <port> "<js-expression>"
// Evaluates an expression in the first Electron page target via CDP and prints the value.
const port = process.argv[2] || '9222';
const expr = process.argv[3] || 'document.title';
(async () => {
  const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) { console.error('NO_PAGE'); process.exit(2); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const done = new Promise((res, rej) => {
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === 1) {
        if (m.result && m.result.exceptionDetails) rej(new Error(JSON.stringify(m.result.exceptionDetails)));
        else res(m.result.result.value);
        ws.close();
      }
    };
    setTimeout(() => rej(new Error('CDP timeout')), 120000);
  });
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  console.log(await done);
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });