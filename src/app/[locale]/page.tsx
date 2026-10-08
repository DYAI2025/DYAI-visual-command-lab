import ClickDummy, { type CommandView } from "@/prototype/visual-command/ClickDummy";
import { commandRepository } from "@/server/catalogue";
import { toLocale } from "@/prototype/visual-command/copy";
import { geist, geistMono } from "@/prototype/visual-command/fonts";
import "@/prototype/visual-command/click-dummy.css";

export default async function LabPage({ params, searchParams }: PageProps<"/[locale]">) {
  const { locale: rawLocale } = await params;
  const query = await searchParams;
  const locale = toLocale(rawLocale);
  const records = await commandRepository.listPublicCommands();
  const commands: CommandView[] = records.map((command) => ({
    id: command.id,
    slash: command.canonicalSlash,
    lane: command.lane,
    name: { en: command.display.en.name, de: command.display.de.name },
    description: { en: command.display.en.description, de: command.display.de.description },
    job: { en: command.job.en, de: command.job.de },
  }));
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const entry = { command:first(query.command), source:first(query.source), state:first(query.state), scenario:first(query.scenario), lane:first(query.lane) };
  return <div className={`${geist.variable} ${geistMono.variable}`}><ClickDummy key={JSON.stringify(entry)} initialLocale={locale} entry={entry} prototype={false} hold={false} commands={commands}/></div>;
}
