"use client";

import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  rectSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useTranslations } from "next-intl";
import type { ImageListItem } from "@/lib/api";

const STATUS_CONFIG: Record<string, { cls: string; dot: string }> = {
  pending:        { cls: "bg-slate-100 text-slate-500",       dot: "bg-slate-300" },
  ocr_processing: { cls: "bg-amber-50 text-amber-700 border border-amber-200",  dot: "bg-amber-500" },
  ocr_done:       { cls: "bg-blue-50 text-blue-700 border border-blue-200",   dot: "bg-blue-500" },
  diff_done:      { cls: "bg-blue-50 text-blue-700 border border-blue-200",   dot: "bg-blue-500" },
  annotated:      { cls: "bg-emerald-50 text-emerald-700 border border-emerald-200", dot: "bg-emerald-500" },
  reviewed:       { cls: "bg-emerald-50 text-emerald-700 border border-emerald-200", dot: "bg-emerald-500" },
  failed:         { cls: "bg-red-50 text-red-600 border border-red-200",    dot: "bg-red-500" },
};

interface SortableImageCardProps {
  image: ImageListItem;
  taskId: number;
  disabled: boolean;
  statusLabel: string;
}

function SortableImageCard({ image, taskId, disabled, statusLabel }: SortableImageCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: image.id, disabled });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  const status = STATUS_CONFIG[image.status] ?? STATUS_CONFIG.pending;

  return (
    <div ref={setNodeRef} style={style} className="relative">
      <a
        href={`/tasks/${taskId}/images/${image.id}`}
        className="group block overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-card)] shadow-[var(--shadow-card)] transition-all duration-200 hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-md)] hover:-translate-y-0.5"
      >
        {/* Thumbnail placeholder */}
        <div className="flex h-40 items-center justify-center bg-slate-50 transition-colors group-hover:bg-slate-100">
          <svg
            width="40"
            height="40"
            viewBox="0 0 40 40"
            fill="none"
            className="text-slate-300 transition-colors group-hover:text-slate-400"
          >
            <rect x="4" y="6" width="32" height="28" rx="3" stroke="currentColor" strokeWidth="1.5" fill="none"/>
            <path d="M4 26L13 18L19 23L26 15L36 26" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
            <circle cx="14" cy="14" r="3" stroke="currentColor" strokeWidth="1.5"/>
          </svg>
        </div>

        <div className="p-3.5">
          <p className="mb-2 truncate text-sm font-semibold text-[var(--color-text)]">
            {image.label ?? `Image #${image.id}`}
          </p>
          <div className="flex items-center gap-1.5">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${status.cls} ${
                image.status === "ocr_processing" ? "animate-pulse" : ""
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
              {statusLabel}
            </span>
          </div>
          {image.error_message && (
            <p className="mt-1.5 truncate text-xs text-red-500">
              {image.error_message}
            </p>
          )}
        </div>
      </a>

      {/* Drag handle */}
      {!disabled && (
        <button
          {...attributes}
          {...listeners}
          className="absolute top-2.5 right-2.5 flex h-7 w-7 cursor-grab items-center justify-center rounded-lg bg-white/90 text-slate-400 shadow-sm backdrop-blur-sm transition-all hover:bg-white hover:text-slate-600 hover:shadow-md active:cursor-grabbing"
          onClick={(e) => e.preventDefault()}
          aria-label="Drag to reorder"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <circle cx="5" cy="3" r="1" fill="currentColor"/>
            <circle cx="9" cy="3" r="1" fill="currentColor"/>
            <circle cx="5" cy="7" r="1" fill="currentColor"/>
            <circle cx="9" cy="7" r="1" fill="currentColor"/>
            <circle cx="5" cy="11" r="1" fill="currentColor"/>
            <circle cx="9" cy="11" r="1" fill="currentColor"/>
          </svg>
        </button>
      )}
    </div>
  );
}

interface SortableImageGridProps {
  images: ImageListItem[];
  taskId: number;
  disabled: boolean;
  onReorder: (imageIds: number[]) => void;
}

export default function SortableImageGrid({
  images,
  taskId,
  disabled,
  onReorder,
}: SortableImageGridProps) {
  const t = useTranslations("taskDetail");

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const getStatusLabel = (status: string): string => {
    const key = `imageStatus.${status}` as any;
    return t.has(key) ? t(key) : status;
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = images.findIndex((img) => img.id === active.id);
    const newIndex = images.findIndex((img) => img.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(images, oldIndex, newIndex);
    onReorder(reordered.map((img) => img.id));
  };

  if (images.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-[var(--color-border)] py-16 text-center">
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none" className="mb-3 text-slate-300">
          <rect x="4" y="6" width="32" height="28" rx="3" stroke="currentColor" strokeWidth="1.5"/>
          <path d="M4 26L13 18L19 23L26 15L36 26" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
          <circle cx="14" cy="14" r="3" stroke="currentColor" strokeWidth="1.5"/>
        </svg>
        <p className="text-sm text-[var(--color-text-secondary)]">{t("noImages")}</p>
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext
        items={images.map((img) => img.id)}
        strategy={rectSortingStrategy}
      >
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {images.map((img) => (
            <SortableImageCard
              key={img.id}
              image={img}
              taskId={taskId}
              disabled={disabled}
              statusLabel={getStatusLabel(img.status)}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
