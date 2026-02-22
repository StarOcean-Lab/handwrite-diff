import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import LanguageToggle from "@/components/LanguageToggle";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("metadata");
  return {
    title: t("title"),
    description: t("description"),
  };
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = await getLocale();
  const messages = await getMessages();
  const t = await getTranslations("common");

  return (
    <html lang={locale}>
      <body className="min-h-screen">
        <NextIntlClientProvider messages={messages}>
          {/* Navbar */}
          <header
            className="sticky top-0 z-50 border-b border-[var(--color-border)]"
            style={{
              background: "rgba(255,255,255,0.85)",
              backdropFilter: "blur(12px)",
              WebkitBackdropFilter: "blur(12px)",
              boxShadow: "0 1px 0 rgba(0,0,0,0.06)",
            }}
          >
            <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3.5">
              {/* Logo */}
              <a href="/" className="flex items-center gap-2.5 group">
                {/* Icon */}
                <div
                  className="flex h-8 w-8 items-center justify-center rounded-lg transition-transform group-hover:scale-105"
                  style={{
                    background: "linear-gradient(135deg, #2563eb 0%, #7c3aed 100%)",
                    boxShadow: "0 2px 8px rgba(37,99,235,0.35)",
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M2 12L6 4L8 8L10 6L14 12H2Z" fill="white" opacity="0.9"/>
                    <circle cx="11" cy="4" r="1.5" fill="white"/>
                  </svg>
                </div>
                {/* Wordmark */}
                <span className="text-[15px] font-semibold tracking-tight text-[var(--color-text)]">
                  Handwrite<span className="gradient-text">Diff</span>
                </span>
              </a>

              {/* Nav Actions */}
              <div className="flex items-center gap-2">
                <LanguageToggle />
                <a
                  href="/providers"
                  className="rounded-lg px-3.5 py-2 text-sm font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-slate-100 hover:text-[var(--color-text)]"
                >
                  {t("providers")}
                </a>
                <a
                  href="/new"
                  className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-white transition-all hover:shadow-md"
                  style={{
                    background: "linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)",
                    boxShadow: "0 1px 4px rgba(37,99,235,0.4)",
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M7 1V13M1 7H13" stroke="white" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                  {t("newTask")}
                </a>
              </div>
            </div>
          </header>

          <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
