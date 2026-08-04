import { approxTokens } from "@/lib/blocks/tokens";
import * as schema from "@/lib/db/schema";
import { EMBEDDING_DIMENSIONS } from "@/lib/llm/embedding-config";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { CHUNK_TARGET_TOKENS, chunkProse, writePlayerCanon } from "../corpus";

/**
 * The player-canon ingress (M3R3 C2): prose chunking for pasted material, and
 * the write path's own profileId + replace-by-title semantics against the real
 * dev Postgres. Voyage is stubbed — the discipline under test is chunking and
 * SQL, and paid embeddings buy neither.
 */

vi.mock("@/lib/llm/voyage", () => ({
  embedTexts: vi.fn(async (texts: string[]) =>
    texts.map(() => new Array(1024).fill(0.1) as number[]),
  ),
}));

const MAX_TOKENS = CHUNK_TARGET_TOKENS * 1.5;

describe("chunkProse (pasted material — no headers to split on)", () => {
  it("merges blank-line paragraphs toward the target; every chunk carries content", () => {
    const para = `${"The knight walked the long road east. ".repeat(30)}\n`;
    const text = Array.from({ length: 12 }, () => para).join("\n");
    const chunks = chunkProse("Volume 3 synopsis", text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.title).toBe("Volume 3 synopsis");
      expect(c.content.trim().length).toBeGreaterThan(0);
      expect(approxTokens(c.content)).toBeLessThanOrEqual(MAX_TOKENS);
    }
    // Merging is real: chunks are near the target, not one per paragraph.
    expect(chunks.length).toBeLessThan(12);
  });

  it("splits a single-newline paste (the e-reader copy shape) instead of returning one wall", () => {
    const lines = Array.from(
      { length: 200 },
      (_, i) => `Line ${i}: the caravan crossed the salt flats before dawn, and nobody spoke.`,
    );
    const text = lines.join("\n");
    expect(approxTokens(text)).toBeGreaterThan(CHUNK_TARGET_TOKENS * 3);

    const chunks = chunkProse("Chapter 12", text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(approxTokens(c.content)).toBeLessThanOrEqual(MAX_TOKENS);
  });

  it("sentence-splits one giant unbroken paragraph — no chunk exceeds 1.5x the target", () => {
    const text = Array.from(
      { length: 300 },
      (_, i) => `The ${i}th sword was forged in a winter nobody in the capital remembers now.`,
    ).join(" ");
    expect(text.includes("\n")).toBe(false);
    expect(approxTokens(text)).toBeGreaterThan(CHUNK_TARGET_TOKENS * 4);

    const chunks = chunkProse("The Ashen Court", text);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.content.trim().length).toBeGreaterThan(0);
      expect(approxTokens(c.content)).toBeLessThanOrEqual(MAX_TOKENS);
    }
  });

  it("bounds a punctuation-free list under a header — one blank line no longer disables the cascade", () => {
    // The C2 review's replication, verbatim in shape: a pasted cast list whose
    // ONLY blank line sits under the header. The newline split used to be gated
    // on the GLOBAL part count, so 2 parts disabled it; the sentence rescue
    // found no boundary in punctuation-free lines, and the body came back as
    // one ~6.8k-token chunk that ka.ts then truncated to 400 chars.
    const body = Array.from(
      { length: 400 },
      (_, i) => `Kael Var${i} — the exiled knight of the ${i}th house, sworn to the winter throne`,
    ).join("\n");
    const text = `Characters\n\n${body}`;
    expect(text.length).toBeGreaterThan(20_000);
    expect(/[.!?…。！？]/.test(body)).toBe(false);

    const chunks = chunkProse("Cast list", text);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) {
      expect(c.title).toBe("Cast list");
      expect(c.content.trim().length).toBeGreaterThan(0);
      expect(approxTokens(c.content)).toBeLessThanOrEqual(MAX_TOKENS);
    }
    // Nothing was dropped on the way through the cascade.
    expect(chunks.some((c) => c.content.includes("Kael Var0 "))).toBe(true);
    expect(chunks.some((c) => c.content.includes("Kael Var399 "))).toBe(true);
  });

  it("hard-slices a run with no sentence boundary and no line break — the last resort still bounds", () => {
    // A comma-separated roster: every cascade stage before the slice finds
    // exactly one part. The post-condition holds for EVERY chunk anyway.
    const text = Array.from({ length: 2_000 }, (_, i) => `Var${i} of the winter houses`).join(", ");
    expect(text.includes("\n")).toBe(false);
    expect(/[.!?…。！？]/.test(text)).toBe(false);
    expect(approxTokens(text)).toBeGreaterThan(CHUNK_TARGET_TOKENS * 3);

    const chunks = chunkProse("Roster", text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.content.trim().length).toBeGreaterThan(0);
      expect(approxTokens(c.content)).toBeLessThanOrEqual(MAX_TOKENS);
    }
  });

  it("a short paste is exactly one chunk; nothing empty ever comes back", () => {
    expect(chunkProse("A note", "Milia is the protagonist's mother. She is alive.")).toEqual([
      { title: "A note", content: "Milia is the protagonist's mother. She is alive." },
    ]);
    expect(chunkProse("Empty", "   \n\n  \n ")).toEqual([]);
  });
});

const url = process.env.DATABASE_URL;
if (!url) console.warn("[corpus.player] DATABASE_URL not set — skipping");

const pool = url ? new Pool({ connectionString: url, max: 4 }) : undefined;
const db = pool ? drizzle(pool, { schema, casing: "snake_case" }) : undefined;

describe.skipIf(!url)("writePlayerCanon (real Postgres, stubbed embeddings)", () => {
  // canon_chunks.profileId carries no foreign key (§6 layer 5 is cross-campaign
  // and profile-keyed by string), so the pseudo-profile needs no campaign row.
  const campaignId = crypto.randomUUID();
  const profileId = `player_canon_${campaignId}`;

  afterAll(async () => {
    if (!db || !pool) return;
    try {
      await db.delete(schema.canonChunks).where(eq(schema.canonChunks.profileId, profileId));
    } finally {
      await pool.end();
    }
  });

  const rowsFor = async (title: string) => {
    if (!db) throw new Error("unreachable");
    const all = await db
      .select()
      .from(schema.canonChunks)
      .where(eq(schema.canonChunks.profileId, profileId));
    return all.filter((r) => r.title === title);
  };

  it("writes under the campaign-scoped pseudo-profile with player provenance", async () => {
    if (!db) throw new Error("unreachable");
    const result = await writePlayerCanon(db, campaignId, [
      {
        title: "Volume 3 synopsis",
        pageType: "arcs",
        text: Array.from(
          { length: 200 },
          (_, i) =>
            `Paragraph ${i}: the siege of the winter capital ran three months long, and the houses counted their dead by lamplight.`,
        ).join("\n\n"),
      },
      {
        title: "The Ashen Court",
        pageType: "factions",
        text: "The Ashen Court rules by proxy: seven houses, one throne nobody sits on.",
      },
    ]);

    expect(result.profileId).toBe(profileId);
    expect(result.chunks).toBeGreaterThan(1);

    const synopsis = await rowsFor("Volume 3 synopsis");
    const court = await rowsFor("The Ashen Court");
    expect(synopsis.length).toBeGreaterThan(1);
    expect(court).toHaveLength(1);
    for (const row of [...synopsis, ...court]) {
      expect(row.provenance).toBe("player_supplied");
      expect(row.sourceUrl).toBe("player");
      expect(row.turnId).toBe(0);
      expect(row.confidence).toBe(1);
      expect(row.embedding).toHaveLength(EMBEDDING_DIMENSIONS);
    }
    expect(synopsis[0]?.pageType).toBe("arcs");
    expect(court[0]?.pageType).toBe("factions");
  });

  it("re-supplying a title replaces THAT title only — the rest of the player's canon survives", async () => {
    if (!db) throw new Error("unreachable");
    const before = await rowsFor("The Ashen Court");
    expect(before).toHaveLength(1);

    await writePlayerCanon(db, campaignId, [
      {
        title: "Volume 3 synopsis",
        pageType: "arcs",
        text: "Correction: the siege lasted one winter, not three months, and the capital held.",
      },
    ]);

    const synopsis = await rowsFor("Volume 3 synopsis");
    expect(synopsis).toHaveLength(1);
    expect(synopsis[0]?.content).toContain("Correction");
    expect(synopsis.some((r) => r.content.includes("three months long"))).toBe(false);

    // The untouched entry is untouched — same row, not a rewrite.
    const after = await rowsFor("The Ashen Court");
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before[0]?.id);
  });
});
