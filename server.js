// Servidor HTTP + API REST do estúdio de unhas (sem dependências externas)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomInt } from 'node:crypto';
import { db, getSettings, setSetting, verifyPassword, hashPassword, tx } from './db.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = Number(process.env.PORT) || 3000;

// ---------------------------------------------------------------- utilitários
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (msg, status = 400) => { throw new HttpError(status, msg); };

const pad = n => String(n).padStart(2, '0');
const toHHMM = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const parseHHMM = s => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? ''));
  if (!m || +m[2] > 59) return null;
  const v = +m[1] * 60 + +m[2];
  return v <= 1440 ? v : null;
};
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? '')) && localDate(toDateObj(s)) === s;
const toDateObj = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = toDateObj(s); d.setDate(d.getDate() + n); return localDate(d); };
const weekday = s => toDateObj(s).getDay();
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const digits = s => String(s ?? '').replace(/\D/g, '');
const str = (s, max = 200) => String(s ?? '').trim().slice(0, max);
const int = (v, name, min = 0, max = 1e9) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(`${name} inválido`);
  return n;
};

// ---------------------------------------------------------------- mensagens de WhatsApp
// O envio é feito pelo próprio WhatsApp de quem cancela: o link wa.me abre a conversa com o texto
// pronto, e a pessoa só toca em "enviar". (Envio 100% automático exigiria a API paga do WhatsApp Business.)
const waNumber = d => { d = digits(d); return d.length <= 11 ? '55' + d : d; };
const waLink = (phone, text) => `https://wa.me/${waNumber(phone)}?text=${encodeURIComponent(text)}`;
/** "sexta-feira, 13/11 às 10:00" */
const fmtWhen = (date, startMin) =>
  `${toDateObj(date).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' })} às ${toHHMM(startMin)}`;
const firstName = name => String(name).trim().split(/\s+/)[0];

const PUBLIC_SETTINGS = ['shop_name', 'about', 'address', 'phone', 'whatsapp', 'instagram',
  'slot_step', 'min_advance_min', 'max_days_ahead', 'cancel_advance_min'];
const STATUSES = ['confirmed', 'completed', 'cancelled', 'no_show'];

// ---------------------------------------------------------------- disponibilidade
function getWorkingHours(proId, wd) {
  return db.prepare('SELECT * FROM working_hours WHERE pro_id = ? AND weekday = ?').get(proId, wd);
}

/**
 * Estado de cada horário de uma profissional numa data, para um serviço de `duration` minutos:
 *   'free'  = livre
 *   'taken' = ocupado por outro cliente (dá para entrar na fila de espera)
 * Horários fora do expediente, no intervalo, bloqueados ou já passados ficam fora do mapa.
 */
function slotStates(proId, date, duration, { admin = false } = {}) {
  const states = new Map();
  const s = getSettings();
  const today = localDate();
  if (!admin && (date < today || date > addDays(today, +s.max_days_ahead))) return states;

  const wh = getWorkingHours(proId, weekday(date));
  if (!wh) return states;

  const appts = db.prepare(`SELECT start_min s, end_min e FROM appointments
                            WHERE pro_id = ? AND date = ? AND status != 'cancelled'`).all(proId, date);
  const fixed = db.prepare(`SELECT start_min s, end_min e FROM blocks
                            WHERE date = ? AND (pro_id IS NULL OR pro_id = ?)`).all(date, proId);
  if (wh.break_start != null && wh.break_end != null) fixed.push({ s: wh.break_start, e: wh.break_end });

  let earliest = wh.start_min;
  if (date === today) earliest = Math.max(earliest, nowMin() + (admin ? 0 : +s.min_advance_min));

  const step = Math.max(5, +s.slot_step || 15);
  const overlaps = t => b => t < b.e && t + duration > b.s;
  for (let t = wh.start_min; t + duration <= wh.end_min; t += step) {
    if (t < earliest || fixed.some(overlaps(t))) continue;
    states.set(t, appts.some(overlaps(t)) ? 'taken' : 'free');
  }
  return states;
}

function activePros() {
  return db.prepare('SELECT id, name FROM pros WHERE active = 1 ORDER BY name').all();
}

/** Horários do dia: `available` = dá para agendar; senão está ocupado e `queue` diz quantos já esperam por ele. */
function availability(date, service, proId, opts) {
  const pros = proId ? activePros().filter(b => b.id === proId) : activePros();
  const map = new Map(); // horário -> profissionais livres (vazio = todos ocupados)
  for (const b of pros) {
    for (const [t, state] of slotStates(b.id, date, service.duration_min, opts)) {
      if (!map.has(t)) map.set(t, []);
      if (state === 'free') map.get(t).push(b.id);
    }
  }
  const queue = new Map(db.prepare(`SELECT start_min t, COUNT(*) n FROM waitlist
                                    WHERE status = 'waiting' AND date = ? GROUP BY start_min`).all(date).map(r => [r.t, r.n]));
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([t, ids]) => ({
    time: toHHMM(t), available: ids.length > 0, proIds: ids, queue: ids.length ? 0 : (queue.get(t) || 0),
  }));
}

/** Profissional livre para o horário (o pedido, ou o menos ocupado do dia se "qualquer um"). null = ninguém livre. */
function pickPro(proId, date, start, duration, opts) {
  const active = activePros().map(b => b.id);
  const candidates = (proId ? [proId] : active)
    .filter(id => active.includes(id))
    .filter(id => slotStates(id, date, duration, opts).get(start) === 'free');
  if (!candidates.length) return null;
  const load = id => db.prepare(`SELECT COUNT(*) n FROM appointments
                                 WHERE pro_id = ? AND date = ? AND status != 'cancelled'`).get(id, date).n;
  return candidates.sort((a, b) => load(a) - load(b))[0];
}

// ---------------------------------------------------------------- agendamentos
const APPT_SELECT = `SELECT a.*, s.name AS service_name, b.name AS pro_name, (w.id IS NOT NULL) AS from_waitlist
                     FROM appointments a JOIN services s ON s.id = a.service_id JOIN pros b ON b.id = a.pro_id
                     LEFT JOIN waitlist w ON w.appointment_id = a.id`;
const WAIT_SELECT = `SELECT w.*, s.name AS service_name, b.name AS pro_name
                     FROM waitlist w JOIN services s ON s.id = w.service_id LEFT JOIN pros b ON b.id = w.pro_id`;

const getAppointment = id => db.prepare(`${APPT_SELECT} WHERE a.id = ?`).get(id);

function apptView(a) {
  return {
    kind: 'appointment',
    id: a.id, code: a.code, date: a.date, start: toHHMM(a.start_min), end: toHHMM(a.end_min),
    serviceId: a.service_id, serviceName: a.service_name, proId: a.pro_id, proName: a.pro_name,
    customerName: a.customer_name, customerPhone: a.customer_phone, notes: a.notes,
    priceCents: a.price_cents, status: a.status, fromWaitlist: !!a.from_waitlist, createdAt: a.created_at,
    cancelReason: a.cancel_reason || '', cancelledBy: a.cancelled_by || null, cancelledAt: a.cancelled_at || null,
  };
}

function waitView(w) {
  const today = localDate();
  const past = w.date < today || (w.date === today && w.start_min <= nowMin());
  const waiting = w.status === 'waiting' && !past;
  return {
    kind: 'waitlist',
    id: w.id, code: w.code, date: w.date, start: toHHMM(w.start_min),
    serviceId: w.service_id, serviceName: w.service_name, proId: w.pro_id, proName: w.pro_name ?? null,
    customerName: w.customer_name, customerPhone: w.customer_phone, notes: w.notes,
    status: w.status === 'waiting' && past ? 'expired' : w.status,
    // lugar na fila daquele horário (1 = próximo a ser chamado)
    position: waiting ? db.prepare(`SELECT COUNT(*) n FROM waitlist WHERE status = 'waiting' AND date = ? AND start_min = ? AND id <= ?`)
      .get(w.date, w.start_min, w.id).n : null,
    createdAt: w.created_at,
  };
}

// Código único entre agendamentos e fila: quem sai da fila mantém o mesmo código no agendamento.
function newCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    const code = Array.from({ length: 6 }, () => chars[randomInt(chars.length)]).join('');
    if (!db.prepare('SELECT 1 FROM appointments WHERE code = ? UNION SELECT 1 FROM waitlist WHERE code = ?').get(code, code)) return code;
  }
}

function getService(id) {
  const s = db.prepare('SELECT * FROM services WHERE id = ? AND active = 1').get(Number(id));
  return s || fail('Serviço não encontrado');
}

function parseBooking(body) {
  const service = getService(body.serviceId);
  const date = isDate(body.date) ? body.date : fail('Data inválida');
  const start = parseHHMM(body.time) ?? fail('Horário inválido');
  const name = str(body.name, 80);
  const phone = digits(body.phone);
  if (name.length < 2) fail('Informe seu nome');
  if (phone.length < 10 || phone.length > 13) fail('Informe um telefone válido com DDD');
  return { service, date, start, name, phone, notes: str(body.notes, 300), proId: body.proId ? Number(body.proId) : null };
}

function insertAppointment({ code, proId, service, date, start, name, phone, notes }) {
  const info = db.prepare(`INSERT INTO appointments
      (code, pro_id, service_id, date, start_min, end_min, customer_name, customer_phone, notes, price_cents)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(code, proId, service.id, date, start, start + service.duration_min, name, phone, notes, service.price_cents);
  return getAppointment(info.lastInsertRowid);
}

function createAppointment(body, { admin = false } = {}) {
  const b = parseBooking(body);
  // Node é single-thread e o SQLite aqui é síncrono: checar + inserir é atômico.
  const chosen = pickPro(b.proId, b.date, b.start, b.service.duration_min, { admin });
  if (chosen == null) {
    fail(admin ? 'Esse horário não está livre.' : 'Esse horário acabou de ser ocupado. Entre na fila de espera ou escolha outro.', 409);
  }
  return apptView(insertAppointment({ ...b, code: newCode(), proId: chosen }));
}

// ---------------------------------------------------------------- fila de espera
function joinWaitlist(body) {
  const b = parseBooking(body);
  const slot = availability(b.date, b.service, b.proId).find(s => s.time === toHHMM(b.start));
  if (!slot) fail('Esse horário não está disponível para fila de espera.');
  if (slot.available) return createAppointment(body); // vagou nesse meio-tempo: já agenda direto

  const mine = [b.phone, b.date, b.start];
  if (db.prepare(`SELECT 1 FROM appointments WHERE customer_phone = ? AND date = ? AND start_min = ? AND status = 'confirmed'`).get(...mine)) {
    fail('Você já tem um agendamento neste horário.');
  }
  if (db.prepare(`SELECT 1 FROM waitlist WHERE customer_phone = ? AND date = ? AND start_min = ? AND status = 'waiting'`).get(...mine)) {
    fail('Você já está na fila de espera deste horário.');
  }
  const open = db.prepare(`SELECT COUNT(*) n FROM waitlist WHERE customer_phone = ? AND status = 'waiting' AND date >= ?`).get(b.phone, localDate()).n;
  if (open >= 5) fail('Você já está em 5 filas de espera. Saia de alguma para entrar em outra.');

  const id = db.prepare(`INSERT INTO waitlist (code, pro_id, service_id, date, start_min, customer_name, customer_phone, notes)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(newCode(), b.proId, b.service.id, b.date, b.start, b.name, b.phone, b.notes).lastInsertRowid;
  return waitView(db.prepare(`${WAIT_SELECT} WHERE w.id = ?`).get(id));
}

/**
 * Chamado sempre que algum horário pode ter vagado (cancelamento, bloqueio removido, expediente alterado).
 * Quem está na fila ganha o horário automaticamente, por ordem de chegada; o dono é avisado no painel.
 * Devolve os agendamentos criados a partir da fila.
 */
function processWaitlist() {
  const promoted = [];
  const waiting = db.prepare(`SELECT * FROM waitlist WHERE status = 'waiting' AND date >= ? ORDER BY id`).all(localDate());
  for (const w of waiting) {
    const service = db.prepare('SELECT * FROM services WHERE id = ? AND active = 1').get(w.service_id);
    if (!service) continue;
    const proId = pickPro(w.pro_id, w.date, w.start_min, service.duration_min);
    if (proId == null) continue;
    tx(() => {
      const a = insertAppointment({
        code: w.code, proId, service, date: w.date, start: w.start_min,
        name: w.customer_name, phone: w.customer_phone, notes: w.notes,
      });
      db.prepare(`UPDATE waitlist SET status = 'promoted', appointment_id = ? WHERE id = ?`).run(a.id, w.id);
      promoted.push(a);
    });
  }
  return promoted;
}

/** Marca um agendamento como cancelado, guardando o motivo e quem cancelou, e libera o horário para a fila. */
function cancelAppointment(a, { reason, by }) {
  db.prepare(`UPDATE appointments SET status = 'cancelled', cancel_reason = ?, cancelled_by = ?,
              cancelled_at = datetime('now', 'localtime'), cancel_seen = ? WHERE id = ?`)
    .run(reason, by, by === 'cliente' ? 0 : 1, a.id);
  const promoted = processWaitlist();
  // alguém da fila de espera ficou com este mesmo horário?
  return promoted.find(p => p.pro_id === a.pro_id && p.date === a.date && p.start_min < a.end_min && p.end_min > a.start_min) || null;
}

/** Acha pelo código + telefone um agendamento ou, se não houver, um lugar na fila de espera. */
function findByCodeAndPhone(code, phone) {
  code = str(code, 10).toUpperCase();
  phone = digits(phone);
  const appt = db.prepare(`${APPT_SELECT} WHERE a.code = ?`).get(code);
  if (appt && appt.customer_phone === phone) return { appt };
  const wait = db.prepare(`${WAIT_SELECT} WHERE w.code = ?`).get(code);
  if (wait && wait.customer_phone === phone) return { wait };
  return fail('Agendamento não encontrado. Confira o código e o telefone.', 404);
}

// ---------------------------------------------------------------- sessões do admin
const sessions = new Map(); // token -> expira em (ms)
const loginFails = new Map(); // ip -> { n, until }
const SESSION_MS = 12 * 60 * 60 * 1000;

function requireAdmin(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const exp = sessions.get(token);
  if (!exp || exp < Date.now()) { sessions.delete(token); fail('Sessão expirada. Entre novamente.', 401); }
}

// ---------------------------------------------------------------- rotas
const routes = [];
function route(method, pattern, handler, { admin = false } = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, admin });
}

// ----- público
route('GET', '/api/info', () => {
  const s = getSettings();
  const settings = Object.fromEntries(PUBLIC_SETTINGS.map(k => [k, s[k] ?? '']));
  const services = db.prepare('SELECT id, name, description, price_cents, duration_min FROM services WHERE active = 1 ORDER BY sort, id').all();
  const pros = activePros().map(b => ({
    ...b,
    days: db.prepare('SELECT weekday FROM working_hours WHERE pro_id = ?').all(b.id).map(r => r.weekday),
  }));
  // Horário de funcionamento = união dos expedientes das profissionais ativas
  const hours = Array.from({ length: 7 }, (_, wd) => {
    const r = db.prepare(`SELECT MIN(start_min) o, MAX(end_min) c FROM working_hours h JOIN pros b ON b.id = h.pro_id
                          WHERE b.active = 1 AND h.weekday = ?`).get(wd);
    return r.o == null ? null : { open: toHHMM(r.o), close: toHHMM(r.c) };
  });
  return { settings, services, pros, hours, today: localDate() };
});

route('GET', '/api/availability', ({ query }) => {
  const date = isDate(query.get('date')) ? query.get('date') : fail('Data inválida');
  const service = getService(query.get('serviceId'));
  const proId = query.get('proId') ? Number(query.get('proId')) : null;
  return { slots: availability(date, service, proId) };
});

route('POST', '/api/appointments', ({ body }) => createAppointment(body));

route('POST', '/api/waitlist', ({ body }) => joinWaitlist(body));

route('POST', '/api/appointments/lookup', ({ body }) => {
  const { appt, wait } = findByCodeAndPhone(body.code, body.phone);
  return appt ? apptView(appt) : waitView(wait);
});

route('POST', '/api/appointments/cancel', ({ body }) => {
  const { appt: a, wait: w } = findByCodeAndPhone(body.code, body.phone);
  if (w) { // sair da fila de espera
    if (w.status !== 'waiting') fail('Você não está mais nesta fila de espera.');
    db.prepare(`UPDATE waitlist SET status = 'cancelled' WHERE id = ?`).run(w.id);
    return waitView({ ...w, status: 'cancelled' });
  }
  if (a.status !== 'confirmed') fail('Este agendamento não pode mais ser cancelado.');
  const s = getSettings();
  const minutesUntil = (toDateObj(a.date).getTime() + a.start_min * 60000 - Date.now()) / 60000;
  if (minutesUntil < +s.cancel_advance_min) {
    fail(`Cancelamento online só até ${Math.round(+s.cancel_advance_min / 60 * 10) / 10}h antes. Fale com o estúdio.`);
  }
  // o cliente precisa dizer por que está cancelando
  const reason = str(body.reason, 300).replace(/\s+/g, ' ');
  if (reason.length < 3) fail('Conte o motivo do cancelamento.');

  cancelAppointment(a, { reason, by: 'cliente' });

  // mensagem pronta para o cliente mandar à profissional (ou ao estúdio, se ela não tiver WhatsApp cadastrado)
  const pro = db.prepare('SELECT name, whatsapp FROM pros WHERE id = ?').get(a.pro_id);
  const to = pro?.whatsapp || s.whatsapp;
  const text = [
    pro?.whatsapp ? `Olá, ${firstName(pro.name)}! Aqui é ${a.customer_name}.` : `Olá! Aqui é ${a.customer_name}.`,
    'Precisei cancelar meu horário:',
    '',
    `Serviço: ${a.service_name} com ${a.pro_name}`,
    `Horário: ${fmtWhen(a.date, a.start_min)}`,
    `Motivo: ${reason}`,
    `Código: ${a.code}`,
  ].join('\n');
  return {
    ...apptView(getAppointment(a.id)),
    notify: to ? { para: pro?.whatsapp ? a.pro_name : s.shop_name, url: waLink(to, text), texto: text } : null,
  };
});

// ----- admin: login
route('POST', '/api/admin/login', ({ body, req }) => {
  const ip = req.socket.remoteAddress;
  const f = loginFails.get(ip);
  if (f && f.n >= 10 && f.until > Date.now()) fail('Muitas tentativas. Aguarde 15 minutos.', 429);
  if (!verifyPassword(body.password, getSettings().admin_password)) {
    const n = (f && f.until > Date.now() ? f.n : 0) + 1;
    loginFails.set(ip, { n, until: Date.now() + 15 * 60000 });
    fail('Senha incorreta', 401);
  }
  loginFails.delete(ip);
  const token = randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_MS);
  return { token };
});

route('POST', '/api/admin/logout', ({ req }) => {
  sessions.delete((req.headers.authorization || '').replace(/^Bearer /, ''));
  return { ok: true };
}, { admin: true });

route('POST', '/api/admin/password', ({ body }) => {
  if (!verifyPassword(body.current, getSettings().admin_password)) fail('Senha atual incorreta');
  if (String(body.next || '').length < 6) fail('A nova senha precisa ter ao menos 6 caracteres');
  setSetting('admin_password', hashPassword(String(body.next)));
  return { ok: true };
}, { admin: true });

// ----- admin: agenda
route('GET', '/api/admin/appointments', ({ query }) => {
  const from = isDate(query.get('from')) ? query.get('from') : localDate();
  const to = isDate(query.get('to')) ? query.get('to') : from;
  const rows = db.prepare(`${APPT_SELECT} WHERE a.date BETWEEN ? AND ? ORDER BY a.date, a.start_min, b.name`).all(from, to);
  return rows.map(apptView);
}, { admin: true });

route('GET', '/api/admin/availability', ({ query }) => {
  const date = isDate(query.get('date')) ? query.get('date') : fail('Data inválida');
  const service = getService(query.get('serviceId'));
  const proId = query.get('proId') ? Number(query.get('proId')) : null;
  return { slots: availability(date, service, proId, { admin: true }) };
}, { admin: true });

route('POST', '/api/admin/appointments', ({ body }) => createAppointment(body, { admin: true }), { admin: true });

route('PATCH', '/api/admin/appointments/:id', ({ params, body, req }) => {
  if (!STATUSES.includes(body.status)) fail('Status inválido');
  const a = getAppointment(Number(params.id)) || fail('Não encontrado', 404);
  if (a.status === body.status) return apptView(a);

  // Estúdio cancelando: motivo opcional e mensagem pronta para avisar o cliente
  if (body.status === 'cancelled') {
    const reason = str(body.reason, 300).replace(/\s+/g, ' ');
    const taken = cancelAppointment(a, { reason, by: 'estudio' });
    const s = getSettings();
    const origin = String(req.headers.origin || `http://${req.headers.host}`);
    const site = /\/\/(localhost|127\.|\[::1\])/.test(origin) ? '' : `${origin}/#agendar`; // link local não serve ao cliente
    const text = [
      `Olá, ${firstName(a.customer_name)}! Aqui é da ${s.shop_name}.`,
      `Infelizmente precisamos cancelar o seu horário de ${a.service_name} com ${a.pro_name}, ${fmtWhen(a.date, a.start_min)}.`,
      ...(reason ? [`Motivo: ${reason}`] : []),
      '',
      site ? `Pedimos desculpas. Para marcar outro horário: ${site}` : 'Pedimos desculpas. Responda esta mensagem para marcarmos outro horário.',
    ].join('\n');
    return {
      ...apptView(getAppointment(a.id)),
      notify: { para: a.customer_name, url: waLink(a.customer_phone, text), texto: text },
      filaOcupou: taken ? taken.customer_name : null,
    };
  }

  if (a.status === 'cancelled') {
    // reativar: só se o horário ainda estiver livre
    const conflict = db.prepare(`SELECT 1 FROM appointments WHERE pro_id = ? AND date = ? AND status != 'cancelled'
                                 AND id != ? AND start_min < ? AND end_min > ?`).get(a.pro_id, a.date, a.id, a.end_min, a.start_min);
    if (conflict) fail('O horário já foi ocupado por outro cliente.', 409);
    db.prepare(`UPDATE appointments SET cancel_reason = '', cancelled_by = NULL, cancelled_at = NULL, cancel_seen = 1 WHERE id = ?`).run(a.id);
  }
  db.prepare('UPDATE appointments SET status = ? WHERE id = ?').run(body.status, a.id);
  return apptView(getAppointment(a.id));
}, { admin: true });

// "Ok, visto": tira do topo do painel o aviso de cancelamento feito pelo cliente
route('POST', '/api/admin/appointments/:id/seen', ({ params }) => {
  db.prepare('UPDATE appointments SET cancel_seen = 1 WHERE id = ?').run(Number(params.id));
  return { ok: true };
}, { admin: true });

// ----- admin: fila de espera
route('GET', '/api/admin/waitlist', () => {
  const today = localDate();
  // quem ainda está aguardando
  const waiting = db.prepare(`${WAIT_SELECT} WHERE w.status = 'waiting' AND w.date >= ? ORDER BY w.date, w.start_min, w.id`)
    .all(today).map(waitView).filter(w => w.status === 'waiting');
  // quem ganhou a vaga e ainda não foi avisado pelo dono
  const toNotify = db.prepare(`SELECT w.id AS wait_id, a.id FROM waitlist w JOIN appointments a ON a.id = w.appointment_id
                               WHERE w.status = 'promoted' AND w.notified = 0 AND a.status = 'confirmed' AND a.date >= ?
                               ORDER BY a.date, a.start_min`)
    .all(today).map(r => ({ ...apptView(getAppointment(r.id)), waitId: r.wait_id }));
  // clientes que cancelaram pelo site e o painel ainda não viu
  const cancellations = db.prepare(`${APPT_SELECT} WHERE a.status = 'cancelled' AND a.cancelled_by = 'cliente'
                                    AND a.cancel_seen = 0 AND a.date >= ? ORDER BY a.cancelled_at`)
    .all(today).map(apptView);
  return { waiting, toNotify, cancellations };
}, { admin: true });
route('POST', '/api/admin/waitlist/:id/notified', ({ params }) => {
  db.prepare('UPDATE waitlist SET notified = 1 WHERE id = ?').run(Number(params.id));
  return { ok: true };
}, { admin: true });
route('DELETE', '/api/admin/waitlist/:id', ({ params }) => {
  db.prepare(`UPDATE waitlist SET status = 'cancelled' WHERE id = ? AND status = 'waiting'`).run(Number(params.id));
  return { ok: true };
}, { admin: true });

// ----- admin: serviços
route('GET', '/api/admin/services', () =>
  db.prepare('SELECT * FROM services ORDER BY sort, id').all(), { admin: true });

function serviceFields(b) {
  const name = str(b.name, 60) || fail('Nome do serviço obrigatório');
  return [name, str(b.description, 200), int(b.price_cents, 'Preço', 0, 10_000_00),
    int(b.duration_min, 'Duração', 5, 600), b.active === false || b.active === 0 ? 0 : 1, Number(b.sort) || 0];
}
route('POST', '/api/admin/services', ({ body }) => {
  const id = db.prepare('INSERT INTO services(name, description, price_cents, duration_min, active, sort) VALUES (?, ?, ?, ?, ?, ?)')
    .run(...serviceFields(body)).lastInsertRowid;
  return db.prepare('SELECT * FROM services WHERE id = ?').get(id);
}, { admin: true });
route('PUT', '/api/admin/services/:id', ({ params, body }) => {
  db.prepare('UPDATE services SET name = ?, description = ?, price_cents = ?, duration_min = ?, active = ?, sort = ? WHERE id = ?')
    .run(...serviceFields(body), Number(params.id));
  return db.prepare('SELECT * FROM services WHERE id = ?').get(Number(params.id)) || fail('Não encontrado', 404);
}, { admin: true });
route('DELETE', '/api/admin/services/:id', ({ params }) => {
  const id = Number(params.id);
  // com histórico de agendamentos: apenas desativa, para não perder relatórios
  if (db.prepare('SELECT 1 FROM appointments WHERE service_id = ? UNION SELECT 1 FROM waitlist WHERE service_id = ?').get(id, id)) {
    db.prepare('UPDATE services SET active = 0 WHERE id = ?').run(id);
    return { deactivated: true };
  }
  db.prepare('DELETE FROM services WHERE id = ?').run(id);
  return { deleted: true };
}, { admin: true });

// ----- admin: profissionais e expediente
function proWithHours(b) {
  const hours = db.prepare('SELECT * FROM working_hours WHERE pro_id = ? ORDER BY weekday').all(b.id).map(h => ({
    weekday: h.weekday, start: toHHMM(h.start_min), end: toHHMM(h.end_min),
    breakStart: h.break_start == null ? '' : toHHMM(h.break_start),
    breakEnd: h.break_end == null ? '' : toHHMM(h.break_end),
  }));
  return { ...b, hours };
}
function saveHours(proId, hours) {
  if (!Array.isArray(hours)) return;
  db.prepare('DELETE FROM working_hours WHERE pro_id = ?').run(proId);
  const ins = db.prepare('INSERT INTO working_hours VALUES (?, ?, ?, ?, ?, ?)');
  const DAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
  for (const h of hours) {
    const wd = int(h.weekday, 'Dia da semana', 0, 6);
    const start = parseHHMM(h.start), end = parseHHMM(h.end);
    if (start == null || end == null || end <= start) fail(`Expediente inválido na ${DAYS[wd]}`);
    let bs = h.breakStart ? parseHHMM(h.breakStart) : null, be = h.breakEnd ? parseHHMM(h.breakEnd) : null;
    if ((bs == null) !== (be == null) || (bs != null && (be <= bs || bs < start || be > end))) {
      fail(`Intervalo inválido na ${DAYS[wd]}`);
    }
    ins.run(proId, wd, start, end, bs, be);
  }
}
function proWhatsapp(v) {
  const d = digits(v);
  if (d && (d.length < 10 || d.length > 13)) fail('WhatsApp da profissional inválido: use DDD + número');
  return d;
}
route('GET', '/api/admin/pros', () =>
  db.prepare('SELECT * FROM pros ORDER BY name').all().map(proWithHours), { admin: true });
route('POST', '/api/admin/pros', ({ body }) => tx(() => {
  const name = str(body.name, 60) || fail('Nome obrigatório');
  const id = Number(db.prepare('INSERT INTO pros(name, active, whatsapp) VALUES (?, ?, ?)')
    .run(name, body.active === false ? 0 : 1, proWhatsapp(body.whatsapp)).lastInsertRowid);
  saveHours(id, body.hours);
  return proWithHours(db.prepare('SELECT * FROM pros WHERE id = ?').get(id));
}), { admin: true });
route('PUT', '/api/admin/pros/:id', ({ params, body }) => {
  const saved = tx(() => {
    const id = Number(params.id);
    db.prepare('SELECT 1 FROM pros WHERE id = ?').get(id) || fail('Não encontrado', 404);
    const name = str(body.name, 60) || fail('Nome obrigatório');
    db.prepare('UPDATE pros SET name = ?, active = ?, whatsapp = ? WHERE id = ?')
      .run(name, body.active === false ? 0 : 1, proWhatsapp(body.whatsapp), id);
    saveHours(id, body.hours);
    return proWithHours(db.prepare('SELECT * FROM pros WHERE id = ?').get(id));
  });
  processWaitlist(); // expediente maior pode ter aberto vaga para quem esperava
  return saved;
}, { admin: true });
route('DELETE', '/api/admin/pros/:id', ({ params }) => {
  const id = Number(params.id);
  if (db.prepare('SELECT 1 FROM appointments WHERE pro_id = ?').get(id)) {
    db.prepare('UPDATE pros SET active = 0 WHERE id = ?').run(id);
    return { deactivated: true };
  }
  db.prepare('DELETE FROM pros WHERE id = ?').run(id);
  return { deleted: true };
}, { admin: true });

// ----- admin: bloqueios (folgas, feriados)
route('GET', '/api/admin/blocks', ({ query }) => {
  const from = isDate(query.get('from')) ? query.get('from') : localDate();
  return db.prepare(`SELECT k.*, b.name AS pro_name FROM blocks k LEFT JOIN pros b ON b.id = k.pro_id
                     WHERE k.date >= ? ORDER BY k.date, k.start_min`).all(from)
    .map(k => ({ ...k, start: toHHMM(k.start_min), end: toHHMM(k.end_min) }));
}, { admin: true });
route('POST', '/api/admin/blocks', ({ body }) => {
  const date = isDate(body.date) ? body.date : fail('Data inválida');
  const allDay = !!body.allDay;
  const start = allDay ? 0 : parseHHMM(body.start), end = allDay ? 1440 : parseHHMM(body.end);
  if (start == null || end == null || end <= start) fail('Horário do bloqueio inválido');
  const proId = body.proId ? Number(body.proId) : null;
  const id = db.prepare('INSERT INTO blocks(pro_id, date, start_min, end_min, reason) VALUES (?, ?, ?, ?, ?)')
    .run(proId, date, start, end, str(body.reason, 100)).lastInsertRowid;
  // avisa se já existem clientes marcados no período bloqueado
  const affected = db.prepare(`${APPT_SELECT} WHERE a.date = ? AND a.status = 'confirmed' AND a.start_min < ? AND a.end_min > ?
                               ${proId ? 'AND a.pro_id = ?' : ''}`)
    .all(...[date, end, start, ...(proId ? [proId] : [])]).map(apptView);
  return { id, affected };
}, { admin: true });
route('DELETE', '/api/admin/blocks/:id', ({ params }) => {
  db.prepare('DELETE FROM blocks WHERE id = ?').run(Number(params.id));
  processWaitlist();
  return { ok: true };
}, { admin: true });

// ----- admin: configurações
route('GET', '/api/admin/settings', () => {
  const s = getSettings();
  return Object.fromEntries(PUBLIC_SETTINGS.map(k => [k, s[k] ?? '']));
}, { admin: true });
route('PUT', '/api/admin/settings', ({ body }) => {
  const numeric = { slot_step: [5, 120], min_advance_min: [0, 10080], max_days_ahead: [1, 365], cancel_advance_min: [0, 10080] };
  tx(() => {
    for (const k of PUBLIC_SETTINGS) {
      if (!(k in body)) continue;
      if (numeric[k]) setSetting(k, int(body[k], k, ...numeric[k]));
      else if (k === 'whatsapp') setSetting(k, digits(body[k]));
      else setSetting(k, str(body[k], k === 'about' ? 600 : 200));
    }
  });
  return { ok: true };
}, { admin: true });

// ---------------------------------------------------------------- servidor
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json',
};

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 100_000) fail('Requisição muito grande', 413);
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('JSON inválido'); }
}

async function serveStatic(pathname, res) {
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/admin') pathname = '/admin.html';
  const file = path.join(PUBLIC_DIR, path.normalize(decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403).end(); return; }
  try {
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Página não encontrada');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (!url.pathname.startsWith('/api/')) return await serveStatic(url.pathname, res);

    let match = null, r = null;
    for (r of routes) {
      if (r.method === req.method && (match = r.re.exec(url.pathname))) break;
    }
    if (!match) fail('Rota não encontrada', 404);
    if (r.admin) requireAdmin(req);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]));
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
    send(res, 200, await r.handler({ req, params, query: url.searchParams, body }));
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    console.error(err);
    send(res, 500, { error: 'Erro interno no servidor' });
  }
});

server.listen(PORT, () => {
  console.log(`\n  💅 Estúdio rodando em http://localhost:${PORT}`);
  console.log(`  🔐 Painel do estúdio:  http://localhost:${PORT}/admin  (senha inicial: admin123)\n`);
});
