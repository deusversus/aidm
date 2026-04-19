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
  type WorldBuilderDeps,
  type WorldBuilderOutput,
  validateAssertion,
} from "./world-builder";

/**
 * Routing pre-pass for every player message.
 *
 * Runs IntentClassifier first, then branches:
 *
 *   META_FEEDBACK    → OverrideHandler (meta mode) → verdict.kind === "meta"
 *   OVERRIDE_COMMAND → OverrideHandler (override)  → verdict.kind === "override"
 *   WORLD_BUILDING   → WorldBuilder                → verdict.kind === "worldbuilder"
 *   everything else                                → verdict.kind === "continue"
 *
 * What the router does NOT do:
 *   - Persist overrides (the workflow step consumes the verdict and writes)
 *   - Render the WorldBuilder response to SSE (same — workflow step)
 *   - Consume a turn on meta / worldbuilder-reject (same — workflow step)
 *
 * This function is deterministic given its deps: swap providers in tests,
 * get predictable verdicts. The turn workflow (`src/lib/workflow/turn.ts`)
 * calls it directly as the pre-pass that annotates and routes before KA
 * starts orchestrating the scene.
 *
 * Span hierarchy: the router's span and its sub-agents' spans currently
 * share the same `trace` handle (the root). True parent/child nesting is
 * a Langfuse-native concern — revisit whether `AidmSpanHandle` needs
 * `.span()` as well as `.end()` to model hierarchy when the Langfuse UI
 * surface the flat layout becomes unwieldy. Siblings-on-one-trace is
 * readable today; don't over-engineer until it stops being.
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

export type RouterVerdict =
  | { kind: "continue"; intent: IntentOutput }
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

  const intent = await classifyIntent(
    {
      playerMessage: parsed.playerMessage,
      recentTurnsSummary: parsed.recentTurnsSummary,
      campaignPhase: parsed.campaignPhase,
    },
    {
      trace: deps.trace,
      logger: deps.logger,
      ...deps.intentClassifier,
    },
  );

  if (intent.intent === "META_FEEDBACK") {
    const override = await handleOverride(
      { command: parsed.playerMessage, prior_overrides: parsed.priorOverrides },
      { trace: deps.trace, logger: deps.logger, ...deps.overrideHandler },
    );
    const verdict: RouterVerdict = { kind: "meta", intent, override };
    span?.end({ output: { kind: verdict.kind, intent: intent.intent } });
    return verdict;
  }

  if (intent.intent === "OVERRIDE_COMMAND") {
    const override = await handleOverride(
      { command: parsed.playerMessage, prior_overrides: parsed.priorOverrides },
      { trace: deps.trace, logger: deps.logger, ...deps.overrideHandler },
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
      { trace: deps.trace, logger: deps.logger, ...deps.worldBuilder },
    );
    const verdict: RouterVerdict = {
      kind: "worldbuilder",
      intent,
      verdict: wbVerdict,
    };
    span?.end({
      output: {
        kind: verdict.kind,
        intent: intent.intent,
        decision: wbVerdict.decision,
      },
    });
    return verdict;
  }

  const verdict: RouterVerdict = { kind: "continue", intent };
  span?.end({ output: { kind: verdict.kind, intent: intent.intent } });
  return verdict;
}
