
/* =========================================================
   Bitácora — scripts.js (OAuth + rápido + auto-reconnect)
   - POST text/plain (sin preflight)
   - OAuth GIS con refresh silencioso
   - Cola offline + retry backoff
   - Idempotencia (clientId) para no duplicar si reintenta
   ========================================================= */

// ================== CONFIG ==================
// ✅ Usar Google Sheets API directo (más rápido que Apps Script WebApp)
const SPREADSHEET_ID = "1hX4s5KlgHkPzV0PLTo4WY2RemBCGjqaRp_EJ1zsmZig";
const SHEET_NAME = "Bitacora"; // pestaña

// Columnas esperadas:
// A: clientId  (para idempotencia / dedupe)
// B: texto
// C: timestamp ISO

// ================== CONFIG OAUTH (GIS) ==================
const OAUTH_CLIENT_ID = "789127451795-jocq4e8m0su82qe9s9rie3d73tveodmm.apps.googleusercontent.com";

// Scopes
// - openid/email/profile: identidad (para mostrar cuenta)
// - drive.metadata.readonly: scope sensible para que en "Testing" SOLO puedan autorizar los Test Users
const OAUTH_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  // ✅ leer/escribir en la planilla (Sheets API)
  "https://www.googleapis.com/auth/spreadsheets"
].join(" ");

// LocalStorage OAuth
const LS_OAUTH = "bitacora_oauth_token_v1";        // {access_token, expires_at}
const LS_OAUTH_EMAIL = "bitacora_oauth_email_v1";  // email hint

// Local cache/offline keys
const LS_CACHE = "bitacora_cache_v1";              // { items, ts }
const LS_PENDING = "bitacora_pending_v1";          // { queue:[{clientId,texto,createdAt}], ts }

// ================== UI: construir estructura ==================
const header = document.querySelector("header");
const main = document.querySelector("main");

// opcional: clases “tipo app” (no rompe nada si no existen estilos)
header.classList.add("app-header");
main.classList.add("app-main");

// ----- Card header estilo “Notas para siempre” -----
const seccionTitulo = document.createElement("section");
seccionTitulo.className = "titulo";
header.appendChild(seccionTitulo);

// Row 1: título
const headerRow1 = document.createElement("div");
headerRow1.className = "header-row-1";
seccionTitulo.appendChild(headerRow1);

const h1 = document.createElement("h1");
h1.innerText = "Bitácora de situaciones";
headerRow1.appendChild(h1);

// Row 2: auth bar (pill estado + pill cuenta + botones)
const headerRow2 = document.createElement("div");
headerRow2.className = "header-row-2";
seccionTitulo.appendChild(headerRow2);

const authBar = document.createElement("div");
authBar.className = "auth-bar";
headerRow2.appendChild(authBar);

const authLeft = document.createElement("div");
authLeft.className = "auth-left";
authBar.appendChild(authLeft);

// Pill de estado
const syncPill = document.createElement("div");
syncPill.className = "sync-pill";
syncPill.innerHTML = `<span class="sync-dot"></span><span class="sync-text">Cargando…</span>`;
authLeft.appendChild(syncPill);

// Pill cuenta (va a la izquierda, como “Notas…”)
const accountPill = document.createElement("div");
accountPill.className = "account-pill";
accountPill.style.display = "none";
authLeft.appendChild(accountPill);

// Acciones (botones a la derecha)
const headerActions = document.createElement("div");
headerActions.className = "header-actions";
authBar.appendChild(headerActions);

// Botón conectar
const btnConnect = document.createElement("button");
btnConnect.className = "btn-connect";
btnConnect.type = "button";
btnConnect.textContent = "Conectar";
btnConnect.dataset.mode = "connect"; // connect | switch
headerActions.appendChild(btnConnect);

// Botón refresh
const btnRefresh = document.createElement("button");
btnRefresh.className = "btn-refresh";
btnRefresh.type = "button";
btnRefresh.textContent = "↻";
btnRefresh.title = "Reintentar conexión";
btnRefresh.style.display = "none";
headerActions.appendChild(btnRefresh);

// Botón expirar token (oculto siempre)
const btnExpire = document.createElement("button");
btnExpire.className = "btn-expire";
btnExpire.type = "button";
btnExpire.textContent = "⏳ Expirar";
btnExpire.title = "Expirar token local y probar reconexión silenciosa";
btnExpire.style.display = "none";
btnExpire.hidden = true; // 👈 oculto siempre
headerActions.appendChild(btnExpire);

const seccionAgregar = document.createElement("section");
seccionAgregar.classList = "agregarSituacion";
main.appendChild(seccionAgregar);

const labelTexto = document.createElement("label");
labelTexto.innerText = "Situación que pasó:";
labelTexto.htmlFor = "texto-situacion";
seccionAgregar.appendChild(labelTexto);

const textarea = document.createElement("textarea");
textarea.id = "texto-situacion";
textarea.placeholder = "Ej: Estaba en tal lugar, pasó esto, yo pensé tal cosa, reaccioné así...";
seccionAgregar.appendChild(textarea);

const buttonGuardar = document.createElement("button");
buttonGuardar.innerText = "Guardar situación";
seccionAgregar.appendChild(buttonGuardar);

const seccionMuro = document.createElement("section");
seccionMuro.classList = "muro-situaciones";
main.appendChild(seccionMuro);

// ================== Estado ==================
let situaciones = [];

// OAuth state
let tokenClient = null;
let oauthAccessToken = "";
let oauthExpiresAt = 0;

// Connection lock
let connectInFlight = null;

// ================== UI helpers ==================
function setSync(state, text) {
  syncPill.classList.remove("ok", "saving", "offline");
  if (state) syncPill.classList.add(state);
  syncPill.querySelector(".sync-text").textContent = text;
}

function setAccountUI(email) {
  const e = (email || "").toString().trim();
  if (!e) {
    accountPill.style.display = "none";
    accountPill.textContent = "";
    btnConnect.textContent = "Conectar";
    btnConnect.dataset.mode = "connect";

    // ocultar expirar si no hay cuenta
    if (typeof btnExpire !== "undefined") btnExpire.style.display = "none";
    return;
  }

  accountPill.style.display = "inline-flex";
  accountPill.textContent = e;
  btnConnect.textContent = "Cambiar cuenta";
  btnConnect.dataset.mode = "switch";

  // mostrar expirar cuando hay cuenta
  if (typeof btnExpire !== "undefined") btnExpire.style.display = "inline-block";
}

// ================== Fecha helpers (igual que tu versión) ==================
function formatearFechaLarga(fecha) {
  if (!fecha) return "";
  const opciones = { weekday: "long", day: "numeric", month: "long" };
  let txt = fecha.toLocaleDateString("es-AR", opciones);
  return txt.charAt(0).toUpperCase() + txt.slice(1);
}

function obtenerFranjaHoraria(fecha) {
  if (!fecha) return "";
  const h = fecha.getHours();
  if (h >= 0 && h < 6) return "Madrugada";
  if (h >= 6 && h < 12) return "Mañana";
  if (h >= 12 && h < 18) return "Tarde";
  return "Noche";
}

function renderMuro(items) {
  seccionMuro.innerHTML = "";

  items.forEach((item) => {
    const card = document.createElement("article");
    card.classList.add("situacion-card");

    const fecha = item.timestamp ? new Date(item.timestamp) : null;

    const titulo = document.createElement("h3");
    titulo.innerText = formatearFechaLarga(fecha) || "Sin fecha";
    card.appendChild(titulo);

    if (fecha) {
      const franja = document.createElement("p");
      franja.classList.add("situacion-franja");
      franja.innerText = "Momento del día: " + obtenerFranjaHoraria(fecha);
      card.appendChild(franja);
    }

    if (item.timestamp) {
      const fechaCarga = new Date(item.timestamp);
      const pMeta = document.createElement("p");
      pMeta.classList.add("situacion-fecha");
      pMeta.innerText =
        "Registrado: " +
        fechaCarga.toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
      card.appendChild(pMeta);
    }

    const pTexto = document.createElement("p");
    pTexto.classList.add("situacion-texto");
    pTexto.innerText = item.texto || "";
    card.appendChild(pTexto);

    seccionMuro.appendChild(card);
  });
}

// ================== Local cache + pending queue ==================
function loadCache() {
  try {
    const raw = localStorage.getItem(LS_CACHE);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed?.items) ? parsed : null;
  } catch {
    return null;
  }
}
function saveCache(items) {
  try { localStorage.setItem(LS_CACHE, JSON.stringify({ items, ts: Date.now() })); } catch {}
}

function loadPending() {
  try {
    const raw = localStorage.getItem(LS_PENDING);
    const parsed = raw ? JSON.parse(raw) : null;
    const queue = Array.isArray(parsed?.queue) ? parsed.queue : null;
    return queue ? parsed : null;
  } catch {
    return null;
  }
}
function setPendingQueue(queue) {
  try { localStorage.setItem(LS_PENDING, JSON.stringify({ queue, ts: Date.now() })); } catch {}
}
function clearPending() {
  try { localStorage.removeItem(LS_PENDING); } catch {}
}

function isOnline() {
  return navigator.onLine !== false;
}

// ================== OAuth helpers (copiado del patrón Lista Compras) ==================
function isTokenValid() {
  return !!oauthAccessToken && Date.now() < (oauthExpiresAt - 10_000);
}

function loadStoredOAuth() {
  try {
    const raw = localStorage.getItem(LS_OAUTH);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed?.access_token || !parsed?.expires_at) return null;
    return { access_token: parsed.access_token, expires_at: Number(parsed.expires_at) };
  } catch {
    return null;
  }
}
function saveStoredOAuth(access_token, expires_at) {
  try { localStorage.setItem(LS_OAUTH, JSON.stringify({ access_token, expires_at })); } catch {}
}

function clearStoredOAuth() {
  try { localStorage.removeItem(LS_OAUTH); } catch {}
}

// Expira token local (runtime + storage) sin revocar permisos en Google.
// Sirve para testear que el "silent refresh" vuelva a obtener token sin popup.
function expireOAuthTokenLocal() {
  const hadToken = !!oauthAccessToken;

  // limpiar runtime
  oauthAccessToken = "";
  oauthExpiresAt = 0;

  // limpiar storage
  clearStoredOAuth();

  // UI
  setSync("offline", "Token expirado — probando reconexión…");
  btnRefresh.style.display = "inline-block";

  // si había token, intentamos reconectar SIN popup
  // (si hay sesión y consentimiento previo, debería volver sin pedir permisos)
  if (hadToken || loadStoredOAuthEmail()) {
    reconnectAndRefresh().catch(() => {});
  } else {
    // si no hay hint/cuenta, queda en “Necesita Conectar”
    setSync("offline", "Necesita Conectar");
  }
}

function loadStoredOAuthEmail() {
  try { return String(localStorage.getItem(LS_OAUTH_EMAIL) || "").trim().toLowerCase(); } catch { return ""; }
}
function saveStoredOAuthEmail(email) {
  try { localStorage.setItem(LS_OAUTH_EMAIL, (email || "").toString()); } catch {}
}
function clearStoredOAuthEmail() {
  try { localStorage.removeItem(LS_OAUTH_EMAIL); } catch {}
}

function initOAuth() {
  if (!window.google?.accounts?.oauth2?.initTokenClient) {
    throw new Error("GIS no está cargado (falta gsi/client en HTML)");
  }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: OAUTH_CLIENT_ID,
    scope: OAUTH_SCOPES,
    include_granted_scopes: true,
    // Si te trae problemas con "Cambiar cuenta", probá comentar esta línea o ponerla en false
    use_fedcm_for_prompt: true,
    callback: () => {}
  });
}

function requestAccessToken({ prompt, hint } = {}) {
  return new Promise((resolve, reject) => {
    if (!tokenClient) return reject(new Error("OAuth no inicializado"));

    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error("popup_timeout_or_closed"));
    }, 45_000);

    tokenClient.callback = (resp) => {
      if (done) return;
      done = true;
      clearTimeout(timer);

      if (!resp || resp.error) {
        const err = String(resp?.error || "oauth_error");
        const sub = String(resp?.error_subtype || "");
        const msg = (err + (sub ? `:${sub}` : "")).toLowerCase();
        const e = new Error(err);
        e.isCanceled =
          msg.includes("popup_closed") ||
          msg.includes("popup_closed_by_user") ||
          msg.includes("access_denied") ||
          msg.includes("user_cancel") ||
          msg.includes("interaction_required");
        return reject(e);
      }

      const accessToken = resp.access_token;
      const expiresIn = Number(resp.expires_in || 3600);
      const expiresAt = Date.now() + (expiresIn * 1000);

      oauthAccessToken = accessToken;
      oauthExpiresAt = expiresAt;
      saveStoredOAuth(accessToken, expiresAt);

      resolve({ access_token: accessToken, expires_at: expiresAt });
    };

    const req = {};
    if (prompt !== undefined) req.prompt = prompt;
    if (hint && String(hint).includes("@")) req.hint = hint;

    try { tokenClient.requestAccessToken(req); }
    catch (e) { clearTimeout(timer); reject(e); }
  });
}

async function ensureOAuthToken(allowInteractive = false, interactivePrompt = "consent") {
  if (isTokenValid()) return oauthAccessToken;

  const stored = loadStoredOAuth();
  if (stored?.access_token && stored?.expires_at && Date.now() < (stored.expires_at - 10_000)) {
    oauthAccessToken = stored.access_token;
    oauthExpiresAt = Number(stored.expires_at);
    return oauthAccessToken;
  }

  const hintEmail = (loadStoredOAuthEmail() || "").trim().toLowerCase();

  if (!allowInteractive && !hintEmail) {
    throw new Error("TOKEN_NEEDS_INTERACTIVE");
  }

  try {
    await requestAccessToken({ prompt: "", hint: hintEmail || undefined });
    if (isTokenValid()) return oauthAccessToken;
  } catch (e) {
    if (!allowInteractive) throw new Error("TOKEN_NEEDS_INTERACTIVE");
  }

  await requestAccessToken({ prompt: interactivePrompt ?? "consent", hint: hintEmail || undefined });

  if (!isTokenValid()) throw new Error("TOKEN_NEEDS_INTERACTIVE");
  return oauthAccessToken;
}

// ================== API client (POST text/plain) ==================
async function apiPost_(payload) {
  // payload: { mode, access_token, ... }
  const mode = (payload?.mode || "").toString().toLowerCase();
  const token = (payload?.access_token || "").toString();

  if (!token) return { ok: false, error: "auth_required" };

  const sheetEsc = encodeURIComponent(SHEET_NAME);

  try {
    // ---------- WHOAMI ----------
    if (mode === "whoami") {
      const r = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!r.ok) return { ok: false, error: "whoami_failed" };
      const data = await r.json();
      return { ok: true, email: (data?.email || "").toString().toLowerCase().trim() };
    }

    // ---------- LIST ----------
    if (mode === "list") {
      // Lee A2:C => clientId, texto, timestamp
      const url =
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}` +
        `/values/${sheetEsc}!A2:C?majorDimension=ROWS`;

      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const txt = await r.text();
      if (!r.ok) return { ok: false, error: "list_failed", detail: txt.slice(0, 800) };

      const json = JSON.parse(txt);
      const values = Array.isArray(json?.values) ? json.values : [];

      const items = values
        .filter(row => (row?.[1] || "").toString().trim() !== "") // texto en col B
        .map(row => ({
          texto: (row?.[0] || "").toString(),
          timestamp: (row?.[1] || "").toString(),
          clientId: (row?.[2] || "").toString()
        }));

      return { ok: true, items };
    }

    // ---------- ADD_BATCH ----------
    if (mode === "add_batch") {
      const entries = Array.isArray(payload?.entries) ? payload.entries : [];
      if (!entries.length) return { ok: true, added: 0 };

      // Armamos filas: [clientId, texto, timestamp]
      const rows = entries
        .map(e => ({
          clientId: (e?.clientId || "").toString().trim(),
          texto: (e?.texto || "").toString().trim(),
          createdAt: e?.createdAt ? Number(e.createdAt) : Date.now()
        }))
        .filter(e => e.clientId && e.texto)
        .map(e => ([
          e.clientId,
          e.texto,
          new Date(e.createdAt).toISOString()
        ]));

      if (!rows.length) return { ok: true, added: 0 };

      // Append masivo
      const url =
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}` +
        `/values/${sheetEsc}!A:C:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

      const body = { values: rows };

      const r = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });

      const txt = await r.text();
      if (!r.ok) return { ok: false, error: "add_batch_failed", detail: txt.slice(0, 800) };

      return { ok: true, added: rows.length };
    }

    // ---------- PING ----------
    if (mode === "ping") return { ok: true, pong: true };

    return { ok: false, error: "bad_mode" };
  } catch (e) {
    return { ok: false, error: "network_error", detail: String(e?.message || e) };
  }
}

async function apiCall(mode, payload = {}, opts = {}) {
  const allowInteractive = !!opts.allowInteractive;

  let token = await ensureOAuthToken(allowInteractive, opts.interactivePrompt || "consent");
  const body = { mode, access_token: token, ...(payload || {}) };

  let data = await apiPost_(body);

  // Si falla por auth/scope, forzamos interactivo 1 vez
  if (!data?.ok && (data?.error === "missing_scope" || data?.error === "auth_required")) {
    token = await ensureOAuthToken(true, "consent");
    body.access_token = token;
    data = await apiPost_(body);
  }

  // Si todavía falla, agregamos contexto para que se vea el motivo real
  if (!data?.ok) {
    const detail = data?.detail ? ` | ${String(data.detail).slice(0, 180)}` : "";
    console.error("[apiCall FAIL]", mode, data);
    return { ...(data || {}), ok: false, _debug: `${mode}:${data?.error || "unknown"}${detail}` };
  }

  return data;
}

async function verifyBackendAccessOrThrow(allowInteractive) {
  const data = await apiCall("whoami", {}, { allowInteractive });
  if (!data?.ok) {
    const msg = (data?.error || "no_access") + (data?.detail ? ` | ${data.detail}` : "");
    throw new Error(msg);
  }
  return data;
}

// ================== Data ops ==================
function sortSituacionesDesc(items) {
  const arr = Array.isArray(items) ? items.slice() : [];
  arr.sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return tb - ta;
  });
  return arr;
}

async function fetchSituacionesRemote() {
  const resp = await apiCall("list", {}, { allowInteractive: false });
  if (!resp?.ok) throw new Error(resp?.error || "list_failed");

  // Normalizamos + orden desc por timestamp
  const items = Array.isArray(resp?.items) ? resp.items : [];
  return sortSituacionesDesc(items);
}

// ================== Pending queue: add + flush ==================
function makeClientId() {
  // idempotencia: si reintenta, el backend dedupea por clientId
  return "c_" + Date.now() + "_" + Math.floor(Math.random() * 1e9);
}

function enqueuePending(texto) {
  const q = loadPending()?.queue || [];
  q.push({ clientId: makeClientId(), texto: (texto || "").trim(), createdAt: Date.now() });
  setPendingQueue(q);
  return q[q.length - 1];
}

// backoff retry
let retryTimer = null;
let retryDelayMs = 2000;
const RETRY_MAX_MS = 60000;

function resetRetry() {
  retryDelayMs = 2000;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
}

async function scheduleRetry(label = "") {
  if (retryTimer) return;
  if (!isOnline()) return;

  const p = loadPending();
  if (!p?.queue?.length) return;

  if (!isTokenValid()) {
    try { await ensureOAuthToken(false); }
    catch (e) {
      if (String(e?.message || e) === "TOKEN_NEEDS_INTERACTIVE") {
        setSync("offline", "Necesita Conectar");
        btnRefresh.style.display = "inline-block";
      }
      return;
    }
  }
  if (!isTokenValid()) return;

  retryTimer = setTimeout(async () => {
    retryTimer = null;
    try {
      await flushPending();
      if (loadPending()?.queue?.length) {
        retryDelayMs = Math.min(Math.floor(retryDelayMs * 1.7), RETRY_MAX_MS);
        scheduleRetry("retry_loop");
      } else {
        resetRetry();
      }
    } catch {
      retryDelayMs = Math.min(Math.floor(retryDelayMs * 1.7), RETRY_MAX_MS);
      scheduleRetry("retry_loop_err");
    }
  }, retryDelayMs);
}

async function flushPending() {
  if (!isOnline()) {
    setSync("offline", "Sin conexión — Guardado local");
    return;
  }

  // token silent
  try { await ensureOAuthToken(false); } catch {}
  if (!isTokenValid()) {
    setSync("offline", "Necesita Conectar");
    btnRefresh.style.display = "inline-block";
    return;
  }

  const pending = loadPending();
  const queue = pending?.queue || [];
  if (!queue.length) return;

  setSync("saving", "Sincronizando…");

  // 1) Traer remote para dedupe por clientId (evita duplicados si reintentó)
  const remote = await fetchSituacionesRemote();
  const existingIds = new Set(
    remote.map(x => (x?.clientId || "").toString()).filter(Boolean)
  );

  const toSend = queue.filter(e => !existingIds.has((e?.clientId || "").toString()));
  if (!toSend.length) {
    // todo ya estaba en la sheet => limpiamos cola
    clearPending();
    situaciones = remote;
    saveCache(situaciones);
    renderMuro(situaciones);
    setSync("ok", "Sincronizado ✅");
    btnRefresh.style.display = "none";
    return;
  }

  // 2) Enviar batch (append)
  const resp = await apiCall("add_batch", { entries: toSend }, { allowInteractive: false });
  if (!resp?.ok) throw new Error(resp?.error || "add_batch_failed");

  // 3) limpiar cola si ok
  clearPending();

  // 4) refrescar lista
  const items = await fetchSituacionesRemote();
  situaciones = items;
  saveCache(situaciones);
  renderMuro(situaciones);

  setSync("ok", "Sincronizado ✅");
  btnRefresh.style.display = "none";
}

// ================== UI actions ==================
async function refreshUIFromCache() {
  const cached = loadCache();
  if (cached?.items) {
    situaciones = sortSituacionesDesc(cached.items);
    renderMuro(situaciones);
  }
}

async function refreshUIFromRemoteIfPossible(showToast = false) {
  if (!isOnline()) {
    setSync("offline", "Sin conexión — usando cache");
    return;
  }

  // token silent
  try { await ensureOAuthToken(false); } catch {}
  if (!isTokenValid()) {
    setSync("offline", "Necesita Conectar");
    btnRefresh.style.display = "inline-block";
    return;
  }

  try {
    const items = await fetchSituacionesRemote();
    situaciones = items;
    saveCache(situaciones);
    renderMuro(situaciones);
    setSync("ok", "Listo ✅");
    btnRefresh.style.display = "none";
  } catch {
    setSync("offline", "No se pudo cargar — usando cache");
    btnRefresh.style.display = "inline-block";
  }
}

// guardar
async function onGuardarClicked() {
  const texto = (textarea.value || "").trim();
  if (!texto) return;

  // 1) encolar local inmediatamente
  enqueuePending(texto);

  // 2) UX: limpiar input
  textarea.value = "";
  textarea.focus();

  // 3) render optimista: agregamos al muro arriba (sin timestamp real aún)
  const optimistic = { texto, timestamp: Date.now() };
  situaciones = sortSituacionesDesc([optimistic, ...(situaciones || [])]);
  renderMuro(situaciones);
  saveCache(situaciones);

  // 4) intentar flush ya
  try {
    await flushPending();
    setSync("ok", "Guardado ✅");
  } catch {
    setSync("offline", "Quedó pendiente — se reintenta");
    btnRefresh.style.display = "inline-block";
    scheduleRetry("save_failed");
  }
}

// ================== Connect flow (igual patrón Lista Compras) ==================
function isConnectBusy() { return !!connectInFlight; }

async function runConnectFlow({ interactive, prompt } = { interactive: false, prompt: "consent" }) {
  if (connectInFlight) return connectInFlight;

  connectInFlight = (async () => {
    try {
      setSync("saving", interactive ? "Conectando…" : "Reconectando…");

      try {
        await ensureOAuthToken(!!interactive, prompt || "consent");
      } catch (e) {
        if (e?.isCanceled) {
          if (isTokenValid()) setSync("ok", "Listo ✅");
          else {
            setSync("offline", "Necesita Conectar");
            btnRefresh.style.display = "inline-block";
          }
          return { ok: false, canceled: true };
        }
        throw e;
      }

      const who = await verifyBackendAccessOrThrow(!!interactive);

      const email = (who?.email || "").toString();
      if (email) saveStoredOAuthEmail(email);
      setAccountUI(email);

      btnRefresh.style.display = "none";

      await flushPending();
      await refreshUIFromRemoteIfPossible(false);

      scheduleRetry("runConnectFlow");

      return { ok: true };
    } catch (e) {
      const msg = String(e?.message || e || "");
      console.error("[CONNECT FAIL]", e);

      // 👉 MOSTRAR EL ERROR REAL (si viene de apiCall)
      // verifyBackendAccessOrThrow tira Error(msg), así que lo vemos acá.
      setSync("offline", `Error: ${msg.slice(0, 60)}`);
      btnRefresh.style.display = "inline-block";

      // Si lo que pasó es que necesita popup:
      if (msg === "TOKEN_NEEDS_INTERACTIVE") {
        setSync("offline", "Necesita Conectar");
        btnRefresh.style.display = "inline-block";
        return { ok: false, needsInteractive: true };
      }

      return { ok: false, error: msg };
    } finally {
      connectInFlight = null;
    }
  })();

  return connectInFlight;
}

async function reconnectAndRefresh() {
  return await runConnectFlow({ interactive: false, prompt: "" });
}

// ================== Eventos ==================
buttonGuardar.addEventListener("click", onGuardarClicked);

textarea.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.ctrlKey) {
    event.preventDefault();
    buttonGuardar.click();
  }
});

window.addEventListener("online", () => {
  setSync("saving", "Volvió la conexión…");
  flushPending().finally(() => scheduleRetry("online_event"));
});

window.addEventListener("offline", () => {
  setSync("offline", "Sin conexión — Guardado local");
});

btnConnect.addEventListener("click", async () => {
  if (isConnectBusy()) return;

  if (btnConnect.dataset.mode === "switch") {
    const prevStored = loadStoredOAuth();
    const prevEmail = loadStoredOAuthEmail();
    const prevRuntimeToken = oauthAccessToken;
    const prevRuntimeExp = oauthExpiresAt;

    clearStoredOAuth();
    clearStoredOAuthEmail();
    oauthAccessToken = "";
    oauthExpiresAt = 0;

    const res = await runConnectFlow({ interactive: true, prompt: "select_account" });

    if (res?.canceled) {
      if (prevStored?.access_token && prevStored?.expires_at) saveStoredOAuth(prevStored.access_token, prevStored.expires_at);
      if (prevEmail) saveStoredOAuthEmail(prevEmail);
      oauthAccessToken = prevRuntimeToken || "";
      oauthExpiresAt = prevRuntimeExp || 0;
      setAccountUI(prevEmail || "");
      if (isTokenValid()) setSync("ok", "Listo ✅");
      else {
        setSync("offline", "Necesita Conectar");
        btnRefresh.style.display = "inline-block";
      }
      return;
    }

    return;
  }

  await runConnectFlow({ interactive: true, prompt: "consent" });
});

btnRefresh.addEventListener("click", async () => {
  await reconnectAndRefresh();
});

// Expirar token local (sin revocar permisos)
btnExpire.addEventListener("click", async () => {
  expireOAuthTokenLocal();
});

// auto-refresh token (evita popups)
setInterval(async () => {
  try {
    if (document.visibilityState !== "visible") return;
    if (isConnectBusy()) return;
    if (!oauthAccessToken) return;

    if (Date.now() < (oauthExpiresAt - 120_000)) return;

    await ensureOAuthToken(false);

    // Evitamos loop infinito de reconexión automática.
    // Si necesita conectar, que lo haga el usuario con el botón.
  } catch {}
}, 20_000);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (isConnectBusy()) return;

  // Evitamos reconexión automática al volver a la pestaña (provoca loop).
  // Si hace falta, usar el botón Conectar/↻.
});

// ================== INIT ==================
window.addEventListener("load", async () => {
  textarea.focus();

  // 0) init OAuth + restore storage
  try {
    initOAuth();

    const stored = loadStoredOAuth();
    if (stored?.access_token && Date.now() < (stored.expires_at - 10_000)) {
      oauthAccessToken = stored.access_token;
      oauthExpiresAt = stored.expires_at;
      setAccountUI(loadStoredOAuthEmail());

      // mostrar botón expirar si hay cuenta
      if (typeof btnExpire !== "undefined") btnExpire.style.display = "inline-block";
    } else {
      setAccountUI(loadStoredOAuthEmail());

      // si hay email guardado, mostrar expirar igual (sirve para testear)
      if (loadStoredOAuthEmail() && typeof btnExpire !== "undefined") {
        btnExpire.style.display = "inline-block";
      }
    } 
  } catch {}

  // 1) cache instantáneo
  await refreshUIFromCache();
  setSync(isOnline() ? "saving" : "offline", isOnline() ? "Cargando… (cache)" : "Sin conexión — usando cache");

  // 2) si hay pending, intentá sincronizar (sin popup)
  if (isOnline()) {
    const p = loadPending();
    if (p?.queue?.length) {
      try { await flushPending(); }
      catch { scheduleRetry("init_pending"); }
    }
  }

  // 3) auto-sync al cargar (SIN popup)
  if (isOnline()) {
    const emailHint = loadStoredOAuthEmail();
    const stored = loadStoredOAuth();

    if (emailHint || (stored?.access_token && stored?.expires_at)) {
      await reconnectAndRefresh();
    } else {
      setSync("offline", "Necesita Conectar");
      btnRefresh.style.display = "inline-block";
    }
  } else {
    setSync("offline", "Sin conexión");
    btnRefresh.style.display = "none";
  }
});
