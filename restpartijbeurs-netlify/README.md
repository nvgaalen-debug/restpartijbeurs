# Restpartijbeurs

Handelsplatform voor restpartijen aardappelen, groente en fruit. Draait op Netlify en
bewaart de gegevens in dezelfde Aiven-database als Vloeren Kassa, in eigen tabellen
(`rpb_users`, `rpb_sessions`, `rpb_docs`). De tabel `records` van de kassa wordt niet aangeraakt.

## Bestanden

| Bestand | Wat het is |
| --- | --- |
| `public/index.html` | De app zelf (één HTML-bestand) |
| `netlify/functions/api.mjs` | De serverfunctie op `/api/...`: inloggen, gebruikers, partijen en biedingen |
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

4. Ga naar **Deploys → Trigger deploy → Deploy site** en wacht tot hij op **Published** staat.

### 3. Eerste beheerder
1. Open het webadres van de site. Je ziet **Eerste beheerder**.
2. Vul `RPB_SETUP_CODE`, je naam, bedrijf, contact en een eigen code in.
3. Ga naar **Beheer** en maak voor elke handelaar een account aan. Geef de naam en code persoonlijk door.

Na de eerste beheerder werkt `RPB_SETUP_CODE` niet meer; je mag hem laten staan of verwijderen.

## Een update doorvoeren
Vervang het gewijzigde bestand op GitHub en kies **Commit changes**. Netlify bouwt zelf opnieuw.
Gegevens blijven staan; ingelogde gebruikers blijven ingelogd.

## Beveiliging in het kort
- Codes worden met scrypt gehasht opgeslagen; de database bevat geen leesbare codes.
- Elke wijziging wordt op de server gecontroleerd: een handelaar kan alleen zijn eigen partijen en biedingen schrijven.
- Na 5 foute codes is een account 2 minuten geblokkeerd. Een sessie verloopt na 30 dagen of bij uitloggen.
- Een gedeactiveerde gebruiker of een gebruiker met een nieuwe code wordt direct uitgelogd.
- Alle ingelogde gebruikers zien alle partijen en biedingen, inclusief bedrijfsnamen en contactgegevens.

## Problemen
| Melding | Oplossing |
| --- | --- |
| "Database niet bereikbaar" | Controleer `DATABASE_URL` en lees de functielog in Netlify (Functions → api). |
| "...(certificaat: zie PG_SSL_CA / PG_SSL_INSECURE)" | Zet `PG_SSL_INSECURE` op `true` of plak het CA-certificaat in `PG_SSL_CA`, en deploy opnieuw. |
| "RPB_SETUP_CODE ontbreekt in Netlify" | Voeg de variabele toe en deploy opnieuw. |
| "Page not found" op `/api/status` | `netlify/functions/api.mjs` of `package.json` ontbreekt op GitHub. |
| Beheerder kwijt / code vergeten | Een andere beheerder stelt een nieuwe code in. Is er geen andere beheerder, vraag dan om hulp: dat moet in de database. |
