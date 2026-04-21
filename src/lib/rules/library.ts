import type { Db } from "@/lib/db";
import { npcs, ruleLibraryChunks } from "@/lib/state/schema";
import type { Composition } from "@/lib/types/composition";
import type { DNAScales } from "@/lib/types/dna";
import type { Profile } from "@/lib/types/profile";
import { and, eq, inArray, sql } from "drizzle-orm";

/**
 * Rule library getters — deterministic lookups keyed on (category, axis,
 * value_key). The content lives in `rule_library_chunks` (populated by
 * `pnpm rules:index` from `rule_library/**\/*.yaml`).
 *
 * At session start, `assembleSessionRuleLibraryGuidance` pulls the
 * campaign-relevant subset (24 DNA + 13 composition + character tier +
 * in-play archetypes) and concatenates a prose bundle KA reads in
 * Block 1 under "Rule-library guidance for this session". Block 1 is
 * cached across the session, so the bundle is computed once per turn
 * (cheap — four small DB queries) and will move to session-cache
 * (campaign.settings.session_cache) in Phase 7 polish.
 *
 * Without this layer, `heroism: 7` renders as a bare number in Block 1
 * with no attached "what 7 means in narrative practice" — KA falls back
 * to base-training intuition for the axes, which drifts toward generic
 * anime prose over hundreds of turns. With it, every axis carries a
 * prescriptive directive.
 */

// ---------------------------------------------------------------------------
// Primitive getters — single (category, axis, value) lookup.
// ---------------------------------------------------------------------------

async function lookupContent(
  db: Db,
  category: string,
  axis: string | null,
  valueKey: string,
): Promise<string | null> {
  const [row] = await db
    .select({ content: ruleLibraryChunks.content })
    .from(ruleLibraryChunks)
    .where(
      and(
        eq(ruleLibraryChunks.category, category),
        axis === null ? sql`${ruleLibraryChunks.axis} IS NULL` : eq(ruleLibraryChunks.axis, axis),
        eq(ruleLibraryChunks.valueKey, valueKey),
      ),
    )
    .limit(1);
  return row?.content ?? null;
}

export async function getDnaGuidance(
  db: Db,
  axis: keyof DNAScales,
  value: number,
): Promise<string | null> {
  // Content is authored at 1 / 5 / 10; snap to the nearest of those.
  // v3-parity: stepped directives let three points cover the range
  // without needing to author every integer. Callers' actual DNA
  // value is still narrated faithfully in Block 1; the guidance is
  // interpretive.
  const snap = value <= 2 ? "1" : value >= 8 ? "10" : "5";
  return lookupContent(db, "dna", axis, snap);
}

export async function getCompositionGuidance(
  db: Db,
  axis: keyof Composition,
  valueKey: string,
): Promise<string | null> {
  return lookupContent(db, "composition", axis, valueKey);
}

export async function getPowerTierGuidance(db: Db, tier: string): Promise<string | null> {
  return lookupContent(db, "power_tier", null, tier);
}

export async function getArchetypeGuidance(db: Db, archetype: string): Promise<string | null> {
  return lookupContent(db, "archetype", null, archetype);
}

// ---------------------------------------------------------------------------
// Session-level bundle assembly.
// ---------------------------------------------------------------------------

interface SessionBundleInput {
  profile: Profile;
  activeDna?: DNAScales;
  activeComposition?: Composition;
  characterPowerTier?: string | null;
  campaignId: string;
}

/**
 * Pull all rule-library chunks relevant to THIS session in four batched
 * queries (one per category: dna, composition, power_tier, archetype),
 * then assemble a Markdown bundle KA reads at session start. Missing
 * content degrades gracefully — an axis with no chunk for its current
 * value simply omits that axis's line. The bundle never errors.
 */
export async function assembleSessionRuleLibraryGuidance(
  db: Db,
  input: SessionBundleInput,
): Promise<string> {
  const activeDna = input.activeDna ?? input.profile.canonical_dna;
  const activeComposition = input.activeComposition ?? input.profile.canonical_composition;

  // --- DNA section ---
  const dnaAxes = Object.keys(activeDna) as Array<keyof DNAScales>;
  const dnaLookups = dnaAxes.map((axis) => {
    const value = activeDna[axis];
    const snap = value <= 2 ? "1" : value >= 8 ? "10" : "5";
    return { axis: axis as string, valueKey: snap };
  });
  const dnaRows = await fetchBatch(db, "dna", dnaLookups);
  const dnaSection = renderSection(
    "DNA axes — tonal pressures for this campaign",
    dnaAxes.map((axis) => {
      const valueKey = dnaLookups.find((l) => l.axis === axis)?.valueKey ?? "5";
      const row = dnaRows.find((r) => r.axis === axis && r.valueKey === valueKey);
      if (!row) return null;
      return {
        key: `${axis} = ${activeDna[axis]}`,
        content: row.content,
      };
    }),
  );

  // --- Composition section ---
  const compositionAxes = Object.keys(activeComposition) as Array<keyof Composition>;
  const compositionLookups = compositionAxes.map((axis) => ({
    axis: axis as string,
    valueKey: String(activeComposition[axis]),
  }));
  const compositionRows = await fetchBatch(db, "composition", compositionLookups);
  const compositionSection = renderSection(
    "Composition — narrative framing for this campaign",
    compositionAxes.map((axis) => {
      const valueKey = String(activeComposition[axis]);
      const row = compositionRows.find((r) => r.axis === axis && r.valueKey === valueKey);
      if (!row) return null;
      return {
        key: `${axis}: ${valueKey}`,
        content: row.content,
      };
    }),
  );

  // --- Power tier section (character + in-play NPCs for context) ---
  const tierKeys = new Set<string>();
  if (input.characterPowerTier) tierKeys.add(input.characterPowerTier);
  const npcTiers = await db
    .select({ powerTier: npcs.powerTier })
    .from(npcs)
    .where(eq(npcs.campaignId, input.campaignId))
    .limit(100);
  for (const r of npcTiers) {
    if (r.powerTier) tierKeys.add(r.powerTier);
  }
  const tierRows =
    tierKeys.size === 0
      ? []
      : await db
          .select({
            valueKey: ruleLibraryChunks.valueKey,
            content: ruleLibraryChunks.content,
          })
          .from(ruleLibraryChunks)
          .where(
            and(
              eq(ruleLibraryChunks.category, "power_tier"),
              inArray(ruleLibraryChunks.valueKey, [...tierKeys]),
            ),
          )
          .limit(50);
  const tierSection = renderSection(
    "Power tiers in play",
    [...tierKeys].map((tier) => {
      const row = tierRows.find((r) => r.valueKey === tier);
      if (!row) return null;
      return { key: tier, content: row.content };
    }),
  );

  // --- Ensemble archetypes section (from NPC catalog, if any) ---
  const archetypes = new Set<string>();
  const npcArchetypeRows = await db
    .select({ ensembleArchetype: npcs.ensembleArchetype })
    .from(npcs)
    .where(eq(npcs.campaignId, input.campaignId))
    .limit(100);
  for (const r of npcArchetypeRows) {
    if (r.ensembleArchetype) archetypes.add(r.ensembleArchetype);
  }
  const archetypeRows =
    archetypes.size === 0
      ? []
      : await db
          .select({
            valueKey: ruleLibraryChunks.valueKey,
            content: ruleLibraryChunks.content,
          })
          .from(ruleLibraryChunks)
          .where(
            and(
              eq(ruleLibraryChunks.category, "archetype"),
              inArray(ruleLibraryChunks.valueKey, [...archetypes]),
            ),
          )
          .limit(50);
  const archetypeSection = renderSection(
    "Ensemble archetypes in play",
    [...archetypes].map((arch) => {
      const row = archetypeRows.find((r) => r.valueKey === arch);
      if (!row) return null;
      return { key: arch, content: row.content };
    }),
  );

  const sections = [dnaSection, compositionSection, tierSection, archetypeSection].filter(
    (s) => s.length > 0,
  );
  return sections.join("\n\n---\n\n");
}

async function fetchBatch(
  db: Db,
  category: string,
  lookups: Array<{ axis: string; valueKey: string }>,
): Promise<Array<{ axis: string | null; valueKey: string | null; content: string }>> {
  if (lookups.length === 0) return [];
  const axes = [...new Set(lookups.map((l) => l.axis))];
  const values = [...new Set(lookups.map((l) => l.valueKey))];
  // Bounded at 500 — max 24 axes × ~10 values + slack; real queries are
  // always well under. The explicit limit also keeps test fake-DBs simple
  // (they only need to implement the chain through .limit()).
  return db
    .select({
      axis: ruleLibraryChunks.axis,
      valueKey: ruleLibraryChunks.valueKey,
      content: ruleLibraryChunks.content,
    })
    .from(ruleLibraryChunks)
    .where(
      and(
        eq(ruleLibraryChunks.category, category),
        inArray(ruleLibraryChunks.axis, axes),
        inArray(ruleLibraryChunks.valueKey, values),
      ),
    )
    .limit(500);
}

function renderSection(
  heading: string,
  entries: Array<{ key: string; content: string } | null>,
): string {
  const live = entries.filter((e): e is { key: string; content: string } => e !== null);
  if (live.length === 0) return "";
  const body = live.map((e) => `**${e.key}**\n${e.content.trim()}`).join("\n\n");
  return `### ${heading}\n\n${body}`;
}
