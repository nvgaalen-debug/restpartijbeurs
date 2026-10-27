// FoodSource – meldingenlijst (belletje) en het rode getal op het app-icoon.
// De server bewaart elke melding (nieuw bod, gegund, niet gegund, vraag en aanbod), ook als
// pushmeldingen uit staan of de melding op de telefoon is weggetikt.
const dlgNotes = $("#dlg-notes");
S.notesUnread = 0;
function setNotesBadge(n) {
  S.notesUnread = n;
  const el = $("#n-notes");
  el.hidden = !(n > 0); el.textContent = n > 99 ? "99+" : String(n);
  $("#btn-notes").setAttribute("aria-label", n > 0 ? `Meldingen, ${n} nieuw` : "Meldingen");
}
// App-icoon: het getal verdwijnt zodra je de app opent (het belletje houdt bij wat je nog niet bekeek)
function clearIconBadge() { try { if (navigator.clearAppBadge && document.visibilityState === "visible") navigator.clearAppBadge().catch(() => {}); } catch {} }
document.addEventListener("visibilitychange", clearIconBadge);
clearIconBadge();

function noteTime(iso) {
  const d = new Date(iso), now = new Date(), min = Math.round((now - d) / 60000);
  const hm = d.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
  if (min < 1) return "zojuist";
  if (min < 60) return `${min} min geleden`;
  if (localDate(d) === localDate(now)) return `vandaag ${hm}`;
  if (localDate(d) === localDate(new Date(now - 86400000))) return `gisteren ${hm}`;
  return d.toLocaleDateString("nl-NL", { weekday: "short", day: "numeric", month: "short" }) + " " + hm;
}
const NOTE_ICON = {
  bid: '<path d="M3 12.5V4h8.5L21 13.5 13.5 21z"/><circle cx="7.6" cy="8.6" r="1.6"/>',
  awarded: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  rejected: '<path d="M7 7l10 10M17 7L7 17"/>',
  match: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5.5 5.5"/>',
};
async function openNotes() {
  $("#notes-list").innerHTML = `<div class="notes-empty">Laden…</div>`;
  if (!dlgNotes.open) dlgNotes.showModal();
  try {
    const d = await api("notes");
    $("#notes-list").innerHTML = d.notes.length
      ? d.notes.map((n) => `<button type="button" class="note-item${n.read ? "" : " unread"} k-${esc(n.kind)}" data-note="${esc(n.id)}">
          <span class="note-ico"><svg viewBox="0 0 24 24" aria-hidden="true">${NOTE_ICON[n.kind] || NOTE_ICON.bid}</svg></span>
          <span class="note-txt"><b>${esc(n.title)}</b><span>${esc(n.body)}</span><small>${esc(noteTime(n.at))}</small></span>
        </button>`).join("")
      : `<div class="notes-empty"><b>Nog geen meldingen</b><span>Hier zie je nieuwe biedingen op je partijen, of je bod gegund is, en wanneer vraag en aanbod bij elkaar passen.</span></div>`;
    S.notesList = d.notes;
    // Bekeken = gelezen (de nieuwe blijven in deze lijst nog even gemarkeerd)
    if (d.unread) { const r = await api("notes/read", { method: "POST", body: { all: true } }); setNotesBadge(r.unread); }
  } catch (e) { $("#notes-list").innerHTML = `<div class="notes-empty">${esc(e.message)}</div>`; }
}
$("#btn-notes").addEventListener("click", openNotes);
$("#notes-all").addEventListener("click", async () => {
  try { const r = await api("notes/read", { method: "POST", body: { all: true } }); setNotesBadge(r.unread); $$("#notes-list .unread").forEach((x) => x.classList.remove("unread")); } catch (e) { toast(e.message); }
});
$("#notes-list").addEventListener("click", (e) => {
  const b = e.target.closest("[data-note]"); if (!b) return;
  const n = (S.notesList || []).find((x) => x.id === b.dataset.note); if (!n) return;
  dlgNotes.close();
  const l = n.link || {};
  if (typeof openFromPush === "function") openFromPush(l.view, l.seller, l.lot, l.want);
});
