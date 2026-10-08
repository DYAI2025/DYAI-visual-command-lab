import "../globals.css";
import { notFound } from "next/navigation";

const supportedLocales = new Set(["en", "de"]);

export const metadata = {
  title: "DYAI Visual Command Lab",
  description: "Choose the outcome, not the prompt.",
};

export default async function LocaleLayout({
  children,
  params,
}: LayoutProps<"/[locale]">) {
  const { locale } = await params;
  if (!supportedLocales.has(locale)) notFound();

  return (
    <html lang={locale}>
      <body>{children}</body>
    </html>
  );
}
