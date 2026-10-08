// PROTOTYPE ONLY — the Blue Thread (Augmentation Trace) as a pure function of the lab state.
//
// The trace is an expression of the state model, not the state model itself: every value here
// is derived from LabState and nothing in the UI reads trace state to decide behaviour.

import { intentComplete, type LabState } from "./machine.ts";

/** Node forms. Each has a distinct shape, so meaning survives without cobalt or motion. */
export type NodeForm =
  | "dormant" //   hollow square, neutral
  | "active" //    filled square
  | "boundary" //  hollow square with signal edge: the execution boundary is reached, not crossed
  | "paused" //    hollow square with two bars: checkpoint (auth)
  | "running" //   filled square + indeterminate segment
  | "stopped" //   cross: failed at this boundary
  | "bounded" //   end bar: bounded system state, recoverable
  | "resolved"; // filled square inside a ring

/** Segment forms. dotted < dashed < solid; paused/stopped/bounded end at the boundary. */
export type SegmentForm = "dormant" | "pending" | "active" | "paused" | "running" | "stopped" | "bounded" | "resolved";

export type TraceKey =
  | "dormant"
  | "source"
  | "capability"
  | "decision"
  | "auth"
  | "generating"
  | "resolved"
  | "error"
  | "rate"
  | "cost";

/** Canonical TraceMark geometry from the DYAI design system (components/Trace). */
// "stopped" is a prototype-local extension (line ending in a cross); every other value is canonical.
export type TraceGlyph = "missing" | "branch" | "reduced" | "broken" | "practice" | "resolved" | "bounded" | "stopped";

export interface TraceView {
  key: TraceKey;
  glyph: TraceGlyph;
  nodes: { source: NodeForm; capability: NodeForm; execute: NodeForm; result: NodeForm };
  segments: {
    /** Source node → branch point (desktop gutter) / SOURCE→CAPABILITY (mobile). */
    sourceToCapability: SegmentForm;
    /** Gutter → selected card. Only the selected capability ever receives it. */
    branch: SegmentForm;
    /** Branch point → execution boundary (action strip). */
    capabilityToExecute: SegmentForm;
    /** Execution boundary → result surface. */
    executeToResult: SegmentForm;
  };
}

export function traceView(state: LabState): TraceView {
  const hasSource = state.source !== null;
  const hasCommand = state.commandId !== null;
  const complete = intentComplete(state);
  const source: NodeForm = hasSource ? "active" : "dormant";
  const capability: NodeForm = hasCommand ? "active" : "dormant";
  // One established end + one missing end = the relationship is pending; both = active.
  const sourceToCapability: SegmentForm = complete ? "active" : hasSource || hasCommand ? "pending" : "dormant";
  const branch: SegmentForm = hasCommand ? (hasSource ? "active" : "pending") : "dormant";
  const base = { source, capability };

  switch (state.phase) {
    case "BROWSE":
      return {
        key: "dormant",
        glyph: "missing",
        nodes: { ...base, execute: "dormant", result: "dormant" },
        segments: { sourceToCapability, branch, capabilityToExecute: "dormant", executeToResult: "dormant" },
      };
    case "SOURCE_READY":
      return {
        key: "source",
        glyph: "missing",
        nodes: { ...base, execute: "dormant", result: "dormant" },
        segments: { sourceToCapability, branch, capabilityToExecute: "dormant", executeToResult: "dormant" },
      };
    case "CAPABILITY_SELECTED":
    case "READY":
      return complete
        ? {
            key: "decision",
            glyph: "reduced",
            nodes: { ...base, execute: "boundary", result: "dormant" },
            segments: { sourceToCapability, branch, capabilityToExecute: "active", executeToResult: "dormant" },
          }
        : {
            key: "capability",
            glyph: "branch",
            nodes: { ...base, execute: "dormant", result: "dormant" },
            segments: { sourceToCapability, branch, capabilityToExecute: "pending", executeToResult: "dormant" },
          };
    case "AUTH_REQUIRED":
      return {
        key: "auth",
        glyph: "broken",
        nodes: { ...base, execute: "paused", result: "dormant" },
        segments: { sourceToCapability, branch, capabilityToExecute: "paused", executeToResult: "dormant" },
      };
    case "GENERATING":
      return {
        key: "generating",
        glyph: "practice",
        nodes: { ...base, execute: "running", result: "dormant" },
        segments: { sourceToCapability, branch, capabilityToExecute: "active", executeToResult: "running" },
      };
    case "RESULT":
      return {
        key: "resolved",
        glyph: "resolved",
        nodes: { source: "resolved", capability: "resolved", execute: "resolved", result: "resolved" },
        segments: { sourceToCapability: "resolved", branch: "resolved", capabilityToExecute: "resolved", executeToResult: "resolved" },
      };
    case "RECOVERABLE_ERROR":
      return {
        key: "error",
        glyph: "stopped",
        nodes: { ...base, execute: "stopped", result: "dormant" },
        segments: { sourceToCapability, branch, capabilityToExecute: "stopped", executeToResult: "dormant" },
      };
    case "RATE_LIMITED":
    case "COST_BOUNDED":
      return {
        key: state.phase === "RATE_LIMITED" ? "rate" : "cost",
        glyph: "bounded",
        nodes: { ...base, execute: "bounded", result: "dormant" },
        segments: { sourceToCapability, branch, capabilityToExecute: "bounded", executeToResult: "dormant" },
      };
  }
}
