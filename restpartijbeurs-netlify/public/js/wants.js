// FoodSource – Gevraagd: kopers zetten wat ze zoeken, aanbieders reageren met "Ik kan leveren".
// Passen vraag en aanbod bij elkaar, dan zien beide dat hier (en krijgen ze een pushmelding van de server).
// De matchscore (0–100% met uitleg) komt uit match-core.js: een kopie van netlify/lib/match.mjs, dus precies wat de server rekent.
const matchStem = MatchCore.stem, matchWords = MatchCore.words, productMatches = MatchCore.productMatch;
function wantIsOpen(w) { return MatchCore.wantOpen(w, localDate()); }
const scoreOf = (w, l) => MatchCore.matchScore(w, l, localDate());
function wantMatchesLot(w, l) { return wantIsOpen(w) && !lotState(l).closed && scoreOf(w, l).score >= MatchCore.GOOD; }
// Badge + uitleg (✓ / ⚠️ / ·)
function matchBadge(sc) { return `<span class="mscore ${sc.level}" title="${sc.level === "good" ? "Goede match" : "Bijna-match"}">${sc.score}%</span>`; }
function matchLines(sc) {
  return `<ul class="mlines">${sc.lines.map((x) => `<li class="${x.s}"><span aria-hidden="true">${x.s === "ok" ? "✓" : x.s === "warn" ? "!" : "·"}</span>${esc(x.t)}</li>`).join("")}</ul>`;
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
  if (w.status === "gesloten") return { label: w.closedBy === "beheer" ? "Gesloten door beheer" : w.closedReason === "gevonden" ? "Gevonden" : "Gesloten", cls: "off", closed: true };
  const dl = daysLeft(w.until);
  if (dl === null || dl < 0) return { label: "Verlopen", cls: "off", closed: true };
  const d = new Date(w.until + "T12:00").toLocaleDateString("nl-NL", { weekday: "short", day: "numeric", month: "short" });
  return { label: `Nodig vóór ${d}`, cls: dl <= 2 ? "warn" : "ok", closed: false };
}
// Partijen die (bijna) bij een vraag passen, plus partijen die als reactie op deze vraag zijn aangeboden.
// Beste match eerst; elke partij krijgt .match = { score, level, lines, km, bidAt }
function lotsForWant(w) {
  return allLots().filter((l) => l.sellerId !== w.buyerId && !lotState(l).closed)
    .map((l) => ({ ...l, match: scoreOf(w, l) }))
    .filter((l) => isReaction(l, w) || l.match.score >= MatchCore.NEAR)
    .sort((a, b) => (b.match.score - a.match.score) || (a.price - b.price));
}
// Beste match tussen een partij en mijn eigen open vragen (voor het label in het aanbod)
function myBestMatch(l) {
  if (!S.me || l.sellerId === S.me) return null;
  let best = null;
  for (const [id, w] of Object.entries(myWantsDoc()?.items || {})) {
    if (!wantIsOpen(w)) continue;
    const sc = scoreOf(w, l);
    if (sc.score >= MatchCore.NEAR && (!best || sc.score > best.sc.score)) best = { sc, w: { ...w, id } };
  }
  return best;
}

// Door de aanbieder op deze vraag aangeboden (nieuwe partij via 'Ik kan leveren', of een bestaande partij)
const isReaction = (l, w) => l.wantRef === w.key || !!l.offeredTo?.[w.key];
// ---------- tonen ----------
S.wcat = "";
// Eén gevonden partij bij je vraag: percentage, gegevens, waarom (✓ / !), en bij een net te dure partij "Bied € …"
function wantHit(w, l) {
  const m = l.match;
  return `<div class="want-hit ${m.level}">
    <button class="want-hit-main" type="button" data-act="want-lot" data-seller="${esc(l.sellerId)}" data-lot="${esc(l.id)}">
      ${m.out ? `<span class="mscore out">${esc(m.out)}</span>` : matchBadge(m)}
      <span class="want-hit-txt"><b>${esc(l.product)}${l.ras ? " " + esc(l.ras) : ""}</b>${isReaction(l, w) ? ' <span class="want-tag">Reactie</span>' : ""}<span class="sub">${num.format(l.remaining ?? l.qty)} ${esc(l.unit)} · ${esc(l.company)}${l.location ? " · " + esc(l.location) : ""}</span></span>
      <span class="want-hit-price">${euro.format(l.price)}<span class="sub">per ${esc(unitSingular(l.unit))}</span></span>
    </button>
    ${matchLines(m)}
    ${m.bidAt && S.canWrite !== false ? `<div class="want-hit-act"><button class="btn small" type="button" data-act="want-bid" data-lot="${esc(l.id)}" data-price="${m.bidAt}">Bied ${euro.format(m.bidAt)}</button></div>` : ""}
  </div>`;
}
function wantCard(w) {
  const st = wantState(w), mine = w.buyerId === S.me;
  const price = w.maxPrice > 0 ? `max ${euro.format(w.maxPrice)} per ${esc(unitSingular(w.unit))}` : "prijs in overleg";
  const lots = st.closed ? [] : lotsForWant(w);
  const myLots = !mine ? lots.filter((l) => l.sellerId === S.me) : [];
  let extra = "", actions = "";
  if (mine) {
    const good = lots.filter((l) => l.match.level === "good").length;
    extra = lots.length
      ? `<div class="want-hits"><div class="want-hits-title">${lots.length === 1 ? "1 partij gevonden" : lots.length + " partijen gevonden"} · beste match ${lots[0].match.score}%${good < lots.length ? `<span class="sub">${good ? good + " goed, " : ""}${lots.length - good} bijna</span>` : ""}</div>${lots.slice(0, 6).map((l) => wantHit(w, l)).join("")}${lots.length > 6 ? `<div class="sub">En nog ${lots.length - 6} in het aanbod.</div>` : ""}</div>`
      : st.closed ? "" : `<div class="want-none">Nog geen passend aanbod. Je krijgt een melding zodra er een goede match is (90% of meer).</div>`;
    actions = w.closedBy === "beheer" ? ""
      : st.closed
      ? `<button class="btn small" type="button" data-act="want-edit" data-want="${esc(w.id)}">Heropenen</button>`
      : `<button class="btn small" type="button" data-act="want-edit" data-want="${esc(w.id)}">Bewerken</button><button class="btn small" type="button" data-act="want-found" data-want="${esc(w.id)}">Gevonden</button><button class="btn small ghost" type="button" data-act="want-close" data-want="${esc(w.id)}">Intrekken</button>`;
  } else {
    const offered = myLots.find((l) => isReaction(l, w));
    if (offered) extra = `<div class="want-yours">${offered.match.out ? "" : matchBadge(offered.match) + " "}Je hebt <b>${esc(offered.product)}</b> aangeboden; de koper ziet hem bij de vraag.</div>`;
    else if (myLots.length) extra = `<div class="want-yours">${matchBadge(myLots[0].match)} Je partij <b>${esc(myLots[0].product)}</b> ${myLots[0].match.level === "good" ? "past bij deze vraag" : "past bijna bij deze vraag"}; de koper ziet hem.</div>`;
    actions = S.canWrite !== false && S.me ? `<button class="btn primary small" type="button" data-act="want-supply" data-want="${esc(w.key)}">Ik kan leveren</button>` : "";
  }
  // Zelfde opbouw als een partij in het aanbod: titel, categorie · klasse, twee blokjes, regels met icoontjes, onderaan wie
  const pill = mine && !st.closed ? `<span class="pill acc">Jouw vraag</span>` : `<span class="pill ${st.cls}">${esc(st.label)}</span>`;
  return `<article class="want${mine ? " mine" : ""}${st.closed ? " closed" : ""}" id="want-${esc(w.buyerId)}-${esc(w.id)}">
    <div class="want-body">
      <div class="want-head"><h3 class="tl-title prod">${esc(w.product)}</h3>${pill}</div>
      <div class="tl-meta"><span class="sw ${esc(w.category)}"></span>${esc(w.category)} · ${w.klasse ? esc(w.klasse) : "elke klasse"}</div>
      <div class="tl-stats"><div><b>${num.format(w.qty)} ${esc(w.unit)}</b><span>Gevraagd</span></div><div><b>${w.maxPrice > 0 ? euro.format(w.maxPrice) : "In overleg"}</b><span>${w.maxPrice > 0 ? `Max. per ${esc(unitSingular(w.unit))}` : "Prijs"}</span></div></div>
      ${mine && !st.closed ? `<div class="tl-line">${svgI(ICO.cal)}<span>${esc(st.label)}</span></div>` : ""}
      ${w.region || w.maxKm ? `<div class="tl-line">${svgI(ICO.pin)}<span>${w.region ? esc(w.region) : ""}${w.maxKm ? `<span class="sub">${w.region ? " · " : ""}max ${num.format(w.maxKm)} km</span>` : ""}</span></div>` : ""}
      ${w.note ? `<div class="tl-line">${svgI(ICO.note)}<span>${esc(w.note)}</span></div>` : ""}
      ${extra}
    </div>
    ${mine ? (actions ? `<div class="tl-seller want-foot mine"><div class="actions">${actions}</div></div>` : "") : `<div class="tl-seller want-foot">${svgI(ICO.shop)}<span class="want-who">${esc(w.company || "Koper")}</span><div class="actions">${actions}</div></div>`}
  </article>`;
}
function renderWants() {
  const box = $("#wanted"); if (!box) return;
  const all = allWants();
  $("#n-wanted").textContent = all.filter((w) => w.buyerId !== S.me && wantIsOpen(w)).length;
  if (!S.ready) { box.innerHTML = `<div class="notice">Vragen laden…</div>`; return; }
  const mineOnly = S.wsort === "mine";
  let list = mineOnly ? all.filter((w) => w.buyerId === S.me) : all.filter((w) => wantIsOpen(w));
  if (S.wcat) list = list.filter((w) => w.category === S.wcat);
  const qq = (S.wq || "").trim().toLowerCase();
  if (qq) list = list.filter((w) => [w.product, w.category, w.klasse, w.region, w.company, w.note].join(" ").toLowerCase().includes(qq));
  // Past bij mijn partijen: beste match met een van mijn open partijen (alleen vragen van anderen)
  const mine0 = S.wsort === "match" ? myOpenLots() : [];
  const best = (w) => (w.buyerId === S.me ? 0 : Math.max(0, ...mine0.map((l) => scoreOf(w, l).score)));
  if (S.wsort === "match") list = list.filter((w) => best(w) >= MatchCore.NEAR);
  const bySoon = (a, b) => (a.until || "").localeCompare(b.until || "");
  const sorters = {
    soon: (a, b) => (wantIsOpen(b) - wantIsOpen(a)) || ((b.buyerId === S.me) - (a.buyerId === S.me)) || bySoon(a, b),
    new: (a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""),
    match: (a, b) => (best(b) - best(a)) || bySoon(a, b),
    mine: (a, b) => (wantIsOpen(b) - wantIsOpen(a)) || bySoon(a, b),
  };
  list.sort(sorters[S.wsort] || sorters.soon);
  if (!list.length) {
    if (qq || S.wcat || S.wsort === "match") { box.innerHTML = `<div class="notice">${S.wsort === "match" && !qq ? "Er zijn nu geen vragen die bij je partijen passen." : "Geen vragen gevonden met deze filters."}</div>`; return; }
    box.innerHTML = `<div class="empty" style="grid-template-columns:1fr"><div><h2>${mineOnly ? "Je hebt nog niets gevraagd" : "Nog geen vragen"}</h2>
      <p>Zoek je iets dat niet in het aanbod staat? Plaats een vraag. Aanbieders met een passende partij krijgen direct een melding.</p>
      ${S.canWrite !== false && S.me ? `<button class="btn primary" type="button" data-act="want-new">+ Vraag plaatsen</button>` : ""}</div></div>`;
    return;
  }
  box.innerHTML = `<div class="want-grid">${list.map(wantCard).join("")}</div>`;
}
function showWant(key) {
  const [buyer, id] = String(key || "").split(":");
  S.wcat = ""; S.wq = ""; $("#wq").value = ""; $$("#want-chips .chip").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.wcat === "")));
  if (S.wsort === "match" || (S.wsort === "mine" && buyer !== S.me)) { S.wsort = "soon"; $("#wsort").value = "soon"; }
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
  S.wantCatTouched = !!w;
  const reopen = w && (w.status === "gesloten" || !wantIsOpen(w));
  $("#want-title").textContent = !w ? "Vraag plaatsen" : reopen ? "Vraag heropenen" : "Vraag bewerken";
  $("#want-submit").textContent = !w ? "Plaatsen" : reopen ? "Heropenen" : "Opslaan";
  const v = (sel, val) => ($(sel).value = val ?? "");
  v("#w-product", w?.product); v("#w-cat", w?.category || "Groente"); v("#w-qty", w ? decOut(w.qty) : ""); v("#w-unit", w?.unit || pref.get("wunit") || "pallets");
  v("#w-klasse", w?.klasse || ""); v("#w-price", w?.maxPrice ? eurOut(w.maxPrice) : "");
  v("#w-until", w && !reopen ? w.until : localDate(new Date(Date.now() + 7 * 86400000)));
  v("#w-region", w?.region); v("#w-maxkm", w?.maxKm ? String(w.maxKm) : ""); v("#w-note", w?.note);
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
  const rawKm = val("#w-maxkm"), maxKm = rawKm ? intIn(rawKm) : null;
  const err = !val("#w-product") ? "Vul in wat je zoekt." : !(qty > 0) ? "Vul een hoeveelheid in (een heel getal, behalve bij kg)." : rawPrice && !(maxPrice > 0) ? "Vul een geldige maximale prijs in, of laat het veld leeg." : rawKm && !(maxKm >= 1 && maxKm <= 1000) ? "Vul een maximale afstand in hele kilometers in (1 tot 1000), of laat het veld leeg." : rawKm && !val("#w-region") ? "Vul ook je plaats of postcode in; vanaf daar rekenen we de afstand." : !val("#w-until") ? "Kies vóór wanneer je het nodig hebt." : val("#w-until") < localDate() ? "Die datum ligt in het verleden." : !val("#w-company") ? "Vul je bedrijfsnaam in." : "";
  if (err) { $("#want-err").textContent = err; return; }
  const id = S.editingWant || newId().replace(/^l/, "w");
  const company = val("#w-company"), contact = val("#w-phone");
  pref.set("wunit", unit); pref.set("company", company); pref.set("contact", contact);
  const isNew = !S.editingWant;
  const ok = await saveMyWants((doc) => {
    doc.company = company; doc.contact = contact;
    const prev = doc.items[id] || {};
    doc.items[id] = { ...prev, product: val("#w-product"), category: val("#w-cat"), qty, unit, klasse: val("#w-klasse"), maxPrice, until: val("#w-until"), region: val("#w-region"), maxKm, note: val("#w-note"), status: "open" };
    delete doc.items[id].closedReason; delete doc.items[id].closedAt;
  });
  if (!ok) return;
  dlgWant.close();
  const w = { ...myWantsDoc().items[id], id, buyerId: S.me, key: `${S.me}:${id}` };
  const hits = lotsForWant(w), n = hits.length;
  toast(isNew ? (n ? `Vraag geplaatst. ${n === 1 ? "1 partij gevonden" : n + " partijen gevonden"}, beste match ${hits[0].match.score}%; je ziet ze bij je vraag.` : "Vraag geplaatst. Aanbieders met een passende partij krijgen een melding.") : "Vraag opgeslagen.");
  if (S.view !== "wanted") setView("wanted");
});

// ---------- acties ----------
document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-act]");
  if (!t || !/^(want|supply)-/.test(t.dataset.act)) return;
  const act = t.dataset.act;
  if (act === "want-new") return openWantDialog();
  if (act === "want-edit") return openWantDialog(t.dataset.want);
  if (act === "want-lot") return openLotDetail(t.dataset.seller, t.dataset.lot);
  if (act === "want-bid") return openBidDialog(t.dataset.lot, { price: Number(t.dataset.price) });
  if (act === "want-found" || act === "want-close") {
    const id = t.dataset.want;
    const ok = await saveMyWants((doc) => { const w = doc.items[id]; if (w) { w.status = "gesloten"; w.closedReason = act === "want-found" ? "gevonden" : "niet meer nodig"; } });
    if (ok) toast(act === "want-found" ? "Mooi! De vraag is gesloten." : "Vraag ingetrokken. Aanbieders zien hem niet meer.");
    return;
  }
  if (act === "want-supply") {
    const w = allWants().find((x) => x.key === t.dataset.want);
    if (!w) return;
    // Eerst je eigen lopende partijen; alleen als je niets in het aanbod hebt meteen een nieuwe partij
    if (sameProductLots(w).length) return openSupply(w);
    return newLotForWant(w);
  }
  if (act === "supply-lot") {
    const w = S.supplyWant, id = t.dataset.lot;
    if (!w || !id) return;
    t.disabled = true;
    const ok = await saveMyLots((doc) => { const it = doc.items[id]; if (it) it.offeredTo = { ...(it.offeredTo || {}), [w.key]: { at: new Date().toISOString() } }; });
    t.disabled = false;
    if (!ok) return;
    dlgSupply.close();
    const l = myLotsDoc()?.items?.[id];
    toast(`${l?.product || "Partij"} aangeboden. ${w.company || "De koper"} krijgt bericht en ziet hem bij de vraag.`);
    return;
  }
  if (act === "supply-new") { const w = S.supplyWant; dlgSupply.close(); if (w) newLotForWant(w); }
});
// Alleen eigen partijen van hetzelfde product (bloemkool-vraag → geen bananen)
const sameProductLots = (w) => myOpenLots().filter((l) => productMatches(w.product, l.product, l.ras, w.category !== l.category));
function myOpenLots() {
  const d = myLotsDoc(); if (!d) return [];
  return Object.entries(d.items || {}).map(([id, it]) => ({ ...it, id, sellerId: S.me, company: it.company || d.company || "" })).filter((l) => !lotState(l).closed);
}
// "Ik kan leveren": kies een partij die je al aanbiedt, of zet een nieuwe online
const dlgSupply = $("#dlg-supply");
function openSupply(w) {
  S.supplyWant = w;
  $("#sup-sub").textContent = `${w.company || "Een koper"} zoekt ${num.format(w.qty)} ${w.unit} ${w.product}${w.klasse ? " (" + w.klasse + ")" : ""}${w.maxPrice > 0 ? `, max ${euro.format(w.maxPrice)} per ${unitSingular(w.unit)}` : ", prijs in overleg"}${w.region ? ` · ${w.region}` : ""}.`;
  const lots = sameProductLots(w).map((l) => { const m = scoreOf(w, l); return { l, m, fit: m.level === "good", done: !!(l.offeredTo?.[w.key] || l.wantRef === w.key) }; })
    .sort((a, b) => (b.m.score - a.m.score) || (b.l.createdAt || "").localeCompare(a.l.createdAt || ""));
  $("#sup-list").innerHTML = lots.map(({ l, m, fit, done }) => `<div class="sup-item${fit ? " fit" : ""}">
      ${validPhotos(l)[0] ? `<img src="${photoUrl(validPhotos(l)[0])}" alt="" loading="lazy">` : `<span class="sup-noimg sw ${esc(l.category)}"></span>`}
      <div class="sup-txt"><b>${esc(l.product)}${l.ras ? " " + esc(l.ras) : ""}</b> ${m.out ? `<span class="sup-why">${esc(m.out)}</span>` : matchBadge(m)}
        <span class="sub">${num.format(l.remaining ?? l.qty)} ${esc(l.unit)} · ${euro.format(l.price)} per ${esc(unitSingular(l.unit))}${l.location ? " · " + esc(l.location) : ""}</span>
        ${matchLines(m)}</div>
      ${done ? `<span class="pill ok">Aangeboden</span>` : `<button class="btn small${fit ? " primary" : ""}" type="button" data-act="supply-lot" data-lot="${esc(l.id)}">Aanbieden</button>`}
    </div>`).join("");
  dlgSupply.showModal();
}
function newLotForWant(w) {
  {
    openLotDialog(null, {
      wantRef: w.key,
      title: "Aanbieden op vraag",
      banner: `Op de vraag van ${w.company || "een koper"}: ${num.format(w.qty)} ${w.unit} ${w.product}${w.maxPrice > 0 ? `, max ${euro.format(w.maxPrice)} per ${unitSingular(w.unit)}` : ""}${w.region ? ` (${w.region})` : ""}. Pas aan wat bij jou anders is; de koper krijgt bericht zodra je publiceert.`,
      fields: { "#f-product": w.product, "#f-cat": guessCategory(w.product) || w.category, "#f-klasse": w.klasse || undefined, "#f-qty": w.unit === "kg" ? decOut(w.qty) : String(w.qty), "#f-unit": w.unit, "#f-price": w.maxPrice > 0 ? eurOut(w.maxPrice) : "" },
    });
  }
}
S.wsort = "soon"; S.wq = "";
$("#wq").addEventListener("input", () => { S.wq = $("#wq").value; renderWants(); });
$("#wsort").addEventListener("change", () => { S.wsort = $("#wsort").value; renderWants(); });
$("#want-chips").addEventListener("click", (e) => {
  const c = e.target.closest("[data-wcat]"); if (!c) return;
  S.wcat = c.dataset.wcat;
  $$("#want-chips .chip").forEach((x) => x.setAttribute("aria-pressed", String(x === c)));
  renderWants();
});

// ---------- categorie vanzelf invullen bij het typen van het product ----------
// Eerst: wat er al in het aanbod staat met precies dit product (niet de vragen: daar kan juist de fout in zitten); anders een lijst met bekende producten.
// Langste woord eerst, zodat "Frietaardappelen" Aardappelen wordt en niet Fruit (vanwege "appel").
const CAT_WORDS = {
  Groente: "tomaat trostomaat cherrytomaat komkommer paprika sla ijsbergsla kropsla rucola broccoli bloemkool wortel peen ui sjalot prei champignon paddenstoel courgette aubergine spinazie andijvie spruit kool rodekool spitskool savooiekool chinesekool paksoi witlof asperge boon sperzieboon snijboon erwt peul knoflook selderij bleekselderij knolselderij radijs biet pompoen mais venkel pastinaak peper rabarber koolrabi raap",
  Fruit: "appel peer aardbei framboos braam bes blauwebes bosbes kers pruim druif banaan sinaasappel mandarijn clementine citroen limoen meloen watermeloen kiwi mango ananas perzik nectarine abrikoos grapefruit avocado granaatappel vijg elstar jonagold jonagored kanzi junami conference doyenne gieser",
  Aardappelen: "aardappel frietaardappel consumptieaardappel kriel krieltje pootaardappel agria fontane bintje nicola innovator markies opperdoezer zoeteaardappel",
};
const CAT_DICT = Object.entries(CAT_WORDS).flatMap(([cat, list]) => list.split(" ").map((w) => [matchStem(w), cat])).sort((a, b) => b[0].length - a[0].length);
function guessCategory(product) {
  const ws = matchWords(product);
  if (!ws.length) return "";
  const key = ws.join(" ");
  const seen = {};
  for (const x of allLots()) if (matchWords(x.product).join(" ") === key && x.category) seen[x.category] = (seen[x.category] || 0) + 1;
  const best = Object.entries(seen).sort((a, b) => b[1] - a[1])[0];
  if (best) return best[0];
  for (const [stem, cat] of CAT_DICT) if (ws.some((w) => w === stem || (stem.length >= 4 && w.includes(stem)))) return cat;
  return "";
}
function autoCategory(productSel, catSel, flag) {
  $(productSel).addEventListener("input", () => {
    if (S[flag]) return; // zelf gekozen: niet meer overschrijven
    const c = guessCategory($(productSel).value);
    if (c && $(catSel).value !== c) { $(catSel).value = c; $(catSel).classList.add("auto-set"); setTimeout(() => $(catSel).classList.remove("auto-set"), 900); }
  });
  $(catSel).addEventListener("change", () => { S[flag] = true; });
}
autoCategory("#w-product", "#w-cat", "wantCatTouched");
autoCategory("#f-product", "#f-cat", "lotCatTouched");
// Nieuw venster: weer vrij om te raden (bij bewerken of 'Ik kan leveren' staat de categorie al goed)
document.addEventListener("lot-dialog-open", () => { S.lotCatTouched = !!S.editing || !!S.wantRef; });
