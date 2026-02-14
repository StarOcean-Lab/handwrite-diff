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
      className="rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs font-medium hover:bg-gray-100 transition-colors"
      title={locale === "zh" ? "Switch to English" : "切换为中文"}
    >
      {locale === "zh" ? "EN" : "中"}
    </button>
  );
}
