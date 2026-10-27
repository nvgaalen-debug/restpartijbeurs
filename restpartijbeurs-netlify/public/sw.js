// FoodSource – service worker, alleen voor pushmeldingen.
// Bewust géén cache: de app haalt altijd de nieuwste versie op (zie update.js).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { body: e.data ? e.data.text() : "" }; }
  const title = m.title || "FoodSource";
  e.waitUntil((async () => {
    // App staat open en zichtbaar: daar ook tonen (een iPhone laat dan zelf geen banner zien)
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of list) if (c.visibilityState === "visible") c.postMessage({ type: "rpb-push", title, body: m.body || "", view: m.view || "", seller: m.seller || "", lot: m.lot || "", want: m.want || "" });
    // Rood getal op het app-icoon (iPhone vanaf iOS 16.4, Android, computer)
    if (m.badge > 0 && self.navigator.setAppBadge) { try { await self.navigator.setAppBadge(m.badge); } catch {} }
    // Altijd ook een echte melding (verplicht: anders trekt Safari het abonnement in)
    await self.registration.showNotification(title, {
    body: m.body || "",
    icon: "/api/brand/icon-192.png",
    badge: "/api/brand/icon-192.png",
    tag: m.tag || undefined,
    renotify: !!m.tag,
    data: { view: m.view || "", seller: m.seller || "", lot: m.lot || "", want: m.want || "" },
    });
  })());
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const d = e.notification.data || {};
  const qs = new URLSearchParams();
  if (d.view) qs.set("open", d.view);
  if (d.seller && d.lot) { qs.set("seller", d.seller); qs.set("lot", d.lot); }
  if (d.want) qs.set("want", d.want);
  const url = "/" + (qs.toString() ? "?" + qs : "");
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of list) {
      if (new URL(c.url).origin !== self.location.origin) continue;
      // App staat al open: daarheen en het juiste scherm tonen
      c.postMessage({ type: "rpb-open", view: d.view || "", seller: d.seller || "", lot: d.lot || "", want: d.want || "" });
      try { return await c.focus(); } catch { /* sommige browsers staan focus niet toe */ }
      return;
    }
    return self.clients.openWindow(url);
  })());
});

// Abonnement vernieuwd door de browser: opnieuw aanmelden lukt alleen vanuit de app (met sessie);
// bij de volgende keer openen controleert push.js dat en meldt het toestel opnieuw aan.
self.addEventListener("pushsubscriptionchange", () => {});
