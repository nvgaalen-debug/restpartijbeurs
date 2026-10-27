// Restpartijbeurs – Beheer: statistieken (KPI's en grafieken)
// Volgorde in index.html: core, market, account, admin, payments, stats, start.
// ---------- statistieken ----------
const ST = { period: 90, cat: "", measure: "kg" };
const DAY = 86400000;
const kgNum = new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 0 });
const dec1 = new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const compact = (n) => (Math.abs(n) >= 1e6 ? dec1.format(n / 1e6) + " mln" : kgNum.format(n));
const axisNum = (n) => (Math.abs(n) >= 1e6 ? dec1.format(n / 1e6) + " mln" : Math.abs(n) >= 1000 ? kgNum.format(n / 1000) + "K" : kgNum.format(n));
const eurCompact = (n) => (Math.abs(n) >= 1000 ? "€ " + compact(n) : euro.format(n).replace(/,00$/, ""));
$("#f-unit").addEventListener("change", () => { $("#f-kg-field").hidden = $("#f-unit").value === "kg"; });

// kg per eenheid: ingevuld veld, anders uit de verpakkingstekst ("6 kg doos"), anders onbekend
function kgPerUnit(l) {
  if (l.unit === "kg") return 1;
  if (l.kgPerUnit > 0) return l.kgPerUnit;
  const m = String(l.pack || "").replace(",", ".").match(/(\d+(?:\.\d+)?)\s*(kg|kilo)/i);
  return m ? Number(m[1]) : null;
}
// Wanneer is een advertentie afgesloten, en hoe?
function lotEnd(l) {
  const t = Date.now();
  const accs = Object.values(l.accepted || {});
  const lastAcc = accs.reduce((m, a) => Math.max(m, Date.parse(a.at) || 0), 0);
  const rem = l.remaining ?? l.qty;
  if (l.status === "ingetrokken") return { kind: accs.length ? "deels" : "ingetrokken", at: Date.parse(l.withdrawReason?.at || l.updatedAt) || null };
  if (l.status === "verkocht" || rem <= 0) return { kind: "verkocht", at: lastAcc || Date.parse(l.updatedAt) || null };
  const untilEnd = l.until ? Date.parse(l.until + "T23:59:59") : null;
  if (untilEnd && untilEnd < t) return { kind: accs.length ? "deels" : "verlopen", at: untilEnd };
  return { kind: "open", at: null };
}
// Statistieken: lopende partijen plus het archief (opgeruimde partijen, alleen cijfers)
const statLots = () => allLots().concat(S.archive || []);
async function loadArchive() {
  if (S.archiveBusy || (S.archiveAt && Date.now() - S.archiveAt < 300000)) return;
  S.archiveBusy = true;
  try { S.archive = (await api("admin/archive")).lots || []; S.archiveAt = Date.now(); if (S.archive.length) renderStats(); }
  catch { /* geen archief: dan alleen de lopende partijen */ } finally { S.archiveBusy = false; }
}
function firstBidAt(l) {
  if (l.archived) return Date.parse(l.firstBidAt) || null;
  let m = Infinity;
  for (const b of bidsFor(l.id)) { const x = Date.parse(b.at); if (x && x < m) m = x; }
  for (const a of Object.values(l.accepted || {})) { const x = Date.parse(a.at); if (x && x < m) m = x; }
  return m === Infinity ? null : m;
}
function computeStats(from, to) {
  const lots = statLots().filter((l) => !ST.cat || l.category === ST.cat);
  const sales = [];
  for (const l of lots) {
    const kpu = kgPerUnit(l);
    for (const [bidder, a] of Object.entries(l.accepted || {})) {
      const at = Date.parse(a.at); if (!at || at < from || at >= to) continue;
      sales.push({ at, qty: a.qty || 0, kg: kpu ? (a.qty || 0) * kpu : null, eur: (a.qty || 0) * (a.price || 0), ratio: l.price ? (a.price || 0) / l.price : null, lot: l, bidder });
    }
  }
  const closed = [], created = [], firstBids = [];
  for (const l of lots) {
    const c = Date.parse(l.createdAt);
    if (c >= from && c < to) {
      created.push(l);
      const fb = firstBidAt(l); if (fb && fb >= c) firstBids.push(fb - c);
    }
    const e = lotEnd(l);
    if (e.kind !== "open" && e.at && e.at >= from && e.at < to) closed.push({ l, ...e, dur: c && e.at > c ? e.at - c : null });
  }
  const kgSales = sales.filter((s) => s.kg != null);
  const durs = closed.map((x) => x.dur).filter((d) => d != null);
  const ratios = sales.map((s) => s.ratio).filter((r) => r != null);
  const soldLike = closed.filter((x) => x.kind === "verkocht" || x.kind === "deels").length;
  return {
    sales, closed, created,
    count: sales.length,
    kg: kgSales.reduce((s, x) => s + x.kg, 0), kgMissing: sales.length - kgSales.length,
    eur: sales.reduce((s, x) => s + x.eur, 0),
    avgDur: durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : null,
    avgFirstBid: firstBids.length ? firstBids.reduce((a, b) => a + b, 0) / firstBids.length : null,
    sellRate: closed.length ? soldLike / closed.length : null,
    priceRatio: ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null,
  };
}
const fmtDur = (ms) => {
  if (ms == null) return "—";
  const h = ms / 3600000;
  return h < 48 ? `${kgNum.format(Math.max(1, Math.round(h)))}<small>uur</small>` : `${dec1.format(h / 24)}<small>dagen</small>`;
};
function deltaHtml(cur, prev, { lowerIsBetter = false, pct = false } = {}) {
  if (!ST.period || cur == null || prev == null) return "";
  if (pct) {
    const d = Math.round((cur - prev) * 100);
    if (!d) return `<span class="delta flat">= vorige periode</span>`;
    const good = lowerIsBetter ? d < 0 : d > 0;
    return `<span class="delta ${good ? "up" : "down"}">${d > 0 ? "▲ +" : "▼ "}${d} pt</span><span>vs vorige ${ST.period} dagen</span>`;
  }
  if (!prev) return cur ? `<span class="delta up">▲ nieuw</span><span>vs vorige ${ST.period} dagen</span>` : "";
  const d = Math.round(((cur - prev) / prev) * 100);
  if (!d) return `<span class="delta flat">= vorige periode</span>`;
  const good = lowerIsBetter ? d < 0 : d > 0;
  return `<span class="delta ${good ? "up" : "down"}">${d > 0 ? "▲ +" : "▼ "}${d}%</span><span>vs vorige ${ST.period} dagen</span>`;
}

function renderStats() {
  loadArchive();
  if (S.view !== "admin" || S.apane !== "stats") return;
  const to = Date.now() + 1;
  let from;
  if (ST.period) from = to - ST.period * DAY;
  else { const all = statLots().map((l) => Date.parse(l.createdAt)).filter(Boolean); from = all.length ? Math.min(...all) - DAY : to - 30 * DAY; }
  const cur = computeStats(from, to);
  const prev = ST.period ? computeStats(from - ST.period * DAY, from) : null;
  $("#st-asof").textContent = "Bijgewerkt " + new Date().toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
  const k = (label, value, sub) => `<div class="kpi"><div class="k-label">${label}</div><div class="k-value">${value}</div><div class="k-sub">${sub || "&nbsp;"}</div></div>`;
  $("#st-kpis").innerHTML = [
    k("Aantal verkopen", kgNum.format(cur.count), deltaHtml(cur.count, prev?.count) || "gunningen"),
    k("Verkocht volume", `${compact(cur.kg)}<small>kg</small>`, deltaHtml(cur.kg, prev?.kg) || (cur.kgMissing ? `${cur.kgMissing} zonder gewicht` : "")),
    k("Omzet via gunningen", eurCompact(cur.eur), deltaHtml(cur.eur, prev?.eur)),
    k("Nieuwe advertenties", kgNum.format(cur.created.length), deltaHtml(cur.created.length, prev?.created.length)),
    k("Gemiddelde looptijd", fmtDur(cur.avgDur), deltaHtml(cur.avgDur, prev?.avgDur, { lowerIsBetter: true }) || "van plaatsen tot afsluiten"),
    k("Tijd tot eerste bod", fmtDur(cur.avgFirstBid), deltaHtml(cur.avgFirstBid, prev?.avgFirstBid, { lowerIsBetter: true }) || "gemiddeld"),
    k("Verkoopratio", cur.sellRate == null ? "—" : `${Math.round(cur.sellRate * 100)}<small>%</small>`, deltaHtml(cur.sellRate, prev?.sellRate, { pct: true }) || "afgesloten advertenties met een verkoop"),
    k("Prijs t.o.v. vraagprijs", cur.priceRatio == null ? "—" : `${Math.round(cur.priceRatio * 100)}<small>%</small>`, deltaHtml(cur.priceRatio, prev?.priceRatio, { pct: true }) || "gemiddeld gegund bedrag"),
  ].join("");
  renderTimeChart(cur, from, to);
  const catKg = ["Groente", "Fruit", "Aardappelen"].map((c) => ({ label: c, value: cur.sales.filter((s) => s.lot.category === c && s.kg != null).reduce((a, s) => a + s.kg, 0), color: { Groente: "var(--v-groente)", Fruit: "var(--v-fruit)", Aardappelen: "var(--v-aard)" }[c] }))
    .filter((r) => !ST.cat || r.label === ST.cat);
  hbar($("#ch-cat"), catKg, (v) => `${compact(v)} kg`, "Nog geen verkopen met bekend gewicht in deze periode.");
  const byProd = {};
  for (const s of cur.sales) if (s.kg != null) { const p = (s.lot.product || "Onbekend").trim(); byProd[p] = (byProd[p] || 0) + s.kg; }
  const prods = Object.entries(byProd).sort((a, b) => b[1] - a[1]);
  const top = prods.slice(0, 8).map(([label, value]) => ({ label, value }));
  if (prods.length > 8) top.push({ label: `Overig (${prods.length - 8})`, value: prods.slice(8).reduce((a, x) => a + x[1], 0), muted: true });
  hbar($("#ch-prod"), top, (v) => `${compact(v)} kg`, "Nog geen verkopen met bekend gewicht in deze periode.");
  const ends = { verkocht: "Volledig verkocht", deels: "Deels verkocht", ingetrokken: "Ingetrokken", verlopen: "Verlopen zonder verkoop" };
  hbar($("#ch-end"), Object.entries(ends).map(([key, label]) => ({ label, value: cur.closed.filter((x) => x.kind === key).length })),
    (v) => `${kgNum.format(v)} (${cur.closed.length ? Math.round((v / cur.closed.length) * 100) : 0}%)`, "Nog geen advertenties afgesloten in deze periode.", true);
  const rs = {};
  for (const x of cur.closed) if (x.l.status === "ingetrokken") { const lab = x.l.withdrawReason?.label || "Geen reden"; rs[lab] = (rs[lab] || 0) + 1; }
  hbar($("#ch-reason"), Object.entries(rs).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value })), (v) => kgNum.format(v), "Geen ingetrokken advertenties in deze periode.");
  $("#st-note").textContent = cur.kgMissing ? `${cur.kgMissing} ${cur.kgMissing === 1 ? "verkoop" : "verkopen"} zonder bekend gewicht per eenheid ${cur.kgMissing === 1 ? "telt" : "tellen"} niet mee in de kg-cijfers. Vul bij die partijen "Gewicht per eenheid" in.` : "";
}

// Kolommen per week of maand, met hover
function renderTimeChart(cur, from, to) {
  const el = $("#ch-time"), m = ST.measure;
  const monthly = !ST.period || ST.period > 120;
  const startOf = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); if (monthly) d.setDate(1); else d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; };
  const buckets = [];
  for (let d = startOf(from); d.getTime() < to; monthly ? d.setMonth(d.getMonth() + 1) : d.setDate(d.getDate() + 7)) buckets.push({ start: new Date(d), count: 0, kg: 0, eur: 0 });
  for (const s of cur.sales) {
    const st = startOf(s.at).getTime();
    const bkt = buckets.find((b) => b.start.getTime() === st); if (!bkt) continue;
    bkt.count++; bkt.eur += s.eur; if (s.kg != null) bkt.kg += s.kg;
  }
  const label = (d) => monthly ? d.toLocaleDateString("nl-NL", { month: "short", year: "2-digit" }).replace(".", "") : d.toLocaleDateString("nl-NL", { day: "numeric", month: "short" }).replace(".", "");
  $("#ch-time-sub").textContent = `${monthly ? "per maand" : "per week"} · ${{ count: "aantal gunningen", kg: "kg gegund", eur: "gegunde waarde in euro" }[m]}`;
  const fmtV = (v) => (m === "eur" ? eurCompact(v) : m === "kg" ? `${compact(v)} kg` : kgNum.format(v));
  const W = Math.max(320, Math.round(el.clientWidth - 28) || 680), H = 240, L = 46, R = 8, T = 12, B = 28;
  const max = Math.max(0, ...buckets.map((b) => b[m]));
  if (!cur.sales.length) { el.innerHTML = `<div class="empty-chart">Nog geen verkopen in deze periode.</div>`; return; }
  const step = niceStep(max / 4), top = Math.max(step, Math.ceil(max / step) * step);
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const bw = (W - L - R) / buckets.length, barW = Math.min(24, Math.max(4, bw * 0.6));
  const ticks = []; for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
  const every = Math.ceil(buckets.length / Math.floor((W - L - R) / 56));
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Verkopen ${monthly ? "per maand" : "per week"}">`;
  for (const v of ticks) svg += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${v ? "var(--v-grid)" : "var(--v-axis)"}" stroke-width="1"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11.5" fill="var(--v-muted)">${m === "eur" ? "€ " + axisNum(v) : axisNum(v)}</text>`;
  buckets.forEach((b, i) => {
    const cx = L + bw * i + bw / 2, h = H - B - y(b[m]), x0 = cx - barW / 2, y0 = y(b[m]), r = Math.min(4, h, barW / 2);
    if (b[m] > 0) svg += `<path d="M${x0} ${H - B}V${y0 + r}Q${x0} ${y0} ${x0 + r} ${y0}H${x0 + barW - r}Q${x0 + barW} ${y0} ${x0 + barW} ${y0 + r}V${H - B}Z" fill="var(--v-1)"/>`;
    if (i % every === 0) svg += `<text x="${cx}" y="${H - 8}" text-anchor="middle" font-size="11.5" fill="var(--v-muted)">${label(b.start)}</text>`;
    svg += `<rect class="hit" data-i="${i}" x="${L + bw * i}" y="${T}" width="${bw}" height="${H - T - B}" fill="transparent"/>`;
  });
  svg += `</svg><div class="tip" hidden></div>`;
  el.innerHTML = svg;
  const tip = el.querySelector(".tip"), svgEl = el.querySelector("svg");
  svgEl.addEventListener("mousemove", (e) => {
    const hit = e.target.closest(".hit"); if (!hit) { tip.hidden = true; return; }
    const b = buckets[Number(hit.dataset.i)];
    const end = new Date(b.start); monthly ? end.setMonth(end.getMonth() + 1) : end.setDate(end.getDate() + 7); end.setDate(end.getDate() - 1);
    tip.innerHTML = `<b>${monthly ? b.start.toLocaleDateString("nl-NL", { month: "long", year: "numeric" }) : `${label(b.start)} – ${label(end)}`}</b><br>${kgNum.format(b.count)} verkopen · ${compact(b.kg)} kg · ${eurCompact(b.eur)}`;
    const rect = svgEl.getBoundingClientRect(), sx = rect.width / W;
    tip.style.left = `${14 + (Number(hit.getAttribute("x")) + bw / 2) * sx}px`; tip.style.top = `${8 + y(b[m]) * sx}px`; tip.hidden = false;
  });
  svgEl.addEventListener("mouseleave", () => (tip.hidden = true));
}
function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}
// Horizontale balken met waarde aan het eind
function hbar(el, rows, fmt, emptyText, keepZero) {
  const data = keepZero ? rows : rows.filter((r) => r.value > 0);
  if (!data.length || !data.some((r) => r.value > 0)) { el.innerHTML = `<div class="empty-chart">${emptyText}</div>`; return; }
  const W = Math.max(300, Math.round(el.clientWidth - 28) || 420), rowH = 30, valW = 92, H = data.length * rowH + 4;
  const longest = Math.max(...data.map((r) => r.label.length));
  const labelW = Math.min(Math.round(W * 0.42), Math.max(80, longest * 7.4 + 12));
  const maxChars = Math.floor((labelW - 12) / 7.4);
  const max = Math.max(...data.map((r) => r.value)), bar = 16;
  const x = (v) => (W - labelW - valW) * (v / max);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
  data.forEach((r, i) => {
    const cy = i * rowH + rowH / 2, w = Math.max(r.value > 0 ? 3 : 0, x(r.value)), y0 = cy - bar / 2, rr = Math.min(4, w);
    const lab = r.label.length > maxChars ? r.label.slice(0, maxChars - 1) + "…" : r.label;
    svg += `<text x="0" y="${cy + 4}" font-size="13" fill="var(--ink)">${esc(lab)}<title>${esc(r.label)}</title></text>`;
    if (w > 0) svg += `<path d="M${labelW} ${y0}H${labelW + w - rr}Q${labelW + w} ${y0} ${labelW + w} ${y0 + rr}V${y0 + bar - rr}Q${labelW + w} ${y0 + bar} ${labelW + w - rr} ${y0 + bar}H${labelW}Z" fill="${r.muted ? "var(--v-axis)" : r.color || "var(--v-1)"}"/>`;
    svg += `<text x="${labelW + w + 8}" y="${cy + 4}" font-size="12.5" fill="var(--muted)" style="font-variant-numeric:tabular-nums">${fmt(r.value)}</text>`;
  });
  svg += `<line x1="${labelW}" x2="${labelW}" y1="0" y2="${H}" stroke="var(--v-axis)" stroke-width="1"/></svg>`;
  el.innerHTML = svg;
}
$("#st-period").addEventListener("click", (e) => {
  const c = e.target.closest("[data-p]"); if (!c) return;
  ST.period = Number(c.dataset.p);
  $$("#st-period .chip").forEach((x) => x.setAttribute("aria-pressed", String(x === c)));
  renderStats();
});
$("#st-cat").addEventListener("change", (e) => { ST.cat = e.target.value; renderStats(); });
$("#ch-time-measure").addEventListener("click", (e) => {
  const b = e.target.closest("[data-m]"); if (!b) return;
  ST.measure = b.dataset.m;
  $$("#ch-time-measure button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  renderStats();
});
let stResize; window.addEventListener("resize", () => { clearTimeout(stResize); stResize = setTimeout(renderStats, 150); });
