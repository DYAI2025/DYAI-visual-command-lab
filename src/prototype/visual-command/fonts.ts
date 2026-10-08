// PROTOTYPE ONLY — Geist / Geist Mono (DYAI design system type families), self-hosted by next/font
// at build time so the running prototype makes no font request to Google.
import { Geist, Geist_Mono } from "next/font/google";

export const geist = Geist({ subsets: ["latin", "latin-ext"], variable: "--font-geist", display: "swap" });
export const geistMono = Geist_Mono({ subsets: ["latin", "latin-ext"], variable: "--font-geist-mono", display: "swap" });
