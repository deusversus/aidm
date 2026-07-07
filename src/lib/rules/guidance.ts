import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AxisName } from "@/lib/types/grounding";
import jsYaml from "js-yaml";
import { z } from "zod";

/**
 * Loader for the v3-carried per-axis guidance chunks
 * (rule_library/dna/<axis>.yaml) — the Renderer's craft-instruction source
 * (§11: "extreme-scales-only guidance selection | C | the Renderer's core
 * policy"). Bands: "1" (low extreme), "5" (mid), "10" (high extreme).
 */

const GuidanceEntry = z.object({
  value_key: z.enum(["1", "5", "10"]),
  tags: z.array(z.string()).default([]),
  content: z.string().min(1),
});

const GuidanceFile = z.object({
  library_slug: z.string(),
  category: z.string(),
  axis: AxisName,
  entries: z.array(GuidanceEntry).min(1),
});
export type GuidanceFile = z.infer<typeof GuidanceFile>;

let _cache: Map<string, GuidanceFile> | undefined;

export function loadDnaGuidance(): Map<string, GuidanceFile> {
  if (_cache) return _cache;
  const dir = join(process.cwd(), "rule_library", "dna");
  const entries = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => {
      const parsed = GuidanceFile.safeParse(jsYaml.load(readFileSync(join(dir, f), "utf8")));
      if (!parsed.success) {
        throw new Error(`rule_library/dna/${f}: ${parsed.error.issues[0]?.message}`);
      }
      return [parsed.data.axis, parsed.data] as const;
    });
  _cache = new Map(entries);
  if (_cache.size !== entries.length) {
    throw new Error("rule_library/dna: duplicate axis files");
  }
  return _cache;
}

/** Craft guidance for an axis at an extreme ("1" | "10") or midpoint ("5"). */
export function guidanceFor(axis: AxisName, band: "1" | "5" | "10"): string | null {
  const file = loadDnaGuidance().get(axis);
  return file?.entries.find((e) => e.value_key === band)?.content.trim() ?? null;
}
