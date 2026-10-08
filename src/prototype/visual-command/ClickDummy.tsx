"use client";
/* eslint-disable @next/next/no-img-element -- image content is local blob:/data: URLs; next/image adds nothing for them */

// PROTOTYPE ONLY — Visual Command Lab click dummy. Everything here runs in the browser: the source
// image never leaves it, sign-in is simulated, and "generation" is a local timer whose answer is
// chosen by the prototype controller (?prototype=1). Nothing calls /api/generate.

import { useEffect, useLayoutEffect, useReducer, useRef, useState, type Dispatch, type DragEvent, type ReactNode, type RefObject } from "react";
import type { Lane } from "@/domain/commands";
import { capabilityArt, DEMO_SOURCE_URL, LOCAL_TREATMENT, svgDataUrl } from "./art.ts";
import { COPY, type Copy, type Locale } from "./copy.ts";
import {
  canGenerate,
  entryState,
  intentComplete,
  isBlocked,
  labReducer,
  LANE_FILTERS,
  OUTCOMES,
  type CommandRef,
  type EntryParams,
  type LabEvent,
  type LabState,
  type Phase,
  type SourceRef,
} from "./machine.ts";
import { IconArrow, LanguageSwitch, Meta, TraceEyebrow, Wordmark } from "./primitives.tsx";
import { recipeSummary } from "./recipe-summaries.ts";
import { traceView, type NodeForm, type TraceView } from "./trace.ts";
import { TraceBranch, TraceNode, TraceSegment } from "./trace-parts.tsx";

export interface CommandView {
  id: string;
  slash: string;
  lane: Lane;
  name: Record<Locale, string>;
  description: Record<Locale, string>;
  job: Record<Locale, string>;
}

interface Props {
  initialLocale: Locale;
  entry: EntryParams;
  prototype: boolean;
  hold: boolean;
  commands: CommandView[];
}

/** Simulated execution time — long enough to read the state, short enough for a prototype. */
const GENERATION_MS = 2200;
const ACCEPTED = ["image/jpeg", "image/png", "image/webp"];
/** Vertical drop from the branch run into the selected card's top edge (half the row gap). */
const DROP = 10;

const DEMO_SOURCE: SourceRef = { kind: "demo", url: DEMO_SOURCE_URL, name: "demo" };
const THUMBS = new Map<string, string>();
const thumb = (id: string) => {
  let url = THUMBS.get(id);
  if (!url) THUMBS.set(id, (url = svgDataUrl(capabilityArt(id))));
  return url;
};

/** gx, branchY, branchX: workspace coordinates (the branch). sourceY, splitY, height: gutter coordinates. */
type Geometry = { gx: number; sourceY: number; branchY: number | null; branchX: number | null; splitY: number | null; height: number };

export default function ClickDummy({ initialLocale, entry, prototype, hold, commands }: Props) {
  const refs: CommandRef[] = commands.map((c) => ({ id: c.id, canonicalSlash: c.slash, lane: c.lane }));
  const [state, dispatch] = useReducer(labReducer, undefined, () => entryState(entry, refs, DEMO_SOURCE));
  const [holdRun] = useState(() => (hold ? entryState(entry, refs, DEMO_SOURCE).run : -1));
  const [locale, setLocale] = useState<Locale>(initialLocale);
  // What the single live region currently announces. A language switch replaces the phase text
  // with "Language: …" instead of re-announcing the unchanged phase in the new language.
  const [announcement, setAnnouncement] = useState<{ kind: "phase" | "language"; phase: Phase }>({
    kind: "phase",
    phase: state.phase,
  });
  if (announcement.phase !== state.phase) setAnnouncement({ kind: "phase", phase: state.phase });
  const [sourceError, setSourceError] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [recipeOpen, setRecipeOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [downloadNote, setDownloadNote] = useState<"" | "ok" | "failed">("");
  // Remounts the status line per download, so a repeated download is announced again.
  const [downloadCount, setDownloadCount] = useState(0);
  const [geo, setGeo] = useState<Geometry | null>(null);

  const t = COPY[locale];
  const view = traceView(state);
  const command = commands.find((c) => c.id === state.commandId) ?? null;
  const resultCommand = commands.find((c) => c.id === state.result?.commandId) ?? command;
  const visible = commands.filter((c) => state.lane === "all" || c.lane === state.lane);
  const selectedHidden = command !== null && !visible.some((c) => c.id === command.id);
  const generating = state.phase === "GENERATING";

  const fileRef = useRef<HTMLInputElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const sourceLabelRef = useRef<HTMLParagraphElement>(null);
  const hiddenNoteRef = useRef<HTMLParagraphElement>(null);
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());
  const generateRef = useRef<HTMLButtonElement>(null);
  const gateHeadingRef = useRef<HTMLHeadingElement>(null);
  const failureHeadingRef = useRef<HTMLHeadingElement>(null);
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
  const galleryHeadingRef = useRef<HTMLHeadingElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const blobUrl = useRef<string | null>(null);
  const prevPhase = useRef(state.phase);

  // ── Simulated generation: a local timer, answer chosen by the prototype scenario. ──────────
  useEffect(() => {
    if (state.phase !== "GENERATING" || state.run === holdRun) return;
    const run = state.run;
    const outcome = state.scenario;
    const timer = window.setTimeout(() => dispatch({ type: "GENERATION_SETTLED", run, outcome }), GENERATION_MS);
    return () => window.clearTimeout(timer);
  }, [state.phase, state.run, state.scenario, holdRun]);

  // ── Focus follows the boundary the user has to deal with next. ──────────────────────────────
  useEffect(() => {
    const prev = prevPhase.current;
    prevPhase.current = state.phase;
    if (prev === state.phase) return;
    // Retry (blocked → GENERATING) keeps focus at the execution boundary; only leaving a result or
    // a blocked state without a capability (Try another / Choose another) returns to the gallery.
    const target =
      state.phase === "AUTH_REQUIRED"
        ? gateHeadingRef.current
        : state.phase === "RESULT"
          ? resultHeadingRef.current
          : isBlocked(state.phase)
            ? failureHeadingRef.current
            : state.phase === "GENERATING"
              ? statusRef.current
              : prev === "AUTH_REQUIRED"
                ? generateRef.current
                : (prev === "RESULT" || isBlocked(prev)) && state.commandId === null
                  ? galleryHeadingRef.current
                  : null;
    if (!target) return;
    const behavior: ScrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    const frame = window.requestAnimationFrame(() => {
      target.focus({ preventScroll: true });
      const scrollTarget = state.phase === "RESULT" ? target.closest("section") : target === galleryHeadingRef.current ? target : null;
      scrollTarget?.scrollIntoView({ block: "start", behavior });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [state.phase, state.commandId]);

  // ── Blue Thread geometry (desktop gutter only). Measured, never animated by scroll. ─────────
  useLayoutEffect(() => {
    const ws = workspaceRef.current;
    const gutter = gutterRef.current;
    if (!ws || !gutter) return;
    const measure = () => {
      if (getComputedStyle(gutter).display === "none") return setGeo(null);
      const wr = ws.getBoundingClientRect();
      const gr = gutter.getBoundingClientRect();
      // Offset inside the rail, not its live position: the rail may be sticky and scrolled.
      const labelEl = sourceLabelRef.current;
      const label = labelEl?.getBoundingClientRect();
      const rail = labelEl?.closest("aside")?.getBoundingClientRect();
      const target = state.commandId
        ? (cardRefs.current.get(state.commandId) ?? hiddenNoteRef.current)
        : null;
      const tr = target?.getBoundingClientRect();
      setGeo({
        gx: gr.left - wr.left + gr.width / 2,
        sourceY: label && rail ? label.top - rail.top + label.height / 2 : 12,
        branchY: tr ? tr.top - wr.top - DROP : null,
        branchX: tr ? tr.left - wr.left + 24 : null,
        splitY: tr ? tr.top - gr.top - DROP : null,
        // Down to the workspace's bottom edge, where the action strip continues the line.
        height: wr.bottom - gr.top,
      });
    };
    const frame = window.requestAnimationFrame(measure);
    const observer = new ResizeObserver(measure);
    observer.observe(ws);
    window.addEventListener("resize", measure);
    void document.fonts?.ready.then(measure);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [state.commandId, state.lane, state.source, state.phase, locale]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(
    () => () => {
      if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
    },
    [],
  );

  // ── Handlers ────────────────────────────────────────────────────────────────────────────────
  const releaseBlob = () => {
    if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
    blobUrl.current = null;
  };

  const takeFile = (file: File | undefined) => {
    if (!file) return;
    if (!ACCEPTED.includes(file.type)) return setSourceError(true);
    if (generating) return;
    setSourceError(false);
    releaseBlob();
    const url = URL.createObjectURL(file);
    blobUrl.current = url;
    dispatch({ type: "SOURCE_SET", source: { kind: "file", url, name: file.name } });
  };

  const useDemo = () => {
    setSourceError(false);
    releaseBlob();
    dispatch({ type: "SOURCE_SET", source: DEMO_SOURCE });
  };

  const removeSource = () => {
    releaseBlob();
    dispatch({ type: "SOURCE_CLEARED" });
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    takeFile(event.dataTransfer.files[0]);
  };

  const switchLanguage = (next: Locale) => {
    if (next === locale) return;
    setLocale(next);
    setAnnouncement({ kind: "language", phase: state.phase });
    // Keep the interaction state: rewrite the URL without a navigation.
    const url = new URL(window.location.href);
    url.pathname = url.pathname.replace(/^\/(en|de)(?=\/|$)/, `/${next}`);
    window.history.replaceState(window.history.state, "", url);
  };

  const reset = () => {
    releaseBlob();
    setRecipeOpen(false);
    setDownloadNote("");
    dispatch({ type: "RESET" });
  };

  const tryAnother = () => {
    setRecipeOpen(false);
    setDownloadNote("");
    dispatch({ type: "TRY_ANOTHER" });
  };

  const download = async () => {
    if (!state.source || !resultCommand) return;
    const name = `dyai-${resultCommand.id}-simulated-output`;
    try {
      let blob: Blob;
      let extension: string;
      if (state.source.kind === "demo") {
        blob = new Blob([capabilityArt(resultCommand.id)], { type: "image/svg+xml" });
        extension = "svg";
      } else {
        blob = await renderLocalResult(state.source.url, resultCommand.id, `${t.result.simulatedMarker} · ${resultCommand.slash}`);
        extension = "png";
      }
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = `${name}.${extension}`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(href), 1000);
      setDownloadNote("ok");
      setDownloadCount((n) => n + 1);
    } catch {
      setDownloadNote("failed");
      setDownloadCount((n) => n + 1);
    }
  };

  const sourceName = state.source ? (state.source.kind === "demo" ? t.sourceDemoName : state.source.name) : null;

  // ── Render ──────────────────────────────────────────────────────────────────────────────────
  return (
    <div className="vcl" data-phase={state.phase} data-trace={view.key} data-session={state.session} lang={locale}>
      {/* A held state (?hold=1) needs the controller's Reset to leave it. */}
      {prototype || hold ? <ScenarioPanel t={t} state={state} dispatch={dispatch} onReset={reset} locale={locale} /> : null}

      <header className="vcl-header">
        <div className="vcl-shell vcl-header-inner">
          <Wordmark label={t.wordmarkLabel} />
          <Meta className="vcl-header-lab">
            {t.labName} · VC-01
          </Meta>
          <span className="vcl-header-badge vcl-meta">{t.prototypeBadge}</span>
          <LanguageSwitch locale={locale} onChange={switchLanguage} label={locale === "de" ? "Sprache" : "Language"} />
        </div>
      </header>

      <main id="lab">
        <section className="vcl-shell vcl-hero" aria-labelledby="vcl-title">
          <div>
            <Meta as="p" className="vcl-eyebrow">
              {t.eyebrow}
            </Meta>
            <h1 id="vcl-title" className="vcl-hero-title">
              {t.title}
            </h1>
          </div>
          <div className="vcl-hero-side">
            <p className="vcl-intro">{t.intro}</p>
            <Meta as="p" className="vcl-intro-meta">
              {t.introMeta}
            </Meta>
          </div>
        </section>

        <div className="vcl-shell vcl-cols vcl-workspace" ref={workspaceRef}>
          {/* ── 01 Source · 02 Mode · selected capability ─────────────────────────────── */}
          <aside className="vcl-rail" aria-label={`${t.sourceLabel} · ${t.modeLabel}`}>
            <div className="vcl-rail-inner">
              <p className="vcl-meta vcl-section-label" ref={sourceLabelRef}>
                <TraceNode form={view.nodes.source} className="vcl-node--inline" />
                {t.sourceLabel}
              </p>
              <div
                className="vcl-drop"
                data-has-source={state.source ? "true" : "false"}
                data-dragging={dragging ? "true" : "false"}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
              >
                {state.source ? (
                  <figure className="vcl-source">
                    <img src={state.source.url} alt={sourceName ?? ""} />
                    <figcaption>
                      <span className="vcl-source-name">{sourceName}</span>
                      <Meta>{t.sourceLocal}</Meta>
                    </figcaption>
                  </figure>
                ) : (
                  <div className="vcl-drop-empty">
                    <span className="vcl-drop-frame" aria-hidden="true" />
                    <span className="vcl-meta">{t.sourceEmpty}</span>
                    <span className="vcl-drop-hint">{t.sourceDrop}</span>
                  </div>
                )}
                <div className="vcl-drop-actions">
                  <button type="button" className="vcl-button-secondary" onClick={() => fileRef.current?.click()} disabled={generating}>
                    {state.source ? t.sourceReplace : t.sourceChoose}
                  </button>
                  {state.source ? (
                    <button type="button" className="vcl-text-button" onClick={removeSource} disabled={generating}>
                      {t.sourceRemove}
                    </button>
                  ) : (
                    <button type="button" className="vcl-text-button" onClick={useDemo}>
                      {t.sourceDemo}
                    </button>
                  )}
                </div>
                <input
                  ref={fileRef}
                  className="vcl-file"
                  type="file"
                  accept={ACCEPTED.join(",")}
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={(e) => {
                    takeFile(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              </div>
              {sourceError ? (
                <p className="vcl-inline-error" role="alert">
                  {t.sourceInvalid}
                </p>
              ) : null}

              <div className="vcl-mode">
                <p className="vcl-meta vcl-section-label">{t.modeLabel}</p>
                <dl>
                  {t.mode.map((m) => (
                    <div key={m.name}>
                      <dt>{m.name}</dt>
                      <dd className="vcl-meta">{m.value}</dd>
                    </div>
                  ))}
                </dl>
                <button
                  type="button"
                  className="vcl-text-button"
                  aria-expanded={advancedOpen}
                  aria-controls="vcl-advanced"
                  onClick={() => setAdvancedOpen((o) => !o)}
                >
                  {t.modeAdvanced}
                </button>
                <p id="vcl-advanced" className="vcl-mode-note" hidden={!advancedOpen}>
                  {t.modeAdvancedNote}
                </p>
              </div>

              <div className="vcl-intent" data-selected={command ? "true" : "false"}>
                <p className="vcl-meta vcl-section-label">
                  <TraceNode form={view.nodes.capability} className="vcl-node--inline" />
                  {t.intentLabel}
                </p>
                {command ? (
                  <>
                    <p className="vcl-intent-name">
                      {command.name[locale]} <code className="vcl-slash">{command.slash}</code>
                    </p>
                    <p className="vcl-intent-desc">{command.description[locale]}</p>
                    <CapabilityNotice command={command} t={t} />
                  </>
                ) : (
                  <p className="vcl-intent-none">{t.intentNone}</p>
                )}
              </div>
            </div>
          </aside>

          {/* ── Trace gutter (desktop). Segments are local; the branch is measured. ───────── */}
          <div className="vcl-gutter" ref={gutterRef} aria-hidden="true">
            <Gutter view={view} geo={geo} />
          </div>
          {geo && geo.branchY !== null && geo.branchX !== null ? (
            <TraceBranch form={view.segments.branch} x={geo.gx} y={geo.branchY} width={Math.max(0, geo.branchX - geo.gx)} drop={DROP} />
          ) : null}

          {/* ── 03 Capability ─────────────────────────────────────────────────────────── */}
          <section className="vcl-gallery" aria-labelledby="vcl-gallery-title">
            <div className="vcl-gallery-head">
              <div>
                <p className="vcl-meta vcl-section-label">{t.capabilitiesLabel}</p>
                <h2 id="vcl-gallery-title" className="vcl-gallery-title" tabIndex={-1} ref={galleryHeadingRef}>
                  {t.capabilitiesTitle}
                </h2>
              </div>
              <div className="vcl-lanes-row">
                <div className="vcl-lanes" role="group" aria-label={t.laneGroup}>
                  {LANE_FILTERS.map((lane) => (
                    <button
                      key={lane}
                      type="button"
                      aria-pressed={state.lane === lane}
                      onClick={() => dispatch({ type: "LANE_SET", lane })}
                    >
                      <span className="vcl-scenario-dot" aria-hidden="true" />
                      {t.lanes[lane]}
                    </button>
                  ))}
                </div>
                <Meta>{t.count(visible.length)}</Meta>
              </div>
              {selectedHidden && command ? (
                <p className="vcl-hidden-note" ref={hiddenNoteRef}>
                  <span>{t.hiddenByFilter(command.slash)}</span>{" "}
                  <button type="button" className="vcl-text-button" onClick={() => dispatch({ type: "LANE_SET", lane: "all" })}>
                    {t.showAll}
                  </button>
                </p>
              ) : null}
            </div>
            <ul className="vcl-grid">
              {visible.map((c) => {
                const selected = c.id === state.commandId;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      className="vcl-card"
                      aria-pressed={selected}
                      disabled={generating}
                      data-lane={c.lane}
                      ref={(el) => {
                        if (el) cardRefs.current.set(c.id, el);
                        else cardRefs.current.delete(c.id);
                      }}
                      onClick={() =>
                        dispatch(selected ? { type: "COMMAND_CLEARED" } : { type: "COMMAND_SELECTED", commandId: c.id })
                      }
                    >
                      <span className="vcl-card-thumb">
                        <img src={thumb(c.id)} alt="" data-simulated="SIMULATED OUTPUT" loading="lazy" />
                      </span>
                      <span className="vcl-card-body">
                        <span className="vcl-card-name">{c.name[locale]}</span>
                        <code className="vcl-slash">{c.slash}</code>
                        <span className="vcl-card-foot">
                          <span className="vcl-meta">{t.lanes[c.lane]}</span>
                          <span className="vcl-card-state vcl-meta" aria-hidden="true">
                            <span className="vcl-mini-signal" />
                            {selected ? t.selected : t.select}
                          </span>
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>

        {/* ── Persistent action boundary (graphite) ────────────────────────────────────── */}
        <ActionStrip
          t={t}
          state={state}
          view={view}
          command={command}
          sourceName={sourceName}
          generateRef={generateRef}
          gateHeadingRef={gateHeadingRef}
          failureHeadingRef={failureHeadingRef}
          statusRef={statusRef}
          dispatch={dispatch}
          chooseSource={() => fileRef.current?.click()}
          tryAnother={tryAnother}
          locale={locale}
        />

        {state.phase === "RESULT" && resultCommand && state.source ? (
          <section className="vcl-shell vcl-cols vcl-result" aria-labelledby="vcl-result-title">
            <div className="vcl-result-meta">
              <TraceEyebrow glyph={view.glyph} name={t.traceName} state={t.traceStates[view.key]} />
              <p className="vcl-meta vcl-section-label">{t.result.label}</p>
              <h2 id="vcl-result-title" className="vcl-result-title" tabIndex={-1} ref={resultHeadingRef}>
                {t.result.title(resultCommand.name[locale])}
              </h2>
              <p className="vcl-result-marker">
                <code className="vcl-slash">{resultCommand.slash}</code>
                <Meta>
                  {t.lanes[resultCommand.lane]} · {t.result.simulatedMarker}
                </Meta>
              </p>
              <Meta as="p">{t.result.from(sourceName ?? "")}</Meta>
              <div className="vcl-notices">
                <CapabilityNotice command={resultCommand} t={t} />
                <p className="vcl-notice vcl-notice--synthetic">{t.notices.synthetic}</p>
              </div>
            </div>
            <div className="vcl-result-gutter" aria-hidden="true">
              <TraceSegment form={view.segments.executeToResult} className="vcl-result-stub" />
              <TraceNode form={view.nodes.result} className="vcl-result-node" />
            </div>
            <div className="vcl-result-main">
              <ResultCanvas source={state.source} commandId={resultCommand.id} marker={t.result.simulatedMarker} />
              <p className="vcl-result-note vcl-meta">{t.result.simulatedNote}</p>
              <div className="vcl-result-actions">
                <button type="button" className="vcl-action" onClick={download}>
                  {t.result.download}
                  <IconArrow direction="down" />
                </button>
                <button type="button" className="vcl-action vcl-action--secondary" onClick={tryAnother}>
                  {t.result.tryAnother}
                  <IconArrow />
                </button>
                <button
                  type="button"
                  className="vcl-text-button"
                  aria-expanded={recipeOpen}
                  aria-controls="vcl-recipe"
                  onClick={() => setRecipeOpen((o) => !o)}
                >
                  {recipeOpen ? t.result.hideRecipe : t.result.viewRecipe}
                </button>
              </div>
              {downloadNote ? (
                <p key={downloadCount} className={downloadNote === "failed" ? "vcl-inline-error" : "vcl-meta"} role="status">
                  {downloadNote === "failed" ? t.result.downloadFailed : t.result.downloaded}
                </p>
              ) : null}
              <RecipePanel open={recipeOpen} command={resultCommand} t={t} locale={locale} />
            </div>
          </section>
        ) : null}
      </main>

      <footer className="vcl-footer">
        <div className="vcl-shell vcl-footer-inner">
          <Meta>DYAI Studio · {t.labName}</Meta>
          <Meta>{t.prototypeBadge}</Meta>
        </div>
      </footer>

      {/* One live region; its text changes once per event (phase change or language switch). */}
      <p className="vcl-sr-only" role="status" aria-live="polite">
        {announcement.kind === "language" ? t.languageAnnounce : t.announce[announcement.phase]}
      </p>
    </div>
  );
}

// ── Gutter ────────────────────────────────────────────────────────────────────────────────────

function Gutter({ view, geo }: { view: TraceView; geo: Geometry | null }) {
  if (!geo) {
    return (
      <>
        <TraceNode form={view.nodes.source} className="vcl-gutter-node" style={{ top: 12 }} />
        <TraceSegment form={view.segments.sourceToCapability} style={{ top: 24, bottom: 0 }} className="vcl-gutter-seg" />
      </>
    );
  }
  const top = geo.sourceY;
  const split = geo.splitY;
  return (
    <>
      <TraceNode form={view.nodes.source} className="vcl-gutter-node" style={{ top }} />
      <TraceSegment
        form={view.segments.sourceToCapability}
        className="vcl-gutter-seg"
        style={{ top: top + 7, height: Math.max(0, (split ?? geo.height) - top - 7) }}
      />
      {split !== null ? (
        <>
          <TraceNode form={view.nodes.capability} className="vcl-gutter-node vcl-gutter-node--junction" style={{ top: split }} />
          <TraceSegment
            form={view.segments.capabilityToExecute}
            className="vcl-gutter-seg"
            style={{ top: split + 7, height: Math.max(0, geo.height - split - 7) }}
          />
        </>
      ) : null}
    </>
  );
}

// ── Action strip ──────────────────────────────────────────────────────────────────────────────

function ActionStrip({
  t,
  state,
  view,
  command,
  sourceName,
  generateRef,
  gateHeadingRef,
  failureHeadingRef,
  statusRef,
  dispatch,
  chooseSource,
  tryAnother,
  locale,
}: {
  t: Copy;
  state: LabState;
  view: TraceView;
  command: CommandView | null;
  sourceName: string | null;
  generateRef: RefObject<HTMLButtonElement | null>;
  gateHeadingRef: RefObject<HTMLHeadingElement | null>;
  failureHeadingRef: RefObject<HTMLHeadingElement | null>;
  statusRef: RefObject<HTMLDivElement | null>;
  dispatch: Dispatch<LabEvent>;
  chooseSource: () => void;
  tryAnother: () => void;
  locale: Locale;
}) {
  const slash = command?.slash.toUpperCase() ?? "";
  const r = t.strip.readiness;
  const readiness =
    state.phase === "AUTH_REQUIRED"
      ? r.auth
      : state.phase === "GENERATING"
        ? r.generating
        : state.phase === "RESULT"
          ? r.result
          : state.phase === "RECOVERABLE_ERROR"
            ? r.error
            : state.phase === "RATE_LIMITED"
              ? r.rate
              : state.phase === "COST_BOUNDED"
                ? r.cost
                : intentComplete(state)
                  ? state.session === "signed_in"
                    ? r.ready
                    : r.signIn
                  : command
                    ? r.needsSource
                    : state.source
                      ? r.needsCapability
                      : r.browse;
  const failure =
    state.phase === "RECOVERABLE_ERROR" ? t.failure.error : state.phase === "RATE_LIMITED" ? t.failure.rate : state.phase === "COST_BOUNDED" ? t.failure.cost : null;

  return (
    <div className="vcl-strip" data-phase={state.phase} data-trace={view.key} role="region" aria-label={t.strip.label}>
      <div className="vcl-shell vcl-cols vcl-strip-cols">
        <div className="vcl-strip-left">
          <TraceEyebrow glyph={view.glyph} name={t.traceName} state={t.traceStates[view.key]} inverse />
        </div>
        <div className="vcl-strip-gutter" aria-hidden="true">
          <TraceSegment form={view.segments.capabilityToExecute} className="vcl-strip-in" />
          <TraceNode form={view.nodes.execute} className="vcl-strip-node" />
          <TraceSegment form={view.segments.executeToResult} className="vcl-strip-out" />
        </div>
        <div className="vcl-strip-main">
          <MobileTrace view={view} t={t} />

          {state.phase === "AUTH_REQUIRED" && command ? (
            <div className="vcl-gate" role="group" aria-labelledby="vcl-gate-title" aria-describedby="vcl-gate-body">
              <p className="vcl-meta vcl-strip-meta">{t.auth.meta}</p>
              <h2 id="vcl-gate-title" className="vcl-strip-title" tabIndex={-1} ref={gateHeadingRef}>
                {t.auth.title}
              </h2>
              <p id="vcl-gate-body" className="vcl-strip-body">
                {t.auth.body}
              </p>
              <KeptIntent t={t} label={t.auth.kept} command={command} sourceName={sourceName} locale={locale} />
              <div className="vcl-strip-actions">
                <button type="button" className="vcl-action" onClick={() => dispatch({ type: "AUTH_CONTINUE" })}>
                  {t.auth.continue}
                  <IconArrow />
                </button>
                <button type="button" className="vcl-text-button vcl-text-button--light" onClick={() => dispatch({ type: "AUTH_CANCEL" })}>
                  {t.auth.cancel}
                </button>
              </div>
              <p className="vcl-meta vcl-strip-fine">{t.auth.simulated}</p>
            </div>
          ) : failure && command ? (
            <div className="vcl-failure" data-kind={state.phase} role="group" aria-labelledby="vcl-failure-title">
              <p className="vcl-meta vcl-strip-meta vcl-failure-meta">
                <span className="vcl-failure-mark" aria-hidden="true" />
                {failure.meta} · {slash}
              </p>
              <h2 id="vcl-failure-title" className="vcl-strip-title" tabIndex={-1} ref={failureHeadingRef}>
                {failure.title}
              </h2>
              <p className="vcl-strip-body">{failure.body}</p>
              <KeptIntent t={t} label={t.failureKept} command={command} sourceName={sourceName} locale={locale} />
              <div className="vcl-strip-actions">
                {state.phase === "RECOVERABLE_ERROR" ? (
                  <button type="button" className="vcl-action" ref={generateRef} onClick={() => dispatch({ type: "GENERATE" })}>
                    {failure.action}
                    <IconArrow />
                  </button>
                ) : (
                  <button type="button" className="vcl-text-button vcl-text-button--light" onClick={() => dispatch({ type: "GENERATE" })}>
                    {failure.action}
                  </button>
                )}
                <button type="button" className="vcl-text-button vcl-text-button--light" onClick={tryAnother}>
                  {t.chooseAnother}
                </button>
              </div>
            </div>
          ) : (
            <div className="vcl-strip-row">
              <div className="vcl-strip-status" ref={statusRef} tabIndex={-1} role={state.phase === "GENERATING" ? "status" : undefined}>
                <p className="vcl-meta vcl-strip-meta">
                  <span className="vcl-status-mark" data-trace={view.key} aria-hidden="true" />
                  {state.phase === "GENERATING" ? t.generating.meta(slash) : slash ? `${readiness} · ${slash}` : readiness}
                </p>
                <p className="vcl-strip-line">
                  {state.phase === "GENERATING"
                    ? t.generating.body
                    : command
                      ? t.strip.selectedLine(command.name[locale])
                      : state.source
                        ? t.strip.needsCapability
                        : t.strip.nothing}
                  {sourceName && state.phase !== "GENERATING" ? <span className="vcl-strip-source"> · {t.strip.sourceLine(sourceName)}</span> : null}
                </p>
              </div>
              <div className="vcl-strip-actions">
                {command && !state.source ? (
                  <button type="button" className="vcl-text-button vcl-text-button--light" onClick={chooseSource}>
                    {t.strip.addSource}
                  </button>
                ) : null}
                {state.phase === "RESULT" ? (
                  <a className="vcl-text-button vcl-text-button--light" href="#vcl-result-title">
                    {t.result.label.replace(/^\d+ — /, "")} ↓
                  </a>
                ) : (
                  <button
                    type="button"
                    className="vcl-action"
                    ref={generateRef}
                    disabled={!canGenerate(state)}
                    aria-busy={state.phase === "GENERATING"}
                    onClick={() => dispatch({ type: "GENERATE" })}
                  >
                    {state.phase === "GENERATING" ? t.strip.generating : t.strip.generate}
                    <IconArrow />
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function KeptIntent({ t, label, command, sourceName, locale }: { t: Copy; label: string; command: CommandView; sourceName: string | null; locale: Locale }) {
  return (
    <p className="vcl-kept">
      <span className="vcl-meta">{label}</span>
      <span className="vcl-kept-item">
        {t.nodes.source}: {sourceName ?? "—"}
      </span>
      <span className="vcl-kept-item">
        {t.nodes.capability}: {command.name[locale]} <code className="vcl-slash">{command.slash}</code>
      </span>
    </p>
  );
}

/** Mobile: the same Source → Capability → Generate → Result relationship as a compact sequence. */
function MobileTrace({ view, t }: { view: TraceView; t: Copy }) {
  const steps: { key: keyof TraceView["nodes"]; label: string; form: NodeForm }[] = [
    { key: "source", label: t.nodes.source, form: view.nodes.source },
    { key: "capability", label: t.nodes.capability, form: view.nodes.capability },
    { key: "execute", label: t.nodes.execute, form: view.nodes.execute },
    { key: "result", label: t.nodes.result, form: view.nodes.result },
  ];
  const links = [view.segments.sourceToCapability, view.segments.capabilityToExecute, view.segments.executeToResult];
  return (
    <ol className="vcl-mtrace" aria-label={`${t.traceName} / ${t.traceStates[view.key]}`}>
      {steps.map((step, i) => (
        <li key={step.key} data-form={step.form}>
          {i > 0 ? <TraceSegment form={links[i - 1]} axis="h" className="vcl-mtrace-seg" /> : null}
          <TraceNode form={step.form} />
          <span className="vcl-mtrace-label">
            {step.label}
            <span className="vcl-sr-only"> — {t.nodeForms[step.form]}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

// ── Notices, recipe, result ───────────────────────────────────────────────────────────────────

function CapabilityNotice({ command, t }: { command: CommandView; t: Copy }) {
  const n = t.notices;
  let body: ReactNode = null;
  if (command.lane === "explain") body = <p>{n.explain}</p>;
  else if (command.lane === "polish")
    body = (
      <>
        <p>{n.polishLead}</p>
        <dl className="vcl-notice-lists">
          <div>
            <dt className="vcl-meta">{n.polishPreserve}</dt>
            <dd>{n.polishPreserveItems.join(", ")}</dd>
          </div>
          <div>
            <dt className="vcl-meta">{n.polishMayChange}</dt>
            <dd>{n.polishMayChangeItems.join(", ")}</dd>
          </div>
        </dl>
        <p>{n.polishTail}</p>
      </>
    );
  else if (command.id === "bricktoy") body = <p>{n.bricktoy}</p>;
  if (!body) return null;
  return (
    <div className="vcl-notice" data-lane={command.lane}>
      <span className="vcl-meta">{n.noticeLabel}</span>
      {body}
    </div>
  );
}

function RecipePanel({ open, command, t, locale }: { open: boolean; command: CommandView; t: Copy; locale: Locale }) {
  const s = recipeSummary(command.lane, locale);
  return (
    <div id="vcl-recipe" className="vcl-recipe" hidden={!open}>
      <p className="vcl-meta vcl-recipe-head">
        {t.recipe.title} · {t.recipe.simulated}
      </p>
      <dl>
        <div>
          <dt className="vcl-meta">{t.recipe.capability}</dt>
          <dd>
            {command.name[locale]} <code className="vcl-slash">{command.slash}</code>
          </dd>
        </div>
        <div>
          <dt className="vcl-meta">{t.recipe.job}</dt>
          <dd>{command.job[locale]}</dd>
        </div>
        <div>
          <dt className="vcl-meta">{t.recipe.preserves}</dt>
          <dd>{s.preserves.join(", ")}</dd>
        </div>
        <div>
          <dt className="vcl-meta">{t.recipe.mayChange}</dt>
          <dd>{s.mayChange.join(", ")}</dd>
        </div>
        <div>
          <dt className="vcl-meta">{t.recipe.limits}</dt>
          <dd>{s.limits.join(" ")}</dd>
        </div>
        <div>
          <dt className="vcl-meta">{t.recipe.implementation}</dt>
          <dd>{t.recipe.implementationValue}</dd>
        </div>
      </dl>
    </div>
  );
}

function ResultCanvas({ source, commandId, marker }: { source: SourceRef; commandId: string; marker: string }) {
  if (source.kind === "demo") {
    return (
      <figure className="vcl-canvas" data-simulated="SIMULATED OUTPUT">
        <img src={thumb(commandId)} alt="" />
        <figcaption className="vcl-canvas-marker vcl-meta">{marker}</figcaption>
      </figure>
    );
  }
  const treatment = LOCAL_TREATMENT[commandId] ?? { filter: "none", frame: "none" as const };
  return (
    <figure className="vcl-canvas" data-simulated="SIMULATED OUTPUT" data-frame={treatment.frame}>
      <img src={source.url} alt="" style={{ filter: treatment.filter }} />
      <span className="vcl-canvas-frame" aria-hidden="true" />
      <figcaption className="vcl-canvas-marker vcl-meta">{marker}</figcaption>
    </figure>
  );
}

/** Download for an uploaded source: the same local treatment, rendered to PNG, marked as simulated. */
async function renderLocalResult(url: string, commandId: string, marker: string): Promise<Blob> {
  const image = new Image();
  image.src = url;
  await image.decode();
  const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
  const w = Math.round(image.naturalWidth * scale);
  const h = Math.round(image.naturalHeight * scale);
  const band = Math.max(28, Math.round(h * 0.05));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h + band;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.filter = LOCAL_TREATMENT[commandId]?.filter ?? "none";
  ctx.drawImage(image, 0, 0, w, h);
  ctx.filter = "none";
  ctx.fillStyle = "#171a19";
  ctx.fillRect(0, h, w, band);
  ctx.fillStyle = "#f2f2ec";
  ctx.font = `500 ${Math.round(band * 0.42)}px ui-monospace, Menlo, monospace`;
  ctx.textBaseline = "middle";
  ctx.fillText(marker.toUpperCase(), Math.round(band * 0.5), h + band / 2);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/png"));
}

// ── Prototype controller (not product UI) ─────────────────────────────────────────────────────

function ScenarioPanel({
  t,
  state,
  dispatch,
  onReset,
  locale,
}: {
  t: Copy;
  state: LabState;
  dispatch: Dispatch<LabEvent>;
  onReset: () => void;
  locale: Locale;
}) {
  const p = t.prototype;
  return (
    <aside className="vcl-proto" aria-label={p.title} data-prototype-only="true">
      <div className="vcl-shell vcl-proto-inner">
        <p className="vcl-meta vcl-proto-title">
          <b>{p.title}</b> — {p.note}
        </p>
        <fieldset>
          <legend className="vcl-meta">{p.outcome}</legend>
          {OUTCOMES.map((o) => (
            <label key={o}>
              <input type="radio" name="vcl-outcome" checked={state.scenario === o} onChange={() => dispatch({ type: "SCENARIO_SET", scenario: o })} />
              {p.outcomes[o]}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend className="vcl-meta">{p.session}</legend>
          {(["anonymous", "signed_in"] as const).map((s) => (
            <label key={s}>
              <input type="radio" name="vcl-session" checked={state.session === s} onChange={() => dispatch({ type: "SESSION_SET", session: s })} />
              {s === "anonymous" ? p.anonymous : p.signedIn}
            </label>
          ))}
        </fieldset>
        <p className="vcl-meta vcl-proto-phase">
          {p.phase}: <b data-testid="phase">{state.phase}</b>
        </p>
        <div className="vcl-proto-actions">
          <button type="button" className="vcl-text-button" onClick={onReset}>
            {p.reset}
          </button>
          <a className="vcl-text-button" href={`/${locale}/click-dummy/states`}>
            {p.catalogue}
          </a>
        </div>
      </div>
    </aside>
  );
}
