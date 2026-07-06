/**
 * One-shot backfill: ensure every existing campaign has `provider` +
 * `tier_models` in `settings` (M1.5 addition).
 *
 * Historical campaigns were created before the provider/tier_models
 * fields existed; they'd otherwise fall back to env defaults through
 * `anthropicFallbackConfig()` at every turn, which works but obscures
 * the source of truth. This script writes the Anthropic defaults
 * directly onto the row so the settings blob is self-describing.
 *
 * Idempotent: campaigns that already carry `provider` + `tier_models`
 * are left alone. Safe to run N times.
 *
 * Usage (with .env.local loaded):
 *   pnpm tsx scripts/migrate-campaign-providers.ts
 *   pnpm tsx scripts/migrate-campaign-providers.ts --dry-run
 */
import { getDb } from "@/lib/db";
import { anthropicFallbackConfig } from "@/lib/providers";
import { campaigns } from "@/lib/state/schema";
import { CampaignSettings, hasProviderConfig } from "@/lib/types/campaign-settings";
import { eq } from "drizzle-orm";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const db = getDb();

  const rows = await db
    .select({ id: campaigns.id, name: campaigns.name, settings: campaigns.settings })
    .from(campaigns);

  console.log(`Scanning ${rows.length} campaign row(s)…`);

  let migrated = 0;
  let skipped = 0;
  const fallback = anthropicFallbackConfig();

  for (const row of rows) {
    const parsed = CampaignSettings.safeParse(row.settings ?? {});
    if (!parsed.success) {
      console.warn(
        `  ! ${row.id} (${row.name}): settings parse failed — skipping. Issues:`,
        parsed.error.issues.map((i) => i.message),
      );
      skipped += 1;
      continue;
    }
    if (hasProviderConfig(parsed.data)) {
      skipped += 1;
      continue;
    }
    const next = {
      ...(parsed.data as Record<string, unknown>),
      provider: fallback.provider,
      tier_models: fallback.tier_models,
    };
    console.log(`  → ${row.id} (${row.name}): adding provider=${fallback.provider}`);
    if (!dryRun) {
      await db.update(campaigns).set({ settings: next }).where(eq(campaigns.id, row.id));
    }
    migrated += 1;
  }

  console.log(
    `\nDone. Migrated: ${migrated}. Skipped (already-populated or parse-fail): ${skipped}.`,
  );
  if (dryRun) console.log("(dry-run mode — no writes performed)");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
