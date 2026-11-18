/* HorosHub — lokaler Backend-Server (Node >= 18, keine Dependencies) */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');

const ROOT = __dirname;
const PORT = 4676;
const RUN_DIR = process.env.HOROS_RUNTIME_DIR || path.join(ROOT, '.horoshub');
const TOKEN_FILE = path.join(RUN_DIR, 'token');
const CONFIG_FILE = path.join(RUN_DIR, 'config.json');
const STATE_FILE = path.join(RUN_DIR, 'state.json');
const GH = 'https://api.github.com';

fs.mkdirSync(RUN_DIR, { recursive: true });

let token = fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : '';
let config = Object.assign({
  login: '',
  cloneDir: path.join(os.homedir(), 'HorosHub', 'Repos'),
  backupDir: path.join(os.homedir(), 'HorosHub', 'Backups'),
  autoBackup: true,
  backupTime: '03:00',
  weeklyMirror: true,
  gitName: '',
  gitEmail: ''
}, readJSON(CONFIG_FILE, {}));
let state = Object.assign({ lastDaily: '', lastWeekly: '' }, readJSON(STATE_FILE, {}));
const jobs = new Map();

function readJSON(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } }
function saveConfig() { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); }
function saveState() { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
function send(res, code, obj, headers) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {}));
  res.end(body);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > (limit || 60 * 1024 * 1024)) { reject(new Error('Payload zu groß')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('Ungültiges JSON')); } });
    req.on('error', reject);
  });
}
async function gh(method, p, body, accept) {
  const headers = { 'User-Agent': 'HorosHub', 'Accept': accept || 'application/vnd.github+json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(GH + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { status: r.status, data, headers: r.headers };
}
function git(args, opts) {
  return new Promise(resolve => {
    const child = spawn('git', args, Object.assign({ cwd: ROOT, windowsHide: true }, opts || {}));
    let out = '', err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', e => resolve({ code: -1, out, err: String(e.message) }));
    child.on('close', code => resolve({ code, out, err }));
    return child;
  });
}
function gitStream(args, onLine, opts) {
  const child = spawn('git', args, Object.assign({ cwd: ROOT, windowsHide: true }, opts || {}));
  let buf = '';
  const feed = d => { buf += d.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); onLine(line.replace(/\r/g, '')); } };
  child.stdout.on('data', feed); child.stderr.on('data', feed);
  child.on('error', e => onLine('ERROR ' + e.message));
  return child;
}
function walkSize(dir, cap) {
  let total = 0, count = 0;
  const stack = [dir];
  while (stack.length && count < (cap || 200000)) {
    const d = stack.pop();
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
    for (const en of entries) {
      count++;
      const p = path.join(d, en.name);
      if (en.isDirectory()) stack.push(p);
      else { try { total += fs.statSync(p).size; } catch (e) {} }
    }
  }
  return total;
}
function newJob(kind, label, meta) {
  const id = crypto.randomBytes(6).toString('hex');
  const j = { id, kind, label, status: 'running', progress: 0, log: [], error: '', started: Date.now(), finished: 0, meta: meta || {} };
  jobs.set(id, j);
  return j;
}
function jlog(j, line) { j.log.push(line); if (j.log.length > 400) j.log.shift(); }
function jdone(j, ok, err) { j.status = ok ? 'done' : 'error'; j.progress = ok ? 100 : j.progress; j.error = err || ''; j.finished = Date.now(); }
function pct(line) { const m = line.match(/(\d{1,3})%/); return m ? Math.min(100, +m[1]) : null; }
function uniqueTarget(t) {
  if (!fs.existsSync(t)) return t;
  try { if (fs.readdirSync(t).length === 0) return t; } catch (e) {}
  for (let i = 2; i < 50; i++) { const c = t + '-' + i; if (!fs.existsSync(c)) return c; }
  return t + '-' + Date.now();
}
function safeRel(p) {
  const clean = String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.split('/').some(s => s === '..' || s === '' || /^[a-zA-Z]:$/.test(s))) throw new Error('Ungültiger Dateipfad: ' + p);
  return clean;
}

/* ---------- Jobs: Klonen ---------- */
function runClone(j, o) {
  const target = uniqueTarget(path.resolve(o.target));
  j.meta.target = target;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const args = ['clone', '--progress'];
  if (o.depth) args.push('--depth', '1');
  if (o.recurse) args.push('--recurse-submodules');
  args.push(o.url, target);
  jlog(j, '$ git ' + args.join(' '));
  const child = gitStream(args, line => {
    if (!line.trim()) return;
    jlog(j, line);
    const p = pct(line); if (p !== null) j.progress = Math.max(j.progress, p * 0.95);
  });
  j.meta.child = child;
  child.on('close', code => {
    j.meta.child = null;
    if (j.status === 'cancelled') return;
    if (code === 0) {
      j.meta.bytes = walkSize(target);
      jdone(j, true);
      jlog(j, 'Fertig: ' + target);
      if (o.openAfter && process.platform === 'win32') spawn('explorer.exe', [target], { detached: true, windowsHide: true }).unref();
    } else jdone(j, false, 'git clone endete mit Code ' + code);
  });
}

/* ---------- Jobs: Upload (echtes Repo + Push) ---------- */
async function runUpload(j, o) {
  try {
    if (!token) throw new Error('Kein Token hinterlegt – Upload benötigt Schreibzugriff.');
    j.progress = 5; jlog(j, 'Erstelle Repository ' + o.name + ' …');
    const cr = await gh('POST', '/user/repos', { name: o.name, description: o.desc || '', private: !!o.private, auto_init: false });
    if (cr.status !== 201) throw new Error('GitHub: ' + cr.status + ' ' + JSON.stringify(cr.data && cr.data.message || cr.data));
    const full = cr.data.full_name;
    j.meta.full = full;
    j.progress = 15;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'horoshub-up-'));
    j.meta.tmp = tmp;
    for (const f of o.files) {
      const rel = safeRel(f.path);
      const dest = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(f.b64, 'base64'));
    }
    jlog(j, o.files.length + ' Dateien geschrieben');
    j.progress = 30;
    const ident = ['-c', 'user.name=' + (config.gitName || 'HorosHub'), '-c', 'user.email=' + (config.gitEmail || 'horoshub@local')];
    let r = await git(['init', '-b', 'main'], { cwd: tmp }); jlog(j, r.out + r.err);
    if (r.code !== 0) throw new Error('git init fehlgeschlagen');
    j.progress = 40;
    r = await git(['add', '-A'], { cwd: tmp });
    j.progress = 50;
    r = await git(ident.concat(['commit', '-m', o.message || 'Initial upload via HorosHub']), { cwd: tmp });
    jlog(j, r.out.trim());
    if (r.code !== 0) throw new Error('git commit fehlgeschlagen: ' + r.err);
    j.progress = 60;
    const pushUrl = 'https://' + token + '@github.com/' + full + '.git';
    jlog(j, '$ git push … main');
    await new Promise((resolve, reject) => {
      const child = gitStream(['push', '--progress', pushUrl, 'main'], line => {
        if (!line.trim()) return;
        jlog(j, line.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '***'));
        const p = pct(line); if (p !== null) j.progress = Math.max(j.progress, 60 + p * 0.35);
      }, { cwd: tmp });
      j.meta.child = child;
      child.on('close', code => { j.meta.child = null; code === 0 ? resolve() : reject(new Error('git push endete mit Code ' + code)); });
    });
    fs.rmSync(tmp, { recursive: true, force: true });
    j.meta.tmp = null;
    j.meta.url = cr.data.html_url;
    jdone(j, true);
    jlog(j, 'Gepusht: ' + cr.data.html_url);
  } catch (e) {
    if (j.meta.tmp) fs.rmSync(j.meta.tmp, { recursive: true, force: true });
    jdone(j, false, e.message);
  }
}

/* ---------- Jobs: Backup / Mirror ---------- */
async function runBackup(j, o) {
  try {
    const dir = path.resolve(o.dir);
    fs.mkdirSync(dir, { recursive: true });
    const list = o.fulls;
    for (let i = 0; i < list.length; i++) {
      if (j.status === 'cancelled') return;
      const full = list[i];
      const name = full.split('/').pop();
      const target = path.join(dir, name + '.git');
      j.meta.current = full;
      jlog(j, '[' + (i + 1) + '/' + list.length + '] ' + full);
      const base = i / list.length * 100;
      const span = 100 / list.length;
      const url = 'https://github.com/' + full + '.git';
      const exists = fs.existsSync(target);
      const args = exists ? ['--git-dir=' + target, 'remote', 'update', '--prune'] : ['clone', '--mirror', '--progress', url, target];
      await new Promise((resolve, reject) => {
        const child = gitStream(args, line => {
          if (!line.trim()) return;
          jlog(j, line);
          const p = pct(line); if (p !== null) j.progress = Math.max(j.progress, base + p / 100 * span);
        });
        j.meta.child = child;
        child.on('close', code => { j.meta.child = null; code === 0 ? resolve() : reject(new Error(full + ': git endete mit Code ' + code)); });
      });
      j.progress = base + span;
    }
    j.meta.bytes = walkSize(dir, 400000);
    state.lastDaily = new Date().toISOString().slice(0, 10);
    if (new Date().getDay() === 0) state.lastWeekly = state.lastDaily;
    saveState();
    jdone(j, true);
    jlog(j, 'Backup abgeschlossen: ' + dir);
  } catch (e) { jdone(j, false, e.message); }
}

/* ---------- Zeitplan ---------- */
setInterval(async () => {
  const now = new Date();
  const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  const today = now.toISOString().slice(0, 10);
  const running = [...jobs.values()].some(j => j.kind === 'backup' && j.status === 'running');
  if (running) return;
  let fulls = null;
  const need = async () => {
    if (fulls) return fulls;
    const r = token ? await gh('GET', '/user/repos?per_page=100&affiliation=owner') : await gh('GET', '/users/' + config.login + '/repos?per_page=100');
    fulls = Array.isArray(r.data) ? r.data.map(x => x.full_name) : [];
    return fulls;
  };
  if (config.autoBackup && hhmm === config.backupTime && state.lastDaily !== today) {
    const j = newJob('backup', 'Tägliches Backup', { auto: true });
    runBackup(j, { fulls: await need(), dir: config.backupDir });
  } else if (config.weeklyMirror && now.getDay() === 0 && hhmm === '02:00' && state.lastWeekly !== today) {
    const j = newJob('backup', 'Wöchentliches Voll-Mirror', { auto: true });
    runBackup(j, { fulls: await need(), dir: config.backupDir });
  }
}, 20000);

/* ---------- HTTP ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  try {
    if (p.startsWith('/api/')) {
      /* Status */
      if (p === '/api/status' && req.method === 'GET') {
        const g = await git(['--version']);
        return send(res, 200, { backend: true, version: '1.0.0', git: g.code === 0 ? g.out.trim() : null, tokenSet: !!token, login: config.login, firstRun: !token && !config.login, config, state, jobs: [...jobs.values()].filter(j => j.status === 'running').length });
      }
      /* Token */
      if (p === '/api/token' && req.method === 'POST') {
        const b = await readBody(req, 1024 * 64);
        const t = String(b.token || '').trim();
        if (!t) return send(res, 400, { error: 'Token leer' });
        const r = await fetch(GH + '/user', { headers: { 'User-Agent': 'HorosHub', 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + t } });
        if (!r.ok) return send(res, 401, { error: 'Token ungültig (HTTP ' + r.status + ')' });
        const user = await r.json();
        token = t; config.login = user.login;
        if (b.persist) fs.writeFileSync(TOKEN_FILE, t); else if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
        saveConfig();
        return send(res, 200, { ok: true, login: user.login, scopes: r.headers.get('x-oauth-scopes') || 'fine-grained', persisted: !!b.persist });
      }
      if (p === '/api/token' && req.method === 'DELETE') {
        token = ''; if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
        config.login = ''; saveConfig();
        return send(res, 200, { ok: true });
      }
      /* Öffentlichen Account verbinden (ohne Token) */
      if (p === '/api/account' && req.method === 'POST') {
        const b = await readBody(req, 1024 * 8);
        const login = String(b.login || '').trim().replace(/^@/, '');
        if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) return send(res, 400, { error: 'Ungültiger GitHub-Benutzername' });
        const r = await gh('GET', '/users/' + login);
        if (r.status === 404) return send(res, 404, { error: 'Benutzer „' + login + '" nicht gefunden' });
        if (r.status !== 200) return send(res, 502, { error: 'GitHub-Abfrage fehlgeschlagen (HTTP ' + r.status + ')' });
        config.login = login; saveConfig();
        return send(res, 200, { ok: true, login, name: r.data.name || login, avatar: r.data.avatar_url || '' });
      }
      /* Config / Git-Identität */
      if (p === '/api/config' && req.method === 'GET') return send(res, 200, config);
      if (p === '/api/config' && req.method === 'POST') {
        const b = await readBody(req, 1024 * 64);
        for (const k of ['cloneDir', 'backupDir', 'autoBackup', 'backupTime', 'weeklyMirror', 'gitName', 'gitEmail', 'login']) if (k in b) config[k] = b[k];
        saveConfig();
        return send(res, 200, config);
      }
      if (p === '/api/gitconfig' && req.method === 'GET') {
        const n = await git(['config', '--global', 'user.name']);
        const e = await git(['config', '--global', 'user.email']);
        return send(res, 200, { name: n.out.trim(), email: e.out.trim() });
      }
      if (p === '/api/gitconfig' && req.method === 'POST') {
        const b = await readBody(req, 1024 * 64);
        if (b.name) await git(['config', '--global', 'user.name', String(b.name)]);
        if (b.email) await git(['config', '--global', 'user.email', String(b.email)]);
        config.gitName = b.name || config.gitName; config.gitEmail = b.email || config.gitEmail; saveConfig();
        return send(res, 200, { ok: true });
      }
      /* GitHub-Proxy */
      if (p.startsWith('/api/gh/')) {
        const gp = '/' + p.slice('/api/gh/'.length) + (u.search || '');
        const body = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req, 20 * 1024 * 1024) : undefined;
        const accept = req.headers['accept'] && req.headers['accept'] !== '*/*' ? req.headers['accept'] : undefined;
        const r = await gh(req.method, gp, body && Object.keys(body).length ? body : (req.method === 'PUT' || req.method === 'PATCH' ? body : undefined), accept);
        const h = {};
        for (const k of ['x-ratelimit-remaining', 'x-ratelimit-limit', 'x-oauth-scopes']) if (r.headers.get(k)) h[k] = r.headers.get(k);
        return send(res, r.status, r.data === null ? { ok: r.status < 300 } : r.data, h);
      }
      /* Dateisystem */
      if (p === '/api/fs/size' && req.method === 'GET') {
        const dir = u.searchParams.get('path') || config.cloneDir;
        return send(res, 200, { bytes: fs.existsSync(dir) ? walkSize(dir) : 0 });
      }
      if (p === '/api/fs/exists' && req.method === 'GET') {
        const dir = u.searchParams.get('path') || '';
        return send(res, 200, { exists: fs.existsSync(dir) });
      }
      if (p === '/api/open' && req.method === 'POST') {
        const b = await readBody(req, 1024 * 8);
        const target = String(b.path || '');
        if (!target || !fs.existsSync(target)) return send(res, 400, { error: 'Pfad existiert nicht' });
        const dir = fs.statSync(target).isDirectory() ? target : path.dirname(target);
        const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
        try { spawn(cmd, [dir], { detached: true, stdio: 'ignore' }).unref(); } catch (e) { return send(res, 500, { error: String(e.message || e) }); }
        return send(res, 200, { opened: dir });
      }
      /* Jobs */
      if (p === '/api/clone' && req.method === 'POST') {
        const b = await readBody(req, 1024 * 64);
        if (!b.url) return send(res, 400, { error: 'url fehlt' });
        const j = newJob('clone', b.label || b.url, {});
        runClone(j, { url: b.url, target: b.target || path.join(config.cloneDir, (b.label || 'repo')), depth: !!b.depth, recurse: !!b.recurse, openAfter: !!b.openAfter });
        return send(res, 200, { id: j.id });
      }
      if (p === '/api/upload' && req.method === 'POST') {
        const b = await readBody(req, 60 * 1024 * 1024);
        if (!b.name || !Array.isArray(b.files) || !b.files.length) return send(res, 400, { error: 'name/files fehlen' });
        if (b.files.length > 400) return send(res, 400, { error: 'Maximal 400 Dateien pro Upload' });
        const j = newJob('upload', b.name, {});
        runUpload(j, b);
        return send(res, 200, { id: j.id });
      }
      if (p === '/api/backup' && req.method === 'POST') {
        const b = await readBody(req, 1024 * 128);
        let fulls = b.fulls;
        if (!fulls || !fulls.length) {
          const r = token ? await gh('GET', '/user/repos?per_page=100&affiliation=owner') : await gh('GET', '/users/' + config.login + '/repos?per_page=100');
          fulls = Array.isArray(r.data) ? r.data.map(x => x.full_name) : [];
        }
        if (!fulls.length) return send(res, 400, { error: 'Keine Repositories gefunden' });
        const j = newJob('backup', 'Backup (' + fulls.length + ' Repos)', {});
        runBackup(j, { fulls, dir: b.dir || config.backupDir });
        return send(res, 200, { id: j.id, count: fulls.length });
      }
      if (p === '/api/jobs' && req.method === 'GET') {
        return send(res, 200, [...jobs.values()].map(publicJob).sort((a, b) => b.started - a.started).slice(0, 60));
      }
      const jm = p.match(/^\/api\/jobs\/([a-f0-9]+)(\/cancel)?$/);
      if (jm) {
        const j = jobs.get(jm[1]);
        if (!j) return send(res, 404, { error: 'Job unbekannt' });
        if (jm[2] && req.method === 'POST') {
          if (j.status === 'running') { j.status = 'cancelled'; j.finished = Date.now(); if (j.meta.child) j.meta.child.kill('SIGTERM'); if (j.meta.tmp) fs.rmSync(j.meta.tmp, { recursive: true, force: true }); }
          return send(res, 200, publicJob(j));
        }
        if (req.method === 'GET') return send(res, 200, publicJob(j));
        if (req.method === 'DELETE') { jobs.delete(jm[1]); return send(res, 200, { ok: true }); }
      }
      return send(res, 404, { error: 'Unbekannter API-Pfad' });
    }
    /* Statische Dateien */
    let file = p === '/' ? '/index.html' : p;
    const abs = path.normalize(path.join(ROOT, file));
    if (!abs.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { res.writeHead(404); return res.end('Nicht gefunden'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(abs).pipe(res);
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});
function publicJob(j) {
  return { id: j.id, kind: j.kind, label: j.label, status: j.status, progress: Math.round(j.progress), error: j.error, started: j.started, finished: j.finished, log: j.log.slice(-14), meta: { target: j.meta.target, full: j.meta.full, url: j.meta.url, bytes: j.meta.bytes, current: j.meta.current, auto: j.meta.auto } };
}
server.listen(PORT, '127.0.0.1', () => {
  console.log('HorosHub läuft auf http://127.0.0.1:' + PORT);
  console.log('Token: ' + (token ? 'geladen' : 'nicht gesetzt') + ' · Git-Identität: ' + config.gitName);
  if (process.platform === 'win32' && !process.env.HOROS_NO_OPEN) spawn('cmd', ['/c', 'start', '', 'http://127.0.0.1:' + PORT], { detached: true, windowsHide: true }).unref();
});