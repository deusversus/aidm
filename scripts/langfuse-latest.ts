#!/usr/bin/env tsx
/**
 * Pretty-print the most recent Langfuse trace (or a specific one by id)
 * with per-span model + duration + cost inline. The fastest path to
 * answering "is KA's consultant spawning actually tiered?" without
 * opening the Langfuse UI.
 *
 * Shells `langfuse-cli` so auth + endpoint discovery stay in one tool.
 * The CLI wraps every response in `{ ok, status, body }`, so this
 * script unwraps + renders.
 *
 * Usage:
 *   pnpm langfuse:latest               # most recent trace
 *   pnpm langfuse:latest <traceId>     # specific trace
 */
import { execFileSync } from "node:child_process";

// --- CLI response shapes ---
interface CliEnvelope<T> {
  ok: boolean;
  status: number;
  body: T;
  error?: string;
}

interface TraceListItem {
  id: string;
  name: string | null;
  timestamp: string;
  userId?: string | null;
  metadata?: Record<string, unknown> | null;
  totalCost?: number;
  latency?: number;
}

interface Observation {
  id: string;
  traceId: string;
  parentObservationId: string | null;
  name?: string | null;
  type: string;
  startTime: string;
  endTime?: string | null;
  // Model fields (from --fields model). Only populated when the span
  // was created as a Generation; our current spans store model in
  // metadata instead, so these will usually be null for our traces.
  providedModelName?: string | null;
  internalModelId?: string | null;
  // Usage + cost fields (from --fields usage).
  totalCost?: number | null;
  costDetails?: Record<string, number> | null;
  usageDetails?: Record<string, number> | null;
  // Input/output (from --fields io). KA + Chronicler emit cost_usd
  // inside `output`; _runner.ts emits costUsd inside `metadata`.
  input?: unknown;
  output?: unknown;
  // Metadata (from --fields metadata). Our spans stash model/tier/cost
  // here rather than as first-class Generation fields.
  metadata?: Record<string, unknown> | null;
  latency?: number | null;
  level?: string | null;
}

// --- CLI shell helper ---
function cli<T>(args: string[]): T {
  const out = execFileSync("npx", ["langfuse-cli", ...args, "--json"], {
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const env = JSON.parse(out) as CliEnvelope<T>;
  if (!env.ok) {
    throw new Error(`langfuse-cli failed: status=${env.status} error=${env.error ?? "(none)"}`);
  }
  return env.body;
}

// --- Formatting ---
function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtCost(usd: number | null | undefined): string {
  if (usd == null || usd === 0) return "—";
  if (usd < 0.001) return "<$.001";
  return `$${usd.toFixed(4)}`;
}

function modelShort(m: string | null | undefined): string {
  if (!m) return "—";
  // "claude-sonnet-4-6" → "sonnet-4-6"; drop long yyyymmdd snapshot tags.
  return m.replace(/^claude-/, "").replace(/-20\d{6}$/, "");
}

function durMs(o: Observation): number | null {
  if (o.latency != null) return o.latency * 1000;
  if (!o.endTime) return null;
  return new Date(o.endTime).getTime() - new Date(o.startTime).getTime();
}

/**
 * Langfuse returns `input`/`output` as JSON-encoded STRINGS (not parsed
 * objects). Parse defensively so a malformed payload doesn't take down
 * the whole trace render.
 */
function parseOutput(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  if (typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function costOf(o: Observation): number | null {
  // Our cost data lives in three possible spots depending on which
  // wrapper emitted the span:
  //   - _runner.ts          → metadata.costUsd
  //   - KA + Chronicler     → output.cost_usd  (output is a JSON string
  //                                              in the Langfuse API)
  //   - future Generation   → totalCost (Langfuse first-class)
  const meta = (o.metadata ?? {}) as Record<string, unknown>;
  const metaCost =
    typeof meta.costUsd === "number"
      ? meta.costUsd
      : typeof meta.cost_usd === "number"
        ? meta.cost_usd
        : null;
  if (metaCost !== null) return metaCost;
  const out = parseOutput(o.output);
  if (out) {
    const outCost =
      typeof out.cost_usd === "number"
        ? out.cost_usd
        : typeof out.costUsd === "number"
          ? out.costUsd
          : null;
    if (outCost !== null) return outCost;
  }
  // Langfuse's first-class totalCost is 0 on our spans (we don't emit
  // Generation-typed with token usage). Skip the 0s.
  return o.totalCost && o.totalCost > 0 ? o.totalCost : null;
}

function modelOf(o: Observation): string | null {
  // Model is stored in span metadata by _runner.ts / KA / Chronicler.
  // Langfuse's first-class `providedModelName` is for Generation-typed
  // spans, which we don't emit yet — see the "future work" note in the
  // header comment.
  const meta = o.metadata ?? {};
  if (typeof meta.model === "string") return meta.model;
  return o.providedModelName ?? o.internalModelId ?? null;
}

function tierOf(o: Observation): string | null {
  const meta = o.metadata ?? {};
  return typeof meta.tier === "string" ? meta.tier : null;
}

function nameOf(o: Observation): string {
  return o.name ?? `(${o.type.toLowerCase()})`;
}

// --- Tree layout ---
// The CLI reports parentObservationId as `t-<traceId>` for top-level
// spans that hang off the trace root (Langfuse's convention). Normalize
// to null so tree building works.
function normalizeParent(p: string | null, traceId: string): string | null {
  if (!p) return null;
  if (p === `t-${traceId}`) return null;
  return p;
}

function buildTree(obs: Observation[], traceId: string): Map<string | null, Observation[]> {
  const byParent = new Map<string | null, Observation[]>();
  for (const o of obs) {
    const key = normalizeParent(o.parentObservationId, traceId);
    const bucket = byParent.get(key) ?? [];
    bucket.push(o);
    byParent.set(key, bucket);
  }
  for (const bucket of byParent.values()) {
    bucket.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  }
  return byParent;
}

function renderNode(
  o: Observation,
  byParent: Map<string | null, Observation[]>,
  prefix: string,
  isLast: boolean,
): void {
  const elbow = isLast ? "└── " : "├── ";
  const name = nameOf(o).slice(0, 40).padEnd(40);
  const tier = (tierOf(o) ?? "").slice(0, 8).padEnd(8);
  const model = modelShort(modelOf(o)).padEnd(14);
  const dur = fmtMs(durMs(o)).padStart(7);
  const cost = fmtCost(costOf(o)).padStart(8);
  console.log(`${prefix}${elbow}${name} ${tier} ${model} ${dur} ${cost}`);
  const children = byParent.get(o.id) ?? [];
  const childPrefix = prefix + (isLast ? "    " : "│   ");
  children.forEach((c, i) => renderNode(c, byParent, childPrefix, i === children.length - 1));
}

// --- Fetchers ---
function fetchLatestTraceId(): string {
  console.error("[langfuse-latest] fetching most recent trace…");
  const body = cli<{ data: TraceListItem[] }>([
    "api",
    "traces",
    "list",
    "--limit",
    "1",
    "--order-by",
    "timestamp.desc",
  ]);
  const rows = body.data ?? [];
  const first = rows[0];
  if (!first) throw new Error("no traces found");
  return first.id;
}

function fetchTrace(traceId: string): TraceListItem {
  console.error(`[langfuse-latest] fetching trace ${traceId}…`);
  return cli<TraceListItem>(["api", "traces", "get", traceId]);
}

// Pull ALL observations for a trace. Langfuse observations use
// CURSOR-based pagination (not page numbers) + a 1000-item ceiling per
// request. A long Chronicler post-turn can spawn 40+ spans; pulling
// 1000 in one shot covers the realistic cap.
function fetchObservations(traceId: string): Observation[] {
  console.error(`[langfuse-latest] fetching observations for ${traceId}…`);
  const all: Observation[] = [];
  let cursor: string | undefined;
  for (let loop = 0; loop < 10; loop++) {
    const args = [
      "api",
      "observations",
      "list",
      "--trace-id",
      traceId,
      // core + basic = id/type/parent/name.
      // metadata = _runner's {model, tier, costUsd, attempt}.
      // io = KA/Chronicler's output.cost_usd (they emit in output).
      // usage = Langfuse first-class totalCost (future Generation spans).
      // metrics = latency + ttft.
      "--fields",
      "core,basic,io,metadata,usage,metrics",
      "--limit",
      "1000",
    ];
    if (cursor) args.push("--cursor", cursor);
    const body = cli<{ data: Observation[]; meta?: { nextCursor?: string | null } }>(args);
    const batch = body.data ?? [];
    all.push(...batch);
    const next = body.meta?.nextCursor;
    if (!next || batch.length === 0) break;
    cursor = next;
  }
  return all;
}

function main(): void {
  const argTraceId = process.argv[2];
  const traceId = argTraceId ?? fetchLatestTraceId();

  const trace = fetchTrace(traceId);
  const obs = fetchObservations(traceId);
  const byParent = buildTree(obs, traceId);
  const roots = byParent.get(null) ?? [];

  const who = trace.userId ?? "—";
  const campaignId = (trace.metadata as { campaignId?: string } | undefined)?.campaignId ?? "—";
  const metaUserId = (trace.metadata as { userId?: string } | undefined)?.userId ?? who;

  console.log("");
  console.log(`trace: ${trace.name ?? "(unnamed)"}   id=${trace.id}`);
  console.log(`  at=${trace.timestamp}`);
  console.log(`  user=${metaUserId}  campaign=${campaignId}`);
  if (trace.totalCost != null) console.log(`  totalCost=${fmtCost(trace.totalCost)}`);
  if (trace.latency != null) console.log(`  totalLatency=${fmtMs(trace.latency * 1000)}`);
  console.log(`  observations=${obs.length}`);
  console.log("");

  if (roots.length === 0) {
    console.log("(no observations on this trace)");
    return;
  }

  console.log(
    `${"name".padEnd(40)} ${"tier".padEnd(8)} ${"model".padEnd(14)} ${"dur".padStart(7)} ${"cost".padStart(8)}`,
  );
  console.log(
    `${"-".repeat(40)} ${"-".repeat(8)} ${"-".repeat(14)} ${"-".repeat(7)} ${"-".repeat(8)}`,
  );
  roots.forEach((r, i) => renderNode(r, byParent, "", i === roots.length - 1));
  console.log("");
}

try {
  main();
} catch (err) {
  console.error("[langfuse-latest] failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
