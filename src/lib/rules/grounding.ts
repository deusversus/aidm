import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AnchorFile, type Exemplar, ExemplarFile, V0_AXES } from "@/lib/types/grounding";
import jsYaml from "js-yaml";

/**
 * Loaders for the grounding data (blueprint §4.6–4.7): repo-versioned YAML,
 * zod-validated at load, cross-checked so an anchor can never point at an
 * exemplar that doesn't exist. Consumers: SZ calibration, the Renderer's
 * exemplar injection, the Sakkan's blind scoring, and the eval harness.
 */

const RULE_LIBRARY_DIR = join(process.cwd(), "rule_library");

function loadYamlDir<T>(dir: string, parse: (raw: unknown, file: string) => T): T[] {
  const full = join(RULE_LIBRARY_DIR, dir);
  return readdirSync(full)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort()
    .map((f) => parse(jsYaml.load(readFileSync(join(full, f), "utf8")), f));
}

export function loadAnchors(): AnchorFile[] {
  return loadYamlDir("anchors", (raw, file) => {
    const parsed = AnchorFile.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`anchors/${file}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    }
    return parsed.data;
  });
}

export function loadExemplars(): ExemplarFile[] {
  return loadYamlDir("exemplars", (raw, file) => {
    const parsed = ExemplarFile.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`exemplars/${file}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    }
    return parsed.data;
  });
}

export interface GroundingLibrary {
  anchors: AnchorFile[];
  exemplars: Exemplar[];
  byId: Map<string, Exemplar>;
}

/** Load both libraries and enforce the cross-file invariants. */
export function loadGrounding(): GroundingLibrary {
  const anchors = loadAnchors();
  const exemplarFiles = loadExemplars();
  const exemplars = exemplarFiles.flatMap((f) => f.exemplars);
  const byId = new Map(exemplars.map((e) => [e.id, e]));
  if (byId.size !== exemplars.length) {
    throw new Error("grounding: duplicate exemplar ids");
  }
  for (const anchor of anchors) {
    for (const [band, def] of Object.entries(anchor.bands)) {
      if (!def.excerpt_ref) continue;
      const ex = byId.get(def.excerpt_ref);
      if (!ex) {
        throw new Error(
          `anchors/${anchor.axis} band ${band}: excerpt_ref ${def.excerpt_ref} not found`,
        );
      }
      if (ex.axis !== anchor.axis || String(ex.band) !== band) {
        throw new Error(
          `anchors/${anchor.axis} band ${band}: excerpt_ref ${def.excerpt_ref} is for ${ex.axis}/${ex.band}`,
        );
      }
    }
  }
  // v0 coverage (§4.7): both extremes of every v0 axis.
  for (const axis of V0_AXES) {
    const anchor = anchors.find((a) => a.axis === axis);
    if (!anchor) throw new Error(`grounding: v0 axis ${axis} has no anchor file`);
    for (const band of [1, 9] as const) {
      if (!exemplars.some((e) => e.axis === axis && e.band === band)) {
        throw new Error(`grounding: v0 axis ${axis} missing band-${band} exemplar`);
      }
    }
  }
  return { anchors, exemplars, byId };
}
