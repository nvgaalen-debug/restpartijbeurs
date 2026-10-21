// Restpartijbeurs – Inloggen, account aanvragen, code vergeten/herstellen, mijn account
// Volgorde in index.html: core, market, account, admin, payments, stats, start.
// ---------- verplicht nieuwe code ----------
const dlgForce = $("#dlg-forcecode");
dlgForce.addEventListener("cancel", (e) => e.preventDefault()); // niet wegklikken met Escape
function openForceCode() {
  if (dlgForce.open) return;
  ["#fc-cur", "#fc-new", "#fc-new2"].forEach((id) => ($(id).value = "")); $("#fc-err").textContent = "";
  dlgForce.showModal(); $("#fc-cur").focus();
}
$("#form-forcecode").addEventListener("submit", async (e) => {
  e.preventDefault();
  const cur = $("#fc-cur").value, nw = $("#fc-new").value;
  const err = !cur ? "Vul je huidige code in." : nw.length < 12 ? "De nieuwe code moet minstens 12 tekens hebben." : nw !== $("#fc-new2").value ? "De twee nieuwe codes zijn niet gelijk." : "";
  if (err) { $("#fc-err").textContent = err; return; }
  try {
    const d = await api("me", { method: "PATCH", body: { currentCode: cur, newCode: nw } });
    dlgForce.close(); enterApp(d.user); toast("Nieuwe code opgeslagen.");
  } catch (ex) { $("#fc-err").textContent = ex.message; }
});
$("#fc-logout").addEventListener("click", async () => {
  try { await api("logout", { method: "POST" }); } catch {}
  dlgForce.close(); signOutLocal(); $("#user-box").hidden = true; showLogin("Je bent uitgelogd.");
});

// ---------- login ----------
// De sessie zit in een HttpOnly-cookie die JavaScript niet kan lezen. S.token zegt alleen nog óf je bent ingelogd.
function setToken(on) { S.token = on ? "1" : ""; S.legacyToken = ""; try { localStorage.removeItem("rpb.token"); } catch {} }
function signOutLocal() {
  stopPolling();
  setToken("");
  S.user = null; S.me = null; S.canWrite = null; S.ready = false; S.lastNow = "";
  S.lotsDocs = new Map(); S.bidsDocs = new Map(); S.versions = {}; S.market = {};
}
function hideAllViews() { ["market", "mine", "bids", "admin"].forEach((v) => ($("#view-" + v).hidden = true)); $("#announce").hidden = true; $("#subbar").hidden = true; }
async function showLogin(msg) {
  document.body.classList.add("locked");
  hideAllViews();
  $("#view-login").hidden = false;
  $("#status").hidden = true;
  let needsSetup = false;
  try { const st = await api("status"); needsSetup = st.needsSetup; applySettings(st.settings); try { sessionStorage.removeItem("rpb.reloaded"); } catch {} }
  catch (e) {
    $("#form-setup").hidden = true; $("#form-login").hidden = true;
    const el = $("#status"); el.hidden = false;
    // Eén keer automatisch de hele pagina herladen bij een geweigerde verbinding van buitenaf
    let tried = false; try { tried = sessionStorage.getItem("rpb.reloaded") === "1"; } catch {}
    if (e.external && !tried) { try { sessionStorage.setItem("rpb.reloaded", "1"); } catch {} location.reload(); return; }
    el.innerHTML = `<strong>${e.external ? "Geen verbinding met de app." : e.status === 0 ? "Geen internetverbinding." : "De server is niet goed ingesteld."}</strong> <span id="status-msg"></span> <button class="btn small" type="button" id="btn-retry">${e.external ? "Pagina herladen" : "Opnieuw proberen"}</button>`;
    $("#status-msg").textContent = e.message;
    $("#btn-retry").addEventListener("click", () => (e.external ? location.reload() : showLogin()));
    return;
  }
  // Heeft de gebruiker intussen al 'Account aanvragen' geopend, laat dat dan staan.
  const busy = !needsSetup && ["#form-register", "#reg-done", "#form-forgot", "#forgot-done", "#form-reset", "#form-recover"].some((id) => !$(id).hidden);
  $("#form-setup").hidden = !needsSetup;
  if (busy) return;
  $("#form-login").hidden = needsSetup;
  $("#form-register").hidden = true; $("#reg-done").hidden = true; $("#form-forgot").hidden = true; $("#forgot-done").hidden = true;
  if (!needsSetup) { $("#login-err").textContent = msg || $("#login-err").textContent || ""; $("#l-name").focus(); }
  else $("#s-setup").focus();
}

// ---------- account aanvragen ----------
function showLoginForm() { $("#form-recover").hidden = true; $("#form-reset").hidden = true; $("#form-register").hidden = true; $("#reg-done").hidden = true; $("#form-forgot").hidden = true; $("#forgot-done").hidden = true; $("#form-login").hidden = false; $("#l-name").focus(); }
$("#btn-forgot").addEventListener("click", () => {
  $("#form-login").hidden = true; $("#form-forgot").hidden = false; $("#fg-err").textContent = "";
  $("#fg-name").value = $("#l-name").value.trim(); ($("#fg-name").value ? $("#fg-contact") : $("#fg-name")).focus();
});
$("#fg-back").addEventListener("click", showLoginForm);
function forgotTexts() {
  const mail = !!S.settings?.mailEnabled;
  $("#fg-intro").textContent = mail
    ? "Vul de naam in waarmee je inlogt. Je krijgt een e-mail met een link om een nieuwe code te kiezen, op het e-mailadres dat bij je account hoort."
    : "Vul je naam in en hoe we je kunnen bereiken. De beheerder neemt contact met je op en geeft je een tijdelijke code. Bij het inloggen kies je daarna zelf een nieuwe.";
  $("#fg-contact-label").textContent = mail ? "Telefoon (optioneel, voor als we je niet kunnen mailen)" : "Telefoon of e-mail";
  $("#fg-done-text").textContent = mail
    ? "Als deze naam bij ons bekend is, krijg je binnen een paar minuten een e-mail met een link. Die werkt 60 minuten. Niets ontvangen? Kijk ook in je map met ongewenste e-mail, of neem contact op met de beheerder."
    : "Als deze naam bij ons bekend is, neemt de beheerder zo snel mogelijk contact met je op. Je krijgt dan een tijdelijke code.";
}
$("#btn-forgot").addEventListener("click", forgotTexts);
// Link uit de e-mail: /?herstel=<token>
let resetToken = "";
function showResetForm(token) {
  resetToken = token;
  ["#form-login", "#form-register", "#reg-done", "#form-forgot", "#forgot-done", "#form-setup"].forEach((id) => ($(id).hidden = true));
  $("#form-reset").hidden = false; $("#rsf-err").textContent = ""; $("#rs-new").focus();
}
$("#form-reset").addEventListener("submit", async (e) => {
  e.preventDefault();
  const c1 = $("#rs-new").value;
  const err = c1.length < 12 ? "De code moet minstens 12 tekens hebben." : c1 !== $("#rs-new2").value ? "De twee codes zijn niet gelijk." : "";
  if (err) { $("#rsf-err").textContent = err; return; }
  const btn = $("#rsf-submit"); btn.disabled = true;
  try {
    const d = await api("reset", { method: "POST", body: { token: resetToken, code: c1 } });
    resetToken = ""; $("#rs-new").value = ""; $("#rs-new2").value = "";
    $("#form-reset").hidden = true; showLoginForm();
    $("#l-name").value = d.name || ""; $("#l-code").focus();
    $("#login-err").textContent = "Je nieuwe code is opgeslagen. Log hiermee in.";
  } catch (ex) { $("#rsf-err").textContent = ex.message; }
  finally { btn.disabled = false; }
});
["#fg-name", "#fg-contact"].forEach((id) => $(id).addEventListener("input", () => ($("#fg-err").textContent = "")));
$("#fg-done-back").addEventListener("click", showLoginForm);
// Beheerder herstellen met de installatiecode
$("#btn-to-recover").addEventListener("click", () => {
  $("#form-forgot").hidden = true; $("#form-recover").hidden = false; $("#rcv-err").textContent = "";
  $("#rc-name").value = $("#fg-name").value.trim(); $("#rc-setup").focus();
});
$("#rcv-back").addEventListener("click", showLoginForm);
$("#form-recover").addEventListener("submit", async (e) => {
  e.preventDefault();
  const setupCode = $("#rc-setup").value, name = $("#rc-name").value.trim(), code = $("#rc-new").value;
  const err = !setupCode ? "Vul de installatiecode in." : !name ? "Vul de naam van de beheerder in." : code.length < 12 ? "De nieuwe code moet minstens 12 tekens hebben." : code !== $("#rc-new2").value ? "De twee codes zijn niet gelijk." : "";
  if (err) { $("#rcv-err").textContent = err; return; }
  const btn = $("#rcv-submit"); btn.disabled = true;
  try {
    const d = await api("recover", { method: "POST", body: { setupCode, name, code } });
    ["#rc-setup", "#rc-new", "#rc-new2"].forEach((id) => ($(id).value = ""));
    showLoginForm(); $("#l-name").value = d.name || name; $("#l-code").focus();
    $("#login-err").textContent = "Je nieuwe code is opgeslagen. Log hiermee in.";
  } catch (ex) { $("#rcv-err").textContent = ex.message; }
  finally { btn.disabled = false; }
});
$("#form-forgot").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#fg-name").value.trim(), contact = $("#fg-contact").value.trim();
  const err = !name ? "Vul je naam in." : !contact && !S.settings?.mailEnabled ? "Vul je telefoonnummer of e-mailadres in." : "";
  if (err) { $("#fg-err").textContent = err; return; }
  const btn = $("#fg-submit"); btn.disabled = true;
  try {
    await api("forgot", { method: "POST", body: { name, contact, note: $("#fg-note").value.trim(), website: $("#fg-website").value } });
    ["#fg-name", "#fg-contact", "#fg-note"].forEach((id) => ($(id).value = ""));
    $("#form-forgot").hidden = true; $("#forgot-done").hidden = false;
  } catch (ex) { $("#fg-err").textContent = ex.message; }
  finally { btn.disabled = false; }
});
$("#btn-to-register").addEventListener("click", () => {
  $("#form-login").hidden = true; $("#form-register").hidden = false; $("#reg-err").textContent = ""; $("#r-company").focus();
});
$("#btn-to-login").addEventListener("click", showLoginForm);
$("#btn-done-login").addEventListener("click", showLoginForm);
$("#form-register").addEventListener("submit", async (e) => {
  e.preventDefault();
  const val = (id) => $(id).value.trim();
  const kvk = val("#r-kvk").replace(/[\s.]/g, "");
  const err = !val("#r-company") ? "Vul je bedrijfsnaam in."
    : !/^\d{8}$/.test(kvk) ? "Vul een KvK-nummer van 8 cijfers in."
    : !val("#r-phone") && !val("#r-email") ? "Vul een telefoonnummer of e-mailadres in."
    : !val("#r-name") ? "Vul je naam in."
    : $("#r-code").value.length < 12 ? "Kies een code van minstens 12 tekens. Een paar woorden achter elkaar werkt goed."
    : $("#r-code").value !== $("#r-code2").value ? "De twee codes zijn niet gelijk." : "";
  if (err) { $("#reg-err").textContent = err; return; }
  const btn = e.submitter; if (btn) btn.disabled = true;
  try {
    const payNow = !$("#reg-pay").hidden && (document.querySelector("input[name=r-pay]:checked")?.value === "now");
    const d = await api("register", { method: "POST", body: {
      company: val("#r-company"), kvk, phone: val("#r-phone"), email: val("#r-email"), note: val("#r-note"),
      name: val("#r-name"), code: $("#r-code").value, website: $("#r-website").value, payNow,
    } });
    try { sessionStorage.setItem("rpb.regname", val("#r-name")); } catch {}
    if (d.checkoutUrl) { location.href = d.checkoutUrl; return; }
    $("#reg-done-text").textContent = `Bedankt, ${val("#r-name")}. De beheerder bekijkt je aanvraag voor ${val("#r-company")}. Zodra die is goedgekeurd, log je in met de naam "${val("#r-name")}" en de code die je net hebt gekozen.`
      + (d.payError ? ` Online betalen lukte nu niet (${d.payError}); dat kan later via Mijn account.` : "");
    $("#l-name").value = val("#r-name");
    ["#r-company", "#r-kvk", "#r-phone", "#r-email", "#r-note", "#r-name", "#r-code", "#r-code2"].forEach((id) => ($(id).value = ""));
    $("#form-register").hidden = true; $("#reg-done").hidden = false;
  } catch (ex) { $("#reg-err").textContent = ex.message; }
  finally { if (btn) btn.disabled = false; }
});
function enterApp(user) {
  S.user = user; S.me = user.id; S.canWrite = true;
  if (user.mustChange) { document.body.classList.add("locked"); hideAllViews(); $("#view-login").hidden = true; openForceCode(); return; }
  document.body.classList.remove("locked");
  $("#user-box").hidden = false;
  $("#btn-account").textContent = user.name + (user.company ? " · " + user.company : "");
  $("#tab-admin").hidden = user.role !== "beheerder";
  let v = "market";
  try {
    const s = localStorage.getItem("rpb.view"); if (["mine", "bids"].includes(s) || (s === "admin" && user.role === "beheerder")) v = s;
    const ap = localStorage.getItem("rpb.apane"); if (["dash", "stats", "users", "lots", "reasons", "log", "settings"].includes(ap)) S.apane = ap;
  } catch {}
  setView(v);
  render();
  startPolling();
  loadSettings();
  loadMySub().then(handlePaymentReturn);
}
$("#form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#l-name").value.trim(), code = $("#l-code").value;
  if (!name || !code) { $("#login-err").textContent = "Vul je naam en code in."; return; }
  $("#login-err").textContent = "";
  try {
    const d = await api("login", { method: "POST", body: { name, code } });
    setToken(true); $("#l-code").value = "";
    enterApp(d.user);
  } catch (err) { $("#login-err").textContent = err.message; }
});
$("#form-setup").addEventListener("submit", async (e) => {
  e.preventDefault();
  const val = (id) => $(id).value.trim();
  if ($("#s-code").value.length < 12) { $("#setup-err").textContent = "Kies een code van minstens 12 tekens."; return; }
  if ($("#s-code").value !== $("#s-code2").value) { $("#setup-err").textContent = "De twee codes zijn niet gelijk."; return; }
  try {
    const d = await api("setup", { method: "POST", body: { setupCode: val("#s-setup"), name: val("#s-name"), company: val("#s-company"), contact: val("#s-contact"), code: $("#s-code").value } });
    setToken(true);
    enterApp(d.user);
    toast("Beheerdersaccount aangemaakt. Maak nu de handelaren aan onder Beheer.");
  } catch (err) { $("#setup-err").textContent = err.message; }
});
$("#btn-logout").addEventListener("click", async () => {
  try { await api("logout", { method: "POST" }); } catch {}
  signOutLocal();
  $("#user-box").hidden = true;
  showLogin("Je bent uitgelogd.");
});

// ---------- account ----------
const dlgAcc = $("#dlg-account");
$("#btn-account").addEventListener("click", () => {
  $("#acc-sub").textContent = `Ingelogd als ${S.user.name} (${S.user.role}).`;
  $("#a-company").value = S.user.company || ""; $("#a-contact").value = S.user.contact || "";
  $("#a-cur").value = ""; $("#a-new").value = ""; $("#acc-err").textContent = "";
  const api = !!(S.settings && S.settings.apiEnabled);
  $("#acc-api-title").hidden = !api; $("#acc-api").hidden = !api;
  dlgAcc.showModal();
});
$("#form-account").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = { company: $("#a-company").value.trim(), contact: $("#a-contact").value.trim() };
  if ($("#a-new").value) { body.newCode = $("#a-new").value; body.currentCode = $("#a-cur").value; }
  try {
    const d = await api("me", { method: "PATCH", body });
    S.user = d.user;
    $("#btn-account").textContent = d.user.name + (d.user.company ? " · " + d.user.company : "");
    dlgAcc.close();
    toast(body.newCode ? "Account en code opgeslagen." : "Account opgeslagen.");
  } catch (err) { $("#acc-err").textContent = err.message; }
});
