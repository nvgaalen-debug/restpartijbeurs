// Restpartijbeurs / FoodSource – automatisch de nieuwste versie laden
// Telefoons (vooral een icoon op het beginscherm) houden een geopende pagina lang vast. Daarom kijkt de app
// bij terugkomen in beeld en elke 5 minuten in /version.json of er een nieuwe versie online staat.
// Is dat zo, dan ververst hij de pagina, maar alleen als er niets openstaat (venster, typen, opslaan).
(() => {
  const mine = document.querySelector('meta[name="app-version"]')?.content || "";
  if (!mine || mine === "dev") return; // lokaal ontwikkelen: niets doen
  let waiting = false, lastCheck = 0;
  const busy = () => !!document.querySelector("dialog[open]") || (typeof S !== "undefined" && (S.pendingSaves > 0 || S.uploading > 0)) ||
    /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
  function reloadWhenIdle() {
    if (busy()) { setTimeout(reloadWhenIdle, 3000); return; }
    location.reload();
  }
  async function check(force) {
    if (waiting || document.hidden) return;
    if (!force && Date.now() - lastCheck < 60000) return;
    lastCheck = Date.now();
    try {
      const r = await fetch("/version.json?t=" + Date.now(), { cache: "no-store" });
      if (!r.ok) return;
      const v = (await r.json()).version;
      if (!v || v === mine) return;
      // Voorkom een lus als de server nog even de oude pagina geeft: per versie hoogstens één keer verversen
      try { if (sessionStorage.getItem("rpb.reloadedFor") === v) return; sessionStorage.setItem("rpb.reloadedFor", v); } catch {}
      waiting = true; reloadWhenIdle();
    } catch { /* geen verbinding: later opnieuw */ }
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) check(true); });
  window.addEventListener("pageshow", (e) => { if (e.persisted) check(true); });
  window.addEventListener("focus", () => check(false));
  setInterval(() => check(true), 5 * 60000);
  setTimeout(() => check(true), 5000);
})();
