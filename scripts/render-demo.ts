// Render a sample carousel with placeholder branding to eval-results/render-demo/ (git-ignored) so a person can
// look at the output. No network access; placeholder text and colours only.  Usage: npm run render:demo
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderCarousel } from "@lbe/render";

const out = path.resolve(import.meta.dirname, "..", "eval-results", "render-demo");
await mkdir(out, { recursive: true });
const started = Date.now();
const { pngs, pdf } = await renderCarousel({
  theme: { brandName: "ActTrident", background: "#0b1f3a", foreground: "#ffffff", accent: "#3fb4ff" },
  footer: "[PLACEHOLDER] Follow for weekly security habits",
  slides: [
    { title: "Spotting a phishing email in 10 seconds", text: "[PLACEHOLDER] Three checks anyone on your team can do before clicking." },
    { title: "1. Check the sender", text: "[PLACEHOLDER] Does the address match the organisation it claims to be from?" },
    { title: "2. Pause on urgency", text: "[PLACEHOLDER] \"Act now or lose access\" is a pressure tactic. Slow down." },
    { title: "3. Report, don't delete", text: "[PLACEHOLDER] Reporting quickly and without blame helps everyone." },
  ],
});
for (const [i, png] of pngs.entries()) await writeFile(path.join(out, `slide-${i + 1}.png`), png);
await writeFile(path.join(out, "carousel.pdf"), pdf);
console.log(`Rendered ${pngs.length} slides + carousel.pdf (${Math.round(pdf.byteLength / 1024)} KB) in ${Date.now() - started} ms → ${path.relative(process.cwd(), out)}`);
