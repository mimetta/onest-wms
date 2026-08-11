import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "@/i18n/locale";
import { dmSans, notoSansThai } from "@/lib/fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Onest WMS",
  description: "Onest Warehouse Management System · ระบบบริหารคลังสินค้า",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Onest WMS" },
};

export const viewport: Viewport = {
  themeColor: "#1F3A2B",
  width: "device-width",
  initialScale: 1,
  // Deliberately NOT maximumScale: 1. Pinch-zoom is how someone reads a small
  // lot number on a cheap handheld screen; disabling it to make the app feel
  // "native" would make it less usable in the exact place it is used most.
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const locale = await getLocale();

  return (
    <html lang={locale} className={`${dmSans.variable} ${notoSansThai.variable}`}>
      <body className="min-h-dvh">
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
