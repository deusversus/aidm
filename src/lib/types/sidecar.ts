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

export const CommitScene = z.object({
  scene_cast_delta: z.array(SceneCastDelta).default([]),
  /** Genuine decision point — present and stop (§5.1); chips may render (§9.2). */
  decision_point: z.boolean(),
  /** 2–3 suggested moves, rendered as dismissible chips, never in prose (§9.2). */
  suggested_moves: z.array(z.string()).min(2).max(3).optional(),
  /** Declared seed mentions — path 1 of two-path detection (§7.6). */
  intended_seed_mentions: z.array(z.string()).default([]),
  sakuga_used: SakugaMode.optional(),
  /** 1–3 Compositor hints (§5.7). */
  notable_beats: z.array(z.string()).min(1).max(3),
});

export type CommitScene = z.infer<typeof CommitScene>;
