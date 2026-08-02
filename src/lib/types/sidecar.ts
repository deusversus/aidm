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
 *
 * COUNTS ARE NOT SCHEMA BOUNDS (diagnosed live 2026-08-01). The structured-
 * output grammar carries types and enums; it STRIPS length constraints —
 * `.min()`/`.max()` on strings and arrays validate client-side only. A trailer
 * one move over the cap therefore satisfies the grammar the KA writes against,
 * fails the zod parse, and reads downstream as "no trailer at all" — burning
 * the continuation round and the probe fallback, and, at worst, filing the
 * scene with a reconstructed record instead of the writer's own. The ceilings
 * are real and they stay: they live in the `.describe()` text the KA reads and
 * in `clampCommitScene` below. A decoration must never destroy its host.
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
    .describe("1-3 beats worth remembering — hints for the record, not prose."),
});

export type CommitScene = z.infer<typeof CommitScene>;

/** The §5.7 emission ceilings, enforced in code (see the contract note above). */
export const SUGGESTED_MOVES_MAX = 3;
export const NOTABLE_BEATS_MAX = 3;

/**
 * Normalize a parsed trailer to its emission ceilings. Over-count lists are
 * sliced, blanks dropped, and the clamp is logged — the scene is never lost
 * over one surplus entry.
 *
 * Under-count is NOT an error and is NOT repaired: a one-move suggested_moves
 * cannot be sliced into existence, and the chips are optional decoration — the
 * play view and the suggestions route both gate on `length >= 2` and render
 * nothing below it. An empty notable_beats likewise passes through; it is a
 * hint for the record, and nothing downstream requires one.
 *
 * Every trailer path funnels here: the native tool_use and the continuation
 * round via `extractCommitScene`, the probe reconstruction in ka.ts.
 */
export function clampCommitScene(
  scene: CommitScene,
  ctx: { source?: string; campaignId?: string; turnNumber?: number } = {},
): CommitScene {
  const tidy = (xs: string[]) => xs.map((s) => s.trim()).filter((s) => s.length > 0);
  const over: string[] = [];

  const beats = tidy(scene.notable_beats);
  if (beats.length > NOTABLE_BEATS_MAX) over.push(`notable_beats=${beats.length}`);

  const rawMoves = scene.suggested_moves === undefined ? undefined : tidy(scene.suggested_moves);
  if (rawMoves && rawMoves.length > SUGGESTED_MOVES_MAX) {
    over.push(`suggested_moves=${rawMoves.length}`);
  }

  if (over.length > 0) {
    console.warn("[sidecar] commit_scene over its emission ceiling — clamped, scene kept", {
      ...ctx,
      over,
    });
  }

  const moves = rawMoves?.slice(0, SUGGESTED_MOVES_MAX);
  const base: CommitScene = { ...scene, notable_beats: beats.slice(0, NOTABLE_BEATS_MAX) };
  if (moves === undefined || moves.length === 0) {
    Reflect.deleteProperty(base, "suggested_moves");
    return base;
  }
  return { ...base, suggested_moves: moves };
}
