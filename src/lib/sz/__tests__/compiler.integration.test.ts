import * as schema from "@/lib/db/schema";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import { renderSettei } from "@/lib/renderer/settei";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileSessionZero, dedupeAdmissions, gapVerdict, resolveObservations } from "../compiler";
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

// The dedup rules are pure — exercised without a DB so they run everywhere.
describe("dedupeAdmissions (§6.5 identity guard, deterministic)", () => {
  it("folds self-insert protagonist briefs into ONE npc, identity before capability", () => {
    // Today's real defect: the OSP minted the self-insert twice, under two
    // placeholder names, from a backstory brief and a capabilities brief.
    const out = dedupeAdmissions([
      {
        name: "The Protagonist (unnamed)",
        kind: "cast",
        brief: "Raised in the lower wards; carries a dead mentor's compass.",
      },
      {
        name: "player's protagonist",
        kind: "cast",
        brief: "A duelist whose ability channels stormlight into a blade.",
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.entityType).toBe("npc");
    expect(out[0]?.name).toBe("The Protagonist");
    expect(out[0]?.block).toContain("lower wards");
    expect(out[0]?.block).toContain("stormlight");
    // Identity material precedes capability material in the merged block.
    expect(out[0]?.block.indexOf("lower wards")).toBeLessThan(
      out[0]?.block.indexOf("stormlight") ?? -1,
    );
  });

  it("keeps a real extracted name when the description flags the self-insert", () => {
    const out = dedupeAdmissions([
      { name: "Kaelen", kind: "cast", brief: "The player's protagonist; a wandering smith." },
      { name: "protagonist", kind: "cast", brief: "Fights with an ability drawn from grief." },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe("Kaelen");
  });

  it("merges near-duplicate names of the same type; leaves distinct entities alone", () => {
    const out = dedupeAdmissions([
      { name: "The Trawler", kind: "world", brief: "A converted fishing boat." },
      { name: "the trawler.", kind: "world", brief: "Its hold smells of brine and fuel." },
      { name: "Ganymede Dock", kind: "world", brief: "A closing-time berth." },
    ]);
    expect(out).toHaveLength(2);
    const trawler = out.find((e) => e.name === "The Trawler");
    expect(trawler?.block).toContain("fishing boat");
    expect(trawler?.block).toContain("brine");
  });

  it("does NOT merge DIFFERENT names for the same meaning (M2 alias territory)", () => {
    const out = dedupeAdmissions([
      { name: "Lloyd and protagonist connection", kind: "thread", brief: "Their paths tangle." },
      { name: "Path-Crossing with Lloyd", kind: "thread", brief: "Lloyd keeps reappearing." },
    ]);
    expect(out).toHaveLength(2);
  });

  it("does not mistake a non-protagonist NPC for the self-insert", () => {
    const out = dedupeAdmissions([
      { name: "Lloyd", kind: "cast", brief: "The protagonist's rival and foil." },
      { name: "The Protagonist", kind: "cast", brief: "The player's self-insert lead." },
    ]);
    expect(out).toHaveLength(2);
    expect(out.some((e) => e.name === "Lloyd")).toBe(true);
    expect(out.some((e) => e.name === "The Protagonist")).toBe(true);
  });
});

const SCRIPTED_OBSERVATIONS: Observation[] = [
  obs(
    "spark",
    "The moment someone says 'whatever happens, happens' and walks toward the thing anyway.",
  ),
  obs("finitude", "finite — they want the story to trend toward an end"),
  // M2 C4: the protagonist is NAMED — the gap verdict blocks an unnamed,
  // un-deferred PC. A real name in the shared fixture; the dedup fixture below
  // overrides it with the deferral form to prove that path also compiles.
  obs("pc_name", "Jules — the player's own bounty hunter, named after the source"),
  // SV2: the concept gate blocks a conceptless, un-deferred table — the shared
  // fixture carries one (seat + big idea, verbatim).
  obs(
    "pc_concept",
    "Someone new beside the canon crew — a washed-up bounty hunter who can't stop paying other people's debts",
  ),
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

describe("suggestion affordance resolution (anchored, never guessed from prose)", () => {
  it("does not read prose 'never' as the value (live misparse 2026-07-10)", () => {
    const r = resolveObservations([
      obs(
        "suggestion_affordance",
        "Yes to suggested moves at decision points, but diegetically wrapped as the protagonist's own system — never as a fourth-wall voice.",
      ),
    ]);
    expect(r.suggestionAffordance).toBe("on_request_only");
    expect(r.deferred.some((d) => d.includes("ambiguous suggestion affordance"))).toBe(true);
  });

  it("anchored 'never' resolves", () => {
    const r = resolveObservations([obs("suggestion_affordance", "never — player declined chips")]);
    expect(r.suggestionAffordance).toBe("never");
  });

  it("snake_case token resolves unanchored", () => {
    const r = resolveObservations([
      obs("suggestion_affordance", "player chose default_on, wrapped diegetically"),
    ]);
    expect(r.suggestionAffordance).toBe("default_on");
  });
});

describe("protagonist name resolution + gap (M2 C4, deterministic)", () => {
  it("gap verdict blocks an unnamed, un-deferred protagonist", () => {
    const gaps = gapVerdict(
      resolveObservations(SCRIPTED_OBSERVATIONS.filter((o) => o.kind !== "pc_name")),
      true,
    );
    expect(gaps.some((g) => g.includes("protagonist is unnamed"))).toBe(true);
  });

  it("resolves anchored-first: 'Kaelen — he chose it himself' → 'Kaelen'", () => {
    const r = resolveObservations([obs("pc_name", "Kaelen — he chose it himself")]);
    expect(r.pcName).toBe("Kaelen");
    expect(r.pcNameDeferred).toBe(false);
  });

  it("honorific-led names survive the sentence-period cut (audit #2)", () => {
    expect(resolveObservations([obs("pc_name", "Dr. Elara Voss — the title matters")]).pcName).toBe(
      "Dr. Elara Voss",
    );
    expect(resolveObservations([obs("pc_name", "Lt. Col. Roy Mustang")]).pcName).toBe(
      "Lt. Col. Roy Mustang",
    );
    expect(resolveObservations([obs("pc_name", "Kaelen. He chose it himself.")]).pcName).toBe(
      "Kaelen",
    );
    expect(resolveObservations([obs("pc_name", "Ka'el")]).pcName).toBe("Ka'el");
  });

  it("an explicit deferral overrides an OSP-invented brief name (audit #1)", () => {
    const out = dedupeAdmissions(
      [
        {
          name: "Kaelen",
          kind: "cast",
          brief: "The player's self-insert; a name the OSP invented despite the deferral.",
        },
      ],
      undefined,
      { nameDeferred: true },
    );
    const pc = out.find((a) => a.isPlayerProtagonist);
    expect(pc?.name).toBe("The Protagonist");
  });

  it("the deferral form defers and records a note", () => {
    const r = resolveObservations([
      obs("pc_name", "deferred — the player wants it to emerge in play"),
    ]);
    expect(r.pcName).toBeUndefined();
    expect(r.pcNameDeferred).toBe(true);
    expect(r.deferred.some((d) => d.includes("protagonist name deferred"))).toBe(true);
  });

  it("latest wins on a rename, and a later real name clears an earlier deferral", () => {
    const renamed = resolveObservations([
      obs("pc_name", "Kaelen"),
      obs("pc_name", "Seryn — she renamed the character mid-conversation"),
    ]);
    expect(renamed.pcName).toBe("Seryn");
    expect(renamed.pcNameDeferred).toBe(false);

    const undeferred = resolveObservations([
      obs("pc_name", "deferred — undecided for now"),
      obs("pc_name", "Kaelen"),
    ]);
    expect(undeferred.pcName).toBe("Kaelen");
    expect(undeferred.pcNameDeferred).toBe(false);
    // SV2: the resolved deferral leaves no stale open item behind — the
    // summary must never claim the name is being left open when it isn't.
    expect(undeferred.deferred.some((d) => d.includes("protagonist name deferred"))).toBe(false);
  });
});

describe("character concept resolution + gap (SV2, deterministic)", () => {
  it("gap verdict blocks a conceptless, un-deferred table", () => {
    const gaps = gapVerdict(
      resolveObservations(SCRIPTED_OBSERVATIONS.filter((o) => o.kind !== "pc_concept")),
      true,
    );
    expect(gaps.some((g) => g.includes("concept was never gathered"))).toBe(true);
  });

  it("resolves VERBATIM, latest-wins — never parsed, never truncated", () => {
    const concept =
      "Replace the protagonist: the Straw Hats exist, but the captain's seat is mine. A cook who fights only to feed people.";
    const r = resolveObservations([
      obs("pc_concept", "someone new beside the cast — an early draft"),
      obs("pc_concept", concept),
    ]);
    expect(r.pcConcept).toBe(concept);
    expect(r.pcConceptDeferred).toBe(false);
    // The canon-seat choice rides the concept AND its canonicality
    // observation — both resolve from the same exchange.
    const seat = resolveObservations([
      obs("pc_concept", concept),
      obs(
        "canonicality",
        '{"timeline_mode": "canon_adjacent", "canon_cast_mode": "replaced_protagonist"}',
      ),
    ]);
    expect(seat.canonicality?.canon_cast_mode).toBe("replaced_protagonist");
  });

  it("the deferral form defers, notes it, and passes the gate", () => {
    const r = resolveObservations([
      ...SCRIPTED_OBSERVATIONS.filter((o) => o.kind !== "pc_concept"),
      obs("pc_concept", "deferred — the player wants the character to emerge in play"),
    ]);
    expect(r.pcConcept).toBeUndefined();
    expect(r.pcConceptDeferred).toBe(true);
    expect(r.deferred.some((d) => d.includes("character concept deferred"))).toBe(true);
    expect(gapVerdict(r, true).some((g) => g.includes("concept"))).toBe(false);
  });

  it("a later concrete concept clears an earlier deferral AND its note", () => {
    const r = resolveObservations([
      obs("pc_concept", "deferred — not sure yet"),
      obs("pc_concept", "A talentless underdog who trains harder than anyone"),
    ]);
    expect(r.pcConcept).toContain("underdog");
    expect(r.pcConceptDeferred).toBe(false);
    expect(r.deferred.some((d) => d.includes("character concept deferred"))).toBe(false);
  });

  it("mid-string 'deferred' in verbatim prose is NOT a deferral (the sentinel is anchored)", () => {
    // The concept is free prose — the player's own words may contain the
    // sentinel word. Only a LEADING "deferred" is the player's deferral.
    const prose = "a knight whose dream was deferred until now";
    const r = resolveObservations([obs("pc_concept", prose)]);
    expect(r.pcConcept).toBe(prose);
    expect(r.pcConceptDeferred).toBe(false);
    // Same discipline on the name path (C4 family).
    const named = resolveObservations([
      obs("pc_name", "Kaelen — he deferred the choice for years"),
    ]);
    expect(named.pcName).toBe("Kaelen");
    expect(named.pcNameDeferred).toBe(false);
  });

  it("a curly-single-quoted deferral still defers (the anchor knows every quote form)", () => {
    // Models quote-wrap despite anchoring instructions; the quote-strip on the
    // name path already anticipates ‘…’ — the deferral anchor must too.
    const r = resolveObservations([obs("pc_concept", "‘deferred — let the character emerge’")]);
    expect(r.pcConcept).toBeUndefined();
    expect(r.pcConceptDeferred).toBe(true);
    const name = resolveObservations([obs("pc_name", "‘deferred — no name yet’")]);
    expect(name.pcName).toBeUndefined();
    expect(name.pcNameDeferred).toBe(true);
  });
});

describe("power tier + framing choices (SV3, deterministic)", () => {
  it("power tier resolves with its baseline, latest-wins; malformed and off-ladder defer", () => {
    const r = resolveObservations([
      obs("pc_power_tier", '{"tier": "T7", "baseline": "T8"}'),
      obs("pc_power_tier", '{"tier": "T5", "baseline": "T8"}'),
    ]);
    expect(r.pcPowerTier).toBe("T5");
    expect(r.pcPowerBaseline).toBe("T8");

    const prose = resolveObservations([obs("pc_power_tier", "far above baseline, T3-ish")]);
    expect(prose.pcPowerTier).toBeUndefined();
    expect(prose.deferred.some((d) => d.includes("unparseable power tier"))).toBe(true);
    // Off the T1-T10 ladder never lands a garbage tier on the contract.
    const off = resolveObservations([obs("pc_power_tier", '{"tier": "T11", "baseline": "T8"}')]);
    expect(off.pcPowerTier).toBeUndefined();
    expect(off.deferred.some((d) => d.includes("unparseable power tier"))).toBe(true);
  });

  it("framing choices validate per-axis and win latest; junk defers, never overwrites", () => {
    const r = resolveObservations([
      obs("framing_choice", '{"axis": "tension_source", "value": "burden"}'),
      obs("framing_choice", '{"axis": "tension_source", "value": "existential"}'),
      obs("framing_choice", '{"axis": "narrative_focus", "value": "mundane"}'),
      obs("framing_choice", '{"axis": "mode", "value": "op_dominant"}'),
      // A junk VALUE on a real axis defers and must not clobber the settled pick.
      obs("framing_choice", '{"axis": "tension_source", "value": "vibes"}'),
      // A junk AXIS defers; non-JSON defers.
      obs("framing_choice", '{"axis": "power_level", "value": "high"}'),
      obs("framing_choice", "make it feel like a legend"),
    ]);
    expect(r.framingChoices).toContainEqual({ axis: "tension_source", value: "existential" });
    expect(r.framingChoices).toContainEqual({ axis: "narrative_focus", value: "mundane" });
    expect(r.framingChoices).toContainEqual({ axis: "mode", value: "op_dominant" });
    expect(r.framingChoices).toHaveLength(3);
    expect(r.deferred.filter((d) => d.includes("framing choice"))).toHaveLength(3);
  });
});

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
    // Second source for the hybrid fixture — content reused, identity distinct.
    await db
      .insert(schema.profiles)
      .values({
        id: "test_sz_profile_b",
        title: "Solo Leveling",
        profile: {
          id: "test_sz_profile_b",
          title: "Solo Leveling",
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
      await db.delete(schema.profiles).where(eq(schema.profiles.id, "test_sz_profile_b"));
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

  it("blend choices resolve latest-wins per component; malformed ones defer", () => {
    const resolved = resolveObservations([
      obs("blend", '{"component": "world", "choice": "Solo Leveling"}'),
      obs("blend", '{"component": "framing", "choice": "Cowboy Bebop"}'),
      obs("blend", '{"component": "world", "choice": "Cowboy Bebop"}'),
      obs("blend", "mostly bebop I guess"),
    ]);
    expect(resolved.blendChoices).toContainEqual({ component: "world", choice: "Cowboy Bebop" });
    expect(resolved.blendChoices).toHaveLength(2);
    expect(resolved.deferred.some((d) => d.includes("unparseable blend"))).toBe(true);
  });

  it("a hybrid draft compiles single-source from the player's WORLD pick, recipe carried (M1, user-ratified)", async () => {
    if (!db) throw new Error("unreachable");
    const hybridDraft: ConductorDraft = {
      transcript: [],
      observations: [
        ...SCRIPTED_OBSERVATIONS,
        obs("blend", '{"component": "world", "choice": "Solo Leveling"}'),
        obs("blend", '{"component": "framing", "choice": "Cowboy Bebop"}'),
      ],
      // Bebop was researched FIRST — the world pick must still win the base.
      profileIds: ["test_sz_profile", "test_sz_profile_b"],
      readyToCompile: true,
    };
    const [hybrid] = await db
      .insert(schema.campaigns)
      .values({ playerId, title: "hybrid fixture", status: "draft", szTranscript: hybridDraft })
      .returning();
    if (!hybrid) throw new Error("insert failed");
    try {
      const result = await compileSessionZero(db, hybrid.id, {
        ospSynthesizer: async () => STUB_OSP,
        ingestor: async () => ({ writes: [], flags: [] }),
      });
      expect(result.gaps).toEqual([]);
      expect(result.contract.hybrid_recipe?.world.source_profile_ids).toEqual([
        "test_sz_profile_b",
      ]);
      expect(result.contract.hybrid_recipe?.framing.notes).toContain("Cowboy Bebop");
      expect(result.contract.anchors_used).toContain("test_sz_profile");
    } finally {
      await db.delete(schema.campaigns).where(eq(schema.campaigns.id, hybrid.id));
    }
  });

  it("binds ONE protagonist npc from overlapping self-insert briefs (§6.5)", async () => {
    if (!db) throw new Error("unreachable");
    // Today's live defect: two cast_facts about the self-insert (one backstory-
    // flavored, one capabilities-flavored) plus world facts mentioning him, and
    // the OSP minted the protagonist TWICE under two placeholder names — plus a
    // pair of same-relationship threads under DIFFERENT names.
    const draft: ConductorDraft = {
      transcript: [],
      observations: [
        ...SCRIPTED_OBSERVATIONS,
        // Latest-wins override to the deferral form: this fixture's protagonist
        // stays "The Protagonist" (unnamed by the player's own word), which the
        // dedup assertions below depend on — and proves the deferred path compiles.
        obs("pc_name", "deferred — the player wants the name to emerge in play"),
        obs("cast_fact", "The protagonist was orphaned in the lower wards and never named."),
        obs("cast_fact", "The protagonist can channel stormlight into a blade — a rare ability."),
        obs("world_fact", "The lower wards raised the protagonist and half the crew."),
      ],
      profileIds: ["test_sz_profile"],
      readyToCompile: true,
    };
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        playerId,
        title: "protagonist dedup fixture",
        status: "draft",
        szTranscript: draft,
      })
      .returning();
    if (!campaign) throw new Error("insert failed");
    const PROTAGONIST_STUB = {
      ...STUB_OSP,
      briefs: [
        {
          name: "The Protagonist (unnamed)",
          kind: "cast" as const,
          brief: "Orphaned in the lower wards; carries a dead mentor's compass. Never named.",
          admit_to_catalog: true,
        },
        {
          name: "player's protagonist",
          kind: "cast" as const,
          brief: "A duelist whose ability channels stormlight into a blade.",
          admit_to_catalog: true,
        },
        {
          name: "Lloyd and protagonist connection",
          kind: "thread" as const,
          brief: "Their paths keep tangling on the docks.",
          admit_to_catalog: true,
        },
        {
          name: "Path-Crossing with Lloyd",
          kind: "thread" as const,
          brief: "Lloyd reappears wherever the crew lands.",
          admit_to_catalog: true,
        },
      ],
    };
    try {
      const result = await compileSessionZero(db, campaign.id, {
        ospSynthesizer: async () => PROTAGONIST_STUB,
        // No-op ingestor: the dedup under test is the brief-admission path, kept
        // isolated from ingestion-minted entities (§6.5 fix scope).
        ingestor: async () => ({ writes: [], flags: [] }),
      });
      expect(result.gaps).toEqual([]);

      const rows = await db
        .select()
        .from(schema.entities)
        .where(eq(schema.entities.campaignId, campaign.id));
      const npcs = rows.filter((e) => e.entityType === "npc");
      // Exactly ONE protagonist npc, carrying BOTH facts' material.
      expect(npcs).toHaveLength(1);
      expect(npcs[0]?.name).toBe("The Protagonist");
      expect(npcs[0]?.block).toContain("lower wards");
      expect(npcs[0]?.block).toContain("stormlight");
      // Its version-1 row mirrors the merged block (rewind base intact).
      const versions = await db
        .select()
        .from(schema.entityVersions)
        .where(eq(schema.entityVersions.entityId, npcs[0]?.id ?? ""));
      expect(versions).toHaveLength(1);
      expect(versions[0]?.block).toBe(npcs[0]?.block);
      // The two same-relationship threads have DIFFERENT names — deterministic
      // dedup leaves them as two rows (M2 semantic-alias territory).
      const threads = rows.filter((e) => e.entityType === "thread");
      expect(threads).toHaveLength(2);
    } finally {
      await db.delete(schema.campaigns).where(eq(schema.campaigns.id, campaign.id));
    }
  });

  it("a named PC seeds the protagonist row EXACTLY that name, state-stamped; the OSP gets the name (M2 C4)", async () => {
    if (!db) throw new Error("unreachable");
    const named: ConductorDraft = {
      transcript: [],
      observations: [
        ...SCRIPTED_OBSERVATIONS.filter((o) => o.kind !== "pc_name"),
        obs("pc_name", "Kaelen — he chose it himself"),
      ],
      profileIds: ["test_sz_profile"],
      readyToCompile: true,
    };
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ playerId, title: "named pc fixture", status: "draft", szTranscript: named })
      .returning();
    if (!campaign) throw new Error("insert failed");
    const NAMED_STUB = {
      ...STUB_OSP,
      briefs: [
        {
          name: "The Protagonist (unnamed)",
          kind: "cast" as const,
          brief: "The player's self-insert; a wandering blade who carries a dead mentor's compass.",
          admit_to_catalog: true,
        },
      ],
    };
    let seenPcName: string | undefined;
    let seenPcConcept: string | undefined;
    try {
      const result = await compileSessionZero(db, campaign.id, {
        ospSynthesizer: async (input) => {
          seenPcName = input.resolved.pcName;
          seenPcConcept = input.resolved.pcConcept;
          return NAMED_STUB;
        },
        ingestor: async () => ({ writes: [], flags: [] }),
      });
      expect(result.gaps).toEqual([]);
      // The OSP synthesizer receives the name (briefs/opening can use it) —
      // and the concept (SV2: the protagonist brief's anchor).
      expect(seenPcName).toBe("Kaelen");
      expect(seenPcConcept).toContain("bounty hunter");

      const npcs = await db
        .select()
        .from(schema.entities)
        .where(
          and(eq(schema.entities.campaignId, campaign.id), eq(schema.entities.entityType, "npc")),
        );
      expect(npcs).toHaveLength(1);
      // The row is named EXACTLY the player's word.
      expect(npcs[0]?.name).toBe("Kaelen");
      // …and stamped so the resolver's protagonist alias survives the real name.
      expect((npcs[0]?.state as { is_player_protagonist?: boolean })?.is_player_protagonist).toBe(
        true,
      );
    } finally {
      await db.delete(schema.campaigns).where(eq(schema.campaigns.id, campaign.id));
    }
  });

  it("a deferred PC compiles: row stays 'The Protagonist', the deferral note is recorded (M2 C4)", async () => {
    if (!db) throw new Error("unreachable");
    const deferredDraft: ConductorDraft = {
      transcript: [],
      observations: [
        ...SCRIPTED_OBSERVATIONS.filter((o) => o.kind !== "pc_name"),
        obs("pc_name", "deferred — the player wants the name to emerge in play"),
      ],
      profileIds: ["test_sz_profile"],
      readyToCompile: true,
    };
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        playerId,
        title: "deferred pc fixture",
        status: "draft",
        szTranscript: deferredDraft,
      })
      .returning();
    if (!campaign) throw new Error("insert failed");
    const DEFERRED_STUB = {
      ...STUB_OSP,
      briefs: [
        {
          name: "player's protagonist",
          kind: "cast" as const,
          brief: "The self-insert lead, as yet unnamed.",
          admit_to_catalog: true,
        },
      ],
    };
    let seenDeferred: string[] = [];
    try {
      const result = await compileSessionZero(db, campaign.id, {
        ospSynthesizer: async (input) => {
          seenDeferred = [...input.resolved.deferred];
          return DEFERRED_STUB;
        },
        ingestor: async () => ({ writes: [], flags: [] }),
      });
      expect(result.gaps).toEqual([]);
      // The deferral surfaces to the OSP (and the conductor's open-items summary).
      expect(seenDeferred.some((d) => d.includes("protagonist name deferred"))).toBe(true);

      const npcs = await db
        .select()
        .from(schema.entities)
        .where(
          and(eq(schema.entities.campaignId, campaign.id), eq(schema.entities.entityType, "npc")),
        );
      expect(npcs).toHaveLength(1);
      expect(npcs[0]?.name).toBe("The Protagonist");
    } finally {
      await db.delete(schema.campaigns).where(eq(schema.campaigns.id, campaign.id));
    }
  });

  it("a gap-≥2 table compiles: tier on the contract, framing moves override ACTIVE only (SV3)", async () => {
    if (!db) throw new Error("unreachable");
    const opDraft: ConductorDraft = {
      transcript: [],
      observations: [
        ...SCRIPTED_OBSERVATIONS,
        obs("pc_power_tier", '{"tier": "T5", "baseline": "T8"}'),
        obs("framing_choice", '{"axis": "tension_source", "value": "burden"}'),
        obs("framing_choice", '{"axis": "mode", "value": "op_dominant"}'),
      ],
      profileIds: ["test_sz_profile"],
      readyToCompile: true,
    };
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({ playerId, title: "op tier fixture", status: "draft", szTranscript: opDraft })
      .returning();
    if (!campaign) throw new Error("insert failed");
    let seenTier: string | undefined;
    try {
      const result = await compileSessionZero(db, campaign.id, {
        ospSynthesizer: async (input) => {
          seenTier = input.resolved.pcPowerTier;
          return STUB_OSP;
        },
        ingestor: async () => ({ writes: [], flags: [] }),
      });
      expect(result.gaps).toEqual([]);
      // The circuit's contract half: the chosen tier lands, typed.
      expect(result.contract.pc_power_tier).toBe("T5");
      // Framing moves land as ACTIVE-layer overrides; canonical keeps the
      // source's own framing (calibration's exact discipline).
      expect(result.contract.active.framing.tension_source).toBe("burden");
      expect(result.contract.active.framing.mode).toBe("op_dominant");
      expect(result.contract.canonical.framing.tension_source).toBe("existential");
      expect(result.contract.canonical.framing.mode).toBe("standard");
      // The OSP hears about the elevation (no struggle-scene cold opens).
      expect(seenTier).toBe("T5");
    } finally {
      await db.delete(schema.campaigns).where(eq(schema.campaigns.id, campaign.id));
    }
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
    // The C6 rebind (§5.4): SZ facts flow through the SAME ingestion seam as
    // gameplay. Stubbed here; its clarify must land in the OSP's deferred
    // context (an unanswerable question becomes an uncertainty, not silence).
    const ingestCalls: { text: string; provenance?: string; profileIds: string[] }[] = [];
    let ospDeferred: string[] = [];
    const result = await compileSessionZero(db, campaignId, {
      ingestor: async (_db, _cid, turnNumber, text, opts) => {
        expect(turnNumber).toBe(0);
        ingestCalls.push({ text, provenance: opts.provenance, profileIds: opts.profileIds });
        return {
          writes: [{ kind: "semantic_fact", id: "x", summary: "stubbed" }],
          clarify: "does the trawler have grav-plating?",
          flags: ["tier-inflation watch: 'best pilot in the system'"],
        };
      },
      ospSynthesizer: async (input) => {
        ospDeferred = [...input.resolved.deferred];
        return STUB_OSP;
      },
    });
    expect(ingestCalls).toHaveLength(1);
    expect(ingestCalls[0]?.text).toContain("fishing trawler");
    expect(ingestCalls[0]?.provenance).toBe("sz_compiler");
    expect(ingestCalls[0]?.profileIds).toContain("test_sz_profile");
    expect(ospDeferred.some((d) => d.includes("grav-plating"))).toBe(true);
    expect(ospDeferred.some((d) => d.includes("tier-inflation"))).toBe(true);
    expect(result.gaps).toEqual([]);
    expect(result.contract.spark).toContain("whatever happens");
    expect(result.contract.active.treatment.darkness).toBe(8); // player's move
    expect(result.contract.canonical.treatment.darkness).toBe(7); // profile untouched
    // SV3 no-regression: a tier-less draft compiles with NO pc_power_tier —
    // layout falls back to the world baseline exactly as before.
    expect(result.contract.pc_power_tier).toBeUndefined();
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
      compileSessionZero(db, campaignId, {
        ospSynthesizer: async () => STUB_OSP,
        ingestor: async () => ({ writes: [], flags: [] }),
      }),
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

    // SZ admission is a minting authority: creation writes version 1 so the
    // rewind block-restore always has a base (C6 re-audit — an unversioned
    // mint leaves the block unrestorable once later enrichments tombstone).
    const trawlerEntity = admitted.find((e) => e.name === "The Trawler");
    const trawlerVersions = await db
      .select()
      .from(schema.entityVersions)
      .where(eq(schema.entityVersions.entityId, trawlerEntity?.id ?? ""));
    expect(trawlerVersions).toHaveLength(1);
    expect(trawlerVersions[0]?.version).toBe(1);
    expect(trawlerVersions[0]?.block).toBe(trawlerEntity?.block);

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

  it("the compile claim is exclusive: a live 'compiling' blocks, a stale one re-claims", async () => {
    if (!db) throw new Error("unreachable");
    // Simulate a compile in flight: the claim was stamped moments ago.
    await db
      .update(schema.campaigns)
      .set({ status: "compiling", updatedAt: new Date() })
      .where(eq(schema.campaigns.id, campaignId));
    await expect(
      compileSessionZero(db, campaignId, {
        ospSynthesizer: async () => STUB_OSP,
        ingestor: async () => ({ writes: [], flags: [] }),
      }),
    ).rejects.toThrow(/already in flight/);
    // The loser lost BEFORE any side effect — it must NOT have reverted the
    // winner's claim (the C6 re-audit sabotage mode: a loser's catch flipping
    // compiling→draft fails the winner's own compiling→active transaction).
    const [held] = await db
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId));
    expect(held?.status).toBe("compiling");

    // A CRASHED compile (stale claim, no process left to revert it) stays
    // retryable: past the staleness window the claim is taken over.
    await db
      .update(schema.campaigns)
      .set({ updatedAt: new Date(Date.now() - 6 * 60 * 1000) })
      .where(eq(schema.campaigns.id, campaignId));
    const result = await compileSessionZero(db, campaignId, {
      ospSynthesizer: async () => STUB_OSP,
      ingestor: async () => ({ writes: [], flags: [] }),
    });
    expect(result.gaps).toEqual([]);
    const [after] = await db
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId));
    expect(after?.status).toBe("active");
  });
});
