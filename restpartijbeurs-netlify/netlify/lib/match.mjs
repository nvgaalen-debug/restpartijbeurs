// Vraag en aanbod: past een partij bij een vraag?
// Dezelfde regels staan in public/js/wants.js (wantMatchesLot), zodat de app en de meldingen hetzelfde zeggen.
// - product: elk woord uit de vraag komt voor in product of ras van de partij
//   (enkelvoud/meervoud maakt niet uit: "appels" = "appel", "tomaten" = "tomaat", "aardappelen" past bij "Frietaardappelen")
// - andere categorie (bijv. per ongeluk "Groente" bij aardbeien): alleen als het product precies hetzelfde woord is
//   (dan geen "appel" in "aardappel"); in dezelfde categorie mag een deel van een woord ("aardappelen" → "Frietaardappelen")
// - klasse alleen als de koper er een koos
// - maximale prijs alleen als die is ingevuld en de prijzen vergelijkbaar zijn (zelfde eenheid, of per kg)
// - partij en vraag allebei nog open
const STOP = new Set(["en", "of", "de", "het", "een", "met", "voor", "van", "klasse", "kg", "kilo"]);
export function stem(w) {
  let s = w.replace(/'?s$/, "").replace(/en$/, "");
  if (s.length < 2) s = w;
  return s.replace(/([aeiou])\1/g, "$1").replace(/([^aeiou])\1/g, "$1").replace(/v$/, "f");
}
export function words(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim().split(" ")
    .filter((w) => w.length >= 2 && !STOP.has(w)).map(stem);
}
export function productMatch(wantProduct, lotProduct, lotRas, strict = false) {
  const want = words(wantProduct), lot = words(`${lotProduct || ""} ${lotRas || ""}`);
  if (!want.length || !lot.length) return false;
  return want.every((w) => lot.some((l) => l === w || (!strict && ((w.length >= 4 && l.includes(w)) || (w.length >= 3 && l.endsWith(w))))));
}
export function lotOpen(l, today) {
  const rem = l.remaining ?? l.qty;
  return l.status !== "ingetrokken" && l.status !== "verkocht" && rem > 0 && !(l.until && l.until < today);
}
export function wantOpen(w, today) { return w && w.status !== "gesloten" && !!w.until && w.until >= today; }
export function priceOk(w, l) {
  if (!(w.maxPrice > 0)) return true;
  if (w.unit === l.unit) return l.price <= w.maxPrice + 1e-9;
  if (w.unit === "kg" && l.kgPerUnit > 0) return l.price / l.kgPerUnit <= w.maxPrice + 1e-9;
  return true; // niet te vergelijken: de koper beoordeelt zelf
}
export function wantMatchesLot(w, l, today) {
  return wantOpen(w, today) && lotOpen(l, today)
    && (!w.klasse || w.klasse === l.klasse) && priceOk(w, l) && productMatch(w.product, l.product, l.ras, w.category !== l.category);
}
