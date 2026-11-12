// Controle mínimo do Chrome/Edge em modo headless pelo protocolo DevTools (sem dependências).
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BROWSERS = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function launch({ width = 1920, height = 1080 } = {}) {
  const exe = BROWSERS.find(p => existsSync(p));
  if (!exe) throw new Error('Chrome ou Edge não encontrado. Defina CHROME_PATH.');
  const profile = mkdtempSync(path.join(os.tmpdir(), 'estudio-video-'));
  const proc = spawn(exe, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--window-size=${width},${height}`,
    '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
    '--force-color-profile=srgb',
    // sem isto o navegador "adormece" abas em segundo plano e a renderização quase para
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    ...(process.env.CHROME_ARGS ? process.env.CHROME_ARGS.split(' ') : []),
    'about:blank',
  ], { stdio: 'ignore' });

  // O navegador escreve a porta escolhida neste arquivo
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 150 && !existsSync(portFile); i++) await sleep(100);
  if (!existsSync(portFile)) { proc.kill(); throw new Error('O navegador não iniciou.'); }
  const [port, wsPath] = readFileSync(portFile, 'utf8').trim().split(/\r?\n/);

  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('Falha ao conectar no navegador')); });

  let nextId = 0;
  const pending = new Map();
  const waiters = []; // { method, sessionId, resolve }
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`)); else p.resolve(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') console.error('  [página] erro:', m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') console.error('  [página] console.error:', m.params.args.map(a => a.value ?? a.description).join(' '));
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].method === m.method && waiters[i].sessionId === m.sessionId) waiters.splice(i, 1)[0].resolve(m.params);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject, method });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

  async function newPage() {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const cmd = (method, params) => send(method, params, sessionId);
    await cmd('Page.enable');
    await cmd('Runtime.enable');
    return {
      cmd,
      async goto(url) {
        const loaded = new Promise(resolve => waiters.push({ method: 'Page.loadEventFired', sessionId, resolve }));
        await cmd('Page.navigate', { url });
        await loaded;
      },
      /** Executa uma função (pode ser async) dentro da página e devolve o resultado. */
      async run(fn, ...args) {
        const r = await cmd('Runtime.evaluate', {
          expression: `(${fn})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true,
        });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
      },
      viewport: (w, h, dpr = 1, mobile = false) =>
        cmd('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile }),
      async screenshot(format = 'png', quality) {
        const r = await cmd('Page.captureScreenshot', { format, ...(quality ? { quality } : {}) });
        return Buffer.from(r.data, 'base64');
      },
    };
  }

  async function close() {
    try { await send('Browser.close'); } catch {}
    await sleep(300);
    try { proc.kill(); } catch {}
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }

  return { newPage, close, exe };
}
