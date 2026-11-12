// Gera a narração do vídeo com as vozes em português já instaladas no Windows (sem internet).
//   node apresentacao/narrar.mjs                -> voz "Maria" (padrão)
//   node apresentacao/narrar.mjs --voz Daniel   -> voz masculina
//   node apresentacao/narrar.mjs --ritmo 1.2   -> fala mais rápida (padrão: 1.1)
// Saída: narracao/*.wav e narracao/narracao.js (lido por video.html e pelo renderizador).
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'narracao');
const arg = (name, def) => { const i = process.argv.indexOf(name); return i < 0 ? def : process.argv[i + 1]; };

// Falas por cena: [segundo dentro da cena em que a fala começa, texto].
// Cada fala é uma frase completa (frases cortadas ao meio soam artificiais na voz sintética).
const FALAS = {
  abertura: [
    [0.7, 'Seu estúdio de unhas com a agenda cheia, sem ficar presa ao WhatsApp.'],
  ],
  problema: [
    [0.3, 'Parece familiar?'],
    [2.3, 'Mensagens o dia todo, cliente que desiste em cima da hora, e a agenda no caderno.'],
    [8.8, 'Dá para resolver tudo isso em um só lugar.'],
  ],
  cliente: [
    [0.6, 'Com o agendamento online, a cliente resolve tudo pelo celular.'],
    [6.1, 'Escolhe o serviço, a profissional e o dia.'],
    [10.2, 'Só aparecem os horários realmente livres.'],
    [14.3, 'Em menos de um minuto, o horário está confirmado.'],
  ],
  fila: [
    [0.5, 'E se o horário já estiver ocupado?'],
    [3.3, 'Com um toque, a cliente entra na fila de espera.'],
    [7.4, 'Se o horário vagar, o agendamento é confirmado automaticamente.'],
  ],
  painel: [
    [0.5, 'No painel, você vê a agenda do dia, por profissional.'],
    [4.9, 'Vê o faturamento previsto e o que já foi faturado.'],
    [9.0, 'E marca cada atendimento com um clique.'],
  ],
  vaga: [
    [0.5, 'Alguém cancelou?'],
    [1.9, 'A fila de espera aparece no painel.'],
    [4.9, 'A próxima da fila entra no lugar, automaticamente.'],
    [9.2, 'E o aviso por WhatsApp já sai pronto para enviar.'],
  ],
  controle: [
    [0.6, 'Você define os serviços, os preços e a duração.'],
    [4.7, 'O expediente e o almoço de cada profissional.'],
    [8.8, 'E bloqueia folgas, feriados e férias.'],
  ],
  local: [
    [0.6, 'Endereço, horário de funcionamento, contato e mapa: tudo à mão da cliente.'],
  ],
  fim: [
    [0.7, 'Menos mensagens, menos horário vago, e mais clientes.'],
    [5.6, 'Agendamento online para nail designers.'],
  ],
};

mkdirSync(DIR, { recursive: true });
for (const f of readdirSync(DIR)) if (f.endsWith('.wav')) rmSync(path.join(DIR, f));

const itens = Object.entries(FALAS).flatMap(([cena, falas]) => falas.map(([at, texto], i) =>
  ({ cena, at, texto, arquivo: `narracao/${cena}-${i + 1}.wav`, caminho: path.join(DIR, `${cena}-${i + 1}.wav`) })));
const spec = path.join(DIR, '_spec.json');
writeFileSync(spec, JSON.stringify({ voz: arg('--voz', 'Maria'), ritmo: Number(arg('--ritmo', '1.1')), itens }), 'utf8');

// Síntese de voz do Windows (API WinRT), chamada pelo PowerShell
const ps = String.raw`
$ErrorActionPreference = 'Stop'
$spec = Get-Content -Raw -Encoding UTF8 $env:NARRACAO_SPEC | ConvertFrom-Json
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + '`' + String.raw`1' } | Select-Object -First 1
function Await($op, [Type]$type) { $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $task.Wait(); $task.Result }
$all = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
$voice = $all | Where-Object { $_.Language -eq 'pt-BR' -and $_.DisplayName -like ('*' + $spec.voz + '*') } | Select-Object -First 1
if (-not $voice) { $voice = $all | Where-Object { $_.Language -like 'pt-*' } | Select-Object -First 1 }
if (-not $voice) { throw 'Nenhuma voz em portugues instalada no Windows.' }
$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$synth.Voice = $voice
$synth.Options.SpeakingRate = [double]$spec.ritmo
try { $synth.Options.AppendedSilence = [Windows.Media.SpeechSynthesis.SpeechAppendedSilence]::Min } catch {}
foreach ($item in $spec.itens) {
  $stream = Await ($synth.SynthesizeTextToStreamAsync($item.texto)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
  $size = [uint32]$stream.Size
  $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
  $null = Await ($reader.LoadAsync($size)) ([uint32])
  $bytes = New-Object byte[] $size
  $reader.ReadBytes($bytes)
  [IO.File]::WriteAllBytes($item.caminho, $bytes)
}
Write-Output ('VOZ=' + $voice.DisplayName)
`;
const run = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
  { env: { ...process.env, NARRACAO_SPEC: spec }, encoding: 'utf8' });
rmSync(spec);
if (run.status !== 0) { console.error(run.stderr || run.stdout); process.exit(1); }
const voz = /VOZ=(.*)/.exec(run.stdout)?.[1].trim() || '?';

/**
 * Onde a voz realmente começa e termina dentro do WAV (s). A síntese do Windows deixa silêncio
 * nas pontas; o vídeo toca só o trecho falado.
 */
function wavInfo(file) {
  const b = readFileSync(file);
  let o = 12, fmt = null;
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4), size = b.readUInt32LE(o + 4);
    if (id === 'fmt ') fmt = { channels: b.readUInt16LE(o + 10), rate: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
    if (id === 'data') {
      if (!fmt || fmt.bits !== 16) throw new Error('WAV em formato inesperado: ' + file);
      const start = o + 8, step = 2 * fmt.channels, n = Math.floor(Math.min(size, b.length - start) / step);
      const loud = i => Math.abs(b.readInt16LE(start + i * step)) > 260;
      let first = 0, last = n - 1;
      while (first < n && !loud(first)) first++;
      while (last > first && !loud(last)) last--;
      const pad = 0.04 * fmt.rate; // pequena folga para não cortar a respiração da frase
      const ini = Math.max(0, first - pad) / fmt.rate, fim = Math.min(n, last + pad * 3) / fmt.rate;
      return { ini, dur: fim - ini, rate: fmt.rate };
    }
    o += 8 + size + (size % 2);
  }
  throw new Error('WAV inválido: ' + file);
}

const falas = [];
console.log(`Voz: ${voz}\n`);
for (const cena of Object.keys(FALAS)) {
  let prevEnd = 0;
  for (const it of itens.filter(i => i.cena === cena)) {
    const { ini, dur } = wavInfo(it.caminho);
    const aviso = it.at < prevEnd + 0.2 ? '  <-- SOBREPÕE a fala anterior' : '';
    console.log(`${cena.padEnd(9)} ${it.at.toFixed(1).padStart(5)}s -> ${(it.at + dur).toFixed(1).padStart(5)}s (${dur.toFixed(1)}s)  ${it.texto}${aviso}`);
    prevEnd = it.at + dur;
    falas.push({ cena, at: it.at, ini: +ini.toFixed(3), dur: +dur.toFixed(3), arquivo: it.arquivo, texto: it.texto });
  }
}
writeFileSync(path.join(DIR, 'narracao.js'), `// Gerado por narrar.mjs\nwindow.NARRACAO = ${JSON.stringify({ voz, falas }, null, 1)};\n`);
console.log(`\n${falas.length} falas em ${DIR}`);
