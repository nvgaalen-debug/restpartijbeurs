// Restpartijbeurs – Opstarten van de app (moet als laatste geladen worden)
// Volgorde in index.html: core, market, account, admin, payments, stats, start.
// ---------- boot ----------
(async () => {
  const herstel = new URLSearchParams(location.search).get("herstel");
  if (herstel) { // link uit de e-mail "code vergeten": token direct uit de adresbalk halen
    history.replaceState(null, "", location.pathname);
    await showLogin(); showResetForm(herstel); return;
  }
  try { S.legacyToken = localStorage.getItem("rpb.token") || ""; } catch {}
  try { const d = await api("me"); setToken(true); enterApp(d.user); }
  catch (err) {
    S.legacyToken = "";
    if (err.status === 401 && !err.external) { await showLogin(); handleRequestReturn(); }
    else showLogin(err.message);
  }
})();
