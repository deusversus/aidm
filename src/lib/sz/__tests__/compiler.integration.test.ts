import * as schema from "@/lib/db/schema";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import { renderSettei } from "@/lib/renderer/settei";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileSessionZero, gapVerdict, resolveObservations } from "../compiler";
import type { ConductorDraft, Observation } from "../conductor";

/** Real-DB compile: scripted draft → contract + OSP → persisted handoff. */

const url = process.env.DATABASE_URL;
if (!url) console.warn("[sz.compiler] DATABASE_URL not set — skipping");

const pool = url ? new Pool({ connectionString: url, max: 4 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

const obs = (kind: Observation["kind"], content: string): Observation => ({
  kind,
  content,
  confidence: 0.9,
});

const SCRIPTED_OBSERVATIONS: Observation[] = [
  obs(
    "spark",
    "The moment someone says 'whatever happens, happens' and walks toward the thing anyway.",
  ),
  obs("finitude", "finite — they want the story to trend toward an end"),
  obs("death_physics", "death is real, sudden, and cheap; nobody gets a speech"),
  obs("lethality_posture", "a little more intense than default; losses stay lost"),
  obs("hard_line", "no harm to children on-screen"),
  obs("calibration", '{"axis": "darkness", "value": 8}'),
  obs(
    "canonicality",
    '{"timeline_mode": "canon_adjacent", "canon_cast_mode": "full_cast", "event_fidelity": "influenceable"}',
  ),
  obs("presentation", "bare prose; episode-title cards only"),
  obs("suggestion_affordance", "on_request_only"),
  obs(
    "tier_selection",
    '{"narration": "claude-sonnet-5", "judgment": "claude-haiku-4-5", "probe": "claude-haiku-4-5"}',
  ),
  obs("world_fact", "The crew operates out of a converted fishing trawler, not the canon ship"),
  obs("player_taste", "loves found-family premises; plays late at night"),
  obs("deferred", "who the recurring antagonist is — director's territory"),
];

const STUB_OSP = {
  director_inputs: {
    opening_situation: "A bounty gone quiet on a Ganymede dock at closing time.",
    spark_reading: "Fatalism worn as freedom; walking toward the thing anyway.",
    suggested_first_arc_question: "What does the crew owe each other when the money's gone?",
  },
  animation_inputs: {
    forbidden_opening_moves: ["revealing the antagonist", "spending the spark in scene one"],
    opening_pov: "the player's character, mid-shift, before the trouble",
  },
  constraints: [
    { text: "no harm to children on-screen", tier: "hard" as const },
    { text: "keep episodes bounty-shaped early", tier: "soft" as const },
  ],
  uncertainties: [
    {
      question: "who the recurring antagonist is",
      safe_assumption: "someone inside the bounty system itself",
      degraded_generation_guidance: "keep antagonist references faceless and institutional",
    },
  ],
  briefs: [
    {
      name: "The Trawler",
      kind: "world" as const,
      brief: "A converted fishing trawler serving as the crew's ship.",
      admit_to_catalog: true,
    },
  ],
  orphan_facts: ["the player hums the OP when happy"],
};

describe.skipIf(!url)("SZ compiler (real Postgres)", () => {
  const playerId = `test_player_${crypto.randomUUID()}`;
  let campaignId: string;

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values({ id: playerId, email: "sz@example.com" });
    // A stub profile row satisfying the Profile contract (fixture-derived).
    const contract = bebopContract();
    await db
      .insert(schema.profiles)
      .values({
        id: "test_sz_profile",
        title: "Cowboy Bebop",
        profile: {
          id: "test_sz_profile",
          title: "Cowboy Bebop",
          alternate_titles: [],
          media_type: "anime",
          status: "completed",
          relation_type: "canonical",
          ip_mechanics: {
            ...contract.canonical.world,
            author_voice: contract.canonical.voice.author_voice,
            voice_cards: [],
          },
          canonical_dna: contract.canonical.treatment,
          canonical_composition: contract.canonical.framing,
          director_personality: contract.canonical.voice.director_personality,
          cast_depth_posture: contract.canonical.voice.cast_depth_posture,
        },
      })
      .onConflictDoNothing();
    const draft: ConductorDraft = {
      transcript: [{ role: "user", content: "let's play bebop" }],
      observations: SCRIPTED_OBSERVATIONS,
      profileIds: ["test_sz_profile"],
      readyToCompile: true,
    };
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ playerId, title: "SZ compile fixture", status: "draft", szTranscript: draft })
      .returning();
    if (!campaign) throw new Error("campaign insert failed");
    campaignId = campaign.id;
  });

  afterAll(async () => {
    if (!db || !pool) return;
    try {
      await db.delete(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
      await db.delete(schema.profiles).where(eq(schema.profiles.id, "test_sz_profile"));
      await db.delete(schema.players).where(eq(schema.players.id, playerId));
    } finally {
      await pool.end();
    }
  });

  it("resolution is latest-wins and calibration parses per axis", () => {
    const resolved = resolveObservations([
      ...SCRIPTED_OBSERVATIONS,
      obs("calibration", '{"axis": "darkness", "value": 6}'),
    ]);
    expect(resolved.calibration.darkness).toBe(6);
    expect(resolved.spark).toContain("whatever happens");
    expect(resolved.finitude).toBe("finite");
  });

  it("finitude never inverts and never guesses (§8 sacrosanct)", () => {
    const indefinite = resolveObservations([
      obs("finitude", "indefinite — an open monster-of-the-week cycle"),
    ]);
    expect(indefinite.finitude).toBe("indefinite");
    const undecided = resolveObservations([obs("finitude", "they're undecided for now")]);
    expect(undecided.finitude).toBe("undecided");
    // The chosen word leads (the conductor is told to record it first) —
    // a trailing mention of the other word must not flip it.
    const both = resolveObservations([
      obs("finitude", "finite — they considered indefinite but want a real ending"),
    ]);
    expect(both.finitude).toBe("finite");
    // Ambiguous mid-string mentions of BOTH words resolve to nothing: the
    // gap verdict blocks a guessed Series contract rather than shipping one.
    const ambiguous = resolveObservations([
      obs("finitude", "torn between a finite run and letting it go on indefinitely"),
    ]);
    expect(ambiguous.finitude).toBeUndefined();
    expect(ambiguous.deferred.some((d) => d.includes("ambiguous finitude"))).toBe(true);
  });

  it("a malformed tier_selection defers instead of throwing", () => {
    const resolved = resolveObservations([obs("tier_selection", "sonnet for everything please")]);
    expect(resolved.tierSelection).toBeUndefined();
    expect(resolved.deferred.some((d) => d.includes("tier selection"))).toBe(true);
  });

  it("gap verdict blocks a sparkless handoff (§8)", () => {
    const gaps = gapVerdict(
      resolveObservations(SCRIPTED_OBSERVATIONS.filter((o) => o.kind !== "spark")),
      true,
    );
    expect(gaps.some((g) => g.includes("spark"))).toBe(true);
  });

  it("a sparkless compile HALTS: campaign stays draft, nothing persists", async () => {
    if (!db) throw new Error("unreachable");
    const sparkless: ConductorDraft = {
      transcript: [],
      observations: SCRIPTED_OBSERVATIONS.filter((o) => o.kind !== "spark"),
      profileIds: ["test_sz_profile"],
      readyToCompile: true,
    };
    const [blocked] = await db
      .insert(schema.campaigns)
      .values({ playerId, title: "sparkless fixture", status: "draft", szTranscript: sparkless })
      .returning();
    if (!blocked) throw new Error("insert failed");
    try {
      const result = await compileSessionZero(db, blocked.id, {
        ospSynthesizer: async () => {
          throw new Error("OSP must never run on a gapped draft");
        },
      });
      expect(result.gaps.length).toBeGreaterThan(0);
      const [row] = await db
        .select()
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, blocked.id));
      expect(row?.status).toBe("draft");
      expect(row?.premiseContract).toBeNull();
      const facts = await db
        .select()
        .from(schema.criticalFacts)
        .where(eq(schema.criticalFacts.campaignId, blocked.id));
      expect(facts).toHaveLength(0);
    } finally {
      await db.delete(schema.campaigns).where(eq(schema.campaigns.id, blocked.id));
    }
  });

  it("compiles the scripted draft: contract + OSP persisted, handoff complete", async () => {
    if (!db) throw new Error("unreachable");
    const result = await compileSessionZero(db, campaignId, {
      ospSynthesizer: async () => STUB_OSP,
    });
    expect(result.gaps).toEqual([]);
    expect(result.contract.spark).toContain("whatever happens");
    expect(result.contract.active.treatment.darkness).toBe(8); // player's move
    expect(result.contract.canonical.treatment.darkness).toBe(7); // profile untouched
    expect(result.contract.intensity.hard_lines).toContain("no harm to children on-screen");

    const [campaign] = await db
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId));
    expect(campaign?.status).toBe("active");
    expect(campaign?.tierModels).toMatchObject({ narration: "claude-sonnet-5" });

    const facts = await db
      .select()
      .from(schema.criticalFacts)
      .where(eq(schema.criticalFacts.campaignId, campaignId));
    expect(facts.some((f) => f.content.includes("Finitude: finite"))).toBe(true);
    expect(facts.some((f) => f.content.startsWith("HARD LINE"))).toBe(true);
    // Player assertions persist deterministically — never via the OSP model.
    const trawler = facts.find((f) => f.content.includes("fishing trawler"));
    expect(trawler?.provenance).toBe("player_assertion");
    expect(trawler?.category).toBe("sz_fact");

    // A second compile must lose the draft→active race, not double-write.
    await expect(
      compileSessionZero(db, campaignId, { ospSynthesizer: async () => STUB_OSP }),
    ).rejects.toThrow(/already active/);
    const factsAfter = await db
      .select()
      .from(schema.criticalFacts)
      .where(eq(schema.criticalFacts.campaignId, campaignId));
    expect(factsAfter).toHaveLength(facts.length);

    const marks = await db
      .select()
      .from(schema.pencilMarks)
      .where(eq(schema.pencilMarks.campaignId, campaignId));
    expect(marks.some((m) => m.topic === "spark")).toBe(true);

    const admitted = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.campaignId, campaignId));
    expect(admitted.some((e) => e.name === "The Trawler")).toBe(true);

    const [player] = await db.select().from(schema.players).where(eq(schema.players.id, playerId));
    expect((player?.profile as { taste?: string[] }).taste?.[0]).toContain("found-family");
  });

  it("the compiled contract renders a Settei — the round-trip into C1", async () => {
    if (!db) throw new Error("unreachable");
    const [campaign] = await db
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId));
    const contract = campaign?.premiseContract as Parameters<typeof renderSettei>[0]["contract"];
    const settei = renderSettei({ contract, marks: [] });
    expect(settei.charterTokens).toBeGreaterThan(0);
    expect(settei.text).toContain("whatever happens");
    expect(settei.renderedAxes).toContain("darkness");
  });
});
