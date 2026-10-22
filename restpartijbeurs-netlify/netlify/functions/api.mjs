// Restpartijbeurs – API op Netlify
// Eén functie op /api/*. Praat met PostgreSQL (Aiven) en controleert bij elke
// wijziging wie er ingelogd is. De browser praat nooit zelf met de database.
//
// Omgevingsvariabelen (Netlify → Site configuration → Environment variables):
//   DATABASE_URL     Service URI van Aiven (postgres://...)          verplicht
//   RPB_SETUP_CODE   Code om de eerste beheerder aan te maken         verplicht bij eerste start
//   PG_SSL_CA        CA-certificaat van Aiven (aanbevolen)
//   PG_SSL_INSECURE  "true" = certificaat niet controleren (verbinding blijft versleuteld)
//   MOLLIE_API_KEY   Mollie-sleutel voor online betalen (test_... of live_...)
//   PG_SCHEMA        Eigen schema in de database, bijv. "rpb_test" voor de testomgeving (leeg = standaard)
//   PG_MIGRATE_FROM  Eenmalig, bijv. "public": verplaatst bestaande rpb_-tabellen naar PG_SCHEMA. Daarna weghalen.
//   APP_ENV          "test" = testomgeving: oranje balk "TESTOMGEVING" in de app; leegmaken toegestaan
//   ALLOW_WIPE       "true" = leegmaken ook buiten de testomgeving toestaan (standaard uit)
//   GMAIL_USER         Gmail-adres voor e-mail (code vergeten)          optioneel
//   GMAIL_APP_PASSWORD App-wachtwoord van dat Google-account            nodig bij GMAIL_USER
//   BREVO_API_KEY      Alternatief: Brevo-sleutel                       optioneel
//   MAIL_FROM          Afzenderadres bij Brevo, bijv. noreply@jouwdomein.nl
//   ANTHROPIC_API_KEY  Sleutel voor AI (velden invullen op basis van een foto)   optioneel
//   AI_MODEL           AI-model, standaard claude-haiku-5-5                      optioneel

import pg from "pg";
import crypto from "node:crypto";
import tls from "node:tls";
import { createV1 } from "../lib/foodsource-v1.mjs";
import { createAi, aiConfigured, aiModel } from "../lib/ai-photo.mjs";

export const config = { path: "/api/*" };

const COLLECTIONS = new Set(["lots", "bids"]);
const MAX_DOC_BYTES = 256 * 1024;
const MAX_FULL_BYTES = 450 * 1024;   // grote foto, na verkleinen in de browser
const MAX_THUMB_BYTES = 60 * 1024;   // miniatuur
const MAX_PHOTOS_PER_USER = 300;
const SESSION_DAYS = 30;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const MIN_CODE = 12;                 // minimale lengte van een code (wachtwoord)
const COOKIE = "rpb_s";              // sessiecookie (HttpOnly, niet leesbaar voor JavaScript)

// ---------- database ----------
let pool = null;
let schemaReady = null;
const SCHEMA_VERSION = "2026-10-21a"; // verhogen bij elke wijziging in ensureSchema
// Testomgeving: eigen schema in dezelfde database, zodat test- en echte gegevens gescheiden blijven
const PG_SCHEMA = /^[a-z_][a-z0-9_]{0,40}$/.test(process.env.PG_SCHEMA || "") ? process.env.PG_SCHEMA : "";
// Eenmalige verhuizing: PG_MIGRATE_FROM=public verplaatst de bestaande rpb_-tabellen naar PG_SCHEMA.
// Alleen tabellen van de Restpartijbeurs (vaste lijst), nooit die van een andere app (zoals records van Vloeren Kassa).
const PG_MIGRATE_FROM = /^[a-z_][a-z0-9_]{0,40}$/.test(process.env.PG_MIGRATE_FROM || "") ? process.env.PG_MIGRATE_FROM : "";
const RPB_TABLES = ["rpb_users", "rpb_sessions", "rpb_docs", "rpb_payments", "rpb_mollie", "rpb_log", "rpb_settings", "rpb_photos", "rpb_attempts", "rpb_resets", "rpb_api_keys", "rpb_events", "rpb_assets"];

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
  // Time-outs: liever een nette foutmelding dan een functie die blijft hangen
  const options = [PG_SCHEMA ? `-c search_path=${PG_SCHEMA}` : "", "-c statement_timeout=10000"].filter(Boolean).join(" ");
  pool = new pg.Pool({ connectionString: clean, ssl, max: 3, idleTimeoutMillis: 10000, connectionTimeoutMillis: 8000, options });
  return pool;
}

async function q(text, params = []) {
  return getPool().query(text, params);
}

// Verplaatst in één keer (één opdracht = alles of niets). Een tabel die al in het doelschema staat,
// blijft staan: nooit iets overschrijven. Indexen en de teller van rpb_log gaan automatisch mee.
async function migrateTables(from, to) {
  const list = RPB_TABLES.map((t) => `'${t}'`).join(",");
  await q(`DO $mig$ DECLARE t text; moved int := 0; BEGIN
    EXECUTE 'CREATE SCHEMA IF NOT EXISTS ${to}';
    FOREACH t IN ARRAY ARRAY[${list}] LOOP
      IF to_regclass('${from}.' || t) IS NOT NULL AND to_regclass('${to}.' || t) IS NULL THEN
        EXECUTE format('ALTER TABLE %I.%I SET SCHEMA %I', '${from}', t, '${to}');
        moved := moved + 1;
      END IF;
    END LOOP;
    RAISE NOTICE 'rpb: % tabellen verplaatst van ${from} naar ${to}', moved;
  END $mig$`);
  console.log(`rpb: tabellen gecontroleerd/verplaatst van ${from} naar ${to}`);
}

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      // Nooit in de testomgeving: anders zou productie naar het testschema kunnen verhuizen
      if (PG_SCHEMA && PG_MIGRATE_FROM && PG_MIGRATE_FROM !== PG_SCHEMA && process.env.APP_ENV !== "test") await migrateTables(PG_MIGRATE_FROM, PG_SCHEMA);
      // Snelle start: is het schema al bijgewerkt, dan alle CREATE/ALTER-opdrachten overslaan
      try {
        const v = await q("SELECT value FROM rpb_settings WHERE key = '_schema'");
        if (v.rows[0]?.value === SCHEMA_VERSION) return;
      } catch { /* tabel bestaat nog niet: hieronder aanmaken */ }
      if (PG_SCHEMA) await q(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}`);
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
      await q("ALTER TABLE rpb_users ADD COLUMN IF NOT EXISTS exempt BOOLEAN NOT NULL DEFAULT FALSE");
      await q("ALTER TABLE rpb_users ADD COLUMN IF NOT EXISTS must_change BOOLEAN NOT NULL DEFAULT FALSE");
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
      // Versienummer per document: een wijziging lukt alleen op de versie die je hebt gelezen
      await q("ALTER TABLE rpb_docs ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0");
      // Pogingen per netwerkadres (inloggen, aanmelden), tegen het raden van codes
      await q(`CREATE TABLE IF NOT EXISTS rpb_attempts (
        kind TEXT NOT NULL,
        ip TEXT NOT NULL,
        at TIMESTAMPTZ NOT NULL
      )`);
      await q("CREATE INDEX IF NOT EXISTS rpb_attempts_idx ON rpb_attempts (kind, ip, at)");
      // Meldingen "code vergeten": de beheerder stelt een tijdelijke code in
      await q(`CREATE TABLE IF NOT EXISTS rpb_resets (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        contact TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL,
        handled_at TIMESTAMPTZ,
        handled_by TEXT
      )`);
      await q("ALTER TABLE rpb_resets ADD COLUMN IF NOT EXISTS token_hash TEXT");
      await q("ALTER TABLE rpb_resets ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ");
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
      // FoodSource API v1: sleutels per bedrijf, gebeurtenissen (webhooks) en webhookadres
      await q(`CREATE TABLE IF NOT EXISTS rpb_api_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        scopes TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        last_used_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ
      )`);
      await q("CREATE INDEX IF NOT EXISTS rpb_api_keys_user ON rpb_api_keys (user_id)");
      await q(`CREATE TABLE IF NOT EXISTS rpb_events (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        delivered_at TIMESTAMPTZ,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        next_attempt_at TIMESTAMPTZ
      )`);
      await q("CREATE INDEX IF NOT EXISTS rpb_events_user ON rpb_events (user_id, id)");
      await q("CREATE INDEX IF NOT EXISTS rpb_events_due ON rpb_events (next_attempt_at) WHERE delivered_at IS NULL AND next_attempt_at IS NOT NULL");
      await q("ALTER TABLE rpb_users ADD COLUMN IF NOT EXISTS webhook_url TEXT NOT NULL DEFAULT ''");
      await q("ALTER TABLE rpb_users ADD COLUMN IF NOT EXISTS webhook_secret TEXT NOT NULL DEFAULT ''");
      // Huisstijl: logo en app-iconen (apart van rpb_settings, die bij elk verzoek gelezen wordt)
      await q(`CREATE TABLE IF NOT EXISTS rpb_assets (
        key TEXT PRIMARY KEY,
        mime TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )`);
      await q("INSERT INTO rpb_settings (key, value) VALUES ('_schema', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [SCHEMA_VERSION]);
    })().catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

// ---------- helpers ----------
function httpError(status, message, extra) { const e = new Error(message); e.status = status; e.extra = extra; return e; }
const conflict = () => httpError(409, "Deze gegevens zijn net ergens anders gewijzigd. Probeer het opnieuw.", { conflict: true });

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
      "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "referrer-policy": "same-origin", ...extraHeaders,
    },
  });
}

// ---------- sessiecookie ----------
function sessionCookie(req, token) {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return token
    ? `${COOKIE}=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure}`
    : `${COOKIE}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}
function tokenFrom(req) {
  const m = (req.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`));
  if (m) return { token: m[1], via: "cookie" };
  const h = (req.headers.get("authorization") || "").match(/^Bearer ([a-f0-9]{64})$/); // oude versie van de app
  if (h) return { token: h[1], via: "bearer" };
  return null;
}
// Wijzigingen alleen vanaf onze eigen website (extra slot naast SameSite=Strict)
function checkOrigin(req) {
  const origin = req.headers.get("origin");
  if (!origin) return;
  let host = "";
  try { host = new URL(origin).host; } catch {}
  const allowed = new Set([new URL(req.url).host, req.headers.get("host") || ""]);
  for (const u of [process.env.SITE_URL, process.env.URL]) if (u) try { allowed.add(new URL(u).host); } catch {}
  if (!allowed.has(host)) throw httpError(403, "Verzoek van een andere website geweigerd.");
}

// ---------- pogingen per netwerkadres ----------
function clientIp(req) {
  return req.headers.get("x-nf-client-connection-ip")
    || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim()
    || "onbekend";
}
async function throttle(kind, ip, limit, minutes, msg) {
  const r = await q("SELECT COUNT(*)::int AS n FROM rpb_attempts WHERE kind = $1 AND ip = $2 AND at > $3",
    [kind, ip, new Date(Date.now() - minutes * 60000)]);
  if (Number(r.rows[0].n) >= limit) throw httpError(429, msg || `Te veel pogingen vanaf dit netwerk. Probeer het over ${minutes} minuten opnieuw.`);
}
async function attempt(kind, ip) {
  await q("INSERT INTO rpb_attempts (kind, ip, at) VALUES ($1, $2, $3)", [kind, ip, new Date()]);
  if (Math.random() < 0.05) await q("DELETE FROM rpb_attempts WHERE at < $1", [new Date(Date.now() - 86400000)]);
}

const MAX_BODY_BYTES = 1536 * 1024; // ruim genoeg voor een foto (groot + miniatuur) in base64
async function readBody(req) {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > MAX_BODY_BYTES) throw httpError(413, "Te veel gegevens in één keer.");
  let text = "";
  try { text = await req.text(); } catch { return {}; }
  if (text.length > MAX_BODY_BYTES) throw httpError(413, "Te veel gegevens in één keer.");
  try { const b = JSON.parse(text); return b && typeof b === "object" && !Array.isArray(b) ? b : {}; }
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
const WEAK_CODES = new Set(["wachtwoord123", "welkom123456", "password1234", "123456789012", "qwertyuiopas",
  "restpartijbeurs", "restpartijen", "aardappelen", "groenteenfruit", "wachtwoord1234", "welkom1234567"]);
function validCode(code) {
  if (typeof code !== "string" || code.length < MIN_CODE) {
    throw httpError(400, `De code moet minstens ${MIN_CODE} tekens hebben. Tip: een paar woorden achter elkaar, zoals "rode appels in de kist".`);
  }
  if (code.length > 100) throw httpError(400, "De code is te lang.");
  const low = code.toLowerCase();
  if (WEAK_CODES.has(low) || /^(.)\1+$/.test(code) || "01234567890123456789".includes(code) || "abcdefghijklmnopqrstuvwxyz".includes(low)) {
    throw httpError(400, "Deze code is te makkelijk te raden. Kies een andere.");
  }
  return code;
}

function publicUser(u) {
  return {
    id: u.id, name: u.name, company: u.company, contact: u.contact, role: u.role, active: u.active,
    pending: !!u.pending, kvk: u.kvk || "", email: u.email || "", note: u.note || "", exempt: !!u.exempt,
    mustChange: !!u.must_change,
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
  autoApprovePaid: "false",        // aanvraag automatisch goedkeuren na online betaling
  requireSubscription: "true",     // zonder geldig abonnement niet aanbieden/bieden
  apiEnabled: "false",             // FoodSource API v1 voor koppelingen met ERP-systemen
  aiEnabled: "false",              // velden van een partij laten invullen op basis van een foto
  logoVersion: "",                 // leeg = geen eigen logo; anders wisselt de waarde bij elk nieuw logo
  logoShowName: "true",            // naam van de website naast het logo tonen
  logoBg: "#ffffff",               // achtergrondkleur van het app-icoon
  reasonCodes: JSON.stringify([    // redenen bij het intrekken van een advertentie
    { code: "VERK", label: "Buiten het platform verkocht", active: true, needsNote: false },
    { code: "KWAL", label: "Kwaliteit niet meer goed", active: true, needsNote: false },
    { code: "HOUD", label: "Houdbaarheid verlopen", active: true, needsNote: false },
    { code: "FOUT", label: "Fout in de advertentie", active: true, needsNote: false },
    { code: "ANDR", label: "Anders", active: true, needsNote: true },
  ]),
};
// ---------- huisstijl: logo en app-iconen ----------
// Adres → sleutel in rpb_assets. De browser maakt de iconen zelf (vierkant, met achtergrondkleur) uit het logo.
const BRAND_FILES = { logo: "logo", "icon-512.png": "icon512", "icon-192.png": "icon192", "icon-180.png": "icon180", "icon-32.png": "icon32" };
const ICON_SIZES = { icon512: 512, icon192: 192, icon180: 180, icon32: 32 };
const MAX_LOGO_BYTES = 600 * 1024;
// Alleen echte PNG-, JPEG- of WebP-bestanden (geen SVG: daar kan code in zitten)
function parseImage(dataUrl, { max, png = false, size = 0 }) {
  const m = typeof dataUrl === "string" && dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m || (png && m[1] !== "image/png")) throw httpError(400, png ? "Het app-icoon moet een PNG-bestand zijn." : "Gebruik een PNG-, JPEG- of WebP-bestand.");
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > max) throw httpError(413, "Het logo is te groot. Gebruik een kleiner bestand (maximaal 600 kB).");
  const isPng = buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47;
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isWebp = buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP";
  const ok = m[1] === "image/png" ? isPng : m[1] === "image/jpeg" ? isJpeg : isWebp;
  if (!ok) throw httpError(400, "Dit bestand is geen geldige afbeelding.");
  if (size && (buf.readUInt32BE(16) !== size || buf.readUInt32BE(20) !== size)) throw httpError(400, `Het app-icoon moet ${size} × ${size} pixels zijn.`);
  return { mime: m[1], b64: buf.toString("base64") };
}

function parseReasons(v) {
  try {
    const arr = JSON.parse(v);
    return Array.isArray(arr) ? arr.filter((r) => r && typeof r.code === "string").map((r) => ({
      code: String(r.code).toUpperCase().slice(0, 10), label: String(r.label || "").slice(0, 80), active: r.active !== false, needsNote: !!r.needsNote,
    })) : [];
  } catch { return []; }
}
function cleanReason(input, codes, { required }) {
  const code = typeof input?.code === "string" ? input.code.toUpperCase() : "";
  const active = codes.filter((r) => r.active);
  if (!code) { if (required && active.length) throw httpError(400, "Kies een reden voor het intrekken."); return null; }
  const rc = codes.find((r) => r.code === code);
  if (!rc || !rc.active) throw httpError(400, "Deze reden bestaat niet (meer). Kies een andere reden.");
  const note = str(input.note, 300);
  if (rc.needsNote && !note) throw httpError(400, `Licht de reden "${rc.label}" kort toe.`);
  return { code: rc.code, label: rc.label, note, at: new Date().toISOString() };
}
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
    autoApprovePaid: s.autoApprovePaid === "true",
    requireSubscription: s.requireSubscription !== "false",
    apiEnabled: s.apiEnabled === "true",
    aiEnabled: s.aiEnabled === "true" && aiConfigured(),
    aiSwitch: s.aiEnabled === "true",
    aiConfigured: aiConfigured(),
    aiModel: aiConfigured() ? aiModel() : "",
    reasonCodes: parseReasons(s.reasonCodes),
    logoVersion: /^[a-f0-9]{8,16}$/.test(s.logoVersion) ? s.logoVersion : "",
    logoShowName: s.logoShowName !== "false",
    logoBg: /^#[0-9a-f]{6}$/i.test(s.logoBg) ? s.logoBg.toLowerCase() : "#ffffff",
    onlinePayment: !!process.env.MOLLIE_API_KEY,
    paymentTestMode: String(process.env.MOLLIE_API_KEY || "").startsWith("test_"),
    mailEnabled: mailEnabled(),
    mailProvider: mailProvider(),
    environment: process.env.APP_ENV === "test" ? "test" : "prod",
    wipeAllowed: wipeAllowed(),
  };
}

// Leegmaken mag standaard alleen in de testomgeving
function wipeAllowed() { return process.env.APP_ENV === "test" || process.env.ALLOW_WIPE === "true"; }
const TRADE_TABLES = ["rpb_docs", "rpb_photos", "rpb_events"];
const ALL_TABLES = ["rpb_docs", "rpb_photos", "rpb_assets", "rpb_events", "rpb_api_keys", "rpb_payments", "rpb_mollie", "rpb_log", "rpb_settings", "rpb_attempts", "rpb_resets", "rpb_sessions", "rpb_users"];

// ---------- e-mail: via Gmail (SMTP) of via Brevo ----------
const MAIL_BASE = process.env.MAIL_API_BASE || "https://api.brevo.com/v3";
const isEmail = (x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x || "");
function mailProvider() {
  if (isEmail(process.env.GMAIL_USER) && process.env.GMAIL_APP_PASSWORD) return "gmail";
  if (process.env.BREVO_API_KEY && isEmail(process.env.MAIL_FROM)) return "brevo";
  return "";
}
function mailEnabled() { return !!mailProvider(); }
function mailFromAddress() { return mailProvider() === "gmail" ? process.env.GMAIL_USER : process.env.MAIL_FROM; }

// Eenvoudige SMTP-client (TLS op poort 465), zonder extra pakketten
const b64 = (t) => Buffer.from(String(t), "utf8").toString("base64");
const wrap76 = (t) => t.replace(/.{1,76}/g, "$&\r\n");
const encWord = (t) => (/^[\x20-\x7e]*$/.test(t) ? t : `=?UTF-8?B?${b64(t)}?=`);
function smtpSend({ host, port, user, pass, from, fromName, to, subject, text, html }) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, servername: host, rejectUnauthorized: process.env.MAIL_SMTP_INSECURE !== "true" });
    sock.setTimeout(15000, () => { sock.destroy(); reject(httpError(502, "De mailserver reageert niet.")); });
    let buf = "", waiter = null;
    sock.setEncoding("utf8");
    sock.on("data", (d) => {
      buf += d;
      const lines = buf.split("\r\n");
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i])) { const reply = lines.slice(0, i + 1).join("\n"); buf = lines.slice(i + 1).join("\r\n"); const w = waiter; waiter = null; if (w) w(reply); return; }
      }
    });
    sock.on("error", (e) => { console.error("smtp", e); reject(httpError(502, "De mailserver is niet bereikbaar.")); });
    const read = () => new Promise((r) => (waiter = r));
    const step = async (cmd, ok) => {
      if (cmd !== null) sock.write(cmd + "\r\n");
      const reply = await read();
      if (!String(reply).startsWith(String(ok))) {
        const code = reply.slice(0, 3);
        throw httpError(502, code === "535" ? "Gmail weigerde het inloggen. Controleer GMAIL_USER en het app-wachtwoord." : "De mailserver weigerde het bericht (" + reply.slice(0, 120).replace(/\s+/g, " ") + ").");
      }
      return reply;
    };
    const boundary = "rpb" + crypto.randomBytes(8).toString("hex");
    const msg = [
      `From: ${encWord(fromName)} <${from}>`, `To: <${to}>`, `Subject: ${encWord(subject)}`,
      `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomBytes(12).toString("hex")}@${from.split("@")[1]}>`,
      "MIME-Version: 1.0", `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
      `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap76(b64(text)),
      `--${boundary}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap76(b64(html)),
      `--${boundary}--`, "",
    ].join("\r\n");
    (async () => {
      await step(null, 220);
      await step("EHLO restpartijbeurs", 250);
      await step("AUTH PLAIN " + Buffer.from(`\0${user}\0${pass}`).toString("base64"), 235);
      await step(`MAIL FROM:<${from}>`, 250);
      await step(`RCPT TO:<${to}>`, 250);
      await step("DATA", 354);
      await step(msg + "\r\n.", 250);
      sock.write("QUIT\r\n"); sock.end();
      resolve();
    })().catch((e) => { sock.destroy(); reject(e); });
  });
}
const escHtml = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
async function sendMail({ to, toName, subject, text, html }) {
  const provider = mailProvider();
  if (!provider) throw httpError(503, "E-mail is nog niet ingesteld (GMAIL_USER en GMAIL_APP_PASSWORD in Netlify).");
  if (/[\r\n<>]/.test(to)) throw httpError(400, "Ongeldig e-mailadres.");
  const st = await getSettings(), siteName = st.siteName;
  // Logo bovenaan de HTML-mail (alleen als de site een vast adres heeft; mailprogramma's laden het van onze server)
  const base = publicUrl();
  if (html && st.logoVersion && /^https:\/\//.test(base)) {
    html = `<p style="margin:0 0 16px"><img src="${base}/api/brand/logo?v=${st.logoVersion}" alt="${escHtml(siteName)}" style="max-height:56px;max-width:240px;height:auto"></p>` + html;
  }
  if (provider === "gmail") {
    return smtpSend({
      host: process.env.MAIL_SMTP_HOST || "smtp.gmail.com", port: Number(process.env.MAIL_SMTP_PORT) || 465,
      user: process.env.GMAIL_USER, pass: String(process.env.GMAIL_APP_PASSWORD).replace(/\s+/g, ""),
      from: process.env.GMAIL_USER, fromName: process.env.MAIL_FROM_NAME || siteName, to, subject, text, html,
    });
  }
  let res;
  try {
    res = await fetch(MAIL_BASE + "/smtp/email", {
      method: "POST",
      headers: { "api-key": process.env.BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { email: process.env.MAIL_FROM, name: process.env.MAIL_FROM_NAME || siteName },
        to: [{ email: to, ...(toName ? { name: toName } : {}) }],
        subject, textContent: text, htmlContent: html,
      }),
    });
  } catch (e) { console.error("mail", e); throw httpError(502, "De e-maildienst is niet bereikbaar."); }
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    console.error("mail", res.status, d);
    throw httpError(502, "De e-maildienst weigerde het bericht: " + (d.message || res.status));
  }
}
// E-mailadres dat bij het account hoort: het e-mailveld, anders een adres in het contactveld
function accountEmail(u) {
  if (validEmail(u.email || "")) return u.email;
  const m = String(u.contact || "").match(/[^\s@\/,;]+@[^\s@\/,;]+\.[^\s@\/,;]+/);
  return m ? m[0] : "";
}
const RESET_MINUTES = 60;

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
// Adres van deze omgeving voor links in e-mails, Mollie en de API. SITE_URL gaat voor: Netlify geeft ook een
// testomgeving (branch deploy) het adres van productie mee in URL, en dan zouden links naar de echte site wijzen.
function publicUrl() { return String(process.env.SITE_URL || process.env.URL || "").trim().replace(/\/$/, ""); }
function siteUrl(req) { return publicUrl() || new URL(req.url).origin.replace(/\/$/, ""); }

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
      const start = curUntil && curUntil >= t ? curUntil : t; // vroeg verlengen: aansluiten op huidige einddatum
      validUntil = addYear(start);
      const label = { ideal: "iDEAL", wero: "Wero", bancontact: "Bancontact", creditcard: "creditcard" }[p.method] || p.method || "online";
      const note = `Online via ${label} (${row.mollie_id}), incl. btw € ${centsToValue(row.amount_incl).replace(".", ",")}`;
      await q(`INSERT INTO rpb_payments (id, user_id, amount_cents, paid_on, valid_until, note, created_by, created_at, mollie_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (mollie_id) WHERE mollie_id IS NOT NULL DO NOTHING`,
        [newId("b"), row.user_id, row.amount_excl, t, validUntil, note, "mollie", new Date(), row.mollie_id]);
      const ur = await q("SELECT id, name, company, pending FROM rpb_users WHERE id = $1", [row.user_id]);
      const u = ur.rows[0];
      await log(u || null, "betaling", `Abonnement online betaald via ${label}: ${euro(row.amount_excl / 100)} excl. btw, geldig t/m ${validUntil}`);
      if (u?.pending && (await getSettings()).autoApprovePaid) {
        await q("UPDATE rpb_users SET pending = FALSE, active = TRUE WHERE id = $1 AND pending = TRUE", [u.id]);
        await log(u, "account", "Aanvraag automatisch goedgekeurd na online betaling");
      }
    }
  }
  const ar = await q("SELECT pending, active FROM rpb_users WHERE id = $1", [row.user_id]);
  return { status, validUntil, approved: !!(ar.rows[0] && !ar.rows[0].pending && ar.rows[0].active) };
}

// Mollie-betaling aanmaken voor een gebruiker; geeft de betaalpagina terug
async function createSubscriptionPayment(req, user, returnParam) {
  const s = await getSettings();
  if (!s.subscriptionPrice) throw httpError(400, "Er is geen abonnementsprijs ingesteld.");
  const excl = s.subscriptionPrice;
  const incl = Math.round(excl * (1 + (s.vatPercent || 0) / 100));
  const ref = "m" + crypto.randomBytes(12).toString("hex");
  const base = siteUrl(req);
  const body = {
    amount: { currency: "EUR", value: centsToValue(incl) },
    description: `${s.siteName} abonnement ${user.company || user.name}`.slice(0, 255),
    redirectUrl: `${base}/?${returnParam}=${ref}`,
    webhookUrl: `${base}/api/mollie/webhook`,
    metadata: { ref, userId: user.id },
    locale: "nl_NL",
  };
  if (s.payMethods.length === 1) body.method = s.payMethods[0];
  else if (s.payMethods.length > 1) body.method = s.payMethods;
  const now = new Date();
  await q("INSERT INTO rpb_mollie (ref, user_id, amount_excl, amount_incl, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $6)",
    [ref, user.id, excl, incl, "created", now]);
  const p = await mollie("/payments", { method: "POST", body });
  await q("UPDATE rpb_mollie SET mollie_id = $2, status = $3, updated_at = $4 WHERE ref = $1", [ref, p.id, p.status || "open", new Date()]);
  const checkout = p._links?.checkout?.href;
  if (!checkout) throw httpError(502, "Mollie gaf geen betaalpagina terug.");
  await log(user, "betaling", `Online betaling gestart: € ${centsToValue(incl).replace(".", ",")} incl. btw`);
  return { checkoutUrl: checkout, ref };
}
// Middernacht in Nederlandse tijd (zomer- en wintertijd) als tijdstip
function amsMidnight(d) {
  const guess = new Date(d + "T00:00:00Z");
  const local = new Date(guess.toLocaleString("en-US", { timeZone: "Europe/Amsterdam" }));
  const utc = new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(guess.getTime() - (local - utc));
}
function addDay(d) { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); }

// Bedrag als tekst in euro's ("120", "120,50", "1.200,00", "€ 120") → hele centen, of null
function parseEuroText(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? Math.round(raw * 100) : null;
  let t = String(raw ?? "").replace(/[€\s]/g, "");
  if (!t) return null;
  if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}
// Datum van vandaag in Nederland (niet UTC), zodat "houdbaar tot" en abonnementen om middernacht NL wisselen
const AMS_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit" });
const today = () => AMS_DATE.format(new Date());
const validDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
// Einddatum abonnement = datum + 12 maanden (29 februari wordt 28 februari)
function addYear(d) {
  const [y, m, day] = d.split("-").map(Number);
  const last = new Date(Date.UTC(y + 1, m, 0)).getUTCDate();
  return `${y + 1}-${String(m).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

// Mag deze gebruiker handelen (aanbieden, bieden, gunnen, foto's plaatsen)?
async function subscriptionStatus(user) {
  const s = await getSettings();
  const r = await q("SELECT to_char(MAX(valid_until), 'YYYY-MM-DD') AS u FROM rpb_payments WHERE user_id = $1", [user.id]);
  const paidUntil = r.rows[0]?.u || null;
  const required = s.requireSubscription && s.subscriptionPrice > 0;
  const exempt = user.role === "beheerder" || !!user.exempt;
  const valid = !!paidUntil && paidUntil >= today();
  return { paidUntil, required, exempt, valid, canTrade: !required || exempt || valid, settings: s };
}
async function requireTrade(user) {
  const st = await subscriptionStatus(user);
  if (!st.canTrade) {
    throw httpError(402, st.paidUntil
      ? `Je abonnement is verlopen op ${st.paidUntil.split("-").reverse().join("-")}. Betaal je abonnement om weer te kunnen aanbieden en bieden.`
      : "Je hebt nog geen abonnement. Betaal je abonnement om te kunnen aanbieden en bieden.");
  }
}

// Wijzigingen in partijen en biedingen omzetten naar regels voor het logboek
function describeLots(prev, next, names) {
  const out = [];
  const a = (prev && prev.items) || {}, b = (next && next.items) || {};
  const label = (it) => `${it.product || "partij"}${it.ras ? " " + it.ras : ""}`;
  for (const [id, it] of Object.entries(b)) {
    const old = a[id];
    if (!old) { out.push(["partij", `Partij aangeboden: ${label(it)}, ${it.qty} ${it.unit} à ${euro(it.price)}`]); continue; }
    let said = false;
    if (old.status !== it.status && it.status === "ingetrokken") {
      const wr = it.withdrawReason;
      out.push(["partij", `Partij ingetrokken: ${label(it)}${wr ? ` — reden ${wr.code} ${wr.label}${wr.note ? ": " + wr.note : ""}` : ""}`]); said = true;
    }
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
  const t = tokenFrom(req);
  if (!t) throw httpError(401, "Log opnieuw in.");
  const r = await q(
    `SELECT u.* FROM rpb_sessions s JOIN rpb_users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > $2`,
    [sha256(t.token), new Date()]
  );
  const u = r.rows[0];
  if (!u || !u.active) throw httpError(401, "Log opnieuw in.");
  u._token = t.token; u._via = t.via;
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

async function insertUser({ name, company, contact, code, role, pending = false, kvk = "", email = "", note = "", mustChange = false }) {
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
    `INSERT INTO rpb_users (id, name, name_key, company, contact, role, active, salt, hash, failed, created_at, pending, kvk, email, note, must_change)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, $10, $11, $12, $13, $14, $15)`,
    [user.id, user.name, key, user.company, user.contact, user.role, user.active, salt, hashCode(code, salt), new Date(),
     user.pending, user.kvk, user.email, user.note, !!mustChange]
  );
  return publicUser({ ...user, must_change: !!mustChange, created_at: new Date() });
}


// ---------- documenten: lezen met versie, schrijven alleen op die versie ----------
async function readDoc(collection, id) {
  const r = await q("SELECT data, version FROM rpb_docs WHERE collection = $1 AND id = $2", [collection, id]);
  const row = r.rows[0];
  return row ? { data: row.data || null, version: Number(row.version) || 0, exists: true } : { data: null, version: 0, exists: false };
}
// Schrijft alleen als niemand het document intussen heeft gewijzigd; anders null.
async function writeDocAt(collection, id, cur, data, by) {
  const text = data === null ? null : JSON.stringify(data);
  const now = new Date();
  const r = cur.exists
    ? await q(`UPDATE rpb_docs SET data = $3::jsonb, updated_at = $4, updated_by = $5, version = version + 1
        WHERE collection = $1 AND id = $2 AND version = $6 RETURNING version`, [collection, id, text, now, by, cur.version])
    : await q(`INSERT INTO rpb_docs (collection, id, data, updated_at, updated_by, version) VALUES ($1, $2, $3::jsonb, $4, $5, 1)
        ON CONFLICT (collection, id) DO NOTHING RETURNING version`, [collection, id, text, now, by]);
  return r.rows[0] ? { version: Number(r.rows[0].version), at: now } : null;
}

// ---------- controle van partijen (door de server, niet door de browser) ----------
const UNITS = ["colli", "kg", "pallets", "kisten", "zakken"];
const CATEGORIES = ["Groente", "Fruit", "Aardappelen"];
const KLASSEN = ["Klasse I", "Klasse II", "Industrie / verwerking", "Biologisch Klasse I", "Biologisch Klasse II"];
const LOT_TEXT = { externalId: 80, gtin: 14, gln: 13, product: 80, ras: 80, category: 40, klasse: 40, origin: 60, location: 80, unit: 20, pack: 120, note: 1000, company: 120, contact: 120 };
const num = (v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.replace(",", ".")) : NaN);
const isoOr = (v, d) => (typeof v === "string" && !isNaN(Date.parse(v)) ? new Date(v).toISOString() : d);
const sumQty = (acc) => Object.values(acc || {}).reduce((s, a) => s + (Number(a?.qty) || 0), 0);

async function normalizeLots(me, prev, data) {
  const raw = data.items && typeof data.items === "object" && !Array.isArray(data.items) ? data.items : {};
  const ids = Object.keys(raw);
  if (ids.length > 1000) throw httpError(413, "Te veel partijen in één keer.");
  const old = prev?.items || {};
  const nowIso = new Date().toISOString();
  const codes = (await getSettings()).reasonCodes;
  const pr = await q("SELECT id, created_at FROM rpb_photos WHERE owner = $1", [me.id]);
  const ownPhotos = new Map(pr.rows.map((r) => [r.id, new Date(r.created_at)]));
  const bidDocs = new Map();
  const offerOf = async (bidder, lotId) => {
    if (!bidDocs.has(bidder)) bidDocs.set(bidder, (await readDoc("bids", bidder)).data);
    return bidDocs.get(bidder)?.offers?.[lotId] || null;
  };
  const items = {};
  for (const id of ids) {
    const it0 = raw[id], was = old[id];
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || !it0 || typeof it0 !== "object" || Array.isArray(it0)) throw httpError(400, "Ongeldige partij.");
    const it = {};
    for (const [k, max] of Object.entries(LOT_TEXT)) it[k] = str(it0[k], max);
    const name = it.product || "partij";
    if (!it.product) throw httpError(400, "Vul bij elke partij een product in.");
    // Vaste keuzelijsten; een bestaande waarde die niet verandert laten we staan (oude partijen)
    const changed = (k) => !was || was[k] !== it[k];
    if (changed("unit") && !UNITS.includes(it.unit)) throw httpError(400, `Ongeldige eenheid bij ${name}.`);
    if (changed("category") && !CATEGORIES.includes(it.category)) throw httpError(400, `Ongeldige categorie bij ${name}.`);
    if (changed("klasse") && it.klasse && !KLASSEN.includes(it.klasse)) throw httpError(400, `Ongeldige klasse bij ${name}.`);
    it.qty = num(it0.qty);
    if (!(it.qty > 0 && it.qty <= 1e7)) throw httpError(400, `Ongeldige hoeveelheid bij ${name}.`);
    it.price = num(it0.price);
    if (!(it.price >= 0 && it.price <= 1e6)) throw httpError(400, `Ongeldige prijs bij ${name}.`);
    const minQty = num(it0.minQty);
    it.minQty = minQty > 0 ? Math.min(minQty, it.qty) : null;
    const kg = num(it0.kgPerUnit);
    it.kgPerUnit = kg > 0 && kg <= 100000 ? kg : null;
    it.until = validDate(it0.until) ? it0.until : "";
    // Foto's: alleen eigen foto's, maximaal 3
    const photos = Array.isArray(it0.photos) ? it0.photos.filter((x) => typeof x === "string").slice(0, 3) : [];
    for (const ph of photos) if (!ownPhotos.has(ph) && !(was?.photos || []).includes(ph)) throw httpError(403, "Je kunt alleen je eigen foto's gebruiken.");
    it.photos = photos;
    it.createdAt = was?.createdAt || nowIso;
    it.updatedAt = isoOr(it0.updatedAt, nowIso);

    // Gunningen: bestaande blijven precies zoals ze zijn, nieuwe controleert de server zelf
    const accepted = { ...(was?.accepted || {}) };
    let sold = sumQty(accepted);
    const wantsWithdraw = it0.status === "ingetrokken";
    for (const bidder of Object.keys(it0.accepted && typeof it0.accepted === "object" ? it0.accepted : {})) {
      if (accepted[bidder]) continue;
      if (bidder === me.id) throw httpError(400, "Je kunt niet aan jezelf gunnen.");
      if (wantsWithdraw || was?.status === "ingetrokken") throw httpError(409, "Een ingetrokken partij kun je niet gunnen.");
      const offer = await offerOf(bidder, id);
      if (!offer || offer.sellerId !== me.id) throw httpError(409, "Dit bod bestaat niet meer. De pagina wordt ververst.", { conflict: true });
      const rem = it.qty - sold;
      if (rem <= 0) throw httpError(409, `${name} is al volledig gegund.`);
      const gq = Math.min(num(offer.qty) || 0, rem);
      if (!(gq > 0)) throw httpError(409, "Dit bod heeft geen geldige hoeveelheid.");
      accepted[bidder] = { qty: gq, price: num(offer.price) || 0, at: nowIso };
      sold += gq;
    }
    if (sold > it.qty) throw httpError(400, `Van ${name} is al ${sold} ${it.unit} gegund. De hoeveelheid kan niet lager zijn.`);
    if (Object.keys(accepted).length) it.accepted = accepted;
    it.remaining = Math.round((it.qty - sold) * 1000) / 1000;

    // Afwijzingen: alleen toevoegen, met het tijdstip van de server
    const rejected = { ...(was?.rejected || {}) };
    for (const bidder of Object.keys(it0.rejected && typeof it0.rejected === "object" ? it0.rejected : {})) {
      if (!rejected[bidder] && !accepted[bidder] && bidder !== me.id && /^[A-Za-z0-9_-]{1,40}$/.test(bidder)) rejected[bidder] = { at: nowIso };
    }
    if (Object.keys(rejected).length) it.rejected = rejected;

    // Status volgt uit de cijfers; intrekken vraagt een reden
    if (was?.status === "ingetrokken" && was.withdrawReason?.by === "beheer" && !wantsWithdraw) {
      throw httpError(403, `${name} is door de beheerder ingetrokken. Neem contact op met de beheerder.`);
    }
    it.status = wantsWithdraw ? "ingetrokken" : it.remaining <= 0 ? "verkocht" : "open";
    if (wantsWithdraw) {
      it.withdrawReason = was?.status === "ingetrokken" ? was.withdrawReason : cleanReason(it0.withdrawReason, codes, { required: true });
      if (!it.withdrawReason) delete it.withdrawReason;
    }
    items[id] = it;
  }
  // Eigen ERP-nummer (externalId, via de API) is uniek per bedrijf
  const seenExt = new Set();
  for (const it of Object.values(items)) {
    if (!it.externalId) continue;
    if (seenExt.has(it.externalId)) throw httpError(409, `Het ERP-nummer ${it.externalId} komt bij twee partijen voor.`);
    seenExt.add(it.externalId);
  }
  // Een partij verdwijnt nooit via opslaan vanuit de browser (de app heeft daar geen knop voor).
  // Ontbreekt er een, dan is de browser verouderd: weigeren en opnieuw laten ophalen.
  // Verwijderen kan alleen de beheerder, via Beheer → Restpartijen.
  for (const [id, was] of Object.entries(old)) {
    if (!items[id]) {
      throw httpError(409, Object.keys(was?.accepted || {}).length
        ? `${was.product || "Deze partij"} heeft al gunningen en kan niet worden verwijderd. Trek hem in.`
        : `${was.product || "Een partij"} ontbreekt in wat je browser stuurde. De pagina wordt ververst; probeer het daarna opnieuw.`, { conflict: true });
    }
  }
  return { out: { company: str(data.company, 120), contact: str(data.contact, 120), items }, ownPhotos };
}

// ---------- controle van biedingen ----------
async function normalizeBids(me, prev, data) {
  const raw = data.offers && typeof data.offers === "object" && !Array.isArray(data.offers) ? data.offers : {};
  if (Object.keys(raw).length > 1000) throw httpError(413, "Te veel biedingen in één keer.");
  const old = prev?.offers || {};
  const lotDocs = new Map();
  const lotOf = async (seller, lotId) => {
    if (!lotDocs.has(seller)) lotDocs.set(seller, (await readDoc("lots", seller)).data);
    return lotDocs.get(seller)?.items?.[lotId] || null;
  };
  const t = today();
  const offers = {};
  for (const [lotId, o] of Object.entries(raw)) {
    if (!o || typeof o !== "object") continue;
    const was = old[lotId];
    const sellerId = str(o.sellerId, 40);
    const price = num(o.price), qty = num(o.qty), note = str(o.note, 500);
    // Ongewijzigd bod: laten staan zoals het was (ook als de partij intussen dicht is)
    if (was && was.sellerId === sellerId && was.price === price && was.qty === qty && (was.note || "") === note) { offers[lotId] = was; continue; }
    if (was && was.sellerId !== sellerId) throw httpError(400, "Ongeldig bod.");
    if (!sellerId || sellerId === me.id) throw httpError(400, "Je kunt niet op je eigen partij bieden.");
    const l = await lotOf(sellerId, lotId);
    if (!l) throw httpError(409, "Deze partij bestaat niet meer.", { conflict: true });
    if (l.accepted?.[me.id] || l.rejected?.[me.id]) throw httpError(409, "Je bod op deze partij is al gegund of afgewezen en kan niet meer worden gewijzigd.");
    const rem = l.remaining ?? l.qty;
    if (l.status === "ingetrokken" || l.status === "verkocht" || !(rem > 0) || (l.until && l.until < t)) {
      throw httpError(409, `${l.product || "Deze partij"} is niet meer beschikbaar.`, { conflict: true });
    }
    if (!(price > 0 && price <= 1e6)) throw httpError(400, "Vul een geldige prijs in.");
    const min = Math.min(l.minQty || 1, rem);
    if (!(qty >= min)) throw httpError(400, `Bied minimaal ${min} ${l.unit || ""}.`.trim());
    if (qty > rem) throw httpError(409, `Er is nog maar ${rem} ${l.unit || ""} beschikbaar.`.trim(), { conflict: true });
    offers[lotId] = { sellerId, product: str(l.product, 80), price, qty, note, at: new Date().toISOString() };
  }
  return { company: str(data.company, 120), contact: str(data.contact, 120), offers };
}

// ---------- wat ziet wie? ----------
// Een handelaar ziet van anderen niet wie wat geboden heeft of aan wie tegen welke prijs is gegund,
// alleen de biedingen op zijn eigen partijen en zijn eigen gunningen.
function lotsView(me, ownerId, data) {
  if (!data || me.role === "beheerder" || ownerId === me.id) return data;
  const items = {};
  for (const [id, it] of Object.entries(data.items || {})) {
    const { accepted, rejected, withdrawReason, ...rest } = it || {};
    const x = { ...rest };
    if (accepted?.[me.id]) x.accepted = { [me.id]: accepted[me.id] };
    if (rejected?.[me.id]) x.rejected = { [me.id]: rejected[me.id] };
    items[id] = x;
  }
  return { ...data, items };
}
function bidsView(me, bidderId, data) {
  if (!data || me.role === "beheerder" || bidderId === me.id) return data;
  const offers = {};
  for (const [id, o] of Object.entries(data.offers || {})) if (o && o.sellerId === me.id) offers[id] = o;
  return { company: data.company || "", contact: data.contact || "", offers };
}

// ---------- FoodSource API v1 ----------
const AI = createAi({ q, httpError, log, today });
const V1 = createV1({ q, readDoc, writeDocAt, normalizeLots, describeLots, getSettings, requireTrade, log, today, validDate, siteUrl, json, MAX_DOC_BYTES });

// ---------- routes ----------
async function route(req, ctx = {}) {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const method = req.method.toUpperCase();
  const [a, b, c] = parts;

  await ensureSchema();
  const ip = clientIp(req);
  const isWebhook = a === "mollie" && b === "webhook";
  if (method !== "GET" && !isWebhook) checkOrigin(req);

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
    await throttle("setup", ip, 10, 15);
    const given = str(body.setupCode, 200);
    const ok = given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (!ok) { await attempt("setup", ip); throw httpError(403, "De installatiecode klopt niet."); }
    const user = await insertUser({ ...body, role: "beheerder", mustChange: false });
    const token = await createSession(user.id);
    await log(user, "account", "Eerste beheerder aangemaakt");
    return json(200, { user }, { "set-cookie": sessionCookie(req, token) });
  }

  // Account aanvragen (zonder login). Het account staat uit tot een beheerder het goedkeurt.
  if (a === "register" && method === "POST") {
    const body = await readBody(req);
    if (str(body.website, 200)) return json(200, { ok: true }); // honeypot: bots vullen dit verborgen veld in
    await throttle("register", ip, 5, 60, "Er zijn vanaf dit netwerk al meerdere aanvragen gedaan. Probeer het over een uur opnieuw.");
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
    await attempt("register", ip);
    await log(nu, "account", `Account aangevraagd (KvK ${kvk})`);
    if (body.payNow) {
      const s = await getSettings();
      if (s.onlinePayment && s.subscriptionPrice > 0) {
        try { return json(200, { ok: true, ...(await createSubscriptionPayment(req, nu, "aanvraag")) }); }
        catch (e) { return json(200, { ok: true, payError: e.message }); } // aanvraag staat er wel; betalen kan later
      }
    }
    return json(200, { ok: true });
  }

  // Status van een betaling bij een aanvraag (nog zonder login; de ref is willekeurig en niet te raden)
  if (a === "pay" && b === "request-status" && method === "GET") {
    const ref = str(url.searchParams.get("ref") || "", 40);
    if (!/^m[a-f0-9]{24}$/.test(ref)) throw httpError(404, "Betaling niet gevonden.");
    const st = await syncMollie(ref);
    if (!st) throw httpError(404, "Betaling niet gevonden.");
    return json(200, st);
  }

  // Code vergeten (zonder login). Het antwoord is altijd hetzelfde, zodat niemand
  // kan uitproberen welke namen bestaan. De beheerder ziet de melding onder Gebruikers.
  if (a === "forgot" && method === "POST") {
    const body = await readBody(req);
    const done = { ok: true };
    if (str(body.website, 200)) return json(200, done); // honeypot
    await throttle("forgot", ip, 5, 60, "Er zijn vanaf dit netwerk al meerdere meldingen gedaan. Probeer het over een uur opnieuw of neem contact op met de beheerder.");
    await attempt("forgot", ip);
    const contact = str(body.contact, 120), note = str(body.note, 300);
    if (!contact && !mailEnabled()) throw httpError(400, "Vul in hoe de beheerder je kan bereiken.");
    const r = await q("SELECT id, name, company, active, pending, email, contact FROM rpb_users WHERE name_key = $1", [nameKey(str(body.name, 60))]);
    const u = r.rows[0];
    // Met e-mail: een resetlink naar het adres dat al bij het account hoort (nooit naar een ingetypt adres)
    const to = u && u.active && !u.pending && mailEnabled() ? accountEmail(u) : "";
    if (to) {
      const recent = await q("SELECT COUNT(*)::int AS n FROM rpb_resets WHERE user_id = $1 AND token_hash IS NOT NULL AND created_at > $2", [u.id, new Date(Date.now() - 3600000)]);
      if (Number(recent.rows[0].n) >= 3) return json(200, done); // maximaal 3 mails per uur per account
      const token = crypto.randomBytes(32).toString("hex");
      await q("UPDATE rpb_resets SET handled_at = $2 WHERE user_id = $1 AND token_hash IS NOT NULL AND handled_at IS NULL", [u.id, new Date()]); // oude links ongeldig
      await q("INSERT INTO rpb_resets (id, user_id, contact, note, created_at, token_hash, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [newId("r"), u.id, to, "", new Date(), sha256(token), new Date(Date.now() + RESET_MINUTES * 60000)]);
      const s = await getSettings();
      const link = `${siteUrl(req)}/?herstel=${token}`;
      try {
        await sendMail({
          to, toName: u.name, subject: `${s.siteName}: nieuwe code instellen`,
          text: `Hallo ${u.name},\n\nJe hebt gevraagd om een nieuwe code voor ${s.siteName}. Open binnen ${RESET_MINUTES} minuten deze link om een nieuwe code te kiezen:\n\n${link}\n\nHeb je dit niet zelf gevraagd? Dan kun je deze e-mail negeren; je huidige code blijft gewoon werken.\n`,
          html: `<p>Hallo ${escHtml(u.name)},</p><p>Je hebt gevraagd om een nieuwe code voor ${escHtml(s.siteName)}. Klik binnen ${RESET_MINUTES} minuten op de knop om een nieuwe code te kiezen.</p>
<p><a href="${link}" style="display:inline-block;background:#a3204f;color:#ffffff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">Nieuwe code kiezen</a></p>
<p style="color:#666666;font-size:13px">Werkt de knop niet? Kopieer dan deze link: ${link}</p>
<p style="color:#666666;font-size:13px">Heb je dit niet zelf gevraagd? Dan kun je deze e-mail negeren; je huidige code blijft gewoon werken.</p>`,
        });
        await log(u, "account", "Resetlink voor nieuwe code gemaild");
        return json(200, done);
      } catch (e) {
        console.error("reset mail", e);
        await log(u, "account", "Resetlink mailen mislukt; melding naar beheerder");
      }
    }
    if (u && u.active && !u.pending) {
      const open = await q("SELECT id FROM rpb_resets WHERE user_id = $1 AND handled_at IS NULL AND token_hash IS NULL", [u.id]);
      if (open.rows[0]) await q("UPDATE rpb_resets SET contact = $2, note = $3, created_at = $4 WHERE id = $1", [open.rows[0].id, contact, note, new Date()]);
      else {
        const n = await q("SELECT COUNT(*)::int AS n FROM rpb_resets WHERE handled_at IS NULL AND token_hash IS NULL");
        if (Number(n.rows[0].n) < 100) await q("INSERT INTO rpb_resets (id, user_id, contact, note, created_at) VALUES ($1, $2, $3, $4, $5)", [newId("r"), u.id, contact, note, new Date()]);
      }
      await log(u, "account", `Code vergeten gemeld (bereikbaar via ${contact})`);
    }
    return json(200, done);
  }

  // Beheerder herstellen met de installatiecode (RPB_SETUP_CODE uit Netlify).
  // Voor als de enige beheerder zijn code kwijt is: alleen wie bij de Netlify-instellingen kan, kent die code.
  if (a === "recover" && method === "POST") {
    const body = await readBody(req);
    await throttle("recover", ip, 5, 15);
    const expected = process.env.RPB_SETUP_CODE || "";
    if (!expected) throw httpError(503, "Er is geen installatiecode ingesteld in Netlify (RPB_SETUP_CODE).");
    const given = str(body.setupCode, 200);
    const okCode = given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (!okCode) { await attempt("recover", ip); throw httpError(403, "De installatiecode klopt niet."); }
    const r = await q("SELECT * FROM rpb_users WHERE name_key = $1", [nameKey(str(body.name, 60))]);
    const u = r.rows[0];
    if (!u || u.role !== "beheerder" || u.pending) { await attempt("recover", ip); throw httpError(404, "Er is geen beheerder met deze naam."); }
    validCode(body.code);
    const salt = crypto.randomBytes(16).toString("hex");
    await q("UPDATE rpb_users SET salt = $2, hash = $3, failed = 0, locked_until = NULL, must_change = FALSE, active = TRUE WHERE id = $1", [u.id, salt, hashCode(body.code, salt)]);
    await q("DELETE FROM rpb_sessions WHERE user_id = $1", [u.id]); // overal uitloggen
    await log(u, "account", "Beheerderscode hersteld met de installatiecode");
    return json(200, { ok: true, name: u.name });
  }

  // Nieuwe code instellen met de link uit de e-mail
  if (a === "reset" && method === "POST") {
    const body = await readBody(req);
    await throttle("reset", ip, 20, 15);
    const token = str(body.token, 100);
    const bad = () => httpError(400, "Deze link is verlopen of al gebruikt. Vraag via 'Code vergeten?' een nieuwe aan.");
    if (!/^[a-f0-9]{64}$/.test(token)) { await attempt("reset", ip); throw bad(); }
    const r = await q("SELECT id, user_id FROM rpb_resets WHERE token_hash = $1 AND handled_at IS NULL AND expires_at > $2", [sha256(token), new Date()]);
    const row = r.rows[0];
    if (!row) { await attempt("reset", ip); throw bad(); }
    const ur = await q("SELECT * FROM rpb_users WHERE id = $1", [row.user_id]);
    const u = ur.rows[0];
    if (!u || !u.active || u.pending) throw bad();
    validCode(body.code);
    const salt = crypto.randomBytes(16).toString("hex");
    await q("UPDATE rpb_users SET salt = $2, hash = $3, failed = 0, locked_until = NULL, must_change = FALSE WHERE id = $1", [u.id, salt, hashCode(body.code, salt)]);
    await q("UPDATE rpb_resets SET handled_at = $2, handled_by = $3 WHERE user_id = $1 AND handled_at IS NULL", [u.id, new Date(), u.id]);
    await q("DELETE FROM rpb_sessions WHERE user_id = $1", [u.id]); // overal uitloggen
    await log(u, "account", "Nieuwe code ingesteld via e-maillink");
    return json(200, { ok: true, name: u.name });
  }

  // Inloggen
  if (a === "login" && method === "POST") {
    const body = await readBody(req);
    const key = nameKey(str(body.name, 60));
    const code = typeof body.code === "string" ? body.code.slice(0, 200) : "";
    await throttle("login", ip, 30, 15);
    const r = await q("SELECT * FROM rpb_users WHERE name_key = $1", [key]);
    const u = r.rows[0];
    const fail = () => httpError(401, "Naam of code klopt niet.");
    if (!u) { checkCode(code, "x", "00"); await attempt("login", ip); throw fail(); } // even lang rekenen als bij een bestaande naam
    if (u.pending) {
      if (checkCode(code, u.salt, u.hash)) throw httpError(403, "Je aanvraag is ontvangen en wacht op goedkeuring door de beheerder.");
      await attempt("login", ip);
      throw fail();
    }
    if (!u.active) { await attempt("login", ip); throw fail(); }
    if (u.locked_until && new Date(u.locked_until) > new Date()) {
      throw httpError(429, `Te vaak een verkeerde code. Probeer het over ${LOCK_MINUTES} minuten opnieuw.`);
    }
    if (!checkCode(code, u.salt, u.hash)) {
      const failed = (u.failed || 0) + 1;
      const lock = failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60000) : null;
      await q("UPDATE rpb_users SET failed = $2, locked_until = $3 WHERE id = $1", [u.id, failed >= MAX_FAILED ? 0 : failed, lock]);
      await log(u, "inloggen", lock ? `Verkeerde code, account ${LOCK_MINUTES} minuten geblokkeerd` : "Verkeerde code");
      await attempt("login", ip);
      throw fail();
    }
    // Te korte code van vóór de nieuwe regels: eerst een nieuwe kiezen
    const mustChange = !!u.must_change || code.length < MIN_CODE;
    await q("UPDATE rpb_users SET failed = 0, locked_until = NULL, must_change = $2 WHERE id = $1", [u.id, mustChange]);
    await log(u, "inloggen", "Ingelogd");
    await q("DELETE FROM rpb_sessions WHERE expires_at < $1", [new Date()]);
    const token = await createSession(u.id);
    return json(200, { user: publicUser({ ...u, must_change: mustChange }) }, { "set-cookie": sessionCookie(req, token) });
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

  // Huisstijl (zonder login): logo en app-iconen. Met ?v=<versie> mag de browser ze voor altijd bewaren.
  if (a === "brand" && b && !c && method === "GET") {
    const key = BRAND_FILES[b];
    if (!key) throw httpError(404, "Niet gevonden.");
    const r = await q("SELECT mime, data FROM rpb_assets WHERE key = $1", [key]);
    const row = r.rows[0];
    if (!row) {
      if (key === "logo") throw httpError(404, "Er is geen logo ingesteld.");
      return new Response(null, { status: 302, headers: { location: `/icons/${b}`, "cache-control": "public, max-age=300" } });
    }
    const v = url.searchParams.get("v"), cur = (await getSettings()).logoVersion;
    const forever = v && v === cur;
    return new Response(Buffer.from(row.data, "base64"), {
      status: 200,
      headers: {
        "content-type": row.mime,
        "cache-control": forever ? "public, max-age=31536000, immutable" : "public, max-age=300",
        ...(forever ? { "netlify-cdn-cache-control": "public, max-age=31536000, immutable, durable" } : {}),
        "x-content-type-options": "nosniff",
      },
    });
  }
  // App-manifest: naam en icoon als iemand de site op het beginscherm zet (Android, Chrome, Edge)
  if (a === "manifest.webmanifest" && !b && method === "GET") {
    const s = await getSettings();
    const v = s.logoVersion ? `?v=${s.logoVersion}` : "";
    const icon = (n) => ({ src: `/api/brand/icon-${n}.png${v}`, sizes: `${n}x${n}`, type: "image/png", purpose: "any" });
    const body = JSON.stringify({
      name: s.siteName, short_name: s.siteName.slice(0, 24), lang: "nl", start_url: "/", scope: "/", display: "standalone",
      background_color: s.logoBg, theme_color: s.logoBg, icons: [icon(192), icon(512)],
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "public, max-age=300" } });
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

  // FoodSource API v1 voor koppelingen (eigen sleutel, geen sessiecookie)
  if (a === "v1") { ctx.kick = true; return V1.handle(req, parts.slice(1), url); }

  // Vanaf hier: ingelogd
  const me = await auth(req);
  if (me.must_change && a !== "me" && a !== "logout") {
    throw httpError(403, `Kies eerst een nieuwe code van minstens ${MIN_CODE} tekens.`, { mustChange: true });
  }

  // Abonnement online betalen: maakt een Mollie-betaling en geeft de betaalpagina terug
  if (a === "pay" && b === "subscription" && method === "POST") {
    return json(200, await createSubscriptionPayment(req, me, "betaling"));
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
    const st = await subscriptionStatus(me);
    const s = st.settings;
    const incl = Math.round(s.subscriptionPrice * (1 + (s.vatPercent || 0) / 100));
    const renewFrom = st.valid ? st.paidUntil : today();
    return json(200, {
      paidUntil: st.paidUntil, today: today(), priceExcl: s.subscriptionPrice / 100, priceIncl: incl / 100,
      onlinePayment: s.onlinePayment, testMode: s.paymentTestMode,
      required: st.required, exempt: st.exempt, valid: st.valid, canTrade: st.canTrade, nextUntil: addYear(renewFrom),
    });
  }

  // Foto opslaan: { thumb: "data:image/jpeg;base64,...", full: "data:image/jpeg;base64,..." }
  if (a === "photos" && !b && method === "POST") {
    await requireTrade(me);
    const body = await readBody(req);
    const parse = (s, max, label) => {
      const m = typeof s === "string" && s.match(/^data:(image\/(?:jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
      if (!m) throw httpError(400, "Alleen JPEG- of WebP-foto's zijn toegestaan.");
      const bytes = Buffer.byteLength(m[2], "base64");
      if (bytes > max) throw httpError(413, `De ${label} is te groot.`);
      // Controleer of de inhoud echt een JPEG of WebP is, niet alleen wat de browser zegt
      const head = Buffer.from(m[2].slice(0, 24), "base64");
      const isJpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
      const isWebp = head.slice(0, 4).toString("latin1") === "RIFF" && head.slice(8, 12).toString("latin1") === "WEBP";
      if (m[1] === "image/jpeg" ? !isJpeg : !isWebp) throw httpError(400, "Dit bestand is geen geldige foto.");
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

  // AI: velden van een partij voorstellen op basis van een eigen foto
  if (a === "ai" && b === "lot-photo" && !c && method === "POST") {
    await requireTrade(me);
    if (!(await getSettings()).aiEnabled) throw httpError(403, "AI-herkenning staat uit.");
    const body = await readBody(req);
    return json(200, await AI.suggestFromPhoto(me, str(body.photoId, 40)));
  }
  // AI: velden voorstellen op basis van een beschrijving (getypt, ingesproken, geplakt) en/of een eigen foto
  if (a === "ai" && b === "lot" && !c && method === "POST") {
    await requireTrade(me);
    if (!(await getSettings()).aiEnabled) throw httpError(403, "AI-herkenning staat uit.");
    const body = await readBody(req);
    return json(200, await AI.suggest(me, { photoId: str(body.photoId, 40), text: typeof body.text === "string" ? body.text.slice(0, 5000) : "" }));
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
    await q("DELETE FROM rpb_sessions WHERE token_hash = $1", [sha256(me._token)]);
    await log(me, "inloggen", "Uitgelogd");
    return json(200, { ok: true }, { "set-cookie": sessionCookie(req, "") });
  }

  // Oude versie bewaarde de sessie in de browser; die zetten we hier om naar een HttpOnly-cookie
  if (a === "me" && method === "GET") {
    return json(200, { user: publicUser(me) }, me._via === "bearer" ? { "set-cookie": sessionCookie(req, me._token) } : {});
  }

  if (a === "me" && method === "PATCH") {
    const body = await readBody(req);
    const company = body.company !== undefined ? str(body.company, 120) : me.company;
    const contact = body.contact !== undefined ? str(body.contact, 120) : me.contact;
    if (body.newCode !== undefined) {
      if (!checkCode(String(body.currentCode || ""), me.salt, me.hash)) throw httpError(403, "Je huidige code klopt niet.");
      validCode(body.newCode);
      if (body.newCode === body.currentCode) throw httpError(400, "Kies een andere code dan je huidige.");
      const salt = crypto.randomBytes(16).toString("hex");
      await q("UPDATE rpb_users SET salt = $2, hash = $3, must_change = FALSE WHERE id = $1", [me.id, salt, hashCode(body.newCode, salt)]);
      await q("DELETE FROM rpb_sessions WHERE user_id = $1 AND token_hash <> $2", [me.id, sha256(me._token)]); // andere apparaten uitloggen
      await log(me, "account", "Eigen code gewijzigd");
      me.must_change = false;
    } else if (me.must_change) {
      throw httpError(403, `Kies eerst een nieuwe code van minstens ${MIN_CODE} tekens.`, { mustChange: true });
    }
    await q("UPDATE rpb_users SET company = $2, contact = $3 WHERE id = $1", [me.id, company, contact]);
    return json(200, { user: publicUser({ ...me, company, contact }) });
  }

  // Mijn account → API-koppelingen: sleutels en webhook
  if (a === "keys" || a === "webhook") { ctx.kick = b === "retry"; return V1.account(req, me, parts, readBody); }

  // Alle partijen en biedingen (of alleen wat er sinds 'since' veranderde)
  if (a === "data" && method === "GET") {
    const since = url.searchParams.get("since");
    const now = new Date();
    let r;
    if (since && !isNaN(Date.parse(since))) {
      r = await q("SELECT collection, id, data, version FROM rpb_docs WHERE updated_at > $1", [new Date(since)]);
    } else {
      r = await q("SELECT collection, id, data, version FROM rpb_docs WHERE data IS NOT NULL");
    }
    const docs = r.rows.map((d) => ({
      collection: d.collection, id: d.id, version: Number(d.version) || 0,
      data: d.collection === "lots" ? lotsView(me, d.id, d.data) : d.collection === "bids" ? bidsView(me, d.id, d.data) : null,
    }));
    // Per partij alleen het hoogste bod en het aantal biedingen, zonder namen
    const allBids = await q("SELECT data FROM rpb_docs WHERE collection = 'bids' AND data IS NOT NULL");
    const market = {};
    for (const row of allBids.rows) {
      for (const [lotId, o] of Object.entries(row.data?.offers || {})) {
        if (!o) continue;
        const m = market[lotId] || (market[lotId] = { top: 0, n: 0 });
        m.n++; if (Number(o.price) > m.top) m.top = Number(o.price);
      }
    }
    // Actuele bedrijfsnaam en contact per gebruiker, zodat oude partijen en biedingen
    // de nieuwste gegevens tonen als daar zelf niets is ingevuld.
    const p = await q("SELECT id, company, contact FROM rpb_users WHERE active = TRUE AND pending = FALSE"); // geen gegevens van aanvragers
    const profiles = {};
    for (const row of p.rows) profiles[row.id] = { company: row.company, contact: row.contact };
    let pendingCount;
    if (me.role === "beheerder") {
      const pc = await q("SELECT COUNT(*)::int AS n FROM rpb_users WHERE pending = TRUE");
      pendingCount = Number(pc.rows[0].n);
      const rc = await q("SELECT COUNT(*)::int AS n FROM rpb_resets WHERE handled_at IS NULL AND token_hash IS NULL");
      pendingCount += Number(rc.rows[0].n);
    }
    return json(200, { now: now.toISOString(), full: !since, docs, market, profiles, pendingCount });
  }

  // Eigen document schrijven: /api/doc/lots of /api/doc/bids
  // De browser stuurt mee welke versie hij heeft gelezen ("base"). Is het document intussen
  // gewijzigd, dan weigert de server (409) en haalt de browser eerst de nieuwe versie op.
  if (a === "doc" && b && COLLECTIONS.has(b) && !c && method === "PUT") {
    await requireTrade(me);
    const body = await readBody(req);
    const data = body.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw httpError(400, "Ongeldige gegevens.");
    const cur = await readDoc(b, me.id);
    if (Number.isInteger(body.base) && body.base !== cur.version) throw conflict();
    const prev = cur.data;
    let clean, ownPhotos = null;
    if (b === "lots") ({ out: clean, ownPhotos } = await normalizeLots(me, prev, data));
    else clean = await normalizeBids(me, prev, data);
    if (Buffer.byteLength(JSON.stringify(clean)) > MAX_DOC_BYTES) throw httpError(413, "Te veel gegevens in één keer. Trek oude partijen of biedingen in.");
    const saved = await writeDocAt(b, me.id, cur, clean, me.id);
    if (!saved) throw conflict();
    let lines = [];
    if (b === "lots") {
      const nr = await q("SELECT id, name, company FROM rpb_users");
      const names = {}; for (const row of nr.rows) names[row.id] = row.company || row.name;
      lines = describeLots(prev, clean, names);
      // Foto's die nergens meer bij horen en ouder zijn dan 6 uur opruimen
      const used = new Set(Object.values(clean.items).flatMap((it) => it.photos || []));
      const cutoff = Date.now() - 6 * 3600000;
      for (const [pid, at] of ownPhotos) if (!used.has(pid) && at.getTime() < cutoff) await q("DELETE FROM rpb_photos WHERE id = $1 AND owner = $2", [pid, me.id]);
    } else lines = describeBids(prev, clean);
    for (const [kind, detail] of lines.slice(0, 10)) await log(me, kind, detail);
    // Gebeurtenissen voor koppelingen (webhook / GET /api/v1/events): nieuw bod, gunning
    try {
      if (b === "lots") await V1.emitForLots(me, prev, clean, siteUrl(req));
      else await V1.emitForBids(me, prev, clean, siteUrl(req));
      ctx.kick = true;
    } catch (e) { console.error("events", e); }
    return json(200, { ok: true, at: saved.at.toISOString(), version: saved.version, data: clean });
  }

  // Beheerder: document van een ander verwijderen (opruimen)
  if (a === "doc" && b && COLLECTIONS.has(b) && c && method === "DELETE") {
    requireAdmin(me);
    await q("UPDATE rpb_docs SET data = NULL, updated_at = $3, updated_by = $4, version = version + 1 WHERE collection = $1 AND id = $2", [b, c, new Date(), me.id]);
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
    const user = await insertUser({ ...(await readBody(req)), mustChange: true }); // gebruiker kiest bij eerste keer inloggen zelf een code
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
    const exempt = typeof body.exempt === "boolean" ? body.exempt : !!u.exempt;
    if (exempt !== !!u.exempt) {
      await q("UPDATE rpb_users SET exempt = $2 WHERE id = $1", [b, exempt]);
      await log(me, "beheer", `${exempt ? "Vrijgesteld van abonnement" : "Vrijstelling abonnement ingetrokken"}: ${name}${company ? " (" + company + ")" : ""}`);
    }
    if (body.code !== undefined) {
      validCode(body.code);
      const salt = crypto.randomBytes(16).toString("hex");
      await q("UPDATE rpb_users SET salt = $2, hash = $3, failed = 0, locked_until = NULL, must_change = TRUE WHERE id = $1", [b, salt, hashCode(body.code, salt)]);
      await q("UPDATE rpb_resets SET handled_at = $2, handled_by = $3 WHERE user_id = $1 AND handled_at IS NULL", [b, new Date(), me.id]);
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
    return json(200, { user: publicUser({ ...u, name, role, active, company, contact, kvk, pending, exempt }) });
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

    // Omgeving leegmaken: "trade" = partijen, biedingen en foto's; "all" = alles, terug naar de eerste beheerder
    if (b === "wipe" && method === "POST") {
      if (!wipeAllowed()) throw httpError(403, "Leegmaken staat uit. Zet in Netlify ALLOW_WIPE op true en doe een nieuwe deploy (of gebruik de testomgeving).");
      const body = await readBody(req);
      await throttle("wipe", ip, 5, 15);
      const scope = body.scope === "all" ? "all" : body.scope === "trade" ? "trade" : "";
      if (!scope) throw httpError(400, "Kies wat je wilt leegmaken.");
      if (str(body.confirm, 20) !== "LEEGMAKEN") throw httpError(400, "Typ LEEGMAKEN in hoofdletters ter bevestiging.");
      const expected = process.env.RPB_SETUP_CODE || "", given = str(body.setupCode, 200);
      const okCode = !!expected && given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
      if (!okCode) { await attempt("wipe", ip); throw httpError(403, "De installatiecode klopt niet."); }
      const counts = {};
      for (const t of scope === "all" ? ALL_TABLES : TRADE_TABLES) {
        const r = await q(`SELECT COUNT(*)::int AS n FROM ${t}`);
        counts[t] = Number(r.rows[0].n);
        await q(`DELETE FROM ${t}`);
      }
      console.log("wipe", scope, PG_SCHEMA || "public", counts);
      if (scope === "trade") {
        await log(me, "beheer", `Omgeving leeggemaakt: ${counts.rpb_docs} documenten met partijen en biedingen en ${counts.rpb_photos} foto's verwijderd`);
        return json(200, { ok: true, scope, counts });
      }
      return json(200, { ok: true, scope, counts }, { "set-cookie": sessionCookie(req, "") });
    }

    // Testmail om de koppeling met Brevo te controleren
    if (b === "testmail" && method === "POST") {
      const body = await readBody(req);
      const to = str(body.to, 120) || accountEmail(me);
      if (!validEmail(to)) throw httpError(400, "Vul een geldig e-mailadres in.");
      const s = await getSettings();
      await sendMail({ to, subject: `${s.siteName}: testmail`, text: `Dit is een testmail van ${s.siteName}. De e-mailkoppeling werkt.`, html: `<p>Dit is een testmail van ${escHtml(s.siteName)}. De e-mailkoppeling werkt.</p>` });
      await log(me, "beheer", `Testmail verstuurd naar ${to}`);
      return json(200, { ok: true, to });
    }

    // Meldingen "code vergeten"
    if (b === "resets" && !c && method === "GET") {
      const r = await q(`SELECT r.id, r.user_id, r.contact, r.note, r.created_at, u.name, u.company, u.contact AS known
        FROM rpb_resets r JOIN rpb_users u ON u.id = r.user_id WHERE r.handled_at IS NULL AND r.token_hash IS NULL ORDER BY r.created_at`);
      return json(200, { resets: r.rows.map((x) => ({ id: x.id, userId: x.user_id, name: x.name, company: x.company, contact: x.contact, note: x.note, known: x.known, at: new Date(x.created_at).toISOString() })) });
    }
    if (b === "resets" && c && method === "DELETE") {
      const r = await q("SELECT r.user_id, u.name, u.company FROM rpb_resets r LEFT JOIN rpb_users u ON u.id = r.user_id WHERE r.id = $1 AND r.handled_at IS NULL", [c]);
      if (r.rows[0]) {
        await q("UPDATE rpb_resets SET handled_at = $2, handled_by = $3 WHERE id = $1", [c, new Date(), me.id]);
        await log(me, "beheer", `Melding code vergeten afgesloten zonder nieuwe code: ${r.rows[0].name || "onbekend"}`);
      }
      return json(200, { ok: true });
    }

    // Logboek
    if (b === "log" && method === "GET") {
      const sp = url.searchParams;
      const limit = Math.min(5000, Math.max(1, Number(sp.get("limit")) || 200));
      const before = Number(sp.get("before")) || 0;
      const kind = str(sp.get("kind") || "", 20);
      const user = str(sp.get("user") || "", 40);
      const text = str(sp.get("q") || "", 100);
      const from = sp.get("from"), to = sp.get("to");
      const conds = [], params = [];
      const add = (sql, v) => { params.push(v); conds.push(sql.replace("?", "$" + params.length)); };
      if (before) add("id < ?", before);
      if (kind) add("kind = ?", kind);
      if (user) add("user_id = ?", user);
      if (text) add("(detail ILIKE ? OR user_name ILIKE $" + (params.length + 1) + ")", "%" + text.replace(/[\\%_]/g, (c) => "\\" + c) + "%");
      if (validDate(from)) add("at >= ?", amsMidnight(from));
      if (validDate(to)) add("at < ?", amsMidnight(addDay(to)));
      const r = await q(`SELECT id, at, user_name, kind, detail FROM rpb_log ${conds.length ? "WHERE " + conds.join(" AND ") : ""} ORDER BY id DESC LIMIT ${limit}`, params);
      return json(200, { entries: r.rows.map((x) => ({ id: Number(x.id), at: new Date(x.at).toISOString(), user: x.user_name, kind: x.kind, detail: x.detail })) });
    }

    // Logo en app-iconen instellen of weghalen
    if (b === "logo" && method === "PUT") {
      const body = await readBody(req);
      const bg = typeof body.bg === "string" && /^#[0-9a-f]{6}$/i.test(body.bg) ? body.bg.toLowerCase() : "#ffffff";
      const showName = body.showName !== false;
      const now = new Date();
      if (body.logo !== undefined) {
        const logo = parseImage(body.logo, { max: MAX_LOGO_BYTES });
        const icons = {};
        for (const [k, n] of Object.entries(ICON_SIZES)) icons[k] = parseImage(body.icons?.[n], { max: 300 * 1024, png: true, size: n });
        for (const [k, img] of [["logo", logo], ...Object.entries(icons)]) {
          await q("INSERT INTO rpb_assets (key, mime, data, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT (key) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data, updated_at = EXCLUDED.updated_at", [k, img.mime, img.b64, now]);
        }
        await q("INSERT INTO rpb_settings (key, value) VALUES ('logoVersion', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [crypto.randomBytes(6).toString("hex")]);
      } else if (!(await getSettings()).logoVersion) throw httpError(400, "Kies eerst een logo.");
      await q("INSERT INTO rpb_settings (key, value) VALUES ('logoShowName', $1), ('logoBg', $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [String(showName), bg]);
      await log(me, "beheer", body.logo !== undefined ? "Nieuw logo ingesteld" : "Weergave van het logo gewijzigd");
      return json(200, { settings: await getSettings() });
    }
    if (b === "logo" && method === "DELETE") {
      await q("DELETE FROM rpb_assets WHERE key IN ('logo', 'icon512', 'icon192', 'icon180', 'icon32')");
      await q("DELETE FROM rpb_settings WHERE key IN ('logoVersion', 'logoShowName', 'logoBg')");
      await log(me, "beheer", "Logo verwijderd");
      return json(200, { settings: await getSettings() });
    }

    // Website-instellingen
    if (b === "settings" && method === "PUT") {
      const body = await readBody(req);
      const before = await getSettings();
      // Prijs: bij voorkeur hele centen (subscriptionPriceCents); oude manier (euro's als tekst) streng gelezen.
      // Iets wat we niet kunnen lezen wordt een foutmelding, nooit stilletjes € 0 (dan is handelen gratis).
      let priceCents;
      if (body.subscriptionPriceCents !== undefined) priceCents = body.subscriptionPriceCents;
      else if (body.subscriptionPrice !== undefined) priceCents = parseEuroText(body.subscriptionPrice);
      else priceCents = before.subscriptionPrice;
      if (!Number.isInteger(priceCents) || priceCents < 0 || priceCents > 10000000) throw httpError(400, "Ongeldige abonnementsprijs. Vul een bedrag in, bijvoorbeeld 120 of 120,50.");
      const vat = body.vatPercent === undefined ? before.vatPercent : typeof body.vatPercent === "number" ? body.vatPercent : String(body.vatPercent).trim() === "" ? NaN : Number(String(body.vatPercent).replace(",", ".").trim());
      if (!Number.isFinite(vat) || vat < 0 || vat > 100) throw httpError(400, "Ongeldig btw-percentage. Vul een getal tussen 0 en 100 in.");
      const vals = {
        siteName: str(body.siteName, 60) || SETTING_DEFAULTS.siteName,
        welcomeText: str(body.welcomeText, 1000),
        announcement: str(body.announcement, 500),
        registrationOpen: body.registrationOpen === false ? "false" : "true",
        subscriptionPrice: String(priceCents),
        subscriptionText: str(body.subscriptionText, 300),
        vatPercent: String(vat),
        payMethods: (Array.isArray(body.payMethods) ? body.payMethods : []).filter((x) => PAY_METHODS.includes(x)).join(","),
        autoApprovePaid: body.autoApprovePaid === true ? "true" : "false",
        requireSubscription: body.requireSubscription === false ? "false" : "true",
        apiEnabled: body.apiEnabled === undefined ? String(before.apiEnabled) : body.apiEnabled === true ? "true" : "false",
        aiEnabled: body.aiEnabled === undefined ? String(before.aiSwitch) : body.aiEnabled === true ? "true" : "false",
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
      if (!["withdraw", "reopen", "delete"].includes(action)) throw httpError(400, "Onbekende actie.");
      const codes = (await getSettings()).reasonCodes;
      const reason = action === "reopen" ? null : cleanReason(body.reason, codes, { required: true });
      let it, saved = null;
      for (let tryNo = 0; tryNo < 3 && !saved; tryNo++) { // opnieuw proberen als de verkoper tegelijk iets wijzigt
        const cur = await readDoc("lots", sellerId);
        const doc = cur.data;
        it = doc?.items?.[lotId];
        if (!it) throw httpError(404, "Partij niet gevonden.");
        if (action === "withdraw") { it.status = "ingetrokken"; it.withdrawReason = { ...reason, by: "beheer" }; }
        else if (action === "reopen") { it.status = (it.remaining ?? it.qty) > 0 ? "open" : "verkocht"; delete it.withdrawReason; }
        else delete doc.items[lotId];
        saved = await writeDocAt("lots", sellerId, cur, doc, me.id);
      }
      if (!saved) throw conflict();
      if (action === "delete") for (const p of Array.isArray(it.photos) ? it.photos : []) await q("DELETE FROM rpb_photos WHERE id = $1", [p]);
      const label = `${it.product || "partij"}${it.ras ? " " + it.ras : ""}`;
      const nr = await q("SELECT name, company FROM rpb_users WHERE id = $1", [sellerId]);
      const owner = nr.rows[0] ? (nr.rows[0].company || nr.rows[0].name) : "onbekend";
      const verb = { withdraw: "ingetrokken", reopen: "heropend", delete: "verwijderd" }[action];
      await log(me, "beheer", `Partij van ${owner} ${verb}: ${label}${reason ? ` — reden ${reason.code} ${reason.label}${reason.note ? ": " + reason.note : ""}` : ""}`);
      return json(200, { ok: true });
    }

    // Redencodes beheren
    if (b === "reasons" && method === "PUT") {
      const body = await readBody(req);
      const list = Array.isArray(body.codes) ? body.codes : [];
      if (list.length > 50) throw httpError(400, "Maximaal 50 redencodes.");
      const seen = new Set(), out = [];
      for (const r of list) {
        const code = str(r.code, 10).toUpperCase().replace(/\s+/g, "");
        const label = str(r.label, 80);
        if (!/^[A-Z0-9_-]{2,10}$/.test(code)) throw httpError(400, `Code "${code || "(leeg)"}" is ongeldig. Gebruik 2 tot 10 letters of cijfers.`);
        if (!label) throw httpError(400, `Vul een omschrijving in bij code ${code}.`);
        if (seen.has(code)) throw httpError(400, `Code ${code} komt twee keer voor.`);
        seen.add(code);
        out.push({ code, label, active: r.active !== false, needsNote: !!r.needsNote });
      }
      const before = (await getSettings()).reasonCodes;
      await q("INSERT INTO rpb_settings (key, value) VALUES ('reasonCodes', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify(out)]);
      const added = out.filter((r) => !before.find((x) => x.code === r.code)).map((r) => r.code);
      const removed = before.filter((r) => !out.find((x) => x.code === r.code)).map((r) => r.code);
      await log(me, "beheer", `Redencodes bijgewerkt (${out.length} codes${added.length ? ", nieuw: " + added.join(", ") : ""}${removed.length ? ", verwijderd: " + removed.join(", ") : ""})`);
      return json(200, { codes: out });
    }
  }

  throw httpError(404, "Onbekend adres.");
}

// Webhooks afleveren: na een wijziging (op de achtergrond als Netlify dat kan) en elke 5 minuten
// via de geplande functie webhooks.mjs (voor herhaalpogingen).
export async function runWebhooks(limit = 20) { await ensureSchema(); return V1.deliverDue(limit); }

export default async (req, context) => {
  try {
    const ctx = { kick: false };
    const res = await route(req, ctx);
    if (ctx.kick) {
      const p = V1.deliverDue(5).catch((e) => console.error("webhooks", e));
      if (context && typeof context.waitUntil === "function") context.waitUntil(p); else await p;
    }
    return res;
  } catch (e) {
    if (e && e.status) return json(e.status, { error: e.message, ...(e.extra || {}) });
    console.error(e);
    const msg = String((e && e.message) || e);
    const dbProblem = /certificate|ECONN|ETIMEDOUT|ENOTFOUND|connect|terminat|timeout|password authentication|SQL:/i.test(msg) || (e && typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code));
    const hint = /certificate/i.test(msg) ? " (certificaat: zie PG_SSL_CA / PG_SSL_INSECURE)" : "";
    return json(500, { error: dbProblem ? "Database niet bereikbaar" + hint + ". Probeer het over een minuut opnieuw." : "Er ging iets mis op de server. Probeer het opnieuw; blijft het misgaan, meld het dan bij de beheerder." });
  }
};
