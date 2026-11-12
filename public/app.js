// Site do cliente: vitrine, agendamento, consulta/cancelamento e localização
let info;
// waitlist = o horário escolhido está ocupado e o cliente vai entrar na fila; queue = quantos já esperam por ele
const state = { serviceId: null, proId: '', date: null, time: null, waitlist: false, queue: 0 };
let availabilityReq = 0;
let lastBooking = null; // código e telefone do último agendamento feito nesta página (para cancelar sem redigitar)

const service = () => info.services.find(s => s.id === state.serviceId);
const proName = id => info.pros.find(b => b.id === id)?.name;

async function init() {
  try {
    info = await http('GET', '/api/info');
  } catch {
    document.body.innerHTML = '<p style="padding:40px;text-align:center">Não foi possível carregar a página. Tente novamente em instantes.</p>';
    return;
  }
  const s = info.settings;
  document.title = `${s.shop_name} — Agendamento online`;
  $$('[data-bind]').forEach(el => { el.textContent = s[el.dataset.bind] || ''; });
  $('#year').textContent = new Date().getFullYear();

  renderOpenBadge();
  renderServices();
  renderPros();
  renderDays();
  renderLocation();

  maskPhone($('#f-phone'));
  maskPhone($('#l-phone'));
  try { // lembra nome/telefone do último agendamento neste navegador
    const saved = JSON.parse(localStorage.getItem('customer') || 'null');
    if (saved) { $('#f-name').value = saved.name; $('#f-phone').value = saved.phone; }
  } catch {}

  $('#step-form').addEventListener('input', updateSummary);
  $('#confirm').addEventListener('click', confirmBooking);
  $('#book-again').addEventListener('click', resetBooking);
  $('#lookup-form').addEventListener('submit', lookup);
  $('#success-cancel').addEventListener('click', cancelFromSuccess);
}

function renderOpenBadge() {
  const now = new Date();
  const h = info.hours[now.getDay()];
  const cur = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const badge = $('#open-badge');
  if (h && cur >= h.open && cur < h.close) {
    badge.textContent = `Aberto agora · até ${h.close}`;
    badge.classList.add('open');
  } else {
    // próximo dia de funcionamento
    for (let i = 0; i < 7; i++) {
      const wd = (now.getDay() + i) % 7, hh = info.hours[wd];
      if (!hh || (i === 0 && cur >= hh.open)) continue;
      badge.textContent = `Fechado · abre ${i === 0 ? 'hoje' : i === 1 ? 'amanhã' : WEEKDAYS[wd].toLowerCase()} às ${hh.open}`;
      return;
    }
    badge.textContent = 'Fechado';
  }
}

function renderServices() {
  $('#service-list').innerHTML = info.services.map(s => `
    <div class="card service">
      <h3>${esc(s.name)}</h3>
      <span class="muted small">${esc(s.description)}</span>
      <div class="meta">
        <span class="price">${money(s.price_cents)}</span>
        <span class="muted small">${fmtDuration(s.duration_min)}</span>
      </div>
      <button class="btn btn-sm" data-book="${s.id}">Agendar</button>
    </div>`).join('') || '<div class="empty">Nenhum serviço cadastrado.</div>';
  $$('[data-book]').forEach(b => b.addEventListener('click', () => {
    selectService(Number(b.dataset.book));
    $('#agendar').scrollIntoView();
  }));

  $('#service-choices').innerHTML = info.services.map(s => `
    <button type="button" class="choice" data-service="${s.id}" aria-pressed="false">
      <strong>${esc(s.name)}</strong><span>${money(s.price_cents)} · ${fmtDuration(s.duration_min)}</span>
    </button>`).join('');
  $$('[data-service]').forEach(b => b.addEventListener('click', () => selectService(Number(b.dataset.service))));
}

function renderPros() {
  const opts = [{ id: '', name: 'Qualquer profissional', sub: 'Primeiro horário livre' },
    ...info.pros.map(b => ({ id: b.id, name: b.name, sub: 'Nail designer' }))];
  $('#pro-choices').innerHTML = opts.map(b => `
    <button type="button" class="choice" data-pro="${b.id}" aria-pressed="${b.id === state.proId}">
      <strong>${esc(b.name)}</strong><span>${esc(b.sub)}</span>
    </button>`).join('');
  $$('[data-pro]').forEach(b => b.addEventListener('click', () => {
    state.proId = b.dataset.pro ? Number(b.dataset.pro) : '';
    $$('[data-pro]').forEach(x => x.setAttribute('aria-pressed', x === b));
    renderDays();
    loadSlots();
  }));
}

function workingWeekdays() {
  const list = state.proId ? info.pros.filter(b => b.id === state.proId) : info.pros;
  return new Set(list.flatMap(b => b.days));
}

function renderDays() {
  const open = workingWeekdays();
  const max = Number(info.settings.max_days_ahead) || 30;
  const days = [];
  for (let i = 0; i <= max; i++) days.push(addDays(info.today, i));
  if (state.date && !open.has(toDateObj(state.date).getDay())) state.date = null;
  if (!state.date) {
    // primeiro dia aberto que ainda não encerrou o expediente
    const now = new Date(), cur = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    state.date = days.find(d => {
      const wd = toDateObj(d).getDay();
      return open.has(wd) && !(d === info.today && cur >= (info.hours[wd]?.close || '00:00'));
    }) || null;
  }

  $('#days').innerHTML = days.map((d, i) => {
    const dt = toDateObj(d);
    const label = i === 0 ? 'Hoje' : i === 1 ? 'Amanhã' : dt.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '');
    return `<button type="button" class="day" data-date="${d}" aria-pressed="${d === state.date}" ${open.has(dt.getDay()) ? '' : 'disabled'}
              aria-label="${fmtDate(d)}"><small>${label}</small><b>${dt.getDate()}</b><small>${dt.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '')}</small></button>`;
  }).join('');
  $$('[data-date]').forEach(b => b.addEventListener('click', () => {
    state.date = b.dataset.date;
    $$('[data-date]').forEach(x => x.setAttribute('aria-pressed', x === b));
    loadSlots();
  }));
}

function selectService(id) {
  state.serviceId = id;
  $$('[data-service]').forEach(x => x.setAttribute('aria-pressed', Number(x.dataset.service) === id));
  loadSlots();
}

async function loadSlots() {
  state.time = null;
  state.waitlist = false;
  $('#step-form').classList.add('hidden');
  updateSummary();
  const box = $('#slots');
  if (!state.serviceId || !state.date) {
    box.innerHTML = '<div class="empty">Escolha um serviço e um dia para ver os horários livres.</div>';
    return;
  }
  box.innerHTML = '<div class="empty">Buscando horários…</div>';
  const req = ++availabilityReq;
  const params = new URLSearchParams({ date: state.date, serviceId: state.serviceId, proId: state.proId });
  try {
    const { slots } = await http('GET', `/api/availability?${params}`);
    if (req !== availabilityReq) return; // resposta antiga
    if (!slots.length) {
      box.innerHTML = '<div class="empty">Sem horários livres neste dia. Tente outro dia ou outro profissional.</div>';
      return;
    }
    // Horários ocupados continuam visíveis (indisponíveis), com a opção de entrar na fila de espera
    const taken = slots.filter(s => !s.available).length;
    const legend = !taken ? '' : `<p class="slot-legend">${taken === slots.length
      ? 'Todos os horários deste dia estão ocupados.' : '<span class="swatch"></span> Ocupado.'}
      Toque em um horário ocupado para entrar na <strong>fila de espera</strong>: se ele vagar, é seu.</p>`;
    box.innerHTML = `${legend}<div class="slots">${slots.map(s => s.available
      ? `<button type="button" class="slot" data-time="${s.time}" aria-pressed="false">${s.time}</button>`
      : `<button type="button" class="slot taken" data-time="${s.time}" data-taken="1" data-queue="${s.queue}" aria-pressed="false"
           aria-label="${s.time}, ocupado. Entrar na fila de espera">${s.time}<small>ocupado</small></button>`).join('')}</div>`;
    $$('[data-time]', box).forEach(b => b.addEventListener('click', () => {
      state.time = b.dataset.time;
      state.waitlist = !!b.dataset.taken;
      state.queue = Number(b.dataset.queue) || 0;
      $$('[data-time]', box).forEach(x => x.setAttribute('aria-pressed', x === b));
      $('#step-form').classList.remove('hidden');
      updateSummary();
      if (!$('#f-name').value) $('#f-name').focus({ preventScroll: true });
    }));
  } catch (e) {
    box.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function updateSummary() {
  const s = service();
  $('#sum-service').textContent = s?.name || '—';
  $('#sum-pro').textContent = state.proId ? proName(state.proId) : 'Qualquer um';
  $('#sum-date').textContent = state.date ? fmtDate(state.date, { weekday: 'short', day: '2-digit', month: 'short' }) : '—';
  $('#sum-time').textContent = state.time ? state.time + (state.waitlist ? ' (ocupado)' : '') : '—';
  $('#confirm').textContent = state.waitlist ? 'Entrar na fila de espera' : 'Confirmar agendamento';
  $('#wait-note').classList.toggle('hidden', !state.waitlist);
  if (state.waitlist) {
    const ahead = state.queue === 0 ? 'Ninguém na fila ainda: você será o primeiro.'
      : state.queue === 1 ? 'Já há 1 pessoa na fila deste horário.' : `Já há ${state.queue} pessoas na fila deste horário.`;
    $('#wait-note').textContent = `Este horário está ocupado. Entrando na fila, se ele vagar o agendamento é confirmado automaticamente no seu nome e o estúdio avisa você. ${ahead}`;
  }
  $('#sum-duration').textContent = s ? fmtDuration(s.duration_min) : '—';
  $('#sum-price').textContent = s ? money(s.price_cents) : '—';
  $$('.step').forEach(el => el.classList.remove('done'));
  if (s) $('#step-service').classList.add('done');
  $('#step-pro').classList.add('done');
  if (state.date) $('#step-date').classList.add('done');
  if (state.time) $('#step-time').classList.add('done');
  const formOk = $('#f-name').value.trim().length >= 2 && $('#f-phone').value.replace(/\D/g, '').length >= 10;
  if (formOk) $('#step-form').classList.add('done');
  $('#confirm').disabled = !(s && state.date && state.time && formOk);
}

async function confirmBooking() {
  const btn = $('#confirm');
  btn.disabled = true;
  btn.textContent = state.waitlist ? 'Entrando na fila…' : 'Confirmando…';
  const body = {
    serviceId: state.serviceId, proId: state.proId || null, date: state.date, time: state.time,
    name: $('#f-name').value, phone: $('#f-phone').value, notes: $('#f-notes').value,
  };
  try {
    // Resposta: kind 'appointment' (agendado) ou 'waitlist' (na fila). Se o horário vagou
    // enquanto o cliente preenchia, a fila de espera já devolve o agendamento confirmado.
    const a = await http('POST', state.waitlist ? '/api/waitlist' : '/api/appointments', body);
    try { localStorage.setItem('customer', JSON.stringify({ name: body.name, phone: body.phone })); } catch {}
    const when = `${fmtDate(a.date)} às ${a.start}`;
    const who = a.proName ? ` com ${a.proName}` : '';
    let msg;
    if (a.kind === 'waitlist') {
      $('#success-title').textContent = 'Você está na fila de espera';
      $('#success-text').textContent = `${a.serviceName}${who} — ${when}. Você é o ${a.position}º da fila. ` +
        'Se o horário vagar, seu agendamento é confirmado automaticamente e o estúdio avisa você. ' +
        'Acompanhe em "Meu agendamento" com o código abaixo.';
      msg = `Olá! Entrei na fila de espera para ${a.serviceName}${who} em ${when}. Código: ${a.code}`;
    } else {
      $('#success-title').textContent = 'Agendamento confirmado';
      $('#success-text').textContent = `${a.serviceName}${who} — ${when}.`;
      msg = `Olá! Acabei de agendar ${a.serviceName}${who} em ${when}. Código: ${a.code}`;
    }
    lastBooking = { code: a.code, phone: body.phone };
    $('#success-cancel').textContent = a.kind === 'waitlist' ? 'Sair da fila de espera' : 'Cancelar este agendamento';
    $('#booking').classList.add('hidden');
    $('#success').classList.remove('hidden');
    $('#success-code').textContent = a.code;
    const wa = info.settings.whatsapp;
    $('#success-whats').classList.toggle('hidden', !wa);
    $('#success-whats').href = `https://wa.me/${wa}?text=${encodeURIComponent(msg)}`;
    $('#agendar').scrollIntoView();
  } catch (e) {
    toast(e.message, 'error');
    if (e.status === 409) loadSlots(); // recarrega: o horário agora aparece como ocupado
  } finally {
    updateSummary(); // restaura o texto e o estado do botão
  }
}

function resetBooking() {
  $('#success').classList.add('hidden');
  $('#booking').classList.remove('hidden');
  $('#f-notes').value = '';
  loadSlots();
}

// ------------------------------------------------------------- consultar e cancelar
const CANCEL_REASONS = ['Imprevisto no trabalho', 'Problema de saúde', 'Compromisso de família', 'Vou remarcar outro dia'];
let lookupCreds = null;

async function lookup(ev, { openCancel = false } = {}) {
  ev?.preventDefault();
  lookupCreds = { code: $('#l-code').value.trim(), phone: $('#l-phone').value };
  try {
    const a = await http('POST', '/api/appointments/lookup', lookupCreds);
    renderLookup(a);
    if (openCancel) $('#cancel-open')?.click();
  } catch (e) {
    $('#lookup-result').innerHTML = `<div class="card lookup-card"><p class="muted" style="margin:0">${esc(e.message)}</p></div>`;
  }
}

/** Mostra o agendamento consultado. `notify` vem logo depois de o cliente cancelar: o aviso para a profissional. */
function renderLookup(a, notify) {
  const out = $('#lookup-result');
  const inQueue = a.kind === 'waitlist';
  const label = inQueue ? WAIT_LABEL[a.status] : STATUS_LABEL[a.status];
  const statusClass = !inQueue ? a.status : a.status === 'waiting' ? 'waiting' : 'cancelled';
  const who = a.proName ? `com ${esc(a.proName)}` : 'com qualquer profissional';
  let detail = inQueue
    ? (a.status === 'waiting' ? `Você é o ${a.position}º da fila. Se o horário vagar, o agendamento é confirmado automaticamente.` : '')
    : `${money(a.priceCents)}${a.fromWaitlist && a.status === 'confirmed' ? ' · O horário vagou e é seu.' : ''}`;
  if (!inQueue && a.status === 'cancelled' && a.cancelReason) {
    detail = `Cancelado ${a.cancelledBy === 'estudio' ? 'pelo estúdio' : 'por você'} · Motivo: ${esc(a.cancelReason)}`;
  }
  const hoursBefore = Math.round(Number(info.settings.cancel_advance_min || 0) / 60 * 10) / 10;

  let actions = '';
  if (inQueue && a.status === 'waiting') {
    actions = '<button type="button" class="btn btn-danger btn-sm" id="leave-queue">Sair da fila de espera</button>';
  } else if (!inQueue && a.status === 'confirmed') {
    actions = `
      <button type="button" class="btn btn-danger btn-sm" id="cancel-open">Cancelar agendamento</button>
      <form class="cancel-form hidden" id="cancel-form" novalidate>
        <label for="c-reason">Por que você precisa cancelar? <span class="muted">(obrigatório)</span></label>
        <div class="reason-chips">${CANCEL_REASONS.map(r =>
          `<button type="button" class="reason-chip" aria-pressed="false" data-reason="${esc(r)}">${esc(r)}</button>`).join('')}</div>
        <textarea id="c-reason" rows="3" maxlength="300" placeholder="Escreva o motivo"></textarea>
        <p class="muted small">${hoursBefore ? `O cancelamento online vai até ${hoursBefore}h antes do horário. ` : ''}Depois de cancelar, você avisa a profissional pelo WhatsApp com a mensagem já pronta.</p>
        <div class="form-actions">
          <button type="button" class="btn" id="cancel-back">Voltar</button>
          <button class="btn btn-danger-solid" id="cancel-confirm">Confirmar cancelamento</button>
        </div>
      </form>`;
  }

  const notice = notify === undefined ? '' : notify
    ? `<div class="notice">
         <strong>Agendamento cancelado.</strong>
         <p>Falta só avisar ${esc(notify.para)}: o WhatsApp abre com a mensagem pronta, é só tocar em enviar.</p>
         <a class="btn btn-primary" href="${esc(notify.url)}" target="_blank" rel="noopener">Avisar ${esc(notify.para)} no WhatsApp</a>
       </div>`
    : '<div class="notice"><strong>Agendamento cancelado.</strong><p>O motivo ficou registrado e o estúdio vê o aviso no painel.</p></div>';

  out.innerHTML = `
    <div class="card lookup-card">
      <p style="margin-top:0"><span class="status ${statusClass}">${label}</span></p>
      <p style="margin-bottom:0"><strong>${esc(a.serviceName)}</strong> ${who}<br>
      ${esc(fmtDate(a.date))} às ${a.start}${detail ? `<br><span class="muted small">${detail}</span>` : ''}</p>
      ${notice}
      ${actions ? `<div style="margin-top:16px">${actions}</div>` : ''}
    </div>`;

  $('#leave-queue')?.addEventListener('click', async () => {
    if (!confirm('Sair da fila de espera deste horário?')) return;
    try {
      renderLookup(await http('POST', '/api/appointments/cancel', lookupCreds));
      toast('Você saiu da fila de espera.', 'ok');
    } catch (e) { toast(e.message, 'error'); }
  });

  const form = $('#cancel-form');
  if (!form) return;
  const reason = $('#c-reason');
  $('#cancel-open').addEventListener('click', () => {
    $('#cancel-open').classList.add('hidden');
    form.classList.remove('hidden');
    reason.focus();
  });
  $('#cancel-back').addEventListener('click', () => {
    form.classList.add('hidden');
    $('#cancel-open').classList.remove('hidden');
  });
  $$('.reason-chip', form).forEach(chip => chip.addEventListener('click', () => {
    reason.value = chip.dataset.reason;
    reason.classList.remove('invalid');
    $$('.reason-chip', form).forEach(c => c.setAttribute('aria-pressed', c === chip));
  }));
  reason.addEventListener('input', () => {
    reason.classList.remove('invalid');
    $$('.reason-chip', form).forEach(c => c.setAttribute('aria-pressed', c.dataset.reason === reason.value));
  });
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    if (reason.value.trim().length < 3) {
      reason.classList.add('invalid');
      reason.focus();
      toast('Conte o motivo do cancelamento.', 'error');
      return;
    }
    const btn = $('#cancel-confirm');
    btn.disabled = true;
    btn.textContent = 'Cancelando…';
    try {
      const r = await http('POST', '/api/appointments/cancel', { ...lookupCreds, reason: reason.value.trim() });
      renderLookup(r, r.notify);
      loadSlots(); // o horário voltou a ficar livre (ou foi para alguém da fila)
    } catch (e) {
      toast(e.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Confirmar cancelamento';
    }
  });
}

/** Do aviso de "agendamento confirmado" direto para o cancelamento. */
function cancelFromSuccess() {
  if (!lastBooking) return;
  $('#l-code').value = lastBooking.code;
  $('#l-phone').value = lastBooking.phone;
  $('#meu-agendamento').scrollIntoView();
  lookup(null, { openCancel: true });
}

function renderLocation() {
  const s = info.settings;
  const q = encodeURIComponent(s.address);
  $('#map').src = `https://maps.google.com/maps?q=${q}&z=16&output=embed`;
  $('#directions').href = `https://www.google.com/maps/dir/?api=1&destination=${q}`;
  if (s.whatsapp) $('#whats-link').href = `https://wa.me/${s.whatsapp}`;
  else $('#whats-link').remove();
  if (s.instagram) {
    const handle = s.instagram.replace(/^@/, '');
    $('#insta-wrap').innerHTML = ` · <a href="https://instagram.com/${encodeURIComponent(handle)}" target="_blank" rel="noopener">@${esc(handle)}</a>`;
  }
  const today = new Date().getDay();
  const order = [1, 2, 3, 4, 5, 6, 0];
  $('#hours').innerHTML = order.map(wd => {
    const h = info.hours[wd];
    return `<tr class="${wd === today ? 'today' : ''}"><td>${WEEKDAYS[wd]}</td><td>${h ? `${h.open} – ${h.close}` : 'Fechado'}</td></tr>`;
  }).join('');
}

init();
