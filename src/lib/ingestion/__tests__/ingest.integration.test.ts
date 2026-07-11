import * as schema from "@/lib/db/schema";
import { callProbe } from "@/lib/llm/calls";
import { EMBEDDING_DIMENSIONS } from "@/lib/llm/embedding-config";
import { embedTexts } from "@/lib/llm/voyage";
import { bebopContract } from "@/lib/renderer/__tests__/fixtures";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CANON_MATCH_DISTANCE, ingestAssertion } from "../ingest";

/**
 * Universal ingestion (§5.4, §6.5) against real Postgres with a scripted
 * extractor and deterministic basis-vector embeddings. Pins: the "The
 * Syndicate" resolver (canon link, no duplicate on re-mention), the ACCEPT
 * default with the exact provenance envelope, CLARIFY writing nothing, FLAG
 * writing + surfacing, and the envelope on every write.
 */

vi.mock("@/lib/llm/calls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/calls")>();
  return { ...actual, callProbe: vi.fn() };
});
vi.mock("@/lib/llm/voyage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/voyage")>();
  return { ...actual, embedTexts: vi.fn() };
});

const url = process.env.DATABASE_URL;
if (!url) console.warn("[ingestion] DATABASE_URL not set — skipping");
const pool = url ? new Pool({ connectionString: url, max: 4 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

const mockProbe = vi.mocked(callProbe);
const mockEmbed = vi.mocked(embedTexts);

/** Basis vector: 1 at index i, orthogonal to every other basis vector. */
function basis(i: number): number[] {
  const v = new Array(EMBEDDING_DIMENSIONS).fill(0);
  v[i] = 1;
  return v;
}

interface ScriptedFact {
  kind: string;
  entity_name?: string;
  content: string;
  posture: string;
  posture_reason?: string;
  /** §5.4 C2 relational anchor — the exact catalog name a NEW entity hangs off. */
  related_to_entity?: string;
}

/** Script the single extractor probe call for one assertion. */
function armExtractor(facts: ScriptedFact[]) {
  // biome-ignore lint/suspicious/noExplicitAny: harness spans the generic probe signature
  mockProbe.mockImplementation((_s: any, _o: any) => Promise.resolve({ facts }) as never);
}

/** The prompt the extractor probe was called with — for dossier inspection. */
function extractorPrompt(): string {
  const call = mockProbe.mock.calls.find(
    (c) => (c[1] as { name?: string })?.name === "world_assertion_extract",
  );
  if (!call) throw new Error("extractor probe was not called");
  return (call[1] as { prompt: string }).prompt;
}

describe.skipIf(!url)("Universal ingestion (real Postgres, scripted extractor)", () => {
  const playerId = `test_player_${crypto.randomUUID()}`;
  // Profile-keyed canon lives outside the campaign cascade — randomize + clean.
  const profileId = `test_profile_${crypto.randomUUID()}`;
  let campaignId: string;

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.players).values({ id: playerId, email: "ingestion@example.com" });
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        playerId,
        title: "Ingestion fixture",
        status: "active",
        premiseContract: bebopContract(),
        // Sonnet/Haiku only — never Fable in tests (standing directive).
        tierModels: {
          narration: "claude-sonnet-5",
          judgment: "claude-sonnet-5",
          probe: "claude-haiku-4-5",
        },
      })
      .returning();
    if (!campaign) throw new Error("campaign insert failed");
    campaignId = campaign.id;
  });

  afterAll(async () => {
    if (!db || !pool) return;
    try {
      await db.delete(schema.campaigns).where(eq(schema.campaigns.id, campaignId));
      await db.delete(schema.canonChunks).where(eq(schema.canonChunks.profileId, profileId));
      await db.delete(schema.players).where(eq(schema.players.id, playerId));
    } finally {
      await pool.end();
    }
  });

  beforeEach(async () => {
    if (!db) throw new Error("unreachable");
    mockProbe.mockReset();
    mockEmbed.mockReset();
    // Default: every text embeds to basis(0). Tests override as needed.
    mockEmbed.mockImplementation(async (texts: string[]) => texts.map(() => basis(0)));
    // Deleting entities cascades entity_versions; clean semantic + canon too.
    await db
      .delete(schema.semanticMemories)
      .where(eq(schema.semanticMemories.campaignId, campaignId));
    await db.delete(schema.entities).where(eq(schema.entities.campaignId, campaignId));
    await db.delete(schema.canonChunks).where(eq(schema.canonChunks.profileId, profileId));
  });

  it("resolver: 'The Syndicate' links to canon and never duplicates on re-mention", async () => {
    if (!db) throw new Error("unreachable");
    // Canon chunk for The Syndicate; NO existing catalog entity for it.
    await db.insert(schema.canonChunks).values({
      profileId,
      pageType: "factions",
      title: "The Syndicate",
      content:
        "The Red Dragon Crime Syndicate is the dominant criminal organization of the Solar System, ruled by a council of Elders. Spike Spiegel and Vicious both rose through its ranks.",
      embedding: basis(0),
      turnId: 0,
      provenance: "sz_research",
      confidence: 1,
    });

    armExtractor([
      {
        kind: "faction",
        entity_name: "The Syndicate",
        content: "The raiders were bolstered by The Syndicate's new leader.",
        posture: "accept",
      },
    ]);

    const first = await ingestAssertion(
      db,
      campaignId,
      1,
      "the raiders were bolstered by The Syndicate's new leader",
      { profileIds: [profileId] },
    );

    // One entity minted (linked to canon), plus the semantic fact.
    const created = first.writes.filter((w) => w.kind === "entity_created");
    expect(created).toHaveLength(1);
    expect(first.writes.some((w) => w.kind === "semantic_fact")).toBe(true);

    const rows1 = await db
      .select()
      .from(schema.entities)
      .where(
        and(eq(schema.entities.campaignId, campaignId), eq(schema.entities.name, "The Syndicate")),
      );
    expect(rows1).toHaveLength(1);
    const entity = rows1[0];
    if (!entity) throw new Error("entity missing");
    // Block derives from CANON content (link, don't invent), not the paraphrase.
    expect(entity.block).toContain("Red Dragon");
    expect(entity.block).toContain("canon:");
    expect(entity.block).not.toContain("raiders were bolstered");
    expect(entity.entityType).toBe("faction");

    // Second assertion mentioning it again → enrich, NOT a second row.
    armExtractor([
      {
        kind: "faction",
        entity_name: "The Syndicate",
        content: "The Syndicate now taxes every jump gate in the Belt.",
        posture: "accept",
      },
    ]);
    const second = await ingestAssertion(db, campaignId, 2, "the syndicate taxes the gates now", {
      profileIds: [profileId],
    });
    expect(second.writes.some((w) => w.kind === "entity_enriched")).toBe(true);
    expect(second.writes.some((w) => w.kind === "entity_created")).toBe(false);

    const rows2 = await db
      .select()
      .from(schema.entities)
      .where(
        and(eq(schema.entities.campaignId, campaignId), eq(schema.entities.name, "The Syndicate")),
      );
    expect(rows2).toHaveLength(1); // still exactly one — never duplicated
    expect(rows2[0]?.block).toContain("taxes every jump gate"); // appended

    // Creation writes version 1 (rewind's restore base — C6 audit);
    // enrichment stacks version 2.
    const versions = await db
      .select()
      .from(schema.entityVersions)
      .where(eq(schema.entityVersions.entityId, entity.id))
      .orderBy(schema.entityVersions.version);
    expect(versions).toHaveLength(2);
    expect(versions[0]?.version).toBe(1);
    expect(versions[0]?.turnId).toBe(1); // creation turn
    expect(versions[1]?.version).toBe(2);
    expect(versions[1]?.turnId).toBe(2); // enrichment turn
  });

  it("resolver: a weak/absent canon hit mints a plain entity from the assertion", async () => {
    if (!db) throw new Error("unreachable");
    // Canon chunk is ORTHOGONAL to the query embedding → distance 1 ≥ 0.45.
    await db.insert(schema.canonChunks).values({
      profileId,
      pageType: "factions",
      title: "The Syndicate",
      content: "Unrelated canon body.",
      embedding: basis(3),
      turnId: 0,
      provenance: "sz_research",
      confidence: 1,
    });
    mockEmbed.mockImplementation(async (texts: string[]) => texts.map(() => basis(0)));
    armExtractor([
      {
        kind: "faction",
        entity_name: "The Blue Crows",
        content: "The Blue Crows are a rival bounty crew flying a converted gunship.",
        posture: "accept",
      },
    ]);
    const res = await ingestAssertion(db, campaignId, 3, "the blue crows showed up", {
      profileIds: [profileId],
    });
    expect(res.writes.some((w) => w.kind === "entity_created")).toBe(true);
    const [row] = await db
      .select()
      .from(schema.entities)
      .where(
        and(eq(schema.entities.campaignId, campaignId), eq(schema.entities.name, "The Blue Crows")),
      );
    // No canon link — block is the player's assertion, no canon tag.
    expect(row?.block).toContain("rival bounty crew");
    expect(row?.block).not.toContain("canon:");
    expect(CANON_MATCH_DISTANCE).toBe(0.45);
  });

  it("resolver: protagonist placeholder spellings enrich the ONE PC row (§6.5)", async () => {
    if (!db) throw new Error("unreachable");
    // The live turn-3 defect: catalog held "The Protagonist (unnamed)" and an
    // assertion about "the protagonist" exact-missed it, minting a third row.
    await db.insert(schema.entities).values({
      campaignId,
      name: "The Protagonist (unnamed)",
      entityType: "npc",
      block: "Player's self-insert; street-rat.",
      turnId: 0,
      provenance: "sz_compiler",
      confidence: 1,
    });
    armExtractor([
      {
        kind: "cast_fact",
        entity_name: "the protagonist",
        content: "The protagonist rotates his enchanted wells to stay hidden.",
        posture: "accept",
      },
    ]);
    const result = await ingestAssertion(db, campaignId, 3, "I rotate the wells.", {
      profileIds: [],
    });
    expect(result.writes.some((w) => w.kind === "entity_enriched")).toBe(true);
    expect(result.writes.some((w) => w.kind === "entity_created")).toBe(false);
    const pcRows = await db
      .select()
      .from(schema.entities)
      .where(
        and(eq(schema.entities.campaignId, campaignId), eq(schema.entities.entityType, "npc")),
      );
    expect(pcRows).toHaveLength(1);
    expect(pcRows[0]?.block).toContain("rotates his enchanted wells");
  });

  it("ACCEPT default: a bare world fact writes a semantic row with the exact envelope", async () => {
    if (!db) throw new Error("unreachable");
    armExtractor([
      {
        kind: "world_fact",
        content: "Terra Firma's dust storms have grown worse this season.",
        posture: "accept",
      },
    ]);
    const res = await ingestAssertion(
      db,
      campaignId,
      4,
      "the storms on terra firma are worse now",
      {
        profileIds: [profileId],
      },
    );
    expect(res.clarify).toBeUndefined();
    expect(res.flags).toHaveLength(0);
    expect(res.writes.filter((w) => w.kind === "entity_created")).toHaveLength(0);
    expect(res.writes.some((w) => w.kind === "semantic_fact")).toBe(true);

    const [mem] = await db
      .select()
      .from(schema.semanticMemories)
      .where(eq(schema.semanticMemories.campaignId, campaignId));
    expect(mem?.content).toContain("dust storms");
    expect(mem?.category).toBe("world_state");
    expect(mem?.baseHeat).toBe(100);
    expect(mem?.heatFloor).toBe(1);
    expect(mem?.lastBoostedTurn).toBe(4);
    expect(mem?.turnId).toBe(4);
    expect(mem?.provenance).toBe("player_assertion");
    expect(mem?.confidence).toBe(1);
  });

  it("CLARIFY: writes nothing and returns the question", async () => {
    if (!db) throw new Error("unreachable");
    armExtractor([
      {
        kind: "location",
        entity_name: "the derelict",
        content: "The derelict the crew is boarding is the Ganymede freighter.",
        posture: "clarify",
        posture_reason: "Do you mean the derelict on Mars or the one drifting past Ganymede?",
      },
    ]);
    const res = await ingestAssertion(db, campaignId, 5, "we board the derelict", {
      profileIds: [profileId],
    });
    expect(res.clarify).toContain("Mars or the one");
    expect(res.writes).toHaveLength(0);
    expect(res.flags).toHaveLength(0);

    const mems = await db
      .select()
      .from(schema.semanticMemories)
      .where(eq(schema.semanticMemories.campaignId, campaignId));
    expect(mems).toHaveLength(0);
    const ents = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.campaignId, campaignId));
    expect(ents).toHaveLength(0);
  });

  it("FLAG: writes normally AND surfaces the craft note", async () => {
    if (!db) throw new Error("unreachable");
    armExtractor([
      {
        kind: "cast_fact",
        entity_name: "Slayer",
        content: "Slayer destroyed an ISSP cruiser single-handedly with a sidearm.",
        posture: "flag",
        posture_reason:
          "Tier-inflation: a lone gunman one-shotting a cruiser breaks the world's scale.",
      },
    ]);
    const res = await ingestAssertion(db, campaignId, 6, "slayer wrecked the cruiser alone", {
      profileIds: [],
    });
    expect(res.flags).toHaveLength(1);
    expect(res.flags[0]).toContain("Tier-inflation");
    // Flagged fact still writes: entity + semantic.
    expect(res.writes.some((w) => w.kind === "entity_created")).toBe(true);
    expect(res.writes.some((w) => w.kind === "semantic_fact")).toBe(true);

    const [ent] = await db
      .select()
      .from(schema.entities)
      .where(and(eq(schema.entities.campaignId, campaignId), eq(schema.entities.name, "Slayer")));
    expect(ent?.entityType).toBe("npc");
    const mems = await db
      .select()
      .from(schema.semanticMemories)
      .where(eq(schema.semanticMemories.campaignId, campaignId));
    expect(mems).toHaveLength(1);
    expect(mems[0]?.category).toBe("fact");
  });

  it("every write carries the provenance envelope {turnId, provenance, confidence}", async () => {
    if (!db) throw new Error("unreachable");
    // Create on turn 7 with a custom provenance (the SZ caller's channel)…
    armExtractor([
      {
        kind: "faction",
        entity_name: "The Blue Crows",
        content: "The Blue Crows are a rival bounty crew.",
        posture: "accept",
      },
    ]);
    await ingestAssertion(db, campaignId, 7, "the blue crows are rivals", {
      profileIds: [],
      provenance: "sz_extraction",
    });
    // …then enrich on turn 8.
    armExtractor([
      {
        kind: "faction",
        entity_name: "The Blue Crows",
        content: "The Blue Crows fly a converted gunship.",
        posture: "accept",
      },
    ]);
    await ingestAssertion(db, campaignId, 8, "their ship is a gunship", {
      profileIds: [],
      provenance: "sz_extraction",
    });

    const [ent] = await db
      .select()
      .from(schema.entities)
      .where(
        and(eq(schema.entities.campaignId, campaignId), eq(schema.entities.name, "The Blue Crows")),
      );
    if (!ent) throw new Error("entity missing");
    expect(ent.turnId).toBe(7); // envelope from creation
    expect(ent.provenance).toBe("sz_extraction");
    expect(ent.confidence).toBe(1);

    const versions = await db
      .select()
      .from(schema.entityVersions)
      .where(eq(schema.entityVersions.entityId, ent.id))
      .orderBy(schema.entityVersions.version);
    expect(versions).toHaveLength(2); // v1 creation + v2 enrichment
    expect(versions[0]?.turnId).toBe(7); // creation turn
    expect(versions[1]?.turnId).toBe(8); // the enrichment turn
    for (const v of versions) {
      expect(v.provenance).toBe("sz_extraction");
      expect(v.confidence).toBe(1);
    }

    const mems = await db
      .select()
      .from(schema.semanticMemories)
      .where(eq(schema.semanticMemories.campaignId, campaignId));
    expect(mems).toHaveLength(2);
    for (const m of mems) {
      expect([7, 8]).toContain(m.turnId);
      expect(m.provenance).toBe("sz_extraction");
      expect(m.confidence).toBe(1);
    }
  });

  it("mint-time guard: a semantic near-dup enriches the existing row instead of minting (§6.5)", async () => {
    if (!db) throw new Error("unreachable");
    // The live exhibit: an existing thread the deterministic tier can't match to
    // a differently-named assertion about the same connection.
    await db.insert(schema.entities).values({
      campaignId,
      name: "Path-Crossing with Lloyd",
      entityType: "thread",
      block: "The protagonist and Lloyd keep crossing paths.",
      turnId: 0,
      provenance: "sz_compiler",
      confidence: 1,
    });
    // All names embed to basis(0) → the candidate sits within the guard's
    // distance; the probe confirms "same" at the AUTO bar → ENRICH. (C1 audit
    // #4: the guard enriches only above MERGE_AUTO_CONFIDENCE — a false enrich
    // silently swallows a new entity, while a false mint gets janitor'd.)
    const scriptPair = (confidence: number, name: string) =>
      mockProbe.mockImplementation(
        // biome-ignore lint/suspicious/noExplicitAny: harness spans the generic probe signature
        (_s: any, o: any) =>
          (o.name === "entity_merge_pair"
            ? Promise.resolve({ same: true, confidence, reason: "same forming bond" })
            : Promise.resolve({
                facts: [
                  {
                    kind: "thread",
                    entity_name: name,
                    content: "Their bond deepens after the duel.",
                    posture: "accept",
                  },
                ],
              })) as never,
      );

    scriptPair(0.95, "Lloyd and the protagonist's connection");
    const res = await ingestAssertion(db, campaignId, 9, "the bond with lloyd deepens", {
      profileIds: [],
    });

    expect(res.writes.some((w) => w.kind === "entity_enriched")).toBe(true);
    expect(res.writes.some((w) => w.kind === "entity_created")).toBe(false);
    const threads = await db
      .select()
      .from(schema.entities)
      .where(
        and(eq(schema.entities.campaignId, campaignId), eq(schema.entities.entityType, "thread")),
      );
    expect(threads).toHaveLength(1); // guard prevented the parallel mint
    expect(threads[0]?.block).toContain("Their bond deepens after the duel.");

    // Mid-band (suggest < confidence < auto): the guard MINTS — ambiguity is
    // the janitor's territory at session close, never a silent swallow.
    scriptPair(0.8, "The Lloyd Entanglement");
    const mid = await ingestAssertion(db, campaignId, 10, "the entanglement deepens", {
      profileIds: [],
    });
    expect(mid.writes.some((w) => w.kind === "entity_created")).toBe(true);
    const threadsAfter = await db
      .select()
      .from(schema.entities)
      .where(
        and(eq(schema.entities.campaignId, campaignId), eq(schema.entities.entityType, "thread")),
      );
    expect(threadsAfter).toHaveLength(2);
  });

  it("empty-normalization guard: '???' and '!!!' stay separate rows (§6.5)", async () => {
    if (!db) throw new Error("unreachable");
    // Both names normalize to "" — the keying guard must give each its own
    // identity (they are not the same entity), and the mint-guard skips them.
    armExtractor([
      {
        kind: "cast_fact",
        entity_name: "???",
        content: "A cloaked figure watches from the rafters.",
        posture: "accept",
      },
      {
        kind: "cast_fact",
        entity_name: "!!!",
        content: "A second figure signals from the street.",
        posture: "accept",
      },
    ]);

    const res = await ingestAssertion(db, campaignId, 10, "two strangers appear", {
      profileIds: [],
    });

    expect(res.writes.filter((w) => w.kind === "entity_created")).toHaveLength(2);
    const npcs = await db
      .select()
      .from(schema.entities)
      .where(
        and(eq(schema.entities.campaignId, campaignId), eq(schema.entities.entityType, "npc")),
      );
    expect(npcs).toHaveLength(2);
    expect(npcs.map((r) => r.name).sort()).toEqual(["!!!", "???"]);
  });

  it("dossier (C2): protagonist line, thread group, and arc line ride the extractor prompt", async () => {
    if (!db) throw new Error("unreachable");
    // A placeholder-named PC (isProtagonistName over npc rows) + a live thread.
    await db.insert(schema.entities).values([
      {
        campaignId,
        name: "The Protagonist (unnamed)",
        entityType: "npc",
        block: "Street-rat turned reluctant blade; hunts the raiders who razed his village.",
        turnId: 0,
        provenance: "sz_compiler",
        confidence: 1,
      },
      {
        campaignId,
        name: "The Debt to Lloyd",
        entityType: "thread",
        block: "An unpaid favor hangs between them, sharpening every meeting.",
        turnId: 2,
        provenance: "sz_compiler",
        confidence: 1,
      },
    ]);
    armExtractor([]); // we only inspect the prompt the extractor received
    await ingestAssertion(db, campaignId, 11, "I ready my blade", {
      profileIds: [],
      arcLine: "The Reckoning — will he avenge his mother?",
    });

    const prompt = extractorPrompt();
    expect(prompt).toContain("THE PLAYER'S PROTAGONIST");
    expect(prompt).toContain("The Protagonist (unnamed)");
    // Block head rides the line (~100 chars), grouped under the protagonist.
    expect(prompt).toContain("Street-rat turned reluctant blade");
    // Threads are their own labeled group (the Director's live material).
    expect(prompt).toContain("THREADS");
    expect(prompt).toContain("The Debt to Lloyd");
    expect(prompt).toContain("ACTIVE ARC: The Reckoning — will he avenge his mother?");
  });

  it("relational binding (C2): exact catalog name enriches; a new relation mints with state seeded", async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.entities).values([
      {
        campaignId,
        name: "The Protagonist's Mother",
        entityType: "npc",
        block: "Slain in the raid on his village.",
        turnId: 0,
        provenance: "sz_compiler",
        confidence: 1,
      },
      {
        campaignId,
        name: "The Gaunt Warden",
        entityType: "npc",
        block: "The towering monster the crew now duels.",
        turnId: 1,
        provenance: "player_assertion",
        confidence: 1,
      },
    ]);

    // (a) A relational reference that RESOLVES to the catalog → enrich the one row.
    armExtractor([
      {
        kind: "cast_fact",
        entity_name: "The Protagonist's Mother",
        content: "His mother sang to him every night before the fire took her.",
        posture: "accept",
      },
    ]);
    const enrich = await ingestAssertion(db, campaignId, 11, "for my mother, who sang to me", {
      profileIds: [],
    });
    expect(enrich.writes.some((w) => w.kind === "entity_enriched")).toBe(true);
    expect(enrich.writes.some((w) => w.kind === "entity_created")).toBe(false);

    // (b) A genuinely NEW entity + related_to_entity → mint with the relation
    // seeded into state (turn-keyed, G1's shape).
    armExtractor([
      {
        kind: "thread",
        entity_name: "The Warden's Master",
        content: "The Gaunt Warden answers to a hidden master who ordered the massacre.",
        posture: "accept",
        related_to_entity: "The Gaunt Warden",
      },
    ]);
    const mint = await ingestAssertion(db, campaignId, 12, "for everyone your master killed", {
      profileIds: [],
    });
    expect(mint.writes.some((w) => w.kind === "entity_created")).toBe(true);

    const [master] = await db
      .select()
      .from(schema.entities)
      .where(
        and(
          eq(schema.entities.campaignId, campaignId),
          eq(schema.entities.name, "The Warden's Master"),
        ),
      );
    expect(master?.entityType).toBe("thread");
    const state = (master?.state ?? {}) as { relationships?: Record<string, string> };
    expect(state.relationships?.["12"]).toContain("related to The Gaunt Warden");
  });

  it("the scream (C2 golden): mother enriches, master mints bound to the monster — no parallel mother", async () => {
    if (!db) throw new Error("unreachable");
    await db.insert(schema.entities).values([
      {
        campaignId,
        name: "The Protagonist's Mother",
        entityType: "npc",
        block: "Died in the massacre he swears to avenge.",
        turnId: 0,
        provenance: "sz_compiler",
        confidence: 1,
      },
      {
        campaignId,
        name: "The Gaunt Warden",
        entityType: "npc",
        block: "The monster looming over the battlefield.",
        turnId: 1,
        provenance: "player_assertion",
        confidence: 1,
      },
    ]);
    const scream =
      "I WILL NOT LOSE! FOR MY MOTHER! FOR THE CHILDREN THAT DIED! FOR EVERYONE YOUR MASTER KILLED!";
    // The dossier resolves "my mother" to the catalog; "your master" is NEW
    // canon bound to the monster the fight is against.
    armExtractor([
      {
        kind: "cast_fact",
        entity_name: "The Protagonist's Mother",
        content: "The protagonist's mother is among the dead he fights to avenge.",
        posture: "accept",
      },
      {
        kind: "world_fact",
        content: "Children died in the massacre the protagonist is avenging.",
        posture: "accept",
      },
      {
        kind: "thread",
        entity_name: "The Warden's Master",
        content: "The Gaunt Warden serves a hidden master who ordered the killings.",
        posture: "accept",
        related_to_entity: "The Gaunt Warden",
      },
    ]);
    const res = await ingestAssertion(db, campaignId, 13, scream, {
      profileIds: [],
      arcLine: "The Reckoning — will he avenge the fallen?",
    });

    // Mother: enriched, and exactly one mother-named npc row survives.
    expect(res.writes.some((w) => w.kind === "entity_enriched")).toBe(true);
    const npcs = await db
      .select()
      .from(schema.entities)
      .where(
        and(eq(schema.entities.campaignId, campaignId), eq(schema.entities.entityType, "npc")),
      );
    expect(npcs.filter((r) => /mother/i.test(r.name)).map((r) => r.name)).toEqual([
      "The Protagonist's Mother",
    ]);

    // Master: minted as a thread bound to the monster (new canon landed).
    const [master] = await db
      .select()
      .from(schema.entities)
      .where(
        and(
          eq(schema.entities.campaignId, campaignId),
          eq(schema.entities.name, "The Warden's Master"),
        ),
      );
    expect(master?.entityType).toBe("thread");
    const state = (master?.state ?? {}) as { relationships?: Record<string, string> };
    expect(state.relationships?.["13"]).toContain("related to The Gaunt Warden");
  });
});
