import { z } from "zod";

/**
 * Rule library Zod shapes.
 *
 * The DB table `rule_library_chunks` stores narration guidance keyed by
 * (category, axis, value_key). This file is the type-level contract for
 * both the indexer (reading YAML → validating → upserting) and the
 * getters (reading DB → returning typed slices to Block 1 assembly).
 *
 * Categories are v3-derived; v4 expanded DNA (11 → 24) + composition
 * (3 → 13) so the content inside each category grows significantly, but
 * the taxonomy itself matches v3.
 */

export const RuleLibraryCategory = z.enum([
  "dna", // tonal axis × value (heroism: 7, grit: 4, ...)
  "composition", // framing axis × enum (tension_source: existential, ...)
  "power_tier", // T1 – T10 narration guidance
  "archetype", // ensemble archetype — struggler / heart / rival / ...
  "scale", // v3-style narrative scales (kept for compatibility with v3 content)
  "ceremony", // tier-progression ceremony text (scaffold; content later)
  "genre", // shonen / seinen / noir / isekai / ...
  "tension", // v3 tension presets
  "op_expression", // OP-dominant narration techniques
  "beat_craft", // arc-phase writing guidance (Phase 7)
]);
export type RuleLibraryCategory = z.infer<typeof RuleLibraryCategory>;

/**
 * A single rule-library entry as stored in DB + authored in YAML. All
 * fields are 1:1 with the `rule_library_chunks` row shape; `id`,
 * `createdAt`, `updatedAt`, `version` are DB-managed and optional in
 * the YAML side (indexer fills / bumps them).
 */
export const RuleLibraryChunk = z.object({
  id: z.string().uuid(),
  librarySlug: z.string().min(1),
  category: RuleLibraryCategory,
  axis: z.string().nullable(),
  valueKey: z.string().nullable(),
  tags: z.array(z.string()).default([]),
  retrieveConditions: z.record(z.string(), z.unknown()).default({}),
  content: z.string().min(1),
  version: z.number().int().min(1).default(1),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type RuleLibraryChunk = z.infer<typeof RuleLibraryChunk>;

/**
 * The YAML file shape the indexer reads — one file per (category, axis)
 * when axis applies, or per category for non-axis categories.
 *
 *     library_slug: dna_heroism
 *     category: dna
 *     axis: heroism
 *     entries:
 *       - value_key: "1"
 *         tags: [low_heroism, antihero]
 *         content: |
 *           Heroism at 1 means ... (directive prose)
 *       - value_key: "5"
 *         ...
 *
 * The indexer walks `rule_library/**\/*.yaml`, validates each file's
 * entries against `RuleLibraryYamlEntry`, then upserts to the DB.
 */
export const RuleLibraryYamlEntry = z.object({
  value_key: z.string().min(1).nullable(),
  tags: z.array(z.string()).default([]),
  retrieve_conditions: z.record(z.string(), z.unknown()).default({}),
  content: z.string().min(1),
});
export type RuleLibraryYamlEntry = z.infer<typeof RuleLibraryYamlEntry>;

export const RuleLibraryYamlFile = z.object({
  library_slug: z.string().min(1),
  category: RuleLibraryCategory,
  axis: z.string().nullable().default(null),
  entries: z.array(RuleLibraryYamlEntry).min(1),
});
export type RuleLibraryYamlFile = z.infer<typeof RuleLibraryYamlFile>;
