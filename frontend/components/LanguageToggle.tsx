"use client";

import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { LOCALE_COOKIE, type Locale } from "@/i18n/config";

export default function LanguageToggle() {
  const locale = useLocale() as Locale;
  const router = useRouter();

  const toggle = () => {
    const next: Locale = locale === "zh" ? "en" : "zh";
    document.cookie = `${LOCALE_COOKIE}=${next};path=/;max-age=${60 * 60 * 24 * 365}`;
    router.refresh();
  };

  return (
    <button
      onClick={toggle}
      title={locale === "zh" ? "Switch to English" : "切换为中文"}
      className="flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs font-semibold text-[var(--color-text-secondary)] transition-all hover:border-[var(--color-border-strong)] hover:bg-slate-50 hover:text-[var(--color-text)]"
    >
      <svg width="11" height="11" viewBox="0 0 11 11" fill="none" className="opacity-60">
        <circle cx="5.5" cy="5.5" r="4.5" stroke="currentColor" strokeWidth="1"/>
        <path d="M5.5 1C5.5 1 7 3 7 5.5C7 8 5.5 10 5.5 10" stroke="currentColor" strokeWidth="1"/>
        <path d="M5.5 1C5.5 1 4 3 4 5.5C4 8 5.5 10 5.5 10" stroke="currentColor" strokeWidth="1"/>
        <path d="M1 5.5H10" stroke="currentColor" strokeWidth="1"/>
      </svg>
      {locale === "zh" ? "EN" : "中"}
    </button>
  );
}
