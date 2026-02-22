"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import ProviderFormModal from "@/components/ProviderFormModal";
import {
  deleteProvider,
  listProviders,
  setDefaultProvider,
  type ModelProvider,
} from "@/lib/api";

export default function ProvidersPage() {
  const t = useTranslations("providers");

  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalProvider, setModalProvider] = useState<ModelProvider | null | "new">(undefined as never);
  const [showModal, setShowModal] = useState(false);

  const loadProviders = useCallback(async () => {
    try {
      const data = await listProviders();
      setProviders(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("loadError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  const handleOpenNew = () => {
    setModalProvider(null);
    setShowModal(true);
  };

  const handleEdit = (p: ModelProvider) => {
    setModalProvider(p);
    setShowModal(true);
  };

  const handleSave = (saved: ModelProvider) => {
    setProviders((prev) => {
      const idx = prev.findIndex((p) => p.id === saved.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = saved;
        return next;
      }
      return [...prev, saved];
    });
    setShowModal(false);
  };

  const handleSetDefault = async (p: ModelProvider) => {
    try {
      const updated = await setDefaultProvider(p.id);
      setProviders((prev) =>
        prev.map((x) => ({ ...x, is_default: x.id === updated.id }))
      );
    } catch (err) {
      alert(err instanceof Error ? err.message : t("setDefaultError"));
    }
  };

  const handleDelete = async (p: ModelProvider) => {
    if (!confirm(t("deleteConfirm", { name: p.name }))) return;
    try {
      await deleteProvider(p.id);
      setProviders((prev) => prev.filter((x) => x.id !== p.id));
    } catch (err) {
      alert(err instanceof Error ? err.message : t("deleteError"));
    }
  };

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <button
          onClick={handleOpenNew}
          className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] transition-colors"
        >
          + {t("addProvider")}
        </button>
      </div>

      {loading && (
        <p className="text-[var(--color-text-secondary)]">{t("loading")}</p>
      )}

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {!loading && providers.length === 0 && (
        <div className="rounded-xl border border-dashed border-[var(--color-border)] p-12 text-center">
          <p className="mb-2 text-[var(--color-text-secondary)]">{t("noProviders")}</p>
          <p className="text-sm text-[var(--color-text-secondary)]">{t("noProvidersHint")}</p>
        </div>
      )}

      <div className="space-y-4">
        {providers.map((p) => (
          <div
            key={p.id}
            className="rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-5"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center gap-2">
                  <h3 className="font-semibold">{p.name}</h3>
                  {p.is_default && (
                    <span className="rounded-full bg-[var(--color-primary)] px-2 py-0.5 text-xs text-white">
                      {t("default")}
                    </span>
                  )}
                </div>
                <p className="truncate text-sm text-[var(--color-text-secondary)]">
                  {p.base_url}
                </p>
                <p className="text-sm text-[var(--color-text-secondary)]">
                  {t("apiKeyLabel")}: <span className="font-mono">{p.api_key_masked}</span>
                </p>
                <p className="text-sm text-[var(--color-text-secondary)]">
                  {t("defaultModelLabel")}: <span className="font-mono">{p.default_model}</span>
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {!p.is_default && (
                  <button
                    onClick={() => handleSetDefault(p)}
                    className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-gray-50"
                  >
                    {t("setDefault")}
                  </button>
                )}
                <button
                  onClick={() => handleEdit(p)}
                  className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-gray-50"
                >
                  {t("edit")}
                </button>
                <button
                  onClick={() => handleDelete(p)}
                  className="rounded-lg border border-red-200 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"
                >
                  {t("delete")}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {showModal && (
        <ProviderFormModal
          provider={modalProvider as ModelProvider | null}
          onClose={() => setShowModal(false)}
          onSave={handleSave}
        />
      )}
    </div>
  );
}
