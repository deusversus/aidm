/**
 * Dump every composed prompt in the registry, with fingerprint + included
 * fragments, to stdout. Used for audit — diff against a previous dump to
 * see exactly what prompt changes produced what composed-output changes.
 *
 * Usage:
 *   pnpm prompts:dump                 # pretty print all
 *   pnpm prompts:dump --ids           # just list IDs + fingerprints
 *   pnpm prompts:dump --id <prompt>   # dump one prompt in full
 *
 * The fingerprints here are what land on every persisted turn row, so
 * diffing dumps across commits is the audit trail for "did this prompt
 * change produce the regression we're chasing."
 */
import { getAllPrompts, getPrompt, listPromptIds } from "@/lib/prompts";

function main() {
  const args = process.argv.slice(2);
  const idFlag = args.indexOf("--id");
  if (idFlag !== -1) {
    const id = args[idFlag + 1];
    if (!id) {
      console.error("usage: pnpm prompts:dump --id <prompt-id>");
      process.exit(1);
    }
    const p = getPrompt(id);
    console.log(`# ${p.id}`);
    console.log(`# fingerprint: ${p.fingerprint}`);
    console.log(`# path: ${p.path}`);
    console.log(`# includes: ${p.includedFragments.join(", ") || "(none)"}`);
    console.log(`# bytes: ${p.content.length}`);
    console.log();
    console.log(p.content);
    return;
  }

  if (args.includes("--ids")) {
    for (const id of listPromptIds()) {
      const p = getPrompt(id);
      console.log(`${p.fingerprint.slice(0, 12)}  ${p.id}`);
    }
    return;
  }

  const all = getAllPrompts();
  for (const p of all) {
    console.log("=".repeat(80));
    console.log(`# ${p.id}`);
    console.log(`# fingerprint: ${p.fingerprint}`);
    console.log(`# includes: ${p.includedFragments.join(", ") || "(none)"}`);
    console.log(`# bytes: ${p.content.length}`);
    console.log("=".repeat(80));
    console.log(p.content);
    console.log();
  }
  console.log("=".repeat(80));
  console.log(`# total prompts: ${all.length}`);
  console.log("=".repeat(80));
}

main();
