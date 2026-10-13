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
  return { id: u.id, name: u.name, company: u.company, contact: u.contact, role: u.role, active: u.active };
}

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

async function insertUser({ name, company, contact, code, role }) {
  name = str(name, 60);
  if (!name) throw httpError(400, "Vul een naam in.");
  validCode(code);
  const key = nameKey(name);
  const exists = await q("SELECT 1 FROM rpb_users WHERE name_key = $1", [key]);
  if (exists.rows.length) throw httpError(409, "Er bestaat al een gebruiker met deze naam.");
  const salt = crypto.randomBytes(16).toString("hex");
  const user = {
    id: newId("u"), name, company: str(company, 120), contact: str(contact, 120),
    role: role === "beheerder" ? "beheerder" : "handelaar", active: true,
  };
  await q(
    `INSERT INTO rpb_users (id, name, name_key, company, contact, role, active, salt, hash, failed, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7, $8, 0, $9)`,
    [user.id, user.name, key, user.company, user.contact, user.role, salt, hashCode(code, salt), new Date()]
  );
  return user;
}

// ---------- routes ----------
async function route(req) {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const method = req.method.toUpperCase();
  const [a, b, c] = parts;

  await ensureSchema();

  // Status: is er al een beheerder?
  if (a === "status" && method === "GET") {
    return json(200, { needsSetup: (await countUsers()) === 0 });
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
    return json(200, { token, user });
  }

  // Inloggen
  if (a === "login" && method === "POST") {
    const body = await readBody(req);
    const key = nameKey(str(body.name, 60));
    const code = typeof body.code === "string" ? body.code : "";
    const r = await q("SELECT * FROM rpb_users WHERE name_key = $1", [key]);
    const u = r.rows[0];
    const fail = () => httpError(401, "Naam of code klopt niet.");
    if (!u || !u.active) throw fail();
    if (u.locked_until && new Date(u.locked_until) > new Date()) {
      throw httpError(429, `Te vaak een verkeerde code. Probeer het over ${LOCK_MINUTES} minuten opnieuw.`);
    }
    if (!checkCode(code, u.salt, u.hash)) {
      const failed = (u.failed || 0) + 1;
      const lock = failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60000) : null;
      await q("UPDATE rpb_users SET failed = $2, locked_until = $3 WHERE id = $1", [u.id, failed >= MAX_FAILED ? 0 : failed, lock]);
      throw fail();
    }
    await q("UPDATE rpb_users SET failed = 0, locked_until = NULL WHERE id = $1", [u.id]);
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

  // Vanaf hier: ingelogd
  const me = await auth(req);

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
    return json(200, { now: now.toISOString(), full: !since, docs: r.rows });
  }

  // Eigen document schrijven: /api/doc/lots of /api/doc/bids
  if (a === "doc" && b && COLLECTIONS.has(b) && !c && method === "PUT") {
    const body = await readBody(req);
    const data = body.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw httpError(400, "Ongeldige gegevens.");
    const text = JSON.stringify(data);
    if (Buffer.byteLength(text) > MAX_DOC_BYTES) throw httpError(413, "Te veel gegevens in één keer. Trek oude partijen of biedingen in.");
    const now = new Date();
    await q(
      `INSERT INTO rpb_docs (collection, id, data, updated_at, updated_by) VALUES ($1, $2, $3::jsonb, $4, $2)
       ON CONFLICT (collection, id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
      [b, me.id, text, now]
    );
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
    const r = await q("SELECT * FROM rpb_users ORDER BY name_key");
    return json(200, { users: r.rows.map(publicUser) });
  }
  if (a === "users" && !b && method === "POST") {
    requireAdmin(me);
    const user = await insertUser(await readBody(req));
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
    await q("UPDATE rpb_users SET role = $2, active = $3, company = $4, contact = $5 WHERE id = $1", [b, role, active, company, contact]);
    if (body.code !== undefined) {
      validCode(body.code);
      const salt = crypto.randomBytes(16).toString("hex");
      await q("UPDATE rpb_users SET salt = $2, hash = $3, failed = 0, locked_until = NULL WHERE id = $1", [b, salt, hashCode(body.code, salt)]);
    }
    if (!active || body.code !== undefined) await q("DELETE FROM rpb_sessions WHERE user_id = $1", [b]);
    return json(200, { user: publicUser({ ...u, role, active, company, contact }) });
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
