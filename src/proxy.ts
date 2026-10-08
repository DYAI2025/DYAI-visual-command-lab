import { NextRequest, NextResponse } from "next/server";

const locales = ["en", "de"] as const;
const defaultLocale = "en";

function hasLocale(pathname: string) {
  return locales.some(
    (locale) => pathname === `/${locale}` || pathname.startsWith(`/${locale}/`),
  );
}

function preferredLocale(request: NextRequest) {
  const accepted = request.headers.get("accept-language")?.toLowerCase() ?? "";
  return accepted.startsWith("de") || accepted.includes(",de") ? "de" : defaultLocale;
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (hasLocale(pathname)) return NextResponse.next();

  const locale = preferredLocale(request);
  const url = request.nextUrl.clone();
  url.pathname = `/${locale}${pathname === "/" ? "" : pathname}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)"],
};
