// PROTOTYPE ONLY — Visual Command Lab click dummy: state model, Blue Thread model, copy parity.
import assert from "node:assert/strict";
import test from "node:test";

import {
  PHASES,
  initialLabState,
  labReducer,
  entryState,
  restingPhase,
  canGenerate,
} from "../src/prototype/visual-command/machine.ts";
import { traceView } from "../src/prototype/visual-command/trace.ts";
import { COPY } from "../src/prototype/visual-command/copy.ts";
import { commandCatalogue } from "../src/domain/commands/index.ts";

const COMMANDS = commandCatalogue.map((c) => ({ id: c.id, canonicalSlash: c.canonicalSlash, lane: c.lane }));
const DEMO = { kind: "demo", url: "data:image/svg+xml,demo", name: "demo" };
const FILE = { kind: "file", url: "blob:local/1", name: "me.jpg" };
const run = (events, from = initialLabState) => events.reduce((s, e) => labReducer(s, e), from);

test("brief §32 interaction grammar, end to end", () => {
  let s = run([{ type: "COMMAND_SELECTED", commandId: "actionfigure" }]);
  assert.equal(s.phase, "CAPABILITY_SELECTED");
  assert.equal(run([{ type: "SOURCE_SET", source: FILE }]).phase, "SOURCE_READY");

  s = run([{ type: "SOURCE_SET", source: FILE }], s);
  assert.equal(s.phase, "CAPABILITY_SELECTED", "complete intent, anonymous: still S1+S2, not READY");
  assert.equal(canGenerate(s), true, "Generate must be pressable before sign-in (04.2 S3 trigger)");

  s = run([{ type: "GENERATE" }], s);
  assert.equal(s.phase, "AUTH_REQUIRED");
  assert.equal(s.source, FILE, "auth keeps the source");
  assert.equal(s.commandId, "actionfigure", "auth keeps the capability");

  s = run([{ type: "AUTH_CONTINUE" }], s);
  assert.equal(s.phase, "READY");
  assert.equal(s.session, "signed_in");

  s = run([{ type: "GENERATE" }], s);
  assert.equal(s.phase, "GENERATING");
  s = run([{ type: "GENERATION_SETTLED", run: s.run, outcome: "success" }], s);
  assert.equal(s.phase, "RESULT");
  assert.deepEqual(s.result, { commandId: "actionfigure", sourceName: "me.jpg" });

  s = run([{ type: "TRY_ANOTHER" }], s);
  assert.equal(s.phase, "SOURCE_READY", "Try another keeps the source, clears the capability");
  assert.equal(s.source, FILE);
  assert.equal(s.commandId, null);
});

test("generation failures stop at the boundary and keep the intent", () => {
  for (const [outcome, phase] of [
    ["error", "RECOVERABLE_ERROR"],
    ["rate_limited", "RATE_LIMITED"],
    ["cost_bounded", "COST_BOUNDED"],
  ]) {
    let s = run([
      { type: "SESSION_SET", session: "signed_in" },
      { type: "SOURCE_SET", source: DEMO },
      { type: "COMMAND_SELECTED", commandId: "35mm" },
      { type: "GENERATE" },
    ]);
    s = run([{ type: "GENERATION_SETTLED", run: s.run, outcome }], s);
    assert.equal(s.phase, phase);
    assert.equal(s.source, DEMO);
    assert.equal(s.commandId, "35mm");
    const retried = run([{ type: "GENERATE" }], s);
    assert.equal(retried.phase, "GENERATING", `${phase} is recoverable`);
  }
});

test("auth cancel keeps the intent and returns to the resting phase", () => {
  const s = run([
    { type: "SOURCE_SET", source: DEMO },
    { type: "COMMAND_SELECTED", commandId: "manga" },
    { type: "GENERATE" },
    { type: "AUTH_CANCEL" },
  ]);
  assert.equal(s.phase, "CAPABILITY_SELECTED");
  assert.equal(s.source, DEMO);
  assert.equal(s.commandId, "manga");
  assert.equal(s.session, "anonymous");
});

test("duplicate prevention and stale results", () => {
  let s = run([
    { type: "SESSION_SET", session: "signed_in" },
    { type: "SOURCE_SET", source: DEMO },
    { type: "COMMAND_SELECTED", commandId: "mindmap" },
    { type: "GENERATE" },
  ]);
  const generating = s;
  assert.equal(run([{ type: "GENERATE" }], s), generating, "second Generate while executing is ignored");
  assert.equal(run([{ type: "COMMAND_SELECTED", commandId: "manga" }], s), generating, "intent frozen while executing");
  assert.equal(run([{ type: "GENERATION_SETTLED", run: s.run - 1, outcome: "success" }], s), generating, "stale run ignored");
  s = run([{ type: "LANE_SET", lane: "polish" }], s);
  assert.equal(s.phase, "GENERATING", "lane filter never touches execution");
});

test("lane filter keeps source and selection", () => {
  const s = run([
    { type: "SOURCE_SET", source: DEMO },
    { type: "COMMAND_SELECTED", commandId: "actionfigure" },
    { type: "LANE_SET", lane: "polish" },
  ]);
  assert.equal(s.lane, "polish");
  assert.equal(s.commandId, "actionfigure");
  assert.equal(s.source, DEMO);
});

test("deep link selects the command and exposes its lane; source may be missing", () => {
  for (const command of ["actionfigure", "/actionfigure"]) {
    const s = entryState({ command }, COMMANDS, DEMO);
    assert.equal(s.commandId, "actionfigure");
    assert.equal(s.lane, "play");
    assert.equal(s.phase, "CAPABILITY_SELECTED");
    assert.equal(s.source, null);
    assert.equal(traceView(s).nodes.capability, "active");
  }
  assert.equal(entryState({ command: "/lego" }, COMMANDS, DEMO).commandId, null, "/lego is not a canonical card");
  assert.equal(entryState({ command: "nope" }, COMMANDS, DEMO).phase, "BROWSE");
});

test("every catalogue state is reachable by replaying real events", () => {
  for (const phase of PHASES) {
    const s = entryState({ state: phase }, COMMANDS, DEMO);
    assert.equal(s.phase, phase, `catalogue cannot reach ${phase}`);
  }
});

test("state catalogue entries resolve to the phase they name (EN and DE)", () => {
  for (const locale of ["en", "de"]) {
    for (const entry of COPY[locale].catalogue.states) {
      const params = Object.fromEntries(new URLSearchParams(entry.query));
      const s = entryState(params, COMMANDS, DEMO);
      const named = entry.phase.split(" ")[0];
      if (PHASES.includes(named)) assert.equal(s.phase, named, `${locale}: ${entry.query}`);
    }
  }
  assert.deepEqual(
    COPY.en.catalogue.states.map((s) => s.query),
    COPY.de.catalogue.states.map((s) => s.query),
  );
});

test("resting phase is one rule", () => {
  assert.equal(restingPhase({ source: null, commandId: null, session: "anonymous" }), "BROWSE");
  assert.equal(restingPhase({ source: DEMO, commandId: null, session: "signed_in" }), "SOURCE_READY");
  assert.equal(restingPhase({ source: null, commandId: "x", session: "signed_in" }), "CAPABILITY_SELECTED");
  assert.equal(restingPhase({ source: DEMO, commandId: "x", session: "anonymous" }), "CAPABILITY_SELECTED");
  assert.equal(restingPhase({ source: DEMO, commandId: "x", session: "signed_in" }), "READY");
});

// ── Blue Thread model ────────────────────────────────────────────────────────────────────────

const allStates = () => {
  const out = PHASES.map((phase) => entryState({ state: phase }, COMMANDS, DEMO));
  out.push(entryState({ command: "actionfigure" }, COMMANDS, DEMO));
  out.push(entryState({ command: "actionfigure", source: "demo" }, COMMANDS, DEMO));
  return out;
};

test("trace: the branch exists only toward a selected capability", () => {
  for (const s of allStates()) {
    const v = traceView(s);
    if (s.commandId === null) assert.equal(v.segments.branch, "dormant", s.phase);
    else assert.notEqual(v.segments.branch, "dormant", s.phase);
  }
});

test("trace: auth pauses, failure stops, boundaries bound, result resolves — at the execution node", () => {
  const at = (phase) => traceView(entryState({ state: phase }, COMMANDS, DEMO));
  assert.equal(at("AUTH_REQUIRED").nodes.execute, "paused");
  assert.equal(at("AUTH_REQUIRED").segments.sourceToCapability, "active", "auth does not reset the trace");
  assert.equal(at("RECOVERABLE_ERROR").nodes.execute, "stopped");
  assert.equal(at("RECOVERABLE_ERROR").segments.sourceToCapability, "active", "failure keeps the established part");
  assert.equal(at("RECOVERABLE_ERROR").nodes.result, "dormant");
  assert.equal(at("RATE_LIMITED").nodes.execute, "bounded");
  assert.equal(at("COST_BOUNDED").nodes.execute, "bounded");
  assert.notEqual(at("RATE_LIMITED").key, at("RECOVERABLE_ERROR").key, "a boundary is not a failure");
  assert.equal(at("GENERATING").segments.executeToResult, "running");
  assert.equal(at("RESULT").nodes.result, "resolved");
  assert.equal(at("READY").nodes.execute, "boundary");
});

test("trace: decoration test — every phase maps to a distinct, labelled trace state", () => {
  const keys = new Set();
  for (const s of allStates()) {
    const v = traceView(s);
    keys.add(v.key);
    for (const locale of ["en", "de"]) assert.ok(COPY[locale].traceStates[v.key], `${locale} label for ${v.key}`);
    for (const form of Object.values(v.nodes)) assert.ok(COPY.en.nodeForms[form] && COPY.de.nodeForms[form], `label for node form ${form}`);
  }
  assert.equal(keys.size, Object.keys(COPY.en.traceStates).length, "every declared trace state is used");
});

// ── Copy parity ──────────────────────────────────────────────────────────────────────────────

function shape(value) {
  if (typeof value === "function") return "fn";
  if (Array.isArray(value)) return value.length > 0 && typeof value[0] === "object" ? value.map(shape) : `array`;
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, shape(value[k])]));
  return typeof value;
}

test("EN and DE copy have the same structure", () => {
  assert.deepEqual(shape(COPY.de), shape(COPY.en));
  assert.equal(COPY.de.notices.polishPreserveItems.length, COPY.en.notices.polishPreserveItems.length);
  assert.equal(COPY.de.notices.polishMayChangeItems.length, COPY.en.notices.polishMayChangeItems.length);
});

test("copy names no provider or model (brief §19, docs/contracts.md provider-term rule)", () => {
  const text = JSON.stringify(COPY).toLowerCase();
  for (const term of ["openrouter", "gemini", "gpt", "flux", "stable diffusion", "midjourney"]) assert.ok(!text.includes(term), term);
});

test("a catalogue state wins over a conflicting scenario parameter", () => {
  assert.equal(entryState({ state: "RATE_LIMITED", scenario: "success" }, COMMANDS, DEMO).phase, "RATE_LIMITED");
  assert.equal(entryState({ state: "RECOVERABLE_ERROR", scenario: "cost_bounded" }, COMMANDS, DEMO).phase, "RECOVERABLE_ERROR");
  assert.equal(entryState({ state: "RESULT", scenario: "error" }, COMMANDS, DEMO).phase, "RESULT");
});
