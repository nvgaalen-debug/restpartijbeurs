// FoodSource – pushmeldingen op dit toestel (Mijn account → Meldingen op dit toestel)
// Werkt op Android en computer in de browser; op iPhone/iPad (iOS 16.4+) alleen als de site
// op het beginscherm staat en vanaf dat icoon is geopend.
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () => navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
let swReg = null;

async function pushRegistration() {
  if (!pushSupported()) return null;
  if (swReg) return swReg;
  try { swReg = await navigator.serviceWorker.register("/sw.js", { scope: "/" }); await navigator.serviceWorker.ready; }
  catch (e) { console.warn("service worker", e); swReg = null; }
  return swReg;
}
async function currentSubscription() {
  const reg = await pushRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}
const keyBytes = (b64) => { const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64.length + 3) % 4)); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };
function deviceLabel() {
  const ua = navigator.userAgent;
  const dev = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) || isIos() ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "computer";
  const br = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return isStandalone() ? `${dev} (app)` : br ? `${dev} (${br})` : dev;
}

// ---------- het blok in Mijn account ----------
function pushUi({ msg, ios = false, prefs = null, on = false, test = false, off = false, err = "" }) {
  $("#push-msg").textContent = msg || "";
  $("#push-ios").hidden = !ios;
  $("#push-prefs").hidden = !prefs;
  if (prefs) $$("#push-prefs [data-push]").forEach((c) => (c.checked = prefs[c.dataset.push] !== false));
  $("#push-on").hidden = !on; $("#push-test").hidden = !test; $("#push-off").hidden = !off;
  $("#push-err").textContent = err;
}
async function renderPush() {
  $("#acc-push-title").hidden = false; $("#acc-push").hidden = false;
  if (!pushSupported()) {
    if (isIos() && !isStandalone()) return pushUi({ msg: "Op een iPhone of iPad werken meldingen alleen als FoodSource op je beginscherm staat:", ios: true });
    return pushUi({ msg: isIos() ? "Meldingen hebben iOS 16.4 of nieuwer nodig. Werk je iPhone bij via Instellingen → Algemeen → Software-update." : "Deze browser ondersteunt geen pushmeldingen. Gebruik Chrome, Edge, Firefox of Safari." });
  }
  if (Notification.permission === "denied") {
    return pushUi({ msg: isIos() ? "Meldingen zijn geblokkeerd. Zet ze aan via Instellingen → Meldingen → FoodSource." : "Meldingen zijn geblokkeerd in je browser. Sta ze toe via het slotje naast het webadres en kom hier terug." });
  }
  pushUi({ msg: "Even kijken…" });
  try {
    const sub = await currentSubscription();
    const d = await api("push" + (sub ? "?endpoint=" + encodeURIComponent(sub.endpoint) : ""));
    S.pushKey = d.publicKey;
    if (sub && d.subscribed && Notification.permission === "granted") {
      return pushUi({ msg: "Meldingen staan aan. Kies wat je op dit toestel wilt krijgen:", prefs: d.prefs, test: true, off: true });
    }
    pushUi({ msg: "Krijg direct een melding bij een nieuw bod op je partij, als je bod gegund of afgewezen is, of als vraag en aanbod bij elkaar passen. Tik op een melding en de app opent op de juiste plek.", on: true });
  } catch (e) { pushUi({ msg: "", err: e.message }); }
}
async function pushTurnOn() {
  $("#push-err").textContent = "";
  $("#push-on").disabled = true;
  try {
    // Toestemming vragen moet direct na de tik (anders weigert Safari)
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { await renderPush(); if (perm === "default") $("#push-err").textContent = "Je hebt nog geen toestemming gegeven. Tik nogmaals en kies Sta toe."; return; }
    const reg = await pushRegistration();
    if (!reg) throw new Error("De app kon de meldingendienst niet starten. Herlaad de pagina en probeer het opnieuw.");
    if (!S.pushKey) S.pushKey = (await api("push")).publicKey;
    let sub = await reg.pushManager.getSubscription();
    // Ander sleutelpaar op de server (bijv. na het vervangen van de sleutels)? Dan opnieuw aanmelden.
    if (sub && sub.options?.applicationServerKey) {
      const have = btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      if (have !== S.pushKey) { await sub.unsubscribe(); sub = null; }
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(S.pushKey) });
    await api("push/subscribe", { method: "POST", body: { subscription: sub.toJSON(), label: deviceLabel(), prefs: { bid: true, awarded: true, rejected: true, match: true } } });
    toast("Meldingen staan aan op dit toestel.");
    await renderPush();
  } catch (e) { $("#push-err").textContent = e.message || "Aanzetten lukte niet."; }
  finally { $("#push-on").disabled = false; }
}
$("#push-on").addEventListener("click", pushTurnOn);
$("#push-off").addEventListener("click", async () => {
  try {
    const sub = await currentSubscription();
    if (sub) { await api("push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } }); await sub.unsubscribe().catch(() => {}); }
    toast("Meldingen staan uit op dit toestel.");
    await renderPush();
  } catch (e) { $("#push-err").textContent = e.message; }
});
$("#push-test").addEventListener("click", async () => {
  $("#push-err").textContent = "";
  try {
    const sub = await currentSubscription();
    if (!sub) return renderPush();
    await api("push/test", { method: "POST", body: { endpoint: sub.endpoint } });
    toast("Testmelding verstuurd. Hij verschijnt binnen een paar seconden.");
  } catch (e) { $("#push-err").textContent = e.message; if (e.status === 410) renderPush(); }
});
$$("#push-prefs [data-push]").forEach((c) => c.addEventListener("change", async () => {
  $("#push-err").textContent = "";
  const prefs = {}; $$("#push-prefs [data-push]").forEach((x) => (prefs[x.dataset.push] = x.checked));
  try {
    const sub = await currentSubscription();
    if (!sub) return renderPush();
    await api("push/prefs", { method: "PUT", body: { endpoint: sub.endpoint, prefs } });
  } catch (e) { c.checked = !c.checked; $("#push-err").textContent = e.message; }
}));
$("#btn-account").addEventListener("click", () => { renderPush(); });

// Bij uitloggen dit toestel afmelden, zodat de volgende gebruiker geen meldingen van jou krijgt
async function pushLogout() {
  try {
    const sub = pushSupported() ? await currentSubscription() : null;
    if (sub) await api("push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint }, timeout: 4000 });
  } catch { /* uitloggen gaat altijd door */ }
}

// ---------- tik op een melding: juiste scherm openen ----------
async function openFromPush(view, seller, lot, want) {
  if (!S.user) return;
  if (["market", "wanted", "mine", "bids"].includes(view)) setView(view);
  if (want && typeof showWant === "function") { if (typeof pull === "function") { try { await pull(); } catch {} } showWant(want); return; }
  if (!seller || !lot) return;
  const found = () => S.ready && allLots().some((x) => x.id === lot && x.sellerId === seller);
  // De melding kan nieuwer zijn dan wat de app al heeft: dan eerst de nieuwste gegevens ophalen
  if (!found() && S.ready && typeof pull === "function") { try { await pull(); } catch {} }
  const t0 = Date.now();
  while (!found() && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 300));
  if (found()) openLotDetail(seller, lot);
}
// App was dicht: de service worker opent /?open=…&seller=…&lot=…
(() => {
  const p = new URLSearchParams(location.search);
  const view = p.get("open");
  if (!view) return;
  history.replaceState(null, "", location.pathname);
  if (["market", "wanted", "mine", "bids"].includes(view)) { try { localStorage.setItem("rpb.view", view); } catch {} }
  const seller = p.get("seller") || "", lot = p.get("lot") || "", want = p.get("want") || "";
  const t0 = Date.now();
  (function wait() { if (S.user && S.ready) return openFromPush(view, seller, lot, want); if (Date.now() - t0 < 20000) setTimeout(wait, 300); })();
})();
// App stond al open
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "rpb-open") openFromPush(e.data.view, e.data.seller, e.data.lot, e.data.want);
  });
  // Service worker vroeg registreren, zodat meldingen ook binnenkomen als de app dicht is
  if (pushSupported()) window.addEventListener("load", () => { pushRegistration(); });
}
