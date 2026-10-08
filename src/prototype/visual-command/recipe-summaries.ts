// PROTOTYPE ONLY — human-readable recipe disclosures for "View recipe".
//
// The real recipes (src/server/recipes/recipes.json) are server-only and must never be imported
// by UI code (tests/ui-boundary.test.mjs). These summaries are written for the click dummy, keyed
// by lane, and labelled in the interface as a simulated summary. No prompt text, no model names.

import type { Lane } from "@/domain/commands";
import type { Locale } from "./copy.ts";

interface Summary {
  preserves: string[];
  mayChange: string[];
  limits: string[];
}

const SUMMARIES: Record<Locale, Record<Lane, Summary>> = {
  en: {
    play: {
      preserves: ["who or what is recognisable in the source", "pose and overall composition"],
      mayChange: ["rendering style", "material and scale", "background and packaging"],
      limits: ["Likeness is approximate.", "Text, logos and small details may be redrawn or lost."],
    },
    explain: {
      preserves: ["the topic shown in the source"],
      mayChange: ["layout", "text labels", "structure and sequence"],
      limits: ["Labels, facts and order may be invented or wrong.", "Not a source of verified knowledge."],
    },
    polish: {
      preserves: ["subject identity", "people and objects", "geometry", "logos and text", "visible defects and materials"],
      mayChange: ["exposure and tone", "colour and perceived light", "contrast and sharpness treatment", "film or photo character", "atmosphere and depth"],
      limits: ["Preservation is intended, not guaranteed.", "The result is still AI-processed."],
    },
  },
  de: {
    play: {
      preserves: ["wer oder was in der Quelle erkennbar ist", "Pose und Gesamtkomposition"],
      mayChange: ["Darstellungsstil", "Material und Maßstab", "Hintergrund und Verpackung"],
      limits: ["Ähnlichkeit ist nur ungefähr.", "Text, Logos und kleine Details können neu gezeichnet werden oder fehlen."],
    },
    explain: {
      preserves: ["das Thema der Quelle"],
      mayChange: ["Layout", "Beschriftungen", "Struktur und Abfolge"],
      limits: ["Beschriftungen, Fakten und Reihenfolge können erfunden oder falsch sein.", "Keine Quelle geprüften Wissens."],
    },
    polish: {
      preserves: ["Identität des Motivs", "Personen und Objekte", "Geometrie", "Logos und Text", "sichtbare Mängel und Materialien"],
      mayChange: ["Belichtung und Tonwerte", "Farbe und wahrgenommenes Licht", "Kontrast und Schärfebehandlung", "Film- oder Fotocharakter", "Atmosphäre und Tiefe"],
      limits: ["Erhalt ist beabsichtigt, nicht garantiert.", "Das Ergebnis ist trotzdem KI-bearbeitet."],
    },
  },
};

export function recipeSummary(lane: Lane, locale: Locale): Summary {
  return SUMMARIES[locale][lane];
}
