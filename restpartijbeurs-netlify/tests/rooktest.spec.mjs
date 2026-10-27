// Rooktest FoodSource / Restpartijbeurs – draait na elke release.
//
// Productie: alleen kijken (inloggen, aanbod bekijken, API lezen). Er wordt NIETS aangemaakt of gewijzigd.
// Testomgeving (APP_ENV=test): daarnaast een volledige handel: partij met foto aanbieden, bieden, gunnen, intrekken,
// en vraag en aanbod: koper plaatst een vraag, aanbieder reageert met "Ik kan leveren", koper ziet de reactie.
// Welke omgeving het is, leest de test zelf uit /api/status; de volledige handel draait nooit op productie.
//
// Instellingen (omgevingsvariabelen; in GitHub als "secrets"):
//   SMOKE_URL                      adres om te testen, bijv. https://restpartijbeurs.netlify.app
//   TEST_BUYER / TEST_BUYER_CODE   koper-testaccount in de testomgeving
//   TEST_SELLER / TEST_SELLER_CODE aanbieder-testaccount in de testomgeving
//   PROD_BUYER / PROD_BUYER_CODE   koper-account op productie (alleen kijken)
//   TEST_API_KEY / PROD_API_KEY    optioneel: API-sleutel (fs_test_… / fs_live_…) met recht "lots:read"
//   SMOKE_AI=1                     optioneel: ook de AI-invulhulp testen (kost minder dan een cent)
import { test, expect, devices } from "@playwright/test";

const BASE = (process.env.SMOKE_URL || "").replace(/\/+$/, "");
let ENV = "onbekend", SETTINGS = {};
const P = () => (ENV === "test" ? "TEST" : "PROD");
const acct = (role) => ({ name: process.env[`${P()}_${role}`] || "", code: process.env[`${P()}_${role}_CODE`] || "" });
const apiKey = () => process.env[`${P()}_API_KEY`] || "";
const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Amsterdam" }).replace(/[-:]/g, "").replace(" ", "-").slice(0, 13);
const PRODUCT = `Rooktest ${stamp}`;
const WANTED = `Rooktestvraag ${stamp}`;   // uniek woord: past bij geen echte partij of vraag

test.beforeAll(async ({ request }) => {
  expect(BASE, "Zet SMOKE_URL op het adres van de site, bijv. https://restpartijbeurs.netlify.app").toMatch(/^https?:\/\//);
  expect(BASE, "SMOKE_URL wijst naar het Netlify-dashboard in plaats van de site zelf").not.toContain("app.netlify.com");
  const r = await request.get(BASE + "/api/status");
  expect(r.status(), "/api/status moet antwoorden (database en serverfunctie werken)").toBe(200);
  const d = await r.json();
  SETTINGS = d.settings || {}; ENV = SETTINGS.environment || "prod";
  console.log(`Omgeving: ${ENV} · ${BASE} · site "${SETTINGS.siteName}"`);
  // In GitHub weet de workflow welke omgeving hij bedoelt; klopt dat niet, dan is groen misleidend → rood
  const want = (process.env.SMOKE_EXPECT_ENV || "").toLowerCase();
  if (want) {
    expect(ENV, want === "test"
      ? `${BASE} meldt zich als productie. Zet in Netlify bij dit project APP_ENV=test en doe een nieuwe deploy (of controleer SMOKE_URL_TEST).`
      : `${BASE} meldt zich als testomgeving, maar productie werd verwacht (controleer SMOKE_URL_PROD).`).toBe(want);
    const need = want === "test" ? ["TEST_BUYER", "TEST_BUYER_CODE", "TEST_SELLER", "TEST_SELLER_CODE"] : ["PROD_BUYER", "PROD_BUYER_CODE"];
    const missing = need.filter((k) => !process.env[k]);
    expect(missing, `Deze secrets ontbreken in GitHub (Settings → Secrets and variables → Actions): ${missing.join(", ")}`).toEqual([]);
  }
});

// Elke pagina: JavaScript-fouten verzamelen; aan het eind van de test mogen er geen zijn
function watch(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}
async function login(page, { name, code }) {
  // Wachten tot de app klaar is met opstarten (die bouwt het inlogscherm na het laden nog op en wist dan de velden)
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.locator("#form-login")).toBeVisible();
  for (let i = 0; i < 3; i++) {
    await page.fill("#l-name", name);
    await page.fill("#l-code", code);
    await page.waitForTimeout(200);
    if ((await page.inputValue("#l-name")) === name && (await page.inputValue("#l-code")) === code) break;
  }
  await page.click("#form-login button[type=submit]");
  // Ingelogd (kopregel met naam) of de vraag om eerst een eigen code te kiezen; wat het eerst verschijnt
  const done = page.locator("#user-box:not([hidden]), #dlg-forcecode[open], #login-err:not(:empty)").first();
  await expect(done, `Inloggen als ${name} lukte niet binnen de tijd`).toBeVisible();
  const err = (await page.locator("#login-err").textContent().catch(() => "")) || "";
  expect(err, `Inloggen als ${name} geweigerd (klopt de code?)`).toBe("");
  expect(await page.locator("#dlg-forcecode[open]").count(), `Testaccount ${name} moet eerst één keer met de hand inloggen en een eigen code kiezen`).toBe(0);
  await expect(page.locator("#view-market")).toBeVisible();
}

// Partij intrekken via Mijn partijen (liefst met een reden zonder verplichte toelichting)
async function withdrawLot(page, product) {
  await page.click("#tab-mine");
  const panel = page.locator("#mine .panel", { hasText: product });
  await panel.locator("[data-act=withdraw]").click();
  await expect(page.locator("#dlg-reason")).toBeVisible();
  const choices = page.locator("#rs-list label");
  const n = await choices.count();
  let picked = false;
  for (let i = 0; i < n && !picked; i++) {
    const txt = await choices.nth(i).innerText();
    if (!/anders/i.test(txt)) { await choices.nth(i).click(); picked = true; }
  }
  if (!picked) { await choices.first().click(); await page.fill("#rs-note", "Rooktest"); }
  await page.click("#rs-ok");
  await expect(panel).toContainText("Ingetrokken");
}

// ---------- 1. site, beveiliging en versie ----------
test("site, beveiliging en versie", async ({ request }) => {
  const home = await request.get(BASE + "/");
  expect(home.status()).toBe(200);
  const h = home.headers();
  expect(h["content-security-policy"], "beveiligingsheader CSP ontbreekt").toContain("script-src 'self'");
  if (BASE.startsWith("https://")) {
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["strict-transport-security"]).toBeTruthy();
  }
  // De pagina en version.json horen bij dezelfde release (anders is de deploy half gelukt)
  const html = await home.text();
  const meta = (html.match(/name="app-version" content="([^"]+)"/) || [])[1];
  const v = await (await request.get(BASE + "/version.json")).json();
  expect(v.version, "version.json ontbreekt of is leeg").toBeTruthy();
  if (meta && meta !== "dev") expect(meta, "index.html en version.json zijn van verschillende versies").toBe(v.version);
  console.log(`Versie: ${v.version}${v.built ? " (gebouwd " + v.built + ")" : ""}`);
  const st = await (await request.get(BASE + "/api/status")).json();
  expect(st.needsSetup, "er is nog geen beheerder: database leeg of verkeerde database").toBe(false);
  const mf = await request.get(BASE + "/api/manifest.webmanifest");
  expect(mf.status()).toBe(200);
  expect((await mf.json()).name).toBeTruthy();
  const icon = await request.get(BASE + "/api/brand/icon-180.png", { maxRedirects: 0 });
  expect([200, 302]).toContain(icon.status());
});

// ---------- 2. inlogscherm ----------
test("inlogscherm laadt zonder fouten", async ({ page }) => {
  const errors = watch(page);
  await page.goto("/");
  await expect(page.locator("#form-login")).toBeVisible();
  await expect(page.locator("#site-name")).toHaveText(/\S/);
  expect(errors, "JavaScript-fouten op de pagina").toEqual([]);
});

// ---------- 3. koper op de computer: inloggen, aanbod, uitloggen ----------
test("koper: inloggen, aanbod bekijken en uitloggen (computer)", async ({ page }) => {
  const buyer = acct("BUYER");
  test.skip(!buyer.name, `Geen koper-testaccount ingesteld (${P()}_BUYER / ${P()}_BUYER_CODE)`);
  const errors = watch(page);
  await login(page, buyer);
  await expect(page.locator("#market")).toBeVisible();
  await expect(page.locator("#market .lot, #market .empty, #market .notice").first()).toBeVisible();
  for (const tab of ["#tab-wanted", "#tab-mine", "#tab-bids", "#tab-market"]) { await page.click(tab); await expect(page.locator(tab)).toHaveAttribute("aria-selected", "true"); }
  // grote foto van de eerste partij met foto moet laden (eerder bug: foto weg uit de database)
  const thumb = page.locator("#market .thumbs button").first();
  if (await thumb.count()) {
    await thumb.click();
    await expect(page.locator("#dlg-photo")).toBeVisible();
    await expect.poll(() => page.locator("#lb-img").evaluate((i) => i.complete && i.naturalWidth), { message: "grote foto laadt niet" }).toBeGreaterThan(0);
    await page.click("#dlg-photo [data-close]");
  }
  await page.click("#btn-logout");
  await expect(page.locator("#form-login")).toBeVisible();
  expect(errors).toEqual([]);
});

// ---------- 4. koper op de telefoon ----------
test.describe("telefoon", () => {
  const { defaultBrowserType, ...iphone } = devices["iPhone 13"];
  test.use({ ...iphone });
  test("koper: aanbod als tegels, details openen (telefoon)", async ({ page }) => {
    const buyer = acct("BUYER");
    test.skip(!buyer.name, `Geen koper-testaccount ingesteld (${P()}_BUYER)`);
    const errors = watch(page);
    await login(page, buyer);
    await expect(page.locator("#market .tl, #market .empty, #market .notice").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), "pagina is breder dan het scherm").toBe(false);
    const tile = page.locator("#market .tl").first();
    if (await tile.count()) {
      await tile.click();
      await expect(page.locator("#dlg-lotdetail")).toBeVisible();
      await expect(page.locator("#ld-body .lot")).toBeVisible();
      await page.click("#dlg-lotdetail [data-close]");
    }
    expect(errors).toEqual([]);
  });
});

// ---------- 5. API voor koppelingen ----------
test("API: zonder sleutel geweigerd, met sleutel partijen lezen", async ({ request }) => {
  const none = await request.get(BASE + "/api/v1/me");
  expect([401, 403], "API zonder sleutel moet geweigerd worden").toContain(none.status());
  const key = apiKey();
  test.skip(!key, `Geen API-sleutel ingesteld (${P()}_API_KEY); alleen de weigering is getest`);
  const me = await request.get(BASE + "/api/v1/me", { headers: { "X-API-Key": key } });
  expect(me.status(), "API-sleutel werkt niet (ingetrokken, verkeerde omgeving of API uitgezet?)").toBe(200);
  expect(me.headers()["foodsource-request-id"]).toBeTruthy();
  const lots = await request.get(BASE + "/api/v1/lots?limit=5", { headers: { "X-API-Key": key } });
  expect(lots.status()).toBe(200);
  const body = await lots.json();
  expect(Array.isArray(body.data)).toBe(true);
  expect(typeof body.hasMore).toBe("boolean");
});

// ---------- 6. volledige handel – alleen in de testomgeving ----------
test.describe("volledige handel (alleen testomgeving)", () => {
  test.describe.configure({ mode: "serial" });
  const ok = () => ENV === "test" && acct("SELLER").name && acct("BUYER").name;
  const reason = () => ENV !== "test" ? "Dit is productie: daar wordt niets aangemaakt" : "TEST_SELLER en TEST_BUYER zijn niet allebei ingesteld";

  test("aanbieder biedt een partij met foto aan", async ({ page }) => {
    test.skip(!ok(), reason());
    const errors = watch(page);
    await login(page, acct("SELLER"));
    await page.click("#btn-new");
    await expect(page.locator("#dlg-lot")).toBeVisible();
    // kleine echte JPEG maken in de browser en als foto toevoegen
    const b64 = await page.evaluate(() => { const c = document.createElement("canvas"); c.width = 640; c.height = 480; const x = c.getContext("2d");
      x.fillStyle = "#2f7d4a"; x.fillRect(0, 0, 640, 480); x.fillStyle = "#fff"; x.font = "bold 48px sans-serif"; x.fillText("ROOKTEST", 170, 255); return c.toDataURL("image/jpeg", 0.85).split(",")[1]; });
    await page.setInputFiles("#f-photo", { name: "rooktest.jpg", mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") });
    await expect(page.locator("#photo-edit .ph img")).toHaveCount(1, { timeout: 30_000 });
    // Staat de AI aan, dan vult die na de eerste foto zelf velden in: eerst laten afronden, daarna zetten wij alles zelf
    await page.waitForTimeout(800);
    if (await page.locator("#ai-strip").isVisible()) await expect(page.locator("#ai-btn")).not.toHaveText("Bezig…", { timeout: 30_000 });
    await page.fill("#f-product", PRODUCT);
    await page.selectOption("#f-cat", "Groente");
    await page.selectOption("#f-unit", "colli");
    await page.fill("#f-qty", "10");
    await page.fill("#f-minqty", "1");
    await page.fill("#f-price", "1,00");
    await page.fill("#f-loc", "Teststad");
    await page.fill("#f-note", "Automatische test na release; wordt direct weer ingetrokken.");
    await page.click("#lot-submit");
    await expect(page.locator("#dlg-lot")).toBeHidden();
    await expect(page.locator(".toast")).toContainText(/gepubliceerd|bijgewerkt/i);
    expect(errors).toEqual([]);
  });

  test("koper vindt de partij, bekijkt de foto en biedt", async ({ page }) => {
    test.skip(!ok(), reason());
    const errors = watch(page);
    await login(page, acct("BUYER"));
    await page.fill("#q", PRODUCT);
    const card = page.locator("#market .lot", { hasText: PRODUCT });
    await expect(card).toBeVisible();
    await card.locator(".thumbs button").first().click();
    await expect.poll(() => page.locator("#lb-img").evaluate((i) => i.complete && i.naturalWidth), { message: "grote foto van de nieuwe partij laadt niet" }).toBeGreaterThan(0);
    await page.click("#dlg-photo [data-close]");
    await card.locator("[data-act=bid]").click();
    await expect(page.locator("#dlg-bid")).toBeVisible();
    await page.fill("#b-price", "0,90");
    await page.fill("#b-qty", "4");
    await page.click("#form-bid button[type=submit]");
    await expect(page.locator("#dlg-bid")).toBeHidden();
    await page.click("#tab-bids");
    await expect(page.locator("#mybids")).toContainText(PRODUCT);
    expect(errors).toEqual([]);
  });

  test("aanbieder gunt het bod; koper ziet de gunning", async ({ page, browser }) => {
    test.skip(!ok(), reason());
    const errors = watch(page);
    await login(page, acct("SELLER"));
    await page.click("#tab-mine");
    const panel = page.locator("#mine .panel", { hasText: PRODUCT });
    await expect(panel.locator("[data-act=accept]")).toBeVisible();
    await panel.locator("[data-act=accept]").first().click();
    await expect(page.locator(".toast")).toContainText("Gegund");
    // koper in een eigen venster
    const ctx = await browser.newContext();
    const buyerPage = await ctx.newPage();
    await login(buyerPage, acct("BUYER"));
    await buyerPage.click("#tab-bids");
    await expect(buyerPage.locator("#mybids")).toContainText("Gegund");
    await ctx.close();
    expect(errors).toEqual([]);
  });

  test("aanbieder trekt de rest in (opruimen)", async ({ page }) => {
    test.skip(!ok(), reason());
    const errors = watch(page);
    await login(page, acct("SELLER"));
    await withdrawLot(page, PRODUCT);
    expect(errors).toEqual([]);
  });
});

// ---------- 6b. vraag en aanbod (Gevraagd) – alleen in de testomgeving ----------
test.describe("vraag en aanbod (alleen testomgeving)", () => {
  test.describe.configure({ mode: "serial" });
  const ok = () => ENV === "test" && acct("SELLER").name && acct("BUYER").name;
  const reason = () => ENV !== "test" ? "Dit is productie: daar wordt niets aangemaakt" : "TEST_SELLER en TEST_BUYER zijn niet allebei ingesteld";
  const tomorrow = new Date(Date.now() + 36 * 3600000).toLocaleDateString("sv-SE", { timeZone: "Europe/Amsterdam" });

  test("koper plaatst een vraag", async ({ page }) => {
    test.skip(!ok(), reason());
    const errors = watch(page);
    await login(page, acct("BUYER"));
    await page.click("#tab-wanted");
    await expect(page.locator("#view-wanted")).toBeVisible();
    await page.click("#btn-new");
    await expect(page.locator("#dlg-want")).toBeVisible();
    await page.fill("#w-product", WANTED);
    await page.selectOption("#w-cat", "Groente");
    await page.fill("#w-qty", "5");
    await page.selectOption("#w-unit", "colli");
    await page.fill("#w-price", "1,00");
    await page.fill("#w-until", tomorrow);
    await page.fill("#w-region", "Teststad");
    await page.fill("#w-note", "Automatische test na release; wordt direct weer gesloten.");
    if (!(await page.inputValue("#w-company"))) await page.fill("#w-company", "Rooktest");
    await page.click("#want-submit");
    await expect(page.locator("#dlg-want"), await page.locator("#want-err").textContent().catch(() => "")).toBeHidden();
    await expect(page.locator(".want.mine", { hasText: WANTED })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("aanbieder ziet de vraag en reageert met 'Ik kan leveren' (telefoon)", async ({ browser }) => {
    test.skip(!ok(), reason());
    const { defaultBrowserType, ...iphone } = devices["iPhone 13"];
    const ctx = await browser.newContext({ ...iphone, baseURL: BASE });
    const page = await ctx.newPage();
    const errors = watch(page);
    await login(page, acct("SELLER"));
    await page.click("#tab-wanted");
    const card = page.locator(".want", { hasText: WANTED });
    await expect(card, "de vraag van de koper is niet zichtbaar bij de aanbieder").toBeVisible();
    await card.locator("[data-act=want-supply]").click();
    // Heeft de aanbieder al lopende partijen, dan eerst de keuzelijst; de test zet een nieuwe partij online
    await expect(page.locator("#dlg-lot[open], #dlg-supply[open]").first()).toBeVisible();
    if (await page.locator("#dlg-supply[open]").count()) await page.click("#dlg-supply [data-act=supply-new]");
    await expect(page.locator("#dlg-lot")).toBeVisible();
    await expect(page.locator("#lot-want")).toBeVisible();
    await expect(page.locator("#f-product"), "'Ik kan leveren' vult het product niet in").toHaveValue(WANTED);
    await expect(page.locator("#f-price")).toHaveValue("1,00");
    await page.fill("#f-loc", "Teststad");
    await page.fill("#f-note", "Automatische test na release; wordt direct weer ingetrokken.");
    if (!(await page.inputValue("#f-company"))) await page.fill("#f-company", "Rooktest");
    await page.click("#lot-submit");
    await expect(page.locator("#dlg-lot")).toBeHidden();
    await expect(page.locator(".toast")).toContainText(/koper krijgt bericht/i);
    await expect(card).toContainText("aangeboden; de koper ziet hem");
    expect(errors).toEqual([]);
    await ctx.close();
  });

  test("koper ziet de reactie bij zijn vraag en sluit de vraag", async ({ page }) => {
    test.skip(!ok(), reason());
    const errors = watch(page);
    await login(page, acct("BUYER"));
    await page.click("#tab-wanted");
    const card = page.locator(".want.mine", { hasText: WANTED });
    const hit = card.locator(".want-hit", { hasText: "Reactie" });
    await expect(hit, "de reactie van de aanbieder staat niet bij de vraag").toBeVisible();
    await hit.click();
    await expect(page.locator("#dlg-lotdetail")).toBeVisible();
    await expect(page.locator("#ld-body")).toContainText("Reactie op jouw vraag");
    await page.click("#dlg-lotdetail [data-close]");
    await card.locator("[data-act=want-found]").click();
    await expect(page.locator(".toast")).toContainText("gesloten");
    await expect(page.locator(".want.mine", { hasText: WANTED })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("aanbieder trekt de reactie-partij in (opruimen)", async ({ page }) => {
    test.skip(!ok(), reason());
    const errors = watch(page);
    await login(page, acct("SELLER"));
    await withdrawLot(page, WANTED);
    expect(errors).toEqual([]);
  });
});

// ---------- 7. AI-invulhulp (optioneel, alleen testomgeving) ----------
test("AI vult partijgegevens in uit een beschrijving", async ({ page }) => {
  test.skip(process.env.SMOKE_AI !== "1", "AI-test staat uit (SMOKE_AI=1 om mee te draaien)");
  test.skip(ENV !== "test" || !acct("SELLER").name, "Alleen in de testomgeving met TEST_SELLER");
  test.skip(!SETTINGS.aiEnabled, "AI-herkenning staat uit in deze omgeving");
  const errors = watch(page);
  await login(page, acct("SELLER"));
  await page.click("#btn-new");
  await expect(page.locator("#ai-strip")).toBeVisible();
  await page.fill("#ai-text", "200 dozen trostomaten klasse 1, 6 kilo per doos, 4 euro per doos, tot vrijdag, ophalen Westland");
  await page.click("#ai-btn");
  await expect(page.locator("#ai-status")).toContainText("Ingevuld", { timeout: 30_000 });
  await expect(page.locator("#f-product")).toHaveValue(/tomat/i);
  await expect(page.locator("#f-qty")).toHaveValue("200");
  await page.click("#dlg-lot [data-close]");   // niet publiceren
  expect(errors).toEqual([]);
});
