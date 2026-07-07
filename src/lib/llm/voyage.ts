import { env } from "@/lib/env";
import { getLangfuse } from "@/lib/observability/langfuse";
import { recordModelCall } from "@/lib/observability/meter";
import { VoyageAIClient } from "voyageai";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "./embedding-config";

let _client: VoyageAIClient | undefined;

/** Voyage client singleton — the named non-Anthropic exception (§3). */
export function getVoyage(): VoyageAIClient {
  if (_client) return _client;
  const apiKey = env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error("VOYAGE_API_KEY not configured");
  _client = new VoyageAIClient({ apiKey });
  return _client;
}

export interface EmbedOptions {
  /** Asymmetric embedding hint: retrieval queries vs stored documents. */
  inputType?: "query" | "document";
  /**
   * 429 posture. "interactive" (default): one quick retry — a player's turn
   * must never block minutes on rate limits; the degrade ladder owns that
   * failure. "research": patient multi-minute backoff for corpus builds.
   */
  patience?: "interactive" | "research";
  campaignId?: string;
  turnNumber?: number;
}

/**
 * Embed texts at the frozen model + dimensions, metered through the same
 * cost pipeline as every Anthropic call. Batching within Voyage's 128-text
 * limit is the caller's concern at M0 (no consumer sends more yet).
 */
export async function embedTexts(texts: string[], opts: EmbedOptions = {}): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length > 128) {
    throw new Error(`embedTexts: ${texts.length} texts exceeds Voyage's 128-per-request limit`);
  }
  const lf = getLangfuse();
  const trace = lf?.trace({
    name: "embed",
    tags: ["embedding"],
    metadata: { campaignId: opts.campaignId, count: texts.length },
  });
  const started = Date.now();

  // Keyless-tier Voyage runs at 3 RPM / 10K TPM. Research callers wait it
  // out; interactive callers fail fast into the degrade ladder (a payment
  // method on the account lifts the limit; 200M free tokens still apply).
  const maxAttempts = opts.patience === "research" ? 6 : 2;
  const backoffMs = (attempt: number) =>
    opts.patience === "research" ? 21_000 * (attempt + 1) : 2_000;
  let res: Awaited<ReturnType<ReturnType<typeof getVoyage>["embed"]>> | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      res = await getVoyage().embed({
        input: texts,
        model: EMBEDDING_MODEL,
        outputDimension: EMBEDDING_DIMENSIONS,
        ...(opts.inputType ? { inputType: opts.inputType } : {}),
      });
      break;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status !== 429 || attempt === maxAttempts - 1) throw err;
      console.warn(
        `[voyage] 429 — backing off ${backoffMs(attempt) / 1000}s (${opts.patience ?? "interactive"})`,
      );
      await new Promise((r) => setTimeout(r, backoffMs(attempt)));
    }
  }
  if (!res) throw new Error("embedTexts: unreachable");
  const latencyMs = Date.now() - started;

  // Meter before validating — a malformed response is still a billed one.
  await recordModelCall({
    provider: "voyage",
    model: EMBEDDING_MODEL,
    tier: "embedding",
    usage: { input_tokens: res.usage?.totalTokens ?? 0, output_tokens: 0 },
    latencyMs,
    campaignId: opts.campaignId,
    turnNumber: opts.turnNumber,
    traceId: trace?.id,
  });

  const embeddings = (res.data ?? []).map((d) => d.embedding ?? []);
  if (embeddings.length !== texts.length) {
    throw new Error(`embedTexts: got ${embeddings.length} embeddings for ${texts.length} texts`);
  }
  for (const e of embeddings) {
    if (e.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `embedTexts: dimension ${e.length} ≠ frozen ${EMBEDDING_DIMENSIONS} — refusing to return`,
      );
    }
  }
  trace?.update({ output: { count: embeddings.length, latencyMs } });

  return embeddings;
}

/** Cosine similarity — the organic seed sweep (§7.6) and dedup live on this. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error("cosineSimilarity: length mismatch");
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
