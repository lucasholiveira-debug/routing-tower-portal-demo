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




const PANEL_CONFIG = window.RT_PANEL_CONFIG || null;
const SUPABASE_URL = PANEL_CONFIG?.supabaseUrl || "https://demo.invalid";
const SUPABASE_ANON_KEY = PANEL_CONFIG?.anonKey || "demo-no-api-key";

const headers = {
  apikey: SUPABASE_ANON_KEY,
  "Content-Type": "application/json",
};
if (SUPABASE_ANON_KEY.startsWith("eyJ")) {
  headers.Authorization = `Bearer ${SUPABASE_ANON_KEY}`;
}

let extensionToken = "";




let localPortalBaseUrl = "https://demo.invalid";
let payload = null;
let operations = [];
let occurrences = [];




let overtimeRequests = [];
let selectedSupervisor = "todos";
let snapshotRevision = null;
let revisionCheckRunning = false;
const AUTO_REVISION_MIN_INTERVAL_MS = 5 * 60000;
let lastAutomaticRevisionAt = 0;
let automaticRevisionTimer = null;
let automaticRevisionToken = "";




let filterRegion = new Set();
let filterShift = new Set();
let filterSearch = "";
let filterDate = "";            // dia de referência (ISO); o recorte vem de periodMode


let periodMode = "day";
let filterDateEnd = "";
let filterSignal = "";
let occurrencesResolved = [];
let ganttDay = "";
let filterStatus = new Set();
let filterAnalyst = new Set();
let filterHub = new Set();
let dateFilterInitialized = false;


const PANEL_PREFS_KEY = "routingTowerSupervisorPrefs";
function savePanelPrefs() {
  try {
    localStorage.setItem(PANEL_PREFS_KEY, JSON.stringify({
      periodMode: periodMode === "range" ? "day" : periodMode,
      region: [...filterRegion], shift: [...filterShift], status: [...filterStatus], signal: filterSignal,
    }));
  } catch (_) { /* navegador sem armazenamento: só não lembra */ }
}
function restorePanelPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PANEL_PREFS_KEY) || "null");
    if (!saved) return;
    if (["day", "week", "month"].includes(saved.periodMode)) periodMode = saved.periodMode;
    filterRegion = new Set(saved.region || []);
    filterShift = new Set(saved.shift || []);
    filterStatus = new Set(saved.status || []);
    filterSignal = String(saved.signal || "");
  } catch (_) { /* preferência corrompida: começa do padrão */ }
}
restorePanelPrefs();





let activeSubstitutions = [];

const STATUS_CHART_DEFS = [
  { key: "finished", label: "Finalizado", color: "var(--ok)" },
  { key: "execution", label: "Em execução", color: "var(--run)" },


  { key: "early", label: "Adiantado", color: "var(--early)" },
  { key: "pending", label: "Pendente", color: "#94a3b8" },
  { key: "not_started", label: "Sem início", color: "var(--warn)" },
  { key: "late", label: "Atrasado", color: "var(--bad)" },





  { key: "cancelled_route", label: "Roteirização cancelada", color: "var(--cancelled)" },
  { key: "no_operation", label: "Sem operação", color: "var(--no-op)" },
];




const TERMINAL_OPERATION_STATUSES = new Set(["finished", "cancelled_route", "no_operation"]);
function isTerminalOperationStatus(status) {
  return TERMINAL_OPERATION_STATUSES.has(String(status || ""));
}

function api(path) {
  return `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${path}`;
}

function currentSupervisorToken() {
  return extensionToken || "";
}

function safe(value, fallback = "-") {
  return value === undefined || value === null || value === "" ? fallback : value;
}






const fmtDateTime = (v) => v ? new Intl.DateTimeFormat('pt-BR', {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'}).format(new Date(v)) : '—';

const statusLabelsPtBr = {
  accepted: "Aceita", approved: "Aprovada", awaiting_analyst: "Aguardando o analista",
  cancelled: "Cancelada", declined: "Recusada", execution: "Em execução", finished: "Finalizada",
  identified: "Identificada", open: "Aberta", pending: "Pendente", processed: "Processada",
  rejected: "Reprovada", working_overtime: "Extra confirmado · OK",
};

function statusLabelPtBr(value, fallback = "-") {
  const raw = String(value || "").trim();
  return raw ? (statusLabelsPtBr[raw.toLowerCase()] || raw.replaceAll("_", " ")) : fallback;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeUrl(value) {
  const url = String(value || "").trim();
  return /^https?:\/\//i.test(url) ? url : "";
}

function dateOnly(value) {
  return String(value || "").slice(0, 10);
}

function fmtDate(value) {
  if (!value) return "-";
  const date = new Date(String(value).includes("T") ? value : `${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleDateString("pt-BR");
}

function fmtTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}




function openDialogMessageBox() {
  const dialogs = [...document.querySelectorAll("dialog[open]")];
  const dialog = dialogs[dialogs.length - 1];
  if (!dialog) return null;
  let box = dialog.querySelector(".dialog-message");
  if (!box) {
    box = document.createElement("div");
    box.className = "dialog-message";
    const host = dialog.querySelector(".modal") || dialog;
    const header = host.querySelector(".modal-header");
    if (header) header.insertAdjacentElement("afterend", box);
    else host.prepend(box);
  }
  return box;
}

function showDialogMessage(message, kind) {
  const box = openDialogMessageBox();
  if (!box) return;
  box.classList.toggle("notice", kind === "notice");
  box.textContent = message || "";
  box.hidden = !message;
  if (message) box.scrollIntoView({ block: "nearest", behavior: "smooth" });
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

function showError(message) {
  if (message && /failed to fetch|networkerror|load failed|timed out|jwt/i.test(String(message))) {
    message = friendlyError(message);
  }
  const box = document.getElementById("error");
  if (!box) return;
  box.classList.remove("notice");
  box.textContent = message;
  box.style.display = message ? "block" : "none";
  showDialogMessage(message, "error");
}

function hideError() {
  const box = document.getElementById("error");
  if (!box) return;
  box.textContent = "";
  box.style.display = "none";
  showDialogMessage("", "error");
}

function showNotice(message) {
  const box = document.getElementById("error");
  if (!box) return;
  box.classList.add("notice");
  box.textContent = message;
  box.style.display = message ? "block" : "none";
  showDialogMessage(message, "notice");
}

function applyTheme(theme) {
  const selected = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = selected;
  localStorage.setItem("routingTowerSupervisorTheme", selected);
  const button = document.getElementById("themeBtn");
  if (button) {
    button.setAttribute("aria-label", selected === "dark" ? "Ativar tema claro" : "Ativar tema escuro");
    button.title = selected === "dark" ? "Mudar para o dia" : "Mudar para a noite";
  }
}

applyTheme(localStorage.getItem("routingTowerSupervisorTheme") ||
  (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"));

function roleCanSelectScope() {
  const role = String(payload?.access?.role || "").toLowerCase();




  return ["admin", "gerente", "coordenador", "supervisor"].includes(role);
}

function canEditPanel() {
  return Boolean(payload?.access?.can_edit);
}

let panelLoad = null, panelLoadToken = null, lastManualLoadAt = 0;
async function loadData(preferCache=false) {
  const identity = currentSupervisorToken();
  if (panelLoad && panelLoadToken === identity) return panelLoad;

  if (readRecovery.waiting() && Date.now() - lastManualLoadAt < 5000) {
    clearTimeout(loadRetryTimer);
    loadRetryTimer = setTimeout(() => loadData(preferCache), Math.max(5000, readRecovery.remainingSeconds() * 1000));
    return;
  }
  lastManualLoadAt = Date.now();
  panelLoadToken = identity;
  const task = loadDataOnce(preferCache);
  panelLoad = task;
  try { return await task; } finally { if (panelLoad === task) panelLoad = null; }
}
async function loadDataOnce(preferCache=false) {
  showError("");
  clearTimeout(loadRetryTimer);
  const supervisorToken = currentSupervisorToken();
  if (!supervisorToken) {
    showError("Acesso ao painel não configurado. Abra a extensão Routing Tower e cole a chave recebida pelo gestor.");
    return;
  }

  await rtReadCache.begin("supervisor", supervisorToken);


  let slowShown = false;
  const slowHint = setTimeout(() => {
    if (payload) return;
    slowShown = true;
    showNotice("Ainda carregando… o servidor está mais lento que o normal. Se for uma atualização do sistema, esta tela vai avisar.");
  }, 8000);
  try {
    const response = await rtReadCache.request("snapshot", () => fetchWithTimeout(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/rt_get_supervisor_state`, {
      method: "POST",
      headers,
      body: JSON.stringify({ p_token: supervisorToken }),
    }), preferCache, value => Boolean(value?.payload), true);
    if (supervisorToken !== currentSupervisorToken()) return;
    if (!response.ok) throw httpError(response, "state");

    const state = await response.json();
    if (supervisorToken !== currentSupervisorToken()) return;
    if (!state?.payload) throw new Error("empty");
    payload = state.payload;
    if (!response.headers.get("X-RT-Cache")) readRecovery.recovered();
    if (slowShown) hideError();

    const allowedAnalysts = new Set((payload.analysts || []).map((item) => Number(item.id)));
    const allowedTokens = new Set((payload.analysts || []).map((item) => item.portal_token).filter(Boolean));
    operations = (state.operations || []).filter((item) => allowedAnalysts.has(Number(item.analyst_id)));
    occurrences = (state.occurrences || []).filter((item) =>
      allowedAnalysts.has(Number(item.analyst_id)) || allowedTokens.has(item.portal_token)
    );
    overtimeRequests = (state.overtime || []).filter((item) => allowedAnalysts.has(Number(item.analyst_id)));

    occurrencesResolved = (state.occurrences_resolved || []).filter((item) =>
      allowedAnalysts.has(Number(item.analyst_id)) || allowedTokens.has(item.portal_token)
    );
    if (!dateFilterInitialized) {
      dateFilterInitialized = true;
      filterDate = operationalTodayIso();
    }
    render();
    const cachedSnapshot = response.headers.get("X-RT-Cache");
    if (cachedSnapshot) {
      activeSubstitutions = rtReadCache.peek("substitutions", Array.isArray) || activeSubstitutions;
      if (rtReadCache.peek("timeoff", value => Array.isArray(value?.absences))) loadLiveTimeoff(true).then(changed => { if (changed) render(); });
      const seconds = cachedSnapshot === "fallback" ? (readRecovery.waiting() ? readRecovery.remainingSeconds() : readRecovery.nextSeconds()) : 1;
      loadRetryTimer = setTimeout(() => loadData(), seconds * 1000);
    } else {
    loadActiveSubstitutions().then(() => scanOperationalAlerts());
    registerPanelVersion(supervisorToken, payload?.access?.name);
    loadLiveTimeoff().then((changed) => { if (changed) render(); });
    }
  } catch (error) {
    if (supervisorToken !== currentSupervisorToken() || error.stale) return;
    if (error.status === 401 || error.status === 403) { payload = null; operations = []; occurrences = []; document.body.replaceChildren(Object.assign(document.createElement("p"), {textContent:"Acesso não autorizado. Confira a chave nas configurações da extensão."})); return; }
    console.error("Falha ao carregar painel do supervisor", error);
    if (slowShown) hideError();
    await handleLoadFailure(error);
  } finally {
    clearTimeout(slowHint);
  }
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

const readRecovery = createReadRecovery(currentSupervisorToken);

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
        <button type="button" class="rt-maint-view">Ver o painel mesmo assim</button>
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
  const done = "Atualização do sistema concluída.";
  loadData().then(() => {
    if (!payload) return;
    showNotice(done);
    setTimeout(() => { if (document.getElementById("error")?.textContent === done) hideError(); }, 6000);
  });
}

async function handleLoadFailure(error) {
  if (await checkMaintenance()) return;
  if (isTransientFailure(error)) {
    const retrySeconds = (readRecovery.waiting() ? readRecovery.remainingSeconds() : readRecovery.nextSeconds());
    showError(`${friendlyError(error)} Tento de novo sozinho em ${retrySeconds} s (ou clique em Atualizar).`);
    clearTimeout(loadRetryTimer);
    loadRetryTimer = setTimeout(() => loadData(), retrySeconds * 1000);
    return;
  }
  showError("Não consegui carregar o painel online agora. Publique a escala novamente no app e tente atualizar.");
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
  "operacao": {
    "titulo": "Painel do supervisor",
    "para_que": "Acompanhar a operação do time em tempo real: quem está com cada hub, o que começou, terminou ou atrasou, e as ocorrências.",
    "passos": [
      "Escolha o período (Dia, Semana, Mês ou Intervalo), a data e o escopo (todos os supervisores ou um).",
      "Os contadores mostram o total de ocorrências, as pendentes e as OK; clique num contador para abrir a lista.",
      "Os indicadores mostram analistas com hub, hubs do dia, janelas de roteirização, finalizados, em execução, atenção e sem analista; os gráficos mostram os hubs por status e por regional.",
      "Cada cartão de analista tem o farol (em execução, OK, em ordem, atenção): clique no cartão para abrir os detalhes do analista.",
      "Botões do topo: \"Agenda\", \"Ocorrências\", \"Prévia da escala\" (Gantt do dia), \"Hubs sem analista\" e \"Mais\" (supervisor substituto, cadastro emergencial, links úteis, termos e atualizar telas).",
      "O botão redondo no canto: \"Exportar esta visão em PDF\", \"Voltar para hoje\" e \"Atualizar dados\".",
      "Cada janela do painel tem o seu \"?\" com o passo a passo dela."
    ],
    "dicas": [
      "O painel avisa no Windows quando um hub atrasa ou não começa.",
      "Os números mudam quando os analistas registram nos painéis ou quando o app publica a escala.",
      "Se o sistema estiver em atualização, aparece um aviso; a tela volta sozinha quando terminar."
    ]
  },
  "dashboard": {
    "titulo": "Dashboard Gerencial",
    "para_que": "O resumo gerencial do período: situação das operações, atrasos, cancelamentos, horas extras e ocorrências, com os filtros da aba Operação.",
    "passos": [
      "Escolha o período (Dia, Semana, Mês ou Intervalo). A data e os outros filtros (escopo, analista, hub, regional) são os da aba \"Operação\".",
      "\"Resumo do período\": operações, finalizadas, em execução, sem início, atrasadas, canceladas e sem operação.",
      "\"Atrasos e pendências\": quanto das janelas que já terminaram foi encerrado no sistema e quais analistas e hubs mais atrasam.",
      "\"Roteirizações canceladas\": os motivos mais comuns e as últimas canceladas.",
      "\"Horas extras\": horas por situação, por motivo e por analista, com pagamento e compensação.",
      "\"Ocorrências\": pendentes por tempo de espera, tempo médio até a tratativa e os tipos mais comuns.",
      "\"Exportar PDF\" salva o dashboard."
    ],
    "dicas": [
      "Passe o mouse nas barras para ver o detalhe.",
      "Os atrasos são medidos pelo status que o analista registra: o painel não guarda a hora exata de início."
    ]
  },
  "visibilidade": {
    "titulo": "Visibilidade Schedule",
    "para_que": "Jornada, janelas de roteirização e disponibilidade dos analistas das supervisões. Os times que usam o Routing Tower vêm da escala publicada no app (ao vivo); as outras supervisões, da planilha Gestão T3.",
    "passos": [
      "\"Resumo\" (abre primeiro): indicadores e destaques do dia (primeira e última janela, hubs por analista, o mais ocupado, o maior tempo livre, folguistas), uma linha por supervisor (clique para filtrar), os pontos de atenção do mais grave para o menos grave (clique para ver o analista na Prévia), a carga por analista (mais ocupados e quem tem mais tempo livre para assumir um hub), ausências e retornos, hora a hora, as próximas 2 horas (no dia atual), a escala de ceia, as regiões (clique para filtrar) e as jornadas.",
      "\"Sugestões de analistas\" (no Resumo): para cada hub atrasado (sem início depois do tempo das configurações do Gerenciamento, 10 min), novo hub ou alteração de opsclock, quem está livre na janela - primeiro o mesmo supervisor, depois a mesma regional, depois os outros. Clique num nome para ver na Prévia.",
      "\"Prévia da escala\": as janelas de cada analista no dia; a faixa clara é a jornada e, onde não há barra, o analista está livre.",
      "\"Disponibilidade\": quantos estão livres, em operação e em ceia a cada 30 minutos ou 1 hora; clique num horário para ver os nomes.",
      "\"Análise\": horas com demanda e disponíveis por supervisor e por analista, e os ciclos por regional.",
      "Use as setas e \"Hoje\" para mudar o dia, e os filtros de supervisor, região, turno e busca.",
      "\"Atualizar\" lê o Routing Tower e a planilha de novo (a aba também atualiza sozinha a cada 5 minutos com ela aberta); \"Planilha\" abre a Gestão T3; \"Ver tabela\" troca a linha do tempo por uma tabela; \"Salvar PDF\" imprime."
    ],
    "dicas": [
      "Time do Routing Tower (igual ao app): janelas = escala publicada do dia, sem rotas canceladas e sem \"Sem operação\"; sem operação no dia = folga; ceia = a lançada no app; férias e afastamentos vêm do app; analista com até 30 dias de casa aparece como \"nova\".",
      "Dia ainda sem escala publicada: o time aparece com a escala PREVISTA (repete o mesmo dia da semana já publicado; folgas, DSR e férias lançados valem) e o subtítulo avisa.",
      "Regras de RH do dia (11 h de descanso, até 2 h extras, até 7 dias e até 3 domingos seguidos) aparecem nos pontos de atenção do Resumo, contando só a partir do início na empresa.",
      "\"Salvar PDF\" imprime só a aba, sem cortar os blocos entre as páginas.",
      "A linha do tempo mostra de onde vieram os dados (\"Routing Tower ao vivo + Gestão T3\").",
      "Para as supervisões da planilha, o Chrome precisa estar logado com a conta @shopee.com. Aberto pelo app (127.0.0.1), o Chrome não deixa ler a planilha e a aba mostra só os times do Routing Tower."
    ]
  },
  "gerenciamento": {
    "titulo": "Gerenciamento",
    "para_que": "Comunicação entre supervisores, coordenação e gerência: solicitações (mensagem, alteração de horário, clusterização, envio de arquivo), comunicados, arquivos e áreas de trabalho no estilo Monday/Trello, com tarefas, micro tarefas, etiquetas e prazos.",
    "passos": [
      "\"Solicitações\": \"Nova solicitação\" com o tipo, para quem (coordenação, gerência ou as duas), o assunto, a mensagem e os anexos. Alteração de horário pede hub, ciclo, dias e horários; clusterização, hub e a proposta.",
      "Na solicitação aberta, a conversa fica em ordem. A coordenação/gerência aprova, pede ajuste ou recusa (o texto do campo de resposta vai junto); o supervisor responde e marca como concluída. A bolinha laranja mostra o que está aguardando você.",
      "\"Comunicados\": a coordenação/gerência publica para os times (com categoria e, nas categorias com campos, o hub, a regional e a janela) e vê quem já leu; o supervisor confirma com \"Li e entendi\". No topo, filtre por categoria, por data (De/Até) e pelo texto.",
      "\"Configurações\" (coordenação, gerência e admin): categorias dos comunicados e tipos de solicitação (nome, cor, campos extras, se sugerem analistas na Visibilidade, se pedem \"Li e entendi\", ativo), destinos do \"Para\", colunas e etiquetas padrão das áreas, limites dos anexos e as sugestões (minutos de atraso do hub, nomes por grupo). O que já foi usado não é apagado, só desativado.",
      "\"Arquivos\": todos os anexos das solicitações, para baixar ou abrir a solicitação de origem.",
      "\"Áreas de trabalho\" → \"Nova área de trabalho\": nome, cor e os membros (só eles e o admin veem a área). Ela já nasce com as colunas A fazer, Em andamento, Em revisão e Concluído e com algumas etiquetas.",
      "\"Nova tarefa\" ou \"+ Adicionar tarefa\" numa coluna: título, descrição, responsável, início, prazo, prioridade e etiquetas.",
      "Arraste o cartão para outra coluna para mudar a situação; na coluna marcada como concluída a tarefa ganha a data de conclusão.",
      "Abra a tarefa para as micro tarefas (#1, #2..., como issues do Git: abrir/fechar, responsável, prazo e etiquetas) e os comentários.",
      "\"Configurar área\": colunas (nome, cor, ordem, se conta como concluída) e etiquetas (nome e cor). Nome, cor, membros e arquivar: só quem criou a área ou o admin.",
      "\"Prazos\": o gráfico das tarefas da área do início ao prazo, por um dia ou por um intervalo; \"Prazos de todas as áreas\" junta todas."
    ],
    "dicas": [
      "Anexos: até 5 arquivos e 2 MB por mensagem, até 100 MB no total (em \"Arquivos\" aparece o espaço usado). Os antigos vão para o Drive: o admin baixa, guarda e clica em \"Remover\".",
      "O número na aba Gerenciamento mostra o que aguarda você (solicitações e comunicados não lidos), e o Windows avisa quando chega algo novo.",
      "Prazo em vermelho: atrasada; em laranja: vence em até 2 dias.",
      "A tela se atualiza sozinha a cada minuto; \"Atualizar\" busca na hora."
    ]
  },

  "details": {
    "titulo": "Detalhes do analista",
    "para_que": "A ficha do analista e as operações dele no período: próximas folgas, horas extras, contato e cada hub com o status.",
    "passos": [
      "A ficha no topo mostra as próximas folgas (até o fim do mês seguinte), as horas extras e o contato.",
      "A lista mostra cada operação com hub, horário e status; a operação cancelada traz o motivo.",
      "Para passar uma operação a outro analista, escolha em \"Selecione alguém livre nesse horário\" e clique em \"Transferir\".",
      "\"↗ Portal do analista\" abre o painel como o analista vê."
    ],
    "dicas": [
      "Operação finalizada não pode ser transferida.",
      "Quem só visualiza (gerente, coordenador) não transfere."
    ]
  },
  "unassigned": {
    "titulo": "Hubs sem analista",
    "para_que": "Os hubs que estão sem analista na data operacional, para atribuir na hora.",
    "passos": [
      "Confira a lista de hubs sem analista da data escolhida no painel.",
      "Escolha o analista em \"Selecione o analista\" (e o ciclo, quando houver mais de um) e clique em \"Atribuir\"."
    ],
    "dicas": [
      "\"Sem ciclo operando nesta data\": o hub não tem janela cadastrada; ajuste no app (Hubs e ciclos).",
      "Hub ou analista que não existe no cadastro: use Mais > \"Cadastro emergencial (só hoje)\"."
    ]
  },
  "ocorrencias": {
    "titulo": "Ocorrências",
    "para_que": "As ocorrências que os analistas comunicaram nas operações, para tratar e dar retorno.",
    "passos": [
      "Abra pelo botão \"Ocorrências\" ou clicando num contador (total, pendentes ou OK).",
      "Leia a ocorrência, escreva a tratativa (fica no histórico da gestão) e escolha \"Aprovar tratativa\" ou \"Reprovar / devolver\".",
      "Clique em \"Salvar tratativa\": o analista vê o retorno no painel dele."
    ],
    "dicas": [
      "Sem a tratativa escrita, a ocorrência não é concluída."
    ]
  },
  "agenda": {
    "titulo": "Agenda",
    "para_que": "Mandar compromissos e avisos para a equipe: reuniões, treinamentos, implantações e avisos operacionais.",
    "passos": [
      "Em \"Agendar para\", escolha toda a equipe do escopo, analistas selecionados ou operações selecionadas.",
      "Escolha o tipo (Reunião, Treinamento, Implantação em operação ou Aviso operacional), o título, a data e o horário e a duração.",
      "Em \"Repetir\", escolha se o compromisso se repete toda semana (2, 4, 8 ou 12 vezes).",
      "Se quiser, cole o link (Meet, Drive ou documento) e escreva a mensagem; depois clique em \"Enviar\".",
      "\"Enviados nos últimos 60 dias\" mostra o que já foi enviado e quem confirmou presença ou avisou que não pode."
    ],
    "dicas": [
      "O analista recebe no painel, com aviso perto do horário, e responde \"Vou participar\" ou \"Não posso\".",
      "Data e horário que já passaram não são aceitos."
    ]
  },
  "substituto": {
    "titulo": "Supervisor substituto",
    "para_que": "Quando um supervisor estiver de folga, outro acompanha o time dele e recebe os avisos (hub atrasado ou sem início).",
    "passos": [
      "Escolha o supervisor original, o substituto, o período (De e Até) e, se quiser, o motivo.",
      "Clique em \"Atribuir substituto\"; para encerrar antes, use \"Cancelar\" na substituição ativa."
    ],
    "dicas": [
      "A substituição só vale enquanto a data de hoje estiver dentro do período."
    ]
  },
  "emergencial": {
    "titulo": "Cadastro emergencial (só hoje)",
    "para_que": "Resolver na hora um hub ou um analista que falta no cadastro, só para hoje; o cadastro definitivo é feito no app.",
    "passos": [
      "\"Hub emergencial\": escolha um hub já cadastrado (falta só o ciclo de hoje) ou informe um hub novo (código operacional e nome), com o início e o fim do ciclo de hoje; clique em \"Cadastrar Hub emergencial\".",
      "\"Analista emergencial\": nome, Staff ID (opcional) e o início e o fim do turno; clique em \"Cadastrar analista emergencial\"."
    ],
    "dicas": [
      "Depois, cadastre do jeito certo no app (Hubs e ciclos ou Analistas)."
    ]
  },
  "links": {
    "titulo": "Links úteis",
    "para_que": "Cadastrar os atalhos (manuais, planilhas e sistemas) que aparecem no painel dos analistas.",
    "passos": [
      "Em \"Novo link\", informe a categoria, o título e o endereço (https://...) e clique em \"Adicionar link\".",
      "\"Excluir\" tira um link da lista."
    ],
    "dicas": [
      "Os analistas veem os links na aba \"Links úteis\" do painel deles."
    ]
  },
  "previa": {
    "titulo": "Prévia da escala",
    "para_que": "O Gantt das operações publicadas de cada analista num dia, com os filtros do painel.",
    "passos": [
      "Use ◀ e ▶ para trocar o dia.",
      "As cores mostram a situação: em ordem ou finalizado, em execução, sem início, atrasado ou cancelado; folga e DSR aparecem listrados.",
      "A linha vermelha marca o horário de agora.",
      "\"Salvar PDF\" abre a impressão do Chrome: escolha \"Salvar como PDF\"."
    ],
    "dicas": [
      "É só para ver: para mudar a escala, use o app (Montar escala)."
    ]
  }
};
const HELP_BY_DIALOG = {
  details: "details", unassigned: "unassigned", occurrencesDialog: "ocorrencias", eventsDialog: "agenda",
  substDialog: "substituto", emergencyDialog: "emergencial", linksDialog: "links", ganttDialog: "previa",
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
  const guide = HELP_GUIDES[key] || HELP_GUIDES.operacao;
  document.getElementById("glossaryBody").innerHTML = `
    <div class="modal-header"><h2>Como usar: ${escapeHtml(guide.titulo)}</h2><button data-close="glossaryDialog">Fechar</button></div>
    ${helpGuideHtml(guide)}
    <h3 class="help-terms-title">O que significa cada termo</h3>
    ${glossaryHtml()}`;
  const dialog = document.getElementById("glossaryDialog");
  if (!dialog.open) dialog.showModal();
}

function addDialogHelpButton(dialog) {
  const key = HELP_BY_DIALOG[dialog.id];
  const header = dialog.querySelector(".modal-header");
  if (!key || !header || header.querySelector(".help-btn")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "help-btn";
  button.textContent = "?";
  button.title = "Como usar esta janela";
  button.setAttribute("aria-label", "Como usar esta janela");
  button.onclick = () => openHelp(key);
  header.insertBefore(button, header.querySelector("[data-close]"));
}

Object.keys(HELP_BY_DIALOG).forEach((id) => {
  const dialog = document.getElementById(id);
  if (!dialog) return;
  new MutationObserver(() => addDialogHelpButton(dialog)).observe(dialog, { childList: true, subtree: true });
  addDialogHelpButton(dialog);
});

function openGlossary() {
  document.getElementById("glossaryBody").innerHTML = `
    <div class="modal-header"><h2>O que significa cada termo</h2><button data-close="glossaryDialog">Fechar</button></div>
    ${glossaryHtml()}`;
  document.getElementById("glossaryDialog").showModal();
}


let panelVersionRegistered = false;
function registerPanelVersion(token, name) {
  const version = globalThis.chrome?.runtime?.getManifest?.()?.version;
  if (panelVersionRegistered || !version || !token) return;
  panelVersionRegistered = true;
  fetch(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/rt_register_panel_version`, {
    method: "POST",
    headers,
    body: JSON.stringify({ p_token: token, p_panel: "supervisor", p_version: version, p_name: name || "" }),
  }).catch(() => {});
}








async function refreshPanel() {
  const button = document.getElementById("refreshBtn");
  if (!button || button.classList.contains("syncing")) return;
  const originalTitle = button.title;
  const originalText = button.textContent;
  button.classList.add("syncing");
  button.disabled = true;
  button.title = "Sincronizando...";
  button.textContent = "Atualizando…";
  try {
    await loadData();
  } finally {
    button.classList.remove("syncing");
    button.disabled = false;
    button.title = originalTitle;
    button.textContent = originalText;
  }
}





function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}







function operationalTodayIso() {
  const now = new Date();
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (now.getHours() < 12) cursor.setDate(cursor.getDate() - 1);
  return `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`;
}

function isoOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}


function periodRange() {
  const base = /^\d{4}-\d{2}-\d{2}$/.test(filterDate) ? filterDate : operationalTodayIso();
  const anchor = new Date(`${base}T12:00:00`);
  let start = new Date(anchor);
  let end = new Date(anchor);
  if (periodMode === "week") {
    start.setDate(anchor.getDate() - ((anchor.getDay() + 6) % 7));
    end = new Date(start);
    end.setDate(start.getDate() + 6);
  } else if (periodMode === "month") {
    start = new Date(anchor.getFullYear(), anchor.getMonth(), 1, 12);
    end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0, 12);
  } else if (periodMode === "range" && /^\d{4}-\d{2}-\d{2}$/.test(filterDateEnd)) {
    end = new Date(`${filterDateEnd}T12:00:00`);
  }
  if (end < start) [start, end] = [end, start];
  const limit = new Date(start);
  limit.setDate(start.getDate() + 61);
  if (end > limit) end = limit;
  return { start: isoOf(start), end: isoOf(end) };
}

function inPeriod(day) {
  const { start, end } = periodRange();
  return Boolean(day) && day >= start && day <= end;
}

function periodLabel() {
  const { start, end } = periodRange();
  return start === end ? fmtDate(start) : `${fmtDate(start)} a ${fmtDate(end)}`;
}

function updatePeriodButtons() {
  document.querySelectorAll("[data-period-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.periodMode === periodMode);
  });
}

async function loadActiveSubstitutions(preferCache = false) {
  if (window.RT_WEB_CONTEXT) return;
  const identity = currentSupervisorToken();
  try {
    const response = await rtReadCache.request("substitutions", () => fetchWithTimeout(api("rpc/rt_list_supervisor_substitutes"), {
      method: "POST", headers, body: JSON.stringify({ p_token: identity }),
    }), preferCache, Array.isArray);
    if (identity !== currentSupervisorToken()) return;
    if (response.ok) activeSubstitutions = (await response.json()) || [];
  } catch (error) {
    console.warn("Falha ao carregar supervisores substitutos", error);
  }
  if (document.getElementById("substDialog")?.open) renderSubstitutesPanel();
}

function myTeamNamesForAlerts() {
  const me = String(payload?.access?.name || "").trim();
  const names = new Set();
  if (me) names.add(me);
  const today = todayIso();
  (activeSubstitutions || []).forEach((sub) => {
    if (sub.substitute_supervisor === me && sub.start_date <= today && today <= sub.end_date) {
      names.add(sub.original_supervisor);
    }
  });
  return names;
}

async function saveSupervisorSubstitute() {
  const original = document.getElementById("substOriginal").value;
  const substitute = document.getElementById("substReplacement").value;
  const start = document.getElementById("substStart").value;
  const end = document.getElementById("substEnd").value;
  const reason = document.getElementById("substReason").value;
  if (!original || !substitute || !start || !end) {
    showNotice("Preencha supervisor original, substituto e o período.");
    return;
  }
  try {
    const response = await fetch(api("rpc/rt_set_supervisor_substitute"), {
      method: "POST",
      headers,
      body: JSON.stringify({
        p_token: currentSupervisorToken(),
        p_created_by_name: payload?.access?.name || "",
        p_original_supervisor: original,
        p_substitute_supervisor: substitute,
        p_start_date: start,
        p_end_date: end,
        p_reason: reason || null,
      }),
    });
    if (!response.ok) {
      const problem = await response.json().catch(() => null);
      throw new Error(problem?.message || "Não consegui salvar a substituição.");
    }
    document.getElementById("substReason").value = "";
    showNotice("Supervisor substituto atribuído.");
    await loadActiveSubstitutions();
  } catch (error) {
    showError(error.message);
  }
}

async function cancelSupervisorSubstitute(id) {
  try {
    await fetch(api("rpc/rt_cancel_supervisor_substitute"), {
      method: "POST", headers, body: JSON.stringify({ p_token: currentSupervisorToken(), p_id: Number(id) }),
    });
  } catch (error) {
    console.warn("Falha ao cancelar substituição", error);
  }
  await loadActiveSubstitutions();
}

function openSubstitutesDialog() {
  document.getElementById("substBody").innerHTML = `
    <div class="modal-header">
      <div><h2>Supervisor substituto</h2><p class="subtitle">Enquanto durar o período, os alertas do time do supervisor
        original (hub atrasado, sem início) também chegam pro substituto.</p></div>
      <button data-close="substDialog">Fechar</button>
    </div>
    <div class="event-form">
      <label>Supervisor original <select id="substOriginal"></select></label>
      <label>Substituto <select id="substReplacement"></select></label>
      <label>De <input id="substStart" type="date"></label>
      <label>Até <input id="substEnd" type="date"></label>
      <label>Motivo (opcional) <input id="substReason" placeholder="Ex.: Férias"></label>
      <button type="button" data-action="save-subst">Atribuir substituto</button>
    </div>
    <div id="substitutesList" class="list"></div>`;
  document.getElementById("substDialog").showModal();
  renderSubstitutesPanel();
}

function renderSubstitutesPanel() {
  const box = document.getElementById("substitutesList");
  if (!box) return; // diálogo fechado - nada pra atualizar agora
  const supervisors = [...new Set((payload.supervisors || []).filter(Boolean))].sort();
  const optionsHtml = supervisors.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
  document.getElementById("substOriginal").innerHTML = optionsHtml;
  document.getElementById("substReplacement").innerHTML = optionsHtml;
  const today = todayIso();
  box.innerHTML = activeSubstitutions.length ? activeSubstitutions.map((sub) => {
    const active = sub.start_date <= today && today <= sub.end_date;
    return `<div class="row operation-row ${active ? "blue" : "orange"}">
      <div>
        <b>${escapeHtml(sub.original_supervisor)} → ${escapeHtml(sub.substitute_supervisor)}</b>
        <span class="pill ${active ? "blue" : "orange"}">${active ? "ativo" : "agendado/encerrado"}</span><br>
        <small>${fmtDate(sub.start_date)} a ${fmtDate(sub.end_date)}${sub.reason ? " · " + escapeHtml(sub.reason) : ""}</small>
      </div>
      <button type="button" data-action="cancel-subst" data-id="${sub.id}">Cancelar</button>
    </div>`;
  }).join("") : `<div class="chart-empty">Nenhum supervisor substituto atribuído.</div>`;
}


const NOTIFIED_ALERTS_STORAGE_KEY = "rtSupervisorNotifiedAlerts";





const SUPERVISOR_ALERT_STATE_KEY = "rtSupervisorAlertState";
let notifiedAlertIds = null;
let supervisorAlertState = null;

function loadNotifiedAlertIds() {
  if (notifiedAlertIds && supervisorAlertState) return Promise.resolve(notifiedAlertIds);
  return new Promise((resolve) => {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      notifiedAlertIds = new Set();
      supervisorAlertState = {};
      resolve(notifiedAlertIds);
      return;
    }
    chrome.storage.local.get(
      { [NOTIFIED_ALERTS_STORAGE_KEY]: [], [SUPERVISOR_ALERT_STATE_KEY]: {} },
      (cfg) => {



        notifiedAlertIds = new Set((cfg[NOTIFIED_ALERTS_STORAGE_KEY] || []).slice(-500));
        supervisorAlertState = cfg[SUPERVISOR_ALERT_STATE_KEY] && typeof cfg[SUPERVISOR_ALERT_STATE_KEY] === "object"
          ? cfg[SUPERVISOR_ALERT_STATE_KEY] : {};
        resolve(notifiedAlertIds);
      }
    );
  });
}

function persistNotifiedAlertIds() {
  if (typeof chrome === "undefined" || !chrome.storage?.local || !notifiedAlertIds) return;
  chrome.storage.local.set({
    [NOTIFIED_ALERTS_STORAGE_KEY]: [...notifiedAlertIds].slice(-500),
    [SUPERVISOR_ALERT_STATE_KEY]: supervisorAlertState || {},
  });
}

function systemNotify(id, title, message) {
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

async function scanOperationalAlerts() {
  if (typeof chrome === "undefined" || !chrome.notifications || document.hidden) return;
  await loadNotifiedAlertIds();
  const teamNames = myTeamNamesForAlerts();
  const analystSupervisor = new Map((payload?.analysts || []).map((a) => [Number(a.id), a.supervisor || ""]));
  const now = new Date();
  let changed = false;
  operations.forEach((item) => {



    const supervisorName = analystSupervisor.get(Number(item.analyst_id));
    if (supervisorName && teamNames.size && !teamNames.has(supervisorName)) return;
    const key = String(item.assignment_id || item.id || "");
    if (!key) return;
    const state = operationState(item, now);
    if (state.key === "late") {
      const alertId = `late:${key}`;
      if (!notifiedAlertIds.has(alertId)) {
        notifiedAlertIds.add(alertId);
        changed = true;
        systemNotify(alertId, "Hub atrasado",
          `${item.station_id || item.hub_name || "Hub"} · ${item.analyst_name || "Analista"} está atrasado.`);
      }
      return;
    }
    if (state.key === "early") {
      const alertId = `early:${key}`;
      if (!notifiedAlertIds.has(alertId)) {
        notifiedAlertIds.add(alertId);
        changed = true;
        systemNotify(alertId, "Hub adiantado",
          `${item.station_id || item.hub_name || "Hub"} · ${item.analyst_name || "Analista"} iniciou a roteirização adiantado.`);
      }
      return;
    }
    const start = item.start_datetime ? new Date(item.start_datetime) : null;
    const startOk = start && !Number.isNaN(start.getTime());
    if (startOk && String(item.operation_status || "pending") === "pending" && (now - start) >= 5 * 60 * 1000) {
      const alertId = `not-started:${key}`;
      if (!notifiedAlertIds.has(alertId)) {
        notifiedAlertIds.add(alertId);
        changed = true;
        systemNotify(alertId, "Hub sem início",
          `${item.station_id || item.hub_name || "Hub"} · ${item.analyst_name || "Analista"} não iniciou 5 min após o horário.`);
      }
    }
  });




  const occurrencesBaselined = Boolean(supervisorAlertState.occurrencesBaselined);
  occurrences.forEach((item) => {
    const supervisorName = analystSupervisor.get(Number(item.analyst_id));
    if (supervisorName && teamNames.size && !teamNames.has(supervisorName)) return;
    const key = String(item.id || "");
    if (!key) return;
    const alertId = `occurrence-received:${key}`;
    if (!notifiedAlertIds.has(alertId)) {
      notifiedAlertIds.add(alertId);
      changed = true;
      if (occurrencesBaselined) {
        systemNotify(alertId, "Nova ocorrência recebida",
          `${item.analyst_name || "Analista"}: ${item.message || "sem descrição"}`);
      }
    }
  });
  if (!occurrencesBaselined) {
    supervisorAlertState.occurrencesBaselined = true;
    changed = true;
  }



  const myName = String(payload?.access?.name || "").trim();
  const substitutionsBaselined = Boolean(supervisorAlertState.substitutionsBaselined);
  (activeSubstitutions || []).forEach((sub) => {
    if (sub.substitute_supervisor !== myName) return;
    const key = String(sub.id || "");
    if (!key) return;
    const alertId = `substitute-assigned:${key}`;
    if (!notifiedAlertIds.has(alertId)) {
      notifiedAlertIds.add(alertId);
      changed = true;
      if (substitutionsBaselined) {
        systemNotify(alertId, "Atribuição de supervisor",
          `Você foi atribuído como substituto de ${sub.original_supervisor || "outro supervisor"} de ${fmtDate(sub.start_date)} a ${fmtDate(sub.end_date)}.`);
      }
    }
  });
  if (!substitutionsBaselined) {
    supervisorAlertState.substitutionsBaselined = true;
    changed = true;
  }




  supervisorAlertState.overtime = supervisorAlertState.overtime || {};
  overtimeRequests.forEach((item) => {
    const supervisorName = analystSupervisor.get(Number(item.analyst_id));
    if (supervisorName && teamNames.size && !teamNames.has(supervisorName)) return;
    const key = String(item.id || "");
    if (!key) return;
    const previousStatus = supervisorAlertState.overtime[key];
    if (item.status === "accepted" && previousStatus && previousStatus !== "accepted") {
      systemNotify(`overtime-accepted:${key}:${item.status}`, "Hora extra aceita",
        `${item.analyst_name || "Analista"} aceitou a hora extra de ${fmtDate(item.work_date)}.`);
      changed = true;
    }
    if (previousStatus !== item.status) {
      supervisorAlertState.overtime[key] = item.status;
      changed = true;
    }
  });

  if (changed) persistNotifiedAlertIds();
}

setInterval(scanOperationalAlerts, 60000);

function operationState(item, now = new Date()) {
  const status = String(item.operation_status || "pending");
  const start = item.start_datetime ? new Date(item.start_datetime) : null;
  const end = item.end_datetime ? new Date(item.end_datetime) : null;
  const startOk = start && !Number.isNaN(start.getTime());
  const endOk = end && !Number.isNaN(end.getTime());

  if (status === "finished") return { key: "finished", signal: "green", label: "finalizado" };
  if (status === "cancelled_route") return { key: "cancelled_route", signal: "red", label: "roteirização cancelada" };
  if (status === "no_operation") return { key: "no_operation", signal: "gray", label: "sem operação" };
  if (status === "execution") {








    const updatedAt = item.updated_at ? new Date(item.updated_at) : null;
    const updatedAtOk = updatedAt && !Number.isNaN(updatedAt.getTime());
    if (startOk && updatedAtOk && (start - updatedAt) > 20 * 60 * 1000) {
      return { key: "early", signal: "purple", label: "adiantado" };
    }
    return { key: "execution", signal: "blue", label: "em execução" };
  }


  if (String(item.conflict_level || "").toLowerCase() === "critical") {
    return { key: "conflict", signal: "red", label: "conflito real de escala" };
  }
  if (endOk && now > end) return { key: "late", signal: "red", label: "atrasado" };
  if (startOk && now >= start) return { key: "not_started", signal: "orange", label: "deu horário e não iniciou" };
  return { key: "future", signal: "green", label: "em ordem" };
}

function stationRegionMap() {
  const map = new Map();
  (payload?.all_hubs || []).forEach((hub) => {
    if (hub.station_id) map.set(String(hub.station_id), hub.region || "Sem regional");
  });
  return map;
}

function availableRegions() {
  const regions = new Set();
  (payload?.all_hubs || []).forEach((hub) => regions.add(hub.region || "Sem regional"));
  return [...regions].filter(Boolean).sort();
}

function availableShifts() {
  const shifts = new Set();
  (payload?.analysts || []).forEach((analyst) => { if (analyst.shift) shifts.add(analyst.shift); });
  return [...shifts].sort();
}

function availableDates() {
  const dates = new Set();
  operations.forEach((item) => {
    const day = dateOnly(item.work_date);
    if (day) dates.add(day);
  });
  return [...dates].sort();
}




function availableAnalystOptions() {
  return (payload?.analysts || [])
    .filter((analyst) => analyst && analyst.id != null)
    .map((analyst) => ({ id: Number(analyst.id), name: analyst.name || `Analista ${analyst.id}` }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}


function availableHubOptions() {
  const seen = new Map();
  (payload?.all_hubs || []).forEach((hub) => {
    const stationId = String(hub.station_id || "").trim();
    if (!stationId || seen.has(stationId)) return;
    seen.set(stationId, `${stationId}${hub.hub_name ? " · " + hub.hub_name : ""}`);
  });
  return [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0], "pt-BR"));
}



function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function recountAnalyst(analyst) {




  const counts = { pending: 0, execution: 0, finished: 0, late: 0, not_started: 0, early: 0, cancelled_route: 0, no_operation: 0, away: 0 };
  const items = analyst.items || [];
  let awayLabel = "";
  items.forEach((item) => {
    const absence = absenceCoveringDate(analyst.timeoff, dateOnly(item.work_date));
    if (absence && !isTerminalOperationStatus(item.operation_status)) {
      counts.away += 1;
      awayLabel = absence.absence_type || awayLabel;
      return;
    }
    const state = operationState(item);
    if (state.key === "future") counts.pending += 1;
    else if (counts[state.key] !== undefined) counts[state.key] += 1;
  });
  const hasOpenOccurrence = occurrences.some((item) => Number(item.analyst_id) === Number(analyst.id));
  const allAway = counts.away > 0 && counts.away === items.length;
  const signal = hasOpenOccurrence || counts.late ? "red" :
    (allAway ? "orange" : (counts.not_started ? "orange" : (counts.execution || counts.early ? "blue" : "green")));
  const statusLabel = hasOpenOccurrence ? "ocorrência aberta" :
    counts.late ? "atrasado" :
    allAway ? `de folga${awayLabel ? ` (${awayLabel})` : ""}` :
    counts.not_started ? "deu horário e não iniciou" :
    counts.early ? "adiantado" :
    counts.execution ? "em execução" : "em ordem";
  const next = items
    .filter((item) => !isTerminalOperationStatus(item.operation_status) && !absenceCoveringDate(analyst.timeoff, dateOnly(item.work_date)))
    .sort((a, b) => String(a.start_datetime || "").localeCompare(String(b.start_datetime || "")))[0] || items[0];
  return {
    ...analyst,
    assignments: items.length,
    pending: counts.pending || 0,
    execution: counts.execution || 0,
    finished: counts.finished || 0,
    late: counts.late || 0,
    not_started: counts.not_started || 0,
    early: counts.early || 0,
    cancelled_route: counts.cancelled_route || 0,
    no_operation: counts.no_operation || 0,
    away: counts.away || 0,
    signal,
    status_label: statusLabel,
    next_hub: next ? `${fmtDate(next.work_date)} ${fmtTime(next.start_datetime)} - ${next.station_id || ""} ${next.hub_name || ""}`.trim() : "sem hub",
  };
}

function itemStatusKey(item) {
  const state = operationState(item);




  if (state.key === "future") return "pending";
  if (state.key === "conflict") return "late";
  return state.key;
}

function itemMatchesFilters(analystName, item, { applyDate }) {
  if (applyDate && !inPeriod(dateOnly(item.work_date))) return false;
  const regionMap = stationRegionMap();
  if (filterRegion.size && !filterRegion.has(regionMap.get(String(item.station_id)) || "Sem regional")) return false;
  if (filterStatus.size && !filterStatus.has(itemStatusKey(item))) return false;
  if (filterHub.size && !filterHub.has(String(item.station_id || ""))) return false;
  const query = normalizeSearchText(filterSearch);
  if (query) {
    const haystack = normalizeSearchText(`${analystName || ""} ${item.station_id || ""} ${item.hub_name || ""}`);
    if (!haystack.includes(query)) return false;
  }
  return true;
}

function filteredOperationalAnalysts(applyDate = true) {
  const base = buildOperationalAnalysts();
  const query = normalizeSearchText(filterSearch);
  const itemFilterActive = filterRegion.size > 0 || filterStatus.size > 0 || filterHub.size > 0 || Boolean(query) || applyDate;
  return base
    .map((analyst) => {




      if (!Array.isArray(analyst.items)) return analyst;
      const items = analyst.items.filter((item) => itemMatchesFilters(analyst.name, item, { applyDate }));
      return recountAnalyst({ ...analyst, items });
    })
    .filter((analyst) => {
      if (selectedSupervisor !== "todos" && analyst.supervisor !== selectedSupervisor) return false;
      if (filterShift.size && !filterShift.has(String(analyst.shift || ""))) return false;
      if (filterAnalyst.size && !filterAnalyst.has(String(analyst.id))) return false;
      if (itemFilterActive && Array.isArray(analyst.items) && analyst.items.length === 0) return false;
      if (filterSignal && analyst.signal !== filterSignal) return false;
      return true;
    });
}

function regionBreakdown(applyDate = true) {
  const regionMap = stationRegionMap();
  const counts = new Map();

  filteredOperationalAnalysts(applyDate).forEach((analyst) => {
    (analyst.items || []).forEach((item) => {
      const region = regionMap.get(String(item.station_id)) || "Sem regional";
      counts.set(region, (counts.get(region) || 0) + 1);
    });
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function calcMetrics(analysts) {
  const detail = { execution: 0, finished: 0, late: 0, not_started: 0, pending: 0, early: 0, cancelled_route: 0, no_operation: 0 };
  let assignments = 0;
  analysts.forEach((analyst) => {
    assignments += analyst.assignments || 0;
    detail.execution += analyst.execution || 0;
    detail.finished += analyst.finished || 0;
    detail.late += analyst.late || 0;
    detail.not_started += analyst.not_started || 0;
    detail.pending += analyst.pending || 0;
    detail.early += analyst.early || 0;
    detail.cancelled_route += analyst.cancelled_route || 0;
    detail.no_operation += analyst.no_operation || 0;
  });
  const regionMap = stationRegionMap();
  const unassigned = (payload.unassigned_hubs || []).filter(
    (hub) => !filterRegion.size || filterRegion.has(hub.region || regionMap.get(String(hub.station_id)) || "Sem regional")
  );
  return {
    analysts: analysts.length,
    assignments,
    execution: detail.execution,
    finished: detail.finished,
    pending: detail.pending,
    late: detail.late,
    not_started: detail.not_started,
    early: detail.early,
    cancelled_route: detail.cancelled_route,
    no_operation: detail.no_operation,
    attention: detail.late + detail.not_started + occurrences.length,
    without_hub: unassigned.length,
  };
}





function multiSelectSummary(selectedSet, totalOptions, allLabel) {
  if (selectedSet.size === 0 || selectedSet.size === totalOptions) return allLabel;
  if (selectedSet.size === 1) return [...selectedSet][0];
  return `${selectedSet.size} selecionados`;
}

function renderMultiSelectField(id, label, options, selectedSet, allLabel = "Todos") {

  const summaryText = multiSelectSummary(selectedSet, options.length, allLabel);
  return `
    <div class="filter-field ms-field">
      <label>${label}</label>
      <details class="ms-dropdown" id="${id}" data-ms-total="${options.length}" data-ms-all-label="${escapeHtml(allLabel)}">
        <summary>${escapeHtml(summaryText)}</summary>
        <div class="ms-panel">
          <div class="ms-panel-actions">
            <button type="button" data-ms-action="all" data-ms-id="${id}">Selecionar todos</button>
            <button type="button" data-ms-action="none" data-ms-id="${id}">Limpar</button>
          </div>
          ${options.length ? options.map(([value, optLabel]) => `
            <label class="ms-option">
              <input type="checkbox" data-ms-group="${id}" value="${escapeHtml(String(value))}" ${selectedSet.has(String(value)) ? "checked" : ""}>
              <span>${escapeHtml(optLabel)}</span>
            </label>`).join("") : `<div class="ms-empty">Nenhuma opção disponível.</div>`}
        </div>
      </details>
    </div>`;
}




function wireMultiSelectDismiss(box) {
  box.querySelectorAll("details.ms-dropdown").forEach((details) => {
    details.addEventListener("toggle", () => {
      if (!details.open) return;
      box.querySelectorAll("details.ms-dropdown").forEach((other) => {
        if (other !== details) other.open = false;
      });
    });
  });
  document.addEventListener("click", (event) => {
    if (box.contains(event.target)) return;
    box.querySelectorAll("details.ms-dropdown[open]").forEach((details) => { details.open = false; });
  });
}



function refreshMultiSelectSummary(details) {
  const total = Number(details.getAttribute("data-ms-total") || "0");
  const allLabel = details.getAttribute("data-ms-all-label") || "Todos";
  const checked = details.querySelectorAll('input[type="checkbox"]:checked').length;
  const selectedSet = new Set([...details.querySelectorAll('input[type="checkbox"]:checked')].map((i) => i.value));
  details.querySelector("summary").textContent = multiSelectSummary(selectedSet, total, allLabel);
}

function wireMultiSelectGroup(id, targetSet, onChange) {
  const details = document.getElementById(id);
  if (!details) return;
  details.querySelectorAll(`input[data-ms-group="${id}"]`).forEach((input) => {
    input.onchange = () => {
      if (input.checked) targetSet.add(input.value);
      else targetSet.delete(input.value);
      refreshMultiSelectSummary(details);
      onChange();
    };
  });
  details.querySelectorAll(`button[data-ms-id="${id}"]`).forEach((button) => {
    button.onclick = () => {
      const action = button.getAttribute("data-ms-action");
      const inputs = details.querySelectorAll(`input[data-ms-group="${id}"]`);
      targetSet.clear();
      if (action === "all") inputs.forEach((input) => { input.checked = true; targetSet.add(input.value); });
      else inputs.forEach((input) => { input.checked = false; });
      refreshMultiSelectSummary(details);
      onChange();
    };
  });
}

function renderFilters() {
  const box = document.getElementById("filtersBar");
  if (!box) return;
  const regions = availableRegions();
  const shifts = availableShifts();
  const analystOptions = availableAnalystOptions();
  const hubOptions = availableHubOptions();
  const signalOptions = [["", "Todos os faróis"], ["red", "Atenção"], ["orange", "Sem início / folga"], ["blue", "Em execução"], ["green", "Em ordem / OK"]];
  box.innerHTML = `
    <div class="filter-field">
      <label>${periodMode === "range" ? "Data inicial" : "Data"}</label>
      <input type="date" id="filterDateInput" value="${escapeHtml(filterDate)}">
    </div>
    <div class="filter-field" ${periodMode === "range" ? "" : "hidden"}>
      <label>Data final</label>
      <input type="date" id="filterDateEndInput" value="${escapeHtml(filterDateEnd)}">
    </div>
    ${renderMultiSelectField("filterAnalystSelect", "Analista", analystOptions.map((a) => [a.id, a.name]), filterAnalyst)}
    ${renderMultiSelectField("filterHubSelect", "Hub", hubOptions.map(([stationId, label]) => [stationId, label]), filterHub)}
    ${renderMultiSelectField("filterRegionSelect", "Regional", regions.map((r) => [r, r]), filterRegion, "Todas")}
    ${renderMultiSelectField("filterShiftSelect", "Turno", shifts.map((s) => [s, s]), filterShift)}
    ${renderMultiSelectField("filterStatusSelect", "Status", STATUS_CHART_DEFS.map((def) => [def.key, def.label]), filterStatus)}
    <div class="filter-field">
      <label>Farol</label>
      <select id="filterSignalSelect">
        ${signalOptions.map(([value, label]) => `<option value="${value}" ${value === filterSignal ? "selected" : ""}>${label}</option>`).join("")}
      </select>
    </div>
    <div class="filter-field grow">
      <label>Buscar</label>
      <input type="text" id="filterSearchInput" placeholder="Analista, Hub, sigla..." value="${escapeHtml(filterSearch)}">
    </div>
    <button type="button" id="filterClearBtn" class="ghost-button">Limpar filtros</button>
  `;
  document.getElementById("filterDateInput").onchange = (event) => {
    filterDate = event.target.value || operationalTodayIso();
    renderOperationView();
  };
  document.getElementById("filterDateEndInput").onchange = (event) => {
    filterDateEnd = event.target.value || "";
    renderOperationView();
  };
  document.getElementById("filterSignalSelect").onchange = (event) => {
    filterSignal = event.target.value || "";
    renderOperationView();
  };
  wireMultiSelectGroup("filterAnalystSelect", filterAnalyst, renderOperationView);
  wireMultiSelectGroup("filterHubSelect", filterHub, renderOperationView);
  wireMultiSelectGroup("filterRegionSelect", filterRegion, renderOperationView);
  wireMultiSelectGroup("filterShiftSelect", filterShift, renderOperationView);
  wireMultiSelectGroup("filterStatusSelect", filterStatus, renderOperationView);
  wireMultiSelectDismiss(box);
  const searchInput = document.getElementById("filterSearchInput");
  let debounceTimer = null;
  searchInput.oninput = (event) => {
    const value = event.target.value;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      filterSearch = value;
      renderOperationView();
    }, 250);
  };
  document.getElementById("filterClearBtn").onclick = () => {
    filterAnalyst = new Set();
    filterHub = new Set();
    filterRegion = new Set();
    filterShift = new Set();
    filterStatus = new Set();
    filterSearch = "";
    filterSignal = "";
    periodMode = "day";
    filterDate = operationalTodayIso();
    filterDateEnd = "";
    updatePeriodButtons();
    renderFilters();
    renderOperationView();
  };
}



function statusBucketDetails(dayAnalysts) {
  const buckets = { finished: [], execution: [], pending: [], not_started: [], late: [], early: [] };
  (dayAnalysts || []).forEach((analyst) => {
    (analyst.items || []).forEach((item) => {
      const key = itemStatusKey(item);
      if (!buckets[key]) return;
      const label = `${item.station_id || item.hub_name || "Hub"} · ${analyst.name || "Analista"}`;
      buckets[key].push(label);
    });
  });
  return buckets;
}

function statusTooltip(def, value, pct, entries) {
  const lines = [`${def.label}: ${value} Hub(s) · ${pct}%`];
  const preview = entries.slice(0, 8);
  preview.forEach((entry) => lines.push(entry));
  if (entries.length > preview.length) lines.push(`+${entries.length - preview.length} mais`);
  return lines.join("\n");
}

function renderCharts(dayMetrics, dayAnalysts = []) {
  const box = document.getElementById("charts");
  if (!box) return;
  const statusTotal = STATUS_CHART_DEFS.reduce((sum, def) => sum + (dayMetrics[def.key] || 0), 0);
  const statusBuckets = statusBucketDetails(dayAnalysts);
  const statusChart = `
    <div class="chart-card card">
      <h3>Hubs por status · ${periodLabel()}<span class="chart-total">${statusTotal} no total</span></h3>
      ${statusTotal ? `<div class="bar-chart">
        ${STATUS_CHART_DEFS.map((def) => {
          const value = dayMetrics[def.key] || 0;
          const pct = statusTotal ? Math.round((value / statusTotal) * 100) : 0;
          const entries = statusBuckets[def.key] || [];
          const tip = statusTooltip(def, value, pct, entries);
          return `<div class="bar-row" tabindex="0" data-tip="${escapeHtml(tip)}">
            <span class="bar-label">${def.label}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${def.color}"></div></div>
            <span class="bar-value">${value}</span>
          </div>`;
        }).join("")}
      </div>` : `<div class="chart-empty">Nenhum Hub no filtro selecionado.</div>`}
    </div>`;

  const regions = regionBreakdown(true).slice(0, 8);
  const regionTotal = regions.reduce((sum, [, value]) => sum + value, 0);
  const regionColors = ["var(--orange)", "var(--run)", "var(--ok)", "var(--warn)", "#8b5cf6", "#0ea5e9", "#ec4899", "#64748b"];
  const regionChart = `
    <div class="chart-card card">
      <h3>Hubs por Regional · ${periodLabel()}<span class="chart-total">${regionTotal} no total</span></h3>
      ${regions.length ? `<div class="bar-chart">
        ${regions.map(([region, value], index) => {
          const pct = regionTotal ? Math.round((value / regionTotal) * 100) : 0;
          return `<div class="bar-row">
            <span class="bar-label">${escapeHtml(region)}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${regionColors[index % regionColors.length]}"></div></div>
            <span class="bar-value">${value}</span>
          </div>`;
        }).join("")}
      </div>` : `<div class="chart-empty">Nenhum Hub no filtro selecionado.</div>`}
    </div>`;

  box.innerHTML = statusChart + regionChart;
}

function renderOperationView() {




  const dayAnalysts = filteredOperationalAnalysts(true);
  const dayMetrics = calcMetrics(dayAnalysts);
  const totalAnalysts = filteredOperationalAnalysts(false);
  const totalMetrics = calcMetrics(totalAnalysts);
  const dateNote = `em ${periodLabel()}`;
  document.getElementById("metrics").innerHTML = [
    ["Analistas", dayMetrics.analysts || 0, "com Hub no filtro atual"],
    [periodMode === "day" ? "Hubs do dia" : "Hubs no período", dayMetrics.assignments || 0, `alocados ${dateNote}`],
    ["Total de Janelas de Roteirização", totalMetrics.assignments || 0, "somando todo o período da escala"],
    ["Finalizados", dayMetrics.finished || 0, "concluídos pelo analista"],
    ["Em execução", dayMetrics.execution || 0, "informados pelo analista"],
    ["Atenção", dayMetrics.attention || 0, "atrasos, início pendente ou ocorrência"],
    ["Sem analista", dayMetrics.without_hub || 0, `para ${fmtDate(operationalTodayIso())} (data operacional)`],
  ].map(([label, value, note]) => `<div class="metric"><span>${label}</span><strong>${value}</strong><span>${note}</span></div>`).join("");
  renderCharts(dayMetrics, dayAnalysts);
  renderAnalysts(dayAnalysts);
  renderOccurrenceCounters();
  updateWelcome(dayAnalysts);
  renderManagerDashboard();
}

function updateWelcome(dayAnalysts = []) {
  const title = document.getElementById("welcomeTitle");
  const text = document.getElementById("welcomeText");
  if (!title || !text) return;
  const firstName = String(payload?.access?.name || "").trim().split(/\s+/)[0] || "Supervisor";
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite";
  const attention = dayAnalysts.filter((analyst) => analyst.signal === "red" || (analyst.not_started || 0) > 0).length;
  const executing = dayAnalysts.reduce((sum, analyst) => sum + (analyst.execution || 0), 0);
  title.textContent = `${greeting}, ${firstName}!`;
  text.textContent = attention
    ? `Há ${attention} analista(s) precisando de atenção. Vamos organizar as prioridades juntos.`
    : executing
      ? `${executing} operação(ões) em execução. O painel está acompanhando tudo com você.`
      : "Sua operação está tranquila neste momento. Eu aviso quando algo precisar da sua atenção.";
}


function occurrenceDay(item) {
  const operation = operations.find((op) => Number(op.assignment_id) === Number(item.assignment_id));
  if (operation?.work_date) return dateOnly(operation.work_date);
  const created = item.created_at ? new Date(item.created_at) : null;
  if (!created || Number.isNaN(created.getTime())) return "";
  if (created.getHours() < 12) created.setDate(created.getDate() - 1);
  return isoOf(created);
}

function occurrenceGroups() {
  const open = occurrences.filter((item) => inPeriod(occurrenceDay(item)));
  const resolved = occurrencesResolved.filter((item) => inPeriod(occurrenceDay(item)));
  const approved = resolved.filter((item) => String(item.decision || item.status || "") === "approved");
  return { open, resolved, approved };
}

function renderOccurrenceCounters() {
  const { open, resolved, approved } = occurrenceGroups();
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = String(value); };
  set("occurrenceTotal", open.length + resolved.length);
  set("occurrencePending", open.length);
  set("occurrenceApproved", approved.length);
}

function render() {
  savePanelPrefs();
  document.getElementById("subtitle").textContent = `Data operacional ${fmtDate(operationalTodayIso())} · ${safe(payload.schedule?.title, "sem escala")}`;
  document.getElementById("generated").textContent = `Atualizado em ${new Date(payload.generated_at || Date.now()).toLocaleString("pt-BR")}`;

  if (!canEditPanel()) {
    showNotice("Visualização de apoio: este acesso permite acompanhar a equipe vinculada, sem alterar Hubs ou ocorrências.");
  }

  renderFilters();
  renderScopeControl();
  document.getElementById("unassignedBadge").textContent = String((payload.unassigned_hubs || []).length);
  document.getElementById("unassignedBtn").onclick = openUnassigned;
  document.getElementById("occurrencesBadge").textContent = String(occurrences.length);
  document.getElementById("occurrencesBtn").onclick = () => openOccurrences("open");
  document.getElementById("previewBtn").onclick = () => openGantt();
  document.getElementById("eventsBtn").onclick = openEvents;
  document.getElementById("substitutesBtn").onclick = openSubstitutesDialog;
  document.getElementById("emergencyBtn").onclick = openEmergencyDialog;
  document.getElementById("linksBtn").onclick = openLinksDialog;
  document.getElementById("glossaryBtn").onclick = openGlossary;
  document.getElementById("helpBtn").onclick = () => openHelp(
    ({ dashboardsView: "dashboard", visibilidadeView: "visibilidade", gerenciamentoView: "gerenciamento" })[document.querySelector(".tab-button.active[data-view]")?.dataset.view] || "operacao");
  document.getElementById("refreshBtn").onclick = refreshPanel;
  renderOperationView();
  renderDashboardLinks();
}

function switchPortalView(viewId) {
  document.querySelectorAll(".portal-view").forEach((view) => view.classList.toggle("active", view.id === viewId));
  document.querySelectorAll(".tab-button").forEach((button) => button.classList.toggle("active", button.dataset.view === viewId));

  if (viewId === "visibilidadeView") setTimeout(rtVisibilidadeOpen, 0);
  if (viewId === "gerenciamentoView") setTimeout(mgmtStart, 0);

}

function renderHubs() {
  const search = document.getElementById("hubSearch");
  const query = String(search?.value || "").trim().toLowerCase();
  const hubs = (payload?.all_hubs || []).filter((hub) => !query || [
    hub.station_id, hub.name, hub.region, hub.subregion, hub.city, hub.state,
    hub.lmh, hub.routing_type, hub.supervisor, hub.notes,
  ].some((value) => String(value || "").toLowerCase().includes(query)));
  document.getElementById("hubsTableBody").innerHTML = hubs.map((hub) => {
    const links = [
      ["SOP", hub.sop_url], ["Plano diário", hub.daily_plan_url], ["Template", hub.template_url],
    ].filter(([, url]) => safeUrl(url));
    return `<tr>
      <td><strong>${escapeHtml(safe(hub.station_id))}</strong>${escapeHtml(safe(hub.name, ""))}<br><small>${escapeHtml(safe(hub.supervisor, "sem supervisor"))}</small></td>
      <td>${escapeHtml(safe(hub.region))}<br><small>${escapeHtml(safe(hub.subregion, ""))}</small></td>
      <td>${escapeHtml(safe(hub.city, ""))}${hub.state ? `/${escapeHtml(hub.state)}` : ""}</td>
      <td>${escapeHtml(safe(hub.lmh, "-"))}</td>
      <td>${escapeHtml(safe(hub.routing_type, "-"))}</td>
      <td>${escapeHtml(safe(hub.window_info, "-"))}</td>
      <td>${escapeHtml(safe(hub.rr_rts_info, "-"))}</td>
      <td>${escapeHtml(safe(hub.motorcycle_info, "-"))}</td>
      <td>${escapeHtml(safe(hub.bulky_info, "-"))}</td>
      <td>${escapeHtml(safe(hub.notes, "-"))}</td>
      <td><div class="table-links">${links.map(([label, url]) => `<a class="mini-link" href="${escapeHtml(url)}" target="_blank" rel="noopener">${label}</a>`).join("") || "-"}</div></td>
    </tr>`;
  }).join("") || `<tr><td colspan="11">Nenhum Hub encontrado neste escopo.</td></tr>`;
  if (search && !search.dataset.bound) {
    search.dataset.bound = "1";
    search.addEventListener("input", renderHubs);
  }
}

function romaneioCsvUrl(rawUrl) {
  const url = safeUrl(rawUrl);
  if (!url) return "";
  const match = url.match(/docs\.google\.com\/spreadsheets\/d\/([^/]+)/i);
  if (!match) return url;
  const gid = new URL(url).searchParams.get("gid") || "0";
  return `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv&gid=${encodeURIComponent(gid)}`;
}

function parseCsv(text) {
  const rows = [];
  let row = [], value = "", quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) { row.push(value); value = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(value); value = "";
      if (row.some((cell) => String(cell).trim())) rows.push(row);
      row = [];
    } else value += char;
  }
  row.push(value);
  if (row.some((cell) => String(cell).trim())) rows.push(row);
  return rows;
}

function configureRomaneio() {
  const source = safeUrl(payload?.resources?.romaneio_url);
  const open = document.getElementById("openRomaneio");
  open.href = source || "#";
  open.style.display = source ? "inline-flex" : "none";
  document.getElementById("reloadRomaneio").onclick = loadRomaneio;
}

async function loadRomaneio() {
  const source = safeUrl(payload?.resources?.romaneio_url);
  const status = document.getElementById("romaneioStatus");
  const shell = document.getElementById("romaneioTableShell");
  if (!source) {
    status.textContent = "Configure o link do romaneio em Configurações > Publicações no aplicativo.";
    status.hidden = false; shell.hidden = true; return;
  }
  status.textContent = "Baixando os dados da aba Dashboard…";
  status.hidden = false; shell.hidden = true;
  try {
    const response = await fetch(romaneioCsvUrl(source), { credentials: "include", cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const rows = parseCsv(await response.text());
    if (!rows.length) throw new Error("A planilha não retornou linhas.");
    const width = Math.max(...rows.map((row) => row.length));
    const headersRow = rows[0].length ? rows[0] : Array.from({ length: width }, (_, index) => `Coluna ${index + 1}`);
    document.getElementById("romaneioHead").innerHTML = `<tr>${headersRow.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("")}</tr>`;
    document.getElementById("romaneioBody").innerHTML = rows.slice(1).map((row) => `<tr>${Array.from({ length: width }, (_, index) => `<td>${escapeHtml(row[index] || "")}</td>`).join("")}</tr>`).join("");
    status.hidden = true; shell.hidden = false;
  } catch (error) {
    console.error("Falha ao carregar romaneio", error);
    status.innerHTML = "Não foi possível montar a tabela. Verifique se a planilha permite acesso pelo link ou use <b>Abrir planilha</b>.";
    status.hidden = false; shell.hidden = true;
  }
}




const MGR_OVERTIME_STATUS = [
  ["awaiting_analyst", "Aguardando o analista"],
  ["identified", "Identificada"],
  ["accepted", "Aceita (falta aprovar)"],
  ["approved", "Aprovada"],
  ["declined", "Recusada"],
];

function mgrPct(part, total) {
  return total ? Math.round((part / total) * 100) : 0;
}

function mgrHours(minutes) {
  const value = Math.max(0, Math.round(Number(minutes) || 0));
  return `${Math.floor(value / 60)}h${String(value % 60).padStart(2, "0")}`;
}

function mgrTile(label, value, note) {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(note)}</span></div>`;
}

function mgrBars(rows, color, emptyText, format = (value) => String(value)) {
  if (!rows.length) return `<div class="chart-empty">${escapeHtml(emptyText)}</div>`;
  const max = Math.max(1, ...rows.map((row) => row[1]));
  return `<div class="bar-chart">${rows.map(([label, value, tip]) => `
    <div class="bar-row"${tip ? ` tabindex="0" data-tip="${escapeHtml(tip)}"` : ""}>
      <span class="bar-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, Math.round((value / max) * 100))}%;background:${color}"></div></div>
      <span class="bar-value">${escapeHtml(format(value))}</span>
    </div>`).join("")}</div>`;
}

function mgrCard(title, total, body) {
  return `<div class="chart-card card mgr-card"><h3>${escapeHtml(title)}${total ? `<span class="chart-total">${escapeHtml(total)}</span>` : ""}</h3>${body}</div>`;
}

function mgrTop(items, keyOf, limit = 8) {
  const counts = new Map();
  items.forEach((item) => {
    const key = keyOf(item);
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, limit);
}

function mgrOvertimeReason(reason) {
  const text = String(reason || "").toLowerCase();
  if (text.includes("trabalho em dsr") || text.includes("informado pelo portal")) return "Trabalho em DSR";
  if (text.includes("cobertura de dsr")) return "Cobertura de DSR";
  if (text.includes("folga dm")) return "Cobertura de Folga DM";
  if (text.includes("compensat")) return "Cobertura de compensatória";
  if (text.includes("cobertura")) return "Outras coberturas";
  return "Manual / outros";
}

function mgrTypeLabel(code) {
  const text = String(code || "").replace(/[_-]+/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Sem tipo";
}

function mgrOperations() {
  const rows = [];
  filteredOperationalAnalysts(true).forEach((analyst) => {
    (analyst.items || []).forEach((item) => {
      const away = absenceCoveringDate(analyst.timeoff, dateOnly(item.work_date)) && !isTerminalOperationStatus(item.operation_status);
      const state = away ? "away" : operationState(item).key;
      rows.push({ ...item, mgrAnalyst: analyst.name || item.analyst_name || "Analista", mgrState: state === "future" ? "pending" : state });
    });
  });
  return rows;
}

function mgrAllowedAnalysts() {
  const list = (payload?.analysts || [])
    .filter((analyst) => selectedSupervisor === "todos" || analyst.supervisor === selectedSupervisor)
    .filter((analyst) => !filterAnalyst.size || filterAnalyst.has(String(analyst.id)));
  return list.length ? new Set(list.map((analyst) => Number(analyst.id))) : null;
}

function renderManagerDashboard() {
  const box = document.getElementById("mgrDashboard");
  if (!box || !payload) return;
  const ops = mgrOperations();
  const count = (key) => ops.filter((item) => item.mgrState === key).length;
  const now = new Date();
  const ended = ops.filter((item) => item.end_datetime && new Date(item.end_datetime) < now && item.mgrState !== "away");
  const closed = ended.filter((item) => isTerminalOperationStatus(item.operation_status));
  const filtersOn = filterRegion.size || filterStatus.size || filterHub.size || filterShift.size || filterAnalyst.size
    || filterSignal || normalizeSearchText(filterSearch);
  const subtitle = document.getElementById("mgrSubtitle");
  if (subtitle) {
    subtitle.textContent = `Período ${periodLabel()} · ${selectedSupervisor === "todos" ? "todos os supervisores do escopo" : selectedSupervisor}`
      + (filtersOn ? " · com os filtros da aba Operação" : "") + ". A data e os filtros ficam na aba Operação.";
  }

  const statusRows = STATUS_CHART_DEFS.map((def) => [def, count(def.key)]);
  const statusTotal = statusRows.reduce((sum, [, value]) => sum + value, 0);
  const away = count("away");
  const resumo = `
    <section class="metrics">
      ${mgrTile("Operações", ops.length, `no período ${periodLabel()}`)}
      ${mgrTile("Finalizadas", count("finished"), `${mgrPct(count("finished"), ops.length)}% do total`)}
      ${mgrTile("Em execução", count("execution") + count("early"), "informadas pelo analista")}
      ${mgrTile("Sem início", count("not_started"), "deu o horário e não iniciou")}
      ${mgrTile("Atrasadas", count("late"), "passaram do fim da janela")}
      ${mgrTile("Canceladas", count("cancelled_route"), "roteirização cancelada")}
      ${mgrTile("Sem operação", count("no_operation"), "hub não rodou")}
      ${away ? mgrTile("A cobrir", away, "analista de folga ou afastado") : ""}
    </section>
    <section class="mgr-grid">
      ${mgrCard("Situação das operações", `${statusTotal} no total`, statusTotal ? `<div class="bar-chart">${statusRows.map(([def, value]) => `
        <div class="bar-row" tabindex="0" data-tip="${escapeHtml(`${def.label}: ${value} (${mgrPct(value, statusTotal)}%)`)}">
          <span class="bar-label">${escapeHtml(def.label)}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${mgrPct(value, statusTotal)}%;background:${def.color}"></div></div>
          <span class="bar-value">${value}</span>
        </div>`).join("")}</div>` : `<div class="chart-empty">Nenhuma operação no filtro selecionado.</div>`)}
    </section>`;

  const delayed = ops.filter((item) => item.mgrState === "late" || item.mgrState === "not_started");
  const tipOf = (list) => `${list.filter((x) => x.mgrState === "late").length} atrasada(s) · ${list.filter((x) => x.mgrState === "not_started").length} sem início`;
  const byAnalyst = mgrTop(delayed, (item) => item.mgrAnalyst).map(([name, value]) => [name, value, tipOf(delayed.filter((x) => x.mgrAnalyst === name))]);
  const byHub = mgrTop(delayed, (item) => item.station_id || item.hub_name).map(([hub, value]) => [hub, value, tipOf(delayed.filter((x) => (x.station_id || x.hub_name) === hub))]);
  const atrasos = `
    <h3 class="mgr-title">Atrasos e pendências</h3>
    <section class="metrics">
      ${mgrTile("Encerradas no sistema", ended.length ? `${mgrPct(closed.length, ended.length)}%` : "—", `${closed.length} de ${ended.length} janelas que já terminaram`)}
      ${mgrTile("Abertas depois da janela", ended.length - closed.length, "precisam de status do analista")}
      ${mgrTile("Atrasos agora", delayed.length, "atrasadas + sem início")}
    </section>
    <section class="mgr-grid">
      ${mgrCard("Analistas com mais atrasos", byAnalyst.length ? `${delayed.length} no total` : "", mgrBars(byAnalyst, "var(--bad)", "Nenhum atraso no período."))}
      ${mgrCard("Hubs com mais atrasos", byHub.length ? `${delayed.length} no total` : "", mgrBars(byHub, "var(--bad)", "Nenhum atraso no período."))}
    </section>
    <p class="mgr-note">Medido pelo status que o analista registra: o painel não guarda a hora exata de início.</p>`;

  const cancelled = ops.filter((item) => item.mgrState === "cancelled_route");
  const reasons = mgrTop(cancelled, (item) => {
    const text = String(item.cancellation_reason || "").trim().replace(/\s+/g, " ");
    return text ? text.charAt(0).toUpperCase() + text.slice(1, 90) : "Sem motivo informado";
  }, 6);
  const recent = [...cancelled].sort((a, b) => String(b.start_datetime || "").localeCompare(String(a.start_datetime || ""))).slice(0, 6);
  const canceladas = `
    <h3 class="mgr-title">Roteirizações canceladas</h3>
    <section class="mgr-grid">
      ${mgrCard("Motivos mais comuns", cancelled.length ? `${cancelled.length} cancelada(s)` : "", mgrBars(reasons, "var(--cancelled)", "Nenhuma roteirização cancelada no período."))}
      ${mgrCard("Últimas canceladas", "", recent.length ? `<ul class="mgr-list">${recent.map((item) => `
        <li><strong>${escapeHtml(item.station_id || item.hub_name || "Hub")} · ${escapeHtml(fmtDate(dateOnly(item.work_date)))}</strong>
        <small>${escapeHtml(item.mgrAnalyst)} — ${escapeHtml(String(item.cancellation_reason || "sem motivo informado").slice(0, 140))}</small></li>`).join("")}</ul>`
        : `<div class="chart-empty">Nenhuma roteirização cancelada no período.</div>`)}
    </section>`;

  const allowed = mgrAllowedAnalysts();
  const extras = overtimeRequests.filter((item) => inPeriod(dateOnly(item.work_date))
    && (!allowed || allowed.has(Number(item.analyst_id))));
  const valid = extras.filter((item) => item.status !== "declined");
  const minutesOf = (list) => list.reduce((sum, item) => sum + (Number(item.minutes) || 0), 0);
  const sumBy = (list, keyOf) => {
    const totals = new Map();
    list.forEach((item) => {
      const key = keyOf(item);
      totals.set(key, (totals.get(key) || 0) + (Number(item.minutes) || 0));
    });
    return [...totals.entries()].sort((a, b) => b[1] - a[1]);
  };
  const approved = extras.filter((item) => item.status === "approved");
  const paid = minutesOf(approved.filter((item) => String(item.payment_mode || "") !== "compensation"));
  const compensated = minutesOf(approved.filter((item) => String(item.payment_mode || "") === "compensation"));
  const statusRowsHe = MGR_OVERTIME_STATUS
    .map(([key, label]) => [label, minutesOf(extras.filter((item) => item.status === key)), `${extras.filter((item) => item.status === key).length} pedido(s)`])
    .filter(([, value]) => value > 0);
  const horas = `
    <h3 class="mgr-title">Horas extras</h3>
    <section class="metrics">
      ${mgrTile("Horas extras", mgrHours(minutesOf(valid)), `${valid.length} pedido(s), sem as recusadas`)}
      ${mgrTile("Aguardando o analista", extras.filter((item) => item.status === "awaiting_analyst").length, "pedidos sem resposta")}
      ${mgrTile("Falta aprovar", extras.filter((item) => item.status === "accepted").length, "aceitas pelo analista")}
      ${mgrTile("Aprovadas", mgrHours(minutesOf(approved)), `pagamento ${mgrHours(paid)} · compensação ${mgrHours(compensated)}`)}
    </section>
    <section class="mgr-grid">
      ${mgrCard("Por situação", "", mgrBars(statusRowsHe, "var(--run)", "Nenhuma hora extra no período.", mgrHours))}
      ${mgrCard("Por motivo", "", mgrBars(sumBy(valid, (item) => mgrOvertimeReason(item.reason)), "var(--run)", "Nenhuma hora extra no período.", mgrHours))}
      ${mgrCard("Por analista", "", mgrBars(sumBy(valid, (item) => item.analyst_name || "Analista").slice(0, 8), "var(--run)", "Nenhuma hora extra no período.", mgrHours))}
    </section>`;

  const { open, resolved, approved: okOccurrences } = occurrenceGroups();
  const handledHours = resolved
    .map((item) => (new Date(item.handled_at) - new Date(item.created_at)) / 3600000)
    .filter((value) => Number.isFinite(value) && value >= 0);
  const avgHandled = handledHours.length ? handledHours.reduce((sum, value) => sum + value, 0) / handledHours.length : null;
  const ageBuckets = [["Até 1 hora", 0, 1], ["1 a 4 horas", 1, 4], ["4 a 24 horas", 4, 24], ["Mais de 24 horas", 24, Infinity]];
  const ageRows = ageBuckets.map(([label, min, max]) => {
    const value = open.filter((item) => {
      const hours = (now - new Date(item.created_at)) / 3600000;
      return Number.isFinite(hours) && hours >= min && hours < max;
    }).length;
    return [label, value];
  }).filter(([, value]) => value > 0);
  const types = mgrTop([...open, ...resolved], (item) => mgrTypeLabel(item.type_code), 6);
  const ocorrencias = `
    <h3 class="mgr-title">Ocorrências</h3>
    <section class="metrics">
      ${mgrTile("Ocorrências", open.length + resolved.length, `no período ${periodLabel()}`)}
      ${mgrTile("Pendentes", open.length, "sem tratativa")}
      ${mgrTile("Tratadas", resolved.length, `${okOccurrences.length} aprovada(s) · ${resolved.length - okOccurrences.length} devolvida(s)`)}
      ${mgrTile("Tempo até a tratativa", avgHandled === null ? "—" : mgrHours(avgHandled * 60), "média das tratadas")}
    </section>
    <section class="mgr-grid">
      ${mgrCard("Pendentes por tempo de espera", open.length ? `${open.length} pendente(s)` : "", mgrBars(ageRows, "var(--warn)", "Nenhuma ocorrência pendente."))}
      ${mgrCard("Tipos mais comuns", "", mgrBars(types, "var(--orange)", "Nenhuma ocorrência no período."))}
    </section>`;

  box.innerHTML = `
    <h3 class="mgr-title">Resumo do período</h3>${resumo}
    ${atrasos}${canceladas}${horas}${ocorrencias}`;
}

function renderDashboardLinks() {
  const resources = payload?.resources || {};
  const dashboards = [
    ["Dashboard do app", resources.app_dashboard_url, "Visão operacional disponibilizada pelo aplicativo."],

  ];
  document.getElementById("dashboardLinks").innerHTML = dashboards.map(([title, rawUrl, description]) => {
    const url = safeUrl(rawUrl);
    return `<article class="dashboard-card"><h3>${escapeHtml(title)}</h3><p class="subtitle">${escapeHtml(description)}</p><div class="toolbar">${url ? `<button data-dashboard-url="${escapeHtml(url)}" data-dashboard-title="${escapeHtml(title)}">Visualizar aqui</button><a class="link-button" href="${escapeHtml(url)}" target="_blank" rel="noopener">Nova aba</a>` : `<small>Link ainda não configurado no aplicativo.</small>`}</div></article>`;
  }).join("");
}

function openDashboardFrame(url, title) {
  const safeDashboardUrl = safeUrl(url);
  if (!safeDashboardUrl) return;
  document.getElementById("dashboardFrameTitle").textContent = title || "Dashboard";
  document.getElementById("dashboardExternal").href = safeDashboardUrl;
  document.getElementById("dashboardFrame").src = safeDashboardUrl;
  document.getElementById("dashboardFrameWrap").hidden = false;
}

function renderScopeControl() {
  const box = document.getElementById("scopeLabel");
  const accessName = payload?.access?.name || "Escopo autorizado";
  if (!roleCanSelectScope()) {
    selectedSupervisor = "todos";
    box.textContent = `Escopo: ${accessName}`;
    box.className = "scope-chip";
    return;
  }
  const supervisors = [...new Set((payload.supervisors || []).filter(Boolean))].sort();
  box.className = "scope-filter";
  box.innerHTML = `
    <span>Escopo</span>
    <select id="scopeSelect">
      <option value="todos">Todos os supervisores liberados</option>
      ${supervisors.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")}
    </select>`;
  const select = document.getElementById("scopeSelect");
  select.value = supervisors.includes(selectedSupervisor) ? selectedSupervisor : "todos";
  select.onchange = () => {
    selectedSupervisor = select.value || "todos";
    renderOperationView();
  };
}













function absenceCoveringDate(timeoff, workDate) {
  if (!Array.isArray(timeoff) || !workDate) return null;
  return timeoff.find((item) => {
    if (String(item.status || "").toLowerCase() === "cancelled") return false;

    if (String(item.analyst_decision || "").toLowerCase() === "overtime"
      || String(item.status || "").toLowerCase() === "working_overtime") return false;
    const start = dateOnly(item.start_datetime || item.work_date);
    const end = dateOnly(item.end_datetime || item.start_datetime || item.work_date);
    return start && end && start <= workDate && workDate <= end;
  }) || null;
}

function buildOperationalAnalysts() {
  if (!operations.length) {
    return (payload.analysts || []).filter((analyst) => (analyst.assignments || 0) > 0);
  }

  const meta = new Map((payload.analysts || []).map((analyst) => [Number(analyst.id), analyst]));
  const groups = new Map();
  operations.forEach((operation) => {
    if (!operation.analyst_id) return;
    const id = Number(operation.analyst_id);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(operation);
  });

  return [...groups.entries()].map(([id, items]) => {
    const base = meta.get(id) || {};
    const counts = { pending: 0, execution: 0, finished: 0, late: 0, not_started: 0, future: 0, cancelled_route: 0, no_operation: 0, away: 0 };
    let awayLabel = "";
    items.forEach((item) => {
      const absence = absenceCoveringDate(base.timeoff, dateOnly(item.work_date));
      if (absence && !isTerminalOperationStatus(item.operation_status)) {
        counts.away += 1;
        awayLabel = absence.absence_type || awayLabel;
        return;
      }
      const state = operationState(item);
      counts[item.operation_status] = (counts[item.operation_status] || 0) + 1;
      counts[state.key] = (counts[state.key] || 0) + 1;
    });
    const hasOpenOccurrence = occurrences.some((item) => Number(item.analyst_id) === id);
    const allAway = counts.away > 0 && counts.away === items.length;
    const signal = hasOpenOccurrence || counts.late ? "red" :
      (allAway ? "orange" : (counts.not_started ? "orange" : (counts.execution ? "blue" : "green")));
    const statusLabel = hasOpenOccurrence ? "ocorrência aberta" :
      counts.late ? "atrasado" :
      allAway ? `de folga${awayLabel ? ` (${awayLabel})` : ""}` :
      counts.not_started ? "deu horário e não iniciou" :
      counts.execution ? "em execução" : "em ordem";
    const next = items
      .filter((item) => !isTerminalOperationStatus(item.operation_status) && !absenceCoveringDate(base.timeoff, dateOnly(item.work_date)))
      .sort((a, b) => String(a.start_datetime || "").localeCompare(String(b.start_datetime || "")))[0] || items[0];
    return {
      id,
      name: base.name || items[0].analyst_name || `Analista ${id}`,
      portal_token: base.portal_token || items[0].portal_token || "",
      supervisor: base.supervisor || "Não vinculado",
      shift: base.shift || "",
      is_relief: Boolean(base.is_relief),
      assignments: items.length,
      pending: counts.pending || 0,
      execution: counts.execution || 0,
      finished: counts.finished || 0,
      late: counts.late || 0,
      not_started: counts.not_started || 0,
      cancelled_route: counts.cancelled_route || 0,
      no_operation: counts.no_operation || 0,
      away: counts.away || 0,
      signal,
      status_label: statusLabel,
      next_hub: `${fmtDate(next?.work_date)} ${fmtTime(next?.start_datetime)} - ${next?.station_id || ""} ${next?.hub_name || ""}`.trim(),
      items,



      timeoff: base.timeoff || [],
    };
  });
}

function renderAnalysts(list = buildOperationalAnalysts()) {
  const analysts = list.filter((analyst) => selectedSupervisor === "todos" || analyst.supervisor === selectedSupervisor);
  document.getElementById("analysts").innerHTML = analysts.map((analyst) => `
    <article class="card analyst ${analyst.signal}" data-analyst-id="${analyst.id}">
      <div class="card-head">
        <div><div class="name">${escapeHtml(safe(analyst.name))}</div><div class="meta">${escapeHtml(safe(analyst.supervisor, "sem supervisor"))} - ${escapeHtml(safe(analyst.shift))}</div></div>
        <span class="signal ${analyst.signal}" title="${escapeHtml(safe(analyst.status_label))}"></span>
      </div>
      <div class="tags">
        <span class="tag">${analyst.assignments || 0} hubs</span>
        <span class="tag">${analyst.pending || 0} pend.</span>
        <span class="tag">${analyst.execution || 0} exec.</span>
        <span class="tag">${analyst.finished || 0} fin.</span>
        ${analyst.late ? `<span class="tag danger">${analyst.late} atraso</span>` : ""}
        ${analyst.not_started ? `<span class="tag warn">${analyst.not_started} sem início</span>` : ""}
        ${analyst.is_relief ? `<span class="tag relief">Folguista</span>` : ""}
      </div>
      <div class="hub"><b>Próximo hub:</b><br>${escapeHtml(safe(analyst.next_hub, "sem hub"))}</div>
      <p class="status ${analyst.signal}">${escapeHtml(safe(analyst.status_label))}</p>
      ${analyst.portal_token
        ? `<button type="button" class="chip open-analyst-portal" data-portal-token="${escapeHtml(analyst.portal_token)}" title="Abrir a escala deste analista no portal local">↗ Portal do analista</button>`
        : ""}
    </article>
  `).join("") || `<div class="empty-card">Nenhum analista com Hub no período e filtros selecionados.</div>`;
  document.querySelectorAll(".open-analyst-portal").forEach((btn) => {
    btn.onclick = (event) => {


      event.stopPropagation();
      openAnalystPortal(btn.dataset.portalToken);
    };
  });
}

function openAnalystPortal(token) {
  if (!token) return;
  const url = `${localPortalBaseUrl}/portal/${token}`;




  window.open(url, "_blank", "noopener");
}

function groupedByDate(items) {
  return [...items].sort((a, b) => String(a.start_datetime || "").localeCompare(String(b.start_datetime || "")))
    .reduce((groups, item) => {
      const key = dateOnly(item.work_date || item.start_datetime) || "sem-data";
      if (!groups[key]) groups[key] = [];
      groups[key].push(item);
      return groups;
    }, {});
}


let liveTimeoffUntil = "";
async function loadLiveTimeoff(preferCache = false) {
  const identity = currentSupervisorToken();
  try {
    const response = await rtReadCache.request("timeoff", () => fetchWithTimeout(api("rpc/rt_supervisor_live_timeoff"), {
      method: "POST", headers, body: JSON.stringify({ p_token: identity }),
    }), preferCache, value => Array.isArray(value?.absences));
    if (identity !== currentSupervisorToken()) return false;
    if (!response.ok) return false;
    const live = await response.json();
    if (!live || !Array.isArray(live.absences) || !payload) return false;
    liveTimeoffUntil = String(live.last_day || "");
    const firstDay = String(live.first_day || "");
    const byToken = new Map();
    live.absences.forEach((item) => {
      const list = byToken.get(item.portal_token) || [];
      list.push(item);
      byToken.set(item.portal_token, list);
    });
    (payload.analysts || []).forEach((analyst) => {
      if (!analyst.portal_token) return;
      const older = (analyst.timeoff || []).filter((item) => dateOnly(item.start_datetime) < firstDay);
      analyst.timeoff = [...older, ...(byToken.get(analyst.portal_token) || [])];
    });
    return true;
  } catch (_) {
    return false; // sem a 061 no servidor: segue com a lista do painel salvo
  }
}

const OVERTIME_STATUS_LABELS = {
  pending: "Aguardando resposta", offered: "Aguardando resposta", accepted: "Aceita",
  declined: "Recusada", approved: "Aprovada", rejected: "Recusada pelo supervisor", cancelled: "Cancelada",
};
function analystSheet(analyst) {
  const base = (payload.analysts || []).find((item) => Number(item.id) === Number(analyst.id)) || analyst;
  const today = isoOf(new Date());
  const limitDate = new Date();
  limitDate.setDate(limitDate.getDate() + 14);
  const limit = liveTimeoffUntil || isoOf(limitDate);
  const upcomingOff = (base.timeoff || analyst.timeoff || [])
    .filter((item) => String(item.status || "").toLowerCase() !== "cancelled")
    .filter((item) => dateOnly(item.end_datetime || item.start_datetime) >= today && dateOnly(item.start_datetime) <= limit)
    .sort((a, b) => String(a.start_datetime || "").localeCompare(String(b.start_datetime || "")))
    .slice(0, 12);
  const extras = overtimeRequests
    .filter((item) => Number(item.analyst_id) === Number(analyst.id) && dateOnly(item.work_date) >= today)
    .sort((a, b) => String(a.work_date || "").localeCompare(String(b.work_date || "")))
    .slice(0, 6);
  const offList = upcomingOff.length
    ? `<ul>${upcomingOff.map((item) => {
        const start = dateOnly(item.start_datetime);
        const end = dateOnly(item.end_datetime || item.start_datetime);
        const period = end && end !== start ? `${fmtDate(start)} a ${fmtDate(end)}` : fmtDate(start);
        return `<li><b>${escapeHtml(safe(item.absence_type, "Folga"))}</b> · ${period}</li>`;
      }).join("")}</ul>`
    : `<p class="muted">Nenhuma até ${fmtDate(limit)}.</p>`;
  const extraList = extras.length
    ? `<ul>${extras.map((item) => `<li>${fmtDate(item.work_date)} · ${escapeHtml(OVERTIME_STATUS_LABELS[item.status] || safe(item.status, "—"))}</li>`).join("")}</ul>`
    : `<p class="muted">Nenhuma marcada daqui para frente.</p>`;
  const contact = base.email
    ? `<a href="mailto:${escapeHtml(base.email)}">${escapeHtml(base.email)}</a>`
    : `<p class="muted">Sem e-mail no painel.</p>`;
  return `
    <div class="analyst-sheet">
      <div><h3>Próximas folgas (até ${fmtDate(limit)})</h3>${offList}</div>
      <div><h3>Horas extras</h3>${extraList}</div>
      <div><h3>Contato</h3>${contact}${base.staff_id ? `<p class="muted">Staff ID ${escapeHtml(base.staff_id)}</p>` : ""}</div>
    </div>`;
}




let detailsOnlyAvailable = true;

function transferCandidates(sourceAnalystId, assignment, analysts, ops, onlyAvailable) {
  const start = new Date(assignment.start_datetime || 0);
  const end = new Date(assignment.end_datetime || 0);
  const workDate = dateOnly(assignment.work_date);
  return (analysts || [])
    .filter((item) => Number(item.id) !== Number(sourceAnalystId))
    .map((item) => {
      const off = absenceCoveringDate(item.timeoff, workDate);
      const busy = (ops || []).some((operation) => {
        if (Number(operation.analyst_id) !== Number(item.id) || isTerminalOperationStatus(operation.operation_status)) return false;
        const candidateStart = new Date(operation.start_datetime || 0);
        const candidateEnd = new Date(operation.end_datetime || 0);
        return candidateStart < end && candidateEnd > start;
      });
      const reason = off ? `de ${String(off.absence_type || "folga").toLowerCase() === "folga" ? "folga" : safe(off.absence_type, "folga")}` : busy ? "ocupado neste horário" : "";
      return { analyst: item, available: !off && !busy, reason };
    })
    .filter((candidate) => !onlyAvailable || candidate.available)
    .sort((a, b) => Number(b.available) - Number(a.available)
      || Number(Boolean(b.analyst.is_relief)) - Number(Boolean(a.analyst.is_relief))
      || String(a.analyst.name).localeCompare(String(b.analyst.name), "pt-BR"));
}

function openDetails(id) {






  const analyst = filteredOperationalAnalysts(true).find((item) => Number(item.id) === Number(id));
  if (!analyst) return;

  const candidateOptions = (assignment) => {




















    const candidates = transferCandidates(analyst.id, assignment, payload.analysts, operations, detailsOnlyAvailable);
    return {
      html: candidates.map(({ analyst: item, reason }) => `<option value="${item.id}">${item.is_relief ? "★ FOLGUISTA · " : ""}${escapeHtml(safe(item.name))} - ${escapeHtml(safe(item.shift))}${reason ? ` · ${escapeHtml(reason)}` : ""}</option>`).join(""),
      total: candidates.length,
      free: candidates.filter((item) => item.available).length,
    };
  };

  const actionColumn = (item, assignmentId) => {
    const state = operationState(item);
    if (isTerminalOperationStatus(state.key) || isTerminalOperationStatus(item.operation_status)) {
      return `<small class="locked">Finalizado - bloqueado para transferência</small>`;
    }
    if (!canEditPanel()) return `<small>Somente visualização</small>`;
    const options = candidateOptions(item);
    const free = options.free;
    const hint = detailsOnlyAvailable
      ? (free
        ? `${free} pessoa(s) livre(s) neste horário. Folguistas aparecem primeiro.`
        : "Ninguém do time está livre neste horário. Desmarque “Só os disponíveis” para ver todo o time.")
      : `${options.total} pessoa(s) do time · ${free} livre(s) neste horário (aparecem primeiro).`;
    return `
      <div class="row-actions">
        <div class="toolbar">
          <select id="move-${assignmentId}"><option value="">${detailsOnlyAvailable ? "Selecione alguém livre nesse horário" : "Selecione quem vai assumir"}</option>${options.html}</select>
          <button data-action="move" data-id="${assignmentId}">Transferir</button>
        </div>
        <small class="smart-hint">${hint}</small>
      </div>`;
  };

  const groups = groupedByDate(analyst.items || []);
  document.getElementById("detailsBody").innerHTML = `
    <div class="modal-header">
      <div><h2>${escapeHtml(safe(analyst.name))}</h2><p class="subtitle">${escapeHtml(safe(analyst.supervisor))} - ${escapeHtml(safe(analyst.shift))}</p></div>
      <button data-close="details">Fechar</button>
    </div>
    ${analystSheet(analyst)}
    ${canEditPanel() ? `<label class="details-only-free"><input type="checkbox" id="details-only-free"${detailsOnlyAvailable ? " checked" : ""}> Só os disponíveis (livres no horário e sem folga) na lista de quem assume</label>` : ""}
    <div class="list">
      ${Object.entries(groups).map(([date, rows]) => `
        <div class="date-group">
          <h3>${fmtDate(date)}</h3>
          ${rows.map((item) => {
            const assignmentId = item.assignment_id || item.id;
            const state = operationState(item);
            return `
              <div class="row operation-row ${state.signal}">
                <div>
                  <b>${escapeHtml(safe(item.station_id))}</b>
                  <span class="pill ${state.signal}">${escapeHtml(state.label)}</span><br>
                  <small>${escapeHtml(safe(item.hub_name))} - ${fmtTime(item.start_datetime)} até ${fmtTime(item.end_datetime)}</small>
                  ${item.notes ? `<p>${escapeHtml(item.notes)}</p>` : ""}
                  ${item.operation_status === "cancelled_route" && item.cancellation_reason ? `<p class="cancellation-reason"><b>Motivo do cancelamento:</b> ${escapeHtml(item.cancellation_reason)}</p>` : ""}
                </div>
                ${actionColumn(item, assignmentId)}
              </div>`;
          }).join("")}
        </div>`).join("") || "Nenhum Hub publicado para este analista."}
    </div>`;
  document.getElementById("details-only-free")?.addEventListener("change", (event) => {
    detailsOnlyAvailable = Boolean(event.target.checked);
    openDetails(id);
  });
  const dialog = document.getElementById("details");
  if (!dialog.open) dialog.showModal();
}










function assignableAnalystOptions(workDate) {
  return (payload.analysts || [])
    .filter((item) => !absenceCoveringDate(item.timeoff, workDate))
    .sort((a, b) => Number(Boolean(b.is_relief)) - Number(Boolean(a.is_relief)) || String(a.name || "").localeCompare(String(b.name || ""), "pt-BR"))
    .map((item) => `<option value="${item.id}">${item.is_relief ? "★ FOLGUISTA · " : ""}${escapeHtml(safe(item.name))} - ${escapeHtml(safe(item.shift))}</option>`)
    .join("");
}


function unassignedHubTitle(hub) {
  const station = String(hub.station_id || "").trim();
  const known = (payload?.all_hubs || []).find((item) => String(item.station_id || "") === station) || {};
  const name = String(hub.name || hub.hub_name || known.name || known.hub_name || "").trim();
  return [station || "Hub", name].filter(Boolean).join(" · ");
}

function openUnassigned() {
  const hubs = payload.unassigned_hubs || [];
  document.getElementById("unassignedBody").innerHTML = `
    <div class="modal-header">
      <div><h2>Hubs sem analista</h2><p class="subtitle">Atribua direto por aqui ou ajuste no app desktop na próxima publicação.</p></div>
      <button data-close="unassigned">Fechar</button>
    </div>
    <div class="list">
      ${hubs.map((hub) => {
        const cycles = hub.cycles || [];
        const cycleField = cycles.length > 1
          ? `<select id="assign-cycle-${hub.id}">${cycles.map((c) => `<option value="${c.id}">${escapeHtml(c.cycle_code || "Ciclo")} · ${escapeHtml(c.start_time)}-${escapeHtml(c.end_time)}</option>`).join("")}</select>`
          : "";



        const dateInfo = hub.work_date ? `<small class="hub-meta">${escapeHtml(fmtDate(hub.work_date))}</small>` : "";
        const cyclesSummary = cycles.length
          ? `<div class="hub-cycles-summary">${cycles.map((c) => {
              const fixedNames = (c.fixed_analysts || []).filter(Boolean);
              const fixedLabel = fixedNames.length
                ? `Analista fixo: ${fixedNames.map((name) => escapeHtml(name)).join(", ")}`
                : "Sem analista fixo cadastrado neste ciclo";
              return `<small class="hub-meta">${escapeHtml(c.cycle_code || "Ciclo")} · ${escapeHtml(c.start_time)}-${escapeHtml(c.end_time)} — ${fixedLabel}</small>`;
            }).join("")}</div>`
          : "";
        if (!canEditPanel()) {
          return `<div class="row">
            <div><b>${escapeHtml(unassignedHubTitle(hub))}</b><br><small>${escapeHtml(safe(hub.region, "Sem regional"))}</small>${dateInfo}${cyclesSummary}</div>
          </div>`;
        }
        if (!cycles.length) {
          return `<div class="row">
            <div><b>${escapeHtml(unassignedHubTitle(hub))}</b><br><small>${escapeHtml(safe(hub.region, "Sem regional"))}</small>${dateInfo}</div>
            <small class="locked">Sem ciclo operando nesta data - ajuste no app desktop.</small>
          </div>`;
        }
        return `
        <div class="row">
          <div><b>${escapeHtml(unassignedHubTitle(hub))}</b><br><small>${escapeHtml(safe(hub.region, "Sem regional"))}${cycles.length === 1 ? ` · ${escapeHtml(cycles[0].start_time)}-${escapeHtml(cycles[0].end_time)}` : ""}</small>${dateInfo}${cyclesSummary}</div>
          <div class="toolbar row-actions">
            ${cycleField}
            <select id="assign-analyst-${hub.id}"><option value="">Selecione o analista</option>${assignableAnalystOptions(dateOnly(hub.work_date))}</select>
            <button data-action="assign-hub" data-id="${hub.id}" data-cycle-single="${cycles.length === 1 ? cycles[0].id : ""}">Atribuir</button>
          </div>
        </div>`;
      }).join("") || "Nenhum Hub sem analista."}
    </div>`;
  document.getElementById("unassigned").showModal();
}

async function assignHub(hubId) {
  if (!canEditPanel()) return;
  const hub = (payload.unassigned_hubs || []).find((item) => Number(item.id) === Number(hubId));
  if (!hub) return;
  const analystSelect = document.getElementById(`assign-analyst-${hubId}`);
  const targetAnalystId = Number(analystSelect?.value || 0);
  if (!targetAnalystId) { showError("Selecione um analista para atribuir o Hub."); return; }
  const target = (payload.analysts || []).find((item) => Number(item.id) === targetAnalystId) || {};
  const cycleSelect = document.getElementById(`assign-cycle-${hubId}`);
  const cycleId = Number(cycleSelect?.value || document.querySelector(`button[data-action="assign-hub"][data-id="${hubId}"]`)?.dataset.cycleSingle || 0);
  const cycle = (hub.cycles || []).find((item) => Number(item.id) === cycleId);
  if (!cycle) { showError("Selecione o ciclo/janela do Hub."); return; }

  try {
    const response = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/rt_supervisor_assign_hub`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        p_token: currentSupervisorToken(),
        p_hub_id: hub.id,
        p_station_id: hub.station_id || "",
        p_hub_name: hub.hub_name || hub.name || "",
        p_cycle_id: cycle.id,
        p_schedule_id: payload.schedule?.id || null,
        p_work_date: payload.work_date,
        p_start_time: cycle.start_time,
        p_end_time: cycle.end_time,
        p_target_analyst_id: target.id,
        p_target_analyst_name: target.name || "",
        p_target_portal_token: target.portal_token || "",
      }),
    });
    if (!response.ok) throw new Error("assign");
    const ok = await response.json();
    if (!ok) throw new Error("assign");
    showNotice("Atribuição registrada - o app desktop aplica em instantes e o Hub sai desta lista na próxima publicação.");
    document.getElementById("unassigned")?.close();
  } catch (error) {
    console.error("Falha ao atribuir Hub", error);
    showError("Não consegui registrar a atribuição. Tente novamente.");
  }
}






function openEmergencyDialog() {
  const hubOptions = (payload.all_hubs || [])
    .slice()
    .sort((a, b) => String(a.station_id || "").localeCompare(String(b.station_id || ""), "pt-BR"))
    .map((hub) => `<option value="${hub.id}">${escapeHtml(safe(hub.station_id))} - ${escapeHtml(safe(hub.name))}</option>`)
    .join("");
  document.getElementById("emergencyBody").innerHTML = `
    <div class="modal-header">
      <div><h2>Cadastro emergencial</h2><p class="subtitle">Só pra contingência: o cadastro feito aqui vale só por hoje e some
        dos seletores 12h depois - o que já rodou no dia fica registrado normalmente. Cadastro permanente é só pelo app desktop.</p></div>
      <button data-close="emergencyDialog">Fechar</button>
    </div>
    <div class="event-form">
      <h3>Hub emergencial</h3>
      <label>Hub <select id="emergencyHubMode">
        <option value="existing">Hub já cadastrado - só falta o ciclo/horário de hoje</option>
        <option value="new">Hub novo (não existe no cadastro)</option>
      </select></label>
      <label id="emergencyHubExistingField">Selecione o Hub <select id="emergencyHubExisting"><option value="">Selecione...</option>${hubOptions}</select></label>
      <label id="emergencyHubNewField1" hidden>Código operacional (Station-ID) <input id="emergencyHubStationId" placeholder="Ex.: LSP-103"></label>
      <label id="emergencyHubNewField2" hidden>Nome do Hub (opcional) <input id="emergencyHubName" placeholder="Ex.: Hub São Paulo 103"></label>
      <label>Início do ciclo de hoje <input id="emergencyHubStart" type="time"></label>
      <label>Fim do ciclo de hoje <input id="emergencyHubEnd" type="time"></label>
      <button type="button" data-action="save-emergency-hub">Cadastrar Hub emergencial</button>
    </div>
    <div class="event-form">
      <h3>Analista emergencial</h3>
      <label>Nome <input id="emergencyAnalystName" placeholder="Nome completo"></label>
      <label>Staff ID (opcional) <input id="emergencyAnalystStaffId"></label>
      <label>Início do turno <input id="emergencyAnalystStart" type="time" value="21:00"></label>
      <label>Fim do turno <input id="emergencyAnalystEnd" type="time" value="04:32"></label>
      <button type="button" data-action="save-emergency-analyst">Cadastrar analista emergencial</button>
    </div>`;
  document.getElementById("emergencyHubMode").onchange = (event) => {
    const isNew = event.target.value === "new";
    document.getElementById("emergencyHubExistingField").hidden = isNew;
    document.getElementById("emergencyHubNewField1").hidden = !isNew;
    document.getElementById("emergencyHubNewField2").hidden = !isNew;
  };
  document.getElementById("emergencyDialog").showModal();
}

async function saveEmergencyHub() {
  if (!canEditPanel()) return;
  const isNew = document.getElementById("emergencyHubMode")?.value === "new";
  const startTime = document.getElementById("emergencyHubStart")?.value || "";
  const endTime = document.getElementById("emergencyHubEnd")?.value || "";
  if (!startTime || !endTime) { showError("Informe o horário do ciclo emergencial."); return; }
  let existingHubId = null;
  let stationId = "";
  let hubName = "";
  if (isNew) {
    stationId = (document.getElementById("emergencyHubStationId")?.value || "").trim();
    hubName = (document.getElementById("emergencyHubName")?.value || "").trim();
    if (!stationId) { showError("Informe o código operacional do Hub novo."); return; }
  } else {
    existingHubId = Number(document.getElementById("emergencyHubExisting")?.value || 0);
    if (!existingHubId) { showError("Selecione o Hub existente."); return; }
  }
  try {
    const response = await fetch(api("rpc/rt_supervisor_emergency_hub"), {
      method: "POST",
      headers,
      body: JSON.stringify({
        p_token: currentSupervisorToken(),
        p_existing_hub_id: existingHubId,
        p_station_id: stationId,
        p_hub_name: hubName,
        p_cycle_code: "EMERGENCIAL",
        p_start_time: startTime,
        p_end_time: endTime,
        p_supervisor_user_id: payload.scope?.supervisor_user_id || null,
      }),
    });
    if (!response.ok) throw new Error("emergency-hub");
    const ok = await response.json();
    if (!ok) throw new Error("emergency-hub");
    showNotice("Hub emergencial registrado - o app desktop aplica em instantes e o Hub passa a valer só por hoje (some sozinho em 12h).");
    document.getElementById("emergencyDialog")?.close();
  } catch (error) {
    console.error("Falha ao cadastrar Hub emergencial", error);
    showError("Não consegui cadastrar o Hub emergencial. Tente novamente.");
  }
}

async function saveEmergencyAnalyst() {
  if (!canEditPanel()) return;
  const name = (document.getElementById("emergencyAnalystName")?.value || "").trim();
  if (!name) { showError("Informe o nome do analista emergencial."); return; }
  const staffId = (document.getElementById("emergencyAnalystStaffId")?.value || "").trim();
  const shiftStart = document.getElementById("emergencyAnalystStart")?.value || "21:00";
  const shiftEnd = document.getElementById("emergencyAnalystEnd")?.value || "04:32";
  try {
    const response = await fetch(api("rpc/rt_supervisor_emergency_analyst"), {
      method: "POST",
      headers,
      body: JSON.stringify({
        p_token: currentSupervisorToken(),
        p_name: name,
        p_staff_id: staffId || null,
        p_shift_start: shiftStart,
        p_shift_end: shiftEnd,
        p_supervisor_user_id: payload.scope?.supervisor_user_id || null,
      }),
    });
    if (!response.ok) throw new Error("emergency-analyst");
    const ok = await response.json();
    if (!ok) throw new Error("emergency-analyst");
    showNotice("Analista emergencial registrado - o app desktop aplica em instantes e o analista já recebe acesso ao Portal (some sozinho em 12h).");
    document.getElementById("emergencyDialog")?.close();
  } catch (error) {
    console.error("Falha ao cadastrar analista emergencial", error);
    showError("Não consegui cadastrar o analista emergencial. Tente novamente.");
  }
}





let usefulLinksCache = [];











function usefulLinksRequiresScopePick() {
  const role = String(payload?.access?.role || "").toLowerCase();
  return ["admin", "gerente", "coordenador"].includes(role) && selectedSupervisor === "todos";
}

async function fetchUsefulLinks() {
  const response = await fetch(api("rpc/rt_supervisor_list_useful_links"), {
    method: "POST",
    headers,
    body: JSON.stringify({
      p_token: currentSupervisorToken(),
      p_supervisor_name: selectedSupervisor !== "todos" ? selectedSupervisor : null,
    }),
  });
  if (!response.ok) throw new Error("useful-links");
  return response.json();
}

function renderUsefulLinksBody() {
  if (usefulLinksRequiresScopePick()) {
    document.getElementById("linksBody").innerHTML = `
      <div class="modal-header">
        <div><h2>Links úteis</h2><p class="subtitle">Os links são por time. Selecione um supervisor específico no filtro
          "ESCOPO", no topo do painel, e abra "Links úteis" de novo pra gerenciar a lista daquele time.</p></div>
        <button data-close="linksDialog">Fechar</button>
      </div>`;
    return;
  }
  const groups = [];
  usefulLinksCache.forEach((link) => {
    const category = String(link.category || "Geral").trim() || "Geral";
    let group = groups.find((g) => g.category === category);
    if (!group) { group = { category, items: [] }; groups.push(group); }
    group.items.push(link);
  });
  const editable = canEditPanel();
  const teamLabel = selectedSupervisor !== "todos" ? selectedSupervisor : (payload?.access?.name || "seu time");
  document.getElementById("linksBody").innerHTML = `
    <div class="modal-header">
      <div><h2>Links úteis - ${escapeHtml(teamLabel)}</h2><p class="subtitle">Cadastrados aqui aparecem, agrupados por
        categoria, na aba "Links úteis" do portal deste time.</p></div>
      <button data-close="linksDialog">Fechar</button>
    </div>
    ${editable ? `
    <div class="event-form">
      <h3>Novo link</h3>
      <label>Categoria <select id="linkCategory">
        <option value="">Selecione...</option>
        <option value="DOCUMENTAÇÃO">DOCUMENTAÇÃO</option>
        <option value="FERRAMENTAS">FERRAMENTAS</option>
        <option value="CONTATOS">CONTATOS</option>
        <option value="INFOS DO TIME">INFOS DO TIME</option>
        <option value="SHOPEE (Links Internos)">SHOPEE (Links Internos)</option>
      </select></label>
      <label>Título <input id="linkTitle" placeholder="Ex.: Manual de roteirização"></label>
      <label>URL <input id="linkUrl" type="url" placeholder="https://..."></label>
      <button type="button" data-action="save-useful-link">Adicionar link</button>
    </div>` : ""}
    <div class="list">
      ${groups.map((group) => `
        <div class="date-group">
          <h3>${escapeHtml(group.category)}</h3>
          ${group.items.map((link) => `
            <div class="row occurrence-row">
              <div><b>${escapeHtml(safe(link.title))}</b><br><small><a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.url)}</a></small></div>
              ${editable ? `<button data-action="delete-useful-link" data-id="${link.id}">Excluir</button>` : ""}
            </div>`).join("")}
        </div>`).join("") || "Nenhum link cadastrado ainda."}
    </div>`;
}

async function openLinksDialog() {
  document.getElementById("linksBody").innerHTML = "Carregando...";
  document.getElementById("linksDialog").showModal();
  if (usefulLinksRequiresScopePick()) { renderUsefulLinksBody(); return; }
  try {
    usefulLinksCache = await fetchUsefulLinks();
    renderUsefulLinksBody();
  } catch (error) {
    console.error("Falha ao carregar links úteis", error);
    document.getElementById("linksBody").innerHTML = `
      <div class="modal-header"><h2>Links úteis</h2><button data-close="linksDialog">Fechar</button></div>
      <p>Não consegui carregar os links agora. Feche e tente de novo.</p>`;
  }
}

async function saveUsefulLink() {
  if (!canEditPanel()) return;
  const category = (document.getElementById("linkCategory")?.value || "").trim();
  const title = (document.getElementById("linkTitle")?.value || "").trim();
  const url = (document.getElementById("linkUrl")?.value || "").trim();
  if (!category || !title || !url) { showError("Preencha categoria, título e link."); return; }
  try {
    const response = await fetch(api("rpc/rt_supervisor_save_useful_link"), {
      method: "POST",
      headers,
      body: JSON.stringify({
        p_token: currentSupervisorToken(), p_id: null, p_category: category, p_title: title, p_url: url, p_sort_order: 0,
        p_supervisor_name: selectedSupervisor !== "todos" ? selectedSupervisor : null,
      }),
    });
    if (!response.ok) {
      const problem = await response.json().catch(() => null);
      throw new Error(problem?.message || "Não foi possível salvar o link.");
    }
    usefulLinksCache = await fetchUsefulLinks();
    renderUsefulLinksBody();
    showNotice("Link salvo. Já aparece no portal do seu time.");
  } catch (error) {
    console.error("Falha ao salvar link útil", error);
    showError(error.message || "Não consegui salvar o link agora.");
  }
}

async function deleteUsefulLink(id) {
  if (!canEditPanel()) return;
  try {
    const response = await fetch(api("rpc/rt_supervisor_delete_useful_link"), {
      method: "POST", headers, body: JSON.stringify({
        p_token: currentSupervisorToken(), p_id: Number(id),
        p_supervisor_name: selectedSupervisor !== "todos" ? selectedSupervisor : null,
      }),
    });
    if (!response.ok) throw new Error("delete-useful-link");
    usefulLinksCache = usefulLinksCache.filter((link) => Number(link.id) !== Number(id));
    renderUsefulLinksBody();
  } catch (error) {
    console.error("Falha ao excluir link útil", error);
    showError("Não consegui excluir o link agora.");
  }
}


function occurrenceHubLabel(item) {
  const assignmentId = Number(item.assignment_id);
  if (!assignmentId) return "";
  const operation = operations.find((op) => Number(op.assignment_id) === assignmentId)
    || (payload?.analysts || []).flatMap((analyst) => analyst.items || [])
      .find((op) => Number(op.id) === assignmentId);
  if (!operation) return "";
  return [operation.station_id, operation.hub_name].filter(Boolean).join(" · ");
}

function openOccurrences(filter = "open") {
  const { open, resolved, approved } = occurrenceGroups();
  const lists = {
    open: [occurrences, "Ocorrências abertas", "Registre a tratativa e conclua como aprovada ou reprovada."],
    pending: [open, "Ocorrências pendentes", `Abertas em ${periodLabel()}.`],
    all: [[...open, ...resolved], "Todas as ocorrências", `Abertas e resolvidas em ${periodLabel()}.`],
    approved: [approved, "Ocorrências OK", `Aprovadas em ${periodLabel()}.`],
  };
  const [rows, title, note] = lists[filter] || lists.open;
  document.getElementById("occurrencesBody").innerHTML = `
    <div class="modal-header">
      <div><h2>${title}</h2><p class="subtitle">${escapeHtml(note)}</p></div>
      <button data-close="occurrencesDialog">Fechar</button>
    </div>
    <div class="list">
      ${rows.map((item) => String(item.status || "") === "resolved" ? `
        <div class="row occurrence-row">
          <div>
            <b>${escapeHtml(safe(item.type_code))}</b> - ${escapeHtml(safe(item.analyst_name))}
            <span class="occurrence-timestamp"> · ${escapeHtml(fmtDateTime(item.created_at))}</span><br>
            ${occurrenceHubLabel(item) ? `<strong class="occurrence-hub">${escapeHtml(occurrenceHubLabel(item))}</strong><br>` : ""}
            <small>${escapeHtml(safe(item.message))}</small>
            <div class="occ-result ${String(item.decision || "") === "approved" ? "approved" : "rejected"}">
              <b>${String(item.decision || "") === "approved" ? "Aprovada" : "Reprovada"}</b> · ${escapeHtml(safe(item.supervisor_note, "sem registro"))}
            </div>
          </div>
        </div>` : `
        <div class="row occurrence-row">
          <div>
            <b>${escapeHtml(safe(item.type_code))}</b> - ${escapeHtml(safe(item.analyst_name))}
            <span class="occurrence-timestamp"> · ${escapeHtml(fmtDateTime(item.created_at))}</span><br>
            ${occurrenceHubLabel(item) ? `<strong class="occurrence-hub">${escapeHtml(occurrenceHubLabel(item))}</strong><br>` : ""}
            <small>${escapeHtml(safe(item.message))}</small>
            <div class="subtitle">Status atual: ${escapeHtml(statusLabelPtBr(item.status))}</div>
          </div>
          ${canEditPanel() ? `
          <div class="occ-form">
            <select id="occ-decision-${item.id}">
              <option value="approved" ${item.decision === "approved" ? "selected" : ""}>Aprovar tratativa</option>
              <option value="rejected" ${item.decision === "rejected" ? "selected" : ""}>Reprovar / devolver</option>
            </select>
            <textarea id="occ-note-${item.id}" placeholder="Descreva a tratativa para histórico da gestão">${escapeHtml(item.supervisor_note || "")}</textarea>
            <button data-action="occ-status" data-id="${item.id}">Salvar tratativa</button>
          </div>
          ` : `<small>Tratativa: ${escapeHtml(safe(item.supervisor_note, "sem registro"))}</small>`}
        </div>
      `).join("") || "Nenhuma ocorrência neste recorte."}
    </div>`;
  document.getElementById("occurrencesDialog").showModal();
}




const GANTT_HOUR_PX = 88;
const WEEKDAYS_PT = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

function ganttRows(day) {
  const rows = [];
  buildOperationalAnalysts().forEach((analyst) => {
    if (selectedSupervisor !== "todos" && analyst.supervisor !== selectedSupervisor) return;
    if (filterShift.size && !filterShift.has(String(analyst.shift || ""))) return;
    if (filterAnalyst.size && !filterAnalyst.has(String(analyst.id))) return;
    const items = (analyst.items || []).filter((item) =>
      dateOnly(item.work_date) === day && itemMatchesFilters(analyst.name, item, { applyDate: false })
    );
    const off = absenceCoveringDate(analyst.timeoff, day);
    if (items.length || off) rows.push({ analyst, items, off });
  });
  return rows.sort((a, b) => String(a.analyst.name || "").localeCompare(String(b.analyst.name || ""), "pt-BR"));
}

function openGantt(day) {
  ganttDay = day || periodRange().start;
  renderGantt();
  const dialog = document.getElementById("ganttDialog");
  if (!dialog.open) dialog.showModal();
}

function renderGantt() {
  const rows = ganttRows(ganttDay);
  const times = [];
  rows.forEach(({ items }) => items.forEach((item) => {
    const start = new Date(item.start_datetime);
    const end = new Date(item.end_datetime);
    if (!Number.isNaN(start.getTime())) times.push(start.getTime());
    if (!Number.isNaN(end.getTime())) times.push(end.getTime());
  }));
  let axisStart = times.length ? new Date(Math.min(...times)) : new Date(`${ganttDay}T12:00:00`);
  axisStart.setMinutes(0, 0, 0);
  let axisEnd = times.length ? new Date(Math.max(...times)) : new Date(axisStart.getTime() + 24 * 3600000);
  if (axisEnd.getMinutes() || axisEnd.getSeconds()) axisEnd = new Date(axisEnd.getTime() + 3600000);
  axisEnd.setMinutes(0, 0, 0);
  if (axisEnd - axisStart < 6 * 3600000) axisEnd = new Date(axisStart.getTime() + 6 * 3600000);
  const hours = Math.round((axisEnd - axisStart) / 3600000);
  const width = hours * GANTT_HOUR_PX;
  const position = (from, to) => {
    const left = Math.max(0, (from - axisStart) / 3600000 * GANTT_HOUR_PX);
    const right = Math.min(width, (to - axisStart) / 3600000 * GANTT_HOUR_PX);
    return `left:${left.toFixed(1)}px;width:${Math.max(18, right - left).toFixed(1)}px`;
  };
  const ticks = Array.from({ length: hours }, (_, index) => {
    const tick = new Date(axisStart.getTime() + index * 3600000);
    return `<span class="gantt-tick" style="left:${index * GANTT_HOUR_PX}px">${String(tick.getHours()).padStart(2, "0")}:00</span>`;
  }).join("");
  const bars = ({ items, off }) => {
    const parts = [];
    if (off) {
      const offStart = new Date(off.start_datetime || `${ganttDay}T00:00:00`);
      const offEnd = new Date(off.end_datetime || `${ganttDay}T23:59:00`);
      const from = Math.max(axisStart.getTime(), Number.isNaN(offStart.getTime()) ? axisStart.getTime() : offStart.getTime());
      const to = Math.min(axisEnd.getTime(), Number.isNaN(offEnd.getTime()) ? axisEnd.getTime() : offEnd.getTime());
      if (to > from) {
        parts.push(`<span class="gantt-bar off" style="${position(from, to)}" title="${escapeHtml(safe(off.absence_type, "Folga"))}">${escapeHtml(safe(off.absence_type, "Folga"))}</span>`);
      }
    }
    items.forEach((item) => {
      const start = new Date(item.start_datetime);
      const end = new Date(item.end_datetime);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return;
      const state = operationState(item);
      const tip = `${safe(item.station_id, "Hub")} · ${safe(item.hub_name, "")}\n${fmtTime(item.start_datetime)}–${fmtTime(item.end_datetime)} · ${state.label}`;
      parts.push(`<span class="gantt-bar ${state.signal}" style="${position(start.getTime(), end.getTime())}" title="${escapeHtml(tip)}">${escapeHtml(safe(item.station_id, "Hub"))}</span>`);
    });
    return parts.join("");
  };

  const nowMs = Date.now();
  const nowLeft = nowMs >= axisStart.getTime() && nowMs <= axisEnd.getTime()
    ? ((nowMs - axisStart.getTime()) / 3600000 * GANTT_HOUR_PX).toFixed(1) : null;
  const nowLine = nowLeft === null ? "" : `<span class="gantt-now" style="left:${nowLeft}px"></span>`;
  const nowLabel = nowLeft === null ? "" : `<span class="gantt-now-label" style="left:${nowLeft}px">agora ${new Date(nowMs).toTimeString().slice(0, 5)}</span>`;
  const printZoom = Math.min(1, 1050 / (220 + width)).toFixed(3);
  const weekday = WEEKDAYS_PT[new Date(`${ganttDay}T12:00:00`).getDay()];
  document.getElementById("ganttBody").innerHTML = `
    <div class="modal-header">
      <div><h2>Prévia da escala</h2><p class="subtitle">Operações publicadas por analista, com os filtros do painel.</p></div>
      <div class="gantt-toolbar">
        <button type="button" class="ghost-button" data-gantt-step="-1" aria-label="Dia anterior">◀</button>
        <strong>${weekday} · ${fmtDate(ganttDay)}</strong>
        <button type="button" class="ghost-button" data-gantt-step="1" aria-label="Próximo dia">▶</button>
        <button type="button" class="ghost-button" data-gantt-print title="Abre a impressão do Chrome: escolha Salvar como PDF">Salvar PDF</button>
        <button type="button" data-close="ganttDialog">Fechar</button>
      </div>
    </div>
    <div class="gantt-legend">
      <span><i style="background:var(--ok)"></i>Em ordem / finalizado</span>
      <span><i style="background:var(--run)"></i>Em execução</span>
      <span><i style="background:var(--warn)"></i>Sem início</span>
      <span><i style="background:var(--bad)"></i>Atrasado / cancelado</span>
      <span><i style="background:repeating-linear-gradient(45deg,#cbd5e1,#cbd5e1 3px,#f8fafc 3px,#f8fafc 6px)"></i>Folga</span>
    </div>
    ${rows.length ? `<div class="gantt-wrap"><div class="gantt-grid" style="grid-template-columns:220px ${width}px;--hour-width:${GANTT_HOUR_PX}px;--print-zoom:${printZoom}">
      <div class="gantt-axis-name">Analista</div>
      <div class="gantt-axis" style="width:${width}px">${ticks}${nowLabel}</div>
      ${rows.map((row) => `
        <div class="gantt-name">${escapeHtml(safe(row.analyst.name))}<small>${escapeHtml(safe(row.analyst.shift, ""))}</small></div>
        <div class="gantt-track" style="width:${width}px">${bars(row)}${nowLine}</div>`).join("")}
    </div></div>` : `<div class="gantt-empty">Nenhuma operação publicada neste dia com os filtros atuais.</div>`}`;
}

setInterval(() => {
  if (document.getElementById("ganttDialog")?.open) renderGantt();
}, 60000);

function openEvents() {
  const analysts = (payload.analysts || [])
    .filter((item) => item.portal_token)
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  document.getElementById("eventsBody").innerHTML = `
    <div class="modal-header">
      <div><h2>Agenda</h2><p class="subtitle">Agende reuniões, treinamentos e implantações. Os analistas recebem no portal e, pelo Google Agenda, o convite com o Google Meet.</p></div>
      <button data-close="eventsDialog">Fechar</button>
    </div>
    <div class="event-form">
      <label>Agendar para
        <select id="event-target-kind">
          <option value="analysts">Analistas selecionados</option>
          <option value="operations">Operações selecionadas</option>
          <option value="all">Toda a equipe do escopo</option>
        </select>
      </label>
      <label>Tipo
        <select id="event-type">
          <option value="reuniao">Reunião</option>
          <option value="treinamento">Treinamento</option>
          <option value="implantacao">Implantação em operação</option>
          <option value="aviso">Aviso operacional</option>
        </select>
      </label>
      <label>Título <input id="event-title" placeholder="Ex.: Alinhamento de roteirização" /></label>
      <label>Data e horário <input id="event-date" type="datetime-local" /></label>
      <label>Duração (min) <input id="event-duration" type="number" min="5" max="720" step="5" value="60" /></label>
      <label>Repetir
        <select id="event-repeat">
          <option value="0">Não repetir</option>
          <option value="1">Toda semana, 2 vezes</option>
          <option value="3">Toda semana, 4 vezes</option>
          <option value="7">Toda semana, 8 vezes</option>
          <option value="11">Toda semana, 12 vezes</option>
        </select>
      </label>
      <label class="wide">Link ou arquivo (opcional) <input id="event-url" placeholder="Link do Meet, do Drive ou de um documento" /></label>
      <div class="event-targets" id="event-target-list"></div>
      <label class="wide">Mensagem <textarea id="event-message" placeholder="Orientação que o analista deve ler"></textarea></label>
      <label class="event-google wide"><input type="checkbox" id="event-google" checked>
        <span>Abrir no Google Agenda para criar o convite com Google Meet (os analistas entram como convidados)</span></label>
      <div class="dialog-message wide" hidden></div>
      <button data-action="create-event" id="event-submit">Enviar</button>
    </div>
    <div class="event-history"><h3>Enviados nos últimos 60 dias</h3><div class="list" id="event-history-list"><small class="subtitle">Carregando…</small></div></div>`;
  document.getElementById("eventsDialog").showModal();
  const renderTargets = () => {
    const kind = document.getElementById("event-target-kind")?.value || "analysts";
    const shell = document.getElementById("event-target-list");
    if (kind === "all") { shell.innerHTML = "<strong>Toda a equipe vinculada receberá o compromisso.</strong>"; return; }
    const rows = kind === "operations"
      ? operations.map((item) => ({ value: item.assignment_id || item.id, analystId: item.analyst_id, label: `${safe(item.station_id)} · ${safe(item.cycle_code)} · ${safe(item.analyst_name)}` }))
      : analysts.map((item) => ({ value: item.id, analystId: item.id, label: item.name || item.full_name || `Analista ${item.id}` }));
    shell.innerHTML = rows.map((item) => `<label><input type="checkbox" data-event-target value="${escapeHtml(item.value)}" data-analyst-id="${escapeHtml(item.analystId)}"> <span>${escapeHtml(item.label)}</span></label>`).join("") || "Nenhum destino disponível.";
  };
  document.getElementById("event-target-kind").onchange = renderTargets;
  renderTargets();

  const typeSelect = document.getElementById("event-type");
  const googleBox = document.getElementById("event-google");
  const repeatSelect = document.getElementById("event-repeat");
  const syncGoogleOption = () => {
    const notice = typeSelect.value === "aviso";
    googleBox.disabled = notice;
    if (notice) googleBox.checked = false;
    repeatSelect.disabled = notice;
    if (notice) repeatSelect.value = "0";
  };
  typeSelect.onchange = syncGoogleOption;
  syncGoogleOption();
  loadAgendaHistory();
}

const AGENDA_TYPE_LABELS = { reuniao: "Reunião", treinamento: "Treinamento", implantacao: "Implantação", aviso: "Aviso" };




function googleCalendarUrl({ title, details, start, minutes, guests = [], account = "", count = 1 }) {
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = (date) => `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}00`;
  const end = new Date(start.getTime() + minutes * 60000);
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    dates: `${stamp(start)}/${stamp(end)}`,
    details,
    ctz: "America/Sao_Paulo",
  });
  if (guests.length) params.set("add", guests.join(","));
  if (account) params.set("authuser", account);

  if (count > 1) params.set("recur", `RRULE:FREQ=WEEKLY;COUNT=${count}`);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function agendaPresence(item) {
  const going = Array.isArray(item.going) ? item.going : [];
  const notGoing = Array.isArray(item.not_going) ? item.not_going : [];
  if (!going.length && !notGoing.length) {
    return item.event_type && item.event_type !== "aviso" ? `<small class="agenda-presence">Ninguém respondeu ainda.</small>` : "";
  }
  const names = (list) => list.map((name) => escapeHtml(safe(name))).join(", ");
  return `<small class="agenda-presence">${going.length ? `<span class="going">✔ Vão (${going.length}): ${names(going)}</span>` : ""}${notGoing.length ? `<span class="not-going">✖ Não podem (${notGoing.length}): ${names(notGoing)}</span>` : ""}</small>`;
}

async function loadAgendaHistory() {
  const box = document.getElementById("event-history-list");
  if (!box) return;
  try {
    const response = await fetch(api("rpc/rt_supervisor_list_agenda"), {
      method: "POST", headers, body: JSON.stringify({ p_token: currentSupervisorToken() }),
    });
    if (!response.ok) throw new Error("history");
    const rows = await response.json();
    box.innerHTML = (rows || []).map((item) => `
      <div class="row">
        <div>
          <b>${escapeHtml(safe(item.title))}</b> <span class="pill gray">${escapeHtml(AGENDA_TYPE_LABELS[item.event_type] || "Aviso")}</span><br>
          <small class="subtitle">${item.scheduled_for ? `${escapeHtml(fmtDateTime(item.scheduled_for))} · ${escapeHtml(String(item.duration_minutes || 60))} min · ` : ""}${escapeHtml(String(item.analysts || 0))} analista(s) · enviado em ${escapeHtml(fmtDateTime(item.created_at))}</small>
          ${agendaPresence(item)}
        </div>
        ${safeUrl(item.event_url) ? `<a class="mini-link" href="${escapeHtml(safeUrl(item.event_url))}" target="_blank" rel="noopener">Abrir link</a>` : ""}
      </div>`).join("") || `<small class="subtitle">Nada enviado nos últimos 60 dias.</small>`;
  } catch (_) {
    box.innerHTML = `<small class="subtitle">Histórico indisponível (falta aplicar a migration 056 no Supabase).</small>`;
  }
}

async function moveAssignment(id) {
  if (!canEditPanel()) return;
  const source = (operations || []).find((item) => Number(item.assignment_id || item.id) === Number(id)) || {};
  if (isTerminalOperationStatus(source.operation_status) || isTerminalOperationStatus(operationState(source).key)) {
    showError("Este Hub já foi finalizado pelo analista e não pode ser transferido pelo painel.");
    return;
  }
  const targetAnalystId = Number(document.getElementById(`move-${id}`)?.value || 0);
  if (!targetAnalystId) return;
  const target = (payload.analysts || []).find((item) => Number(item.id) === targetAnalystId) || {};

  try {
    const response = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/rt_supervisor_transfer_operation`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        p_token: currentSupervisorToken(),
        p_assignment_id: Number(id),
        p_target_analyst_id: targetAnalystId,
        p_target_analyst_name: target.name || "",
        p_target_portal_token: target.portal_token || "",
        p_source_analyst_id: Number(source.analyst_id || 0),
        p_reason: "Transferência pelo painel do supervisor"
      }),
    });
    if (!response.ok) {
      const problem = await response.json().catch(() => null);
      throw new Error(problem?.message || "move");
    }



    const moved = await response.json().catch(() => null);
    await loadData();
    if (moved !== true) {
      showError("O Hub não foi transferido: ele mudou desde que o painel carregou (foi finalizado ou já está com outra pessoa). Os dados foram atualizados; confira e tente de novo.");
      return;
    }
    document.getElementById("details").close();
  } catch (error) {
    console.error("Falha ao transferir Hub", error);
    const detail = error?.message && error.message !== "move" ? ` (${error.message})` : "";
    showError(`Não consegui mover este Hub agora${detail}. Tente atualizar o painel e repetir a ação.`);
  }
}

async function updateOccurrenceStatus(id) {
  if (!canEditPanel()) return;
  const decision = document.getElementById(`occ-decision-${id}`)?.value || "approved";
  const note = document.getElementById(`occ-note-${id}`)?.value.trim() || "";
  if (!note) {
    showError("Informe a tratativa antes de concluir a ocorrência.");
    return;
  }
  try {
    const response = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/rt_supervisor_set_occurrence_status`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        p_token: currentSupervisorToken(),
        p_occurrence_id: Number(id),
        p_status: "resolved",
        p_decision: decision,
        p_supervisor_note: note,
      }),
    });
    if (!response.ok) throw new Error("occurrence");
    await loadData();
    document.getElementById("occurrencesDialog").close();
  } catch (error) {
    console.error("Falha ao atualizar ocorrência", error);
    showError("Não consegui salvar a tratativa agora. Tente novamente em instantes.");
  }
}

async function createEvent() {
  if (!canEditPanel()) {
    showError("Este acesso só visualiza a equipe: não dá para criar agenda por ele.");
    return;
  }
  const submit = document.getElementById("event-submit");
  if (submit?.disabled) return;
  const targetKind = document.getElementById("event-target-kind")?.value || "analysts";
  const type = document.getElementById("event-type")?.value || "aviso";
  const title = document.getElementById("event-title")?.value.trim() || "";
  const message = document.getElementById("event-message")?.value.trim() || "";
  const eventUrl = safeUrl(document.getElementById("event-url")?.value);
  const scheduledFor = document.getElementById("event-date")?.value || null;
  const durationMinutes = Math.min(720, Math.max(5, Number(document.getElementById("event-duration")?.value || 60) || 60));
  const repeatWeeks = type === "aviso" ? 0 : Math.min(11, Math.max(0, Number(document.getElementById("event-repeat")?.value || 0) || 0));
  const withGoogle = type !== "aviso" && Boolean(document.getElementById("event-google")?.checked);
  const selected = [...document.querySelectorAll("[data-event-target]:checked")];
  const selectedAnalystIds = new Set(selected.map((item) => Number(item.dataset.analystId || 0)).filter(Boolean));

  const missing = [];
  if (targetKind !== "all" && !selectedAnalystIds.size) missing.push(targetKind === "operations" ? "pelo menos uma operação" : "pelo menos um analista");
  if (!title) missing.push("Título");
  if (type !== "aviso" && !scheduledFor) missing.push("Data e horário");
  if (!message) missing.push("Mensagem");
  if (missing.length) {
    showError(`Falta preencher: ${missing.join(", ")}.`);
    return;
  }

  if (scheduledFor && new Date(scheduledFor) < new Date(Date.now() - 5 * 60000)) {
    showError(`A data escolhida (${fmtDate(scheduledFor)} ${fmtTime(scheduledFor)}) já passou — confira o dia e o mês.`);
    return;
  }
  const selectedOperations = targetKind === "operations"
    ? selected.map((item) => String(item.value)).filter(Boolean)
    : [];
  const targetAnalysts = (payload.analysts || [])
    .filter((item) => item.portal_token)
    .filter((item) => targetKind === "all" || selectedAnalystIds.has(Number(item.id)));
  const operationNote = selectedOperations.length ? `\nOperações vinculadas: ${selectedOperations.join(", ")}` : "";
  const rows = targetAnalysts.filter((item) => item.portal_token).map((item) => ({ portal_token: item.portal_token }));
  if (!rows.length) {
    showError("Nenhum analista com chave de portal foi encontrado neste escopo.");
    return;
  }

  const googleTab = withGoogle ? window.open("about:blank", "_blank") : null;
  if (submit) { submit.disabled = true; submit.textContent = "Enviando…"; }
  showError("");
  try {
    const response = await fetch(api("rpc/rt_supervisor_create_agenda"), {
      method: "POST",
      headers,
      body: JSON.stringify({
        p_token: currentSupervisorToken(), p_targets: rows, p_title: title,
        p_message: `${message}${operationNote}`, p_event_type: type,
        p_event_url: eventUrl || null,
        p_scheduled_for: scheduledFor ? new Date(scheduledFor).toISOString() : null,
        p_duration_minutes: durationMinutes,
        p_repeat_weeks: repeatWeeks,
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result?.message || "notification");
    document.getElementById("eventsDialog").close();
    const total = Number(result?.created || rows.length);
    if (googleTab) {
      googleTab.location.href = googleCalendarUrl({
        title,
        details: `${message}${operationNote}${eventUrl ? `\n\nLink: ${eventUrl}` : ""}\n\nEnviado pelo Routing Tower.`,
        start: new Date(scheduledFor),
        minutes: durationMinutes,
        guests: Array.isArray(result?.emails) ? result.emails : [],
        account: result?.organizer_email || "",
        count: repeatWeeks + 1,
      });
      const repeatNote = repeatWeeks ? ` (toda semana, ${repeatWeeks + 1} vezes)` : "";
      showNotice(`Agenda${repeatNote} enviada para o portal dos analistas (${total} compromisso(s)). No Google Agenda que abriu, confira o Google Meet e clique em Salvar para enviar os convites.`);
    } else {
      showNotice(`Aviso enviado para o portal de ${total} analista(s).`);
    }
  } catch (error) {
    if (googleTab) googleTab.close();
    console.error("Falha ao enviar notificação", error);
    showError(error?.message && error.message !== "notification"
      ? error.message
      : "Não consegui salvar a agenda. Confira se as migrations 056 e 059 foram aplicadas no Supabase.");
  } finally {
    if (submit) { submit.disabled = false; submit.textContent = "Enviar"; }
  }
}

if (PANEL_CONFIG?.supervisorToken) {

  extensionToken = String(PANEL_CONFIG.supervisorToken).trim();
  localPortalBaseUrl = String(PANEL_CONFIG.localPortalBaseUrl || window.location.origin).replace(/\/$/, "");
  document.getElementById("updatePortalBtn").hidden = true;
  loadData(true);
} else if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync) {
  chrome.storage.sync.get({ supervisorToken: "", localPortalBaseUrl: "https://demo.invalid" }, (cfg) => {
    extensionToken = (cfg.supervisorToken || "").trim();
    localPortalBaseUrl = (cfg.localPortalBaseUrl || "https://demo.invalid").trim().replace(/\/$/, "");
    loadData(true);
  });
} else {
  showError("Abra este painel pela extensão Routing Tower ou pelo botão \"Painel do supervisor\" do app.");
}

if (!window.RT_WEB_CONTEXT) checkMaintenance();

async function portalUpdateStatus() {
  const response = await fetch(chrome.runtime.getURL(`portal-update-status.json?v=${Date.now()}`), { cache: "no-store" });
  return response.ok ? response.json() : null;
}

async function requestPortalFilesUpdate() {
  const button = document.getElementById("updatePortalBtn");
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
      showNotice('As telas já estão atualizadas.');
      button.disabled = false;
      return;
    }
  } catch (_) {
    showNotice('Não foi possível verificar a atualização. Tente novamente mais tarde.');
    button.disabled = false;
    return;
  }
  const requestedAt = Date.now();
  button.disabled = true;
  showNotice("Autorize o atualizador do Routing Tower para verificar as novas telas.");
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.src = `routingtower-update://portal/check?v=${requestedAt}`;
  document.body.appendChild(frame);
  const timer = setInterval(async () => {
    try {
      const result = await portalUpdateStatus();
      if (!result?.updated_at || Date.parse(result.updated_at) < requestedAt - 2000) return;
      clearInterval(timer);
      button.disabled = false;
      showNotice(result.message || "Verificação concluída.");
      if (result.status === "updated") setTimeout(() => location.reload(), 1200);
    } catch (_) {}
  }, 1000);
  setTimeout(() => {
    clearInterval(timer);
    button.disabled = false;
  }, 90000);
}

document.getElementById("updatePortalBtn").onclick = requestPortalFilesUpdate;




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


const moreButton = document.getElementById("moreBtn");
const morePanel = document.getElementById("morePanel");
function setMoreMenu(open) {
  morePanel.hidden = !open;
  moreButton.setAttribute("aria-expanded", String(open));
}
moreButton.onclick = (event) => {
  event.stopPropagation();
  setMoreMenu(morePanel.hidden);
};
document.addEventListener("click", (event) => {
  if (!morePanel.hidden && (!event.target.closest(".more-menu") || event.target.closest(".more-panel button"))) setMoreMenu(false);
});

const PANEL_VERSION = RT_PANEL_BUILD_VERSION;
if (PANEL_VERSION) {
  const versionLine = document.createElement("p");
  versionLine.className = "more-version";
  versionLine.textContent = `Versão ${PANEL_VERSION}`;
  morePanel.appendChild(versionLine);
}

document.querySelectorAll("[data-period-mode]").forEach((button) => {
  button.onclick = () => {
    periodMode = button.dataset.periodMode;
    if (periodMode === "range" && !filterDateEnd) filterDateEnd = filterDate;
    updatePeriodButtons();
    if (!payload) return;
    renderFilters();
    renderOperationView();
  };
});

const fabButton = document.getElementById("fab");
const fabMenu = document.getElementById("fabMenu");
function closeFab() {
  fabButton.classList.remove("open");
  fabMenu.classList.remove("open");
}
fabButton.onclick = () => {
  fabButton.classList.toggle("open");
  fabMenu.classList.toggle("open");
};



function printPanel(onlyGantt = false) {
  document.body.classList.toggle("printing-gantt", onlyGantt);
  window.print();
}
let themeBeforePrint = null;
window.addEventListener("beforeprint", () => {
  themeBeforePrint = document.documentElement.dataset.theme || null;
  if (themeBeforePrint === "dark") document.documentElement.dataset.theme = "light";
});
window.addEventListener("afterprint", () => {
  if (themeBeforePrint === "dark") document.documentElement.dataset.theme = "dark";
  themeBeforePrint = null;
  document.body.classList.remove("printing-gantt");
});
document.getElementById("mgrPdf").onclick = () => printPanel(false);
document.getElementById("fabPdf").onclick = () => {
  closeFab();
  printPanel(false);
};
document.getElementById("fabToday").onclick = () => {
  closeFab();
  periodMode = "day";
  filterDate = operationalTodayIso();
  filterDateEnd = "";
  updatePeriodButtons();
  if (!payload) return;
  renderFilters();
  renderOperationView();
};
document.getElementById("fabRefresh").onclick = () => {
  closeFab();
  refreshPanel();
};
document.getElementById("themeBtn").onclick = () =>
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");

document.addEventListener("click", (event) => {
  const tab = event.target.closest(".tab-button[data-view]");
  if (tab) switchPortalView(tab.dataset.view);

  const dashboardButton = event.target.closest("button[data-dashboard-url]");
  if (dashboardButton) openDashboardFrame(dashboardButton.dataset.dashboardUrl, dashboardButton.dataset.dashboardTitle);

  const card = event.target.closest(".analyst[data-analyst-id]");
  if (card && !event.target.closest("button,select,textarea,input")) openDetails(card.dataset.analystId);

  const close = event.target.closest("[data-close]");
  if (close) document.getElementById(close.dataset.close)?.close();

  const counter = event.target.closest("[data-occurrence-filter]");
  if (counter && payload) openOccurrences(counter.dataset.occurrenceFilter);

  if (event.target.closest("[data-gantt-print]")) printPanel(true);

  const ganttStep = event.target.closest("[data-gantt-step]");
  if (ganttStep && ganttDay) {
    const next = new Date(`${ganttDay}T12:00:00`);
    next.setDate(next.getDate() + Number(ganttStep.dataset.ganttStep || 0));
    ganttDay = isoOf(next);
    renderGantt();
  }

  const button = event.target.closest("button[data-action]");
  if (!button) return;
  if (button.dataset.action === "move") moveAssignment(button.dataset.id);
  if (button.dataset.action === "assign-hub") assignHub(button.dataset.id);
  if (button.dataset.action === "occ-status") updateOccurrenceStatus(button.dataset.id);
  if (button.dataset.action === "create-event") createEvent();
  if (button.dataset.action === "cancel-subst") cancelSupervisorSubstitute(button.dataset.id);
  if (button.dataset.action === "save-subst") saveSupervisorSubstitute();
  if (button.dataset.action === "save-emergency-hub") saveEmergencyHub();
  if (button.dataset.action === "save-emergency-analyst") saveEmergencyAnalyst();
  if (button.dataset.action === "save-useful-link") saveUsefulLink();
  if (button.dataset.action === "delete-useful-link") deleteUsefulLink(button.dataset.id);
});

async function checkRevision(force = false) {
  if (!force && readRecovery.waiting()) return;
  if (revisionCheckRunning || document.hidden || !currentSupervisorToken()) return;

  const revisionToken = currentSupervisorToken();
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
    const response = await fetchWithTimeout(api("rpc/rt_get_supervisor_revision"), {
      method: "POST", headers, body: JSON.stringify({ p_token: currentSupervisorToken() }),
    }, 20000);
    if (!response.ok) throw httpError(response, "revision");
    const info = await response.json();
    const revision = Number(info?.revision || 0);
    if (force || snapshotRevision === null || revision !== snapshotRevision) {
      await loadData();
      if (!readRecovery.waiting() && payload) snapshotRevision = revision;
    }
  } catch (error) {
    console.warn("Falha ao consultar revisão do supervisor", error);

    if (!payload) await handleLoadFailure(error);
  } finally {
    revisionCheckRunning = false;
  }
}

document.addEventListener("visibilitychange", () => { if (!document.hidden) checkRevision(); });
window.addEventListener("focus", () => checkRevision());
setInterval(() => { if (!document.hidden) checkRevision(); }, 10 * 60000);









const MGMT_STATUS = {
  aberta: { label: "Aberta", tone: "run" },
  ajuste: { label: "Ajuste pedido", tone: "warn" },
  analise: { label: "Em análise", tone: "early" },
  aprovada: { label: "Aprovada", tone: "ok" },
  recusada: { label: "Recusada", tone: "bad" },
  concluida: { label: "Concluída", tone: "muted" },
};
const MGMT_CLOSED = ["aprovada", "recusada", "concluida"];
const MGMT_DAYS = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];
const MGMT_PRIORITY = { baixa: "Baixa", media: "Média", alta: "Alta", urgente: "Urgente" };
const MGMT_COLORS = ["#ee4d2d", "#f97316", "#eab308", "#10b981", "#0ea5e9", "#2563eb", "#7c3aed", "#db2777", "#64748b"];
const mgmt = {
  data: null, loading: false, error: "", section: "solicitacoes", selected: null, rq: { type: "", status: "", query: "" },
  nt: { cat: "", from: "", to: "", q: "" },
  wsId: null, view: "quadro", query: "", label: "", assignee: "",
  chart: { mode: "intervalo", day: "", from: "", to: "", scope: "area" }, timer: null, dragId: null,
};




const MGMT_MODELS = {
  nenhum: "Sem campos extras",
  horario: "Opsclock: hub, ciclo, dias e a janela nova",
  novo_hub: "Novo hub: código, nome, regional, ciclo e janela",
  cluster: "Clusterização: hub, clusters e proposta",
};
const MGMT_DEFAULTS = {
  request_types: [
    { key: "mensagem", label: "Mensagem", color: "#2563eb", model: "nenhum", suggest: false, active: true },
    { key: "horario", label: "Alteração de opsclock (horário/janela)", color: "#f97316", model: "horario", suggest: true, active: true },
    { key: "novo_hub", label: "Novo hub", color: "#10b981", model: "novo_hub", suggest: true, active: true },
    { key: "cluster", label: "Clusterização", color: "#7c3aed", model: "cluster", suggest: false, active: true },
    { key: "arquivo", label: "Envio de arquivo", color: "#0ea5e9", model: "nenhum", suggest: false, active: true },
  ],
  notice_categories: [
    { key: "geral", label: "Geral", color: "#64748b", model: "nenhum", suggest: false, confirm: true, active: true },
  ],
  destinations: [
    { key: "coordenacao", label: "Coordenação", active: true },
    { key: "gerencia", label: "Gerência", active: true },
    { key: "ambos", label: "Coordenação e Gerência", active: true },
  ],
  workspace_defaults: {
    columns: [{ name: "A fazer", color: "#64748b", is_done: false }, { name: "Em andamento", color: "#2563eb", is_done: false },
      { name: "Em revisão", color: "#7c3aed", is_done: false }, { name: "Concluído", color: "#10b981", is_done: true }],
    labels: [{ name: "Alteração de opsclock", color: "#f97316" }, { name: "Clusterização", color: "#7c3aed" },
      { name: "Arquivo", color: "#0ea5e9" }, { name: "Urgente", color: "#dc2626" }],
  },
  attachments: { per_message_mb: 2, total_mb: 100, max_files: 5 },
  suggestions: { late_minutes: 10, max_per_group: 3 },
};
function mgmtSetting(key) { return mgmt.data?.settings?.[key] ?? MGMT_DEFAULTS[key]; }
function mgmtTypes(all = false) { return (mgmtSetting("request_types") || []).filter((t) => all || t.active !== false); }
function mgmtCategories(all = false) { return (mgmtSetting("notice_categories") || []).filter((t) => all || t.active !== false); }
function mgmtDestinations(all = false) { return (mgmtSetting("destinations") || []).filter((t) => all || t.active !== false); }
function mgmtType(key) {
  return mgmtTypes(true).find((t) => t.key === key)
    || { key, label: key || "Mensagem", color: "#64748b", model: key === "horario" || key === "cluster" ? key : "nenhum" };
}
function mgmtCategory(key) { return mgmtCategories(true).find((t) => t.key === key) || { key, label: key || "Geral", color: "#64748b", model: "nenhum" }; }
function mgmtKindChip(t) { return `<span class="mg-chip cor" style="--mg-c:${escapeHtml(t.color || "#64748b")}">${escapeHtml(t.label)}</span>`; }
function mgmtSlug(text, used) {
  let base = String(text || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30) || "item";
  let key = base;
  for (let i = 2; used.has(key); i += 1) key = `${base}_${i}`;
  return key;
}
function mgmtAttachInfo() {
  const a = mgmtSetting("attachments") || {};
  return `Até ${a.max_files || 5} arquivos e ${String(a.per_message_mb || 2).replace(".", ",")} MB por mensagem.`;
}

function mgmtModelFieldsHtml() {
  const hubs = mgmtHubs();
  const teams = mgmt.data.teams || [];
  const hubSelect = hubs.length
    ? `<select name="hub"><option value="">Escolha o hub</option>${hubs.map((h) => `<option value="${escapeHtml(h.code)}">${escapeHtml(h.code)}${h.name ? ` · ${escapeHtml(h.name)}` : ""}</option>`).join("")}</select>`
    : `<input name="hub" placeholder="Código do hub (ex.: HUB-LSP-26)">`;
  const dias = (nome) => `<div><span class="mg-form-label">Dias</span><div class="mg-days">${MGMT_DAYS.map((d, i) => `<label class="mg-check"><input type="checkbox" name="${nome}" value="${i}"> ${d}</label>`).join("")}</div></div>`;
  return `
      <div class="mg-type-fields" data-model="horario cluster"><label>Hub${hubSelect}</label></div>
      <div class="mg-type-fields" data-model="horario">
        <div class="mg-form-row"><label>Ciclo<input name="cycle" placeholder="AM, PM1..."></label><label>A partir de<input name="from" type="date"></label></div>
        ${dias("day")}
        <div class="mg-form-row"><label>Janela atual<input name="current" placeholder="01:00–02:00"></label><label>Novo início<input name="start" type="time"></label><label>Novo fim<input name="end" type="time"></label></div>
      </div>
      <div class="mg-type-fields" data-model="novo_hub">
        <div class="mg-form-row"><label>Código do hub<input name="nh_code" placeholder="HUB-LSP-200"></label><label>Nome do hub<input name="nh_name" placeholder="SP Itaquera"></label><label>Regional<input name="nh_region" placeholder="SPM"></label></div>
        ${teams.length > 1 ? `<label>Time que vai assumir<select name="nh_team"><option value="">Ainda não definido</option>${teams.map((t) => `<option value="${escapeHtml(t.key)}">${escapeHtml(t.name)}</option>`).join("")}</select></label>` : ""}
        <div class="mg-form-row"><label>Ciclo<input name="nh_cycle" placeholder="AM"></label><label>Início da janela<input name="nh_start" type="time"></label><label>Fim da janela<input name="nh_end" type="time"></label><label>A partir de<input name="nh_from" type="date"></label></div>
        ${dias("nh_day")}
      </div>
      <div class="mg-type-fields" data-model="cluster">
        <div class="mg-form-row"><label>Clusters hoje<input name="currentClusters" type="number" min="1"></label><label>Clusters propostos<input name="newClusters" type="number" min="1"></label></div>
        <label>Proposta<textarea name="proposal" placeholder="Quais clusters mudam e por quê"></textarea></label>
      </div>`;
}
function mgmtSyncModel(form, model) {
  form.querySelectorAll(".mg-type-fields").forEach((box) => {
    box.hidden = !box.dataset.model.split(" ").includes(model);
    box.querySelectorAll("input, select, textarea").forEach((el) => { el.disabled = box.hidden; });
  });
}
function mgmtCollectFields(model, data) {
  if (model === "horario") {
    const start = data.get("start") || "", end = data.get("end") || "";
    return { hub: data.get("hub") || "", cycle: data.get("cycle") || "", days: data.getAll("day").map(Number), current: data.get("current") || "",
      start, end, next: start && end ? `${start}–${end}` : "", from: data.get("from") || "" };
  }
  if (model === "novo_hub") {
    return { hub: String(data.get("nh_code") || "").trim().toUpperCase(), hub_name: String(data.get("nh_name") || "").trim(),
      region: String(data.get("nh_region") || "").trim().toUpperCase(), team: data.get("nh_team") || "", cycle: data.get("nh_cycle") || "",
      start: data.get("nh_start") || "", end: data.get("nh_end") || "", from: data.get("nh_from") || "", days: data.getAll("nh_day").map(Number) };
  }
  if (model === "cluster") {
    return { hub: data.get("hub") || "", currentClusters: data.get("currentClusters") || "", newClusters: data.get("newClusters") || "", proposal: data.get("proposal") || "" };
  }
  return {};
}
function mgmtModelRows(model, f) {
  const dia = (iso) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString("pt-BR") : "");
  const dias = (f.days || []).map((d) => MGMT_DAYS[d]).join(", ");
  if (model === "horario") {
    return [["Hub", mgmtHubLabel(f.hub)], ["Ciclo", f.cycle], ["Dias", dias], ["Janela atual", f.current],
      ["Janela nova", f.start && f.end ? `${f.start}–${f.end}` : f.next], ["A partir de", dia(f.from)]];
  }
  if (model === "novo_hub") {
    return [["Hub", `${f.hub || ""}${f.hub_name ? ` · ${f.hub_name}` : ""}`], ["Regional", f.region], ["Time", f.team ? mgmtTeamName(f.team) : ""],
      ["Ciclo", f.cycle], ["Janela", f.start && f.end ? `${f.start}–${f.end}` : ""], ["Dias", dias], ["A partir de", dia(f.from)]];
  }
  if (model === "cluster") {
    return [["Hub", mgmtHubLabel(f.hub)], ["Clusters hoje", f.currentClusters], ["Clusters propostos", f.newClusters], ["Proposta", f.proposal]];
  }
  return [];
}
function mgmtModelDl(model, f) {
  const rows = mgmtModelRows(model, f || {}).filter(([, v]) => String(v || "").trim());
  return rows.length ? `<dl class="mg-fields">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHtml(safe(v))}</dd></div>`).join("")}</dl>` : "";
}

function mgmtIso(date) { return date.toLocaleDateString("sv-SE"); }
function mgmtToday() { return mgmtIso(new Date()); }
function mgmtAddDays(iso, days) { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + days); return mgmtIso(d); }
function mgmtDateBr(iso) { return iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) : ""; }
function mgmtWhen(iso) {
  const d = new Date(iso);
  return `${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
}
function mgmtPerson(key) { return (mgmt.data?.people || []).find((p) => p.key === key)?.name || ""; }
function mgmtInitials(name) { return String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase(); }
function mgmtWs() { return (mgmt.data?.workspaces || []).find((w) => w.id === mgmt.wsId) || null; }
function mgmtCanConfigure(ws) { return Boolean(ws) && (mgmt.data?.me?.role === "admin" || ws.owner_key === mgmt.data?.me?.key); }
function mgmtColumn(ws, id) { return (ws?.columns || []).find((c) => c.id === id) || null; }
function mgmtDone(ws, task) { return Boolean(mgmtColumn(ws, task.column_id)?.is_done); }
function mgmtLabelChips(ws, ids) {
  return (ids || []).map((id) => (ws.labels || []).find((l) => l.id === id)).filter(Boolean)
    .map((l) => `<span class="mg-label" style="--mg-c:${escapeHtml(l.color)}">${escapeHtml(l.name)}</span>`).join("");
}
function mgmtDueClass(ws, task) {
  if (!task.due_date || mgmtDone(ws, task)) return "";
  const today = mgmtToday();
  if (task.due_date < today) return "late";
  return task.due_date <= mgmtAddDays(today, 2) ? "soon" : "";
}

function mgmtIsManager() { return mgmt.data?.me?.side === "gestao"; }
function mgmtChip(text, tone) { return `<span class="mg-chip mg-${tone}">${escapeHtml(text)}</span>`; }
function mgmtTeamName(key) { return (mgmt.data?.teams || []).find((t) => t.key === key)?.name || mgmtPerson(key) || ""; }
function mgmtWaitingMe(item) { return Boolean(item.waiting_for) && item.waiting_for === (mgmtIsManager() ? "gestao" : "supervisor"); }
function mgmtUnread() { return mgmtIsManager() ? 0 : (mgmt.data?.notices || []).filter((n) => n.ask_confirm && !n.read_at).length; }
function mgmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  return n >= 1048576 ? `${(n / 1048576).toFixed(1).replace(".", ",")} MB` : `${Math.round(n / 1024)} KB`;
}

function mgmtFrom(item) {
  const fromGestao = item.messages?.[0]?.side === "gestao";
  const to = fromGestao ? mgmtTeamName(item.team_key) : (mgmtDestinations(true).find((d) => d.key === item.to_group) || {}).label || "Coordenação";
  const team = !fromGestao && mgmtIsManager() && (mgmt.data?.teams || []).length > 1 ? ` · ${mgmtTeamName(item.team_key)}` : "";
  return `${item.author_name || mgmtPerson(item.author_key)} → ${to}${team}`;
}

function mgmtBusy() {
  const view = document.getElementById("gerenciamentoView");
  const active = document.activeElement;
  return Boolean(document.getElementById("mgmtDialog")?.open
    || document.getElementById("mgReply")?.value.trim() || document.getElementById("mgReplyFiles")?.files?.length
    || (active && view?.contains(active) && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)));
}

async function mgmtRpc(name, body) {
  const response = await fetch(api(`rpc/${name}`), {
    method: "POST", headers, body: JSON.stringify({ p_token: currentSupervisorToken(), ...body }),
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => ({}));
    throw new Error(problem?.message || "Não foi possível falar com o servidor agora.");
  }
  return response.json();
}

async function mgmtLoad(silent = false) {
  if (mgmt.loading) return;
  mgmt.loading = true;
  if (!silent && !mgmt.data) mgmtRender();
  try {
    mgmt.data = await mgmtRpc("rt_mgmt_load", {});
    mgmt.error = "";
    mgmtSetBadge((mgmt.data.requests || []).filter(mgmtWaitingMe).length + mgmtUnread());
    if (!mgmtWs()) mgmt.wsId = mgmt.data.workspaces[0]?.id || null;
  } catch (error) {
    mgmt.error = error.message;
  } finally {
    mgmt.loading = false;
  }
  mgmtRender();
}

async function mgmtApply(action, data, quiet = false, fn = "rt_mgmt_apply") {
  try {
    const result = await mgmtRpc(fn, { p_action: action, p_data: data });
    await mgmtLoad(true);
    return result;
  } catch (error) {
    if (!quiet) alert(error.message);
    throw error;
  }
}

function mgmtTalk(action, data) { return mgmtApply(action, data, false, "rt_mgmt_talk"); }

function mgmtStart() {
  const view = document.getElementById("gerenciamentoView");
  if (!view.dataset.bound) {
    view.dataset.bound = "1";
    view.addEventListener("click", mgmtClick);
    view.addEventListener("input", (event) => {
      if (event.target.id === "mgQuery") { mgmt.query = event.target.value; mgmtRenderContent(); }
      if (event.target.id === "mgRqQuery") { mgmt.rq.query = event.target.value; mgmtRenderList(); }
      if (event.target.id === "mgNtQuery") { mgmt.nt.q = event.target.value; mgmtRenderNoticeList(); }
    });
    view.addEventListener("change", mgmtChange);
    view.addEventListener("dragstart", (event) => {
      const card = event.target.closest("[data-mg-task]");
      if (!card) return;
      mgmt.dragId = Number(card.dataset.mgTask);
      event.dataTransfer.effectAllowed = "move";
      card.classList.add("dragging");
    });
    view.addEventListener("dragend", (event) => event.target.closest?.("[data-mg-task]")?.classList.remove("dragging"));
    view.addEventListener("dragover", (event) => {
      if (mgmt.dragId && event.target.closest("[data-mg-drop]")) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }
    });
    view.addEventListener("drop", mgmtDrop);
    const today = mgmtToday();
    Object.assign(mgmt.chart, { day: today, from: mgmtAddDays(today, -7), to: mgmtAddDays(today, 30) });
  }
  clearInterval(mgmt.timer);

  mgmt.timer = setInterval(() => {
    if (!document.hidden && view.classList.contains("active") && !mgmtBusy()) mgmtLoad(true);
  }, 5 * 60000);
  mgmtLoad(Boolean(mgmt.data));
}

function mgmtRender() {
  const view = document.getElementById("gerenciamentoView");
  if (!view) return;
  if (!mgmt.data) {
    view.innerHTML = mgmt.error
      ? `<div class="card mg-empty"><strong>Não foi possível abrir o Gerenciamento.</strong><p class="subtitle">${escapeHtml(mgmt.error)}</p><button type="button" data-mg="reload">Tentar de novo</button></div>`
      : `<div class="card mg-empty">Carregando o Gerenciamento…</div>`;
    return;
  }
  const items = mgmt.data.requests || [];
  const count = (fn) => items.filter(fn).length;
  const unread = mgmtUnread();
  const sections = [["solicitacoes", "Solicitações"], ["comunicados", `Comunicados${unread ? ` (${unread})` : ""}`],
    ["arquivos", "Arquivos"], ["areas", "Áreas de trabalho"]];
  const create = mgmt.section === "areas" ? `<button type="button" data-mg="new-ws">Nova área de trabalho</button>`
    : mgmt.section === "comunicados" ? (mgmtIsManager() ? `<button type="button" data-mg="new-notice">Novo comunicado</button>` : "")
      : `<button type="button" data-mg="new-request">Nova solicitação</button>`;
  view.innerHTML = `
    <div class="page-heading">
      <div><h2>Gerenciamento</h2><p class="subtitle">Comunicação entre supervisores, coordenação e gerência: solicitações, horários, clusterização, arquivos, comunicados e áreas de trabalho com tarefas e prazos.</p></div>
      <div class="mg-actions">
        ${mgmt.error ? `<span class="mg-error">${escapeHtml(mgmt.error)}</span>` : ""}
        <button type="button" class="ghost-button" data-mg="reload" title="Buscar de novo no servidor">Atualizar</button>
        ${mgmtIsManager() ? `<button type="button" class="ghost-button" data-mg="config" title="Categorias, tipos, destinos, padrões, anexos e sugestões">Configurações</button>` : ""}
        ${create}
      </div>
    </div>
    ${mgmt.section === "areas" ? "" : `<div class="mg-counters">${[
      ["Abertas", count((i) => !MGMT_CLOSED.includes(i.status)), "run"],
      ["Aguardando você", count(mgmtWaitingMe), "warn"],
      ["Em análise", count((i) => i.status === "analise"), "early"],
      ["Aprovadas / concluídas", count((i) => ["aprovada", "concluida"].includes(i.status)), "ok"],
      ["Comunicados não lidos", unread, unread ? "bad" : "muted"],
    ].map(([label, value, tone]) => `<div class="mg-counter mg-line-${tone}"><span>${label}</span><strong>${value}</strong></div>`).join("")}</div>`}
    <nav class="date-modes mg-sections" aria-label="Seções do gerenciamento">
      ${sections.map(([key, label]) => `<button type="button" class="date-mode${mgmt.section === key ? " active" : ""}" data-mg-section="${key}">${label}</button>`).join("")}
    </nav>
    <div id="mgSection"></div>`;
  if (mgmt.section === "areas") mgmtRenderAreas();
  else if (mgmt.section === "comunicados") mgmtRenderNotices();
  else if (mgmt.section === "arquivos") mgmtRenderFiles();
  else mgmtRenderRequests();
}

function mgmtRenderAreas() {
  const box = document.getElementById("mgSection");
  if (!box) return;
  const workspaces = mgmt.data.workspaces || [];
  const today = mgmtToday();
  box.innerHTML = `
    <div class="mg-layout">
      <aside class="card mg-side">
        <p class="mg-side-title">Áreas de trabalho</p>
        ${workspaces.map((ws) => {
          const open = ws.tasks.filter((t) => !mgmtDone(ws, t));
          const late = open.filter((t) => t.due_date && t.due_date < today).length;
          return `<button type="button" class="mg-ws${ws.id === mgmt.wsId && mgmt.chart.scope !== "todas" ? " active" : ""}" data-mg-ws="${ws.id}">
            <i style="background:${escapeHtml(ws.color)}"></i><span>${escapeHtml(ws.name)}</span>
            <small>${open.length}${late ? ` · <b>${late} atrasada(s)</b>` : ""}</small></button>`;
        }).join("") || `<p class="subtitle">Nenhuma área ainda. Crie a primeira em "Nova área de trabalho".</p>`}
        <button type="button" class="mg-ws mg-all${mgmt.chart.scope === "todas" && mgmt.view === "prazos" ? " active" : ""}" data-mg="all-deadlines"><span>Prazos de todas as áreas</span></button>
      </aside>
      <section class="mg-main" id="mgMain"></section>
    </div>`;
  mgmtRenderMain();
}

function mgmtRenderMain() {
  const main = document.getElementById("mgMain");
  if (!main) return;
  const ws = mgmtWs();
  if (mgmt.view === "prazos" && mgmt.chart.scope === "todas") {
    main.innerHTML = `<div class="card mg-ws-head"><div><h3>Prazos de todas as áreas</h3><p class="subtitle">Cada linha é uma tarefa, agrupadas por área de trabalho.</p></div></div><div id="mgContent"></div>`;
    mgmtRenderContent();
    return;
  }
  if (!ws) {
    main.innerHTML = `<div class="card mg-empty">Escolha uma área de trabalho ou crie uma nova.</div>`;
    return;
  }
  const people = mgmt.data.people || [];
  const members = [...new Set([ws.owner_key, ...(ws.member_keys || [])])];
  main.innerHTML = `
    <div class="card mg-ws-head" style="--mg-c:${escapeHtml(ws.color)}">
      <div>
        <h3><i></i>${escapeHtml(ws.name)}</h3>
        ${ws.description ? `<p class="subtitle">${escapeHtml(ws.description)}</p>` : ""}
        <div class="mg-members">${members.map((key) => `<span class="mg-avatar" title="${escapeHtml(mgmtPerson(key))}${key === ws.owner_key ? " (criou a área)" : ""}">${escapeHtml(mgmtInitials(mgmtPerson(key)))}</span>`).join("")}</div>
      </div>
      <div class="mg-actions">
        <button type="button" class="ghost-button" data-mg="settings">Configurar área</button>
        <button type="button" data-mg="new-task">Nova tarefa</button>
      </div>
    </div>
    <div class="mg-toolbar">
      <nav class="date-modes" aria-label="Visão da área">
        <button type="button" class="date-mode${mgmt.view === "quadro" ? " active" : ""}" data-mg-view="quadro">Quadro</button>
        <button type="button" class="date-mode${mgmt.view === "prazos" ? " active" : ""}" data-mg-view="prazos">Prazos</button>
      </nav>
      <input id="mgQuery" type="search" placeholder="Buscar tarefa ou micro tarefa" value="${escapeHtml(mgmt.query)}">
      <select id="mgLabel"><option value="">Todas as etiquetas</option>${ws.labels.map((l) => `<option value="${l.id}"${String(mgmt.label) === String(l.id) ? " selected" : ""}>${escapeHtml(l.name)}</option>`).join("")}</select>
      <select id="mgAssignee"><option value="">Todos os responsáveis</option>${people.filter((p) => members.includes(p.key)).map((p) => `<option value="${escapeHtml(p.key)}"${mgmt.assignee === p.key ? " selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}</select>
    </div>
    <div id="mgContent"></div>`;
  mgmtRenderContent();
}

function mgmtFilterTasks(ws) {
  const query = mgmt.query.trim().toLowerCase();
  return (ws.tasks || []).filter((t) => (!mgmt.label || (t.label_ids || []).includes(Number(mgmt.label)))
    && (!mgmt.assignee || t.assignee_key === mgmt.assignee || (t.subtasks || []).some((s) => s.assignee_key === mgmt.assignee))
    && (!query || [t.title, t.description, ...(t.subtasks || []).map((s) => s.title)].some((v) => String(v || "").toLowerCase().includes(query))));
}

function mgmtRenderContent() {
  const box = document.getElementById("mgContent");
  if (!box) return;
  if (mgmt.view === "prazos") { mgmtRenderChart(box); return; }
  const ws = mgmtWs();
  if (!ws) return;
  const tasks = mgmtFilterTasks(ws);
  box.innerHTML = `<div class="mg-board">${ws.columns.map((col) => {
    const items = tasks.filter((t) => t.column_id === col.id).sort((a, b) => a.position - b.position || a.id - b.id);
    return `<section class="mg-col" data-mg-drop="${col.id}" style="--mg-c:${escapeHtml(col.color)}">
      <header><span>${escapeHtml(col.name)}</span><small>${items.length}${col.is_done ? " · concluídas" : ""}</small></header>
      <div class="mg-cards">${items.map((t) => mgmtCard(ws, t)).join("")}</div>
      <button type="button" class="mg-add" data-mg-add="${col.id}">+ Adicionar tarefa</button>
    </section>`;
  }).join("")}</div>`;
}

function mgmtCard(ws, t) {
  const subs = t.subtasks || [];
  const closed = subs.filter((s) => s.state === "fechada").length;
  const due = mgmtDueClass(ws, t);
  return `<article class="mg-card${mgmtDone(ws, t) ? " done" : ""}" draggable="true" data-mg-task="${t.id}" tabindex="0">
    <div class="mg-card-labels">${mgmtLabelChips(ws, t.label_ids)}</div>
    <strong>${escapeHtml(t.title)}</strong>
    <div class="mg-card-meta">
      ${t.priority === "alta" || t.priority === "urgente" ? `<span class="mg-prio ${t.priority}">${MGMT_PRIORITY[t.priority]}</span>` : ""}
      ${t.due_date ? `<span class="mg-due ${due}" title="Prazo">${t.start_date ? `${mgmtDateBr(t.start_date)} → ` : ""}${mgmtDateBr(t.due_date)}</span>` : ""}
      ${subs.length ? `<span title="Micro tarefas fechadas">☑ ${closed}/${subs.length}</span>` : ""}
      ${t.comment_count ? `<span title="Comentários">💬 ${t.comment_count}</span>` : ""}
      ${t.assignee_key ? `<span class="mg-avatar small" title="${escapeHtml(mgmtPerson(t.assignee_key))}">${escapeHtml(mgmtInitials(mgmtPerson(t.assignee_key)))}</span>` : ""}
    </div>
  </article>`;
}

function mgmtChartTasks() {
  const list = mgmt.chart.scope === "todas" ? (mgmt.data.workspaces || []) : [mgmtWs()].filter(Boolean);
  return list.map((ws) => ({ ws, tasks: (mgmt.chart.scope === "todas" ? ws.tasks : mgmtFilterTasks(ws)).filter((t) => t.due_date || t.start_date) }));
}

function mgmtChartDayLabel(iso, from, cols) {
  const day = iso.slice(8, 10);
  if (iso === from || iso.endsWith("-01")) return mgmtDateBr(iso);
  if (cols <= 45) return day;
  return new Date(`${iso}T12:00:00`).getDay() === 1 ? day : "";
}

function mgmtRenderChart(box) {
  const c = mgmt.chart;
  const single = c.mode === "dia";
  let from = single ? c.day : c.from;
  let to = single ? c.day : c.to;
  if (!from || !to || to < from) { from = mgmtToday(); to = mgmtAddDays(from, 30); }
  const days = [];
  for (let d = from; d <= to && days.length < 186; d = mgmtAddDays(d, 1)) days.push(d);
  const today = mgmtToday();
  const groups = mgmtChartTasks().map(({ ws, tasks }) => ({
    ws, tasks: tasks.filter((t) => (t.start_date || t.due_date) <= to && (t.due_date || t.start_date) >= from)
      .sort((a, b) => String(a.start_date || a.due_date).localeCompare(String(b.start_date || b.due_date))),
  })).filter((g) => g.tasks.length);
  const all = groups.flatMap((g) => g.tasks.map((t) => ({ ws: g.ws, t })));
  const late = all.filter(({ ws, t }) => t.due_date && t.due_date < today && !mgmtDone(ws, t)).length;
  const done = all.filter(({ ws, t }) => mgmtDone(ws, t)).length;
  const dueIn = all.filter(({ t }) => t.due_date && t.due_date >= from && t.due_date <= to).length;
  const cols = days.length;
  const idx = (iso) => Math.max(0, Math.min(cols - 1, days.indexOf(iso) >= 0 ? days.indexOf(iso) : (iso < from ? 0 : cols - 1)));
  box.innerHTML = `
    <div class="card mg-chart-card">
      <div class="mg-chart-controls">
        <nav class="date-modes" aria-label="Período do gráfico">
          <button type="button" class="date-mode${single ? " active" : ""}" data-mg-chart-mode="dia">Dia</button>
          <button type="button" class="date-mode${single ? "" : " active"}" data-mg-chart-mode="intervalo">Intervalo</button>
        </nav>
        ${single
          ? `<label>Dia <input type="date" id="mgChartDay" value="${escapeHtml(c.day)}"></label>`
          : `<label>De <input type="date" id="mgChartFrom" value="${escapeHtml(c.from)}"></label><label>Até <input type="date" id="mgChartTo" value="${escapeHtml(c.to)}"></label>`}
        <div class="mg-chart-sum"><span>${all.length} tarefa(s) no período</span><span>${dueIn} com prazo nele</span><span class="late">${late} atrasada(s)</span><span class="done">${done} concluída(s)</span></div>
      </div>
      ${groups.length ? `
      <div class="mg-gantt" style="--mg-days:${cols}">
        <div class="mg-g-row mg-g-head"><div class="mg-g-name">Tarefa</div><div class="mg-g-track">${days.map((d) => `<span class="${d === today ? "today" : ""}${new Date(`${d}T12:00:00`).getDay() % 6 === 0 ? " weekend" : ""}" title="${mgmtDateBr(d)}">${mgmtChartDayLabel(d, from, cols)}</span>`).join("")}</div></div>
        ${groups.map((g) => `
          <div class="mg-g-group" style="--mg-c:${escapeHtml(g.ws.color)}"><i></i>${escapeHtml(g.ws.name)}</div>
          ${g.tasks.map((t) => {
            const start = t.start_date || t.due_date;
            const end = t.due_date || t.start_date;
            const left = idx(start < from ? from : start);
            const right = idx(end > to ? to : end);
            const state = mgmtDone(g.ws, t) ? "done" : (t.due_date && t.due_date < today ? "late" : "");
            return `<div class="mg-g-row" style="--mg-c:${escapeHtml(g.ws.color)}"><button type="button" class="mg-g-name" data-mg-open-task="${t.id}" data-mg-open-ws="${g.ws.id}">${escapeHtml(t.title)}<small>${escapeHtml(mgmtColumn(g.ws, t.column_id)?.name || "")}${t.assignee_key ? ` · ${escapeHtml(mgmtPerson(t.assignee_key))}` : ""}</small></button>
              <div class="mg-g-track">${days.includes(today) ? `<i class="mg-g-today" style="left:calc(${idx(today)} * 100% / var(--mg-days))"></i>` : ""}
                <span class="mg-g-bar ${state}" style="left:calc(${left} * 100% / var(--mg-days));width:calc(${right - left + 1} * 100% / var(--mg-days))" title="${escapeHtml(t.title)}: ${mgmtDateBr(start)} a ${mgmtDateBr(end)}">${start < from ? "◂ " : ""}${t.due_date ? mgmtDateBr(t.due_date) : ""}${end > to ? " ▸" : ""}</span></div></div>`;
          }).join("")}`).join("")}
      </div>` : `<p class="subtitle mg-empty">Nenhuma tarefa com início ou prazo ${single ? "neste dia" : "neste intervalo"}.</p>`}
    </div>`;
}

function mgmtChange(event) {
  const id = event.target.id;
  if (id === "mgLabel") { mgmt.label = event.target.value; mgmtRenderContent(); }
  if (id === "mgAssignee") { mgmt.assignee = event.target.value; mgmtRenderContent(); }
  if (id === "mgChartDay") { mgmt.chart.day = event.target.value; mgmtRenderContent(); }
  if (id === "mgChartFrom") { mgmt.chart.from = event.target.value; mgmtRenderContent(); }
  if (id === "mgChartTo") { mgmt.chart.to = event.target.value; mgmtRenderContent(); }
  if (id === "mgRqType") { mgmt.rq.type = event.target.value; mgmtRenderList(); }
  if (id === "mgNtCat") { mgmt.nt.cat = event.target.value; mgmtRenderNoticeList(); }
  if (id === "mgNtFrom") { mgmt.nt.from = event.target.value; mgmtRenderNoticeList(); }
  if (id === "mgNtTo") { mgmt.nt.to = event.target.value; mgmtRenderNoticeList(); }
  if (id === "mgRqStatus") { mgmt.rq.status = event.target.value; mgmtRenderList(); }
  if (id === "mgReplyFiles") mgmtShowPicked(event.target, "mgReplyPicked");
}

function mgmtClick(event) {
  const t = event.target;
  const section = t.closest("[data-mg-section]");
  if (section) { mgmt.section = section.dataset.mgSection; mgmtRender(); return; }
  const req = t.closest("[data-mg-req]");
  if (req) { mgmt.selected = Number(req.dataset.mgReq); mgmtRenderList(); return; }
  const goReq = t.closest("[data-mg-go-req]");
  if (goReq) {
    Object.assign(mgmt, { section: "solicitacoes", selected: Number(goReq.dataset.mgGoReq) });
    Object.assign(mgmt.rq, { type: "", status: "", query: "" });
    mgmtRender(); return;
  }
  const file = t.closest("[data-mg-file]");
  if (file) { mgmtDownload(Number(file.dataset.mgFile)); return; }
  const fileDel = t.closest("[data-mg-file-del]");
  if (fileDel) {
    if (confirm(`Remover "${fileDel.dataset.mgFileName}" do servidor?\n\nBaixe e guarde no Drive antes: depois daqui ninguém consegue baixar.`)) {
      mgmtTalk("file.delete", { id: Number(fileDel.dataset.mgFileDel) }).catch(() => {});
    }
    return;
  }
  const read = t.closest("[data-mg-read]");
  if (read) { read.disabled = true; mgmtTalk("notice.read", { id: Number(read.dataset.mgRead) }).catch(() => { read.disabled = false; }); return; }
  const noticeDel = t.closest("[data-mg-notice-del]");
  if (noticeDel) {
    if (confirm("Apagar este comunicado para todos?")) mgmtTalk("notice.delete", { id: Number(noticeDel.dataset.mgNoticeDel) }).catch(() => {});
    return;
  }
  const status = t.closest("[data-mg-status]");
  if (status) { mgmtSetStatus(status.dataset.mgStatus); return; }
  const ws = t.closest("[data-mg-ws]");
  if (ws) { mgmt.wsId = Number(ws.dataset.mgWs); mgmt.chart.scope = "area"; mgmt.label = ""; mgmt.assignee = ""; mgmtRender(); return; }
  const viewBtn = t.closest("[data-mg-view]");
  if (viewBtn) { mgmt.view = viewBtn.dataset.mgView; mgmt.chart.scope = "area"; mgmtRenderMain(); return; }
  const mode = t.closest("[data-mg-chart-mode]");
  if (mode) { mgmt.chart.mode = mode.dataset.mgChartMode; mgmtRenderContent(); return; }
  const openTask = t.closest("[data-mg-open-task]");
  if (openTask) { mgmtOpenTask(Number(openTask.dataset.mgOpenTask), Number(openTask.dataset.mgOpenWs)); return; }
  const card = t.closest("[data-mg-task]");
  if (card) { mgmtOpenTask(Number(card.dataset.mgTask)); return; }
  const add = t.closest("[data-mg-add]");
  if (add) { mgmtOpenTask(null, null, Number(add.dataset.mgAdd)); return; }
  const action = t.closest("[data-mg]")?.dataset.mg;
  if (action === "reload") mgmtLoad();
  if (action === "reply") mgmtReply();
  if (action === "new-request") mgmtOpenRequestForm();
  if (action === "new-notice") mgmtOpenNoticeForm();
  if (action === "config") mgmtOpenConfig();
  if (action === "nt-clear") { mgmt.nt = { cat: "", from: "", to: "", q: "" }; mgmtRenderNotices(); }
  if (action === "new-ws") mgmtOpenSettings(null);
  if (action === "settings") mgmtOpenSettings(mgmtWs());
  if (action === "new-task") mgmtOpenTask(null);
  if (action === "all-deadlines") { mgmt.view = "prazos"; mgmt.chart.scope = "todas"; mgmtRender(); }
}

async function mgmtDrop(event) {
  const zone = event.target.closest("[data-mg-drop]");
  const ws = mgmtWs();
  const taskId = mgmt.dragId;
  mgmt.dragId = null;
  if (!zone || !ws || !taskId) return;
  event.preventDefault();
  const columnId = Number(zone.dataset.mgDrop);
  const ordered = ws.tasks.filter((x) => x.column_id === columnId && x.id !== taskId).sort((a, b) => a.position - b.position || a.id - b.id);
  const before = event.target.closest("[data-mg-task]");
  const beforeIndex = before ? ordered.findIndex((x) => x.id === Number(before.dataset.mgTask)) : -1;
  let position;
  if (beforeIndex < 0) position = (ordered.at(-1)?.position || 0) + 1;
  else position = ((ordered[beforeIndex - 1]?.position ?? ordered[beforeIndex].position - 1) + ordered[beforeIndex].position) / 2;
  const task = ws.tasks.find((x) => x.id === taskId);
  if (task) { task.column_id = columnId; task.position = position; mgmtRenderContent(); } // na hora; o servidor confirma
  await mgmtApply("task.move", { id: taskId, column_id: columnId, position }).catch(() => mgmtLoad(true));
}

function mgmtDialog() {
  let dialog = document.getElementById("mgmtDialog");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "mgmtDialog";
    dialog.className = "mg-dialog";
    document.body.appendChild(dialog);
  }
  return dialog;
}

function mgmtColorPicker(name, value) {
  return `<div class="mg-colors">${MGMT_COLORS.map((c) => `<label title="${c}"><input type="radio" name="${name}" value="${c}"${c === value ? " checked" : ""}><i style="background:${c}"></i></label>`).join("")}</div>`;
}

function mgmtOpenSettings(ws) {
  const dialog = mgmtDialog();
  const me = mgmt.data.me;
  const canConfigure = !ws || mgmtCanConfigure(ws);
  const people = (mgmt.data.people || []).filter((p) => p.key !== (ws?.owner_key || me.key));
  const members = new Set(ws?.member_keys || []);
  dialog.innerHTML = `
    <div class="mg-form">
      <div class="modal-header"><h2>${ws ? "Configurar área de trabalho" : "Nova área de trabalho"}</h2><button type="button" data-close="mgmtDialog">Fechar</button></div>
      ${canConfigure ? "" : `<p class="subtitle">Nome, cor e membros só podem ser mudados por quem criou a área (${escapeHtml(mgmtPerson(ws.owner_key))}) ou pelo admin. Colunas e etiquetas, qualquer membro.</p>`}
      <label>Nome<input id="mgWsName" maxlength="120" value="${escapeHtml(ws?.name || "")}" ${canConfigure ? "" : "disabled"}></label>
      <label>Descrição<textarea id="mgWsDesc" ${canConfigure ? "" : "disabled"}>${escapeHtml(ws?.description || "")}</textarea></label>
      <div><span class="mg-form-label">Cor</span>${mgmtColorPicker("mgWsColor", ws?.color || "#ee4d2d")}</div>
      <div><span class="mg-form-label">Membros (veem e editam as tarefas)</span>
        <div class="mg-people">${people.map((p) => `<label class="mg-check"><input type="checkbox" value="${escapeHtml(p.key)}"${members.has(p.key) ? " checked" : ""} ${canConfigure ? "" : "disabled"}> ${escapeHtml(p.name)} <small>${escapeHtml(p.role)}</small></label>`).join("") || `<p class="subtitle">Ninguém mais cadastrado.</p>`}</div>
      </div>
      ${canConfigure ? `<div class="mg-row-end"><button type="button" id="mgWsSave">${ws ? "Salvar área" : "Criar área"}</button></div>` : ""}
      ${ws ? `
      <h3>Colunas</h3>
      <div class="mg-config-list">${ws.columns.map((c, i) => `
        <div class="mg-config-row" data-col="${c.id}">
          <input class="mg-col-name" value="${escapeHtml(c.name)}" maxlength="60">
          <input type="color" class="mg-col-color" value="${escapeHtml(c.color)}">
          <label class="mg-check"><input type="checkbox" class="mg-col-done"${c.is_done ? " checked" : ""}> conta como concluída</label>
          <button type="button" class="ghost-button" data-col-move="-1"${i === 0 ? " disabled" : ""} title="Mover para a esquerda">◀</button>
          <button type="button" class="ghost-button" data-col-move="1"${i === ws.columns.length - 1 ? " disabled" : ""} title="Mover para a direita">▶</button>
          <button type="button" class="ghost-button" data-col-save>Salvar</button>
          <button type="button" class="ghost-button mg-danger" data-col-del${ws.columns.length < 2 ? " disabled" : ""}>Excluir</button>
        </div>`).join("")}
        <div class="mg-config-row"><input id="mgNewCol" placeholder="Nova coluna (ex.: Bloqueado)" maxlength="60"><button type="button" class="ghost-button" id="mgAddCol">Adicionar coluna</button></div>
      </div>
      <h3>Etiquetas</h3>
      <div class="mg-config-list">${ws.labels.map((l) => `
        <div class="mg-config-row" data-lab="${l.id}">
          <input class="mg-lab-name" value="${escapeHtml(l.name)}" maxlength="40">
          <input type="color" class="mg-lab-color" value="${escapeHtml(l.color)}">
          <button type="button" class="ghost-button" data-lab-save>Salvar</button>
          <button type="button" class="ghost-button mg-danger" data-lab-del>Excluir</button>
        </div>`).join("")}
        <div class="mg-config-row"><input id="mgNewLab" placeholder="Nova etiqueta" maxlength="40"><input type="color" id="mgNewLabColor" value="#64748b"><button type="button" class="ghost-button" id="mgAddLab">Adicionar etiqueta</button></div>
      </div>
      ${canConfigure ? `<div class="mg-row-end"><button type="button" class="ghost-button mg-danger" id="mgWsArchive">Arquivar área</button></div>` : ""}` : ""}
    </div>`;
  const run = async (fn) => { try { await fn(); if (ws) mgmtOpenSettings(mgmtWs()); } catch (_) { /* a mensagem já apareceu */ } };
  dialog.querySelector("#mgWsSave")?.addEventListener("click", () => run(async () => {
    const result = await mgmtApply("workspace.save", {
      id: ws?.id, name: dialog.querySelector("#mgWsName").value,
      description: dialog.querySelector("#mgWsDesc").value,
      color: dialog.querySelector("input[name=mgWsColor]:checked")?.value,
      member_keys: [...dialog.querySelectorAll(".mg-people input:checked")].map((x) => x.value),
    });
    if (!ws) { mgmt.wsId = result.id; mgmt.view = "quadro"; mgmt.chart.scope = "area"; dialog.close(); mgmtRender(); }
  }));
  dialog.querySelector("#mgWsArchive")?.addEventListener("click", () => {
    if (!confirm(`Arquivar "${ws.name}"? Ela some da lista de todos os membros.`)) return;
    mgmtApply("workspace.archive", { id: ws.id }).then(() => { mgmt.wsId = null; dialog.close(); mgmtRender(); }).catch(() => {});
  });
  dialog.querySelector("#mgAddCol")?.addEventListener("click", () => run(() => mgmtApply("column.save", { workspace_id: ws.id, name: dialog.querySelector("#mgNewCol").value })));
  dialog.querySelector("#mgAddLab")?.addEventListener("click", () => run(() => mgmtApply("label.save", { workspace_id: ws.id, name: dialog.querySelector("#mgNewLab").value, color: dialog.querySelector("#mgNewLabColor").value })));
  dialog.querySelectorAll("[data-col]").forEach((row) => {
    const id = Number(row.dataset.col);
    const index = ws.columns.findIndex((c) => c.id === id);
    const save = (position) => mgmtApply("column.save", {
      id, name: row.querySelector(".mg-col-name").value, color: row.querySelector(".mg-col-color").value,
      is_done: row.querySelector(".mg-col-done").checked, position,
    });
    row.querySelector("[data-col-save]").addEventListener("click", () => run(() => save()));
    row.querySelectorAll("[data-col-move]").forEach((btn) => btn.addEventListener("click", () => run(async () => {
      const other = ws.columns[index + Number(btn.dataset.colMove)];
      if (!other) return;
      await mgmtApply("column.save", { id: other.id, name: other.name, color: other.color, is_done: other.is_done, position: ws.columns[index].position }, true);
      await save(other.position);
    })));
    row.querySelector("[data-col-del]").addEventListener("click", () => {
      if (!confirm("Excluir a coluna? As tarefas dela vão para a primeira coluna.")) return;
      run(() => mgmtApply("column.delete", { id }));
    });
  });
  dialog.querySelectorAll("[data-lab]").forEach((row) => {
    const id = Number(row.dataset.lab);
    row.querySelector("[data-lab-save]").addEventListener("click", () => run(() => mgmtApply("label.save", { id, name: row.querySelector(".mg-lab-name").value, color: row.querySelector(".mg-lab-color").value })));
    row.querySelector("[data-lab-del]").addEventListener("click", () => {
      if (!confirm("Excluir a etiqueta? Ela sai de todas as tarefas.")) return;
      run(() => mgmtApply("label.delete", { id }));
    });
  });
  if (!dialog.open) dialog.showModal();
}

function mgmtLabelPicker(ws, selected) {
  const chosen = new Set(selected || []);
  return `<div class="mg-label-picker">${ws.labels.map((l) => `<label class="mg-label pick" style="--mg-c:${escapeHtml(l.color)}"><input type="checkbox" value="${l.id}"${chosen.has(l.id) ? " checked" : ""}>${escapeHtml(l.name)}</label>`).join("") || `<span class="subtitle">Nenhuma etiqueta (crie em "Configurar área").</span>`}</div>`;
}

function mgmtPeopleOptions(ws, selected) {
  const members = [...new Set([ws.owner_key, ...(ws.member_keys || [])])];
  return `<option value="">Ninguém</option>${(mgmt.data.people || []).filter((p) => members.includes(p.key)).map((p) => `<option value="${escapeHtml(p.key)}"${p.key === selected ? " selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}`;
}

async function mgmtOpenTask(taskId, wsId = null, columnId = null) {
  if (wsId) mgmt.wsId = wsId;
  const ws = mgmtWs();
  if (!ws) return;
  const task = taskId ? ws.tasks.find((x) => x.id === taskId) : null;
  if (taskId && !task) return;
  const dialog = mgmtDialog();
  const subs = task?.subtasks || [];
  dialog.innerHTML = `
    <div class="mg-form">
      <div class="modal-header"><h2>${task ? "Tarefa" : "Nova tarefa"} · <span class="mg-ws-name" style="color:${escapeHtml(ws.color)}">${escapeHtml(ws.name)}</span></h2><button type="button" data-close="mgmtDialog">Fechar</button></div>
      <label>Título<input id="mgTTitle" maxlength="200" value="${escapeHtml(task?.title || "")}"></label>
      <label>Descrição<textarea id="mgTDesc" placeholder="O que precisa ser feito, links, contexto">${escapeHtml(task?.description || "")}</textarea></label>
      <div class="mg-form-row">
        <label>Coluna<select id="mgTCol">${ws.columns.map((c) => `<option value="${c.id}"${c.id === (task?.column_id || columnId || ws.columns[0]?.id) ? " selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}</select></label>
        <label>Responsável<select id="mgTWho">${mgmtPeopleOptions(ws, task?.assignee_key)}</select></label>
        <label>Prioridade<select id="mgTPrio">${Object.entries(MGMT_PRIORITY).map(([k, v]) => `<option value="${k}"${(task?.priority || "media") === k ? " selected" : ""}>${v}</option>`).join("")}</select></label>
      </div>
      <div class="mg-form-row">
        <label>Início<input type="date" id="mgTStart" value="${escapeHtml(task?.start_date || "")}"></label>
        <label>Prazo<input type="date" id="mgTDue" value="${escapeHtml(task?.due_date || "")}"></label>
      </div>
      <div id="mgTLabels"><span class="mg-form-label">Etiquetas</span>${mgmtLabelPicker(ws, task?.label_ids)}</div>
      <div class="mg-row-end">
        ${task ? `<span class="subtitle">Criada por ${escapeHtml(task.created_by || "-")} em ${mgmtWhen(task.created_at)}${task.completed_at ? ` · concluída em ${mgmtWhen(task.completed_at)}` : ""}</span><button type="button" class="ghost-button mg-danger" id="mgTDel">Excluir tarefa</button>` : ""}
        <button type="button" id="mgTSave">${task ? "Salvar tarefa" : "Criar tarefa"}</button>
      </div>
      ${task ? `
      <h3>Micro tarefas <small class="subtitle">${subs.filter((s) => s.state === "fechada").length}/${subs.length} fechadas</small></h3>
      <div class="mg-subs">${subs.map((s) => `
        <div class="mg-sub${s.state === "fechada" ? " closed" : ""}" data-sub="${s.id}">
          <button type="button" class="mg-sub-state" data-sub-toggle title="${s.state === "fechada" ? "Reabrir" : "Fechar"}">${s.state === "fechada" ? "✔" : "○"}</button>
          <span class="mg-sub-num">#${s.number}</span>
          <input class="mg-sub-title" value="${escapeHtml(s.title)}" maxlength="200">
          <select class="mg-sub-who">${mgmtPeopleOptions(ws, s.assignee_key)}</select>
          <input type="date" class="mg-sub-due" value="${escapeHtml(s.due_date || "")}">
          <button type="button" class="ghost-button" data-sub-save>Salvar</button>
          <button type="button" class="ghost-button mg-danger" data-sub-del title="Excluir micro tarefa">✕</button>
          <div class="mg-sub-labels">${mgmtLabelPicker(ws, s.label_ids)}</div>
        </div>`).join("") || `<p class="subtitle">Nenhuma micro tarefa ainda.</p>`}
        <div class="mg-sub new"><input id="mgNewSub" placeholder="Nova micro tarefa (ex.: Ajustar Mauá no app)" maxlength="200"><select id="mgNewSubWho">${mgmtPeopleOptions(ws, "")}</select><input type="date" id="mgNewSubDue"><button type="button" class="ghost-button" id="mgAddSub">Adicionar</button></div>
      </div>
      <h3>Comentários</h3>
      <div class="mg-comments" id="mgComments"><p class="subtitle">Carregando…</p></div>
      <div class="mg-comment-new"><textarea id="mgNewComment" placeholder="Escreva um comentário para quem acompanha a tarefa"></textarea><button type="button" id="mgAddComment">Comentar</button></div>` : ""}
    </div>`;
  const reopen = () => mgmtOpenTask(task.id);
  const checked = (root) => [...root.querySelectorAll(".mg-label-picker input:checked")].map((x) => Number(x.value));
  dialog.querySelector("#mgTSave").addEventListener("click", async () => {
    const result = await mgmtApply("task.save", {
      id: task?.id, workspace_id: ws.id, column_id: Number(dialog.querySelector("#mgTCol").value),
      title: dialog.querySelector("#mgTTitle").value, description: dialog.querySelector("#mgTDesc").value,
      assignee_key: dialog.querySelector("#mgTWho").value, priority: dialog.querySelector("#mgTPrio").value,
      start_date: dialog.querySelector("#mgTStart").value, due_date: dialog.querySelector("#mgTDue").value,
      label_ids: checked(dialog.querySelector("#mgTLabels")),
    }).catch(() => null);
    if (result) mgmtOpenTask(result.id);
  });
  if (!task) { if (!dialog.open) dialog.showModal(); dialog.querySelector("#mgTTitle").focus(); return; }
  dialog.querySelector("#mgTDel").addEventListener("click", () => {
    if (!confirm(`Excluir "${task.title}" com as micro tarefas e os comentários?`)) return;
    mgmtApply("task.delete", { id: task.id }).then(() => dialog.close()).catch(() => {});
  });
  dialog.querySelectorAll("[data-sub]").forEach((row) => {
    const sub = subs.find((s) => s.id === Number(row.dataset.sub));
    const save = (state) => mgmtApply("subtask.save", {
      id: sub.id, title: row.querySelector(".mg-sub-title").value, assignee_key: row.querySelector(".mg-sub-who").value,
      due_date: row.querySelector(".mg-sub-due").value, label_ids: checked(row), state: state || sub.state,
    }).then(reopen).catch(() => {});
    row.querySelector("[data-sub-toggle]").addEventListener("click", () => save(sub.state === "fechada" ? "aberta" : "fechada"));
    row.querySelector("[data-sub-save]").addEventListener("click", () => save());
    row.querySelector("[data-sub-del]").addEventListener("click", () => {
      if (confirm(`Excluir a micro tarefa #${sub.number}?`)) mgmtApply("subtask.delete", { id: sub.id }).then(reopen).catch(() => {});
    });
  });
  dialog.querySelector("#mgAddSub").addEventListener("click", () => mgmtApply("subtask.save", {
    task_id: task.id, title: dialog.querySelector("#mgNewSub").value,
    assignee_key: dialog.querySelector("#mgNewSubWho").value, due_date: dialog.querySelector("#mgNewSubDue").value,
  }).then(reopen).catch(() => {}));
  dialog.querySelector("#mgAddComment").addEventListener("click", () => mgmtApply("comment.add", {
    task_id: task.id, body: dialog.querySelector("#mgNewComment").value,
  }).then(reopen).catch(() => {}));
  if (!dialog.open) dialog.showModal();
  try {
    const comments = await mgmtRpc("rt_mgmt_comments", { p_task_id: task.id });
    const box = dialog.querySelector("#mgComments");
    if (box) box.innerHTML = comments.map((c) => `<div class="mg-comment${c.author_key === mgmt.data.me.key ? " mine" : ""}">
      <div class="mg-comment-head"><strong>${escapeHtml(c.author_name || mgmtPerson(c.author_key))}</strong>${c.subtask_id ? `<span class="subtitle">na micro tarefa #${escapeHtml(String(subs.find((s) => s.id === c.subtask_id)?.number || "?"))}</span>` : ""}<small>${mgmtWhen(c.created_at)}</small></div>
      <p>${escapeHtml(c.body)}</p></div>`).join("") || `<p class="subtitle">Nenhum comentário ainda.</p>`;
  } catch (error) {
    const box = dialog.querySelector("#mgComments");
    if (box) box.innerHTML = `<p class="mg-error">${escapeHtml(error.message)}</p>`;
  }
}



function mgmtSetBadge(n) {
  const tab = document.querySelector('.tab-button[data-view="gerenciamentoView"]');
  if (!tab) return;
  let badge = tab.querySelector(".tab-badge");
  if (!n) { badge?.remove(); return; }
  if (!badge) { badge = document.createElement("span"); badge.className = "tab-badge"; tab.appendChild(badge); }
  badge.textContent = n > 99 ? "99+" : String(n);
  badge.title = `${n} item(ns) aguardando você no Gerenciamento`;
}

async function mgmtCheckPending() {
  if (window.RT_WEB_CONTEXT) return;
  if (readRecovery.waiting()) return;
  if (!currentSupervisorToken()) return;
  let pend;
  try { pend = await mgmtRpc("rt_mgmt_pending", {}); } catch (_) { return; }
  const reqs = pend.requests || [];
  const notices = pend.notices || [];
  mgmtSetBadge(reqs.length + notices.length);
  if (typeof chrome === "undefined" || !chrome.notifications) return;
  await loadNotifiedAlertIds();
  const novos = [
    ...reqs.map((r) => ({ id: `mgmt-req:${r.id}:${r.updated_at}`, title: "Gerenciamento: aguardando você", text: `${r.title}${r.last_author ? ` · ${r.last_author}` : ""}` })),
    ...notices.map((n) => ({ id: `mgmt-notice:${n.id}`, title: "Novo comunicado", text: `${n.title}${n.author_name ? ` · ${n.author_name}` : ""}` })),
  ].filter((item) => !notifiedAlertIds.has(item.id));
  if (!novos.length) return;
  novos.slice(0, 3).forEach((item) => systemNotify(item.id, item.title, item.text));
  if (novos.length > 3) systemNotify(`mgmt-mais:${Date.now()}`, "Gerenciamento", `E mais ${novos.length - 3} item(ns) aguardando você.`);
  novos.forEach((item) => notifiedAlertIds.add(item.id));
  persistNotifiedAlertIds();
}
setTimeout(mgmtCheckPending, 6000);
setInterval(mgmtCheckPending, 5 * 60000);

function mgmtRenderRequests() {
  const box = document.getElementById("mgSection");
  if (!box) return;
  box.innerHTML = `
    <div class="mg-split">
      <section class="card mg-list-card">
        <div class="mg-filters">
          <input id="mgRqQuery" type="search" placeholder="Buscar hub, assunto ou pessoa" value="${escapeHtml(mgmt.rq.query)}">
          <select id="mgRqType"><option value="">Todos os tipos</option>${mgmtTypes(true).map((t) => `<option value="${escapeHtml(t.key)}"${mgmt.rq.type === t.key ? " selected" : ""}>${escapeHtml(t.label)}${t.active === false ? " (desativado)" : ""}</option>`).join("")}</select>
          <select id="mgRqStatus"><option value="">Todas as situações</option>${Object.entries(MGMT_STATUS).map(([key, st]) => `<option value="${key}"${mgmt.rq.status === key ? " selected" : ""}>${st.label}</option>`).join("")}</select>
        </div>
        <div id="mgList" class="mg-list"></div>
      </section>
      <section class="card mg-detail" id="mgDetail"></section>
    </div>`;
  mgmtRenderList();
}

function mgmtFiltered() {
  const query = mgmt.rq.query.trim().toLowerCase();
  return (mgmt.data.requests || []).filter((item) => (!mgmt.rq.type || item.kind === mgmt.rq.type) && (!mgmt.rq.status || item.status === mgmt.rq.status)
    && (!query || [item.title, item.author_name, mgmtTeamName(item.team_key), item.fields?.hub, ...item.messages.map((m) => m.body)]
      .some((v) => String(v || "").toLowerCase().includes(query))))
    .sort((a, b) => (mgmtWaitingMe(b) - mgmtWaitingMe(a)) || String(b.updated_at).localeCompare(String(a.updated_at)));
}

function mgmtRenderList() {
  const box = document.getElementById("mgList");
  if (!box) return;
  const list = mgmtFiltered();
  if (!list.some((item) => item.id === mgmt.selected)) mgmt.selected = list[0]?.id || null;
  box.innerHTML = list.map((item) => {
    const type = mgmtType(item.kind);
    const st = MGMT_STATUS[item.status] || MGMT_STATUS.aberta;
    const last = item.messages.at(-1) || item;
    return `<button type="button" class="mg-item${item.id === mgmt.selected ? " active" : ""}" data-mg-req="${item.id}">
      <span class="mg-item-top">${mgmtKindChip(type)}${mgmtChip(st.label, st.tone)}${mgmtWaitingMe(item) ? `<span class="mg-dot" title="Aguardando você"></span>` : ""}</span>
      <strong>${escapeHtml(item.title)}</strong>
      <small>${escapeHtml(mgmtFrom(item))} · ${mgmtWhen(last.created_at)} · ${item.messages.length} mensagem(ns)</small>
    </button>`;
  }).join("") || `<p class="subtitle">${(mgmt.data.requests || []).length ? "Nenhuma solicitação com estes filtros." : "Nenhuma solicitação ainda. Abra a primeira em \"Nova solicitação\"."}</p>`;
  mgmtRenderDetail();
}

function mgmtHubs() {
  const seen = new Map();
  (payload?.all_hubs || []).forEach((hub) => {
    const code = String(hub.station_id || "").trim();
    if (code && !seen.has(code)) seen.set(code, hub.name || "");
  });
  return [...seen].map(([code, name]) => ({ code, name })).sort((a, b) => a.code.localeCompare(b.code));
}
function mgmtHubLabel(code) {
  const hub = mgmtHubs().find((h) => h.code === code);
  return hub?.name ? `${hub.code} · ${hub.name}` : code;
}

function mgmtFieldsHtml(item) {
  const type = mgmtType(item.kind);
  const f = item.fields || {};
  const dl = mgmtModelDl(type.model, f);
  if (!dl) return "";
  const apply = type.model === "horario" && item.status === "aprovada"
    ? `<p class="mg-hint">Aprovada. Aplicar no app desktop: Hubs e ciclos → ${escapeHtml(safe(f.hub))} → ciclo ${escapeHtml(safe(f.cycle))}, nos dias pedidos.</p>`
    : type.model === "novo_hub" && item.status === "aprovada"
      ? `<p class="mg-hint">Aprovada. Cadastrar no app desktop: Hubs e ciclos → novo hub ${escapeHtml(safe(f.hub))} (${escapeHtml(safe(f.hub_name))}).</p>` : "";
  return dl + apply;
}

function mgmtRenderDetail() {
  const box = document.getElementById("mgDetail");
  if (!box) return;
  const item = (mgmt.data.requests || []).find((i) => i.id === mgmt.selected);
  if (!item) { box.innerHTML = `<p class="subtitle">Escolha uma solicitação na lista ou crie uma nova.</p>`; return; }
  const manager = mgmtIsManager();
  const closed = MGMT_CLOSED.includes(item.status);
  const type = mgmtType(item.kind);
  const st = MGMT_STATUS[item.status] || MGMT_STATUS.aberta;
  const actions = closed ? "" : manager
    ? `<button type="button" data-mg-status="aprovada">Aprovar</button><button type="button" class="ghost-button" data-mg-status="ajuste">Pedir ajuste</button><button type="button" class="ghost-button mg-danger" data-mg-status="recusada">Recusar</button><button type="button" class="ghost-button" data-mg-status="concluida">Concluir</button>`
    : `<button type="button" class="ghost-button" data-mg-status="concluida">Marcar como concluída</button>`;
  box.innerHTML = `
    <div class="mg-detail-head">
      <div>${mgmtKindChip(type)} ${mgmtChip(st.label, st.tone)}
        <h3>${escapeHtml(item.title)}</h3>
        <small class="subtitle">${escapeHtml(mgmtFrom(item))} · aberta em ${mgmtWhen(item.created_at)}</small></div>
      <div class="mg-detail-actions">${actions}</div>
    </div>
    ${mgmtFieldsHtml(item)}
    <div class="mg-timeline">${item.messages.map((m) => `
      <div class="mg-msg${m.author_key === mgmt.data.me.key ? " mine" : ""}">
        <div class="mg-msg-head"><strong>${escapeHtml(m.author_name || mgmtPerson(m.author_key))}</strong><small>${mgmtWhen(m.created_at)}</small></div>
        ${m.body ? `<p>${escapeHtml(m.body)}</p>` : ""}
        ${(m.files || []).length ? `<div class="mg-files">${m.files.map((f) => f.removed_at
          ? `<span class="mg-file removed" title="Removido do servidor em ${mgmtWhen(f.removed_at)} por ${escapeHtml(f.removed_by || "")}">📎 ${escapeHtml(f.name)} · removido (no Drive)</span>`
          : `<button type="button" class="mg-file" data-mg-file="${f.id}" title="Baixar o arquivo">📎 ${escapeHtml(f.name)} <small>${mgmtSize(f.size)}</small></button>`).join("")}</div>` : ""}
      </div>`).join("")}
    </div>
    ${closed ? `<p class="subtitle">Solicitação encerrada (${st.label.toLowerCase()}).</p>` : `
    <div class="mg-reply">
      <textarea id="mgReply" placeholder="Escreva uma resposta. O texto também vai junto ao ${manager ? "aprovar, pedir ajuste ou recusar" : "marcar como concluída"}."></textarea>
      <div class="mg-reply-bar">
        <label class="ghost-button mg-attach">Anexar arquivo<input id="mgReplyFiles" type="file" multiple hidden></label>
        <span id="mgReplyPicked" class="subtitle"></span>
        <button type="button" data-mg="reply" id="mgReplySend">Enviar</button>
      </div>
    </div>`}`;
}

function mgmtShowPicked(input, targetId) {
  const files = [...(input.files || [])];
  const target = document.getElementById(targetId);
  if (target) target.textContent = files.map((file) => `${file.name} (${mgmtSize(file.size)})`).join(", ");
}


const MGMT_PART = 1048576;
function mgmtPartBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("Não foi possível ler o arquivo."));
    reader.readAsDataURL(blob);
  });
}

async function mgmtUploadFiles(input, progress = () => {}) {
  const files = [...(input?.files || [])];
  if (files.length > 5) throw new Error("Até 5 arquivos por mensagem.");
  if (files.reduce((sum, file) => sum + file.size, 0) > 2 * MGMT_PART) throw new Error("Os anexos passam de 2 MB por mensagem. Envie arquivos menores.");
  const empty = files.find((file) => !file.size);
  if (empty) throw new Error(`O arquivo ${empty.name} está vazio.`);
  const total = files.reduce((sum, file) => sum + Math.ceil(file.size / MGMT_PART), 0);
  const out = [];
  let sent = 0;
  for (const file of files) {
    const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    for (let part = 0; part * MGMT_PART < file.size; part += 1) {
      const data = await mgmtPartBase64(file.slice(part * MGMT_PART, (part + 1) * MGMT_PART));
      await mgmtRpc("rt_mgmt_talk", { p_action: "file.part", p_data: { upload_key: key, part, data } });
      progress(++sent, total);
    }
    out.push({ upload_key: key, name: file.name, mime: file.type || "application/octet-stream" });
  }
  return out;
}

async function mgmtDownload(fileId) {
  document.body.style.cursor = "progress";
  try {
    const chunks = [];
    let first = null;
    for (let part = 0; !first || part < first.parts; part += 1) {
      const piece = await mgmtRpc("rt_mgmt_file", { p_file_id: fileId, p_part: part });
      first = first || piece;
      const bin = atob(piece.data || "");
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      chunks.push(bytes);
    }
    const url = URL.createObjectURL(new Blob(chunks, { type: first.mime || "application/octet-stream" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = first.name || "arquivo";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (error) {
    alert(error.message);
  } finally {
    document.body.style.cursor = "";
  }
}

async function mgmtReply() {
  const item = (mgmt.data.requests || []).find((i) => i.id === mgmt.selected);
  const text = document.getElementById("mgReply")?.value.trim() || "";
  const input = document.getElementById("mgReplyFiles");
  if (!item || (!text && !input?.files?.length)) return;
  const send = document.getElementById("mgReplySend");
  const label = (value, disabled = true) => { if (send) { send.disabled = disabled; send.textContent = value; } };
  label("Enviando…");
  let files;
  try {
    files = await mgmtUploadFiles(input, (n, total) => label(`Enviando anexos ${n}/${total}…`));
  } catch (error) {
    alert(error.message);
    label("Enviar", false);
    return;
  }
  await mgmtTalk("request.reply", { id: item.id, text, files }).catch(() => label("Enviar", false));
}

function mgmtSetStatus(next) {
  const item = (mgmt.data.requests || []).find((i) => i.id === mgmt.selected);
  if (!item) return;
  const reply = document.getElementById("mgReply");
  const text = reply?.value.trim() || "";
  if (next === "ajuste" && !text) { alert("Escreva no campo de resposta o que precisa ser ajustado."); reply?.focus(); return; }
  if (next === "recusada" && !confirm(`Recusar "${item.title}"?`)) return;
  mgmtTalk("request.status", { id: item.id, status: next, text }).catch(() => {});
}

function mgmtRenderNotices() {
  const box = document.getElementById("mgSection");
  if (!box) return;
  const nt = mgmt.nt;
  box.innerHTML = `
    <div class="card mg-filters-row">
      <select id="mgNtCat"><option value="">Todas as categorias</option>${mgmtCategories(true).map((c) => `<option value="${escapeHtml(c.key)}"${nt.cat === c.key ? " selected" : ""}>${escapeHtml(c.label)}${c.active === false ? " (desativada)" : ""}</option>`).join("")}</select>
      <label>De<input type="date" id="mgNtFrom" value="${escapeHtml(nt.from)}"></label>
      <label>Até<input type="date" id="mgNtTo" value="${escapeHtml(nt.to)}"></label>
      <input type="search" id="mgNtQuery" placeholder="Buscar no título ou no texto" value="${escapeHtml(nt.q)}">
      <button type="button" class="ghost-button" data-mg="nt-clear">Limpar filtros</button>
    </div>
    <div class="mg-notices" id="mgNoticeList"></div>`;
  mgmtRenderNoticeList();
}

function mgmtRenderNoticeList() {
  const box = document.getElementById("mgNoticeList");
  if (!box) return;
  const manager = mgmtIsManager();
  const me = mgmt.data.me;
  const many = (mgmt.data.teams || []).length > 1;
  const nt = mgmt.nt;
  const query = nt.q.trim().toLowerCase();
  const all = mgmt.data.notices || [];
  const list = all.filter((n) => {
    const day = new Date(n.created_at).toLocaleDateString("sv-SE");
    return (!nt.cat || (n.category || "geral") === nt.cat) && (!nt.from || day >= nt.from) && (!nt.to || day <= nt.to)
      && (!query || `${n.title} ${n.body}`.toLowerCase().includes(query));
  });
  box.innerHTML = list.map((n) => {
    const cat = mgmtCategory(n.category || "geral");
    const readers = new Set((n.readers || []).map((r) => r.key));
    const pending = (n.audience || []).filter((p) => !readers.has(p.key));
    const unread = !manager && n.ask_confirm && !n.read_at;
    return `<article class="card mg-notice${unread ? " unread" : ""}">
      <div class="mg-msg-head"><span>${mgmtKindChip(cat)} <strong>${escapeHtml(n.title)}</strong></span><small>${escapeHtml(n.author_name || mgmtPerson(n.author_key))} · ${mgmtWhen(n.created_at)}${manager && many ? ` · para ${escapeHtml((n.team_keys || []).map(mgmtTeamName).join(", "))}` : ""}</small></div>
      <p>${escapeHtml(n.body)}</p>
      ${mgmtModelDl(cat.model, n.fields)}
      <div class="mg-reply-bar">
        <small class="subtitle">${n.ask_confirm ? `Lido por ${(n.audience || []).filter((p) => readers.has(p.key)).length} de ${(n.audience || []).length}${manager && pending.length ? ` · falta: ${escapeHtml(pending.map((p) => p.name).join(", "))}` : ""}` : "Sem pedido de confirmação de leitura"}</small>
        <span class="mg-actions">${manager
          ? (n.author_key === me.key || me.role === "admin" ? `<button type="button" class="ghost-button mg-danger" data-mg-notice-del="${n.id}">Apagar</button>` : "")
          : !n.ask_confirm ? "" : n.read_at ? mgmtChip(`Você confirmou a leitura em ${mgmtWhen(n.read_at)}`, "ok") : `<button type="button" data-mg-read="${n.id}">Li e entendi</button>`}</span>
      </div>
    </article>`;
  }).join("") || `<div class="card mg-empty">${all.length ? "Nenhum comunicado com estes filtros." : `Nenhum comunicado ainda.${manager ? " Publique o primeiro em \"Novo comunicado\"." : ""}`}</div>`;
}

function mgmtRenderFiles() {
  const box = document.getElementById("mgSection");
  if (!box) return;
  const rows = (mgmt.data.requests || []).flatMap((item) => item.messages.flatMap((m) => (m.files || []).map((f) => ({ f, item, m }))))
    .sort((a, b) => String(b.m.created_at).localeCompare(String(a.m.created_at)));
  const admin = mgmt.data.me?.role === "admin";
  const storage = mgmt.data.storage || null;
  const usado = storage ? Math.min(100, Math.round((Number(storage.used) || 0) / (Number(storage.limit) || 1) * 100)) : 0;
  const espaco = storage ? `<div class="mg-storage${usado >= 90 ? " cheio" : ""}">
      <div class="mg-row-end"><strong>Espaço dos anexos: ${mgmtSize(storage.used)} de ${mgmtSize(storage.limit)} (${usado}%)</strong>
        <span class="subtitle">${usado >= 90 ? "Quase cheio: o admin baixa os antigos, guarda no Drive e remove aqui." : mgmtAttachInfo()}</span></div>
      <div class="mg-storage-bar"><span style="width:${usado}%"></span></div></div>` : "";
  box.innerHTML = `<section class="card">${espaco}<div class="mg-table-wrap"><table class="mg-table">
    <thead><tr><th>Arquivo</th><th>Solicitação</th><th>Hub</th><th>Enviado por</th><th>Quando</th><th></th></tr></thead>
    <tbody>${rows.map(({ f, item, m }) => {
      const type = mgmtType(item.kind);
      return `<tr>
      <td>${f.removed_at
        ? `<span class="mg-file removed" title="Removido do servidor em ${mgmtWhen(f.removed_at)} por ${escapeHtml(f.removed_by || "")}">📎 ${escapeHtml(f.name)} · removido</span>`
        : `<button type="button" class="mg-file" data-mg-file="${f.id}" title="Baixar o arquivo">📎 ${escapeHtml(f.name)}</button> <small class="subtitle">${mgmtSize(f.size)}</small>`}</td>
      <td>${mgmtKindChip(type)} ${escapeHtml(item.title)}</td>
      <td>${escapeHtml(safe(item.fields?.hub))}</td><td>${escapeHtml(m.author_name || mgmtPerson(m.author_key))}</td><td>${mgmtWhen(m.created_at)}</td>
      <td class="mg-actions"><button type="button" class="ghost-button" data-mg-go-req="${item.id}">Ver solicitação</button>${admin && !f.removed_at ? `<button type="button" class="ghost-button mg-danger" data-mg-file-del="${f.id}" data-mg-file-name="${escapeHtml(f.name)}" title="Depois de guardar no Drive">Remover</button>` : ""}</td></tr>`;
    }).join("") || `<tr><td colspan="6">Nenhum arquivo enviado ainda. Os anexos das solicitações aparecem aqui.</td></tr>`}</tbody></table></div></section>`;
}

function mgmtOpenRequestForm() {
  const dialog = mgmtDialog();
  const manager = mgmtIsManager();
  const teams = mgmt.data.teams || [];
  const types = mgmtTypes();
  dialog.innerHTML = `
    <form class="mg-form" id="mgForm">
      <div class="modal-header"><h2>Nova solicitação</h2><button type="button" data-close="mgmtDialog">Fechar</button></div>
      <div class="mg-form-row">
        <label>Tipo<select name="kind" id="mgFormType">${types.map((t) => `<option value="${escapeHtml(t.key)}">${escapeHtml(t.label)}</option>`).join("")}</select></label>
        ${manager
          ? `<label>Para o time<select name="team_key" required>${teams.length === 1 ? "" : `<option value="">Escolha o time</option>`}${teams.map((t) => `<option value="${escapeHtml(t.key)}">${escapeHtml(t.name)}</option>`).join("")}</select></label>`
          : `<label>Para<select name="to_group">${mgmtDestinations().map((d) => `<option value="${escapeHtml(d.key)}">${escapeHtml(d.label)}</option>`).join("")}</select></label>`}
      </div>
      <label>Assunto<input name="title" maxlength="200" placeholder="Ex.: HUB-LSP-26 Franca · AM na sexta às 00:00" required></label>
      ${mgmtModelFieldsHtml()}
      <label>Mensagem / motivo<textarea name="text"></textarea></label>
      <div class="mg-reply-bar">
        <label class="ghost-button mg-attach">Anexar arquivos (planilha de clusters, prints, PDF…)<input type="file" id="mgFormFiles" multiple hidden></label>
        <span id="mgFormPicked" class="subtitle"></span>
      </div>
      <div class="mg-row-end"><span class="subtitle">${mgmtAttachInfo()}</span><button type="submit" id="mgFormSend">Enviar solicitação</button></div>
    </form>`;
  const form = dialog.querySelector("#mgForm");
  const model = () => mgmtType(form.querySelector("#mgFormType").value).model || "nenhum";
  mgmtSyncModel(form, model());
  form.querySelector("#mgFormType").onchange = () => mgmtSyncModel(form, model());
  form.querySelector("#mgFormFiles").onchange = (event) => mgmtShowPicked(event.target, "mgFormPicked");
  form.onsubmit = async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const kind = data.get("kind");
    const fields = mgmtCollectFields(model(), data);
    const send = form.querySelector("#mgFormSend");
    send.disabled = true;
    send.textContent = "Enviando…";
    let files;
    try {
      files = await mgmtUploadFiles(form.querySelector("#mgFormFiles"), (n, total) => { send.textContent = `Enviando anexos ${n}/${total}…`; });
    } catch (error) {
      alert(error.message);
      send.disabled = false;
      send.textContent = "Enviar solicitação";
      return;
    }
    try {
      const result = await mgmtTalk("request.save", {
        kind, title: data.get("title"), to_group: data.get("to_group") || (mgmtDestinations()[0] || {}).key || "coordenacao",
        team_key: data.get("team_key") || "", text: data.get("text"), fields, files,
      });
      Object.assign(mgmt, { section: "solicitacoes", selected: result.id });
      Object.assign(mgmt.rq, { type: "", status: "", query: "" });
      dialog.close();
      mgmtRender();
    } catch (_) {
      send.disabled = false;
      send.textContent = "Enviar solicitação";
    }
  };
  if (!dialog.open) dialog.showModal();
}

function mgmtOpenNoticeForm() {
  const dialog = mgmtDialog();
  const teams = mgmt.data.teams || [];
  const cats = mgmtCategories();
  dialog.innerHTML = `
    <form class="mg-form" id="mgForm">
      <div class="modal-header"><h2>Novo comunicado</h2><button type="button" data-close="mgmtDialog">Fechar</button></div>
      <div class="mg-form-row">
        <label>Categoria<select name="category" id="mgFormCat">${cats.map((c) => `<option value="${escapeHtml(c.key)}">${escapeHtml(c.label)}</option>`).join("")}</select></label>
        <label>Título<input name="title" maxlength="200" required></label>
      </div>
      ${mgmtModelFieldsHtml()}
      <label>Mensagem<textarea name="text" required></textarea></label>
      ${teams.length > 1 ? `<div><span class="mg-form-label">Times que recebem</span><div class="mg-people">${teams.map((t) => `<label class="mg-check"><input type="checkbox" name="team" value="${escapeHtml(t.key)}" checked> ${escapeHtml(t.name)}</label>`).join("")}</div></div>` : ""}
      <label class="mg-check"><input type="checkbox" name="confirm" id="mgFormConfirm" checked> Pedir "Li e entendi" aos supervisores</label>
      <div class="mg-row-end"><button type="submit">Publicar comunicado</button></div>
    </form>`;
  const form = dialog.querySelector("#mgForm");
  const syncCat = () => {
    const cat = mgmtCategory(form.querySelector("#mgFormCat").value);
    mgmtSyncModel(form, cat.model || "nenhum");
    form.querySelector("#mgFormConfirm").checked = cat.confirm !== false;
  };
  syncCat();
  form.querySelector("#mgFormCat").onchange = syncCat;
  form.onsubmit = async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const teamKeys = teams.length > 1 ? data.getAll("team") : teams.map((t) => t.key);
    if (!teamKeys.length) { alert("Escolha pelo menos um time."); return; }
    const cat = mgmtCategory(data.get("category"));
    try {
      await mgmtTalk("notice.save", {
        title: data.get("title"), text: data.get("text"), ask_confirm: data.get("confirm") === "on", team_keys: teamKeys,
        category: cat.key, fields: mgmtCollectFields(cat.model || "nenhum", data),
      });
      mgmt.section = "comunicados";
      dialog.close();
      mgmtRender();
    } catch (_) { /* a mensagem já apareceu */ }
  };
  if (!dialog.open) dialog.showModal();
}

function mgmtOpenConfig() {
  const dialog = mgmtDialog();
  const modelos = (sel) => Object.entries(MGMT_MODELS).map(([k, v]) => `<option value="${k}"${k === sel ? " selected" : ""}>${escapeHtml(v)}</option>`).join("");
  const linhaLista = (item, extra) => `<div class="mg-config-row" data-key="${escapeHtml(item.key || "")}">
      <input class="cf-label" value="${escapeHtml(item.label || "")}" placeholder="Nome" maxlength="60">
      <input type="color" class="cf-color" value="${escapeHtml(item.color || "#64748b")}">
      ${extra.includes("model") ? `<select class="cf-model">${modelos(item.model || "nenhum")}</select>` : ""}
      ${extra.includes("suggest") ? `<label class="mg-check" title="Mostra analistas livres na janela, no Resumo da Visibilidade Schedule"><input type="checkbox" class="cf-suggest"${item.suggest ? " checked" : ""}> sugere analistas</label>` : ""}
      ${extra.includes("confirm") ? `<label class="mg-check"><input type="checkbox" class="cf-confirm"${item.confirm !== false ? " checked" : ""}> pede "Li e entendi"</label>` : ""}
      <label class="mg-check"><input type="checkbox" class="cf-active"${item.active !== false ? " checked" : ""}> ativo</label>
      <button type="button" class="ghost-button mg-danger" data-cf-del title="Tirar da lista (o que já foi usado só pode ser desativado)">✕</button>
    </div>`;
  const linhaColuna = (c) => `<div class="mg-config-row cf-col"><input class="cf-name" value="${escapeHtml(c.name || "")}" placeholder="Coluna" maxlength="60"><input type="color" class="cf-color" value="${escapeHtml(c.color || "#64748b")}"><label class="mg-check"><input type="checkbox" class="cf-done"${c.is_done ? " checked" : ""}> conta como concluída</label><button type="button" class="ghost-button mg-danger" data-cf-del>✕</button></div>`;
  const linhaEtiqueta = (l) => `<div class="mg-config-row cf-lab"><input class="cf-name" value="${escapeHtml(l.name || "")}" placeholder="Etiqueta" maxlength="40"><input type="color" class="cf-color" value="${escapeHtml(l.color || "#64748b")}"><button type="button" class="ghost-button mg-danger" data-cf-del>✕</button></div>`;
  const ws = mgmtSetting("workspace_defaults") || {};
  const att = mgmtSetting("attachments") || {};
  const sug = mgmtSetting("suggestions") || {};
  const bloco = (key, titulo, ajuda, corpo, add = "") => `<section class="mg-config-block" data-cf="${key}">
      <div class="mg-row-end"><h3>${titulo}</h3><span class="subtitle">${ajuda}</span></div>
      <div class="mg-config-list">${corpo}</div>
      <div class="mg-row-end">${add}<button type="button" data-cf-save="${key}">Salvar</button></div>
    </section>`;
  dialog.innerHTML = `
    <div class="mg-form">
      <div class="modal-header"><h2>Configurações do Gerenciamento</h2><button type="button" data-close="mgmtDialog">Fechar</button></div>
      <p class="subtitle">Valem para todos os times. O que já foi usado não pode ser apagado, só desativado (some dos formulários e continua no histórico).</p>
      ${bloco("notice_categories", "Categorias dos comunicados", "\"Sugere analistas\" mostra quem está livre na janela, no Resumo da Visibilidade Schedule.",
        mgmtCategories(true).map((c) => linhaLista(c, ["model", "suggest", "confirm"])).join(""), `<button type="button" class="ghost-button" data-cf-add="notice_categories">+ Categoria</button>`)}
      ${bloco("request_types", "Tipos de solicitação", "Os campos extras aparecem no formulário da solicitação.",
        mgmtTypes(true).map((t) => linhaLista(t, ["model", "suggest"])).join(""), `<button type="button" class="ghost-button" data-cf-add="request_types">+ Tipo</button>`)}
      ${bloco("destinations", "Destinos da solicitação (\"Para\")", "Para quem o supervisor manda.",
        mgmtDestinations(true).map((d) => linhaLista(d, [])).join(""), `<button type="button" class="ghost-button" data-cf-add="destinations">+ Destino</button>`)}
      ${bloco("workspace_defaults", "Áreas de trabalho: colunas e etiquetas padrão", "Valem para as áreas criadas depois.",
        `<p class="mg-form-label">Colunas</p><div class="cf-cols">${(ws.columns || []).map(linhaColuna).join("")}</div>
         <button type="button" class="ghost-button" data-cf-add="cf-col">+ Coluna</button>
         <p class="mg-form-label">Etiquetas</p><div class="cf-labs">${(ws.labels || []).map(linhaEtiqueta).join("")}</div>
         <button type="button" class="ghost-button" data-cf-add="cf-lab">+ Etiqueta</button>`)}
      ${bloco("attachments", "Anexos", "O espaço total é de todos os anexos juntos; os antigos vão para o Drive.",
        `<div class="mg-form-row"><label>Por mensagem (MB)<input type="number" class="cf-per" min="1" max="10" step="0.5" value="${att.per_message_mb ?? 2}"></label>
         <label>Total (MB)<input type="number" class="cf-total" min="10" max="400" value="${att.total_mb ?? 100}"></label>
         <label>Arquivos por mensagem<input type="number" class="cf-files" min="1" max="10" value="${att.max_files ?? 5}"></label></div>`)}
      ${bloco("suggestions", "Sugestões de analistas (Visibilidade Schedule)", "Hub atrasado = operação de hoje sem início depois destes minutos.",
        `<div class="mg-form-row"><label>Hub atrasado após (min)<input type="number" class="cf-late" min="1" max="120" value="${sug.late_minutes ?? 10}"></label>
         <label>Nomes por grupo<input type="number" class="cf-max" min="1" max="10" value="${sug.max_per_group ?? 3}"></label></div>`)}
    </div>`;
  dialog.querySelectorAll("[data-cf-add]").forEach((btn) => btn.addEventListener("click", () => {
    const alvo = btn.dataset.cfAdd;
    const tmp = document.createElement("div");
    if (alvo === "cf-col") { tmp.innerHTML = linhaColuna({}); dialog.querySelector(".cf-cols").appendChild(tmp.firstElementChild); return; }
    if (alvo === "cf-lab") { tmp.innerHTML = linhaEtiqueta({}); dialog.querySelector(".cf-labs").appendChild(tmp.firstElementChild); return; }
    const extra = alvo === "notice_categories" ? ["model", "suggest", "confirm"] : alvo === "request_types" ? ["model", "suggest"] : [];
    tmp.innerHTML = linhaLista({ active: true, confirm: true }, extra);
    dialog.querySelector(`[data-cf="${alvo}"] .mg-config-list`).appendChild(tmp.firstElementChild);
  }));
  dialog.addEventListener("click", (event) => {
    const del = event.target.closest("[data-cf-del]");
    if (del) del.closest(".mg-config-row").remove();
  });
  dialog.querySelectorAll("[data-cf-save]").forEach((btn) => btn.addEventListener("click", async () => {
    const key = btn.dataset.cfSave;
    const sec = dialog.querySelector(`[data-cf="${key}"]`);
    let value;
    if (["notice_categories", "request_types", "destinations"].includes(key)) {
      const used = new Set([...sec.querySelectorAll(".mg-config-row")].map((r) => r.dataset.key).filter(Boolean));
      value = [...sec.querySelectorAll(".mg-config-row")].map((r) => {
        const label = r.querySelector(".cf-label").value.trim();
        let k = r.dataset.key;
        if (!k) { k = mgmtSlug(label, used); used.add(k); }
        const item = { key: k, label, color: r.querySelector(".cf-color").value, active: r.querySelector(".cf-active").checked };
        if (r.querySelector(".cf-model")) item.model = r.querySelector(".cf-model").value;
        if (r.querySelector(".cf-suggest")) item.suggest = r.querySelector(".cf-suggest").checked;
        if (r.querySelector(".cf-confirm")) item.confirm = r.querySelector(".cf-confirm").checked;
        return item;
      });
    } else if (key === "workspace_defaults") {
      value = {
        columns: [...sec.querySelectorAll(".cf-col")].map((r) => ({ name: r.querySelector(".cf-name").value.trim(), color: r.querySelector(".cf-color").value, is_done: r.querySelector(".cf-done").checked })).filter((c) => c.name),
        labels: [...sec.querySelectorAll(".cf-lab")].map((r) => ({ name: r.querySelector(".cf-name").value.trim(), color: r.querySelector(".cf-color").value })).filter((l) => l.name),
      };
    } else if (key === "attachments") {
      value = { per_message_mb: Number(sec.querySelector(".cf-per").value), total_mb: Number(sec.querySelector(".cf-total").value), max_files: Number(sec.querySelector(".cf-files").value) };
    } else {
      value = { late_minutes: Number(sec.querySelector(".cf-late").value), max_per_group: Number(sec.querySelector(".cf-max").value) };
    }
    btn.disabled = true;
    try {
      await mgmtTalk("settings.save", { key, value });
      mgmtOpenConfig();
    } catch (_) {
      btn.disabled = false;
    }
  }));
  if (!dialog.open) dialog.showModal();
}



const RT_VISIBILIDADE_CSS = String.raw`:host{display:block}
:host{
  --bg:#fff7f3; --card:#ffffff; --surface:#f8fafc; --line:#e5e7eb; --line-soft:#eef0f3;
  --ink:#111827; --ink-2:#64748b; --ink-3:#94a3b8;
  --accent:#ee4d2d; --accent-ink:#ffffff; --row-hover:#fff0eb;
  --jornada:#10b98114; --jornada-bd:#10b98155;
  --st-run:#10b981; --busy:#2563eb; --part:#94a3b8; --st-crit:#dc2626;
  --ceia:rgba(242,138,46,.32); --ceia-bd:rgba(242,138,46,.75); --ceia-ink:#8a3f05;
  --hatch:#e2e8f0; --hatch-2:#f8fafc;
  --heat-0:#f1f5f9; --heat-1:#c9f1df; --heat-2:#8fe0bc; --heat-3:#3cc48f; --heat-4:#0e9f6e;
  --shadow:0 10px 30px #1118270d;
}
:host([data-theme="dark"]){
  --bg:#111827; --card:#172033; --surface:#202b40; --line:#334155; --line-soft:#26324a;
  --ink:#f8fafc; --ink-2:#cbd5e1; --ink-3:#94a3b8; --row-hover:#243147;
  --jornada:#10b9811f; --jornada-bd:#10b98166;
  --st-run:#10b981; --busy:#3b82f6; --part:#64748b;
  --ceia:rgba(240,137,42,.30); --ceia-bd:rgba(240,137,42,.8); --ceia-ink:#ffcf9f;
  --hatch:#334155; --hatch-2:#1e293b;
  --heat-0:#1e293b; --heat-1:#134e3a; --heat-2:#11704f; --heat-3:#0f9466; --heat-4:#10b981;
  --shadow:0 10px 30px #02061740;
}
*{box-sizing:border-box}
[hidden]{display:none!important}
:host{margin:0;background:var(--bg);color:var(--ink);font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
.wrap{max-width:1600px;margin:0 auto;padding:20px 16px 40px}
header.top{display:flex;flex-wrap:wrap;gap:12px 20px;align-items:flex-start;justify-content:space-between;padding-bottom:14px;border-bottom:1px solid var(--line)}
h1{font-size:22px;margin:0 0 4px;letter-spacing:-.01em}
.sub{color:var(--ink-2);margin:0}
.updated{color:var(--ink-3);font-size:12px;margin-top:4px}
.nav{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
button,select,input{font:inherit;color:inherit}
.btn{border:1px solid var(--line);background:var(--card);border-radius:10px;padding:8px 14px;cursor:pointer;font-weight:600;box-shadow:var(--shadow)}
.btn:hover{border-color:var(--ink-3)}
.btn.icon{width:40px;height:38px;padding:0;color:var(--accent);font-size:13px}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.btn.ghost-accent{color:var(--accent)}
.date-label{min-width:170px;text-align:center;font-weight:700}
.date-label small{display:block;font-weight:500;color:var(--ink-3);font-size:11px}
.filters{display:flex;flex-wrap:wrap;gap:10px 14px;align-items:center;margin:14px 0}
.seg{display:inline-flex;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:3px;flex-wrap:wrap}
.seg button{border:0;background:transparent;padding:6px 12px;border-radius:7px;cursor:pointer;color:var(--ink-2);font-weight:600}
.seg button[aria-pressed="true"]{background:var(--ink);color:var(--card)}
.field{display:flex;align-items:center;gap:6px;color:var(--ink-2);font-size:13px}
.field select,.field input{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:7px 10px;color:var(--ink)}
.field input{width:200px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:14px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;box-shadow:var(--shadow)}
.kpi .k{color:var(--ink-2);font-size:12px;font-weight:600}
.kpi .v{font-size:26px;font-weight:700;margin-top:2px;font-variant-numeric:tabular-nums}
.kpi .h{color:var(--ink-3);font-size:12px}
.kpi.alert .v{color:var(--st-crit)}
.legend{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;color:var(--ink-2);font-size:12px;font-weight:600;margin-bottom:10px}
.legend .sw{display:inline-block;width:14px;height:12px;border-radius:3px;vertical-align:-2px;margin-right:5px}
.sw.j{background:var(--jornada);border:1px solid var(--jornada-bd)}
.sw.done{background:var(--st-done)} .sw.run{background:var(--st-run)} .sw.next{background:var(--st-next)} .sw.plan{background:var(--st-plan)}
.sw.off{background:repeating-linear-gradient(135deg,var(--hatch) 0 4px,var(--hatch-2) 4px 8px)}
.sw.unk{border:1.5px dashed var(--ink-3)}
.sw.conf{border:2px solid var(--st-crit)}
.board{background:var(--card);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);overflow:hidden}
.scroller{overflow:auto;max-height:calc(100vh - 120px)}
.grid{position:relative;min-width:100%}
.row{display:flex;border-bottom:1px solid var(--line-soft);position:relative}
.row:last-child{border-bottom:0}
.who{position:sticky;left:0;z-index:3;background:var(--card);width:270px;min-width:270px;padding:8px 12px;border-right:1px solid var(--line);display:flex;flex-direction:column;justify-content:center}
.who .n,.who .m{flex-shrink:0}
.who .n{font-weight:700;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.who .m{color:var(--ink-3);font-size:11px;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.tag{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:0 6px;font-size:10px;font-weight:700;color:var(--ink-2)}
.tag.warn{border-color:var(--st-crit);color:var(--st-crit)}
.track{position:relative;flex:1 0 auto}
.head{position:sticky;top:0;z-index:5;background:var(--surface);border-bottom:1px solid var(--line)}
.head .who{background:var(--surface);color:var(--ink-2);font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
.tick{position:absolute;top:0;bottom:0;border-left:1px solid var(--line-soft)}
.tick.lab{color:var(--ink-2);font-size:11px;font-weight:700;padding:10px 0 0 5px}
.vline{position:absolute;top:0;bottom:0;width:0;border-left:1px solid var(--line-soft);pointer-events:none}
.vline.half{border-left-style:dotted;opacity:.7}
.now{position:absolute;top:0;bottom:0;border-left:2px solid var(--st-crit);z-index:4;pointer-events:none}
.now span{position:absolute;top:21px;left:4px;font-size:10px;font-weight:700;color:var(--st-crit);white-space:nowrap;background:var(--surface);padding:0 3px;border-radius:3px}
.bar{position:absolute;border-radius:6px}
.bar.j{background:var(--jornada);border:1px solid var(--jornada-bd)}
.bar.nosched{border-style:dashed;display:flex;align-items:center;padding-left:10px;font-size:11px;font-weight:700;color:var(--ink-2)}
.bar.off{background:repeating-linear-gradient(135deg,var(--hatch) 0 6px,var(--hatch-2) 6px 12px);display:flex;align-items:center;padding-left:8px;font-size:11px;font-weight:700;color:var(--ink-2)}
.bar.tbd{border:1.5px dashed var(--ink-3);background:transparent;display:flex;align-items:center;padding-left:8px;font-size:11px;color:var(--ink-3);font-weight:600}
.rt{position:absolute;border-radius:6px;font-size:11px;font-weight:700;display:flex;align-items:center;padding:0 6px;white-space:nowrap;overflow:hidden;cursor:default;box-shadow:0 0 0 2px var(--card);z-index:2}
.rt.win{background:var(--st-run);color:#fff}
.rt.ceia{background:var(--ceia);color:var(--ceia-ink);border:1px solid var(--ceia-bd);box-shadow:none;justify-content:center}
.rt.unk{background:var(--card);color:var(--ink-2);border:1.5px dashed var(--ink-3)}
.rt.conf{outline:2px solid var(--st-crit);outline-offset:1px}
.rt .x{margin-left:4px}
.avail .who{padding:4px 12px}.avail .who .n{font-size:12px}.avail .who .m{font-size:10px}
.cell{position:absolute;top:6px;bottom:6px;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;cursor:default}
.empty{padding:40px;text-align:center;color:var(--ink-3)}
#tip{position:fixed;z-index:50;pointer-events:none;background:var(--ink);color:var(--card);border-radius:10px;padding:9px 11px;font-size:12px;max-width:320px;box-shadow:0 6px 20px rgba(0,0,0,.2);display:none}
#tip b{display:block;font-size:13px;margin-bottom:2px}
#tip .r{display:flex;justify-content:space-between;gap:14px}
#tip .r span:first-child{opacity:.7}
.tablewrap{display:none;overflow:auto}
.tablewrap table{border-collapse:collapse;width:100%;font-size:12px}
.tablewrap th,.tablewrap td{border-bottom:1px solid var(--line-soft);padding:7px 10px;text-align:left;vertical-align:top}
.tablewrap th{position:sticky;top:0;background:var(--surface);font-size:11px;text-transform:uppercase;color:var(--ink-2)}
.loading{padding:60px;text-align:center;color:var(--ink-2)}
.sw.nowl{width:2px;height:14px;border-radius:0;background:var(--st-crit)}
.tabs{display:flex;gap:4px;margin-top:14px;border-bottom:1px solid var(--line)}
.tabs button{border:0;background:none;padding:10px 16px;font-weight:700;color:var(--ink-2);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.tabs button[aria-selected="true"]{color:var(--ink);border-bottom-color:var(--accent)}
.dgrid{display:grid;grid-template-columns:minmax(0,1fr);gap:14px}
.card,.lists>div{min-width:0}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);padding:16px}
.card h2{font-size:15px;margin:0 0 2px}
.card .cs{color:var(--ink-3);font-size:12px;margin:0 0 12px}
.chartwrap{overflow-x:auto}
.chartwrap svg{display:block}
.chartwrap .hit{cursor:pointer}
.ax{font-size:11px;fill:var(--ink-2)}
.ax2{font-size:10px;fill:var(--ink-3)}
.vlab{font-size:10px;font-weight:700;fill:var(--ink-2)}
.clegend{display:flex;gap:16px;font-size:12px;color:var(--ink-2);font-weight:600;margin-bottom:8px;flex-wrap:wrap}
.clegend i{display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:-2px;margin-right:5px}
.hm{border-collapse:separate;border-spacing:2px;font-size:11px}
.hm th{font-weight:700;color:var(--ink-2);text-align:left;padding:0 8px 0 0;white-space:nowrap}
.hm thead th{text-align:center;font-weight:600;color:var(--ink-3);padding:0 0 4px}
.hm td{min-width:34px;height:28px;text-align:center;border-radius:4px;font-weight:700;font-variant-numeric:tabular-nums;cursor:pointer}
.hm td.sel,.hm th.sel{outline:2px solid var(--ink);outline-offset:-1px}
.lists{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr));gap:14px}
.plist{list-style:none;margin:0;padding:0;max-height:420px;overflow:auto}
.plist li{display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px solid var(--line-soft);font-size:13px}
.plist li:last-child{border-bottom:0}
.plist .r{color:var(--ink-3);font-size:12px;text-align:right;white-space:nowrap}
.pill{display:inline-block;border-radius:999px;padding:1px 8px;font-size:11px;font-weight:700;background:var(--heat-0);color:var(--ink-2);margin-left:6px}
.slotpick{font-size:20px;font-weight:700}
.hbars{display:grid;grid-template-columns:minmax(0,1fr);gap:2px;max-height:520px;overflow:auto}
.hbrow{display:grid;grid-template-columns:minmax(140px,300px) minmax(80px,1fr) 150px;gap:12px;align-items:center;padding:4px 0;border-bottom:1px solid var(--line-soft);cursor:default}
.hbn{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hbt{display:flex;align-items:center;gap:6px;height:18px}
.hbb{height:14px;background:var(--st-run);border-radius:0 4px 4px 0}
.hbv{font-size:12px;font-weight:700;font-variant-numeric:tabular-nums}
.hbx{font-size:12px;color:var(--ink-3);text-align:right}
.hst{display:flex;height:14px;border-radius:4px;overflow:hidden;background:var(--heat-0);gap:2px}
.hst span{display:block;height:100%}
.hbrow.hrs{grid-template-columns:minmax(140px,300px) minmax(80px,1fr) 200px}
.htab{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}
.htab th,.htab td{padding:8px 10px;border-bottom:1px solid var(--line-soft);text-align:right;white-space:nowrap}
.htab th:first-child{text-align:left}
.htab thead th{font-size:11px;color:var(--ink-2);text-transform:uppercase;font-weight:700}
.htab td:last-child{width:30%}
.htab tr.tot th,.htab tr.tot td{border-top:2px solid var(--line);font-weight:700}
.hbrow.reg{cursor:pointer;grid-template-columns:minmax(80px,140px) minmax(80px,1fr) 230px}
.hbrow.reg:hover .hbn{text-decoration:underline}
@media (max-width:720px){.hbrow{grid-template-columns:minmax(0,1fr) 90px}.hbx{display:none}}
@media (max-width:720px){
  .who{width:170px;min-width:170px}
  .field input{width:150px}
  .date-label{min-width:130px}
}
@media print{
  @page{size:A3 landscape;margin:8mm}
  .tabs{display:none}
  :host{background:#fff}
  .filters,.nav,.noprint{display:none!important}
  .scroller{max-height:none;overflow:visible}
  .board{box-shadow:none}
  .rt,.bar,.cell{-webkit-print-color-adjust:exact;print-color-adjust:exact}
}

/* ===== Layout "Visibilidade do coordenador" ===== */
:host{font-family:Inter,"Segoe UI",Arial,sans-serif}
:host{background:var(--bg)}
.wrap{max-width:1440px;padding:20px 30px 40px}
button,select,input{font-family:inherit}
header.hero{position:sticky;top:0;z-index:15;background:linear-gradient(135deg,#62b8ed,#ffc36f 70%,#ff8659);color:#172033;padding:18px 30px;box-shadow:0 16px 42px #ee4d2d33}
:host([data-theme="dark"]) header.hero{background:linear-gradient(135deg,#071226,#15264f 62%,#4c3270);color:#fff;box-shadow:0 16px 42px #02061770}
.hero .top{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;max-width:1440px;margin:0 auto}
.brand{display:flex;align-items:center;gap:14px}
.logo{width:46px;height:46px;border-radius:14px;background:#fff;color:var(--accent);display:grid;place-items:center;font-weight:900}
.hero h1{font-size:24px;line-height:1.1;margin:0}
.hero .sub{margin:4px 0 0;font-size:13px;color:#26364d;font-weight:650}
:host([data-theme="dark"]) .hero .sub{color:#fff7ed;font-weight:500}
.hero .actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.hero .hbtn{border:1px solid #17203330;border-radius:12px;padding:10px 14px;font-weight:800;font-size:14px;background:#ffffff70;color:#172033;cursor:pointer}
:host([data-theme="dark"]) .hero .hbtn{background:#ffffff22;color:#fff;border-color:#ffffff55}
.hero .hbtn.primary{background:#fff;color:var(--accent);border-color:#fff}
.hero .hbtn.theme{width:42px;height:42px;padding:0;border-radius:50%;font-size:18px}
.barra{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px}
nav.tabs{display:flex;gap:6px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:4px;margin:0}
nav.tabs button{border:0;border-radius:12px;padding:10px 14px;font-weight:800;font-size:14px;background:transparent;color:var(--ink-2);margin:0}
nav.tabs button[aria-selected="true"]{background:var(--accent);color:#fff;border:0}
.nav{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.btn{border:1px solid var(--line);background:var(--card);color:var(--accent);border-radius:12px;padding:10px 14px;font-weight:800;font-size:14px;box-shadow:none}
.btn:hover{background:var(--row-hover);border-color:var(--line)}
.btn.icon{width:42px;height:42px}
.date-label{min-width:190px;font-weight:800;color:var(--ink)}
.date-label small{color:var(--ink-2);font-weight:600}
.filters{gap:10px;margin:0 0 14px;align-items:flex-end}
.field{display:grid;gap:4px;font-size:11px;font-weight:900;color:var(--ink-2);text-transform:uppercase}
.field select,.field input{border-radius:12px;padding:10px 14px;font-weight:700;font-size:14px;min-width:160px;text-transform:none;border:1px solid var(--line);background:var(--card);color:var(--ink)}
.field input{min-width:220px}
.seg{border-radius:14px;padding:4px;gap:4px}
.seg button{border-radius:12px;padding:9px 14px;font-weight:800;color:var(--ink-2)}
.seg button[aria-pressed="true"]{background:var(--accent);color:#fff}
.kpis{grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:16px}
.kpi{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:12px 14px;box-shadow:none}
.kpi .k{font-size:12px;font-weight:800;color:var(--ink-2)}
.kpi .v{font-size:34px;font-weight:900;line-height:1.1;margin-top:4px}
.kpi .h{color:var(--ink-2)}
.kpi:first-child{background:var(--card);border-color:var(--st-run);box-shadow:inset 4px 0 0 var(--st-run)}
.kpi.alert .v{color:var(--st-crit)}
.legend{font-size:11px;font-weight:800;color:var(--ink-2);gap:8px 12px}
.legend .sw{width:12px;height:12px;border-radius:4px}
.sw.j{background:var(--jornada);border:1px dashed var(--jornada-bd)}
.sw.run{background:var(--st-run)}
.sw.off{background:repeating-linear-gradient(45deg,#cbd5e1,#cbd5e1 3px,#f8fafc 3px,#f8fafc 6px)}
.board,.card{background:var(--card);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow)}
.card{padding:18px 20px}
.board{padding:14px}
.scroller{border:1px solid var(--line);border-radius:14px;max-height:68vh}
.who{background:var(--card);border-right:1px solid var(--line);padding:8px 10px}
.who .n{font-size:12px;font-weight:800}
.who .m{color:var(--ink-2);font-weight:600}
.head,.head .who{background:var(--card)}
.head .who{font-size:11px;font-weight:900;color:var(--ink-2)}
.tick.lab{font-size:10px;font-weight:800;color:var(--ink-2)}
.row{border-bottom:1px solid var(--line)}
.vline{border-left-color:var(--line)}
.bar.j{background:var(--jornada);border:1px dashed var(--jornada-bd);border-radius:9px}
.bar.off{background:repeating-linear-gradient(45deg,var(--hatch),var(--hatch) 6px,var(--hatch-2) 6px,var(--hatch-2) 12px);color:#475569;border-radius:9px}
:host([data-theme="dark"]) .bar.off{color:#e2e8f0}
.rt{border-radius:7px;font-weight:800;box-shadow:0 4px 10px #11182722}
.rt.win{background:var(--st-run);color:#fff}
.rt.ceia{box-shadow:none}
.rt.desc{background:var(--card);color:var(--st-crit);border:1.5px dashed var(--st-crit);box-shadow:none}
.now{border-left-color:#ef4444}
.now span{color:#ef4444;background:var(--card)}
.tag{border-radius:999px;font-weight:800}
.card h2{font-size:20px;margin:0}
.card .cs{color:var(--ink-2);font-size:13px;margin:4px 0 12px}
.card h3{margin:0 0 10px;font-size:15px}
.card-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-top:14px}
.tile{border:1px solid var(--line);border-radius:14px;padding:12px 14px;background:var(--surface)}
.tile .rotulo{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--ink-2);font-weight:800}
.tile .rotulo i{width:10px;height:10px;border-radius:3px;display:inline-block}
.tile .valor{font-size:34px;font-weight:900;line-height:1.1;margin-top:4px;font-variant-numeric:tabular-nums}
.tile small{color:var(--ink-2);font-size:12px}
.tile.destaque{background:var(--card);border-color:var(--st-run);box-shadow:inset 4px 0 0 var(--st-run)}
.disp-grid{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:16px;align-items:start}
table.horas{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}
table.horas th{text-align:right;font-size:11px;color:var(--ink-2);font-weight:900;text-transform:uppercase;padding:6px 8px;border-bottom:1px solid var(--line)}
table.horas th:first-child,table.horas td:first-child{text-align:left}
table.horas td{text-align:right;padding:7px 8px;border-bottom:1px solid var(--line);font-weight:700}
table.horas tbody tr{cursor:pointer}
table.horas tbody tr:hover{background:var(--row-hover)}
table.horas tbody tr.sel{background:var(--row-hover);box-shadow:inset 3px 0 0 var(--accent)}
table.horas td.disp{font-weight:900;color:var(--ink)}
table.horas td.zero{color:var(--st-crit)}
.agora-tag{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:999px;background:#ef4444;color:#fff;font-size:10px;font-weight:900;vertical-align:1px}
td.barra-cel{width:30%}
.mini{display:flex;gap:2px;height:12px}
.mini span{display:block;height:100%;border-radius:4px}
.lista{display:grid;gap:6px;margin:0 0 14px;padding:0;list-style:none;max-height:340px;overflow:auto}
.lista li{display:flex;justify-content:space-between;gap:10px;padding:8px 10px;border:1px solid var(--line);border-radius:10px;font-size:13px}
.lista li b{font-weight:800}
.lista li small{color:var(--ink-2);text-align:right}
.grupo{display:flex;align-items:center;gap:6px;margin:4px 0 8px;font-size:12px;font-weight:900;text-transform:uppercase;color:var(--ink-2)}
.grupo i{width:10px;height:10px;border-radius:3px;display:inline-block}
.vazio-lista{color:var(--ink-2);font-size:13px;margin:0 0 14px}
.pill{background:var(--surface);border:1px solid var(--line)}
.hbb,.hst span:last-child{border-radius:4px}
@media (max-width:900px){header.hero{padding:16px}.wrap{padding:16px}.disp-grid{grid-template-columns:1fr}.date-label{min-width:0}}
@media print{header.hero,nav.tabs{display:none!important}}

/* Resumo (aba acrescentada pelo painel do Routing Tower) */
.rs-grid{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:16px;align-items:start;margin-bottom:16px}
@media (max-width:1000px){.rs-grid{grid-template-columns:minmax(0,1fr)}}
.rs-sup td:last-child{width:auto}
.rs-sup th,.rs-sup td{padding:7px 6px}
.rs-sup thead th{white-space:normal;vertical-align:bottom;line-height:1.2}
.rs-sup tbody tr[data-sup]{cursor:pointer}
.rs-sup tbody tr[data-sup]:hover th,.rs-sup tbody tr[data-sup]:hover td{background:var(--row-hover)}
.rs-hora th,.rs-hora td{padding:5px 8px}
.rs-hora td:last-child{width:34%}
.rs-hora tr.pico th,.rs-hora tr.pico td:first-of-type{color:var(--st-crit);font-weight:800}
.rs-hora tr.agora th,.rs-hora tr.agora td{background:var(--row-hover)}
.rs-hora tr.agora th{box-shadow:inset 3px 0 0 var(--st-run)}
.rs-att{display:grid;gap:6px;margin:0;padding:0;list-style:none;max-height:430px;overflow:auto}
.rs-att li{border:1px solid var(--line);border-left:4px solid var(--rs-c,var(--line));border-radius:10px;padding:8px 10px;font-size:13px;display:grid;gap:2px}
.rs-att li[data-ana]{cursor:pointer}
.rs-att li[data-ana]:hover{background:var(--row-hover)}
.rs-att b{font-size:12px;color:var(--rs-c,var(--ink))}
.rs-att small{color:var(--ink-2)}
.rs-chips{display:flex;flex-wrap:wrap;gap:6px}
.rs-chips span{border:1px solid var(--line);border-radius:999px;padding:4px 10px;font-size:12px;font-weight:700;color:var(--ink)}
.rs-dest{margin-bottom:16px}
.rs-dest .tiles{margin-top:10px}
.rs-dest .tile small{overflow:hidden;text-overflow:ellipsis}
.rs-two{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}
@media (max-width:700px){.rs-two{grid-template-columns:minmax(0,1fr)}}
.rs-h3{margin:12px 0 6px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.03em;color:var(--ink-2)}
.rs-two .rs-h3{margin-top:0}
.rs-mini{display:grid;gap:6px;margin:0;padding:0;list-style:none}
.rs-mini li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 10px;align-items:center;padding:7px 9px;border:1px solid var(--line);border-radius:10px;font-size:13px}
.rs-mini li[data-ana]{cursor:pointer}
.rs-mini li[data-ana]:hover{background:var(--row-hover)}
.rs-mini li small{grid-column:1/-1;color:var(--ink-2)}
.rs-mini li em{font-style:normal;font-weight:800;color:var(--ink);white-space:nowrap}
.rs-mini .hst{grid-column:1/-1;height:7px}
.rs-reg tbody tr{cursor:pointer}
.rs-reg tbody tr:hover th,.rs-reg tbody tr:hover td{background:var(--row-hover)}
.rs-reg td:last-child{width:auto;text-align:left;white-space:normal}
.rs-reg thead th:last-child{text-align:left}
.rs-reg tr.sel th{box-shadow:inset 3px 0 0 var(--accent);color:var(--accent)}
.rs-sug{margin-bottom:16px}
.rs-sug-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px;margin-top:10px}
.rs-sug-item{border:1px solid var(--line);border-left:4px solid var(--rs-c,var(--accent));border-radius:12px;padding:10px 12px;display:grid;gap:6px;align-content:start}
.rs-sug-item header{display:grid;gap:2px}
.rs-sug-item header b{font-size:13px;color:var(--rs-c,var(--ink))}
.rs-sug-item header small{color:var(--ink-2);font-size:12px}
.rs-sug-item .rs-h3{margin:6px 0 4px}
.rs-sug.vazio p{margin:4px 0 0}
.rs-aviso{margin:0 0 16px;padding:12px 14px;border:1px dashed var(--accent);border-radius:12px;font-size:13px;color:var(--ink)}
@media print{
  .card,.tile,.kpi,.rs-mini li,.rs-att li,.htab tr,.lista li,.hbrow,.grid .row,.rs-aviso{break-inside:avoid;page-break-inside:avoid}
  .rs-grid,.disp-grid,.dgrid{display:block}
  .rs-grid>.card,.disp-grid>.card,.dgrid>.card{margin-bottom:12px}
  .kpis,.tiles{break-inside:avoid}
  .rs-att,.rs-mini,.lista,.chartwrap{max-height:none;overflow:visible}
  .card{box-shadow:none}
}
`;
const RT_VISIBILIDADE_HTML = String.raw`<header class="hero">
  <div class="top">
    <div class="brand">
      <div class="logo">VS</div>
      <div>
        <h1>Visibilidade Schedule</h1>
        <p class="sub" id="updated">Jornada, janelas de roteirização e disponibilidade por analista</p>
      </div>
    </div>
    <div class="actions">
      <button type="button" class="hbtn" id="sheetBtn" title="Abrir a planilha Gestão T3">Planilha</button>
      <button type="button" class="hbtn" id="refreshBtn" title="Ler a planilha de novo">Atualizar</button>
      <button type="button" class="hbtn" id="viewToggle">Ver tabela</button>
      <button type="button" class="hbtn primary" id="pdf">Salvar PDF</button>
      
    </div>
  </div>
</header>
<div class="wrap">
  <div class="barra">
    <nav class="tabs" role="tablist" aria-label="Visões">
      <button role="tab" id="tabResumo" aria-selected="false">Resumo</button>
      <button role="tab" id="tabEscala" aria-selected="true">Prévia da escala</button>
      <button role="tab" id="tabDash" aria-selected="false">Disponibilidade</button>
      <button role="tab" id="tabAnalise" aria-selected="false">Análise</button>
    </nav>
    <div class="nav">
      <button class="btn icon" id="prev" title="Dia anterior" aria-label="Dia anterior">&#9664;</button>
      <div class="date-label" id="dateLabel"></div>
      <button class="btn icon" id="next" title="Próximo dia" aria-label="Próximo dia">&#9654;</button>
      <button class="btn" id="today">Hoje</button>
    </div>
  </div>

  <div class="filters">
    <div class="seg" id="supSeg" role="group" aria-label="Supervisor"></div>
    <label class="field">Região <select id="fRegion"><option value="">Todas</option></select></label>
    <label class="field">Turno <select id="fTurno"><option value="">Todos</option></select></label>
    <label class="field" id="sortField">Ordenar <select id="fSort">
      <option value="start">Início da jornada</option>
      <option value="name">Nome</option>
      <option value="sup">Supervisor</option>
      <option value="load">Mais janelas</option>
    </select></label>
    <div class="seg" id="stepSeg" role="group" aria-label="Intervalo" hidden><button type="button" data-v="30" aria-pressed="true">30 min</button><button type="button" data-v="60" aria-pressed="false">1 hora</button></div>
    <label class="field"><input id="fSearch" type="search" placeholder="Buscar analista ou hub"></label>
  </div>

  <div class="kpis" id="kpis"></div>

  <div id="viewEscala">
  <div class="legend">
    <span><i class="sw j"></i>Jornada (livre)</span>
    <span><i class="sw run"></i>Janela programada</span>
    <span><i class="sw unk"></i>Escala do hub não definida</span>
    <span><i class="sw off"></i>Folga / DSR / Férias</span>
    <span><i class="sw j"></i>Sem escala de hubs</span>
    <span><i class="sw" style="background:var(--ceia)"></i>Ceia (1h)</span>
    <span><i class="sw" style="border:1.5px dashed var(--st-crit)"></i>Hub sem cobertura</span>
    <span><i class="sw conf"></i>Conflito de janelas</span>
    <span><i class="sw nowl"></i>Agora</span>
  </div>

  <div class="board">
    <div class="card-header" style="margin:2px 4px 10px"><div><h2 style="font-size:20px;margin:0">Prévia da escala</h2><p class="cs" style="margin:4px 0 0;color:var(--ink-2);font-size:13px">Janelas por analista no dia. A faixa verde clara é a jornada: onde não há barra, o analista está livre.</p></div></div>
    <div class="scroller" id="scroller"><div class="loading">Carregando escala…</div></div>
    <div class="tablewrap" id="tablewrap"></div>
  </div>
  </div>
  <div id="viewDash" hidden></div>
  <div id="viewAnalise" hidden></div>
  <div id="viewResumo" hidden></div>
</div>
<div id="tip" role="tooltip"></div>`;
function rtVisibilidadeStart(root, host){
'use strict';
function visible(){ return host.classList.contains('active'); }
var SUPS = (window.RT_DEMO_DATA?.payload?.supervisors || ['Equipe Norte']).slice();
var DOW = ['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
var DAY_START = 12*60;            // o "dia operacional" começa às 12:00
var PX_MIN_PER_HOUR = 72;

var state = { records:[], analysts:[], date:null, sup:'', region:'', turno:'', sort:'start', q:'', table:false, updated:null, tab:'escala', step:30, selSlot:null };

/* ---------- utilidades ---------- */
function norm(s){ return String(s==null?'':s).trim(); }
function key(s){ return norm(s).toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/\s+/g,' '); }
function toMin(s){
  var m = /^(\d{1,2}):(\d{2})/.exec(norm(s)); if(!m) return null;
  return (+m[1])*60 + (+m[2]);
}
function op(t){ return t==null?null:(t<DAY_START? t+1440 : t); }
function fmt(m){ m=((m%1440)+1440)%1440; var h=Math.floor(m/60), mi=m%60; return (h<10?'0':'')+h+':'+(mi<10?'0':'')+mi; }
function dur(m){ var h=Math.floor(m/60), mi=m%60; return h? (h+'h'+(mi?(' '+mi+'min'):'')) : (mi+'min'); }
function esc(s){ return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
function spNow(){
  var p = new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date());
  var o={}; p.forEach(function(x){o[x.type]=x.value;});
  var h = +o.hour % 24;
  return { y:+o.year, mo:+o.month, d:+o.day, min: h*60 + (+o.minute) };
}
function opsToday(){
  var n = spNow(); var d = new Date(Date.UTC(n.y,n.mo-1,n.d));
  var m = n.min; if(m < DAY_START){ d.setUTCDate(d.getUTCDate()-1); m += 1440; }
  return { date:d, min:m };
}
function sameDay(a,b){ return a.getUTCFullYear()==b.getUTCFullYear() && a.getUTCMonth()==b.getUTCMonth() && a.getUTCDate()==b.getUTCDate(); }
function dLabel(d){ var dd=d.getUTCDate(), mm=d.getUTCMonth()+1; return DOW[d.getUTCDay()]+' · '+(dd<10?'0':'')+dd+'/'+(mm<10?'0':'')+mm+'/'+d.getUTCFullYear(); }

/* ---------- leitura dos dados ---------- */
function fromSheet(values){
  if(!values || !values.length) return [];
  var h = values[0].map(key);
  function col(){ for(var i=0;i<arguments.length;i++){ var k=key(arguments[i]); var ix=h.indexOf(k); if(ix>=0) return ix; } return -1; }
  var c = {
    ini:col('INICIO DO EXPEDIENTE','INICIO EXPEDIENTE'), fim:col('FIM EXPEDIENTE','FIM DO EXPEDIENTE'),
    sup:col('LIDERANÇA','LIDERANCA'), ana:col('ANALISTA'), reg:col('REGION'), sort:col('HUB_SORT_CODE'),
    hub:col('HUB_NAME'), shifts:col('HUB_Shifts'), jan:col('JANELA'), rti:col('INICIO_RT'), rtf:col('FIM_RT'),
    days:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(function(d){return col(d);})
  };
  var out=[];
  for(var r=1;r<values.length;r++){
    var v=values[r]; function g(ix){ return ix<0?'':norm(v[ix]); }
    if(!g(c.ana)) continue;
    out.push({ sup:g(c.sup), ini:g(c.ini), fim:g(c.fim), ana:g(c.ana), reg:g(c.reg), sort:g(c.sort),
      hub:g(c.hub), shifts:g(c.shifts), days:c.days.map(function(ix){return g(ix).toUpperCase();}),
      jan:g(c.jan), rti:g(c.rti), rtf:g(c.rtf) });
  }
  return out;
}
function fromPreview(txt){
  var map={A:'Equipe Norte',T:'Equipe Sul',V:'Equipe Leste',C:'Equipe Oeste'};
  return txt.trim().split('\n').map(function(l){
    var p=l.split('|');
    return { sup:map[p[0]]||p[0], ini:p[1], fim:p[2], ana:p[3], reg:p[4], sort:p[5], hub:p[6], shifts:p[7],
      days:(p[8]||'').split('').map(function(x){return x==='.'?'':x;}), jan:p[9], rti:p[10], rtf:p[11] };
  });
}

function fromTeam(values){
  if(!values || !values.length) return [];
  var h=values[0].map(key);
  function col(){ for(var i=0;i<arguments.length;i++){ var ix=h.indexOf(key(arguments[i])); if(ix>=0) return ix; } return -1; }
  var c={ini:col('INICIO'), fim:col('SAÍDA','SAIDA'), sup:col('LIDERANÇA','LIDERANCA'), name:col('Full Name','NOME'), office:col('Office'),
    status:col('STATUS'), ret:col('RETORNO (Férias, atestado)','RETORNO'), sup2:col('Suporte'), station:col('Station office'), from:col('INICIO AFASTAMENTO'), ceiaS:col('CEIA_INICIO'), ceiaE:col('CEIA_FIM'), since:col('ADMISSAO')};
  var out=[];
  for(var r=1;r<values.length;r++){ var v=values[r]; function g(ix){ return ix<0?'':norm(v[ix]); }
    if(!g(c.name)) continue;
    out.push({ini:g(c.ini), fim:g(c.fim), sup:g(c.sup), name:g(c.name), office:g(c.office), status:g(c.status), ret:g(c.ret), sup2:g(c.sup2), station:g(c.station).replace(/^LM Hub_/,''), from:g(c.from), ceiaS:g(c.ceiaS), ceiaE:g(c.ceiaE), since:g(c.since)});
  }
  return out;
}
function teamFromPreview(txt){
  var map={A:'Equipe Norte',T:'Equipe Sul',V:'Equipe Leste',C:'Equipe Oeste'};
  return (txt||'').trim().split('\n').filter(Boolean).map(function(l){ var p=l.split('|');
    return {sup:map[p[0]]||p[0], ini:p[1], fim:p[2], name:p[3], office:p[4], status:p[5], ret:p[6], sup2:p[7], station:p[8]}; });
}
function mergeTeam(analysts, team){
  var idx={}; analysts.forEach(function(a){ idx[key(a.name)]=a; });
  (team||[]).forEach(function(t){
    if(SUPS.indexOf(t.sup)<0) return;
    var a=idx[key(t.name)];
    if(!a){
      var s=op(toMin(t.ini)), e=op(toMin(t.fim)); if(s!=null && e!=null && e<=s) e+=1440;
      a={ name:t.name, sup:t.sup, shifts:{}, hubs:[], regions:{}, js:s, je:e, noSched:true, multiShift:false };
      analysts.push(a); idx[key(t.name)]=a;
    }
    a.team=t;
  });
  return analysts;
}
function build(records){
  var seen={}, by={};
  records.forEach(function(r){
    var sig=[r.ana,r.sort,r.hub,r.jan,r.rti,r.rtf].join('|'); if(seen[sig]) return; seen[sig]=1;
    if(r.ana.indexOf('|')>=0) return; // linhas com mais de um analista ficam fora
    var a = by[r.ana] || (by[r.ana] = { name:r.ana, sup:r.sup, shifts:{}, hubs:[], regions:{} });
    var s=op(toMin(r.ini)), e=op(toMin(r.fim));
    if(s!=null && e!=null){ if(e<=s) e+=1440; var k=s+'-'+e; a.shifts[k]=(a.shifts[k]||0)+1; }
    var valid = /^HUB-/i.test(r.sort);
    var rs=op(toMin(r.rti)), re=op(toMin(r.rtf));
    if(rs!=null && re!=null && re<=rs) re+=1440;
    a.hubs.push({ code: valid? r.sort : '', name: r.hub.replace(/^LM Hub_/,''), reg: valid? r.reg : '', shifts:r.shifts,
      days:r.days, jan:r.jan, s:rs, e:re, check: !valid });
    if(valid && r.reg) a.regions[r.reg]=1;
  });
  return Object.keys(by).map(function(n){
    var a=by[n], best=null, bc=-1;
    Object.keys(a.shifts).forEach(function(k){ if(a.shifts[k]>bc){bc=a.shifts[k];best=k;} });
    if(best){ var p=best.split('-'); a.js=+p[0]; a.je=+p[1]; }
    a.multiShift = Object.keys(a.shifts).length>1;
    return a;
  });
}

/* ---------- cálculo por dia ---------- */
function parseDate(s){ var m=/^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(norm(s)); return m? new Date(Date.UTC(+m[3],+m[2]-1,+m[1])) : null; }
function vacActive(a){
  if(!a.team || !/f[eé]rias|atestado|afast|licen/i.test(a.team.status||'')) return false;
  var f=parseDate(a.team.from); if(f && state.date < f) return false;
  var r=parseDate(a.team.ret); return !r || state.date < r;
}
function dayView(a, dow, nowMin){
  if(vacActive(a)){

    var dsc=a.hubs.filter(function(h){ return (h.days[dow]||'')==='E' && h.s!=null; }).map(function(h){ return { h:h, s:h.s, e:h.e, st:'desc', conf:false, out:false, lane:0 }; }).sort(function(p,q){return p.s-q.s;});
    var le=[]; dsc.forEach(function(b){ var l=0; while(le[l]!=null && le[l]>b.s) l++; b.lane=l; le[l]=b.e; });
    return { status:'vac', isOff:true, label:a.team.status+(a.team.ret?' · retorno '+a.team.ret:''), blocks:dsc, lanes:Math.max(1,le.length), on:[], off:[], unk:[], free:[] };
  }
  if(a.noSched){
    return { status:'nosched', isOff:false, label:'Sem escala de hubs', blocks:[], lanes:1, on:[], off:[], unk:[], free: a.js!=null?[[a.js,a.je]]:[] };
  }
  var on=[], off=[], unk=[];
  a.hubs.forEach(function(h){
    var v=(h.days[dow]||'');
    if(v==='E') on.push(h); else if(v==='D') off.push(h); else unk.push(h);
  });
  var status = on.length? 'work' : (unk.length? 'tbd' : 'off');
  var blocks = on.concat(unk).filter(function(h){return h.s!=null;}).map(function(h){
    var st = unk.indexOf(h)>=0 ? 'unk' : 'win';
    return { h:h, s:h.s, e:h.e, st:st, conf:false, out:false, lane:0 };
  }).sort(function(x,y){return x.s-y.s || x.e-y.e;});

  for(var i=0;i<blocks.length;i++){
    for(var j=i+1;j<blocks.length;j++){
      if(blocks[j].s < blocks[i].e && blocks[i].s < blocks[j].e && blocks[i].st!=='unk' && blocks[j].st!=='unk'){ blocks[i].conf=blocks[j].conf=true; }
    }
    if(a.js!=null && (blocks[i].s < a.js || blocks[i].e > a.je)) blocks[i].out=true;
  }

  var laneEnd=[];
  blocks.forEach(function(b){
    var l=0; while(laneEnd[l]!=null && laneEnd[l]>b.s) l++;
    b.lane=l; laneEnd[l]=b.e;
  });

  var free=[];
  if(a.js!=null && status!=='off'){
    var cur=a.js;
    blocks.filter(function(b){return b.st!=='unk';}).slice().sort(function(x,y){return x.s-y.s;}).forEach(function(b){
      var s=Math.max(b.s,a.js), e=Math.min(b.e,a.je);
      if(e<=s) return; if(s>cur) free.push([cur,s]); cur=Math.max(cur,e);
    });
    if(cur<a.je) free.push([cur,a.je]);
  }
  return { status:status, isOff:status==='off', label:'Folga / DSR', blocks:blocks, lanes:Math.max(1,laneEnd.length), on:on, off:off, unk:unk, free:free };
}
/* intervalos de horário: disponível = em jornada e sem nenhuma janela no intervalo */
function computeSlots(working, lo, hi, step){
  var out=[];
  for(var s=lo;s<hi;s+=step){
    var e=s+step, mid=s+step/2, free=[], busy=[], meal=[], win=0, bySup={};
    working.forEach(function(x){
      var a=x.a, v=x.v;
      var act=v.blocks.filter(function(b){return b.st!=='unk' && b.s<e && b.e>s;});
      win+=act.length;
      if(v.isOff || a.js==null || mid<a.js || mid>=a.je){ return; }
      if(act.length){ busy.push({a:a,v:v,b:act}); }
      else if(inCeia(v,s,e)){ meal.push({a:a,v:v}); }
      else {
        var nx=v.blocks.filter(function(b){return b.st!=='unk' && b.s>=e;}).sort(function(p,q){return p.s-q.s;})[0];
        var until=nx? nx.s : a.je;
        if(v.ceia && v.ceia.s>=e && v.ceia.s<until) until=v.ceia.s;
        free.push({a:a,v:v,until:until,next:nx||null});
        bySup[a.sup]=(bySup[a.sup]||0)+1;
      }
    });
    out.push({s:s,e:e,free:free,busy:busy,meal:meal,win:win,bySup:bySup});
  }
  return out;
}
/* ---------- ceia (1h) ----------
   Regras: 1h dentro do tempo livre da jornada; não começa nas 2 primeiras horas nem termina
   nas 2 últimas (relaxa para 1h se não couber); o mais perto do meio da jornada e espalhando
   para não concentrar muita gente da mesma supervisão no mesmo horário. */
var CEIA=60, CEIA_STEP=15;
function ceiaCands(a, v, buf, strict){
  var out=[]; if(v.isOff || a.js==null) return out;
  for(var t=Math.ceil((a.js+buf)/CEIA_STEP)*CEIA_STEP; t+CEIA<=a.je-buf; t+=CEIA_STEP){
    if(!v.free.some(function(f){return t>=f[0] && t+CEIA<=f[1];})) continue;

    if(strict && v.blocks.some(function(b){return b.st==='unk' && b.s<t+CEIA && b.e>t;})) continue;
    out.push(t);
  }
  return out;
}
function assignCeia(views){
  var occ={};
  var items=views.filter(function(x){return !x.v.isOff && x.a.js!=null;}).map(function(x){
    var c=ceiaCands(x.a,x.v,120,true), buf=120;
    if(!c.length){ c=ceiaCands(x.a,x.v,60,true); buf=60; }
    if(!c.length){ c=ceiaCands(x.a,x.v,120,false); buf=120; }
    if(!c.length){ c=ceiaCands(x.a,x.v,60,false); buf=60; }
    return {x:x, c:c, buf:buf};
  });

  items=items.filter(function(it){
    var tm=it.x.a.team, s=tm&&tm.ceiaS? op(toMin(tm.ceiaS)) : null; if(s==null) return true;
    var e=op(toMin(tm.ceiaE)); if(e==null || e<=s) e=s+CEIA;
    var a=it.x.a, v=it.x.v, o=occ[a.sup]||(occ[a.sup]={});
    for(var k=Math.floor(s/CEIA_STEP)*CEIA_STEP;k<e;k+=CEIA_STEP) o[k]=(o[k]||0)+1;
    v.ceia={s:s,e:e,app:true};
    var nf=[]; v.free.forEach(function(f){ if(e<=f[0] || s>=f[1]){ nf.push(f); return; } if(s>f[0]) nf.push([f[0],s]); if(e<f[1]) nf.push([e,f[1]]); }); v.free=nf;
    return false;
  });
  items.sort(function(p,q){ return p.c.length-q.c.length || p.x.a.name.localeCompare(q.x.a.name); });
  items.forEach(function(it){
    var a=it.x.a, v=it.x.v, o=occ[a.sup]||(occ[a.sup]={}), mid=(a.js+a.je)/2, best=null, bs=Infinity;
    it.c.forEach(function(t){
      var load=0; for(var k=t;k<t+CEIA;k+=CEIA_STEP) load=Math.max(load, o[k]||0);
      var sc=Math.abs(t+CEIA/2-mid) + load*45;
      if(sc<bs){ bs=sc; best=t; }
    });
    if(best==null){ v.ceia=null; v.ceiaWarn=true; return; }
    for(var k=best;k<best+CEIA;k+=CEIA_STEP) o[k]=(o[k]||0)+1;
    v.ceia={s:best,e:best+CEIA,relaxed:it.buf<120};
    var nf=[]; v.free.forEach(function(f){
      if(best>=f[0] && best+CEIA<=f[1]){ if(best>f[0]) nf.push([f[0],best]); if(best+CEIA<f[1]) nf.push([best+CEIA,f[1]]); }
      else nf.push(f);
    }); v.free=nf;
  });
}
function inCeia(v,s,e){ return v.ceia && v.ceia.s<e && v.ceia.e>s; }
function isFreeAt(a, v, t){
  if(v.ceia && t>=v.ceia.s && t<v.ceia.e) return false;
  if(v.isOff || a.js==null || t<a.js || t>=a.je) return false;
  for(var i=0;i<v.blocks.length;i++){ var b=v.blocks[i]; if(b.st!=='unk' && t>=b.s && t<b.e) return false; }
  return true;
}

/* ---------- render ---------- */
var $=function(id){return root.getElementById(id);};
function filtered(){
  var q=key(state.q);
  return state.analysts.filter(function(a){
    if(state.sup && a.sup!==state.sup) return false;
    if(state.region && !a.regions[state.region]) return false;
    if(state.turno && !a.hubs.some(function(h){return h.jan===state.turno;})) return false;
    if(q){
      var hit = key(a.name).indexOf(q)>=0 || a.hubs.some(function(h){return key(h.code).indexOf(q)>=0 || key(h.name).indexOf(q)>=0;});
      if(!hit) return false;
    }
    return true;
  });
}
function render(){
  var today=opsToday();
  var isToday = sameDay(state.date, today.date);
  var nowMin = isToday? today.min : null;


  var dow = (state.date.getUTCDay()+1)%7;
  $('dateLabel').innerHTML = esc(dLabel(state.date)) + '<small>'+(isToday?'dia operacional atual · ':'')+'escala de '+DOW[dow].toLowerCase()+' (entregas)</small>';
  $('updated').textContent = state.updated || 'Jornada, janelas de roteirização e disponibilidade por analista';

  var allViews = state.analysts.map(function(a){ return { a:a, v:dayView(a,dow,nowMin) }; });
  assignCeia(allViews);
  var keepSet = new Set(filtered());
  var list = allViews.filter(function(x){ return keepSet.has(x.a); });
  var sorters = {
    start:function(x,y){ return (x.v.isOff)-(y.v.isOff) || (x.a.js||9e9)-(y.a.js||9e9) || x.a.name.localeCompare(y.a.name); },
    name:function(x,y){ return x.a.name.localeCompare(y.a.name); },
    sup:function(x,y){ return SUPS.indexOf(x.a.sup)-SUPS.indexOf(y.a.sup) || (x.a.js||0)-(y.a.js||0) || x.a.name.localeCompare(y.a.name); },
    load:function(x,y){ return y.v.blocks.length-x.v.blocks.length || x.a.name.localeCompare(y.a.name); }
  };
  list.sort(sorters[state.sort]);
  if(state.tab==='dash'){ renderDash(list, nowMin); return; }
  if(state.tab==='analise'){ renderAnalise(list); return; }
  if(state.tab==='resumo'){ renderResumo(list, nowMin, allViews); return; }

  var working=list.filter(function(x){return !x.v.isOff;});
  var offN=list.length-working.length;
  var wins=0, confN=0, outN=0;
  list.forEach(function(x){ x.v.blocks.forEach(function(b){ if(b.st!=='unk') wins++; if(b.conf) confN++; if(b.out) outN++; }); });
  var freeNow = nowMin==null? null : working.filter(function(x){return isFreeAt(x.a,x.v,nowMin);}).length;
  var onNow = nowMin==null? null : working.filter(function(x){return x.a.js!=null && nowMin>=x.a.js && nowMin<x.a.je;}).length;
  var k=[
    ['Analistas escalados', working.length, list.length+' no filtro'],
    ['Em folga / férias', offN, list.filter(function(x){return x.v.status==='off';}).length+' folga/DSR · '+list.filter(function(x){return x.v.status==='vac';}).length+' férias'],
    ['Sem escala de hubs', list.filter(function(x){return x.v.status==='nosched';}).length, 'na equipe, sem hubs no dia', list.some(function(x){return x.v.status==='nosched';})],
    ['Janelas de roteirização', wins, 'hubs com operação no dia'],
    ['Disponíveis agora', freeNow==null?'—':freeNow, onNow==null?'só no dia atual':(onNow+' em jornada agora')],
    ['Hubs sem cobertura', list.reduce(function(t,x){return t+x.v.blocks.filter(function(b){return b.st==='desc';}).length;},0), 'janelas de analistas de férias/afastados', list.some(function(x){return x.v.blocks.some(function(b){return b.st==='desc';});})],
    ['Conflitos de janela', confN, outN? (outN+' janela(s) fora da jornada'):'janelas sobrepostas', confN>0]
  ];
  $('kpis').innerHTML = k.map(function(x){ return '<div class="kpi'+(x[3]?' alert':'')+'"><div class="k">'+x[0]+'</div><div class="v">'+x[1]+'</div><div class="h">'+x[2]+'</div></div>'; }).join('');

  if(state.table){ renderTable(list); return; }
  $('tablewrap').style.display='none'; $('scroller').style.display='';

  if(!list.length){ $('scroller').innerHTML='<div class="empty">Nenhum analista com os filtros atuais.</div>'; return; }

  var lo=Infinity, hi=-Infinity;
  list.forEach(function(x){
    if(x.a.js!=null){ lo=Math.min(lo,x.a.js); hi=Math.max(hi,x.a.je); }
    x.v.blocks.forEach(function(b){ lo=Math.min(lo,b.s); hi=Math.max(hi,b.e); });
  });
  lo=Math.floor(lo/60)*60; hi=Math.ceil(hi/60)*60; if(hi-lo<360) hi=lo+360;
  var whoW = window.innerWidth<=720?170:270;
  var avail = Math.max(300, $('scroller').clientWidth - whoW - 2);
  var pxm = Math.max(PX_MIN_PER_HOUR/60, avail/(hi-lo));
  var W = Math.round((hi-lo)*pxm);
  function X(t){ return Math.round((t-lo)*pxm); }

  var h=[];
  h.push('<div class="grid" style="width:'+(W+whoW)+'px">');

  h.push('<div class="row head" style="height:36px"><div class="who">Analista</div><div class="track" style="width:'+W+'px">');
  for(var t=lo;t<=hi;t+=60) h.push('<div class="tick lab" style="left:'+X(t)+'px">'+fmt(t)+'</div>');
  if(nowMin!=null && nowMin>=lo && nowMin<=hi) h.push('<div class="now" style="left:'+X(nowMin)+'px"><span>agora '+fmt(nowMin)+'</span></div>');
  h.push('</div></div>');

  var slots=computeSlots(working, lo, hi, 30), maxC=1;
  slots.forEach(function(sl){ maxC=Math.max(maxC,sl.free.length); });
  function heat(n){ if(!n) return 'var(--heat-0)'; var r=n/maxC; return r<.25?'var(--heat-1)':r<.5?'var(--heat-2)':r<.75?'var(--heat-3)':'var(--heat-4)'; }
  function heatInk(n){ var r=n/maxC; return (n && r>=.5)?'#fff':'var(--ink-2)'; }
  h.push('<div class="row avail" style="height:46px"><div class="who"><div class="n">Disponíveis</div><div class="m">em jornada e fora de janela</div></div><div class="track" style="width:'+W+'px">');
  slots.forEach(function(sl,i){
    h.push('<div class="cell" data-slot="'+i+'" style="left:'+(X(sl.s)+1)+'px;width:'+(X(sl.s+30)-X(sl.s)-2)+'px;background:'+heat(sl.free.length)+';color:'+heatInk(sl.free.length)+'">'+sl.free.length+'</div>');
  });
  if(nowMin!=null && nowMin>=lo && nowMin<=hi) h.push('<div class="now" style="left:'+X(nowMin)+'px"></div>');
  h.push('</div></div>');
  h.push('<div class="row avail" style="height:34px;border-bottom:1px solid var(--line)"><div class="who"><div class="n">Janelas em andamento</div></div><div class="track" style="width:'+W+'px">');
  slots.forEach(function(sl,i){
    h.push('<div class="cell" data-slotw="'+i+'" style="left:'+(X(sl.s)+1)+'px;width:'+(X(sl.s+30)-X(sl.s)-2)+'px;color:var(--ink-2)">'+(sl.win||'')+'</div>');
  });
  if(nowMin!=null && nowMin>=lo && nowMin<=hi) h.push('<div class="now" style="left:'+X(nowMin)+'px"></div>');
  h.push('</div></div>');

  var LANE=26, PAD=10;
  list.forEach(function(x,ri){
    var a=x.a, v=x.v, manyTags=(v.ceiaWarn?1:0)+(a.noSched?1:0)+(a.team&&a.team.status?1:0)+(a.team&&a.team.sup2?1:0)+(rtNova(a)?1:0)+(a.multiShift?1:0)+(v.blocks.some(function(b){return b.conf;})?1:0), rowH = Math.max(manyTags?66:52, PAD*2 + v.lanes*LANE + (v.lanes-1)*4);
    var tags='<span class="tag">'+esc(a.sup.split(' ')[0])+'</span>';
    if(v.blocks.some(function(b){return b.conf;})) tags+='<span class="tag warn">conflito</span>';
    if(a.multiShift) tags+='<span class="tag warn" title="Jornadas diferentes entre os hubs">jornada divergente</span>';
    if(a.noSched) tags+='<span class="tag warn">sem escala</span>';
    if(v.ceiaWarn) tags+='<span class="tag warn" title="Não há 1h livre fora do início/fim da jornada">sem espaço p/ ceia</span>';
    if(a.team && a.team.status) tags+='<span class="tag">'+esc(a.team.status)+'</span>';
    if(a.team && a.team.sup2) tags+='<span class="tag">'+esc(a.team.sup2)+'</span>';
    if(rtNova(a)) tags+='<span class="tag">nova · desde '+esc(a.team.since.slice(0,5))+'</span>';
    h.push('<div class="row" style="height:'+rowH+'px"><div class="who"><div class="n" title="'+esc(a.name)+'">'+esc(a.name)+'</div><div class="m">'+
      (a.js!=null? fmt(a.js)+'–'+fmt(a.je):'sem jornada')+' · '+v.on.length+' hub(s) '+tags+'</div></div><div class="track" style="width:'+W+'px">');
    for(var t2=lo;t2<=hi;t2+=60){ h.push('<div class="vline" style="left:'+X(t2)+'px"></div>'); if(t2+30<hi) h.push('<div class="vline half" style="left:'+X(t2+30)+'px"></div>'); }
    var top=PAD, bh=rowH-PAD*2;
    if(a.js!=null){
      if(v.isOff){
        h.push('<div class="bar off" data-a="'+ri+'" data-k="j" style="left:'+X(a.js)+'px;width:'+(X(a.je)-X(a.js))+'px;top:'+top+'px;height:'+bh+'px">'+esc(v.label)+'</div>');
      } else if(v.status==='nosched'){
        h.push('<div class="bar j nosched" data-a="'+ri+'" data-k="j" style="left:'+X(a.js)+'px;width:'+(X(a.je)-X(a.js))+'px;top:'+(top-3)+'px;height:'+(bh+6)+'px">Sem escala de hubs'+(a.team&&a.team.status?' · '+esc(a.team.status):'')+'</div>');
      } else {
        h.push('<div class="bar j" data-a="'+ri+'" data-k="j" style="left:'+X(a.js)+'px;width:'+(X(a.je)-X(a.js))+'px;top:'+(top-3)+'px;height:'+(bh+6)+'px"></div>');
      }
    }
    if(!v.isOff && v.ceia){
      h.push('<div class="rt ceia" data-a="'+ri+'" data-c="1" style="left:'+X(v.ceia.s)+'px;width:'+Math.max(X(v.ceia.e)-X(v.ceia.s),18)+'px;top:'+top+'px;height:'+LANE+'px">Ceia</div>');
    }
    if(!v.isOff || v.status==='vac') v.blocks.forEach(function(b,bi){
      var w=Math.max(X(b.e)-X(b.s),18);
      var label=(b.h.code||b.h.name)+(b.out?' ⚠':'');
      h.push('<div class="rt '+b.st+(b.conf?' conf':'')+'" data-a="'+ri+'" data-b="'+bi+'" style="left:'+X(b.s)+'px;width:'+w+'px;top:'+(top+b.lane*(LANE+4))+'px;height:'+LANE+'px">'+esc(label)+'</div>');
    });
    if(nowMin!=null && nowMin>=lo && nowMin<=hi) h.push('<div class="now" style="left:'+X(nowMin)+'px"></div>');
    h.push('</div></div>');
  });
  h.push('</div>');
  var sc=$('scroller'), keepL=sc.scrollLeft, keepT=sc.scrollTop, first=!sc.dataset.ready;
  sc.innerHTML=h.join(''); sc.dataset.ready='1';
  if(first){ sc.scrollLeft=(nowMin!=null && nowMin>=lo && nowMin<=hi)? Math.max(0,X(nowMin)-avail/2) : 0; } else { sc.scrollLeft=keepL; sc.scrollTop=keepT; }
  state._list=list; state._slots=slots;
}


function timeRange(list, nowMin){
  var lo=Infinity, hi=-Infinity;
  list.forEach(function(x){
    if(x.a.js!=null){ lo=Math.min(lo,x.a.js); hi=Math.max(hi,x.a.je); }
    x.v.blocks.forEach(function(b){ lo=Math.min(lo,b.s); hi=Math.max(hi,b.e); });
  });
  if(!isFinite(lo)){ lo=18*60; hi=30*60; }
  lo=Math.floor(lo/60)*60; hi=Math.ceil(hi/60)*60; if(hi-lo<360) hi=lo+360;
  return [lo,hi];
}
function heatBg(n,max){ if(!n) return 'var(--heat-0)'; var r=n/Math.max(1,max); return r<.25?'var(--heat-1)':r<.5?'var(--heat-2)':r<.75?'var(--heat-3)':'var(--heat-4)'; }
function heatFg(n,max){ return (n && n/Math.max(1,max)>=.5)?'#fff':'var(--ink-2)'; }

function renderDash(list, nowMin){
  var working=list.filter(function(x){return !x.v.isOff;});
  var rg=timeRange(working.length?working:list, nowMin), lo=rg[0], hi=rg[1], step=state.step;
  var slots=computeSlots(working, lo, hi, step); state._dslots=slots;
  var active=slots.filter(function(s){return s.free.length+s.busy.length>0;});

  var sel=-1;
  slots.forEach(function(s,i){ if(state.selSlot!=null && state.selSlot>=s.s && state.selSlot<s.e) sel=i; });
  if(sel<0 && nowMin!=null) slots.forEach(function(s,i){ if(nowMin>=s.s && nowMin<s.e) sel=i; });
  if(sel<0){ var best=-1; slots.forEach(function(s,i){ if(best<0 || s.free.length>slots[best].free.length) best=i; }); sel=Math.max(0,best); }
  var S=slots[sel];

  function pick(arr,f,dir){ var b=null; arr.forEach(function(s){ if(!b || (dir>0? f(s)>f(b) : f(s)<f(b))) b=s; }); return b; }
  var pk=pick(active,function(s){return s.free.length;},1), mn=pick(active,function(s){return s.free.length;},-1), mw=pick(active,function(s){return s.busy.length;},1);
  var avg=active.length? (active.reduce(function(t,s){return t+s.free.length;},0)/active.length) : 0;
  var k=[
    ['Escalados no dia', working.length, (list.length-working.length)+' em folga/férias · '+working.filter(function(x){return x.v.status==='nosched';}).length+' sem escala de hubs'],
    ['Pico de disponíveis', pk?pk.free.length:'—', pk?('às '+fmt(pk.s)+'–'+fmt(pk.e)):''],
    ['Menor disponibilidade', mn?mn.free.length:'—', mn?('às '+fmt(mn.s)+'–'+fmt(mn.e)):'', mn && mn.free.length===0],
    ['Média por intervalo', avg.toFixed(1).replace('.',','), 'disponíveis em intervalos com jornada'],
    ['Mais gente em janela', mw?mw.busy.length:'—', mw?('às '+fmt(mw.s)+'–'+fmt(mw.e)):'']
  ];
  $('kpis').innerHTML = k.map(function(x){ return '<div class="kpi'+(x[3]?' alert':'')+'"><div class="k">'+x[0]+'</div><div class="v">'+x[1]+'</div><div class="h">'+x[2]+'</div></div>'; }).join('');

  var box=$('viewDash');
  if(!working.length){ box.innerHTML='<div class="card"><div class="empty">Nenhum analista escalado com os filtros atuais.</div></div>'; return; }

  var mx=1; slots.forEach(function(s){ mx=Math.max(mx, s.free.length+s.busy.length+s.meal.length); });
  function seg(col,n,lab){ return n? '<span style="width:'+(n/mx*100)+'%;background:'+col+'" title="'+n+' '+lab+'"></span>' : ''; }
  var rowsH=slots.filter(function(s){return s.free.length+s.busy.length+s.meal.length>0 || s===S;}).map(function(s){
    var i=slots.indexOf(s), on=s.free.length+s.busy.length+s.meal.length, isNow=nowMin!=null && nowMin>=s.s && nowMin<s.e;
    return '<tr data-ds="'+i+'" class="'+(i===sel?'sel':'')+'"><td>'+fmt(s.s)+'–'+fmt(s.e)+(isNow?'<span class="agora-tag">agora</span>':'')+'</td>'+
      '<td class="disp'+(on && !s.free.length?' zero':'')+'">'+s.free.length+'</td><td>'+s.busy.length+'</td><td>'+s.meal.length+'</td><td>'+on+'</td>'+
      '<td class="barra-cel"><div class="mini">'+seg('var(--st-run)',s.free.length,'disponíveis')+seg('var(--ceia-bd)',s.meal.length,'em ceia')+seg('var(--busy)',s.busy.length,'em operação')+'</div></td></tr>';
  }).join('');
  var g=['<table class="horas"><thead><tr><th>Horário</th><th>Disponíveis</th><th>Em operação</th><th>Em ceia</th><th>Na jornada</th><th></th></tr></thead><tbody>'+rowsH+'</tbody></table>'];

  var sups = state.sup? [state.sup] : SUPS.filter(function(sp){ return working.some(function(x){return x.a.sup===sp;}); });
  var hmax=1; slots.forEach(function(s){ sups.forEach(function(sp){ hmax=Math.max(hmax, s.bySup[sp]||0); }); });
  var tmax=1; slots.forEach(function(s){ tmax=Math.max(tmax,s.free.length); });
  var hm=['<table class="hm"><thead><tr><th></th>'];
  slots.forEach(function(s,i){ hm.push('<th class="'+(i===sel?'sel':'')+'">'+(step===60||s.s%60===0? fmt(s.s).replace(':00','h') : ':30')+'</th>'); });
  hm.push('</tr></thead><tbody>');
  sups.forEach(function(sp){
    hm.push('<tr><th>'+esc(sp.split(' ')[0])+'</th>');
    slots.forEach(function(s,i){ var n=s.bySup[sp]||0; hm.push('<td data-ds="'+i+'" data-sup="'+esc(sp)+'" class="'+(i===sel?'sel':'')+'" style="background:'+heatBg(n,hmax)+';color:'+heatFg(n,hmax)+'">'+n+'</td>'); });
    hm.push('</tr>');
  });
  if(sups.length>1){
    hm.push('<tr><th>Total</th>');
    slots.forEach(function(s,i){ var n=s.free.length; hm.push('<td data-ds="'+i+'" class="'+(i===sel?'sel':'')+'" style="background:'+heatBg(n,tmax)+';color:'+heatFg(n,tmax)+'">'+n+'</td>'); });
    hm.push('</tr>');
  }
  hm.push('</tbody></table>');

  var fr=S.free.slice().sort(function(p,q){ return (q.until-p.until) || p.a.name.localeCompare(q.a.name); });
  var bz=S.busy.slice().sort(function(p,q){ return p.a.name.localeCompare(q.a.name); });
  var L1=fr.map(function(f){
    var nx=f.next? ('próx.: '+esc(f.next.h.code||f.next.h.name)+' às '+fmt(f.next.s)) : 'sem janelas até o fim';
    return '<li><div><b>'+esc(f.a.name)+'</b><span class="pill">'+esc(f.a.sup.split(' ')[0])+'</span></div><div class="r">livre até '+fmt(f.until)+'<br>'+nx+'</div></li>';
  }).join('') || '<li><div style="color:var(--ink-3)">Ninguém disponível neste intervalo.</div></li>';
  var L2=bz.map(function(z){
    var hubs=z.b.map(function(b){return esc(b.h.code||b.h.name)+' '+fmt(b.s)+'–'+fmt(b.e);}).join('<br>');
    return '<li><div><b>'+esc(z.a.name)+'</b><span class="pill">'+esc(z.a.sup.split(' ')[0])+'</span></div><div class="r">'+hubs+'</div></li>';
  }).join('') || '<li><div style="color:var(--ink-3)">Nenhuma janela neste intervalo.</div></li>';

  var L3=S.meal.slice().sort(function(p,q){return p.a.name.localeCompare(q.a.name);}).map(function(z){
    return '<li><div><b>'+esc(z.a.name)+'</b><span class="pill">'+esc(z.a.sup.split(' ')[0])+'</span></div><div class="r">ceia '+fmt(z.v.ceia.s)+'–'+fmt(z.v.ceia.e)+'</div></li>';
  }).join('') || '<li><div style="color:var(--ink-3)">Ninguém em ceia neste intervalo.</div></li>';
  var stepTxt = step===60?'1 hora':'30 minutos';
  var offN=list.length-working.length;
  var descAll=[]; list.forEach(function(x){ x.v.blocks.forEach(function(b){ if(b.st==='desc') descAll.push({a:x.a,b:b}); }); }); descAll.sort(function(p,q){return p.b.s-q.b.s;});
  function tile(r,v,d,c,dest){ return '<div class="tile'+(dest?' destaque':'')+'"><div class="rotulo">'+(c?'<i style="background:'+c+'"></i>':'')+r+'</div><div class="valor">'+v+'</div><small>'+d+'</small></div>'; }
  function lst(arr,fn,vazio){ return arr.length? '<ul class="lista">'+arr.map(fn).join('')+'</ul>' : '<p class="vazio-lista">'+vazio+'</p>'; }
  var onS=S.free.length+S.busy.length+S.meal.length;
  box.innerHTML =
    '<div class="card"><div class="card-header"><div><h2>Disponibilidade · '+fmt(S.s)+'–'+fmt(S.e)+'</h2><p class="cs" style="margin-bottom:0">Quem está na jornada e livre no intervalo de '+stepTxt+' (fora de janela e fora da ceia). Clique num horário da tabela para ver os nomes.</p></div></div>'+
      '<div class="tiles">'+
        tile('Disponíveis',S.free.length,'na jornada e livres','var(--st-run)',true)+
        tile('Em operação',S.busy.length,'com janela no intervalo','var(--busy)')+
        tile('Em ceia',S.meal.length,'1h de ceia','var(--ceia-bd)')+
        tile('Na jornada',onS,S.win+' janelas em andamento','')+
        tile('De folga / férias',offN,'no dia inteiro','')+
        tile('Hubs sem cobertura',descAll.length,'janelas de analistas afastados','var(--st-crit)')+
      '</div></div>'+
    '<div class="disp-grid">'+
      '<div class="card"><h3>Hora a hora</h3><div class="legend" style="margin-bottom:8px"><span><i class="sw run"></i>Disponíveis</span><span><i class="sw" style="background:var(--ceia-bd)"></i>Em ceia</span><span><i class="sw" style="background:var(--busy)"></i>Em operação</span></div><div class="chartwrap">'+g.join('')+'</div></div>'+
      '<div class="card"><h3>'+fmt(S.s)+'–'+fmt(S.e)+'</h3>'+
        '<div class="grupo"><i style="background:var(--st-run)"></i>Disponíveis ('+S.free.length+')</div>'+lst(fr,function(f){ var nx=f.next? ('próx.: '+esc(f.next.h.code||f.next.h.name)+' às '+fmt(f.next.s)) : 'sem janelas até o fim'; return '<li><b>'+esc(f.a.name)+' <span class="pill">'+esc(f.a.sup.split(' ')[0])+'</span></b><small>livre até '+fmt(f.until)+'<br>'+nx+'</small></li>'; },'Ninguém disponível neste intervalo.')+
        '<div class="grupo"><i style="background:var(--busy)"></i>Em operação ('+S.busy.length+')</div>'+lst(bz,function(z){ return '<li><b>'+esc(z.a.name)+' <span class="pill">'+esc(z.a.sup.split(' ')[0])+'</span></b><small>'+z.b.map(function(b){return esc(b.h.code||b.h.name)+' '+fmt(b.s)+'–'+fmt(b.e);}).join('<br>')+'</small></li>'; },'Nenhuma janela neste intervalo.')+
        '<div class="grupo"><i style="background:var(--ceia-bd)"></i>Em ceia ('+S.meal.length+')</div>'+lst(S.meal.slice().sort(function(p,q){return p.a.name.localeCompare(q.a.name);}),function(z){ return '<li><b>'+esc(z.a.name)+' <span class="pill">'+esc(z.a.sup.split(' ')[0])+'</span></b><small>ceia '+fmt(z.v.ceia.s)+'–'+fmt(z.v.ceia.e)+'</small></li>'; },'Ninguém em ceia neste intervalo.')+
      '</div>'+
    '</div>'+
    '<div class="card" style="margin-top:16px"><h2>Hubs sem cobertura</h2><p class="cs">Janelas que rodam no dia mas o analista da escala está de férias ou afastado. Precisam de alguém para assumir.</p>'+
      lst(descAll,function(d){ var nowIn=S.s<d.b.e && S.e>d.b.s; return '<li><b class="alerta" style="color:var(--st-crit)">'+esc(d.b.h.code||d.b.h.name)+' · '+esc(d.b.h.jan||'')+'</b><small>'+fmt(d.b.s)+'–'+fmt(d.b.e)+' · '+esc(d.b.h.name)+'<br>'+esc(d.a.name)+' ('+esc((d.a.team&&d.a.team.status)||'afastado')+')'+(nowIn?' · <b>no intervalo selecionado</b>':'')+'</small></li>'; },'Todos os hubs do dia têm analista.')+'</div>'+
    '<div class="card" style="margin-top:16px"><h2>Disponíveis por supervisor</h2><p class="cs">Quantidade de analistas livres de cada equipe por intervalo. Clique numa célula para selecionar o horário.</p><div class="chartwrap">'+hm.join('')+'</div></div>';
}


function renderAnalise(list){
  var working=list.filter(function(x){return !x.v.isOff;});
  var box=$('viewAnalise');

  var hubRows=working.map(function(x){
    var seen={}, hubs=[];
    x.v.blocks.forEach(function(b){ if(b.st==='unk') return; var k=b.h.code||b.h.name; if(!seen[k]){ seen[k]=1; hubs.push(k); } });
    var tbd=x.v.blocks.filter(function(b){return b.st==='unk';}).length;
    return { a:x.a, n:hubs.length, wins:x.v.blocks.filter(function(b){return b.st!=='unk';}).length, hubs:hubs, tbd:tbd };
  }).sort(function(p,q){ return q.n-p.n || q.wins-p.wins || p.a.name.localeCompare(q.a.name); });
  state._hubRows=hubRows;
  var hmaxN=1, tot=0; hubRows.forEach(function(r){ hmaxN=Math.max(hmaxN,r.n); tot+=r.n; });
  var withHub=hubRows.filter(function(r){return r.n>0;}).length; var hubAvg = withHub? tot/withHub : 0;
  var hb=hubRows.map(function(r,i){
    var pct=Math.round(r.n/hmaxN*100);
    return '<div class="hbrow" data-hr="'+i+'"><div class="hbn" title="'+esc(r.a.name)+'">'+esc(r.a.name)+'<span class="pill">'+esc(r.a.sup.split(' ')[0])+'</span></div>'+
      '<div class="hbt"><div class="hbb" style="width:'+Math.max(pct,r.n?4:0)+'%"></div><span class="hbv">'+r.n+'</span></div>'+
      '<div class="hbx">'+r.wins+' janela'+(r.wins===1?'':'s')+(r.tbd?' · '+r.tbd+' a definir':'')+'</div></div>';
  }).join('');
  var dist={}; hubRows.forEach(function(r){ dist[r.n]=(dist[r.n]||0)+1; });
  var distTxt=Object.keys(dist).sort(function(a,b){return b-a;}).map(function(n){ return dist[n]+' com '+n+' hub'+(n==1?'':'s'); }).join(' · ');

  var regs={}, turnos={};
  list.filter(function(x){return !x.v.isOff || x.v.status==='vac';}).forEach(function(x){ x.v.blocks.forEach(function(b){
    if(b.st==='unk') return; var rk=b.h.reg||'Sem região', tj=b.h.jan||'—';
    var R=regs[rk]||(regs[rk]={reg:rk,cyc:{},hubs:{},ana:{},byT:{}});
    var ck=(b.h.code||b.h.name)+'|'+tj;
    if(!R.cyc[ck]){ R.cyc[ck]=1; R.byT[tj]=(R.byT[tj]||0)+1; turnos[tj]=1; }
    R.hubs[b.h.code||b.h.name]=1; R.ana[x.a.name]=x.a.sup;
  }); });
  var TORD=Object.keys(turnos).sort();
  var regRows=Object.keys(regs).map(function(k){ var R=regs[k]; return {reg:k, n:Object.keys(R.cyc).length, nh:Object.keys(R.hubs).length, na:Object.keys(R.ana).length, byT:R.byT, ana:R.ana}; })
    .sort(function(p,q){ return q.n-p.n || p.reg.localeCompare(q.reg); });
  state._regRows=regRows;
  var rmax=1, cycTot=0; regRows.forEach(function(r){ rmax=Math.max(rmax,r.n); cycTot+=r.n; });
  var rb=regRows.map(function(r,i){
    var pct=Math.round(r.n/rmax*100);
    var tt=TORD.filter(function(t){return r.byT[t];}).map(function(t){return t+' '+r.byT[t];}).join(' · ');
    return '<div class="hbrow reg" data-rr="'+i+'" data-region="'+esc(r.reg==='Sem região'?'':r.reg)+'"><div class="hbn">'+esc(r.reg)+'</div>'+
      '<div class="hbt"><div class="hbb" style="width:'+Math.max(pct,4)+'%"></div><span class="hbv">'+r.n+'</span></div>'+
      '<div class="hbx">'+tt+' · '+r.na+' analista'+(r.na===1?'':'s')+'</div></div>';
  }).join('');

  var schedN=hubRows.filter(function(r){return r.n>0;}).length;

  function unionLen(iv){ iv=iv.slice().sort(function(p,q){return p[0]-q[0];}); var t=0,cs=null,ce=null; iv.forEach(function(r){ if(cs==null||r[0]>ce){ if(cs!=null) t+=ce-cs; cs=r[0]; ce=r[1]; } else ce=Math.max(ce,r[1]); }); if(cs!=null) t+=ce-cs; return t; }
  var hrsRows=working.filter(function(x){return x.a.js!=null;}).map(function(x){
    var a=x.a, v=x.v;
    var dem=unionLen(v.blocks.filter(function(b){return b.st!=='unk';}).map(function(b){return [Math.max(b.s,a.js),Math.min(b.e,a.je)];}).filter(function(r){return r[1]>r[0];}));
    var ceia=v.ceia?CEIA:0, jor=a.je-a.js, livre=v.free.reduce(function(t,f){return t+(f[1]-f[0]);},0);
    return {a:a, jor:jor, dem:dem, ceia:ceia, livre:livre};
  });
  var HT={jor:0,dem:0,ceia:0,livre:0}, HS={};
  hrsRows.forEach(function(r){ ['jor','dem','ceia','livre'].forEach(function(k){ HT[k]+=r[k]; var s=HS[r.a.sup]||(HS[r.a.sup]={n:0,jor:0,dem:0,ceia:0,livre:0}); s[k]+=r[k]; }); HS[r.a.sup].n++; });
  function hh(m){ var h=Math.floor(m/60), mi=Math.round(m%60); return h+'h'+(mi<10?'0':'')+mi; }
  function pct(a,b){ return b? Math.round(a/b*100)+'%' : '—'; }
  state._hrsRows=hrsRows.slice().sort(function(p,q){ return (q.dem/q.jor)-(p.dem/p.jor) || p.a.name.localeCompare(q.a.name); });
  function stack(r){
    var t=Math.max(1,r.jor);
    return '<div class="hst"><span style="width:'+(r.dem/t*100)+'%;background:var(--busy)"></span><span style="width:'+(r.ceia/t*100)+'%;background:var(--ceia)"></span><span style="width:'+(r.livre/t*100)+'%;background:var(--st-run)"></span></div>';
  }
  var supT='<table class="htab"><thead><tr><th>Supervisor</th><th>Analistas</th><th>Jornada</th><th>Com demanda</th><th>Ceia</th><th>Disponíveis</th><th>Ocupação</th><th style="min-width:160px"></th></tr></thead><tbody>'+
    SUPS.filter(function(s){return HS[s];}).map(function(s){ var r=HS[s];
      return '<tr><th>'+esc(s.split(' ')[0])+'</th><td>'+r.n+'</td><td>'+hh(r.jor)+'</td><td>'+hh(r.dem)+'</td><td>'+hh(r.ceia)+'</td><td><b>'+hh(r.livre)+'</b></td><td>'+pct(r.dem,r.jor)+'</td><td>'+stack(r)+'</td></tr>'; }).join('')+
    '<tr class="tot"><th>Total</th><td>'+hrsRows.length+'</td><td>'+hh(HT.jor)+'</td><td>'+hh(HT.dem)+'</td><td>'+hh(HT.ceia)+'</td><td><b>'+hh(HT.livre)+'</b></td><td>'+pct(HT.dem,HT.jor)+'</td><td>'+stack(HT)+'</td></tr></tbody></table>';
  var anaH=state._hrsRows.map(function(r,i){
    return '<div class="hbrow hrs" data-hh="'+i+'"><div class="hbn" title="'+esc(r.a.name)+'">'+esc(r.a.name)+'<span class="pill">'+esc(r.a.sup.split(' ')[0])+'</span></div>'+stack(r)+
      '<div class="hbx">'+hh(r.dem)+' demanda · <b style="color:var(--ink)">'+hh(r.livre)+' livre</b></div></div>';
  }).join('');
  var k=[
    ['Analistas escalados', working.length, (list.length-working.length)+' em folga/férias'],
    ['HUBs por analista', schedN?(tot/schedN).toFixed(1).replace('.',','):'—', 'média entre quem tem escala · máx. '+hmaxN],
    ['Horas com demanda', hh(HT.dem), pct(HT.dem,HT.jor)+' da jornada total ('+hh(HT.jor)+')'],
    ['Horas disponíveis', hh(HT.livre), 'fora de janela e já descontada 1h de ceia'],
    ['Ciclos no dia', cycTot, regRows.length+' regionais'],
    ['Sem escala de hubs', hubRows.length-schedN, 'analistas sem hub no dia', hubRows.length-schedN>0],
    ['HUBs com operação', tot, 'soma dos hubs por analista']
  ];
  $('kpis').innerHTML = k.map(function(x){ return '<div class="kpi'+(x[3]?' alert':'')+'"><div class="k">'+x[0]+'</div><div class="v">'+x[1]+'</div><div class="h">'+x[2]+'</div></div>'; }).join('');
  if(!working.length){ box.innerHTML='<div class="card"><div class="empty">Nenhum analista escalado com os filtros atuais.</div></div>'; return; }
  box.innerHTML='<div class="dgrid">'+
    '<div class="card"><h2>Horas disponíveis e com demanda</h2><p class="cs">Soma das jornadas do dia. Com demanda = tempo dentro da jornada coberto por janelas de roteirização (sobreposições contam uma vez). Disponíveis = jornada − demanda − 1h de ceia.</p>'+
      '<div class="clegend"><span><i style="background:var(--busy)"></i>Com demanda</span><span><i style="background:var(--ceia)"></i>Ceia</span><span><i style="background:var(--st-run)"></i>Disponível</span></div>'+
      '<div class="chartwrap">'+supT+'</div></div>'+
    '<div class="card"><h2>Horas por analista</h2><p class="cs">Ordenado pela ocupação (maior % da jornada com demanda primeiro). Passe o mouse para ver os números.</p><div class="hbars">'+anaH+'</div></div>'+
    '<div class="card"><h2>Ciclos por regional</h2><p class="cs">Ciclo = hub + janela (AM, PM1, PM2) com operação no dia. Mostra os ciclos por turno e quantos analistas atendem a regional. Clique numa regional para filtrar o painel.</p><div class="hbars">'+rb+'</div></div>'+
    '<div class="card"><h2>HUBs por analista</h2><p class="cs">Hubs com operação no dia selecionado. Média de '+hubAvg.toFixed(1).replace('.',',')+' hubs por analista com escala · '+distTxt+'. Passe o mouse para ver os hubs.</p><div class="hbars">'+hb+'</div></div>'+
    '</div>';
}

/* ---------- Resumo (aba acrescentada pelo painel do Routing Tower, 09/10/2026) ----------
   O dia em uma tela: indicadores e destaques, uma linha por supervisor, os pontos de atenção (do mais
   grave para o menos grave), a carga por analista, ausências e retornos, hora a hora, as próximas 2
   horas (no dia atual), a escala de ceia, as regiões e as jornadas. Respeita os filtros. */
function renderResumo(list, nowMin, todos){
  var box=$('viewResumo');
  if(!state.analysts.length){ $('kpis').innerHTML=''; box.innerHTML='<div class="card"><div class="loading">Carregando escala…</div></div>'; return; }
  if(!list.length){ $('kpis').innerHTML=''; box.innerHTML='<div class="card"><div class="empty">Nenhum analista com os filtros atuais.</div></div>'; return; }
  function hh(m){ var h=Math.floor(m/60), mi=Math.round(m%60); return h+'h'+(mi<10?'0':'')+mi; }
  function pct(a,b){ return b? Math.round(a/b*100)+'%' : '—'; }
  function unionLen(iv){ iv=iv.slice().sort(function(p,q){return p[0]-q[0];}); var t=0,cs=null,ce=null; iv.forEach(function(r){ if(cs==null||r[0]>ce){ if(cs!=null) t+=ce-cs; cs=r[0]; ce=r[1]; } else ce=Math.max(ce,r[1]); }); if(cs!=null) t+=ce-cs; return t; }
  function hub(b){ return esc(b.h.code||b.h.name); }
  function first(s){ return esc(String(s||'').split(' ')[0]); }
  var working=list.filter(function(x){return !x.v.isOff;});
  var S={}, T={n:0,esc:0,off:0,vac:0,nos:0,tbd:0,win:0,dem:0,jor:0,desc:0,conf:0,att:0}, hubs={}, turnos={}, att=[], tbd=[], nos=[];
  function sup(a){ var k=a.sup||'Sem liderança'; return S[k]||(S[k]={n:0,esc:0,off:0,vac:0,nos:0,tbd:0,win:0,dem:0,jor:0,desc:0,conf:0,att:0}); }
  list.forEach(function(x){
    var a=x.a, v=x.v, s=sup(a), wins=v.blocks.filter(function(b){return b.st==='win';});
    function add(k,n){ s[k]+=n; T[k]+=n; }
    add('n',1);
    if(v.status==='off') add('off',1); else if(v.status==='vac') add('vac',1); else add('esc',1);
    if(v.status==='nosched'){ add('nos',1); nos.push(a); }
    if(v.status==='tbd'){ add('tbd',1); tbd.push(a); }
    add('win',wins.length);
    wins.forEach(function(b){ hubs[b.h.code||b.h.name]=1; var j=b.h.jan||'—'; turnos[j]=(turnos[j]||0)+1; });
    if(!v.isOff && a.js!=null){
      add('jor',a.je-a.js);
      add('dem',unionLen(wins.map(function(b){return [Math.max(b.s,a.js),Math.min(b.e,a.je)];}).filter(function(r){return r[1]>r[0];})));
    }
    v.blocks.forEach(function(b){
      if(b.st!=='desc') return;
      add('desc',1);
      att.push({sev:0,cor:'var(--st-crit)',t:b.s,tipo:'Hub sem cobertura',a:a,txt:hub(b)+' · '+fmt(b.s)+'–'+fmt(b.e)+' · analista de '+esc(((a.team&&a.team.status)||'afastamento').toLowerCase())});
    });
    var conf=v.blocks.filter(function(b){return b.conf;});
    if(conf.length){ add('conf',1); att.push({sev:1,cor:'var(--st-crit)',t:conf[0].s,tipo:'Conflito de janelas',a:a,txt:conf.map(function(b){return hub(b)+' '+fmt(b.s)+'–'+fmt(b.e);}).join(' × ')}); }
    var out=v.blocks.filter(function(b){return b.out && b.st==='win';});
    if(out.length) att.push({sev:3,cor:'var(--ceia-bd)',t:out[0].s,tipo:'Janela fora da jornada',a:a,txt:'jornada '+fmt(a.js)+'–'+fmt(a.je)+' · '+out.map(function(b){return hub(b)+' '+fmt(b.s)+'–'+fmt(b.e);}).join(', ')});
    if(v.ceiaWarn) att.push({sev:4,cor:'var(--ceia-bd)',t:a.js||0,tipo:'Sem horário para a ceia',a:a,txt:'não sobra 1 hora livre na jornada para a ceia'});
  });

  var porNome={}; list.forEach(function(x){ porNome[x.a.name]=x.a; });
  var rhN=0;
  (state.rh||[]).forEach(function(r){ var a=porNome[r.nome]; if(!a) return; rhN++; att.push({sev:2,cor:'var(--st-crit)',t:a.js||0,tipo:'Regra de RH',a:a,txt:esc(r.texto)}); });

  var atrasos=(state.eventos&&state.eventos.late)||[];
  atrasos.forEach(function(l){ var a=porNome[l.analista]; if(!a) return; att.push({sev:0,cor:'var(--st-crit)',t:op(toMin(l.rti))||0,tipo:'Hub atrasado',a:a,txt:esc((l.station||'')+' · '+(l.hub||''))+' · janela '+esc(l.rti)+'–'+esc(l.rtf)+' · '+l.atraso+' min sem início'}); });
  att.forEach(function(it){ sup(it.a).att++; T.att++; });
  att.sort(function(p,q){ return p.sev-q.sev || p.t-q.t || p.a.name.localeCompare(q.a.name); });
  function nomes(arr){ var n=arr.map(function(a){return esc(a.name)+(rtNova(a)?' (nova, desde '+esc(a.team.since.slice(0,5))+')':'');}).sort(); return n.slice(0,8).join(', ')+(n.length>8?' e mais '+(n.length-8):''); }
  if(tbd.length) att.push({sev:5,cor:'var(--ink-3)',tipo:'Escala não definida',txt:tbd.length+' analista(s) com hubs sem a escala do dia: '+nomes(tbd)});
  if(nos.length) att.push({sev:6,cor:'var(--ink-3)',tipo:'Sem escala de hubs',txt:nos.length+' analista(s) na equipe sem hubs no dia: '+nomes(nos)});

  var rg=timeRange(working.length?working:list, nowMin), slots=computeSlots(working, rg[0], rg[1], 60);
  var act=slots.filter(function(s){ return s.free.length+s.busy.length+s.meal.length>0 || s.win>0; });
  var maxOn=1, pico=null, aperto=null;
  act.forEach(function(s){
    maxOn=Math.max(maxOn, s.free.length+s.busy.length+s.meal.length);
    if(s.win && (!pico || s.win>pico.win)) pico=s;
    if(s.busy.length && (!aperto || s.free.length<aperto.free.length)) aperto=s;
  });
  var horaT='<table class="htab rs-hora"><thead><tr><th>Hora</th><th>Janelas</th><th>Em janela</th><th>Em ceia</th><th>Livres</th><th style="min-width:140px"></th></tr></thead><tbody>'+
    act.map(function(s){
      var cls=(s===pico?' pico':'')+(nowMin!=null && nowMin>=s.s && nowMin<s.e?' agora':'');
      return '<tr class="'+cls.trim()+'"><th>'+fmt(s.s)+'–'+fmt(s.e)+'</th><td>'+s.win+'</td><td>'+s.busy.length+'</td><td>'+s.meal.length+'</td><td><b>'+s.free.length+'</b></td>'+
        '<td><div class="hst"><span style="width:'+(s.busy.length/maxOn*100)+'%;background:var(--busy)"></span><span style="width:'+(s.meal.length/maxOn*100)+'%;background:var(--ceia)"></span><span style="width:'+(s.free.length/maxOn*100)+'%;background:var(--st-run)"></span></div></td></tr>';
    }).join('')+'</tbody></table>';

  var agora=null, prox=[];
  if(nowMin!=null){
    agora={janela:0,ceia:0,livres:0,jornada:0,proxima:null,comecam:0};
    working.forEach(function(x){
      if(x.a.js!=null && nowMin>=x.a.js && nowMin<x.a.je) agora.jornada++;
      if(x.a.js!=null && x.a.js>nowMin && (agora.proxima==null || x.a.js<agora.proxima)) agora.proxima=x.a.js;
      if(x.v.blocks.some(function(b){return b.st==='win' && nowMin>=b.s && nowMin<b.e;})) agora.janela++;
      else if(x.v.ceia && nowMin>=x.v.ceia.s && nowMin<x.v.ceia.e) agora.ceia++;
      if(isFreeAt(x.a,x.v,nowMin)) agora.livres++;
    });

    if(agora.proxima==null && !agora.jornada){ working.forEach(function(x){ if(x.a.js!=null && (agora.proxima==null || x.a.js<agora.proxima)) agora.proxima=x.a.js; }); agora.seguinte=agora.proxima!=null; }
    working.forEach(function(x){ if(agora.proxima!=null && x.a.js===agora.proxima) agora.comecam++; });
    list.forEach(function(x){ x.v.blocks.forEach(function(b){ if(b.st==='win' && b.s>=nowMin && b.s<nowMin+120) prox.push({a:x.a,b:b}); }); });
    prox.sort(function(p,q){ return p.b.s-q.b.s || p.a.name.localeCompare(q.a.name); });
  }

  var k=[
    ['Escalados', T.esc, T.n+' no filtro · '+T.off+' de folga · '+T.vac+' de férias/afastados'],
    ['Janelas de roteirização', T.win, Object.keys(hubs).length+' hubs · '+Object.keys(turnos).length+' turno(s)'],
    ['Horas com demanda', hh(T.dem), pct(T.dem,T.jor)+' da jornada ('+hh(T.jor)+')'],
    ['Pico de janelas', pico? pico.win : '—', pico? 'às '+fmt(pico.s)+'–'+fmt(pico.e) : 'sem janelas no dia'],
    agora && agora.jornada ? ['Livres agora', agora.livres, agora.janela+' em janela · '+agora.ceia+' em ceia'] :
      agora && agora.proxima!=null ? ['Próxima jornada', fmt(agora.proxima), agora.seguinte? 'no próximo dia operacional' : agora.comecam+' analista(s) começam'] :
      ['Menor folga', aperto? aperto.free.length : '—', aperto? 'livres às '+fmt(aperto.s)+'–'+fmt(aperto.e) : 'sem janelas no dia'],
    ['Pontos de atenção', att.length, (atrasos.length? atrasos.length+' hub(s) atrasado(s) · ' : '')+T.desc+' sem cobertura · '+T.conf+' com conflito · '+rhN+' de RH', T.desc+T.conf+rhN+atrasos.length>0]
  ];
  $('kpis').innerHTML = k.map(function(x){ return '<div class="kpi'+(x[3]?' alert':'')+'"><div class="k">'+x[0]+'</div><div class="v">'+x[1]+'</div><div class="h">'+x[2]+'</div></div>'; }).join('');

  var ordem=SUPS.filter(function(s){return S[s];}).concat(Object.keys(S).filter(function(s){return SUPS.indexOf(s)<0;}));
  function linha(r){ return '<td>'+r.esc+'</td><td>'+r.off+'</td><td>'+r.vac+'</td><td>'+(r.nos+r.tbd)+'</td><td>'+r.win+'</td><td>'+hh(r.dem)+'</td><td>'+pct(r.dem,r.jor)+'</td><td>'+(r.att?'<b style="color:var(--st-crit)">'+r.att+'</b>':'0')+'</td>'; }
  var supT='<table class="htab rs-sup"><thead><tr><th>Supervisor</th><th>Escalados</th><th>Folga</th><th>Férias / afast.</th><th>Sem escala</th><th>Janelas</th><th>Com demanda</th><th>Ocupação</th><th>Atenção</th></tr></thead><tbody>'+
    ordem.map(function(n){ return '<tr data-sup="'+esc(n)+'" title="Filtrar pela equipe"><th>'+first(n)+'</th>'+linha(S[n])+'</tr>'; }).join('')+
    (ordem.length>1? '<tr class="tot"><th>Total</th>'+linha(T)+'</tr>' : '')+'</tbody></table>';
  var attH=att.length? '<ul class="rs-att">'+att.map(function(it){
      return '<li style="--rs-c:'+it.cor+'"'+(it.a?' data-ana="'+esc(it.a.name)+'" title="Ver na Prévia da escala"':'')+'><b>'+it.tipo+(it.a?' · '+esc(it.a.name)+' <span class="pill">'+first(it.a.sup)+'</span>':'')+'</b><small>'+it.txt+'</small></li>';
    }).join('')+'</ul>' : '<p class="vazio-lista">Nada pedindo atenção: todos os hubs com analista, sem conflito e tudo dentro da jornada.</p>';
  var chips=Object.keys(turnos).sort().map(function(j){ return '<span>'+esc(j)+' · '+turnos[j]+'</span>'; }).join('') || '<p class="vazio-lista">Sem janelas no dia.</p>';
  var proxH=agora? '<h2>Próximas 2 horas</h2><p class="cs">Janelas que começam até '+fmt(nowMin+120)+'. '+(agora.jornada? 'Agora: '+agora.janela+' em janela, '+agora.ceia+' em ceia e '+agora.livres+' livres.' : (agora.proxima!=null? 'Ninguém na jornada agora; a próxima começa às '+fmt(agora.proxima)+(agora.seguinte?' (próximo dia operacional)':'')+'.' : 'Ninguém na jornada agora.'))+'</p>'+
    (prox.length? '<ul class="lista">'+prox.map(function(p){ return '<li><b>'+fmt(p.b.s)+'–'+fmt(p.b.e)+' · '+hub(p.b)+'</b><small>'+esc(p.a.name)+' · '+esc(p.b.h.jan||'')+'</small></li>'; }).join('')+'</ul>' : '<p class="vazio-lista">Nenhuma janela começa nas próximas 2 horas.</p>') : '';

  var per=working.filter(function(x){ return x.a.js!=null && x.v.status!=='nosched'; }).map(function(x){
    var a=x.a, v=x.v, wins=v.blocks.filter(function(b){return b.st==='win';}), hs={}, maxF=null;
    wins.forEach(function(b){ hs[b.h.code||b.h.name]=1; });
    v.free.forEach(function(f){ if(!maxF || f[1]-f[0]>maxF[1]-maxF[0]) maxF=f; });
    var jor=a.je-a.js, dem=unionLen(wins.map(function(b){return [Math.max(b.s,a.js),Math.min(b.e,a.je)];}).filter(function(r){return r[1]>r[0];}));
    return {a:a, v:v, dem:dem, jor:jor, occ:jor? dem/jor : 0, livre:maxF, nh:Object.keys(hs).length, nw:wins.length};
  });
  var carregados=per.slice().sort(function(p,q){ return q.occ-p.occ || q.nw-p.nw || p.a.name.localeCompare(q.a.name); }).slice(0,5);
  var folgados=per.filter(function(r){return r.livre;}).sort(function(p,q){ return (q.livre[1]-q.livre[0])-(p.livre[1]-p.livre[0]) || p.a.name.localeCompare(q.a.name); }).slice(0,5);
  function mini(arr, fn, vazio){ return arr.length? '<ul class="rs-mini">'+arr.map(fn).join('')+'</ul>' : '<p class="vazio-lista">'+vazio+'</p>'; }
  function quem(a){ return ' data-ana="'+esc(a.name)+'" title="Ver na Prévia da escala"'; }
  function nome(a){ return '<b>'+esc(a.name)+' <span class="pill">'+first(a.sup)+'</span></b>'; }
  var cargaH='<div class="rs-two"><div><p class="rs-h3">Mais ocupados</p>'+mini(carregados,function(r){
      return '<li'+quem(r.a)+'>'+nome(r.a)+'<em>'+Math.round(r.occ*100)+'%</em><small>'+r.nw+' janela(s) · '+r.nh+' hub(s) · '+hh(r.dem)+' de '+hh(r.jor)+'</small>'+
        '<div class="hst"><span style="width:'+Math.round(r.occ*100)+'%;background:var(--busy)"></span></div></li>';
    },'Ninguém escalado com jornada.')+'</div>'+
    '<div><p class="rs-h3">Mais tempo livre seguido</p>'+mini(folgados,function(r){
      return '<li'+quem(r.a)+'>'+nome(r.a)+'<em>'+dur(r.livre[1]-r.livre[0])+'</em><small>livre das '+fmt(r.livre[0])+' às '+fmt(r.livre[1])+' · ocupação '+Math.round(r.occ*100)+'%</small></li>';
    },'Ninguém com tempo livre na jornada.')+'</div></div>';

  var folgaL=list.filter(function(x){return x.v.status==='off';}), afastL=list.filter(function(x){return x.v.status==='vac';});
  var heL=working.filter(function(x){ return /hora extra/i.test((x.a.team&&x.a.team.status)||''); });
  function diasAte(ret){ var r=parseDate(ret); return r? Math.round((r-state.date)/864e5) : null; }
  afastL.sort(function(p,q){ return (diasAte(p.a.team.ret)||999)-(diasAte(q.a.team.ret)||999) || p.a.name.localeCompare(q.a.name); });
  var voltam=afastL.filter(function(x){ var d=diasAte(x.a.team.ret); return d!=null && d<=7; }).length;
  var ausH='<p class="rs-h3">De folga ('+folgaL.length+')</p>'+mini(folgaL.slice().sort(function(p,q){return p.a.name.localeCompare(q.a.name);}),function(x){
      return '<li'+quem(x.a)+'>'+nome(x.a)+'<em>'+esc((x.a.team&&x.a.team.status)||'Folga')+'</em></li>';
    },'Ninguém de folga no dia.')+
    '<p class="rs-h3">Férias e afastados ('+afastL.length+(voltam?' · '+voltam+' volta(m) em até 7 dias':'')+')</p>'+mini(afastL,function(x){
      var d=diasAte(x.a.team.ret);
      return '<li'+quem(x.a)+'>'+nome(x.a)+'<em'+(d!=null && d<=7?' style="color:var(--st-run)"':'')+'>'+(x.a.team.ret? 'volta '+esc(x.a.team.ret.slice(0,5))+(d!=null?' ('+(d<=0?'hoje':d===1?'amanhã':'em '+d+' dias')+')':'') : 'sem data de volta')+'</em><small>'+esc(x.a.team.status||'')+'</small></li>';
    },'Ninguém de férias ou afastado.')+
    (heL.length? '<p class="rs-h3">Trabalhando no DSR ('+heL.length+')</p>'+mini(heL,function(x){ return '<li'+quem(x.a)+'>'+nome(x.a)+'<em>hora extra</em></li>'; },'') : '');

  var ceias={}, semCeia=[];
  working.forEach(function(x){ if(x.v.ceia){ var k=x.v.ceia.s; (ceias[k]=ceias[k]||[]).push(x); } else if(x.v.ceiaWarn) semCeia.push(x.a); });
  var ceiaH='<h2>Escala de ceia</h2><p class="cs">Time do Routing Tower: a ceia lançada no app. Demais: 1 hora no tempo livre da jornada, espalhando a equipe (* = regra das 2 horas afrouxada para caber).</p>'+
    (Object.keys(ceias).length? '<ul class="rs-mini">'+Object.keys(ceias).map(Number).sort(function(p,q){return p-q;}).map(function(k){
      var g=ceias[k].sort(function(p,q){return p.a.name.localeCompare(q.a.name);});
      return '<li><b>'+fmt(k)+'–'+fmt(k+CEIA)+'</b><em>'+g.length+'</em><small>'+g.map(function(x){ return esc(x.a.name)+(x.v.ceia.relaxed?'*':''); }).join(', ')+'</small></li>';
    }).join('')+'</ul>' : '<p class="vazio-lista">Sem ceia calculada no dia.</p>')+
    (semCeia.length? '<p class="cs" style="margin-top:8px;color:var(--st-crit)">Sem horário para a ceia: '+nomes(semCeia)+'</p>' : '');

  var regs={};
  list.forEach(function(x){ x.v.blocks.forEach(function(b){
    if(b.st!=='win') return;
    var k=b.h.reg||'Sem região', R=regs[k]||(regs[k]={reg:k,win:0,hubs:{},ana:{},tur:{}});
    R.win++; R.hubs[b.h.code||b.h.name]=1; R.ana[x.a.name]=1; var j=b.h.jan||'—'; R.tur[j]=(R.tur[j]||0)+1;
  }); });
  var regRows=Object.keys(regs).map(function(k){return regs[k];}).sort(function(p,q){ return q.win-p.win || p.reg.localeCompare(q.reg); });
  var regH=regRows.length? '<table class="htab rs-reg"><thead><tr><th>Região</th><th>Janelas</th><th>Hubs</th><th>Analistas</th><th>Turnos</th></tr></thead><tbody>'+
    regRows.map(function(R){ return '<tr data-region="'+esc(R.reg==='Sem região'?'':R.reg)+'"'+(state.region && state.region===R.reg?' class="sel"':'')+' title="Filtrar pela região"><th>'+esc(R.reg)+'</th><td>'+R.win+'</td><td>'+Object.keys(R.hubs).length+'</td><td>'+Object.keys(R.ana).length+'</td><td>'+
      Object.keys(R.tur).sort().map(function(j){return esc(j)+' '+R.tur[j];}).join(' · ')+'</td></tr>'; }).join('')+'</tbody></table>' : '<p class="vazio-lista">Sem janelas no dia.</p>';

  var jors={}, jIni=null, jFim=null;
  working.forEach(function(x){ var a=x.a; if(a.js==null) return; var k=a.js+'-'+a.je; (jors[k]=jors[k]||{s:a.js,e:a.je,ana:[]}).ana.push(a); jIni=jIni==null?a.js:Math.min(jIni,a.js); jFim=jFim==null?a.je:Math.max(jFim,a.je); });
  var jorRows=Object.keys(jors).map(function(k){return jors[k];}).sort(function(p,q){ return p.s-q.s || p.e-q.e; });
  var jorH='<h2>Jornadas</h2><p class="cs">'+(jIni!=null? 'Cobertura das '+fmt(jIni)+' às '+fmt(jFim)+' ('+dur(jFim-jIni)+') com '+working.filter(function(x){return x.a.js!=null;}).length+' analista(s) na jornada.' : 'Ninguém com jornada no dia.')+'</p>'+
    mini(jorRows,function(J){ return '<li><b>'+fmt(J.s)+'–'+fmt(J.e)+'</b><em>'+J.ana.length+'</em><small>'+J.ana.map(function(a){return esc(a.name);}).sort().join(', ')+'</small></li>'; },'');

  var primeira=null, ultima=null, folg=working.filter(function(x){ return x.a.team && x.a.team.sup2; });
  list.forEach(function(x){ x.v.blocks.forEach(function(b){ if(b.st!=='win') return; if(!primeira || b.s<primeira.b.s) primeira={a:x.a,b:b}; if(!ultima || b.e>ultima.b.e) ultima={a:x.a,b:b}; }); });
  var novos=list.filter(function(x){return rtNova(x.a);}).map(function(x){return x.a;});
  var comHub=per.filter(function(r){return r.nh>0;}), maxHub=comHub.slice().sort(function(p,q){return q.nh-p.nh;})[0];
  function tile(r,v,d,dest){ return '<div class="tile'+(dest?' destaque':'')+'"><div class="rotulo">'+r+'</div><div class="valor">'+v+'</div><small>'+d+'</small></div>'; }
  var destH='<div class="card rs-dest"><h2>Destaques do dia</h2><div class="tiles">'+
    tile('Primeira janela', primeira? fmt(primeira.b.s) : '—', primeira? hub(primeira.b)+' · '+esc(primeira.a.name) : 'sem janelas')+
    tile('Última janela termina', ultima? fmt(ultima.b.e) : '—', ultima? hub(ultima.b)+' · '+esc(ultima.a.name) : 'sem janelas')+
    tile('Hubs por analista', comHub.length? (comHub.reduce(function(t,r){return t+r.nh;},0)/comHub.length).toFixed(1).replace('.',',') : '—', maxHub? 'máx. '+maxHub.nh+' · '+esc(maxHub.a.name) : 'ninguém com hub')+
    tile('Mais ocupado', carregados[0]? Math.round(carregados[0].occ*100)+'%' : '—', carregados[0]? esc(carregados[0].a.name)+' · '+carregados[0].nw+' janela(s)' : '')+
    tile('Maior tempo livre seguido', folgados[0]? dur(folgados[0].livre[1]-folgados[0].livre[0]) : '—', folgados[0]? esc(folgados[0].a.name)+' · '+fmt(folgados[0].livre[0])+'–'+fmt(folgados[0].livre[1]) : '', true)+
    tile('Folguistas / suporte', folg.length, folg.length? nomes(folg.map(function(x){return x.a;})) : 'nenhum escalado no dia')+
    (novos.length? tile('Novos na equipe', novos.length, nomes(novos)+' · até 30 dias de casa') : '')+
    '</div></div>';

  box.onclick=function(e){
    var li=e.target.closest('[data-ana]');
    if(li){ state.q=li.dataset.ana; $('fSearch').value=state.q; $('tabEscala').click(); return; }
    var tr=e.target.closest('tr[data-sup]');
    if(tr){ var b=[].slice.call($('supSeg').querySelectorAll('button')).filter(function(x){return x.dataset.v===tr.dataset.sup;})[0]; if(b) b.click(); return; }
    var rg=e.target.closest('tr[data-region]');
    if(rg && rg.dataset.region){ state.region=(state.region===rg.dataset.region?'':rg.dataset.region); $('fRegion').value=state.region; render(); }
  };



  var ev=state.eventos||null, sugH='';
  if(ev){
    var porGrupo=ev.max_per_group||3;
    var cand=(todos||list).filter(function(x){ return !x.v.isOff && x.a.js!=null; });
    function ocupacao(x){ var a=x.a, jor=a.je-a.js; if(!jor) return 0; return unionLen(x.v.blocks.filter(function(b){return b.st==='win';}).map(function(b){return [Math.max(b.s,a.js),Math.min(b.e,a.je)];}).filter(function(r){return r[1]>r[0];}))/jor; }
    function janelaDe(ini, fim){ var s0=op(toMin(ini)), e0=op(toMin(fim)); if(s0==null || e0==null) return null; if(e0<=s0) e0+=1440; return [s0,e0]; }
    function livreEm(x, s0, e0){ var tl=0; x.v.free.forEach(function(f){ var i=Math.max(f[0],s0), j=Math.min(f[1],e0); if(j>i) tl+=j-i; }); return tl; }
    function grupos(evt, s0, e0, exceto){
      var g=[[],[],[]];
      cand.forEach(function(x){
        if(exceto && key(x.a.name)===key(exceto)) return;
        var livre=livreEm(x,s0,e0); if(livre<=0) return;
        var i = evt.sup && sameSup(x.a.sup, evt.sup) ? 0 : (evt.reg && x.a.regions[evt.reg] ? 1 : 2);
        g[i].push({x:x, livre:livre, toda:livre>=e0-s0, occ:ocupacao(x)});
      });
      g.forEach(function(l){ l.sort(function(p,q){ return (q.toda-p.toda) || (q.livre-p.livre) || (p.occ-q.occ) || p.x.a.name.localeCompare(q.x.a.name); }); });
      return g;
    }
    var itens=[];
    atrasos.forEach(function(l){
      var jw=janelaDe(l.rti, l.rtf); if(!jw) return;
      var ini=nowMin!=null? Math.max(nowMin, jw[0]) : jw[0];
      itens.push({cor:'var(--st-crit)', tipo:'Hub atrasado', titulo:esc((l.station||'')+(l.hub?' · '+l.hub:'')),
        info:'janela '+fmt(jw[0])+'–'+fmt(jw[1])+' · '+l.atraso+' min sem início · '+esc(l.analista||''), evt:{sup:l.sup, reg:l.reg}, s:ini, e:ini+(jw[1]-jw[0]), exceto:l.analista});
    });
    (ev.comunicacoes||[]).forEach(function(c){
      var jw=janelaDe(c.inicio, c.fim);
      itens.push({cor:c.cor||'var(--accent)', tipo:esc(c.tipo), titulo:c.hub? esc(c.hub+(c.hub_nome?' · '+c.hub_nome:'')) : esc(c.titulo),
        info:(jw? 'janela '+fmt(jw[0])+'–'+fmt(jw[1]) : 'sem janela informada')+(c.desde? ' · a partir de '+esc(c.desde.slice(8,10)+'/'+c.desde.slice(5,7)) : '')
          +' · '+(c.origem==='comunicado'? 'comunicado' : 'solicitação')+' "'+esc(c.titulo)+'"', evt:{sup:c.sup, reg:c.reg}, s:jw?jw[0]:null, e:jw?jw[1]:null});
    });
    var nomesG=function(evt){ return ['Mesmo supervisor'+(evt.sup? ' ('+first(evt.sup)+')' : ''), 'Mesma regional'+(evt.reg? ' ('+esc(evt.reg)+')' : ''), 'Outros']; };
    sugH='<div class="card rs-sug'+(itens.length?'':' vazio')+'"><h2>Sugestões de analistas</h2>'+
      (itens.length? '<p class="cs">Quem está livre na janela de cada hub atrasado (mais de '+(ev.late_minutes||10)+' min sem início), novo hub ou alteração de opsclock: primeiro o mesmo supervisor, depois a mesma regional, depois os outros. Clique num nome para ver na Prévia.</p><div class="rs-sug-list">'+
        itens.slice(0,8).map(function(it){
          var corpo;
          if(it.s==null) corpo='<p class="vazio-lista">Informe a janela (início e fim) na comunicação para ver quem está livre.</p>';
          else {
            var gr=grupos(it.evt, it.s, it.e, it.exceto), ng=nomesG(it.evt);
            corpo=gr.map(function(g,i){ if(!g.length) return ''; return '<p class="rs-h3">'+ng[i]+'</p><ul class="rs-mini">'+g.slice(0,porGrupo).map(function(c){
              return '<li'+quem(c.x.a)+'>'+nome(c.x.a)+'<em>'+(c.toda?'livre a janela toda':'livre '+dur(c.livre)+' de '+dur(it.e-it.s))+'</em><small>jornada '+fmt(c.x.a.js)+'–'+fmt(c.x.a.je)+' · ocupação '+Math.round(c.occ*100)+'%</small></li>';
            }).join('')+'</ul>'; }).join('') || '<p class="vazio-lista">Ninguém livre nessa janela.</p>';
          }
          return '<article class="rs-sug-item" style="--rs-c:'+it.cor+'"><header><b>'+it.tipo+' · '+it.titulo+'</b><small>'+it.info+'</small></header>'+corpo+'</article>';
        }).join('')+'</div>'
      : '<p class="cs">Nada pedindo cobertura agora: nenhum hub com mais de '+(ev.late_minutes||10)+' min sem início e nenhuma comunicação aberta de novo hub ou alteração de opsclock.</p>')+'</div>';
  }
  var avisoH=state.prevista? '<div class="rs-aviso"><b>Dia ainda sem escala publicada no Routing Tower.</b> O time aparece com a escala <b>prevista</b>, repetindo a de '+state.prevista.slice(8,10)+'/'+state.prevista.slice(5,7)+'; folgas, DSR e férias já lançados valem.</div>' : '';
  box.innerHTML=
    avisoH+destH+sugH+
    '<div class="rs-grid">'+
      '<div class="card"><h2>Por supervisor</h2><p class="cs">Escalados, folgas, férias, janelas e horas com demanda de cada equipe no dia. Clique numa equipe para filtrar.</p><div class="chartwrap">'+supT+'</div></div>'+
      '<div class="card"><h2>Pontos de atenção</h2><p class="cs">Do mais grave para o menos grave. Clique num item para ver o analista na Prévia da escala.</p>'+attH+'</div>'+
    '</div>'+
    '<div class="rs-grid">'+
      '<div class="card"><h2>Carga por analista</h2><p class="cs">Ocupação = tempo da jornada com janela. O maior tempo livre seguido mostra quem pode assumir um hub. Clique num nome para ver na Prévia.</p>'+cargaH+'</div>'+
      '<div class="card"><h2>Ausências e retornos</h2><p class="cs">Quem não trabalha no dia e quando volta.</p>'+ausH+'</div>'+
    '</div>'+
    '<div class="rs-grid">'+
      '<div class="card"><h2>Hora a hora</h2><p class="cs">Analistas na jornada a cada hora: em janela, em ceia e livres. Em vermelho, a hora com mais janelas'+(agora?'; com contorno, a hora atual':'')+'.</p>'+
        '<div class="clegend"><span><i style="background:var(--busy)"></i>Em janela</span><span><i style="background:var(--ceia)"></i>Em ceia</span><span><i style="background:var(--st-run)"></i>Livres</span></div><div class="chartwrap">'+horaT+'</div></div>'+
      '<div class="card">'+proxH+ceiaH+'</div>'+
    '</div>'+
    '<div class="rs-grid">'+
      '<div class="card"><h2>Regiões</h2><p class="cs">Janelas, hubs, analistas e turnos de cada região no dia. Clique numa região para filtrar (clique de novo para tirar).</p><div class="chartwrap">'+regH+'</div></div>'+
      '<div class="card">'+jorH+'<h2 style="margin-top:16px">Janelas por turno</h2><p class="cs">Quantas janelas de roteirização cada turno tem no dia.</p><div class="rs-chips">'+chips+'</div></div>'+
    '</div>';
}
function renderTable(list){
  $('scroller').style.display='none'; var tw=$('tablewrap'); tw.style.display='block';
  var rows=list.map(function(x){
    var a=x.a, v=x.v;
    var win=v.blocks.map(function(b){ return esc((b.h.code||b.h.name)+' '+fmt(b.s)+'–'+fmt(b.e)+(b.st==='unk'?' (a definir)':'')+(b.st==='desc'?' (sem cobertura)':'')+(b.conf?' ⚠ conflito':'')); }).join('<br>');
    var free=v.free.map(function(f){return fmt(f[0])+'–'+fmt(f[1]);}).join(', ');
    var st = v.isOff? v.label : (v.status==='nosched'?'Sem escala de hubs':(v.status==='tbd'?'Escala não definida':'Escalado'))+(a.team&&a.team.status&&!v.isOff?' · '+esc(a.team.status):'');
    return '<tr><td><b>'+esc(a.name)+'</b></td><td>'+esc(a.sup)+'</td><td>'+st+'</td><td>'+(a.js!=null?fmt(a.js)+'–'+fmt(a.je):'—')+'</td><td>'+(win||'—')+'</td><td>'+(v.ceia?fmt(v.ceia.s)+'–'+fmt(v.ceia.e):(v.ceiaWarn?'sem espaço':'—'))+'</td><td>'+(free||'—')+'</td><td>'+esc(v.off.map(function(h){return h.code||h.name;}).join(', ')||'—')+'</td></tr>';
  }).join('');
  tw.innerHTML='<table><thead><tr><th>Analista</th><th>Supervisor</th><th>Status</th><th>Jornada</th><th>Janelas de roteirização</th><th>Ceia</th><th>Livre</th><th>Hubs sem operação no dia</th></tr></thead><tbody>'+rows+'</tbody></table>';
}

/* ---------- tooltip ---------- */
var tip=$('tip');
function showTip(html,e){ tip.innerHTML=html; tip.style.display='block'; moveTip(e); }
function moveTip(e){ var w=tip.offsetWidth,h=tip.offsetHeight,x=e.clientX+14,y=e.clientY+14; if(x+w>innerWidth-8)x=e.clientX-w-14; if(y+h>innerHeight-8)y=e.clientY-h-14; tip.style.left=x+'px'; tip.style.top=y+'px'; }
function r2(k,v){ return '<div class="r"><span>'+k+'</span><span>'+v+'</span></div>'; }

root.addEventListener('mousemove',function(e){
  var el=e.target.closest && e.target.closest('[data-b],[data-k],[data-c],[data-slot],[data-slotw],[data-ds]');
  var hr=e.target.closest && e.target.closest('[data-hr]');
  var hq=e.target.closest && e.target.closest('[data-hh]');
  if(hq && state._hrsRows){ var Q=state._hrsRows[+hq.dataset.hh]; if(Q){ showTip('<b>'+esc(Q.a.name)+'</b>'+r2('Jornada',fmt(Q.a.js)+'–'+fmt(Q.a.je)+' ('+dur(Q.jor)+')')+r2('Com demanda',dur(Q.dem)+' · '+Math.round(Q.dem/Q.jor*100)+'%')+r2('Ceia',Q.ceia?dur(Q.ceia):'sem espaço')+r2('Disponível',dur(Q.livre)),e); return; } }
  var rr=e.target.closest && e.target.closest('[data-rr]');
  if(rr && state._regRows){
    var G=state._regRows[+rr.dataset.rr];
    if(G){ var an=Object.keys(G.ana).sort(); showTip('<b>'+esc(G.reg)+'</b>'+r2('Ciclos no dia',G.n)+Object.keys(G.byT).sort().map(function(t){return r2('&nbsp;&nbsp;'+esc(t),G.byT[t]);}).join('')+r2('Hubs',G.nh)+r2('Analistas',G.na)+
      '<div style="margin-top:6px;opacity:.85">'+an.slice(0,12).map(function(n){return esc(n)+' <span style="opacity:.7">('+esc(G.ana[n].split(' ')[0])+')</span>';}).join('<br>')+(an.length>12?'<br>+'+(an.length-12)+' outros':'')+'</div>',e); return; }
  }
  if(hr && state._hubRows){
    var R=state._hubRows[+hr.dataset.hr];
    if(R){ showTip('<b>'+esc(R.a.name)+'</b>'+r2('Supervisor',esc(R.a.sup))+r2('Hubs no dia',R.n)+r2('Janelas',R.wins)+(R.hubs.length?'<div style="margin-top:6px;opacity:.85">'+R.hubs.map(esc).join('<br>')+'</div>':''),e); return; }
  }
  if(el && el.dataset.ds!=null){
    var ds=state._dslots[+el.dataset.ds]; if(!ds){tip.style.display='none';return;}
    showTip('<b>'+fmt(ds.s)+'–'+fmt(ds.e)+'</b>'+r2('Disponíveis',ds.free.length)+r2('Em janela de roteirização',ds.busy.length)+r2('Em ceia',ds.meal.length)+r2('Total em jornada',ds.free.length+ds.busy.length+ds.meal.length)+
      (el.dataset.sup?r2(esc(el.dataset.sup),ds.bySup[el.dataset.sup]||0):'')+'<div style="margin-top:6px;opacity:.7">Clique para ver os nomes</div>',e); return;
  }
  if(!el || !state._list){ tip.style.display='none'; return; }
  if(el.dataset.slot!=null || el.dataset.slotw!=null){
    var sl=state._slots[+(el.dataset.slot!=null?el.dataset.slot:el.dataset.slotw)];
    var names=sl.free.slice(0,14).map(function(f){return esc(f.a.name);}).join('<br>')+(sl.free.length>14?'<br>+'+(sl.free.length-14)+' outros':'');
    showTip('<b>'+fmt(sl.s)+'–'+fmt(sl.e)+'</b>'+r2('Disponíveis',sl.free.length)+r2('Em janela de roteirização',sl.busy.length)+r2('Em ceia',sl.meal.length)+r2('Janelas em andamento',sl.win)+(sl.free.length?'<div style="margin-top:6px;opacity:.85">'+names+'</div>':''),e); return;
  }
  var x=state._list[+el.dataset.a]; if(!x){ tip.style.display='none'; return; }
  if(el.dataset.c){
    var cv=x.v.ceia; showTip('<b>Ceia · '+esc(x.a.name)+'</b>'+r2('Horário',fmt(cv.s)+'–'+fmt(cv.e))+r2('Jornada',fmt(x.a.js)+'–'+fmt(x.a.je))+
      '<div style="margin-top:6px;opacity:.8">'+(cv.relaxed?'Sem espaço fora das 2h de início/fim; ficou a pelo menos 1h das pontas.':'Fora das 2 primeiras e 2 últimas horas da jornada.')+'</div>',e); return;
  }
  if(el.dataset.k==='j'){
    var a=x.a, v=x.v;
    var free=v.free.map(function(f){return fmt(f[0])+'–'+fmt(f[1])+' ('+dur(f[1]-f[0])+')';}).join('<br>');
    showTip('<b>'+esc(a.name)+'</b>'+r2('Supervisor',esc(a.sup))+r2('Jornada',fmt(a.js)+'–'+fmt(a.je))+
      (a.team&&a.team.office?r2('Office',esc(a.team.office+(a.team.station?' · '+a.team.station:''))):'')+
      (a.team&&a.team.status?r2('Status RH',esc(a.team.status)+(a.team.ret?' (retorno '+esc(a.team.ret)+')':'')):'')+
      (a.team&&a.team.sup2?r2('Suporte',esc(a.team.sup2)):'')+
      (v.ceia?r2('Ceia',fmt(v.ceia.s)+'–'+fmt(v.ceia.e)):(v.ceiaWarn?r2('Ceia','sem espaço livre'):''))+
      (v.isOff?r2('No dia',esc(v.label)):v.status==='nosched'?r2('No dia','Sem escala de hubs — disponível a jornada toda'):r2('Janelas no dia',v.blocks.length)+(free?'<div style="margin-top:6px"><span style="opacity:.7">Livre:</span><br>'+free+'</div>':''))+
      (v.off.length?'<div style="margin-top:6px;opacity:.85">Sem operação hoje: '+esc(v.off.map(function(h){return h.code||h.name;}).join(', '))+'</div>':''),e);
    return;
  }
  var b=x.v.blocks[+el.dataset.b]; if(!b){ tip.style.display='none'; return; }
  showTip('<b>'+esc(b.h.code||'Hub sem código')+'</b><div style="opacity:.85;margin-bottom:4px">'+esc(b.h.name)+'</div>'+
    r2('Janela',fmt(b.s)+'–'+fmt(b.e)+' ('+dur(b.e-b.s)+')')+r2('Turno',esc(b.h.jan||'—'))+r2('Escala do hub',esc(b.h.shifts||'—'))+
    r2('Região',esc(b.h.reg||'—'))+(b.st==='desc'?'<div style="margin-top:6px;color:#ff9b9b">⚠ Analista de '+esc((x.a.team&&x.a.team.status)||'afastamento')+' — hub sem cobertura</div>':'')+(b.st==='unk'?'<div style="margin-top:6px;color:#ffd38a">Escala do hub não definida para este dia</div>':'')+
    (b.conf?'<div style="margin-top:6px;color:#ff9b9b">⚠ Sobrepõe outra janela do analista</div>':'')+
    (b.out?'<div style="margin-top:6px;color:#ff9b9b">⚠ Fora da jornada '+fmt(x.a.js)+'–'+fmt(x.a.je)+'</div>':'')+
    (b.h.check?'<div style="margin-top:6px;color:#ffd38a">Verificar HUB_SORT_CODE na planilha</div>':''),e);
});
root.addEventListener('scroll',function(){tip.style.display='none';},true);
document.addEventListener('scroll',function(){tip.style.display='none';},true);

/* ---------- controles ---------- */
function setupControls(){
  var seg=$('supSeg');
  seg.innerHTML=['Todos'].concat(SUPS).map(function(s,i){ return '<button type="button" data-v="'+(i?esc(s):'')+'" aria-pressed="'+(i?'false':'true')+'">'+esc(i?s.split(' ')[0]:s)+'</button>'; }).join('');
  seg.addEventListener('click',function(e){ var b=e.target.closest('button'); if(!b) return; state.sup=b.dataset.v; seg.querySelectorAll('button').forEach(function(x){x.setAttribute('aria-pressed',String(x===b));}); render(); });
  $('fRegion').addEventListener('change',function(e){state.region=e.target.value;render();});
  $('fTurno').addEventListener('change',function(e){state.turno=e.target.value;render();});
  $('fSort').addEventListener('change',function(e){state.sort=e.target.value;render();});
  $('fSearch').addEventListener('input',function(e){state.q=e.target.value;render();});
  $('prev').onclick=function(){ state.date=new Date(state.date.getTime()-864e5); state.selSlot=null; render(); refreshDay(); };
  $('next').onclick=function(){ state.date=new Date(state.date.getTime()+864e5); state.selSlot=null; render(); refreshDay(); };
  $('today').onclick=function(){ state.date=opsToday().date; $('scroller').dataset.ready=''; render(); refreshDay(); };
  $('viewToggle').onclick=function(){ state.table=!state.table; this.textContent=state.table?'Ver linha do tempo':'Ver tabela'; render(); };
  $('pdf').onclick=function(){
    document.body.classList.add('printing-visibilidade');
    window.addEventListener('afterprint',function fim(){ document.body.classList.remove('printing-visibilidade'); window.removeEventListener('afterprint',fim); });
    window.print();
  };

  function applyTheme(){ host.setAttribute('data-theme', document.documentElement.getAttribute('data-theme')==='dark'?'dark':'light'); }
  applyTheme();
  new MutationObserver(function(){ applyTheme(); if(visible()) render(); }).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
  function setTab(t){
    state.tab=t; $('tabEscala').setAttribute('aria-selected',String(t==='escala')); $('tabDash').setAttribute('aria-selected',String(t==='dash')); $('tabAnalise').setAttribute('aria-selected',String(t==='analise'));
    $('viewEscala').hidden = t!=='escala'; $('viewDash').hidden = t!=='dash'; $('viewAnalise').hidden = t!=='analise';
    $('viewResumo').hidden = t!=='resumo'; $('tabResumo').setAttribute('aria-selected',String(t==='resumo'));
    $('sortField').style.display = t!=='escala'?'none':''; $('stepSeg').hidden = t!=='dash'; $('viewToggle').style.display = t!=='escala'?'none':'';
    try{ localStorage.setItem('escalaTab',t); }catch(e){}
    render();
  }
  $('tabEscala').onclick=function(){ setTab('escala'); };
  $('tabDash').onclick=function(){ setTab('dash'); };
  $('tabAnalise').onclick=function(){ setTab('analise'); };
  $('tabResumo').onclick=function(){ setTab('resumo'); };
  $('viewAnalise').addEventListener('click',function(e){ var rg=e.target.closest('[data-region]'); if(rg && rg.dataset.region){ state.region=(state.region===rg.dataset.region?'':rg.dataset.region); $('fRegion').value=state.region; render(); } });
  $('stepSeg').addEventListener('click',function(e){ var b=e.target.closest('button'); if(!b) return; state.step=+b.dataset.v; this.querySelectorAll('button').forEach(function(x){x.setAttribute('aria-pressed',String(x===b));}); render(); });
  $('viewDash').addEventListener('click',function(e){
    var rg=e.target.closest('[data-region]');
    if(rg && rg.dataset.region){ state.region=(state.region===rg.dataset.region?'':rg.dataset.region); $('fRegion').value=state.region; render(); return; }
    var el=e.target.closest('[data-ds]'); if(!el) return; var s=state._dslots[+el.dataset.ds]; if(s){ state.selSlot=s.s; render(); } });

  var st0=null; try{ st0=localStorage.getItem('escalaTab'); }catch(e){}
  setTimeout(function(){ setTab(st0==='escala'||st0==='dash'||st0==='analise'? st0 : 'resumo'); },0);
  var rt; window.addEventListener('resize',function(){ clearTimeout(rt); rt=setTimeout(function(){ if(visible()) render(); },120); });
  setInterval(function(){ if(visible() && ((!state.table && state.tab==='escala') || state.tab==='resumo')) render(); }, 60*1000);
}
function fillOptions(){
  var regs={}, turns={};
  state.analysts.forEach(function(a){ Object.keys(a.regions).forEach(function(r){regs[r]=1;}); a.hubs.forEach(function(h){ if(h.jan) turns[h.jan]=1; }); });
  function fill(id,obj){ var sel=$(id), cur=sel.value; sel.length=1; Object.keys(obj).sort().forEach(function(v){ var o=document.createElement('option'); o.value=o.textContent=v; sel.appendChild(o); }); sel.value=cur; }
  fill('fRegion',regs); fill('fTurno',turns);
}
function load(records, updated, team){
  state.records=records; state.analysts=mergeTeam(build(records), team);
  state.updated=updated||null; fillOptions(); render();
}
var SHEET_ID='DEMONSTRACAO', GID_SCHEDULE='0', GID_EQUIPE='559233863';
function parseCSV(s){ var rows=[],row=[],f='',q=false; for(var i=0;i<s.length;i++){ var c=s[i];
  if(q){ if(c==='"'){ if(s[i+1]==='"'){f+='"';i++;} else q=false; } else f+=c; }
  else { if(c==='"') q=true; else if(c===','){row.push(f);f='';} else if(c==='\n'){row.push(f.replace(/\r$/,''));rows.push(row);row=[];f='';} else f+=c; } }
  if(f!==''||row.length){ row.push(f.replace(/\r$/,'')); rows.push(row); } return rows; }
function getCSV(gid){
  return fetch('https://docs.google.com/spreadsheets/d/'+SHEET_ID+'/export?format=csv&gid='+gid,{credentials:'include',cache:'no-store'}).then(function(r){
    var ct=r.headers.get('content-type')||'';
    if(!r.ok || ct.indexOf('text/csv')<0) throw new Error('sem acesso');
    return r.text();
  }).then(parseCSV);
}
function showError(msg){
  var html='<div class="card"><div class="empty" style="padding:30px;text-align:center">'+msg+'</div></div>';
  $('scroller').innerHTML='<div class="empty" style="padding:30px;text-align:center">'+msg+'</div>'; $('viewDash').innerHTML=html; $('viewAnalise').innerHTML=html; $('viewResumo').innerHTML=html;
  $('updated').textContent='Não foi possível ler a planilha';
}
var API_URL='https://demo.invalid/disabled-script';
function getAPI(){
  return fetch(API_URL,{credentials:'include',cache:'no-store'}).then(function(r){
    var ct=r.headers.get('content-type')||'';
    if(!r.ok || ct.indexOf('json')<0) throw new Error('api');
    return r.json();
  });
}
function fetchViaCSV(){
  return Promise.all([getCSV(GID_SCHEDULE), getCSV(GID_EQUIPE).catch(function(){ return []; })]).then(function(res){ return {rows:res[0], team:res[1]}; });
}



var rtVis={ sheet:null, days:{} };
function rtVisDay(){ var d=state.date; return d.getUTCFullYear()+'-'+('0'+(d.getUTCMonth()+1)).slice(-2)+'-'+('0'+d.getUTCDate()).slice(-2); }
function getRT(){
  var day=rtVisDay();
  if(rtVis.days[day]) return Promise.resolve(rtVis.days[day]);
  return fetch(api('rpc/rt_visibility_schedule'),{method:'POST',headers:headers,body:JSON.stringify({p_token:currentSupervisorToken(),p_date:day})})
    .then(function(r){ if(!r.ok) throw new Error('rt'); return r.json(); })
    .then(function(res){ rtVis.days[day]=res; return res; });
}
function rebuildSups(){
  var seg=$('supSeg'); if(!seg) return;
  seg.innerHTML=['Todos'].concat(SUPS).map(function(s,i){ var v=i?s:''; return '<button type="button" data-v="'+esc(v)+'" aria-pressed="'+String(state.sup===v)+'">'+esc(i?s.split(' ')[0]:s)+'</button>'; }).join('');
}


function sameSup(a,b){
  var ta=key(a).split(' '), tb=key(b).split(' ');
  if(!ta[0] || ta[0]!==tb[0]) return false;
  var sh=ta.length<=tb.length?ta:tb, lg=ta.length<=tb.length?tb:ta;
  return sh.every(function(x){ return lg.indexOf(x)>=0; });
}

function rtNova(a){
  var d=a.team&&a.team.since? parseDate(a.team.since) : null;
  return !!d && d<=state.date && (state.date-d)<=30*864e5;
}
function mergeLive(){
  var rt=rtVis.days[rtVisDay()]||null, sheet=rtVis.sheet;
  if(!rt && !sheet) return false;
  var own=rt? rt.sups||[] : [], grew=false;
  own.forEach(function(s){
    var i=-1; SUPS.forEach(function(x,j){ if(i<0 && sameSup(x,s)) i=j; });
    if(i<0){ SUPS.push(s); grew=true; }
    else if(SUPS[i]!==s){ if(state.sup===SUPS[i]) state.sup=s; SUPS[i]=s; grew=true; }
  });
  if(grew) rebuildSups();
  function isOwn(n){ return own.some(function(s){ return sameSup(n,s); }); }
  var rows=(sheet? fromSheet(sheet.rows).filter(function(r){ return !isOwn(r.sup); }) : []).concat(rt? fromSheet(rt.rows) : []);
  var team=(sheet? fromTeam(sheet.team||[]).filter(function(x){ return !isOwn(x.sup); }) : []).concat(rt? fromTeam(rt.team||[]) : []);
  state.rh=(rt && rt.rh)||[];
  state.prevista=(rt && rt.projected && rt.base_date)? rt.base_date : null;
  var d=new Date(), hh=('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2);
  var src= rt && sheet ? 'Routing Tower ao vivo + Gestão T3' : (rt ? 'Routing Tower ao vivo · planilha Gestão T3 indisponível' : 'Gestão T3 · Routing Tower indisponível');
  if(state.prevista) src+=' · Routing Tower: escala PREVISTA (repete '+state.prevista.slice(8,10)+'/'+state.prevista.slice(5,7)+')';
  load(rows, src+' · atualizado às '+hh+' · atualiza a cada 10 min', team);
  return true;
}
function fetchLive(){
  $('updated').textContent='Atualizando…';
  rtVis.days={};
  var pSheet=getAPI().catch(function(){ return fetchViaCSV(); }).then(function(res){ rtVis.sheet=res; }, function(){ rtVis.sheet=null; });
  var pRT=getRT().catch(function(){ return null; });
  Promise.all([pSheet,pRT]).then(function(){
    getEventos();
    if(mergeLive()) return;
    showError('Não foi possível carregar os dados.<br>Confira se o Chrome está logado com a sua conta <b>@shopee.com</b> (abra o Gmail ou o Drive numa aba) e clique em <b>Atualizar</b>.'+(location.protocol==='http:'?'<br><br>Este painel foi aberto pelo app (127.0.0.1), e aqui o Chrome não deixa ler a planilha. Abra o painel pelo ícone do <b>Routing Tower</b> no Chrome, ou use o botão <b>Planilha</b>.':''));
  });
}


function getEventos(){
  var day=rtVisDay();
  return fetch(api('rpc/rt_visibility_events'),{method:'POST',headers:headers,body:JSON.stringify({p_token:currentSupervisorToken(),p_date:day})})
    .then(function(r){ if(!r.ok) throw new Error('eventos'); return r.json(); })
    .then(function(res){ if(day!==rtVisDay()) return; state.eventos=res; if(visible() && state.tab==='resumo') render(); },
          function(){ state.eventos=null; });
}
setInterval(function(){ if(!document.hidden && visible() && state.tab==='resumo') getEventos(); }, 5*60*1000);

function refreshDay(){ state.eventos=null; getEventos(); if(rtVis.days[rtVisDay()]){ mergeLive(); return; } getRT().then(mergeLive, function(){}); }

state.date=opsToday().date;
setupControls();
$('refreshBtn').onclick=fetchLive;
$('sheetBtn').onclick=function(){ window.open('https://docs.google.com/spreadsheets/d/'+SHEET_ID+'/edit','_blank'); };
if(window.PREVIEW_DATA){ load(fromPreview(window.PREVIEW_DATA), 'Prévia de teste', teamFromPreview(window.PREVIEW_TEAM)); }
else { fetchLive(); setInterval(function(){ if(!document.hidden && visible()) fetchLive(); }, 10*60*1000); }
return { show: function(){ render(); } };

}
let rtVisibilidadeApi = null;
function rtVisibilidadeOpen() {
  const host = document.getElementById("visibilidadeView");
  if (!host) return;
  if (rtVisibilidadeApi) { rtVisibilidadeApi.show(); return; }
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${RT_VISIBILIDADE_CSS}</style>${RT_VISIBILIDADE_HTML}`;
  rtVisibilidadeApi = rtVisibilidadeStart(root, host);
}


if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && (changes.analystToken || changes.supervisorToken || changes.profile)) {
      document.body.replaceChildren(Object.assign(document.createElement('p'), {textContent:'Atualizando acesso…'}));
      rtReadCache.clear().finally(() => location.reload());
    }
  });
}
