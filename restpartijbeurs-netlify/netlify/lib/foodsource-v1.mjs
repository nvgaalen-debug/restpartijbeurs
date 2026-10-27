// FoodSource API v1 – ERP-onafhankelijke koppeling
// Elk systeem (Business Central, SAP, Exact, AFAS, een WMS…) praat met dezelfde API:
//   /api/v1/...   met  Authorization: Bearer fs_live_…  (testomgeving: fs_test_…)
// Engelse veldnamen en vaste codes; intern vertalen we naar de Nederlandse velden van de app.
// Alle controles op partijen lopen via dezelfde normalizeLots als de app (gunningen blijven
// onwijzigbaar, hoeveelheid nooit lager dan gegund, enz.).
//
// Dit bestand krijgt de hulpfuncties van api.mjs mee (createV1(deps)), zodat er maar één
// plek is waar partijen worden gecontroleerd en opgeslagen.

import crypto from "node:crypto";
import dns from "node:dns";
import net from "node:net";
import https from "node:https";

export const SCOPES = ["lots:read", "lots:write", "bids:read"];
const MAX_KEYS = 10;
const RATE_PER_MIN = 120;
const MAX_JSON = 64 * 1024;
const EVENT_DAYS = 30;
// Opnieuw proberen na 1, 5, 15 minuten en 1, 3, 6, 12, 24 uur; daarna stoppen
const RETRY_MIN = [1, 5, 15, 60, 180, 360, 720, 1440];
const WEBHOOK_TIMEOUT_MS = 5000;

const CAT = { vegetables: "Groente", fruit: "Fruit", potatoes: "Aardappelen" };
const UNIT = { case: "colli", kg: "kg", pallet: "pallets", crate: "kisten", bag: "zakken" };
const QUAL = { "class-1": "Klasse I", "class-2": "Klasse II", processing: "Industrie / verwerking", "organic-class-1": "Biologisch Klasse I", "organic-class-2": "Biologisch Klasse II" };
const flip = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [v, k]));
const CAT_R = flip(CAT), UNIT_R = flip(UNIT), QUAL_R = flip(QUAL);

// ---------- netwerk (vervangbaar in tests) ----------
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  const x = String(ip).toLowerCase();
  if (x.startsWith("::ffff:")) { const v4 = x.slice(7); return net.isIPv4(v4) ? isPrivateIp(v4) : true; }
  return x === "::" || x === "::1" || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith("ff") || x.startsWith("64:ff9b") || x.startsWith("2001:db8");
}
// Controleert het adres op het moment van verbinden (ook als DNS intussen iets anders zegt)
function safeLookup(host, opts, cb) {
  dns.lookup(host, { ...opts, all: true }, (err, list) => {
    if (err) return cb(err);
    const ok = (list || []).filter((x) => !isPrivateIp(x.address));
    if (!list?.length || ok.length !== list.length) return cb(Object.assign(new Error("Webhook address points to an internal network"), { code: "EBLOCKED" }));
    if (opts && opts.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}
function httpsPost(url, headers, body) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request({
      method: "POST", hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      headers: { ...headers, "content-length": Buffer.byteLength(body) }, lookup: safeLookup, timeout: WEBHOOK_TIMEOUT_MS,
    }, (res) => {
      res.on("data", () => {}); // antwoord negeren; alleen de status telt
      res.on("end", () => resolve({ status: res.statusCode || 0 }));
    });
    const timer = setTimeout(() => req.destroy(new Error("timeout after 5 s")), WEBHOOK_TIMEOUT_MS);
    req.on("timeout", () => req.destroy(new Error("timeout after 5 s")));
    req.on("error", (e) => { clearTimeout(timer); resolve({ status: 0, error: e.message }); });
    req.on("close", () => clearTimeout(timer));
    req.end(body);
  });
}
let transport = {
  lookup: (host) => dns.promises.lookup(host, { all: true }),
  post: httpsPost,
};
export function setWebhookTransport(t) { transport = { ...transport, ...t }; } // voor tests

async function checkWebhookUrl(raw) {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (s.length > 500) throw Object.assign(new Error("Het webhookadres is te lang."), { status: 400 });
  let u;
  try { u = new URL(s); } catch { throw Object.assign(new Error("Dit is geen geldig webadres."), { status: 400 }); }
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  if (u.protocol !== "https:") throw bad("Het webhookadres moet met https:// beginnen.");
  if (u.username || u.password) throw bad("Zet geen gebruikersnaam of wachtwoord in het webhookadres.");
  if (u.port && !["443", "8443"].includes(u.port)) throw bad("Alleen poort 443 of 8443 is toegestaan.");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || /\.(localhost|local|internal|lan|home|corp)$/.test(host) || !host.includes(".") && !net.isIP(host)) throw bad("Interne adressen zijn niet toegestaan.");
  const addrs = net.isIP(host) ? [{ address: host }] : await transport.lookup(host).catch(() => null);
  if (!addrs || !addrs.length) throw bad("Dit adres bestaat niet (DNS geeft geen antwoord).");
  if (addrs.some((x) => isPrivateIp(x.address))) throw bad("Interne netwerkadressen zijn niet toegestaan.");
  return u.toString();
}

// ---------- GS1-controles ----------
function gs1Check(digits) {
  const d = digits.split("").map(Number), last = d.pop();
  let sum = 0;
  d.reverse().forEach((x, i) => { sum += x * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === last;
}
const validGtin = (s) => /^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(s) && gs1Check(s);
const validGln = (s) => /^\d{13}$/.test(s) && gs1Check(s);

export function createV1(d) {
  const { q, readDoc, writeDocAt, normalizeLots, describeLots, getSettings, requireTrade, log, today, validDate, siteUrl, json, MAX_DOC_BYTES, Push, afterLots } = d;
  const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
  const envKey = () => (process.env.APP_ENV === "test" ? "test" : "live");

  // ---------- foutmeldingen: altijd {"error": {"code", "message", "field"}} ----------
  const CODES = { 400: "validation_error", 401: "unauthorized", 402: "subscription_required", 403: "forbidden", 404: "not_found", 405: "method_not_allowed", 409: "conflict", 413: "too_large", 429: "rate_limited" };
  function fail(status, message, field, code) { const e = new Error(message); e.status = status; e.v1 = { code: code || CODES[status] || "error", field: field || null }; return e; }
  const v = (field, message) => fail(400, message, field);

  // ---------- vertalen: intern (app) ↔ API ----------
  function apiStatus(it) {
    if (it.status === "ingetrokken") return "withdrawn";
    if (it.status === "verkocht" || !((it.remaining ?? it.qty) > 0)) return "sold";
    if (it.until && it.until < today()) return "expired";
    return "open";
  }
  const money = (n) => ({ amount: Number(n) || 0, currency: "EUR" });
  function lastChange(it) {
    const t = [it.updatedAt, it.createdAt, it.withdrawReason?.at, ...Object.values(it.accepted || {}).map((a) => a?.at), ...Object.values(it.rejected || {}).map((a) => a?.at)]
      .filter((x) => typeof x === "string" && !isNaN(Date.parse(x))).map((x) => Date.parse(x));
    return t.length ? new Date(Math.max(...t)).toISOString() : null;
  }
  function toApiLot(id, it, base, names = {}, { withAwards = true } = {}) {
    const out = {
      id, externalId: it.externalId || null,
      product: it.product || "", variety: it.ras || null,
      category: CAT_R[it.category] || null, quality: QUAL_R[it.klasse] || null,
      origin: it.origin || null, location: it.location || null, gln: it.gln || null, gtin: it.gtin || null,
      quantity: it.qty, unit: UNIT_R[it.unit] || null, weightPerUnitKg: it.kgPerUnit ?? null, minQuantity: it.minQty ?? null,
      price: money(it.price), availableUntil: it.until || null, packaging: it.pack || null, note: it.note || null,
      status: apiStatus(it), remainingQuantity: it.remaining ?? it.qty,
      photos: (it.photos || []).map((p) => `${base}/api/photo/${p}?s=f`),
      createdAt: it.createdAt || null, updatedAt: lastChange(it),
    };
    if (withAwards) {
      out.awards = Object.entries(it.accepted || {}).map(([buyer, a]) => ({ buyer: { id: buyer, company: names[buyer] || null }, quantity: a.qty, price: money(a.price), awardedAt: a.at || null }));
      out.withdrawal = it.status === "ingetrokken" && it.withdrawReason
        ? { reasonCode: it.withdrawReason.code, note: it.withdrawReason.note || null, at: it.withdrawReason.at || null, byAdministrator: it.withdrawReason.by === "beheer" }
        : null;
    }
    return out;
  }

  // Leest de velden die een koppeling mag zetten. mode: "create" | "replace" | "patch"
  const TEXT = { externalId: 80, product: 80, variety: 80, location: 80, packaging: 120, note: 1000 };
  function fromApi(body, was, mode) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw v(null, "Body must be a JSON object.");
    const has = (k) => body[k] !== undefined;
    const it = mode === "patch" ? { ...was } : {
      // Bij vervangen blijven foto's, gunningen, afwijzingen, intrekken en contact staan
      ...(was ? { photos: was.photos, accepted: was.accepted, rejected: was.rejected, status: was.status, withdrawReason: was.withdrawReason, createdAt: was.createdAt, company: was.company, contact: was.contact } : {}),
    };
    const need = mode !== "patch";
    const text = (k, internal, required) => {
      if (!has(k)) { if (need && required) throw v(k, `${k} is required.`); if (need) it[internal] = ""; return; }
      const x = body[k];
      if (x === null || x === "") { if (required) throw v(k, `${k} is required.`); it[internal] = ""; return; }
      if (typeof x !== "string") throw v(k, `${k} must be a string.`);
      if (x.trim().length > TEXT[k]) throw v(k, `${k} is longer than ${TEXT[k]} characters.`);
      it[internal] = x.trim();
    };
    const choice = (k, internal, map, required, dflt) => {
      if (!has(k)) { if (need) { if (required && !dflt) throw v(k, `${k} is required.`); it[internal] = dflt ? map[dflt] : ""; } return; }
      const x = body[k];
      if ((x === null || x === "") && !required) { it[internal] = dflt ? map[dflt] : ""; return; }
      if (!map[x]) throw v(k, `${k} must be one of: ${Object.keys(map).join(", ")}.`);
      it[internal] = map[x];
    };
    const number = (k, internal, { required, min, max, gt }) => {
      if (!has(k)) { if (need && required) throw v(k, `${k} is required.`); if (need) it[internal] = null; return; }
      const x = body[k];
      if (x === null && !required) { it[internal] = null; return; }
      if (typeof x !== "number" || !Number.isFinite(x)) throw v(k, `${k} must be a number.`);
      if ((gt !== undefined && !(x > gt)) || (min !== undefined && x < min) || x > max) throw v(k, `${k} is out of range.`);
      it[internal] = x;
    };

    if (has("externalId") || need) {
      const x = body.externalId;
      if (x !== undefined && x !== null && x !== "" && (typeof x !== "string" || !/^[A-Za-z0-9._:\-]{1,80}$/.test(x))) throw v("externalId", "externalId may contain letters, digits and . _ : - (max. 80).");
      it.externalId = typeof x === "string" ? x : "";
    }
    text("product", "product", true);
    text("variety", "ras", false);
    choice("category", "category", CAT, true);
    choice("quality", "klasse", QUAL, false, "class-1");
    if (has("origin") || need) {
      const x = body.origin;
      if (x === undefined || x === null || x === "") it.origin = "";
      else if (typeof x !== "string" || !/^[A-Za-z]{2}$/.test(x)) throw v("origin", "origin must be a 2-letter ISO 3166 country code, e.g. NL.");
      else it.origin = x.toUpperCase();
    }
    text("location", "location", false);
    for (const [k, ok, msg] of [["gln", validGln, "gln must be 13 digits with a valid GS1 check digit."], ["gtin", validGtin, "gtin must be 8, 12, 13 or 14 digits with a valid GS1 check digit."]]) {
      if (!has(k)) { if (need) it[k] = ""; continue; }
      const x = body[k];
      if (x === null || x === "") { it[k] = ""; continue; }
      if (typeof x !== "string" || !ok(x)) throw v(k, msg);
      it[k] = x;
    }
    number("quantity", "qty", { required: true, gt: 0, max: 1e7 });
    choice("unit", "unit", UNIT, true);
    number("weightPerUnitKg", "kgPerUnit", { gt: 0, max: 100000 });
    if (it.unit === "kg") it.kgPerUnit = 1;
    number("minQuantity", "minQty", { gt: 0, max: 1e7 });
    // Hele aantallen, behalve bij kg (colli, pallets, kisten en zakken tel je in stuks)
    if (it.unit !== "kg") {
      if ((has("quantity") || has("unit") || need) && !Number.isInteger(it.qty)) throw v("quantity", "quantity must be a whole number unless unit is kg.");
      if ((has("minQuantity") || has("unit") || need) && it.minQty != null && !Number.isInteger(it.minQty)) throw v("minQuantity", "minQuantity must be a whole number unless unit is kg.");
    }
    if (it.minQty && it.qty && it.minQty > it.qty) throw v("minQuantity", "minQuantity cannot be larger than quantity.");
    if (has("price") || need) {
      const p = body.price;
      if (!p || typeof p !== "object" || Array.isArray(p)) throw v("price", "price must be an object: {\"amount\": 6.5, \"currency\": \"EUR\"}.");
      if (p.currency !== undefined && p.currency !== "EUR") throw v("price.currency", "currency must be EUR.");
      if (typeof p.amount !== "number" || !Number.isFinite(p.amount) || p.amount < 0 || p.amount > 1e6) throw v("price.amount", "price.amount must be a number between 0 and 1000000.");
      it.price = Math.round(p.amount * 10000) / 10000;
    }
    if (has("availableUntil") || need) {
      const x = body.availableUntil;
      if (x === undefined || x === null || x === "") it.until = "";
      else if (!validDate(x)) throw v("availableUntil", "availableUntil must be a date YYYY-MM-DD.");
      else it.until = x;
    }
    text("packaging", "pack", false);
    text("note", "note", false);
    // Hoeveelheid nooit lager dan wat al gegund is
    const sold = Object.values(it.accepted || {}).reduce((s, a) => s + (Number(a?.qty) || 0), 0);
    if (sold > 0 && it.qty < sold) throw v("quantity", `quantity cannot be lower than the ${sold} already awarded.`);
    it.updatedAt = new Date().toISOString();
    return it;
  }

  // ---------- namen voor gunningen en gebeurtenissen ----------
  async function companies(ids) {
    const list = [...new Set(ids)].filter(Boolean);
    if (!list.length) return {};
    const r = await q(`SELECT id, name, company, contact FROM rpb_users WHERE id IN (${list.map((_, i) => "$" + (i + 1)).join(",")})`, list);
    const out = {};
    for (const row of r.rows) out[row.id] = row;
    return out;
  }
  const nameMap = (rows) => Object.fromEntries(Object.entries(rows).map(([id, u]) => [id, u.company || u.name]));

  // ---------- gebeurtenissen ----------
  async function wantsEvents(userId) {
    const r = await q(`SELECT u.webhook_url, (SELECT COUNT(*)::int FROM rpb_api_keys k WHERE k.user_id = u.id AND k.revoked_at IS NULL) AS n
      FROM rpb_users u WHERE u.id = $1`, [userId]);
    const row = r.rows[0];
    if (!row) return null;
    return { webhook: !!row.webhook_url, keys: Number(row.n) > 0 };
  }
  async function emit(userId, type, data) {
    const w = await wantsEvents(userId);
    if (!w || (!w.webhook && !w.keys)) return; // geen koppeling: niets bewaren
    const now = new Date();
    await q("INSERT INTO rpb_events (user_id, type, data, created_at, next_attempt_at) VALUES ($1, $2, $3::jsonb, $4, $5)",
      [userId, type, JSON.stringify(data), now, w.webhook ? now : null]);
    if (Math.random() < 0.02) await q("DELETE FROM rpb_events WHERE created_at < $1", [new Date(Date.now() - EVENT_DAYS * 86400000)]);
  }
  // Na het opslaan van partijen (app, API of beheer): nieuwe gunningen melden aan verkoper en koper
  async function emitForLots(seller, prev, next, base) {
    // Vraag en aanbod: kopers met een passende vraag horen het van een nieuwe partij (app én API)
    if (afterLots) { try { await afterLots(seller, prev, next, base); } catch (e) { console.error("match", e); } }
    const a = prev?.items || {}, b = next?.items || {};
    const fresh = [];
    let rejects = false;
    for (const [id, it] of Object.entries(b)) {
      for (const [buyer, acc] of Object.entries(it.accepted || {})) if (!a[id]?.accepted?.[buyer]) fresh.push({ id, it, buyer, acc });
      if (Object.keys(it.rejected || {}).some((x) => !a[id]?.rejected?.[x])) rejects = true;
    }
    if (!fresh.length && !rejects) return;
    const who = await companies([seller.id, ...fresh.map((x) => x.buyer)]);
    const names = nameMap(who);
    // Pushmelding naar de koper (gegund / niet gegund); een fout hier mag de koppelingen niet hinderen
    if (Push) { try { await Push.forLots(seller, prev, next, names, base); } catch (e) { console.error("push", e); } }
    const party = (id) => ({ id, company: who[id]?.company || who[id]?.name || null, contact: who[id]?.contact || null });
    for (const { id, it, buyer, acc } of fresh) {
      const award = { quantity: acc.qty, unit: UNIT_R[it.unit] || null, price: money(acc.price), total: money(Math.round(acc.qty * acc.price * 100) / 100), awardedAt: acc.at };
      await emit(seller.id, "lot.awarded", { role: "seller", lot: toApiLot(id, it, base, names), award: { ...award, buyer: party(buyer) } });
      await emit(buyer, "lot.awarded", { role: "buyer", lot: toApiLot(id, it, base, names, { withAwards: false }), award: { ...award, seller: party(seller.id) } });
    }
  }
  // Na het opslaan van biedingen: nieuw of gewijzigd bod melden aan de verkoper
  async function emitForBids(buyer, prev, next, base) {
    const a = prev?.offers || {}, b = next?.offers || {};
    const changed = Object.entries(b).filter(([lotId, o]) => !a[lotId] || a[lotId].price !== o.price || a[lotId].qty !== o.qty);
    if (!changed.length) return;
    const who = await companies([buyer.id]);
    for (const [lotId, o] of changed) {
      const lot = (await readDoc("lots", o.sellerId)).data?.items?.[lotId];
      if (Push) { try { await Push.forBid(o.sellerId, lotId, lot, o, next.company || who[buyer.id]?.company || who[buyer.id]?.name, !!a[lotId], base); } catch (e) { console.error("push", e); } }
      await emit(o.sellerId, "bid.received", {
        lot: lot ? { id: lotId, externalId: lot.externalId || null, product: lot.product || "", remainingQuantity: lot.remaining ?? lot.qty } : { id: lotId, externalId: null },
        bid: { buyer: { id: buyer.id, company: next.company || who[buyer.id]?.company || null, contact: next.contact || who[buyer.id]?.contact || null }, quantity: o.qty, price: money(o.price), note: o.note || null, placedAt: o.at, updated: !!a[lotId] },
      });
    }
  }

  // ---------- webhooks afleveren ----------
  function signature(secret, t, body) { return crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex"); }
  async function send(url, secret, ev) {
    const body = JSON.stringify({ id: String(ev.id), type: ev.type, createdAt: new Date(ev.created_at).toISOString(), data: ev.data });
    const t = Math.floor(Date.now() / 1000);
    const headers = {
      "content-type": "application/json", "user-agent": "FoodSource-Webhooks/1",
      "foodsource-event": ev.type, "foodsource-delivery": String(ev.id), "foodsource-signature": `t=${t},v1=${signature(secret, t, body)}`,
    };
    try {
      await checkWebhookUrl(url);
      const r = await transport.post(url, headers, body);
      if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status };
      return { ok: false, status: r.status, error: r.error || (r.status >= 300 && r.status < 400 ? `redirect (${r.status}) not followed` : `HTTP ${r.status}`) };
    } catch (e) { return { ok: false, status: 0, error: e.message }; }
  }
  // Pakt berichten die aan de beurt zijn. Eerst "claimen" (2 minuten), zodat twee processen
  // hetzelfde bericht niet tegelijk versturen.
  async function deliverDue(limit = 10) {
    const now = new Date();
    const r = await q(`UPDATE rpb_events SET next_attempt_at = $2 WHERE id IN (
        SELECT id FROM rpb_events WHERE delivered_at IS NULL AND next_attempt_at IS NOT NULL AND next_attempt_at <= $1
        ORDER BY id LIMIT ${Math.max(1, Math.min(50, limit))} FOR UPDATE SKIP LOCKED)
      RETURNING id, user_id, type, data, created_at, attempts`, [now, new Date(now.getTime() + 120000)]);
    let sent = 0;
    for (const ev of r.rows.sort((x, y) => Number(x.id) - Number(y.id))) {
      const u = (await q("SELECT webhook_url, webhook_secret, active FROM rpb_users WHERE id = $1", [ev.user_id])).rows[0];
      if (!u || !u.active || !u.webhook_url || !u.webhook_secret) { await q("UPDATE rpb_events SET next_attempt_at = NULL WHERE id = $1", [ev.id]); continue; }
      const res = await send(u.webhook_url, u.webhook_secret, ev);
      const n = Number(ev.attempts) + 1;
      if (res.ok) { sent++; await q("UPDATE rpb_events SET delivered_at = $2, attempts = $3, last_error = '', next_attempt_at = NULL WHERE id = $1", [ev.id, new Date(), n]); }
      else {
        const wait = RETRY_MIN[n - 1];
        await q("UPDATE rpb_events SET attempts = $2, last_error = $3, next_attempt_at = $4 WHERE id = $1",
          [ev.id, n, String(res.error || "").slice(0, 300), wait ? new Date(Date.now() + wait * 60000) : null]);
      }
    }
    return { picked: r.rows.length, sent };
  }

  // ---------- API-sleutel controleren ----------
  async function keyAuth(req) {
    // Sleutel via "Authorization: Bearer fs_…" of via "X-API-Key: fs_…" (voor omgevingen of proxy's
    // die zelf iets met de Authorization-header doen)
    const h = (req.headers.get("authorization") || "").trim();
    const x = (req.headers.get("x-api-key") || "").trim();
    const m = (x ? ("Bearer " + x) : h).match(/^Bearer (fs_(live|test)_[A-Za-z0-9_-]{32})$/);
    if (!m) throw fail(401, "Missing or malformed API key. Send the header X-API-Key: fs_live_… (or Authorization: Bearer fs_live_…).");
    if (m[2] !== envKey()) throw fail(401, `This is the ${envKey() === "test" ? "test" : "production"} environment; use an fs_${envKey()}_ key.`);
    const r = await q(`SELECT k.id AS key_id, k.name AS key_name, k.prefix AS key_prefix, k.scopes AS key_scopes, u.*
      FROM rpb_api_keys k JOIN rpb_users u ON u.id = k.user_id WHERE k.key_hash = $1 AND k.revoked_at IS NULL`, [sha256(m[1])]);
    const u = r.rows[0];
    if (!u || !u.active || u.pending) throw fail(401, "This API key is not valid (revoked, or the company is deactivated).");
    if (!(await getSettings()).apiEnabled) throw fail(403, "The API is currently switched off by the FoodSource administrator.");
    // 120 verzoeken per minuut per sleutel
    const since = new Date(Date.now() - 60000);
    const c = await q("SELECT COUNT(*)::int AS n FROM rpb_attempts WHERE kind = 'api' AND ip = $1 AND at > $2", [u.key_id, since]);
    if (Number(c.rows[0].n) >= RATE_PER_MIN) { const e = fail(429, `Rate limit: at most ${RATE_PER_MIN} requests per minute per key.`); e.headers = { "retry-after": "60" }; throw e; }
    await q("INSERT INTO rpb_attempts (kind, ip, at) VALUES ('api', $1, $2)", [u.key_id, new Date()]);
    if (Math.random() < 0.02) await q("DELETE FROM rpb_attempts WHERE kind = 'api' AND at < $1", [new Date(Date.now() - 3600000)]);
    await q("UPDATE rpb_api_keys SET last_used_at = $2 WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < $3)", [u.key_id, new Date(), since]);
    u.scopes = String(u.key_scopes || "").split(",").filter((s) => SCOPES.includes(s));
    return u;
  }
  const need = (me, scope) => { if (!me.scopes.includes(scope)) throw fail(403, `This API key lacks the ${scope} permission.`, null, "forbidden"); };

  async function readJson(req) {
    const len = Number(req.headers.get("content-length") || 0);
    if (len > MAX_JSON) throw fail(413, "Request body too large (max 64 KB).");
    const text = await req.text().catch(() => "");
    if (text.length > MAX_JSON) throw fail(413, "Request body too large (max 64 KB).");
    try { const b = JSON.parse(text); if (b && typeof b === "object" && !Array.isArray(b)) return b; } catch {}
    throw v(null, "Body must be a JSON object.");
  }

  function findLot(doc, ref) {
    const items = doc?.items || {};
    if (ref.startsWith("ext:")) {
      const ext = ref.slice(4);
      const hit = Object.entries(items).find(([, it]) => it && it.externalId === ext);
      return hit ? { id: hit[0], it: hit[1] } : null;
    }
    return items[ref] ? { id: ref, it: items[ref] } : null;
  }
  const extTaken = (doc, ext, exceptId) => !!ext && Object.entries(doc?.items || {}).some(([id, it]) => id !== exceptId && it?.externalId === ext);
  const newLotId = () => "L" + crypto.randomBytes(9).toString("hex");

  // Wijziging op de eigen partijen: lezen, aanpassen, controleren (normalizeLots), opslaan op versie.
  async function mutate(me, base, change) {
    await requireTrade(me).catch((e) => { throw e.status === 402 ? fail(402, "A valid FoodSource subscription is required to change lots.") : e; });
    for (let tryNo = 0; tryNo < 3; tryNo++) {
      const cur = await readDoc("lots", me.id);
      const doc = cur.data ? JSON.parse(JSON.stringify(cur.data)) : { company: me.company || "", contact: me.contact || "", items: {} };
      if (!doc.items || typeof doc.items !== "object") doc.items = {};
      const res = change(doc);
      if (res.noop) return { ...res, item: doc.items[res.id] };
      let clean;
      try { ({ out: clean } = await normalizeLots(me, cur.data, doc)); }
      catch (e) { if (e.status) throw fail(e.status === 403 ? 403 : e.status === 409 ? 409 : e.status === 413 ? 413 : 400, e.message, null); throw e; }
      if (Buffer.byteLength(JSON.stringify(clean)) > MAX_DOC_BYTES) throw fail(413, "Too much data for this company. Withdraw or let old lots expire first.");
      const saved = await writeDocAt("lots", me.id, cur, clean, me.id);
      if (!saved) continue; // iemand anders (app of API) was net eerder: opnieuw
      const nr = await q("SELECT id, name, company FROM rpb_users");
      const names = {}; for (const row of nr.rows) names[row.id] = row.company || row.name;
      for (const [kind, detail] of describeLots(cur.data, clean, names).slice(0, 10)) await log(me, kind, `${detail} (via API, sleutel ${me.key_prefix}…)`);
      try { await emitForLots(me, cur.data, clean, base); } catch (e) { console.error("events", e); }
      return { ...res, item: clean.items[res.id], names };
    }
    throw fail(409, "The lots of this company were changed at the same moment. Please retry.");
  }

  // ---------- /api/v1/... ----------
  async function route(req, parts, url) {
    const method = req.method.toUpperCase();
    const me = await keyAuth(req);
    const base = siteUrl(req);
    const [r0, r1, r2, r3] = parts;

    if (r0 === "me" && !r1 && method === "GET") {
      return json(200, {
        company: { id: me.id, name: me.company || me.name, contact: me.contact || null },
        key: { id: me.key_id, name: me.key_name, prefix: me.key_prefix, scopes: me.scopes },
        environment: envKey() === "test" ? "test" : "production", apiVersion: "v1",
      });
    }
    if (r0 === "reason-codes" && !r1 && method === "GET") {
      const codes = (await getSettings()).reasonCodes.filter((x) => x.active);
      return json(200, { data: codes.map((x) => ({ code: x.code, label: x.label, noteRequired: !!x.needsNote })) });
    }
    if (r0 === "events" && !r1 && method === "GET") {
      need(me, "lots:read");
      const afterRaw = url.searchParams.get("after") || "0";
      if (!/^\d{1,18}$/.test(afterRaw)) throw v("after", "after must be an event id (digits only), as returned in next.");
      const after = Number(afterRaw);
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
      const r = await q(`SELECT id, type, data, created_at FROM rpb_events WHERE user_id = $1 AND id > $2 ORDER BY id LIMIT ${limit}`, [me.id, after]);
      const data = r.rows.map((e) => ({ id: String(e.id), type: e.type, createdAt: new Date(e.created_at).toISOString(), data: e.data }));
      return json(200, { data, next: data.length ? data[data.length - 1].id : String(after), hasMore: data.length === limit });
    }

    if (r0 === "lots") {
      // GET /lots
      if (!r1 && method === "GET") {
        need(me, "lots:read");
        const status = url.searchParams.get("status");
        if (status && !["open", "sold", "withdrawn", "expired"].includes(status)) throw v("status", "status must be open, sold, withdrawn or expired.");
        const since = url.searchParams.get("updatedSince");
        if (since && isNaN(Date.parse(since))) throw v("updatedSince", "updatedSince must be an ISO 8601 timestamp.");
        const doc = (await readDoc("lots", me.id)).data;
        const items = Object.entries(doc?.items || {});
        const names = nameMap(await companies(items.flatMap(([, it]) => Object.keys(it?.accepted || {}))));
        let data = items.map(([id, it]) => toApiLot(id, it, base, names));
        if (status) data = data.filter((x) => x.status === status);
        if (since) data = data.filter((x) => x.updatedAt && Date.parse(x.updatedAt) > Date.parse(since));
        // Vaste volgorde (oudste eerst, dan id), zodat een cursor stabiel blijft als er partijen bijkomen
        data.sort((x, y) => String(x.createdAt).localeCompare(String(y.createdAt)) || x.id.localeCompare(y.id));
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw === null ? 100 : Number(limitRaw);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw v("limit", "limit must be a whole number from 1 to 200.");
        const cursor = url.searchParams.get("cursor");
        if (cursor) {
          let pos;
          try { pos = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch {}
          if (!pos || typeof pos.c !== "string" || typeof pos.i !== "string") throw v("cursor", "cursor is not valid; use nextCursor from the previous page.");
          data = data.filter((x) => String(x.createdAt) > pos.c || (String(x.createdAt) === pos.c && x.id > pos.i));
        }
        const page = data.slice(0, limit), hasMore = data.length > limit;
        const last = page[page.length - 1];
        const nextCursor = hasMore ? Buffer.from(JSON.stringify({ c: String(last.createdAt), i: last.id })).toString("base64url") : null;
        return json(200, { data: page, nextCursor, hasMore });
      }
      // POST /lots
      if (!r1 && method === "POST") {
        need(me, "lots:write");
        const body = await readJson(req);
        if (typeof body.externalId !== "string" || !body.externalId) throw v("externalId", "externalId is required for POST /lots, so a retry after a timeout cannot create a second lot. Or use PUT /lots/by-external-id/{externalId}.");
        const it = fromApi(body, null, "create");
        const res = await mutate(me, base, (doc) => {
          if (extTaken(doc, it.externalId)) {
            const hit = findLot(doc, "ext:" + it.externalId);
            throw fail(409, `A lot with externalId "${it.externalId}" already exists (id ${hit.id}). Use PUT /lots/by-external-id/{externalId} to update it.`, "externalId");
          }
          const id = newLotId();
          doc.items[id] = { ...it, createdAt: new Date().toISOString() };
          return { id };
        });
        return json(201, toApiLot(res.id, res.item, base, res.names));
      }
      // PUT /lots/by-external-id/{externalId}  (veilig om te herhalen)
      if (r1 === "by-external-id" && r2 && !r3 && method === "PUT") {
        need(me, "lots:write");
        const ext = decodeURIComponent(r2);
        if (!/^[A-Za-z0-9._:\-]{1,80}$/.test(ext)) throw v("externalId", "externalId may contain letters, digits and . _ : - (max. 80).");
        const body = await readJson(req);
        if (body.externalId !== undefined && body.externalId !== ext) throw v("externalId", "externalId in the body differs from the one in the path.");
        const res = await mutate(me, base, (doc) => {
          const hit = findLot(doc, "ext:" + ext);
          const it = fromApi({ ...body, externalId: ext }, hit?.it || null, "replace");
          const id = hit ? hit.id : newLotId();
          if (!hit) it.createdAt = new Date().toISOString();
          // Niets veranderd? Dan ook niets opslaan (geen nieuwe versie, geen logregel)
          if (hit && sameLot(hit.it, it)) return { id, created: false, noop: true };
          doc.items[id] = it;
          return { id, created: !hit };
        });
        return json(res.created ? 201 : 200, toApiLot(res.id, res.item, base, res.names || nameMap(await companies(Object.keys(res.item.accepted || {})))));
      }
      if (r1 && r1 !== "by-external-id") {
        const ref = decodeURIComponent(r1);
        const notFound = () => fail(404, "Lot not found (or it belongs to another company).");
        // GET /lots/{id}
        if (!r2 && method === "GET") {
          need(me, "lots:read");
          const hit = findLot((await readDoc("lots", me.id)).data, ref);
          if (!hit) throw notFound();
          return json(200, toApiLot(hit.id, hit.it, base, nameMap(await companies(Object.keys(hit.it.accepted || {})))));
        }
        // PATCH /lots/{id}
        if (!r2 && method === "PATCH") {
          need(me, "lots:write");
          const body = await readJson(req);
          for (const k of ["id", "status", "remainingQuantity", "awards", "createdAt", "updatedAt", "photos", "withdrawal"]) if (body[k] !== undefined) throw v(k, `${k} is read-only.`);
          const res = await mutate(me, base, (doc) => {
            const hit = findLot(doc, ref);
            if (!hit) throw notFound();
            // externalId is de vaste sleutel naar het ERP: eenmaal gezet niet meer te wijzigen.
            // Een partij die in de app is gemaakt (zonder externalId) mag er wel één krijgen.
            if (body.externalId !== undefined && hit.it.externalId && body.externalId !== hit.it.externalId) throw v("externalId", "externalId cannot be changed once it is set.");
            if (body.externalId === null || body.externalId === "") { if (hit.it.externalId) throw v("externalId", "externalId cannot be removed once it is set."); }
            const it = fromApi(body, hit.it, "patch");
            if (extTaken(doc, it.externalId, hit.id)) throw fail(409, `Another lot already uses externalId "${it.externalId}".`, "externalId");
            doc.items[hit.id] = it;
            return { id: hit.id };
          });
          return json(200, toApiLot(res.id, res.item, base, res.names));
        }
        // POST /lots/{id}/withdraw
        if (r2 === "withdraw" && !r3 && method === "POST") {
          need(me, "lots:write");
          const body = await readJson(req);
          const codes = (await getSettings()).reasonCodes;
          const code = typeof body.reasonCode === "string" ? body.reasonCode.toUpperCase() : "";
          const rc = codes.find((x) => x.code === code && x.active);
          if (!rc) throw v("reasonCode", `reasonCode must be one of: ${codes.filter((x) => x.active).map((x) => x.code).join(", ")} (see GET /reason-codes).`);
          const note = typeof body.note === "string" ? body.note.trim() : "";
          if (note.length > 300) throw v("note", "note is longer than 300 characters.");
          if (rc.needsNote && !note) throw v("note", `A note is required for reason ${rc.code}.`);
          const res = await mutate(me, base, (doc) => {
            const hit = findLot(doc, ref);
            if (!hit) throw notFound();
            if (hit.it.status === "ingetrokken") return { id: hit.id, noop: true }; // al ingetrokken: niets te doen
            doc.items[hit.id] = { ...hit.it, status: "ingetrokken", withdrawReason: { code: rc.code, note }, updatedAt: new Date().toISOString() };
            return { id: hit.id };
          });
          return json(200, toApiLot(res.id, res.item, base, res.names || nameMap(await companies(Object.keys(res.item.accepted || {})))));
        }
        // GET /lots/{id}/bids
        if (r2 === "bids" && !r3 && method === "GET") {
          need(me, "bids:read");
          const hit = findLot((await readDoc("lots", me.id)).data, ref);
          if (!hit) throw notFound();
          const r = await q("SELECT id, data FROM rpb_docs WHERE collection = 'bids' AND data IS NOT NULL");
          const rows = r.rows.filter((row) => row.data?.offers?.[hit.id]?.sellerId === me.id);
          const who = await companies(rows.map((row) => row.id));
          const data = rows.map((row) => {
            const o = row.data.offers[hit.id];
            return {
              id: `${hit.id}.${row.id}`, buyer: { id: row.id, company: row.data.company || who[row.id]?.company || null, contact: row.data.contact || who[row.id]?.contact || null },
              quantity: o.qty, price: money(o.price), note: o.note || null, placedAt: o.at || null,
              status: hit.it.accepted?.[row.id] ? "awarded" : hit.it.rejected?.[row.id] ? "rejected" : "open",
            };
          }).sort((x, y) => y.price.amount - x.price.amount);
          return json(200, { data });
        }
      }
    }
    if (["me", "reason-codes", "events", "lots"].includes(r0)) throw fail(405, "Method not allowed for this path.");
    throw fail(404, "Unknown API path. See the FoodSource API v1 documentation.");
  }
  // Velden die een koppeling kan zetten vergelijken (voor herhaalde PUT zonder wijziging)
  function sameLot(a, b) {
    const keys = ["externalId", "product", "ras", "category", "klasse", "origin", "location", "gln", "gtin", "qty", "unit", "kgPerUnit", "minQty", "price", "until", "pack", "note"];
    const norm = (x) => (x === undefined || x === null ? "" : x);
    return keys.every((k) => String(norm(a[k])) === String(norm(b[k])));
  }

  async function handle(req, parts, url) {
    // Elk antwoord krijgt een id (van Netlify als die er is): handig bij supportvragen tussen klant, ERP-partner en FoodSource
    const traceId = (req.headers.get("x-nf-request-id") || "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 64) || crypto.randomBytes(10).toString("hex");
    let res;
    try { res = await route(req, parts, url); }
    catch (e) {
      if (!(e && e.status)) { console.error("v1", traceId, e); throw e; }
      const code = e.v1?.code || CODES[e.status] || "error";
      const field = e.v1?.field || null;
      res = json(e.status, { error: { code, message: e.message, field, details: field ? [{ field, message: e.message }] : [], traceId } }, e.headers || {});
    }
    res.headers.set("foodsource-request-id", traceId);
    return res;
  }

  // ---------- Mijn account → API-koppelingen (met de gewone sessie van de app) ----------
  const publicKey = (k) => ({ id: k.id, name: k.name, prefix: k.prefix, scopes: String(k.scopes).split(",").filter(Boolean), createdAt: new Date(k.created_at).toISOString(), lastUsedAt: k.last_used_at ? new Date(k.last_used_at).toISOString() : null });
  const httpErr = (status, message) => Object.assign(new Error(message), { status });
  const str = (x, n) => (typeof x === "string" ? x.trim().slice(0, n) : "");

  async function account(req, me, parts, readBody) {
    const method = req.method.toUpperCase();
    const [a, b, c] = parts;
    const s = await getSettings();
    if (a === "keys" && !b && method === "GET") {
      const r = await q("SELECT * FROM rpb_api_keys WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at", [me.id]);
      const ev = await q("SELECT COUNT(*) FILTER (WHERE delivered_at IS NULL AND next_attempt_at IS NULL AND attempts > 0)::int AS failed, MAX(delivered_at) AS last_ok, MAX(created_at) AS last_event FROM rpb_events WHERE user_id = $1", [me.id]);
      const last = await q("SELECT last_error, attempts FROM rpb_events WHERE user_id = $1 AND delivered_at IS NULL AND attempts > 0 ORDER BY id DESC LIMIT 1", [me.id]);
      const e0 = ev.rows[0] || {};
      return json(200, {
        apiEnabled: s.apiEnabled, environment: envKey(), baseUrl: `${siteUrl(req)}/api/v1`, scopes: SCOPES, maxKeys: MAX_KEYS,
        keys: r.rows.map(publicKey),
        webhook: { url: me.webhook_url || "", hasSecret: !!me.webhook_secret, failed: Number(e0.failed || 0), lastDelivered: e0.last_ok ? new Date(e0.last_ok).toISOString() : null, lastError: last.rows[0]?.last_error || "" },
      });
    }
    if (a === "keys" && !b && method === "POST") {
      if (!s.apiEnabled) throw httpErr(403, "De API staat uit. Vraag de beheerder om hem aan te zetten (Website-instellingen).");
      const body = await readBody(req);
      const name = str(body.name, 60);
      if (!name) throw httpErr(400, "Geef de sleutel een naam, bijvoorbeeld \"Business Central\".");
      const scopes = (Array.isArray(body.scopes) ? body.scopes : []).filter((x) => SCOPES.includes(x));
      if (!scopes.length) throw httpErr(400, "Kies minstens één recht.");
      const n = await q("SELECT COUNT(*)::int AS n FROM rpb_api_keys WHERE user_id = $1 AND revoked_at IS NULL", [me.id]);
      if (Number(n.rows[0].n) >= MAX_KEYS) throw httpErr(409, `Je hebt al ${MAX_KEYS} sleutels. Trek eerst een sleutel in.`);
      const secret = `fs_${envKey()}_` + crypto.randomBytes(24).toString("base64url");
      const row = { id: "k" + crypto.randomBytes(9).toString("hex"), name, prefix: secret.slice(0, 16), scopes: SCOPES.filter((x) => scopes.includes(x)).join(","), created_at: new Date(), last_used_at: null };
      await q("INSERT INTO rpb_api_keys (id, user_id, name, prefix, key_hash, scopes, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [row.id, me.id, row.name, row.prefix, sha256(secret), row.scopes, row.created_at]);
      await log(me, "account", `API-sleutel aangemaakt: ${name} (${row.prefix}…, ${row.scopes})`);
      return json(200, { key: { ...publicKey(row), secret } });
    }
    if (a === "keys" && b && !c && method === "DELETE") {
      const r = await q("SELECT name, prefix FROM rpb_api_keys WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL", [b, me.id]);
      if (r.rows[0]) {
        await q("UPDATE rpb_api_keys SET revoked_at = $2 WHERE id = $1", [b, new Date()]);
        await log(me, "account", `API-sleutel ingetrokken: ${r.rows[0].name} (${r.rows[0].prefix}…)`);
      }
      return json(200, { ok: true });
    }
    if (a === "webhook" && !b && method === "PUT") {
      const body = await readBody(req);
      const raw = str(body.url, 600);
      if (!raw) {
        await q("UPDATE rpb_users SET webhook_url = '' WHERE id = $1", [me.id]);
        await q("UPDATE rpb_events SET next_attempt_at = NULL WHERE user_id = $1 AND delivered_at IS NULL", [me.id]);
        if (me.webhook_url) await log(me, "account", "Webhookadres verwijderd");
        return json(200, { url: "" });
      }
      if (!s.apiEnabled) throw httpErr(403, "De API staat uit. Vraag de beheerder om hem aan te zetten (Website-instellingen).");
      const clean = await checkWebhookUrl(raw);
      const fresh = !me.webhook_secret;
      const secret = fresh ? "whsec_" + crypto.randomBytes(24).toString("base64url") : me.webhook_secret;
      await q("UPDATE rpb_users SET webhook_url = $2, webhook_secret = $3 WHERE id = $1", [me.id, clean, secret]);
      if (clean !== me.webhook_url) await log(me, "account", `Webhookadres ingesteld: ${new URL(clean).host}`);
      return json(200, { url: clean, ...(fresh ? { secret } : {}) });
    }
    if (a === "webhook" && b === "secret" && method === "POST") {
      const secret = "whsec_" + crypto.randomBytes(24).toString("base64url");
      await q("UPDATE rpb_users SET webhook_secret = $2 WHERE id = $1", [me.id, secret]);
      await log(me, "account", "Nieuw webhookgeheim aangemaakt");
      return json(200, { secret });
    }
    if (a === "webhook" && b === "test" && method === "POST") {
      if (!me.webhook_url || !me.webhook_secret) throw httpErr(400, "Stel eerst een webhookadres in.");
      const res = await send(me.webhook_url, me.webhook_secret, { id: "test_" + crypto.randomBytes(6).toString("hex"), type: "ping", created_at: new Date(), data: { message: "Test from FoodSource", company: { id: me.id, name: me.company || me.name } } });
      await log(me, "account", `Testbericht naar webhook: ${res.ok ? "gelukt" : "mislukt (" + res.error + ")"}`);
      return json(200, res);
    }
    if (a === "webhook" && b === "retry" && method === "POST") {
      // Mislukte berichten (gestopt na alle pogingen) nog één reeks geven
      await q("UPDATE rpb_events SET attempts = 0, next_attempt_at = $2 WHERE user_id = $1 AND delivered_at IS NULL AND attempts > 0 AND next_attempt_at IS NULL AND created_at > $3",
        [me.id, new Date(), new Date(Date.now() - EVENT_DAYS * 86400000)]);
      return json(200, { ok: true, ...(await deliverDue(20)) });
    }
    throw httpErr(404, "Onbekend adres.");
  }

  return { handle, account, emitForLots, emitForBids, deliverDue, toApiLot };
}

export const _test = { isPrivateIp, validGtin, validGln, checkWebhookUrl, httpsPost };
