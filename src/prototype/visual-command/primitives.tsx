// PROTOTYPE ONLY — DYAI design-system primitives ported for the click dummy.
//
// Source: DYAI2025/DYAI-design-system_v2.1final@5fc119eb1e339dcc4855b2db711ce5697386647e
// (components/Wordmark, ButtonLink + IconArrow, Trace + TraceMark, LanguageSwitch, Meta). That
// repository is a token/static-preview source, not a React package, so the markup is ported here.

import type { ReactNode } from "react";
import type { Locale } from "./copy.ts";
import type { TraceGlyph } from "./trace.ts";

/** Three 2px bars, 100/68/36%, rotated −45° — CSS only (`.vcl-brand-mark`), never an image. */
export function Wordmark({ label }: { label: string }) {
  return (
    <span className="vcl-wordmark" aria-label={label} role="img">
      <span className="vcl-brand-mark" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span aria-hidden="true">DYAI</span>
      <small aria-hidden="true">STUDIO</small>
    </span>
  );
}

export function IconArrow({ direction = "right" }: { direction?: "right" | "down" }) {
  return (
    <svg
      className="vcl-icon-arrow"
      viewBox="0 0 17 17"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={direction === "down" ? { transform: "rotate(90deg)" } : undefined}
    >
      <path d="M3 8.5h11M9.5 4l4.5 4.5L9.5 13" />
    </svg>
  );
}

/** TraceMark geometry, verbatim from components/Trace/preview.html; `stopped` is prototype-local. */
export function TraceMark({ glyph }: { glyph: TraceGlyph }) {
  const shapes: Record<TraceGlyph, ReactNode> = {
    missing: (
      <>
        <path d="M2 8h8" />
        <path d="M14 8h4M22 8h4M30 8h4" strokeDasharray="1 3" />
        <path d="M38 8h8" />
      </>
    ),
    branch: (
      <>
        <path d="M2 8h16" />
        <path d="M18 8c8 0 8-5 16-5h12M18 8c8 0 8 5 16 5h12" />
      </>
    ),
    reduced: (
      <>
        <path d="M2 8h44" />
        <circle cx="12" cy="8" r="2.2" fill="currentColor" />
        <circle cx="24" cy="8" r="2.2" fill="currentColor" />
        <circle cx="36" cy="8" r="2.2" strokeDasharray="1.5 1.5" opacity=".5" />
      </>
    ),
    broken: (
      <>
        <path d="M2 8h14" />
        <path d="M32 8h14" />
        <circle cx="24" cy="8" r="2" strokeDasharray="2 2" />
      </>
    ),
    practice: (
      <>
        <path d="M2 8h44" />
        <path d="M8 5v6M16 5v6M24 5v6M32 5v6M40 5v6" />
      </>
    ),
    resolved: (
      <>
        <path d="M2 8h44" />
        <circle cx="24" cy="8" r="2.4" fill="currentColor" />
      </>
    ),
    bounded: (
      <>
        <path d="M8 8h32" />
        <path d="M8 3v10M40 3v10" />
        <path d="M2 8h3M43 8h3" strokeDasharray="1 2" />
      </>
    ),
    stopped: (
      <>
        <path d="M2 8h26" />
        <path d="M34 4l8 8M42 4l-8 8" />
      </>
    ),
  };
  return (
    <svg
      className={`vcl-trace-mark vcl-trace-mark--${glyph}`}
      viewBox="0 0 48 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
    >
      {shapes[glyph]}
    </svg>
  );
}

/** Eyebrow: TraceMark + "AUGMENTATION TRACE / <state>". */
export function TraceEyebrow({ glyph, name, state, inverse }: { glyph: TraceGlyph; name: string; state: string; inverse?: boolean }) {
  return (
    <span className={`vcl-trace${inverse ? " vcl-trace--inverse" : ""}`} data-glyph={glyph}>
      <TraceMark glyph={glyph} />
      <span className="vcl-trace-label">
        <span className="vcl-trace-name">{name}</span>
        <span aria-hidden="true"> / </span>
        {state}
      </span>
    </span>
  );
}

export function LanguageSwitch({ locale, onChange, label }: { locale: Locale; onChange: (l: Locale) => void; label: string }) {
  return (
    <div className="vcl-language-switch" role="group" aria-label={label}>
      {(["en", "de"] as const).map((l) => (
        <button key={l} type="button" lang={l} aria-pressed={locale === l} onClick={() => onChange(l)}>
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

export function Meta({ children, className, as: As = "span" }: { children: ReactNode; className?: string; as?: "span" | "div" | "p" }) {
  return <As className={`vcl-meta${className ? ` ${className}` : ""}`}>{children}</As>;
}
