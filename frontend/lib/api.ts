/**
 * API client for communicating with the HandwriteDiff backend.
 */

const BASE = "";  // Uses Next.js rewrites to proxy /api/* to backend

export interface Task {
  id: number;
  title: string;
  reference_text: string;
  reference_words: string[] | null;
  status: string;
  total_images: number;
  completed_images: number;
  ocr_model: string | null;
  provider_id: number | null;
  provider_name: string | null;
  created_at: string;
}

export interface TaskListItem {
  id: number;
  title: string;
  reference_text_preview: string;
  status: string;
  total_images: number;
  completed_images: number;
  ocr_model: string | null;
  provider_id: number | null;
  provider_name: string | null;
  created_at: string;
}

export interface ModelProvider {
  id: number;
  name: string;
  base_url: string;
  api_key_masked: string;
  default_model: string;
  models: string[];
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface TaskListPaginated {
  items: TaskListItem[];
  total: number;
  page: number;
  limit: number;
}

export interface ImageListItem {
  id: number;
  task_id: number;
  label: string | null;
  sort_order: number;
  status: string;
  error_message: string | null;
  created_at: string;
}

export interface OcrWord {
  text: string;
  bbox: number[];
  confidence: number;
}

export interface Annotation {
  id: number;
  image_id: number;
  word_index: number | null;
  ocr_word: string | null;
  reference_word: string | null;
  error_type: string;
  annotation_shape: string;
  bbox_x1: number;
  bbox_y1: number;
  bbox_x2: number;
  bbox_y2: number;
  is_auto: boolean;
  is_user_corrected: boolean;
  note: string | null;
  label_x: number | null;
  label_y: number | null;
  label_font_size: number | null;
}

export interface ImageDetail {
  id: number;
  task_id: number;
  label: string | null;
  image_path: string;
  annotated_image_path: string | null;
  ocr_raw_text: string | null;
  ocr_words: OcrWord[] | null;
  diff_result: Array<{
    diff_type: string;
    ocr_index: number | null;
    ref_index: number | null;
    ocr_word: string | null;
    reference_word: string | null;
    ocr_confidence?: number | null;
  }> | null;
  status: string;
  error_message: string | null;
  annotations: Annotation[];
}

// --- Tasks ---

export async function createTask(
  title: string,
  referenceText: string,
  ocrModel?: string,
  providerId?: number,
): Promise<Task> {
  const res = await fetch(`${BASE}/api/v1/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      reference_text: referenceText,
      ocr_model: ocrModel || null,
      provider_id: providerId ?? null,
    }),
  });
  if (!res.ok) throw new Error(`Create task failed: ${res.status}`);
  return res.json();
}

export async function listTasks(page = 1, limit = 20): Promise<TaskListPaginated> {
  const res = await fetch(`${BASE}/api/v1/tasks?page=${page}&limit=${limit}`);
  if (!res.ok) throw new Error(`List tasks failed: ${res.status}`);
  return res.json();
}

export async function getTask(taskId: number): Promise<Task> {
  const res = await fetch(`${BASE}/api/v1/tasks/${taskId}`);
  if (!res.ok) throw new Error(`Get task failed: ${res.status}`);
  return res.json();
}

export async function deleteTask(taskId: number): Promise<void> {
  const res = await fetch(`${BASE}/api/v1/tasks/${taskId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Delete task failed: ${res.status}`);
}

export async function updateReferenceText(taskId: number, referenceText: string): Promise<Task> {
  const res = await fetch(`${BASE}/api/v1/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reference_text: referenceText }),
  });
  if (!res.ok) throw new Error(`Update reference text failed: ${res.status}`);
  return res.json();
}

export interface TaskStats {
  task_id: number;
  total_words: number;
  accuracy_pct: number;
  correct: number;
  wrong: number;
  missing: number;
  extra: number;
}

export async function getTaskStats(taskId: number): Promise<TaskStats> {
  const res = await fetch(`${BASE}/api/v1/tasks/${taskId}/stats`);
  if (!res.ok) throw new Error(`Get task stats failed: ${res.status}`);
  return res.json();
}

// --- Images ---

export async function uploadImages(taskId: number, files: File[]): Promise<{ uploaded: number; images: ImageListItem[] }> {
  const form = new FormData();
  for (const f of files) {
    form.append("files", f);
  }
  const res = await fetch(`${BASE}/api/v1/tasks/${taskId}/images`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(`Upload images failed: ${res.status}`);
  return res.json();
}

export async function listTaskImages(taskId: number): Promise<ImageListItem[]> {
  const res = await fetch(`${BASE}/api/v1/tasks/${taskId}/images`);
  if (!res.ok) throw new Error(`List images failed: ${res.status}`);
  return res.json();
}

export async function reorderImages(
  taskId: number,
  imageIds: number[],
): Promise<{ status: string; reordered: number; triggered_rediff: boolean }> {
  const res = await fetch(`${BASE}/api/v1/tasks/${taskId}/images/reorder`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image_ids: imageIds }),
  });
  if (!res.ok) throw new Error(`Reorder images failed: ${res.status}`);
  return res.json();
}

export async function getImageDetail(imageId: number): Promise<ImageDetail> {
  const res = await fetch(`${BASE}/api/v1/images/${imageId}`);
  if (!res.ok) throw new Error(`Get image detail failed: ${res.status}`);
  return res.json();
}

export function getOriginalImageUrl(imageId: number): string {
  return `${BASE}/api/v1/images/${imageId}/original`;
}

export function getAnnotatedImageUrl(imageId: number): string {
  return `${BASE}/api/v1/images/${imageId}/annotated`;
}

// --- OCR Correction ---

export async function correctOcr(imageId: number, correctedText: string): Promise<void> {
  const res = await fetch(`${BASE}/api/v1/images/${imageId}/ocr`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ corrected_text: correctedText }),
  });
  if (!res.ok) throw new Error(`Correct OCR failed: ${res.status}`);
}

// --- Annotations ---

export async function replaceAnnotations(imageId: number, annotations: Omit<Annotation, "id" | "image_id" | "is_user_corrected">[]): Promise<Annotation[]> {
  const res = await fetch(`${BASE}/api/v1/images/${imageId}/annotations`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ annotations }),
  });
  if (!res.ok) throw new Error(`Replace annotations failed: ${res.status}`);
  return res.json();
}

export async function createAnnotation(imageId: number, annotation: Omit<Annotation, "id" | "image_id" | "is_user_corrected">): Promise<Annotation> {
  const res = await fetch(`${BASE}/api/v1/images/${imageId}/annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(annotation),
  });
  if (!res.ok) throw new Error(`Create annotation failed: ${res.status}`);
  return res.json();
}

export async function deleteAnnotation(imageId: number, annotId: number): Promise<void> {
  const res = await fetch(`${BASE}/api/v1/images/${imageId}/annotations/${annotId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Delete annotation failed: ${res.status}`);
}

// --- Processing ---

export async function triggerProcessing(taskId: number): Promise<{ status: string; queued_images: number }> {
  const res = await fetch(`${BASE}/api/v1/tasks/${taskId}/process`, { method: "POST" });
  if (!res.ok) throw new Error(`Trigger processing failed: ${res.status}`);
  return res.json();
}

export interface ImageProgress {
  id: number;
  label: string | null;
  status: string;
  error_message: string | null;
}

export interface ProgressData {
  status: string;
  total_images: number;
  completed_images: number;
  current_phase: string;
  images: ImageProgress[];
}

export async function getProgress(taskId: number): Promise<ProgressData> {
  const res = await fetch(`${BASE}/api/v1/tasks/${taskId}/progress`);
  if (!res.ok) throw new Error(`Get progress failed: ${res.status}`);
  return res.json();
}

export async function regenerateAnnotations(imageId: number): Promise<void> {
  const res = await fetch(`${BASE}/api/v1/images/${imageId}/regenerate`, { method: "POST" });
  if (!res.ok) throw new Error(`Regenerate failed: ${res.status}`);
}

export async function exportAnnotatedImage(imageId: number): Promise<{ annotated_image_path: string }> {
  const res = await fetch(`${BASE}/api/v1/images/${imageId}/export`, { method: "POST" });
  if (!res.ok) throw new Error(`Export failed: ${res.status}`);
  return res.json();
}

export async function renderExportImage(
  imageId: number,
  annotations: Omit<Annotation, "id" | "image_id" | "is_user_corrected">[],
  scaleFactor: number,
): Promise<Blob> {
  const res = await fetch(`${BASE}/api/v1/images/${imageId}/render-export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      annotations: annotations.map((a) => ({
        word_index: a.word_index,
        ocr_word: a.ocr_word,
        reference_word: a.reference_word,
        error_type: a.error_type,
        annotation_shape: a.annotation_shape,
        bbox_x1: a.bbox_x1,
        bbox_y1: a.bbox_y1,
        bbox_x2: a.bbox_x2,
        bbox_y2: a.bbox_y2,
        is_auto: a.is_auto,
        note: a.note,
        label_x: a.label_x,
        label_y: a.label_y,
        label_font_size: a.label_font_size,
      })),
      scale_factor: scaleFactor,
    }),
  });
  if (!res.ok) throw new Error(`Render export failed: ${res.status}`);
  return res.blob();
}

// --- Model Providers ---

export async function listProviders(): Promise<ModelProvider[]> {
  const res = await fetch(`${BASE}/api/v1/providers`);
  if (!res.ok) throw new Error(`List providers failed: ${res.status}`);
  return res.json();
}

export async function createProvider(data: {
  name: string;
  base_url: string;
  api_key: string;
  default_model: string;
  models?: string[];
  is_default?: boolean;
}): Promise<ModelProvider> {
  const res = await fetch(`${BASE}/api/v1/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Create provider failed: ${res.status}`);
  return res.json();
}

export async function updateProvider(
  id: number,
  data: {
    name?: string;
    base_url?: string;
    api_key?: string;
    default_model?: string;
    models?: string[];
    is_default?: boolean;
  },
): Promise<ModelProvider> {
  const res = await fetch(`${BASE}/api/v1/providers/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Update provider failed: ${res.status}`);
  return res.json();
}

export async function deleteProvider(id: number): Promise<void> {
  const res = await fetch(`${BASE}/api/v1/providers/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Delete provider failed: ${res.status}`);
}

export async function setDefaultProvider(id: number): Promise<ModelProvider> {
  const res = await fetch(`${BASE}/api/v1/providers/${id}/set-default`, { method: "POST" });
  if (!res.ok) throw new Error(`Set default provider failed: ${res.status}`);
  return res.json();
}

export async function testProviderConnection(data: {
  base_url: string;
  api_key: string;
  model: string;
}): Promise<{ success: boolean; message: string; latency_ms?: number }> {
  const res = await fetch(`${BASE}/api/v1/providers/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Test provider failed: ${res.status}`);
  return res.json();
}

export interface ModelTestResult {
  model: string;
  success: boolean;
  message: string;
  latency_ms?: number;
}

export async function testProviderModels(
  providerId: number,
  models: string[],
): Promise<ModelTestResult[]> {
  const res = await fetch(`${BASE}/api/v1/providers/${providerId}/test-models`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ models }),
  });
  if (!res.ok) throw new Error(`Test provider models failed: ${res.status}`);
  return res.json();
}

// --- Export ---

export async function exportTaskZip(taskId: number): Promise<void> {
  const res = await fetch(`${BASE}/api/v1/tasks/${taskId}/export-zip`);
  if (!res.ok) throw new Error("Export failed");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `annotated_task_${taskId}.zip`;
  a.click();
  URL.revokeObjectURL(url);
}
