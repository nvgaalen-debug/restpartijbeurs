// Restpartijbeurs – Basis: hulpfuncties, toestand, praten met de server, opslaan, meldingen
// Volgorde in index.html: core, market, account, admin, payments, stats, start.
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const euro = new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" });
const num = new Intl.NumberFormat("nl-NL");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clone = (o) => JSON.parse(JSON.stringify(o || {}));
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

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
    try {
      const r = await api("doc/" + collection, { method: "PUT", body: { data: doc, base: S.versions[collection + "/" + S.me] || 0 } });
      map.set(S.me, r.data || doc);
      S.versions[collection + "/" + S.me] = r.version;
      S.writeSeq = (S.writeSeq || 0) + 1;
      render();
      return true;
    } catch (e) {
      if (e.conflict && tryNo < 2) { await pull(true); continue; }
      if (e.conflict) await pull(true);
      if (e.status !== 401 && !e.mustChange) toast(e.status ? e.message : "Opslaan lukte niet. Controleer je verbinding en probeer het opnieuw.");
      return false;
    }
  }
  return false;
}

// ---------- server ----------
async function api(path, { method = "GET", body } = {}) {
  const headers = { "content-type": "application/json" };
  if (S.legacyToken) headers.authorization = "Bearer " + S.legacyToken; // eenmalig, van een oude versie; daarna een HttpOnly-cookie
  let res;
  try {
    res = await fetch("/api/" + path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store", credentials: "same-origin" });
  } catch {
    throw Object.assign(new Error("Geen verbinding met de server."), { status: 0 });
  }
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
async function pull(full) {
  if (!S.token) return;
  try {
    const since = S.lastNow && !full ? new Date(Date.parse(S.lastNow) - 5000).toISOString() : "";
    const seq0 = S.writeSeq || 0;
    const d = await api("data" + (since ? "?since=" + encodeURIComponent(since) : ""));
    // Is er tijdens het ophalen iets opgeslagen, dan is dit antwoord mogelijk ouder: niet gebruiken, direct opnieuw
    if ((S.writeSeq || 0) !== seq0) { setTimeout(() => pull(full), 50); return; }
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
    S.lastNow = d.now; S.ready = true;
    if (S.offline) { S.offline = false; }
    render();
  } catch (e) {
    if (e.status === 401) return;
    if (!S.offline) { S.offline = true; renderStatus(); }
  }
}
function startPolling() {
  stopPolling();
  pull();
  pollTimer = setInterval(() => { if (document.visibilityState === "visible") pull(); }, 8000);
}
function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && S.token) pull(); });
function saveMyLots(mutate) { return queue(() => writeDoc("lots", mutate)); }
function saveMyBids(mutate) { return queue(() => writeDoc("bids", mutate)); }

// ---------- toast ----------
let toastT;
function toast(msg) {
  let el = $(".toast");
  if (!el) { el = document.createElement("div"); el.className = "toast"; el.setAttribute("role", "status"); document.body.appendChild(el); }
  el.textContent = msg;
  clearTimeout(toastT);
  toastT = setTimeout(() => el.remove(), 3600);
}
