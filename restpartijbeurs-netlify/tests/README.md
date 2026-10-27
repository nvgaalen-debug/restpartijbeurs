# Rooktest na elke release

Een automatische controle van de echte site, na elke nieuwe versie. Duurt ongeveer 1 minuut (plus installeren in GitHub).

**Voorlopig test de GitHub-workflow alleen de testomgeving.** De test zelf kan ook productie controleren (alleen kijken); dat zetten we aan zodra productie live is.

| Omgeving | Wat de test doet |
|---|---|
| **Test** (`APP_ENV=test`) | Alles hieronder, plus een volledige handel: aanbieder zet een partij met foto online, koper bekijkt de foto en biedt, aanbieder gunt, koper ziet de gunning, aanbieder trekt de rest in. Daarna vraag en aanbod: koper plaatst een vraag, aanbieder reageert op de telefoon met "Ik kan leveren", koper ziet de reactie en sluit de vraag, aanbieder trekt de partij in. Optioneel ook de AI-invulhulp. |
| **Productie** | Alleen kijken: site en beveiliging, versie, inlogscherm, inloggen als koper, aanbod op computer en telefoon (grote foto laadt), API. **Er wordt niets aangemaakt of gewijzigd.** |

De test leest zelf uit de site welke omgeving het is; de volledige handel draait nooit op productie.

## Eenmalig instellen

### 1. Testaccounts
In de **testomgeving** (Beheer → Gebruikers → Nieuwe gebruiker):
- een aanbieder, bijv. naam `Rooktest Aanbieder`;
- een koper, bijv. naam `Rooktest Koper`.

Zet bij allebei via **Acties → Geen abonnement nodig** het abonnement uit, en log met elk account **één keer met de hand in** om een eigen code te kiezen (de test kan dat niet).

Later, voor productie: alleen een koper-account (alleen kijken), ook vrijgesteld en één keer zelf ingelogd.

Optioneel: maak als de koper onder **Mijn account → API-koppelingen** een sleutel met alleen het recht *Partijen lezen*; dan test de rooktest ook de API met sleutel.

### 2. GitHub
1. Zet `rooktest.yml` (zit apart bij de levering) in de repository op **`.github/workflows/rooktest.yml`**, in de hoofdmap naast `restpartijbeurs-netlify`.
   Makkelijkst via de website: repository → **Actions** → *set up a workflow yourself* → plak de inhoud → bestandsnaam `rooktest.yml` → **Commit changes**.
2. Repository → **Settings → Secrets and variables → Actions**:
   - tab **Variables**: `SMOKE_URL_TEST` (bijv. `https://restpartijbeurs.netlify.app`);
   - tab **Secrets**: `TEST_SELLER`, `TEST_SELLER_CODE`, `TEST_BUYER`, `TEST_BUYER_CODE`, en optioneel `TEST_API_KEY`.
   Codes en sleutels zet u alleen hier (versleuteld), nooit in een bestand.

## Gebruik
- **Na elke upload naar GitHub** start de test vanzelf: hij wacht tot de testomgeving de nieuwe versie toont (maximaal 12 minuten) en test die volledig.
- **Met de hand**: Actions → **Rooktest na release** → **Run workflow** (vinkje voor de AI-test als u die ook wilt).
- **Elke ochtend** om 05:17 UTC (06:17 wintertijd, 07:17 zomertijd) test hij de testomgeving volledig, inclusief een rooktest-partij die meteen weer wordt ingetrokken.
- Groen vinkje = in orde. Rood kruis = klik erop; onder *Artifacts* staat **rooktest-rapport** met schermafbeeldingen van wat misging. GitHub stuurt u bij een fout ook een e-mail.

## Zelf draaien op de computer (optioneel)
Nodig: Node.js 20 of nieuwer.
```
cd tests
npm install
npx playwright install chromium
set SMOKE_URL=https://restpartijbeurs.netlify.app      (Mac/Linux: export SMOKE_URL=...)
set TEST_BUYER=Rooktest Koper
set TEST_BUYER_CODE=...
npx playwright test
npx playwright show-report
```
