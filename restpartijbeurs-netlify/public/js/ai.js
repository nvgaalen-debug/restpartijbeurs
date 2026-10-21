// Restpartijbeurs / FoodSource – partijgegevens laten voorstellen op basis van een foto (Claude)
// Werkt in het venster "Partij aanbieden". Na de eerste foto bij een nieuwe partij vult de app
// de velden alvast in; de aanbieder controleert en vult hoeveelheid, prijs en datum zelf in.
// Velden die de aanbieder zelf al heeft aangeraakt, blijven altijd staan.

const AIF = {
  product: "#f-product", ras: "#f-ras", category: "#f-cat", klasse: "#f-klasse", origin: "#f-herkomst",
  unit: "#f-unit", kgPerUnit: "#f-kg", pack: "#f-pack", note: "#f-note",
};
const AI_LABEL = { product: "product", ras: "ras", category: "categorie", klasse: "klasse", origin: "herkomst", unit: "eenheid", kgPerUnit: "kg per eenheid", pack: "verpakking", note: "toelichting" };
const AIS = { touched: new Set(), busy: false, autoDone: false };

const aiOn = () => !!(S.settings && S.settings.aiEnabled);
function aiStatus(html, kind) {
  const el = $("#ai-status");
  el.hidden = !html; el.className = "ai-status" + (kind ? " " + kind : ""); el.innerHTML = html || "";
}
function aiRefresh() {
  const strip = $("#ai-strip");
  strip.hidden = !aiOn();
  if (strip.hidden) return;
  const has = S.dlgPhotos.length > 0;
  $("#ai-title").textContent = has ? "Gegevens laten invullen" : "Begin met een foto";
  $("#ai-btn").textContent = AIS.busy ? "Bezig…" : has ? "Vul in met AI" : "Foto maken";
  $("#ai-btn").disabled = AIS.busy || S.uploading > 0;
}

document.addEventListener("lot-dialog-open", () => {
  AIS.touched = new Set(); AIS.busy = false; AIS.autoDone = !!S.editing;
  $$("#form-lot .ai-filled").forEach((el) => el.classList.remove("ai-filled"));
  aiStatus("");
  aiRefresh();
});
// Wat de aanbieder zelf typt of kiest, overschrijft de AI nooit
$("#form-lot").addEventListener("input", (e) => { if (e.isTrusted && e.target.id) { AIS.touched.add("#" + e.target.id); e.target.classList.remove("ai-filled"); } });
$("#form-lot").addEventListener("change", (e) => { if (e.isTrusted && e.target.id) { AIS.touched.add("#" + e.target.id); e.target.classList.remove("ai-filled"); } });
// Foto toegevoegd: bij een nieuwe partij meteen laten herkennen (eenmalig)
document.addEventListener("lot-photo-added", (e) => {
  aiRefresh();
  if (aiOn() && !AIS.autoDone && !S.editing && !AIS.touched.has("#f-product")) { AIS.autoDone = true; runAi(e.detail); }
});
$("#photo-edit").addEventListener("click", () => setTimeout(aiRefresh, 0)); // foto verwijderd
$("#ai-btn").addEventListener("click", () => {
  if (S.dlgPhotos.length) runAi(S.dlgPhotos[0]);
  else $("#f-photo-cam").click();
});
$("#f-photo-cam").addEventListener("change", (e) => { const f = e.target.files; if (f && f.length) addPhotos(f); e.target.value = ""; });

async function runAi(photoId) {
  if (AIS.busy) return;
  AIS.busy = true; aiRefresh();
  aiStatus(`<span class="ai-spin" aria-hidden="true"></span> Claude bekijkt de foto…`);
  try {
    const d = await api("ai/lot-photo", { method: "POST", body: { photoId }, timeout: 20000 });
    if (!$("#dlg-lot").open) return;
    const s = d.suggestion;
    if (!s.isProduce) {
      aiStatus(`Op deze foto herkent de AI geen aardappelen, groente of fruit.${s.remarks ? " " + esc(s.remarks) : ""} Vul de gegevens zelf in of probeer een andere foto.`, "warn");
      return;
    }
    const filled = [];
    for (const [k, sel] of Object.entries(AIF)) {
      let val = s[k];
      if (val === null || val === undefined || val === "") continue;
      if (k === "kgPerUnit") val = String(val).replace(".", ",");
      const el = $(sel);
      if (AIS.touched.has(sel)) continue;                       // zelf ingevuld: laten staan
      if (S.editing && el.value && el.tagName !== "SELECT") continue; // bestaande partij: alleen lege velden
      if (S.editing && el.tagName === "SELECT") continue;
      if (el.tagName === "SELECT" && ![...el.options].some((o) => o.value === val)) continue;
      el.value = val; el.classList.add("ai-filled"); filled.push(AI_LABEL[k]);
    }
    $("#f-kg-field").hidden = $("#f-unit").value === "kg";
    const conf = { hoog: ["ok", "zeker"], middel: ["warn", "redelijk zeker"], laag: ["warn", "onzeker"] }[s.confidence] || ["warn", "onzeker"];
    aiStatus(filled.length
      ? `<span class="pill ${conf[0]}">AI: ${conf[1]}</span> Ingevuld: ${esc(filled.join(", "))}. <b>Controleer de gemarkeerde velden</b> en vul hoeveelheid, prijs en datum zelf in.${s.remarks ? `<br><span class="sub">${esc(s.remarks)}</span>` : ""}`
      : `De AI had geen aanvullingen op wat er al staat.${s.remarks ? " " + esc(s.remarks) : ""}`, filled.length ? "ok" : "");
    const firstEmpty = ["#f-qty", "#f-price"].find((x) => !$(x).value);
    if (firstEmpty && filled.length) $(firstEmpty).focus();
  } catch (err) {
    aiStatus(esc(err.message || "Herkennen lukte niet. Vul de gegevens zelf in."), "warn");
  } finally { AIS.busy = false; aiRefresh(); }
}
