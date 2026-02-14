"use client";

import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import type { Annotation } from "@/lib/api";
import { resolveOverlaps } from "@/lib/overlap";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ToolType = "select" | "ellipse" | "underline" | "caret";

interface LocalAnnotation extends Annotation {
  _localId: string; // Stable local ID for tracking
}

interface EditorState {
  annotations: LocalAnnotation[];
  past: LocalAnnotation[][];
  future: LocalAnnotation[][];
}

type ResizeHandle = "nw" | "ne" | "sw" | "se";

type EditorAction =
  | { type: "SET"; annotations: LocalAnnotation[] }
  | { type: "ADD"; annotation: LocalAnnotation }
  | { type: "UPDATE"; id: string; changes: Partial<LocalAnnotation> }
  | { type: "SNAPSHOT" }
  | { type: "UPDATE_SILENT"; id: string; changes: Partial<LocalAnnotation> }
  | { type: "DELETE"; id: string }
  | { type: "UNDO" }
  | { type: "REDO" };

interface AnnotationEditorProps {
  annotations: Annotation[];
  imageWidth: number;
  imageHeight: number;
  activeTool: ToolType;
  selectedId: string | null;
  /** Scale factor for annotation visual elements (stroke, font, padding). Default 1.0. */
  annotationScale?: number;
  onSelect: (id: string | null) => void;
  onChange: (annotations: Annotation[]) => void;
  onUndoRedoChange: (canUndo: boolean, canRedo: boolean) => void;
}

// ─── Reducer (undo/redo) ────────────────────────────────────────────────────

function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "SET":
      return { annotations: action.annotations, past: [], future: [] };

    case "ADD":
      return {
        past: [...state.past, state.annotations],
        annotations: [...state.annotations, action.annotation],
        future: [],
      };

    case "UPDATE":
      return {
        past: [...state.past, state.annotations],
        annotations: state.annotations.map((a) =>
          a._localId === action.id ? { ...a, ...action.changes } : a,
        ),
        future: [],
      };

    // Push current state to past (for drag/resize start)
    case "SNAPSHOT":
      return {
        ...state,
        past: [...state.past, state.annotations],
        future: [],
      };

    // Update without pushing to past (for drag/resize in-progress)
    case "UPDATE_SILENT":
      return {
        ...state,
        annotations: state.annotations.map((a) =>
          a._localId === action.id ? { ...a, ...action.changes } : a,
        ),
      };

    case "DELETE":
      return {
        past: [...state.past, state.annotations],
        annotations: state.annotations.filter((a) => a._localId !== action.id),
        future: [],
      };

    case "UNDO":
      if (state.past.length === 0) return state;
      return {
        past: state.past.slice(0, -1),
        annotations: state.past[state.past.length - 1],
        future: [state.annotations, ...state.future],
      };

    case "REDO":
      if (state.future.length === 0) return state;
      return {
        past: [...state.past, state.annotations],
        annotations: state.future[0],
        future: state.future.slice(1),
      };

    default:
      return state;
  }
}

// ─── Helper ─────────────────────────────────────────────────────────────────

let _idCounter = 0;
function nextLocalId(): string {
  return `local_${++_idCounter}_${Date.now()}`;
}

function toLocal(a: Annotation): LocalAnnotation {
  return { ...a, _localId: `server_${a.id}` };
}

function fromLocal(a: LocalAnnotation): Annotation {
  const { _localId, ...rest } = a;
  return rest;
}

// ─── Resize handle hit-testing ──────────────────────────────────────────────

const HANDLE_VISUAL_SIZE = 8;
const HANDLE_HIT_SIZE = 12; // Larger than visual for easier clicking

function hitTestResizeHandle(
  x: number,
  y: number,
  a: LocalAnnotation,
): ResizeHandle | null {
  const halfHit = HANDLE_HIT_SIZE / 2;
  const corners: { handle: ResizeHandle; cx: number; cy: number }[] = [
    { handle: "nw", cx: a.bbox_x1, cy: a.bbox_y1 },
    { handle: "ne", cx: a.bbox_x2, cy: a.bbox_y1 },
    { handle: "sw", cx: a.bbox_x1, cy: a.bbox_y2 },
    { handle: "se", cx: a.bbox_x2, cy: a.bbox_y2 },
  ];
  for (const { handle, cx, cy } of corners) {
    if (
      x >= cx - halfHit &&
      x <= cx + halfHit &&
      y >= cy - halfHit &&
      y <= cy + halfHit
    ) {
      return handle;
    }
  }
  return null;
}

const HANDLE_CURSORS: Record<ResizeHandle, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
};

// ─── Label hit-testing ───────────────────────────────────────────────────────

/**
 * Estimate the bounding rectangle of a label's text and check if (x,y) is inside.
 *
 * @param scale  annotationScale factor.
 * @param labelYOffset  overlap-resolved y offset.
 * @returns The matching annotation, or null.
 */
function hitTestLabel(
  x: number,
  y: number,
  a: LocalAnnotation,
  scale: number,
  labelYOffset: number,
): boolean {
  if (!a.reference_word) return false;

  const bboxHeight = a.bbox_y2 - a.bbox_y1;
  const customFs = a.label_font_size;
  const fontSize = customFs != null && customFs > 0
    ? customFs
    : Math.max(Math.min(Math.round(bboxHeight * 0.5 * scale), 48 * scale), 10 * scale);
  const textWidth = a.reference_word.length * fontSize * 0.6;
  const textHeight = fontSize;

  // Compute label center position
  let labelCx: number;
  let labelCy: number;

  if (a.label_x != null && a.label_y != null) {
    labelCx = a.label_x;
    labelCy = a.label_y;
  } else {
    const cx = (a.bbox_x1 + a.bbox_x2) / 2;
    labelCx = cx;
    if (a.annotation_shape === "caret") {
      labelCy = a.bbox_y1 - 6 * scale + labelYOffset - textHeight / 2;
    } else {
      labelCy = a.bbox_y1 - 8 * scale + labelYOffset - textHeight / 2;
    }
  }

  const rectX = labelCx - textWidth / 2;
  const rectY = labelCy - textHeight / 2;

  return (
    x >= rectX &&
    x <= rectX + textWidth &&
    y >= rectY &&
    y <= rectY + textHeight
  );
}

// ─── Colors ─────────────────────────────────────────────────────────────────

const TYPE_COLORS: Record<string, { stroke: string; fill: string }> = {
  wrong: { stroke: "#dc2626", fill: "rgba(220,38,38,0.08)" },
  extra: { stroke: "#f97316", fill: "rgba(249,115,22,0.08)" },
  missing: { stroke: "#2563eb", fill: "rgba(37,99,235,0.08)" },
  correct: { stroke: "#16a34a", fill: "rgba(22,163,74,0.05)" },
};

// ─── Min resize constraints ─────────────────────────────────────────────────

const MIN_WIDTH = 20;
const MIN_HEIGHT = 15;

// ─── Font size constraints ──────────────────────────────────────────────────

const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 80;

// ─── Component ──────────────────────────────────────────────────────────────

export default function AnnotationEditor({
  annotations: serverAnnotations,
  imageWidth,
  imageHeight,
  activeTool,
  selectedId,
  annotationScale = 1.0,
  onSelect,
  onChange,
  onUndoRedoChange,
}: AnnotationEditorProps) {
  const [state, dispatch] = useReducer(editorReducer, {
    annotations: serverAnnotations.map(toLocal),
    past: [],
    future: [],
  });

  // Drawing state
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [drawCurrent, setDrawCurrent] = useState<{ x: number; y: number } | null>(null);

  // Drag state (shape body)
  const [dragging, setDragging] = useState<{
    id: string;
    startX: number;
    startY: number;
    origBbox: { x1: number; y1: number; x2: number; y2: number };
  } | null>(null);

  // Resize state
  const [resizing, setResizing] = useState<{
    id: string;
    handle: ResizeHandle;
    origBbox: { x1: number; y1: number; x2: number; y2: number };
  } | null>(null);

  // Label drag state
  const [labelDragging, setLabelDragging] = useState<{
    id: string;
    startX: number;
    startY: number;
    origLabelX: number;
    origLabelY: number;
  } | null>(null);

  // Compute label offsets to prevent overlap (Phase 2)
  const labelOffsets = useMemo(
    () => resolveOverlaps(state.annotations),
    [state.annotations],
  );

  // Sync undo/redo availability
  useEffect(() => {
    onUndoRedoChange(state.past.length > 0, state.future.length > 0);
  }, [state.past.length, state.future.length, onUndoRedoChange]);

  // Sync changes to parent
  useEffect(() => {
    onChange(state.annotations.map(fromLocal));
  }, [state.annotations]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: "UNDO" });
      } else if ((e.ctrlKey || e.metaKey) && e.key === "z" && e.shiftKey) {
        e.preventDefault();
        dispatch({ type: "REDO" });
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedId) {
          dispatch({ type: "DELETE", id: selectedId });
          onSelect(null);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedId, onSelect]);

  // ─── Public methods exposed via parent callbacks ───

  const undo = useCallback(() => dispatch({ type: "UNDO" }), []);
  const redo = useCallback(() => dispatch({ type: "REDO" }), []);
  const deleteSelected = useCallback(() => {
    if (selectedId) {
      dispatch({ type: "DELETE", id: selectedId });
      onSelect(null);
    }
  }, [selectedId, onSelect]);

  const changeType = useCallback(
    (errorType: string) => {
      if (selectedId) {
        dispatch({
          type: "UPDATE",
          id: selectedId,
          changes: { error_type: errorType, is_user_corrected: true },
        });
      }
    },
    [selectedId],
  );

  const changeFontSize = useCallback(
    (delta: number) => {
      if (!selectedId) return;
      const ann = state.annotations.find((a) => a._localId === selectedId);
      if (!ann) return;

      const bboxHeight = ann.bbox_y2 - ann.bbox_y1;
      const currentSize =
        ann.label_font_size != null && ann.label_font_size > 0
          ? ann.label_font_size
          : Math.max(Math.min(Math.round(bboxHeight * 0.5 * annotationScale), 48 * annotationScale), 10 * annotationScale);
      const newSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, currentSize + delta));

      dispatch({
        type: "UPDATE",
        id: selectedId,
        changes: { label_font_size: newSize, is_user_corrected: true },
      });
    },
    [selectedId, state.annotations, annotationScale],
  );

  // Ctrl+Wheel handler for font size adjustment
  const handleWheel = useCallback(
    (deltaY: number, ctrlKey: boolean): boolean => {
      if (!ctrlKey || !selectedId) return false;
      const delta = deltaY < 0 ? 2 : -2;
      changeFontSize(delta);
      return true; // consumed
    },
    [selectedId, changeFontSize],
  );

  // Expose methods to parent via ref-like pattern
  useEffect(() => {
    (window as any).__annotationEditor = { undo, redo, deleteSelected, changeType, changeFontSize };
    return () => {
      delete (window as any).__annotationEditor;
    };
  }, [undo, redo, deleteSelected, changeType, changeFontSize]);

  // ─── Helper: compute default label position for an annotation ───

  const getDefaultLabelPos = useCallback(
    (a: LocalAnnotation): { x: number; y: number } => {
      const s = annotationScale;
      const cx = (a.bbox_x1 + a.bbox_x2) / 2;
      const bboxHeight = a.bbox_y2 - a.bbox_y1;
      const customFs = a.label_font_size;
      const fontSize = customFs != null && customFs > 0
        ? customFs
        : Math.max(Math.min(Math.round(bboxHeight * 0.5 * s), 48 * s), 10 * s);
      const labelYOffset = labelOffsets.get(a._localId) ?? 0;

      if (a.annotation_shape === "caret") {
        return { x: cx, y: a.bbox_y1 - 6 * s + labelYOffset - fontSize / 2 };
      }
      return { x: cx, y: a.bbox_y1 - 8 * s + labelYOffset - fontSize / 2 };
    },
    [annotationScale, labelOffsets],
  );

  // ─── Mouse Handlers ───

  const handleMouseDown = useCallback(
    (x: number, y: number, e: React.MouseEvent): boolean => {
      if (activeTool === "select") {
        // Priority 1: Check resize handles on the currently selected annotation
        if (selectedId) {
          const selected = state.annotations.find((a) => a._localId === selectedId);
          if (selected) {
            const handle = hitTestResizeHandle(x, y, selected);
            if (handle) {
              dispatch({ type: "SNAPSHOT" });
              setResizing({
                id: selected._localId,
                handle,
                origBbox: {
                  x1: selected.bbox_x1,
                  y1: selected.bbox_y1,
                  x2: selected.bbox_x2,
                  y2: selected.bbox_y2,
                },
              });
              return true;
            }
          }
        }

        // Priority 2: Check label text hit → start label drag
        for (const a of state.annotations) {
          if (!a.reference_word) continue;
          const offset = labelOffsets.get(a._localId) ?? 0;
          if (hitTestLabel(x, y, a, annotationScale, offset)) {
            onSelect(a._localId);
            dispatch({ type: "SNAPSHOT" });
            // Resolve current effective label position
            const effectiveX = a.label_x ?? getDefaultLabelPos(a).x;
            const effectiveY = a.label_y ?? getDefaultLabelPos(a).y;
            setLabelDragging({
              id: a._localId,
              startX: x,
              startY: y,
              origLabelX: effectiveX,
              origLabelY: effectiveY,
            });
            return true;
          }
        }

        // Priority 3: Check if clicked on an annotation shape body (hit → drag)
        const hit = state.annotations.find(
          (a) => x >= a.bbox_x1 && x <= a.bbox_x2 && y >= a.bbox_y1 && y <= a.bbox_y2,
        );
        if (hit) {
          onSelect(hit._localId);
          dispatch({ type: "SNAPSHOT" });
          setDragging({
            id: hit._localId,
            startX: x,
            startY: y,
            origBbox: {
              x1: hit.bbox_x1,
              y1: hit.bbox_y1,
              x2: hit.bbox_x2,
              y2: hit.bbox_y2,
            },
          });
          return true;
        } else {
          onSelect(null);
          return false; // Not consumed: let ImageViewer pan
        }
      } else {
        // Start drawing
        setDrawStart({ x, y });
        setDrawCurrent({ x, y });
        return true; // Consumed: drawing mode
      }
    },
    [activeTool, state.annotations, selectedId, onSelect, annotationScale, labelOffsets, getDefaultLabelPos],
  );

  const handleMouseMove = useCallback(
    (x: number, y: number) => {
      if (resizing) {
        const { handle, origBbox } = resizing;
        let { x1, y1, x2, y2 } = origBbox;

        // Update the corner being dragged, keeping opposite corner fixed
        switch (handle) {
          case "nw":
            x1 = Math.min(x, x2 - MIN_WIDTH);
            y1 = Math.min(y, y2 - MIN_HEIGHT);
            break;
          case "ne":
            x2 = Math.max(x, x1 + MIN_WIDTH);
            y1 = Math.min(y, y2 - MIN_HEIGHT);
            break;
          case "sw":
            x1 = Math.min(x, x2 - MIN_WIDTH);
            y2 = Math.max(y, y1 + MIN_HEIGHT);
            break;
          case "se":
            x2 = Math.max(x, x1 + MIN_WIDTH);
            y2 = Math.max(y, y1 + MIN_HEIGHT);
            break;
        }

        dispatch({
          type: "UPDATE_SILENT",
          id: resizing.id,
          changes: {
            bbox_x1: x1,
            bbox_y1: y1,
            bbox_x2: x2,
            bbox_y2: y2,
            is_user_corrected: true,
          },
        });
      } else if (labelDragging) {
        const dx = x - labelDragging.startX;
        const dy = y - labelDragging.startY;
        dispatch({
          type: "UPDATE_SILENT",
          id: labelDragging.id,
          changes: {
            label_x: labelDragging.origLabelX + dx,
            label_y: labelDragging.origLabelY + dy,
            is_user_corrected: true,
          },
        });
      } else if (dragging) {
        const dx = x - dragging.startX;
        const dy = y - dragging.startY;
        dispatch({
          type: "UPDATE_SILENT",
          id: dragging.id,
          changes: {
            bbox_x1: dragging.origBbox.x1 + dx,
            bbox_y1: dragging.origBbox.y1 + dy,
            bbox_x2: dragging.origBbox.x2 + dx,
            bbox_y2: dragging.origBbox.y2 + dy,
            is_user_corrected: true,
          },
        });
      } else if (drawStart) {
        setDrawCurrent({ x, y });
      }
    },
    [resizing, labelDragging, dragging, drawStart],
  );

  const handleMouseUp = useCallback(
    (x: number, y: number) => {
      if (resizing) {
        setResizing(null);
        return;
      }

      if (labelDragging) {
        setLabelDragging(null);
        return;
      }

      if (dragging) {
        setDragging(null);
        return;
      }

      if (drawStart && drawCurrent) {
        const x1 = Math.min(drawStart.x, x);
        const y1 = Math.min(drawStart.y, y);
        const x2 = Math.max(drawStart.x, x);
        const y2 = Math.max(drawStart.y, y);

        // Only create if drag distance is meaningful
        if (x2 - x1 > 5 && y2 - y1 > 5) {
          const shapeMap: Record<string, string> = {
            ellipse: "ellipse",
            underline: "underline",
            caret: "caret",
          };
          const errorMap: Record<string, string> = {
            ellipse: "wrong",
            underline: "extra",
            caret: "missing",
          };

          const newAnnotation: LocalAnnotation = {
            _localId: nextLocalId(),
            id: 0, // Not saved yet
            image_id: 0,
            word_index: null,
            ocr_word: null,
            reference_word: null,
            error_type: errorMap[activeTool] ?? "wrong",
            annotation_shape: shapeMap[activeTool] ?? "ellipse",
            bbox_x1: x1,
            bbox_y1: y1,
            bbox_x2: x2,
            bbox_y2: y2,
            is_auto: false,
            is_user_corrected: false,
            note: null,
            label_x: null,
            label_y: null,
            label_font_size: null,
          };
          dispatch({ type: "ADD", annotation: newAnnotation });
        }
      }

      setDrawStart(null);
      setDrawCurrent(null);
    },
    [resizing, labelDragging, dragging, drawStart, drawCurrent, activeTool],
  );

  // ─── Render SVG ───

  const renderAnnotation = (a: LocalAnnotation) => {
    const colors = TYPE_COLORS[a.error_type] ?? TYPE_COLORS.wrong;
    const isSelected = a._localId === selectedId;
    const s = annotationScale; // shorthand
    const strokeWidth = (isSelected ? 3 : 2) * s;
    const bboxHeight = a.bbox_y2 - a.bbox_y1;
    // Dynamic font size: custom or auto-computed
    const customFs = a.label_font_size;
    const fontSize = customFs != null && customFs > 0
      ? customFs
      : Math.max(Math.min(Math.round(bboxHeight * 0.5 * s), 48 * s), 10 * s);
    const labelYOffset = labelOffsets.get(a._localId) ?? 0;
    const handleSize = HANDLE_VISUAL_SIZE * s;
    const halfHandle = handleSize / 2;

    // Render resize handles (shared across shapes)
    const resizeHandles = isSelected ? (
      <>
        <rect
          x={a.bbox_x1 - halfHandle}
          y={a.bbox_y1 - halfHandle}
          width={handleSize}
          height={handleSize}
          fill={colors.stroke}
          style={{ cursor: HANDLE_CURSORS.nw }}
        />
        <rect
          x={a.bbox_x2 - halfHandle}
          y={a.bbox_y1 - halfHandle}
          width={handleSize}
          height={handleSize}
          fill={colors.stroke}
          style={{ cursor: HANDLE_CURSORS.ne }}
        />
        <rect
          x={a.bbox_x1 - halfHandle}
          y={a.bbox_y2 - halfHandle}
          width={handleSize}
          height={handleSize}
          fill={colors.stroke}
          style={{ cursor: HANDLE_CURSORS.sw }}
        />
        <rect
          x={a.bbox_x2 - halfHandle}
          y={a.bbox_y2 - halfHandle}
          width={handleSize}
          height={handleSize}
          fill={colors.stroke}
          style={{ cursor: HANDLE_CURSORS.se }}
        />
      </>
    ) : null;

    // Compute label text position
    const renderLabel = (defaultX: number, defaultY: number) => {
      if (!a.reference_word) return null;
      const lx = a.label_x ?? defaultX;
      const ly = a.label_y ?? (defaultY + labelYOffset);
      return (
        <text
          x={lx}
          y={ly}
          textAnchor="middle"
          fill={colors.stroke}
          fontSize={fontSize}
          fontWeight="bold"
          fontFamily="Liberation Sans, Arial, Helvetica, sans-serif"
          style={{ cursor: "move", pointerEvents: "all" }}
        >
          {a.reference_word}
        </text>
      );
    };

    if (a.annotation_shape === "ellipse") {
      const cx = (a.bbox_x1 + a.bbox_x2) / 2;
      const cy = (a.bbox_y1 + a.bbox_y2) / 2;
      const rx = (a.bbox_x2 - a.bbox_x1) / 2 + 4 * s;
      const ry = (a.bbox_y2 - a.bbox_y1) / 2 + 3 * s;

      return (
        <g key={a._localId}>
          <ellipse
            cx={cx}
            cy={cy}
            rx={rx}
            ry={ry}
            fill={colors.fill}
            stroke={colors.stroke}
            strokeWidth={strokeWidth}
            style={{ pointerEvents: "all", cursor: "pointer" }}
          />
          {renderLabel(cx, a.bbox_y1 - 8 * s)}
          {resizeHandles}
        </g>
      );
    }

    if (a.annotation_shape === "underline") {
      const cy = a.bbox_y2 + 2 * s;
      return (
        <g key={a._localId}>
          <line
            x1={a.bbox_x1}
            y1={cy}
            x2={a.bbox_x2}
            y2={cy}
            stroke={colors.stroke}
            strokeWidth={strokeWidth + 1 * s}
            style={{ pointerEvents: "all", cursor: "pointer" }}
          />
          {/* Strikethrough */}
          <line
            x1={a.bbox_x1}
            y1={(a.bbox_y1 + a.bbox_y2) / 2}
            x2={a.bbox_x2}
            y2={(a.bbox_y1 + a.bbox_y2) / 2}
            stroke={colors.stroke}
            strokeWidth={strokeWidth}
            opacity={0.5}
          />
          {resizeHandles}
        </g>
      );
    }

    if (a.annotation_shape === "caret") {
      const cx = (a.bbox_x1 + a.bbox_x2) / 2;
      const bottom = a.bbox_y2;
      const top = a.bbox_y1;
      return (
        <g key={a._localId}>
          <polyline
            points={`${cx - 8 * s},${bottom} ${cx},${top} ${cx + 8 * s},${bottom}`}
            fill="none"
            stroke={colors.stroke}
            strokeWidth={strokeWidth}
            style={{ pointerEvents: "all", cursor: "pointer" }}
          />
          {renderLabel(cx, top - 6 * s)}
          {resizeHandles}
        </g>
      );
    }

    return null;
  };

  // Drawing preview
  const renderDrawPreview = () => {
    if (!drawStart || !drawCurrent) return null;
    const x1 = Math.min(drawStart.x, drawCurrent.x);
    const y1 = Math.min(drawStart.y, drawCurrent.y);
    const x2 = Math.max(drawStart.x, drawCurrent.x);
    const y2 = Math.max(drawStart.y, drawCurrent.y);

    if (activeTool === "ellipse") {
      return (
        <ellipse
          cx={(x1 + x2) / 2}
          cy={(y1 + y2) / 2}
          rx={(x2 - x1) / 2}
          ry={(y2 - y1) / 2}
          fill="rgba(220,38,38,0.1)"
          stroke="#dc2626"
          strokeWidth={2}
          strokeDasharray="4 2"
        />
      );
    }

    return (
      <rect
        x={x1}
        y={y1}
        width={x2 - x1}
        height={y2 - y1}
        fill="rgba(37,99,235,0.1)"
        stroke="#2563eb"
        strokeWidth={1}
        strokeDasharray="4 2"
      />
    );
  };

  return {
    svgOverlay: (
      <g>
        {state.annotations.map(renderAnnotation)}
        {renderDrawPreview()}
      </g>
    ),
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleWheel,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    undo,
    redo,
    deleteSelected,
    changeType,
    changeFontSize,
  };
}
