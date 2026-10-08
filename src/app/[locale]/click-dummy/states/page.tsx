// PROTOTYPE ONLY — state catalogue for reviewing every click-dummy state by URL.
import type { Metadata, Route } from "next";
import Link from "next/link";
import { COPY, toLocale } from "@/prototype/visual-command/copy";
import { geist, geistMono } from "@/prototype/visual-command/fonts";
import { Wordmark } from "@/prototype/visual-command/primitives";
import "@/prototype/visual-command/click-dummy.css";

export const metadata: Metadata = {
  title: "Visual Command Lab — state catalogue · DYAI Studio",
  robots: { index: false, follow: false },
};

export default async function StateCataloguePage({ params }: PageProps<"/[locale]/click-dummy/states">) {
  const { locale: raw } = await params;
  const locale = toLocale(raw);
  const t = COPY[locale];
  const base = `/${locale}/click-dummy`;
  const href = (query: string) => (query ? `${base}?${query}&prototype=1` : `${base}?prototype=1`) as Route;

  return (
    <div className={`${geist.variable} ${geistMono.variable}`}>
      <div className="vcl vcl-catalogue">
        <header className="vcl-header">
          <div className="vcl-shell vcl-header-inner">
            <Wordmark label={t.wordmarkLabel} />
            <span className="vcl-meta vcl-header-lab">{t.labName} · VC-01</span>
            <span className="vcl-header-badge vcl-meta">{t.prototypeBadge}</span>
          </div>
        </header>
        <main className="vcl-shell vcl-catalogue-main">
          <p className="vcl-meta vcl-eyebrow">{t.prototype.title}</p>
          <h1 className="vcl-gallery-title">{t.catalogue.title}</h1>
          <p className="vcl-intro">{t.catalogue.intro}</p>
          <ol className="vcl-catalogue-list">
            {t.catalogue.states.map((entry) => (
              <li key={entry.phase + entry.query}>
                <code className="vcl-slash">{entry.phase}</code>
                <span>{entry.note}</span>
                <Link className="vcl-text-button" href={href(entry.query)}>
                  {t.catalogue.open} →
                </Link>
              </li>
            ))}
          </ol>
          <Link className="vcl-text-button" href={href("")}>
            {t.catalogue.back}
          </Link>
        </main>
      </div>
    </div>
  );
}
