/**
 * Prompt dependency graph — walks the registry and outputs a Mermaid
 * diagram of prompt → fragment edges. Useful for "what downstream
 * prompts does editing this fragment affect?" audits.
 *
 * v3-parity Phase 7 polish (MINOR #23). v3 had PromptDependencyGraph +
 * impact_report(); v4 previously had no equivalent.
 *
 * Usage:
 *   pnpm prompts:graph             # mermaid to stdout
 *   pnpm prompts:graph --impact <fragment-id>
 *                                   # list prompts that transitively
 *                                   # include the given fragment
 *
 * Copy the mermaid output into any markdown renderer (GitHub, VSCode
 * preview, etc.) to visualize.
 */
import { getAllPrompts, listPromptIds } from "@/lib/prompts";

function sanitize(id: string): string {
  // Mermaid node IDs don't accept slashes; replace with underscores.
  return id.replace(/[^a-zA-Z0-9_]/g, "_");
}

function mermaidOutput(): string {
  const prompts = getAllPrompts();
  const lines: string[] = ["graph LR"];
  const seen = new Set<string>();
  for (const p of prompts) {
    const src = sanitize(p.id);
    const label = p.id.replace(/"/g, "'");
    if (!seen.has(p.id)) {
      lines.push(`  ${src}["${label}"]`);
      seen.add(p.id);
    }
    for (const frag of p.includedFragments) {
      const dst = sanitize(frag);
      const fragLabel = frag.replace(/"/g, "'");
      if (!seen.has(frag)) {
        lines.push(`  ${dst}["${fragLabel}"]:::fragment`);
        seen.add(frag);
      }
      lines.push(`  ${src} --> ${dst}`);
    }
  }
  lines.push("  classDef fragment fill:#dff,stroke:#06a;");
  return lines.join("\n");
}

function impactReport(fragmentId: string): string[] {
  const hit = new Set<string>();
  const all = getAllPrompts();
  for (const p of all) {
    if (p.includedFragments.includes(fragmentId)) hit.add(p.id);
  }
  // Transitive: any prompt whose includes overlap with anything
  // already in `hit` also gets added. Iterate to fixpoint.
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of all) {
      if (hit.has(p.id)) continue;
      if (p.includedFragments.some((f) => hit.has(f))) {
        hit.add(p.id);
        changed = true;
      }
    }
  }
  return [...hit].sort();
}

function main() {
  const args = process.argv.slice(2);
  const impactIdx = args.indexOf("--impact");
  if (impactIdx !== -1) {
    const fragment = args[impactIdx + 1];
    if (!fragment) {
      console.error("usage: pnpm prompts:graph --impact <fragment-id>");
      process.exit(1);
    }
    if (!listPromptIds().includes(fragment)) {
      console.error(`fragment id not registered: ${fragment}`);
      console.error("registered ids:");
      for (const id of listPromptIds()) console.error(`  - ${id}`);
      process.exit(1);
    }
    const affected = impactReport(fragment);
    if (affected.length === 0) {
      console.log(`No prompts include ${fragment} transitively.`);
      return;
    }
    console.log(`Editing ${fragment} affects ${affected.length} prompt(s) transitively:`);
    for (const id of affected) console.log(`  ${id}`);
    return;
  }

  console.log("```mermaid");
  console.log(mermaidOutput());
  console.log("```");
}

main();
