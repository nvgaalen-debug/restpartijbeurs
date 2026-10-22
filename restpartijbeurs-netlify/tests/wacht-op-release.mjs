// Wacht tot Netlify de versie uit deze map echt heeft gepubliceerd, zodat de rooktest de nieuwe release test
// en niet de vorige. Vergelijkt public/version.json in de repository met SMOKE_URL/version.json.
// Gebruik: node wacht-op-release.mjs   (SMOKE_URL moet gezet zijn; maximaal 12 minuten wachten)
import { readFileSync } from "node:fs";

const base = (process.env.SMOKE_URL || "").replace(/\/+$/, "");
if (!/^https?:\/\//.test(base)) { console.error("Zet SMOKE_URL, bijv. https://restpartijbeurs.netlify.app"); process.exit(1); }
let expected = "";
try { expected = JSON.parse(readFileSync(new URL("../public/version.json", import.meta.url), "utf8")).version || ""; } catch { /* geen versiebestand */ }
if (!expected || expected === "dev") { console.log("Geen versienummer in de repository; niet wachten."); process.exit(0); }

const max = Number(process.env.WAIT_MINUTES || 12) * 60_000, t0 = Date.now();
console.log(`Wachten tot ${base} versie ${expected} toont…`);
while (Date.now() - t0 < max) {
  try {
    const r = await fetch(`${base}/version.json?t=${Date.now()}`, { cache: "no-store" });
    const live = r.ok ? (await r.json()).version : `HTTP ${r.status}`;
    if (live === expected) { console.log(`Versie ${expected} staat online (na ${Math.round((Date.now() - t0) / 1000)} s).`); process.exit(0); }
    console.log(`  nu online: ${live}`);
  } catch (e) { console.log(`  site niet bereikbaar: ${e.message}`); }
  await new Promise((r) => setTimeout(r, 20_000));
}
console.error(`Na ${max / 60_000} minuten staat versie ${expected} nog niet online. Kijk in Netlify bij Deploys (mislukt? Trigger deploy?).`);
process.exit(1);
