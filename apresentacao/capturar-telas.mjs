// Popula um servidor de DEMONSTRAÇÃO com dados fictícios e captura as telas reais usadas no vídeo.
// Uso:  DEMO_URL=http://localhost:3100 node apresentacao/capturar-telas.mjs
// Rode contra um servidor com banco vazio/de teste (DB_FILE=...), nunca contra o banco real.
import { launch, sleep } from './cdp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BASE = process.env.DEMO_URL || 'http://localhost:3100';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'telas');
mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------ dados fictícios
let token;
async function api(method, url, body) {
  const r = await fetch(BASE + url, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url}: ${data.error}`);
  return data;
}
const iso = d => d.toLocaleDateString('sv');
const plus = (dateStr, n) => { const d = new Date(dateStr + 'T12:00:00'); d.setDate(d.getDate() + n); return d; };

// Dia da demonstração: próximo dia de semana cheio (ter-sex), com folga de 2 dias
const day = new Date(); day.setDate(day.getDate() + 2);
while (day.getDay() < 2 || day.getDay() > 5) day.setDate(day.getDate() + 1);
const D = iso(day);

token = (await api('POST', '/api/admin/login', { password: 'admin123' })).token;
if ((await api('GET', `/api/admin/appointments?from=${D}&to=${D}`)).length) {
  throw new Error('Este servidor já tem agendamentos no dia da demonstração. Use um banco novo (DB_FILE).');
}
await api('PUT', '/api/admin/settings', {
  shop_name: 'Azul Nail Studio',
  about: 'Esmaltação em gel, alongamento e nail art com acabamento impecável, e aquele café enquanto você espera.',
  instagram: '@azulnailstudio',
});

// [profissional (1 = Juliana, 2 = Camila), serviço, hora, cliente, telefone, status]
const seed = [
  [1, 1, '09:00', 'Mariana Souza', '11987650001', 'completed'],
  [1, 2, '09:30', 'Gabriela Lima', '11987650002', 'completed'],
  [1, 3, '10:00', 'Beatriz Santos', '11987650003'],
  [1, 1, '11:00', 'Fernanda Rocha', '11987650004'],
  [1, 3, '13:00', 'Amanda Martins', '11987650005'],
  [1, 1, '14:30', 'Débora Ferreira', '11987650006'],
  [1, 2, '16:00', 'Vitória Ramos', '11987650007'],
  [1, 1, '17:30', 'Olívia Pires', '11987650013'],
  [2, 3, '09:00', 'Letícia Dias', '11987650008', 'completed'],
  [2, 3, '10:00', 'Bruna Oliveira', '11987650009'],
  [2, 1, '11:00', 'Carolina Mendes', '11987650010'],
  [2, 4, '13:30', 'Sabrina Teixeira', '11987650011'],
  [2, 1, '14:00', 'Eduarda Nunes', '11987650012'],
  [2, 5, '16:30', 'Helena Barros', '11987650014'],
];
for (const [proId, serviceId, time, name, phone, status] of seed) {
  const a = await api('POST', '/api/admin/appointments', { proId, serviceId, date: D, time, name, phone });
  if (status) await api('PATCH', `/api/admin/appointments/${a.id}`, { status });
}
const weekdayFrom = (n) => { const d = plus(D, n); while (d.getDay() < 2) d.setDate(d.getDate() + 1); return iso(d); };
await api('POST', '/api/admin/blocks', { date: weekdayFrom(5), allDay: true, reason: 'Feriado' });
await api('POST', '/api/admin/blocks', { date: weekdayFrom(8), proId: 1, start: '14:00', end: '16:00', reason: 'Consulta médica' });
await api('POST', '/api/admin/blocks', { date: weekdayFrom(12), proId: 2, allDay: true, reason: 'Curso de nail art' });
console.log('Dados de demonstração criados para', D);

// ------------------------------------------------------------ captura
const browser = await launch();
const shots = {};

/** Salva a tela e as posições (em px de CSS, relativas à tela) dos elementos que o vídeo vai destacar. */
async function shot(page, name, selectors = {}) {
  const rects = await page.run(sels => {
    const out = {};
    for (const [k, sel] of Object.entries(sels)) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      out[k] = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    }
    const toast = document.querySelector('#toast'); // avisos temporários não entram na captura
    if (toast) toast.style.visibility = 'hidden';   // (só esconde: a página ainda precisa do elemento)
    return out;
  }, selectors);
  await sleep(150);
  writeFileSync(path.join(OUT, `${name}.png`), await page.screenshot('png'));
  shots[name] = { file: `telas/${name}.png`, rects };
  console.log('  tela', name, Object.keys(rects).join(', '));
}
const scrollTo = (page, sel, offset = 76) => page.run((s, o) => {
  const el = document.querySelector(s);
  scrollTo(0, el.getBoundingClientRect().top + scrollY - o);
}, sel, offset);
const click = (page, sel, wait = 700) => page.run(async (s, w) => {
  document.querySelector(s).click();
  await new Promise(r => setTimeout(r, w));
}, sel, wait);
const fill = (page, values) => page.run(v => {
  for (const [sel, value] of Object.entries(v)) {
    const el = document.querySelector(sel);
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}, values);
const ready = page => page.run(async () => {
  document.documentElement.style.scrollBehavior = 'auto';
  await document.fonts.ready;
  await new Promise(r => setTimeout(r, 900));
});

// ----- cliente, no celular
const PHONE = { w: 390, h: 844 };
const m = await browser.newPage();
await m.viewport(PHONE.w, PHONE.h, 3, true);
await m.goto(BASE + '/');
await ready(m);

await shot(m, 'c1-inicio');
await scrollTo(m, '#servicos h2');
await shot(m, 'c2-servicos', { agendar: '[data-book="3"]' });

await click(m, '[data-book="3"]');                         // Mão + Pé
await scrollTo(m, '#step-service');
await shot(m, 'c3-servico', { profissional: '[data-pro="2"]' });
await click(m, '[data-pro="2"]');                       // Camila
await shot(m, 'c3-profissional');

await scrollTo(m, '#step-date');
await shot(m, 'c4-dia', { dia: `[data-date="${D}"]` });
await click(m, `[data-date="${D}"]`);
await shot(m, 'c4-horarios', { horario: '[data-time="15:00"]' });
await click(m, '[data-time="15:00"]', 300);
await shot(m, 'c5-horario');

await fill(m, { '#f-name': 'Luana Almeida', '#f-phone': '11988881234' });
await scrollTo(m, '#step-form');
await shot(m, 'c6-dados', { confirmar: '#confirm' });
await click(m, '#confirm', 1000);
await scrollTo(m, '#agendar h2');
await shot(m, 'c7-confirmado');

// fila de espera: outra cliente quer as 10:00, que já estão ocupadas
await click(m, '#book-again', 900);
await scrollTo(m, '#step-date');
await shot(m, 'w0-ocupados', { horario: '.slot.taken[data-time="10:00"]' });
await click(m, '.slot.taken[data-time="10:00"]', 300);
await shot(m, 'w1-escolhido');
await fill(m, { '#f-name': 'Rafaela Costa', '#f-phone': '11977774321' });
await scrollTo(m, '#summary');
await shot(m, 'w2-resumo', { confirmar: '#confirm', nota: '#wait-note' });
await click(m, '#confirm', 1000);
await scrollTo(m, '#agendar h2');
await shot(m, 'w3-na-fila');

// localização
await scrollTo(m, '#localizacao h2');
await sleep(3000); // mapa
await shot(m, 'l1-endereco');
await scrollTo(m, '#map', 150);
await sleep(1500);
await shot(m, 'l2-mapa');

// ----- dono, no computador
const DESK = { w: 1200, h: 800 };
const a = await browser.newPage();
await a.viewport(DESK.w, DESK.h, 2, false);
await a.goto(BASE + '/admin');
await ready(a);
await fill(a, { '#password': 'admin123' });
await a.run(async () => { document.querySelector('#login-form').requestSubmit(); await new Promise(r => setTimeout(r, 1200)); });
await fill(a, { '#agenda-date': D });
await sleep(900);
await shot(a, 'a1-agenda', { stats: '#stats', lista: '#agenda-list', novo: '#new-appt' });

await fill(a, { '#agenda-pro': '2' });                  // só a Camila
await sleep(900);
await a.run(() => scrollTo(0, document.body.scrollHeight));
await shot(a, 'a2-fila', { fila: '#waitlist-day' });

// a cliente das 10:00 cancela -> a primeira da fila entra no lugar
// (pela API: o painel abriria o modal de motivo do cancelamento)
const bruna = (await api('GET', `/api/admin/appointments?from=${D}&to=${D}`)).find(x => (x.customerName || x.customer_name) === 'Bruna Oliveira');
await api('PATCH', `/api/admin/appointments/${bruna.id}`, { status: 'cancelled', reason: 'Imprevisto no trabalho' });
await fill(a, { '#agenda-pro': '2' });
await sleep(1500);
await a.run(() => scrollTo(0, 0));
await a.run(() => {
  [...document.querySelectorAll('#agenda-list .appt')].find(r => r.innerText.includes('Rafaela Costa'))?.setAttribute('id', 'linha-fila');
});
await shot(a, 'a3-vaga', { alerta: '#waitlist-alerts .alert', linha: '#linha-fila', whats: '#waitlist-alerts a.btn' });

await fill(a, { '#agenda-pro': '' });
await click(a, '[data-tab="services"]', 400);
await shot(a, 'a4-servicos', { tabela: '#services-table' });
await click(a, '[data-tab="pros"]', 400);
await shot(a, 'a5-expediente', { card: '#pros-list .pro-card' });
await click(a, '[data-tab="blocks"]', 400);
await shot(a, 'a6-folgas', { form: '#block-form', lista: '#blocks-list' });

writeFileSync(path.join(OUT, 'telas.js'),
  `// Gerado por capturar-telas.mjs\nwindow.TELAS = ${JSON.stringify({ dia: D, celular: PHONE, computador: DESK, shots }, null, 1)};\n`);
await browser.close();
console.log('Pronto:', Object.keys(shots).length, 'telas em', OUT);
