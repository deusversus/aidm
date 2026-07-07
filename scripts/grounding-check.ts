/**
 * Grounding-data validation CLI — the v5 successor to v4's rules:index
 * for the M0 surface. Loads and cross-validates the anchor + exemplar
 * libraries (refs, coverage, provenance) and prints the inventory. The
 * DB-indexing half of the old script (guidance chunks → embedded rows)
 * returns with the M1 canon/guidance RAG, where its reader lands.
 *
 * Run: pnpm grounding:check
 */
import { loadGrounding } from "@/lib/rules/grounding";

const lib = loadGrounding();

console.log(`anchors:   ${lib.anchors.length} axes`);
for (const a of lib.anchors) {
  const shows = Object.values(a.bands).reduce((n, b) => n + b.shows.length, 0);
  console.log(`  ${a.axis}: ${shows} witness shows, bands 1/5/9 pinned`);
}
console.log(`exemplars: ${lib.exemplars.length} passages`);
for (const e of lib.exemplars) {
  const words = e.text.split(/\s+/).length;
  console.log(`  ${e.id}: band ${e.band}, ${words} words, ${e.anchor_show}`);
}
console.log("\ngrounding: OK — all refs resolve, v0 coverage complete");
