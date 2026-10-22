// Restpartijbeurs / FoodSource – partijgegevens laten voorstellen door Claude
// Werkt in het venster "Partij aanbieden". Bronnen: een foto, een beschrijving (getypt, ingesproken
// of geplakt uit WhatsApp/mail) of allebei. Uit de beschrijving komen ook hoeveelheid, prijs, datum
// en afhaallocatie. Velden die de aanbieder zelf al heeft aangeraakt, blijven altijd staan.

const AIF = {
  product: "#f-product", ras: "#f-ras", category: "#f-cat", klasse: "#f-klasse", origin: "#f-herkomst",
  unit: "#f-unit", kgPerUnit: "#f-kg", pack: "#f-pack", note: "#f-note",
  qty: "#f-qty", minQty: "#f-minqty", price: "#f-price", until: "#f-until", location: "#f-loc",
};
const AI_LABEL = {
  product: "product", ras: "ras", category: "categorie", klasse: "klasse", origin: "herkomst", unit: "eenheid", kgPerUnit: "kg per eenheid",
  pack: "verpakking", note: "toelichting", qty: "hoeveelheid", minQty: "minimale afname", price: "prijs", until: "datum", location: "afhaallocatie",
};
const AIS = { touched: new Set(), busy: false, autoDone: false, rec: null, listening: false, micTimer: 0 };

const aiOn = () => !!(S.settings && S.settings.aiEnabled);
function aiStatus(html, kind) {
  const el = $("#ai-status");
  el.hidden = !html; el.className = "ai-status" + (kind ? " " + kind : ""); el.innerHTML = html || "";
}
function aiRefresh() {
  const strip = $("#ai-strip");
  strip.hidden = !aiOn();
  if (strip.hidden) return;
  const hasPhoto = S.dlgPhotos.length > 0, hasText = $("#ai-text").value.trim().length >= 3;
  $("#ai-cam-label").textContent = hasPhoto ? "Andere foto" : "Foto maken";
  $("#ai-btn").textContent = AIS.busy ? "Bezig…" : "Vul in met AI";
  $("#ai-btn").disabled = AIS.busy || S.uploading > 0 || !(hasPhoto || hasText);
  $("#ai-btn").title = hasPhoto || hasText ? "" : "Maak eerst een foto of beschrijf de partij";
}

document.addEventListener("lot-dialog-open", () => {
  AIS.touched = new Set(); AIS.busy = false; AIS.autoDone = !!S.editing;
  stopListening();
  $("#ai-text").value = "";
  $$("#form-lot .ai-filled").forEach((el) => el.classList.remove("ai-filled"));
  aiStatus("");
  aiRefresh();
});
// Wat de aanbieder zelf typt of kiest, overschrijft de AI nooit (de beschrijving zelf telt niet als veld)
for (const ev of ["input", "change"]) {
  $("#form-lot").addEventListener(ev, (e) => {
    if (!e.isTrusted || !e.target.id || e.target.id === "ai-text") return;
    AIS.touched.add("#" + e.target.id); e.target.classList.remove("ai-filled");
  });
}
$("#ai-text").addEventListener("input", aiRefresh);
// Ctrl/Cmd+Enter in de beschrijving = invullen
$("#ai-text").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!$("#ai-btn").disabled) $("#ai-btn").click(); } });

// Foto toegevoegd: bij een nieuwe partij meteen laten herkennen (eenmalig), samen met een eventuele beschrijving
document.addEventListener("lot-photo-added", (e) => {
  aiRefresh();
  if (aiOn() && !AIS.autoDone && !S.editing && !AIS.touched.has("#f-product")) { AIS.autoDone = true; runAi(e.detail, $("#ai-text").value); }
});
$("#photo-edit").addEventListener("click", () => setTimeout(aiRefresh, 0)); // foto verwijderd
$("#ai-cam").addEventListener("click", () => $("#f-photo-cam").click());
$("#ai-btn").addEventListener("click", () => { stopListening(); runAi(S.dlgPhotos[0] || "", $("#ai-text").value); });
$("#f-photo-cam").addEventListener("change", (e) => { const f = e.target.files; if (f && f.length) addPhotos(f); e.target.value = ""; });

// ---------- inspreken (spraakherkenning van de browser; anders de microfoon op het toetsenbord) ----------
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
// iPhone/iPad (ook Chrome daar, dat is ook Safari-techniek): de doorlopende modus negeert daar soms "stop" en
// blijft tekst sturen. Daar luisteren we per zin (stopt vanzelf na een korte stilte) en nooit langer dan 60 s.
const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
if (SpeechRec) $("#ai-mic").hidden = false;
function micUi(on) {
  $("#ai-mic").setAttribute("aria-pressed", String(on)); $("#ai-mic-label").textContent = on ? "Stop" : "Inspreken";
}
// Stoppen werkt altijd direct: de knop gaat meteen terug en latere berichten van de oude herkenning worden genegeerd
function stopListening() {
  const rec = AIS.rec;
  AIS.rec = null; AIS.listening = false; clearTimeout(AIS.micTimer);
  micUi(false);
  if (rec) {
    try { rec.stop(); } catch {}
    setTimeout(() => { try { rec.abort(); } catch {} }, 700); // als stop() genegeerd wordt
  }
}
$("#ai-mic").addEventListener("click", () => {
  if (AIS.listening) { stopListening(); aiStatus(""); aiRefresh(); return; }
  let rec;
  try { rec = new SpeechRec(); } catch { aiStatus("Inspreken lukte niet. Tik in het tekstvak op de microfoon van je toetsenbord.", "warn"); return; }
  rec.lang = "nl-NL"; rec.interimResults = true; rec.continuous = !IOS; rec.maxAlternatives = 1;
  const ta = $("#ai-text"), start = ta.value.trim() ? ta.value.trim() + " " : "";
  const mine = () => AIS.rec === rec;
  rec.onresult = (ev) => {
    if (!mine()) return;
    // Steeds de hele tekst opnieuw opbouwen: op de iPhone komen resultaten soms dubbel binnen
    let text = "";
    for (let i = 0; i < ev.results.length; i++) text += ev.results[i][0].transcript + (ev.results[i].isFinal ? " " : "");
    ta.value = (start + text.replace(/\s+/g, " ").trim()).slice(0, 1500); aiRefresh();
  };
  rec.onerror = (ev) => {
    if (!mine()) return;
    const msg = ev.error === "not-allowed" || ev.error === "service-not-allowed"
      ? "De microfoon mag niet gebruikt worden. Sta de microfoon toe (iPhone: Instellingen → Apps → Safari → Microfoon), of tik in het tekstvak op de microfoon van je toetsenbord."
      : ev.error === "no-speech" ? "Ik hoorde niets. Probeer het nog eens, of typ de beschrijving."
      : ev.error === "aborted" ? "" : "Inspreken lukte niet. Typ de beschrijving, of tik in het tekstvak op de microfoon van je toetsenbord.";
    stopListening(); aiStatus(msg ? esc(msg) : "", "warn"); aiRefresh();
  };
  rec.onend = () => {
    if (!mine()) return;
    stopListening(); aiRefresh();
    aiStatus(ta.value.trim() ? "Klaar. Controleer de tekst en tik op <b>Vul in met AI</b>, of tik nog eens op Inspreken om iets toe te voegen." : "");
  };
  try {
    rec.start(); AIS.rec = rec; AIS.listening = true; micUi(true);
    AIS.micTimer = setTimeout(() => { if (mine()) { stopListening(); aiRefresh(); } }, 60000);
    aiStatus("Spreek de partij in, bijvoorbeeld: <i>“tweehonderd dozen trostomaten, vier euro per doos, tot vrijdag, ophalen in Barendrecht”</i>." +
      (IOS ? " Het stopt vanzelf na een korte stilte." : " Tik op Stop als je klaar bent."));
  } catch { stopListening(); aiStatus("Inspreken lukte niet. Tik in het tekstvak op de microfoon van je toetsenbord.", "warn"); }
});

// ---------- voorstel ophalen en invullen ----------
function aiValue(k, v) {
  if (k === "price") return eurOut(v);
  if (k === "kgPerUnit" || k === "qty" || k === "minQty") return decOut(v);
  return v;
}
async function runAi(photoId, text) {
  if (AIS.busy) return;
  text = (text || "").trim();
  if (!photoId && text.length < 3) { aiStatus("Maak een foto of beschrijf de partij.", "warn"); return; }
  AIS.busy = true; aiRefresh();
  aiStatus(`<span class="ai-spin" aria-hidden="true"></span> Claude ${photoId && text ? "bekijkt de foto en leest je beschrijving" : photoId ? "bekijkt de foto" : "leest je beschrijving"}…`);
  try {
    const d = await api("ai/lot", { method: "POST", body: { photoId: photoId || "", text }, timeout: 20000 });
    if (!$("#dlg-lot").open) return;
    const s = d.suggestion;
    if (!s.isProduce) {
      aiStatus(`De AI herkent hier geen aardappelen, groente of fruit.${s.remarks ? " " + esc(s.remarks) : ""} Vul de gegevens zelf in of probeer het anders.`, "warn");
      return;
    }
    const filled = [];
    // Eerst de eenheid: die bepaalt of "kg per eenheid" zichtbaar is en hoe hoeveelheden gelezen worden
    const order = ["unit", ...Object.keys(AIF).filter((k) => k !== "unit")];
    for (const k of order) {
      const sel = AIF[k];
      let val = s[k];
      if (val === null || val === undefined || val === "") continue;
      if (k === "kgPerUnit" && s.unit === "kg") continue;
      val = aiValue(k, val);
      const el = $(sel);
      if (AIS.touched.has(sel)) continue;                         // zelf ingevuld: laten staan
      if (S.editing && el.value && el.tagName !== "SELECT") continue; // bestaande partij: alleen lege velden
      if (S.editing && el.tagName === "SELECT") continue;
      if (el.tagName === "SELECT" && ![...el.options].some((o) => o.value === val)) continue;
      el.value = val; el.classList.add("ai-filled"); filled.push(AI_LABEL[k]);
    }
    $("#f-kg-field").hidden = $("#f-unit").value === "kg";
    const missing = [["#f-qty", "hoeveelheid"], ["#f-price", "prijs"], ["#f-until", "datum"]].filter(([x]) => !$(x).value).map(([, n]) => n);
    const conf = { hoog: ["ok", "zeker"], middel: ["warn", "redelijk zeker"], laag: ["warn", "onzeker"] }[s.confidence] || ["warn", "onzeker"];
    aiStatus(filled.length
      ? `<span class="pill ${conf[0]}">AI: ${conf[1]}</span> Ingevuld: ${esc(filled.join(", "))}. <b>Controleer de gemarkeerde velden</b>${missing.length ? ` en vul zelf in: ${esc(missing.join(", "))}` : ""}.${s.remarks ? `<br><span class="sub">${esc(s.remarks)}</span>` : ""}`
      : `De AI had geen aanvullingen op wat er al staat.${s.remarks ? " " + esc(s.remarks) : ""}`, filled.length ? "ok" : "");
    const firstEmpty = ["#f-qty", "#f-price"].find((x) => !$(x).value);
    if (firstEmpty && filled.length && !matchMedia("(pointer: coarse)").matches) $(firstEmpty).focus();
  } catch (err) {
    aiStatus(esc(err.message || "Invullen lukte niet. Vul de gegevens zelf in."), "warn");
  } finally { AIS.busy = false; aiRefresh(); }
}
// Venster dicht (Annuleren, Publiceren, Escape): microfoon altijd uit
$("#dlg-lot").addEventListener("close", () => { if (AIS.listening) stopListening(); });
