// Banco de dados SQLite (embutido no Node.js, sem dependências externas)
import { DatabaseSync } from 'node:sqlite';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(process.env.DB_FILE || path.join(dataDir, 'estudio.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS services (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    price_cents  INTEGER NOT NULL,
    duration_min INTEGER NOT NULL,
    active       INTEGER NOT NULL DEFAULT 1,
    sort         INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS pros (
    id     INTEGER PRIMARY KEY,
    name   TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  );

  -- Expediente semanal de cada profissional (weekday: 0=domingo ... 6=sábado; horários em minutos)
  CREATE TABLE IF NOT EXISTS working_hours (
    pro_id   INTEGER NOT NULL REFERENCES pros(id) ON DELETE CASCADE,
    weekday     INTEGER NOT NULL,
    start_min   INTEGER NOT NULL,
    end_min     INTEGER NOT NULL,
    break_start INTEGER,
    break_end   INTEGER,
    PRIMARY KEY (pro_id, weekday)
  );

  -- Bloqueios: folgas, feriados, compromissos (pro_id NULL = estúdio inteiro)
  CREATE TABLE IF NOT EXISTS blocks (
    id        INTEGER PRIMARY KEY,
    pro_id INTEGER REFERENCES pros(id) ON DELETE CASCADE,
    date      TEXT NOT NULL,
    start_min INTEGER NOT NULL,
    end_min   INTEGER NOT NULL,
    reason    TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS appointments (
    id             INTEGER PRIMARY KEY,
    code           TEXT NOT NULL UNIQUE,
    pro_id      INTEGER NOT NULL REFERENCES pros(id),
    service_id     INTEGER NOT NULL REFERENCES services(id),
    date           TEXT NOT NULL,
    start_min      INTEGER NOT NULL,
    end_min        INTEGER NOT NULL,
    customer_name  TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    notes          TEXT NOT NULL DEFAULT '',
    price_cents    INTEGER NOT NULL,
    status         TEXT NOT NULL DEFAULT 'confirmed',
    created_at     TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  -- Fila de espera: cliente aguardando um horário ocupado vagar.
  -- pro_id NULL = aceita qualquer profissional. Ao vagar, vira um agendamento com o mesmo código.
  CREATE TABLE IF NOT EXISTS waitlist (
    id             INTEGER PRIMARY KEY,
    code           TEXT NOT NULL UNIQUE,
    pro_id      INTEGER REFERENCES pros(id) ON DELETE CASCADE,
    service_id     INTEGER NOT NULL REFERENCES services(id),
    date           TEXT NOT NULL,
    start_min      INTEGER NOT NULL,
    customer_name  TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    notes          TEXT NOT NULL DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'waiting',  -- waiting | promoted | cancelled
    appointment_id INTEGER REFERENCES appointments(id),
    notified       INTEGER NOT NULL DEFAULT 0,       -- dono já avisou o cliente que a vaga saiu?
    created_at     TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE INDEX IF NOT EXISTS idx_wait_date ON waitlist(date, start_min);
  CREATE INDEX IF NOT EXISTS idx_appt_date ON appointments(date, pro_id);
  CREATE INDEX IF NOT EXISTS idx_blocks_date ON blocks(date);
`);

// ---------- Colunas acrescentadas depois da primeira versão (bancos antigos ganham a coluna sem perder dados)
function addColumn(table, column, definition) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
addColumn('pros', 'whatsapp', "TEXT NOT NULL DEFAULT ''");             // recebe os avisos de cancelamento
addColumn('appointments', 'cancel_reason', "TEXT NOT NULL DEFAULT ''");   // motivo informado ao cancelar
addColumn('appointments', 'cancelled_by', 'TEXT');                        // 'cliente' | 'estudio'
addColumn('appointments', 'cancelled_at', 'TEXT');
addColumn('appointments', 'cancel_seen', 'INTEGER NOT NULL DEFAULT 1');   // 0 = cancelamento do cliente ainda não visto no painel

export function hashPassword(pw) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(pw, salt, 64).toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const calc = scryptSync(String(pw), Buffer.from(salt, 'hex'), 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === calc.length && timingSafeEqual(expected, calc);
}

export function getSettings() {
  return Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value]));
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------- Dados iniciais (só na primeira execução) ----------
const DEFAULT_SETTINGS = {
  shop_name: 'Estúdio de Unhas Exemplo',
  about: 'Esmaltação em gel, alongamento e nail art com acabamento impecável, e aquele café enquanto você espera.',
  address: 'Rua Augusta, 1500 - Consolação, São Paulo - SP',
  phone: '(11) 99999-0000',
  whatsapp: '5511999990000',
  instagram: '',
  slot_step: '15',        // intervalo entre horários oferecidos (min)
  min_advance_min: '60',  // antecedência mínima para o cliente agendar (min)
  max_days_ahead: '30',   // até quantos dias à frente o cliente pode agendar
  cancel_advance_min: '120', // antecedência mínima para o cliente cancelar online (min)
};

for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
  db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)').run(k, v);
}
if (!getSettings().admin_password) {
  setSetting('admin_password', hashPassword(process.env.ADMIN_PASSWORD || 'admin123'));
}

if (db.prepare('SELECT COUNT(*) n FROM services').get().n === 0) {
  tx(() => {
    const ins = db.prepare('INSERT INTO services(name, description, price_cents, duration_min, sort) VALUES (?, ?, ?, ?, ?)');
    [
      ['Manicure', 'Cutilagem, lixamento e esmaltação', 3500, 30],
      ['Pedicure', 'Cutilagem, esfoliação e esmaltação', 4000, 30],
      ['Mão + Pé', 'Manicure e pedicure completas', 7000, 60],
      ['Nail art', 'Decoração em até 2 unhas: desenho, pedraria ou foil', 2000, 15],
      ['Spa das mãos', 'Esfoliação e hidratação profunda', 2500, 15],
      ['Esmaltação em gel', 'Brilho e duração de até 3 semanas', 8000, 60],
      ['Alongamento em gel', 'Unhas alongadas no molde F1, com esmaltação', 16000, 120],
    ].forEach((s, i) => ins.run(...s, i));

    const insB = db.prepare('INSERT INTO pros(name) VALUES (?)');
    const insH = db.prepare('INSERT INTO working_hours VALUES (?, ?, ?, ?, ?, ?)');
    for (const name of ['Juliana', 'Camila']) {
      const id = Number(insB.run(name).lastInsertRowid);
      for (const wd of [2, 3, 4, 5]) insH.run(id, wd, 9 * 60, 19 * 60, 12 * 60, 13 * 60); // ter-sex 09-19
      insH.run(id, 6, 8 * 60, 17 * 60, 12 * 60, 13 * 60);                                  // sáb 08-17
    }
  });
}
