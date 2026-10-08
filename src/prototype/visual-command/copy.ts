// PROTOTYPE ONLY — interface copy for the Visual Command Lab click dummy.
//
// EN headings and action labels follow Confluence 04.2 v1.2 (eyebrow, headline, "Generate",
// "Download", "Try another", "View recipe", "All · Play · Explain · Polish"). The synthetic
// notice is 04.1 §4 verbatim. No German copy exists in 04.1/04.2: the DE strings below were
// written for this prototype, keep the EN structure, and are NOT canonical.

import type { Outcome, Phase } from "./machine.ts";
import type { TraceKey } from "./trace.ts";

export type Locale = "en" | "de";

export interface Copy {
  langName: string;
  wordmarkLabel: string;
  labName: string;
  prototypeBadge: string;
  eyebrow: string;
  title: string;
  intro: string;
  introMeta: string;
  sourceLabel: string;
  sourceEmpty: string;
  sourceDrop: string;
  sourceChoose: string;
  sourceDemo: string;
  sourceReplace: string;
  sourceRemove: string;
  sourceLocal: string;
  sourceDemoName: string;
  sourceInvalid: string;
  modeLabel: string;
  mode: { name: string; value: string }[];
  modeAdvanced: string;
  modeAdvancedNote: string;
  intentLabel: string;
  intentNone: string;
  capabilitiesLabel: string;
  capabilitiesTitle: string;
  laneGroup: string;
  lanes: Record<"all" | "play" | "explain" | "polish", string>;
  count: (n: number) => string;
  selected: string;
  select: string;
  hiddenByFilter: (slash: string) => string;
  showAll: string;
  traceName: string;
  traceStates: Record<TraceKey, string>;
  nodes: { source: string; capability: string; execute: string; result: string };
  nodeForms: Record<string, string>;
  strip: {
    label: string;
    nothing: string;
    needsCapability: string;
    needsSource: string;
    selectedLine: (name: string) => string;
    sourceLine: (name: string) => string;
    readiness: Record<
      "browse" | "needsSource" | "needsCapability" | "signIn" | "ready" | "auth" | "generating" | "result" | "error" | "rate" | "cost",
      string
    >;
    generate: string;
    generating: string;
    addSource: string;
  };
  auth: {
    meta: string;
    title: string;
    body: string;
    kept: string;
    continue: string;
    cancel: string;
    simulated: string;
  };
  generating: { meta: (slash: string) => string; body: string };
  failure: Record<"error" | "rate" | "cost", { meta: string; title: string; body: string; action: string }>;
  failureKept: string;
  chooseAnother: string;
  result: {
    label: string;
    title: (name: string) => string;
    from: (source: string) => string;
    download: string;
    downloaded: string;
    downloadFailed: string;
    tryAnother: string;
    viewRecipe: string;
    hideRecipe: string;
    simulatedMarker: string;
    simulatedNote: string;
  };
  recipe: {
    title: string;
    simulated: string;
    capability: string;
    job: string;
    preserves: string;
    mayChange: string;
    limits: string;
    implementation: string;
    implementationValue: string;
  };
  notices: {
    synthetic: string;
    explain: string;
    polishLead: string;
    polishPreserve: string;
    polishMayChange: string;
    polishPreserveItems: string[];
    polishMayChangeItems: string[];
    polishTail: string;
    bricktoy: string;
    noticeLabel: string;
  };
  announce: Record<Phase, string>;
  languageAnnounce: string;
  prototype: {
    title: string;
    note: string;
    outcome: string;
    outcomes: Record<Outcome, string>;
    session: string;
    anonymous: string;
    signedIn: string;
    reset: string;
    catalogue: string;
    phase: string;
  };
  catalogue: {
    title: string;
    intro: string;
    open: string;
    states: { phase: string; query: string; note: string }[];
    back: string;
  };
}

const en: Copy = {
  langName: "English",
  wordmarkLabel: "DYAI Studio — Visual Command Lab",
  labName: "Visual Command Lab",
  prototypeBadge: "Click dummy · simulated",
  eyebrow: "Choose the outcome, not the prompt",
  title: "See it. Pick it. Make it.",
  intro: "Pick a capability by what it produces, add one image and generate. No prompt, no model settings.",
  introMeta: "Prototype · generation is simulated · no image leaves this browser",
  sourceLabel: "01 — Source",
  sourceEmpty: "No source yet",
  sourceDrop: "Drop an image here, or",
  sourceChoose: "Choose source image",
  sourceDemo: "Use demo source",
  sourceReplace: "Replace",
  sourceRemove: "Remove",
  sourceLocal: "Local preview · not uploaded",
  sourceDemoName: "Demo source — illustration",
  sourceInvalid: "That file is not a JPEG, PNG or WebP image. Your current source is unchanged.",
  modeLabel: "02 — Mode",
  mode: [
    { name: "Recommended", value: "Default" },
    { name: "Keep source identity", value: "On" },
    { name: "Advanced controls", value: "Hidden" },
  ],
  modeAdvanced: "What is hidden?",
  modeAdvancedNote:
    "Model, provider, prompt and parameters are chosen by the capability's recipe. They stay out of the way in VC-01.",
  intentLabel: "Selected capability",
  intentNone: "None yet — pick one from the gallery.",
  capabilitiesLabel: "03 — Capability",
  capabilitiesTitle: "Pick the result you want.",
  laneGroup: "Lane",
  lanes: { all: "All", play: "Play", explain: "Explain", polish: "Polish" },
  count: (n) => `${n} ${n === 1 ? "capability" : "capabilities"}`,
  selected: "Selected",
  select: "Select",
  hiddenByFilter: (slash) => `${slash} is selected but hidden by this lane.`,
  showAll: "Show all",
  traceName: "Augmentation trace",
  traceStates: {
    dormant: "Relationship · not yet established",
    source: "Source · established",
    capability: "Capability · selected",
    decision: "Human decision · ready",
    auth: "Access · required — intent kept",
    generating: "Capability · executing",
    resolved: "Resolved",
    error: "Execution · stopped",
    rate: "Limit · bounded",
    cost: "Capacity · bounded",
  },
  nodes: { source: "Source", capability: "Capability", execute: "Generate", result: "Result" },
  nodeForms: {
    dormant: "not established",
    active: "established",
    boundary: "ready",
    paused: "paused — sign-in",
    running: "running",
    stopped: "stopped",
    bounded: "bounded",
    resolved: "resolved",
  },
  strip: {
    label: "Generate",
    nothing: "Nothing selected",
    needsCapability: "Pick a capability",
    needsSource: "Add a source image",
    selectedLine: (name) => `Selected: ${name}`,
    sourceLine: (name) => `Source: ${name}`,
    readiness: {
      browse: "Not ready",
      needsSource: "Needs source",
      needsCapability: "Needs capability",
      signIn: "Ready · sign-in at Generate",
      ready: "Ready",
      auth: "Paused · sign-in required",
      generating: "Executing",
      result: "Resolved",
      error: "Stopped",
      rate: "Limit reached",
      cost: "Capacity bounded",
    },
    generate: "Generate",
    generating: "Generating",
    addSource: "Choose source image",
  },
  auth: {
    meta: "Generate · sign-in required",
    title: "Sign in to generate this result.",
    body: "Keep your current source and capability. Browsing stays open; only generation needs an account.",
    kept: "Kept",
    continue: "Continue",
    cancel: "Cancel",
    simulated: "Simulated sign-in · no credentials are asked for or stored.",
  },
  generating: {
    meta: (slash) => `Executing · ${slash}`,
    body: "Applying the selected capability.",
  },
  failure: {
    error: {
      meta: "Execution stopped · recoverable",
      title: "The generation failed at this step.",
      body: "Nothing you prepared is lost. Try again, or pick another capability.",
      action: "Retry",
    },
    rate: {
      meta: "Limit reached · about 10 min",
      title: "You have reached the generation limit for now.",
      body: "This is a limit, not an error. Your source and capability are kept; try again in about ten minutes.",
      action: "Check again",
    },
    cost: {
      meta: "Capacity bounded · temporary",
      title: "Generation is paused while capacity is bounded.",
      body: "The Lab has reached its spending boundary for today. Your source and capability are kept; nothing was charged.",
      action: "Check again",
    },
  },
  failureKept: "Kept",
  chooseAnother: "Choose another capability",
  result: {
    label: "04 — Result",
    title: (name) => `${name} — result.`,
    from: (source) => `From ${source}`,
    download: "Download",
    downloaded: "Download started.",
    downloadFailed: "The download could not be prepared in this browser.",
    tryAnother: "Try another",
    viewRecipe: "View recipe",
    hideRecipe: "Hide recipe",
    simulatedMarker: "Simulated output",
    simulatedNote: "Prototype result made locally from your source. It is not a model generation.",
  },
  recipe: {
    title: "Recipe",
    simulated: "Simulated summary · not the server recipe",
    capability: "Capability",
    job: "What it is for",
    preserves: "Meant to stay",
    mayChange: "May change",
    limits: "Limitations",
    implementation: "Model and provider",
    implementationValue: "Implementation detail — not shown",
  },
  notices: {
    synthetic:
      "AI-generated images are synthetic visualisations created for creative and entertainment purposes. They do not establish scientific, analytical, diagnostic, technical, evidentiary or factual truth. Do not use them as proof of real-world condition, structure or properties.",
    explain:
      "Generated labels, structure, text or sequence may be invented or incorrect and are not verified knowledge.",
    polishLead: "A truth-preserving edit — intended, not guaranteed.",
    polishPreserve: "Expected to preserve",
    polishMayChange: "May alter",
    polishPreserveItems: ["subject identity", "people", "objects", "geometry", "logos and text", "visible defects and material characteristics"],
    polishMayChangeItems: ["exposure", "tone", "colour", "perceived light", "contrast", "sharpness treatment", "film or photo character", "atmosphere and depth"],
    polishTail: "The result is still AI-processed.",
    bricktoy: "A brick-toy look. No official or native relationship with LEGO is implied.",
    noticeLabel: "Note",
  },
  announce: {
    BROWSE: "Nothing selected.",
    SOURCE_READY: "Source established.",
    CAPABILITY_SELECTED: "Capability selected.",
    AUTH_REQUIRED: "Sign-in required. Your source and capability are kept.",
    READY: "Ready to generate.",
    GENERATING: "Generating.",
    RESULT: "Result ready.",
    RECOVERABLE_ERROR: "Generation failed. Your source and capability are kept.",
    RATE_LIMITED: "Generation limit reached. Your source and capability are kept.",
    COST_BOUNDED: "Generation paused while capacity is bounded. Your source and capability are kept.",
  },
  languageAnnounce: "Language: English",
  prototype: {
    title: "Prototype controls",
    note: "Not product UI · simulates server answers",
    outcome: "Next generation answers",
    outcomes: { success: "Success", error: "Generation error", rate_limited: "Rate limit", cost_bounded: "Cost / capacity" },
    session: "Session",
    anonymous: "Anonymous",
    signedIn: "Signed in",
    reset: "Reset",
    catalogue: "State catalogue",
    phase: "Phase",
  },
  catalogue: {
    title: "State catalogue.",
    intro: "Every reviewable state of the click dummy, reached by replaying real interaction events. Each link opens the live prototype.",
    open: "Open",
    back: "Back to the click dummy",
    states: [
      { phase: "BROWSE", query: "", note: "Public browsing, nothing established." },
      { phase: "SOURCE_READY", query: "state=SOURCE_READY", note: "Demo source loaded, no capability." },
      { phase: "CAPABILITY_SELECTED", query: "command=actionfigure", note: "Social deep link: capability selected, source missing." },
      { phase: "CAPABILITY_SELECTED + source", query: "command=actionfigure&source=demo", note: "Intent complete, anonymous — sign-in happens at Generate." },
      { phase: "AUTH_REQUIRED", query: "state=AUTH_REQUIRED", note: "Generate pressed while anonymous; intent kept." },
      { phase: "READY", query: "state=READY", note: "Signed in, source and capability valid." },
      { phase: "GENERATING", query: "state=GENERATING&hold=1", note: "Held for review; normally settles after about two seconds." },
      { phase: "RESULT", query: "state=RESULT", note: "Simulated output with recipe and notices." },
      { phase: "RESULT · Explain", query: "state=RESULT&command=mindmap", note: "Explain notice." },
      { phase: "RESULT · Polish", query: "state=RESULT&command=35mm", note: "Polish preserve / may-alter notice." },
      { phase: "RECOVERABLE_ERROR", query: "state=RECOVERABLE_ERROR", note: "Stops at the execution boundary; retry." },
      { phase: "RATE_LIMITED", query: "state=RATE_LIMITED", note: "Bounded, not failed." },
      { phase: "COST_BOUNDED", query: "state=COST_BOUNDED", note: "Temporary capacity boundary." },
      { phase: "Bricktoy notice", query: "command=bricktoy&source=demo", note: "No LEGO affiliation implied." },
    ],
  },
};

const de: Copy = {
  langName: "Deutsch",
  wordmarkLabel: "DYAI Studio — Visual Command Lab",
  labName: "Visual Command Lab",
  prototypeBadge: "Klickdummy · simuliert",
  eyebrow: "Wähle das Ergebnis, nicht den Prompt",
  title: "Sehen. Wählen. Machen.",
  intro: "Wähle eine Fähigkeit nach dem, was sie erzeugt, füge ein Bild hinzu und generiere. Kein Prompt, keine Modelleinstellungen.",
  introMeta: "Prototyp · Generierung simuliert · kein Bild verlässt diesen Browser",
  sourceLabel: "01 — Quelle",
  sourceEmpty: "Noch keine Quelle",
  sourceDrop: "Bild hier ablegen, oder",
  sourceChoose: "Ausgangsbild wählen",
  sourceDemo: "Demo-Quelle verwenden",
  sourceReplace: "Ersetzen",
  sourceRemove: "Entfernen",
  sourceLocal: "Lokale Vorschau · nicht hochgeladen",
  sourceDemoName: "Demo-Quelle — Illustration",
  sourceInvalid: "Diese Datei ist kein JPEG-, PNG- oder WebP-Bild. Deine aktuelle Quelle bleibt unverändert.",
  modeLabel: "02 — Modus",
  mode: [
    { name: "Empfohlen", value: "Standard" },
    { name: "Identität der Quelle wahren", value: "An" },
    { name: "Erweiterte Einstellungen", value: "Verborgen" },
  ],
  modeAdvanced: "Was ist verborgen?",
  modeAdvancedNote:
    "Modell, Anbieter, Prompt und Parameter wählt das Rezept der Fähigkeit. In VC-01 bleiben sie im Hintergrund.",
  intentLabel: "Gewählte Fähigkeit",
  intentNone: "Noch keine — wähle eine aus der Galerie.",
  capabilitiesLabel: "03 — Fähigkeit",
  capabilitiesTitle: "Wähle das Ergebnis, das du willst.",
  laneGroup: "Bereich",
  lanes: { all: "Alle", play: "Play", explain: "Explain", polish: "Polish" },
  count: (n) => `${n} ${n === 1 ? "Fähigkeit" : "Fähigkeiten"}`,
  selected: "Gewählt",
  select: "Wählen",
  hiddenByFilter: (slash) => `${slash} ist gewählt, aber in diesem Bereich ausgeblendet.`,
  showAll: "Alle zeigen",
  traceName: "Augmentation Trace",
  traceStates: {
    dormant: "Beziehung · noch nicht hergestellt",
    source: "Quelle · hergestellt",
    capability: "Fähigkeit · gewählt",
    decision: "Menschliche Entscheidung · bereit",
    auth: "Zugang · erforderlich — Absicht bleibt",
    generating: "Fähigkeit · wird ausgeführt",
    resolved: "Aufgelöst",
    error: "Ausführung · gestoppt",
    rate: "Limit · begrenzt",
    cost: "Kapazität · begrenzt",
  },
  nodes: { source: "Quelle", capability: "Fähigkeit", execute: "Generieren", result: "Ergebnis" },
  nodeForms: {
    dormant: "nicht hergestellt",
    active: "hergestellt",
    boundary: "bereit",
    paused: "pausiert — Anmeldung",
    running: "läuft",
    stopped: "gestoppt",
    bounded: "begrenzt",
    resolved: "aufgelöst",
  },
  strip: {
    label: "Generieren",
    nothing: "Nichts gewählt",
    needsCapability: "Wähle eine Fähigkeit",
    needsSource: "Füge ein Ausgangsbild hinzu",
    selectedLine: (name) => `Gewählt: ${name}`,
    sourceLine: (name) => `Quelle: ${name}`,
    readiness: {
      browse: "Nicht bereit",
      needsSource: "Quelle fehlt",
      needsCapability: "Fähigkeit fehlt",
      signIn: "Bereit · Anmeldung beim Generieren",
      ready: "Bereit",
      auth: "Pausiert · Anmeldung erforderlich",
      generating: "Wird ausgeführt",
      result: "Aufgelöst",
      error: "Gestoppt",
      rate: "Limit erreicht",
      cost: "Kapazität begrenzt",
    },
    generate: "Generieren",
    generating: "Wird generiert",
    addSource: "Ausgangsbild wählen",
  },
  auth: {
    meta: "Generieren · Anmeldung erforderlich",
    title: "Melde dich an, um dieses Ergebnis zu generieren.",
    body: "Deine Quelle und Fähigkeit bleiben erhalten. Stöbern bleibt offen; nur das Generieren braucht ein Konto.",
    kept: "Erhalten",
    continue: "Weiter",
    cancel: "Abbrechen",
    simulated: "Simulierte Anmeldung · es werden keine Zugangsdaten abgefragt oder gespeichert.",
  },
  generating: {
    meta: (slash) => `Wird ausgeführt · ${slash}`,
    body: "Die gewählte Fähigkeit wird angewendet.",
  },
  failure: {
    error: {
      meta: "Ausführung gestoppt · behebbar",
      title: "Die Generierung ist an diesem Schritt fehlgeschlagen.",
      body: "Nichts, was du vorbereitet hast, geht verloren. Versuche es erneut oder wähle eine andere Fähigkeit.",
      action: "Erneut versuchen",
    },
    rate: {
      meta: "Limit erreicht · ca. 10 Min.",
      title: "Du hast das Generierungslimit vorerst erreicht.",
      body: "Das ist ein Limit, kein Fehler. Quelle und Fähigkeit bleiben erhalten; versuche es in etwa zehn Minuten erneut.",
      action: "Erneut prüfen",
    },
    cost: {
      meta: "Kapazität begrenzt · vorübergehend",
      title: "Die Generierung pausiert, solange die Kapazität begrenzt ist.",
      body: "Das Lab hat seine Ausgabengrenze für heute erreicht. Quelle und Fähigkeit bleiben erhalten; es wurde nichts berechnet.",
      action: "Erneut prüfen",
    },
  },
  failureKept: "Erhalten",
  chooseAnother: "Andere Fähigkeit wählen",
  result: {
    label: "04 — Ergebnis",
    title: (name) => `${name} — Ergebnis.`,
    from: (source) => `Aus ${source}`,
    download: "Herunterladen",
    downloaded: "Download gestartet.",
    downloadFailed: "Der Download konnte in diesem Browser nicht vorbereitet werden.",
    tryAnother: "Weitere ausprobieren",
    viewRecipe: "Rezept ansehen",
    hideRecipe: "Rezept ausblenden",
    simulatedMarker: "Simuliertes Ergebnis",
    simulatedNote: "Prototyp-Ergebnis, lokal aus deiner Quelle erzeugt. Es ist keine Modell-Generierung.",
  },
  recipe: {
    title: "Rezept",
    simulated: "Simulierte Zusammenfassung · nicht das Server-Rezept",
    capability: "Fähigkeit",
    job: "Wofür",
    preserves: "Soll erhalten bleiben",
    mayChange: "Darf sich ändern",
    limits: "Grenzen",
    implementation: "Modell und Anbieter",
    implementationValue: "Implementierungsdetail — nicht angezeigt",
  },
  notices: {
    synthetic:
      "KI-generierte Bilder sind synthetische Visualisierungen für kreative und unterhaltende Zwecke. Sie begründen keine wissenschaftliche, analytische, diagnostische, technische, beweiskräftige oder faktische Wahrheit. Nutze sie nicht als Beleg für reale Zustände, Strukturen oder Eigenschaften.",
    explain:
      "Generierte Beschriftungen, Strukturen, Texte oder Abfolgen können erfunden oder falsch sein und sind kein geprüftes Wissen.",
    polishLead: "Eine wahrheitserhaltende Bearbeitung — beabsichtigt, nicht garantiert.",
    polishPreserve: "Soll erhalten bleiben",
    polishMayChange: "Darf sich ändern",
    polishPreserveItems: ["Identität des Motivs", "Personen", "Objekte", "Geometrie", "Logos und Text", "sichtbare Mängel und Materialeigenschaften"],
    polishMayChangeItems: ["Belichtung", "Tonwerte", "Farbe", "wahrgenommenes Licht", "Kontrast", "Schärfebehandlung", "Film- oder Fotocharakter", "Atmosphäre und Tiefe"],
    polishTail: "Das Ergebnis ist trotzdem KI-bearbeitet.",
    bricktoy: "Ein Klemmbaustein-Look. Eine offizielle oder native Verbindung zu LEGO wird nicht behauptet.",
    noticeLabel: "Hinweis",
  },
  announce: {
    BROWSE: "Nichts gewählt.",
    SOURCE_READY: "Quelle hergestellt.",
    CAPABILITY_SELECTED: "Fähigkeit gewählt.",
    AUTH_REQUIRED: "Anmeldung erforderlich. Quelle und Fähigkeit bleiben erhalten.",
    READY: "Bereit zum Generieren.",
    GENERATING: "Wird generiert.",
    RESULT: "Ergebnis bereit.",
    RECOVERABLE_ERROR: "Generierung fehlgeschlagen. Quelle und Fähigkeit bleiben erhalten.",
    RATE_LIMITED: "Generierungslimit erreicht. Quelle und Fähigkeit bleiben erhalten.",
    COST_BOUNDED: "Generierung pausiert, Kapazität begrenzt. Quelle und Fähigkeit bleiben erhalten.",
  },
  languageAnnounce: "Sprache: Deutsch",
  prototype: {
    title: "Prototyp-Steuerung",
    note: "Keine Produkt-UI · simuliert Server-Antworten",
    outcome: "Nächste Generierung antwortet",
    outcomes: { success: "Erfolg", error: "Generierungsfehler", rate_limited: "Ratenlimit", cost_bounded: "Kosten / Kapazität" },
    session: "Sitzung",
    anonymous: "Anonym",
    signedIn: "Angemeldet",
    reset: "Zurücksetzen",
    catalogue: "Zustandskatalog",
    phase: "Phase",
  },
  catalogue: {
    title: "Zustandskatalog.",
    intro: "Jeder prüfbare Zustand des Klickdummys, erreicht durch Abspielen echter Interaktionsereignisse. Jeder Link öffnet den laufenden Prototyp.",
    open: "Öffnen",
    back: "Zurück zum Klickdummy",
    states: [
      { phase: "BROWSE", query: "", note: "Öffentliches Stöbern, nichts hergestellt." },
      { phase: "SOURCE_READY", query: "state=SOURCE_READY", note: "Demo-Quelle geladen, keine Fähigkeit." },
      { phase: "CAPABILITY_SELECTED", query: "command=actionfigure", note: "Social-Deep-Link: Fähigkeit gewählt, Quelle fehlt." },
      { phase: "CAPABILITY_SELECTED + Quelle", query: "command=actionfigure&source=demo", note: "Absicht vollständig, anonym — Anmeldung erst beim Generieren." },
      { phase: "AUTH_REQUIRED", query: "state=AUTH_REQUIRED", note: "Generieren anonym gedrückt; Absicht bleibt." },
      { phase: "READY", query: "state=READY", note: "Angemeldet, Quelle und Fähigkeit gültig." },
      { phase: "GENERATING", query: "state=GENERATING&hold=1", note: "Zur Prüfung angehalten; sonst nach etwa zwei Sekunden fertig." },
      { phase: "RESULT", query: "state=RESULT", note: "Simuliertes Ergebnis mit Rezept und Hinweisen." },
      { phase: "RESULT · Explain", query: "state=RESULT&command=mindmap", note: "Explain-Hinweis." },
      { phase: "RESULT · Polish", query: "state=RESULT&command=35mm", note: "Polish-Hinweis: erhalten / darf sich ändern." },
      { phase: "RECOVERABLE_ERROR", query: "state=RECOVERABLE_ERROR", note: "Stoppt an der Ausführungsgrenze; erneut versuchen." },
      { phase: "RATE_LIMITED", query: "state=RATE_LIMITED", note: "Begrenzt, nicht fehlgeschlagen." },
      { phase: "COST_BOUNDED", query: "state=COST_BOUNDED", note: "Vorübergehende Kapazitätsgrenze." },
      { phase: "Bricktoy-Hinweis", query: "command=bricktoy&source=demo", note: "Keine LEGO-Verbindung behauptet." },
    ],
  },
};

export const COPY: Record<Locale, Copy> = { en, de };

export function toLocale(value: string): Locale {
  return value === "de" ? "de" : "en";
}
