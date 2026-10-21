// FoodSource API-tester (ERP-simulator)
// Doet wat een ERP doet: met een API-sleutel partijen aanbieden, bijwerken en intrekken,
// biedingen lezen en berichten ophalen (GET /events), en van een gunning een order maken.
// De sleutel staat alleen in het geheugen van deze pagina (of, als je dat kiest, in sessionStorage).
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const BASE = location.origin + "/api/v1";
const eur = new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" });
const nl = new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 3 });
const when = (iso) => (iso ? new Date(iso).toLocaleString("nl-NL", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");
const store = {
  get(k, d) { try { const v = localStorage.getItem("fs-tester." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("fs-tester." + k, JSON.stringify(v)); } catch {} },
};

const T = { orders: {}, key: "", me: null, log: [], events: [], after: 0, timer: null, busy: false, reasons: [] };

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3500);
}
const pretty = (x) => (x === undefined ? "" : JSON.stringify(x, null, 2));
const statusPill = (s) => `<span class="pill ${s >= 200 && s < 300 ? "ok" : s === 0 ? "off" : s >= 500 ? "acc" : "warn"}">${s || "geen verbinding"}</span>`;

// ---------- verzoeken ----------
async function call(method, path, body) {
  const t0 = performance.now();
  const entry = { at: new Date().toISOString(), method, path, body, status: 0, res: null, ms: 0 };
  try {
    const r = await fetch(BASE + path, {
      method,
      headers: { "x-api-key": T.key, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      // Cookies van de site gaan mee (nodig als Netlify-wachtwoordbeveiliging aan staat).
      // De API zelf kijkt alleen naar de sleutel, nooit naar de sessie van de app.
      credentials: "same-origin",
      signal: AbortSignal.timeout(20000),
    });
    entry.status = r.status;
    const text = await r.text();
    try { entry.res = JSON.parse(text); } catch { entry.res = text; }
    if (r.headers.get("retry-after")) entry.retryAfter = r.headers.get("retry-after");
  } catch (e) { entry.res = { error: { code: "network", message: e.message } }; }
  entry.ms = Math.round(performance.now() - t0);
  T.log.unshift(entry); if (T.log.length > 200) T.log.pop();
  renderLog();
  return entry;
}
// Foutmelding uit elk soort antwoord: API v1 ({error:{message}}), de rest van de app ({error:"…"}) of geen JSON
function errText(r) {
  const e = r.res && r.res.error;
  const msg = (e && typeof e === "object" && e.message) || (typeof e === "string" && e)
    || (typeof r.res === "string" && r.res.trim() ? r.res.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) : "");
  const netlify = r.status === 401 && typeof r.res === "string" && /Request ID/i.test(r.res);
  return `${r.status ? "HTTP " + r.status : "Geen verbinding"}${msg ? ": " + msg : ""}${netlify ? " — dit antwoord komt van Netlify zelf, niet van FoodSource. Staat de wachtwoordbeveiliging (Visitor access) van de site aan?" : ""}`;
}
function needKey() { if (!T.key) { toast("Verbind eerst met een API-sleutel."); $("#at-key").focus(); return true; } return false; }

// ---------- tabbladen ----------
function showTab(name) {
  $$("#at-tabs .tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.at === name)));
  $$("[data-atpane]").forEach((p) => (p.hidden = p.dataset.atpane !== name));
  store.set("tab", name);
  if (name === "lots" && T.key) loadLots();
  if (name === "events" && T.key) { $("#at-n-events").hidden = true; pollEvents(); }
}
$$("#at-tabs .tab").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.at)));

// ---------- verbinding ----------
$("#at-base").textContent = BASE; $("#r-base").textContent = BASE;
async function connect(key) {
  T.key = key.trim();
  $("#at-conn-err").textContent = ""; $("#at-who").hidden = true;
  if (!/^fs_(live|test)_[A-Za-z0-9_-]{32}$/.test(T.key)) { $("#at-conn-err").textContent = "Dit lijkt geen FoodSource-sleutel (fs_test_… of fs_live_…, 40 tekens)."; T.key = ""; return; }
  const r = await call("GET", "/me");
  if (r.status !== 200) { $("#at-conn-err").textContent = errText(r); T.key = ""; T.me = null; return; }
  T.me = r.res;
  try { if ($("#at-remember").checked) sessionStorage.setItem("fs-tester.key", T.key); else sessionStorage.removeItem("fs-tester.key"); } catch {}
  const sc = r.res.key.scopes;
  $("#at-who").innerHTML = `<span class="pill ok">Verbonden</span> <b>${esc(r.res.company.name)}</b> · sleutel “${esc(r.res.key.name)}” (<code>${esc(r.res.key.prefix)}…</code>) · `
    + ["lots:read", "lots:write", "bids:read"].map((s) => `<span class="pill ${sc.includes(s) ? "acc" : "off"}" title="${sc.includes(s) ? "Recht aanwezig" : "Recht ontbreekt"}">${s}</span>`).join(" ")
    + ` · <span class="pill ${r.res.environment === "test" ? "warn" : "off"}">${r.res.environment === "test" ? "testomgeving" : "productie"}</span>`;
  $("#at-who").hidden = false;
  T.after = store.get("after." + r.res.key.prefix, 0);
  T.events = [];
  const rc = await call("GET", "/reason-codes");
  T.reasons = rc.status === 200 ? rc.res.data : [];
  startPolling();
  const tab = $$("#at-tabs .tab").find((b) => b.getAttribute("aria-selected") === "true")?.dataset.at;
  if (tab === "lots") loadLots();
}
$("#at-conn").addEventListener("submit", (e) => { e.preventDefault(); connect($("#at-key").value); });
$("#at-forget").addEventListener("click", () => {
  T.key = ""; T.me = null; $("#at-key").value = ""; $("#at-who").hidden = true; stopPolling();
  try { sessionStorage.removeItem("fs-tester.key"); } catch {}
  toast("Sleutel vergeten.");
});

// ---------- aanbieden ----------
const today = (days = 0) => { const d = new Date(Date.now() + days * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
function newExt() {
  const n = store.get("extN", 0) + 1; store.set("extN", n);
  const d = new Date();
  return `TEST-${today().replace(/-/g, "")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}-${n}`;
}
$("#o-ext").value = newExt();
$("#o-ext-new").addEventListener("click", () => { $("#o-ext").value = newExt(); previewOffer(); });
const EXAMPLES = {
  elstar: { product: "Elstar", variety: "Elstar", category: "fruit", quality: "class-1", origin: "NL", quantity: "240", unit: "case", price: "6,50", min: "20", weight: "6", until: today(14), location: "Barendrecht", packaging: "6 kg doos, 80 per pallet", gtin: "8712345678906", gln: "", note: "Restpartij na geannuleerde order" },
  agria: { product: "Consumptieaardappelen", variety: "Agria", category: "potatoes", quality: "class-1", origin: "NL", quantity: "20", unit: "pallet", price: "310", min: "2", weight: "1000", until: today(30), location: "Emmeloord", packaging: "Big bag 1000 kg", gtin: "", gln: "", note: "" },
  tomaat: { product: "Trostomaten", variety: "", category: "vegetables", quality: "class-2", origin: "NL", quantity: "1200", unit: "kg", price: "0,85", min: "100", weight: "", until: today(4), location: "Westland", packaging: "Kist 5 kg", gtin: "", gln: "", note: "Kleine kleurafwijking" },
  fout: { product: "", variety: "", category: "fruit", quality: "class-1", origin: "Nederland", quantity: "-5", unit: "case", price: "abc", min: "", weight: "", until: "", location: "", packaging: "", gtin: "8712345678907", gln: "", note: "" },
};
const F = ["product", "variety", "category", "quality", "origin", "quantity", "unit", "price", "min", "weight", "until", "location", "packaging", "gtin", "gln", "note"];
$("#at-example").addEventListener("change", (e) => {
  const ex = EXAMPLES[e.target.value]; if (!ex) return;
  for (const k of F) $("#o-" + k).value = ex[k] ?? "";
  $("#o-ext").value = newExt(); e.target.value = ""; previewOffer();
});
// Getal uit een Nederlands of Engels veld; leeg = weglaten; ongeldig = als tekst doorsturen (dan zegt de API wat er mis is)
function numOrRaw(v) {
  const s = String(v).trim(); if (!s) return undefined;
  const n = Number(s.replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : s;
}
function offerBody() {
  const v = (id) => $("#o-" + id).value.trim();
  const b = {
    product: v("product"), variety: v("variety") || undefined, category: v("category"), quality: v("quality"),
    origin: v("origin") || undefined, location: v("location") || undefined, gtin: v("gtin") || undefined, gln: v("gln") || undefined,
    quantity: numOrRaw(v("quantity")), unit: v("unit"), weightPerUnitKg: numOrRaw(v("weight")), minQuantity: numOrRaw(v("min")),
    price: { amount: numOrRaw(v("price")), currency: "EUR" }, availableUntil: v("until") || undefined,
    packaging: v("packaging") || undefined, note: v("note") || undefined,
  };
  return JSON.parse(JSON.stringify(b)); // lege velden weg
}
function previewOffer(method = "PUT") {
  const ext = $("#o-ext").value.trim();
  const path = method === "POST" ? "/lots" : method === "PATCH" ? `/lots/ext:${ext}` : `/lots/by-external-id/${ext}`;
  let body = offerBody();
  if (method === "POST") body = { externalId: ext, ...body };
  if (method === "PATCH") body = { quantity: body.quantity, price: body.price };
  $("#o-req").textContent = `${method} ${BASE.replace(location.origin, "")}${path}\nX-API-Key: ${T.me ? T.me.key.prefix + "…" : "fs_…"}\nContent-Type: application/json\n\n${pretty(body)}`;
  return { path, body };
}
$("#at-offer").addEventListener("input", () => previewOffer());
async function sendOffer(method) {
  if (needKey()) return;
  const { path, body } = previewOffer(method);
  const r = await call(method, path, body);
  $("#o-status").innerHTML = statusPill(r.status) + ` <span class="at-muted">${r.ms} ms</span>`;
  $("#o-res").textContent = pretty(r.res); $("#o-res").classList.remove("at-muted");
  if (r.status === 200 || r.status === 201) toast(r.status === 201 ? "Partij aangemaakt op FoodSource." : "Partij bijgewerkt.");
  else if (r.res?.error?.field) { const map = { quantity: "quantity", "price.amount": "price", price: "price", minQuantity: "min", weightPerUnitKg: "weight", availableUntil: "until", externalId: "ext" }; const f = map[r.res.error.field] || r.res.error.field; $("#o-" + f)?.focus(); }
}
$("#at-offer").addEventListener("submit", (e) => { e.preventDefault(); sendOffer("PUT"); });
$("#o-post").addEventListener("click", () => sendOffer("POST"));
$("#o-patch").addEventListener("click", () => sendOffer("PATCH"));
previewOffer();

function fillOffer(l) {
  const n = (x) => (x === null || x === undefined ? "" : String(x).replace(".", ","));
  $("#o-ext").value = l.externalId || "";
  const vals = { product: l.product, variety: l.variety, category: l.category, quality: l.quality || "class-1", origin: l.origin, quantity: n(l.quantity), unit: l.unit, price: n(l.price?.amount),
    min: n(l.minQuantity), weight: n(l.weightPerUnitKg), until: l.availableUntil, location: l.location, packaging: l.packaging, gtin: l.gtin, gln: l.gln, note: l.note };
  for (const k of F) $("#o-" + k).value = vals[k] ?? "";
  previewOffer();
}

// ---------- mijn partijen ----------
let lotFilter = "";
const STATUS = { open: ["ok", "open"], sold: ["off", "verkocht"], withdrawn: ["warn", "ingetrokken"], expired: ["off", "verlopen"] };
$$("#l-filter button").forEach((b) => b.addEventListener("click", () => {
  lotFilter = b.dataset.s; $$("#l-filter button").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); loadLots();
}));
$("#l-refresh").addEventListener("click", () => loadLots());
async function loadLots() {
  if (!T.key) return;
  const r = await call("GET", "/lots" + (lotFilter ? "?status=" + lotFilter : ""));
  const body = $("#l-body");
  if (r.status !== 200) { body.innerHTML = `<tr><td colspan="8" class="err">${esc(errText(r))}</td></tr>`; return; }
  T.lots = r.res.data;
  body.innerHTML = r.res.data.length ? r.res.data.map((l) => {
    const [cls, word] = STATUS[l.status] || ["off", l.status];
    return `<tr data-id="${esc(l.id)}">
      <td><code>${esc(l.externalId || "–")}</code></td><td>${esc(l.product)}${l.variety ? ` <span class="at-muted">${esc(l.variety)}</span>` : ""}</td>
      <td class="num">${nl.format(l.quantity)} ${esc(l.unit || "")}</td><td class="num">${nl.format(l.remainingQuantity)}</td><td class="num">${eur.format(l.price.amount)}</td>
      <td><span class="pill ${cls}">${word}</span></td><td class="num">${(l.awards || []).length}</td>
      <td class="num"><div class="actions" style="justify-content:flex-end"><button class="btn small" type="button" data-act="edit">Bewerken</button><button class="btn small" type="button" data-act="bids">Biedingen</button>${l.status !== "withdrawn" ? `<button class="btn small" type="button" data-act="withdraw">Intrekken</button>` : ""}</div></td></tr>`;
  }).join("") : `<tr><td colspan="8" class="at-muted">Geen partijen${lotFilter ? " met deze status" : ""}.</td></tr>`;
}
$("#l-body").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const tr = b.closest("tr"), l = (T.lots || []).find((x) => x.id === tr.dataset.id); if (!l) return;
  const old = tr.nextElementSibling?.classList.contains("at-detail") ? tr.nextElementSibling : null;
  if (b.dataset.act === "edit") {
    if (!l.externalId) { toast("Deze partij heeft geen ERP-nummer (gemaakt in de app). Gebruik Vrij verzoek met PATCH /lots/" + l.id); return; }
    fillOffer(l); showTab("offer"); toast("Gegevens geladen. Pas aan en kies Aanbieden / bijwerken."); return;
  }
  if (old) old.remove();
  const row = document.createElement("tr"); row.className = "at-detail";
  row.innerHTML = `<td colspan="8"><div class="at-muted">Laden…</div></td>`; tr.after(row);
  if (b.dataset.act === "bids") {
    const r = await call("GET", `/lots/${encodeURIComponent(l.id)}/bids`);
    const awards = (l.awards || []).map((a) => `<li>Gegund aan <b>${esc(a.buyer.company || a.buyer.id)}</b>: ${nl.format(a.quantity)} × ${eur.format(a.price.amount)} op ${when(a.awardedAt)}</li>`).join("");
    row.firstElementChild.innerHTML = r.status !== 200 ? `<span class="err">${esc(errText(r))}</span>`
      : (r.res.data.length ? `<table class="bids"><thead><tr><th>Koper</th><th class="num">Hoeveelheid</th><th class="num">Prijs</th><th>Opmerking</th><th>Geplaatst</th><th>Status</th></tr></thead><tbody>${r.res.data.map((x) => `<tr><td>${esc(x.buyer.company || x.buyer.id)}<div class="at-muted">${esc(x.buyer.contact || "")}</div></td><td class="num">${nl.format(x.quantity)}</td><td class="num">${eur.format(x.price.amount)}</td><td>${esc(x.note || "")}</td><td>${when(x.placedAt)}</td><td><span class="pill ${x.status === "awarded" ? "ok" : x.status === "rejected" ? "off" : "acc"}">${{ awarded: "gegund", rejected: "afgewezen", open: "open" }[x.status]}</span></td></tr>`).join("")}</tbody></table>`
        : `<span class="at-muted">Nog geen biedingen. Breng in de app als ander bedrijf een bod uit.</span>`)
        + (awards ? `<ul class="at-awards">${awards}</ul>` : "");
  } else if (b.dataset.act === "withdraw") {
    row.firstElementChild.innerHTML = `<div class="actions" style="align-items:center"><span>Reden:</span><select class="at-reason">${T.reasons.map((x) => `<option value="${esc(x.code)}">${esc(x.code)} – ${esc(x.label)}${x.noteRequired ? " (toelichting verplicht)" : ""}</option>`).join("")}</select>
      <input class="at-note" placeholder="Toelichting" maxlength="300" style="flex:1 1 200px"><button class="btn small primary" type="button" data-go>Intrekken</button><button class="btn small" type="button" data-cancel>Annuleren</button><span class="err at-werr"></span></div>`;
    row.querySelector("[data-cancel]").onclick = () => row.remove();
    row.querySelector("[data-go]").onclick = async () => {
      const r = await call("POST", `/lots/${encodeURIComponent(l.id)}/withdraw`, { reasonCode: row.querySelector(".at-reason").value, note: row.querySelector(".at-note").value.trim() || undefined });
      if (r.status === 200) { toast("Partij ingetrokken."); loadLots(); } else row.querySelector(".at-werr").textContent = errText(r);
    };
  }
});

// ---------- berichten en orders ----------
const processed = () => new Set(store.get("done." + (T.me?.key.prefix || ""), []));
function markDone(id) { const s = processed(); s.add(id); store.set("done." + T.me.key.prefix, [...s].slice(-500)); }
async function pollEvents(manual) {
  if (!T.key || T.busy) return;
  T.busy = true;
  try {
    let more = true, got = 0, guard = 0;
    while (more && guard++ < 10) {
      const r = await call("GET", `/events?after=${T.after}&limit=100`);
      if (r.status !== 200) { $("#e-state").textContent = "Ophalen mislukt: " + errText(r); break; }
      for (const ev of r.res.data) { if (!T.events.find((x) => x.id === ev.id)) T.events.unshift(ev); got++; }
      T.after = Number(r.res.next) || T.after; store.set("after." + T.me.key.prefix, T.after);
      more = r.res.hasMore;
    }
    $("#e-state").textContent = `Laatste id: ${T.after} · ${when(new Date().toISOString())}`;
    if (got) {
      renderEvents();
      const sel = $$("#at-tabs .tab").find((b) => b.getAttribute("aria-selected") === "true")?.dataset.at;
      if (sel !== "events") { const n = $("#at-n-events"); n.textContent = String((Number(n.textContent) || 0) * !n.hidden + got); n.hidden = false; }
      toast(`${got} nieuw${got === 1 ? " bericht" : "e berichten"} ontvangen.`);
    } else if (manual) toast("Geen nieuwe berichten.");
  } finally { T.busy = false; }
}
function startPolling() { stopPolling(); if ($("#e-auto").checked) T.timer = setInterval(() => pollEvents(), 15000); pollEvents(); }
function stopPolling() { if (T.timer) clearInterval(T.timer); T.timer = null; }
$("#e-auto").addEventListener("change", () => (T.key ? startPolling() : null));
$("#e-now").addEventListener("click", () => (needKey() ? null : pollEvents(true)));
$("#e-reset").addEventListener("click", () => {
  if (needKey()) return;
  T.after = 0; T.events = []; store.set("after." + T.me.key.prefix, 0); renderEvents(); pollEvents(true);
});

function orderCard(ev) {
  const d = ev.data, a = d.award, seller = d.role === "seller";
  const party = seller ? a.buyer : a.seller;
  const no = (seller ? "VO-" : "IO-") + ev.id;
  const done = processed().has(ev.id);
  const order = T.orders[ev.id] = {
    orderNumber: no, type: seller ? "verkooporder" : "inkooporder", foodsourceEvent: ev.id,
    [seller ? "customer" : "vendor"]: { foodsourceId: party?.id, name: party?.company, contact: party?.contact },
    lines: [{ item: d.lot.externalId || d.lot.id, description: [d.lot.product, d.lot.variety].filter(Boolean).join(" "), gtin: d.lot.gtin || null, quantity: a.quantity, unit: a.unit, unitPrice: a.price.amount, amount: a.total.amount, currency: "EUR" }],
    pickup: { location: d.lot.location || null, gln: d.lot.gln || null, availableUntil: d.lot.availableUntil || null },
    awardedAt: a.awardedAt,
  };
  return `<div class="at-order">
    <div class="at-order-head"><b>${seller ? "Verkooporder" : "Inkooporder"} ${esc(no)}</b> <span class="at-muted">(gesimuleerd)</span>
      ${done ? `<span class="pill ok">verwerkt</span>` : `<button class="btn small primary" type="button" data-done="${esc(ev.id)}">Markeer als geboekt</button>`}
      <button class="btn small" type="button" data-dl="${esc(ev.id)}">Download order (JSON)</button></div>
    <div class="at-order-grid"><div><span class="at-muted">${seller ? "Klant" : "Leverancier"}</span><br><b>${esc(party?.company || "?")}</b><br>${esc(party?.contact || "")}<br><span class="at-muted">FoodSource-id ${esc(party?.id || "")}</span></div>
      <div><span class="at-muted">Afhalen</span><br>${esc(d.lot.location || "–")}${d.lot.gln ? `<br>GLN ${esc(d.lot.gln)}` : ""}<br>uiterlijk ${esc(d.lot.availableUntil || "–")}</div></div>
    <table class="bids"><thead><tr><th>Artikel / lot</th><th>Omschrijving</th><th class="num">Aantal</th><th class="num">Prijs</th><th class="num">Bedrag</th></tr></thead>
      <tbody><tr><td><code>${esc(order.lines[0].item)}</code></td><td>${esc(order.lines[0].description)}</td><td class="num">${nl.format(a.quantity)} ${esc(a.unit || "")}</td><td class="num">${eur.format(a.price.amount)}</td><td class="num"><b>${eur.format(a.total.amount)}</b></td></tr></tbody></table>
    </div>`;
}
function renderEvents() {
  const list = $("#e-list");
  if (!T.events.length) { list.innerHTML = `<p class="at-muted">Nog geen berichten. Ze verschijnen hier zodra iemand biedt of je in de app gunt.</p>`; return; }
  const seen = new Map();
  list.innerHTML = T.events.map((ev) => {
    const d = ev.data || {};
    const dup = seen.has(ev.id); seen.set(ev.id, 1);
    let title = esc(ev.type), sub = "";
    if (ev.type === "bid.received") { title = `Bod ontvangen op ${esc(d.lot?.product || "")}`; sub = `${esc(d.bid?.buyer?.company || "?")} biedt ${nl.format(d.bid?.quantity)} × ${eur.format(d.bid?.price?.amount || 0)}${d.bid?.updated ? " (gewijzigd bod)" : ""} · partij <code>${esc(d.lot?.externalId || d.lot?.id)}</code>`; }
    if (ev.type === "lot.awarded") { title = d.role === "seller" ? `Gegund: ${esc(d.lot?.product || "")} verkocht` : `Gegund: ${esc(d.lot?.product || "")} gekocht`; sub = `${nl.format(d.award?.quantity)} × ${eur.format(d.award?.price?.amount || 0)} = ${eur.format(d.award?.total?.amount || 0)} · ${esc(d.role === "seller" ? "koper " + (d.award?.buyer?.company || "") : "verkoper " + (d.award?.seller?.company || ""))}`; }
    return `<article class="panel at-event${dup ? " at-dup" : ""}">
      <div class="at-ev-head"><span class="pill ${ev.type === "lot.awarded" ? "ok" : "acc"}">${esc(ev.type)}</span> <b>${title}</b> <span class="at-muted">#${esc(ev.id)} · ${when(ev.createdAt)}</span></div>
      <div class="at-ev-sub">${sub}</div>
      ${ev.type === "lot.awarded" && d.award ? orderCard(ev) : ""}
      <details><summary>Bericht (JSON)</summary><pre class="at-json">${esc(pretty(ev))}</pre></details></article>`;
  }).join("");
}
$("#e-list").addEventListener("click", (e) => {
  const done = e.target.closest("[data-done]"), dl = e.target.closest("[data-dl]");
  if (done) { markDone(done.dataset.done); renderEvents(); toast("Gemarkeerd als geboekt. Komt dit bericht nog een keer binnen, dan boekt een ERP het niet opnieuw."); }
  if (dl) {
    const order = T.orders[dl.dataset.dl];
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(order, null, 2)], { type: "application/json" }));
    a.download = order.orderNumber + ".json"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
});

// ---------- webhook controleren ----------
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
$("#v-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const out = $("#v-result");
  const m = /^\s*t=(\d+),v1=([a-f0-9]{64})\s*$/.exec($("#v-sig").value);
  if (!m) { out.innerHTML = `<p class="err">De header heeft niet de vorm <code>t=&lt;unix-tijd&gt;,v1=&lt;64 hex-tekens&gt;</code>.</p>`; return; }
  const secret = $("#v-secret").value, body = $("#v-body").value;
  if (!secret) { out.innerHTML = `<p class="err">Vul het webhookgeheim in.</p>`; return; }
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${m[1]}.${body}`)));
  const age = Math.round(Date.now() / 1000 - Number(m[1]));
  const ok = sig === m[2];
  out.innerHTML = `<div class="at-box"><div class="at-box-head">${ok ? `<span class="pill ok">Handtekening klopt</span>` : `<span class="pill warn">Handtekening klopt niet</span>`}
    ${age > 300 ? `<span class="pill warn">ouder dan 5 minuten (${Math.round(age / 60)} min): een ontvanger moet dit weigeren</span>` : `<span class="pill ok">${age} s oud</span>`}</div>
    <pre class="at-json">Berekend over: "${esc(m[1])}." + body (${new TextEncoder().encode(body).length} bytes)\nVerwacht v1: ${sig}\nOntvangen v1: ${esc(m[2])}${ok ? "" : "\n\nTip: de body moet byte voor byte gelijk zijn aan wat binnenkwam (geen extra spaties of regeleinde aan het eind)."}</pre></div>`;
});

// ---------- vrij verzoek ----------
$("#r-form").addEventListener("submit", async (e) => {
  e.preventDefault(); if (needKey()) return;
  let path = $("#r-path").value.trim(); if (!path.startsWith("/")) path = "/" + path;
  const method = $("#r-method").value, raw = $("#r-body").value;
  const r = await call(method, path, ["GET", "DELETE"].includes(method) || !raw.trim() ? undefined : raw);
  $("#r-status").innerHTML = statusPill(r.status) + ` <span class="at-muted">${r.ms} ms${r.retryAfter ? " · Retry-After " + esc(r.retryAfter) + " s" : ""}</span>`;
  $("#r-res").textContent = pretty(r.res); $("#r-res").classList.remove("at-muted");
});
const curlOf = (method, path, body) => `curl -X ${method} "${BASE}${path}" \\\n  -H "X-API-Key: $FOODSOURCE_KEY"` + (body !== undefined && body !== "" ? ` \\\n  -H "Content-Type: application/json" \\\n  -d '${(typeof body === "string" ? body : JSON.stringify(body)).replace(/'/g, "'\\''")}'` : "");
$("#r-curl").addEventListener("click", () => {
  let path = $("#r-path").value.trim(); if (!path.startsWith("/")) path = "/" + path;
  copy(curlOf($("#r-method").value, path, $("#r-body").value.trim() || undefined), "curl-opdracht gekopieerd (zet je sleutel in $FOODSOURCE_KEY).");
});
async function copy(text, msg) { try { await navigator.clipboard.writeText(text); toast(msg); } catch { toast("Kopiëren lukte niet in deze browser."); } }

// ---------- logboek ----------
function renderLog() {
  $("#at-n-log").textContent = String(T.log.length);
  $("#g-list").innerHTML = T.log.length ? T.log.map((g, i) => `<details class="panel at-logrow"><summary>${statusPill(g.status)} <code>${esc(g.method)} ${esc(g.path)}</code> <span class="at-muted">${g.ms} ms · ${when(g.at)}</span>${g.res?.error?.code ? ` <span class="at-muted">${esc(g.res.error.code)}</span>` : ""}</summary>
      ${g.body !== undefined ? `<div class="at-box-head">Verzoek</div><pre class="at-json">${esc(typeof g.body === "string" ? g.body : pretty(g.body))}</pre>` : ""}
      <div class="at-box-head">Antwoord</div><pre class="at-json">${esc(typeof g.res === "string" ? g.res : pretty(g.res))}</pre>
      <button class="btn small" type="button" data-curl="${i}">Kopieer als curl</button></details>`).join("") : `<p class="at-muted">Nog geen verzoeken.</p>`;
}
$("#g-list").addEventListener("click", (e) => { const b = e.target.closest("[data-curl]"); if (b) { const g = T.log[Number(b.dataset.curl)]; copy(curlOf(g.method, g.path, g.body), "curl-opdracht gekopieerd."); } });
$("#g-clear").addEventListener("click", () => { T.log = []; renderLog(); });

// ---------- start ----------
fetch("/api/status", { credentials: "same-origin" }).then((r) => r.json()).then((d) => { $("#env-test").hidden = d.settings?.environment !== "test"; if (d.settings && !d.settings.apiEnabled) $("#at-conn-err").textContent = "Let op: de API staat uit. De beheerder zet hem aan onder Website-instellingen → Koppelingen."; }).catch(() => {});
showTab(store.get("tab", "offer"));
try { const k = sessionStorage.getItem("fs-tester.key"); if (k) { $("#at-key").value = k; $("#at-remember").checked = true; connect(k); } } catch {}
