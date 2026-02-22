"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import FileUploader from "@/components/FileUploader";
import { createTask, listProviders, triggerProcessing, uploadImages, type ModelProvider } from "@/lib/api";

type Step = "text" | "upload" | "confirm";
const STEPS: Step[] = ["text", "upload", "confirm"];

function StepIndicator({ current }: { current: Step }) {
  const t = useTranslations("newTask");
  const stepLabels: Record<Step, string> = {
    text: t("steps.text"),
    upload: t("steps.upload"),
    confirm: t("steps.confirm"),
  };
  const currentIdx = STEPS.indexOf(current);

  return (
    <div className="mb-8 flex items-center">
      {STEPS.map((s, i) => {
        const done = i < currentIdx;
        const active = s === current;
        return (
          <div key={s} className="flex flex-1 items-center">
            <div className="flex flex-col items-center">
              <div
                className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold transition-all duration-300 ${
                  done
                    ? "bg-emerald-500 text-white shadow-sm"
                    : active
                      ? "text-white shadow-md"
                      : "bg-slate-100 text-[var(--color-text-muted)]"
                }`}
                style={active ? { background: "linear-gradient(135deg, #2563eb 0%, #7c3aed 100%)" } : {}}
              >
                {done ? (
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M2.5 7L5.5 10L11.5 4" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                ) : (
                  i + 1
                )}
              </div>
              <span
                className={`mt-1.5 text-xs font-medium ${
                  active ? "text-[var(--color-primary)]" : done ? "text-emerald-600" : "text-[var(--color-text-muted)]"
                }`}
              >
                {stepLabels[s]}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div className="mx-2 h-px flex-1 transition-colors duration-300" style={{
                background: done ? "linear-gradient(90deg, #10b981, #34d399)" : "var(--color-border)",
              }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

const inputCls =
  "w-full rounded-xl border border-[var(--color-border)] bg-white px-4 py-2.5 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] transition-all focus:border-[var(--color-primary)] focus:outline-none focus:ring-3 focus:ring-[var(--color-primary-ring)]";

const primaryBtnCls =
  "flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-semibold text-white transition-all hover:shadow-lg disabled:cursor-not-allowed disabled:opacity-50";

const secondaryBtnCls =
  "flex w-full items-center justify-center rounded-xl border border-[var(--color-border)] bg-white py-2.5 text-sm font-medium text-[var(--color-text-secondary)] transition-all hover:border-[var(--color-border-strong)] hover:bg-slate-50 disabled:opacity-50";

export default function NewTaskPage() {
  const t = useTranslations("newTask");
  const router = useRouter();
  const [step, setStep] = useState<Step>("text");
  const [title, setTitle] = useState("");
  const [referenceText, setReferenceText] = useState("");
  const [ocrModel, setOcrModel] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [taskId, setTaskId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Provider state
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<number | null>(null);

  useEffect(() => {
    listProviders()
      .then((data) => {
        setProviders(data);
        const defaultProvider = data.find((p) => p.is_default);
        if (defaultProvider) {
          setSelectedProviderId(defaultProvider.id);
          setOcrModel(defaultProvider.default_model);
        }
      })
      .catch(() => {});
  }, []);

  const handleProviderChange = (value: string) => {
    if (value === "") {
      setSelectedProviderId(null);
      setOcrModel("");
    } else {
      const id = parseInt(value, 10);
      setSelectedProviderId(id);
      const provider = providers.find((p) => p.id === id);
      if (provider) setOcrModel(provider.default_model);
    }
  };

  const handleTextNext = async () => {
    if (!title.trim() || !referenceText.trim()) {
      setError(t("fillRequired"));
      return;
    }
    try {
      setSubmitting(true);
      setError(null);
      const task = await createTask(
        title.trim(),
        referenceText.trim(),
        ocrModel || undefined,
        selectedProviderId ?? undefined,
      );
      setTaskId(task.id);
      setStep("upload");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("taskCreateError"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleUploadNext = async () => {
    if (!taskId || files.length === 0) {
      setError(t("selectImage"));
      return;
    }
    try {
      setSubmitting(true);
      setError(null);
      await uploadImages(taskId, files);
      setStep("confirm");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("uploadError"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleStart = async () => {
    if (!taskId) return;
    try {
      setSubmitting(true);
      await triggerProcessing(taskId);
      router.push(`/tasks/${taskId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("startError"));
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-xl animate-fade-in">
      <div className="mb-8">
        <h1 className="text-xl font-bold text-[var(--color-text)]">{t("title")}</h1>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">{t("subtitle")}</p>
      </div>

      <StepIndicator current={step} />

      {error && (
        <div className="mb-4 flex items-center gap-2.5 rounded-xl border border-red-200 bg-red-50 p-3.5 text-sm text-red-700">
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" className="flex-shrink-0">
            <circle cx="7.5" cy="7.5" r="6.5" stroke="#dc2626" strokeWidth="1.5"/>
            <path d="M7.5 4.5V8M7.5 10.5H7.51" stroke="#dc2626" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          {error}
        </div>
      )}

      {/* Step 1: Reference Text */}
      {step === "text" && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-card)] p-5 shadow-[var(--shadow-sm)]">
            <div className="space-y-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-[var(--color-text)]">
                  {t("taskTitle")}
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t("taskTitlePlaceholder")}
                  className={inputCls}
                />
              </div>

              {/* OCR Provider */}
              <div>
                <label className="mb-1.5 block text-sm font-medium text-[var(--color-text)]">
                  {t("ocrProvider")}
                </label>
                {providers.length === 0 ? (
                  <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-sm text-amber-700">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="mt-0.5 flex-shrink-0">
                      <path d="M8 2L14.5 13.5H1.5L8 2Z" stroke="#d97706" strokeWidth="1.5" fill="none" strokeLinejoin="round"/>
                      <path d="M8 6.5V9.5M8 11.5H8.01" stroke="#d97706" strokeWidth="1.5" strokeLinecap="round"/>
                    </svg>
                    <span>
                      {t("noProviderHint")}{" "}
                      <a href="/providers" className="font-semibold underline underline-offset-2">
                        {t("manageProviders")}
                      </a>
                    </span>
                  </div>
                ) : (
                  <select
                    value={selectedProviderId?.toString() ?? ""}
                    onChange={(e) => handleProviderChange(e.target.value)}
                    className={inputCls}
                  >
                    <option value="">{t("useGlobalConfig")}</option>
                    {providers.map((p) => (
                      <option key={p.id} value={p.id.toString()}>
                        {p.name}{p.is_default ? ` (${t("default")})` : ""}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/* OCR Model */}
              <div>
                <label className="mb-1.5 block text-sm font-medium text-[var(--color-text)]">
                  {t("ocrModel")}
                </label>
                {(() => {
                  const selectedProvider = providers.find((p) => p.id === selectedProviderId);
                  const modelList = selectedProvider?.models ?? [];
                  if (modelList.length > 0) {
                    return (
                      <select
                        value={ocrModel}
                        onChange={(e) => setOcrModel(e.target.value)}
                        className={inputCls}
                      >
                        {modelList.map((m) => (
                          <option key={m} value={m}>
                            {m}{m === selectedProvider?.default_model ? ` (${t("default")})` : ""}
                          </option>
                        ))}
                      </select>
                    );
                  }
                  return (
                    <input
                      type="text"
                      value={ocrModel}
                      onChange={(e) => setOcrModel(e.target.value)}
                      placeholder={t("ocrModelPlaceholder")}
                      className={inputCls}
                    />
                  );
                })()}
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-[var(--color-text)]">
                  {t("referenceText")}
                </label>
                <textarea
                  value={referenceText}
                  onChange={(e) => setReferenceText(e.target.value)}
                  placeholder={t("referenceTextPlaceholder")}
                  rows={7}
                  className={inputCls}
                  style={{ resize: "vertical", minHeight: "160px" }}
                />
              </div>
            </div>
          </div>

          <button
            onClick={handleTextNext}
            disabled={submitting}
            className={primaryBtnCls}
            style={{ background: "linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)" }}
          >
            {submitting ? (
              <>
                <svg className="animate-spin" width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <circle cx="7" cy="7" r="5.5" stroke="rgba(255,255,255,0.4)" strokeWidth="2"/>
                  <path d="M7 1.5A5.5 5.5 0 0112.5 7" stroke="white" strokeWidth="2" strokeLinecap="round"/>
                </svg>
                {t("creating")}
              </>
            ) : (
              <>
                {t("nextUpload")}
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M3 7H11M7.5 3.5L11 7L7.5 10.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </>
            )}
          </button>
        </div>
      )}

      {/* Step 2: Upload Images */}
      {step === "upload" && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-card)] p-5 shadow-[var(--shadow-sm)]">
            <FileUploader onFilesSelected={setFiles} />
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => setStep("text")}
              className={secondaryBtnCls}
            >
              {t("back")}
            </button>
            <button
              onClick={handleUploadNext}
              disabled={submitting || files.length === 0}
              className={primaryBtnCls}
              style={{ background: "linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)" }}
            >
              {submitting ? (
                <>
                  <svg className="animate-spin" width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <circle cx="7" cy="7" r="5.5" stroke="rgba(255,255,255,0.4)" strokeWidth="2"/>
                    <path d="M7 1.5A5.5 5.5 0 0112.5 7" stroke="white" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                  {t("uploading")}
                </>
              ) : (
                t("uploadCount", { count: files.length })
              )}
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Confirm */}
      {step === "confirm" && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-emerald-100 bg-gradient-to-br from-emerald-50 to-teal-50 p-8 text-center shadow-[var(--shadow-sm)]">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-white shadow-[var(--shadow-md)]">
              <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
                <circle cx="14" cy="14" r="13" fill="#dcfce7" stroke="#16a34a" strokeWidth="1.5"/>
                <path d="M8 14.5L11.5 18L20 10" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <h2 className="mb-1.5 text-lg font-semibold text-[var(--color-text)]">{t("readyTitle")}</h2>
            <p className="text-sm text-[var(--color-text-secondary)]">
              {t("readyDesc", { title, count: files.length })}
            </p>
          </div>
          <button
            onClick={handleStart}
            disabled={submitting}
            className={primaryBtnCls}
            style={{ background: "linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)" }}
          >
            {submitting ? (
              <>
                <svg className="animate-spin" width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <circle cx="7" cy="7" r="5.5" stroke="rgba(255,255,255,0.4)" strokeWidth="2"/>
                  <path d="M7 1.5A5.5 5.5 0 0112.5 7" stroke="white" strokeWidth="2" strokeLinecap="round"/>
                </svg>
                {t("starting")}
              </>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M3 7L11 7M8.5 4.5L11 7L8.5 9.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                {t("startProcessing")}
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
