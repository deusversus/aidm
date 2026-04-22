import type { IntentOutput } from "@/lib/types/turn";
import { z } from "zod";
import { type IntentClassifierDeps, classifyIntent } from "./intent-classifier";
import {
  type OverrideHandlerDeps,
  type OverrideHandlerOutput,
  handleOverride,
} from "./override-handler";
import type { AgentDeps } from "./types";
import {
  Canonicality,
  type EntityUpdate,
  type WorldBuilderDeps,
  type WorldBuilderFlag,
  type WorldBuilderOutput,
  validateAssertion,
} from "./world-builder";

/**
 * Routing pre-pass for every player message.
 *
 * Runs IntentClassifier first, then branches:
 *
 *   META_FEEDBACK      → OverrideHandler (meta)  → verdict.kind === "meta"
 *   OVERRIDE_COMMAND   → OverrideHandler         → verdict.kind === "override"
 *   WORLD_BUILDING →
 *     WB decision = ACCEPT or FLAG               → verdict.kind === "continue"
 *                                                   with wbAssertion payload
 *                                                   (KA narrates with the
 *                                                    assertion as canon)
 *     WB decision = CLARIFY                      → verdict.kind === "worldbuilder"
 *                                                   (short-circuit with the
 *                                                    clarifying question)
 *   everything else                              → verdict.kind === "continue"
 *
 * **WB reshape note:** ACCEPT/FLAG used to short-circuit (WB's `response`
 * was the player-facing prose, KA didn't run). That was gatekeeper
 * behavior — the scene halted on every world-fact assertion. The
 * reshape keeps WB as an editor: it looks at the assertion, registers
 * any entityUpdates, flags craft concerns, and steps out of the way.
 * KA runs as normal with the assertion injected into Block 4 so the
 * narrative moves forward.
 *
 * What the router does NOT do:
 *   - Persist overrides (workflow step consumes verdict and writes)
 *   - Render WB response to SSE (same — workflow step)
 *   - Consume a turn on meta / CLARIFY (same — workflow step)
 *   - Persist WB entityUpdates (workflow step does this BEFORE KA runs
 *     on ACCEPT/FLAG so KA's tool calls see the new entities)
 */

export const RouterInput = z.object({
  playerMessage: z.string().min(1),
  recentTurnsSummary: z.string().default(""),
  campaignPhase: z.enum(["sz", "playing", "arc_transition"]).default("playing"),
  // Context consumed only when WorldBuilder fires. Passing defaults is safe
  // even for turns where WB never runs — the cost is ~0.
  canonicalityMode: Canonicality.default("inspired"),
  characterSummary: z.string().default(""),
  activeCanonRules: z.array(z.string()).default([]),
  // Consumed only when OverrideHandler fires.
  priorOverrides: z
    .array(
      z.object({
        id: z.string(),
        category: z.enum([
          "NPC_PROTECTION",
          "CONTENT_CONSTRAINT",
          "NARRATIVE_DEMAND",
          "TONE_REQUIREMENT",
        ]),
        value: z.string(),
        scope: z.enum(["campaign", "session", "arc"]),
      }),
    )
    .default([]),
});
// Use input-side type so callers can omit defaulted fields.
export type RouterInput = z.input<typeof RouterInput>;

/**
 * Payload emitted when WorldBuilder produced an ACCEPT or FLAG verdict.
 * Rides on a `continue`-kind verdict so the turn workflow can persist
 * entities + inject the assertion into Block 4 + pass flags through to
 * the player's sidebar UI, all while KA narrates normally.
 */
export interface WbAssertionPayload {
  assertion: string;
  entityUpdates: EntityUpdate[];
  flags: WorldBuilderFlag[];
  /** Decision that produced this payload — either "ACCEPT" or "FLAG". */
  decision: "ACCEPT" | "FLAG";
  /** WB's brief in-character acknowledgment — informs Block 4 tone,
   * not surfaced as the player-facing response. */
  acknowledgment: string;
}

export type RouterVerdict =
  | { kind: "continue"; intent: IntentOutput; wbAssertion?: WbAssertionPayload }
  | { kind: "meta"; intent: IntentOutput; override: OverrideHandlerOutput }
  | { kind: "override"; intent: IntentOutput; override: OverrideHandlerOutput }
  | { kind: "worldbuilder"; intent: IntentOutput; verdict: WorldBuilderOutput };

export interface RouterDeps extends AgentDeps {
  intentClassifier?: IntentClassifierDeps;
  worldBuilder?: WorldBuilderDeps;
  overrideHandler?: OverrideHandlerDeps;
}

export async function routePlayerMessage(
  input: RouterInput,
  deps: RouterDeps = {},
): Promise<RouterVerdict> {
  const parsed = RouterInput.parse(input);
  const span = deps.trace?.span({
    name: "workflow:router",
    input: { playerMessage: parsed.playerMessage, campaignPhase: parsed.campaignPhase },
  });

  // Base deps threaded into every sub-agent. Per-sub-agent overrides
  // (test injection of mock providers, etc.) spread last so they win.
  const subagentBase = {
    trace: deps.trace,
    logger: deps.logger,
    modelContext: deps.modelContext,
    recordPrompt: deps.recordPrompt,
  };

  const intent = await classifyIntent(
    {
      playerMessage: parsed.playerMessage,
      recentTurnsSummary: parsed.recentTurnsSummary,
      campaignPhase: parsed.campaignPhase,
    },
    { ...subagentBase, ...deps.intentClassifier },
  );

  if (intent.intent === "META_FEEDBACK") {
    const override = await handleOverride(
      { command: parsed.playerMessage, prior_overrides: parsed.priorOverrides },
      { ...subagentBase, ...deps.overrideHandler },
    );
    const verdict: RouterVerdict = { kind: "meta", intent, override };
    span?.end({ output: { kind: verdict.kind, intent: intent.intent } });
    return verdict;
  }

  if (intent.intent === "OVERRIDE_COMMAND") {
    const override = await handleOverride(
      { command: parsed.playerMessage, prior_overrides: parsed.priorOverrides },
      { ...subagentBase, ...deps.overrideHandler },
    );
    const verdict: RouterVerdict = { kind: "override", intent, override };
    span?.end({ output: { kind: verdict.kind, intent: intent.intent } });
    return verdict;
  }

  if (intent.intent === "WORLD_BUILDING") {
    const wbVerdict = await validateAssertion(
      {
        assertion: parsed.playerMessage,
        canonicalityMode: parsed.canonicalityMode,
        characterSummary: parsed.characterSummary,
        activeCanonRules: parsed.activeCanonRules,
        recentTurnsSummary: parsed.recentTurnsSummary,
      },
      { ...subagentBase, ...deps.worldBuilder },
    );
    // CLARIFY — genuine physical ambiguity, scene can't render forward.
    // Short-circuit with WB's clarifying question as the player response.
    if (wbVerdict.decision === "CLARIFY") {
      const verdict: RouterVerdict = { kind: "worldbuilder", intent, verdict: wbVerdict };
      span?.end({
        output: { kind: verdict.kind, intent: intent.intent, decision: wbVerdict.decision },
      });
      return verdict;
    }
    // ACCEPT / FLAG — editor posture: take note, step out of the way,
    // let KA narrate with the assertion as canon. Flags ride on the
    // continue verdict so the workflow emits them alongside `done`.
    const verdict: RouterVerdict = {
      kind: "continue",
      intent,
      wbAssertion: {
        assertion: parsed.playerMessage,
        entityUpdates: wbVerdict.entityUpdates,
        flags: wbVerdict.flags,
        decision: wbVerdict.decision,
        acknowledgment: wbVerdict.response,
      },
    };
    span?.end({
      output: {
        kind: verdict.kind,
        intent: intent.intent,
        decision: wbVerdict.decision,
        flagCount: wbVerdict.flags.length,
      },
    });
    return verdict;
  }

  const verdict: RouterVerdict = { kind: "continue", intent };
  span?.end({ output: { kind: verdict.kind, intent: intent.intent } });
  return verdict;
}
