# Restpartijbeurs

Handelsplatform voor restpartijen aardappelen, groente en fruit. Draait op Netlify en
bewaart de gegevens in dezelfde Aiven-database als Vloeren Kassa, in eigen tabellen
(`rpb_users`, `rpb_sessions`, `rpb_docs`). De tabel `records` van de kassa wordt niet aangeraakt.

## Bestanden

| Bestand | Wat het is |
| --- | --- |
| `public/index.html` | De schermen van de app |
| `public/app.css` | De opmaak |
| `public/js/core.js` | Basis: praten met de server, opslaan, meldingen |
| `public/js/market.js` | Aanbod, mijn partijen, mijn biedingen, foto's, contact |
| `public/js/account.js` | Inloggen, account aanvragen, code vergeten, mijn account |
| `public/js/push.js`, `public/sw.js` | Pushmeldingen: aanzetten in Mijn account, service worker die de melding toont |
| `public/js/wants.js` | Gevraagd: vragen van kopers, "Ik kan leveren", passend aanbod |
| `public/js/notes.js` | Belletje met meldingenlijst; rood getal op het app-icoon |
| `public/js/admin.js` | Beheer: dashboard, gebruikers, redencodes, betalingen, logboek, instellingen |
| `public/js/payments.js` | Abonnement online betalen (Mollie) |
| `public/js/stats.js` | Beheer: statistieken |
| `public/js/integrations.js` | Mijn account → API-koppelingen: sleutels en webhook |
| `public/api-tester.html`, `public/js/api-tester.js` | API-tester (ERP-simulator) op `/api-tester.html`: partijen aanbieden via de API, berichten en orders bekijken |
| `public/openapi.yaml` | Technische beschrijving van de API (OpenAPI 3.1) |
| `public/js/ai.js` | Partij aanbieden: velden laten invullen op basis van een foto |
| `public/js/brand.js` | Eigen logo: kopregel, tabblad-icoon, app-icoon; instellen onder Beheer |
| `public/js/update.js` | Laadt na een update vanzelf de nieuwe versie (kijkt in `public/version.json`) |
| `tests/` | Rooktest na elke release (Playwright); uitleg in `tests/README.md`. GitHub-workflow: `rooktest.yml` (hoort in `.github/workflows/`) |
| `public/icons/` | Standaard app-iconen zolang er geen eigen logo is |
| `netlify/lib/ai-photo.mjs` | Serverkant van de foto-herkenning (Claude via de Anthropic API) |
| `netlify/lib/push.mjs` | Pushmeldingen versturen (Web Push, versleuteld en ondertekend, zonder extra pakketten) |
| `netlify/lib/match.mjs` | Regels: past een partij bij een vraag? |
| `public/js/start.js` | Start de app (wordt als laatste geladen) |
| `public/_headers` | Beveiligingsheaders voor de website (o.a. Content-Security-Policy) |
| `netlify/functions/api.mjs` | De serverfunctie op `/api/...`: inloggen, gebruikers, partijen en biedingen |
| `netlify/functions/webhooks.mjs` | Geplande functie (elke 5 minuten): mislukte webhookberichten opnieuw sturen |
| `netlify/lib/foodsource-v1.mjs` | De FoodSource API v1 op `/api/v1/...` voor koppelingen met ERP-systemen |
| `netlify.toml` | Vertelt Netlify waar de app en de functie staan |
| `package.json` | Laat Netlify de PostgreSQL-driver (`pg`) installeren |

## Online zetten (eenmalig, ongeveer 15 minuten)

### 1. GitHub
1. Maak op GitHub een nieuwe repository, bijvoorbeeld `restpartijbeurs`, en zet hem op **Private**.
2. Kies **uploading an existing file** en sleep de inhoud van deze map erin: de mappen `public` en `netlify`, plus `netlify.toml`, `package.json` en `README.md`.
3. Kies **Commit changes**.

### 2. Netlify
1. Kies **Add new project → Import an existing project → GitHub** en kies de repository.
2. Laat de build-instellingen leeg; Netlify leest ze uit `netlify.toml`. Kies **Deploy**.
3. Ga naar **Site configuration → Environment variables** en voeg toe:

| Variabele | Waarde |
| --- | --- |
| `DATABASE_URL` | Dezelfde waarde als bij de Vloeren Kassa-site (de Service URI van Aiven). Markeer als secret. |
| `PG_SSL_INSECURE` | `true`, net als bij de kassa. Of gebruik `PG_SSL_CA` met het CA-certificaat uit Aiven. |
| `RPB_SETUP_CODE` | Installatiecode: zelfbedacht, minstens 16 tekens, per omgeving een andere. Nodig om de eerste beheerder aan te maken, om een beheerder te herstellen die zijn code kwijt is, en als extra bevestiging bij leegmaken. Laat hem staan. |
| `MOLLIE_API_KEY` | Optioneel. De API-sleutel uit je Mollie-dashboard (`test_...` om te testen, `live_...` voor echte betalingen). Markeer als secret. Zonder deze sleutel registreert de beheerder betalingen handmatig. |
| `APP_ENV` | Alleen in de testomgeving: `test`. Toont een oranje balk "TESTOMGEVING". |
| `PG_MIGRATE_FROM` | Eenmalig, alleen bij Production: `public`. Verplaatst de bestaande Restpartijbeurs-tabellen naar het schema van `PG_SCHEMA`. Na één keer openen van de app weer weghalen. Werkt nooit in de testomgeving. |
| `SITE_URL` | Alleen in de testomgeving: het eigen adres, bijv. `https://test--restpartijbeurs.netlify.app`. Zonder deze waarde wijzen links in e-mails en de terugkoppeling van Mollie naar productie (Netlify geeft een branch deploy het adres van productie mee). |
| `PG_SCHEMA` | Alleen in de testomgeving, bijv. `rpb_test`. De app gebruikt dan een eigen schema in dezelfde database, gescheiden van de echte gegevens en van Vloeren Kassa. |
| `ALLOW_WIPE` | Alleen tijdelijk: `true` zet "Omgeving leegmaken" (Beheer → Website-instellingen) aan buiten de testomgeving. Haal hem daarna weer weg. In de testomgeving (`APP_ENV=test`) staat leegmaken altijd aan. |
| `GMAIL_USER` | Optioneel. Je Gmail-adres; de app verstuurt daarmee mails bij "Code vergeten?". |
| `GMAIL_APP_PASSWORD` | Nodig bij `GMAIL_USER`. Een app-wachtwoord van Google (myaccount.google.com → Beveiliging → App-wachtwoorden; vereist tweestapsverificatie). Markeer als secret. |
| `BREVO_API_KEY` | Optioneel, alternatief voor Gmail. API-sleutel van Brevo (brevo.com → SMTP & API → API Keys). Markeer als secret. Daarmee krijgen gebruikers bij "Code vergeten?" zelf een resetlink per e-mail. |
| `MAIL_FROM` | Nodig bij `BREVO_API_KEY`. Afzenderadres, bijvoorbeeld `noreply@jouwdomein.nl`. Het domein moet in Brevo geverifieerd zijn. |
| `MAIL_FROM_NAME` | Optioneel. Afzendernaam; standaard de naam van de website. |

4. Ga naar **Deploys → Trigger deploy → Deploy site** en wacht tot hij op **Published** staat.

### 3. Eerste beheerder
1. Open het webadres van de site. Je ziet **Eerste beheerder**.
2. Vul `RPB_SETUP_CODE`, je naam, bedrijf, contact en een eigen code in.
3. Ga naar **Beheer** en maak voor elke handelaar een account aan. Geef de naam en code persoonlijk door.

Na de eerste beheerder kan niemand met `RPB_SETUP_CODE` nog een beheerder aanmaken. Laat de code wel staan: je hebt hem nodig om een beheerder te herstellen en om een omgeving leeg te maken.

## Test- en productieomgeving

Eén Netlify-project, twee branches in GitHub: `main` is productie, `test` is de testomgeving (branch deploy op `https://test--<project>.netlify.app`). Zet in Netlify bij de omgevingsvariabelen voor de context **Branch deploys** (of alleen branch `test`): `APP_ENV=test`, `PG_SCHEMA=rpb_test`, `SITE_URL=https://test--<project>.netlify.app` en eventueel een `test_`-sleutel van Mollie. De testomgeving gebruikt dan dezelfde database maar een eigen schema, toont een oranje balk, geeft `fs_test_`-sleutels en mag altijd worden leeggemaakt. Werkwijze: nieuwe versie eerst op `test` zetten en controleren, daarna `test` samenvoegen in `main`.

Let op: geplande functies (zoals het opnieuw proberen van webhooks elke 5 minuten) draait Netlify alleen voor productie. In de testomgeving gaan webhooks direct de deur uit, maar mislukte pogingen worden daar niet automatisch herhaald (wel met de knop "Mislukte berichten opnieuw sturen" in Mijn account → API-koppelingen).

## Een update doorvoeren

Upload altijd **alle gewijzigde bestanden in één keer**. De bestanden in `public/` en `netlify/functions/api.mjs` horen bij elkaar; een half bijgewerkte app werkt niet goed. Met GitHub Desktop gaat dat in één commit.

Vervang het gewijzigde bestand op GitHub en kies **Commit changes**. Netlify bouwt zelf opnieuw.
Gegevens blijven staan; ingelogde gebruikers blijven ingelogd.

## AI: velden invullen op basis van een foto

Bij **Partij aanbieden** maakt de aanbieder een foto; Claude stelt product, ras, categorie, klasse, herkomst (als die op de verpakking staat), eenheid, verpakking, kg per eenheid en een korte toelichting voor. De aanbieder controleert de gemarkeerde velden en vult hoeveelheid, prijs en datum zelf in. Wat de aanbieder al zelf heeft ingevuld, blijft staan.

Aanzetten:
1. Maak een API-sleutel op [console.anthropic.com](https://console.anthropic.com) (zet er een maandlimiet op).
2. Zet hem in Netlify als `ANTHROPIC_API_KEY` en doe een nieuwe deploy. Optioneel: `AI_MODEL` (standaard `claude-haiku-5-5`, snel en goedkoop; `claude-sonnet-5-5` herkent nauwkeuriger maar is trager).
3. Zet als beheerder onder **Website-instellingen → AI** het vinkje aan.

Grenzen: maximaal 60 foto's per uur per gebruiker en 1000 per dag voor de hele site; na 9 seconden zonder antwoord stopt de herkenning (Netlify-limiet). Elk voorstel staat in het logboek, met model en verbruik.

**Beschrijven in plaats van (of naast) een foto.** In de strook bovenaan "Partij aanbieden" kan de aanbieder de partij typen, inspreken (knop *Inspreken*, of de microfoon van het toetsenbord) of een bericht plakken uit WhatsApp of mail, bijvoorbeeld "200 dozen trostomaten klasse 1, 6 kilo per doos, 4 euro per doos, tot vrijdag, ophalen Barendrecht". Claude vult dan ook hoeveelheid, minimale afname, prijs (per eenheid, excl. btw), beschikbaar-tot-datum en afhaallocatie in; uit alleen een foto nooit. Met foto en beschrijving samen gaat de beschrijving voor. Endpoint: `POST /api/ai/lot` met `{ text, photoId }` (minstens één van beide; tekst maximaal 1500 tekens). Zelf ingevulde velden worden nooit overschreven. Inspreken gebruikt de spraakherkenning van de browser (Safari: Apple, Chrome: Google); de tekst gaat daarna, net als getypte tekst, naar Claude. Daarvoor staat `microphone=(self)` in `_headers`.

## Eigen logo

Beheer → Instellingen → **Logo**: kies een PNG, JPEG, WebP of SVG (een SVG wordt in de browser omgezet naar PNG; de server bewaart nooit SVG). De browser maakt er vierkante app-iconen van (512, 192, 180 en 32 px) met de gekozen achtergrondkleur; voor een breed logo kies je via "Apart app-icoon…" een vierkant beeldmerk. Het logo verschijnt in de kopregel en op het inlogscherm, in het tabblad van de browser, in HTML-e-mails (als `URL` in Netlify een https-adres is) en als icoon wanneer iemand de site op het beginscherm van een telefoon zet (`/api/manifest.webmanifest`, `apple-touch-icon`). Bestanden staan in de tabel `rpb_assets` en worden geserveerd via `/api/brand/logo` en `/api/brand/icon-<maat>.png`.

## Pushmeldingen op telefoon en computer

Elke gebruiker zet dit zelf aan per toestel: **Mijn account → Meldingen op dit toestel → Meldingen aanzetten**. Er zijn drie soorten meldingen, elk apart aan of uit te zetten:

- **Nieuw bod op mijn partij** gaat naar de aanbieder. Een tik op de melding opent Mijn partijen met die partij.
- **Mijn bod gegund** gaat naar de koper, met aantal, prijs en afhaalplaats. Een tik op de melding opent Mijn biedingen.
- **Mijn bod niet gegund** gaat naar de koper. Een tik op de melding opent het aanbod.

Waar het werkt:

- **Android en computer** (Chrome, Edge, Firefox, Safari): direct in de browser.
- **iPhone en iPad** (iOS 16.4 of nieuwer): alleen als de site op het beginscherm staat en vanaf dat icoon is geopend. De app laat de stappen zelf zien.

Bij uitloggen wordt het toestel afgemeld.

**Meldingenlijst en getal op het app-icoon.** Elke melding wordt ook bewaard. Rechtsboven staat een belletje met het aantal nieuwe meldingen. Daaronder staat de lijst met de laatste 50, ook als pushmeldingen uit staan of de melding op de telefoon is weggetikt. Tik je een melding aan, dan opent de app op de juiste plek. Openen van de lijst markeert de meldingen als gelezen. Op het app-icoon staat een rood getal met het aantal ongelezen meldingen; dat verdwijnt zodra je de app opent. Dit werkt op een iPhone vanaf iOS 16.4, en op Android en de computer als de browser het ondersteunt. De lijst staat in de tabel `rpb_notes`: maximaal 100 meldingen per gebruiker, 90 dagen bewaard. Endpoints: `GET /api/notes` en `POST /api/notes/read` met `{id}` of `{all: true}`.

**Testmelding.** Die komt na 5 seconden, zodat je de app kunt sluiten; een iPhone toont geen banner van een app die open is. Staat de app open, dan verschijnt een melding als balkje bovenin. In Netlify staat bij Logs → Functions → api per melding een regel `push …` met het antwoord van de pushdienst. `push web.push.apple.com 201 ok` betekent dat Apple hem heeft aangenomen.

**Niets in te stellen.** De server maakt bij het eerste gebruik zelf een sleutelpaar (VAPID) en bewaart dat in de database (`rpb_settings`, sleutel `_vapid`). Test en productie hebben elk een eigen schema en dus eigen sleutels, zodat een testmelding nooit bij echte klanten komt. Wie de sleutels zelf wil beheren, zet `VAPID_PUBLIC_KEY` en `VAPID_PRIVATE_KEY` (base64url) in Netlify. Vervang die daarna niet meer, want dan moet iedereen meldingen opnieuw aanzetten.

**Techniek:**

- Standaard Web Push, zonder app store en zonder extra pakketten. Versleuteling volgens RFC 8291 (aes128gcm) en ondertekening volgens RFC 8292 (ES256).
- `public/sw.js` is alleen voor meldingen en bewaart bewust geen cache.
- Abonnementen staan in `rpb_push`, één regel per toestel, maximaal 10 per gebruiker.
- Meldingen gaan alleen naar de pushdiensten van Apple, Google, Mozilla en Microsoft. Een toestel dat de pushdienst als verdwenen meldt (404 of 410), wordt opgeruimd.
- Endpoints:
  - `GET /api/push` geeft de publieke sleutel en de keuzes van dit toestel;
  - `POST /api/push/subscribe`;
  - `PUT /api/push/prefs`;
  - `POST /api/push/unsubscribe`;
  - `POST /api/push/test`.

## Gevraagd: vraag en aanbod

Kopers zetten in het tabblad **Gevraagd** wat ze zoeken: product, categorie, hoeveelheid, klasse (of "maakt niet uit"), maximale prijs (leeg = in overleg), nodig vóór, regio en toelichting. Aanbieders tikken op **Ik kan leveren**: het venster *Partij aanbieden* opent, al ingevuld met de vraag. De partij die zo ontstaat is een gewone partij (bieden, gunnen en meldingen zoals altijd), met een vaste koppeling naar de vraag (`wantRef`).

- **Passen vraag en aanbod bij elkaar** (zelfde categorie, product komt overeen — enkelvoud/meervoud maakt niet uit, "aardappelen" past bij "Frietaardappelen" —, klasse als gekozen, prijs niet boven het maximum), dan zie je dat bij de vraag. De koper krijgt een pushmelding bij een nieuwe passende partij, de aanbieder bij een nieuwe vraag die past bij zijn partij ("Er wordt gevraagd wat jij hebt", zonder naam van de koper). Regels: `netlify/lib/match.mjs` (server) en `public/js/wants.js` (app) — houd die twee gelijk.
- De koper sluit de vraag met **Gevonden** of **Intrekken**; na de datum verloopt hij vanzelf. Gesloten vragen ziet alleen de koper zelf (onder *Mijn vragen*, met *Heropenen*) en de beheerder.
- Opslag: `rpb_docs` met collectie `wants` (één document per koper, net als partijen en biedingen); de server controleert alles. Logboek: soort *Vraag*. Leegmaken van de handel wist ook vragen.
- Meldingen: nieuw schuifje *Vraag en aanbod passen bij elkaar* in Mijn account; toestellen die al aangemeld waren krijgen het automatisch.

## FoodSource API v1 (koppelingen)

Elk ERP- of voorraadsysteem koppelt via dezelfde API op `/api/v1`. Zo werkt het:

1. Beheerder: zet onder **Website-instellingen → Koppelingen** de API aan. Uitzetten blokkeert alle sleutels direct.
2. Handelaar: maakt onder **Mijn account → API-koppelingen** een sleutel (`fs_live_…`, in de testomgeving `fs_test_…`; mee te sturen als header `X-API-Key`) met alleen de rechten die nodig zijn: `lots:read`, `lots:write`, `bids:read`. De sleutel is één keer zichtbaar.
3. Optioneel: een webhookadres (https). FoodSource stuurt dan meteen `bid.received` (nieuw bod) en `lot.awarded` (gunning), ondertekend met `FoodSource-Signature: t=…,v1=HMAC-SHA256("t.body")`. Lukt het niet, dan opnieuw na 1, 5 en 15 minuten en 1, 3, 6, 12 en 24 uur.

| Methode | Pad | Doel |
| --- | --- | --- |
| GET | `/api/v1/me` | Sleutel en bedrijf controleren |
| GET / POST | `/api/v1/lots` | Eigen partijen (filter `status`, `updatedSince`) / nieuwe partij |
| GET / PATCH | `/api/v1/lots/{id}` | Eén partij / wijzigen (`{id}` mag ook `ext:<externalId>` zijn) |
| PUT | `/api/v1/lots/by-external-id/{externalId}` | Aanmaken of bijwerken op ERP-nummer (veilig om te herhalen) |
| POST | `/api/v1/lots/{id}/withdraw` | Intrekken met `reasonCode` |
| GET | `/api/v1/lots/{id}/bids` | Biedingen op een eigen partij |
| GET | `/api/v1/reason-codes` | Redencodes |
| GET | `/api/v1/events?after=<id>` | Gebeurtenissen ophalen (alternatief voor de webhook) |

Voorbeeld:

```
curl -X PUT https://<jouw-site>/api/v1/lots/by-external-id/BC-1001 \
  -H "X-API-Key: fs_live_..." -H "Content-Type: application/json" \
  -d '{"product":"Elstar","category":"fruit","quantity":240,"unit":"case","price":{"amount":6.5,"currency":"EUR"},"availableUntil":"2026-11-15"}'
```

Testen zonder ERP: open `https://<jouw-site>/api-tester.html` (ook via Mijn account → API-koppelingen → API-tester openen), plak een sleutel en bied partijen aan, haal biedingen en berichten op en bekijk de gesimuleerde orders.

De volledige specificatie staat in `public/openapi.yaml` (OpenAPI 3.1), na publicatie te openen op `https://<jouw-site>/openapi.yaml`.

Limiet: 120 verzoeken per minuut per sleutel (daarboven 429 met `Retry-After`). Fouten: `{"error": {"code", "message", "field"}}`.
Elke wijziging via de API staat in het logboek, met de eerste tekens van de sleutel.

## Beveiliging in het kort
- **Codes:** minstens 12 tekens, met scrypt gehasht opgeslagen. Wie nog een kortere code heeft, of een code die de beheerder heeft ingesteld, moet bij het inloggen eerst zelf een nieuwe kiezen.
- **Sessie:** in een HttpOnly-, Secure- en SameSite=Strict-cookie. JavaScript kan hem niet lezen. Een sessie verloopt na 30 dagen of bij uitloggen. Wijzigingen worden alleen geaccepteerd vanaf de eigen website (Origin-controle).
- **Raden van codes:** na 5 foute codes is een account 15 minuten geblokkeerd. Na 30 mislukte pogingen vanaf één netwerkadres is inloggen vanaf dat adres 15 minuten geblokkeerd. Aanvragen: maximaal 5 per uur per adres.
- **Autorisatie:** elke beheerroute controleert op de server of je beheerder bent. Een handelaar kan alleen zijn eigen partijen en biedingen schrijven.
- **Gunnen en bieden:** de server rekent zelf. Bij een gunning haalt hij prijs en hoeveelheid uit het echte bod, rekent hij de resthoeveelheid uit en weigert hij meer dan er is. Een gunning kan niet worden gewist of gewijzigd. Op een ingetrokken, verkochte of verlopen partij kun je niet bieden. Op je eigen partij ook niet.
- **Gelijktijdige wijzigingen:** elk document heeft een versienummer en wordt alleen opgeslagen op de versie die gelezen is. Bij een conflict haalt de app de nieuwe versie op en voert de wijziging opnieuw uit.
- **Wie ziet wat:** handelaren zien van andere partijen alleen het hoogste bod en het aantal biedingen, niet wie wat bood of aan wie tegen welke prijs gegund is. Een verkoper ziet alle biedingen op zijn eigen partijen. Een koper ziet zijn eigen gunning. De beheerder ziet alles.
- **Foto's:** de server controleert of het echt een JPEG of WebP is. Je kunt alleen je eigen foto's gebruiken of verwijderen. Losse foto's die nergens meer bij horen, worden na 6 uur opgeruimd.
- **Betalingen:** de status komt altijd van Mollie zelf, nooit van de browser of de webhookmelding.
- Een gedeactiveerde gebruiker of een gebruiker met een nieuwe code wordt direct uitgelogd.
- **API-sleutels:** alleen een SHA-256-afdruk wordt bewaard. Een sleutel werkt alleen in zijn eigen omgeving (`fs_live_` of `fs_test_`) en direct niet meer na intrekken, deactiveren of het uitzetten van de API. De API accepteert geen sessiecookie, dus een andere website kan niet namens een ingelogde gebruiker iets doen.
- **Webhooks:** alleen `https` op poort 443 of 8443, geen interne netwerkadressen (ook niet via DNS of een adres dat later verandert: de server controleert het IP-adres bij het verbinden) en geen doorverwijzingen.

## Problemen
| Melding | Oplossing |
| --- | --- |
| "Database niet bereikbaar" | Controleer `DATABASE_URL` en lees de functielog in Netlify (Functions → api). |
| "...(certificaat: zie PG_SSL_CA / PG_SSL_INSECURE)" | Zet `PG_SSL_INSECURE` op `true` of plak het CA-certificaat in `PG_SSL_CA`, en deploy opnieuw. |
| "RPB_SETUP_CODE ontbreekt in Netlify" | Voeg de variabele toe en deploy opnieuw. |
| "Page not found" op `/api/status` | `netlify/functions/api.mjs` of `package.json` ontbreekt op GitHub. |
| Beheerder kwijt / code vergeten | Een andere beheerder stelt een nieuwe code in. Is er geen andere beheerder, vraag dan om hulp: dat moet in de database. |
