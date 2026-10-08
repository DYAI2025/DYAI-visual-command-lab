// PROTOTYPE ONLY — segmented Blue Thread primitives. No page-spanning SVG: each part lives inside
// the layout area it describes and reads its form from traceView(). Forms are drawn so that
// shape alone carries the state (dotted / dashed / solid / gap / cross / end bar); cobalt and
// motion only reinforce it.

import type { CSSProperties } from "react";
import type { NodeForm, SegmentForm } from "./trace.ts";

export function TraceNode({ form, className, style }: { form: NodeForm; className?: string; style?: CSSProperties }) {
  return <span className={`vcl-node${className ? ` ${className}` : ""}`} data-form={form} aria-hidden="true" style={style} />;
}

export function TraceSegment({
  form,
  axis = "v",
  className,
  style,
}: {
  form: SegmentForm;
  axis?: "v" | "h";
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span className={`vcl-seg vcl-seg--${axis}${className ? ` ${className}` : ""}`} data-form={form} aria-hidden="true" style={style}>
      {form === "running" ? <span className="vcl-seg-pulse" /> : null}
    </span>
  );
}

/**
 * Gutter → selected capability. Runs horizontally through the gap above the card's row (never
 * across another card), then drops a short port into the card's top edge.
 */
export function TraceBranch({ form, x, y, width, drop }: { form: SegmentForm; x: number; y: number; width: number; drop: number }) {
  return (
    <span className="vcl-branch" data-form={form} aria-hidden="true" style={{ left: x, top: y, width }}>
      <TraceSegment form={form} axis="h" className="vcl-branch-run" />
      <TraceSegment form={form} axis="v" className="vcl-branch-drop" style={{ height: drop }} />
    </span>
  );
}
