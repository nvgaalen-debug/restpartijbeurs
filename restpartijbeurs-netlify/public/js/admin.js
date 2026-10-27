// Restpartijbeurs – Beheer: dashboard, gebruikers, redencodes, betalingen, restpartijen, logboek, instellingen
// Volgorde in index.html: core, market, account, admin, payments, stats, start.
// ---------- beheer ----------
let users = [];
async function loadUsers() {
  if (S.user?.role !== "beheerder") return;
  try {
    const [d, rs] = await Promise.all([api("users"), api("admin/resets").catch(() => ({ resets: [] }))]);
    users = d.users; S.today = d.today; S.resets = rs.resets || []; renderUsers();
  }
  catch (err) { $("#users-body").innerHTML = `<tr><td colspan="6" class="sub">${esc(err.message)}</td></tr>`; }
}
function renderUsers() {
  const pend = users.filter((u) => u.pending);
  $("#pending-panel").hidden = !pend.length;
  $("#pending-n").textContent = pend.length === 1 ? "1 open" : `${pend.length} open`;
  const rs = S.resets || [];
  setPendingBadge(pend.length + rs.length);
  $("#resets-panel").hidden = !rs.length;
  $("#resets-n").textContent = rs.length === 1 ? "1 open" : `${rs.length} open`;
  $("#resets-body").innerHTML = rs.map((r) => `<tr>
    <td><b>${esc(r.name)}</b><div class="sub">${esc(r.company || "")}</div>${r.note ? `<div class="sub">“${esc(r.note)}”</div>` : ""}</td>
    <td>${esc(r.contact)}</td>
    <td>${esc(r.known) || `<span class="sub">niet bekend</span>`}</td>
    <td class="sub">${new Date(r.at).toLocaleString("nl-NL", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
    <td class="num"><div class="actions" style="justify-content:flex-end">
      <button class="btn primary small" type="button" data-uact="code" data-uid="${esc(r.userId)}">Nieuwe code</button>
      <button class="btn small ghost" type="button" data-rclose="${esc(r.id)}">Afsluiten</button>
    </div></td></tr>`).join("");
  $("#pending-body").innerHTML = pend.map((u) => `<tr>
    <td><b>${esc(u.name)}</b>${u.note ? `<div class="sub">“${esc(u.note)}”</div>` : ""}</td>
    <td>${esc(u.company)}<div style="margin-top:4px">${u.paidUntil ? `<span class="pill ok">Betaald t/m ${fmtDate(u.paidUntil)}</span>` : `<span class="pill off">Nog niet betaald</span>`}</div></td>
    <td class="num">${u.kvk ? `<a href="https://www.kvk.nl/zoeken/?source=all&q=${encodeURIComponent(u.kvk)}" target="_blank" rel="noopener">${esc(u.kvk)}</a>` : "—"}</td>
    <td>${esc(u.contact) || "—"}</td>
    <td class="sub">${u.createdAt ? new Date(u.createdAt).toLocaleString("nl-NL", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : ""}</td>
    <td class="num"><div class="actions" style="justify-content:flex-end">
      <button class="btn primary small" type="button" data-uact="approve" data-uid="${esc(u.id)}">Goedkeuren</button>
      <button class="btn small" type="button" data-uact="reject" data-uid="${esc(u.id)}">Afwijzen</button>
    </div></td></tr>`).join("");
  const uq = ($("#users-q").value || "").trim().toLowerCase();
  const list = users.filter((u) => !u.pending && (!uq || [u.name, u.company, u.kvk, u.contact].join(" ").toLowerCase().includes(uq)));
  $("#users-body").innerHTML = list.map((u) => `<tr>
    <td><b>${esc(u.name)}</b>${u.id === S.me ? ' <span class="sub">(jij)</span>' : ""}${u.contact ? `<div class="sub">${esc(u.contact)}</div>` : ""}</td>
    <td>${esc(u.company) || '<span class="sub">—</span>'}${u.kvk ? `<div class="sub">KvK ${esc(u.kvk)}</div>` : ""}</td>
    <td>${u.role === "beheerder" ? "Beheerder" : "Handelaar"}</td>
    <td>${u.role === "beheerder" ? '<span class="pill acc">Beheerder</span>' : u.exempt ? '<span class="pill acc">Vrijgesteld</span>' : subPill(u.paidUntil)}${u.paidTotal ? `<div class="sub">${euro.format(u.paidTotal)} totaal</div>` : ""}</td>
    <td><span class="pill ${u.active ? "ok" : "off"}">${u.active ? "Actief" : "Gedeactiveerd"}</span></td>
    <td class="num"><div class="actions" style="justify-content:flex-end;flex-wrap:nowrap">
      <button class="btn small" type="button" data-uact="pay" data-uid="${esc(u.id)}">Betaling</button>
      <span class="menu-wrap"><button class="btn small" type="button" data-uact="menu" data-uid="${esc(u.id)}" aria-haspopup="true">Acties ▾</button></span>
    </div></td></tr>`).join("") || `<tr><td colspan="6" class="sub">${uq ? "Geen gebruikers gevonden." : "Nog geen gebruikers."}</td></tr>`;
}
function subPill(until) {
  const t = S.today || localDate();
  if (!until) return `<span class="pill off">Geen</span>`;
  const d = new Date(until + "T12:00").toLocaleDateString("nl-NL", { day: "numeric", month: "short", year: "numeric" });
  if (until < t) return `<span class="pill warn">Verlopen ${d}</span>`;
  const soon = localDate(new Date(Date.now() + 30 * 86400000));
  return `<span class="pill ${until <= soon ? "warn" : "ok"}">Einde ${d}</span>`;
}
function closeMenus() { $$(".menu").forEach((m) => m.remove()); }
function openUserMenu(btn, u) {
  closeMenus();
  const m = document.createElement("div"); m.className = "menu"; m.setAttribute("role", "menu");
  m.innerHTML = `<button type="button" role="menuitem" data-uact="edit" data-uid="${esc(u.id)}">Gegevens wijzigen</button>
    <button type="button" role="menuitem" data-uact="code" data-uid="${esc(u.id)}">Nieuwe code instellen</button>
    <button type="button" role="menuitem" data-uact="role" data-uid="${esc(u.id)}">${u.role === "beheerder" ? "Maak handelaar" : "Maak beheerder"}</button>
    ${u.role !== "beheerder" ? `<button type="button" role="menuitem" data-uact="exempt" data-uid="${esc(u.id)}">${u.exempt ? "Abonnement weer verplicht" : "Geen abonnement nodig"}</button>` : ""}
    <button type="button" role="menuitem" data-uact="active" data-uid="${esc(u.id)}">${u.active ? "Deactiveren" : "Activeren"}</button>`;
  btn.parentElement.appendChild(m);
  m.querySelector("button").focus();
}
document.addEventListener("click", (e) => { if (!e.target.closest(".menu-wrap")) closeMenus(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenus(); });
$("#users-q").addEventListener("input", renderUsers);
$("#btn-show-newuser").addEventListener("click", () => { $("#form-user").hidden = false; $("#u-name").focus(); });
$("#btn-hide-newuser").addEventListener("click", () => { $("#form-user").hidden = true; });
let editFor = null;
const dlgEdit = $("#dlg-edituser");
$("#form-edituser").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = { name: $("#eu-name").value.trim(), company: $("#eu-company").value.trim(), contact: $("#eu-contact").value.trim(), kvk: $("#eu-kvk").value.trim() };
  if (!body.name) { $("#eu-err").textContent = "Vul een naam in."; return; }
  try {
    const d = await api("users/" + encodeURIComponent(editFor.id), { method: "PATCH", body });
    if (d.user.id === S.me) { S.user = { ...S.user, ...d.user }; $("#btn-account").textContent = d.user.name + (d.user.company ? " · " + d.user.company : ""); }
    S.profiles[d.user.id] = { company: d.user.company, contact: d.user.contact };
    dlgEdit.close(); await loadUsers(); render();
    toast(`Gegevens van ${d.user.name} opgeslagen.`);
  } catch (err) { $("#eu-err").textContent = err.message; }
});
let codeFor = null;
const dlgCode = $("#dlg-code");
$("#view-admin").addEventListener("click", async (e) => {
  const t = e.target.closest("[data-uact]"); if (!t) return;
  const u = users.find((x) => x.id === t.dataset.uid); if (!u) return;
  if (t.dataset.uact === "menu") { e.stopPropagation(); if (t.parentElement.querySelector(".menu")) closeMenus(); else openUserMenu(t, u); return; }
  closeMenus();
  if (t.dataset.uact === "pay") return openPayments(u);
  if (t.dataset.uact === "approve") {
    try { await api("users/" + encodeURIComponent(u.id), { method: "PATCH", body: { active: true } }); await loadUsers(); toast(`${u.name} van ${u.company} kan nu inloggen.`); }
    catch (err) { toast(err.message); }
    return;
  }
  if (t.dataset.uact === "reject") {
    if (t.dataset.sure !== "1") { t.dataset.sure = "1"; t.textContent = "Zeker afwijzen?"; t.classList.add("primary"); setTimeout(() => { if (t.isConnected) { t.dataset.sure = ""; t.textContent = "Afwijzen"; t.classList.remove("primary"); } }, 4000); return; }
    try { await api("users/" + encodeURIComponent(u.id), { method: "DELETE" }); await loadUsers(); toast(`Aanvraag van ${u.name} afgewezen en verwijderd.`); }
    catch (err) { toast(err.message); }
    return;
  }
  if (t.dataset.uact === "edit") {
    editFor = u;
    $("#eu-sub").textContent = `Wijzig de gegevens van ${u.name}. Nieuwe gegevens verschijnen ook bij bestaande partijen en biedingen waar niets eigens is ingevuld.`;
    $("#eu-name").value = u.name; $("#eu-company").value = u.company || ""; $("#eu-contact").value = u.contact || ""; $("#eu-kvk").value = u.kvk || "";
    $("#eu-err").textContent = ""; dlgEdit.showModal(); $("#eu-company").focus(); return;
  }
  if (t.dataset.uact === "code") {
    codeFor = u; $("#code-sub").textContent = `Voor ${u.name}. Bestaande sessies worden uitgelogd. Bij het inloggen kiest ${u.name} zelf een nieuwe code.`;
    $("#c-code").value = ""; $("#code-err").textContent = ""; dlgCode.showModal(); return;
  }
  const body = t.dataset.uact === "role" ? { role: u.role === "beheerder" ? "handelaar" : "beheerder" }
    : t.dataset.uact === "exempt" ? { exempt: !u.exempt } : { active: !u.active };
  try { await api("users/" + encodeURIComponent(u.id), { method: "PATCH", body }); await loadUsers(); toast("Gebruiker bijgewerkt."); }
  catch (err) { toast(err.message); }
});
$("#view-admin").addEventListener("click", async (e) => {
  const t = e.target.closest("[data-rclose]"); if (!t) return;
  try { await api("admin/resets/" + encodeURIComponent(t.dataset.rclose), { method: "DELETE" }); await loadUsers(); toast("Melding afgesloten."); }
  catch (err) { toast(err.message); }
});
const CODE_WORDS = ["appel", "peer", "kool", "prei", "sla", "bes", "druif", "kiwi", "peen", "biet", "raap", "ui", "mango", "pruim", "kers", "venkel", "spruit", "andijvie", "tomaat", "paprika", "bonen", "erwt", "radijs", "meloen", "citroen", "banaan", "kist", "krat", "veiling", "schuur"];
$("#c-gen").addEventListener("click", () => {
  const rnd = (n) => crypto.getRandomValues(new Uint32Array(1))[0] % n;
  let c = "";
  while (c.length < 14) c = [0, 1, 2].map(() => CODE_WORDS[rnd(CODE_WORDS.length)]).join("-") + "-" + (10 + rnd(90));
  $("#c-code").value = c; $("#c-code").select();
});
$("#form-code").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("users/" + encodeURIComponent(codeFor.id), { method: "PATCH", body: { code: $("#c-code").value } });
    dlgCode.close(); toast(`Nieuwe code ingesteld voor ${codeFor.name}. Geef hem persoonlijk door.`); loadUsers();
  } catch (err) { $("#code-err").textContent = err.message; }
});
$("#form-user").addEventListener("submit", async (e) => {
  e.preventDefault();
  const val = (id) => $(id).value.trim();
  try {
    const d = await api("users", { method: "POST", body: { name: val("#u-name"), company: val("#u-company"), contact: val("#u-contact"), code: $("#u-code").value, role: $("#u-role").value } });
    ["#u-name", "#u-company", "#u-contact", "#u-code"].forEach((id) => ($(id).value = ""));
    $("#user-err").textContent = "";
    await loadUsers();
    toast(`${d.user.name} kan nu inloggen.`);
  } catch (err) { $("#user-err").textContent = err.message; }
});

// ---------- beheeromgeving ----------
function setPendingBadge(n) {
  S.pendingCount = n;
  for (const id of ["#n-pending", "#n-pending2"]) { $(id).hidden = !n; $(id).textContent = n; }
}
function setAdminPane(p) {
  S.apane = p;
  $$("[data-apane]").forEach((b) => (b.dataset.apane === p ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
  $$("#view-admin [data-pane]").forEach((el) => (el.hidden = el.dataset.pane !== p));
  try { localStorage.setItem("rpb.apane", p); } catch {}
  refreshAdminPane(true);
}
function refreshAdminPane(first) {
  const p = S.apane;
  if (p === "dash") loadStats();
  else if (p === "users") loadUsers();
  else if (p === "lots") renderAdminLots();
  else if (p === "wants") renderAdminWants();
  else if (p === "stats") renderStats();
  else if (p === "log" && first) loadLog(true);
  else if (p === "settings" && first) fillSettings();
  else if (p === "reasons" && first) { rcDraft = (S.settings?.reasonCodes || []).map((r) => ({ ...r })); renderReasons(); }
}

// ---------- redencodes ----------
const dlgReason = $("#dlg-reason");
let reasonResolve = null;
function openReason(title, sub, okLabel) {
  const codes = (S.settings?.reasonCodes || []).filter((r) => r.active);
  if (!codes.length) return Promise.resolve({ code: "", label: "Geen reden", note: "" });
  $("#rs-title").textContent = title; $("#rs-sub").textContent = sub || "";
  $("#rs-ok").textContent = okLabel || "Intrekken";
  $("#rs-list").innerHTML = codes.map((r, i) => `<label><input type="radio" name="rs-code" value="${esc(r.code)}"${i === 0 ? "" : ""}> ${esc(r.label)}<code>${esc(r.code)}</code></label>`).join("");
  $("#rs-note").value = ""; $("#rs-err").textContent = ""; updateReasonNote();
  dlgReason.showModal();
  return new Promise((res) => { reasonResolve = res; });
}
function updateReasonNote() {
  const code = document.querySelector("input[name=rs-code]:checked")?.value;
  const rc = (S.settings?.reasonCodes || []).find((r) => r.code === code);
  $("#rs-note-label").textContent = rc?.needsNote ? "Toelichting *" : "Toelichting (optioneel)";
}
$("#rs-list").addEventListener("change", () => { updateReasonNote(); $("#rs-err").textContent = ""; });
$("#rs-note").addEventListener("input", () => { $("#rs-err").textContent = ""; });
$("#form-reason").addEventListener("submit", (e) => {
  e.preventDefault();
  const code = document.querySelector("input[name=rs-code]:checked")?.value;
  const rc = (S.settings?.reasonCodes || []).find((r) => r.code === code);
  const note = $("#rs-note").value.trim();
  if (!rc) { $("#rs-err").textContent = "Kies een reden."; return; }
  if (rc.needsNote && !note) { $("#rs-err").textContent = "Vul een korte toelichting in."; $("#rs-note").focus(); return; }
  const r = reasonResolve; reasonResolve = null; dlgReason.close();
  r && r({ code: rc.code, label: rc.label, note });
});
dlgReason.addEventListener("close", () => { if (reasonResolve) { const r = reasonResolve; reasonResolve = null; r(null); } });
const reasonText = (wr) => (wr ? `${wr.label}${wr.note ? ": " + wr.note : ""}` : "");

let rcDraft = [];
function reasonUsage() {
  const n = {};
  for (const l of allLots()) if (l.withdrawReason?.code) n[l.withdrawReason.code] = (n[l.withdrawReason.code] || 0) + 1;
  return n;
}
function renderReasons() {
  const use = reasonUsage();
  $("#rc-body").innerHTML = rcDraft.map((r, i) => `<tr data-i="${i}">
    <td><input type="text" data-k="code" value="${esc(r.code)}" maxlength="10" aria-label="Code" style="text-transform:uppercase"></td>
    <td><input type="text" data-k="label" value="${esc(r.label)}" maxlength="80" aria-label="Omschrijving"></td>
    <td><input type="checkbox" data-k="needsNote"${r.needsNote ? " checked" : ""} aria-label="Toelichting verplicht"></td>
    <td><input type="checkbox" data-k="active"${r.active ? " checked" : ""} aria-label="Actief"></td>
    <td class="num">${use[r.code] || 0}</td>
    <td class="num"><button class="btn small ghost" type="button" data-rc-del="${i}">Verwijderen</button></td></tr>`).join("")
    || `<tr><td colspan="6" class="sub">Nog geen redencodes. Zonder codes kan een handelaar intrekken zonder reden.</td></tr>`;
}
$("#rc-body").addEventListener("input", (e) => {
  const tr = e.target.closest("tr[data-i]"); if (!tr) return;
  const r = rcDraft[Number(tr.dataset.i)]; const k = e.target.dataset.k;
  r[k] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
});
$("#rc-body").addEventListener("change", (e) => { const tr = e.target.closest("tr[data-i]"); if (tr && e.target.type === "checkbox") rcDraft[Number(tr.dataset.i)][e.target.dataset.k] = e.target.checked; });
$("#rc-body").addEventListener("click", (e) => {
  const b = e.target.closest("[data-rc-del]"); if (!b) return;
  const r = rcDraft[Number(b.dataset.rcDel)];
  if ((reasonUsage()[r.code] || 0) && b.dataset.sure !== "1") { b.dataset.sure = "1"; b.textContent = "Wordt gebruikt. Toch?"; setTimeout(() => { if (b.isConnected) { b.dataset.sure = ""; b.textContent = "Verwijderen"; } }, 4000); return; }
  rcDraft.splice(Number(b.dataset.rcDel), 1); renderReasons();
});
$("#rc-add").addEventListener("click", () => {
  rcDraft.push({ code: "", label: "", active: true, needsNote: false }); renderReasons();
  $("#rc-body tr:last-child input[data-k=code]").focus();
});
$("#form-reasons").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const d = await api("admin/reasons", { method: "PUT", body: { codes: rcDraft.map((r) => ({ ...r, code: String(r.code).trim().toUpperCase(), label: String(r.label).trim() })) } });
    S.settings = { ...(S.settings || {}), reasonCodes: d.codes };
    rcDraft = d.codes.map((r) => ({ ...r })); renderReasons(); $("#rc-err").textContent = "";
    toast("Redencodes opgeslagen.");
  } catch (err) { $("#rc-err").textContent = err.message; }
});
$$("[data-apane]").forEach((b) => b.addEventListener("click", () => setAdminPane(b.dataset.apane)));
$$("[data-goto-pane]").forEach((b) => b.addEventListener("click", () => setAdminPane(b.dataset.gotoPane)));

const KIND = { inloggen: "Inloggen", account: "Aanvraag", partij: "Partij", bod: "Bod", gunning: "Gunning", betaling: "Betaling", beheer: "Beheer", vraag: "Vraag" };
const fmtTime = (iso) => new Date(iso).toLocaleString("nl-NL", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const fmtDate = (d) => (d ? new Date(d + "T12:00").toLocaleDateString("nl-NL", { day: "numeric", month: "short", year: "numeric" }) : "");

async function loadStats() {
  try {
    const s = await api("admin/stats");
    S.today = s.today;
    $("#t-rev").textContent = euro.format(s.revenueTotal);
    $("#t-rev-sub").textContent = `${euro.format(s.revenueYear)} in ${s.today.slice(0, 4)}`;
    $("#t-cust").textContent = num.format(s.customers);
    $("#t-cust-sub").textContent = `handelaren${s.admins ? ` · ${s.admins} beheerder${s.admins === 1 ? "" : "s"}` : ""}${s.pending ? ` · ${s.pending} aanvra${s.pending === 1 ? "ag" : "gen"}` : ""}`;
    $("#t-paid").textContent = num.format(s.paidCustomers);
    $("#t-paid-sub").textContent = s.customers ? `${Math.round((s.paidCustomers / s.customers) * 100)}% van de handelaren` : "met geldig abonnement";
    $("#t-lots").textContent = num.format(s.lotsOpen);
    $("#t-lots-sub").textContent = `open · ${num.format(s.lotsTotal)} totaal · ${num.format(s.awards)} gunning${s.awards === 1 ? "" : "en"}`;
    $("#dash-asof").textContent = "Bijgewerkt " + new Date().toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
    $("#dash-attention").innerHTML = s.attention.length ? `<ul class="mini-list">${s.attention.map((a) => `<li><span><b>${esc(a.company || a.name)}</b> <span class="sub">${esc(a.company ? a.name : "")}</span></span>
      <span class="actions" style="flex-wrap:nowrap"><span class="pill ${a.expired ? "warn" : "acc"}">${a.expired ? "Verlopen" : "Verloopt"} ${fmtDate(a.paidUntil)}</span><button class="btn small" type="button" data-dash-pay="${esc(a.id)}">Betaling</button></span></li>`).join("")}</ul>`
      : `<div class="nobids">Geen abonnementen die verlopen of binnenkort verlopen.</div>`;
    const lg = await api("admin/log?limit=8");
    $("#dash-log").innerHTML = lg.entries.length ? `<ul class="mini-list">${lg.entries.map((x) => `<li><span>${esc(x.detail)}<div class="sub">${esc(x.user || "—")}</div></span><span class="sub">${fmtTime(x.at)}</span></li>`).join("")}</ul>` : `<div class="nobids">Nog geen activiteit.</div>`;
  } catch (err) { $("#dash-attention").innerHTML = `<div class="nobids">${esc(err.message)}</div>`; }
}
$("#dash-attention").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-dash-pay]"); if (!b) return;
  if (!users.length) { try { const d = await api("users"); users = d.users; } catch {} }
  const u = users.find((x) => x.id === b.dataset.dashPay); if (u) openPayments(u);
});

// Betalingen
const dlgPay = $("#dlg-pay");
let payFor = null;
async function openPayments(u) {
  payFor = u;
  $("#pay-sub").textContent = `${u.name}${u.company ? " · " + u.company : ""}${u.kvk ? " · KvK " + u.kvk : ""}`;
  const t = S.today || localDate();
  const start = u.paidUntil && u.paidUntil >= t ? u.paidUntil : t;
  $("#p-amount").value = ((S.settings?.subscriptionPrice || 0) / 100).toFixed(2);
  $("#p-paid").value = t; $("#p-until").value = addYear12(start); $("#p-note").value = ""; $("#pay-err").textContent = "";
  $("#pay-body").innerHTML = `<tr><td colspan="5" class="sub">Laden…</td></tr>`;
  dlgPay.showModal();
  loadPayments();
}
function addDays(d, n) { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
// datum + 12 maanden (29 februari wordt 28 februari)
function addYear12(d) { const [y, m, day] = d.split("-").map(Number); const last = new Date(Date.UTC(y + 1, m, 0)).getUTCDate(); return `${y + 1}-${String(m).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`; }
$("#p-paid").addEventListener("change", () => { const v = $("#p-paid").value; if (v) $("#p-until").value = addYear12(v); });
async function loadPayments() {
  try {
    const d = await api("admin/payments?user=" + encodeURIComponent(payFor.id));
    $("#pay-body").innerHTML = d.payments.map((p) => `<tr><td>${fmtDate(p.paidOn)}</td><td class="num">${euro.format(p.amount)}</td><td>${fmtDate(p.validUntil)}</td><td>${esc(p.note) || '<span class="sub">—</span>'}</td>
      <td class="num"><button class="btn small ghost" type="button" data-delpay="${esc(p.id)}">Verwijderen</button></td></tr>`).join("") || `<tr><td colspan="5" class="sub">Nog geen betalingen geregistreerd.</td></tr>`;
  } catch (err) { $("#pay-body").innerHTML = `<tr><td colspan="5" class="sub">${esc(err.message)}</td></tr>`; }
}
$("#pay-body").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-delpay]"); if (!b) return;
  if (b.dataset.sure !== "1") { b.dataset.sure = "1"; b.textContent = "Zeker?"; setTimeout(() => { if (b.isConnected) { b.dataset.sure = ""; b.textContent = "Verwijderen"; } }, 4000); return; }
  try { await api("admin/payments/" + encodeURIComponent(b.dataset.delpay), { method: "DELETE" }); await loadPayments(); toast("Betaling verwijderd."); }
  catch (err) { toast(err.message); }
});
$("#form-pay").addEventListener("submit", async (e) => {
  e.preventDefault();
  const amount = $("#p-amount").value, paidOn = $("#p-paid").value, validUntil = $("#p-until").value;
  if (!(Number(amount) >= 0) || amount === "") { $("#pay-err").textContent = "Vul een bedrag in."; return; }
  if (!paidOn || !validUntil) { $("#pay-err").textContent = "Vul beide datums in."; return; }
  try {
    await api("admin/payments", { method: "POST", body: { userId: payFor.id, amount, paidOn, validUntil, note: $("#p-note").value.trim() } });
    $("#pay-err").textContent = ""; $("#p-note").value = "";
    await loadPayments();
    toast(`Betaling van ${euro.format(Number(amount))} geregistreerd voor ${payFor.name}.`);
    refreshAdminPane();
  } catch (err) { $("#pay-err").textContent = err.message; }
});
dlgPay.addEventListener("close", () => refreshAdminPane());

// Restpartijen (alle aanbieders)
let alotsFilter = "open";
$("#alots-filter").addEventListener("click", (e) => {
  const c = e.target.closest("[data-f]"); if (!c) return;
  alotsFilter = c.dataset.f;
  $$("#alots-filter .chip").forEach((x) => x.setAttribute("aria-pressed", String(x === c)));
  renderAdminLots();
});
function renderAdminLots() {
  let lots = allLots();
  if (alotsFilter === "open") lots = lots.filter((l) => !lotState(l).closed);
  if (alotsFilter === "closed") lots = lots.filter((l) => lotState(l).closed);
  lots.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  $("#alots-body").innerHTML = lots.map((l) => {
    const st = lotState(l), bids = bidsFor(l.id), rem = l.remaining ?? l.qty;
    return `<tr>
      <td>${validPhotos(l).length ? `<img class="panel-thumb" style="width:40px;height:40px;vertical-align:middle;margin-right:8px" src="${photoUrl(validPhotos(l)[0])}" alt="" loading="lazy">` : ""}<b>${esc(l.product)}</b>${l.ras ? ` <span class="sub">${esc(l.ras)}</span>` : ""}<div class="sub">${esc(l.category)} · ${esc(l.klasse)}</div></td>
      <td>${esc(l.company) || "—"}</td>
      <td class="num">${num.format(rem)} / ${num.format(l.qty)} ${esc(l.unit)}</td>
      <td class="num">${euro.format(l.price)}</td>
      <td class="num">${bids.length}${bids[0] ? `<div class="sub">hoogste ${euro.format(bids[0].price)}</div>` : ""}</td>
      <td>${fmtDate(l.until)}</td>
      <td><span class="pill ${st.cls}">${st.label}</span>${l.status === "ingetrokken" && l.withdrawReason ? `<div class="sub">${esc(l.withdrawReason.code)} · ${esc(reasonText(l.withdrawReason))}${l.withdrawReason.by === "beheer" ? " (door beheer)" : ""}</div>` : ""}</td>
      <td class="num"><div class="actions" style="justify-content:flex-end;flex-wrap:nowrap">
        ${l.status === "ingetrokken" ? `<button class="btn small" type="button" data-alot="reopen" data-seller="${esc(l.sellerId)}" data-lot="${esc(l.id)}">Heropenen</button>`
          : `<button class="btn small" type="button" data-alot="withdraw" data-seller="${esc(l.sellerId)}" data-lot="${esc(l.id)}">Intrekken</button>`}
        <button class="btn small ghost" type="button" data-alot="delete" data-seller="${esc(l.sellerId)}" data-lot="${esc(l.id)}">Verwijderen</button>
      </div></td></tr>`;
  }).join("") || `<tr><td colspan="8" class="sub">Geen partijen${alotsFilter === "open" ? " open" : alotsFilter === "closed" ? " afgesloten" : ""}.</td></tr>`;
}
$("#alots-body").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-alot]"); if (!b) return;
  const act = b.dataset.alot;
  let reason = null;
  if (act !== "reopen") {
    const l = allLots().find((x) => x.id === b.dataset.lot && x.sellerId === b.dataset.seller);
    reason = await openReason(`${l?.product || "Partij"} ${act === "delete" ? "verwijderen" : "intrekken"}`,
      act === "delete" ? `De partij van ${l?.company || "de aanbieder"} en de foto's worden definitief verwijderd. Waarom?` : `De partij van ${l?.company || "de aanbieder"} verdwijnt uit het aanbod. Waarom?`,
      act === "delete" ? "Definitief verwijderen" : "Intrekken");
    if (!reason) return;
  }
  try {
    await api("admin/lots", { method: "POST", body: { sellerId: b.dataset.seller, lotId: b.dataset.lot, action: act, reason } });
    S.lastNow = ""; await pull(); renderAdminLots();
    toast({ withdraw: "Partij ingetrokken.", reopen: "Partij heropend.", delete: "Partij verwijderd." }[b.dataset.alot]);
  } catch (err) { toast(err.message); }
});

// Vragen (alle kopers)
let awantsFilter = "open";
$("#awants-filter").addEventListener("click", (e) => {
  const c = e.target.closest("[data-f]"); if (!c) return;
  awantsFilter = c.dataset.f;
  $$("#awants-filter .chip").forEach((x) => x.setAttribute("aria-pressed", String(x === c)));
  renderAdminWants();
});
function renderAdminWants() {
  let ws = allWants();
  if (awantsFilter === "open") ws = ws.filter((w) => wantIsOpen(w));
  if (awantsFilter === "closed") ws = ws.filter((w) => !wantIsOpen(w));
  ws.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  $("#awants-body").innerHTML = ws.map((w) => {
    const st = wantState(w), hits = wantIsOpen(w) ? lotsForWant(w) : [];
    const reacties = hits.filter((l) => isReaction(l, w)).length;
    const why = w.closedBy === "beheer" && w.closeReason ? `<div class="sub">${esc(w.closeReason.code)} · ${esc(reasonText(w.closeReason))} (door beheer)</div>` : w.status === "gesloten" && w.closedReason ? `<div class="sub">${esc(w.closedReason)}</div>` : "";
    return `<tr>
      <td><b>${esc(w.product)}</b><div class="sub">${esc(w.category)} · ${w.klasse ? esc(w.klasse) : "elke klasse"}${w.region ? " · " + esc(w.region) : ""}</div>${w.note ? `<div class="sub">“${esc(w.note)}”</div>` : ""}</td>
      <td>${esc(w.company) || "—"}${w.contact ? `<div class="sub" style="white-space:nowrap">${esc(w.contact)}</div>` : ""}</td>
      <td class="num" style="white-space:nowrap">${num.format(w.qty)} ${esc(w.unit)}<div class="sub">${w.maxPrice > 0 ? "max " + euro.format(w.maxPrice) : "prijs in overleg"}</div></td>
      <td style="white-space:nowrap">${fmtDate(w.until)}</td>
      <td class="num">${hits.length}${reacties ? `<div class="sub">${reacties} reactie${reacties === 1 ? "" : "s"}</div>` : ""}</td>
      <td><span class="pill ${st.cls}">${w.closedBy === "beheer" ? "Gesloten door beheer" : st.closed ? esc(st.label) : "Open"}</span>${why}</td>
      <td class="num"><div class="actions" style="justify-content:flex-end;flex-wrap:nowrap">
        ${w.status === "gesloten" ? `<button class="btn small" type="button" data-awant="reopen" data-buyer="${esc(w.buyerId)}" data-want="${esc(w.id)}">Heropenen</button>`
          : `<button class="btn small" type="button" data-awant="close" data-buyer="${esc(w.buyerId)}" data-want="${esc(w.id)}">Sluiten</button>`}
        <button class="btn small ghost" type="button" data-awant="delete" data-buyer="${esc(w.buyerId)}" data-want="${esc(w.id)}">Verwijderen</button>
      </div></td></tr>`;
  }).join("") || `<tr><td colspan="7" class="sub">Geen vragen${awantsFilter === "open" ? " open" : awantsFilter === "closed" ? " gesloten of verlopen" : ""}.</td></tr>`;
}
$("#awants-body").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-awant]"); if (!b) return;
  const act = b.dataset.awant;
  const w = allWants().find((x) => x.id === b.dataset.want && x.buyerId === b.dataset.buyer);
  let reason = null;
  if (act !== "reopen") {
    reason = await openReason(`Vraag ${w?.product || ""} ${act === "delete" ? "verwijderen" : "sluiten"}`,
      act === "delete" ? `De vraag van ${w?.company || "de koper"} wordt definitief verwijderd. Waarom?` : `De vraag van ${w?.company || "de koper"} verdwijnt bij de aanbieders; de koper kan hem niet zelf heropenen. Waarom?`,
      act === "delete" ? "Definitief verwijderen" : "Sluiten");
    if (!reason) return;
  }
  try {
    await api("admin/wants", { method: "POST", body: { buyerId: b.dataset.buyer, wantId: b.dataset.want, action: act, reason } });
    S.lastNow = ""; await pull(); renderAdminWants();
    toast({ close: "Vraag gesloten.", reopen: "Vraag heropend.", delete: "Vraag verwijderd." }[act]);
  } catch (err) { toast(err.message); }
});

// Logboek
let logOldest = 0, logShown = 0, logSeq = 0;
function logFilter() {
  const f = { q: $("#log-q").value.trim(), user: $("#log-user").value, kind: $("#log-kind").value, from: $("#log-from").value, to: $("#log-to").value };
  return { f, qs: Object.entries(f).filter(([, v]) => v).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join(""), any: Object.values(f).some(Boolean) };
}
const fmtLogTime = (iso) => { const d = new Date(iso); return d.toLocaleString("nl-NL", { day: "numeric", month: "short", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}), hour: "2-digit", minute: "2-digit" }); };
async function fillLogUsers() {
  try {
    if (!users.length) users = (await api("users")).users || [];
    const cur = $("#log-user").value;
    const list = users.slice().sort((a, b) => (a.company || a.name).localeCompare(b.company || b.name, "nl"));
    $("#log-user").innerHTML = `<option value="">Alle gebruikers</option>` + list.map((u) => `<option value="${esc(u.id)}">${esc(u.name)}${u.company ? " · " + esc(u.company) : ""}</option>`).join("");
    $("#log-user").value = cur;
  } catch {}
}
async function loadLog(reset) {
  const { qs, any } = logFilter();
  const seq = ++logSeq;
  $("#log-clear").hidden = !any;
  if (reset) { logOldest = 0; logShown = 0; $("#log-body").innerHTML = `<tr><td colspan="4" class="sub">Laden…</td></tr>`; fillLogUsers(); }
  try {
    const d = await api(`admin/log?limit=100${logOldest ? "&before=" + logOldest : ""}${qs}`);
    if (seq !== logSeq) return; // er is intussen een nieuwere zoekopdracht
    const rows = d.entries.map((x) => `<tr><td class="sub" style="white-space:nowrap">${fmtLogTime(x.at)}</td><td>${esc(x.user || "—")}</td><td><span class="pill ${x.kind === "gunning" || x.kind === "betaling" ? "ok" : x.kind === "beheer" ? "acc" : "off"}">${esc(KIND[x.kind] || x.kind)}</span></td><td>${esc(x.detail)}</td></tr>`).join("");
    if (reset) $("#log-body").innerHTML = rows || `<tr><td colspan="4" class="sub">${any ? "Niets gevonden met deze filters." : "Nog niets gelogd."}</td></tr>`;
    else $("#log-body").insertAdjacentHTML("beforeend", rows);
    logShown += d.entries.length;
    if (d.entries.length) logOldest = d.entries[d.entries.length - 1].id;
    $("#log-more").hidden = d.entries.length < 100;
    $("#log-count").textContent = logShown ? `${num.format(logShown)}${d.entries.length < 100 ? "" : "+"} regel${logShown === 1 ? "" : "s"}${any ? " gevonden" : ""}` : "";
  } catch (err) { if (seq === logSeq) $("#log-body").innerHTML = `<tr><td colspan="4" class="sub">${esc(err.message)}</td></tr>`; }
}
let logT;
$("#log-q").addEventListener("input", () => { clearTimeout(logT); logT = setTimeout(() => loadLog(true), 300); });
["#log-user", "#log-kind", "#log-from", "#log-to"].forEach((id) => $(id).addEventListener("change", () => loadLog(true)));
$("#log-clear").addEventListener("click", () => { ["#log-q", "#log-user", "#log-kind", "#log-from", "#log-to"].forEach((id) => ($(id).value = "")); loadLog(true); });
$("#log-more").addEventListener("click", () => loadLog(false));
// Exporteren: alle regels die aan de filters voldoen (max. 5.000), als CSV voor Excel
$("#log-export").addEventListener("click", async () => {
  const btn = $("#log-export"); btn.disabled = true;
  try {
    const d = await api(`admin/log?limit=5000${logFilter().qs}`);
    const cell = (v) => { let t = String(v ?? ""); if (/^[=+\-@]/.test(t)) t = "'" + t; return `"${t.replace(/"/g, '""')}"`; };
    const lines = [["Tijdstip", "Gebruiker", "Soort", "Wat"].map(cell).join(";")].concat(d.entries.map((x) =>
      [new Date(x.at).toLocaleString("nl-NL"), x.user || "", KIND[x.kind] || x.kind, x.detail].map(cell).join(";")));
    const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `logboek-${localDate()}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(`${num.format(d.entries.length)} regels geëxporteerd.`);
  } catch (err) { toast(err.message); }
  finally { btn.disabled = false; }
});

// Website-instellingen
function applySettings(s) {
  if (!s) return;
  S.settings = s;
  forgotTexts();
  $("#site-name").textContent = s.siteName;
  if (typeof applyBrand === "function") applyBrand(s);
  // Tekst naast de naam bovenaan: de welkomsttekst uit de instellingen, anders de standaardtekst
  $("#site-tagline").textContent = (s.welcomeText || "").replace(/\s+/g, " ").trim() || "Aardappelen · groente · fruit";
  $("#site-tagline").title = $("#site-tagline").textContent;
  const isTest = s.environment === "test";
  $("#env-test").hidden = !isTest;
  document.title = (isTest ? "[TEST] " : "") + s.siteName;
  $("#welcome-text").textContent = s.welcomeText || ""; $("#welcome-text").hidden = !s.welcomeText;
  $("#login-alt").hidden = !s.registrationOpen;
  $("#reg-subtext").textContent = s.subscriptionText || ""; $("#reg-subtext").hidden = !s.subscriptionText;
  const canPay = !!(s.onlinePayment && s.subscriptionPrice > 0);
  $("#reg-pay").hidden = $("#reg-pay-title").hidden = !canPay;
  if (canPay) {
    const excl = s.subscriptionPrice / 100, incl = Math.round(s.subscriptionPrice * (1 + (s.vatPercent || 0) / 100)) / 100;
    $("#reg-pay-price").textContent = `${euro.format(excl)} per jaar excl. btw (${euro.format(incl)} incl. btw)`;
    const names = { ideal: "iDEAL | Wero", wero: "Wero", bancontact: "Bancontact", creditcard: "creditcard" };
    const ms = (s.payMethods || []).map((m) => names[m]).filter(Boolean);
    $("#reg-pay-methods").textContent = ms.length ? [...new Set(ms)].join(" of ") : "iDEAL | Wero";
    updateRegSubmit();
  }
  $("#announce").textContent = s.announcement || ""; $("#announce").hidden = !(s.announcement && S.token);
}
function updateRegSubmit() {
  const now = !$("#reg-pay").hidden && document.querySelector("input[name=r-pay]:checked")?.value === "now";
  $("#reg-submit").textContent = now ? "Aanvragen en betalen" : "Aanvraag versturen";
}
$$("input[name=r-pay]").forEach((r) => r.addEventListener("change", updateRegSubmit));

// Terug van de betaalpagina na een aanvraag: /?aanvraag=<ref>
async function handleRequestReturn() {
  const ref = new URLSearchParams(location.search).get("aanvraag");
  if (!ref) return false;
  history.replaceState(null, "", location.pathname);
  let name = ""; try { name = sessionStorage.getItem("rpb.regname") || ""; } catch {}
  $("#form-login").hidden = true; $("#form-register").hidden = true; $("#reg-done").hidden = false;
  $("#reg-done-text").textContent = "Betaling controleren…";
  if (name) $("#l-name").value = name;
  for (let i = 0; i < 10; i++) {
    try {
      const st = await api("pay/request-status?ref=" + encodeURIComponent(ref));
      if (st.status === "paid") {
        $("#reg-done-text").textContent = st.approved
          ? `Betaling gelukt en je account is actief. Je abonnement is geldig t/m ${fmtDate(st.validUntil)}. Log in met je naam en code.`
          : `Betaling gelukt, je abonnement is geldig t/m ${fmtDate(st.validUntil)}. De beheerder keurt je aanvraag zo snel mogelijk goed; daarna kun je inloggen.`;
        return true;
      }
      if (["canceled", "expired", "failed"].includes(st.status)) {
        $("#reg-done-text").textContent = `De betaling is ${st.status === "canceled" ? "geannuleerd" : "niet gelukt"}. Je aanvraag is wel ontvangen. Na goedkeuring kun je het abonnement betalen via Mijn account.`;
        return true;
      }
    } catch (err) { $("#reg-done-text").textContent = err.message; return true; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  $("#reg-done-text").textContent = "Je aanvraag is ontvangen. De betaling wordt nog verwerkt; de beheerder ziet het resultaat in Beheer.";
  return true;
}

async function loadSettings() { try { applySettings((await api("status")).settings); } catch {} }

// Website-instellingen: elk onderdeel klapt uit; welke onderdelen open staan, onthoudt de browser
function revealField(sel) { const el = $(sel); const d = el?.closest("details"); if (d) d.open = true; el?.focus(); }
(() => {
  const KEY = "rpb.settingsOpen";
  let open = [];
  try { open = JSON.parse(localStorage.getItem(KEY) || "null") || ["algemeen"]; } catch { open = ["algemeen"]; }
  const secs = $$("#form-settings details.st-sec");
  secs.forEach((d) => {
    d.open = open.includes(d.dataset.sec);
    d.addEventListener("toggle", () => {
      try { localStorage.setItem(KEY, JSON.stringify(secs.filter((x) => x.open).map((x) => x.dataset.sec))); } catch {}
    });
  });
  const btnAll = $("#st-toggle-all");
  if (btnAll && secs.every((d) => d.open)) btnAll.textContent = "Alles inklappen";
  secs.forEach((d) => d.addEventListener("toggle", () => { if (btnAll) btnAll.textContent = secs.every((x) => x.open) ? "Alles inklappen" : "Alles uitklappen"; }));
  $("#st-toggle-all")?.addEventListener("click", () => {
    const anyClosed = secs.some((d) => !d.open);
    secs.forEach((d) => { d.open = anyClosed; });
    $("#st-toggle-all").textContent = anyClosed ? "Alles inklappen" : "Alles uitklappen";
  });
})();
