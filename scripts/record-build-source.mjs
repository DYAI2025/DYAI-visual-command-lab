// postbuild: records which commit the production build in .next was made from, so real-boundary
// evidence can prove it ran the exact candidate (scripts/live-route-smoke.mjs checks it).
import fs from "node:fs";
import { gitState } from "./lib/plan.mjs";

let state;
try {
  state = gitState();
} catch {
  state = { sha: null, clean: false }; // not a git checkout (e.g. an exported tree): never a candidate
}
fs.writeFileSync(".next/dyai-build-source.json", `${JSON.stringify(state)}\n`);
console.log(`build source: ${state.sha ?? "unknown"}${state.clean ? "" : " (working tree not clean)"}`);
