/**
 * Output-budget classes (M2R2 §6): what a call honestly PRODUCES.
 *
 * Each constant names the size of the emitted artifact — the tokens the model
 * writes as its answer. Thinking headroom is NOT baked in here: it is added
 * structurally at the choke point (`computeEffectiveMaxTokens` in calls.ts),
 * scaled by model and effort. A budget is a ceiling on the artifact, never a
 * jar the model's reasoning must also squeeze inside — that conflation is what
 * made ~25 adaptive-thinking call sites truncate silently inside flat caps.
 *
 * Call sites import a class; no bare max_tokens literals, no silent 1024
 * default. The classes are safety rails, priced only when a call actually
 * reaches them.
 *
 * The KA's per-tier narration budgets (TURN_CONTRACTS.outputBudgetTokens,
 * douga/genga/sakuga) are the ONE deliberate exception: narration length is
 * shaped by the premise and the beat, not by a class here.
 */

/** Single small verdict objects — router, transition check, merge pair, gauge classification. */
export const CLASSIFY = 1_000;

/**
 * Small structured emits — intent triage, pacer directive, outcome validation,
 * relevance ranking, world-assertion extraction, block revision, sidecar
 * fallback, suggestions.
 */
export const STRUCTURED_SMALL = 2_000;

/**
 * Multi-part structured emits with prose fields — outcome judgment, scale,
 * Sakkan scoresheet, compaction, G2 distill, booth resolution, session memo,
 * voice journal, wiki scrape plan, and the interpretive research calls (mapped
 * to the nearest class ≥ their current size, never shrunk).
 */
export const STRUCTURED_RICH = 8_000;

/**
 * Tool-loop calls emitting large contracts — Director cycle + startup, SZ OSP
 * synthesis, and the deepest research synthesis.
 */
export const LOOPED_LARGE = 16_000;

/** Player-facing prose composers — recap, yokoku, booth responder, SZ conductor. */
export const PROSE_COMPOSER = 8_000;
