// PROTOTYPE ONLY — Visual Command Lab click dummy route. Simulated auth and generation; the real
// generation boundary (POST /api/generate, DYAI-37) is neither called nor changed.
import type { Metadata } from "next";
import { commandCatalogue } from "@/domain/commands";
import ClickDummy, { type CommandView } from "@/prototype/visual-command/ClickDummy";
import { toLocale } from "@/prototype/visual-command/copy";
import { geist, geistMono } from "@/prototype/visual-command/fonts";
import "@/prototype/visual-command/click-dummy.css";

export const metadata: Metadata = {
  title: "Visual Command Lab — click dummy · DYAI Studio",
  description: "Prototype: choose the outcome, not the prompt. Generation is simulated.",
  robots: { index: false, follow: false },
};

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export default async function ClickDummyPage({ params, searchParams }: PageProps<"/[locale]/click-dummy">) {
  const { locale } = await params;
  const query = await searchParams;
  const commands: CommandView[] = commandCatalogue.map((command) => ({
    id: command.id,
    slash: command.canonicalSlash,
    lane: command.lane,
    name: { en: command.display.en.name, de: command.display.de.name },
    description: { en: command.display.en.description, de: command.display.de.description },
    job: { en: command.job.en, de: command.job.de },
  }));
  const entry = {
    command: first(query.command),
    source: first(query.source),
    state: first(query.state),
    scenario: first(query.scenario),
    lane: first(query.lane),
  };

  return (
    <div className={`${geist.variable} ${geistMono.variable}`}>
      <ClickDummy
        key={JSON.stringify(entry)}
        initialLocale={toLocale(locale)}
        entry={entry}
        prototype={first(query.prototype) === "1"}
        hold={first(query.hold) === "1"}
        commands={commands}
      />
    </div>
  );
}
