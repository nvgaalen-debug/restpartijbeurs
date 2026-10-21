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
| `public/js/admin.js` | Beheer: dashboard, gebruikers, redencodes, betalingen, logboek, instellingen |
| `public/js/payments.js` | Abonnement online betalen (Mollie) |
| `public/js/stats.js` | Beheer: statistieken |
| `public/js/integrations.js` | Mijn account → API-koppelingen: sleutels en webhook |
| `public/api-tester.html`, `public/js/api-tester.js` | API-tester (ERP-simulator) op `/api-tester.html`: partijen aanbieden via de API, berichten en orders bekijken |
| `public/openapi.yaml` | Technische beschrijving van de API (OpenAPI 3.1) |
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
| `RPB_SETUP_CODE` | Een zelfbedachte code van minstens 16 tekens. Alleen nodig om de eerste beheerder aan te maken. |
| `MOLLIE_API_KEY` | Optioneel. De API-sleutel uit je Mollie-dashboard (`test_...` om te testen, `live_...` voor echte betalingen). Markeer als secret. Zonder deze sleutel registreert de beheerder betalingen handmatig. |
| `APP_ENV` | Alleen in de testomgeving: `test`. Toont een oranje balk "TESTOMGEVING". |
| `PG_MIGRATE_FROM` | Eenmalig, alleen bij Production: `public`. Verplaatst de bestaande Restpartijbeurs-tabellen naar het schema van `PG_SCHEMA`. Na één keer openen van de app weer weghalen. Werkt nooit in de testomgeving. |
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

Na de eerste beheerder werkt `RPB_SETUP_CODE` niet meer; je mag hem laten staan of verwijderen.

## Een update doorvoeren

Upload altijd **alle gewijzigde bestanden in één keer**. De bestanden in `public/` en `netlify/functions/api.mjs` horen bij elkaar; een half bijgewerkte app werkt niet goed. Met GitHub Desktop gaat dat in één commit.

Vervang het gewijzigde bestand op GitHub en kies **Commit changes**. Netlify bouwt zelf opnieuw.
Gegevens blijven staan; ingelogde gebruikers blijven ingelogd.

## FoodSource API v1 (koppelingen)

Elk ERP- of voorraadsysteem koppelt via dezelfde API op `/api/v1`. Zo werkt het:

1. Beheerder: zet onder **Website-instellingen → Koppelingen** de API aan. Uitzetten blokkeert alle sleutels direct.
2. Handelaar: maakt onder **Mijn account → API-koppelingen** een sleutel (`fs_live_…`, in de testomgeving `fs_test_…`) met alleen de rechten die nodig zijn: `lots:read`, `lots:write`, `bids:read`. De sleutel is één keer zichtbaar.
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
  -H "Authorization: Bearer fs_live_..." -H "Content-Type: application/json" \
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
