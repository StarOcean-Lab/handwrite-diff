"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useTranslations } from "next-intl";
import FileUploader from "@/components/FileUploader";
import { createTask, triggerProcessing, uploadImages } from "@/lib/api";

type Step = "text" | "upload" | "confirm";

const OCR_MODELS = [
  { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash（快速）" },
  { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro（高精度）" },
  { value: "gemini-3-flash-preview", label: "Gemini 3 Flash Preview" },
  { value: "gemini-3-pro-preview", label: "Gemini 3 Pro Preview" },
];

export default function NewTaskPage() {
  const t = useTranslations("newTask");
  const router = useRouter();
  const [step, setStep] = useState<Step>("text");
  const [title, setTitle] = useState("");
  const [referenceText, setReferenceText] = useState("");
  const [ocrModel, setOcrModel] = useState("gemini-2.5-flash");
  const [files, setFiles] = useState<File[]>([]);
  const [taskId, setTaskId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleTextNext = async () => {
    if (!title.trim() || !referenceText.trim()) {
      setError(t("fillRequired"));
      return;
    }
    try {
      setSubmitting(true);
      setError(null);
      const task = await createTask(title.trim(), referenceText.trim(), ocrModel);
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
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-8 text-2xl font-bold">{t("title")}</h1>

      {/* Step indicator */}
      <div className="mb-8 flex items-center gap-3">
        {(["text", "upload", "confirm"] as Step[]).map((s, i) => (
          <div key={s} className="flex items-center gap-3">
            <div
              className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold ${
                step === s
                  ? "bg-[var(--color-primary)] text-white"
                  : i < ["text", "upload", "confirm"].indexOf(step)
                    ? "bg-green-500 text-white"
                    : "bg-gray-200 text-gray-500"
              }`}
            >
              {i + 1}
            </div>
            {i < 2 && <div className="h-px w-12 bg-[var(--color-border)]" />}
          </div>
        ))}
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Step 1: Reference Text */}
      {step === "text" && (
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">{t("taskTitle")}</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("taskTitlePlaceholder")}
              className="w-full rounded-lg border border-[var(--color-border)] px-4 py-2.5 text-sm focus:border-[var(--color-primary)] focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">{t("ocrModel")}</label>
            <select
              value={ocrModel}
              onChange={(e) => setOcrModel(e.target.value)}
              className="w-full rounded-lg border border-[var(--color-border)] bg-white px-4 py-2.5 text-sm focus:border-[var(--color-primary)] focus:outline-none"
            >
              {OCR_MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">{t("referenceText")}</label>
            <textarea
              value={referenceText}
              onChange={(e) => setReferenceText(e.target.value)}
              placeholder={t("referenceTextPlaceholder")}
              rows={8}
              className="w-full rounded-lg border border-[var(--color-border)] px-4 py-3 text-sm focus:border-[var(--color-primary)] focus:outline-none"
            />
          </div>
          <button
            onClick={handleTextNext}
            disabled={submitting}
            className="w-full rounded-lg bg-[var(--color-primary)] py-2.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
          >
            {submitting ? t("creating") : t("nextUpload")}
          </button>
        </div>
      )}

      {/* Step 2: Upload Images */}
      {step === "upload" && (
        <div className="space-y-4">
          <FileUploader onFilesSelected={setFiles} />
          <div className="flex gap-3">
            <button
              onClick={() => setStep("text")}
              className="flex-1 rounded-lg border border-[var(--color-border)] py-2.5 text-sm font-medium hover:bg-gray-50"
            >
              {t("back")}
            </button>
            <button
              onClick={handleUploadNext}
              disabled={submitting || files.length === 0}
              className="flex-1 rounded-lg bg-[var(--color-primary)] py-2.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
            >
              {submitting ? t("uploading") : t("uploadCount", { count: files.length })}
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Confirm */}
      {step === "confirm" && (
        <div className="space-y-4 text-center">
          <div className="rounded-xl bg-green-50 p-8">
            <div className="mb-2 text-4xl">✅</div>
            <h2 className="mb-1 text-lg font-semibold">{t("readyTitle")}</h2>
            <p className="text-sm text-[var(--color-text-secondary)]">
              {t("readyDesc", { title, count: files.length })}
            </p>
          </div>
          <button
            onClick={handleStart}
            disabled={submitting}
            className="w-full rounded-lg bg-[var(--color-primary)] py-3 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
          >
            {submitting ? t("starting") : t("startProcessing")}
          </button>
        </div>
      )}
    </div>
  );
}
