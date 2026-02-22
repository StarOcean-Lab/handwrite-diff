"use client";

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";

interface FileUploaderProps {
  onFilesSelected: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
}

export default function FileUploader({
  onFilesSelected,
  accept = "image/*",
  multiple = true,
}: FileUploaderProps) {
  const t = useTranslations("fileUploader");
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const files = Array.from(e.dataTransfer.files).filter((f) =>
        f.type.startsWith("image/"),
      );
      if (files.length > 0) {
        setSelectedFiles(files);
        onFilesSelected(files);
      }
    },
    [onFilesSelected],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      if (files.length > 0) {
        setSelectedFiles(files);
        onFilesSelected(files);
      }
    },
    [onFilesSelected],
  );

  return (
    <div>
      <label
        htmlFor="file-upload"
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed p-10 transition-all duration-200 ${
          isDragging
            ? "border-[var(--color-primary)] bg-[var(--color-primary-light)] scale-[1.01]"
            : "border-[var(--color-border)] hover:border-[var(--color-primary)] hover:bg-[var(--color-primary-light)]"
        }`}
      >
        <input
          type="file"
          accept={accept}
          multiple={multiple}
          onChange={handleChange}
          className="hidden"
          id="file-upload"
        />
        {/* Upload icon */}
        <div
          className={`mb-4 flex h-14 w-14 items-center justify-center rounded-2xl transition-colors ${
            isDragging ? "bg-[var(--color-primary)]" : "bg-slate-100"
          }`}
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            className={isDragging ? "text-white" : "text-slate-400"}
          >
            <path
              d="M12 16V8M12 8L9 11M12 8L15 11"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M3 15V17C3 19.2091 4.79086 21 7 21H17C19.2091 21 21 19.2091 21 17V15"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </div>

        <p className="mb-1 text-sm font-semibold text-[var(--color-text)]">
          {t("dragHint")}
        </p>
        <p className="text-xs text-[var(--color-text-muted)]">
          {t("formatHint")}
        </p>
      </label>

      {selectedFiles.length > 0 && (
        <div className="mt-3 rounded-xl border border-[var(--color-border)] bg-slate-50 p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-semibold text-[var(--color-text)]">
              {t("filesSelected", { count: selectedFiles.length })}
            </p>
            <span className="rounded-full bg-[var(--color-primary)] px-2 py-0.5 text-xs font-bold text-white">
              {selectedFiles.length}
            </span>
          </div>
          <ul className="max-h-40 space-y-1 overflow-y-auto">
            {selectedFiles.map((f, i) => (
              <li key={i} className="flex items-center gap-2 rounded-lg bg-white px-3 py-1.5 text-xs">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="flex-shrink-0 text-slate-400">
                  <rect x="1" y="1" width="10" height="10" rx="1.5" stroke="currentColor" strokeWidth="1"/>
                  <path d="M3.5 4.5H8.5M3.5 6H7" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
                </svg>
                <span className="min-w-0 flex-1 truncate text-[var(--color-text)]">{f.name}</span>
                <span className="flex-shrink-0 text-[var(--color-text-muted)]">
                  {(f.size / 1024).toFixed(1)} KB
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
