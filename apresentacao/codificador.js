// Roda dentro da página do vídeo, a pedido do renderizador: recebe os quadros, codifica em H.264,
// mixa a narração, codifica em AAC e monta o arquivo MP4. Usa só APIs do navegador (WebCodecs e
// Web Audio); não precisa de ffmpeg nem de bibliotecas.
let enc, cfg, fps, failure = null, last = null, avcC = null, color = null;
const samples = []; // quadros de vídeo codificados: { data: Uint8Array, key: bool, ts }
let audio = null;   // { sampleRate, channels, samples: [Uint8Array], asc, pico }

async function iniciar(width, height, framesPerSecond, bitrate) {
  fps = framesPerSecond;
  const base = { width, height, framerate: fps, bitrate, bitrateMode: 'variable', latencyMode: 'quality', avc: { format: 'avc' } };
  // Só codificador por software: não gera quadros B, então a ordem de exibição é a ordem do arquivo.
  for (const codec of ['avc1.640028', 'avc1.4d0028', 'avc1.42e028', 'avc1.420028']) {
    const c = { ...base, codec, hardwareAcceleration: 'prefer-software' };
    if ((await VideoEncoder.isConfigSupported(c)).supported) { cfg = c; break; }
  }
  if (!cfg) throw new Error('Este navegador não codifica H.264 em 1080p.');
  enc = new VideoEncoder({
    output(chunk, meta) {
      const d = meta?.decoderConfig;
      if (d?.description) { avcC = new Uint8Array(d.description.buffer ?? d.description).slice(); color = d.colorSpace ?? color; }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({ data, key: chunk.type === 'key', ts: chunk.timestamp });
    },
    error(e) { failure = e; },
  });
  enc.configure(cfg);
  return cfg.codec;
}

/** Quadro i. `novo` = há imagem nova em /frame; senão repete a anterior (trecho parado do vídeo). */
async function quadro(i, novo) {
  if (failure) throw failure;
  if (novo || !last) {
    const blob = await (await fetch('/frame?i=' + i, { cache: 'no-store' })).blob();
    last?.close();
    last = await createImageBitmap(blob);
  }
  const frame = new VideoFrame(last, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
  enc.encode(frame, { keyFrame: i % (fps * 2) === 0 });
  frame.close();
  while (enc.encodeQueueSize > 3) await new Promise(r => enc.addEventListener('dequeue', r, { once: true }));
}

/**
 * Monta a trilha de áudio: cada fala entra no seu instante; uma música de fundo (opcional) toca
 * baixinho por baixo. Depois codifica em AAC.
 * falas: [{ url, t, ini, dur }]  (t = instante no vídeo; ini/dur = trecho falado dentro do arquivo)
 */
async function prepararAudio(falas, duracao, musicaUrl) {
  const SR = 48000, CH = 2;
  const total = Math.ceil(duracao * SR);
  const ctx = new OfflineAudioContext(CH, total, SR);
  const voz = ctx.createGain();
  voz.connect(ctx.destination);
  for (const f of falas) {
    const src = ctx.createBufferSource();
    src.buffer = await ctx.decodeAudioData(await (await fetch(f.url)).arrayBuffer());
    const g = ctx.createGain(); // entrada e saída suaves, para não dar estalo no corte do silêncio
    g.gain.setValueAtTime(0, f.t);
    g.gain.linearRampToValueAtTime(1, f.t + 0.02);
    g.gain.setValueAtTime(1, f.t + f.dur - 0.06);
    g.gain.linearRampToValueAtTime(0, f.t + f.dur);
    src.connect(g).connect(voz);
    src.start(f.t, f.ini, f.dur);
  }
  if (musicaUrl) {
    const src = ctx.createBufferSource();
    src.buffer = await ctx.decodeAudioData(await (await fetch(musicaUrl)).arrayBuffer());
    src.loop = true;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, 0);
    g.gain.linearRampToValueAtTime(0.14, 1.5);
    g.gain.setValueAtTime(0.14, Math.max(1.5, duracao - 2.5));
    g.gain.linearRampToValueAtTime(0, duracao);
    src.connect(g).connect(ctx.destination);
    src.start(0);
  }
  const mix = await ctx.startRendering();
  const canais = Array.from({ length: CH }, (_, c) => mix.getChannelData(c));

  // normaliza o volume: pico em -1,5 dB
  let pico = 0;
  for (const c of canais) for (let i = 0; i < c.length; i++) { const v = Math.abs(c[i]); if (v > pico) pico = v; }
  if (pico > 0) { const k = 0.84 / pico; for (const c of canais) for (let i = 0; i < c.length; i++) c[i] *= k; }

  const out = [];
  let asc = null, erro = null;
  const aenc = new AudioEncoder({
    output(chunk, meta) {
      const d = meta?.decoderConfig?.description;
      if (d) asc = new Uint8Array(d.buffer ?? d).slice();
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      out.push(data);
    },
    error(e) { erro = e; },
  });
  aenc.configure({ codec: 'mp4a.40.2', sampleRate: SR, numberOfChannels: CH, bitrate: 128000 });
  const BLOCO = 1024 * 16;
  for (let off = 0; off < total; off += BLOCO) {
    const n = Math.min(BLOCO, total - off);
    const planar = new Float32Array(n * CH);
    canais.forEach((c, ch) => planar.set(c.subarray(off, off + n), ch * n));
    const ad = new AudioData({ format: 'f32-planar', sampleRate: SR, numberOfFrames: n, numberOfChannels: CH, timestamp: Math.round(off / SR * 1e6), data: planar });
    aenc.encode(ad);
    ad.close();
  }
  await aenc.flush();
  aenc.close();
  if (erro) throw erro;
  if (!asc) throw new Error('O codificador de áudio não informou a configuração.');
  audio = { sampleRate: SR, channels: CH, samples: out, asc, pico };
  return { quadrosAac: out.length, segundos: out.length * 1024 / SR, picoOriginal: +pico.toFixed(3) };
}

async function finalizar() {
  await enc.flush();
  enc.close();
  if (failure) throw failure;
  if (!avcC) throw new Error('O codificador não informou a configuração do vídeo.');
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].ts <= samples[i - 1].ts) throw new Error('Quadros fora de ordem (o codificador gerou quadros B).');
  }
  const mp4 = montarMp4({ width: cfg.width, height: cfg.height, fps, samples, avcC, color }, audio);
  const r = await fetch('/upload', { method: 'POST', body: mp4 });
  if (!r.ok) throw new Error('Falha ao salvar o MP4');
  return { bytes: mp4.size, quadros: samples.length, chave: samples.filter(s => s.key).length, codec: cfg.codec, audio: !!audio };
}

// ---------------------------------------------------------------- montagem do MP4 (ISO BMFF)
const u16 = n => [n >>> 8 & 255, n & 255];
const u32 = n => [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255];
const ascii = s => [...s].map(c => c.charCodeAt(0));
const zeros = n => new Array(n).fill(0);
function box(type, ...parts) {
  const size = 8 + parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(size);
  out.set(u32(size), 0);
  out.set(ascii(type), 4);
  let o = 8;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const full = (type, version, flags, ...parts) => box(type, [version, flags >>> 16 & 255, flags >>> 8 & 255, flags & 255], ...parts);
const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].flatMap(u32);

function montarMp4(v, a) {
  const MOVIE_TS = 1000;
  const movieDur = Math.round(v.samples.length * 1000 / v.fps);

  // --- blocos ("chunks") de ~1 s, alternando vídeo e áudio, para o arquivo tocar bem em qualquer player
  const group = (list, per) => { const out = []; for (let i = 0; i < list.length; i += per) out.push(list.slice(i, i + per)); return out; };
  const vChunks = group(v.samples.map(s => s.data), v.fps);
  const aChunks = a ? group(a.samples, Math.round(a.sampleRate / 1024)) : [];
  const order = [], vOff = [], aOff = [];
  let pos = 0;
  for (let i = 0; i < Math.max(vChunks.length, aChunks.length); i++) {
    for (const [chunks, offs] of [[vChunks, vOff], [aChunks, aOff]]) {
      if (!chunks[i]) continue;
      offs.push(pos);
      for (const d of chunks[i]) { order.push(d); pos += d.length; }
    }
  }
  const dataSize = pos;

  /** Tabelas de amostras de uma trilha (stts/stsc/stsz/stco [+stss]). */
  const tables = (entry, chunks, offs, delta, keys, base) => {
    const sizes = chunks.flat().map(d => d.length);
    const runs = []; // stsc: uma entrada sempre que muda a quantidade de amostras por bloco
    chunks.forEach((c, i) => { if (!i || chunks[i - 1].length !== c.length) runs.push([i + 1, c.length, 1]); });
    return box('stbl',
      full('stsd', 0, 0, u32(1), entry),
      full('stts', 0, 0, u32(1), u32(sizes.length), u32(delta)),
      ...(keys ? [full('stss', 0, 0, u32(keys.length), keys.flatMap(u32))] : []),
      full('stsc', 0, 0, u32(runs.length), runs.flat().flatMap(u32)),
      full('stsz', 0, 0, u32(0), u32(sizes.length), sizes.flatMap(u32)),
      full('stco', 0, 0, u32(offs.length), offs.flatMap(o => u32(base + o))));
  };
  const dinf = () => box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1)));

  // --- trilha de vídeo
  const prim = { bt709: 1, bt470bg: 5, smpte170m: 6 }, trc = { bt709: 1, smpte170m: 6, 'iec61966-2-1': 13 }, mtx = { rgb: 0, bt709: 1, bt470bg: 5, smpte170m: 6 };
  const colr = v.color ? [box('colr', ascii('nclx'), u16(prim[v.color.primaries] ?? 1), u16(trc[v.color.transfer] ?? 1), u16(mtx[v.color.matrix] ?? 1), [v.color.fullRange ? 0x80 : 0])] : [];
  const avc1 = box('avc1',
    zeros(6), u16(1), zeros(16), u16(v.width), u16(v.height),
    u32(0x00480000), u32(0x00480000), zeros(4), u16(1), zeros(32), u16(0x0018), u16(0xffff),
    box('avcC', v.avcC), ...colr);
  const vKeys = v.samples.map((s, i) => s.key ? i + 1 : 0).filter(Boolean);
  const vTs = v.fps * 1000;
  const videoTrak = base => box('trak',
    full('tkhd', 0, 3, u32(0), u32(0), u32(1), zeros(4), u32(movieDur), zeros(8), u16(0), u16(0), u16(0), zeros(2), MATRIX, u32(v.width << 16), u32(v.height << 16)),
    box('mdia',
      full('mdhd', 0, 0, u32(0), u32(0), u32(vTs), u32(v.samples.length * 1000), u16(0x55c4), u16(0)),
      full('hdlr', 0, 0, u32(0), ascii('vide'), zeros(12), ascii('VideoHandler'), [0]),
      box('minf', full('vmhd', 0, 1, zeros(8)), dinf(), tables(avc1, vChunks, vOff, 1000, vKeys, base))));

  // --- trilha de áudio (AAC)
  const audioTrak = base => {
    const dsi = [0x05, a.asc.length, ...a.asc];
    const dcd = [0x04, 13 + dsi.length, 0x40, 0x15, 0, 0, 0, ...u32(128000), ...u32(128000), ...dsi];
    const esd = [0x03, 3 + dcd.length + 3, ...u16(2), 0, ...dcd, 0x06, 1, 0x02];
    const mp4a = box('mp4a', zeros(6), u16(1), zeros(8), u16(a.channels), u16(16), zeros(4), u32(a.sampleRate * 65536), full('esds', 0, 0, esd));
    const aDur = a.samples.length * 1024;
    return box('trak',
      full('tkhd', 0, 3, u32(0), u32(0), u32(2), zeros(4), u32(Math.round(aDur * MOVIE_TS / a.sampleRate)), zeros(8), u16(0), u16(1), u16(0x0100), zeros(2), MATRIX, u32(0), u32(0)),
      box('mdia',
        full('mdhd', 0, 0, u32(0), u32(0), u32(a.sampleRate), u32(aDur), u16(0x55c4), u16(0)),
        full('hdlr', 0, 0, u32(0), ascii('soun'), zeros(12), ascii('SoundHandler'), [0]),
        box('minf', full('smhd', 0, 0, zeros(4)), dinf(), tables(mp4a, aChunks, aOff, 1024, null, base))));
  };

  const moov = base => box('moov',
    full('mvhd', 0, 0, u32(0), u32(0), u32(MOVIE_TS), u32(movieDur), u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(a ? 3 : 2)),
    videoTrak(base), ...(a ? [audioTrak(base)] : []));

  const ftyp = box('ftyp', ascii('isom'), u32(0x200), ascii('isomiso2avc1mp41'));
  const base = ftyp.length + moov(0).length + 8; // onde começam os dados dentro do arquivo
  const mdatHeader = new Uint8Array([...u32(8 + dataSize), ...ascii('mdat')]);
  // ftyp + moov na frente (o vídeo começa a tocar antes de baixar inteiro), depois os dados
  return new Blob([ftyp, moov(base), mdatHeader, ...order], { type: 'video/mp4' });
}
