import { z } from "zod";
import type { GoldenFixture, JudgeScore } from "./types";

/**
 * Manual prose review tool (Commit 8) — opt-in, runs Haiku 4.5 to
 * score a scenario's narrative against its `manual_rubric`.
 *
 * Gated behind `--judge` on the harness. Never runs in CI:
 *   - Explicit guard throws when process.env.CI === "true"
 *   - Default flow (pnpm evals + pnpm evals:ci) never imports this
 *     file — it's loaded lazily from run.ts only when --judge is set
 *
 * Claude invokes this ONLY with the user's explicit approval per pass.
 * Prose-quality review is a manual, strategic-interval process — not
 * a PR gate. Output lands in `evals/manual-reviews/<timestamp>.json`
 * (gitignored; Claude reports findings back to the user).
 */

const JudgeOutput = z.object({
  register_adherence: z.number().min(1).max(5),
  tone_coherence: z.number().min(1).max(5),
  specificity: z.number().min(1).max(5),
  causal_logic: z.number().min(1).max(5),
  voice_fit: z.number().min(1).max(5),
  rationale: z.string(),
});

export async function judgeScenario(
  fixture: GoldenFixture,
  narrative: string,
): Promise<JudgeScore> {
  // Hard CI guard — even if a script file somehow imports this while
  // CI=true, the call throws before any spend.
  if (process.env.CI === "true") {
    throw new Error(
      "judge.ts: refusing to run in CI (--judge is a manual-only review tool). Remove the flag from the CI workflow or unset CI env.",
    );
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "judge.ts: ANTHROPIC_API_KEY required for manual prose review (this is the one path that hits the real API).",
    );
  }

  console.log(
    `[judge] MANUAL REVIEW MODE — calling real Haiku for ${fixture.id} (~$0.01 expected)`,
  );

  const rubric = fixture.manual_rubric ?? {
    register: [],
    tone_anchors: [],
    forbidden_patterns: [],
  };
  const systemPrompt = [
    "You are a narrative evaluator scoring prose against a craft rubric.",
    "",
    "Score five dimensions 1-5 (1 = poor, 5 = excellent):",
    "  - register_adherence: does the prose fit the register the rubric describes?",
    "  - tone_coherence: do the tone anchors land consistently?",
    "  - specificity: named entities + concrete detail vs. generic filler",
    "  - causal_logic: does what happens make sense given the player's move?",
    "  - voice_fit: does it read like the referenced IP's voice?",
    "",
    "Return ONLY JSON matching the schema — no prose, no markdown fences.",
  ].join("\n");

  const userPrompt = [
    `Scenario: ${fixture.description}`,
    "",
    "Register expected:",
    ...(rubric.register ?? []).map((r: string) => `  - ${r}`),
    "",
    "Tone anchors expected:",
    ...(rubric.tone_anchors ?? []).map((t: string) => `  - ${t}`),
    "",
    "Forbidden patterns:",
    ...(rubric.forbidden_patterns ?? []).map((p: string) => `  - ${p}`),
    "",
    "Narrative to score:",
    narrative,
  ].join("\n");

  const body = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 400,
    temperature: 0,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`judge Haiku call failed: ${res.status} ${await res.text()}`);
  }
  type MessagesResponse = {
    content?: Array<{ type: string; text?: string }>;
  };
  const json = (await res.json()) as MessagesResponse;
  const text = (json.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("")
    .trim();
  const extracted = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  const parsed = JudgeOutput.safeParse(JSON.parse(extracted));
  if (!parsed.success) {
    throw new Error(`judge output failed schema: ${parsed.error.message}`);
  }
  return parsed.data;
}
