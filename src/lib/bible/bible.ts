import type { Db } from "@/lib/db";
import { notTombstoned } from "@/lib/db/helpers";
import { campaigns, criticalFacts, entities, turns } from "@/lib/db/schema";
import { PremiseContract, type WorldComponent } from "@/lib/types/premise";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";

/**
 * The Series Bible (blueprint §9.1, C9): the campaign's living reference —
 * Premise Contract essentials + cast + world facts + the spark. First
 * edition REVEALS after the cold open (≥1 complete turn); before that the
 * page teases rather than spoils. Grows via universal ingestion (§5.4):
 * player-minted entities appear WITH provenance. Read-only at M1 (studio
 * surfaces stage at M4); the ledger/cost page is CUT per the plan.
 */

export interface BibleEntry {
  name: string;
  block: string;
  /** Raw provenance tag + the player-minted flag the UI badges. */
  provenance: string;
  playerMinted: boolean;
  turnId: number;
}

export interface BibleComposition {
  /** False until the cold open has landed (≥1 complete turn). */
  revealed: boolean;
  title: string;
  /** The spark, verbatim — the campaign's central question (§8). */
  spark: string;
  /** Premise essentials safe for the player-facing page (never the axes-as-numbers dump). */
  premise: {
    finitude: string;
    worldName?: string;
    powerSystem?: string;
    hardLines: string[];
  };
  cast: BibleEntry[];
  factions: BibleEntry[];
  locations: BibleEntry[];
  threads: BibleEntry[];
  /** Critical-layer world facts (categories sz_fact + promoted; contract rows excluded — they render under premise). */
  worldFacts: Array<{ content: string; provenance: string; playerMinted: boolean }>;
}

/**
 * Player-minted = provenance "player_assertion" (§5.4 universal ingestion's
 * world-assertion channel). Pins/overrides are player acts too, but they are
 * NOT entities and never enter the catalog — the composer's minted set is
 * exactly the entities and critical facts the player authored, badged so the
 * bible reads as the shared review gate it is (§9.1).
 */
const PLAYER_MINTED = "player_assertion";

/**
 * A displayable world label. The World component (§4.1, premise.ts) carries
 * no dedicated proper-name field — the campaign title is the story's name.
 * The nearest displayable world identity is world_setting: its genre(s) and
 * time period. Undefined when the setting names neither. (power_system.name
 * is the separate powerSystem essential.)
 */
function worldLabel(world: WorldComponent): string | undefined {
  const setting = world.world_setting;
  const genres = setting.genre.filter((g) => g.trim().length > 0);
  const parts: string[] = [];
  if (genres.length > 0) parts.push(genres.join(", "));
  if (setting.time_period?.trim()) parts.push(setting.time_period.trim());
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * Compose the Bible from the live layers: campaign row (contract), entities
 * catalog (active, not tombstoned, grouped by entityType; dismissed cast
 * excluded), critical facts (not demoted, not tombstoned). Returns null when
 * the campaign is missing or its contract cannot be parsed — there is no
 * bible without a premise. Before the cold open lands, the composition
 * returns with revealed:false and EMPTY layers: the page teases without
 * leaking cast the player hasn't yet lived.
 */
export async function composeBible(db: Db, campaignId: string): Promise<BibleComposition | null> {
  const [campaign] = await db
    .select({ title: campaigns.title, premiseContract: campaigns.premiseContract })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId));
  if (!campaign) return null;

  const parsed = PremiseContract.safeParse(campaign.premiseContract);
  if (!parsed.success) return null;
  const contract = parsed.data;

  // Reveal gate (§9.1): the bible is what you find in your hands when you
  // surface from the first scene — not before.
  const [firstComplete] = await db
    .select({ id: turns.id })
    .from(turns)
    .where(and(eq(turns.campaignId, campaignId), eq(turns.status, "complete")))
    .limit(1);
  const revealed = Boolean(firstComplete);

  const scalar = {
    revealed,
    title: campaign.title,
    spark: contract.spark,
    premise: {
      finitude: contract.finitude,
      worldName: worldLabel(contract.active.world),
      powerSystem: contract.active.world.power_system?.name,
      hardLines: contract.intensity.hard_lines,
    },
  };

  if (!revealed) {
    return { ...scalar, cast: [], factions: [], locations: [], threads: [], worldFacts: [] };
  }

  const rows = await db
    .select({
      name: entities.name,
      entityType: entities.entityType,
      block: entities.block,
      provenance: entities.provenance,
      turnId: entities.turnId,
    })
    .from(entities)
    .where(
      and(
        eq(entities.campaignId, campaignId),
        eq(entities.status, "active"),
        notTombstoned(entities),
      ),
    )
    // First-met first (§9.1 "grows via ingestion"): turnId ascending, name as
    // a stable tiebreak within a turn.
    .orderBy(asc(entities.turnId), asc(entities.name));

  const toEntry = (r: (typeof rows)[number]): BibleEntry => ({
    name: r.name,
    block: r.block,
    provenance: r.provenance,
    playerMinted: r.provenance === PLAYER_MINTED,
    turnId: r.turnId,
  });

  const facts = await db
    .select({
      content: criticalFacts.content,
      provenance: criticalFacts.provenance,
      turnId: criticalFacts.turnId,
    })
    .from(criticalFacts)
    .where(
      and(
        eq(criticalFacts.campaignId, campaignId),
        isNull(criticalFacts.demotedAt),
        notTombstoned(criticalFacts),
        // "contract" rows (finitude/intensity) render under premise, not here.
        inArray(criticalFacts.category, ["sz_fact", "promoted"]),
      ),
    )
    .orderBy(asc(criticalFacts.turnId));

  return {
    ...scalar,
    cast: rows.filter((r) => r.entityType === "npc").map(toEntry),
    factions: rows.filter((r) => r.entityType === "faction").map(toEntry),
    locations: rows.filter((r) => r.entityType === "location").map(toEntry),
    threads: rows.filter((r) => r.entityType === "thread").map(toEntry),
    worldFacts: facts.map((f) => ({
      content: f.content,
      provenance: f.provenance,
      playerMinted: f.provenance === PLAYER_MINTED,
    })),
  };
}
