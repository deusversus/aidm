import type { Db } from "@/lib/db";
import { notTombstoned } from "@/lib/db/helpers";
import { seeds } from "@/lib/db/schema";
import {
  type DirectorSeedOp,
  OVERDUE_TENSION_BUMP,
  SEED_DEFAULT_URGENCY,
  SEED_MAX_TURNS_TO_PAYOFF,
  SEED_MIN_TURNS_TO_PAYOFF,
} from "@/lib/types/direction";
import { and, eq, inArray } from "drizzle-orm";

/**
 * The seed ledger operations (blueprint §7.6, v3 foreshadowing.py carried):
 * plant/resolve/abandon with payoff windows, dependency gates, urgency,
 * overdue→tension. The DECLARED detection path lives in G2 (C6: sidecar
 * mentions confirmed by one probe, urgency-on-mention). The organic sweep
 * is M3. Statuses: planted | confirmed | resolved | abandoned.
 */

export type SeedRow = typeof seeds.$inferSelect;

const OPEN_STATUSES = ["planted", "confirmed"] as const;

/** The stored payoff window, defaulted from the plant turn when absent. */
function windowOf(seed: SeedRow): { from: number; to: number } {
  const w = seed.payoffWindow as { from?: number; to?: number } | null;
  return {
    from: w?.from ?? seed.plantedTurn + SEED_MIN_TURNS_TO_PAYOFF,
    to: w?.to ?? seed.plantedTurn + SEED_MAX_TURNS_TO_PAYOFF,
  };
}

/** Stored dependency seed ids (jsonb string[]), guarded. */
function depsOf(seed: SeedRow): string[] {
  return Array.isArray(seed.dependencies) ? (seed.dependencies as string[]) : [];
}

/**
 * Best single containment match (case-insensitive, bidirectional): a row
 * matches if its description contains the query or the query contains it;
 * ties break toward the closest length. The Director speaks prose, so
 * containment is how a spoken reference lands on a stored seed.
 */
function bestMatch(rows: SeedRow[], query: string): SeedRow | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const matches = rows.filter((r) => {
    const d = r.description.trim().toLowerCase();
    return d.includes(q) || q.includes(d);
  });
  if (matches.length === 0) return undefined;
  // Deterministic tie-break on id: the feeding selects carry no ORDER BY, so
  // Postgres row order is unspecified — an equal-distance tie must not resolve
  // to a different seed run-to-run (C7 audit; crash-replay stays idempotent).
  matches.sort(
    (a, b) =>
      Math.abs(a.description.length - query.length) -
        Math.abs(b.description.length - query.length) || a.id.localeCompare(b.id),
  );
  return matches[0];
}

/**
 * Plant with envelope. Window defaults to
 * [plantedTurn + SEED_MIN_TURNS_TO_PAYOFF, plantedTurn + SEED_MAX_TURNS_TO_PAYOFF];
 * urgency defaults SEED_DEFAULT_URGENCY. `dependencies` arrive as
 * descriptions (the Director speaks prose) — matched to seed ids here;
 * unmatched dependencies are dropped with a returned note, never invented.
 */
export async function plantSeed(
  db: Db,
  campaignId: string,
  turnNumber: number,
  op: DirectorSeedOp,
  provenance: string,
): Promise<{ seedId: string; notes: string[] }> {
  const description = op.description?.trim();
  if (!description) throw new Error("plantSeed: a plant op requires a description");

  const notes: string[] = [];
  // Dependency pool excludes ABANDONED seeds: the gate requires deps to reach
  // "resolved", which abandoned never does — a dependency bound to one gates
  // the new seed forever (C7 audit). Resolved seeds stay matchable: a dep on
  // an already-resolved seed is a legitimately open gate.
  const existing = await db
    .select()
    .from(seeds)
    .where(
      and(
        eq(seeds.campaignId, campaignId),
        inArray(seeds.status, ["planted", "confirmed", "resolved"]),
        notTombstoned(seeds),
      ),
    );

  const matchedIds: string[] = [];
  for (const dep of op.dependencies) {
    const match = bestMatch(existing, dep);
    if (match) {
      if (!matchedIds.includes(match.id)) matchedIds.push(match.id);
    } else {
      notes.push(`dependency "${dep}" matched no existing seed — dropped`);
    }
  }

  const from = op.payoff_window_from ?? turnNumber + SEED_MIN_TURNS_TO_PAYOFF;
  const to = op.payoff_window_to ?? turnNumber + SEED_MAX_TURNS_TO_PAYOFF;

  const [row] = await db
    .insert(seeds)
    .values({
      campaignId,
      description,
      expectedPayoff: op.expected_payoff ?? null,
      status: "planted",
      plantedTurn: turnNumber,
      payoffWindow: { from, to },
      urgency: SEED_DEFAULT_URGENCY,
      dependencies: matchedIds,
      mentionCount: 0,
      turnId: turnNumber,
      provenance,
      confidence: 0.9,
    })
    .returning({ id: seeds.id });
  if (!row) throw new Error("plantSeed: insert returned nothing");

  return { seedId: row.id, notes };
}

/** Resolve/abandon by description match (case-insensitive containment, best single match). */
export async function settleSeed(
  db: Db,
  campaignId: string,
  turnNumber: number,
  op: DirectorSeedOp,
): Promise<{ seedId?: string; note?: string }> {
  const query = (op.seed_description ?? op.description ?? "").trim();
  if (!query) return { note: "settleSeed: no seed_description to match against" };

  const open = await db
    .select()
    .from(seeds)
    .where(
      and(
        eq(seeds.campaignId, campaignId),
        inArray(seeds.status, [...OPEN_STATUSES]),
        notTombstoned(seeds),
      ),
    );
  const match = bestMatch(open, query);
  if (!match) return { note: `settleSeed: no open seed matched "${query}"` };

  if (op.op === "resolve") {
    await db
      .update(seeds)
      .set({ status: "resolved", resolvedTurn: turnNumber })
      .where(eq(seeds.id, match.id));
  } else {
    // abandon (the only other settle op) — dropped without a resolution turn.
    await db.update(seeds).set({ status: "abandoned" }).where(eq(seeds.id, match.id));
  }
  return { seedId: match.id };
}

/**
 * Callback-ready (v3 check_callback_ready): status planted|confirmed, past
 * the window's `from` (or SEED_MIN_TURNS_TO_PAYOFF after planting), and
 * every dependency seed RESOLVED (the gate). Ordered by urgency desc.
 * Layout surfaces these as conte callbacks (≤3, opportunities never
 * obligations).
 */
export async function callbackReadySeeds(
  db: Db,
  campaignId: string,
  currentTurn: number,
): Promise<SeedRow[]> {
  const all = await db
    .select()
    .from(seeds)
    .where(and(eq(seeds.campaignId, campaignId), notTombstoned(seeds)));
  const byId = new Map(all.map((s) => [s.id, s]));

  const ready = all.filter((seed) => {
    if (!(OPEN_STATUSES as readonly string[]).includes(seed.status)) return false;
    if (currentTurn < windowOf(seed).from) return false;
    // Dependency gate: every listed dependency must resolve first. A tombstoned
    // dependency is absent from byId → unresolved → gate holds.
    return depsOf(seed).every((depId) => byId.get(depId)?.status === "resolved");
  });

  ready.sort((a, b) => b.urgency - a.urgency);
  return ready;
}

/** Open seeds past their window's `to` (v3 get_overdue_seeds). */
export async function overdueSeeds(
  db: Db,
  campaignId: string,
  currentTurn: number,
): Promise<SeedRow[]> {
  const open = await db
    .select()
    .from(seeds)
    .where(
      and(
        eq(seeds.campaignId, campaignId),
        inArray(seeds.status, [...OPEN_STATUSES]),
        notTombstoned(seeds),
      ),
    );
  return open.filter((seed) => currentTurn > windowOf(seed).to);
}

/** Overdue→tension (v3): bump = count * OVERDUE_TENSION_BUMP, caller caps at 1. */
export function overdueTensionBump(overdueCount: number): number {
  return overdueCount * OVERDUE_TENSION_BUMP;
}

/** Compact seed dossier for the Director's investigation (ids, status, windows, urgency, deps). */
export async function seedDossier(
  db: Db,
  campaignId: string,
  currentTurn: number,
): Promise<string> {
  const all = await db
    .select()
    .from(seeds)
    .where(and(eq(seeds.campaignId, campaignId), notTombstoned(seeds)));
  const byId = new Map(all.map((s) => [s.id, s]));

  const open = all
    .filter((s) => (OPEN_STATUSES as readonly string[]).includes(s.status))
    .sort((a, b) => b.urgency - a.urgency);
  const resolved = all.filter((s) => s.status === "resolved").length;
  const abandoned = all.filter((s) => s.status === "abandoned").length;

  const trunc = (s: string, n = 60): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  const lines: string[] = [`SEED LEDGER (turn ${currentTurn})`];
  // Cap open lines so the dossier stays ~30 lines for the Director prompt.
  for (const seed of open.slice(0, 28)) {
    const w = windowOf(seed);
    const unmet = depsOf(seed)
      .map((id) => byId.get(id))
      .filter((dep) => dep?.status !== "resolved")
      .map((dep) => (dep ? trunc(dep.description, 30) : "?"));
    const deps = unmet.length ? `unmet-deps: ${unmet.join("; ")}` : "unmet-deps: none";
    lines.push(
      `- "${trunc(seed.description)}" [${seed.status}] urgency ${seed.urgency.toFixed(2)} ` +
        `window ${w.from}-${w.to} mentions ${seed.mentionCount} ${deps}`,
    );
  }
  if (open.length > 28) lines.push(`- …and ${open.length - 28} more open`);
  lines.push(`(${resolved} resolved, ${abandoned} abandoned)`);
  return lines.join("\n");
}
