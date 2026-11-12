// Funções compartilhadas entre o site do cliente e o painel do dono
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = cents => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const pad = n => String(n).padStart(2, '0');
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toDateObj = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = toDateObj(s); d.setDate(d.getDate() + n); return localDate(d); };
const fmtDate = (s, opts = { weekday: 'long', day: '2-digit', month: 'long' }) => toDateObj(s).toLocaleDateString('pt-BR', opts);
const fmtDuration = min => min < 60 ? `${min} min` : `${Math.floor(min / 60)}h${min % 60 ? pad(min % 60) : ''}`;
const fmtPhone = d => {
  d = String(d || '').replace(/\D/g, '');
  if (d.startsWith('55') && d.length > 11) d = d.slice(2);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return d;
};
const firstName = n => String(n ?? '').trim().split(/\s+/)[0];
const waNumber = d => { d = String(d || '').replace(/\D/g, ''); return d.length <= 11 ? '55' + d : d; };
const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const STATUS_LABEL = { confirmed: 'Confirmado', completed: 'Atendido', cancelled: 'Cancelado', no_show: 'Não compareceu' };
const WAIT_LABEL = { waiting: 'Na fila de espera', cancelled: 'Saiu da fila', expired: 'Fila encerrada: o horário não vagou', promoted: 'Confirmado' };

function maskPhone(input) {
  input.addEventListener('input', () => {
    const d = input.value.replace(/\D/g, '').slice(0, 11);
    let v = d;
    if (d.length > 2) v = `(${d.slice(0, 2)}) ${d.slice(2)}`;
    if (d.length > 7) v = `(${d.slice(0, 2)}) ${d.slice(2, d.length === 11 ? 7 : 6)}-${d.slice(d.length === 11 ? 7 : 6)}`;
    input.value = v;
  });
}

let toastTimer;
function toast(msg, type = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

async function http(method, url, body, token) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(data.error || 'Erro inesperado'); err.status = res.status; throw err; }
  return data;
}
