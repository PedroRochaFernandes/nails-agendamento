// Painel do dono: agenda, serviços/preços, profissionais/expediente, bloqueios e configurações
let token = null;
try { token = sessionStorage.getItem('adminToken'); } catch {}
let services = [], pros = [];

const api = (method, url, body) => http(method, url, body, token).catch(err => {
  if (err.status === 401 && !url.endsWith('/login')) showLogin();
  throw err;
});

// ------------------------------------------------------------- login
function showLogin() {
  token = null;
  try { sessionStorage.removeItem('adminToken'); } catch {}
  $('#app-view').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
}

$('#login-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  try {
    ({ token } = await http('POST', '/api/admin/login', { password: $('#password').value }));
    try { sessionStorage.setItem('adminToken', token); } catch {}
    $('#password').value = '';
    start();
  } catch (e) { toast(e.message, 'error'); }
});

$('#logout').addEventListener('click', async () => {
  await api('POST', '/api/admin/logout').catch(() => {});
  showLogin();
});

async function start() {
  try {
    [services, pros] = await Promise.all([api('GET', '/api/admin/services'), api('GET', '/api/admin/pros')]);
  } catch { return; }
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  const s = await api('GET', '/api/admin/settings');
  $('#shop-name').textContent = s.shop_name;
  fillSettings(s);
  fillProSelects();
  if (!$('#agenda-date').value) $('#agenda-date').value = localDate();
  loadAgenda();
  renderServices();
  renderPros();
  loadBlocks();
}

// ------------------------------------------------------------- abas
$$('.tab').forEach(t => t.addEventListener('click', () => {
  $$('.tab').forEach(x => x.setAttribute('aria-selected', x === t));
  $$('.panel').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== t.dataset.tab));
}));

function fillProSelects() {
  const opts = pros.filter(b => b.active).map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
  $('#agenda-pro').innerHTML = `<option value="">Todas as profissionais</option>${opts}`;
  $('#b-pro').innerHTML = `<option value="">Todo o estúdio</option>${opts}`;
  $('#m-pro').innerHTML = `<option value="">Qualquer um livre</option>${opts}`;
  $('#m-service').innerHTML = services.filter(s => s.active)
    .map(s => `<option value="${s.id}">${esc(s.name)} — ${money(s.price_cents)} (${fmtDuration(s.duration_min)})</option>`).join('');
}

// ------------------------------------------------------------- agenda
async function loadAgenda() {
  const date = $('#agenda-date').value;
  const proId = Number($('#agenda-pro').value) || null;
  let list = await api('GET', `/api/admin/appointments?from=${date}&to=${date}`);
  if (proId) list = list.filter(a => a.proId === proId);

  $('#agenda-title').textContent = fmtDate(date);
  const active = list.filter(a => a.status !== 'cancelled');
  const revenue = active.filter(a => a.status !== 'no_show').reduce((t, a) => t + a.priceCents, 0);
  const done = list.filter(a => a.status === 'completed');
  $('#stats').innerHTML = `
    <div class="card stat"><span class="muted small">Agendamentos</span><b>${active.length}</b></div>
    <div class="card stat"><span class="muted small">Atendidos</span><b>${done.length}</b></div>
    <div class="card stat"><span class="muted small">Faturamento previsto</span><b>${money(revenue)}</b></div>
    <div class="card stat"><span class="muted small">Já faturado</span><b>${money(done.reduce((t, a) => t + a.priceCents, 0))}</b></div>`;

  $('#agenda-list').innerHTML = list.length ? list.map(a => `
    <div class="appt ${a.status}">
      <div class="time">${a.start}<div class="muted small" style="font-weight:400">${a.end}</div></div>
      <div>
        <strong>${esc(a.customerName)}</strong>${a.fromWaitlist ? ' <span class="tag">veio da fila de espera</span>' : ''}
        <a class="small" href="https://wa.me/${waNumber(a.customerPhone)}" target="_blank" rel="noopener">${fmtPhone(a.customerPhone)}</a><br>
        <span class="muted small">${esc(a.serviceName)} · ${esc(a.proName)} · ${money(a.priceCents)} · cód. ${a.code}</span>
        ${a.notes ? `<div class="small muted" style="margin-top:4px">Obs.: ${esc(a.notes)}</div>` : ''}
        ${a.status === 'cancelled' && a.cancelledBy ? `<div class="small cancel-why">Cancelado ${a.cancelledBy === 'cliente' ? 'pela cliente' : 'pelo estúdio'}${a.cancelReason ? ` · Motivo: ${esc(a.cancelReason)}` : ''}</div>` : ''}
      </div>
      <div class="appt-actions">
        ${a.status === 'confirmed' ? `<button class="btn btn-sm btn-danger" data-cancel="${a.id}">Cancelar</button>` : ''}
        <select data-status="${a.id}" aria-label="Status">
          ${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}" ${k === a.status ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
      </div>
    </div>`).join('') : '<div class="empty" style="border:0">Nenhum agendamento neste dia.</div>';

  const byId = Object.fromEntries(list.map(a => [a.id, a]));
  $$('[data-cancel]').forEach(b => b.addEventListener('click', () => openCancel(byId[b.dataset.cancel])));
  $$('[data-status]').forEach(sel => sel.addEventListener('change', async () => {
    const a = byId[sel.dataset.status];
    if (sel.value === 'cancelled') { // cancelar sempre passa pela janela do motivo
      sel.value = a.status;
      return openCancel(a);
    }
    try {
      await api('PATCH', `/api/admin/appointments/${a.id}`, { status: sel.value });
      toast('Status atualizado', 'ok');
    } catch (e) { toast(e.message, 'error'); }
    loadAgenda();
  }));

  loadWaitlist();
}

// ----- cancelar pelo estúdio: motivo (opcional) e mensagem pronta para o cliente
let cancelling = null;
function openCancel(a) {
  cancelling = a;
  $('#cx-info').textContent = `${a.customerName} · ${fmtDate(a.date)} às ${a.start} · ${a.serviceName} com ${a.proName}`;
  $('#cx-reason').value = '';
  $('#cancel-form').classList.remove('hidden');
  $('#cancel-done').classList.add('hidden');
  $('#cancel-modal').classList.remove('hidden');
  $('#cx-reason').focus();
}
function closeCancel() {
  $('#cancel-modal').classList.add('hidden');
  cancelling = null;
}
$('#cx-back').addEventListener('click', closeCancel);
$('#cx-close').addEventListener('click', closeCancel);
$('#cancel-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  const btn = $('#cx-confirm');
  btn.disabled = true;
  try {
    const r = await api('PATCH', `/api/admin/appointments/${cancelling.id}`, { status: 'cancelled', reason: $('#cx-reason').value });
    $('#cancel-form').classList.add('hidden');
    $('#cancel-done').classList.remove('hidden');
    $('#cx-done-text').textContent = r.filaOcupou
      ? `O horário já foi passado para ${r.filaOcupou}, que estava na fila de espera. Agora avise ${firstName(r.customerName)}:`
      : `Agora avise ${firstName(r.customerName)}. O WhatsApp abre com a mensagem pronta:`;
    $('#cx-preview').textContent = r.notify.texto;
    $('#cx-whats').href = r.notify.url;
    $('#cx-whats').textContent = `Avisar ${firstName(r.customerName)} no WhatsApp`;
    loadAgenda();
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; }
});

// ----- fila de espera
async function loadWaitlist() {
  const date = $('#agenda-date').value;
  const proId = Number($('#agenda-pro').value) || null;
  const { waiting, toNotify, cancellations } = await api('GET', '/api/admin/waitlist');

  // Clientes que cancelaram pelo site (aparece mesmo que o cliente não tenha mandado o WhatsApp)
  const cancelAlerts = cancellations.map(a => `<div class="alert alert-cancel">
      <div><strong>${esc(a.customerName)} cancelou</strong> <span class="tag tag-cancel">cancelado pela cliente</span><br>
        <span class="muted small">${esc(fmtDate(a.date))} às ${a.start} · ${esc(a.serviceName)} com ${esc(a.proName)}</span><br>
        <span class="small">Motivo: ${esc(a.cancelReason)}</span></div>
      <button class="btn btn-sm" data-seen="${a.id}">Ok, visto</button>
    </div>`).join('');

  // Quem ganhou um horário que vagou já está na agenda; falta o dono avisar (um clique no WhatsApp)
  $('#waitlist-alerts').innerHTML = cancelAlerts + toNotify.map(a => {
    const msg = `Olá, ${a.customerName}! Boa notícia: o horário das ${a.start} de ${fmtDate(a.date)} vagou e seu agendamento ` +
      `(${a.serviceName} com ${a.proName}) está confirmado na ${$('#shop-name').textContent}. Código: ${a.code}. ` +
      'Se não puder vir, é só cancelar pelo site ou responder esta mensagem.';
    return `<div class="alert">
      <div><strong>Vaga liberada para ${esc(a.customerName)}</strong> <span class="tag">fila de espera</span><br>
        <span class="muted small">${esc(fmtDate(a.date))} às ${a.start} · ${esc(a.serviceName)} com ${esc(a.proName)} · já está na agenda. Avise a cliente.</span></div>
      <a class="btn btn-primary btn-sm" data-notify="${a.waitId}" target="_blank" rel="noopener"
         href="https://wa.me/${waNumber(a.customerPhone)}?text=${encodeURIComponent(msg)}">Avisar no WhatsApp</a>
      <button class="btn btn-sm" data-notify="${a.waitId}">Já avisei</button>
    </div>`;
  }).join('');
  $$('[data-notify]').forEach(el => el.addEventListener('click', async () => {
    await api('POST', `/api/admin/waitlist/${el.dataset.notify}/notified`).catch(() => {});
    loadWaitlist();
  }));
  $$('[data-seen]').forEach(el => el.addEventListener('click', async () => {
    await api('POST', `/api/admin/appointments/${el.dataset.seen}/seen`).catch(() => {});
    loadWaitlist();
  }));

  // Quem ainda está aguardando no dia selecionado
  const day = waiting.filter(w => w.date === date && (!proId || !w.proId || w.proId === proId));
  const others = waiting.length - waiting.filter(w => w.date === date).length;
  $('#waitlist-day').innerHTML = (day.length ? day.map(w => `
    <div class="appt">
      <div class="time">${w.start}<div class="muted small" style="font-weight:400">${w.position}º da fila</div></div>
      <div>
        <strong>${esc(w.customerName)}</strong>
        <a class="small" href="https://wa.me/${waNumber(w.customerPhone)}" target="_blank" rel="noopener">${fmtPhone(w.customerPhone)}</a><br>
        <span class="muted small">${esc(w.serviceName)} · ${w.proName ? 'com ' + esc(w.proName) : 'qualquer profissional'} · cód. ${w.code}</span>
        ${w.notes ? `<div class="small muted" style="margin-top:4px">Obs.: ${esc(w.notes)}</div>` : ''}
      </div>
      <button class="btn btn-sm btn-danger" data-unwait="${w.id}">Remover</button>
    </div>`).join('') : '<div class="empty" style="border:0">Ninguém na fila de espera neste dia.</div>') +
    (others ? `<div class="muted small" style="padding:10px 16px;border-top:1px solid var(--border)">+ ${others} na fila em outros dias.</div>` : '');
  $$('[data-unwait]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Remover este cliente da fila de espera?')) return;
    await api('DELETE', `/api/admin/waitlist/${b.dataset.unwait}`);
    loadWaitlist();
  }));
}

const shiftDay = n => { $('#agenda-date').value = addDays($('#agenda-date').value || localDate(), n); loadAgenda(); };
$('#day-prev').addEventListener('click', () => shiftDay(-1));
$('#day-next').addEventListener('click', () => shiftDay(1));
$('#day-today').addEventListener('click', () => { $('#agenda-date').value = localDate(); loadAgenda(); });
$('#agenda-date').addEventListener('change', loadAgenda);
$('#agenda-pro').addEventListener('change', loadAgenda);

// ----- novo agendamento manual
maskPhone($('#m-phone'));
$('#new-appt').addEventListener('click', () => {
  $('#appt-form').reset();
  $('#m-date').value = $('#agenda-date').value || localDate();
  $('#appt-modal').classList.remove('hidden');
  loadModalSlots();
});
$('#m-cancel').addEventListener('click', () => $('#appt-modal').classList.add('hidden'));
['#m-service', '#m-pro', '#m-date'].forEach(s => $(s).addEventListener('change', loadModalSlots));

async function loadModalSlots() {
  const sel = $('#m-time');
  sel.innerHTML = '<option value="">Carregando…</option>';
  const params = new URLSearchParams({ date: $('#m-date').value, serviceId: $('#m-service').value, proId: $('#m-pro').value });
  try {
    const slots = (await api('GET', `/api/admin/availability?${params}`)).slots.filter(s => s.available);
    sel.innerHTML = slots.length
      ? slots.map(s => `<option value="${s.time}">${s.time}</option>`).join('')
      : '<option value="">Sem horários livres</option>';
  } catch (e) { sel.innerHTML = `<option value="">${esc(e.message)}</option>`; }
}

$('#appt-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  try {
    const a = await api('POST', '/api/admin/appointments', {
      serviceId: $('#m-service').value, proId: $('#m-pro').value || null, date: $('#m-date').value,
      time: $('#m-time').value, name: $('#m-name').value, phone: $('#m-phone').value, notes: $('#m-notes').value,
    });
    toast(`Agendado com ${a.proName} às ${a.start}`, 'ok');
    $('#appt-modal').classList.add('hidden');
    $('#agenda-date').value = a.date;
    loadAgenda();
  } catch (e) { toast(e.message, 'error'); loadModalSlots(); }
});

// ------------------------------------------------------------- serviços
function renderServices() {
  $('#services-table tbody').innerHTML = services.map(s => serviceRow(s)).join('');
}
function serviceRow(s) {
  return `<tr data-id="${s.id ?? ''}">
    <td><input name="name" value="${esc(s.name)}" placeholder="Ex.: Manicure" required></td>
    <td><input name="description" value="${esc(s.description)}" placeholder="Detalhes"></td>
    <td><input name="price" type="number" min="0" step="0.01" value="${(s.price_cents / 100).toFixed(2)}"></td>
    <td><input name="duration_min" type="number" min="5" step="5" value="${s.duration_min}"></td>
    <td><input name="active" type="checkbox" ${s.active ? 'checked' : ''}></td>
    <td style="white-space:nowrap">
      <button class="btn btn-sm btn-primary" data-save>Salvar</button>
      <button class="btn btn-sm btn-danger" data-del aria-label="Excluir">✕</button>
    </td></tr>`;
}
$('#add-service').addEventListener('click', () => {
  $('#services-table tbody').insertAdjacentHTML('beforeend', serviceRow({ name: '', description: '', price_cents: 0, duration_min: 30, active: 1 }));
  $('#services-table tbody tr:last-child input').focus();
});
$('#services-table').addEventListener('click', async ev => {
  const tr = ev.target.closest('tr');
  if (!tr) return;
  const id = tr.dataset.id;
  const val = n => tr.querySelector(`[name="${n}"]`);
  if (ev.target.matches('[data-save]')) {
    const body = {
      name: val('name').value, description: val('description').value,
      price_cents: Math.round(Number(val('price').value) * 100), duration_min: Number(val('duration_min').value),
      active: val('active').checked, sort: id ? services.find(s => s.id == id)?.sort : services.length,
    };
    try {
      await api(id ? 'PUT' : 'POST', `/api/admin/services${id ? '/' + id : ''}`, body);
      toast('Serviço salvo', 'ok');
      await refreshServices();
    } catch (e) { toast(e.message, 'error'); }
  }
  if (ev.target.matches('[data-del]')) {
    if (!id) { tr.remove(); return; }
    if (!confirm('Excluir este serviço?')) return;
    const r = await api('DELETE', `/api/admin/services/${id}`);
    toast(r.deactivated ? 'Serviço tem histórico: foi desativado' : 'Serviço excluído', 'ok');
    await refreshServices();
  }
});
async function refreshServices() {
  services = await api('GET', '/api/admin/services');
  renderServices();
  fillProSelects();
}

// ------------------------------------------------------------- profissionais
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
function renderPros() {
  $('#pros-list').innerHTML = pros.map(b => proCard(b)).join('') ||
    '<div class="empty">Nenhuma profissional cadastrada.</div>';
}
function proCard(b) {
  const hours = Object.fromEntries((b.hours || []).map(h => [h.weekday, h]));
  return `<form class="card pro-card" data-id="${b.id ?? ''}">
    <header>
      <div class="field"><label>Nome</label><input name="name" value="${esc(b.name)}" required></div>
      <div class="field"><label>WhatsApp (recebe os cancelamentos)</label><input name="whatsapp" value="${esc(b.whatsapp ? fmtPhone(b.whatsapp) : '')}" inputmode="tel" placeholder="(11) 91234-5678"></div>
      <label class="check"><input type="checkbox" name="active" ${b.active ? 'checked' : ''}> Ativo (aparece no site)</label>
    </header>
    <p class="muted small" style="margin:-4px 0 12px">Quando uma cliente desta profissional cancelar, o aviso vai para este número. Sem número, vai para o WhatsApp do estúdio. A cliente vê o número ao enviar a mensagem.</p>
    <div class="scroll-x"><table class="grid">
      <thead><tr><th>Dia</th><th>Trabalha</th><th>Início</th><th>Fim</th><th>Intervalo de</th><th>até</th></tr></thead>
      <tbody>${DAY_ORDER.map(wd => {
        const h = hours[wd];
        return `<tr data-wd="${wd}">
          <td>${WEEKDAYS[wd]}</td>
          <td><input type="checkbox" name="on" ${h ? 'checked' : ''}></td>
          <td><input type="time" name="start" value="${h?.start || '09:00'}"></td>
          <td><input type="time" name="end" value="${h?.end || '19:00'}"></td>
          <td><input type="time" name="breakStart" value="${h ? h.breakStart : '12:00'}"></td>
          <td><input type="time" name="breakEnd" value="${h ? h.breakEnd : '13:00'}"></td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>
    <div style="display:flex;gap:10px;margin-top:12px">
      <button class="btn btn-primary btn-sm">Salvar</button>
      <button type="button" class="btn btn-danger btn-sm" data-del>Excluir</button>
    </div>
  </form>`;
}
$('#add-pro').addEventListener('click', () => {
  $('#pros-list .empty')?.remove();
  $('#pros-list').insertAdjacentHTML('beforeend', proCard({ name: '', active: 1, hours: [] }));
  $('#pros-list form:last-child input[name="name"]').focus();
});
$('#pros-list').addEventListener('submit', async ev => {
  ev.preventDefault();
  const form = ev.target, id = form.dataset.id;
  const hours = $$('tbody tr', form).filter(tr => $('[name="on"]', tr).checked).map(tr => ({
    weekday: Number(tr.dataset.wd), start: $('[name="start"]', tr).value, end: $('[name="end"]', tr).value,
    breakStart: $('[name="breakStart"]', tr).value, breakEnd: $('[name="breakEnd"]', tr).value,
  }));
  try {
    await api(id ? 'PUT' : 'POST', `/api/admin/pros${id ? '/' + id : ''}`,
      { name: form.elements.name.value, whatsapp: form.elements.whatsapp.value, active: form.elements.active.checked, hours });
    toast('Profissional salva', 'ok');
    await refreshPros();
  } catch (e) { toast(e.message, 'error'); }
});
$('#pros-list').addEventListener('click', async ev => {
  if (!ev.target.matches('[data-del]')) return;
  const form = ev.target.closest('form'), id = form.dataset.id;
  if (!id) { form.remove(); return; }
  if (!confirm('Excluir esta profissional?')) return;
  const r = await api('DELETE', `/api/admin/pros/${id}`);
  toast(r.deactivated ? 'Profissional tem histórico: foi desativada' : 'Profissional excluída', 'ok');
  await refreshPros();
});
async function refreshPros() {
  pros = await api('GET', '/api/admin/pros');
  renderPros();
  fillProSelects();
  loadAgenda();
}

// ------------------------------------------------------------- bloqueios
$('#b-allday').addEventListener('change', e => {
  $('#b-start').disabled = $('#b-end').disabled = e.target.checked;
});
$('#block-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  try {
    const r = await api('POST', '/api/admin/blocks', {
      date: $('#b-date').value, proId: $('#b-pro').value || null, allDay: $('#b-allday').checked,
      start: $('#b-start').value, end: $('#b-end').value, reason: $('#b-reason').value,
    });
    if (r.affected.length) {
      alert(`Atenção: ${r.affected.length} cliente(s) já marcado(s) nesse período:\n\n` +
        r.affected.map(a => `${a.start} — ${a.customerName} (${fmtPhone(a.customerPhone)}) com ${a.proName}`).join('\n') +
        '\n\nAvise-os e cancele/remarque pela Agenda.');
    } else toast('Bloqueio adicionado', 'ok');
    $('#block-form').reset();
    $('#b-start').disabled = $('#b-end').disabled = false;
    loadBlocks();
  } catch (e) { toast(e.message, 'error'); }
});
async function loadBlocks() {
  const list = await api('GET', '/api/admin/blocks');
  $('#blocks-list').innerHTML = list.length ? list.map(k => `
    <div class="appt" style="grid-template-columns:1fr auto">
      <div><strong>${esc(fmtDate(k.date, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }))}</strong>
        · ${k.start_min === 0 && k.end_min === 1440 ? 'Dia inteiro' : `${k.start}–${k.end}`}<br>
        <span class="muted small">${esc(k.pro_name || 'Todo o estúdio')}${k.reason ? ' · ' + esc(k.reason) : ''}</span></div>
      <button class="btn btn-sm btn-danger" data-block="${k.id}">Remover</button>
    </div>`).join('') : '<div class="empty" style="border:0">Nenhum bloqueio futuro.</div>';
  $$('[data-block]').forEach(b => b.addEventListener('click', async () => {
    await api('DELETE', `/api/admin/blocks/${b.dataset.block}`);
    loadBlocks();
    loadAgenda(); // remover um bloqueio pode liberar vaga para alguém da fila de espera
  }));
}

// ------------------------------------------------------------- configurações
function fillSettings(s) {
  for (const [k, v] of Object.entries(s)) {
    const el = $(`#settings-form [name="${k}"]`);
    if (el) el.value = v;
  }
}
$('#settings-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  const body = Object.fromEntries(new FormData(ev.target));
  try {
    await api('PUT', '/api/admin/settings', body);
    $('#shop-name').textContent = body.shop_name;
    toast('Configurações salvas', 'ok');
  } catch (e) { toast(e.message, 'error'); }
});
$('#password-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  try {
    await api('POST', '/api/admin/password', { current: $('#p-current').value, next: $('#p-next').value });
    ev.target.reset();
    toast('Senha alterada', 'ok');
  } catch (e) { toast(e.message, 'error'); }
});

if (token) start(); else showLogin();
