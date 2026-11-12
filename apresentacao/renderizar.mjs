// Gera o vídeo da apresentação (MP4, 1920x1080, com narração) a partir de video.html, sem ffmpeg:
// o Chrome/Edge desenha cada quadro, codifica em H.264 e mixa o áudio em AAC.
//
//   node apresentacao/renderizar.mjs                    -> apresentacao/nails-apresentacao.mp4
//   node apresentacao/renderizar.mjs --ate 8            -> só os primeiros 8 s (teste rápido)
//   node apresentacao/renderizar.mjs --sem-audio        -> vídeo mudo
//   node apresentacao/renderizar.mjs --previa 2,10,30   -> só salva esses instantes (s) em apresentacao/_previa/
//   node apresentacao/renderizar.mjs --conferir         -> abre o MP4 pronto, salva quadros dele e mede o áudio
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DIR, 'nails-apresentacao.mp4');
const PREVIA = path.join(DIR, '_previa');
const W = 1920, H = 1080, FPS = 30, BITRATE = 3_500_000;
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? null : (process.argv[i + 1] ?? ''); };
const has = name => process.argv.includes(name);

// ------------------------------------------------------------ servidor local (só para esta renderização)
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.mp4': 'video/mp4',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg' };
let currentFrame = null, uploaded = null;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/frame') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(currentFrame); }
  if (url.pathname === '/vazio') { res.writeHead(200, { 'Content-Type': MIME['.html'] }); return res.end('<!doctype html><meta charset="utf-8"><body>'); }
  if (url.pathname === '/upload' && req.method === 'POST') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    uploaded = Buffer.concat(chunks);
    res.writeHead(200); return res.end('ok');
  }
  const file = path.join(DIR, path.normalize(decodeURIComponent(url.pathname)));
  if (!file.startsWith(DIR)) { res.writeHead(403); return res.end(); }
  try {
    const data = await readFile(file);
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || ''); // o player de vídeo pede por faixas
    if (range) {
      const start = +range[1], end = range[2] ? +range[2] : data.length - 1;
      res.writeHead(206, { 'Content-Type': MIME[path.extname(file)], 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
      return res.end(data.subarray(start, end + 1));
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': data.length });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const browser = await launch({ width: W, height: H });
try {
  if (arg('--conferir') !== null) await conferir();
  else await render();
} finally {
  await browser.close();
  server.close();
}

async function openStage() {
  const page = await browser.newPage();
  await page.viewport(W, H, 1);
  await page.goto(`${BASE}/video.html?render`);
  const info = await page.run(() => window.pronto);
  return { page, info };
}

async function render() {
  const { page, info } = await openStage();
  console.log(`Duração: ${info.duracao.toFixed(1)} s ·`, info.cenas.map(c => `${c.id} ${c.inicio}s`).join(' | '));

  const previa = arg('--previa');
  if (previa !== null) {
    mkdirSync(PREVIA, { recursive: true });
    for (const t of previa.split(',').map(Number)) {
      await page.run(t => window.irPara(t), t);
      writeFileSync(path.join(PREVIA, `t${t.toFixed(1).padStart(5, '0')}.png`), await page.screenshot('png'));
    }
    return console.log('Prévias salvas em', PREVIA);
  }

  // O codificador roda na MESMA aba do palco. (Numa segunda aba, o navegador põe a primeira em
  // segundo plano e ela passa a desenhar um quadro por segundo, ou menos.)
  await page.cmd('Runtime.evaluate', { expression: await readFile(path.join(DIR, 'codificador.js'), 'utf8') });
  const codec = await page.run((w, h, fps, br) => iniciar(w, h, fps, br), W, H, FPS, BITRATE);
  const ate = Math.min(Number(arg('--ate')) || info.duracao, info.duracao); // --ate 8: só os primeiros 8 s
  const total = Math.round(ate * FPS);

  // Áudio: narração (se narrar.mjs já foi rodado) + música de fundo opcional em narracao/musica.*
  if (!has('--sem-audio') && info.falas.length) {
    const musica = ['mp3', 'm4a', 'wav', 'ogg'].map(e => `narracao/musica.${e}`).find(f => existsSync(path.join(DIR, f)));
    const falas = info.falas.filter(f => f.t < ate).map(f => ({ ...f, dur: Math.min(f.dur, ate - f.t) }));
    const a = await page.run((falas, dur, musica) => prepararAudio(falas, dur, musica), falas, ate, musica ? '/' + musica : null);
    console.log(`Áudio: ${falas.length} falas${musica ? ' + música de fundo' : ''} · ${a.segundos.toFixed(1)} s em AAC`);
  } else console.log('Áudio: nenhum (vídeo mudo)');

  console.log(`Codificando ${total} quadros em ${codec}...`);
  let lastSig = null, captured = 0;
  const t0 = Date.now();
  for (let i = 0; i < total; i++) {
    const sig = await page.run(t => window.irPara(t), i / FPS);
    const changed = sig !== lastSig; // quadros idênticos reaproveitam a captura anterior
    if (changed) { currentFrame = await page.screenshot('png'); lastSig = sig; captured++; }
    await page.run((i, novo) => quadro(i, novo), i, changed);
    if (i % 300 === 299 || i === total - 1) console.log(`  ${Math.round((i + 1) / total * 100)}%  (${i + 1} quadros, ${captured} capturas, ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }
  const r = await page.run(() => finalizar());
  writeFileSync(OUT, uploaded);
  console.log(`Pronto: ${OUT}\n  ${(r.bytes / 1e6).toFixed(1)} MB · ${r.quadros} quadros (${r.chave} chave) · ${(r.quadros / FPS).toFixed(1)} s · ${r.codec} · ${r.audio ? 'com áudio' : 'sem áudio'}`);
}

/** Abre o MP4 gerado: confere duração e tamanho, salva alguns quadros e mede onde há som. */
async function conferir() {
  if (!existsSync(OUT)) throw new Error('Gere o vídeo antes.');
  mkdirSync(PREVIA, { recursive: true });
  const page = await browser.newPage();
  await page.viewport(W, H, 1);
  await page.goto(`${BASE}/vazio`);
  const meta = await page.run(async file => {
    document.body.style.cssText = 'margin:0;background:#000';
    const v = document.createElement('video');
    v.muted = true; v.src = file; v.style.cssText = 'width:1920px;height:1080px;display:block';
    document.body.append(v);
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('O navegador não conseguiu abrir o MP4: ' + (v.error?.message || ''))); });
    window.v = v;
    const out = { duracao: v.duration, largura: v.videoWidth, altura: v.videoHeight };
    try { // decodifica a trilha de áudio e mede o volume segundo a segundo
      const buf = await new AudioContext().decodeAudioData(await (await fetch(file)).arrayBuffer());
      const d = buf.getChannelData(0), sr = buf.sampleRate;
      let pico = 0, mapa = '';
      for (let s = 0; s * sr < d.length; s++) {
        let sum = 0, n = 0;
        for (let i = s * sr; i < Math.min(d.length, (s + 1) * sr); i++) { sum += d[i] * d[i]; n++; pico = Math.max(pico, Math.abs(d[i])); }
        mapa += Math.sqrt(sum / n) > 0.01 ? '#' : '.';
      }
      out.audio = { segundos: +buf.duration.toFixed(1), canais: buf.numberOfChannels, taxa: sr, pico: +pico.toFixed(2), mapa };
    } catch (e) { out.audio = 'sem trilha de áudio decodificável: ' + e.message; }
    return out;
  }, '/nails-apresentacao.mp4');
  const { audio, ...video } = meta;
  console.log('MP4:', video, `· ${(statSync(OUT).size / 1e6).toFixed(1)} MB`);
  if (typeof audio === 'string') console.log('Áudio:', audio);
  else console.log(`Áudio: ${audio.segundos} s · ${audio.canais} canais · ${audio.taxa} Hz · pico ${audio.pico}\n  som por segundo (# = fala, . = silêncio):\n  ${audio.mapa}`);
  const times = (arg('--conferir') || '').split(',').filter(Boolean).map(Number);
  for (const t of times.length ? times : [1, meta.duracao / 2, meta.duracao - 0.5]) {
    await page.run(t => new Promise(res => { v.onseeked = () => requestAnimationFrame(() => requestAnimationFrame(res)); v.currentTime = t; }), t);
    writeFileSync(path.join(PREVIA, `mp4-${t.toFixed(1).padStart(5, '0')}.png`), await page.screenshot('png'));
  }
  console.log('Quadros do MP4 salvos em', PREVIA);
}
