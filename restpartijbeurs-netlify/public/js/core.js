// Restpartijbeurs – Basis: hulpfuncties, toestand, praten met de server, opslaan, meldingen
// Volgorde in index.html: core, market, account, admin, payments, stats, start.
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const euro = new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" });
const num = new Intl.NumberFormat("nl-NL");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clone = (o) => JSON.parse(JSON.stringify(o || {}));
// Willekeurige id voor een nieuwe partij (cryptografisch toeval, zodat ids niet botsen)
const newId = () => "l" + Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(16).padStart(2, "0")).join("");
// Datum in de tijdzone van de gebruiker als JJJJ-MM-DD (toISOString geeft UTC en kan een dag verschillen)
const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const S = {
  token: "", user: null, me: null, canWrite: null, ready: false, offline: false, lastNow: "",
  lotsDocs: new Map(), bidsDocs: new Map(), profiles: {}, versions: {}, market: {}, legacyToken: "",
  view: "market", cat: "", q: "", sort: "new", showClosed: false,
  editing: null, bidLot: null,
};

// ---------- local prefs ----------
const pref = {
  get(k) { try { return localStorage.getItem("rpb." + k) || ""; } catch { return ""; } },
  set(k, v) { try { localStorage.setItem("rpb." + k, v); } catch {} },
};

// ---------- derived data ----------
function daysLeft(until) {
  if (!until) return null;
  const end = new Date(until + "T23:59:59");
  const ms = end - new Date();
  return Math.floor(ms / 86400000);
}
function allLots() {
  const out = [];
  for (const [sellerId, d] of S.lotsDocs) {
    const items = (d && d.items) || {};
    for (const [id, it] of Object.entries(items)) {
      const pr = S.profiles[sellerId] || {};
      out.push({ ...it, id, sellerId, company: it.company || d.company || pr.company || "", contact: it.contact || d.contact || pr.contact || "" });
    }
  }
  return out;
}
function lotState(l) {
  const dl = daysLeft(l.until);
  if (l.status === "ingetrokken") return { key: "withdrawn", label: "Ingetrokken", cls: "off", closed: true };
  if (l.status === "verkocht" || (l.remaining ?? l.qty) <= 0) return { key: "sold", label: "Verkocht", cls: "off", closed: true };
  if (dl !== null && dl < 0) return { key: "expired", label: "Verlopen", cls: "off", closed: true };
  if (dl !== null && dl <= 2) return { key: "urgent", label: dl === 0 ? "Vandaag weg" : dl === 1 ? "Nog 1 dag" : "Nog 2 dagen", cls: "warn", closed: false };
  return { key: "open", label: dl === null ? "Open" : `Nog ${dl} dagen`, cls: "ok", closed: false };
}
function bidsFor(lotId) {
  const out = [];
  for (const [bidderId, d] of S.bidsDocs) {
    const o = d && d.offers && d.offers[lotId];
    const pr = S.profiles[bidderId] || {};
    if (o) out.push({ ...o, bidderId, company: d.company || pr.company || "", contact: d.contact || pr.contact || "" });
  }
  return out.sort((a, b) => b.price - a.price);
}
// Hoogste bod en aantal biedingen per partij (de server stuurt dit zonder namen mee)
function bidSummary(lotId) {
  const m = S.market && S.market[lotId];
  if (m) return m;
  const bids = bidsFor(lotId);
  return { top: bids[0] ? bids[0].price : 0, n: bids.length };
}
function myBidDoc() { return S.bidsDocs.get(S.me) || null; }
function myLotsDoc() { return S.lotsDocs.get(S.me) || null; }

// ---------- writes ----------
let chain = Promise.resolve();
function queue(fn) { const p = chain.then(fn); chain = p.catch(() => {}); return p; }
// Schrijft het eigen document. De server controleert alles en geeft de opgeslagen versie terug.
// Heeft iemand (of een ander tabblad) het intussen gewijzigd, dan halen we de nieuwe versie op
// en passen we de wijziging daar opnieuw op toe.
async function writeDoc(collection, mutate) {
  for (let tryNo = 0; tryNo < 3; tryNo++) {
    const map = collection === "lots" ? S.lotsDocs : S.bidsDocs; // na een volledige verversing is dit een nieuwe Map
    const doc = clone(map.get(S.me) || (collection === "lots" ? { items: {} } : { offers: {} }));
    if (collection === "lots") doc.items = doc.items || {}; else doc.offers = doc.offers || {};
    mutate(doc);
    // writeSeq verandert bij begin én einde van het opslaan: een ophaalronde die daar
    // (deels) overheen liep, kan verouderd zijn en wordt dan niet gebruikt
    S.writeSeq = (S.writeSeq || 0) + 1;
    try {
      const r = await api("doc/" + collection, { method: "PUT", body: { data: doc, base: S.versions[collection + "/" + S.me] || 0 } });
      // In de Map van nu zetten: een volledige verversing tijdens het opslaan maakt een nieuwe Map
      (collection === "lots" ? S.lotsDocs : S.bidsDocs).set(S.me, r.data || doc);
      S.versions[collection + "/" + S.me] = r.version;
      S.writeSeq++;
      render();
      return true;
    } catch (e) {
      S.writeSeq++;
      if (e.conflict && tryNo < 2) { await pull(true); continue; }
      if (e.conflict) await pull(true);
      if (e.status !== 401 && !e.mustChange) toast(e.status ? e.message : "Opslaan lukte niet. Controleer je verbinding en probeer het opnieuw.");
      return false;
    }
  }
  return false;
}

// ---------- server ----------
async function api(path, { method = "GET", body, timeout } = {}) {
  const headers = { "content-type": "application/json" };
  if (S.legacyToken) headers.authorization = "Bearer " + S.legacyToken; // eenmalig, van een oude versie; daarna een HttpOnly-cookie
  // Nooit eindeloos wachten: anders blijft de wachtrij met opslaan hangen
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout || (path === "photos" ? 60000 : 20000));
  let res;
  try {
    res = await fetch("/api/" + path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store", credentials: "same-origin", signal: ctrl.signal });
  } catch (e) {
    throw Object.assign(new Error(e && e.name === "AbortError" ? "De server reageert te traag. Controleer je verbinding en probeer het opnieuw." : "Geen verbinding met de server."), { status: 0 });
  } finally { clearTimeout(timer); }
  let data = null;
  try { data = await res.json(); } catch {}
  // Antwoorden van onze eigen functie zijn altijd JSON. Iets anders komt van daarvóór:
  // Netlify-toegangsbeveiliging, een bedrijfsproxy (bijv. Zscaler) of een verlopen netwerk-login.
  const fromApp = !!(data && typeof data === "object");
  if (!res.ok && !fromApp) {
    throw Object.assign(new Error(res.status === 401 || res.status === 403 || res.status === 407
      ? `De verbinding werd geweigerd (${res.status}) voordat de app werd bereikt. Dat komt meestal door een verlopen netwerk- of websitebeveiliging. Herlaad de pagina.`
      : `De server reageert niet goed (${res.status}). Probeer het over een minuut opnieuw.`), { status: res.status, external: true });
  }
  if (res.status === 401 && S.token && !/^(login|setup)$/.test(path)) {
    signOutLocal();
    showLogin("Je sessie is verlopen. Log opnieuw in.");
  }
  if (res.status === 403 && data.mustChange && S.user) openForceCode();
  if (!res.ok) throw Object.assign(new Error(data.error || "Er ging iets mis (" + res.status + ")."), { status: res.status, conflict: !!data.conflict, mustChange: !!data.mustChange });
  return data || {};
}

let pollTimer = null;
// Nooit twee keer tegelijk ophalen: een trager, ouder antwoord mag een nieuwer antwoord niet overschrijven
// Wie tijdens het ophalen opnieuw vraagt, wacht op de ronde erna (die dan volledig is als dat gevraagd werd).
let pullBusy = null, pullAgain = false, pullAgainFull = false;
function pull(full) {
  if (pullBusy) { pullAgain = true; pullAgainFull = pullAgainFull || !!full; return pullBusy; }
  pullBusy = (async () => {
    let f = !!full;
    try {
      do { pullAgain = false; pullAgainFull = false; await pullOnce(f); f = pullAgainFull; } while (pullAgain);
    } finally { pullBusy = null; }
  })();
  return pullBusy;
}
async function pullOnce(full) {
  if (!S.token) return;
  try {
    const since = S.lastNow && !full ? new Date(Date.parse(S.lastNow) - 5000).toISOString() : "";
    const seq0 = S.writeSeq || 0;
    const d = await api("data" + (since ? "?since=" + encodeURIComponent(since) : ""));
    // Is er tijdens het ophalen iets opgeslagen, dan is dit antwoord mogelijk ouder: niet gebruiken, direct opnieuw
    if ((S.writeSeq || 0) !== seq0) { pullAgain = true; pullAgainFull = pullAgainFull || !!full; return; }
    if (d.full) { S.lotsDocs = new Map(); S.bidsDocs = new Map(); }
    for (const doc of d.docs || []) {
      const map = doc.collection === "lots" ? S.lotsDocs : doc.collection === "bids" ? S.bidsDocs : null;
      if (!map) continue;
      const key = doc.collection + "/" + doc.id;
      if (!d.full && (doc.version || 0) < (S.versions[key] || 0)) continue; // we hebben al een nieuwere versie
      S.versions[key] = doc.version || 0;
      if (doc.data === null) map.delete(doc.id); else map.set(doc.id, doc.data);
    }
    if (d.market) S.market = d.market;
    if (d.profiles) S.profiles = d.profiles;
    if (S.view === "admin" && S.apane === "lots") setTimeout(renderAdminLots, 0);
    if (S.view === "admin" && S.apane === "stats" && (d.docs || []).length) setTimeout(renderStats, 0);
    if (typeof d.pendingCount === "number") {
      const changed = d.pendingCount !== S.pendingCount;
      S.pendingCount = d.pendingCount;
      setPendingBadge(d.pendingCount);
      if (changed && S.view === "admin") refreshAdminPane();
    }
    S.lastNow = d.now; S.ready = true; S.lastPullAt = Date.now();
    if (S.offline) { S.offline = false; }
    render();
  } catch (e) {
    if (e.status === 401) return;
    if (!S.offline) { S.offline = true; renderStatus(); }
  }
}
// Elke 30 seconden nieuwe gegevens ophalen, alleen als het tabblad zichtbaar is en er de
// laatste 10 minuten iets gedaan is. Dat scheelt veel aanroepen (en Netlify-credits).
// Bij terugkomen (tabblad, venster of eerste muisbeweging na een pauze) direct ophalen.
const POLL_MS = 30000, IDLE_MS = 10 * 60000;
let lastActivity = Date.now(), pausedForIdle = false;
function startPolling() {
  stopPolling();
  pull();
  pollTimer = setInterval(() => {
    if (document.visibilityState !== "visible") return;
    if (Date.now() - lastActivity > IDLE_MS) { if (!pausedForIdle) { pausedForIdle = true; renderStatus(); } return; }
    pull();
  }, POLL_MS);
}
function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }
function markActive() {
  lastActivity = Date.now();
  if (pausedForIdle) { pausedForIdle = false; renderStatus(); if (S.token) pull(); }
}
["pointerdown", "keydown", "wheel", "touchstart", "mousemove"].forEach((ev) => document.addEventListener(ev, markActive, { passive: true }));
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && S.token) { lastActivity = Date.now(); pausedForIdle = false; pull(); } });
window.addEventListener("focus", () => { if (S.token && Date.now() - (S.lastPullAt || 0) > 5000) { lastActivity = Date.now(); pull(); } });
function saveMyLots(mutate) { return queue(() => writeDoc("lots", mutate)); }
function saveMyBids(mutate) { return queue(() => writeDoc("bids", mutate)); }

// ---------- renderen ----------
// Eén plek om "mag deze gebruiker handelen" te wijzigen; ververst het scherm hooguit één keer
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => { renderQueued = false; render(); });
}
function setCanWrite(v) {
  v = !!v;
  if (S.canWrite === v) return;
  S.canWrite = v;
  scheduleRender();
}

// Bedrag zoals een Nederlander het typt ("120", "120,50", "1.200,00", "€ 120") → hele centen, of null
function parseEuroCents(raw) {
  let t = String(raw ?? "").replace(/[€\s]/g, "");
  if (!t) return null;
  if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");          // NL: punt = duizendtal, komma = decimaal
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, "");       // "1.200" = twaalfhonderd
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

// ---------- toast ----------
let toastT;
function toast(msg) {
  let el = $(".toast");
  if (!el) { el = document.createElement("div"); el.className = "toast"; el.setAttribute("role", "status"); document.body.appendChild(el); }
  el.textContent = msg;
  clearTimeout(toastT);
  toastT = setTimeout(() => el.remove(), 3600);
}
