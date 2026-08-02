import { z } from "zod";

/**
 * The meta booth (blueprint §5.4, C9): out-of-fiction conversation between
 * the player and the studio, BUDGETED. A probe-tier router sends each
 * message to ONE responder — craft/direction → the Director, prose/voice →
 * the KA — never both; the other persona can be explicitly summoned. Capped
 * at BOOTH_EXCHANGE_CAP exchanges, then the responder must emit a resolution
 * summary and the booth closes. Outcomes write typed pencil marks (writer
 * #4, provenance "meta_booth") and/or overrides.
 *
 * Booth text is out-of-fiction: it NEVER enters episodic records, Block 3,
 * or compaction (channel-status turns stay outside the story window).
 *
 * Both responders speak through streamNarration (narration tier): booth text
 * is player-facing conversation (axiom 2), and §5.4's cache mandate — "reuse
 * the narration prompt's cached blocks 1–3 prefix" — is only satisfiable on
 * the narration model (the prompt cache is per-model). The personas differ
 * by a framing MESSAGE, never by mutating the cached system prefix.
 */

/** Player exchanges before the responder must resolve and close (§5.4). */
export const BOOTH_EXCHANGE_CAP = 12;

export const BoothResponder = z.enum(["director", "ka"]);
export type BoothResponder = z.infer<typeof BoothResponder>;

export const BoothExchange = z.object({
  role: z.enum(["player", "studio"]),
  text: z.string(),
  /** Which persona answered (studio rows only). */
  responder: BoothResponder.optional(),
  at_turn: z.number().int().nonnegative(),
});
export type BoothExchange = z.infer<typeof BoothExchange>;

/** campaigns.booth_state — the durable cross-turn conversation. */
export const BoothState = z.object({
  exchanges: z.array(BoothExchange).default([]),
  opened_at_turn: z.number().int().nonnegative().default(0),
});
export type BoothState = z.infer<typeof BoothState>;

/** The router's verdict (probe tier, strict output). */
export const BoothRoute = z.object({
  /** Explicit summons win ("ask the director...", "let me talk to the writer"). */
  responder: BoothResponder,
  reason: z.string(),
});
export type BoothRoute = z.infer<typeof BoothRoute>;

/**
 * Resolution extraction (judgment tier, strict output) — run once when the
 * booth closes: the conversation's durable outcomes become pencil marks
 * (writer #4) and/or overrides. Empty arrays are a valid resolution (a chat
 * that calibrated nothing).
 *
 * NO LENGTH BOUNDS (M3, after the 2026-08-01 live diagnosis — this schema
 * carried the exact twin of the field that caused it). The structured-output
 * grammar strips `.max()` on strings and arrays, so a bound here could not
 * stop a fifth mark from being written; it could only fail the parse and lose
 * the WHOLE resolution — every calibration the player just settled — over a
 * surplus note. The prompt states the limits; booth.ts clamps them.
 */
export const BoothResolution = z.object({
  /** ≤4; clamped engine-side. */
  marks: z.array(
    z.object({
      kind: z.enum(["axis", "voice_feature", "craft_note"]),
      topic: z.string().min(1),
      direction: z.string().min(1),
      evidence: z.string().min(1),
    }),
  ),
  /** ≤2 standing rules the player laid down in the booth (rare — most go via the override channel). */
  overrides: z.array(z.string()),
  /** §6.9 layer-10 writer (M2R R4): one durable note about the PLAYER's
   *  taste — not the character, not this campaign — when the booth chat
   *  revealed one. Usually absent. Bounded by TASTE_NOTE_MAX (db/helpers.ts):
   *  notes ride the Settei budget, enforced at the consumer. */
  player_taste_note: z.string().optional(),
  summary: z.string().min(1),
});
export type BoothResolution = z.infer<typeof BoothResolution>;

/** Emission ceilings the schema can no longer carry (see above). */
export const BOOTH_MARKS_MAX = 4;
export const BOOTH_OVERRIDES_MAX = 2;
