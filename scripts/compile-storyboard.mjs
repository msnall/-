// Compile a storyboard option into an edit-plan.
//
//   node scripts/compile-storyboard.mjs bloom10-v2 r1 option-a            -> report only
//   node scripts/compile-storyboard.mjs bloom10-v2 r1 option-a --out=out/x.json
//   node scripts/compile-storyboard.mjs bloom10-v2 r1 --all                -> every option
//   node scripts/compile-storyboard.mjs --library                          -> validate library/ only
//
// Writing projects/<id>/edit-plan.json is done by the review desk when the
// editor confirms an option (selection gate), never by this script.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { compileProjectOption, loadLibrary, loadRound } from "./lib/storyboard-files.mjs";
import { relative, root } from "./lib/media.mjs";

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((arg) => arg.startsWith("--")).map((arg) => arg.slice(2).split("=")));
const [projectId, round, optionId] = args.filter((arg) => !arg.startsWith("--"));

try {
  const library = await loadLibrary();
  const ready = Object.values(library.cards).filter((card) => card.status === "ready").length;
  console.log(`library: ${Object.keys(library.cards).length} cards (${ready} ready), ${Object.keys(library.styles).length} styles, ${library.tasteRules.rules.length} taste rules`);
  if ("library" in flags) process.exit(0);
  if (!projectId || !round || (!optionId && !("all" in flags))) {
    console.error("Usage: node scripts/compile-storyboard.mjs <project> <round> <option-x|--all> [--out=file.json]");
    process.exit(2);
  }
  const ids = "all" in flags ? (await loadRound(projectId, round)).options.map((option) => option.id) : [optionId];
  let failed = false;
  for (const id of ids) {
    const result = await compileProjectOption(projectId, round, id, { library });
    console.log(`\n${id}: ${result.problems.length ? "FAILED" : "OK"}${result.plan ? `, ${result.segments.length} segment(s): ${result.segments.map((segment) => segment.id).join(", ")}` : ""}`);
    for (const problem of result.problems) console.log(`  ERROR  ${problem}`);
    for (const warning of result.warnings) console.log(`  WARN   ${warning.kind}: ${warning.message}`);
    for (const need of result.needs) console.log(`  NEED   ${need.label} (${need.asset}): ${need.status}`);
    for (const claim of result.claims) console.log(`  CLAIM  ${claim.text}: ${claim.status} (${claim.usedBy.join("; ")})`);
    console.log(`  GATE   ${result.gate.canConfirm ? "can be confirmed" : `blocked: ${result.gate.reasons.join("; ")}`}`);
    if (result.problems.length) failed = true;
    if (result.plan && flags.out) {
      const out = path.resolve(root, ids.length > 1 ? flags.out.replace(/\.json$/, `.${id}.json`) : flags.out);
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, JSON.stringify(result.plan, null, 2) + "\n");
      console.log(`  wrote  ${relative(out)}`);
    }
  }
  process.exit(failed ? 1 : 0);
} catch (error) {
  console.error(error.message ?? error);
  process.exit(1);
}
