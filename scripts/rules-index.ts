/**
 * Rule library indexer — walks `rule_library/**\/*.yaml`, validates each
 * file against the YAML schema, then upserts rows into
 * `rule_library_chunks` by (category, axis, value_key). Content changes
 * bump the version counter; identical content is a no-op.
 *
 * Usage (with .env.local loaded):
 *   pnpm tsx scripts/rules-index.ts
 *   pnpm tsx scripts/rules-index.ts --dry-run
 *
 * Output: per-file summary + final "N indexed, M updated, K skipped".
 * Malformed YAML / Zod-violating entries fail the whole run — partial
 * index states hide content-quality regressions.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { getDb } from "@/lib/db";
import { ruleLibraryChunks } from "@/lib/state/schema";
import { RuleLibraryYamlFile } from "@/lib/types/rule-library";
import { and, eq, sql } from "drizzle-orm";
import jsYaml from "js-yaml";

const ROOT = join(process.cwd(), "rule_library");

function walk(dir: string): string[] {
  const out: string[] = [];
  const entries = readdirSync(dir);
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      out.push(...walk(p));
    } else if (name.endsWith(".yaml") || name.endsWith(".yml")) {
      out.push(p);
    }
  }
  return out;
}

interface IndexResult {
  inserted: number;
  updated: number;
  skipped: number; // identical content — no DB write
}

async function indexFile(db: ReturnType<typeof getDb>, path: string): Promise<IndexResult> {
  const raw = readFileSync(path, "utf8");
  const parsed = jsYaml.load(raw);
  const file = RuleLibraryYamlFile.parse(parsed);

  const result: IndexResult = { inserted: 0, updated: 0, skipped: 0 };

  for (const entry of file.entries) {
    // Find existing row by lookup key.
    const [existing] = await db
      .select({
        id: ruleLibraryChunks.id,
        content: ruleLibraryChunks.content,
        version: ruleLibraryChunks.version,
      })
      .from(ruleLibraryChunks)
      .where(
        and(
          eq(ruleLibraryChunks.category, file.category),
          file.axis === null
            ? sql`${ruleLibraryChunks.axis} IS NULL`
            : eq(ruleLibraryChunks.axis, file.axis),
          entry.value_key === null
            ? sql`${ruleLibraryChunks.valueKey} IS NULL`
            : eq(ruleLibraryChunks.valueKey, entry.value_key),
        ),
      )
      .limit(1);

    if (!existing) {
      await db.insert(ruleLibraryChunks).values({
        librarySlug: file.library_slug,
        category: file.category,
        axis: file.axis,
        valueKey: entry.value_key,
        tags: entry.tags,
        retrieveConditions: entry.retrieve_conditions,
        content: entry.content,
        version: 1,
      });
      result.inserted += 1;
      continue;
    }

    if (existing.content === entry.content) {
      result.skipped += 1;
      continue;
    }

    await db
      .update(ruleLibraryChunks)
      .set({
        librarySlug: file.library_slug,
        tags: entry.tags,
        retrieveConditions: entry.retrieve_conditions,
        content: entry.content,
        version: existing.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(ruleLibraryChunks.id, existing.id));
    result.updated += 1;
  }

  return result;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const db = getDb();
  const files = walk(ROOT);
  if (files.length === 0) {
    console.warn(`No YAML files found under ${ROOT}. Nothing to index.`);
    return;
  }

  let totalInserted = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;

  if (dryRun) {
    // Validate everything without writing.
    for (const path of files) {
      const raw = readFileSync(path, "utf8");
      const parsed = jsYaml.load(raw);
      RuleLibraryYamlFile.parse(parsed);
      console.log(`✓ parse: ${relative(process.cwd(), path)}`);
    }
    console.log(`\nDry run: ${files.length} files validated. No DB writes.`);
    return;
  }

  for (const path of files) {
    const rel = relative(process.cwd(), path);
    try {
      const res = await indexFile(db, path);
      totalInserted += res.inserted;
      totalUpdated += res.updated;
      totalSkipped += res.skipped;
      console.log(
        `  ${rel}: +${res.inserted} inserted, ~${res.updated} updated, =${res.skipped} unchanged`,
      );
    } catch (err) {
      console.error(`  ${rel}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  console.log(
    `\n${totalInserted} inserted · ${totalUpdated} updated · ${totalSkipped} unchanged · ${files.length} files`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
