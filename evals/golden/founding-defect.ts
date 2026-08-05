import { readFileSync } from "node:fs";
import { join } from "node:path";
import jsYaml from "js-yaml";

/**
 * The captured founding-defect row, loaded once (M3R3 verification). Two
 * readers — the golden suite's coverage case and the thin-IP drill — because
 * a fixture copied into both would become two slightly different memories of
 * the same broken row, and the whole point is that this row's shape is fixed.
 */

export interface FoundingDefectRow {
  id: string;
  title: string;
  anilist_id: number;
  start_year: number;
  research_provenance: {
    confidence: number;
    pages_fetched: number;
    wiki_base: string;
    notes: string;
  };
  anilist_genres: string[];
  anilist_tags: string[];
  ip_mechanics: {
    power_system: Record<string, unknown> | null;
    stat_mapping: { has_canonical_stats: boolean; confidence: number };
    world_setting: { genre: string[] };
    voice_cards_with_quotes: number;
  };
}

export function loadFoundingDefect(): FoundingDefectRow {
  return jsYaml.load(
    readFileSync(
      join(process.cwd(), "evals", "golden", "profiles", "exiled_heavy_knight_hollow.yaml"),
      "utf8",
    ),
  ) as FoundingDefectRow;
}
