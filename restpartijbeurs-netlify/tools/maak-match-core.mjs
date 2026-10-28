// Maakt public/js/match-core.js uit netlify/lib/match.mjs, zodat de app precies dezelfde matchscore rekent als de server.
// Gebruik: node tools/maak-match-core.mjs   (met --check: alleen controleren of de kopie nog klopt)
import fs from "node:fs";
const root = new URL("../", import.meta.url);
const src = fs.readFileSync(new URL("netlify/lib/match.mjs", root), "utf8");
const names = [...src.matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]);
const body = src.replace(/^export /gm, "").trim();
const out = `// NIET HIER BEWERKEN – gemaakt uit netlify/lib/match.mjs met: node tools/maak-match-core.mjs
// Matchscore voor vraag en aanbod; dezelfde regels als de server (meldingen).
const MatchCore = (() => {
${body.split("\n").map((l) => (l ? "  " + l : l)).join("\n")}
  return { ${names.join(", ")} };
})();
`;
const dest = new URL("public/js/match-core.js", root);
if (process.argv.includes("--check")) {
  const now = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : "";
  if (now !== out) { console.error("public/js/match-core.js is verouderd: draai node tools/maak-match-core.mjs"); process.exit(1); }
  console.log("match-core.js klopt");
} else { fs.writeFileSync(dest, out); console.log("geschreven:", names.join(", ")); }
