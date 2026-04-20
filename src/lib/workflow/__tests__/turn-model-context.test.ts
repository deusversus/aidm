import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { KeyAnimatorEvent, KeyAnimatorInput } from "@/lib/agents/key-animator";
import type { Db } from "@/lib/db";
import type { CampaignProviderConfig } from "@/lib/providers";
import { campaigns, characters, profiles, turns } from "@/lib/state/schema";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { runTurn } from "../turn";

/**
 * End-to-end threading test for M1.5 modelContext (FU-A / FU-1).
 *
 * Per-commit unit tests prove:
 *   - `resolveModelContext` parses settings correctly (turn-gates.test.ts).
 *   - `runKeyAnimator` honors modelContext when it receives one (key-animator.test.ts).
 *   - `runStructuredAgent` dispatches by provider (_runner.test.ts).
 *
 * What they don't prove: the GLUE in `runTurn` itself actually reads
 * modelContext from the campaign row and threads it into the `runKa`
 * call. If a future refactor drops `modelContext` from that invocation,
 * every unit test above still passes — but production quietly narrates
 * the campaign on Anthropic defaults instead of the configured model.
 *
 * This test closes that gap. Minimal DB fake + stub IntentClassifier +
 * mock runKa that captures the `modelContext` it receives.
 */

type CampaignRow = typeof campaigns.$inferSelect;
type ProfileRow = typeof profiles.$inferSelect;
type CharacterRow = typeof characters.$inferSelect;

function loadBebopProfileContent(): unknown {
  const raw = readFileSync(
    join(process.cwd(), "evals", "golden", "profiles", "cowboy_bebop.yaml"),
    "utf8",
  );
  // Round-trip through YAML → JSON via js-yaml that's already bundled.
  // Inline-require to avoid adding an import for one call site.
  const jsYaml = require("js-yaml") as { load: (s: string) => unknown };
  return jsYaml.load(raw);
}

/**
 * Dispatches db calls to the right rows based on which table the
 * caller passed to `.from()`. Drizzle's chainable builder returns
 * a proxy-like object at each stage; the real table reference is the
 * thing that distinguishes queries.
 */
function makeDb(opts: {
  campaign: CampaignRow;
  profile: ProfileRow;
  character: CharacterRow | null;
  existingTurns: Array<{
    turn_number: number;
    player_message: string;
    narrative_text: string;
  }>;
  onInsertTurn: (values: unknown) => { id: string };
}): Db {
  function selectBuilder(table: unknown) {
    let rows: unknown[] = [];
    if (table === campaigns) rows = [opts.campaign];
    else if (table === profiles) rows = [opts.profile];
    else if (table === characters) rows = opts.character ? [opts.character] : [];
    else if (table === turns) rows = opts.existingTurns;

    return {
      from: (_t: unknown) => ({
        where: (_cond: unknown) => ({
          limit: async (_n: number) => rows,
          orderBy: (_o: unknown) => ({
            limit: async (_n: number) => rows,
          }),
        }),
      }),
    };
  }

  return {
    select: (_cols?: unknown) => ({
      // The chain is `db.select().from(T).where(C).limit(N)` OR
      // `db.select({...}).from(T).where(C).orderBy(O).limit(N)`. Same
      // dispatch — `from(T)` is where we learn which table.
      from: (t: unknown) => selectBuilder(t).from(t),
    }),
    insert: (_t: unknown) => ({
      values: (v: unknown) => ({
        returning: async (_cols?: unknown) => [opts.onInsertTurn(v)],
      }),
    }),
    update: (_t: unknown) => ({
      set: (_v: unknown) => ({
        where: async (_c: unknown) => ({}),
      }),
    }),
    execute: async <T>(_q: unknown): Promise<{ rows: T[] }> =>
      ({ rows: [{ locked: true } as unknown as T] }) as unknown as { rows: T[] },
  } as unknown as Db;
}

function fakeAnthropic(text: string): () => Pick<Anthropic, "messages"> {
  return () =>
    ({
      messages: {
        create: async () => ({ content: [{ type: "text", text }] }),
      },
    }) as unknown as Pick<Anthropic, "messages">;
}

describe("runTurn — modelContext threading (FU-A)", () => {
  it("passes the campaign's tier_models into runKa untouched", async () => {
    // Custom non-default config: pin creative to Sonnet 4.6 + thinking
    // to an Opus 4.5 snapshot. If turn.ts's glue drops modelContext,
    // runKa would see anthropicFallbackConfig() (all Opus 4.7) and the
    // assertion below would fail.
    const customContext: CampaignProviderConfig = {
      provider: "anthropic",
      tier_models: {
        probe: "claude-haiku-4-5-20251001",
        fast: "claude-haiku-4-5-20251001",
        thinking: "claude-opus-4-5-20251101",
        creative: "claude-sonnet-4-6",
      },
    };

    const bebopContent = loadBebopProfileContent();
    const campaignRow: CampaignRow = {
      id: "c-test",
      userId: "u-1",
      name: "Bebop — test",
      phase: "playing",
      profileRefs: ["cowboy-bebop"],
      settings: {
        provider: customContext.provider,
        tier_models: customContext.tier_models,
        active_dna: {},
        world_state: {
          location: "The Bebop",
          situation: "drifting",
          present_npcs: ["Jet"],
        },
      },
      createdAt: new Date(),
      deletedAt: null,
    };

    const profileRow: ProfileRow = {
      id: "p-1",
      slug: "cowboy-bebop",
      title: "Cowboy Bebop",
      mediaType: "anime",
      content: bebopContent,
      version: 1,
      createdAt: new Date(),
    };

    // Capture what runKa received.
    let capturedInput: KeyAnimatorInput | undefined;
    const mockRunKa = async function* (
      input: KeyAnimatorInput,
    ): AsyncGenerator<KeyAnimatorEvent, void, void> {
      capturedInput = input;
      yield {
        kind: "final",
        narrative: "Spike stares at the ceiling.",
        ttftMs: 100,
        totalMs: 200,
        costUsd: 0.01,
        sessionId: "s-1",
        stopReason: "end_turn",
      };
    };

    const db = makeDb({
      campaign: campaignRow,
      profile: profileRow,
      character: null,
      existingTurns: [],
      onInsertTurn: () => ({ id: "t-new" }),
    });

    // IntentClassifier routes via Anthropic by default (modelContext
    // passed through router → classifyIntent). Fake an Anthropic
    // response that returns a continue-branch intent so we reach KA.
    const intentClassifierAnthropic = fakeAnthropic(
      JSON.stringify({
        intent: "DEFAULT",
        action: "look around",
        epicness: 0.2, // low enough to skip OJ (shouldPreJudgeOutcome returns false)
        special_conditions: [],
        confidence: 0.9,
      }),
    );

    // Drain the generator. We don't care about the yielded events here;
    // we care about what runKa received.
    const events: unknown[] = [];
    for await (const ev of runTurn(
      { campaignId: "c-test", userId: "u-1", playerMessage: "look around" },
      {
        db,
        runKa: mockRunKa as never,
        routerDeps: { intentClassifier: { anthropic: intentClassifierAnthropic } },
      },
    )) {
      events.push(ev);
      if ((ev as { type: string }).type === "done" || (ev as { type: string }).type === "error") {
        break;
      }
    }

    expect(capturedInput).toBeDefined();
    expect(capturedInput?.modelContext).toEqual(customContext);
    // Specific assertion on the creative pin so a regression that partially
    // dropped fields (kept provider, dropped tier_models) fails loudly.
    expect(capturedInput?.modelContext.tier_models.creative).toBe("claude-sonnet-4-6");
    expect(capturedInput?.modelContext.tier_models.thinking).toBe("claude-opus-4-5-20251101");
  });
});
