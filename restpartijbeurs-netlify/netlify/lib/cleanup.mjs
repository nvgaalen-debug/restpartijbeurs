// Opschonen van afgesloten partijen (verkocht, ingetrokken of verlopen) – één keer per nacht
// 1. Foto's na X dagen weg (Beheer → Instellingen → Opschonen; standaard 30, 0 = nooit). De partij blijft.
// 2. Partijen na Y dagen helemaal weg (standaard nooit). Eerst gaat een klein regeltje met de cijfers naar het
//    archief (rpb_archive), zodat statistieken en de CSV-export blijven kloppen. Biedingen op die partij gaan mee weg.
// 3. Gesloten of verlopen vragen na 90 dagen weg.
// Een document dat iemand op hetzelfde moment wijzigt, slaan we over; de volgende nacht lukt het dan.

export const WANT_DAYS = 90;

// Wanneer is een partij afgesloten? JJJJ-MM-DD, of null als hij nog loopt.
export function closedOn(it, today) {
  const accs = Object.values(it.accepted || {});
  const d = (x) => (typeof x === "string" && !isNaN(Date.parse(x)) ? new Date(x).toISOString().slice(0, 10) : null);
  if (it.status === "ingetrokken") return d(it.withdrawReason?.at) || d(it.updatedAt) || today;
  if (it.status === "verkocht" || !((it.remaining ?? it.qty) > 0)) return accs.map((a) => d(a?.at)).filter(Boolean).sort().pop() || d(it.updatedAt) || today;
  if (it.until && it.until < today) return it.until;
  return null;
}
const ageDays = (from, to) => Math.floor((Date.parse(to + "T12:00:00Z") - Date.parse(from + "T12:00:00Z")) / 86400000);

// Alleen de cijfers: geen foto's, notities, contactgegevens of biedingen
function summary(sellerId, lotId, it, company, firstBidAt, closed) {
  return {
    id: lotId, sellerId, company: company || "", product: it.product || "", ras: it.ras || "", category: it.category || "", klasse: it.klasse || "",
    origin: it.origin || "", location: it.location || "", qty: it.qty, unit: it.unit, kgPerUnit: it.kgPerUnit ?? null, pack: it.pack || "",
    price: it.price, remaining: it.remaining ?? it.qty, status: it.status, until: it.until || "", createdAt: it.createdAt || null, updatedAt: it.updatedAt || null,
    accepted: it.accepted || {}, withdrawReason: it.withdrawReason ? { code: it.withdrawReason.code, label: it.withdrawReason.label, by: it.withdrawReason.by || "", at: it.withdrawReason.at || null } : null,
    externalId: it.externalId || "", firstBidAt: firstBidAt || null, closedOn: closed, archived: true,
  };
}

export function createCleanup({ q, readDoc, writeDocAt, log, today, getSettings }) {
  const inList = (ids, from = 2) => ids.map((_, i) => "$" + (i + from)).join(",");

  async function run({ force = false } = {}) {
    const s = await getSettings(), t = today();
    const photoDays = s.cleanupPhotoDays, lotDays = s.cleanupLotDays;
    const out = { photos: 0, photoLots: 0, archived: 0, bids: 0, wants: 0, skipped: 0 };
    const lotDocs = (await q("SELECT id FROM rpb_docs WHERE collection = 'lots' AND data IS NOT NULL")).rows.map((r) => r.id);
    let bidRows = null; // alleen ophalen als er partijen naar het archief gaan
    const removed = new Map(); // verkoper → Set(partij-id)
    for (const sellerId of lotDocs) {
      const cur = await readDoc("lots", sellerId);
      const data = cur.data; if (!data?.items) continue;
      const photos = [], gone = [];
      let touched = 0, photoLots = 0;
      for (const [id, it] of Object.entries(data.items)) {
        const c = closedOn(it, t); if (!c) continue;
        const age = ageDays(c, t);
        if (lotDays > 0 && age >= lotDays) {
          if (!bidRows) bidRows = (await q("SELECT id, data FROM rpb_docs WHERE collection = 'bids' AND data IS NOT NULL")).rows;
          let first = null;
          for (const r of bidRows) { const o = r.data?.offers?.[id]; if (o && o.sellerId === sellerId && o.at && (!first || o.at < first)) first = o.at; }
          for (const a of Object.values(it.accepted || {})) if (a?.at && (!first || a.at < first)) first = a.at;
          await q("INSERT INTO rpb_archive (id, seller_id, closed_on, archived_at, data) VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (id) DO NOTHING",
            [`${sellerId}:${id}`, sellerId, c, new Date(), JSON.stringify(summary(sellerId, id, it, it.company || data.company, first, c))]);
          photos.push(...(it.photos || [])); gone.push(id); delete data.items[id]; touched++;
        } else if (photoDays > 0 && age >= photoDays && (it.photos || []).length) {
          photos.push(...it.photos); it.photos = []; it.photosRemovedOn = t; touched++; photoLots++;
        }
      }
      if (!touched) continue;
      const saved = await writeDocAt("lots", sellerId, cur, data, "opschonen");
      if (!saved) { out.skipped++; continue; }
      out.photoLots += photoLots;
      if (gone.length) { out.archived += gone.length; removed.set(sellerId, new Set(gone)); }
      if (photos.length) {
        const r = await q(`DELETE FROM rpb_photos WHERE owner = $1 AND id IN (${inList(photos)})`, [sellerId, ...photos]);
        out.photos += r.rowCount ?? photos.length;
      }
    }
    // Biedingen op gearchiveerde partijen opruimen (de koper ziet anders "Partij verwijderd")
    if (removed.size) {
      for (const r of (await q("SELECT id FROM rpb_docs WHERE collection = 'bids' AND data IS NOT NULL")).rows) {
        const cur = await readDoc("bids", r.id); const offers = cur.data?.offers || {};
        const drop = Object.entries(offers).filter(([lotId, o]) => removed.get(o?.sellerId)?.has(lotId)).map(([k]) => k);
        if (!drop.length) continue;
        for (const k of drop) delete offers[k];
        if (await writeDocAt("bids", r.id, cur, cur.data, "opschonen")) out.bids += drop.length; else out.skipped++;
      }
    }
    // Gesloten of verlopen vragen na 90 dagen
    for (const r of (await q("SELECT id FROM rpb_docs WHERE collection = 'wants' AND data IS NOT NULL")).rows) {
      const cur = await readDoc("wants", r.id); const items = cur.data?.items || {};
      const drop = Object.entries(items).filter(([, w]) => {
        const end = w.status === "gesloten" ? (w.closedAt || w.updatedAt || "").slice(0, 10) : w.until && w.until < t ? w.until : null;
        return end && ageDays(end, t) >= WANT_DAYS;
      }).map(([k]) => k);
      if (!drop.length) continue;
      for (const k of drop) delete items[k];
      if (await writeDocAt("wants", r.id, cur, cur.data, "opschonen")) out.wants += drop.length; else out.skipped++;
    }
    if (out.photos || out.archived || out.wants || force) {
      await log(null, "beheer", `Opgeschoond${force ? " (met de hand)" : ""}: ${out.photos} foto's van ${out.photoLots} afgesloten partijen, ${out.archived} partijen naar het archief${out.bids ? ` (met ${out.bids} biedingen)` : ""}, ${out.wants} oude vragen${out.skipped ? `; ${out.skipped} overgeslagen (werd net gewijzigd)` : ""}`);
    }
    return out;
  }

  // Eén keer per dag, na 3:00 Nederlandse tijd (aangeroepen door de geplande functie van elke 5 minuten)
  async function daily(hour) {
    if (hour < 3) return null;
    const t = today();
    const r = await q("INSERT INTO rpb_settings (key, value) VALUES ('_cleanup', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value WHERE rpb_settings.value <> EXCLUDED.value RETURNING key", [t]);
    if (!r.rows.length) return null; // vandaag al gedaan (of een andere functie is ermee bezig)
    return run();
  }

  // Hoeveel ruimte nemen foto's in, en wat valt er op te ruimen?
  async function storage() {
    const t = today(), s = await getSettings();
    const p = (await q("SELECT COUNT(*)::int AS n, COALESCE(SUM(LENGTH(thumb) + LENGTH(full_img)), 0)::bigint AS bytes FROM rpb_photos")).rows[0];
    const a = (await q("SELECT COUNT(*)::int AS n FROM rpb_archive")).rows[0];
    let closed = 0, closedPhotos = 0, due = 0;
    for (const r of (await q("SELECT data FROM rpb_docs WHERE collection = 'lots' AND data IS NOT NULL")).rows) {
      for (const it of Object.values(r.data?.items || {})) {
        const c = closedOn(it, t); if (!c) continue;
        closed++; const n = (it.photos || []).length; closedPhotos += n;
        if (s.cleanupPhotoDays > 0 && n && ageDays(c, t) >= s.cleanupPhotoDays) due += n;
      }
    }
    // base64 in de database: ~3/4 daarvan is het echte bestand
    return { photos: Number(p.n), mb: Math.round(Number(p.bytes) * 0.75 / 1048576 * 10) / 10, archived: Number(a.n), closedLots: closed, closedPhotos, photosDue: due };
  }

  async function archive() {
    return (await q("SELECT data FROM rpb_archive ORDER BY closed_on")).rows.map((r) => r.data);
  }
  return { run, daily, storage, archive };
}

// ---------- CSV: alle partijen (actief en archief), één regel per partij ----------
const csvCell = (v) => {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // geen formules in Excel
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const nl = (n) => (typeof n === "number" && isFinite(n) ? String(Math.round(n * 100) / 100).replace(".", ",") : "");
export function lotsCsv(rows, names, today) {
  const head = ["Bron", "Aangeboden op", "Afgesloten op", "Status", "Aanbieder", "Product", "Ras", "Categorie", "Klasse", "Herkomst", "Afhalen", "Hoeveelheid", "Eenheid", "Kg per eenheid", "Vraagprijs", "Gegund aan", "Gegunde hoeveelheid", "Gegunde waarde", "Reden intrekken", "ERP-nummer"];
  const lines = [head.join(";")];
  for (const l of rows) {
    const accs = Object.entries(l.accepted || {});
    const st = l.status === "ingetrokken" ? "ingetrokken" : l.status === "verkocht" || !((l.remaining ?? l.qty) > 0) ? "verkocht" : l.until && l.until < today ? "verlopen" : "open";
    lines.push([
      l.archived ? "archief" : "actief", (l.createdAt || "").slice(0, 10), l.closedOn || closedOn(l, today) || "", st,
      l.company || names[l.sellerId] || "", l.product, l.ras, l.category, l.klasse, l.origin, l.location,
      nl(l.qty), l.unit, nl(l.kgPerUnit), nl(l.price),
      accs.map(([b, a]) => `${names[b] || b} (${nl(a.qty)} à ${nl(a.price)})`).join(", "),
      nl(accs.reduce((s, [, a]) => s + (Number(a.qty) || 0), 0)), nl(accs.reduce((s, [, a]) => s + (Number(a.qty) || 0) * (Number(a.price) || 0), 0)),
      l.withdrawReason ? `${l.withdrawReason.code} ${l.withdrawReason.label}` : "", l.externalId,
    ].map(csvCell).join(";"));
  }
  return "﻿" + lines.join("\r\n") + "\r\n"; // BOM: Excel leest dan de euro's en accenten goed
}
