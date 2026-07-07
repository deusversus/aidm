import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "@/lib/db";
import { canonChunks, profiles } from "@/lib/db/schema";
import type { DNAScales } from "@/lib/types/dna";
import { Profile } from "@/lib/types/profile";
import { count, eq } from "drizzle-orm";
import jsYaml from "js-yaml";
import type { Suite, SuiteResult } from "../types";

/**
 * §10.7 (partial) — golden-profile regression: the persisted research
 * output for Cowboy Bebop against the hand-scored golden fixture
 * (evals/golden/profiles/cowboy_bebop.yaml, scored by the user). Reads the
 * DB; makes no model calls — run `pnpm research "Cowboy Bebop"` first.
 * DNA spot-checks use a ±2 tolerance: research is a judgment, the golden
 * is a judgment; the regression catches drift, not disagreement at the
 * margin.
 */

const SPOT_AXES: (keyof DNAScales)[] = ["darkness", "comedy", "moral_complexity", "empathy"];
const TOLERANCE = 2;

export const goldenProfile: Suite = {
  name: "golden-profile",
  gate: "M1 C2 (§10.7 partial; full golden turns land C10)",
  requiresLlm: false,
  async run(): Promise<SuiteResult> {
    const details: string[] = [];
    const failures: string[] = [];

    if (!process.env.DATABASE_URL) {
      return {
        name: this.name,
        gate: this.gate,
        status: "skipped",
        details: ["DATABASE_URL not set"],
        failures: [],
      };
    }

    // Both goldens: Bebop (stat_mapping false) AND Solo Leveling (true) —
    // together the stat check is falsifiable in both directions (C2 audit).
    const fixtures = [
      { id: "cowboy_bebop", cmd: 'pnpm research "Cowboy Bebop"' },
      { id: "solo_leveling", cmd: 'pnpm research "Solo Leveling"' },
    ];
    let anyRun = false;

    for (const fixture of fixtures) {
      const [row] = await getDb().select().from(profiles).where(eq(profiles.id, fixture.id));
      if (!row) {
        details.push(`${fixture.id}: no researched profile — run \`${fixture.cmd}\``);
        continue;
      }
      anyRun = true;

      const parsed = Profile.safeParse(row.profile);
      if (!parsed.success) {
        failures.push(
          `${fixture.id}: persisted profile fails the Profile contract: ${parsed.error.issues[0]?.message}`,
        );
        continue;
      }
      const researched = parsed.data;
      const golden = jsYaml.load(
        readFileSync(
          join(process.cwd(), "evals", "golden", "profiles", `${fixture.id}.yaml`),
          "utf8",
        ),
      ) as {
        canonical_dna: DNAScales;
        ip_mechanics: { combat_style: string; stat_mapping: { has_canonical_stats: boolean } };
      };

      if (researched.ip_mechanics.combat_style !== golden.ip_mechanics.combat_style) {
        failures.push(
          `${fixture.id}: combat_style researched ${researched.ip_mechanics.combat_style} vs golden ${golden.ip_mechanics.combat_style}`,
        );
      }
      if (
        researched.ip_mechanics.stat_mapping.has_canonical_stats !==
        golden.ip_mechanics.stat_mapping.has_canonical_stats
      ) {
        failures.push(
          `${fixture.id}: has_canonical_stats researched ${researched.ip_mechanics.stat_mapping.has_canonical_stats} vs golden ${golden.ip_mechanics.stat_mapping.has_canonical_stats}`,
        );
      }
      for (const axis of SPOT_AXES) {
        const r = researched.canonical_dna[axis];
        const g = golden.canonical_dna[axis];
        const delta = Math.abs(r - g);
        // Δ2 is the §4.5 drift band's own correction threshold — passes,
        // but loudly (borderline drift stays visible in eval output).
        details.push(
          `${fixture.id}/${axis}: researched ${r} vs golden ${g} (Δ${delta})${delta === TOLERANCE ? " ⚠ at tolerance edge" : ""}`,
        );
        if (delta > TOLERANCE) {
          failures.push(
            `${fixture.id}/${axis}: |${r} − ${g}| > ${TOLERANCE} — research drifted from the golden read`,
          );
        }
      }
      const [chunkCount] = await getDb()
        .select({ n: count() })
        .from(canonChunks)
        .where(eq(canonChunks.profileId, fixture.id));
      details.push(`${fixture.id}: canon chunks ${chunkCount?.n ?? 0}`);
      if ((chunkCount?.n ?? 0) === 0) {
        failures.push(
          `${fixture.id}: canon corpus is empty — the Canon layer writer produced nothing`,
        );
      }
    }

    if (!anyRun) {
      return { name: this.name, gate: this.gate, status: "skipped", details, failures: [] };
    }
    return {
      name: this.name,
      gate: this.gate,
      status: failures.length === 0 ? "pass" : "fail",
      details,
      failures,
    };
  },
};
