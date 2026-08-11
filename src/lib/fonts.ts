import { DM_Sans, Noto_Sans_Thai } from "next/font/google";

/**
 * DM Sans for Latin, Noto Sans Thai for Thai — the pairing named in the
 * Mimetta palette doc. Both are loaded as CSS variables and composed into
 * --font-sans in globals.css, so Thai text falls back automatically without
 * every component having to know which script it is rendering.
 */
export const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-dm-sans",
  display: "swap",
});

export const notoSansThai = Noto_Sans_Thai({
  subsets: ["thai"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-noto-thai",
  display: "swap",
});
