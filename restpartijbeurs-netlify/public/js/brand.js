// Restpartijbeurs / FoodSource – huisstijl: eigen logo
// Toont het logo in de kopregel, het tabblad van de browser en als icoon op het beginscherm van een telefoon.
// Onder Beheer → Instellingen kiest de beheerder een logo; de browser maakt daar zelf de vierkante
// app-iconen van (512, 192, 180 en 32 pixels) met de gekozen achtergrondkleur. De server bewaart alleen
// PNG/JPEG/WebP, nooit SVG (daar kan code in zitten): een SVG wordt hier eerst omgezet naar PNG.

// Alles in een eigen scope, zodat namen als loadImage niet botsen met de andere bestanden; alleen applyBrand is algemeen.
(() => {
const brandUrl = (file, s) => `/api/brand/${file}${s.logoVersion ? "?v=" + s.logoVersion : ""}`;

function applyBrand(s) {
  const has = !!s.logoVersion;
  const img = $("#site-logo");
  img.hidden = !has;
  if (has) { img.src = brandUrl("logo", s); img.alt = s.logoShowName ? "" : s.siteName; }
  $("#site-name").classList.toggle("sr-only", has && !s.logoShowName);
  document.querySelector(".brand")?.classList.toggle("has-logo", has);
  $("#lnk-icon").href = brandUrl("icon-32.png", s);
  $("#lnk-apple").href = brandUrl("icon-180.png", s);
  $("#meta-apptitle").content = s.siteName;
  if (!LG.dirty) fillLogoCard(s);
}

// ---------- instellen (beheer) ----------
const LG = { logo: null, icon: null, dirty: false, newLogo: false, removeArmed: 0 };
const ICON_PX = [512, 192, 180, 32];

function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("Dit bestand kan niet als afbeelding geopend worden."));
    im.src = src;
  });
}
async function fileToImage(file) {
  if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type)) throw new Error("Kies een PNG-, JPEG-, WebP- of SVG-bestand.");
  if (file.size > 8 * 1024 * 1024) throw new Error("Dit bestand is groter dan 8 MB. Kies een kleiner bestand.");
  const url = URL.createObjectURL(file);
  try { return await loadImage(url); } finally { setTimeout(() => URL.revokeObjectURL(url), 2000); }
}
const natural = (im) => ({ w: im.naturalWidth || 600, h: im.naturalHeight || 200 });

// Logo voor de kopregel: maximaal 200 px hoog en 800 px breed (scherp genoeg voor retina), doorzichtig blijft doorzichtig
function renderLogo(im) {
  const { w, h } = natural(im);
  const k = Math.min(200 / h, 800 / w, im.naturalWidth ? 4 : 1);
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(w * k)); cv.height = Math.max(1, Math.round(h * k));
  const cx = cv.getContext("2d"); cx.imageSmoothingQuality = "high";
  cx.drawImage(im, 0, 0, cv.width, cv.height);
  let out = cv.toDataURL("image/png");
  if (out.length * 0.75 > 550 * 1024) out = cv.toDataURL("image/webp", 0.9);
  return out;
}
// Vierkant app-icoon: achtergrondkleur, beeld gecentreerd binnen een veilige marge (telefoons ronden de hoeken af)
function renderIcon(im, n, bg) {
  const cv = document.createElement("canvas"); cv.width = cv.height = n;
  const cx = cv.getContext("2d"); cx.imageSmoothingQuality = "high";
  cx.fillStyle = bg; cx.fillRect(0, 0, n, n);
  const { w, h } = natural(im);
  const box = n * (n <= 32 ? 0.92 : 0.72);
  const k = Math.min(box / w, box / h);
  const dw = w * k, dh = h * k;
  cx.drawImage(im, (n - dw) / 2, (n - dh) / 2, dw, dh);
  return cv.toDataURL("image/png");
}

function logoMsg(t, kind) { const el = $("#logo-msg"); el.textContent = t || ""; el.className = "sub" + (kind ? " " + kind : ""); }
function fillLogoCard(s) {
  if (!$("#logo-card")) return;
  const has = !!s.logoVersion;
  $("#logo-prev-img").hidden = !has;
  if (has) $("#logo-prev-img").src = brandUrl("logo", s);
  $("#logo-prev-name").textContent = s.siteName;
  $("#logo-prev-name").hidden = has && !s.logoShowName;
  $("#logo-prev-icon").src = brandUrl("icon-512.png", s);
  $("#logo-bg").value = s.logoBg || "#ffffff";
  $("#logo-showname").checked = s.logoShowName !== false;
  $("#logo-remove").hidden = !has;
  $("#logo-remove").textContent = "Logo verwijderen"; LG.removeArmed = 0;
  $("#logo-save").disabled = true;
}
// Voorbeeld bijwerken na elke keuze; pas bij "Logo opslaan" gaat het naar de server
async function previewLogo() {
  const s = S.settings || {};
  const src = LG.icon || LG.logo;
  if (LG.logo) { $("#logo-prev-img").src = renderLogo(LG.logo); $("#logo-prev-img").hidden = false; }
  if (src) $("#logo-prev-icon").src = renderIcon(src, 512, $("#logo-bg").value);
  $("#logo-prev-name").textContent = s.siteName || "";
  $("#logo-prev-name").hidden = !!(LG.logo || s.logoVersion) && !$("#logo-showname").checked;
  LG.dirty = true; $("#logo-save").disabled = false;
  const { w, h } = src ? natural(src) : { w: 1, h: 1 };
  logoMsg(!LG.icon && w / h > 2.2 ? "Nog niet opgeslagen. Tip: je logo is breed, dus klein in het app-icoon. Kies via \"Apart app-icoon…\" een vierkant beeldmerk (bijv. alleen het symbool)." : "Nog niet opgeslagen.");
}
async function pick(e, which) {
  const f = e.target.files && e.target.files[0]; e.target.value = "";
  if (!f) return;
  try {
    const im = await fileToImage(f);
    LG[which] = im; LG.newLogo = true; // nieuw logo of nieuw icoon: altijd nieuwe iconen meesturen
    // Achtergrondkleur of apart icoon gekozen zonder nieuw logo: het bestaande logo opnieuw gebruiken
    if (which === "icon" && !LG.logo && S.settings?.logoVersion) LG.logo = await loadImage(brandUrl("logo", S.settings));
    await previewLogo();
  } catch (err) { logoMsg(err.message, "warn"); }
}
$("#logo-file").addEventListener("change", (e) => pick(e, "logo"));
$("#logo-icon-file").addEventListener("change", (e) => pick(e, "icon"));
$("#logo-bg").addEventListener("input", async () => {
  try { if (!LG.logo && S.settings?.logoVersion) LG.logo = await loadImage(brandUrl("logo", S.settings)); } catch {}
  if (LG.logo || LG.icon) { LG.newLogo = true; await previewLogo(); }
});
$("#logo-showname").addEventListener("change", previewLogo);

$("#logo-save").addEventListener("click", async () => {
  const btn = $("#logo-save");
  const body = { bg: $("#logo-bg").value, showName: $("#logo-showname").checked };
  if (LG.newLogo && !LG.logo) { logoMsg("Het huidige logo kon niet geladen worden. Kies het logo opnieuw via \"Logo kiezen…\".", "warn"); return; }
  if (LG.newLogo && LG.logo) {
    const src = LG.icon || LG.logo;
    body.logo = renderLogo(LG.logo);
    body.icons = Object.fromEntries(ICON_PX.map((n) => [n, renderIcon(src, n, body.bg)]));
  } else if (!S.settings?.logoVersion) { logoMsg("Kies eerst een logo.", "warn"); return; }
  btn.disabled = true; logoMsg("Opslaan…");
  try {
    const d = await api("admin/logo", { method: "PUT", body, timeout: 30000 });
    LG.logo = LG.icon = null; LG.dirty = LG.newLogo = false;
    applySettings(d.settings);
    logoMsg(""); toast("Logo opgeslagen. Het staat nu bovenaan de site en in het app-icoon.");
  } catch (err) { btn.disabled = false; logoMsg(err.message, "warn"); }
});
$("#logo-remove").addEventListener("click", async () => {
  const btn = $("#logo-remove");
  if (Date.now() - LG.removeArmed > 4000) { LG.removeArmed = Date.now(); btn.textContent = "Zeker weten? Klik nogmaals"; return; }
  btn.disabled = true;
  try {
    const d = await api("admin/logo", { method: "DELETE" });
    LG.logo = LG.icon = null; LG.dirty = LG.newLogo = false;
    applySettings(d.settings); toast("Logo verwijderd.");
  } catch (err) { logoMsg(err.message, "warn"); }
  finally { btn.disabled = false; }
});

window.applyBrand = applyBrand;
})();
