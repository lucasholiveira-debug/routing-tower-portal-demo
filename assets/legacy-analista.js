const RT_PANEL_BUILD_VERSION = "1.8.4";
const RT_PANEL_BUILD_ID = "20261019-control-reads";

(() => {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const memory = new Map(), pending = new Map();
  const prefix = 'rt-public-controls-v1:';
  const paths = {
    '/storage/v1/object/public/routing-tower-portals/status/manutencao.json': 'maintenance',
    '/storage/v1/object/public/routing-tower-portals/extension-updates/latest.json': 'release'
  };
  function read(key) {
    try { return JSON.parse(localStorage.getItem(key)) || memory.get(key); }
    catch (_) { return memory.get(key); }
  }
  function write(key, value) {
    memory.set(key, value);
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
  }
  function response(record) {
    return new Response(record.body, {status: 200, headers: {'Content-Type':'application/json','X-RT-Control-Cache':'hit'}});
  }
  globalThis.fetch = async function(input, options = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const kind = paths[url.pathname];
    if (url.origin !== 'https://demo.invalid' || !kind ||
        String(options.method || input?.method || 'GET').toUpperCase() !== 'GET') return nativeFetch(input, options);
    const key = prefix + kind;
    if (pending.has(key)) return (await pending.get(key)).clone();
    const task = async () => {
      const now = Date.now(), old = read(key);
      if (old && old.until > now && typeof old.body === 'string') return response(old);
      if (old && old.retryAt > now) return new Response('{"message":"VerificaÃ§Ã£o temporariamente indisponÃ­vel"}', {status:503});

      url.search = '';
      url.searchParams.set('rt_client', location.protocol === 'chrome-extension:' ? 'extension' : 'local-panel');
      url.searchParams.set('rt_build', '20261019-control-reads');
      url.searchParams.set('rt_panel', location.pathname.includes('supervisor') ? 'supervisor' : 'analyst');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const result = await nativeFetch(url.href, {...options, cache:'no-cache', signal:controller.signal});
        if (!result.ok) throw new Error('HTTP ' + result.status);
        const body = await result.text(), value = JSON.parse(body);
        if (kind === 'maintenance' ? typeof value?.ativo !== 'boolean' :
            value?.format !== 'routing-tower-extension-update-v1' || typeof value.version !== 'string' || !value.files) throw new Error('Invalid control file');
        const ttl = kind === 'release' ? 1800000 : value.ativo ? 30000 : 300000;
        write(key, {body, until:Date.now()+ttl, retryAt:0});
        return new Response(body, {status:200,headers:{'Content-Type':'application/json'}});
      } catch (_) {
        write(key, {body:old?.body, until:0, retryAt:Date.now()+60000});
        return new Response('{"message":"VerificaÃ§Ã£o temporariamente indisponÃ­vel"}', {status:503});
      } finally { clearTimeout(timer); }
    };

    const work = globalThis.navigator?.locks?.request
      ? navigator.locks.request(key, task) : task();
    pending.set(key, work);
    try { return (await work).clone(); } finally { pending.delete(key); }
  };
})();

(() => {
  const MAX_AGE = 24 * 60 * 60000;
  const prefix = 'rt-read-cache-v1:';
  const pending = new Map();
  let context = null, memory = null, generation = 0, dbPromise;
  function database() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(resolve => {
      if (!globalThis.indexedDB) return resolve(null);
      let settled = false;
      const finish = db => { if (!settled) { settled = true; clearTimeout(timer); resolve(db); } else db?.close(); };
      const timer = setTimeout(() => finish(null), 1500);
      try {
        const req = indexedDB.open('rt-read-cache', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('panels');
        req.onsuccess = () => finish(req.result);
        req.onerror = req.onblocked = () => finish(null);
      } catch (_) { finish(null); }
    });
    return dbPromise;
  }
  async function disk(action, key, value) {
    const db = await database();
    if (!db) return null;
    return new Promise(resolve => {
      let result = null;
      const timer = setTimeout(() => resolve(null), 1500);
      try {
        const tx = db.transaction('panels', action === 'get' ? 'readonly' : 'readwrite');
        const store = tx.objectStore('panels');
        const req = action === 'put' ? store.put(value, key) : store[action](key);
        req.onsuccess = () => { result = action === 'get' ? req.result : true; };
        tx.oncomplete = () => { clearTimeout(timer); resolve(result); };
        tx.onerror = tx.onabort = () => { clearTimeout(timer); resolve(null); };
      } catch (_) { clearTimeout(timer); resolve(null); }
    });
  }
  function banner(at, fallback) {
    let box = document.getElementById('rt-cache-status');
    if (!box) {
      box = document.createElement('div'); box.id = 'rt-cache-status';
      box.setAttribute('role', 'status');
      box.style.cssText = 'padding:12px 20px;background:#fff3cd;color:#513d00;font:14px system-ui;';
      document.body.prepend(box);
    }
    box.textContent = `${fallback ? 'Servidor indisponível. Últimos dados locais' : 'Últimos dados locais'} de ${new Date(at).toLocaleString('pt-BR')}. Podem estar desatualizados. A atualização será tentada automaticamente.`;
  }
  async function clear() {
    generation++;
    const ctx = context;
    memory = null;
    if (!ctx) return;
    try { localStorage.removeItem(prefix + ctx.panel); } catch (_) {}
    await disk('delete', ctx.panel);
  }
  async function begin(panel, token) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(location.origin + '|' + panel + '|' + token));
    const identity = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2,'0')).join('');
    if (context?.panel === panel && context.identity === identity) return;
    generation++;
    const ctx = context = {panel, identity};
    memory = null;
    let saved = await disk('get', panel);
    if (!saved) { try { saved = JSON.parse(localStorage.getItem(prefix + panel)); } catch (_) {} }
    if (context !== ctx) return;
    if (saved?.identity === identity && saved.entries) memory = saved;
    else await clear();
    document.getElementById('rt-cache-status')?.remove();
  }
  function transient(status) { return status === 408 || status === 429 || status >= 500; }
  async function request(name, network, preferCache, valid, primary=false) {
    const ctx = context, epoch = generation;
    if (!ctx) throw new Error('Cache sem contexto de acesso.');
    const existing = memory?.entries?.[name];
    const age = existing ? Date.now() - existing.at : Infinity;
    const usable = existing && age >= 0 && age <= MAX_AGE && valid(existing.data);
    function cached(fallback) {
      if (primary) banner(existing.at, fallback);
      return new Response(JSON.stringify(existing.data), {status:200, headers:{'Content-Type':'application/json','X-RT-Cache':fallback ? 'fallback' : 'bootstrap'}});
    }
    if (preferCache && usable) return cached(false);
    const key = ctx.identity + ':' + epoch + ':' + name;
    if (pending.has(key)) return (await pending.get(key)).clone();
    const task = (async () => {
      try {
        const response = await network();
        if (context !== ctx || generation !== epoch) throw Object.assign(new Error('Acesso alterado.'), {name:'AbortError', stale:true});
        if (response.status === 401 || response.status === 403) { await clear(); return response; }
        if (response.ok) {
          const data = await response.clone().json();

          if (primary && data === null) { await clear(); return new Response(null, {status:403}); }
          if (!valid(data)) throw Object.assign(new Error('Resposta inválida do servidor.'), {status:502});
          if (context !== ctx || generation !== epoch) throw Object.assign(new Error('Acesso alterado.'), {stale:true});
          const saved = memory || {identity:ctx.identity,entries:{}};
          saved.entries[name] = {at:Date.now(),data};
          memory = saved;
          const persisted = await disk('put', ctx.panel, saved);
          if (!persisted && context === ctx && generation === epoch) {
            try { localStorage.setItem(prefix + ctx.panel, JSON.stringify(saved)); }
            catch (_) { if (primary) { banner(saved.entries[name].at, false); document.getElementById('rt-cache-status').textContent = 'Dados atualizados, mas o navegador não permitiu guardar a cópia local. Mantenha esta aba aberta durante a indisponibilidade.'; } }
          }
          if (primary && persisted) document.getElementById('rt-cache-status')?.remove();
          return response;
        }
        if (usable && transient(response.status)) return cached(true);
        return response;
      } catch (error) {
        if (error.stale || context !== ctx || generation !== epoch) throw error;
        if (usable && (transient(Number(error.status)) || error.name === 'AbortError' || error instanceof SyntaxError || /failed to fetch|networkerror|load failed|network request failed/i.test(error.message))) return cached(true);
        throw error;
      }
    })();
    pending.set(key, task);
    try { return (await task).clone(); } finally { pending.delete(key); }
  }
  function peek(name, valid) {
    const entry = memory?.entries?.[name];
    const age = entry ? Date.now() - entry.at : Infinity;
    return entry && age >= 0 && age <= MAX_AGE && valid(entry.data) ? structuredClone(entry.data) : undefined;
  }

  globalThis.rtReadCache = {begin,request,clear,peek};
})();









const SUPABASE_URL = window.RT_PANEL_CONFIG?.supabaseUrl || "https://demo.invalid";
const SUPABASE_ANON_KEY = "demo-no-api-key";







const ROMANEIO_VALIDATION_ENDPOINT = "https://demo.invalid/disabled-script";





const ROMANEIO_VALIDATION_ENABLED = true;

let extensionToken = "";
let state = null;
let occurrenceTypes = [];
let snapshotRevision = null;
let revisionCheckRunning = false;
const AUTO_REVISION_MIN_INTERVAL_MS = 5 * 60000;
let lastAutomaticRevisionAt = 0;
let automaticRevisionTimer = null;
let automaticRevisionToken = "";
let realtimeChannel = null;

const headers = { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json", "X-RT-Portal": "web" };
if (SUPABASE_ANON_KEY.startsWith("eyJ")) headers.Authorization = `Bearer ${SUPABASE_ANON_KEY}`;




const sbClient = (!window.RT_WEB_CONTEXT && typeof window !== "undefined" && window.supabase && window.supabase.createClient)
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;






function setupRealtime(token) {
  if (!sbClient || !token) return;
  if (realtimeChannel) {
    sbClient.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
  realtimeChannel = sbClient
    .channel(`portal-analyst:${token}`, { config: { broadcast: { self: false } } })
    .on("broadcast", { event: "revision" }, () => { checkRevision(); })
    .subscribe();
}

const qs = (s) => document.querySelector(s);
const qsa = (s) => [...document.querySelectorAll(s)];
const fmtDate = (v) => v ? new Intl.DateTimeFormat('pt-BR', {day:'2-digit', month:'2-digit', year:'numeric'}).format(new Date(v + 'T12:00:00')) : '—';
const fmtDateTime = (v) => v ? new Intl.DateTimeFormat('pt-BR', {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'}).format(new Date(v)) : '—';
const weekday = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const operationStatuses = [
  ['pending', 'Pendente'],
  ['execution', 'Execução'],
  ['finished', 'Finalizado'],
  ['cancelled_route', 'Roteirização cancelada'],
  ['no_operation', 'Sem operação'],
];




const TERMINAL_OPERATION_STATUSES = new Set(['finished', 'cancelled_route', 'no_operation']);
function isTerminalOperationStatus(value) {
  return TERMINAL_OPERATION_STATUSES.has(safeOperationStatus(value));
}

function api(path) { return `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${path}`; }
function currentToken() { return extensionToken || ""; }

function toast(message) {
  const el = qs('#toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

function empty(text) {
  return `<div class="empty">${text}</div>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function multilineText(value, fallback='Não informado') {
  const text = String(value ?? '').trim();
  if (!text) return escapeHtml(fallback);
  return escapeHtml(text).replace(/\r?\n/g, '<br>');
}

function shortText(value, fallback='Não informado') {
  return escapeHtml(String(value ?? '').trim() || fallback);
}

function safeOperationStatus(value) {
  return operationStatuses.some(([key]) => key === value) ? value : 'pending';
}

function operationLabel(value) {
  const row = operationStatuses.find(([key]) => key === safeOperationStatus(value));
  return row ? row[1] : 'Pendente';
}

function hasRomaneio(assignment) {
  return Boolean(String(assignment?.romaneio_url || '').trim());
}



function hasCancellationReason(assignment) {
  return Boolean(String(assignment?.cancellation_reason || '').trim());
}

function operationControl(assignment) {
  const value = safeOperationStatus(assignment.operation_status);
  const locked = !hasRomaneio(assignment);
  const cancelLocked = !hasCancellationReason(assignment);
  const options = operationStatuses
    .map(([key, label]) => {
      const disable = (key === 'finished' && locked) || (key === 'cancelled_route' && cancelLocked);
      const hint = key === 'finished' && disable ? ' title="Cole o link do Romaneio nesta operação para poder finalizar"'
        : key === 'cancelled_route' && disable ? ' title="Informe a justificativa do cancelamento nesta operação"'
        : '';
      const suffix = key === 'finished' && disable ? ' (cole o Romaneio)' : key === 'cancelled_route' && disable ? ' (informe o motivo)' : '';
      return `<option value="${key}" ${key === value ? 'selected' : ''} ${disable ? 'disabled' : ''}${hint}>${label}${suffix}</option>`;
    })
    .join('');
  return `
    <label class="op-status op-${value}">
      <span>Status da operação</span>
      <select data-operation-status="${assignment.id}" data-locked-finish="${locked ? '1' : '0'}" data-locked-cancel="${cancelLocked ? '1' : '0'}" aria-label="Status da operação de ${assignment.station_id || assignment.title || 'atividade'}">
        ${options}
      </select>
      ${locked ? '<small class="op-lock-hint">Só é possível finalizar depois de colar o link do Romaneio na operação.</small>' : ''}
      ${cancelLocked ? '<small class="op-lock-hint">Só é possível marcar "Roteirização cancelada" depois de informar o motivo na operação.</small>' : ''}
    </label>`;
}




function operationStatusBadge(assignment) {
  const value = safeOperationStatus(assignment.operation_status);
  return `
    <div class="op-status op-${value}">
      <span>Status da operação</span>
      <strong>${operationLabel(value)}</strong>
    </div>`;
}

function normalizePayload(data) {
  const now = new Date().toISOString();
  return {
    analyst: data?.analyst || {},
    schedule: data?.schedule || null,
    period: data?.period || {},
    month_period: data?.month_period || data?.period || {},
    latest_publication: data?.latest_publication || null,
    publication_read: Boolean(data?.publication_read),
    online_schedule_key: data?.online_schedule_key || data?.schedule_key || null,
    generated_at: data?.generated_at || now,
    assignments: Array.isArray(data?.assignments) ? data.assignments : [],




    weekend_schedule: data?.weekend_schedule || null,
    weekend_assignments: Array.isArray(data?.weekend_assignments) ? data.weekend_assignments : [],
    weekend_latest_publication: data?.weekend_latest_publication || null,
    absences: Array.isArray(data?.absences) ? data.absences : [],
    overtime: Array.isArray(data?.overtime) ? data.overtime : [],
    notifications: Array.isArray(data?.notifications) ? data.notifications : [],
    all_hubs: Array.isArray(data?.all_hubs) ? data.all_hubs : [],
    occurrences: Array.isArray(data?.occurrences) ? data.occurrences : [],
    occurrence_types: Array.isArray(data?.occurrence_types) ? data.occurrence_types : [],
    resources: data?.resources || {},
  };
}





async function postEvent(eventType, eventPayload) {
  const token = currentToken();
  const eventKey = `${token}:${eventType}:${crypto.randomUUID()}`;
  const response = await fetch(api("rpc/rt_submit_portal_event"), {
    method: "POST",
    headers,
    body: JSON.stringify({
      p_token: token,
      p_event_type: eventType,
      p_payload: { portal_token: token, ...eventPayload },
      p_event_key: eventKey,
    }),
  });
  if (!response.ok) {




    const problem = await response.json().catch(() => null);
    throw new Error(problem?.message || "Não consegui enviar sua resposta agora.");
  }
  const delivery = await response.json();
  if (delivery?.event_id) trackEventDelivery(delivery.event_id);
  return delivery;
}

async function trackEventDelivery(eventId, attempts = 0) {
  if (!eventId || attempts >= 24) return;
  try {
    const response = await fetch(api("rpc/rt_get_event_delivery"), {
      method: "POST", headers,
      body: JSON.stringify({ p_token: currentToken(), p_event_id: Number(eventId) }),
    });
    const delivery = response.ok ? await response.json() : null;
    if (delivery?.applied) {
      toast("Aplicado no Routing Tower");
      checkRevision();
      return;
    }
    if (delivery?.status === "dead_letter") {
      qs('#alert-area').innerHTML = `<div class="alert"><span>A alteração não pôde ser aplicada: ${escapeHtml(delivery.last_error || "verifique com o supervisor")}</span></div>`;
      return;
    }
  } catch (_) { /* tenta de novo abaixo */ }
  setTimeout(() => trackEventDelivery(eventId, attempts + 1), 5000);
}





function assignmentCopies(assignmentId) {
  if (assignmentId === null || assignmentId === undefined || assignmentId === '') return [];
  const key = String(assignmentId);
  const copies = [];
  [state.assignments, state.fixed_assignments, state.weekend_assignments].forEach((list) => {
    (list || []).forEach((item) => {
      if (String(item.id) === key && !copies.includes(item)) copies.push(item);
    });
  });
  return copies;
}

function findAssignment(assignmentId) {
  return assignmentCopies(assignmentId)[0] || null;
}

function updateAssignmentCopies(assignmentId, changes) {
  assignmentCopies(assignmentId).forEach((item) => Object.assign(item, changes));
}

async function setOperationStatus(assignmentId, status) {
  const normalized = safeOperationStatus(status);
  const assignment = findAssignment(assignmentId);
  if (!assignment) {
    render();
    toast('Não encontrei esta operação. Atualize a tela e tente de novo.');
    return;
  }

  if (normalized === 'finished' && !hasRomaneio(assignment)) {
    render();
    toast('Cole o link do Romaneio nesta operação antes de finalizar');
    openHub(assignment.hub_id, assignment.id);
    return;
  }


  if (normalized === 'cancelled_route' && !hasCancellationReason(assignment)) {
    render();
    toast('Informe o motivo do cancelamento nesta operação');
    openHub(assignment.hub_id, assignment.id);
    return;
  }







  if (normalized === 'execution' && assignment.operation_status !== 'execution') {
    const start = assignment.start_datetime ? new Date(assignment.start_datetime) : null;
    if (start && !Number.isNaN(start.getTime()) && (start - new Date()) > 20 * 60 * 1000) {
      analystSystemNotify(`analyst-early:${assignmentId}:${Date.now()}`, "Roteirização adiantada",
        `Você iniciou ${assignment.station_id || assignment.hub_name || "esta operação"} com mais de 20 min de antecedência.`);
    }
  }

  const previousStatus = assignment.operation_status;
  updateAssignmentCopies(assignmentId, { operation_status: normalized });




  render();

  try {



    const rpcCall = fetch(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/rt_analyst_set_operation_status`, {
      method: "POST",
      headers,
      body: JSON.stringify({ p_token: currentToken(), p_assignment_id: Number(assignmentId), p_status: normalized }),
    });
    const [, response] = await Promise.all([
      postEvent("operation_status", { assignment_id: Number(assignmentId), status: normalized }),
      rpcCall,
    ]);
    if (!response.ok) {
      const problem = await response.json().catch(() => null);
      throw new Error(problem?.message || 'Não consegui salvar o status agora. Atualize a tela e tente novamente.');
    }
    toast(`Status atualizado para ${operationLabel(normalized)}`);
  } catch (err) {
    updateAssignmentCopies(assignmentId, { operation_status: previousStatus });
    await loadData(true);
    toast(err.message);
  }
}

function bindOperationControls() {
  qsa('[data-operation-status]').forEach((select) => {
    select.onclick = (event) => event.stopPropagation();
    select.onchange = (event) => {
      event.stopPropagation();
      setOperationStatus(select.dataset.operationStatus, select.value);
    };
  });








  qsa('.op-status').forEach((wrap) => {
    const select = wrap.querySelector('select');
    if (!select) return;
    wrap.onclick = (event) => {
      event.stopPropagation();
      if (event.target === select) return;
      if (typeof select.showPicker === 'function') {
        try { select.showPicker(); return; } catch (_) { /* cai no fallback abaixo */ }
      }
      select.focus();
    };
  });
}

let scheduleView = 'fixed';


let weekOffset = 0;




function upcomingSaturdayIso() {

  const day = new Date();
  day.setHours(12, 0, 0, 0);
  day.setDate(day.getDate() + (day.getDay() === 0 ? -1 : 6 - day.getDay()));
  return day.toLocaleDateString('sv-SE');
}

function weekendAssignmentsAhead() {
  const first = upcomingSaturdayIso();
  const key = (x) => String(x.id ?? x.assignment_id ?? `${x.work_date}|${x.start_datetime}|${x.station_id}`);
  const byKey = new Map();
  (state.weekend_assignments || []).forEach((x) => byKey.set(key(x), x));


  const recentEnd = Date.now() - 12 * 3600e3;
  (state.fixed_assignments || []).forEach((x) => {
    const day = String(x.work_date || '').slice(0, 10);
    if (!day) return;
    const stillRunning = new Date(x.end_datetime || x.start_datetime || 0).getTime() >= recentEnd;
    if (day < first && !stillRunning) return;
    const weekday = new Date(`${day}T12:00:00`).getDay();
    if (weekday === 0 || weekday === 6) byKey.set(key(x), x); // a versão ao vivo vale mais
  });
  return [...byKey.values()].sort((a, b) => String(a.start_datetime || '').localeCompare(String(b.start_datetime || '')));
}

function applyScheduleView(type) {
  if (type === 'weekend' && state.weekend_schedule) {
    scheduleView = 'weekend';
    state.assignments = weekendAssignmentsAhead();
    const days = state.assignments.map((x) => String(x.work_date || '').slice(0, 10)).filter(Boolean);
    const firstDay = [String(state.weekend_schedule.start_date || '').slice(0, 10), ...days].filter(Boolean).sort()[0];
    const lastDay = [String(state.weekend_schedule.end_date || '').slice(0, 10), ...days].filter(Boolean).sort().pop();
    state.period = {start: firstDay, end: lastDay};
    state.latest_publication = state.weekend_latest_publication || null;
    state.publication_read = true;
  } else {
    scheduleView = 'fixed';
    state.assignments = state.fixed_assignments || [];
    state.period = state.fixed_period;
    state.latest_publication = state.fixed_latest_publication;
    state.publication_read = state.fixed_publication_read;
  }
}

function updateScheduleTypeTabs() {
  const wrap = qs('#schedule-type-tabs');
  if (!wrap) return;



  const hasWeekendSchedule = Boolean(state.weekend_schedule);
  if (!hasWeekendSchedule && scheduleView === 'weekend') applyScheduleView('fixed');





  const activeView = qs('.view.active')?.id;
  const tabsMatter = activeView === 'view-week' || activeView === 'view-hubs';
  wrap.hidden = !hasWeekendSchedule || !tabsMatter;
  qsa('.schedule-type-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.scheduleType === scheduleView);
  });
}

qsa('.schedule-type-tab').forEach((btn) => {
  btn.onclick = () => {
    applyScheduleView(btn.dataset.scheduleType);
    render();
  };
});

let panelLoad = null, panelLoadToken = null, lastManualLoadAt = 0;
async function loadData(silent=false, preferCache=false) {
  const identity = currentToken();
  if (panelLoad && panelLoadToken === identity) return panelLoad;

  if (readRecovery.waiting() && Date.now() - lastManualLoadAt < 5000) {
    clearTimeout(loadRetryTimer);
    loadRetryTimer = setTimeout(() => loadData(silent, preferCache), Math.max(5000, readRecovery.remainingSeconds() * 1000));
    return;
  }
  lastManualLoadAt = Date.now();
  panelLoadToken = identity;
  const task = loadDataOnce(silent, preferCache);
  panelLoad = task;
  try { return await task; } finally { if (panelLoad === task) panelLoad = null; }
}
async function loadDataOnce(silent=false, preferCache=false) {
  qs('#alert-area').innerHTML = '';
  clearTimeout(loadRetryTimer);
  const token = currentToken();
  if (!token) {
    setConnection(false);
    qs('#alert-area').innerHTML = `<div class="alert"><span>Acesso não configurado. Abra a extensão Routing Tower, clique em "Configurar acesso" e cole a chave individual recebida do supervisor.</span></div>`;
    return;
  }
  await rtReadCache.begin("analista", token);


  if (!state) qs('#analyst-name').textContent = 'Carregando…';
  const slowHint = setTimeout(() => {
    if (state || qs('#load-slow-hint')) return;
    qs('#alert-area').insertAdjacentHTML('afterbegin', `<div class="alert" id="load-slow-hint"><span>Ainda carregando… o servidor está mais lento que o normal. Se for uma atualização do sistema, esta tela vai avisar.</span></div>`);
  }, 8000);
  try {
    const res = await rtReadCache.request("snapshot", () => fetchWithTimeout(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/rt_get_analyst_snapshot`, {
      method: "POST",
      headers,
      body: JSON.stringify({ p_token: token }),
    }), preferCache, value => Boolean(value && typeof value === "object" && !Array.isArray(value)), true);
    if (token !== currentToken()) return;
    if (!res.ok) throw httpError(res, 'Não foi possível carregar sua escala.');
    const payload = await res.json();
    if (token !== currentToken()) return;
    if (!payload) throw new Error('Chave não encontrada ou escala ainda não publicada.');
    if (!res.headers.get('X-RT-Cache')) readRecovery.recovered();
    state = normalizePayload(payload);
    state.fixed_assignments = state.assignments;
    state.fixed_period = state.period;
    state.fixed_latest_publication = state.latest_publication;
    state.fixed_publication_read = state.publication_read;
    applyScheduleView(scheduleView);
    const cachedSnapshot = res.headers.get('X-RT-Cache');
    if (cachedSnapshot) {
      occurrenceTypes = rtReadCache.peek('types', Array.isArray) || state.occurrence_types || [];
      state.useful_links = rtReadCache.peek('links', Array.isArray) || state.useful_links || [];
      const agenda = rtReadCache.peek('agenda', Array.isArray) || [];
      const known = new Set((state.notifications || []).map(item => String(item.id)));
      state.notifications = [...agenda.filter(item => !known.has(String(item.id))), ...(state.notifications || [])].sort((a,b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    }
    render();
    if (!cachedSnapshot) {
    try {
      const typesResponse = await rtReadCache.request("types", () => fetchWithTimeout(api("rt_occurrence_types?select=code,label&active=eq.true&order=label.asc"), { headers }, 15000), preferCache, Array.isArray);
      occurrenceTypes = typesResponse.ok ? await typesResponse.json() : (state.occurrence_types || []);
    } catch (_) { occurrenceTypes = state.occurrence_types || []; }


    try {
      const linksResponse = await rtReadCache.request("links", () => fetchWithTimeout(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/rt_analyst_get_useful_links`, {
        method: "POST", headers, body: JSON.stringify({ p_token: token }),
      }, 15000), preferCache, Array.isArray);
      state.useful_links = linksResponse.ok ? await linksResponse.json() : [];
    } catch (_) { state.useful_links = []; }


    try {
      const agendaResponse = await rtReadCache.request("agenda", () => fetchWithTimeout(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/rt_analyst_get_agenda`, {
        method: "POST", headers, body: JSON.stringify({ p_token: token }),
      }, 15000), preferCache, Array.isArray);
      const agenda = agendaResponse.ok ? await agendaResponse.json() : [];
      if (Array.isArray(agenda) && agenda.length) {
        const known = new Set((state.notifications || []).map((item) => String(item.id)));
        state.notifications = [...agenda.filter((item) => !known.has(String(item.id))), ...(state.notifications || [])]
          .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
      }
    } catch (_) { /* sem a 056 no servidor: segue só com os avisos do painel */ }
    }
    if (token !== currentToken()) return;
    render();
    setConnection(!cachedSnapshot);
    if (cachedSnapshot) {
      const seconds = cachedSnapshot === 'fallback' ? (readRecovery.waiting() ? readRecovery.remainingSeconds() : readRecovery.nextSeconds()) : 1;
      loadRetryTimer = setTimeout(() => loadData(true), seconds * 1000);
    }
    if (!cachedSnapshot) registerPanelVersion(token, state?.analyst?.name);
    if (!silent && !res.headers.get('X-RT-Cache')) toast('Escala atualizada');
  } catch (err) {
    if (token !== currentToken() || err.stale) return;
    if (err.status === 401 || err.status === 403) { state = null; document.body.replaceChildren(Object.assign(document.createElement('p'), {textContent:'Acesso não autorizado. Confira a chave nas configurações da extensão.'})); return; }
    setConnection(false);
    qs('#load-slow-hint')?.remove();
    if (await checkMaintenance()) {
      if (!state) qs('#analyst-name').textContent = 'Sistema em atualização';
      return;
    }
    if (!state) qs('#analyst-name').textContent = 'Não consegui carregar sua escala';

    const retry = isTransientFailure(err);
    const retrySeconds = retry ? (readRecovery.waiting() ? readRecovery.remainingSeconds() : readRecovery.nextSeconds()) : 0;
    const message = retry ? `${friendlyError(err)} Tento de novo sozinho em ${retrySeconds} s.` : friendlyError(err);
    qs('#alert-area').innerHTML = `<div class="alert"><span>${escapeHtml(message)}</span><button type="button" id="retry-load">Tentar de novo</button></div>`;
    qs('#retry-load').onclick = () => loadData();
    if (retry) loadRetryTimer = setTimeout(() => loadData(true), retrySeconds * 1000);
  } finally {
    clearTimeout(slowHint);
    qs('#load-slow-hint')?.remove();
  }
}


function friendlyError(error) {
  const text = String(error?.message || error || "").trim();

  if (/failed to fetch|networkerror|load failed|network request failed|error code: 52\d/i.test(text)) {
    return "Sem internet ou o servidor não respondeu. Confira a conexão e tente de novo.";
  }
  if (/timeout|timed out|aborted/i.test(text)) return "O servidor demorou demais para responder. Tente de novo em instantes.";
  if (/jwt|401|403|permission denied/i.test(text)) return "A chave deste painel não foi aceita. Abra a extensão e confira a chave recebida.";
  if (error instanceof TypeError || error instanceof ReferenceError) {
    return `Algo deu errado no painel (${text.slice(0, 120)}). Recarregue a página; se repetir, avise o supervisor.`;
  }
  return text || "Algo deu errado. Tente de novo em instantes.";
}




const MAINTENANCE_URL = `${SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/public/routing-tower-portals/status/manutencao.json`;
const LOAD_TIMEOUT_MS = 30000;

function createReadRecovery(getToken) {
  let identity = null, failures = 0, until = 0;
  function sync() {
    const token = getToken();
    if (token !== identity) { identity = token; failures = 0; until = 0; }
  }
  return {
    nextSeconds() {
      sync();
      const base = Math.min(600, 120 * (2 ** Math.min(failures++, 3)));
      const seconds = Math.round(base * (1 + Math.random() * 0.25));
      until = Date.now() + seconds * 1000;
      return seconds;
    },
    waiting() { sync(); return Date.now() < until; },
    remainingSeconds() { sync(); return Math.max(1, Math.ceil((until - Date.now()) / 1000)); },
    defer(seconds) { sync(); until = Math.max(until, Date.now() + seconds * 1000); },
    recovered() { sync(); failures = 0; until = 0; }
  };
}

const readRecovery = createReadRecovery(currentToken);

(() => {
  const original = globalThis.fetch.bind(globalThis);
  const pending = new Map();
  const readRpc = /^(rt_get_|rt_list_|rt_analyst_get_|rt_supervisor_list_)/;
  const extraReads = new Set(['rt_supervisor_live_timeoff','rt_visibility_events','rt_visibility_schedule','rt_mgmt_load','rt_mgmt_pending']);
  globalThis.fetch = async function(input, options = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const method = String(options.method || input?.method || 'GET').toUpperCase();
    const rpc = url.pathname.split('/rpc/')[1] || '';
    const read = url.origin === new URL(SUPABASE_URL).origin && url.pathname.startsWith('/rest/v1/')
      && (method === 'GET' || (method === 'POST' && (readRpc.test(rpc) || extraReads.has(rpc))));
    if (!read) return original(input, options);
    const primary = rpc === 'rt_get_supervisor_state' || rpc === 'rt_get_analyst_snapshot';
    if (!primary && readRecovery.waiting()) return new Response(JSON.stringify({message:'Reconectando. Últimos dados preservados.'}), {status:503,headers:{'Content-Type':'application/json'}});
    const key = method + '|' + url.href + '|' + String(options.body || '');
    if (pending.has(key)) return (await pending.get(key)).clone();
    const task = (async () => {
      try {
        const response = await original(input, options);
        if (response.status === 408 || response.status === 429 || response.status >= 500) {
          if (!readRecovery.waiting()) readRecovery.nextSeconds();
          const retry = response.headers.get('Retry-After');
          if (retry) {
            const seconds = /^\d+$/.test(retry) ? Number(retry) : (Date.parse(retry) - Date.now()) / 1000;
            if (Number.isFinite(seconds) && seconds > 0) readRecovery.defer(seconds);
          }
        }
        return response;
      } catch (error) {
        if (error.name === 'AbortError' || /failed to fetch|networkerror|load failed|network request failed/i.test(error.message)) {
          if (!readRecovery.waiting()) readRecovery.nextSeconds();
        }
        throw error;
      }
    })();
    pending.set(key, task);
    try { return (await task).clone(); } finally { pending.delete(key); }
  };
})();

let maintenanceInfo = null;
let maintenanceDismissed = false;
let maintenanceTimer = null;
let maintenanceChecking = null;
let lastMaintenanceCheck = 0;
let loadRetryTimer = null;

async function fetchWithTimeout(url, options = {}, timeoutMs = LOAD_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function httpError(response, fallback) {
  const error = new Error(response.status >= 500
    ? `O servidor não respondeu direito (erro ${response.status}).`
    : fallback);
  error.status = response.status;
  return error;
}

function isTransientFailure(error) {
  const text = String(error?.message || error || "");
  return Number(error?.status) === 408 || Number(error?.status) === 429 || Number(error?.status) >= 500
    || /failed to fetch|networkerror|load failed|network request failed|timeout|timed out|aborted|error code: 52\d/i.test(text);
}

function maintenanceEtaText(value) {
  const when = value ? new Date(value) : null;
  if (!when || Number.isNaN(when.getTime())) return "";
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const day = when.toDateString() === now.toDateString() ? "hoje"
    : when.toDateString() === tomorrow.toDateString() ? "amanhã"
      : when.toLocaleDateString("pt-BR");
  const time = when.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return when < now
    ? `A previsão era ${day} às ${time}; está levando um pouco mais.`
    : `Previsão de volta: ${day} às ${time}.`;
}

function renderMaintenance() {
  const screen = document.getElementById("rt-maintenance");
  const bar = document.getElementById("rt-maintenance-bar");
  if (!maintenanceInfo) {
    screen?.remove();
    bar?.remove();
    return;
  }
  if (maintenanceDismissed) {
    screen?.remove();
    if (!bar) {
      const strip = document.createElement("div");
      strip.id = "rt-maintenance-bar";
      strip.className = "rt-maintenance-bar";
      strip.innerHTML = `<span>Sistema em atualização: evite enviar ou salvar algo até terminar. Esta faixa some sozinha.</span><button type="button">Ver aviso</button>`;
      strip.querySelector("button").onclick = () => { maintenanceDismissed = false; renderMaintenance(); };
      document.body.appendChild(strip);
    }
    return;
  }
  bar?.remove();
  const message = String(maintenanceInfo.mensagem || "").trim()
    || "O Routing Tower está passando por uma atualização. Seus dados estão guardados; é só aguardar.";
  const eta = maintenanceEtaText(maintenanceInfo.previsao);
  const box = screen || document.createElement("div");
  box.id = "rt-maintenance";
  box.className = "rt-maintenance";
  box.setAttribute("role", "alertdialog");
  box.setAttribute("aria-live", "assertive");
  box.innerHTML = `<div class="rt-maintenance-card">
      <div class="rt-maintenance-icon" aria-hidden="true"></div>
      <h2>Estamos atualizando o sistema</h2>
      <p>${escapeHtml(message)}</p>
      ${eta ? `<p class="rt-maintenance-eta">${escapeHtml(eta)}</p>` : ""}
      <p class="rt-maintenance-small">Esta tela some sozinha quando terminar (confere a cada 30 segundos).</p>
      <div class="rt-maintenance-actions">
        <button type="button" class="rt-maint-check">Verificar agora</button>
        <button type="button" class="rt-maint-view">Ver a escala mesmo assim</button>
      </div>
    </div>`;
  box.querySelector(".rt-maint-check").onclick = (event) => {
    event.currentTarget.disabled = true;
    event.currentTarget.textContent = "Verificando…";
    if (!window.RT_WEB_CONTEXT) checkMaintenance();
  };
  box.querySelector(".rt-maint-view").onclick = () => { maintenanceDismissed = true; renderMaintenance(); };
  if (!screen) document.body.appendChild(box);
}

async function checkMaintenance() {
  if (maintenanceChecking) return maintenanceChecking;
  maintenanceChecking = (async () => {
    let info = maintenanceInfo;
    let confirmed = false;
    try {
      const response = await fetchWithTimeout(`${MAINTENANCE_URL}?v=${Date.now()}`, { cache: "no-store" }, 8000);
      if (response.ok) {
        const data = await response.json();
        if (data && typeof data.ativo === "boolean") { info = data.ativo ? data : null; confirmed = true; }
      }
    } catch (_) { /* sem resposta: preserva o último estado confirmado */ }
    lastMaintenanceCheck = Date.now();
    const wasActive = Boolean(maintenanceInfo);
    maintenanceInfo = info;
    if (!info) maintenanceDismissed = false;
    renderMaintenance();
    scheduleMaintenanceCheck();
    if (confirmed && wasActive && !info) onMaintenanceOver();
    return Boolean(info);
  })();
  try {
    return await maintenanceChecking;
  } finally {
    maintenanceChecking = null;
  }
}


function scheduleMaintenanceCheck() {
  clearTimeout(maintenanceTimer);
  maintenanceTimer = setTimeout(() => {
    if (document.hidden && !maintenanceInfo) scheduleMaintenanceCheck();
    else if (!window.RT_WEB_CONTEXT) checkMaintenance();
  }, maintenanceInfo ? 30000 : 300000);
}

function onMaintenanceOver() {
  toast("Atualização do sistema concluída.");
  loadData(true);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && Date.now() - lastMaintenanceCheck > 60000) if (!window.RT_WEB_CONTEXT) checkMaintenance();
});


const GLOSSARY = [
  ["DSR", "Descanso semanal remunerado: a folga semanal de cada analista, em dia fixo pela CLT (sábado para quem trabalha de domingo a sexta; domingo para quem trabalha de segunda a sábado)."],
  ["Folga DM", "Folga de domingo do mês: um domingo de folga por mês. Na semana dela, o analista folga o DSR e o domingo (dobradinha)."],
  ["Dobradinha", "DSR + Folga DM na mesma semana: os dois dias de folga são obrigatórios e o DSR não pode virar hora extra."],
  ["Trabalhar no DSR", "O analista pode escolher trabalhar no próprio DSR: vira hora extra e gera uma folga compensatória na semana seguinte (menos na semana da Folga DM)."],
  ["Compensatória", "Folga na semana seguinte (segunda a sexta) para quem trabalhou no próprio DSR pela escala de fim de semana publicada; nasce na publicação e respeita o limite de 7 dias seguidos de trabalho."],
  ["Cobertura", "Outro analista (folguista) assume as operações de quem está de folga ou afastado; é organizada no Kanban de coberturas."],
  ["Hora extra", "Horas além da escala, combinadas com o supervisor; o analista aceita ou recusa no painel."],
  ["Trabalho em DSR", "Hora extra de quem decidiu trabalhar no próprio DSR."],
  ["Cobertura de DSR", "Hora extra de quem cobre o DSR de outro analista."],
  ["Escala semanal", "Escala de segunda a sexta de uma semana. Publicar vale do dia da publicação em diante; dias que já passaram não mudam."],
  ["Escala de fim de semana", "Escala de sábado e domingo de um fim de semana; vale só para ele."],
];

function glossaryHtml() {
  return `<dl class="glossary-list">${GLOSSARY.map(([term, text]) => `<dt>${escapeHtml(term)}</dt><dd>${escapeHtml(text)}</dd>`).join("")}</dl>`;
}


const HELP_GUIDES = {
  "home": {
    "titulo": "Visão geral",
    "para_que": "O resumo do seu dia e da sua semana: a operação de hoje, o que precisa de você e os avisos do supervisor.",
    "passos": [
      "\"Seu painel da semana\" mostra o período publicado e quantas operações suas estão pendentes.",
      "Os cartões mostram a sua jornada, as atividades da semana, a próxima folga e as pendências.",
      "\"Minha operação\" lista as operações de hoje: mude o \"Status da operação\" conforme avança e clique na operação para abrir os detalhes (romaneio, cancelamento, ocorrência e ficha do hub).",
      "Quando sair uma escala nova aparece \"Nova versão publicada\": leia e clique em \"Confirmar leitura\".",
      "\"Avisos recentes\" traz as publicações, os avisos e os convites da Agenda do supervisor; responda aos convites com \"Vou participar\" ou \"Não posso\".",
      "Se aparecer \"Precisa da sua resposta\", resolva cada item pelo botão ao lado (DSR, hora extra ou convite).",
      "\"Atualizar\" busca os dados mais novos; \"Atualizar telas\" instala a versão mais nova do painel."
    ],
    "dicas": [
      "A bolinha no pé do menu mostra se os dados estão sincronizados; a versão do painel fica ao lado.",
      "Se o sistema estiver em atualização, aparece um aviso; a tela volta sozinha quando terminar.",
      "O botão de lua e sol troca o tema (claro ou escuro)."
    ]
  },
  "week": {
    "titulo": "Minha semana",
    "para_que": "A sua escala publicada, dia a dia: operações, folgas e compromissos da Agenda.",
    "passos": [
      "No topo, escolha \"Escala semanal\" (segunda a sexta) ou \"Fim de semana\" (todos os fins de semana já publicados daqui para a frente).",
      "Na escala semanal, \"Semana atual\" e \"Próxima semana\" (quando já publicada) trocam a semana.",
      "Cada dia mostra as suas operações (hub, horário, ciclo e situação), DSR, Folga DM, compensatórias e compromissos da Agenda.",
      "Clique numa operação para abrir os detalhes: romaneio e finalização, cancelamento com justificativa, ocorrência e ficha do hub."
    ],
    "dicas": [
      "Cartão verde \"Hora extra confirmada\" no DSR: você escolheu trabalhar nesse dia.",
      "A escala só muda quando o supervisor publica de novo."
    ]
  },
  "hubs": {
    "titulo": "Meus hubs",
    "para_que": "Os hubs da sua semana e a ficha de cada um: particularidades, clusters, links e dados por ciclo.",
    "passos": [
      "A lista mostra os hubs vinculados à sua semana (muda com as abas \"Escala semanal\" e \"Fim de semana\").",
      "Clique num hub para abrir a ficha: particularidade geral do hub, dados por ciclo, links e as suas operações nele.",
      "Para atualizar a ficha, edite os campos (clusters com \"+ Adicionar cluster\", ou \"Exportar modelo\" e \"Importar Excel\") e clique em \"Salvar alterações\"."
    ],
    "dicas": [
      "A ficha do hub é a mesma para todos os analistas: o que você salvar, todos veem."
    ]
  },
  "timeoff": {
    "titulo": "Folgas e férias",
    "para_que": "As suas folgas, DSR, compensatórias e férias até o fim do mês seguinte, separadas por mês.",
    "passos": [
      "Cada folga mostra o tipo, o dia e o horário; a lista vai até o fim do mês seguinte.",
      "No DSR que permite escolha, decida: \"Não aceito hora extra\" (vai folgar) ou \"Aceito fazer hora extra\" (vai trabalhar no DSR).",
      "Dá para mudar a decisão (\"Mudar para…\") até o supervisor publicar a escala daquela semana; depois, só com ele."
    ],
    "dicas": [
      "Na semana da Folga DM o DSR é folga obrigatória (dobradinha): não dá para trabalhar.",
      "Trabalhando no DSR, você ganha uma folga compensatória na semana seguinte.",
      "Durante as férias não há DSR nem outra folga."
    ]
  },
  "overtime": {
    "titulo": "Horas extras",
    "para_que": "As horas extras que o supervisor ofereceu e as suas respostas.",
    "passos": [
      "Cada solicitação mostra o dia, o horário, os minutos e o motivo.",
      "Responda com \"Aceitar\" ou \"Recusar\".",
      "\"Ver histórico\" mostra as respostas anteriores."
    ],
    "dicas": [
      "Depois que você aceita, o supervisor aprova o pagamento ou a compensação (banco de horas).",
      "Hora extra de trabalho no próprio DSR aparece aqui como \"Trabalho em DSR\"."
    ]
  },

  "links": {
    "titulo": "Links úteis",
    "para_que": "Atalhos que o supervisor cadastrou para você: manuais, planilhas e sistemas, por categoria.",
    "passos": [
      "Clique no link para abrir em outra aba."
    ],
    "dicas": [
      "Faltou algum link? Peça ao supervisor: ele cadastra no painel dele."
    ]
  },
  "operacao": {
    "titulo": "Detalhes da operação",
    "para_que": "Tudo de uma operação: status, romaneio, cancelamento, ocorrência e a ficha do hub.",
    "passos": [
      "\"Romaneio da operação\": cole o link da planilha ou do romaneio e clique em \"Salvar Romaneio e finalizar operação\" (o painel confere se o link é do hub certo).",
      "\"Cancelamento da operação\": explique o motivo e clique em \"Salvar motivo e cancelar operação\".",
      "\"Registrar ocorrência\": escolha o tipo, conte o que aconteceu e clique em \"Enviar ocorrência ao supervisor\"; o retorno dele aparece em \"Histórico e retorno do supervisor\".",
      "A ficha do hub (particularidades, dados por ciclo e links) fica na mesma janela."
    ],
    "dicas": [
      "\"Finalizado\" só libera depois do romaneio; \"Roteirização cancelada\", depois do motivo.",
      "O supervisor vê o status da operação na hora, no painel dele."
    ]
  }
};

function helpGuideHtml(guide) {
  const list = (items, tag) => (items && items.length
    ? `<${tag}>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</${tag}>` : '');
  return `<div class="help-guide">
    <p class="help-lead">${escapeHtml(guide.para_que || '')}</p>
    ${guide.passos && guide.passos.length ? `<h3>Passo a passo</h3>${list(guide.passos, 'ol')}` : ''}
    ${guide.dicas && guide.dicas.length ? `<h3>Dicas</h3>${list(guide.dicas, 'ul')}` : ''}
  </div>`;
}

function openHelp(key) {
  const guide = HELP_GUIDES[key] || HELP_GUIDES.home;
  qs('#help-dialog-title').textContent = `Como usar: ${guide.titulo}`;
  qs('#help-dialog-content').innerHTML = `${helpGuideHtml(guide)}<h3 class="help-terms-title">O que significa cada termo</h3>${glossaryHtml()}`;
  const dialog = qs('#help-dialog');
  if (!dialog.open) dialog.showModal();
}
qs('#glossary-btn').onclick = () => openHelp(qs('.nav-item.active')?.dataset.view || 'home');
qs('#hub-dialog-help').onclick = () => openHelp('operacao');


let panelVersionRegistered = false;
function registerPanelVersion(token, name) {
  const version = globalThis.chrome?.runtime?.getManifest?.()?.version;
  if (panelVersionRegistered || !version || !token) return;
  panelVersionRegistered = true;
  fetch(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/rt_register_panel_version`, {
    method: "POST",
    headers,
    body: JSON.stringify({ p_token: token, p_panel: "analista", p_version: version, p_name: name || "" }),
  }).catch(() => {});
}

function setConnection(online) {
  qs('#connection-dot').classList.toggle('online', online);
  qs('#connection-text').textContent = online ? 'Dados sincronizados' : 'Sem conexão';
}

function nextWeekAvailable() {
  if (scheduleView !== 'fixed' || !state?.period?.start || !state?.period?.end) return false;
  const saved = weekOffset;
  weekOffset = 0;
  const current = currentWeekRange().start;
  weekOffset = 1;
  const next = currentWeekRange().start;
  weekOffset = saved;
  return next !== current;
}

function updateWeekSwitch() {
  const wrap = qs('#week-switch');
  if (!wrap) return;
  const available = nextWeekAvailable();
  if (!available) weekOffset = 0;
  wrap.hidden = !available;
  qsa('.week-switch-btn').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.weekOffset || 0) === weekOffset);
  });
}

qsa('.week-switch-btn').forEach((btn) => {
  btn.onclick = () => {
    weekOffset = Number(btn.dataset.weekOffset || 0);
    render();
  };
});

function render() {
  updateScheduleTypeTabs();
  updateWeekSwitch();
  const a = state.analyst;
  qs('#analyst-name').textContent = a.name;
  qs('#shift-value').textContent = `${a.shift_start} – ${a.shift_end}`;
  qs('#schedule-pattern').textContent = a.schedule_pattern || 'Jornada cadastrada';



  const weekRange = currentWeekRange();











  const operationalWeek = currentOperationalWeekRange();
  const combinedAssignments = [...(state.fixed_assignments || []), ...(state.weekend_assignments || [])];
  const weekAssignments = combinedAssignments.filter((x) => x.work_date >= operationalWeek.start && x.work_date <= operationalWeek.end);
  qs('#assignment-count').textContent = weekAssignments.length;
  qs('#pending-count').textContent = state.overtime.filter((x) => x.status === 'awaiting_analyst').length;
  const today = new Date();





  const isWorkingOvertime = (x) => String(x.absence_type || '').toLowerCase().includes('dsr')
    && (String(x.analyst_decision || '').toLowerCase() === 'overtime'
      || String(x.status || '').toLowerCase() === 'working_overtime');
  const realTimeoffs = state.absences.filter((x) => !isWorkingOvertime(x));
  const abs = realTimeoffs
    .filter((x) => new Date(x.end_datetime) >= today)
    .sort((a, b) => String(a.start_datetime || '').localeCompare(String(b.start_datetime || '')))[0];
  qs('#next-timeoff').textContent = abs ? fmtDate(abs.start_datetime.slice(0, 10)) : '—';
  qs('#next-timeoff-type').textContent = abs ? abs.absence_type : 'Sem evento';








  qs('#period-label').textContent = `${fmtDate(weekRange.start)} a ${fmtDate(weekRange.end)}`;
  renderActionCard();



  qs('#hero-period').textContent = `${fmtDate(operationalWeek.start)} a ${fmtDate(operationalWeek.end)}`;

  qs('#timeoff-period').textContent = `Até ${fmtDate(timeoffWindowEnd())}`;


  const pendingOperations = combinedAssignments.filter((item) => safeOperationStatus(item.operation_status) === 'pending').length;
  const openNotices = state.notifications.filter((item) => item.status !== 'read').length;
  qs('#smart-message').textContent = pendingOperations
    ? `${a.name.split(' ')[0]}, você tem ${pendingOperations} operação(ões) pendente(s). Abra uma delas para registrar o Romaneio ou comunicar uma ocorrência.`
    : openNotices
      ? `${a.name.split(' ')[0]}, suas operações estão em ordem. Há ${openNotices} aviso(s) recente(s) para consultar.`
      : `${a.name.split(' ')[0]}, sua rotina está organizada e sem pendências neste momento.`;





  const p = todayScheduleSource().publication;
  qs('#version-badge').textContent = p ? `Versão ${p.version}` : 'Sem publicação';
  renderPublicationAlert();
  renderUpcoming();
  renderNotifications();
  renderWeek();
  renderHubs();
  renderTimeoff();
  renderOvertime();
  renderUsefulLinks();
  bindOperationControls();
  scanUpcomingRoutingAlert();
  scanAnalystAlerts();
}

const NOTIFIED_ROUTING_STORAGE_KEY = "rtAnalystNotifiedRouting";
let notifiedRoutingIds = null;

function loadNotifiedRoutingIds() {
  if (notifiedRoutingIds) return Promise.resolve(notifiedRoutingIds);
  return new Promise((resolve) => {
    if (typeof chrome === "undefined" || !chrome.storage?.local) { notifiedRoutingIds = new Set(); resolve(notifiedRoutingIds); return; }
    chrome.storage.local.get({ [NOTIFIED_ROUTING_STORAGE_KEY]: [] }, (cfg) => {
      notifiedRoutingIds = new Set((cfg[NOTIFIED_ROUTING_STORAGE_KEY] || []).slice(-200));
      resolve(notifiedRoutingIds);
    });
  });
}

function persistNotifiedRoutingIds() {
  if (typeof chrome === "undefined" || !chrome.storage?.local || !notifiedRoutingIds) return;
  chrome.storage.local.set({ [NOTIFIED_ROUTING_STORAGE_KEY]: [...notifiedRoutingIds].slice(-200) });
}

async function scanUpcomingRoutingAlert() {
  if (typeof chrome === "undefined" || !chrome.notifications || !state?.assignments?.length) return;
  await loadNotifiedRoutingIds();
  const now = new Date();
  let changed = false;
  state.assignments.forEach((item) => {
    if (safeOperationStatus(item.operation_status) !== 'pending') return;
    const start = item.start_datetime ? new Date(item.start_datetime) : null;
    if (!start || Number.isNaN(start.getTime())) return;
    const minutesToStart = (start - now) / 60000;



    if (minutesToStart <= 5 && minutesToStart > 4) {
      const alertId = `routing:${item.id}`;
      if (!notifiedRoutingIds.has(alertId)) {
        notifiedRoutingIds.add(alertId);
        changed = true;
        try {
          chrome.notifications.create(alertId, {
            type: "basic",
            iconUrl: chrome.runtime.getURL("icons/icon128.png"),
            title: "Roteirização em 5 minutos",
            message: `${item.station_id || item.hub_name || "Seu hub"} começa às ${fmtDateTime(item.start_datetime)}.`,
            priority: 2,
          });
        } catch (error) {
          console.warn("Falha ao criar notificação do sistema", error);
        }
      }
    }
  });
  if (changed) persistNotifiedRoutingIds();
}

setInterval(scanUpcomingRoutingAlert, 60000);






const NOTIFIED_ANALYST_ALERTS_KEY = "rtAnalystNotifiedAlerts";
let notifiedAnalystAlertIds = null;



const ANALYST_ALERT_STATE_KEY = "rtAnalystAlertState";
let analystAlertState = null;

function loadAnalystAlertState() {
  if (notifiedAnalystAlertIds && analystAlertState) {
    return Promise.resolve({ ids: notifiedAnalystAlertIds, state: analystAlertState });
  }
  return new Promise((resolve) => {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      notifiedAnalystAlertIds = new Set();
      analystAlertState = {};
      resolve({ ids: notifiedAnalystAlertIds, state: analystAlertState });
      return;
    }
    chrome.storage.local.get(
      { [NOTIFIED_ANALYST_ALERTS_KEY]: [], [ANALYST_ALERT_STATE_KEY]: {} },
      (cfg) => {
        notifiedAnalystAlertIds = new Set((cfg[NOTIFIED_ANALYST_ALERTS_KEY] || []).slice(-500));
        analystAlertState = cfg[ANALYST_ALERT_STATE_KEY] && typeof cfg[ANALYST_ALERT_STATE_KEY] === "object"
          ? cfg[ANALYST_ALERT_STATE_KEY] : {};
        resolve({ ids: notifiedAnalystAlertIds, state: analystAlertState });
      }
    );
  });
}

function persistAnalystAlertState() {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  chrome.storage.local.set({
    [NOTIFIED_ANALYST_ALERTS_KEY]: [...(notifiedAnalystAlertIds || [])].slice(-500),
    [ANALYST_ALERT_STATE_KEY]: analystAlertState || {},
  });
}

function analystSystemNotify(id, title, message) {
  if (typeof chrome === "undefined" || !chrome.notifications) return;
  try {
    chrome.notifications.create(id, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title,
      message,
      priority: 2,
    });
  } catch (error) {
    console.warn("Falha ao criar notificação do sistema", error);
  }
}

async function scanAnalystAlerts() {
  if (typeof chrome === "undefined" || !chrome.notifications || !state) return;
  await loadAnalystAlertState();
  let changed = false;
  const now = new Date();



  (state.assignments || []).forEach((item) => {
    const key = String(item.id || "");
    if (!key) return;
    const status = safeOperationStatus(item.operation_status);
    const start = item.start_datetime ? new Date(item.start_datetime) : null;
    const end = item.end_datetime ? new Date(item.end_datetime) : null;
    const startOk = start && !Number.isNaN(start.getTime());
    const endOk = end && !Number.isNaN(end.getTime());
    if (!isTerminalOperationStatus(status) && endOk && now > end) {
      const alertId = `analyst-late:${key}`;
      if (!notifiedAnalystAlertIds.has(alertId)) {
        notifiedAnalystAlertIds.add(alertId);
        changed = true;
        analystSystemNotify(alertId, "Hub atrasado",
          `${item.station_id || item.hub_name || "Seu hub"} está atrasado.`);
      }
      return;
    }
    if (status === "pending" && startOk && (now - start) >= 5 * 60 * 1000) {
      const alertId = `analyst-not-started:${key}`;
      if (!notifiedAnalystAlertIds.has(alertId)) {
        notifiedAnalystAlertIds.add(alertId);
        changed = true;
        analystSystemNotify(alertId, "Hub sem início",
          `${item.station_id || item.hub_name || "Seu hub"} não foi iniciado 5 min após o horário.`);
      }
    }
  });




  const occurrencesBaselined = Boolean(analystAlertState.occurrencesBaselined);
  (state.occurrences || []).forEach((item) => {
    const key = String(item.id || "");
    if (!key) return;
    const returned = item.status === "resolved" || item.status === "reviewing" || Boolean(item.decision);
    if (!returned) return;
    const alertId = `analyst-occurrence:${key}`;
    if (!notifiedAnalystAlertIds.has(alertId)) {
      notifiedAnalystAlertIds.add(alertId);
      changed = true;
      if (occurrencesBaselined) {
        analystSystemNotify(alertId, "Ocorrência respondida",
          `O supervisor respondeu sua ocorrência: ${shortText(item.message, "sem descrição")}`);
      }
    }
  });
  if (!occurrencesBaselined) {
    analystAlertState.occurrencesBaselined = true;
    changed = true;
  }




  const overtimeDeclinedBaselined = Boolean(analystAlertState.overtimeDeclinedBaselined);
  (state.overtime || []).forEach((item) => {
    const key = String(item.id || "");
    if (!key) return;
    if (item.status !== "declined" || item.analyst_response !== "supervisor_rejected") return;
    const alertId = `analyst-overtime-declined:${key}`;
    if (!notifiedAnalystAlertIds.has(alertId)) {
      notifiedAnalystAlertIds.add(alertId);
      changed = true;
      if (overtimeDeclinedBaselined) {
        analystSystemNotify(alertId, "Hora extra recusada",
          "O supervisor cancelou uma disponibilidade de hora extra que você tinha aceitado.");
      }
    }
  });
  if (!overtimeDeclinedBaselined) {
    analystAlertState.overtimeDeclinedBaselined = true;
    changed = true;
  }

















  [
    { pub: state.fixed_latest_publication, stateKey: "fixed" },
    { pub: state.weekend_latest_publication, stateKey: "weekend" },
  ].forEach(({ pub, stateKey }) => {
    if (!pub || !pub.id) return;
    const previous = analystAlertState[stateKey];
    const currentId = Number(pub.id);
    const currentVersion = Number(pub.version || 0);
    if (!previous) {
      analystAlertState[stateKey] = { id: currentId, version: currentVersion };
      changed = true;
      return;
    }
    if (previous.id !== currentId) {
      analystSystemNotify(`analyst-publication-new:${currentId}`, "Escala publicada",
        `Uma nova escala (versão ${currentVersion}) foi publicada para você.`);
      analystAlertState[stateKey] = { id: currentId, version: currentVersion };
      changed = true;
    } else if (previous.version !== currentVersion) {
      analystSystemNotify(`analyst-publication-updated:${currentId}:${currentVersion}`, "Escala atualizada",
        `Sua escala foi revisada (versão ${currentVersion}).`);
      analystAlertState[stateKey] = { id: currentId, version: currentVersion };
      changed = true;
    }
  });






  const noticesBaselined = Boolean(analystAlertState.noticesBaselined);
  (state.notifications || []).forEach((item) => {
    const key = String(item.id || "");
    if (!key) return;
    const alertId = `analyst-notice:${key}`;
    if (!notifiedAnalystAlertIds.has(alertId)) {
      notifiedAnalystAlertIds.add(alertId);
      changed = true;
      if (noticesBaselined) {
        analystSystemNotify(alertId, shortText(item.subject || item.title, "Aviso do supervisor"),
          shortText(item.message, ""));
      }
    }
  });
  if (!noticesBaselined) {
    analystAlertState.noticesBaselined = true;
    changed = true;
  }

  if (changed) persistAnalystAlertState();
}

setInterval(scanAnalystAlerts, 60000);

async function confirmPublicationRead() {
  const publication = state.latest_publication;
  const publicationId = Number(publication?.id || 0) || null;
  try {
    const response = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/rt_analyst_confirm_publication_read`, {
      method: "POST",
      headers,
      body: JSON.stringify({ p_token: currentToken(), p_publication_id: publicationId }),
    });
    if (!response.ok) throw new Error();
  } catch (_) {
    await postEvent("publication_read", { publication_id: publicationId, version: publication?.version || null });
  }
  state.publication_read = true;
  renderPublicationAlert();
  toast('Leitura confirmada');
}

function renderPublicationAlert() {
  const p = state.latest_publication;
  if (!p || state.publication_read) {
    qs('#alert-area').innerHTML = '';
    return;
  }
  qs('#alert-area').innerHTML = `<div class="alert"><span><strong>Nova versão publicada.</strong> ${escapeHtml(p.summary || 'Sua escala foi atualizada.')}</span><button id="confirm-read">Confirmar leitura</button></div>`;
  qs('#confirm-read').onclick = () => confirmPublicationRead();
}








function operationalTodayIso(now = new Date()) {
  const cursor = new Date(now);
  if (cursor.getHours() < 12) cursor.setDate(cursor.getDate() - 1);
  return cursor.toLocaleDateString('sv-SE');
}










function todayScheduleSource() {
  const todayIso = operationalTodayIso();
  const weekend = (state.weekend_assignments || []).filter((x) => String(x.work_date) === todayIso);
  const fixed = (state.fixed_assignments || []).filter((x) => String(x.work_date) === todayIso);


  const key = (x) => String(x.id ?? x.assignment_id ?? `${x.work_date}|${x.start_datetime}|${x.station_id}`);
  const byKey = new Map();
  weekend.forEach((x) => byKey.set(key(x), x));
  fixed.forEach((x) => byKey.set(key(x), x));
  const weekendDay = [0, 6].includes(new Date(`${todayIso}T12:00:00`).getDay());
  return {
    assignments: [...byKey.values()],
    publication: (weekend.length || weekendDay) ? (state.weekend_latest_publication || null) : (state.fixed_latest_publication || null),
  };
}

function renderUpcoming() {




  const items = [...todayScheduleSource().assignments]
    .sort((a, b) => a.start_datetime.localeCompare(b.start_datetime))
    .slice(0, 8);
  qs('#upcoming-list').innerHTML = items.length ? items.map((x) => `
    <div class="timeline-item overview-operation" data-hub="${x.hub_id || ''}" data-assignment="${x.id}" role="button" tabindex="0" aria-label="Abrir detalhes de ${x.station_id || x.title || 'atividade'}">
      <div class="time-chip">${new Date(x.start_datetime).toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'})}</div>
      <div>
        <h3>${x.station_id || x.title || 'Atividade'} <small>· ${x.hub_name || ''}</small></h3>
        <p>${fmtDateTime(x.start_datetime)} até ${new Date(x.end_datetime).toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'})} · ${x.cycle_code || x.assignment_type}</p>
        ${operationControl(x)}
      </div>
      <span class="type-pill">${x.assignment_type === 'coverage' ? 'Cobertura' : 'Regular'}</span>
    </div>`).join('') : empty('Nenhuma atividade para hoje.');
  qsa('.overview-operation').forEach((item) => {
    const open = () => openHub(item.dataset.hub, item.dataset.assignment);
    item.onclick = open;
    item.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } };
  });
}

const AGENDA_TYPES = { reuniao: 'Reunião', treinamento: 'Treinamento', implantacao: 'Implantação', aviso: 'Aviso' };
function agendaTypeLabel(type) {
  return AGENDA_TYPES[String(type || '')] || shortText(type, 'Atividade');
}
function agendaLink(url, className = '') {
  const value = String(url || '').trim();
  if (!/^https?:\/\//i.test(value)) return '';
  return `<a${className ? ` class="${className}"` : ''} href="${escapeHtml(value)}" target="_blank" rel="noopener">Abrir link</a>`;
}

const AGENDA_MEETING_TYPES = new Set(['reuniao', 'treinamento', 'implantacao']);
function agendaResponseButtons(x) {
  if (x.source !== 'agenda' || !x.agenda_id || !AGENDA_MEETING_TYPES.has(x.event_type)) return '';
  if (!x.scheduled_for || new Date(x.scheduled_for) < new Date()) {
    return x.my_response ? `<small class="agenda-answer">${x.my_response === 'vou' ? 'Você confirmou presença.' : 'Você avisou que não pode.'}</small>` : '';
  }
  const button = (value, label) => `<button type="button" class="agenda-answer-btn${x.my_response === value ? ' active' : ''}" data-agenda-response="${value}" data-agenda-id="${escapeHtml(String(x.agenda_id))}">${label}</button>`;
  return `<div class="agenda-answer">${button('vou', 'Vou participar')}${button('nao_posso', 'Não posso')}</div>`;
}

async function answerAgenda(agendaId, response) {
  try {
    const res = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/rt_analyst_respond_agenda`, {
      method: "POST", headers, body: JSON.stringify({ p_token: currentToken(), p_agenda_id: Number(agendaId), p_response: response }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || 'Não consegui enviar sua resposta.');
    (state.notifications || []).forEach((item) => { if (String(item.agenda_id) === String(agendaId)) item.my_response = response; });
    render();
    toast(response === 'vou' ? 'Presença confirmada' : 'Supervisor avisado que você não pode');
  } catch (err) {
    toast(friendlyError(err));
  }
}
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-agenda-response]');
  if (button) answerAgenda(button.dataset.agendaId, button.dataset.agendaResponse);
});

const AGENDA_REMINDER_KEY = 'routingTowerAgendaReminders';
function remindUpcomingAgenda() {
  if (!state?.notifications) return;
  let reminded = [];
  try { reminded = JSON.parse(localStorage.getItem(AGENDA_REMINDER_KEY) || '[]'); } catch (_) { reminded = []; }
  const now = Date.now();
  state.notifications
    .filter((x) => x.source === 'agenda' && x.scheduled_for && AGENDA_MEETING_TYPES.has(x.event_type) && x.my_response !== 'nao_posso')
    .forEach((x) => {
      const minutes = Math.round((new Date(x.scheduled_for).getTime() - now) / 60000);
      if (minutes < 0 || minutes > 15 || reminded.includes(String(x.id))) return;
      reminded.push(String(x.id));
      const text = `${shortText(x.subject || x.title, 'Compromisso')} começa em ${minutes <= 1 ? '1 minuto' : `${minutes} minutos`}.`;
      analystSystemNotify(`lembrete-${x.id}`, 'Lembrete da agenda', text);
      toast(text);
    });
  try { localStorage.setItem(AGENDA_REMINDER_KEY, JSON.stringify(reminded.slice(-100))); } catch (_) { /* sem armazenamento */ }
}
setInterval(remindUpcomingAgenda, 60000);



const ACTION_CARD_ENABLED = /TESTE/i.test(globalThis.chrome?.runtime?.getManifest?.()?.name || '');

function localTodayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function goToPortalView(view) {
  const button = qs(`.nav-item[data-view="${view}"]`);
  if (button) switchPortalView(button);
}

function renderActionCard() {
  const card = qs('#action-card');
  if (!card || !ACTION_CARD_ENABLED || !state) return;
  const today = localTodayIso();
  const dsr = (state.absences || []).filter((x) => canDecideTimeoff(x) && !x.analyst_decision
    && String(x.start_datetime || '').slice(0, 10) >= today);
  const extras = (state.overtime || []).filter((x) => x.status === 'awaiting_analyst');
  const agenda = (state.notifications || []).filter((x) => x.source === 'agenda' && x.agenda_id
    && AGENDA_MEETING_TYPES.has(x.event_type) && !x.my_response && x.scheduled_for && new Date(x.scheduled_for) > new Date());
  const items = [
    ...dsr.map((x) => `<li><span><b>DSR de ${fmtDate(String(x.start_datetime).slice(0, 10))}</b> · folgar ou fazer hora extra?</span><button type="button" data-go-view="timeoff">Decidir</button></li>`),
    ...extras.map((x) => `<li><span><b>Hora extra${x.work_date ? ` de ${fmtDate(x.work_date)}` : ''}</b> · aceita ou recusa?</span><button type="button" data-go-view="overtime">Responder</button></li>`),
    ...agenda.map((x) => `<li><span><b>${shortText(x.subject || x.title, 'Compromisso')}</b> · ${fmtDateTime(x.scheduled_for)}</span>${agendaResponseButtons(x)}</li>`),
  ];
  const now = Date.now();
  const next = [...(state.fixed_assignments || []), ...(state.weekend_assignments || [])]
    .filter((x) => new Date(x.end_datetime || x.start_datetime).getTime() > now)
    .sort((a, b) => String(a.start_datetime || '').localeCompare(String(b.start_datetime || '')))[0];


  const nextStart = next ? new Date(next.start_datetime) : null;
  const nextText = next
    ? `Próxima operação: <b>${escapeHtml(next.station_id || 'Hub')}</b> · ${nextStart.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' })} às ${nextStart.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
    : 'Nenhuma operação publicada daqui para frente.';
  card.hidden = false;
  card.innerHTML = `
    <div class="action-card-head">
      <h3>${items.length ? `Precisa da sua resposta (${items.length})` : 'Nada esperando resposta sua ✓'}</h3>
      <small>${nextText}</small>
    </div>
    ${items.length ? `<ul>${items.join('')}</ul>` : ''}`;
  card.querySelectorAll('[data-go-view]').forEach((button) => { button.onclick = () => goToPortalView(button.dataset.goView); });
}

function renderNotifications() {
  const list = state.notifications.slice(0, 7);
  qs('#notification-list').innerHTML = list.length ? list.map((x) => `<div class="notification"><strong>${shortText(x.subject || x.title, 'Aviso')}</strong>${x.scheduled_for ? `<small class="notification-when">${agendaTypeLabel(x.event_type)} · ${fmtDateTime(x.scheduled_for)}${x.created_by_name ? ` · ${shortText(x.created_by_name)}` : ''}</small>` : ''}<p>${shortText(x.message)}</p>${agendaLink(x.event_url, 'notification-link')}${agendaResponseButtons(x)}<small>${fmtDateTime(x.created_at)}</small></div>`).join('') : empty('Nenhum aviso recente.');
  remindUpcomingAgenda();
}










function currentWeekRange() {
  const toIso = (d) => d.toLocaleDateString('sv-SE');
  if (scheduleView !== 'fixed') return { start: state.period.start, end: state.period.end };
  const start = new Date();
  start.setHours(12, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // segunda-feira
  if (weekOffset > 0) {
    const next = new Date(start);
    next.setDate(start.getDate() + 7 * weekOffset);
    if (state.period?.end && toIso(next) <= state.period.end) start.setTime(next.getTime());
  }
  const end = new Date(start);
  end.setDate(start.getDate() + 4); // sexta-feira
  return { start: toIso(start), end: toIso(end) };
}








function currentOperationalWeekRange() {
  const todayIso = operationalTodayIso();
  const today = new Date(todayIso + 'T12:00:00');
  const daysSinceSaturday = (today.getDay() + 1) % 7; // sáb=6→0, dom=0→1, seg=1→2, ..., sex=5→6
  const start = new Date(today);
  start.setDate(today.getDate() - daysSinceSaturday);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const toIso = (d) => d.toLocaleDateString('sv-SE');
  return { start: toIso(start), end: toIso(end) };
}

function renderWeek() {





  const range = currentWeekRange();
  const start = new Date(range.start + 'T12:00:00');


  const end = new Date(range.end + 'T12:00:00');
  const dayCount = Math.max(1, Math.round((end - start) / 86400000) + 1);

  const shownDays = [];
  for (let i = 0; i < dayCount; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    if (scheduleView === 'weekend' && d.getDay() !== 0 && d.getDay() !== 6) continue;
    shownDays.push(d);
  }
  qs('#week-grid').style.gridTemplateColumns = `repeat(${Math.max(1, shownDays.length)},minmax(160px,1fr))`;
  const days = [];
  for (const d of shownDays) {
    const iso = d.toISOString().slice(0, 10);
    const items = state.assignments.filter((x) => x.work_date === iso);
    const agenda = state.notifications.filter((x) => x.scheduled_for && String(x.scheduled_for).slice(0, 10) === iso);
    const timeoffs = state.absences.filter((x) => {
      const type = String(x.absence_type || '').toLowerCase();
      if (!type.includes('dsr') && !type.includes('compens') && !type.includes('folga dm')) return false;
      const eventStart = String(x.start_datetime || '').slice(0, 10);
      const eventEnd = String(x.end_datetime || '').slice(0, 10);
      const duration = new Date(x.end_datetime) - new Date(x.start_datetime);
      return eventStart === iso || (duration >= 86400000 && eventStart <= iso && eventEnd >= iso);
    });
    days.push(`
      <div class="day-column">
        <h3>${weekday[d.getDay()]} · ${d.toLocaleDateString('pt-BR', {day:'2-digit', month:'2-digit'})}</h3>
        ${agenda.map((x) => `<div class="agenda-day-card"><small>${agendaTypeLabel(x.event_type)} · ${new Date(x.scheduled_for).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}</small><strong>${shortText(x.subject || x.title, 'Agenda')}</strong><span>${shortText(x.message, '')}</span>${agendaLink(x.event_url)}${agendaResponseButtons(x)}</div>`).join('')}
        ${timeoffs.map((x) => {
          const type = String(x.absence_type || '').toLowerCase();
          const monthlySunday = type.includes('folga dm');
          const compensatory = type.includes('compens');











          const workingOvertime = type.includes('dsr')
            && (String(x.analyst_decision || '').toLowerCase() === 'overtime'
              || String(x.status || '').toLowerCase() === 'working_overtime');
          const colors = workingOvertime
            ? 'border-color:#86efac;background:#f0fdf4;color:#15803d'
            : monthlySunday
              ? 'border-color:#f9a8d4;background:#fdf2f8;color:#be185d'
              : compensatory
                ? 'border-color:#bfdbfe;background:#eff6ff;color:#1d4ed8'
                : 'border-color:#fed7aa;background:#fff7ed;color:#9a3412';
          const fallback = workingOvertime
            ? 'Hora extra confirmada - você vai trabalhar neste turno, DSR não será folgado hoje.'
            : monthlySunday
              ? 'Domingo fixo mensal definido pelo supervisor'
              : compensatory
                ? 'Folga compensatória definida pelo supervisor'
                : 'Descanso semanal remunerado';
          const label = workingOvertime ? 'Hora extra confirmada' : shortText(x.absence_type);
          return `
          <div class="timeoff-day-card" style="border:1px solid;border-radius:14px;padding:11px;margin-bottom:9px;${colors}">
            <strong style="display:block;font-size:12px">${label}</strong>
            <small style="display:block;font-size:10px;line-height:1.35;margin-top:4px">${workingOvertime ? fallback : multilineText(x.reason, fallback)}</small>
            <span style="display:block;font-size:10px;margin-top:6px;font-weight:700">${new Date(x.start_datetime).toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'})}–${new Date(x.end_datetime).toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'})}</span>
          </div>`;
        }).join('')}
        ${items.length ? items.map((x) => `
          <div class="assignment-card ${x.assignment_type === 'coverage' ? 'coverage' : ''}" data-hub="${x.hub_id || ''}" data-assignment="${x.id}">
            <strong>${x.station_id || x.title}</strong>
            <small>${x.hub_name || ''}</small>
            <span>${new Date(x.start_datetime).toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'})}–${new Date(x.end_datetime).toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'})} · ${x.cycle_code || x.assignment_type}</span>
            ${operationStatusBadge(x)}
          </div>`).join('') : (timeoffs.length ? '' : empty('Livre'))}
      </div>`);
  }
  qs('#week-grid').innerHTML = days.join('');
  qsa('.assignment-card[data-hub]').forEach((el) => el.onclick = () => openHub(el.dataset.hub, el.dataset.assignment));
}

function uniqueHubs() {



  const range = currentWeekRange();
  const map = new Map();
  state.assignments.filter((x) => x.hub_id && String(x.work_date) >= range.start && String(x.work_date) <= range.end).forEach((x) => {
    if (!map.has(x.hub_id)) map.set(x.hub_id, x);
  });
  return [...map.values()];
}

function hubCard(hub, assigned=false) {
  const id = hub.hub_id || hub.id;
  const station = hub.station_id || hub.title || 'Hub';
  const name = hub.hub_name || hub.name || '';
  const assignmentCycles = [...(state.assignments || []), ...(state.weekend_assignments || [])]
    .filter((item) => String(item.hub_id) === String(id))
    .map((item) => item.cycle_code)
    .filter(Boolean);
  const suppliedCycles = Array.isArray(hub.cycles)
    ? hub.cycles.map((cycle) => typeof cycle === 'string' ? cycle : cycle.cycle_code || cycle.code).filter(Boolean)
    : [];
  const cycles = [...new Set([...suppliedCycles, ...assignmentCycles, hub.cycle_code].filter(Boolean))].join(' · ') || 'Ciclo não informado';
  const notes = hub.hub_notes || hub.notes || '';
  return `
    <div class="hub-card ${assigned ? 'assigned' : ''}" data-hub="${id}" role="button" tabindex="0" aria-label="Abrir particularidades de ${escapeHtml(station)}">
      <div class="hub-card-head">
        <h3>${shortText(station)} · ${shortText(name, '')}</h3>
        ${assigned ? '<span class="type-pill">Semana</span>' : '<span class="type-pill neutral">Base</span>'}
      </div>
      <p><strong>Ciclos:</strong> ${shortText(cycles)}</p>
      <p><strong>Regional:</strong> ${shortText(hub.region_code)} ${hub.subregion ? `· ${shortText(hub.subregion)}` : ''}</p>
      <p class="hub-notes">${multilineText(notes, 'Sem particularidades cadastradas.')}</p>
    </div>`;
}

function renderHubs() {
  const assigned = uniqueHubs();
  const content = assigned.length ? `<section class="hub-section"><h3>Hubs vinculados à minha semana</h3><div class="hub-grid-inner">${assigned.map((x) => hubCard(x, true)).join('')}</div></section>` : '';
  qs('#hub-grid').innerHTML = content || empty('Nenhum hub vinculado para sua semana atual.');
  qsa('.hub-card').forEach((el) => {
    const open = () => openHub(el.dataset.hub);
    el.onclick = open;
    el.onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
    };
  });
}


function loadOccurrenceHistory(assignmentId) {
  const holder = qs('#operation-occurrence-history');
  if (!holder) return;
  const items = (state.occurrences || []).filter((item) => Number(item.assignment_id) === Number(assignmentId));
  holder.innerHTML = items.length ? items.map((item) => {
    const returned = item.status === 'resolved' || item.status === 'reviewing' || Boolean(item.decision);
    const decisionLabel = item.decision === 'approved' ? 'Aprovada' : item.decision === 'adjusted' ? 'Ajustada' : item.decision === 'rejected' ? 'Reprovada' : item.decision === 'verifying' ? 'Verificando' : 'Em análise';
    return `<div class="occurrence-history-item"><div class="occurrence-history-head"><strong>${shortText(item.type || item.occurrence_label || item.type_code)} · ${decisionLabel}</strong></div><small>${shortText(item.message)} · ${fmtDateTime(item.created_at)}</small>${returned ? `<div class="occurrence-return ${item.decision === 'rejected' ? 'rejected' : item.decision === 'verifying' ? 'reviewing' : ''}"><b>Retorno do supervisor:</b> ${shortText(item.supervisor_note, 'Sem justificativa informada.')}</div>` : ''}</div>`;
  }).join('') : empty('Nenhuma ocorrência registrada nesta operação.');
}

async function sendLocalOccurrence(assignmentId) {
  const button = qs(`#occurrence-send-${assignmentId}`);
  const status = qs(`#occurrence-form-status-${assignmentId}`);
  const typeCode = qs(`#occurrence-type-${assignmentId}`)?.value || 'outro';
  const message = (qs(`#occurrence-message-${assignmentId}`)?.value || '').trim();
  if (message.length < 3) { status.className = 'form-status error'; status.textContent = 'Descreva a ocorrência antes de enviar.'; return; }
  button.classList.add('sending'); button.textContent = 'Enviando ocorrência…';
  try {
    const eventKey = `${currentToken()}:occurrence:${crypto.randomUUID()}`;
    const response = await fetch(api("rpc/rt_analyst_create_occurrence"), {
      method: "POST",
      headers,
      body: JSON.stringify({
        p_token: currentToken(), p_assignment_id: Number(assignmentId),
        p_type_code: typeCode, p_message: message, p_event_key: eventKey,
      }),
    });
    if (!response.ok) throw new Error('Não foi possível enviar a ocorrência.');
    const saved = await response.json().catch(() => ({}));
    if (saved?.event_id) trackEventDelivery(saved.event_id);
    qs(`#occurrence-message-${assignmentId}`).value = '';
    status.className = 'form-status success';
    status.textContent = 'Ocorrência registrada; o supervisor verá assim que o Routing Tower processar.';
    loadOccurrenceHistory(assignmentId);
  } catch (error) {
    status.className = 'form-status error'; status.textContent = error.message;
  } finally {
    button.classList.remove('sending'); button.textContent = 'Enviar ocorrência ao supervisor';
  }
}










async function validateRomaneioLink(romaneioUrl, assignment) {
  let response;
  try {
    response = await fetch(`${ROMANEIO_VALIDATION_ENDPOINT}?hub=${encodeURIComponent(romaneioUrl)}`);
  } catch {
    throw new Error('Não foi possível conferir o Romaneio agora. Verifique sua conexão e tente novamente.');
  }







  const rawBody = await response.text();
  let payload = null;
  try { payload = JSON.parse(rawBody); } catch { payload = null; }
  if (!payload) {
    if (/Authorization needed|accounts\.google\.com\/o\/oauth2/i.test(rawBody)) {
      const authError = new Error('Você ainda não autorizou a checagem automática de Romaneio no Google. Autorize o acesso abaixo e tente novamente.');
      authError.romaneioAuthNeeded = true;
      throw authError;
    }
    throw new Error('Romaneio não encontrado. Confira o link colado.');
  }
  if (!response.ok || payload.error || (Number(payload.code) || 200) >= 400) {
    throw new Error(payload?.error || payload?.name || 'Romaneio não encontrado. Confira o link colado.');
  }







  const cleanApiHubName = (value) => String(value || '')
    .replace(/^\s*LM[\s_]*Hub[\s_]*/i, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();








  const normalize = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const expectedHub = normalize(assignment?.hub_name);
  const expectedCiclo = normalize(assignment?.cycle_code);
  const foundHubDisplay = cleanApiHubName(payload.hub);
  const foundHub = normalize(foundHubDisplay);
  const foundCiclo = normalize(payload.ciclo);
  if (expectedHub && foundHub && expectedHub !== foundHub) {
    throw new Error(`Esse romaneio é do Hub "${foundHubDisplay}", mas você está finalizando uma operação do Hub "${assignment.hub_name}". Confira o link colado.`);
  }
  if (expectedCiclo && foundCiclo && expectedCiclo !== foundCiclo) {
    throw new Error(`Esse romaneio é do ciclo "${payload.ciclo}", mas a operação sendo finalizada é do ciclo "${assignment.cycle_code}". Confira o link colado.`);
  }
  return payload;
}

async function submitRomaneio(assignmentId) {
  const input = qs(`#romaneio-url-${assignmentId}`);
  const status = qs(`#romaneio-form-status-${assignmentId}`);
  const button = qs(`[data-action="submit-romaneio"][data-assignment-id="${assignmentId}"]`);
  const romaneioUrl = (input?.value || '').trim();
  const assignment = findAssignment(assignmentId);
  try { new URL(romaneioUrl); } catch { status.className = 'form-status error'; status.textContent = 'Cole um link válido do Romaneio.'; return; }
  if (ROMANEIO_VALIDATION_ENABLED) {
    if (button) { button.disabled = true; button.classList.add('sending'); button.textContent = 'Validando Romaneio…'; }
    status.className = 'form-status'; status.textContent = 'Conferindo o Romaneio…';
    try {
      await validateRomaneioLink(romaneioUrl, assignment);
    } catch (error) {
      status.className = 'form-status error';













      if (error.romaneioAuthNeeded) {
        const authBtnId = `romaneio-auth-btn-${assignmentId}`;
        status.innerHTML = `${error.message} <button type="button" id="${authBtnId}" class="notification-link">Autorizar acesso</button>`;
        const authBtn = qs(`#${authBtnId}`);
        if (authBtn) authBtn.onclick = () => {
          authBtn.disabled = true;
          authBtn.textContent = 'Aguardando autorização…';



          const popupWidth = 650;
          const popupHeight = 725;
          const popupLeft = Math.round((window.screen.width - popupWidth) / 2);
          const popupTop = Math.round((window.screen.height - popupHeight) / 2);
          const authWindow = window.open(
            `${ROMANEIO_VALIDATION_ENDPOINT}?hub=${encodeURIComponent(romaneioUrl)}&autoclose=1`,
            '_blank',
            `width=${popupWidth},height=${popupHeight},top=${popupTop},left=${popupLeft}`
          );
          if (!authWindow) {


            authBtn.disabled = false;
            authBtn.textContent = 'Autorizar acesso';
            return;
          }
          const poll = setInterval(() => {
            if (!authWindow.closed) return;
            clearInterval(poll);
            submitRomaneio(assignmentId);
          }, 500);
        };
      } else {
        status.textContent = error.message;
      }
      if (button) { button.disabled = false; button.classList.remove('sending'); button.textContent = 'Salvar Romaneio e finalizar operação'; }
      return;
    }
  } else {
    if (button) { button.disabled = true; button.classList.add('sending'); }
  }
  if (button) button.textContent = 'Salvando Romaneio…';
  try {
    const response = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/rt_analyst_save_romaneio`, {
      method: "POST",
      headers,
      body: JSON.stringify({ p_token: currentToken(), p_assignment_id: Number(assignmentId), p_romaneio_url: romaneioUrl }),
    });
    if (!response.ok) {
      const problem = await response.json().catch(() => ({}));
      throw new Error(problem?.message || 'Não foi possível salvar o Romaneio.');
    }
    updateAssignmentCopies(assignmentId, { romaneio_url: romaneioUrl, operation_status: 'finished' });
    status.className = 'form-status success'; status.textContent = 'Romaneio salvo. A operação foi finalizada automaticamente.';
    toast('Romaneio salvo e operação finalizada');
    setTimeout(() => { qs('#hub-dialog').close(); render(); }, 900);
  } catch (error) {
    status.className = 'form-status error'; status.textContent = error.message;
  } finally {
    if (button) { button.disabled = false; button.classList.remove('sending'); button.textContent = 'Salvar Romaneio e finalizar operação'; }
  }
}




async function submitCancellationReason(assignmentId) {
  const input = qs(`#cancel-reason-${assignmentId}`);
  const status = qs(`#cancel-reason-form-status-${assignmentId}`);
  const button = qs(`[data-action="submit-cancel-reason"][data-assignment-id="${assignmentId}"]`);
  const reason = (input?.value || '').trim();
  if (reason.length < 5) {
    status.className = 'form-status error';
    status.textContent = 'Descreva o motivo do cancelamento (pelo menos 5 caracteres).';
    return;
  }
  if (button) { button.disabled = true; button.classList.add('sending'); button.textContent = 'Salvando motivo…'; }
  status.className = 'form-status'; status.textContent = 'Salvando no Supabase…';
  try {
    const response = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/rt_analyst_save_cancellation_reason`, {
      method: "POST",
      headers,
      body: JSON.stringify({ p_token: currentToken(), p_assignment_id: Number(assignmentId), p_reason: reason }),
    });
    if (!response.ok) {
      const problem = await response.json().catch(() => ({}));
      throw new Error(problem?.message || 'Não foi possível salvar a justificativa do cancelamento.');
    }
    updateAssignmentCopies(assignmentId, { cancellation_reason: reason, operation_status: 'cancelled_route' });
    status.className = 'form-status success'; status.textContent = 'Motivo salvo. A roteirização foi marcada como cancelada.';
    toast('Motivo salvo e roteirização cancelada');
    setTimeout(() => { qs('#hub-dialog').close(); render(); }, 900);
  } catch (error) {
    status.className = 'form-status error'; status.textContent = error.message;
  } finally {
    if (button) { button.disabled = false; button.classList.remove('sending'); button.textContent = 'Salvar motivo e cancelar operação'; }
  }
}


let activeHubForm = null;
let hubFormEditing = false;

function boolValue(...values) {
  const value = values.find((item) => item !== undefined && item !== null && item !== '');
  return value === true || value === 1 || String(value || '').toLowerCase() === 'true' || String(value || '').toLowerCase() === 'sim';
}

function hubCycleRows(hub, hubId) {
  const supplied = [hub.cycle_details, hub.particularities, hub.hub_cycles, hub.cycles_data, Array.isArray(hub.cycles) ? hub.cycles : null]
    .find((value) => Array.isArray(value) && value.length);
  const assignments = [...(state.assignments || []), ...(state.weekend_assignments || [])]
    .filter((item) => String(item.hub_id) === String(hubId));
  const source = supplied || assignments;
  if (source.length) {
    const unique = new Map();
    source.map((cycle, index) => normalizeHubCycle(cycle, hub, index)).forEach((cycle) => {
      const key = String(cycle.cycle_code).trim().toLowerCase();
      if (!unique.has(key)) unique.set(key, cycle);
      else if (cycle.clusters.length) {
        const current = unique.get(key);
        const seen = new Set(current.clusters.map((cluster) => String(cluster.id || cluster.name)));
        current.clusters.push(...cycle.clusters.filter((cluster) => !seen.has(String(cluster.id || cluster.name))));
      }
    });
    return [...unique.values()];
  }
  const codes = String(hub.cycles || hub.cycle_code || 'Ciclo não informado').split(/[,;/]+/).map((item) => item.trim()).filter(Boolean);
  return codes.map((code, index) => normalizeHubCycle({ cycle_code: code }, hub, index));
}

function normalizeHubCycle(cycle, hub, index) {
  const start = cycle.start_datetime ? new Date(cycle.start_datetime).toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'}) : cycle.start_time;
  const end = cycle.end_datetime ? new Date(cycle.end_datetime).toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'}) : cycle.end_time;
  const clusterSource = [cycle.clusters, cycle.cluster_details, cycle.cluster_rules, hub.clusters]
    .find((value) => Array.isArray(value) && value.length) || [];
  const modalRulesSource = cycle.modal_rules || cycle.modalRules || {};
  const modalRule = (key, legacyAvailability, legacySpr) => {
    const rule = modalRulesSource[key] || {};
    return {
      availability: rule.availability ?? rule.status ?? legacyAvailability ?? '',
      scope: rule.scope || rule.application_type || 'all',
      details: rule.details || rule.cities_ceps || rule.rule || '',
      spr_max: rule.spr_max ?? rule.max_spr ?? legacySpr ?? '',
    };
  };
  const normalized = {
    id: cycle.id || cycle.cycle_id || `${hub.hub_id || hub.id || 'hub'}-${index}`,
    cycle_code: cycle.cycle_code || cycle.code || cycle.cycle || `Ciclo ${index + 1}`,
    cluster: cycle.cluster || cycle.cluster_name || cycle.area_name || 'Todos os clusters do Hub',
    window_info: cycle.window_info || (start && end ? `${start}–${end}` : hub.window_info || ''),
    can_route: cycle.can_route ?? cycle.can_rout ?? cycle.routable ?? true,
    rr: cycle.rr ?? cycle.rr_available ?? '',
    passeio: cycle.passeio ?? cycle.car_available ?? '',
    moto: cycle.moto ?? cycle.motorcycle_available ?? hub.motorcycle_info ?? '',
    volumoso: cycle.volumoso ?? cycle.bulky_available ?? '',
    spr_rr: cycle.spr_rr ?? '',
    spr_passeio: cycle.spr_passeio ?? '',
    spr_moto: cycle.spr_moto ?? '',
    spr_volumoso: cycle.spr_volumoso ?? '',
    remove_offices: boolValue(cycle.remove_offices, cycle.retirar_offices),
    success_label: boolValue(cycle.success_label, cycle.use_success_label),
    removed_ceps: cycle.removed_ceps || cycle.ceps_removed || cycle.cep_exceptions || '',
    particularity: cycle.particularity || cycle.notes || cycle.hub_notes || hub.hub_notes || hub.notes || '',
    saturday_actions: cycle.saturday_actions || cycle.acoes_sabado || '',
    sunday_actions: cycle.sunday_actions || cycle.acoes_domingo || '',
    week_notes: cycle.week_notes || cycle.observacoes_semana || '',
    weekend_notes: cycle.weekend_notes || cycle.observacoes_fim_semana || '',
    clusters: clusterSource.map((cluster, clusterIndex) => ({
      id: cluster.id || cluster.cluster_id || `${index}-${clusterIndex}`,
      order: cluster.order ?? cluster.ord ?? clusterIndex + 1,
      name: cluster.name || cluster.cluster_name || cluster.cluster || `Cluster ${clusterIndex + 1}`,
      spr_min: cluster.spr_min ?? '',
      spr_max: cluster.spr_max ?? '',
      receives_moto: boolValue(cluster.receives_moto, cluster.moto, cluster.can_receive_motorcycle),
      moto_mode: String(cluster.moto_mode || cluster.motorcycle_allocation || '').toLowerCase() === 'all' || String(cluster.moto_quantity || '').toLowerCase() === 'tudo' ? 'all' : 'quantity',
      moto_quantity: String(cluster.moto_quantity ?? cluster.motorcycles ?? '').toLowerCase() === 'tudo' ? '' : (cluster.moto_quantity ?? cluster.motorcycles ?? ''),
      spr_moto: cluster.spr_moto || cluster.motorcycle_spr || 'Padrão',
      observation: cluster.observation || cluster.notes || '',
    })),
  };
  normalized.modal_rules = {
    rr: modalRule('rr', normalized.rr, normalized.spr_rr),
    passeio: modalRule('passeio', normalized.passeio, normalized.spr_passeio),
    moto: modalRule('moto', normalized.moto, normalized.spr_moto),
    volumoso: modalRule('volumoso', normalized.volumoso, normalized.spr_volumoso),
  };
  return normalized;
}

function hubResourceLink(label, value) {
  const href = String(value || '').trim();
  return href
    ? `<a class="hub-resource-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)} <span>↗</span></a>`
    : `<span class="hub-resource-link unavailable">${escapeHtml(label)} <small>Não informado</small></span>`;
}

function hubField(label, name, value='', options={}) {
  const classes = ['hub-form-field', options.span || ''].filter(Boolean).join(' ');
  if (options.type === 'checkbox') return `<label class="${classes}"><span>${escapeHtml(label)}</span><span class="hub-toggle"><input type="checkbox" data-hub-field name="${name}" ${value ? 'checked' : ''} disabled><i></i><b>${options.help || 'Aplicar neste ciclo'}</b></span></label>`;
  if (options.type === 'select') return `<label class="${classes}"><span>${escapeHtml(label)}</span><select data-hub-field name="${name}" disabled><option value="true" ${value ? 'selected' : ''}>Pode roteirizar</option><option value="false" ${!value ? 'selected' : ''}>Não pode roteirizar</option></select></label>`;
  if (options.type === 'textarea') return `<label class="${classes}"><span>${escapeHtml(label)}</span><textarea data-hub-field name="${name}" rows="${options.rows || 3}" placeholder="${escapeHtml(options.placeholder || 'Não informado')}" disabled>${escapeHtml(value)}</textarea></label>`;
  return `<label class="${classes}"><span>${escapeHtml(label)}</span><input data-hub-field name="${name}" type="${options.type || 'text'}" value="${escapeHtml(value)}" placeholder="${escapeHtml(options.placeholder || 'Não informado')}" disabled></label>`;
}





function clusterRowMarkup(cluster, index, options = {}) {
  const disabledAttr = options.disabled ? ' disabled' : '';
  const receivesMoto = cluster.receives_moto !== false;
  return `<tr data-cluster-index="${index}" ${cluster.id ? '' : 'data-placeholder="true"'}>
    <td><input data-hub-field name="cluster_name" value="${escapeHtml(cluster.name)}" placeholder="Nome da cidade ou cluster"${disabledAttr}></td>
    <td><input data-hub-field name="cluster_spr_max" type="number" min="0" value="${escapeHtml(cluster.spr_max)}" placeholder="SPR máximo"${disabledAttr}></td>
    <td><select data-hub-field name="cluster_receives_moto"${disabledAttr}><option value="sim" ${receivesMoto ? 'selected' : ''}>Sim</option><option value="nao" ${!receivesMoto ? 'selected' : ''}>Não</option></select></td>
    <td><div class="cluster-quantity"><input data-hub-field name="cluster_moto_quantity" type="number" min="0" value="${escapeHtml(cluster.moto_quantity)}" ${cluster.moto_mode === 'all' ? 'hidden' : ''} placeholder="0"${disabledAttr}><button type="button" data-cluster-everything class="${cluster.moto_mode === 'all' ? 'active' : ''}"${disabledAttr}>${cluster.moto_mode === 'all' ? 'Tudo' : 'Usar tudo'}</button></div></td>
    <td><input data-hub-field name="cluster_order" type="number" min="1" value="${escapeHtml(cluster.order ?? '')}" placeholder="${index + 1}"${disabledAttr}></td>
    <td><input data-hub-field name="cluster_observation" value="${escapeHtml(cluster.observation)}" placeholder="Regra, restrição ou detalhe"${disabledAttr}></td>
  </tr>`;
}

function cycleClusterTable(cycle) {
  const rows = cycle.clusters.length ? cycle.clusters : [{id:'',name:'',spr_max:'',receives_moto:true,moto_quantity:'',moto_mode:'quantity',order:'',observation:''}];
  return `<div class="cluster-all-row"><span><strong>CLUSTERS</strong><small>Informe a quantidade ou selecione “Tudo” para cada cluster.</small></span><div class="cluster-all-actions"><button type="button" class="cluster-all-btn" data-export-cluster-model>Exportar modelo</button><button type="button" class="cluster-all-btn" data-import-cluster-excel disabled>Importar Excel</button><button type="button" class="cluster-all-btn" data-add-cluster disabled>+ Adicionar cluster</button></div></div>
    <div class="cluster-table-wrap"><table class="cluster-moto-table"><thead><tr><th>CLUSTER</th><th>SPR MAXIMO</th><th>MOTOS</th><th>QUANTIDADE DE MOTOS</th><th>ORDEM DE CONFIRMAÇÃO</th><th>OBSERVAÇÃO</th></tr></thead><tbody>${rows.map((cluster, index) => clusterRowMarkup(cluster, index, {disabled:true})).join('')}</tbody></table></div>`;
}

function modalRuleCard(key, label, rule) {
  const option = (value, text) => `<option value="${value}" ${rule.scope === value ? 'selected' : ''}>${text}</option>`;
  return `<article class="modal-rule-card" data-modal="${key}">
    <header><strong>${label}</strong><span>Regra deste modal</span></header>
    ${hubField('Pode fazer?', `modal_${key}_availability`, rule.availability, {placeholder:'Ex.: Sim, Não ou sob validação'})}
    ${hubField('SPR Máx.', `modal_${key}_spr_max`, rule.spr_max, {type:'number',placeholder:'Informe o limite'})}
    <label class="hub-form-field modal-scope"><span>Aplicar por</span><select data-hub-field name="modal_${key}_scope" disabled>${option('all','Todos os clusters')}${option('city','Cidade / cluster')}${option('cep','Lista de CEP')}${option('custom','Outra regra')}</select></label>
    ${hubField('Cidades, clusters, CEPs ou regra', `modal_${key}_details`, rule.details, {type:'textarea',rows:3,span:'modal-details',placeholder:'Ex.: somente Embu; CEPs 06800-000 a 06849-999; retirar determinada região'})}
  </article>`;
}

function cycleFormCard(cycle, index) {
  return `<section class="hub-cycle-page ${index === 0 ? 'active' : ''}" data-cycle-index="${index}" aria-hidden="${index === 0 ? 'false' : 'true'}">
    <div class="selected-cycle-head"><div><span class="cycle-code">${shortText(cycle.cycle_code)}</span><strong>${shortText(cycle.cluster)}</strong><small>${shortText(cycle.window_info, 'Janela não informada')}</small></div><span class="route-status ${cycle.can_route ? 'allowed' : 'blocked'}">${cycle.can_route ? 'Pode roteirizar' : 'Não pode roteirizar'}</span></div>
    <div class="hub-smart-form">
      <p class="hub-form-section-title">Configuração do ciclo</p>
      ${hubField('Janela de roteirização', 'window_info', cycle.window_info)}
      ${hubField('Permissão', 'can_route', cycle.can_route, {type:'select'})}
      ${hubField('Retirar offices', 'remove_offices', cycle.remove_offices, {type:'checkbox'})}
      ${hubField('Success Label', 'success_label', cycle.success_label, {type:'checkbox'})}
      <p class="hub-form-section-title">Regras de roteirização por modal</p>
      <div class="modal-rules-grid span-all">${modalRuleCard('rr','RR',cycle.modal_rules.rr)}${modalRuleCard('passeio','Passeio',cycle.modal_rules.passeio)}${modalRuleCard('moto','Moto',cycle.modal_rules.moto)}${modalRuleCard('volumoso','Volumoso',cycle.modal_rules.volumoso)}</div>
      <p class="hub-form-section-title">CLUSTERS</p>
      <div class="span-all">${cycleClusterTable(cycle)}</div>
      <p class="hub-form-section-title">Particularidades e exceções</p>
      ${hubField('CEPs retirados / exceções de CEP', 'removed_ceps', cycle.removed_ceps, {type:'textarea',rows:4,span:'span-all',placeholder:'Informe CEPs, faixas ou regras de retirada'})}
      ${hubField('Particularidade do ciclo', 'particularity', cycle.particularity, {type:'textarea',rows:5,span:'span-all',placeholder:'Ex.: de sexta para sábado, retirar offices e aplicar Success Label'})}
      ${hubField('Ações de sábado', 'saturday_actions', cycle.saturday_actions, {type:'textarea',rows:4,span:'span-half'})}
      ${hubField('Ações de domingo', 'sunday_actions', cycle.sunday_actions, {type:'textarea',rows:4,span:'span-half'})}
      ${hubField('Observações da semana', 'week_notes', cycle.week_notes, {type:'textarea',rows:4,span:'span-half'})}
      ${hubField('Observações de fim de semana', 'weekend_notes', cycle.weekend_notes, {type:'textarea',rows:4,span:'span-half'})}
    </div>
  </section>`;
}

function setHubFormEditing(editing) {
  hubFormEditing = editing;
  qsa('#hub-particularity-form [data-hub-field]').forEach((field) => { field.disabled = !editing; });
  qsa('#hub-particularity-form [data-add-cluster], #hub-particularity-form [data-cluster-everything], #hub-particularity-form [data-import-cluster-excel]').forEach((button) => { button.disabled = !editing; });
  const editButton = qs('#hub-edit-btn');
  const saveButton = qs('#hub-save-btn');
  if (editButton) editButton.textContent = editing ? 'Cancelar ajustes' : 'Ajustar';
  if (saveButton) saveButton.disabled = !editing;
  const status = qs('#hub-form-status');
  if (status) status.textContent = editing ? 'Modo de edição ativo. Revise os ciclos antes de salvar.' : 'Informações sincronizadas';
}

function readHubForm() {
  return {
    hub_id: activeHubForm.hubId,
    station_id: activeHubForm.station,
    hub_name: activeHubForm.name,
    version: activeHubForm.version,
    links: {
      planning: qs('[name="planning_url"]')?.value.trim() || '',
      motorcycles: qs('[name="motorcycle_url"]')?.value.trim() || '',
      files: qs('[name="files_url"]')?.value.trim() || '',
      romaneio_folder: qs('[name="romaneio_folder_url"]')?.value.trim() || '',
    },
    hub_notes: qs('[name="hub_notes"]')?.value.trim() || '',
    cycles: qsa('.hub-cycle-page').map((card) => {
      const value = (name) => card.querySelector(`[name="${name}"]`);
      const sourceCycle = activeHubForm.cycles[Number(card.dataset.cycleIndex)];
      return {
        id: sourceCycle.id,
        cycle_code: sourceCycle.cycle_code,
        cluster: sourceCycle.cluster,
        window_info: value('window_info').value.trim(),
        can_route: value('can_route').value === 'true',
        remove_offices: value('remove_offices').checked,
        success_label: value('success_label').checked,
        rr: value('modal_rr_availability').value.trim(), passeio: value('modal_passeio_availability').value.trim(),
        moto: value('modal_moto_availability').value.trim(), volumoso: value('modal_volumoso_availability').value.trim(),
        spr_rr: value('modal_rr_spr_max').value.trim(), spr_passeio: value('modal_passeio_spr_max').value.trim(),
        spr_moto: value('modal_moto_spr_max').value.trim(), spr_volumoso: value('modal_volumoso_spr_max').value.trim(),
        modal_rules: Object.fromEntries(['rr','passeio','moto','volumoso'].map((modal) => [modal, {
          availability: value(`modal_${modal}_availability`).value.trim(),
          spr_max: value(`modal_${modal}_spr_max`).value.trim(),
          scope: value(`modal_${modal}_scope`).value,
          details: value(`modal_${modal}_details`).value.trim(),
        }])),
        removed_ceps: value('removed_ceps').value.trim(),
        particularity: value('particularity').value.trim(),
        saturday_actions: value('saturday_actions').value.trim(),
        sunday_actions: value('sunday_actions').value.trim(),
        week_notes: value('week_notes').value.trim(),
        weekend_notes: value('weekend_notes').value.trim(),
        clusters: [...card.querySelectorAll('tbody tr[data-cluster-index]')].map((row) => {
          const field = (name) => row.querySelector(`[name="${name}"]`);
          const original = sourceCycle.clusters[Number(row.dataset.clusterIndex)];
          const allButton = row.querySelector('[data-cluster-everything]');
          const orderField = field('cluster_order');
          const receivesMotoField = field('cluster_receives_moto');
          return {
            id: original?.id || '',
            order: Number(orderField?.value) || original?.order || Number(row.dataset.clusterIndex) + 1,
            name: field('cluster_name').value.trim(),
            spr_min: original?.spr_min || '',
            spr_max: field('cluster_spr_max').value.trim(),
            receives_moto: receivesMotoField ? receivesMotoField.value === 'sim' : true,
            moto_mode: allButton.classList.contains('active') ? 'all' : 'quantity',
            moto_quantity: allButton.classList.contains('active') ? '' : field('cluster_moto_quantity').value,
            spr_moto: original?.spr_moto || '',
            observation: field('cluster_observation').value.trim(),
          };
        }).filter((cluster) => cluster.name || cluster.moto_quantity || cluster.moto_mode === 'all' || cluster.spr_max || cluster.observation),
      };
    }),
  };
}








const XLSX_CRC_TABLE = (() => {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function xlsxCrc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = XLSX_CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function xlsxU16(n) { return [n & 0xFF, (n >>> 8) & 0xFF]; }
function xlsxU32(n) { return [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]; }

function buildZipArchive(files) {
  const encoder = new TextEncoder();
  const localParts = []; const centralParts = [];
  let offset = 0;
  const dosTime = 0, dosDate = 0x21; // data fixa (irrelevante - é um arquivo gerado na hora)
  files.forEach((file) => {
    const nameBytes = encoder.encode(file.name);
    const data = file.data;
    const crc = xlsxCrc32(data);
    const size = data.length;
    const localHeader = new Uint8Array([
      ...xlsxU32(0x04034b50), ...xlsxU16(20), ...xlsxU16(0), ...xlsxU16(0),
      ...xlsxU16(dosTime), ...xlsxU16(dosDate), ...xlsxU32(crc), ...xlsxU32(size), ...xlsxU32(size),
      ...xlsxU16(nameBytes.length), ...xlsxU16(0),
    ]);
    const localEntry = new Uint8Array(localHeader.length + nameBytes.length + data.length);
    localEntry.set(localHeader, 0);
    localEntry.set(nameBytes, localHeader.length);
    localEntry.set(data, localHeader.length + nameBytes.length);
    localParts.push(localEntry);

    const centralHeader = new Uint8Array([
      ...xlsxU32(0x02014b50), ...xlsxU16(20), ...xlsxU16(20), ...xlsxU16(0), ...xlsxU16(0),
      ...xlsxU16(dosTime), ...xlsxU16(dosDate), ...xlsxU32(crc), ...xlsxU32(size), ...xlsxU32(size),
      ...xlsxU16(nameBytes.length), ...xlsxU16(0), ...xlsxU16(0), ...xlsxU16(0), ...xlsxU16(0), ...xlsxU32(0),
      ...xlsxU32(offset),
    ]);
    const centralEntry = new Uint8Array(centralHeader.length + nameBytes.length);
    centralEntry.set(centralHeader, 0);
    centralEntry.set(nameBytes, centralHeader.length);
    centralParts.push(centralEntry);

    offset += localEntry.length;
  });
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const centralOffset = offset;
  const eocd = new Uint8Array([
    ...xlsxU32(0x06054b50), ...xlsxU16(0), ...xlsxU16(0), ...xlsxU16(files.length), ...xlsxU16(files.length),
    ...xlsxU32(centralSize), ...xlsxU32(centralOffset), ...xlsxU16(0),
  ]);
  const result = new Uint8Array(offset + centralSize + eocd.length);
  let pos = 0;
  localParts.forEach((part) => { result.set(part, pos); pos += part.length; });
  centralParts.forEach((part) => { result.set(part, pos); pos += part.length; });
  result.set(eocd, pos);
  return result;
}

function xlsxXmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function xlsxColumnName(index) {
  let n = index + 1; let name = '';
  while (n > 0) { const rem = (n - 1) % 26; name = String.fromCharCode(65 + rem) + name; n = Math.floor((n - 1) / 26); }
  return name;
}

function buildXlsxBlob(sheetName, headerRow, dataRows) {
  const encoder = new TextEncoder();
  const allRows = [headerRow, ...dataRows];
  const rowsXml = allRows.map((row, rowIndex) => {
    const r = rowIndex + 1;
    const cells = row.map((value, colIndex) => `<c r="${xlsxColumnName(colIndex)}${r}" t="inlineStr"><is><t xml:space="preserve">${xlsxXmlEscape(value)}</t></is></c>`).join('');
    return `<row r="${r}">${cells}</row>`;
  }).join('');
  const dim = allRows.length ? `A1:${xlsxColumnName((allRows[0].length || 1) - 1)}${allRows.length}` : 'A1';
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="${dim}"/><sheetData>${rowsXml}</sheetData></worksheet>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xlsxXmlEscape(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`;
  const files = [
    { name: '[Content_Types].xml', data: encoder.encode(contentTypes) },
    { name: '_rels/.rels', data: encoder.encode(rootRels) },
    { name: 'xl/workbook.xml', data: encoder.encode(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: encoder.encode(workbookRels) },
    { name: 'xl/styles.xml', data: encoder.encode(styles) },
    { name: 'xl/worksheets/sheet1.xml', data: encoder.encode(sheet) },
  ];
  return new Blob([buildZipArchive(files)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}








async function inflateRawBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function readZipEntries(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const maxBack = Math.min(bytes.length, 65557);
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= bytes.length - maxBack && i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) throw new Error('Arquivo .xlsx inválido (fim de diretório ZIP não encontrado).');
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  let pos = view.getUint32(eocdOffset + 16, true);
  const entries = {};
  const decoder = new TextDecoder();
  for (let i = 0; i < totalEntries; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;
    const method = view.getUint16(pos + 10, true);
    const compSize = view.getUint32(pos + 20, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);
    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    entries[name] = { method, compSize, localHeaderOffset };
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return { bytes, view, entries };
}

async function readZipEntryText(zip, name) {
  const entry = zip.entries[name];
  if (!entry) return null;
  const { view, bytes } = zip;
  const off = entry.localHeaderOffset;
  if (view.getUint32(off, true) !== 0x04034b50) throw new Error('Arquivo .xlsx corrompido.');
  const nameLen = view.getUint16(off + 26, true);
  const extraLen = view.getUint16(off + 28, true);
  const dataStart = off + 30 + nameLen + extraLen;
  const compressed = bytes.subarray(dataStart, dataStart + entry.compSize);
  const raw = entry.method === 0 ? compressed : await inflateRawBytes(compressed);
  return new TextDecoder('utf-8').decode(raw);
}

function parseSharedStrings(xmlText) {
  if (!xmlText) return [];
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  return [...doc.getElementsByTagName('si')].map((si) => [...si.getElementsByTagName('t')].map((t) => t.textContent || '').join(''));
}

function xlsxColumnIndex(ref) {
  const letters = (String(ref || '').match(/[A-Z]+/) || ['A'])[0];
  let index = 0;
  for (const ch of letters) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

function parseSheetRows(xmlText, sharedStrings) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  return [...doc.getElementsByTagName('row')].map((rowEl) => {
    const row = [];
    [...rowEl.getElementsByTagName('c')].forEach((cellEl) => {
      const ref = cellEl.getAttribute('r');
      const idx = ref ? xlsxColumnIndex(ref) : row.length;
      const type = cellEl.getAttribute('t');
      let value = '';
      if (type === 'inlineStr') {
        const isEl = cellEl.getElementsByTagName('is')[0];
        value = isEl ? (isEl.textContent || '') : '';
      } else {
        const vEl = cellEl.getElementsByTagName('v')[0];
        const raw = vEl ? vEl.textContent : '';
        value = type === 's' ? (sharedStrings[Number(raw)] || '') : raw;
      }
      row[idx] = value;
    });
    return row;
  });
}

function normalizeClusterHeader(value) {
  return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}



const CLUSTER_IMPORT_HEADER_ALIASES = {
  CLUSTER: 'name',
  SPRMAXIMO: 'spr_max',
  SPRMAX: 'spr_max',
  MOTOS: 'receives_moto',
  QUANTIDADEDEMOTOS: 'moto_quantity',
  QUANTIDADEMOTOS: 'moto_quantity',
  ORDEMDECONFIRMACAO: 'order',
  ORDEM: 'order',
  OBSERVACAO: 'observation',
};

async function importClusterWorkbook(file) {
  const buffer = await file.arrayBuffer();
  const zip = readZipEntries(buffer);
  const sharedStrings = parseSharedStrings(await readZipEntryText(zip, 'xl/sharedStrings.xml'));
  const sheetXml = await readZipEntryText(zip, 'xl/worksheets/sheet1.xml');
  if (!sheetXml) throw new Error('Não encontrei nenhuma planilha dentro do arquivo.');
  const rows = parseSheetRows(sheetXml, sharedStrings).filter((row) => Array.isArray(row) && row.some((cell) => String(cell ?? '').trim()));
  if (!rows.length) throw new Error('Planilha vazia.');
  const [headerRow, ...dataRows] = rows;
  const headerMap = {};
  headerRow.forEach((raw, index) => {
    const alias = CLUSTER_IMPORT_HEADER_ALIASES[normalizeClusterHeader(raw)];
    if (alias) headerMap[index] = alias;
  });
  if (!Object.values(headerMap).includes('name')) {
    throw new Error('A planilha precisa ter, no mínimo, a coluna CLUSTER.');
  }
  const clusters = [];
  dataRows.forEach((row, rowIndex) => {
    const item = {};
    Object.entries(headerMap).forEach(([index, alias]) => { item[alias] = row[Number(index)]; });
    const name = String(item.name ?? '').trim();
    if (!name) return;
    const quantityText = String(item.moto_quantity ?? '').trim();
    const isAll = quantityText.toLowerCase() === 'tudo' || quantityText.toLowerCase() === 'todos';
    const motosText = String(item.receives_moto ?? '').trim().toLowerCase();
    const receivesMoto = motosText ? ['sim', 's', 'yes', 'true', '1'].includes(motosText) : Boolean(quantityText);
    clusters.push({
      id: '',
      order: Number(item.order) || (rowIndex + 1),
      name,
      spr_min: '',
      spr_max: String(item.spr_max ?? '').trim(),
      receives_moto: receivesMoto,
      moto_mode: isAll ? 'all' : 'quantity',
      moto_quantity: isAll ? '' : quantityText,
      spr_moto: 'Padrão',
      observation: String(item.observation ?? '').trim(),
    });
  });
  if (!clusters.length) throw new Error('Nenhuma linha com cluster válido foi encontrada na planilha.');
  return clusters;
}

function downloadHubData(kind) {
  const payload = readHubForm();
  const safeName = String(activeHubForm.station || 'hub').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
  if (kind === 'json') {
    const blob = new Blob([JSON.stringify(payload, null, 2)], {type:'application/json;charset=utf-8'});
    const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = `particularidades-${safeName}.json`; link.click(); URL.revokeObjectURL(url); return;
  }
  const headersList = ['Hub','Nome','Versão','Ciclo','Cluster do ciclo','Janela','Roteirização','Retirar offices','Success Label','RR','Regra RR','Detalhes RR','SPR Máx. RR','Passeio','Regra Passeio','Detalhes Passeio','SPR Máx. Passeio','Moto','Regra Moto','Detalhes Moto','SPR Máx. Moto','Volumoso','Regra Volumoso','Detalhes Volumoso','SPR Máx. Volumoso','CLUSTER','SPR MAXIMO','MOTOS','QUANTIDADE DE MOTOS','ORDEM DE CONFIRMAÇÃO','OBSERVAÇÃO','CEPs retirados','Particularidade','Ações sábado','Ações domingo','Observações semana','Observações fim de semana'];
  const rows = payload.cycles.flatMap((cycle) => {
    const clusters = cycle.clusters.length ? cycle.clusters : [{name:'Sem cluster detalhado',receives_moto:false,moto_mode:'quantity',moto_quantity:'',order:'',spr_min:'',spr_max:'',spr_moto:'',observation:''}];
    return clusters.map((cluster) => [payload.station_id,payload.hub_name,payload.version,cycle.cycle_code,cycle.cluster,cycle.window_info,cycle.can_route?'Pode roteirizar':'Não pode',cycle.remove_offices?'Sim':'Não',cycle.success_label?'Sim':'Não',cycle.rr,cycle.modal_rules.rr.scope,cycle.modal_rules.rr.details,cycle.modal_rules.rr.spr_max,cycle.passeio,cycle.modal_rules.passeio.scope,cycle.modal_rules.passeio.details,cycle.modal_rules.passeio.spr_max,cycle.moto,cycle.modal_rules.moto.scope,cycle.modal_rules.moto.details,cycle.modal_rules.moto.spr_max,cycle.volumoso,cycle.modal_rules.volumoso.scope,cycle.modal_rules.volumoso.details,cycle.modal_rules.volumoso.spr_max,cluster.name,cluster.spr_max,cluster.receives_moto===false?'Não':'Sim',cluster.moto_mode==='all'?'TUDO':cluster.moto_quantity,cluster.order,cluster.observation,cycle.removed_ceps,cycle.particularity,cycle.saturday_actions,cycle.sunday_actions,cycle.week_notes,cycle.weekend_notes]);
  });
  const blob = buildXlsxBlob('Particularidades', headersList, rows.map((row) => row.map((cell) => cell === undefined || cell === null ? '' : String(cell))));
  const url = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href = url; link.download = `particularidades-${safeName}.xlsx`; link.click(); URL.revokeObjectURL(url);
}

async function saveHubParticularities() {
  const button = qs('#hub-save-btn');
  const status = qs('#hub-form-status');
  const payload = readHubForm();
  button.disabled = true; button.textContent = 'Salvando…'; status.textContent = 'Salvando no Supabase…';
  try {
    const response = await fetch(api("rpc/rt_analyst_save_hub_particularity"), {
      method: "POST",
      headers,
      body: JSON.stringify({
        p_token: currentToken(), p_station_id: payload.station_id, p_notes: payload.hub_notes,
        p_daily_plan_url: payload.links.planning, p_motorcycle_availability_url: payload.links.motorcycles,
        p_files_url: payload.links.files, p_romaneio_folder_url: payload.links.romaneio_folder,






        p_cycles: payload.cycles,
      }),
    });
    if (!response.ok) {
      const problem = await response.json().catch(() => null);
      throw new Error(problem?.message || 'Não foi possível salvar a ficha deste Hub.');
    }
    const meta = await response.json();




    postEvent('hub_particularity', {
      station_id: payload.station_id, notes: payload.hub_notes,
      daily_plan_url: payload.links.planning, motorcycle_availability_url: payload.links.motorcycles,
      files_url: payload.links.files, romaneio_folder_url: payload.links.romaneio_folder,
      cycles: payload.cycles,
    }).catch(() => {});
    activeHubForm.cycles = payload.cycles;
    activeHubForm.hub.cycle_details = payload.cycles;
    activeHubForm.hub.hub_notes = payload.hub_notes;
    activeHubForm.hub.notes = payload.hub_notes;
    activeHubForm.hub.daily_plan_url = payload.links.planning;
    activeHubForm.hub.planning_url = payload.links.planning;
    activeHubForm.hub.motorcycle_availability_url = payload.links.motorcycles;
    activeHubForm.hub.motorcycle_url = payload.links.motorcycles;
    activeHubForm.hub.files_url = payload.links.files;
    activeHubForm.hub.romaneio_folder_url = payload.links.romaneio_folder;
    activeHubForm.hub.particularity_version = meta.particularity_version;
    activeHubForm.hub.particularity_updated_at = meta.particularity_updated_at;
    activeHubForm.hub.particularity_updated_by = meta.particularity_updated_by;


    [...state.assignments, ...(state.all_hubs || [])].forEach((item) => {
      if (item.station_id !== payload.station_id) return;
      item.hub_notes = payload.hub_notes; item.notes = payload.hub_notes;
      item.daily_plan_url = payload.links.planning; item.planning_url = payload.links.planning;
      item.motorcycle_availability_url = payload.links.motorcycles; item.motorcycle_url = payload.links.motorcycles;
      item.files_url = payload.links.files;
      item.romaneio_folder_url = payload.links.romaneio_folder;
      item.particularity_version = meta.particularity_version;
      item.particularity_updated_at = meta.particularity_updated_at;
      item.particularity_updated_by = meta.particularity_updated_by;
    });
    status.textContent = 'Ficha salva no Supabase.';
    status.className = 'hub-form-status success';
    toast('Particularidades do Hub atualizadas');
    setHubFormEditing(false);
    renderHubs();
  } catch (error) {
    status.textContent = error.message || 'Não foi possível salvar agora.';
    status.className = 'hub-form-status error';
    button.disabled = false;
  } finally { button.textContent = 'Salvar alterações'; }
}

async function openHub(id, assignmentId=null) {



  const x = assignmentId
    ? findAssignment(assignmentId)
    : (state.assignments.find((a) => String(a.hub_id) === String(id))
      || (state.all_hubs || []).find((a) => String(a.id) === String(id)));
  if (!x) {
    if (assignmentId) toast('Não encontrei esta operação. Atualize a tela e tente de novo.');
    return;
  }
  const hubId = x.hub_id || x.id;
  const hasSchedule = Boolean(x.start_datetime && x.end_datetime);
  const station = x.station_id || x.title || 'Hub';
  const name = x.hub_name || x.name || '';
  const cycles = hubCycleRows(x, hubId);
  const version = x.particularity_version || x.version || state.latest_publication?.version || 'Sem versão';
  const updatedAt = x.particularity_updated_at || x.updated_at || state.generated_at;
  const updatedBy = x.particularity_updated_by || x.updated_by_name || x.analyst_name || 'Routing Tower';
  activeHubForm = { hub:x, hubId, station, name, cycles, version };
  qs('#hub-dialog-title').textContent = `${station} · ${name}`;
  const links = {
    planning: x.planning_url || x.daily_plan_url || x.sop_url || '',
    motorcycles: x.motorcycle_url || x.motorcycle_availability_url || '',
    files: x.files_url || x.template_url || '',
    romaneio_folder: x.romaneio_folder_url || '',
  };










  const showOperationTools = Boolean(assignmentId) && hasSchedule;
  const operationTools = showOperationTools ? `<section class="operation-form"><div class="operation-form-head"><h3>Romaneio da operação</h3><span class="type-pill">Finalização automática</span></div><label>Link do Romaneio<input id="romaneio-url-${x.id}" type="url" value="${escapeHtml(x.romaneio_url || '')}" placeholder="Cole aqui o link da planilha ou do Romaneio"></label><button type="button" class="romaneio-send" data-action="submit-romaneio" data-assignment-id="${x.id}">Salvar Romaneio e finalizar operação</button><div class="form-status" id="romaneio-form-status-${x.id}" aria-live="polite"></div></section><section class="operation-form"><div class="operation-form-head"><h3>Cancelamento da operação</h3><span class="type-pill">Roteirização cancelada</span></div><label>Motivo do cancelamento<textarea id="cancel-reason-${x.id}" rows="3" placeholder="Explique objetivamente por que esta operação está sendo cancelada.">${escapeHtml(x.cancellation_reason || '')}</textarea></label><button type="button" class="romaneio-send" data-action="submit-cancel-reason" data-assignment-id="${x.id}">Salvar motivo e cancelar operação</button><div class="form-status" id="cancel-reason-form-status-${x.id}" aria-live="polite"></div></section><section class="operation-form"><div class="operation-form-head"><h3>Registrar ocorrência</h3><span class="type-pill">Supervisor</span></div><label>Tipo<select id="occurrence-type-${x.id}">${(occurrenceTypes || []).map((type) => `<option value="${escapeHtml(type.code)}">${shortText(type.label)}</option>`).join('') || '<option value="outro">Outro tipo de ocorrência</option>'}</select></label><label>Descrição<textarea id="occurrence-message-${x.id}" rows="4" placeholder="Conte objetivamente o que aconteceu nesta operação."></textarea></label><button type="button" class="occurrence-send" id="occurrence-send-${x.id}" data-action="send-occurrence" data-assignment-id="${x.id}">Enviar ocorrência ao supervisor</button><div class="form-status" id="occurrence-form-status-${x.id}" aria-live="polite"></div><h3>Histórico e retorno do supervisor</h3><div class="occurrence-history" id="operation-occurrence-history">${empty('Carregando histórico…')}</div></section>` : '';






  const showFicha = !assignmentId;
  const fichaContent = showFicha ? `<div class="hub-particularity-content">
    <header class="hub-form-header"><div><p class="eyebrow">FICHA DE PARTICULARIDADES</p><h2>${shortText(station)} · ${shortText(name, '')}</h2><p>Informações para apoiar a roteirização deste Hub.</p></div><div class="hub-version-meta"><span>Versão <strong>${shortText(version)}</strong></span><span>Atualizado em <strong>${fmtDateTime(updatedAt)}</strong></span><span>Por <strong>${shortText(updatedBy)}</strong></span></div></header>
    <div class="hub-resource-links">${hubResourceLink('Planejamento', links.planning)}${hubResourceLink('Disponibilidade de motos', links.motorcycles)}${hubResourceLink('Arquivos diversos', links.files)}${hubResourceLink('Pasta dos romaneios', links.romaneio_folder)}</div>
    <div id="hub-particularity-form"><section class="hub-general-card"><h3>Particularidade geral do Hub</h3>${hubField('Observações gerais', 'hub_notes', x.hub_notes || x.notes || '', {type:'textarea',rows:4,span:'span-all'})}<div class="hub-link-fields">${hubField('Link de planejamento', 'planning_url', links.planning, {type:'url'})}${hubField('Link de disponibilidade de motos', 'motorcycle_url', links.motorcycles, {type:'url'})}${hubField('Link de arquivos diversos', 'files_url', links.files, {type:'url'})}${hubField('Link da pasta de romaneios', 'romaneio_folder_url', links.romaneio_folder, {type:'url'})}</div></section><section class="cycle-selector-wrap"><div><p class="eyebrow">SELECIONE O CICLO</p><h3>Dados por ciclo</h3></div><div class="cycle-selector" role="tablist" aria-label="Ciclos do Hub">${cycles.map((cycle,index)=>`<button type="button" role="tab" class="cycle-select-btn ${index===0?'active':''}" aria-selected="${index===0?'true':'false'}" data-cycle-select="${index}"><span>${shortText(cycle.cycle_code)}</span><small>${shortText(cycle.window_info,'Sem janela')}</small></button>`).join('')}</div></section><div class="hub-cycle-stage">${cycles.map(cycleFormCard).join('')}</div></div>
    <footer class="hub-form-actions"><span id="hub-form-status" class="hub-form-status">Informações sincronizadas</span><button type="button" class="hub-export-btn" data-hub-export="json">Exportar JSON</button><button type="button" class="hub-export-btn" data-hub-export="excel">Exportar Excel</button><button type="button" class="hub-edit-btn" id="hub-edit-btn">Ajustar</button><button type="button" class="hub-save-btn" id="hub-save-btn" disabled>Salvar alterações</button></footer>
    </div>` : '';
  qs('#hub-dialog-content').innerHTML = `${fichaContent}${operationTools}`;
  qsa('[data-cycle-select]').forEach((button) => {
    button.onclick = () => {
      const index = button.dataset.cycleSelect;
      qsa('[data-cycle-select]').forEach((item) => { const active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-selected', String(active)); });
      qsa('.hub-cycle-page').forEach((page) => {
        const active = page.dataset.cycleIndex === index;
        page.classList.toggle('active', active);
        page.setAttribute('aria-hidden', String(!active));
      });
    };
    button.onkeydown = (event) => {
      if (!['ArrowLeft','ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const tabs = qsa('[data-cycle-select]');
      const next = (tabs.indexOf(button) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].focus(); tabs[next].click();
    };
  });
  const bindEverythingButton = (button) => button.onclick = () => {
    const row = button.closest('tr');
    const input = row.querySelector('[name="cluster_moto_quantity"]');
    const active = button.classList.toggle('active');
    button.textContent = active ? 'Tudo' : 'Usar tudo';
    input.hidden = active;
    if (active) input.value = '';
  };
  qsa('[data-cluster-everything]').forEach(bindEverythingButton);
  qsa('[data-add-cluster]').forEach((button) => button.onclick = () => {
    const body = button.closest('.hub-cycle-page').querySelector('.cluster-moto-table tbody');
    const index = body.querySelectorAll('tr').length;
    const wrapper = document.createElement('tbody');
    wrapper.innerHTML = clusterRowMarkup(
      {name:'',spr_max:'',receives_moto:true,moto_quantity:'',moto_mode:'quantity',order:index+1,observation:''},
      index, {disabled:false},
    );
    const row = wrapper.firstElementChild;
    body.appendChild(row);
    bindEverythingButton(row.querySelector('[data-cluster-everything]'));
    row.querySelector('[name="cluster_name"]').focus();
  });







  qsa('[data-export-cluster-model]').forEach((button) => button.onclick = () => {
    const headers = ['CLUSTER', 'SPR MAXIMO', 'MOTOS', 'QUANTIDADE DE MOTOS', 'ORDEM DE CONFIRMAÇÃO', 'OBSERVAÇÃO'];
    const exampleRows = [
      ['Centro', '120', 'Sim', '4', '1', 'Prioridade nas primeiras rotas do ciclo'],
      ['Zona Norte', '90', 'Não', '', '2', ''],
      ['Zona Sul', '150', 'Sim', 'Tudo', '3', 'Recebe todas as motos disponíveis'],
    ];
    const blob = buildXlsxBlob('Clusters', headers, exampleRows);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = 'modelo-clusters.xlsx'; link.click();
    URL.revokeObjectURL(url);
  });
  qsa('[data-import-cluster-excel]').forEach((button) => button.onclick = () => {
    const page = button.closest('.hub-cycle-page');
    const cycleIndex = Number(page.dataset.cycleIndex);
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const status = qs('#hub-form-status');
      try {
        const clusters = await importClusterWorkbook(file);
        if (activeHubForm.cycles[cycleIndex]) activeHubForm.cycles[cycleIndex].clusters = clusters;
        const body = page.querySelector('.cluster-moto-table tbody');
        body.innerHTML = clusters.map((cluster, index) => clusterRowMarkup(cluster, index, {disabled:false})).join('');
        [...body.querySelectorAll('[data-cluster-everything]')].forEach(bindEverythingButton);
        if (status) { status.textContent = `${clusters.length} cluster(s) importado(s) da planilha. Revise e salve.`; status.className = 'hub-form-status success'; }
        toast(`${clusters.length} cluster(s) importado(s) da planilha`);
      } catch (error) {
        if (status) { status.textContent = error.message || 'Não foi possível importar a planilha de clusters.'; status.className = 'hub-form-status error'; }
        toast(error.message || 'Não foi possível importar a planilha de clusters.');
      }
    };
    input.click();
  });
  qsa('[data-hub-export]').forEach((button) => button.onclick = () => downloadHubData(button.dataset.hubExport));


  const hubEditBtn = qs('#hub-edit-btn');
  if (hubEditBtn) hubEditBtn.onclick = () => {
    if (hubFormEditing) { openHub(id, assignmentId); return; }
    setHubFormEditing(true);
  };
  const hubSaveBtn = qs('#hub-save-btn');
  if (hubSaveBtn) hubSaveBtn.onclick = saveHubParticularities;
  if (showOperationTools) {
    const romaneioButton = qs(`[data-action="submit-romaneio"][data-assignment-id="${x.id}"]`);
    if (romaneioButton) romaneioButton.onclick = () => submitRomaneio(x.id);
    const cancelReasonButton = qs(`[data-action="submit-cancel-reason"][data-assignment-id="${x.id}"]`);
    if (cancelReasonButton) cancelReasonButton.onclick = () => submitCancellationReason(x.id);
    const occurrenceButton = qs(`[data-action="send-occurrence"][data-assignment-id="${x.id}"]`);
    if (occurrenceButton) occurrenceButton.onclick = () => sendLocalOccurrence(x.id);
  }
  setHubFormEditing(false);
  qs('#hub-dialog').showModal();
  if (showOperationTools) loadOccurrenceHistory(x.id);
}

function timeoffDecisionLabel(decision) {
  if (decision === 'timeoff') return 'Hora extra recusada';
  if (decision === 'overtime') return 'Hora extra aceita';
  return 'Aguardando minha decisão';
}

function sundayOfWeek(isoDateTime) {













  const date = new Date(isoDateTime);
  const day = date.getDay(); // 0=domingo
  date.setDate(date.getDate() + ((7 - day) % 7));
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const dayOfMonth = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${dayOfMonth}`;
}

function hasMandatoryFolgaDmThisWeek(absence) {








  const sunday = sundayOfWeek(absence.start_datetime);
  return (state.absences || []).some((x) =>
    String(x.absence_type || '').toLowerCase() === 'folga dm'
    && String(x.start_datetime || '').slice(0, 10) === sunday
  );
}

function canDecideTimeoff(absence) {
  const type = String(absence.absence_type || '').toLowerCase();
  if (type.includes('compens')) return false;
  if (!type.includes('dsr')) return false;
  if (hasMandatoryFolgaDmThisWeek(absence)) return false;
  return true;
}

function timeoffDecisionControl(absence) {
  const decision = absence.analyst_decision || '';
  if (!canDecideTimeoff(absence)) {
    const type = String(absence.absence_type || '').toLowerCase();
    const label = type.includes('folga dm')
      ? 'Domingo mensal bloqueado'
      : type.includes('compens')
        ? 'Compensatória definida'
        : type.includes('dsr') && hasMandatoryFolgaDmThisWeek(absence)
          ? 'Folga obrigatória (semana com Folga DM)'
          : 'Definido pelo supervisor';
    return `<div class="decision-box locked"><small>Status</small><strong>${shortText(label)}</strong></div>`;
  }






  if (decision) {
    const tone = decision === 'overtime' ? 'overtime' : 'timeoff';
    const covered = String(absence.status || '') === 'covered';
    let footer = '';
    if (absence.schedule_published === false && !covered) {
      const other = decision === 'overtime' ? 'timeoff' : 'overtime';
      footer = `
        <button class="decision-change" data-timeoff-decision="${other}" data-absence-id="${absence.id}">${other === 'overtime' ? 'Mudar para: aceito hora extra' : 'Mudar para: não aceito hora extra'}</button>
        <em>Dá para mudar até o supervisor publicar a escala dessa semana.</em>`;
    } else if (covered) {
      footer = '<em>Cobertura confirmada: para mudar, fale com o supervisor.</em>';
    } else if (absence.schedule_published === true) {
      footer = '<em>Escala da semana publicada: para mudar, fale com o supervisor.</em>';
    }
    return `<div class="decision-box decided-${tone}"><small>Decisão</small><strong>${timeoffDecisionLabel(decision)}</strong>${footer}</div>`;
  }
  return `
    <div class="decision-box">
      <small>Decisão</small>
      <strong>${timeoffDecisionLabel(decision)}</strong>
      <div class="action-group decision-actions">
        <button class="decline" data-timeoff-decision="timeoff" data-absence-id="${absence.id}">Não aceito hora extra</button>
        <button class="accept" data-timeoff-decision="overtime" data-absence-id="${absence.id}">Aceito fazer hora extra</button>
      </div>
    </div>`;
}

function bindTimeoffDecisionButtons() {
  qsa('[data-timeoff-decision]').forEach((btn) => {
    btn.onclick = () => setTimeoffDecision(btn.dataset.absenceId, btn.dataset.timeoffDecision);
  });
}

async function setTimeoffDecision(absenceId, decision) {
  const absence = state.absences.find((item) => String(item.id) === String(absenceId));
  if (!absence) return;
  const previous = { analyst_decision: absence.analyst_decision, status: absence.status, requires_coverage: absence.requires_coverage };
  absence.analyst_decision = decision;
  absence.status = decision === 'overtime' ? 'working_overtime' : 'pending';
  absence.requires_coverage = decision === 'overtime' ? 0 : 1;





  renderTimeoff();
  try {
    await postEvent("absence_decision", { absence_id: Number(absenceId), decision });
    toast(`${timeoffDecisionLabel(decision)} registrado`);








    await loadData(true);
  } catch (err) {
    Object.assign(absence, previous);
    renderTimeoff();
    await loadData(true);
    toast(err.message);
  }
}



function isUpcomingAbsence(x) {
  const end = new Date(x?.end_datetime || x?.start_datetime || '');
  return !Number.isNaN(end.getTime()) && end >= new Date();
}

function timeoffWindowEnd() {
  const now = new Date();
  const last = new Date(now.getFullYear(), now.getMonth() + 2, 0);
  return `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;
}

function timeoffMonthLabel(isoMonth) {
  const [year, month] = String(isoMonth || '').split('-').map(Number);
  if (!year || !month) return '';
  const text = new Date(year, month - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function renderTimeoff() {
  const upcoming = (state.absences || [])
    .filter(isUpcomingAbsence)
    .sort((a, b) => String(a.start_datetime || '').localeCompare(String(b.start_datetime || '')));
  let lastMonth = '';
  qs('#timeoff-list').innerHTML = upcoming.length ? upcoming.map((x) => {

    const month = String(x.start_datetime || '').slice(0, 7);
    const header = month && month !== lastMonth ? `<h3 class="timeoff-month">${escapeHtml(timeoffMonthLabel(month))}</h3>` : '';
    lastMonth = month || lastMonth;
    return `${header}
    <div class="row-card timeoff-card">
      <div><strong>${shortText(x.absence_type)}</strong><small>${multilineText(x.reason, 'Sem observação')}</small></div>
      <div><small>Início</small><strong>${fmtDateTime(x.start_datetime)}</strong></div>
      <div><small>Término</small><strong>${fmtDateTime(x.end_datetime)}</strong></div>
      ${timeoffDecisionControl(x)}
    </div>`;
  }).join('') : empty('Nenhuma folga ou ausência programada.');
  bindTimeoffDecisionButtons();
}

function overtimeStatusLabel(x) {
  if (x.status === 'declined' && x.analyst_response === 'supervisor_rejected') return 'Recusado pelo supervisor';
  const labels = {awaiting_analyst: 'Aguardando resposta', accepted: 'Aceita', approved: 'Aprovada', declined: 'Recusada', identified: 'Identificada'};
  return labels[x.status] || x.status;
}
function overtimeResponseLabel(x) {
  if (x.status === 'declined' && x.analyst_response === 'supervisor_rejected') return 'A disponibilidade foi cancelada pelo supervisor';
  return x.analyst_response || 'Pendente';
}





function renderUsefulLinks() {
  const holder = qs('#useful-links-list');
  if (!holder) return;
  const links = state.useful_links || [];
  if (!links.length) { holder.innerHTML = empty('Seu supervisor ainda não cadastrou links úteis.'); return; }
  const groups = [];
  links.forEach((link) => {
    const category = String(link.category || 'Geral').trim() || 'Geral';
    let group = groups.find((g) => g.category === category);
    if (!group) { group = { category, items: [] }; groups.push(group); }
    group.items.push(link);
  });
  holder.innerHTML = groups.map((group) => `
    <div class="links-category">
      <h3>${shortText(group.category)}</h3>
      <div class="links-grid">
        ${group.items.map((link) => `<a class="row-card link-card" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer"><strong>${shortText(link.title)}</strong><small>${escapeHtml(link.url)}</small></a>`).join('')}
      </div>
    </div>`).join('');
}









function isOvertimeActionable(x) {
  const end = new Date(x?.end_datetime || x?.start_datetime || '');
  return !Number.isNaN(end.getTime()) && end >= new Date();
}

let overtimeHistoryOpen = false;


let overtimeScrollToHistory = false;



let overtimePendingId = null;
let overtimePendingAction = null;

function overtimeRowActions(x) {
  if (x.status !== 'awaiting_analyst') return '<span></span>';
  if (String(overtimePendingId) === String(x.id)) {
    const confirmLabel = overtimePendingAction === 'accept' ? 'Confirmar aceite' : 'Confirmar recusa';
    const placeholder = overtimePendingAction === 'accept' ? 'Observação (opcional)' : 'Motivo da recusa (opcional)';
    return `
      <div class="operation-form overtime-response-form" id="overtime-form-${x.id}" style="grid-column:1/-1;margin-top:0">
        <label>Observação<textarea id="overtime-notes-${x.id}" rows="2" placeholder="${placeholder}"></textarea></label>
        <div class="action-group">
          <button type="button" class="decline" data-overtime-cancel="${x.id}">Cancelar</button>
          <button type="button" class="accept" data-overtime-confirm="${x.id}">${confirmLabel}</button>
        </div>
        <div class="form-status" id="overtime-form-status-${x.id}"></div>
      </div>`;
  }
  return `<div class="action-group"><button class="accept" data-id="${x.id}" data-action="accept">Aceitar</button><button class="decline" data-id="${x.id}" data-action="decline">Recusar</button></div>`;
}

function renderOvertime() {
  const actionable = [];
  const history = [];
  (state.overtime || []).forEach((x) => (isOvertimeActionable(x) ? actionable : history).push(x));
  actionable.sort((a, b) => String(a.start_datetime || '').localeCompare(String(b.start_datetime || '')));
  history.sort((a, b) => String(b.start_datetime || '').localeCompare(String(a.start_datetime || '')));

  const rowHtml = (x) => `<div class="row-card"><div><strong>${Math.round(x.minutes / 60 * 10) / 10} h · ${shortText(x.reason)}</strong><small>${fmtDateTime(x.start_datetime)} a ${fmtDateTime(x.end_datetime)}</small></div><div><small>Status</small><strong>${shortText(overtimeStatusLabel(x))}</strong></div><div><small>Resposta</small><strong>${shortText(overtimeResponseLabel(x))}</strong></div>${overtimeRowActions(x)}</div>`;

  let html = actionable.length ? actionable.map(rowHtml).join('') : empty('Nenhuma solicitação de hora extra.');
  if (overtimeHistoryOpen && history.length) {
    html += `<div class="occurrence-history-head" id="overtime-history-head" style="margin-top:14px"><small>Histórico (${history.length})</small></div>` + history.map(rowHtml).join('');
  }
  qs('#overtime-list').innerHTML = html;

  const toggle = qs('#overtime-history-toggle');
  if (toggle) {
    toggle.innerHTML = history.length
      ? `<button type="button" class="history-toggle-btn" id="overtime-history-btn">${overtimeHistoryOpen ? 'Ocultar histórico' : `Ver histórico (${history.length})`}</button>`
      : '';
    const btn = qs('#overtime-history-btn');
    if (btn) btn.onclick = () => {
      overtimeHistoryOpen = !overtimeHistoryOpen;
      overtimeScrollToHistory = overtimeHistoryOpen;
      renderOvertime();
    };
  }



  if (overtimeScrollToHistory) {
    overtimeScrollToHistory = false;
    qs('#overtime-history-head')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }




  qsa('#overtime-list [data-action]').forEach((btn) => btn.onclick = () => {
    overtimePendingId = btn.dataset.id;
    overtimePendingAction = btn.dataset.action;
    renderOvertime();
    qs(`#overtime-notes-${overtimePendingId}`)?.focus();
  });
  qsa('#overtime-list [data-overtime-cancel]').forEach((btn) => btn.onclick = () => {
    overtimePendingId = null;
    overtimePendingAction = null;
    renderOvertime();
  });
  qsa('#overtime-list [data-overtime-confirm]').forEach((btn) => btn.onclick = () => confirmOvertimeResponse(btn.dataset.overtimeConfirm));
}

async function confirmOvertimeResponse(id) {
  const action = overtimePendingAction;
  const notes = qs(`#overtime-notes-${id}`)?.value || '';
  const status = qs(`#overtime-form-status-${id}`);
  const confirmBtn = qs(`#overtime-form-${id} [data-overtime-confirm]`);
  const cancelBtn = qs(`#overtime-form-${id} [data-overtime-cancel]`);
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Enviando…'; }
  if (cancelBtn) cancelBtn.disabled = true;
  if (status) { status.className = 'form-status'; status.textContent = 'Enviando resposta…'; }

  const item = state.overtime.find((entry) => String(entry.id) === String(id));
  const previous = item ? { status: item.status, analyst_response: item.analyst_response } : null;
  if (item) { item.status = action === 'decline' ? 'declined' : 'accepted'; item.analyst_response = notes || action; }
  try {
    await postEvent("overtime_response", { request_id: Number(id), response: action, notes });
    overtimePendingId = null;
    overtimePendingAction = null;
    toast('Resposta registrada');
    await loadData(true);
  } catch (err) {
    if (item && previous) Object.assign(item, previous);
    toast(err.message);
    await loadData(true);




    if (String(overtimePendingId) === String(id)) {
      renderOvertime();
      const notesField = qs(`#overtime-notes-${id}`);
      if (notesField) notesField.value = notes;
      const retryStatus = qs(`#overtime-form-status-${id}`);
      if (retryStatus) { retryStatus.className = 'form-status error'; retryStatus.textContent = err.message; }
    }
  }
}

function switchPortalView(btn) {
  const update = () => {
    qsa('.nav-item').forEach((x) => x.classList.remove('active'));
    btn.classList.add('active');
    qsa('.view').forEach((x) => x.classList.remove('active'));
    qs(`#view-${btn.dataset.view}`).classList.add('active');
    updateScheduleTypeTabs();


  };

  if (document.startViewTransition) document.startViewTransition(update);
  else update();
}
qsa('.nav-item').forEach((btn) => btn.onclick = () => switchPortalView(btn));

function applyTheme(theme) {
  const selected = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = selected;
  try { localStorage.setItem('routingTowerAnalystTheme', selected); } catch (_) { /* sem armazenamento: só nesta tela */ }
  const button = qs('#theme-btn');
  if (button) {
    button.setAttribute('aria-label', selected === 'dark' ? 'Ativar tema claro' : 'Ativar tema escuro');
    button.title = selected === 'dark' ? 'Mudar para o dia' : 'Mudar para a noite';
  }
}
let savedTheme = null;
try { savedTheme = localStorage.getItem('routingTowerAnalystTheme'); } catch (_) { savedTheme = null; }
applyTheme(savedTheme || (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
qs('#theme-btn').onclick = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');

qs('#refresh-btn').onclick = () => loadData();







async function portalUpdateStatus() {
  try {
    const response = await fetch(chrome.runtime.getURL(`portal-update-status.json?v=${Date.now()}`), {cache: 'no-store'});
    return response.ok ? response.json() : null;
  } catch (_) {
    return null;
  }
}

async function requestPortalFilesUpdate() {
  const button = qs('#update-portal-btn');
  if (button.disabled) return;
  button.disabled = true;
  try {
    const response = await fetch(EXTENSION_LATEST_URL);
    if (!response.ok) throw new Error('release');
    const release = await response.json();
    const installed = await installedFilesVersion();
    const available = versionIsNewer(release.version, installed) ||
      (release.version === installed && release.build_id && release.build_id !== RT_PANEL_BUILD_ID);
    if (!available) {
      toast('As telas já estão atualizadas.');
      button.disabled = false;
      return;
    }
  } catch (_) {
    toast('Não foi possível verificar a atualização. Tente novamente mais tarde.');
    button.disabled = false;
    return;
  }
  const requestedAt = Date.now();
  let settled = false;
  button.disabled = true;
  toast('Autorize o atualizador do Routing Tower para verificar as novas telas.');
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.src = `routingtower-update://portal/check?v=${requestedAt}`;
  document.body.appendChild(frame);
  const timer = setInterval(async () => {
    try {
      const result = await portalUpdateStatus();
      if (!result?.updated_at || Date.parse(result.updated_at) < requestedAt - 2000) return;
      settled = true;
      clearInterval(timer);
      button.disabled = false;
      toast(result.message || 'Verificação concluída.');
      if (result.status === 'updated') setTimeout(() => location.reload(), 1200);
    } catch (_) {}
  }, 1000);




  setTimeout(() => {
    clearInterval(timer);
    button.disabled = false;
    if (!settled) toast('Não consegui falar com o Routing Tower no seu computador. Confirme se o app está aberto e tente de novo.');
  }, 90000);
}

qs('#update-portal-btn').onclick = requestPortalFilesUpdate;




const EXTENSION_LATEST_URL = `${SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/public/routing-tower-portals/extension-updates/latest.json`;
let loadedFilesVersion = RT_PANEL_BUILD_VERSION;

function versionIsNewer(candidate, current) {
  const a = String(candidate || "").split(".").map((part) => Number(part) || 0);
  const b = String(current || "").split(".").map((part) => Number(part) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

async function installedFilesVersion() {
  try {
    const response = await fetch(chrome.runtime.getURL(`manifest.json?v=${Date.now()}`), { cache: "no-store" });
    return response.ok ? String((await response.json()).version || "") : "";
  } catch (_) {
    return "";
  }
}

function showUpdateBanner(text, label, action) {
  let bar = document.getElementById("rt-update-banner");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "rt-update-banner";
    bar.className = "rt-update-banner";
    document.body.appendChild(bar);
  }
  bar.innerHTML = `<span>${escapeHtml(text)}</span><button type="button" class="rt-update-go">${escapeHtml(label)}</button><button type="button" class="rt-update-close" aria-label="Fechar aviso">×</button>`;
  bar.querySelector(".rt-update-go").onclick = () => { bar.remove(); action(); };
  bar.querySelector(".rt-update-close").onclick = () => bar.remove();
}

async function checkExtensionUpdate() {
  if (typeof chrome === "undefined" || !chrome.runtime?.getURL) return; // aberto pelo app: sem extensão
  const installed = await installedFilesVersion();
  if (!installed) return;
  if (loadedFilesVersion === null) loadedFilesVersion = installed;
  if (installed !== loadedFilesVersion) {
    const busy = document.querySelector("dialog[open]") || document.activeElement?.matches?.("input, textarea, select");
    if (!busy) {
      location.reload();
      return;
    }
    showUpdateBanner("Telas novas instaladas. Recarregue quando terminar o que está fazendo.", "Recarregar", () => location.reload());
    return;
  }
  try {
    const response = await fetch(`${EXTENSION_LATEST_URL}?v=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) return;
    const release = await response.json();
    const latest = String(release.version || "");
    const repairAvailable = latest === installed && release.build_id && release.build_id !== RT_PANEL_BUILD_ID;
    if (latest && (versionIsNewer(latest, installed) || repairAvailable)) {
      showUpdateBanner(`Nova versão das telas disponível (${latest}).`, "Atualizar agora", requestPortalFilesUpdate);
    }
  } catch (_) { /* sem internet: tenta de novo no próximo ciclo */ }
}
if (!window.RT_WEB_CONTEXT) setTimeout(checkExtensionUpdate, 4000);


qs('#export-update-btn').onclick = () => {
  const payload = {
    format: 'routing-tower-offline-update-v1',
    generated_at: new Date().toISOString(),
    analyst: {id: state.analyst.id, name: state.analyst.name, token: currentToken()},
    assignments: state.assignments,
    absences: state.absences,
    overtime: state.overtime,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type: 'application/json'});
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `atualizacao-${String(state.analyst.name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  toast('Arquivo de atualização gerado para enviar ao supervisor.');
};







async function checkRevision(force = false) {
  if (!force && readRecovery.waiting()) return;
  if (revisionCheckRunning || document.hidden || !currentToken()) return;

  const revisionToken = currentToken();
  if (revisionToken !== automaticRevisionToken) {
    automaticRevisionToken = revisionToken;
    lastAutomaticRevisionAt = 0;
    clearTimeout(automaticRevisionTimer);
    automaticRevisionTimer = null;
  }
  const remaining = AUTO_REVISION_MIN_INTERVAL_MS - (Date.now() - lastAutomaticRevisionAt);
  if (!force && lastAutomaticRevisionAt && remaining > 0) {
    if (automaticRevisionTimer === null) {
      automaticRevisionTimer = setTimeout(() => {
        automaticRevisionTimer = null;
        checkRevision();
      }, remaining);
    }
    return;
  }
  clearTimeout(automaticRevisionTimer);
  automaticRevisionTimer = null;
  lastAutomaticRevisionAt = Date.now();
  revisionCheckRunning = true;
  try {
    const response = await fetchWithTimeout(api("rpc/rt_get_analyst_revision"), {
      method: "POST", headers, body: JSON.stringify({ p_token: currentToken() }),
    });
    if (!response.ok) throw httpError(response, "revision");
    const info = await response.json();
    const revision = Number(info?.revision || 0);
    if (force || snapshotRevision === null || revision !== snapshotRevision) {
      await loadData(true);
      if (!readRecovery.waiting() && state) snapshotRevision = revision;
    }
  } catch (error) {
    setConnection(false);
  } finally {
    revisionCheckRunning = false;
  }
}

document.addEventListener("visibilitychange", () => { if (!document.hidden) checkRevision(); });
window.addEventListener("focus", () => checkRevision());



setInterval(() => { if (!document.hidden) checkRevision(); }, 10 * 60000);

if (window.RT_WEB_CONTEXT) {
  extensionToken = window.RT_WEB_CONTEXT.cache_key;
  loadData(true, false);
} else if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync) {
  chrome.storage.sync.get({ analystToken: "" }, (cfg) => {
    extensionToken = (cfg.analystToken || "").trim();
    setupRealtime(extensionToken);
    loadData(true, true);
  });
} else {
  qs('#alert-area').innerHTML = `<div class="alert"><span>Abra esta tela pela extensão Routing Tower para usar sua chave individual com segurança.</span></div>`;
}

if (!window.RT_WEB_CONTEXT) checkMaintenance();

const PANEL_VERSION = RT_PANEL_BUILD_VERSION;
if (PANEL_VERSION && qs('#panel-version')) qs('#panel-version').textContent = `v${PANEL_VERSION}`;

if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && (changes.analystToken || changes.supervisorToken || changes.profile)) {
      document.body.replaceChildren(Object.assign(document.createElement('p'), {textContent:'Atualizando acesso…'}));
      rtReadCache.clear().finally(() => location.reload());
    }
  });
}
