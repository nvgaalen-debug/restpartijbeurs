// Geplande functie: elke 5 minuten webhookberichten opnieuw proberen die eerder mislukten.
// Nieuwe berichten gaan meteen na de wijziging al de deur uit (zie api.mjs).
import { runWebhooks } from "./api.mjs";

export default async () => {
  try {
    const r = await runWebhooks(25);
    if (r.picked) console.log("webhooks", r);
  } catch (e) { console.error("webhooks", e); }
};

export const config = { schedule: "*/5 * * * *" };
