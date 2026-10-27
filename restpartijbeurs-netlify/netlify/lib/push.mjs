// Pushmeldingen op telefoon en computer (Web Push, zonder extra pakketten)
// - De sleutels (VAPID) maakt de server zelf aan bij het eerste gebruik en bewaart ze in de database.
//   Test en productie hebben elk een eigen database-schema, dus ook eigen sleutels.
//   Wie zelf sleutels wil beheren, kan VAPID_PUBLIC_KEY en VAPID_PRIVATE_KEY (base64url) in Netlify zetten.
// - Per toestel een abonnement (rpb_push) met eigen keuzes: nieuw bod, gegund, niet gegund.
// - Versleuteling volgens RFC 8291 (aes128gcm) en ondertekening volgens RFC 8292 (VAPID, ES256).
import crypto from "node:crypto";

export const PUSH_KINDS = ["bid", "awarded", "rejected", "match"];
const DEFAULT_PREFS = { bid: true, awarded: true, rejected: true, match: true };
const MAX_DEVICES = 10;
const TIMEOUT_MS = 4000;
const TEST_DELAY_MS = Number(process.env.PUSH_TEST_DELAY_MS ?? 5000); // binnen de 10 s die een Netlify-functie mag duren
// Alleen de bekende pushdiensten van Apple, Google, Mozilla en Microsoft (geen willekeurige adressen)
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^([a-z0-9-]+\.)*push\.apple\.com$/, /^([a-z0-9-]+\.)*notify\.windows\.com$/];

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (s) => Buffer.from(String(s || ""), "base64url");

let transport = async (url, { headers, body }) => {
  const r = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
  // Bij een fout zegt de pushdienst waarom (Apple: {"reason": "BadJwtToken"} enz.); dat komt in het logboek van Netlify
  const reason = r.status >= 400 ? (await r.text().catch(() => "")).slice(0, 200) : "";
  return { status: r.status, reason };
};
export function setPushTransport(fn) { transport = fn; } // voor tests

export function checkEndpoint(raw) {
  let u;
  try { u = new URL(String(raw || "")); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return null;
  if (!PUSH_HOSTS.some((re) => re.test(u.hostname.toLowerCase()))) return null;
  return String(raw).length <= 1000 ? u.toString() : null;
}

// ---------- versleuteling (RFC 8291) ----------
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();
export function encrypt(payload, p256dh, auth, fixed = {}) { // fixed: alleen voor de testvector uit RFC 8291
  const uaPublic = unb64u(p256dh), authSecret = unb64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length < 16) throw new Error("ongeldige abonnementssleutels");
  const ecdh = crypto.createECDH("prime256v1");
  let asPublic;
  if (fixed.asPrivate) { ecdh.setPrivateKey(unb64u(fixed.asPrivate)); asPublic = ecdh.getPublicKey(); } else asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
  const salt = fixed.salt ? unb64u(fixed.salt) : crypto.randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const c = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const ct = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload, "utf8"), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21); salt.copy(head, 0); head.writeUInt32BE(4096, 16); head[20] = 65;
  return Buffer.concat([head, asPublic, ct]);
}

export function createPush({ q, log }) {
  // ---------- sleutels ----------
  let keys = null;
  async function vapid() {
    if (keys) return keys;
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
      const pub = unb64u(process.env.VAPID_PUBLIC_KEY);
      keys = { publicKey: process.env.VAPID_PUBLIC_KEY, jwk: { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: process.env.VAPID_PRIVATE_KEY } };
      return keys;
    }
    const r = await q("SELECT value FROM rpb_settings WHERE key = '_vapid'");
    let jwk = null;
    try { jwk = JSON.parse(r.rows[0]?.value || "null"); } catch {}
    if (!jwk?.d) {
      const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const fresh = privateKey.export({ format: "jwk" });
      // Bij twee gelijktijdige verzoeken wint de eerste; daarna lezen we wat er staat
      await q("INSERT INTO rpb_settings (key, value) VALUES ('_vapid', $1) ON CONFLICT (key) DO NOTHING", [JSON.stringify({ kty: "EC", crv: "P-256", x: fresh.x, y: fresh.y, d: fresh.d })]);
      jwk = JSON.parse((await q("SELECT value FROM rpb_settings WHERE key = '_vapid'")).rows[0].value);
    }
    keys = { publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)])), jwk };
    return keys;
  }
  // Apple: niet vaker dan eens per uur een nieuwe handtekening; we hergebruiken hem 11 uur (geldig 12 uur)
  const tokens = new Map();
  function jwt(aud, sub, jwk) {
    const hit = tokens.get(aud + "|" + sub);
    if (hit && hit.until > Date.now()) return hit.token;
    const token = signJwt(aud, sub, jwk);
    tokens.set(aud + "|" + sub, { token, until: Date.now() + 11 * 3600000 });
    return token;
  }
  function signJwt(aud, sub, jwk) {
    const enc = (o) => b64u(Buffer.from(JSON.stringify(o)));
    const data = `${enc({ typ: "JWT", alg: "ES256" })}.${enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub })}`;
    const key = crypto.createPrivateKey({ key: jwk, format: "jwk" });
    return `${data}.${b64u(crypto.sign("sha256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" }))}`;
  }

  // ---------- één melding naar één toestel ----------
  async function sendTo(row, msg, base) {
    const k = await vapid();
    const url = checkEndpoint(row.endpoint);
    if (!url) return { gone: true };
    const body = encrypt(JSON.stringify(msg), row.p256dh, row.auth);
    const sub = /^https:\/\//.test(base || "") ? base : "mailto:noreply@foodsource.nl";
    const headers = {
      "content-type": "application/octet-stream", "content-encoding": "aes128gcm",
      ttl: String(msg.ttl || 86400), urgency: msg.urgency || "normal", ...(msg.tag ? { topic: msg.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) } : {}),
      authorization: `vapid t=${jwt(new URL(url).origin, sub, k.jwk)}, k=${k.publicKey}`,
    };
    try {
      const r = await transport(url, { headers, body });
      if (r.status === 404 || r.status === 410) { console.log("push", new URL(url).hostname, r.status, "toestel afgemeld bij de pushdienst"); return { gone: true }; }
      const ok = r.status >= 200 && r.status < 300;
      console.log("push", new URL(url).hostname, r.status, ok ? "ok" : r.reason || "");
      return { ok, status: r.status, reason: r.reason };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // Melding naar alle toestellen van een gebruiker die dit soort melding aan hebben staan
  async function notify(userId, kind, msg, base) {
    if (!userId) return 0;
    const r = await q(`SELECT p.* FROM rpb_push p JOIN rpb_users u ON u.id = p.user_id
      WHERE p.user_id = $1 AND u.active = TRUE AND u.pending = FALSE`, [userId]);
    const rows = r.rows.filter((x) => (x.prefs || DEFAULT_PREFS)[kind] !== false);
    if (!rows.length) { console.log(`push: geen toestel met meldingen aan voor ${userId} (${kind}; ${r.rows.length} toestel(len) aangemeld)`); return 0; }
    const out = await Promise.all(rows.map((row) => sendTo(row, msg, base).catch((e) => ({ ok: false, error: e.message }))));
    let sent = 0;
    for (let i = 0; i < rows.length; i++) {
      if (out[i].gone) await q("DELETE FROM rpb_push WHERE id = $1", [rows[i].id]);
      else if (out[i].ok) { sent++; await q("UPDATE rpb_push SET last_ok_at = $2, fails = 0 WHERE id = $1", [rows[i].id, new Date()]); }
      else {
        console.error("push mislukt", out[i].status || out[i].error, out[i].reason || "");
        // Na 20 mislukte pogingen op rij is het toestel waarschijnlijk weg
        await q("UPDATE rpb_push SET fails = fails + 1 WHERE id = $1", [rows[i].id]);
        await q("DELETE FROM rpb_push WHERE id = $1 AND fails >= 20", [rows[i].id]);
      }
    }
    return sent;
  }

  // ---------- teksten ----------
  const UNIT1 = { colli: "colli", kg: "kg", pallets: "pallet", kisten: "kist", zakken: "zak" };
  const nf = (n, d) => new Intl.NumberFormat("nl-NL", { minimumFractionDigits: d, maximumFractionDigits: d }).format(Number(n) || 0);
  const qtyTxt = (n, unit) => `${nf(n, Number.isInteger(Number(n)) ? 0 : 1)} ${unit || ""}`.trim();
  const eur = (n) => `€ ${nf(n, 2)}`;
  const nlDate = (s) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s || "")) return "";
    return new Intl.DateTimeFormat("nl-NL", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(s + "T12:00:00Z"));
  };
  const clip = (s, n) => (String(s || "").length > n ? String(s).slice(0, n - 1) + "…" : String(s || ""));

  // Na het opslaan van partijen door de aanbieder: koper hoort gunning of afwijzing
  async function forLots(seller, prev, next, names, base) {
    const a = prev?.items || {}, b = next?.items || {};
    const jobs = [];
    for (const [id, it] of Object.entries(b)) {
      const product = clip(it.product || "partij", 40);
      for (const [buyer, acc] of Object.entries(it.accepted || {})) {
        if (a[id]?.accepted?.[buyer]) continue;
        const where = [it.location ? `Ophalen in ${it.location}` : "", it.until ? `vóór ${nlDate(it.until)}` : ""].filter(Boolean).join(" ");
        jobs.push(notify(buyer, "awarded", {
          title: `Gegund: ${product}`,
          body: clip(`${names[seller.id] || "De aanbieder"} heeft je bod geaccepteerd: ${qtyTxt(acc.qty, it.unit)} à ${eur(acc.price)}.${where ? " " + where + "." : ""}`, 180),
          view: "bids", seller: seller.id, lot: id, tag: `aw-${id}`, urgency: "high",
        }, base));
      }
      for (const buyer of Object.keys(it.rejected || {})) {
        if (a[id]?.rejected?.[buyer]) continue;
        jobs.push(notify(buyer, "rejected", {
          title: `Bod niet gegund: ${product}`,
          body: `${names[seller.id] || "De aanbieder"} heeft je bod op deze partij afgewezen. Kijk in het aanbod voor vergelijkbare partijen.`,
          view: "market", tag: `rj-${id}`,
        }, base));
      }
    }
    await Promise.all(jobs);
  }
  // Na het opslaan van biedingen door de koper: aanbieder hoort een nieuw of gewijzigd bod
  async function forBid(sellerId, lotId, lot, bid, buyerName, updated, base) {
    const unit = lot?.unit === "kg" ? "kg" : UNIT1[lot?.unit] || "eenheid";
    return notify(sellerId, "bid", {
      title: `${updated ? "Bod gewijzigd" : "Nieuw bod"} op ${clip(lot?.product || "je partij", 40)}`,
      body: clip(`${buyerName || "Een koper"} biedt ${eur(bid.price)} per ${unit} voor ${qtyTxt(bid.qty, lot?.unit)}.${bid.note ? " “" + clip(bid.note, 60) + "”" : ""}`, 180),
      view: "mine", seller: sellerId, lot: lotId, tag: `bid-${lotId}`, urgency: "high",
    }, base);
  }

  // ---------- routes: /api/push ----------
  const cleanPrefs = (p) => Object.fromEntries(PUSH_KINDS.map((k) => [k, !(p && typeof p === "object" && p[k] === false)]));
  async function route(req, me, parts, readBody, json, httpError, base) {
    const [, b] = parts;
    const method = req.method;
    const body = method === "GET" ? {} : await readBody(req);
    const endpoint = method === "GET" ? new URL(req.url).searchParams.get("endpoint") : body.endpoint || body.subscription?.endpoint;
    const own = async () => {
      const r = await q("SELECT * FROM rpb_push WHERE user_id = $1 AND endpoint = $2", [me.id, String(endpoint || "")]);
      return r.rows[0] || null;
    };

    // Openbare sleutel en de keuzes van dit toestel
    if (!b && method === "GET") {
      const k = await vapid();
      const row = endpoint ? await own() : null;
      const n = await q("SELECT COUNT(*)::int AS n FROM rpb_push WHERE user_id = $1", [me.id]);
      return json(200, { publicKey: k.publicKey, subscribed: !!row, prefs: row ? cleanPrefs(row.prefs) : DEFAULT_PREFS, devices: Number(n.rows[0].n) });
    }
    // Toestel aanmelden (of opnieuw: dan worden de sleutels bijgewerkt)
    if (b === "subscribe" && method === "POST") {
      const s = body.subscription || {};
      const url = checkEndpoint(s.endpoint);
      if (!url) throw httpError(400, "Deze browser gebruikt een onbekende pushdienst.");
      const p256dh = String(s.keys?.p256dh || ""), auth = String(s.keys?.auth || "");
      if (unb64u(p256dh).length !== 65 || unb64u(auth).length < 16) throw httpError(400, "Ongeldige sleutels van de browser.");
      const label = String(body.label || "").replace(/[^\p{L}\p{N} ().,\-/]/gu, "").slice(0, 60);
      const prefs = cleanPrefs(body.prefs);
      // Hetzelfde toestel bij een andere gebruiker? Dan hoort het nu bij deze gebruiker.
      await q("DELETE FROM rpb_push WHERE endpoint = $1 AND user_id <> $2", [s.endpoint, me.id]);
      const n = await q("SELECT COUNT(*)::int AS n FROM rpb_push WHERE user_id = $1 AND endpoint <> $2", [me.id, s.endpoint]);
      if (Number(n.rows[0].n) >= MAX_DEVICES) {
        // Oudste toestel opruimen in plaats van weigeren
        await q("DELETE FROM rpb_push WHERE id = (SELECT id FROM rpb_push WHERE user_id = $1 ORDER BY COALESCE(last_ok_at, created_at) LIMIT 1)", [me.id]);
      }
      await q(`INSERT INTO rpb_push (user_id, endpoint, p256dh, auth, prefs, label, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
        ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, prefs = EXCLUDED.prefs, label = EXCLUDED.label, fails = 0`,
        [me.id, s.endpoint, p256dh, auth, JSON.stringify(prefs), label, new Date()]);
      await log(me, "account", `Pushmeldingen aangezet${label ? " op " + label : ""}`);
      return json(200, { ok: true, prefs });
    }
    if (b === "prefs" && method === "PUT") {
      if (!(await own())) throw httpError(404, "Meldingen staan op dit toestel niet aan.");
      const prefs = cleanPrefs(body.prefs);
      await q("UPDATE rpb_push SET prefs = $3::jsonb WHERE user_id = $1 AND endpoint = $2", [me.id, String(endpoint), JSON.stringify(prefs)]);
      return json(200, { ok: true, prefs });
    }
    if (b === "unsubscribe" && method === "POST") {
      await q("DELETE FROM rpb_push WHERE user_id = $1 AND endpoint = $2", [me.id, String(endpoint || "")]);
      return json(200, { ok: true });
    }
    if (b === "test" && method === "POST") {
      const row = await own();
      if (!row) throw httpError(404, "Meldingen staan op dit toestel niet aan.");
      // Op verzoek even wachten: zo kan de gebruiker de app sluiten (iPhone toont geen banner van een open app)
      if (body.delay) await new Promise((r) => setTimeout(r, TEST_DELAY_MS));
      const r = await sendTo(row, { title: "Testmelding", body: "Pushmeldingen werken op dit toestel.", view: "", tag: "test" }, base);
      console.log("push test", new URL(row.endpoint).hostname, r.status || r.error || (r.gone ? "gone" : ""));
      if (r.gone) { await q("DELETE FROM rpb_push WHERE id = $1", [row.id]); throw httpError(410, "Dit toestel is niet meer aangemeld. Zet meldingen opnieuw aan."); }
      if (!r.ok) {
        const why = (String(r.reason || "").match(/"reason"\s*:\s*"([^"]+)"/) || [])[1] || r.error || "";
        throw httpError(502, `De pushdienst nam de melding niet aan (${r.status || "geen antwoord"}${why ? " " + why : ""}). Probeer het later opnieuw; blijft het misgaan, stuur deze tekst naar de beheerder.`);
      }
      return json(200, { ok: true });
    }
    throw httpError(404, "Onbekend verzoek.");
  }

  return { notify, forLots, forBid, route, vapid };
}
