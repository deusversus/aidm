import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "@/lib/db";
import { canonChunks, profiles } from "@/lib/db/schema";
import {
  buildFieldSources,
  coverageGates,
  deriveTrust,
  mechanicsImplied,
} from "@/lib/research/trust";
import type { DNAScales } from "@/lib/types/dna";
import { Profile } from "@/lib/types/profile";
import { count, eq } from "drizzle-orm";
import jsYaml from "js-yaml";
import { loadFoundingDefect } from "../golden/founding-defect";
import type { Suite, SuiteResult } from "../types";

/**
 * §10.7 (partial) — golden-profile regression: the persisted research
 * output for Cowboy Bebop against the hand-scored golden fixture
 * (evals/golden/profiles/cowboy_bebop.yaml, scored by the user). Reads the
 * DB; makes no model calls — run `pnpm research "Cowboy Bebop"` first.
 * DNA spot-checks use a ±2 tolerance: research is a judgment, the golden
 * is a judgment; the regression catches drift, not disagreement at the
 * margin.
 *
 * M3R3 adds the COVERAGE case (below): the same hand-authored-fixture idiom
 * turned on the trust substrate instead of the DNA read — a thin fixture must
 * be judged defective, a rich one must pass clean. It is pure, so unlike the
 * persisted-profile half it measures on every run, CI included.
 */

const SPOT_AXES: (keyof DNAScales)[] = ["darkness", "comedy", "moral_complexity", "empathy"];
const TOLERANCE = 2;

/** What the coverage case reads out of a rich golden — the mechanics organs. */
interface GoldenMechanics {
  ip_mechanics: {
    power_system?: { name?: string } | null;
    stat_mapping: { has_canonical_stats: boolean };
    world_setting: { genre: string[] };
  };
}

/**
 * A rich research RUN's coverage envelope. The golden files describe the IP,
 * never the run that fetched it, so the run side is stated here: a full wiki
 * scrape, well past every floor. Deliberately explicit — the case asserts the
 * gates' verdict on a healthy shape, and a healthy shape has to be named.
 */
const RICH_RUN = { pagesFetched: 34, contentChars: 180_000, voiceQuoteCharacters: 3 };

/**
 * The coverage case (M3R3 verification). Falsifiable in both directions by
 * construction: Solo Leveling is the rich fixture on purpose — its genre trips
 * mechanicsImplied exactly like the hollow row's tags do, and it clears the
 * gates anyway because the research actually produced the power system and the
 * canonical stat mapping. A gate that only ever fires on thin profiles proves
 * nothing; this pair moves the verdict on coverage alone.
 */
function coverageCase(details: string[], failures: string[]): void {
  const hollow = loadFoundingDefect();
  const mech = hollow.ip_mechanics;
  const thinGates = coverageGates({
    mechanicsImplied: mechanicsImplied(mech.world_setting.genre, hollow.anilist_tags),
    powerSystemPresent: mech.power_system !== null,
    statsCanonical: mech.stat_mapping.has_canonical_stats,
    contentChars: 0,
    pagesFetched: hollow.research_provenance.pages_fetched,
  });
  const thin = deriveTrust({
    startYear: hollow.start_year,
    pagesFetched: hollow.research_provenance.pages_fetched,
    contentChars: 0,
    sourcesConsulted: ["anilist", hollow.research_provenance.wiki_base],
    powerSystemPresent: mech.power_system !== null,
    powerSystemFromPages: false,
    statsCanonical: mech.stat_mapping.has_canonical_stats,
    statConfidence: mech.stat_mapping.confidence,
    voiceQuoteCharacters: mech.voice_cards_with_quotes,
    mechanicsImplied: mechanicsImplied(mech.world_setting.genre, hollow.anilist_tags),
    method: "api_wiki",
    fieldSources: buildFieldSources({
      identityOrigin: "anilist",
      tonalSource: null,
      settingSource: null,
      statMappingSource: null,
      powerSystemSource: null,
      voiceSource: null,
    }),
    fieldPages: {},
    defects: thinGates.defects,
  });

  if (!thin.defective) {
    failures.push(
      `coverage/${hollow.id}: the hollow row reads NOT defective — the founding defect is back`,
    );
  }
  if (thin.derived_confidence > 25) {
    failures.push(
      `coverage/${hollow.id}: derived_confidence ${thin.derived_confidence} on ${hollow.research_provenance.pages_fetched} pages — the row asserted ${hollow.research_provenance.confidence} and the whole point is that the number is derived`,
    );
  }
  if (!(thin.coverage_gaps[0] ?? "").startsWith("DEFECT:")) {
    failures.push(`coverage/${hollow.id}: coverage_gaps does not lead with a DEFECT line`);
  }
  details.push(
    `coverage/${hollow.id}: derived ${thin.derived_confidence} (row asserted ${hollow.research_provenance.confidence}), defective ${thin.defective}, ${thin.coverage_gaps.length} gap(s)`,
  );

  const rich = jsYaml.load(
    readFileSync(join(process.cwd(), "evals", "golden", "profiles", "solo_leveling.yaml"), "utf8"),
  ) as GoldenMechanics;
  const richMech = rich.ip_mechanics;
  const richImplied = mechanicsImplied(richMech.world_setting.genre, []);
  const richGates = coverageGates({
    mechanicsImplied: richImplied,
    powerSystemPresent: !!richMech.power_system,
    statsCanonical: richMech.stat_mapping.has_canonical_stats,
    contentChars: RICH_RUN.contentChars,
    pagesFetched: RICH_RUN.pagesFetched,
  });
  const richTrust = deriveTrust({
    startYear: null,
    pagesFetched: RICH_RUN.pagesFetched,
    contentChars: RICH_RUN.contentChars,
    sourcesConsulted: ["anilist", "https://solo-leveling.fandom.com"],
    powerSystemPresent: !!richMech.power_system,
    powerSystemFromPages: true,
    statsCanonical: richMech.stat_mapping.has_canonical_stats,
    statConfidence: 98,
    voiceQuoteCharacters: RICH_RUN.voiceQuoteCharacters,
    mechanicsImplied: richImplied,
    method: "api_wiki",
    fieldSources: buildFieldSources({
      identityOrigin: "anilist",
      tonalSource: "wiki",
      settingSource: "wiki",
      statMappingSource: "wiki",
      powerSystemSource: "wiki",
      voiceSource: "wiki",
    }),
    fieldPages: {},
    defects: richGates.defects,
  });

  if (!richImplied) {
    failures.push(
      "coverage/solo_leveling: the rich fixture no longer trips mechanicsImplied — the pair stops being falsifiable",
    );
  }
  if (richTrust.defective) {
    failures.push(
      `coverage/solo_leveling: a fully-researched mechanics IP reads DEFECTIVE — ${richGates.defects.join("; ")}`,
    );
  }
  if (richTrust.derived_confidence < 75) {
    failures.push(
      `coverage/solo_leveling: derived_confidence ${richTrust.derived_confidence} on a rich scrape — the gates are punishing a healthy profile`,
    );
  }
  details.push(
    `coverage/solo_leveling: derived ${richTrust.derived_confidence}, defective ${richTrust.defective}, mechanics implied ${richImplied} and satisfied`,
  );
}

export const goldenProfile: Suite = {
  name: "golden-profile",
  gate: "M1 C2 (§10.7 partial; full golden turns land C10) + M3R3 coverage case",
  requiresLlm: false,
  async run(): Promise<SuiteResult> {
    const details: string[] = [];
    const failures: string[] = [];

    // Pure, DB-free, and FIRST: the coverage case is the half that can always
    // measure. The skip semantics below are untouched on purpose — a run with
    // no persisted profiles still reports `skipped`, because the DNA
    // regression genuinely measured nothing and a passing coverage case must
    // not paper over that. A coverage FAILURE still fails the suite outright.
    coverageCase(details, failures);

    if (!process.env.DATABASE_URL) {
      details.push("DATABASE_URL not set — the persisted-profile regression did not run");
      return {
        name: this.name,
        gate: this.gate,
        status: failures.length > 0 ? "fail" : "skipped",
        details,
        failures,
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
      return {
        name: this.name,
        gate: this.gate,
        status: failures.length > 0 ? "fail" : "skipped",
        details,
        failures,
      };
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
