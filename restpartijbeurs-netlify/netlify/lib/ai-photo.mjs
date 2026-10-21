// AI: partijgegevens voorstellen op basis van een foto (Claude, via de Anthropic API)
// De browser stuurt alleen het id van een eigen, al geüploade foto; de server haalt de foto uit de
// database en vraagt Claude om een voorstel. De API-sleutel van Anthropic komt nooit in de browser.
//
// Omgevingsvariabelen:
//   ANTHROPIC_API_KEY  sleutel van de Anthropic API (console.anthropic.com)       nodig voor AI
//   AI_MODEL           model, standaard claude-haiku-5-5 (snel en goedkoop); bijv. claude-sonnet-5-5
//   AI_API_BASE        alleen voor tests (standaard https://api.anthropic.com)

export const AI_DEFAULT_MODEL = "claude-haiku-5-5";
const AI_TIMEOUT_MS = 9000;          // Netlify Functions stoppen na ±10 seconden
const PER_USER_PER_HOUR = 60;
const PER_SITE_PER_DAY = 1000;       // rem op de kosten als er iets misgaat

const CATEGORIES = ["Groente", "Fruit", "Aardappelen"];
const KLASSEN = ["Klasse I", "Klasse II", "Industrie / verwerking", "Biologisch Klasse I", "Biologisch Klasse II"];
const UNITS = ["colli", "kg", "pallets", "kisten", "zakken"];

const SYSTEM = `Je bent een ervaren handelaar in aardappelen, groente en fruit (AGF) in Nederland.
Een aanbieder maakt een foto van een restpartij om die op een handelsplatform aan te bieden. Stel op basis van de foto de gegevens van de partij voor.

Regels:
- Vul alleen in wat je op de foto ziet of wat in de AGF-handel voor deze verpakking gebruikelijk is. Verzin niets.
- Productnaam in het Nederlands, zoals een handelaar hem noemt, bijvoorbeeld: Trostomaten, Komkommers, Paprika rood, IJsbergsla, Broccoli, Wortelen, Uien, Champignons, Appels, Peren, Aardbeien, Blauwe bessen, Consumptieaardappelen, Frietaardappelen.
- Ras alleen als het op een etiket staat of zonder twijfel herkenbaar is (bijvoorbeeld Elstar, Conference). Anders leeg.
- Klasse alleen als die op een etiket of keurlabel staat; "Biologisch" alleen bij een zichtbaar biologisch keurmerk. Anders leeg.
- Herkomst alleen als het land op de verpakking staat, als ISO-landcode van 2 letters (NL, ES, MA). Anders leeg.
- Eenheid: kies hoe de partij verhandeld wordt: colli (dozen/trays), kisten, zakken, pallets of kg (los gestort, big bags per kg).
- Verpakking: kort en concreet, bijvoorbeeld "Kartonnen doos 6 kg", "Kist 10 kg", "Zak 25 kg", "Big bag ca. 1000 kg", "Tray 12 x 500 g".
- Kg per eenheid alleen als het gewicht op de verpakking staat of de verpakking een vaste standaardmaat heeft.
- Opmerking: één of twee zinnen over wat een koper wil weten en zichtbaar is: maat, kleur, rijpheid, gebreken. Geen verkooppraat.
- Is de foto geen AGF of onbruikbaar, zet dan isProduce op false en leg in remarks kort uit waarom.
Antwoord alleen via de tool.`;

const TOOL = {
  name: "partij_voorstel",
  description: "Voorstel voor de gegevens van een restpartij AGF op basis van de foto.",
  input_schema: {
    type: "object",
    properties: {
      isProduce: { type: "boolean", description: "Toont de foto aardappelen, groente of fruit?" },
      product: { type: "string", description: "Productnaam in het Nederlands" },
      ras: { type: "string", description: "Ras of soort, leeg als onbekend" },
      category: { type: "string", enum: CATEGORIES },
      klasse: { type: "string", enum: [...KLASSEN, ""], description: "Leeg als niet zichtbaar" },
      origin: { type: "string", description: "ISO-landcode van 2 letters, leeg als niet zichtbaar" },
      unit: { type: "string", enum: UNITS },
      pack: { type: "string", description: "Verpakking, kort" },
      kgPerUnit: { type: ["number", "null"], description: "Kg per eenheid, of null" },
      note: { type: "string", description: "Een of twee zinnen voor kopers" },
      confidence: { type: "string", enum: ["hoog", "middel", "laag"] },
      remarks: { type: "string", description: "Korte toelichting voor de aanbieder: twijfels, wat te controleren" },
    },
    required: ["isProduce", "product", "category", "unit", "confidence"],
  },
};

const clip = (v, n) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");

// Antwoord van het model nooit blind vertrouwen: alleen bekende waarden en beperkte lengtes
export function cleanSuggestion(x) {
  const o = x && typeof x === "object" ? x : {};
  const kg = typeof o.kgPerUnit === "number" && o.kgPerUnit > 0 && o.kgPerUnit <= 100000 ? Math.round(o.kgPerUnit * 1000) / 1000 : null;
  const origin = clip(o.origin, 10).toUpperCase(); // "Spanje" mag niet "SP" worden: alleen precies 2 letters
  return {
    isProduce: o.isProduce !== false,
    product: clip(o.product, 80),
    ras: clip(o.ras, 80),
    category: CATEGORIES.includes(o.category) ? o.category : "",
    klasse: KLASSEN.includes(o.klasse) ? o.klasse : "",
    origin: /^[A-Z]{2}$/.test(origin) ? origin : "",
    unit: UNITS.includes(o.unit) ? o.unit : "",
    pack: clip(o.pack, 120),
    kgPerUnit: o.unit === "kg" ? 1 : kg,
    note: clip(o.note, 400),
    confidence: ["hoog", "middel", "laag"].includes(o.confidence) ? o.confidence : "laag",
    remarks: clip(o.remarks, 300),
  };
}

export function aiConfigured() { return !!process.env.ANTHROPIC_API_KEY; }
export function aiModel() { return /^[a-z0-9.-]{3,60}$/.test(process.env.AI_MODEL || "") ? process.env.AI_MODEL : AI_DEFAULT_MODEL; }

export function createAi({ q, httpError, log }) {
  async function count(kind, key, sinceMs) {
    const r = await q("SELECT COUNT(*)::int AS n FROM rpb_attempts WHERE kind = $1 AND ip = $2 AND at > $3", [kind, key, new Date(Date.now() - sinceMs)]);
    return Number(r.rows[0].n);
  }

  async function suggestFromPhoto(me, photoId) {
    if (!/^p[a-f0-9]{18}$/.test(photoId || "")) throw httpError(400, "Kies eerst een foto.");
    const pr = await q("SELECT owner, mime, full_img FROM rpb_photos WHERE id = $1", [photoId]);
    const ph = pr.rows[0];
    if (!ph) throw httpError(404, "Deze foto bestaat niet (meer). Voeg hem opnieuw toe.");
    if (ph.owner !== me.id) throw httpError(403, "Je kunt alleen je eigen foto's laten herkennen.");
    if (await count("ai", me.id, 3600000) >= PER_USER_PER_HOUR) throw httpError(429, "Je hebt het afgelopen uur al veel foto's laten herkennen. Probeer het later opnieuw of vul de gegevens zelf in.");
    if (await count("ai", "_site", 86400000) >= PER_SITE_PER_DAY) throw httpError(429, "De AI-herkenning is voor vandaag op. Vul de gegevens zelf in.");
    const now = new Date();
    await q("INSERT INTO rpb_attempts (kind, ip, at) VALUES ('ai', $1, $2), ('ai', '_site', $2)", [me.id, now]);

    const base = (process.env.AI_API_BASE || "https://api.anthropic.com").replace(/\/$/, "");
    const model = aiModel();
    const t0 = Date.now();
    let res, body;
    try {
      res = await fetch(base + "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model, max_tokens: 700, system: SYSTEM, tools: [TOOL], tool_choice: { type: "tool", name: TOOL.name },
          messages: [{ role: "user", content: [
            { type: "image", source: { type: "base64", media_type: ph.mime, data: ph.full_img } },
            { type: "text", text: "Stel de gegevens voor van deze restpartij." },
          ] }],
        }),
        signal: AbortSignal.timeout(AI_TIMEOUT_MS),
      });
      body = await res.json().catch(() => null);
    } catch (e) {
      console.error("ai", e);
      throw httpError(504, e?.name === "TimeoutError" ? "De AI deed er te lang over. Probeer het nog eens of vul de gegevens zelf in." : "De AI is nu niet bereikbaar. Vul de gegevens zelf in.");
    }
    if (!res.ok) {
      console.error("ai", res.status, body?.error);
      const why = res.status === 401 ? "de sleutel (ANTHROPIC_API_KEY) klopt niet" : res.status === 429 || res.status === 529 ? "de AI is even te druk" : `fout ${res.status}`;
      throw httpError(502, `AI-herkenning lukte niet (${why}). Vul de gegevens zelf in.`);
    }
    const use = (body?.content || []).find((c) => c.type === "tool_use" && c.name === TOOL.name);
    if (!use) throw httpError(502, "De AI gaf geen bruikbaar antwoord. Probeer een andere foto of vul de gegevens zelf in.");
    const suggestion = cleanSuggestion(use.input);
    const ms = Date.now() - t0;
    await log(me, "partij", `AI-voorstel uit foto: ${suggestion.isProduce ? suggestion.product || "onbekend" : "geen AGF herkend"} (${model}, ${ms} ms, ${body?.usage?.input_tokens || "?"}+${body?.usage?.output_tokens || "?"} tokens)`);
    return { suggestion, model, ms };
  }
  return { suggestFromPhoto };
}
