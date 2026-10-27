// FoodSource – Gevraagd: kopers zetten wat ze zoeken, aanbieders reageren met "Ik kan leveren".
// Passen vraag en aanbod bij elkaar, dan zien beide dat hier (en krijgen ze een pushmelding van de server).
// Dezelfde regels als netlify/lib/match.mjs – bij een wijziging beide aanpassen.
const MATCH_STOP = new Set(["en", "of", "de", "het", "een", "met", "voor", "van", "klasse", "kg", "kilo"]);
function matchStem(w) {
  let s = w.replace(/'?s$/, "").replace(/en$/, "");
  if (s.length < 2) s = w;
  return s.replace(/([aeiou])\1/g, "$1").replace(/([^aeiou])\1/g, "$1").replace(/v$/, "f");
}
const matchWords = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim().split(" ")
  .filter((w) => w.length >= 2 && !MATCH_STOP.has(w)).map(matchStem);
function productMatches(wantProduct, lotProduct, lotRas) {
  const want = matchWords(wantProduct), lot = matchWords(`${lotProduct || ""} ${lotRas || ""}`);
  if (!want.length || !lot.length) return false;
  return want.every((w) => lot.some((l) => l === w || (w.length >= 4 && l.includes(w)) || (w.length >= 3 && l.endsWith(w))));
}
function wantIsOpen(w) { return w && w.status !== "gesloten" && !!w.until && w.until >= localDate(); }
function priceFits(w, l) {
  if (!(w.maxPrice > 0)) return true;
  if (w.unit === l.unit) return l.price <= w.maxPrice + 1e-9;
  if (w.unit === "kg" && l.kgPerUnit > 0) return l.price / l.kgPerUnit <= w.maxPrice + 1e-9;
  return true;
}
function wantMatchesLot(w, l) {
  return wantIsOpen(w) && !lotState(l).closed && w.category === l.category && (!w.klasse || w.klasse === l.klasse) && priceFits(w, l) && productMatches(w.product, l.product, l.ras);
}

// ---------- gegevens ----------
function allWants() {
  const out = [];
  for (const [buyerId, d] of S.wantsDocs) {
    const pr = S.profiles[buyerId] || {};
    for (const [id, w] of Object.entries((d && d.items) || {})) out.push({ ...w, id, buyerId, key: `${buyerId}:${id}`, company: d.company || pr.company || "", contact: d.contact || pr.contact || "" });
  }
  return out;
}
const myWantsDoc = () => S.wantsDocs.get(S.me) || null;
function wantState(w) {
  if (w.status === "gesloten") return { label: w.closedReason === "gevonden" ? "Gevonden" : "Gesloten", cls: "off", closed: true };
  const dl = daysLeft(w.until);
  if (dl === null || dl < 0) return { label: "Verlopen", cls: "off", closed: true };
  const d = new Date(w.until + "T12:00").toLocaleDateString("nl-NL", { weekday: "short", day: "numeric", month: "short" });
  return { label: `Nodig vóór ${d}`, cls: dl <= 2 ? "warn" : "ok", closed: false };
}
// Partijen die bij een vraag passen, plus partijen die als reactie op deze vraag zijn aangeboden
function lotsForWant(w) {
  return allLots().filter((l) => l.sellerId !== w.buyerId && !lotState(l).closed && (l.wantRef === w.key || wantMatchesLot(w, l)));
}

// ---------- tonen ----------
S.wcat = "";
function wantCard(w) {
  const st = wantState(w), mine = w.buyerId === S.me;
  const price = w.maxPrice > 0 ? `max ${euro.format(w.maxPrice)} per ${esc(unitSingular(w.unit))}` : "prijs in overleg";
  const lots = st.closed ? [] : lotsForWant(w);
  const myLots = !mine ? lots.filter((l) => l.sellerId === S.me) : [];
  let extra = "", actions = "";
  if (mine) {
    extra = lots.length
      ? `<div class="want-hits"><div class="want-hits-title">${lots.length === 1 ? "1 partij past" : lots.length + " partijen passen"}</div>${lots.slice(0, 6).map((l) => `<button class="want-hit" type="button" data-act="want-lot" data-seller="${esc(l.sellerId)}" data-lot="${esc(l.id)}">
          <span><b>${esc(l.product)}${l.ras ? " " + esc(l.ras) : ""}</b>${l.wantRef === w.key ? ' <span class="want-tag">Reactie</span>' : ""}<span class="sub">${num.format(l.remaining ?? l.qty)} ${esc(l.unit)} · ${esc(l.company)}${l.location ? " · " + esc(l.location) : ""}</span></span>
          <span class="want-hit-price">${euro.format(l.price)}<span class="sub">per ${esc(unitSingular(l.unit))}</span></span></button>`).join("")}</div>`
      : st.closed ? "" : `<div class="want-none">Nog geen passend aanbod. Je krijgt een melding zodra er iets past.</div>`;
    actions = st.closed
      ? `<button class="btn small" type="button" data-act="want-edit" data-want="${esc(w.id)}">Heropenen</button>`
      : `<button class="btn small" type="button" data-act="want-edit" data-want="${esc(w.id)}">Bewerken</button><button class="btn small" type="button" data-act="want-found" data-want="${esc(w.id)}">Gevonden</button><button class="btn small ghost" type="button" data-act="want-close" data-want="${esc(w.id)}">Intrekken</button>`;
  } else {
    if (myLots.length) extra = `<div class="want-yours">Je partij <b>${esc(myLots[0].product)}</b> past al bij deze vraag; de koper ziet hem.</div>`;
    actions = S.canWrite !== false && S.me ? `<button class="btn primary small" type="button" data-act="want-supply" data-want="${esc(w.key)}">Ik kan leveren</button>` : "";
  }
  return `<article class="want${mine ? " mine" : ""}${st.closed ? " closed" : ""}" id="want-${esc(w.buyerId)}-${esc(w.id)}">
    <div class="label-strip"><span class="cat"><span class="sw ${esc(w.category)}"></span>${esc(w.category)} · ${w.klasse ? esc(w.klasse) : "elke klasse"}</span><span class="pill ${st.cls}">${mine && !st.closed ? "Jouw vraag" : esc(st.label)}</span></div>
    <div class="want-body">
      <h3 class="prod">${esc(w.product)}</h3>
      <div class="want-specs"><b>${num.format(w.qty)} ${esc(w.unit)}</b> · ${price}</div>
      <div class="want-meta">${mine && !st.closed ? esc(st.label) + (w.region ? " · " : "") : ""}${w.region ? esc(w.region) : ""}</div>
      ${w.note ? `<div class="note">${esc(w.note)}</div>` : ""}
      ${extra}
    </div>
    <div class="want-foot"><span class="want-who">${mine ? "" : esc(w.company || "Koper")}</span><div class="actions">${actions}</div></div>
  </article>`;
}
function renderWants() {
  const box = $("#wanted"); if (!box) return;
  const all = allWants();
  $("#n-wanted").textContent = all.filter((w) => w.buyerId !== S.me && wantIsOpen(w)).length;
  if (!S.ready) { box.innerHTML = `<div class="notice">Vragen laden…</div>`; return; }
  let list = S.wcat === "mine" ? all.filter((w) => w.buyerId === S.me) : all.filter((w) => wantIsOpen(w) && (!S.wcat || w.category === S.wcat));
  // Eigen open vragen bovenaan, daarna wat het eerst nodig is
  list.sort((a, b) => (wantIsOpen(b) - wantIsOpen(a)) || ((b.buyerId === S.me) - (a.buyerId === S.me)) || (a.until || "").localeCompare(b.until || ""));
  if (!list.length) {
    box.innerHTML = `<div class="empty" style="grid-template-columns:1fr"><div><h2>${S.wcat === "mine" ? "Je hebt nog niets gevraagd" : "Nog geen vragen"}</h2>
      <p>Zoek je iets dat niet in het aanbod staat? Plaats een vraag. Aanbieders met een passende partij krijgen direct een melding.</p>
      ${S.canWrite !== false && S.me ? `<button class="btn primary" type="button" data-act="want-new">+ Vraag plaatsen</button>` : ""}</div></div>`;
    return;
  }
  box.innerHTML = `<div class="want-grid">${list.map(wantCard).join("")}</div>`;
}
function showWant(key) {
  const [buyer, id] = String(key || "").split(":");
  S.wcat = ""; $$("#want-chips .chip").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.wcat === "")));
  setView("wanted"); renderWants();
  const el = document.getElementById(`want-${buyer}-${id}`);
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 2400);
}

// ---------- vraag plaatsen / bewerken ----------
const dlgWant = $("#dlg-want");
function openWantDialog(id) {
  const w = id ? myWantsDoc()?.items?.[id] : null;
  S.editingWant = id || null;
  const reopen = w && (w.status === "gesloten" || !wantIsOpen(w));
  $("#want-title").textContent = !w ? "Vraag plaatsen" : reopen ? "Vraag heropenen" : "Vraag bewerken";
  $("#want-submit").textContent = !w ? "Plaatsen" : reopen ? "Heropenen" : "Opslaan";
  const v = (sel, val) => ($(sel).value = val ?? "");
  v("#w-product", w?.product); v("#w-cat", w?.category || "Groente"); v("#w-qty", w ? decOut(w.qty) : ""); v("#w-unit", w?.unit || pref.get("wunit") || "pallets");
  v("#w-klasse", w?.klasse || ""); v("#w-price", w?.maxPrice ? eurOut(w.maxPrice) : "");
  v("#w-until", w && !reopen ? w.until : localDate(new Date(Date.now() + 7 * 86400000)));
  v("#w-region", w?.region); v("#w-note", w?.note);
  v("#w-company", myWantsDoc()?.company || S.user?.company || pref.get("company")); v("#w-phone", myWantsDoc()?.contact || S.user?.contact || pref.get("contact"));
  $("#want-err").textContent = "";
  dlgWant.showModal();
  if (isTouch()) dlgWant.scrollTop = 0; else $("#w-product").focus();
}
$("#form-want").addEventListener("submit", async (e) => {
  e.preventDefault();
  const val = (sel) => $(sel).value.trim();
  const unit = val("#w-unit");
  const qty = unit === "kg" ? decIn(val("#w-qty")) : intIn(val("#w-qty"));
  const rawPrice = val("#w-price"), maxPrice = rawPrice ? decIn(rawPrice) : null;
  const err = !val("#w-product") ? "Vul in wat je zoekt." : !(qty > 0) ? "Vul een hoeveelheid in (een heel getal, behalve bij kg)." : rawPrice && !(maxPrice > 0) ? "Vul een geldige maximale prijs in, of laat het veld leeg." : !val("#w-until") ? "Kies vóór wanneer je het nodig hebt." : val("#w-until") < localDate() ? "Die datum ligt in het verleden." : !val("#w-company") ? "Vul je bedrijfsnaam in." : "";
  if (err) { $("#want-err").textContent = err; return; }
  const id = S.editingWant || newId().replace(/^l/, "w");
  const company = val("#w-company"), contact = val("#w-phone");
  pref.set("wunit", unit); pref.set("company", company); pref.set("contact", contact);
  const isNew = !S.editingWant;
  const ok = await saveMyWants((doc) => {
    doc.company = company; doc.contact = contact;
    const prev = doc.items[id] || {};
    doc.items[id] = { ...prev, product: val("#w-product"), category: val("#w-cat"), qty, unit, klasse: val("#w-klasse"), maxPrice, until: val("#w-until"), region: val("#w-region"), note: val("#w-note"), status: "open" };
    delete doc.items[id].closedReason; delete doc.items[id].closedAt;
  });
  if (!ok) return;
  dlgWant.close();
  const w = { ...myWantsDoc().items[id], id, buyerId: S.me, key: `${S.me}:${id}` };
  const n = lotsForWant(w).length;
  toast(isNew ? (n ? `Vraag geplaatst. ${n === 1 ? "Er past al 1 partij" : `Er passen al ${n} partijen`}; je ziet ze bij je vraag.` : "Vraag geplaatst. Aanbieders met een passende partij krijgen een melding.") : "Vraag opgeslagen.");
  if (S.view !== "wanted") setView("wanted");
});

// ---------- acties ----------
document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-act]");
  if (!t || !/^want-/.test(t.dataset.act)) return;
  const act = t.dataset.act;
  if (act === "want-new") return openWantDialog();
  if (act === "want-edit") return openWantDialog(t.dataset.want);
  if (act === "want-lot") return openLotDetail(t.dataset.seller, t.dataset.lot);
  if (act === "want-found" || act === "want-close") {
    const id = t.dataset.want;
    const ok = await saveMyWants((doc) => { const w = doc.items[id]; if (w) { w.status = "gesloten"; w.closedReason = act === "want-found" ? "gevonden" : "niet meer nodig"; } });
    if (ok) toast(act === "want-found" ? "Mooi! De vraag is gesloten." : "Vraag ingetrokken. Aanbieders zien hem niet meer.");
    return;
  }
  if (act === "want-supply") {
    const w = allWants().find((x) => x.key === t.dataset.want);
    if (!w) return;
    openLotDialog(null, {
      wantRef: w.key,
      title: "Aanbieden op vraag",
      banner: `Op de vraag van ${w.company || "een koper"}: ${num.format(w.qty)} ${w.unit} ${w.product}${w.maxPrice > 0 ? `, max ${euro.format(w.maxPrice)} per ${unitSingular(w.unit)}` : ""}${w.region ? ` (${w.region})` : ""}. Pas aan wat bij jou anders is; de koper krijgt bericht zodra je publiceert.`,
      fields: { "#f-product": w.product, "#f-cat": w.category, "#f-klasse": w.klasse || undefined, "#f-qty": w.unit === "kg" ? decOut(w.qty) : String(w.qty), "#f-unit": w.unit, "#f-price": w.maxPrice > 0 ? eurOut(w.maxPrice) : "" },
    });
  }
});
$("#want-chips").addEventListener("click", (e) => {
  const c = e.target.closest("[data-wcat]"); if (!c) return;
  S.wcat = c.dataset.wcat;
  $$("#want-chips .chip").forEach((x) => x.setAttribute("aria-pressed", String(x === c)));
  renderWants();
});
