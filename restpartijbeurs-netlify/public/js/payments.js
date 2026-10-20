// Restpartijbeurs – Abonnement online betalen via Mollie
// Volgorde in index.html: core, market, account, admin, payments, stats, start.
// ---------- abonnement betalen (Mollie) ----------
async function loadMySub() {
  if (!S.token) return;
  try { S.sub = await api("pay/me"); } catch { S.sub = null; }
  renderSub();
}
function subState() {
  const s = S.sub; if (!s) return null;
  const soon = new Date(Date.parse(s.today) + 30 * 86400000).toISOString().slice(0, 10);
  const block = s.required && !s.exempt;
  if (s.exempt && S.user?.role !== "beheerder") return { key: "exempt", title: "Je hebt geen abonnement nodig.", text: "De beheerder heeft je vrijgesteld." };
  if (!s.paidUntil) return { key: "none", title: "Je hebt nog geen abonnement.", text: block ? "Je kunt het aanbod bekijken, maar pas aanbieden en bieden als je abonnement is betaald." : "" };
  if (s.paidUntil < s.today) return { key: "expired", title: `Je abonnement is verlopen op ${fmtDate(s.paidUntil)}.`, text: block ? "Je kunt het aanbod bekijken, maar niet aanbieden of bieden tot je opnieuw betaalt." : "" };
  if (s.paidUntil <= soon) return { key: "soon", title: `Je abonnement loopt af op ${fmtDate(s.paidUntil)}.`, text: "Verleng op tijd, dan kun je zonder onderbreking blijven handelen." };
  return { key: "ok", title: "Abonnement actief.", text: `Einde abonnement: ${fmtDate(s.paidUntil)}.` };
}
function renderSub() {
  const s = S.sub, st = subState();
  // Zonder geldig abonnement: wel kijken, niet handelen (de server controleert dit ook)
  setCanWrite(s ? s.canTrade : true); // ververst het aanbod alleen als dit echt verandert
  const show = !!(s && st && s.priceExcl > 0 && S.user?.role === "handelaar" && !["ok", "exempt"].includes(st.key));
  $("#subbar").hidden = !show || document.body.classList.contains("locked");
  $("#subbar").classList.toggle("blocked", !!(s && !s.canTrade));
  const payLabel = s ? `${st && st.key === "soon" ? "Verlengen" : "Nu betalen"} · ${euro.format(s.priceIncl)} incl. btw` : "";
  if (show) {
    $("#subbar-title").textContent = st.title;
    $("#subbar-text").textContent = [st.text, s.onlinePayment ? `Een jaar kost ${euro.format(s.priceExcl)} excl. btw; na betaling loopt je abonnement tot ${fmtDate(s.nextUntil)}.` : "Neem contact op met de beheerder om te betalen."].filter(Boolean).join(" ");
    $("#subbar-pay").hidden = !s.onlinePayment; $("#subbar-pay").textContent = payLabel;
  }
  const showAcc = !!(s && st && (s.priceExcl > 0 || s.paidUntil) && S.user?.role !== "beheerder");
  $("#acc-sub-title").hidden = $("#acc-sub").hidden = !showAcc;
  if (showAcc) {
    $("#acc-sub-text").textContent = `${st.title} ${st.key === "ok" ? "" : st.text}`.trim() + (st.key === "ok" ? ` Einde abonnement: ${fmtDate(s.paidUntil)}.` : "");
    $("#acc-sub-pay").hidden = !s.onlinePayment || st.key === "exempt" || !(s.priceExcl > 0);
    $("#acc-sub-pay").textContent = st.key === "ok" ? `Verlengen tot ${fmtDate(s.nextUntil)} · ${euro.format(s.priceIncl)}` : payLabel;
  }
}
async function startPayment(btn) {
  if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = "Betaalpagina openen…"; }
  let leaving = false;
  try {
    const d = await api("pay/subscription", { method: "POST" });
    try { sessionStorage.setItem("rpb.payref", d.ref); } catch {}
    leaving = true; // knop uit laten staan terwijl de browser naar Mollie gaat (geen dubbele betaling)
    location.href = d.checkoutUrl;
  } catch (err) {
    toast(err.message);
  } finally {
    if (btn && !leaving) { btn.disabled = false; btn.textContent = btn.dataset.label; }
  }
}
$("#subbar-pay").addEventListener("click", (e) => startPayment(e.currentTarget));
$("#acc-sub-pay").addEventListener("click", (e) => startPayment(e.currentTarget));

// Terug van de betaalpagina: /?betaling=<ref>
async function handlePaymentReturn() {
  const params = new URLSearchParams(location.search);
  const ref = params.get("betaling");
  if (!ref || !S.token) return;
  history.replaceState(null, "", location.pathname);
  toast("Betaling controleren…");
  const TRIES = 10;
  for (let i = 0; i < TRIES; i++) {
    try {
      const st = await api("pay/status?ref=" + encodeURIComponent(ref));
      if (st.status === "paid") { toast(`Betaling gelukt. Einde abonnement: ${fmtDate(st.validUntil)}.`); break; }
      if (["canceled", "expired", "failed"].includes(st.status)) { toast(st.status === "canceled" ? "Betaling geannuleerd. Er is niets afgeschreven." : "De betaling is niet gelukt. Probeer het opnieuw."); break; }
    } catch (err) { toast(err.message); break; }
    if (i === TRIES - 1) { toast("De betaling wordt nog verwerkt. Je ziet het resultaat over een paar minuten bij Mijn account."); break; }
    await new Promise((r) => setTimeout(r, 2000)); // alleen wachten als er nog een poging komt
  }
  loadMySub();
}

function fillSettings() {
  const s = S.settings || {};
  $("#st-vat").value = String(s.vatPercent ?? 21).replace(".", ",");
  $("#st-auto").checked = !!s.autoApprovePaid;
  $("#st-require").checked = s.requireSubscription !== false;
  $$("input[name=st-pm]").forEach((c) => (c.checked = (s.payMethods || []).includes(c.value)));
  $("#st-mollie").innerHTML = s.onlinePayment
    ? `<span class="pill ${s.paymentTestMode ? "warn" : "ok"}">${s.paymentTestMode ? "Testmodus" : "Live"}</span> Mollie is gekoppeld. ${s.paymentTestMode ? "Betalingen zijn testbetalingen; er wordt geen geld overgemaakt." : "Handelaren kunnen hun abonnement online betalen."}`
    : `<span class="pill off">Niet gekoppeld</span> Zet je Mollie API-sleutel in Netlify als <code>MOLLIE_API_KEY</code> en doe een nieuwe deploy.`;
  $("#st-mail").innerHTML = s.mailEnabled
    ? `<span class="pill ok">Gekoppeld via ${s.mailProvider === "gmail" ? "Gmail" : "Brevo"}</span> Bij "Code vergeten?" krijgt een gebruiker een link op het e-mailadres van zijn account. Zonder bekend e-mailadres komt de melding hier bij Gebruikers.`
    : `<span class="pill off">Niet gekoppeld</span> Zet in Netlify <code>GMAIL_USER</code> (je Gmail-adres) en <code>GMAIL_APP_PASSWORD</code> (een app-wachtwoord van Google) en doe een nieuwe deploy. Tot die tijd komen meldingen "code vergeten" hier bij Gebruikers.`;
  $("#st-testmail-row").hidden = !s.mailEnabled;
  $("#wipe-panel").hidden = !s.wipeAllowed;
  $("#st-name").value = s.siteName || ""; $("#st-welcome").value = s.welcomeText || ""; $("#st-ann").value = s.announcement || "";
  $("#st-reg").checked = s.registrationOpen !== false; $("#st-price").value = ((s.subscriptionPrice || 0) / 100).toFixed(2).replace(".", ","); $("#st-subtext").value = s.subscriptionText || "";
  $("#st-err").textContent = "";
}
$("#wipe-btn").addEventListener("click", async () => {
  const scope = document.querySelector("input[name=wipe-scope]:checked")?.value;
  const confirm = $("#wipe-confirm").value.trim(), setupCode = $("#wipe-code").value;
  const err = confirm !== "LEEGMAKEN" ? "Typ LEEGMAKEN in hoofdletters ter bevestiging." : !setupCode ? "Vul de installatiecode in." : "";
  if (err) { $("#wipe-err").textContent = err; return; }
  const btn = $("#wipe-btn"); btn.disabled = true; $("#wipe-err").textContent = "";
  try {
    const d = await api("admin/wipe", { method: "POST", body: { scope, confirm, setupCode } });
    $("#wipe-confirm").value = ""; $("#wipe-code").value = "";
    if (d.scope === "all") { signOutLocal(); $("#user-box").hidden = true; showLogin(); toast("Alles is verwijderd. Maak de eerste beheerder opnieuw aan."); return; }
    S.lastNow = ""; await pull(true);
    toast(`Leeggemaakt: ${d.counts.rpb_photos} foto's en alle partijen en biedingen verwijderd.`);
  } catch (ex) { $("#wipe-err").textContent = ex.message; }
  finally { btn.disabled = false; }
});
$("#st-testmail-btn").addEventListener("click", async () => {
  const btn = $("#st-testmail-btn"); btn.disabled = true; $("#st-testmail-res").textContent = "Versturen…";
  try { const d = await api("admin/testmail", { method: "POST", body: { to: $("#st-testmail").value.trim() } }); $("#st-testmail-res").textContent = `Testmail verstuurd naar ${d.to}. Kijk ook in de map met ongewenste e-mail.`; }
  catch (err) { $("#st-testmail-res").textContent = err.message; }
  finally { btn.disabled = false; }
});
$("#form-settings").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#st-err").textContent = "";
  // Prijs en btw expliciet als getal versturen (prijs in hele centen). Een veld dat de browser
  // niet kan lezen is leeg; dat mag nooit stilletjes € 0 of 0% worden.
  const priceCents = parseEuroCents($("#st-price").value);
  const vatRaw = String($("#st-vat").value).replace(",", ".").replace("%", "").trim();
  const vat = vatRaw === "" ? NaN : Number(vatRaw);
  if (priceCents === null || priceCents > 10000000) { $("#st-err").textContent = "Vul een geldige abonnementsprijs in, bijvoorbeeld 120 of 120,50. Gratis? Vul dan 0 in."; $("#st-price").focus(); return; }
  if (!Number.isFinite(vat) || vat < 0 || vat > 100) { $("#st-err").textContent = "Vul een btw-percentage in tussen 0 en 100, bijvoorbeeld 21."; $("#st-vat").focus(); return; }
  try {
    const d = await api("admin/settings", { method: "PUT", body: {
      siteName: $("#st-name").value, welcomeText: $("#st-welcome").value, announcement: $("#st-ann").value,
      registrationOpen: $("#st-reg").checked, subscriptionPriceCents: priceCents, subscriptionText: $("#st-subtext").value,
      vatPercent: vat, autoApprovePaid: $("#st-auto").checked, requireSubscription: $("#st-require").checked, payMethods: $$("input[name=st-pm]").filter((c) => c.checked).map((c) => c.value),
    } });
    applySettings(d.settings); fillSettings(); toast("Instellingen opgeslagen.");
  } catch (err) { $("#st-err").textContent = err.message; }
});
