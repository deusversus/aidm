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
  /**
   * Idempotency keys for the corrections this booth has ALREADY filed
   * (booth.ts `correctionKey`). A critical_fact correction is self-cancelling
   * on a re-run — its target is tombstoned, so nothing resolves — but an
   * entity revision never tombstones its row: the same correction re-run at
   * close, or on crash-replay, revised a live dossier a second time. The
   * ledger is what makes both filing sites idempotent for BOTH target kinds,
   * and it rides booth_state so it is exactly as durable as the conversation
   * that produced it. Absent on a pre-ledger stored state — defaults to empty.
   */
  filed_corrections: z.array(z.string()).default([]),
});
export type BoothState = z.infer<typeof BoothState>;

/** The router's verdict (probe tier, strict output). */
export const BoothRoute = z.object({
  /** Explicit summons win ("ask the director...", "let me talk to the writer"). */
  responder: BoothResponder,
  reason: z.string(),
  /**
   * M3R2 C4 — the §7.4 ladder's first rung for the corrections channel: TRUE
   * when the player's words say an established RECORD is WRONG. The router
   * already runs on every booth message, so the signal is free; only a true
   * signal pays for the judged comprehension gate that can actually file.
   * A false negative costs a correction the player can restate; a false
   * positive costs one gate call that bounces.
   */
  record_correction_signal: z.boolean(),
});
export type BoothRoute = z.infer<typeof BoothRoute>;

/**
 * A record correction (M3R2 C4, the founding incident 2026-08-03): the player
 * told the booth a hard line was recorded INVERTED, the Writer agreed and
 * promised the fix, and the close-time resolution had no write path to the
 * record — the booth had a voice but no pen. This is the pen.
 *
 * `target_kind` is EXACTLY what M2-C3's retire-and-replace supports, no more:
 * a layer-9 critical fact (tombstone the row, insert the replacement) or a
 * catalog entity's living dossier block (the revise judgment + a version row).
 * A correction the machinery cannot land is never approximated into one it can.
 *
 * NO LENGTH BOUNDS (M3 C1 grammar rule, as on every field above): the engine
 * drops empties and clamps; a bound here could only fail the parse and lose
 * the whole resolution.
 */
export const BoothCorrection = z.object({
  target_kind: z.enum(["critical_fact", "entity"]),
  /**
   * critical_fact: the established record's OWN words, quoted closely enough
   * to match it. entity: the exact catalog name. This is what binds the
   * correction to a row — an unmatched hint files NOTHING (never a guess).
   */
  target_hint: z.string(),
  /** What the record must say INSTEAD, as a record line — not chat. */
  corrected_content: z.string(),
  /**
   * The VERBATIM player statement that grounds this correction. The engine
   * checks it against the player's own transcript lines: a correction the
   * player did not say in so many words is the RESPONDER's inference, and
   * inference never moves the record (§5.4 player authority runs one way).
   */
  player_words: z.string(),
});
export type BoothCorrection = z.infer<typeof BoothCorrection>;

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
  /** ≤BOOTH_CORRECTIONS_MAX record corrections the player's own words settled
   *  (M3R2 C4). OPTIONAL, like the taste note: corrections are the rarest
   *  outcome a booth has, and the field's absence must read as "none" rather
   *  than costing the resolution a parse (a pre-C4 stored resolution has no
   *  field at all). The engine treats absent and empty identically. */
  corrections: z.array(BoothCorrection).optional(),
  summary: z.string().min(1),
});
export type BoothResolution = z.infer<typeof BoothResolution>;

/** Emission ceilings the schema can no longer carry (see above). */
export const BOOTH_MARKS_MAX = 4;
export const BOOTH_OVERRIDES_MAX = 2;
/** Corrections are the rarest booth outcome and the most authoritative write it can make. */
export const BOOTH_CORRECTIONS_MAX = 3;

/**
 * §7.4 comprehension-before-compliance (M3R1): the override channel's one
 * judged look before the most destructive write in §5.4 — the probe's
 * OVERRIDE_COMMAND classification alone must never be enough to eat a scene
 * and bind the studio (the 2026-08-03 eaten-reply incident; ~25% residual
 * misroute on the hardest input at a Haiku probe). NO LENGTH BOUNDS (M3 C1
 * grammar rule): the prompt states the one-sentence limit; the runtime clamps.
 */
export const OverrideComprehension = z.object({
  /** True ONLY for words aimed at the STUDIO laying down a rule that binds
   *  future scenes. An imperative aimed into the fiction is false. */
  contains_standing_rule: z.boolean(),
  /** The rule restated in ONE imperative sentence, the studio's own words —
   *  never an echo. Empty when contains_standing_rule is false. */
  rule: z.string(),
  /** one_shot = this beat only. It still MINTS its restatement (M3R1 review
   *  walk-back: bouncing a real one-beat rule re-entered the story machinery
   *  as a mislabeled action and rolled dice on a request); the self-retiring
   *  lifecycle is deferred with the OP-command design. */
  scope: z.enum(["standing", "one_shot"]),
});
export type OverrideComprehension = z.infer<typeof OverrideComprehension>;

/**
 * The corrections channel's comprehension gate (M3R2 C4) — comprehendOverride's
 * sibling, for the same reason: the write on the other side of it is
 * destructive (a retire-and-replace RETIRES a line of the record), so a probe
 * signal alone must never be enough to make it. The judged instrument decides,
 * and when it hesitates the booth files nothing and says so.
 *
 * NO LENGTH BOUNDS (M3 C1 grammar rule): the prompt states the one-line limit.
 */
export const CorrectionComprehension = z.object({
  /** True ONLY when the PLAYER'S OWN WORDS state that an established record is
   *  WRONG. Musing, disagreement with the story, and a wish for the future are
   *  all false — those are marks and overrides, not corrections. */
  player_states_record_is_wrong: z.boolean(),
  /** Which record the correction lands on — the two M2-C3 supports. */
  target_kind: z.enum(["critical_fact", "entity"]),
  /** The established record's own words (critical_fact) or the exact catalog
   *  name (entity). Empty when the verdict is false. */
  target_hint: z.string(),
  /** The corrected record restated in ONE line, in the RECORD's register —
   *  the M3R1 restatement pattern, never an echo of the chat. This is the text
   *  that lands and the text the acknowledgement names, so a wrong reading is
   *  visible the moment it lands. Empty when the verdict is false. */
  record_text: z.string(),
});
export type CorrectionComprehension = z.infer<typeof CorrectionComprehension>;
