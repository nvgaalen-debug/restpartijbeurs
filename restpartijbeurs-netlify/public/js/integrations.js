// Restpartijbeurs / FoodSource – Mijn account → API-koppelingen (sleutels en webhook)
// Volgorde in index.html: core, market, account, admin, payments, stats, integrations, start.

const dlgApi = $("#dlg-api");
const SCOPE_LABEL = { "lots:read": "lezen", "lots:write": "aanmelden/wijzigen", "bids:read": "biedingen" };
const whenText = (iso) => (iso ? new Date(iso).toLocaleString("nl-NL", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "nog niet");

function showSecret(box, value) {
  $("#" + box + "-val").textContent = value || "";
  $("#" + box).hidden = !value;
}

async function loadApi() {
  $("#api-err").textContent = "";
  let d;
  try { d = await api("keys"); } catch (err) { $("#api-err").textContent = err.message; return; }
  $("#api-base").textContent = d.baseUrl;
  $("#api-keys").innerHTML = d.keys.length
    ? d.keys.map((k) => `<tr><td>${esc(k.name)}</td><td><code>${esc(k.prefix)}…</code></td><td>${k.scopes.map((s) => esc(SCOPE_LABEL[s] || s)).join(", ")}</td><td>${esc(whenText(k.lastUsedAt))}</td>
        <td class="num"><button class="btn small" type="button" data-revoke="${esc(k.id)}" data-name="${esc(k.name)}">Intrekken</button></td></tr>`).join("")
    : `<tr><td colspan="5" class="sub">Nog geen sleutels.</td></tr>`;
  $("#api-create").disabled = !d.apiEnabled || d.keys.length >= d.maxKeys;
  const w = d.webhook;
  if (document.activeElement !== $("#api-hook")) $("#api-hook").value = w.url;
  $("#api-hook-tools").hidden = !w.url;
  $("#api-hook-retry").hidden = !w.failed;
  $("#api-hook-status").textContent = !w.url ? ""
    : w.failed ? `${w.failed} bericht${w.failed === 1 ? "" : "en"} niet afgeleverd${w.lastError ? " (laatste fout: " + w.lastError + ")" : ""}. Haal ze op met GET /events of stuur ze opnieuw.`
    : w.lastError ? `Laatste poging mislukt: ${w.lastError}. FoodSource probeert het opnieuw.`
    : w.lastDelivered ? `Laatste bericht afgeleverd: ${whenText(w.lastDelivered)}.` : "Nog geen berichten verstuurd.";
}

$("#acc-api-open").addEventListener("click", () => {
  showSecret("api-newkey", ""); showSecret("api-newsecret", "");
  $("#api-name").value = "";
  dlgAcc.close();
  dlgApi.showModal();
  loadApi();
});
// Geheimen niet laten staan als het venster dicht gaat
dlgApi.addEventListener("close", () => { showSecret("api-newkey", ""); showSecret("api-newsecret", ""); });

$("#api-create").addEventListener("click", async () => {
  const name = $("#api-name").value.trim();
  const scopes = $$("input[name=api-scope]").filter((c) => c.checked).map((c) => c.value);
  $("#api-err").textContent = !name ? "Geef de sleutel een naam, bijvoorbeeld de naam van het systeem." : !scopes.length ? "Kies minstens één recht." : "";
  if ($("#api-err").textContent) return;
  const btn = $("#api-create"); btn.disabled = true;
  try {
    const d = await api("keys", { method: "POST", body: { name, scopes } });
    $("#api-name").value = "";
    showSecret("api-newkey", d.key.secret);
    await loadApi();
  } catch (err) { $("#api-err").textContent = err.message; btn.disabled = false; }
});

$("#api-keys").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-revoke]"); if (!b) return;
  if (!confirmTwice(b, "Zeker weten?", "Intrekken")) return;
  try { await api("keys/" + encodeURIComponent(b.dataset.revoke), { method: "DELETE" }); toast(`Sleutel "${b.dataset.name}" ingetrokken. Die koppeling werkt niet meer.`); loadApi(); }
  catch (err) { $("#api-err").textContent = err.message; }
});
// Twee keer klikken in plaats van een browserdialoog
function confirmTwice(b, ask, label) {
  if (b.dataset.sure) { delete b.dataset.sure; b.textContent = label; b.classList.remove("danger"); return true; }
  b.dataset.sure = "1"; b.textContent = ask; b.classList.add("danger");
  setTimeout(() => { if (b.dataset.sure) { delete b.dataset.sure; b.textContent = label; b.classList.remove("danger"); } }, 4000);
  return false;
}

$("#api-hook-save").addEventListener("click", async () => {
  const btn = $("#api-hook-save"); btn.disabled = true; $("#api-err").textContent = "";
  try {
    const d = await api("webhook", { method: "PUT", body: { url: $("#api-hook").value.trim() } });
    $("#api-hook").value = d.url;
    if (d.secret) showSecret("api-newsecret", d.secret);
    toast(d.url ? "Webhookadres opgeslagen." : "Webhook uitgezet.");
    loadApi();
  } catch (err) { $("#api-err").textContent = err.message; }
  finally { btn.disabled = false; }
});
$("#api-hook-secret").addEventListener("click", async (e) => {
  if (!confirmTwice(e.currentTarget, "Oude werkt dan niet meer. Zeker?", "Nieuw geheim")) return;
  try { const d = await api("webhook/secret", { method: "POST" }); showSecret("api-newsecret", d.secret); toast("Nieuw geheim gemaakt. Zet het in je ERP; het oude geheim werkt niet meer."); }
  catch (err) { $("#api-err").textContent = err.message; }
});
$("#api-hook-test").addEventListener("click", async () => {
  const btn = $("#api-hook-test"); btn.disabled = true; $("#api-hook-status").textContent = "Versturen…";
  try {
    const d = await api("webhook/test", { method: "POST" });
    $("#api-hook-status").textContent = d.ok ? `Testbericht afgeleverd (status ${d.status}).` : `Testbericht mislukt: ${d.error}.`;
  } catch (err) { $("#api-hook-status").textContent = err.message; }
  finally { btn.disabled = false; }
});
$("#api-hook-retry").addEventListener("click", async () => {
  try { const d = await api("webhook/retry", { method: "POST" }); toast(`${d.sent} bericht${d.sent === 1 ? "" : "en"} afgeleverd.`); loadApi(); }
  catch (err) { $("#api-err").textContent = err.message; }
});
$$("#dlg-api [data-copy]").forEach((b) => b.addEventListener("click", async () => {
  const text = $("#" + b.dataset.copy).textContent;
  try { await navigator.clipboard.writeText(text); b.textContent = "Gekopieerd"; setTimeout(() => (b.textContent = "Kopiëren"), 2000); }
  catch { const r = document.createRange(); r.selectNodeContents($("#" + b.dataset.copy)); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); toast("Selecteer en kopieer met Ctrl+C."); }
}));
