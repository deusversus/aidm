import { z } from "zod";
import { SakugaMode } from "./turn";

/**
 * The commit_scene sidecar (blueprint §5.7): the KA call streams free prose
 * to the play view, then delivers this typed payload as a MANDATORY
 * tool-use trailer in the same response. If the trailer is missing, a
 * probe-tier extraction call reconstructs it (fallback, logged).
 */

/**
 * Cast admission is an explicit act (§6.5): the sidecar is one of exactly
 * three catalog-minting authorities (with Director promotion and player
 * assertion). Background extraction from prose enriches existing entities
 * and never creates them.
 */
export const CastDeltaAction = z.enum(["admit_to_catalog", "dismiss", "spawn_transient"]);

export const SceneCastDelta = z.object({
  name: z.string().min(1),
  action: CastDeltaAction,
  note: z.string().optional(),
});
export type SceneCastDelta = z.infer<typeof SceneCastDelta>;

/**
 * Field docs are `.describe()` calls, not comments: z.toJSONSchema carries
 * them into the commit_scene tool schema — the KA's ONLY view of what each
 * field means (audit 2026-07-19: a bare schema left suggested_moves emission
 * to model whim, so the player's default_on chips almost never appeared).
 */
export const CommitScene = z.object({
  scene_cast_delta: z
    .array(SceneCastDelta)
    .default([])
    .describe(
      "Catalog changes this scene made. Admission is deliberate — most scenes admit no one.",
    ),
  decision_point: z
    .boolean()
    .describe(
      "True when the scene ends on a genuine fork presented to the player — presented and stopped, unresolved.",
    ),
  suggested_moves: z
    .array(z.string())
    .min(2)
    .max(3)
    .optional()
    .describe(
      "When decision_point is true: 2-3 short, premise-true next moves the player could take (imperative phrases). Rendered as dismissible chips, never in prose. Omit when decision_point is false.",
    ),
  intended_seed_mentions: z
    .array(z.string())
    .default([])
    .describe("Seed ids you deliberately wove into this scene."),
  sakuga_used: SakugaMode.optional().describe(
    "The sakuga sub-mode this scene actually used, when one was granted.",
  ),
  notable_beats: z
    .array(z.string())
    .min(1)
    .max(3)
    .describe("1-3 beats worth remembering — hints for the record, not prose."),
});

export type CommitScene = z.infer<typeof CommitScene>;
