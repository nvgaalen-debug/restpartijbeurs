// Restpartijbeurs – Aanbod, mijn partijen, mijn biedingen, partij- en bieddialogen, foto's, contact
// Volgorde in index.html: core, market, account, admin, payments, stats, start.
// ---------- rendering ----------
function specRows(l) {
  const rows = [
    ["Partij", `${num.format(l.remaining ?? l.qty)} ${esc(l.unit)}${(l.remaining ?? l.qty) !== l.qty ? ` <span class="sub" style="color:var(--muted)">van ${num.format(l.qty)}</span>` : ""}`],
    l.pack ? ["Verpakking", esc(l.pack)] : null,
    l.minQty > 1 ? ["Min. afname", `${num.format(l.minQty)} ${esc(l.unit)}`] : null,
    ["Houdbaar tot", l.until ? new Date(l.until + "T12:00").toLocaleDateString("nl-NL", { weekday: "short", day: "numeric", month: "short" }) : "—"],
    l.location ? ["Afhalen", esc(l.location)] : null,
    ["Aanbieder", esc(l.company) + (l.contact ? `<br><span style="color:var(--muted)">${esc(l.contact)}</span>` : "")],
  ].filter(Boolean);
  return `<dl class="specs">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
}

function lotCard(l, { example = false } = {}) {
  const st = example ? { label: "Nog 3 dagen", cls: "ok", closed: false } : lotState(l);
  const sum = example ? { top: 0, n: 0 } : bidSummary(l.id);
  const mine = !example && l.sellerId === S.me;
  const myOffer = !example && myBidDoc()?.offers?.[l.id];
  let action = "";
  if (example) action = `<button class="btn primary small" type="button" tabindex="-1">Bieden</button>`;
  else if (mine) action = `<button class="btn small" type="button" data-act="manage">Beheren</button>`;
  else {
    const contactBtn = `<button class="btn small" type="button" data-act="contact" data-seller="${esc(l.sellerId)}" data-lot="${esc(l.id)}">Contact</button>`;
    const bidBtn = !st.closed && S.canWrite !== false && S.me ? `<button class="btn primary small" type="button" data-act="bid" data-lot="${esc(l.id)}">${myOffer ? "Bod wijzigen" : "Bieden"}</button>` : "";
    action = `<div class="actions">${contactBtn}${bidBtn}</div>`;
  }

  const bidLine = example ? `<div class="bidinfo">Hoogste bod <b>${euro.format(5.8)}</b> · 3 biedingen</div>`
    : `<div class="bidinfo">${sum.n ? `Hoogste bod <b>${euro.format(sum.top)}</b> · ${sum.n} ${sum.n === 1 ? "bod" : "biedingen"}` : "Nog geen biedingen"}${myOffer ? ` · jouw bod <b>${euro.format(myOffer.price)}</b>` : ""}</div>`;

  return `<article class="lot${st.closed ? " closed" : ""}">
    <div class="label-strip"><span class="cat"><span class="sw ${esc(l.category)}"></span>${esc(l.category)} · ${esc(l.klasse)}${l.origin ? " · " + esc(l.origin) : ""}</span>
      <span class="pill ${st.cls}">${mine && !st.closed ? "Jouw partij" : st.label}</span></div>
    <div class="lot-body">
      ${example ? "" : thumbStrip(l)}
      <div><h3 class="prod">${esc(l.product)}</h3>${l.ras ? `<div class="ras">${esc(l.ras)}</div>` : ""}${!example && ((l.wantRef || "").startsWith(S.me + ":") || Object.keys(l.offeredTo || {}).some((k) => k.startsWith(S.me + ":"))) ? `<div class="want-tag">Reactie op jouw vraag</div>` : ""}${!example && typeof myBestMatch === "function" ? ((b) => (b ? `<div class="lot-match ${b.sc.level}">${b.sc.score}% match met je vraag</div>` : ""))(myBestMatch(l)) : ""}</div>
      ${specRows(l)}
      ${l.note ? `<div class="note">${esc(l.note)}</div>` : ""}
    </div>
    <div class="lot-foot">
      <div><div class="price">${euro.format(l.price)} <small>/ ${esc(unitSingular(l.unit))}</small></div>${bidLine}</div>
      ${action}
    </div>
  </article>`;
}
const photoUrl = (id, full) => "/api/photo/" + encodeURIComponent(id) + (full ? "?s=f" : "?s=t");
const validPhotos = (l) => (Array.isArray(l.photos) ? l.photos.filter((p) => /^p[a-f0-9]{18}$/.test(p)).slice(0, 3) : []);
function thumbStrip(l) {
  const ps = validPhotos(l);
  if (!ps.length) return "";
  const cls = ps.length === 1 ? " one" : ps.length === 2 ? " two" : "";
  return `<div class="thumbs${cls}">${ps.map((p, i) => `<button type="button" data-act="photo" data-seller="${esc(l.sellerId)}" data-lot="${esc(l.id)}" data-i="${i}" aria-label="Foto ${i + 1} van ${esc(l.product)} vergroten"><img src="${photoUrl(p)}" alt="" loading="lazy"></button>`).join("")}</div>`;
}
// ---------- telefoon: compacte tegel (2 kolommen); tikken opent de volledige advertentie ----------
const isCompact = () => matchMedia("(max-width: 600px)").matches;
const CAT_ICON = {
  Groente: '<path d="M12 21c-4-3-6-7-6-11 0-3 2.5-6 6-7 3.5 1 6 4 6 7 0 4-2 8-6 11z"/><path d="M12 21V8"/>',
  Fruit: '<path d="M12 7c-3-2-8-1-8 5s4 9 6 9c1 0 1.4-.5 2-.5s1 .5 2 .5c2 0 6-3 6-9s-5-7-8-5z"/><path d="M12 7c0-2 1-4 3-4"/>',
  Aardappelen: '<path d="M6 8c2-4 9-5 12-2s2 10-3 12-11 1-11-4c0-2 1-4 2-6z"/><circle cx="10" cy="10" r=".6"/><circle cx="14" cy="13" r=".6"/><circle cx="10" cy="15" r=".6"/>',
};
const ICO = {
  pin: '<path d="M12 21s-6-5.3-6-10a6 6 0 0 1 12 0c0 4.7-6 10-6 10z"/><circle cx="12" cy="11" r="2.2"/>',
  box: '<path d="M12 2.8l8.5 4.6v9.2L12 21.2l-8.5-4.6V7.4z"/><path d="M3.5 7.4L12 12l8.5-4.6M12 12v9.2"/>',
  shop: '<path d="M3.5 9.5L5 4h14l1.5 5.5"/><path d="M3.5 9.5h17v10.5h-17z"/><path d="M9.5 20v-5.5h5V20"/>',
  cal: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  note: '<path d="M5 4h14v12l-4 4H5z"/><path d="M15 20v-4h4M8.5 9h7M8.5 12.5h5"/>',
};
const svgI = (d, cls = "tl-ico") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
function lotTile(l) {
  const st = lotState(l), mine = l.sellerId === S.me;
  const ph = validPhotos(l)[0];
  const rem = l.remaining ?? l.qty;
  const until = l.until ? new Date(l.until + "T12:00").toLocaleDateString("nl-NL", { day: "numeric", month: "short" }) : "";
  const myOffer = myBidDoc()?.offers?.[l.id];
  return `<article class="tl${st.closed ? " closed" : ""}" data-act="lot-detail" data-seller="${esc(l.sellerId)}" data-lot="${esc(l.id)}" tabindex="0" role="button" aria-label="${esc(l.product)}: details bekijken">
    <div class="tl-photo">${ph ? `<img src="${photoUrl(ph)}" alt="" loading="lazy">` : `<div class="tl-noimg ${esc(l.category)}">${svgI(CAT_ICON[l.category] || CAT_ICON.Groente, "tl-catico")}</div>`}
      <span class="tl-badge ${mine && !st.closed ? "mine" : st.cls}">${mine && !st.closed ? "Jouw partij" : st.closed || st.cls === "warn" ? esc(st.label) : "Beschikbaar"}</span>
      ${myOffer && !st.closed ? `<span class="tl-mybid">Jouw bod</span>` : ""}${!st.closed && typeof myBestMatch === "function" ? ((b) => (b ? `<span class="tl-match ${b.sc.level}">${b.sc.score}% match</span>` : ""))(myBestMatch(l)) : ""}</div>
    <div class="tl-body">
      <h3 class="tl-title">${esc(l.product)}</h3>
      <div class="tl-meta">${esc(l.category)} · ${esc(l.klasse)}${l.origin ? " · " + esc(l.origin) : ""}</div>
      <div class="tl-stats"><div><b>${num.format(rem)} ${esc(l.unit)}</b><span>Partij</span></div><div><b>${euro.format(l.price)}</b><span>Prijs per ${esc(unitSingular(l.unit))}</span></div></div>
      ${l.location || until ? `<div class="tl-line">${svgI(ICO.pin)}<span>${esc(l.location || "")}${l.location && until ? "<br>" : ""}${until ? `<span class="sub">Tot ${esc(until)}</span>` : ""}</span></div>` : ""}
      ${l.pack ? `<div class="tl-line">${svgI(ICO.box)}<span>${esc(l.pack)}</span></div>` : ""}
      <div class="tl-seller">${svgI(ICO.shop)}<span>${esc(l.company || "")}</span><span class="tl-chev" aria-hidden="true">›</span></div>
    </div>
  </article>`;
}
const dlgDetail = $("#dlg-lotdetail");
function openLotDetail(seller, lotId) {
  S.detail = { seller, lotId };
  renderLotDetail();
  if (!dlgDetail.open) dlgDetail.showModal();
}
function renderLotDetail() {
  if (!S.detail) return;
  const l = allLots().find((x) => x.id === S.detail.lotId && x.sellerId === S.detail.seller);
  if (!l) { if (dlgDetail.open) dlgDetail.close(); return; }
  $("#ld-title").textContent = l.product;
  const best = typeof myBestMatch === "function" && !lotState(l).closed ? myBestMatch(l) : null;
  $("#ld-body").innerHTML = lotCard(l) + (best ? `<div class="ld-match ${best.sc.level}"><div class="ld-match-title">${matchBadge(best.sc)} ${best.sc.level === "good" ? "Past bij" : "Past bijna bij"} je vraag: ${esc(best.w.product)}, ${num.format(best.w.qty)} ${esc(best.w.unit)}</div>${matchLines(best.sc)}
    ${best.sc.bidAt && S.canWrite !== false ? `<button class="btn small" type="button" data-act="want-bid" data-lot="${esc(l.id)}" data-price="${best.sc.bidAt}">Bied ${euro.format(best.sc.bidAt)}</button>` : ""}</div>` : "");
}
dlgDetail.addEventListener("close", () => { S.detail = null; });
document.addEventListener("keydown", (e) => {
  const t = e.target.closest?.(".tl[data-act]");
  if (t && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); t.click(); }
});
matchMedia("(max-width: 600px)").addEventListener("change", () => { if (typeof renderMarket === "function") renderMarket(); });

function unitSingular(u) { return ({ colli: "collo", pallets: "pallet", kisten: "kist", zakken: "zak" }[u]) || u; }

const EXAMPLE = { product: "Trostomaten", ras: "Klasse I, maat B", category: "Groente", klasse: "Klasse I", origin: "NL", qty: 240, remaining: 240, unit: "colli", pack: "6 kg doos, 80 colli per pallet", minQty: 40, price: 6.5, location: "Barendrecht", company: "Kwekerij De Voorbeeldkas", contact: "010 000 0000", note: "Overschot na geannuleerde order. Kleur 7–8, morgen af te halen." };

function renderMarket() {
  const box = $("#market");
  let lots = allLots();
  const openCount = lots.filter((l) => !lotState(l).closed).length;
  $("#n-market").textContent = openCount;

  if (!S.ready) {
    box.innerHTML = `<div class="empty"><div><h2>Aanbod laden…</h2><p>De partijen worden opgehaald.</p></div><div class="example">${lotCard(EXAMPLE, { example: true })}</div></div>`;
    return;
  }
  if (!lots.length) {
    box.innerHTML = `<div class="empty"><div><h2>Nog geen restpartijen</h2>
      <p>Heb je een overschot aan groente, fruit of aardappelen? Zet het hier binnen een minuut online. Collega-handelaren zien je partij direct en kunnen een bod doen per eenheid.</p>
      ${S.canWrite !== false && S.me ? `<button class="btn primary" type="button" data-act="new">+ Eerste partij aanbieden</button>` : ""}</div>
      <div class="example">${lotCard(EXAMPLE, { example: true })}</div></div>`;
    return;
  }
  // Afgesloten partijen (verkocht, ingetrokken, verlopen) tonen kan alleen de beheerder, en niet op de telefoon
  const isAdmin = S.user?.role === "beheerder";
  document.body.classList.toggle("can-show-closed", isAdmin);
  if (!isAdmin) { S.showClosed = false; $("#show-closed").checked = false; }
  if (!S.showClosed || isCompact()) lots = lots.filter((l) => !lotState(l).closed);
  if (S.cat) lots = lots.filter((l) => l.category === S.cat);
  if (S.q) {
    const q = S.q.toLowerCase();
    lots = lots.filter((l) => [l.product, l.ras, l.origin, l.location, l.company, l.pack].join(" ").toLowerCase().includes(q));
  }
  const sorters = {
    new: (a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""),
    until: (a, b) => (a.until || "9999").localeCompare(b.until || "9999"),
    price: (a, b) => a.price - b.price,
    value: (a, b) => (b.remaining ?? b.qty) * b.price - (a.remaining ?? a.qty) * a.price,
  };
  lots.sort(sorters[S.sort]);
  if (dlgDetail.open) renderLotDetail();
  const compact = isCompact();
  box.innerHTML = lots.length ? `<div class="${compact ? "tl-grid" : "grid"}">${lots.map((l) => (compact ? lotTile(l) : lotCard(l))).join("")}</div>`
    : `<div class="notice">Geen partijen gevonden met deze filters.</div>`;
}

function renderMine() {
  const box = $("#mine");
  const doc = myLotsDoc();
  const lots = Object.entries((doc && doc.items) || {}).map(([id, it]) => ({ ...it, id, sellerId: S.me, company: it.company || doc.company, contact: it.contact || doc.contact }))
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  $("#n-mine").textContent = lots.filter((l) => !lotState(l).closed).length;
  if (!lots.length) {
    $("#mine-filter").innerHTML = "";
    box.innerHTML = `<div class="empty" style="grid-template-columns:1fr"><div><h2>Je hebt nog niets aangeboden</h2>
      <p>Partijen die je aanbiedt verschijnen hier, met alle biedingen eronder.</p>
      ${S.canWrite !== false && S.me ? `<button class="btn primary" type="button" data-act="new">+ Partij aanbieden</button>` : ""}</div></div>`;
    return;
  }
  // Filter: alle, nog beschikbaar (open), of (deels) gegund
  const F = {
    all: { label: "Alle", ok: () => true },
    open: { label: "Beschikbaar", ok: (l) => !lotState(l).closed },
    awarded: { label: "Gegund", ok: (l) => Object.keys(l.accepted || {}).length > 0 },
  };
  if (!F[S.mineFilter]) { let v = ""; try { v = localStorage.getItem("rpb-mine-filter") || ""; } catch {} S.mineFilter = F[v] ? v : "all"; }
  $("#mine-filter").innerHTML = Object.entries(F).map(([k, f]) => `<button class="chip" type="button" data-act="mine-filter" data-f="${k}" aria-pressed="${S.mineFilter === k}">${f.label} <span class="n">${lots.filter(f.ok).length}</span></button>`).join("");
  const shown = lots.filter(F[S.mineFilter].ok);
  if (!shown.length) {
    box.innerHTML = `<div class="notice">${S.mineFilter === "awarded" ? "Je hebt nog geen partijen gegund." : "Je hebt geen partijen die nog beschikbaar zijn."}</div>`;
    return;
  }
  box.innerHTML = shown.map((l) => {
    const st = lotState(l);
    const bids = bidsFor(l.id);
    const accepted = l.accepted || {};
    const rejected = l.rejected || {};
    const rem = l.remaining ?? l.qty;
    const soldQty = Object.values(accepted).reduce((s, a) => s + (a.qty || 0), 0);
    const rows = bids.map((b) => {
      const acc = accepted[b.bidderId];
      const rej = rejected[b.bidderId];
      const canAct = !st.closed && !acc && !rej;
      const status = acc ? `<span class="pill ok">Gegund ${num.format(acc.qty)} ${esc(l.unit)}</span>` : rej ? `<span class="pill off">Afgewezen</span>` : st.closed ? `<span class="pill off">Gesloten</span>` : `<span class="pill acc">Open</span>`;
      return `<tr>
        <td class="bc-who">${esc(b.company) || "Onbekend"}${b.contact ? `<div class="sub">${esc(b.contact)}</div>` : ""}${b.note ? `<div class="sub">“${esc(b.note)}”</div>` : ""}</td>
        <td class="num" data-label="Prijs">${euro.format(b.price)}<div class="sub">${b.price >= l.price ? "≥ vraagprijs" : Math.round((1 - b.price / l.price) * 100) + "% onder vraag"}</div></td>
        <td class="num" data-label="Hoeveelheid">${num.format(b.qty)} ${esc(l.unit)}</td>
        <td class="num" data-label="Totaal">${euro.format(b.price * Math.min(b.qty, rem || b.qty))}</td>
        <td class="bc-status">${status}</td>
        <td class="num bc-act"><div class="actions" style="justify-content:flex-end">${canAct ? `<button class="btn primary small" type="button" data-act="accept" data-lot="${esc(l.id)}" data-bidder="${esc(b.bidderId)}">Accepteren</button><button class="btn small" type="button" data-act="reject" data-lot="${esc(l.id)}" data-bidder="${esc(b.bidderId)}">Afwijzen</button>` : ""}<button class="btn small${acc ? " primary" : ""}" type="button" data-act="contact-bidder" data-lot="${esc(l.id)}" data-bidder="${esc(b.bidderId)}">Contact</button></div></td>
      </tr>`;
    }).join("");
    return `<div class="panel">
      <div class="panel-head">
        <div class="panel-title">${validPhotos(l).length ? `<img class="panel-thumb" src="${photoUrl(validPhotos(l)[0])}" alt="" loading="lazy" data-act="photo" data-seller="${esc(S.me)}" data-lot="${esc(l.id)}" data-i="0">` : ""}<div style="min-width:0"><h3>${esc(l.product)}${l.ras ? ` <span style="font-weight:500;color:var(--muted)">${esc(l.ras)}</span>` : ""}</h3>
          <div class="meta">${soldQty ? `${num.format(l.qty)} ${esc(l.unit)} aangeboden` : `${num.format(rem)} van ${num.format(l.qty)} ${esc(l.unit)} beschikbaar`} · vraagprijs ${euro.format(l.price)} · <span class="pill ${st.cls}">${st.label}</span>${l.status === "ingetrokken" && l.withdrawReason ? ` <span class="sub">Reden: ${esc(reasonText(l.withdrawReason))}${l.withdrawReason.by === "beheer" ? " (door beheer)" : ""}</span>` : ""}</div>${soldQty > 0 ? (() => {
            const pct = Math.max(0, Math.min(100, Math.round(soldQty / (soldQty + Math.max(rem, 0)) * 100)));
            const restTxt = rem <= 0 ? "alles gegund" : st.closed ? `${num.format(rem)} ${esc(l.unit)} niet meer te koop` : `<b>${num.format(rem)} ${esc(l.unit)}</b> nog beschikbaar`;
            return `<div class="award" data-pct="${pct}"><div class="award-bar${st.closed && rem > 0 ? " closed" : ""}" role="img" aria-label="${pct}% gegund"><span style="width:${pct}%"></span></div>
              <div class="award-txt"><span class="award-done">${num.format(soldQty)} ${esc(l.unit)} gegund</span> · ${restTxt}</div></div>`;
          })() : ""}</div></div>
        <div class="actions">
          ${l.status === "ingetrokken" ? `<button class="btn small" type="button" data-act="reopen" data-lot="${esc(l.id)}">Heropenen</button>`
            : st.key !== "sold" ? `<button class="btn small" type="button" data-act="edit" data-lot="${esc(l.id)}">Bewerken</button><button class="btn small" type="button" data-act="withdraw" data-lot="${esc(l.id)}">Intrekken</button>` : ""}
        </div>
      </div>
      ${bids.length ? `<div class="tablewrap"><table class="bids bid-cards"><thead><tr><th>Bieder</th><th class="num">Prijs</th><th class="num">Hoeveelheid</th><th class="num">Totaal</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
        : `<div class="nobids">Nog geen biedingen op deze partij.</div>`}
    </div>`;
  }).join("");
}

function renderBids() {
  const box = $("#mybids");
  const doc = myBidDoc();
  const offers = Object.entries((doc && doc.offers) || {});
  const lotsById = new Map(allLots().map((l) => [l.id, l]));
  const items = offers.map(([lotId, o]) => {
    const l = lotsById.get(lotId);
    let status;
    if (!l) status = { label: "Partij verwijderd", cls: "off", open: false, key: "lost" };
    else if (l.accepted && l.accepted[S.me]) status = { label: `Gegund: ${num.format(l.accepted[S.me].qty)} ${esc(l.unit)}`, cls: "ok", open: false, key: "won" };
    else if (l.rejected && l.rejected[S.me]) status = { label: "Afgewezen", cls: "off", open: false, key: "rejected" };
    else { const st = lotState(l); status = st.closed ? { label: "Niet gegund", cls: "off", open: false, key: "lost" } : { label: "In behandeling", cls: "acc", open: true, key: "open" }; }
    return { lotId, o, l, status };
  }).sort((a, b) => (b.o.at || "").localeCompare(a.o.at || ""));
  $("#n-bids").textContent = items.filter((i) => i.status.open).length;
  if (!items.length) {
    $("#bids-filter").innerHTML = "";
    box.innerHTML = `<div class="empty" style="grid-template-columns:1fr"><div><h2>Nog geen biedingen</h2><p>Bied op een partij in het aanbod. Je ziet hier of de verkoper je bod accepteert.</p>
      <button class="btn" type="button" data-act="goto-market">Naar het aanbod</button></div></div>`;
    return;
  }
  // Filter op status; "Niet gegund" (partij verkocht aan een ander, verlopen of verwijderd) alleen als die er zijn
  const F = { all: "Alle", open: "In behandeling", won: "Gegund", rejected: "Afgewezen", lost: "Niet gegund" };
  const count = (k) => (k === "all" ? items.length : items.filter((i) => i.status.key === k).length);
  if (!F[S.bidsFilter]) { let v = ""; try { v = localStorage.getItem("rpb-bids-filter") || ""; } catch {} S.bidsFilter = F[v] ? v : "all"; }
  $("#bids-filter").innerHTML = Object.entries(F).filter(([k]) => k !== "lost" || count(k) || S.bidsFilter === k)
    .map(([k, label]) => `<button class="chip" type="button" data-act="bids-filter" data-f="${k}" aria-pressed="${S.bidsFilter === k}">${label} <span class="n">${count(k)}</span></button>`).join("");
  const shown = S.bidsFilter === "all" ? items : items.filter((i) => i.status.key === S.bidsFilter);
  if (!shown.length) { box.innerHTML = `<div class="notice">Geen biedingen met de status “${F[S.bidsFilter]}”.</div>`; return; }
  box.innerHTML = `<div class="panel"><div class="tablewrap"><table class="bids bid-cards"><thead><tr><th>Partij</th><th class="num">Jouw bod</th><th class="num">Hoeveelheid</th><th class="num">Totaal</th><th>Status</th><th></th></tr></thead><tbody>
    ${shown.map(({ lotId, o, l, status }) => {
      const sm = l ? bidSummary(lotId) : null;
      const top = sm && sm.n ? { price: sm.top } : null;
      const winning = top && o.price >= top.price;
      return `<tr>
        <td class="bc-who"><b>${esc(l ? l.product : o.product || "Partij")}</b>${l ? `<div class="sub">${esc(l.company)}${l.contact ? " · " + esc(l.contact) : ""}</div>` : ""}</td>
        <td class="num" data-label="Jouw bod">${euro.format(o.price)}${status.open && top ? `<div class="sub">${winning ? "Hoogste bod" : "Hoogste: " + euro.format(top.price)}</div>` : ""}</td>
        <td class="num" data-label="Hoeveelheid">${num.format(o.qty)} ${esc(l ? l.unit : "")}</td>
        <td class="num" data-label="Totaal">${euro.format(o.price * o.qty)}</td>
        <td class="bc-status"><span class="pill ${status.cls}">${status.label}</span></td>
        <td class="num bc-act"><div class="actions" style="justify-content:flex-end">${status.open ? `<button class="btn small" type="button" data-act="bid" data-lot="${esc(lotId)}">Wijzigen</button>` : ""}${l ? `<button class="btn small${status.cls === "ok" ? " primary" : ""}" type="button" data-act="contact-seller" data-lot="${esc(lotId)}">Contact</button>` : ""}<button class="btn small ghost" type="button" data-act="retract" data-lot="${esc(lotId)}">${status.open ? "Intrekken" : "Verwijderen"}</button></div></td>
      </tr>`;
    }).join("")}</tbody></table></div></div>`;
}

function renderStatus() {
  const el = $("#status");
  if (S.offline && S.token) {
    el.hidden = false;
    el.innerHTML = `<strong>Geen verbinding met de server.</strong> Wat je ziet kan verouderd zijn. De pagina probeert het elke 30 seconden opnieuw.`;
  } else if (typeof pausedForIdle !== "undefined" && pausedForIdle && S.token) {
    el.hidden = false;
    el.textContent = "Bijwerken gepauzeerd omdat je even niets hebt gedaan. Beweeg je muis of tik op het scherm om de nieuwste partijen en biedingen te zien.";
  } else el.hidden = true;
  $("#btn-new").hidden = !(S.me && S.canWrite !== false);
}

// Niet opnieuw beginnen terwijl we al aan het renderen zijn; dan nog één keer erna
let rendering = false;
function render() {
  if (rendering) { scheduleRender(); return; }
  rendering = true;
  try {
    renderStatus();
    renderMarket();
    renderMine();
    renderBids();
    if (typeof renderWants === "function") renderWants();
  } finally { rendering = false; }
}

// ---------- view switching ----------
function setView(v) {
  S.view = v;
  $$(".tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.view === v)));
  $("#view-market").hidden = v !== "market";
  $("#view-wanted").hidden = v !== "wanted";
  $("#view-mine").hidden = v !== "mine";
  $("#view-bids").hidden = v !== "bids";
  $("#view-admin").hidden = v !== "admin";
  $("#view-login").hidden = true;
  document.body.dataset.view = v; // telefoon: knop "Partij aanbieden" niet over Beheer heen
  const ft = $("#btn-new .fab-text"); if (ft) ft.textContent = v === "wanted" ? " Vraag plaatsen" : " Partij aanbieden";
  if (v === "admin") setAdminPane(S.apane || "dash");
  try { localStorage.setItem("rpb.view", v); } catch {}
}

// ---------- lot dialog ----------
const dlgLot = $("#dlg-lot");
// Telefoon/tablet: niet meteen een veld selecteren, anders schuift het toetsenbord over het venster (en de fotoknop)
const isTouch = () => matchMedia("(pointer: coarse)").matches;
// Bedragen tonen en lezen met komma; "1.234,50" en "6.50" werken allebei
const eurOut = (n) => (typeof n === "number" && isFinite(n) ? n.toFixed(2).replace(".", ",") : "");
const decOut = (n) => (n === null || n === undefined || n === "" ? "" : String(n).replace(".", ","));
const decIn = (v) => { let t = String(v ?? "").trim().replace(/\s/g, ""); if (t.includes(",")) t = t.replace(/\./g, "").replace(",", "."); return parseFloat(t); };
const intIn = (v) => { const t = String(v ?? "").trim().replace(/[\s.]/g, ""); return /^\d+$/.test(t) ? parseInt(t, 10) : NaN; };
function openLotDialog(lotId, prefill) {
  S.editing = lotId || null;
  S.wantRef = !lotId && prefill?.wantRef ? prefill.wantRef : "";
  const doc = myLotsDoc();
  const l = lotId ? doc.items[lotId] : null;
  $("#lot-title").textContent = l ? "Partij bewerken" : "Partij aanbieden";
  $("#lot-submit").textContent = l ? "Opslaan" : "Publiceren";
  const tomorrow = localDate(new Date(Date.now() + 3 * 86400000));
  const v = (id, val) => ($(id).value = val ?? "");
  v("#f-product", l?.product); v("#f-ras", l?.ras); v("#f-cat", l?.category || "Groente"); v("#f-klasse", l?.klasse || "Klasse I");
  v("#f-herkomst", l?.origin || "NL"); v("#f-loc", l?.location); v("#f-qty", l?.qty); v("#f-unit", l?.unit || "colli");
  v("#f-kg", decOut(l?.kgPerUnit || "")); $("#f-kg-field").hidden = (l?.unit || "colli") === "kg";
  v("#f-minqty", l?.minQty || ""); v("#f-price", eurOut(l?.price)); v("#f-until", l?.until || tomorrow); v("#f-pack", l?.pack); v("#f-note", l?.note);
  v("#f-company", l?.company || doc?.company || S.user?.company || ""); v("#f-phone", l?.contact || doc?.contact || S.user?.contact || "");
  $("#lot-err").textContent = "";
  S.dlgPhotos = l ? validPhotos(l) : [];
  S.origPhotos = S.dlgPhotos.slice();
  S.newPhotos = [];
  S.lotSaved = false;
  S.uploading = 0;
  renderPhotoEdit();
  if (prefill) {
    for (const [id, val] of Object.entries(prefill.fields || {})) if (val !== undefined && val !== null && val !== "") $(id).value = val;
    $("#f-kg-field").hidden = $("#f-unit").value === "kg";
    $("#lot-title").textContent = prefill.title || $("#lot-title").textContent;
  }
  $("#lot-want").hidden = !S.wantRef; $("#lot-want").textContent = S.wantRef ? prefill.banner || "" : "";
  document.dispatchEvent(new CustomEvent("lot-dialog-open"));
  dlgLot.showModal();
  if (isTouch()) dlgLot.scrollTop = 0; else $("#f-product").focus();
}

// ---------- foto's ----------
function renderPhotoEdit() {
  const box = $("#photo-edit");
  const items = S.dlgPhotos.map((p, i) => `<div class="ph"><img src="${photoUrl(p)}" alt="Foto ${i + 1}">${i === 0 ? '<span class="badge">Hoofdfoto</span>' : ""}<button class="x" type="button" data-rmphoto="${esc(p)}" aria-label="Foto ${i + 1} verwijderen">×</button></div>`);
  for (let i = 0; i < S.uploading; i++) items.push(`<div class="ph busy">Bezig…</div>`);
  if (S.dlgPhotos.length + S.uploading < 3) items.push(`<button class="ph-add" type="button" id="btn-addphoto">+ Foto<br>toevoegen</button>`);
  box.innerHTML = items.join("");
}
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Deze foto kan niet worden geopend. Gebruik een JPG- of PNG-foto.")); };
    img.src = url;
  });
}
function shrink(img, maxSide, maxBytes, startQ) {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h);
  let q = startQ, out = c.toDataURL("image/jpeg", q);
  while (out.length * 0.75 > maxBytes && q > 0.4) { q -= 0.1; out = c.toDataURL("image/jpeg", q); }
  return out;
}
async function addPhotos(files) {
  const room = 3 - S.dlgPhotos.length - S.uploading;
  const list = Array.from(files).filter((f) => f.type.startsWith("image/")).slice(0, Math.max(0, room));
  if (files.length > room) toast("Maximaal 3 foto's per partij.");
  for (const file of list) {
    S.uploading++; renderPhotoEdit();
    try {
      const img = await loadImage(file);
      const full = shrink(img, 1280, 400 * 1024, 0.82);
      const thumb = shrink(img, 360, 50 * 1024, 0.75);
      const d = await api("photos", { method: "POST", body: { full, thumb } });
      S.dlgPhotos.push(d.id); S.newPhotos.push(d.id);
      document.dispatchEvent(new CustomEvent("lot-photo-added", { detail: d.id }));
    } catch (err) { toast(err.message || "Uploaden lukte niet."); }
    finally { S.uploading--; renderPhotoEdit(); }
  }
}
function deletePhotos(ids) { ids.forEach((id) => api("photos/" + encodeURIComponent(id), { method: "DELETE" }).catch(() => {})); }
$("#photo-edit").addEventListener("click", (e) => {
  if (e.target.closest("#btn-addphoto")) { $("#f-photo").click(); return; }
  const rm = e.target.closest("[data-rmphoto]");
  if (rm) { S.dlgPhotos = S.dlgPhotos.filter((p) => p !== rm.dataset.rmphoto); renderPhotoEdit(); }
});
$("#f-photo").addEventListener("change", (e) => { const f = e.target.files; if (f && f.length) addPhotos(f); e.target.value = ""; });
dlgLot.addEventListener("close", () => {
  // Nieuw geüploade foto's NIET hier weggooien: als het opslaan nog bezig was (trage verbinding) of de server
  // het al had opgeslagen, verwees de partij daarna naar een verwijderde foto. De server ruimt foto's die
  // nergens bij horen zelf op (na 6 uur, bij de volgende keer opslaan).
  S.newPhotos = [];
});

// ---------- contact ----------
const dlgContact = $("#dlg-contact");
function parseContact(s) {
  const text = String(s || "").trim();
  // Alleen een "schoon" e-mailadres gebruiken in de mailto-link (geen ?, &, cc= of bcc= erachter)
  const email = (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/) || [])[0] || "";
  const phoneRaw = (text.replace(email, "").match(/\+?[\d][\d\s\-().]{7,}\d/) || [])[0] || "";
  let digits = phoneRaw.replace(/[^\d+]/g, "");
  let intl = digits.startsWith("+") ? digits.slice(1) : digits.startsWith("00") ? digits.slice(2) : digits.startsWith("0") ? "31" + digits.slice(1) : digits;
  if (intl.length < 9) intl = "";
  return { text, email, phone: phoneRaw.trim(), tel: digits, wa: intl };
}
function openContact(sellerId, lotId) {
  const l = allLots().find((x) => x.id === lotId && x.sellerId === sellerId);
  if (!l) return;
  const rem = l.remaining ?? l.qty;
  const me = S.user ? S.user.name + (S.user.company ? ", " + S.user.company : "") : "";
  openContactWith({
    company: l.company || "Aanbieder", contact: l.contact, who: "aanbieder",
    sub: `Over ${l.product}${l.ras ? " · " + l.ras : ""}, ${num.format(rem)} ${l.unit} à ${euro.format(l.price)}.`,
    msg: `Goedendag,\n\nIk heb interesse in uw restpartij ${l.product}${l.ras ? " (" + l.ras + ")" : ""}: ${num.format(rem)} ${l.unit} à ${euro.format(l.price)} per ${unitSingular(l.unit)}, gezien op ${(S.settings && S.settings.siteName) || "de Restpartijbeurs"}. Is de partij nog beschikbaar?\n\nMet vriendelijke groet,\n${me}`,
    subject: `Restpartij ${l.product}${l.ras ? " " + l.ras : ""}`,
  });
}
// Koper → aanbieder: vanuit Mijn biedingen (vooral na een gunning: ophalen en betalen afspreken)
function openContactSeller(lotId) {
  const l = allLots().find((x) => x.id === lotId);
  const o = myBidDoc()?.offers?.[lotId];
  if (!l || !o) return;
  const acc = l.accepted?.[S.me];
  const me = S.user ? S.user.name + (S.user.company ? ", " + S.user.company : "") : "";
  const what = `${l.product}${l.ras ? " (" + l.ras + ")" : ""}`;
  const body = acc
    ? `U heeft mij ${num.format(acc.qty)} ${l.unit} ${what} à ${euro.format(acc.price)} per ${unitSingular(l.unit)} gegund, dank u wel. Graag stem ik het ophalen${l.location ? " in " + l.location : ""} en de betaling met u af. Wanneer schikt het u?`
    : `Ik heb op uw partij ${what} geboden: ${num.format(o.qty)} ${l.unit} à ${euro.format(o.price)} per ${unitSingular(l.unit)}. Ik wil het graag even met u over mijn bod hebben.`;
  openContactWith({
    company: l.company || "Aanbieder", contact: l.contact, who: "aanbieder",
    sub: `Over je bod op ${l.product}${l.ras ? " · " + l.ras : ""}: ${num.format(acc ? acc.qty : o.qty)} ${l.unit} à ${euro.format(acc ? acc.price : o.price)}${acc ? " (gegund)" : ""}.`,
    msg: `Goedendag,\n\n${body}\n\nMet vriendelijke groet,\n${me}`,
    subject: `${acc ? "Gegunde partij" : "Mijn bod op"} ${l.product}${l.ras ? " " + l.ras : ""}`,
  });
}
// Aanbieder → bieder: over een bod op een eigen partij (open, gegund of afgewezen)
function openContactBidder(lotId, bidderId) {
  const l = myLotsDoc()?.items?.[lotId];
  const b = bidsFor(lotId).find((x) => x.bidderId === bidderId);
  if (!l || !b) return;
  const acc = l.accepted?.[bidderId];
  const me = S.user ? S.user.name + (S.user.company ? ", " + S.user.company : "") : "";
  const what = `${l.product}${l.ras ? " (" + l.ras + ")" : ""}`;
  const body = acc
    ? `Bedankt voor uw bod op onze partij ${what}. Wij hebben u ${num.format(acc.qty)} ${l.unit} à ${euro.format(acc.price)} per ${unitSingular(l.unit)} gegund${l.location ? ", af te halen in " + l.location : ""}. Graag stemmen we het ophalen en de betaling met u af. Wanneer schikt het u?`
    : `Bedankt voor uw bod op onze partij ${what}: ${num.format(b.qty)} ${l.unit} à ${euro.format(b.price)} per ${unitSingular(l.unit)}. Ik wil het graag even met u over uw bod hebben.`;
  openContactWith({
    company: b.company || "Bieder", contact: b.contact, who: "bieder",
    sub: `Over het bod op ${l.product}${l.ras ? " · " + l.ras : ""}: ${num.format(acc ? acc.qty : b.qty)} ${l.unit} à ${euro.format(acc ? acc.price : b.price)}${acc ? " (gegund)" : ""}.`,
    msg: `Goedendag,\n\n${body}\n\nMet vriendelijke groet,\n${me}`,
    subject: `Uw bod op ${l.product}${l.ras ? " " + l.ras : ""}`,
  });
}
function openContactWith({ company, contact, who, sub, msg, subject }) {
  const c = parseContact(contact);
  $("#ct-sub").textContent = sub;
  $("#ct-company").textContent = company;
  $("#ct-line").textContent = c.text || `Deze ${who} heeft geen telefoonnummer of e-mailadres ingevuld.`;
  $("#ct-msg").value = msg;
  const btns = [];
  if (c.tel) btns.push(`<a class="btn primary" id="ct-call" href="tel:${esc(c.tel)}">Bellen</a>`);
  if (c.wa) btns.push(`<a class="btn" id="ct-wa" href="#" target="_blank" rel="noopener">WhatsApp</a>`);
  if (c.email) btns.push(`<a class="btn${c.tel ? "" : " primary"}" id="ct-mail" href="#">E-mail</a>`);
  if (c.text) btns.push(`<button class="btn" type="button" id="ct-copy">Gegevens kopiëren</button>`);
  $("#ct-actions").innerHTML = btns.join("");
  $("#ct-hint").textContent = "";
  const updateLinks = () => {
    const msg = $("#ct-msg").value;
    const wa = $("#ct-wa"); if (wa) wa.href = "https://wa.me/" + c.wa + "?text=" + encodeURIComponent(msg);
    const mail = $("#ct-mail"); if (mail) mail.href = "mailto:" + encodeURIComponent(c.email).replace(/%40/g, "@") + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(msg);
  };
  updateLinks();
  $("#ct-msg").oninput = updateLinks;
  const copy = $("#ct-copy");
  if (copy) copy.onclick = async () => {
    const t = `${company}\n${c.text}`;
    try { await navigator.clipboard.writeText(t); $("#ct-hint").textContent = "Gekopieerd."; }
    catch { const r = document.createRange(); r.selectNodeContents($("#ct-line")); const s = getSelection(); s.removeAllRanges(); s.addRange(r); $("#ct-hint").textContent = "Geselecteerd. Druk op Ctrl+C om te kopiëren."; }
  };
  dlgContact.showModal();
  // Begin van het bericht in beeld (niet het einde, waar de cursor anders staat)
  const ta = $("#ct-msg"); try { ta.setSelectionRange(0, 0); } catch {} ta.scrollTop = 0;
}

const dlgPhoto = $("#dlg-photo");
let lb = { list: [], i: 0, title: "" };
function showLb() {
  $("#lb-missing").hidden = true; $("#lb-img").hidden = false;
  $("#lb-img").src = photoUrl(lb.list[lb.i], true);
  $("#lb-img").alt = `${lb.title}, foto ${lb.i + 1}`;
  $("#lb-title").textContent = lb.title;
  $("#lb-count").textContent = lb.list.length > 1 ? `Foto ${lb.i + 1} van ${lb.list.length}` : "";
  $("#lb-prev").hidden = $("#lb-next").hidden = lb.list.length < 2;
}
function openLightbox(sellerId, lotId, i) {
  const l = allLots().find((x) => x.id === lotId && x.sellerId === sellerId);
  if (!l) return;
  lb = { list: validPhotos(l), i: Number(i) || 0, title: l.product + (l.ras ? " · " + l.ras : "") };
  if (!lb.list.length) return;
  showLb(); dlgPhoto.showModal();
}
$("#lb-prev").addEventListener("click", () => { lb.i = (lb.i - 1 + lb.list.length) % lb.list.length; showLb(); });
$("#lb-next").addEventListener("click", () => { lb.i = (lb.i + 1) % lb.list.length; showLb(); });
dlgPhoto.addEventListener("keydown", (e) => { if (e.key === "ArrowLeft") $("#lb-prev").click(); if (e.key === "ArrowRight") $("#lb-next").click(); });
dlgPhoto.addEventListener("click", (e) => { if (e.target === dlgPhoto) dlgPhoto.close(); });
$("#form-lot").addEventListener("submit", async (e) => {
  e.preventDefault();
  const val = (id) => $(id).value.trim();
  const qty = intIn(val("#f-qty"));
  const price = decIn(val("#f-price"));
  const minQty = intIn(val("#f-minqty")) || 1;
  const err = !val("#f-product") ? "Vul het product in." : !(qty > 0) ? "Vul een hoeveelheid groter dan 0 in." : !(price >= 0) ? "Vul een vraagprijs in." : !val("#f-until") ? "Kies tot wanneer de partij beschikbaar is." : !val("#f-company") ? "Vul je bedrijfsnaam in." : minQty > qty ? "Minimale afname is groter dan de partij." : "";
  if (err) { $("#lot-err").textContent = err; return; }
  if (S.uploading) { $("#lot-err").textContent = "Wacht tot de foto's zijn geüpload."; return; }
  const company = val("#f-company"), contact = val("#f-phone");
  const photos = S.dlgPhotos.slice(0, 3);
  pref.set("company", company); pref.set("contact", contact);
  const id = S.editing || newId();
  const ok = await saveMyLots((doc) => {
    doc.company = company; doc.contact = contact;
    const prev = doc.items[id] || {};
    const soldQty = Object.values(prev.accepted || {}).reduce((s, a) => s + (a.qty || 0), 0);
    doc.items[id] = {
      ...prev,
      product: val("#f-product"), ras: val("#f-ras"), category: val("#f-cat"), klasse: val("#f-klasse"), origin: val("#f-herkomst"),
      location: val("#f-loc"), qty, unit: val("#f-unit"), minQty, price, until: val("#f-until"), pack: val("#f-pack"), note: val("#f-note"),
      kgPerUnit: val("#f-unit") === "kg" ? 1 : (decIn(val("#f-kg")) > 0 ? Math.round(decIn(val("#f-kg")) * 1000) / 1000 : null),
      company, contact, photos,
      ...(!prev.createdAt && S.wantRef ? { wantRef: S.wantRef } : {}),
      remaining: Math.max(0, qty - soldQty),
      status: prev.status === "ingetrokken" ? "ingetrokken" : (qty - soldQty <= 0 ? "verkocht" : "open"),
      createdAt: prev.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  });
  if (ok) {
    S.lotSaved = true;
    const removed = (S.origPhotos || []).filter((p) => !photos.includes(p));
    if (removed.length) deletePhotos(removed);
    dlgLot.close();
    toast(S.editing ? "Partij bijgewerkt." : S.wantRef ? "Partij gepubliceerd. De koper krijgt bericht dat je kunt leveren." : "Partij gepubliceerd. Kopers zien hem nu in het aanbod.");
  }
});

// ---------- bid dialog ----------
const dlgBid = $("#dlg-bid");
function openBidDialog(lotId, pre = {}) {
  const l = allLots().find((x) => x.id === lotId);
  if (!l) return;
  S.bidLot = l;
  const mine = myBidDoc()?.offers?.[lotId];
  const rem = l.remaining ?? l.qty;
  const sm = bidSummary(lotId), top = sm.n ? { price: sm.top } : null;
  $("#bid-sub").textContent = `${l.product}${l.ras ? " · " + l.ras : ""} — ${num.format(rem)} ${l.unit} van ${l.company}. Vraagprijs ${euro.format(l.price)}${top ? `, hoogste bod ${euro.format(top.price)}` : ""}.`;
  $("#b-price").value = eurOut(pre.price > 0 ? pre.price : mine ? mine.price : l.price);
  $("#b-qty").value = mine ? Math.min(mine.qty, rem) : rem;
  $("#b-qty").min = Math.min(l.minQty || 1, rem); $("#b-qty").max = rem;
  $("#b-qty-hint").textContent = `${l.minQty > 1 ? "Min. " + num.format(Math.min(l.minQty, rem)) + ", " : ""}max. ${num.format(rem)} ${l.unit}`;
  $("#b-note").value = mine?.note || "";
  $("#b-company").value = myBidDoc()?.company || S.user?.company || "";
  $("#b-phone").value = myBidDoc()?.contact || S.user?.contact || "";
  $("#bid-err").textContent = "";
  updateBidSum();
  dlgBid.showModal();
  if (!isTouch()) $("#b-price").focus();
}
function updateBidSum() {
  const l = S.bidLot; if (!l) return;
  const p = decIn($("#b-price").value);
  const q = intIn($("#b-qty").value);
  $("#b-sum").textContent = p >= 0 && q > 0 ? `Totaal ${euro.format(p * q)} voor ${num.format(q)} ${l.unit}${p < l.price ? ` · ${Math.round((1 - p / l.price) * 100)}% onder vraagprijs` : ""}` : "Vul prijs en hoeveelheid in";
}
$("#b-price").addEventListener("input", updateBidSum);
$("#b-qty").addEventListener("input", updateBidSum);
$("#form-bid").addEventListener("submit", async (e) => {
  e.preventDefault();
  const l = S.bidLot; if (!l) return;
  const rem = l.remaining ?? l.qty;
  const price = decIn($("#b-price").value);
  const qty = intIn($("#b-qty").value);
  const min = Math.min(l.minQty || 1, rem);
  const company = $("#b-company").value.trim(), contact = $("#b-phone").value.trim();
  const err = !(price > 0) ? "Vul een prijs in." : !(qty >= min) ? `Bied minimaal ${num.format(min)} ${l.unit}.` : qty > rem ? `Er is nog maar ${num.format(rem)} ${l.unit} beschikbaar.` : !company ? "Vul je bedrijfsnaam in." : "";
  if (err) { $("#bid-err").textContent = err; return; }
  pref.set("company", company); pref.set("contact", contact);
  const ok = await saveMyBids((doc) => {
    doc.company = company; doc.contact = contact;
    doc.offers[l.id] = { sellerId: l.sellerId, product: l.product, price, qty, note: $("#b-note").value.trim(), at: new Date().toISOString() };
  });
  if (ok) { dlgBid.close(); toast(`Bod van ${euro.format(price)} per ${unitSingular(l.unit)} geplaatst.`); }
});

$$("dialog [data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));

// ---------- actions ----------
document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const act = t.dataset.act, lotId = t.dataset.lot, bidder = t.dataset.bidder;
  if (act === "lot-detail") return openLotDetail(t.dataset.seller, lotId);
  if (act === "photo") return openLightbox(t.dataset.seller, lotId, t.dataset.i);
  if (act === "contact") return openContact(t.dataset.seller, lotId);
  if (act === "contact-seller") return openContactSeller(lotId);
  if (act === "bids-filter") { S.bidsFilter = t.dataset.f; try { localStorage.setItem("rpb-bids-filter", S.bidsFilter); } catch {} return renderBids(); }
  if (act === "mine-filter") { S.mineFilter = t.dataset.f; try { localStorage.setItem("rpb-mine-filter", S.mineFilter); } catch {} return renderMine(); }
  if (act === "contact-bidder") return openContactBidder(lotId, bidder);
  if (act === "new") return openLotDialog();
  if (act === "bid") return openBidDialog(lotId);
  if (act === "manage") { if (dlgDetail.open) dlgDetail.close(); return setView("mine"); }
  if (act === "goto-market") return setView("market");
  if (act === "edit") return openLotDialog(lotId);
  if (act === "withdraw" || act === "reopen") {
    let reason = null;
    if (act === "withdraw") {
      const it0 = myLotsDoc()?.items?.[lotId];
      reason = await openReason(`${it0?.product || "Partij"} intrekken`, "Kopers zien de partij daarna niet meer. Waarom trek je hem in?");
      if (!reason) return;
    }
    const ok = await saveMyLots((doc) => {
      const it = doc.items[lotId]; if (!it) return;
      if (act === "withdraw") { it.status = "ingetrokken"; it.withdrawReason = reason; }
      else { it.status = (it.remaining ?? it.qty) > 0 ? "open" : "verkocht"; delete it.withdrawReason; }
    });
    if (ok) toast(act === "withdraw" ? `Partij ingetrokken (${reason.label}). Kopers zien hem niet meer.` : "Partij staat weer in het aanbod.");
    return;
  }
  if (act === "accept" || act === "reject") {
    const b = bidsFor(lotId).find((x) => x.bidderId === bidder);
    if (!b) return;
    let gq = 0;
    const ok = await saveMyLots((doc) => {
      const it = doc.items[lotId]; if (!it) return;
      if (act === "reject") { it.rejected = { ...(it.rejected || {}), [bidder]: { at: new Date().toISOString() } }; return; }
      const rem = it.remaining ?? it.qty;
      gq = Math.min(b.qty, rem);
      it.accepted = { ...(it.accepted || {}), [bidder]: { qty: gq, price: b.price, at: new Date().toISOString() } };
      it.remaining = rem - gq;
      if (it.remaining <= 0) it.status = "verkocht";
    });
    if (ok) toast(act === "reject" ? "Bod afgewezen." : `Gegund: ${num.format(gq)} aan ${b.company || "bieder"}. Neem contact op voor levering en betaling.`);
    return;
  }
  if (act === "retract") {
    const ok = await saveMyBids((doc) => { delete doc.offers[lotId]; });
    if (ok) toast("Bod verwijderd.");
  }
});
$("#btn-new").addEventListener("click", () => (S.view === "wanted" && typeof openWantDialog === "function" ? openWantDialog() : openLotDialog()));
$$(".tab").forEach((t) => t.addEventListener("click", () => setView(t.dataset.view)));
$("#cat-chips").addEventListener("click", (e) => {
  const c = e.target.closest("[data-cat]"); if (!c) return;
  S.cat = c.dataset.cat;
  $$("#cat-chips .chip").forEach((x) => x.setAttribute("aria-pressed", String(x === c)));
  renderMarket();
});
$("#q").addEventListener("input", (e) => { S.q = e.target.value.trim(); renderMarket(); });
$("#sort").addEventListener("change", (e) => { S.sort = e.target.value; renderMarket(); });
$("#show-closed").addEventListener("change", (e) => { S.showClosed = e.target.checked; renderMarket(); });

// Foto die niet (meer) bestaat: geen kapot plaatje, maar een duidelijke melding / lege plek
document.addEventListener("error", (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !/\/api\/photo\//.test(img.src)) return;
  if (img.id === "lb-img") { img.hidden = true; $("#lb-missing").hidden = false; return; }
  const ph = img.closest(".ph");
  if (ph) { ph.classList.add("missing"); img.replaceWith(Object.assign(document.createElement("span"), { className: "ph-missing", textContent: "Foto ontbreekt" })); return; }
  img.classList.add("img-missing"); img.alt = "Foto ontbreekt";
}, true);
