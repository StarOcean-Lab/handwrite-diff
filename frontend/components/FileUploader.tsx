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
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
      className={`
        flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-10 transition-colors cursor-pointer
        ${isDragging ? "border-[var(--color-primary)] bg-blue-50" : "border-[var(--color-border)] hover:border-[var(--color-primary)]"}
      `}
    >
      <input
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={handleChange}
        className="hidden"
        id="file-upload"
      />
      <label htmlFor="file-upload" className="cursor-pointer text-center">
        <div className="mb-2 text-4xl">📷</div>
        <p className="text-sm font-medium text-[var(--color-text)]">
          {t("dragHint")}
        </p>
        <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
          {t("formatHint")}
        </p>
      </label>
      {selectedFiles.length > 0 && (
        <div className="mt-4 w-full">
          <p className="mb-2 text-sm font-medium">
            {t("filesSelected", { count: selectedFiles.length })}
          </p>
          <ul className="max-h-32 overflow-y-auto text-xs text-[var(--color-text-secondary)]">
            {selectedFiles.map((f, i) => (
              <li key={i} className="truncate">
                {f.name} ({(f.size / 1024).toFixed(1)} KB)
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
