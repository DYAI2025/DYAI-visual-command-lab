// PROTOTYPE ONLY — Visual Command Lab click dummy (no backend, no auth, no generation).
//
// Explicit state model for the click dummy, after Confluence 04.2 v1.2 §9/§12 (S0–S8). The
// real generation boundary (DYAI-37, POST /api/generate) answers with error codes such as
// `authentication_required`, `rate_limited` / `quota_exceeded` and `budget_exhausted`; this
// module only simulates the user-facing states those codes lead to. It never calls the server.

export const PHASES = [
  "BROWSE",
  "SOURCE_READY",
  "CAPABILITY_SELECTED",
  "AUTH_REQUIRED",
  "READY",
  "GENERATING",
  "RESULT",
  "RECOVERABLE_ERROR",
  "RATE_LIMITED",
  "COST_BOUNDED",
] as const;
export type Phase = (typeof PHASES)[number];

export const LANE_FILTERS = ["all", "play", "explain", "polish"] as const;
export type LaneFilter = (typeof LANE_FILTERS)[number];

export const OUTCOMES = ["success", "error", "rate_limited", "cost_bounded"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export type Session = "anonymous" | "signed_in";

export interface SourceRef {
  kind: "file" | "demo";
  /** blob: URL for a local file, data: URL for the demo source. Never uploaded. */
  url: string;
  name: string;
}

export interface LabState {
  phase: Phase;
  source: SourceRef | null;
  commandId: string | null;
  session: Session;
  lane: LaneFilter;
  /** Prototype scenario: what the simulated generation will answer. */
  scenario: Outcome;
  /** Incremented per generation; a settle event for an older run is ignored. */
  run: number;
  /** What the shown result was made from (survives until Try another / a new selection). */
  result: { commandId: string; sourceName: string } | null;
}

export type LabEvent =
  | { type: "SOURCE_SET"; source: SourceRef }
  | { type: "SOURCE_CLEARED" }
  | { type: "COMMAND_SELECTED"; commandId: string }
  | { type: "COMMAND_CLEARED" }
  | { type: "LANE_SET"; lane: LaneFilter }
  | { type: "GENERATE" }
  | { type: "AUTH_CONTINUE" }
  | { type: "AUTH_CANCEL" }
  | { type: "GENERATION_SETTLED"; run: number; outcome: Outcome }
  | { type: "TRY_ANOTHER" }
  | { type: "RESET" }
  // Prototype controller only — not product events.
  | { type: "SCENARIO_SET"; scenario: Outcome }
  | { type: "SESSION_SET"; session: Session };

export const initialLabState: LabState = {
  phase: "BROWSE",
  source: null,
  commandId: null,
  session: "anonymous",
  lane: "all",
  scenario: "success",
  run: 0,
  result: null,
};

const BLOCKED: ReadonlySet<Phase> = new Set(["RECOVERABLE_ERROR", "RATE_LIMITED", "COST_BOUNDED"]);

/** Resting phase from what the user has established. One rule, no scattered booleans. */
export function restingPhase(state: Pick<LabState, "source" | "commandId" | "session">): Phase {
  if (state.source && state.commandId) return state.session === "signed_in" ? "READY" : "CAPABILITY_SELECTED";
  if (state.commandId) return "CAPABILITY_SELECTED";
  if (state.source) return "SOURCE_READY";
  return "BROWSE";
}

/** Source + capability are both present: the human decision can be made. */
export function intentComplete(state: Pick<LabState, "source" | "commandId">): boolean {
  return state.source !== null && state.commandId !== null;
}

/** Generate is pressable: complete intent and not already executing or at the auth gate. */
export function canGenerate(state: LabState): boolean {
  return intentComplete(state) && state.phase !== "GENERATING" && state.phase !== "AUTH_REQUIRED";
}

function settle(state: LabState): LabState {
  return { ...state, phase: restingPhase(state) };
}

function startGeneration(state: LabState): LabState {
  if (!canGenerate(state)) return state;
  if (state.session !== "signed_in") return { ...state, phase: "AUTH_REQUIRED" };
  return { ...state, phase: "GENERATING", run: state.run + 1, result: null };
}

export function labReducer(state: LabState, event: LabEvent): LabState {
  switch (event.type) {
    case "SOURCE_SET":
    case "SOURCE_CLEARED":
    case "COMMAND_SELECTED":
    case "COMMAND_CLEARED": {
      // Duplicate prevention: the intent is frozen while it executes.
      if (state.phase === "GENERATING") return state;
      const next: LabState =
        event.type === "SOURCE_SET"
          ? { ...state, source: event.source }
          : event.type === "SOURCE_CLEARED"
            ? { ...state, source: null }
            : event.type === "COMMAND_SELECTED"
              ? { ...state, commandId: event.commandId }
              : { ...state, commandId: null };
      // A changed intent leaves a result or a blocked state behind; the auth gate stays open
      // only while the intent it guards is still complete.
      if (state.phase === "AUTH_REQUIRED" && intentComplete(next)) return next;
      return settle({ ...next, result: null });
    }
    case "LANE_SET":
      // Filtering never touches source, selection or execution state.
      return { ...state, lane: event.lane };
    case "GENERATE":
      if (state.phase === "RESULT") return state;
      return startGeneration(state);
    case "AUTH_CONTINUE":
      if (state.phase !== "AUTH_REQUIRED") return state;
      // Simulated sign-in: return to the exact intent, now READY. Execution stays a human decision.
      return settle({ ...state, session: "signed_in" });
    case "AUTH_CANCEL":
      if (state.phase !== "AUTH_REQUIRED") return state;
      return settle(state);
    case "GENERATION_SETTLED": {
      if (state.phase !== "GENERATING" || event.run !== state.run) return state;
      if (event.outcome === "success") {
        const sourceName = state.source?.name ?? "";
        return { ...state, phase: "RESULT", result: { commandId: state.commandId ?? "", sourceName } };
      }
      const phase: Phase =
        event.outcome === "error" ? "RECOVERABLE_ERROR" : event.outcome === "rate_limited" ? "RATE_LIMITED" : "COST_BOUNDED";
      return { ...state, phase };
    }
    case "TRY_ANOTHER":
      if (state.phase !== "RESULT" && !BLOCKED.has(state.phase)) return state;
      // Source stays, capability is cleared, browsing resumes (04.2 §12).
      return settle({ ...state, commandId: null, result: null });
    case "RESET":
      return { ...initialLabState, scenario: state.scenario };
    case "SCENARIO_SET":
      return { ...state, scenario: event.scenario };
    case "SESSION_SET": {
      const next = { ...state, session: event.session };
      if (state.phase === "GENERATING" || state.phase === "RESULT" || BLOCKED.has(state.phase)) return next;
      if (state.phase === "AUTH_REQUIRED") return event.session === "signed_in" ? settle(next) : next;
      return settle(next);
    }
  }
}

export function isBlocked(phase: Phase): boolean {
  return BLOCKED.has(phase);
}

// ── Deep links and the state catalogue ────────────────────────────────────────────────────

export interface EntryParams {
  /** `?command=actionfigure` (id) or `?command=/actionfigure` (canonical slash). */
  command?: string;
  /** `?source=demo` loads the demo source. */
  source?: string;
  /** `?state=AUTH_REQUIRED` etc. — the review catalogue drives the reducer to that phase. */
  state?: string;
  /** `?scenario=error|rate_limited|cost_bounded|success` */
  scenario?: string;
  /** `?lane=play|explain|polish|all` */
  lane?: string;
}

export interface CommandRef {
  id: string;
  canonicalSlash: string;
  lane: Exclude<LaneFilter, "all">;
}

const PHASE_SCENARIO: Partial<Record<Phase, Outcome>> = {
  RECOVERABLE_ERROR: "error",
  RATE_LIMITED: "rate_limited",
  COST_BOUNDED: "cost_bounded",
};

/** Default capability used by the catalogue when a state needs one and none was named. */
export const CATALOGUE_DEFAULT_COMMAND = "actionfigure";

export function resolveCommand(value: string | undefined, commands: readonly CommandRef[]): CommandRef | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  return commands.find((c) => c.id === v || c.canonicalSlash === v || c.canonicalSlash === `/${v}`);
}

/**
 * Initial state for a URL. Every target phase is reached by replaying real events through the
 * reducer, so a catalogue state can never be one the interaction itself could not produce.
 */
export function entryState(
  params: EntryParams,
  commands: readonly CommandRef[],
  demoSource: SourceRef,
): LabState {
  const target = PHASES.find((p) => p === params.state);
  const scenario = OUTCOMES.find((o) => o === params.scenario) ?? (target && PHASE_SCENARIO[target]) ?? "success";
  let command = resolveCommand(params.command, commands);
  const needsCommand = target !== undefined && target !== "BROWSE" && target !== "SOURCE_READY";
  if (!command && needsCommand) command = resolveCommand(CATALOGUE_DEFAULT_COMMAND, commands);
  const needsSource = target !== undefined && target !== "BROWSE" && target !== "CAPABILITY_SELECTED";
  const withSource = params.source === "demo" || needsSource;

  const run = (s: LabState, e: LabEvent) => labReducer(s, e);
  let s = run(initialLabState, { type: "SCENARIO_SET", scenario });
  if (withSource) s = run(s, { type: "SOURCE_SET", source: demoSource });
  if (command) {
    s = run(s, { type: "COMMAND_SELECTED", commandId: command.id });
    // A deep link exposes the command's lane (04.2 §12: referenced command visible/selected).
    s = run(s, { type: "LANE_SET", lane: command.lane });
  }
  const lane = LANE_FILTERS.find((l) => l === params.lane);
  if (lane) s = run(s, { type: "LANE_SET", lane });

  if (!target || target === "BROWSE" || target === "SOURCE_READY" || target === "CAPABILITY_SELECTED") return s;
  if (target === "AUTH_REQUIRED") return run(s, { type: "GENERATE" });
  s = run(s, { type: "SESSION_SET", session: "signed_in" });
  if (target === "READY") return s;
  s = run(s, { type: "GENERATE" });
  if (target === "GENERATING") return s;
  s = run(s, { type: "GENERATION_SETTLED", run: s.run, outcome: target === "RESULT" ? "success" : (PHASE_SCENARIO[target] ?? scenario) });
  return s;
}
