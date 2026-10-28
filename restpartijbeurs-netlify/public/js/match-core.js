// NIET HIER BEWERKEN – gemaakt uit netlify/lib/match.mjs met: node tools/maak-match-core.mjs
// Matchscore voor vraag en aanbod; dezelfde regels als de server (meldingen).
const MatchCore = (() => {
  // Vraag en aanbod: hoe goed past een partij bij een vraag? (matchscore 0–100% met uitleg)
  // Dit bestand is de enige bron: de app krijgt een kopie in public/js/match-core.js (node tools/maak-match-core.mjs).
  // Wijzig je hier iets, maak dan de kopie opnieuw – de test controleert dat ze gelijk zijn.
  //
  // Harde eisen (anders "past niet", wordt niet getoond):
  //   - hetzelfde product (enkelvoud/meervoud maakt niet uit; bij een andere categorie precies hetzelfde woord)
  //   - partij en vraag allebei nog open
  //   - niet meer dan 15% boven de maximumprijs, niet meer dan 2× de maximale afstand
  // Zachte eisen (samen 100 punten):
  //   product 30 · prijs 20 · hoeveelheid 20 · klasse 15 · afstand 10 · houdbaarheid 5
  // 90% of meer = goede match (ook een melding), 70–89% = bijna-match (alleen in de app), lager = niet tonen.
  // Gaat een partij over een grens die de koper zelf koos (maximumprijs, klasse, maximale afstand), dan is het
  // hooguit een bijna-match (89%): groen betekent "voldoet aan alles wat je vroeg".

  const GOOD = 90;
  const NEAR = 70;
  const W = { product: 30, price: 20, qty: 20, klasse: 15, km: 10, fresh: 5 };
  const STOP = new Set(["en", "of", "de", "het", "een", "met", "voor", "van", "klasse", "kg", "kilo"]);
  const UNIT1 = { colli: "collo", kg: "kg", pallets: "pallet", kisten: "kist", zakken: "zak" };

  function stem(w) {
    let s = w.replace(/'?s$/, "").replace(/en$/, "");
    if (s.length < 2) s = w;
    return s.replace(/([aeiou])\1/g, "$1").replace(/([^aeiou])\1/g, "$1").replace(/v$/, "f");
  }
  function words(s) {
    return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim().split(" ")
      .filter((w) => w.length >= 2 && !STOP.has(w)).map(stem);
  }
  // 2 = precies hetzelfde product, 1 = deel van een woord ("aardappelen" in "Frietaardappelen"), 0 = ander product
  function productLevel(wantProduct, lotProduct, lotRas, strict = false) {
    const want = words(wantProduct), lot = words(`${lotProduct || ""} ${lotRas || ""}`);
    if (!want.length || !lot.length) return 0;
    if (want.every((w) => lot.includes(w))) return 2;
    if (strict) return 0;
    return want.every((w) => lot.some((l) => l === w || (w.length >= 4 && l.includes(w)) || (w.length >= 3 && l.endsWith(w)))) ? 1 : 0;
  }
  function productMatch(wantProduct, lotProduct, lotRas, strict = false) {
    return productLevel(wantProduct, lotProduct, lotRas, strict) > 0;
  }
  function lotOpen(l, today) {
    const rem = l.remaining ?? l.qty;
    return l.status !== "ingetrokken" && l.status !== "verkocht" && rem > 0 && !(l.until && l.until < today);
  }
  function wantOpen(w, today) { return !!w && w.status !== "gesloten" && !!w.until && w.until >= today; }

  // Afstand hemelsbreed in km tussen twee { lat, lon }
  function km(a, b) {
    if (!a || !b || !isFinite(a.lat) || !isFinite(b.lat) || !isFinite(a.lon) || !isFinite(b.lon)) return null;
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // Klasse: hoger mag altijd (Klasse I voor wie Klasse II zoekt); biologisch alleen als dat gevraagd is, en dan verplicht
  const RANK = { "Industrie / verwerking": 0, "Klasse II": 1, "Klasse I": 2 };
  const kl = (k) => { const s = String(k || ""); return { bio: /^Biologisch/i.test(s), rank: RANK[s.replace(/^Biologisch\s+/i, "")] }; };

  // Prijs van de partij in de eenheid van de vraag (of null als dat niet te vergelijken is)
  function priceIn(w, l) {
    if (w.unit === l.unit) return l.price;
    if (w.unit === "kg" && l.kgPerUnit > 0) return l.price / l.kgPerUnit;
    return null;
  }
  function qtyIn(w, l) {
    const rem = l.remaining ?? l.qty;
    if (w.unit === l.unit) return rem;
    if (w.unit === "kg" && l.kgPerUnit > 0) return rem * l.kgPerUnit;
    return null;
  }
  function priceOk(w, l) {
    if (!(w.maxPrice > 0)) return true;
    const p = priceIn(w, l);
    return p === null || p <= w.maxPrice + 1e-9;
  }
  const nf = (n, d = 0) => new Intl.NumberFormat("nl-NL", { maximumFractionDigits: d }).format(n);
  const eur = (n) => new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(n);
  const dayDiff = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86400000);

  // → { score, level: "good" | "near" | "low" | "out", lines: [{ s: "ok" | "warn" | "info", t }], out?, km, bidAt? }
  //   bidAt = voorgesteld bod (in de eenheid van de partij) als de partij net te duur is
  function matchScore(w, l, today) {
    const lines = [];
    let breach = false;
    const res = (score, out) => (score = Math.min(Math.round(score), breach ? GOOD - 1 : 100), { score: out ? 0 : score, level: out ? "out" : score >= GOOD - 0.5 ? "good" : score >= NEAR - 0.5 ? "near" : "low", lines, out: out || "", km: dist, bidAt });
    let dist = null, bidAt = null, pts = 0;
    const unit1 = (u) => UNIT1[u] || u;

    // Product (hard + punten)
    const lvl = productLevel(w.product, l.product, l.ras, w.category !== l.category);
    if (!lvl) return res(0, "Ander product");
    if (lvl === 2) { pts += W.product; lines.push({ s: "ok", t: "Juiste product" }); }
    else { pts += W.product * 0.8; lines.push({ s: "ok", t: `Verwant product: ${l.product}${l.ras ? " " + l.ras : ""}` }); }

    // Prijs
    const p = priceIn(w, l);
    if (!(w.maxPrice > 0)) { pts += W.price; lines.push({ s: "info", t: `${eur(l.price)} per ${unit1(l.unit)} (geen maximumprijs)` }); }
    else if (p === null) { pts += W.price; lines.push({ s: "info", t: `${eur(l.price)} per ${unit1(l.unit)}: niet te vergelijken met je maximum per ${unit1(w.unit)}` }); }
    else if (p <= w.maxPrice + 1e-9) {
      pts += W.price;
      const gap = w.maxPrice - p;
      lines.push({ s: "ok", t: gap >= 0.005 ? `${eur(gap)} per ${unit1(w.unit)} onder je maximum` : "Precies je maximumprijs" });
    } else {
      const over = (p - w.maxPrice) / w.maxPrice;
      if (over > 0.15 + 1e-9) return res(0, "Te duur");
      pts += W.price * (1 - over / 0.15);
      lines.push({ s: "warn", t: `${eur(p - w.maxPrice)} per ${unit1(w.unit)} boven je maximum` }); breach = true;
      bidAt = Math.round((w.unit === l.unit ? w.maxPrice : w.maxPrice * l.kgPerUnit) * 100) / 100;
    }

    // Hoeveelheid
    const have = qtyIn(w, l);
    if (have === null || !(w.qty > 0)) { pts += W.qty; lines.push({ s: "info", t: `${nf(l.remaining ?? l.qty, 2)} ${l.unit} beschikbaar` }); }
    else if (have >= w.qty - 1e-9) { pts += W.qty; lines.push({ s: "ok", t: `Genoeg: ${nf(have, 2)} ${w.unit} beschikbaar` }); }
    else { const r = have / w.qty; pts += W.qty * r; lines.push({ s: "warn", t: `${nf(have, 2)} van ${nf(w.qty, 2)} ${w.unit} (${nf(r * 100)}%)` }); }

    // Klasse
    if (!w.klasse) { pts += W.klasse; if (l.klasse) lines.push({ s: "info", t: l.klasse }); }
    else {
      const a = kl(w.klasse), b = kl(l.klasse);
      if (w.klasse === l.klasse) { pts += W.klasse; lines.push({ s: "ok", t: l.klasse }); }
      else if (!l.klasse) { pts += W.klasse / 2; lines.push({ s: "warn", t: "Klasse niet opgegeven" }); breach = true; }
      else if ((!a.bio || b.bio) && a.rank !== undefined && b.rank !== undefined && b.rank >= a.rank) { pts += W.klasse; lines.push({ s: "ok", t: `${l.klasse} (beter dan gevraagd)` }); }
      else { lines.push({ s: "warn", t: `${l.klasse} i.p.v. ${w.klasse}` }); breach = true; }
    }

    // Afstand (hemelsbreed)
    dist = km(w.geo, l.geo);
    const max = w.maxKm > 0 ? w.maxKm : 0;
    if (dist === null) { pts += W.km; if (max) lines.push({ s: "info", t: "Afstand onbekend" }); }
    else {
      const d = Math.round(dist);
      if (max && dist > max * 2) return res(0, "Te ver weg");
      if (max && dist > max) { pts += W.km * (1 - (dist - max) / max); lines.push({ s: "warn", t: `${nf(d)} km, verder dan je maximum van ${nf(max)} km` }); breach = true; }
      else if (max) { pts += W.km; lines.push({ s: "ok", t: `${nf(d)} km afstand` }); }
      else { pts += dist <= 50 ? W.km : dist <= 200 ? W.km * (1 - 0.5 * (dist - 50) / 150) : W.km / 2; lines.push({ s: dist <= 50 ? "ok" : "info", t: `${nf(d)} km afstand` }); }
    }

    // Houdbaarheid
    if (!l.until) pts += W.fresh;
    else {
      const left = dayDiff(today, l.until);
      if (left >= 3) pts += W.fresh;
      else { pts += left >= 1 ? W.fresh * 0.6 : W.fresh * 0.2; lines.push({ s: "warn", t: left >= 1 ? `Nog ${left} ${left === 1 ? "dag" : "dagen"} houdbaar` : "Vandaag de laatste dag" }); }
    }
    return res(pts);
  }

  // Past goed genoeg voor een melding (en "Past bij je vraag")
  function wantMatchesLot(w, l, today) {
    return wantOpen(w, today) && lotOpen(l, today) && matchScore(w, l, today).score >= GOOD;
  }
  return { GOOD, NEAR, stem, words, productLevel, productMatch, lotOpen, wantOpen, km, priceOk, matchScore, wantMatchesLot };
})();
