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
      <div><h3 class="prod">${esc(l.product)}</h3>${l.ras ? `<div class="ras">${esc(l.ras)}</div>` : ""}</div>
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
  if (!S.showClosed) lots = lots.filter((l) => !lotState(l).closed);
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
  box.innerHTML = lots.length ? `<div class="grid">${lots.map((l) => lotCard(l)).join("")}</div>`
    : `<div class="notice">Geen partijen gevonden met deze filters.</div>`;
}

function renderMine() {
  const box = $("#mine");
  const doc = myLotsDoc();
  const lots = Object.entries((doc && doc.items) || {}).map(([id, it]) => ({ ...it, id, sellerId: S.me, company: it.company || doc.company, contact: it.contact || doc.contact }))
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  $("#n-mine").textContent = lots.filter((l) => !lotState(l).closed).length;
  if (!lots.length) {
    box.innerHTML = `<div class="empty" style="grid-template-columns:1fr"><div><h2>Je hebt nog niets aangeboden</h2>
      <p>Partijen die je aanbiedt verschijnen hier, met alle biedingen eronder.</p>
      ${S.canWrite !== false && S.me ? `<button class="btn primary" type="button" data-act="new">+ Partij aanbieden</button>` : ""}</div></div>`;
    return;
  }
  box.innerHTML = lots.map((l) => {
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
      const status = acc ? `<span class="pill ok">Gegund ${num.format(acc.qty)}</span>` : rej ? `<span class="pill off">Afgewezen</span>` : st.closed ? `<span class="pill off">Gesloten</span>` : `<span class="pill acc">Open</span>`;
      return `<tr>
        <td>${esc(b.company) || "Onbekend"}${b.contact ? `<div class="sub">${esc(b.contact)}</div>` : ""}${b.note ? `<div class="sub">“${esc(b.note)}”</div>` : ""}</td>
        <td class="num">${euro.format(b.price)}<div class="sub">${b.price >= l.price ? "≥ vraagprijs" : Math.round((1 - b.price / l.price) * 100) + "% onder vraag"}</div></td>
        <td class="num">${num.format(b.qty)} ${esc(l.unit)}</td>
        <td class="num">${euro.format(b.price * Math.min(b.qty, rem || b.qty))}</td>
        <td>${status}</td>
        <td class="num">${canAct ? `<div class="actions" style="justify-content:flex-end"><button class="btn primary small" type="button" data-act="accept" data-lot="${esc(l.id)}" data-bidder="${esc(b.bidderId)}">Accepteren</button><button class="btn small" type="button" data-act="reject" data-lot="${esc(l.id)}" data-bidder="${esc(b.bidderId)}">Afwijzen</button></div>` : ""}</td>
      </tr>`;
    }).join("");
    return `<div class="panel">
      <div class="panel-head">
        <div class="panel-title">${validPhotos(l).length ? `<img class="panel-thumb" src="${photoUrl(validPhotos(l)[0])}" alt="" loading="lazy" data-act="photo" data-seller="${esc(S.me)}" data-lot="${esc(l.id)}" data-i="0">` : ""}<div style="min-width:0"><h3>${esc(l.product)}${l.ras ? ` <span style="font-weight:500;color:var(--muted)">${esc(l.ras)}</span>` : ""}</h3>
          <div class="meta">${num.format(rem)} van ${num.format(l.qty)} ${esc(l.unit)} beschikbaar · vraagprijs ${euro.format(l.price)} · ${soldQty ? `${num.format(soldQty)} gegund · ` : ""}<span class="pill ${st.cls}">${st.label}</span>${l.status === "ingetrokken" && l.withdrawReason ? ` <span class="sub">Reden: ${esc(reasonText(l.withdrawReason))}${l.withdrawReason.by === "beheer" ? " (door beheer)" : ""}</span>` : ""}</div></div></div>
        <div class="actions">
          ${l.status === "ingetrokken" ? `<button class="btn small" type="button" data-act="reopen" data-lot="${esc(l.id)}">Heropenen</button>`
            : st.key !== "sold" ? `<button class="btn small" type="button" data-act="edit" data-lot="${esc(l.id)}">Bewerken</button><button class="btn small" type="button" data-act="withdraw" data-lot="${esc(l.id)}">Intrekken</button>` : ""}
        </div>
      </div>
      ${bids.length ? `<div class="tablewrap"><table class="bids"><thead><tr><th>Bieder</th><th class="num">Prijs</th><th class="num">Hoeveelheid</th><th class="num">Totaal</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
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
    if (!l) status = { label: "Partij verwijderd", cls: "off", open: false };
    else if (l.accepted && l.accepted[S.me]) status = { label: `Gegund: ${num.format(l.accepted[S.me].qty)} ${l.unit}`, cls: "ok", open: false };
    else if (l.rejected && l.rejected[S.me]) status = { label: "Afgewezen", cls: "off", open: false };
    else { const st = lotState(l); status = st.closed ? { label: "Niet gegund", cls: "off", open: false } : { label: "In behandeling", cls: "acc", open: true }; }
    return { lotId, o, l, status };
  }).sort((a, b) => (b.o.at || "").localeCompare(a.o.at || ""));
  $("#n-bids").textContent = items.filter((i) => i.status.open).length;
  if (!items.length) {
    box.innerHTML = `<div class="empty" style="grid-template-columns:1fr"><div><h2>Nog geen biedingen</h2><p>Bied op een partij in het aanbod. Je ziet hier of de verkoper je bod accepteert.</p>
      <button class="btn" type="button" data-act="goto-market">Naar het aanbod</button></div></div>`;
    return;
  }
  box.innerHTML = `<div class="panel"><div class="tablewrap"><table class="bids"><thead><tr><th>Partij</th><th class="num">Jouw bod</th><th class="num">Hoeveelheid</th><th class="num">Totaal</th><th>Status</th><th></th></tr></thead><tbody>
    ${items.map(({ lotId, o, l, status }) => {
      const sm = l ? bidSummary(lotId) : null;
      const top = sm && sm.n ? { price: sm.top } : null;
      const winning = top && o.price >= top.price;
      return `<tr>
        <td><b>${esc(l ? l.product : o.product || "Partij")}</b>${l ? `<div class="sub">${esc(l.company)}${l.contact ? " · " + esc(l.contact) : ""}</div>` : ""}</td>
        <td class="num">${euro.format(o.price)}${status.open && top ? `<div class="sub">${winning ? "Hoogste bod" : "Hoogste: " + euro.format(top.price)}</div>` : ""}</td>
        <td class="num">${num.format(o.qty)} ${esc(l ? l.unit : "")}</td>
        <td class="num">${euro.format(o.price * o.qty)}</td>
        <td><span class="pill ${status.cls}">${status.label}</span></td>
        <td class="num">${status.open ? `<div class="actions" style="justify-content:flex-end"><button class="btn small" type="button" data-act="bid" data-lot="${esc(lotId)}">Wijzigen</button><button class="btn small ghost" type="button" data-act="retract" data-lot="${esc(lotId)}">Intrekken</button></div>`
          : `<button class="btn small ghost" type="button" data-act="retract" data-lot="${esc(lotId)}">Verwijderen</button>`}</td>
      </tr>`;
    }).join("")}</tbody></table></div></div>`;
}

function renderStatus() {
  const el = $("#status");
  if (S.offline && S.token) {
    el.hidden = false;
    el.innerHTML = `<strong>Geen verbinding met de server.</strong> Wat je ziet kan verouderd zijn. De pagina probeert het elke 8 seconden opnieuw.`;
  } else el.hidden = true;
  $("#btn-new").hidden = !(S.me && S.canWrite !== false);
}

function render() {
  renderStatus();
  renderMarket();
  renderMine();
  renderBids();
}

// ---------- view switching ----------
function setView(v) {
  S.view = v;
  $$(".tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.view === v)));
  $("#view-market").hidden = v !== "market";
  $("#view-mine").hidden = v !== "mine";
  $("#view-bids").hidden = v !== "bids";
  $("#view-admin").hidden = v !== "admin";
  $("#view-login").hidden = true;
  if (v === "admin") setAdminPane(S.apane || "dash");
  try { localStorage.setItem("rpb.view", v); } catch {}
}

// ---------- lot dialog ----------
const dlgLot = $("#dlg-lot");
function openLotDialog(lotId) {
  S.editing = lotId || null;
  const doc = myLotsDoc();
  const l = lotId ? doc.items[lotId] : null;
  $("#lot-title").textContent = l ? "Partij bewerken" : "Partij aanbieden";
  $("#lot-submit").textContent = l ? "Opslaan" : "Publiceren";
  const tomorrow = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const v = (id, val) => ($(id).value = val ?? "");
  v("#f-product", l?.product); v("#f-ras", l?.ras); v("#f-cat", l?.category || "Groente"); v("#f-klasse", l?.klasse || "Klasse I");
  v("#f-herkomst", l?.origin || "NL"); v("#f-loc", l?.location); v("#f-qty", l?.qty); v("#f-unit", l?.unit || "colli");
  v("#f-kg", l?.kgPerUnit || ""); $("#f-kg-field").hidden = (l?.unit || "colli") === "kg";
  v("#f-minqty", l?.minQty || ""); v("#f-price", l?.price); v("#f-until", l?.until || tomorrow); v("#f-pack", l?.pack); v("#f-note", l?.note);
  v("#f-company", l?.company || doc?.company || S.user?.company || ""); v("#f-phone", l?.contact || doc?.contact || S.user?.contact || "");
  $("#lot-err").textContent = "";
  S.dlgPhotos = l ? validPhotos(l) : [];
  S.origPhotos = S.dlgPhotos.slice();
  S.newPhotos = [];
  S.lotSaved = false;
  S.uploading = 0;
  renderPhotoEdit();
  dlgLot.showModal();
  $("#f-product").focus();
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
  // Niet opgeslagen: nieuw geüploade foto's weer weggooien
  if (!S.lotSaved && S.newPhotos?.length) deletePhotos(S.newPhotos);
  S.newPhotos = [];
});

// ---------- contact ----------
const dlgContact = $("#dlg-contact");
function parseContact(s) {
  const text = String(s || "").trim();
  const email = (text.match(/[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+/) || [])[0] || "";
  const phoneRaw = (text.replace(email, "").match(/\+?[\d][\d\s\-().]{7,}\d/) || [])[0] || "";
  let digits = phoneRaw.replace(/[^\d+]/g, "");
  let intl = digits.startsWith("+") ? digits.slice(1) : digits.startsWith("00") ? digits.slice(2) : digits.startsWith("0") ? "31" + digits.slice(1) : digits;
  if (intl.length < 9) intl = "";
  return { text, email, phone: phoneRaw.trim(), tel: digits, wa: intl };
}
function openContact(sellerId, lotId) {
  const l = allLots().find((x) => x.id === lotId && x.sellerId === sellerId);
  if (!l) return;
  const c = parseContact(l.contact);
  const rem = l.remaining ?? l.qty;
  $("#ct-sub").textContent = `Over ${l.product}${l.ras ? " · " + l.ras : ""}, ${num.format(rem)} ${l.unit} à ${euro.format(l.price)}.`;
  $("#ct-company").textContent = l.company || "Aanbieder";
  $("#ct-line").textContent = c.text || "Deze aanbieder heeft geen telefoonnummer of e-mailadres ingevuld.";
  const me = S.user ? S.user.name + (S.user.company ? ", " + S.user.company : "") : "";
  $("#ct-msg").value = `Goedendag,\n\nIk heb interesse in uw restpartij ${l.product}${l.ras ? " (" + l.ras + ")" : ""}: ${num.format(rem)} ${l.unit} à ${euro.format(l.price)} per ${unitSingular(l.unit)}, gezien op de Restpartijbeurs. Is de partij nog beschikbaar?\n\nMet vriendelijke groet,\n${me}`;
  const subject = `Restpartij ${l.product}${l.ras ? " " + l.ras : ""}`;
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
    const mail = $("#ct-mail"); if (mail) mail.href = "mailto:" + c.email + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(msg);
  };
  updateLinks();
  $("#ct-msg").oninput = updateLinks;
  const copy = $("#ct-copy");
  if (copy) copy.onclick = async () => {
    const t = `${l.company}\n${c.text}`;
    try { await navigator.clipboard.writeText(t); $("#ct-hint").textContent = "Gekopieerd."; }
    catch { const r = document.createRange(); r.selectNodeContents($("#ct-line")); const s = getSelection(); s.removeAllRanges(); s.addRange(r); $("#ct-hint").textContent = "Geselecteerd. Druk op Ctrl+C om te kopiëren."; }
  };
  dlgContact.showModal();
}

const dlgPhoto = $("#dlg-photo");
let lb = { list: [], i: 0, title: "" };
function showLb() {
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
  const qty = parseInt(val("#f-qty"), 10);
  const price = parseFloat(val("#f-price").replace(",", "."));
  const minQty = parseInt(val("#f-minqty"), 10) || 1;
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
      kgPerUnit: val("#f-unit") === "kg" ? 1 : (parseFloat(val("#f-kg").replace(",", ".")) > 0 ? parseFloat(val("#f-kg").replace(",", ".")) : null),
      company, contact, photos,
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
    toast(S.editing ? "Partij bijgewerkt." : "Partij gepubliceerd. Kopers zien hem nu in het aanbod.");
  }
});

// ---------- bid dialog ----------
const dlgBid = $("#dlg-bid");
function openBidDialog(lotId) {
  const l = allLots().find((x) => x.id === lotId);
  if (!l) return;
  S.bidLot = l;
  const mine = myBidDoc()?.offers?.[lotId];
  const rem = l.remaining ?? l.qty;
  const sm = bidSummary(lotId), top = sm.n ? { price: sm.top } : null;
  $("#bid-sub").textContent = `${l.product}${l.ras ? " · " + l.ras : ""} — ${num.format(rem)} ${l.unit} van ${l.company}. Vraagprijs ${euro.format(l.price)}${top ? `, hoogste bod ${euro.format(top.price)}` : ""}.`;
  $("#b-price").value = mine ? mine.price : l.price;
  $("#b-qty").value = mine ? Math.min(mine.qty, rem) : rem;
  $("#b-qty").min = Math.min(l.minQty || 1, rem); $("#b-qty").max = rem;
  $("#b-qty-hint").textContent = `${l.minQty > 1 ? "Min. " + num.format(Math.min(l.minQty, rem)) + ", " : ""}max. ${num.format(rem)} ${l.unit}`;
  $("#b-note").value = mine?.note || "";
  $("#b-company").value = myBidDoc()?.company || S.user?.company || "";
  $("#b-phone").value = myBidDoc()?.contact || S.user?.contact || "";
  $("#bid-err").textContent = "";
  updateBidSum();
  dlgBid.showModal();
  $("#b-price").focus();
}
function updateBidSum() {
  const l = S.bidLot; if (!l) return;
  const p = parseFloat(String($("#b-price").value).replace(",", "."));
  const q = parseInt($("#b-qty").value, 10);
  $("#b-sum").textContent = p >= 0 && q > 0 ? `Totaal ${euro.format(p * q)} voor ${num.format(q)} ${l.unit}${p < l.price ? ` · ${Math.round((1 - p / l.price) * 100)}% onder vraagprijs` : ""}` : "Vul prijs en hoeveelheid in";
}
$("#b-price").addEventListener("input", updateBidSum);
$("#b-qty").addEventListener("input", updateBidSum);
$("#form-bid").addEventListener("submit", async (e) => {
  e.preventDefault();
  const l = S.bidLot; if (!l) return;
  const rem = l.remaining ?? l.qty;
  const price = parseFloat(String($("#b-price").value).replace(",", "."));
  const qty = parseInt($("#b-qty").value, 10);
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
  if (act === "photo") return openLightbox(t.dataset.seller, lotId, t.dataset.i);
  if (act === "contact") return openContact(t.dataset.seller, lotId);
  if (act === "new") return openLotDialog();
  if (act === "bid") return openBidDialog(lotId);
  if (act === "manage") return setView("mine");
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
$("#btn-new").addEventListener("click", () => openLotDialog());
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
