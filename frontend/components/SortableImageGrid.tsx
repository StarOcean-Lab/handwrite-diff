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

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-gray-100 text-gray-600",
  ocr_processing: "bg-yellow-100 text-yellow-700",
  ocr_done: "bg-blue-100 text-blue-700",
  diff_done: "bg-blue-100 text-blue-700",
  annotated: "bg-green-100 text-green-700",
  reviewed: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
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

  const statusColor = STATUS_COLORS[image.status] ?? STATUS_COLORS.pending;

  return (
    <div ref={setNodeRef} style={style} className="relative">
      <a
        href={`/tasks/${taskId}/images/${image.id}`}
        className="group block overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] transition-shadow hover:shadow-md"
      >
        {/* Thumbnail placeholder */}
        <div className="flex h-36 items-center justify-center bg-gray-50 text-4xl text-gray-300">
          📄
        </div>
        <div className="p-3">
          <p className="mb-1 truncate text-sm font-medium">
            {image.label ?? `Image #${image.id}`}
          </p>
          <span
            className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${statusColor}`}
          >
            {statusLabel}
          </span>
          {image.error_message && (
            <p className="mt-1 truncate text-xs text-red-500">
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
          className="absolute top-2 right-2 flex h-7 w-7 cursor-grab items-center justify-center rounded-md bg-white/80 text-gray-500 shadow-sm backdrop-blur-sm hover:bg-white hover:text-gray-700 active:cursor-grabbing"
          onClick={(e) => e.preventDefault()}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-4 w-4"
          >
            <path
              fillRule="evenodd"
              d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zm0 5A.75.75 0 012.75 9h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 9.75zm0 5a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75z"
              clipRule="evenodd"
            />
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
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
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
      <div className="rounded-xl border border-dashed border-[var(--color-border)] py-12 text-center text-[var(--color-text-secondary)]">
        {t("noImages")}
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
