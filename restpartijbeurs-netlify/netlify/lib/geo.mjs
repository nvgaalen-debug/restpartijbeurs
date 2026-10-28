// Plaats of postcode → coördinaten, voor de afstand tussen vraag en aanbod (hemelsbreed).
// Bron: PDOK Locatieserver (overheid, gratis, geen sleutel). Antwoorden gaan in rpb_geo, zodat elke plaats maar één keer
// wordt opgezocht. Lukt het opzoeken niet, dan blijft de afstand "onbekend": nooit een fout voor de gebruiker.
// Instelbaar: GEO_URL (andere dienst met hetzelfde antwoord), GEO_OFF=1 (helemaal uit).

export { km } from "./match.mjs";

const PDOK = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/free";
const NEG_DAYS = 7; // niets gevonden: na een week opnieuw proberen
let transport = null; // tests: setGeoTransport(async (url) => ({ ok, json }))
export function setGeoTransport(fn) { transport = fn; }

// "regio Breda", "omgeving Venlo", "Westland (ophalen)" → "breda", "venlo", "westland"
// "heel Nederland", "landelijk", "maakt niet uit" → "" (overal: geen afstand)
export function placeKey(text) {
  let s = String(text || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const pc = s.match(/\b([1-9]\d{3})\s?([a-z]{2})?\b/);
  if (pc) return pc[1] + (pc[2] && !/^(sa|sd|ss)$/.test(pc[2]) ? pc[2] : "");
  // Alleen het eerste deel: "regio Breda, of ophalen kan in heel Nederland" → Breda
  s = s.replace(/\(.*?\)/g, " ").split(/,|\bof\b|\/|;|\ben\b/)[0];
  if (/\b(heel|geheel|hele) (nederland|nl|land)\b|^\s*(nederland|nl|landelijk|overal|maakt niet uit|n\.?v\.?t\.?|onbekend)\s*$/.test(s)) return "";
  s = s.replace(/\b(regio|omgeving|omg\.?|rondom|rond|nabij|bij|in|te|ophalen|afhalen|levering|leveren|aflevering|afleveradres|haven|veiling|provincie|prov\.?|gemeente)\b/g, " ");
  return s.replace(/[^a-z0-9' -]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

export function createGeo({ q, log = () => {} }) {
  const off = () => process.env.GEO_OFF === "1";
  async function fetchPlace(key) {
    const isPc = /^\d{4}/.test(key);
    const params = new URLSearchParams({ q: key, rows: "1", fl: "weergavenaam,centroide_ll,type", fq: isPc ? "type:postcode" : "type:(woonplaats OR gemeente)" });
    const url = `${process.env.GEO_URL || PDOK}?${params}`;
    let r;
    if (transport) r = await transport(url);
    else {
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 2500);
      try { const res = await fetch(url, { signal: ctl.signal, headers: { accept: "application/json" } }); r = { ok: res.ok, status: res.status, json: res.ok ? await res.json() : null }; }
      finally { clearTimeout(timer); }
    }
    if (!r?.ok) throw new Error(`geo ${r?.status || "fout"}`);
    // 4 cijfers zonder letters: PDOK kent alleen 6-positie postcodes → eerste treffer van "1234" is goed genoeg
    const d = r.json?.response?.docs?.[0];
    const m = typeof d?.centroide_ll === "string" && d.centroide_ll.match(/POINT\(([-\d.]+) ([-\d.]+)\)/);
    if (!m) return null;
    const lon = Number(m[1]), lat = Number(m[2]);
    if (!(lat > 50 && lat < 54 && lon > 3 && lon < 8)) return null; // alleen Nederland (en net over de grens)
    const label = isPc ? String(d.weergavenaam || key).replace(/^(\d{4})\s?[A-Z]{2}\s*/, "$1 ") : String(d.weergavenaam || key).split(",")[0];
    return { lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5, place: label.slice(0, 60) };
  }

  // tekst → { lat, lon, place } of null; budget = hoeveel keer we deze ronde nog naar buiten mogen
  async function lookup(text, budget = { n: 10 }) {
    if (off()) return null;
    const key = placeKey(text);
    if (!key || key.length < 2) return null;
    const c = (await q("SELECT lat, lon, place, found, at FROM rpb_geo WHERE key = $1", [key])).rows[0];
    if (c && (c.found || Date.now() - new Date(c.at).getTime() < NEG_DAYS * 86400000)) return c.found ? { lat: Number(c.lat), lon: Number(c.lon), place: c.place } : null;
    if (budget.n <= 0) return null;
    budget.n--;
    let g = null;
    try { g = await fetchPlace(key); }
    catch (e) { log(`geo: ${key} niet opgezocht (${e.message})`); return null; } // dienst plat: niet onthouden
    await q(`INSERT INTO rpb_geo (key, lat, lon, place, found, at) VALUES ($1, $2, $3, $4, $5, now())
      ON CONFLICT (key) DO UPDATE SET lat = EXCLUDED.lat, lon = EXCLUDED.lon, place = EXCLUDED.place, found = EXCLUDED.found, at = now()`,
      [key, g?.lat ?? null, g?.lon ?? null, g?.place ?? null, !!g]);
    return g;
  }
  return { lookup };
}
