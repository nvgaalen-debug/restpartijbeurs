// Restpartijbeurs – API op Netlify
// Eén functie op /api/*. Praat met PostgreSQL (Aiven) en controleert bij elke
// wijziging wie er ingelogd is. De browser praat nooit zelf met de database.
//
// Omgevingsvariabelen (Netlify → Site configuration → Environment variables):
//   DATABASE_URL     Service URI van Aiven (postgres://...)          verplicht
//   RPB_SETUP_CODE   Code om de eerste beheerder aan te maken         verplicht bij eerste start
//   PG_SSL_CA        CA-certificaat van Aiven (aanbevolen)
//   PG_SSL_INSECURE  "true" = certificaat niet controleren (verbinding blijft versleuteld)

import pg from "pg";
import crypto from "node:crypto";

export const config = { path: "/api/*" };

const COLLECTIONS = new Set(["lots", "bids"]);
const MAX_DOC_BYTES = 256 * 1024;
const MAX_FULL_BYTES = 450 * 1024;   // grote foto, na verkleinen in de browser
const MAX_THUMB_BYTES = 60 * 1024;   // miniatuur
const MAX_PHOTOS_PER_USER = 300;
const SESSION_DAYS = 30;
const MAX_FAILED = 5;
const LOCK_MINUTES = 2;

// ---------- database ----------
let pool = null;
let schemaReady = null;

export function setPool(p) { pool = p; schemaReady = null; } // voor tests

function getPool() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL || process.env.DATABASE_KEY;
  if (!url) throw httpError(500, "DATABASE_URL ontbreekt in Netlify.");
  let ssl;
  if (process.env.PG_SSL_CA) ssl = { ca: process.env.PG_SSL_CA, rejectUnauthorized: true };
  else if (process.env.PG_SSL_INSECURE === "true") ssl = { rejectUnauthorized: false };
  else ssl = { rejectUnauthorized: true };
  // sslmode uit de URL halen, anders overschrijft pg onze ssl-instelling
  const clean = url.replace(/([?&])sslmode=[^&]*&?/, "$1").replace(/[?&]$/, "");
  pool = new pg.Pool({ connectionString: clean, ssl, max: 3, idleTimeoutMillis: 10000 });
  return pool;
}

async function q(text, params = []) {
  return getPool().query(text, params);
}

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await q(`CREATE TABLE IF NOT EXISTS rpb_users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL UNIQUE,
        company TEXT NOT NULL DEFAULT '',
        contact TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT 'handelaar',
        active BOOLEAN NOT NULL DEFAULT TRUE,
        salt TEXT NOT NULL,
        hash TEXT NOT NULL,
        failed INTEGER NOT NULL DEFAULT 0,
        locked_until TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL
      )`);
      // Kolommen voor aanmelden (toegevoegd in een latere versie)
      await q("ALTER TABLE rpb_users ADD COLUMN IF NOT EXISTS pending BOOLEAN NOT NULL DEFAULT FALSE");
      await q("ALTER TABLE rpb_users ADD COLUMN IF NOT EXISTS kvk TEXT NOT NULL DEFAULT ''");
      await q("ALTER TABLE rpb_users ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT ''");
      await q("ALTER TABLE rpb_users ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT ''");
      await q(`CREATE TABLE IF NOT EXISTS rpb_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      )`);
      await q(`CREATE TABLE IF NOT EXISTS rpb_docs (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        data JSONB,
        updated_at TIMESTAMPTZ NOT NULL,
        updated_by TEXT NOT NULL,
        PRIMARY KEY (collection, id)
      )`);
      await q(`CREATE TABLE IF NOT EXISTS rpb_payments (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        paid_on DATE NOT NULL,
        valid_until DATE NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      )`);
      await q("ALTER TABLE rpb_payments ADD COLUMN IF NOT EXISTS mollie_id TEXT");
      await q("CREATE UNIQUE INDEX IF NOT EXISTS rpb_payments_mollie ON rpb_payments (mollie_id) WHERE mollie_id IS NOT NULL");
      await q(`CREATE TABLE IF NOT EXISTS rpb_mollie (
        ref TEXT PRIMARY KEY,
        mollie_id TEXT,
        user_id TEXT NOT NULL,
        amount_excl INTEGER NOT NULL,
        amount_incl INTEGER NOT NULL,
        status TEXT NOT NULL,
        method TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )`);
      await q(`CREATE TABLE IF NOT EXISTS rpb_log (
        id BIGSERIAL PRIMARY KEY,
        at TIMESTAMPTZ NOT NULL,
        user_id TEXT NOT NULL DEFAULT '',
        user_name TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL,
        detail TEXT NOT NULL
      )`);
      await q(`CREATE TABLE IF NOT EXISTS rpb_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`);
      await q(`CREATE TABLE IF NOT EXISTS rpb_photos (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        mime TEXT NOT NULL,
        thumb TEXT NOT NULL,
        full_img TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      )`);
    })().catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

// ---------- helpers ----------
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function readBody(req) {
  try { const b = await req.json(); return b && typeof b === "object" ? b : {}; }
  catch { return {}; }
}

const str = (v, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const nameKey = (n) => n.toLowerCase().replace(/\s+/g, " ").trim();
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const newId = (prefix) => prefix + crypto.randomBytes(9).toString("hex");

function hashCode(code, salt) {
  return crypto.scryptSync(code, salt, 32).toString("hex");
}
function checkCode(code, salt, hash) {
  const a = Buffer.from(hashCode(code, salt), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function validCode(code) {
  if (typeof code !== "string" || code.length < 4) throw httpError(400, "De code moet minstens 4 tekens hebben.");
  if (code.length > 100) throw httpError(400, "De code is te lang.");
  return code;
}

function publicUser(u) {
  return {
    id: u.id, name: u.name, company: u.company, contact: u.contact, role: u.role, active: u.active,
    pending: !!u.pending, kvk: u.kvk || "", email: u.email || "", note: u.note || "",
    createdAt: u.created_at ? new Date(u.created_at).toISOString() : null,
    ...(u.paid_until !== undefined ? { paidUntil: u.paid_until || null, paidTotal: Number(u.paid_total || 0) / 100 } : {}),
  };
}

// ---------- logboek ----------
const LOG_KEEP = 5000;
async function log(user, kind, detail) {
  try {
    await q("INSERT INTO rpb_log (at, user_id, user_name, kind, detail) VALUES ($1, $2, $3, $4, $5)",
      [new Date(), user?.id || "", user ? (user.name + (user.company ? " (" + user.company + ")" : "")) : "", kind, String(detail).slice(0, 500)]);
    if (Math.random() < 0.02) {
      await q(`DELETE FROM rpb_log WHERE id < (SELECT id FROM rpb_log ORDER BY id DESC OFFSET ${LOG_KEEP} LIMIT 1)`);
    }
  } catch (e) { console.error("log", e); }
}
const euro = (n) => "€ " + Number(n || 0).toFixed(2).replace(".", ",");

// ---------- instellingen ----------
const SETTING_DEFAULTS = {
  siteName: "Restpartijbeurs",
  welcomeText: "",
  announcement: "",
  registrationOpen: "true",
  subscriptionPrice: "12000",      // in centen, excl. btw
  subscriptionText: "",
  vatPercent: "21",
  payMethods: "ideal",             // Mollie-methoden, kommagescheiden; leeg = alles wat in Mollie aan staat
};
const PAY_METHODS = ["ideal", "wero", "bancontact", "creditcard"];
async function getSettings() {
  const r = await q("SELECT key, value FROM rpb_settings");
  const s = { ...SETTING_DEFAULTS };
  for (const row of r.rows) if (row.key in s) s[row.key] = row.value;
  return {
    siteName: s.siteName || SETTING_DEFAULTS.siteName,
    welcomeText: s.welcomeText,
    announcement: s.announcement,
    registrationOpen: s.registrationOpen !== "false",
    subscriptionPrice: Number(s.subscriptionPrice) || 0,
    subscriptionText: s.subscriptionText,
    vatPercent: Number.isFinite(Number(s.vatPercent)) ? Number(s.vatPercent) : 21,
    payMethods: String(s.payMethods || "").split(",").map((x) => x.trim()).filter((x) => PAY_METHODS.includes(x)),
    onlinePayment: !!process.env.MOLLIE_API_KEY,
    paymentTestMode: String(process.env.MOLLIE_API_KEY || "").startsWith("test_"),
  };
}

// ---------- Mollie ----------
const MOLLIE_BASE = process.env.MOLLIE_API_BASE || "https://api.mollie.com/v2";
async function mollie(path, { method = "GET", body } = {}) {
  const key = process.env.MOLLIE_API_KEY;
  if (!key) throw httpError(503, "Online betalen is nog niet ingesteld (MOLLIE_API_KEY ontbreekt in Netlify).");
  let res;
  try {
    res = await fetch(MOLLIE_BASE + path, {
      method,
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) { console.error("mollie", e); throw httpError(502, "Mollie is niet bereikbaar. Probeer het later opnieuw."); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("mollie", res.status, data);
    const msg = data.detail || data.title || "onbekende fout";
    throw httpError(502, "Mollie weigerde de betaling: " + msg);
  }
  return data;
}
const centsToValue = (c) => (c / 100).toFixed(2);
function siteUrl(req) { return (process.env.URL || new URL(req.url).origin).replace(/\/$/, ""); }

// Haal de actuele status bij Mollie op en verwerk een geslaagde betaling (precies één keer).
async function syncMollie(ref) {
  const r = await q("SELECT * FROM rpb_mollie WHERE ref = $1", [ref]);
  const row = r.rows[0];
  if (!row || !row.mollie_id) return null;
  const p = await mollie("/payments/" + encodeURIComponent(row.mollie_id));
  const status = String(p.status || "open");
  if (status !== row.status || (p.method || "") !== row.method) {
    await q("UPDATE rpb_mollie SET status = $2, method = $3, updated_at = $4 WHERE ref = $1", [ref, status, p.method || "", new Date()]);
  }
  let validUntil = null;
  if (status === "paid") {
    const done = await q("SELECT to_char(valid_until, 'YYYY-MM-DD') AS valid_until FROM rpb_payments WHERE mollie_id = $1", [row.mollie_id]);
    if (done.rows[0]) validUntil = done.rows[0].valid_until;
    else {
      const t = today();
      const cur = await q("SELECT to_char(MAX(valid_until), 'YYYY-MM-DD') AS u FROM rpb_payments WHERE user_id = $1", [row.user_id]);
      const curUntil = cur.rows[0]?.u;
      const start = curUntil && curUntil >= t ? addDay(curUntil) : t;
      validUntil = addYear(start);
      const label = { ideal: "iDEAL", wero: "Wero", bancontact: "Bancontact", creditcard: "creditcard" }[p.method] || p.method || "online";
      const note = `Online via ${label} (${row.mollie_id}), incl. btw € ${centsToValue(row.amount_incl).replace(".", ",")}`;
      await q(`INSERT INTO rpb_payments (id, user_id, amount_cents, paid_on, valid_until, note, created_by, created_at, mollie_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (mollie_id) WHERE mollie_id IS NOT NULL DO NOTHING`,
        [newId("b"), row.user_id, row.amount_excl, t, validUntil, note, "mollie", new Date(), row.mollie_id]);
      const ur = await q("SELECT id, name, company FROM rpb_users WHERE id = $1", [row.user_id]);
      await log(ur.rows[0] || null, "betaling", `Abonnement online betaald via ${label}: ${euro(row.amount_excl / 100)} excl. btw, geldig t/m ${validUntil}`);
    }
  }
  return { status, validUntil };
}
function addDay(d) { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); }

const today = () => new Date().toISOString().slice(0, 10);
const validDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
function addYear(d) { const x = new Date(d + "T12:00:00Z"); x.setUTCFullYear(x.getUTCFullYear() + 1); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); }

// Wijzigingen in partijen en biedingen omzetten naar regels voor het logboek
function describeLots(prev, next, names) {
  const out = [];
  const a = (prev && prev.items) || {}, b = (next && next.items) || {};
  const label = (it) => `${it.product || "partij"}${it.ras ? " " + it.ras : ""}`;
  for (const [id, it] of Object.entries(b)) {
    const old = a[id];
    if (!old) { out.push(["partij", `Partij aangeboden: ${label(it)}, ${it.qty} ${it.unit} à ${euro(it.price)}`]); continue; }
    let said = false;
    if (old.status !== it.status && it.status === "ingetrokken") { out.push(["partij", `Partij ingetrokken: ${label(it)}`]); said = true; }
    if (old.status === "ingetrokken" && it.status !== "ingetrokken") { out.push(["partij", `Partij heropend: ${label(it)}`]); said = true; }
    for (const [bidder, acc] of Object.entries(it.accepted || {})) {
      if (!(old.accepted || {})[bidder]) { out.push(["gunning", `Gegund: ${acc.qty} ${it.unit} ${label(it)} à ${euro(acc.price)} aan ${names[bidder] || "onbekend"}`]); said = true; }
    }
    for (const bidder of Object.keys(it.rejected || {})) {
      if (!(old.rejected || {})[bidder]) { out.push(["bod", `Bod afgewezen van ${names[bidder] || "onbekend"} op ${label(it)}`]); said = true; }
    }
    if (!said && old.updatedAt !== it.updatedAt) out.push(["partij", `Partij bewerkt: ${label(it)}`]);
  }
  for (const [id, it] of Object.entries(a)) if (!b[id]) out.push(["partij", `Partij verwijderd: ${label(it)}`]);
  return out;
}
function describeBids(prev, next) {
  const out = [];
  const a = (prev && prev.offers) || {}, b = (next && next.offers) || {};
  for (const [id, o] of Object.entries(b)) {
    const old = a[id];
    if (!old) out.push(["bod", `Bod uitgebracht: ${o.qty} × ${euro(o.price)} op ${o.product || "partij"}`]);
    else if (old.price !== o.price || old.qty !== o.qty) out.push(["bod", `Bod gewijzigd: ${o.qty} × ${euro(o.price)} op ${o.product || "partij"}`]);
  }
  for (const [id, o] of Object.entries(a)) if (!b[id]) out.push(["bod", `Bod ingetrokken op ${o.product || "partij"}`]);
  return out;
}

const MAX_PENDING = 50;
const validKvk = (s) => /^\d{8}$/.test(s);
const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  await q("INSERT INTO rpb_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)", [sha256(token), userId, expires]);
  return token;
}

async function auth(req) {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer ([a-f0-9]{64})$/);
  if (!m) throw httpError(401, "Log opnieuw in.");
  const r = await q(
    `SELECT u.* FROM rpb_sessions s JOIN rpb_users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > $2`,
    [sha256(m[1]), new Date()]
  );
  const u = r.rows[0];
  if (!u || !u.active) throw httpError(401, "Log opnieuw in.");
  return u;
}

function requireAdmin(u) {
  if (u.role !== "beheerder") throw httpError(403, "Alleen een beheerder kan dit.");
}

async function countUsers() {
  const r = await q("SELECT COUNT(*)::int AS n FROM rpb_users");
  return Number(r.rows[0].n);
}

async function activeAdmins() {
  const r = await q("SELECT COUNT(*)::int AS n FROM rpb_users WHERE role = 'beheerder' AND active = TRUE");
  return Number(r.rows[0].n);
}

async function insertUser({ name, company, contact, code, role, pending = false, kvk = "", email = "", note = "" }) {
  name = str(name, 60);
  if (!name) throw httpError(400, "Vul een naam in.");
  validCode(code);
  const key = nameKey(name);
  const exists = await q("SELECT 1 FROM rpb_users WHERE name_key = $1", [key]);
  if (exists.rows.length) throw httpError(409, "Er bestaat al een gebruiker met deze naam.");
  const salt = crypto.randomBytes(16).toString("hex");
  const user = {
    id: newId("u"), name, company: str(company, 120), contact: str(contact, 120),
    role: role === "beheerder" ? "beheerder" : "handelaar", active: !pending,
    pending: !!pending, kvk: str(kvk, 8), email: str(email, 120), note: str(note, 500),
  };
  await q(
    `INSERT INTO rpb_users (id, name, name_key, company, contact, role, active, salt, hash, failed, created_at, pending, kvk, email, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, $10, $11, $12, $13, $14)`,
    [user.id, user.name, key, user.company, user.contact, user.role, user.active, salt, hashCode(code, salt), new Date(),
     user.pending, user.kvk, user.email, user.note]
  );
  return publicUser({ ...user, created_at: new Date() });
}

// ---------- routes ----------
async function route(req) {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const method = req.method.toUpperCase();
  const [a, b, c] = parts;

  await ensureSchema();

  // Status: is er al een beheerder? Plus de openbare website-instellingen.
  if (a === "status" && method === "GET") {
    return json(200, { needsSetup: (await countUsers()) === 0, settings: await getSettings() });
  }

  // Eerste beheerder aanmaken
  if (a === "setup" && method === "POST") {
    const body = await readBody(req);
    const expected = process.env.RPB_SETUP_CODE || "";
    if (!expected) throw httpError(500, "RPB_SETUP_CODE ontbreekt in Netlify.");
    if ((await countUsers()) > 0) throw httpError(409, "Er is al een beheerder. Log in.");
    const given = str(body.setupCode, 200);
    const ok = given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (!ok) throw httpError(403, "De installatiecode klopt niet.");
    const user = await insertUser({ ...body, role: "beheerder" });
    const token = await createSession(user.id);
    await log(user, "account", "Eerste beheerder aangemaakt");
    return json(200, { token, user });
  }

  // Account aanvragen (zonder login). Het account staat uit tot een beheerder het goedkeurt.
  if (a === "register" && method === "POST") {
    const body = await readBody(req);
    if (str(body.website, 200)) return json(200, { ok: true }); // honeypot: bots vullen dit verborgen veld in
    if ((await countUsers()) === 0) throw httpError(409, "Er is nog geen beheerder. Maak eerst het beheerdersaccount aan.");
    if (!(await getSettings()).registrationOpen) throw httpError(403, "Aanmelden is op dit moment gesloten. Neem contact op met de beheerder.");
    const company = str(body.company, 120), kvk = str(body.kvk, 20).replace(/\s|\./g, "");
    const email = str(body.email, 120), phone = str(body.phone, 60);
    if (!company) throw httpError(400, "Vul je bedrijfsnaam in.");
    if (!validKvk(kvk)) throw httpError(400, "Vul een KvK-nummer van 8 cijfers in.");
    if (!email && !phone) throw httpError(400, "Vul een telefoonnummer of e-mailadres in.");
    if (email && !validEmail(email)) throw httpError(400, "Dit e-mailadres klopt niet.");
    const pend = await q("SELECT COUNT(*)::int AS n FROM rpb_users WHERE pending = TRUE");
    if (Number(pend.rows[0].n) >= MAX_PENDING) throw httpError(429, "Er staan te veel aanvragen open. Probeer het later opnieuw.");
    const contact = [phone, email].filter(Boolean).join(" / ");
    const nu = await insertUser({ name: body.name, company, contact, code: body.code, role: "handelaar", pending: true, kvk, email, note: body.note });
    await log(nu, "account", `Account aangevraagd (KvK ${kvk})`);
    return json(200, { ok: true });
  }

  // Inloggen
  if (a === "login" && method === "POST") {
    const body = await readBody(req);
    const key = nameKey(str(body.name, 60));
    const code = typeof body.code === "string" ? body.code : "";
    const r = await q("SELECT * FROM rpb_users WHERE name_key = $1", [key]);
    const u = r.rows[0];
    const fail = () => httpError(401, "Naam of code klopt niet.");
    if (!u) throw fail();
    if (u.pending) {
      if (checkCode(code, u.salt, u.hash)) throw httpError(403, "Je aanvraag is ontvangen en wacht op goedkeuring door de beheerder.");
      throw fail();
    }
    if (!u.active) throw fail();
    if (u.locked_until && new Date(u.locked_until) > new Date()) {
      throw httpError(429, `Te vaak een verkeerde code. Probeer het over ${LOCK_MINUTES} minuten opnieuw.`);
    }
    if (!checkCode(code, u.salt, u.hash)) {
      const failed = (u.failed || 0) + 1;
      const lock = failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60000) : null;
      await q("UPDATE rpb_users SET failed = $2, locked_until = $3 WHERE id = $1", [u.id, failed >= MAX_FAILED ? 0 : failed, lock]);
      await log(u, "inloggen", lock ? `Verkeerde code, account ${LOCK_MINUTES} minuten geblokkeerd` : "Verkeerde code");
      throw fail();
    }
    await q("UPDATE rpb_users SET failed = 0, locked_until = NULL WHERE id = $1", [u.id]);
    await log(u, "inloggen", "Ingelogd");
    await q("DELETE FROM rpb_sessions WHERE expires_at < $1", [new Date()]);
    const token = await createSession(u.id);
    return json(200, { token, user: publicUser(u) });
  }

  // Foto tonen: /api/photo/<id>?s=t (miniatuur) of ?s=f (groot).
  // Zonder login, zodat <img> hem kan laden; de id is willekeurig en niet te raden.
  if (a === "photo" && b && !c && method === "GET") {
    if (!/^p[a-f0-9]{18}$/.test(b)) throw httpError(404, "Foto niet gevonden.");
    const full = url.searchParams.get("s") === "f";
    const r = await q(`SELECT mime, ${full ? "full_img" : "thumb"} AS img FROM rpb_photos WHERE id = $1`, [b]);
    const row = r.rows[0];
    if (!row) throw httpError(404, "Foto niet gevonden.");
    return new Response(Buffer.from(row.img, "base64"), {
      status: 200,
      headers: {
        "content-type": row.mime,
        "cache-control": "public, max-age=31536000, immutable",
        "netlify-cdn-cache-control": "public, max-age=31536000, immutable, durable",
        "x-content-type-options": "nosniff",
      },
    });
  }

  // Mollie meldt een statuswijziging (zonder login). We vertrouwen de melding niet,
  // maar halen de status zelf bij Mollie op.
  if (a === "mollie" && b === "webhook" && method === "POST") {
    const text = await req.text().catch(() => "");
    const molId = new URLSearchParams(text).get("id") || "";
    if (/^tr_[A-Za-z0-9]+$/.test(molId)) {
      const r = await q("SELECT ref FROM rpb_mollie WHERE mollie_id = $1", [molId]);
      if (r.rows[0]) await syncMollie(r.rows[0].ref);
    }
    return new Response("ok", { status: 200 });
  }

  // Vanaf hier: ingelogd
  const me = await auth(req);

  // Abonnement online betalen: maakt een Mollie-betaling en geeft de betaalpagina terug
  if (a === "pay" && b === "subscription" && method === "POST") {
    const s = await getSettings();
    if (!s.subscriptionPrice) throw httpError(400, "Er is geen abonnementsprijs ingesteld.");
    const excl = s.subscriptionPrice;
    const incl = Math.round(excl * (1 + (s.vatPercent || 0) / 100));
    const ref = "m" + crypto.randomBytes(12).toString("hex");
    const base = siteUrl(req);
    const body = {
      amount: { currency: "EUR", value: centsToValue(incl) },
      description: `${s.siteName} abonnement ${me.company || me.name}`.slice(0, 255),
      redirectUrl: `${base}/?betaling=${ref}`,
      webhookUrl: `${base}/api/mollie/webhook`,
      metadata: { ref, userId: me.id },
      locale: "nl_NL",
    };
    if (s.payMethods.length === 1) body.method = s.payMethods[0];
    else if (s.payMethods.length > 1) body.method = s.payMethods;
    const now = new Date();
    await q("INSERT INTO rpb_mollie (ref, user_id, amount_excl, amount_incl, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $6)",
      [ref, me.id, excl, incl, "created", now]);
    const p = await mollie("/payments", { method: "POST", body });
    await q("UPDATE rpb_mollie SET mollie_id = $2, status = $3, updated_at = $4 WHERE ref = $1", [ref, p.id, p.status || "open", new Date()]);
    const checkout = p._links?.checkout?.href;
    if (!checkout) throw httpError(502, "Mollie gaf geen betaalpagina terug.");
    await log(me, "betaling", `Online betaling gestart: € ${centsToValue(incl).replace(".", ",")} incl. btw`);
    return json(200, { checkoutUrl: checkout, ref });
  }

  // Status van een eigen online betaling (na terugkeer van Mollie)
  if (a === "pay" && b === "status" && method === "GET") {
    const ref = str(url.searchParams.get("ref") || "", 40);
    const r = await q("SELECT user_id, status FROM rpb_mollie WHERE ref = $1", [ref]);
    if (!r.rows[0] || r.rows[0].user_id !== me.id) throw httpError(404, "Betaling niet gevonden.");
    const st = await syncMollie(ref);
    return json(200, st || { status: r.rows[0].status });
  }

  // Eigen abonnementsstatus
  if (a === "pay" && b === "me" && method === "GET") {
    const r = await q("SELECT to_char(MAX(valid_until), 'YYYY-MM-DD') AS u FROM rpb_payments WHERE user_id = $1", [me.id]);
    const s = await getSettings();
    const incl = Math.round(s.subscriptionPrice * (1 + (s.vatPercent || 0) / 100));
    return json(200, { paidUntil: r.rows[0]?.u || null, today: today(), priceExcl: s.subscriptionPrice / 100, priceIncl: incl / 100, onlinePayment: s.onlinePayment, testMode: s.paymentTestMode });
  }

  // Foto opslaan: { thumb: "data:image/jpeg;base64,...", full: "data:image/jpeg;base64,..." }
  if (a === "photos" && !b && method === "POST") {
    const body = await readBody(req);
    const parse = (s, max, label) => {
      const m = typeof s === "string" && s.match(/^data:(image\/(?:jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
      if (!m) throw httpError(400, "Alleen JPEG- of WebP-foto's zijn toegestaan.");
      const bytes = Buffer.byteLength(m[2], "base64");
      if (bytes > max) throw httpError(413, `De ${label} is te groot.`);
      return { mime: m[1], b64: m[2] };
    };
    const full = parse(body.full, MAX_FULL_BYTES, "foto");
    const thumb = parse(body.thumb, MAX_THUMB_BYTES, "miniatuur");
    const n = await q("SELECT COUNT(*)::int AS n FROM rpb_photos WHERE owner = $1", [me.id]);
    if (Number(n.rows[0].n) >= MAX_PHOTOS_PER_USER) throw httpError(409, "Je hebt het maximale aantal foto's bereikt. Verwijder foto's van oude partijen.");
    const id = "p" + crypto.randomBytes(9).toString("hex");
    await q("INSERT INTO rpb_photos (id, owner, mime, thumb, full_img, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [id, me.id, full.mime, thumb.b64, full.b64, new Date()]);
    return json(200, { id });
  }

  // Foto verwijderen: eigen foto, of elke foto als beheerder
  if (a === "photos" && b && method === "DELETE") {
    const r = await q("SELECT owner FROM rpb_photos WHERE id = $1", [b]);
    const row = r.rows[0];
    if (!row) return json(200, { ok: true });
    if (row.owner !== me.id && me.role !== "beheerder") throw httpError(403, "Dit is niet jouw foto.");
    await q("DELETE FROM rpb_photos WHERE id = $1", [b]);
    return json(200, { ok: true });
  }

  if (a === "logout" && method === "POST") {
    const token = (req.headers.get("authorization") || "").slice(7);
    await q("DELETE FROM rpb_sessions WHERE token_hash = $1", [sha256(token)]);
    await log(me, "inloggen", "Uitgelogd");
    return json(200, { ok: true });
  }

  if (a === "me" && method === "GET") return json(200, { user: publicUser(me) });

  if (a === "me" && method === "PATCH") {
    const body = await readBody(req);
    const company = body.company !== undefined ? str(body.company, 120) : me.company;
    const contact = body.contact !== undefined ? str(body.contact, 120) : me.contact;
    if (body.newCode !== undefined) {
      if (!checkCode(String(body.currentCode || ""), me.salt, me.hash)) throw httpError(403, "Je huidige code klopt niet.");
      validCode(body.newCode);
      const salt = crypto.randomBytes(16).toString("hex");
      await q("UPDATE rpb_users SET salt = $2, hash = $3 WHERE id = $1", [me.id, salt, hashCode(body.newCode, salt)]);
    }
    await q("UPDATE rpb_users SET company = $2, contact = $3 WHERE id = $1", [me.id, company, contact]);
    return json(200, { user: publicUser({ ...me, company, contact }) });
  }

  // Alle partijen en biedingen (of alleen wat er sinds 'since' veranderde)
  if (a === "data" && method === "GET") {
    const since = url.searchParams.get("since");
    const now = new Date();
    let r;
    if (since && !isNaN(Date.parse(since))) {
      r = await q("SELECT collection, id, data FROM rpb_docs WHERE updated_at > $1", [new Date(since)]);
    } else {
      r = await q("SELECT collection, id, data FROM rpb_docs WHERE data IS NOT NULL");
    }
    // Actuele bedrijfsnaam en contact per gebruiker, zodat oude partijen en biedingen
    // de nieuwste gegevens tonen als daar zelf niets is ingevuld.
    const p = await q("SELECT id, company, contact FROM rpb_users");
    const profiles = {};
    for (const row of p.rows) profiles[row.id] = { company: row.company, contact: row.contact };
    let pendingCount;
    if (me.role === "beheerder") {
      const pc = await q("SELECT COUNT(*)::int AS n FROM rpb_users WHERE pending = TRUE");
      pendingCount = Number(pc.rows[0].n);
    }
    return json(200, { now: now.toISOString(), full: !since, docs: r.rows, profiles, pendingCount });
  }

  // Eigen document schrijven: /api/doc/lots of /api/doc/bids
  if (a === "doc" && b && COLLECTIONS.has(b) && !c && method === "PUT") {
    const body = await readBody(req);
    const data = body.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw httpError(400, "Ongeldige gegevens.");
    const text = JSON.stringify(data);
    if (Buffer.byteLength(text) > MAX_DOC_BYTES) throw httpError(413, "Te veel gegevens in één keer. Trek oude partijen of biedingen in.");
    const now = new Date();
    const prevR = await q("SELECT data FROM rpb_docs WHERE collection = $1 AND id = $2", [b, me.id]);
    const prev = prevR.rows[0]?.data || null;
    await q(
      `INSERT INTO rpb_docs (collection, id, data, updated_at, updated_by) VALUES ($1, $2, $3::jsonb, $4, $2)
       ON CONFLICT (collection, id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
      [b, me.id, text, now]
    );
    let lines = [];
    if (b === "lots") {
      const nr = await q("SELECT id, name, company FROM rpb_users");
      const names = {}; for (const row of nr.rows) names[row.id] = row.company || row.name;
      lines = describeLots(prev, data, names);
    } else lines = describeBids(prev, data);
    for (const [kind, detail] of lines.slice(0, 10)) await log(me, kind, detail);
    return json(200, { ok: true, at: now.toISOString() });
  }

  // Beheerder: document van een ander verwijderen (opruimen)
  if (a === "doc" && b && COLLECTIONS.has(b) && c && method === "DELETE") {
    requireAdmin(me);
    await q("UPDATE rpb_docs SET data = NULL, updated_at = $3, updated_by = $4 WHERE collection = $1 AND id = $2", [b, c, new Date(), me.id]);
    return json(200, { ok: true });
  }

  // Beheerder: gebruikers
  if (a === "users" && !b && method === "GET") {
    requireAdmin(me);
    const r = await q(`SELECT u.*,
        (SELECT to_char(MAX(p.valid_until), 'YYYY-MM-DD') FROM rpb_payments p WHERE p.user_id = u.id) AS paid_until,
        (SELECT COALESCE(SUM(p.amount_cents), 0) FROM rpb_payments p WHERE p.user_id = u.id) AS paid_total
      FROM rpb_users u ORDER BY u.pending DESC, u.name_key`);
    return json(200, { users: r.rows.map(publicUser), today: today() });
  }
  if (a === "users" && !b && method === "POST") {
    requireAdmin(me);
    const user = await insertUser(await readBody(req));
    await log(me, "beheer", `Gebruiker aangemaakt: ${user.name}${user.company ? " (" + user.company + ")" : ""}, rol ${user.role}`);
    return json(200, { user });
  }
  if (a === "users" && b && method === "PATCH") {
    requireAdmin(me);
    const body = await readBody(req);
    const r = await q("SELECT * FROM rpb_users WHERE id = $1", [b]);
    const u = r.rows[0];
    if (!u) throw httpError(404, "Gebruiker niet gevonden.");
    const role = body.role === "beheerder" || body.role === "handelaar" ? body.role : u.role;
    const active = typeof body.active === "boolean" ? body.active : u.active;
    const losingAdmin = u.role === "beheerder" && u.active && (role !== "beheerder" || !active);
    if (losingAdmin && (await activeAdmins()) <= 1) throw httpError(409, "Er moet minstens één actieve beheerder blijven.");
    const company = body.company !== undefined ? str(body.company, 120) : u.company;
    const contact = body.contact !== undefined ? str(body.contact, 120) : u.contact;
    const kvk = body.kvk !== undefined ? str(body.kvk, 20).replace(/\s|\./g, "") : u.kvk;
    if (body.kvk !== undefined && kvk && !validKvk(kvk)) throw httpError(400, "Vul een KvK-nummer van 8 cijfers in.");
    const pending = active ? false : u.pending; // goedkeuren = activeren
    await q("UPDATE rpb_users SET kvk = $2, pending = $3 WHERE id = $1", [b, kvk, pending]);
    let name = u.name;
    if (body.name !== undefined) {
      name = str(body.name, 60);
      if (!name) throw httpError(400, "Vul een naam in.");
      const key = nameKey(name);
      const clash = await q("SELECT 1 FROM rpb_users WHERE name_key = $1 AND id <> $2", [key, b]);
      if (clash.rows.length) throw httpError(409, "Er bestaat al een gebruiker met deze naam.");
      await q("UPDATE rpb_users SET name = $2, name_key = $3 WHERE id = $1", [b, name, key]);
    }
    await q("UPDATE rpb_users SET role = $2, active = $3, company = $4, contact = $5 WHERE id = $1", [b, role, active, company, contact]);
    if (body.code !== undefined) {
      validCode(body.code);
      const salt = crypto.randomBytes(16).toString("hex");
      await q("UPDATE rpb_users SET salt = $2, hash = $3, failed = 0, locked_until = NULL WHERE id = $1", [b, salt, hashCode(body.code, salt)]);
    }
    if (!active || body.code !== undefined) await q("DELETE FROM rpb_sessions WHERE user_id = $1", [b]);
    const who = `${name}${company ? " (" + company + ")" : ""}`;
    if (u.pending && !pending) await log(me, "beheer", `Aanvraag goedgekeurd: ${who}`);
    else if (u.active !== active) await log(me, "beheer", `${active ? "Geactiveerd" : "Gedeactiveerd"}: ${who}`);
    if (u.role !== role) await log(me, "beheer", `Rol gewijzigd naar ${role}: ${who}`);
    if (body.code !== undefined) await log(me, "beheer", `Nieuwe code ingesteld voor ${who}`);
    if (body.name !== undefined || body.company !== undefined || body.contact !== undefined || body.kvk !== undefined) {
      const changed = [name !== u.name && "naam", company !== u.company && "bedrijf", contact !== u.contact && "contact", kvk !== u.kvk && "KvK"].filter(Boolean);
      if (changed.length) await log(me, "beheer", `Gegevens gewijzigd (${changed.join(", ")}): ${who}`);
    }
    return json(200, { user: publicUser({ ...u, name, role, active, company, contact, kvk, pending }) });
  }

  // Beheerder: aanvraag afwijzen (verwijdert alleen accounts die nog niet zijn goedgekeurd)
  if (a === "users" && b && method === "DELETE") {
    requireAdmin(me);
    const r = await q("SELECT pending, name, company FROM rpb_users WHERE id = $1", [b]);
    if (!r.rows[0]) return json(200, { ok: true });
    if (!r.rows[0].pending) throw httpError(409, "Alleen een openstaande aanvraag kan worden afgewezen. Deactiveer bestaande gebruikers.");
    await q("DELETE FROM rpb_users WHERE id = $1 AND pending = TRUE", [b]);
    await log(me, "beheer", `Aanvraag afgewezen: ${r.rows[0].name} (${r.rows[0].company})`);
    return json(200, { ok: true });
  }

  // ---------- beheeromgeving ----------
  if (a === "admin") {
    requireAdmin(me);

    // Kerncijfers voor het dashboard
    if (b === "stats" && method === "GET") {
      const t = today(), yearStart = t.slice(0, 4) + "-01-01";
      const soon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
      const rev = await q("SELECT COALESCE(SUM(amount_cents), 0) AS total, COALESCE(SUM(CASE WHEN paid_on >= $1 THEN amount_cents ELSE 0 END), 0) AS year FROM rpb_payments", [yearStart]);
      const us = await q(`SELECT
          COUNT(*) FILTER (WHERE active AND NOT pending AND role = 'handelaar') AS traders,
          COUNT(*) FILTER (WHERE active AND NOT pending AND role = 'beheerder') AS admins,
          COUNT(*) FILTER (WHERE pending) AS pending
        FROM rpb_users`);
      const paid = await q(`SELECT COUNT(DISTINCT p.user_id) AS n FROM rpb_payments p JOIN rpb_users u ON u.id = p.user_id
        WHERE p.valid_until >= $1 AND u.active AND NOT u.pending`, [t]);
      const att = await q(`SELECT u.id, u.name, u.company, to_char(MAX(p.valid_until), 'YYYY-MM-DD') AS paid_until
        FROM rpb_users u JOIN rpb_payments p ON p.user_id = u.id
        WHERE u.active AND NOT u.pending GROUP BY u.id, u.name, u.company
        HAVING MAX(p.valid_until) <= $1 ORDER BY MAX(p.valid_until) LIMIT 20`, [soon]);
      const docs = await q("SELECT id, data FROM rpb_docs WHERE collection = 'lots' AND data IS NOT NULL");
      let lotsOpen = 0, lotsTotal = 0, awards = 0, awardValue = 0;
      for (const row of docs.rows) {
        for (const it of Object.values(row.data?.items || {})) {
          lotsTotal++;
          const rem = it.remaining ?? it.qty;
          if (it.status !== "ingetrokken" && it.status !== "verkocht" && rem > 0 && (!it.until || it.until >= t)) lotsOpen++;
          for (const acc of Object.values(it.accepted || {})) { awards++; awardValue += (acc.qty || 0) * (acc.price || 0); }
        }
      }
      const r0 = rev.rows[0], u0 = us.rows[0];
      return json(200, {
        today: t,
        revenueTotal: Number(r0.total) / 100, revenueYear: Number(r0.year) / 100,
        customers: Number(u0.traders), admins: Number(u0.admins), pending: Number(u0.pending),
        paidCustomers: Number(paid.rows[0].n),
        lotsOpen, lotsTotal, awards, awardValue,
        attention: att.rows.map((x) => ({ id: x.id, name: x.name, company: x.company, paidUntil: x.paid_until, expired: x.paid_until < t })),
      });
    }

    // Betalingen per gebruiker
    if (b === "payments" && !c && method === "GET") {
      const uid = url.searchParams.get("user") || "";
      const r = await q(`SELECT id, user_id, amount_cents, to_char(paid_on, 'YYYY-MM-DD') AS paid_on, to_char(valid_until, 'YYYY-MM-DD') AS valid_until, note, created_at
        FROM rpb_payments ${uid ? "WHERE user_id = $1" : ""} ORDER BY paid_on DESC, created_at DESC LIMIT 500`, uid ? [uid] : []);
      return json(200, { payments: r.rows.map((p) => ({ id: p.id, userId: p.user_id, amount: Number(p.amount_cents) / 100, paidOn: p.paid_on, validUntil: p.valid_until, note: p.note })) });
    }
    if (b === "payments" && !c && method === "POST") {
      const body = await readBody(req);
      const ur = await q("SELECT id, name, company FROM rpb_users WHERE id = $1", [str(body.userId, 40)]);
      const u = ur.rows[0];
      if (!u) throw httpError(404, "Gebruiker niet gevonden.");
      const amount = Math.round(Number(String(body.amount).replace(",", ".")) * 100);
      if (!Number.isFinite(amount) || amount < 0 || amount > 10000000) throw httpError(400, "Vul een geldig bedrag in.");
      const paidOn = validDate(body.paidOn) ? body.paidOn : today();
      const validUntil = validDate(body.validUntil) ? body.validUntil : addYear(paidOn);
      if (validUntil < paidOn) throw httpError(400, "'Geldig tot' ligt voor de betaaldatum.");
      const id = newId("b");
      await q("INSERT INTO rpb_payments (id, user_id, amount_cents, paid_on, valid_until, note, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [id, u.id, amount, paidOn, validUntil, str(body.note, 200), me.id, new Date()]);
      await log(me, "betaling", `Betaling geregistreerd: ${euro(amount / 100)} van ${u.name}${u.company ? " (" + u.company + ")" : ""}, geldig t/m ${validUntil}`);
      return json(200, { id });
    }
    if (b === "payments" && c && method === "DELETE") {
      const r = await q("SELECT p.amount_cents, u.name, u.company FROM rpb_payments p LEFT JOIN rpb_users u ON u.id = p.user_id WHERE p.id = $1", [c]);
      if (r.rows[0]) {
        await q("DELETE FROM rpb_payments WHERE id = $1", [c]);
        await log(me, "betaling", `Betaling verwijderd: ${euro(Number(r.rows[0].amount_cents) / 100)} van ${r.rows[0].name || "onbekend"}`);
      }
      return json(200, { ok: true });
    }

    // Logboek
    if (b === "log" && method === "GET") {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 200));
      const before = Number(url.searchParams.get("before")) || 0;
      const kind = str(url.searchParams.get("kind") || "", 20);
      const conds = [], params = [];
      if (before) { params.push(before); conds.push(`id < $${params.length}`); }
      if (kind) { params.push(kind); conds.push(`kind = $${params.length}`); }
      const r = await q(`SELECT id, at, user_name, kind, detail FROM rpb_log ${conds.length ? "WHERE " + conds.join(" AND ") : ""} ORDER BY id DESC LIMIT ${limit}`, params);
      return json(200, { entries: r.rows.map((x) => ({ id: Number(x.id), at: new Date(x.at).toISOString(), user: x.user_name, kind: x.kind, detail: x.detail })) });
    }

    // Website-instellingen
    if (b === "settings" && method === "PUT") {
      const body = await readBody(req);
      const before = await getSettings();
      const vals = {
        siteName: str(body.siteName, 60) || SETTING_DEFAULTS.siteName,
        welcomeText: str(body.welcomeText, 1000),
        announcement: str(body.announcement, 500),
        registrationOpen: body.registrationOpen === false ? "false" : "true",
        subscriptionPrice: String(Math.max(0, Math.round(Number(String(body.subscriptionPrice ?? "").replace(",", ".")) * 100) || 0)),
        subscriptionText: str(body.subscriptionText, 300),
        vatPercent: String(Math.min(100, Math.max(0, Number(String(body.vatPercent ?? "21").replace(",", ".")) || 0))),
        payMethods: (Array.isArray(body.payMethods) ? body.payMethods : []).filter((x) => PAY_METHODS.includes(x)).join(","),
      };
      for (const [k, v] of Object.entries(vals)) {
        await q("INSERT INTO rpb_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [k, v]);
      }
      const after = await getSettings();
      const changed = Object.keys(after).filter((k) => String(after[k]) !== String(before[k]));
      if (changed.length) await log(me, "beheer", `Website-instellingen gewijzigd: ${changed.join(", ")}`);
      return json(200, { settings: after });
    }

    // Partij van een ander intrekken, heropenen of verwijderen
    if (b === "lots" && method === "POST") {
      const body = await readBody(req);
      const sellerId = str(body.sellerId, 40), lotId = str(body.lotId, 60), action = body.action;
      const r = await q("SELECT data FROM rpb_docs WHERE collection = 'lots' AND id = $1", [sellerId]);
      const doc = r.rows[0]?.data;
      const it = doc?.items?.[lotId];
      if (!it) throw httpError(404, "Partij niet gevonden.");
      const label = `${it.product || "partij"}${it.ras ? " " + it.ras : ""}`;
      const nr = await q("SELECT name, company FROM rpb_users WHERE id = $1", [sellerId]);
      const owner = nr.rows[0] ? (nr.rows[0].company || nr.rows[0].name) : "onbekend";
      if (action === "withdraw") { it.status = "ingetrokken"; }
      else if (action === "reopen") { it.status = (it.remaining ?? it.qty) > 0 ? "open" : "verkocht"; }
      else if (action === "delete") {
        for (const p of Array.isArray(it.photos) ? it.photos : []) await q("DELETE FROM rpb_photos WHERE id = $1", [p]);
        delete doc.items[lotId];
      } else throw httpError(400, "Onbekende actie.");
      await q("UPDATE rpb_docs SET data = $2::jsonb, updated_at = $3, updated_by = $4 WHERE collection = 'lots' AND id = $1",
        [sellerId, JSON.stringify(doc), new Date(), me.id]);
      const verb = { withdraw: "ingetrokken", reopen: "heropend", delete: "verwijderd" }[action];
      await log(me, "beheer", `Partij van ${owner} ${verb}: ${label}`);
      return json(200, { ok: true });
    }
  }

  throw httpError(404, "Onbekend adres.");
}

export default async (req) => {
  try {
    return await route(req);
  } catch (e) {
    if (e && e.status) return json(e.status, { error: e.message });
    console.error(e);
    const msg = String((e && e.message) || e);
    const hint = /certificate/i.test(msg) ? " (certificaat: zie PG_SSL_CA / PG_SSL_INSECURE)" : "";
    return json(500, { error: "Database niet bereikbaar" + hint + "." });
  }
};
