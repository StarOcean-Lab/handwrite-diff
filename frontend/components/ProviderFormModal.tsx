"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  createProvider,
  testProviderConnection,
  testProviderModels,
  updateProvider,
  type ModelProvider,
  type ModelTestResult,
} from "@/lib/api";

interface ProviderFormModalProps {
  provider: ModelProvider | null;
  onClose: () => void;
  onSave: (p: ModelProvider) => void;
}

export default function ProviderFormModal({
  provider,
  onClose,
  onSave,
}: ProviderFormModalProps) {
  const t = useTranslations("providers");

  const [name, setName] = useState(provider?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(provider?.base_url ?? "");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<string[]>(provider?.models ?? []);
  const [defaultModel, setDefaultModel] = useState(provider?.default_model ?? "");
  const [newModelInput, setNewModelInput] = useState("");
  const [isDefault, setIsDefault] = useState(provider?.is_default ?? false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // -- Test panel state --
  const [showTestPanel, setShowTestPanel] = useState(false);
  const [checkedModels, setCheckedModels] = useState<Set<string>>(new Set());
  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState<ModelTestResult[]>([]);

  // ------------------------------------------------------------------
  // Model list helpers
  // ------------------------------------------------------------------

  const addModel = () => {
    const m = newModelInput.trim();
    if (!m || models.includes(m)) return;
    setModels((prev) => [...prev, m]);
    if (!defaultModel) setDefaultModel(m);
    setNewModelInput("");
  };

  const removeModel = (m: string) => {
    setModels((prev) => {
      const next = prev.filter((x) => x !== m);
      if (defaultModel === m) setDefaultModel(next[0] ?? "");
      return next;
    });
    setCheckedModels((prev) => {
      const next = new Set(prev);
      next.delete(m);
      return next;
    });
  };

  const handleModelKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addModel();
    }
  };

  // ------------------------------------------------------------------
  // Test panel helpers
  // ------------------------------------------------------------------

  const openTestPanel = () => {
    // Pre-check all current models
    setCheckedModels(new Set(models));
    setTestResults([]);
    setShowTestPanel(true);
  };

  const toggleChecked = (m: string) => {
    setCheckedModels((prev) => {
      const next = new Set(prev);
      if (next.has(m)) next.delete(m);
      else next.add(m);
      return next;
    });
  };

  const runTests = async () => {
    const toTest = models.filter((m) => checkedModels.has(m));
    if (toTest.length === 0) return;

    setTesting(true);
    setTestResults([]);

    try {
      if (provider) {
        // Editing: use stored key via backend endpoint
        const results = await testProviderModels(provider.id, toTest);
        setTestResults(results);
      } else {
        // New provider: need apiKey + baseUrl from form, test one by one
        const effectiveKey = apiKey.trim();
        const effectiveUrl = baseUrl.trim();
        if (!effectiveKey || !effectiveUrl) {
          setTestResults(toTest.map((m) => ({
            model: m,
            success: false,
            message: t("testFillRequired"),
          })));
          return;
        }
        const results: ModelTestResult[] = [];
        for (const m of toTest) {
          try {
            const r = await testProviderConnection({
              base_url: effectiveUrl,
              api_key: effectiveKey,
              model: m,
            });
            results.push({ model: m, success: r.success, message: r.message, latency_ms: r.latency_ms });
          } catch (err) {
            results.push({ model: m, success: false, message: err instanceof Error ? err.message : t("testError") });
          }
          // Update results incrementally so the user sees progress
          setTestResults([...results]);
        }
      }
    } catch (err) {
      setTestResults(toTest.map((m) => ({
        model: m,
        success: false,
        message: err instanceof Error ? err.message : t("testError"),
      })));
    } finally {
      setTesting(false);
    }
  };

  // ------------------------------------------------------------------
  // Submit
  // ------------------------------------------------------------------

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !baseUrl.trim()) {
      setError(t("fillRequired"));
      return;
    }
    if (models.length === 0) {
      setError(t("modelsRequired"));
      return;
    }
    if (!defaultModel) {
      setError(t("defaultModelRequired"));
      return;
    }
    if (!provider && !apiKey.trim()) {
      setError(t("apiKeyRequired"));
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        base_url: baseUrl.trim(),
        default_model: defaultModel,
        models,
        is_default: isDefault,
      };
      const saved = provider
        ? await updateProvider(provider.id, {
            ...payload,
            ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
          })
        : await createProvider({ ...payload, api_key: apiKey.trim() });
      onSave(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("saveError"));
    } finally {
      setSaving(false);
    }
  };

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="relative w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl bg-[var(--color-card)] p-6 shadow-xl">
        <h2 className="mb-5 text-lg font-semibold">
          {provider ? t("editProvider") : t("addProvider")}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Name */}
          <div>
            <label className="mb-1 block text-sm font-medium">{t("name")}</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("namePlaceholder")}
              className="w-full rounded-lg border border-[var(--color-border)] px-4 py-2.5 text-sm focus:border-[var(--color-primary)] focus:outline-none"
            />
          </div>

          {/* Base URL */}
          <div>
            <label className="mb-1 block text-sm font-medium">{t("baseUrl")}</label>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://generativelanguage.googleapis.com"
              className="w-full rounded-lg border border-[var(--color-border)] px-4 py-2.5 text-sm focus:border-[var(--color-primary)] focus:outline-none"
            />
          </div>

          {/* API Key */}
          <div>
            <label className="mb-1 block text-sm font-medium">{t("apiKey")}</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={provider ? t("apiKeyPlaceholderEdit") : t("apiKeyPlaceholder")}
              className="w-full rounded-lg border border-[var(--color-border)] px-4 py-2.5 text-sm focus:border-[var(--color-primary)] focus:outline-none"
            />
          </div>

          {/* Models List */}
          <div>
            <label className="mb-1 block text-sm font-medium">{t("modelsList")}</label>
            <p className="mb-2 text-xs text-[var(--color-text-secondary)]">{t("modelsListHint")}</p>

            {models.length > 0 && (
              <div className="mb-2 space-y-1">
                {models.map((m) => (
                  <div
                    key={m}
                    className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2"
                  >
                    {/* Default radio */}
                    <input
                      type="radio"
                      name="defaultModel"
                      checked={defaultModel === m}
                      onChange={() => setDefaultModel(m)}
                      className="h-4 w-4 accent-[var(--color-primary)] shrink-0"
                      title={t("setAsDefaultModel")}
                    />
                    <span className="flex-1 truncate font-mono text-sm">{m}</span>
                    {defaultModel === m && (
                      <span className="shrink-0 rounded-full bg-[var(--color-primary)] px-2 py-0.5 text-xs text-white">
                        {t("default")}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => removeModel(m)}
                      className="shrink-0 text-gray-400 hover:text-red-500 text-lg leading-none"
                      title={t("removeModel")}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Add model input */}
            <div className="flex gap-2">
              <input
                type="text"
                value={newModelInput}
                onChange={(e) => setNewModelInput(e.target.value)}
                onKeyDown={handleModelKeyDown}
                placeholder={t("addModelPlaceholder")}
                className="flex-1 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm focus:border-[var(--color-primary)] focus:outline-none"
              />
              <button
                type="button"
                onClick={addModel}
                disabled={!newModelInput.trim()}
                className="rounded-lg bg-[var(--color-primary)] px-3 py-2 text-sm text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-40"
              >
                {t("addModel")}
              </button>
            </div>
          </div>

          {/* Is Default */}
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="h-4 w-4 rounded accent-[var(--color-primary)]"
            />
            {t("setAsDefault")}
          </label>

          {/* Test Connection */}
          <div className="rounded-lg border border-[var(--color-border)] p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{t("testConnection")}</span>
              <button
                type="button"
                onClick={showTestPanel ? () => setShowTestPanel(false) : openTestPanel}
                disabled={models.length === 0}
                className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-40"
              >
                {showTestPanel ? t("testCollapse") : t("testExpand")}
              </button>
            </div>

            {showTestPanel && (
              <div className="mt-3 space-y-2">
                <p className="text-xs text-[var(--color-text-secondary)]">{t("testSelectHint")}</p>

                {/* Model checkboxes */}
                <div className="space-y-1">
                  {models.map((m) => {
                    const result = testResults.find((r) => r.model === m);
                    return (
                      <label
                        key={m}
                        className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-gray-50"
                      >
                        <input
                          type="checkbox"
                          checked={checkedModels.has(m)}
                          onChange={() => toggleChecked(m)}
                          className="h-4 w-4 accent-[var(--color-primary)] shrink-0"
                        />
                        <span className="flex-1 truncate font-mono text-sm">{m}</span>
                        {result && (
                          <span
                            className={`shrink-0 text-xs ${result.success ? "text-green-600" : "text-red-500"}`}
                          >
                            {result.success
                              ? `✅ ${result.latency_ms}ms`
                              : `❌ ${result.message}`}
                          </span>
                        )}
                        {testing && checkedModels.has(m) && !result && (
                          <span className="shrink-0 text-xs text-gray-400">{t("testing")}…</span>
                        )}
                      </label>
                    );
                  })}
                </div>

                {/* Select all / none */}
                <div className="flex gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => setCheckedModels(new Set(models))}
                    className="text-[var(--color-primary)] hover:underline"
                  >
                    {t("testSelectAll")}
                  </button>
                  <span className="text-gray-300">|</span>
                  <button
                    type="button"
                    onClick={() => setCheckedModels(new Set())}
                    className="text-[var(--color-primary)] hover:underline"
                  >
                    {t("testSelectNone")}
                  </button>
                </div>

                <button
                  type="button"
                  onClick={runTests}
                  disabled={testing || checkedModels.size === 0}
                  className="w-full rounded-lg bg-[var(--color-primary)] py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
                >
                  {testing
                    ? t("testRunning", { done: testResults.length, total: checkedModels.size })
                    : t("testRun", { count: checkedModels.size })}
                </button>
              </div>
            )}
          </div>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-lg border border-[var(--color-border)] py-2.5 text-sm hover:bg-gray-50"
            >
              {t("cancel")}
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 rounded-lg bg-[var(--color-primary)] py-2.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
            >
              {saving ? t("saving") : t("save")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
