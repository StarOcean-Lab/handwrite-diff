import { describe, it, expect } from "vitest";
import {
  computeDisplayDiffOps,
  rebuildCorrectedEntries,
  type RawDiffOp,
  type CorrectionEntry,
  type AnnotationForRebuild,
} from "../computeDisplayDiffOps";

// ── 构造辅助函数 ──────────────────────────────────────────────────────────────

function op(
  diff_type: string,
  ocr_word: string | null,
  reference_word: string | null,
  ocr_index: number | null = null,
  ref_index: number | null = null,
): RawDiffOp {
  return { diff_type, ocr_word, reference_word, ocr_index, ref_index };
}

function mergeLeader(newWord: string, mergedOcrWords: string): CorrectionEntry {
  return { type: "merge", newWord, mergedOcrWords, hidden: false };
}

function mergeHidden(): CorrectionEntry {
  return { type: "merge", newWord: "", mergedOcrWords: "", hidden: true };
}

function modifyEntry(newWord: string): CorrectionEntry {
  return { type: "modify", newWord, mergedOcrWords: "", hidden: false };
}

// ── 测试套件 ──────────────────────────────────────────────────────────────────

describe("computeDisplayDiffOps", () => {
  // ── 基础行为 ────────────────────────────────────────────────────────────────

  it("无任何修正时原样返回原始 ops", () => {
    const raw: RawDiffOp[] = [
      op("correct", "Phil", "Phil"),
      op("wrong", "great", "grapefruit"),
      op("extra", "foods", null),
    ];
    const result = computeDisplayDiffOps(raw, new Set(), new Map());
    expect(result).toBe(raw); // 应该是同一引用（fast path）
  });

  it("ignore 操作把 diff_type 改为 correct", () => {
    const raw: RawDiffOp[] = [
      op("wrong", "great", "grapefruit", 0, 0),
      op("extra", "foods", null, 1, null),
    ];
    const result = computeDisplayDiffOps(raw, new Set([0, 1]), new Map());
    expect(result[0].diff_type).toBe("correct");
    expect(result[1].diff_type).toBe("correct");
  });

  // ── modify ──────────────────────────────────────────────────────────────────

  it("modify：OCR 词与新词相同 → diff_type 变 correct", () => {
    const raw: RawDiffOp[] = [op("wrong", "Grapefruit", "grapefruit", 0, 0)];
    const entries = new Map([[0, modifyEntry("Grapefruit")]]);
    const result = computeDisplayDiffOps(raw, new Set(), entries);
    expect(result[0].diff_type).toBe("correct");
    expect(result[0].reference_word).toBe("Grapefruit");
  });

  it("modify：OCR 词与新词不同 → 保留原 diff_type，更新 reference_word", () => {
    const raw: RawDiffOp[] = [op("wrong", "great", "grapefruit", 0, 0)];
    const entries = new Map([[0, modifyEntry("grape")]]);
    const result = computeDisplayDiffOps(raw, new Set(), entries);
    expect(result[0].diff_type).toBe("wrong");
    expect(result[0].reference_word).toBe("grape");
  });

  // ── merge leader ────────────────────────────────────────────────────────────

  it("merge leader 展示合并后的 OCR 词和用户指定的参考词", () => {
    const raw: RawDiffOp[] = [
      op("wrong", "great", "grapefruit", 0, 0),
      op("wrong", "foods", "I've", 1, 1),
    ];
    const entries = new Map<number, CorrectionEntry>([
      [0, mergeLeader("grapefruit", "great foods")],
      [1, mergeHidden()],
    ]);
    const result = computeDisplayDiffOps(raw, new Set(), entries);
    expect(result[0].ocr_word).toBe("great foods");
    expect(result[0].reference_word).toBe("grapefruit");
    expect(result[0].diff_type).toBe("wrong");
  });

  // ── 核心 Bug 修复：孤儿参考词 + EXTRA 重配对 ─────────────────────────────────

  it("【bug 修复】hidden 成员的孤儿 ref 与紧随其后的 EXTRA 重配对为 WRONG", () => {
    // 场景：OCR "great foods I would got"，参考 "grapefruit I've got"
    // difflib 对齐：great→grapefruit, foods→I've(wrong), I→EXTRA, would→EXTRA, got→got
    // 用户合并 great+foods → grapefruit
    // 期望：foods 的孤儿 ref "I've" 与 EXTRA "I" 配对为 × I→I've
    const raw: RawDiffOp[] = [
      op("correct", "with", "with", 0, 0),
      op("wrong", "great", "grapefruit", 1, 1),   // i=1: merge leader
      op("wrong", "foods", "I've", 2, 2),          // i=2: hidden, orphaned ref = "I've"
      op("extra", "I", null, 3, null),             // i=3: 应被提升为 × I→I've
      op("extra", "would", null, 4, null),         // i=4: 无配对，保持 EXTRA
      op("correct", "got", "got", 5, 3),           // i=5: 对齐锚点
    ];
    const entries = new Map<number, CorrectionEntry>([
      [1, mergeLeader("grapefruit", "great foods")],
      [2, mergeHidden()],
    ]);

    const result = computeDisplayDiffOps(raw, new Set(), entries);

    // i=1: merge leader 正常
    expect(result[1].ocr_word).toBe("great foods");
    expect(result[1].reference_word).toBe("grapefruit");

    // i=2: hidden 成员 → 孤儿 ref 已被配对，静默隐藏
    expect(result[2].diff_type).toBe("corrected_hidden");

    // i=3: EXTRA "I" 被提升为 WRONG，ref_word = "I've"
    expect(result[3].diff_type).toBe("wrong");
    expect(result[3].reference_word).toBe("I've");
    expect(result[3].ocr_word).toBe("I");

    // i=4: "would" 无配对，保持 EXTRA
    expect(result[4].diff_type).toBe("extra");

    // i=5: CORRECT 不受影响
    expect(result[5].diff_type).toBe("correct");
  });

  it("孤儿 ref 后紧接 CORRECT 锚点（无 EXTRA）→ 降级回 MISSING（fallback）", () => {
    // 如果合并区域和下一个 CORRECT 之间没有 EXTRA，孤儿 ref 仍应显示为 MISSING
    const raw: RawDiffOp[] = [
      op("wrong", "great", "grapefruit", 0, 0),  // i=0: merge leader
      op("wrong", "foods", "I've", 1, 1),         // i=1: hidden, orphaned ref
      op("correct", "got", "got", 2, 2),          // i=2: 对齐锚点，阻止向前搜索
    ];
    const entries = new Map<number, CorrectionEntry>([
      [0, mergeLeader("grapefruit", "great foods")],
      [1, mergeHidden()],
    ]);

    const result = computeDisplayDiffOps(raw, new Set(), entries);

    // 孤儿 ref 找不到 EXTRA → 回退显示为 MISSING
    expect(result[1].diff_type).toBe("missing");
    expect(result[1].ocr_word).toBeNull();
    expect(result[1].reference_word).toBe("I've");
  });

  it("多个孤儿 ref → 各自与后续 EXTRA 顺序配对", () => {
    // 合并两组：A+B → X，C+D → Y
    // 孤儿：B.ref="ref_b"，D.ref="ref_d"
    // EXTRA：E1, E2
    // 期望：E1→ref_b，E2→ref_d
    const raw: RawDiffOp[] = [
      op("wrong", "a", "X", 0, 0),   // i=0: merge leader 1
      op("wrong", "b", "ref_b", 1, 1), // i=1: hidden, orphaned "ref_b"
      op("wrong", "c", "Y", 2, 2),   // i=2: merge leader 2
      op("wrong", "d", "ref_d", 3, 3), // i=3: hidden, orphaned "ref_d"
      op("extra", "e1", null, 4, null), // i=4: → 配对 "ref_b"
      op("extra", "e2", null, 5, null), // i=5: → 配对 "ref_d"
    ];
    const entries = new Map<number, CorrectionEntry>([
      [0, mergeLeader("X", "a b")],
      [1, mergeHidden()],
      [2, mergeLeader("Y", "c d")],
      [3, mergeHidden()],
    ]);

    const result = computeDisplayDiffOps(raw, new Set(), entries);

    expect(result[1].diff_type).toBe("corrected_hidden");
    expect(result[3].diff_type).toBe("corrected_hidden");
    expect(result[4].diff_type).toBe("wrong");
    expect(result[4].reference_word).toBe("ref_b");
    expect(result[5].diff_type).toBe("wrong");
    expect(result[5].reference_word).toBe("ref_d");
  });

  it("hidden 成员 ref === ocr_word → 静默隐藏（不产生孤儿）", () => {
    // 当 OCR 词和 ref 词相同时，merge hidden 不应产生孤儿 ref，直接隐藏
    const raw: RawDiffOp[] = [
      op("wrong", "great", "grapefruit", 0, 0),
      op("correct", "got", "got", 1, 1),  // ref === ocr，hidden 后不产生孤儿
      op("extra", "E", null, 2, null),
    ];
    const entries = new Map<number, CorrectionEntry>([
      [0, mergeLeader("grapefruit", "great got")],
      [1, mergeHidden()],
    ]);

    const result = computeDisplayDiffOps(raw, new Set(), entries);

    // i=1: hidden 且 ref===ocr → 静默隐藏，不消耗 EXTRA
    expect(result[1].diff_type).toBe("corrected_hidden");
    // i=2: EXTRA 不受影响，因为没有孤儿 ref 需要它
    expect(result[2].diff_type).toBe("extra");
  });

  it("孤儿 ref 后方是 WRONG 而非 EXTRA → 跨过 WRONG，继续寻找 EXTRA", () => {
    // 孤儿 ref 后方：先遇到 WRONG，再遇到 EXTRA
    // WRONG 不是锚点，不应阻止搜索
    const raw: RawDiffOp[] = [
      op("wrong", "great", "grapefruit", 0, 0),  // i=0: merge leader
      op("wrong", "foods", "I've", 1, 1),         // i=1: hidden, orphaned "I've"
      op("wrong", "other", "thing", 2, 2),        // i=2: 普通 WRONG，不应阻止
      op("extra", "I", null, 3, null),            // i=3: → 应配对 "I've"
    ];
    const entries = new Map<number, CorrectionEntry>([
      [0, mergeLeader("grapefruit", "great foods")],
      [1, mergeHidden()],
    ]);

    const result = computeDisplayDiffOps(raw, new Set(), entries);

    expect(result[1].diff_type).toBe("corrected_hidden");
    expect(result[3].diff_type).toBe("wrong");
    expect(result[3].reference_word).toBe("I've");
  });

  it("ignore 与 merge 共存：ignore 的词不会被用于配对", () => {
    const raw: RawDiffOp[] = [
      op("wrong", "great", "grapefruit", 0, 0),  // i=0: merge leader
      op("wrong", "foods", "I've", 1, 1),         // i=1: hidden, orphaned "I've"
      op("extra", "I", null, 2, null),            // i=2: 被 ignore，不可用于配对
      op("extra", "would", null, 3, null),        // i=3: → 应配对 "I've"
    ];
    const entries = new Map<number, CorrectionEntry>([
      [0, mergeLeader("grapefruit", "great foods")],
      [1, mergeHidden()],
    ]);

    const result = computeDisplayDiffOps(raw, new Set([2]), entries);

    // i=2 被 ignore 跳过，i=3 配对 "I've"
    expect(result[2].diff_type).toBe("correct"); // ignore → correct
    expect(result[3].diff_type).toBe("wrong");
    expect(result[3].reference_word).toBe("I've");
  });

  it("【重新生成后】hidden 成员变成 correct 类型（后端 _apply_user_corrections 覆盖）仍能正确重配对", () => {
    // 场景：用户合并 great+foods → grapefruit 后点击"重新生成标注"
    // 后端 _apply_user_corrections 会把 hidden 成员从 WRONG 改为 CORRECT
    // 与 bug 修复核心测试的唯一区别：hidden 成员 diff_type 从 "wrong" 变成了 "correct"
    const raw: RawDiffOp[] = [
      op("correct", "with", "with", 0, 0),
      op("wrong",   "great foods", "grapefruit", 1, 1),  // i=1: merge leader（已被后端合并）
      op("correct", "foods",       "I've",        2, 2),  // i=2: hidden，后端改为 CORRECT
      op("extra",   "I",           null,           3, null), // i=3: 应被提升为 × I→I've
      op("extra",   "would",       null,           4, null), // i=4: 无配对
      op("correct", "got",         "got",          5, 3),
    ];
    const entries = new Map<number, CorrectionEntry>([
      [1, mergeLeader("grapefruit", "great foods")],
      [2, mergeHidden()],
    ]);

    const result = computeDisplayDiffOps(raw, new Set(), entries);

    // i=1: merge leader 展示正确
    expect(result[1].ocr_word).toBe("great foods");
    expect(result[1].reference_word).toBe("grapefruit");
    expect(result[1].diff_type).toBe("wrong");

    // i=2: hidden 成员即使 diff_type="correct" 也应静默隐藏（孤儿 ref 配对成功）
    expect(result[2].diff_type).toBe("corrected_hidden");

    // i=3: EXTRA "I" 被提升为 WRONG × I→I've
    expect(result[3].diff_type).toBe("wrong");
    expect(result[3].ocr_word).toBe("I");
    expect(result[3].reference_word).toBe("I've");

    // i=4: "would" 无配对，保持 EXTRA
    expect(result[4].diff_type).toBe("extra");

    // i=5: CORRECT 不受影响
    expect(result[5].diff_type).toBe("correct");
  });

  it("【重新生成后】hidden 成员为 correct + 其后紧跟 correct 锚点，无 EXTRA 可配 → 降级为 MISSING", () => {
    // regenerate 后，hidden 成员 diff_type="correct"，且后方没有 EXTRA（被 CORRECT 锚点阻断）
    const raw: RawDiffOp[] = [
      op("wrong",   "great foods", "grapefruit", 0, 0),  // leader
      op("correct", "foods",       "I've",        1, 1),  // hidden（post-regeneration 类型）
      op("correct", "got",         "got",          2, 2),  // 锚点，阻断搜索
      op("extra",   "I",           null,           3, null), // EXTRA，但已被锚点阻断
    ];
    const entries = new Map<number, CorrectionEntry>([
      [0, mergeLeader("grapefruit", "great foods")],
      [1, mergeHidden()],
    ]);

    const result = computeDisplayDiffOps(raw, new Set(), entries);

    // 没有可配对的 EXTRA → 孤儿 ref 降级为 MISSING
    expect(result[1].diff_type).toBe("missing");
    expect(result[1].reference_word).toBe("I've");
    expect(result[1].ocr_word).toBeNull();

    // i=3: EXTRA 未被消耗（被锚点隔断），保持 EXTRA
    expect(result[3].diff_type).toBe("extra");
  });

  it("完整真实场景：grapefruit → great foods 合并修正", () => {
    // 对应用户报告的原始 bug：
    // 参考: Phil I'm going to start this episode with grapefruit I've got some here
    // OCR:  Phil I'm going to start this episode with great foods I would got some hear
    // difflib 对齐（片段）:
    //   great→grapefruit(WRONG), foods→I've(WRONG), I→EXTRA, would→EXTRA, got→got(CORRECT)
    const raw: RawDiffOp[] = [
      op("correct", "Phil", "Phil", 0, 0),
      op("correct", "I'm", "I'm", 1, 1),
      op("correct", "with", "with", 2, 2),
      op("wrong", "great", "grapefruit", 3, 3),   // i=3: merge leader
      op("wrong", "foods", "I've", 4, 4),          // i=4: hidden → orphaned "I've"
      op("extra", "I", null, 5, null),             // i=5: → WRONG × I→I've
      op("extra", "would", null, 6, null),         // i=6: 无配对，保持 EXTRA
      op("correct", "got", "got", 7, 5),           // i=7: 对齐锚点
      op("correct", "some", "some", 8, 6),
      op("wrong", "hear", "here", 9, 7),
    ];
    const entries = new Map<number, CorrectionEntry>([
      [3, mergeLeader("grapefruit", "great foods")],
      [4, mergeHidden()],
    ]);

    const result = computeDisplayDiffOps(raw, new Set(), entries);

    // 前缀 CORRECT 不变
    expect(result[0].diff_type).toBe("correct");
    expect(result[1].diff_type).toBe("correct");
    expect(result[2].diff_type).toBe("correct");

    // merge leader
    expect(result[3].ocr_word).toBe("great foods");
    expect(result[3].reference_word).toBe("grapefruit");
    expect(result[3].diff_type).toBe("wrong");

    // hidden 成员静默隐藏（孤儿 ref 已配对）
    expect(result[4].diff_type).toBe("corrected_hidden");

    // EXTRA "I" 升级为 WRONG，携带孤儿 ref "I've"
    expect(result[5].diff_type).toBe("wrong");
    expect(result[5].ocr_word).toBe("I");
    expect(result[5].reference_word).toBe("I've");

    // "would" 无配对，保持 EXTRA
    expect(result[6].diff_type).toBe("extra");

    // 后续 CORRECT 不受影响
    expect(result[7].diff_type).toBe("correct");
    expect(result[8].diff_type).toBe("correct");
    expect(result[9].diff_type).toBe("wrong"); // hear→here 独立 WRONG
  });

  it("【跨行合并 Bug】hidden 成员 reference_word 被覆盖为 leader.newWord 时，不应重配对 EXTRA", () => {
    // 根因：跨行合并时 isCrossLineWrong=true，前端把 hidden 成员的
    // reference_word 从原始对齐值（"I've"）覆盖为合并目标（"grapefruit"）。
    // 重新生成后 rawOps[9].reference_word="grapefruit"，错误地把 "I" 重配对为 ×I→grapefruit。
    // 正确行为：检测到 reference_word === leader.newWord → 静默隐藏，不消耗 EXTRA。
    const raw: RawDiffOp[] = [
      op("correct", "with", "with", 0, 0),
      op("wrong",   "great foods", "grapefruit", 1, 1),  // i=1: leader（已被后端合并）
      op("wrong",   "foods",       "grapefruit", 2, 2),  // i=2: 跨行 hidden（ref 被覆盖为 "grapefruit"）
      op("extra",   "I",           null,          3, null), // i=3: 不应被消耗
      op("extra",   "would",       null,          4, null),
      op("correct", "got",         "got",         5, 3),
    ];
    const entries = new Map<number, CorrectionEntry>([
      [1, mergeLeader("grapefruit", "great foods")],
      [2, mergeHidden()],
    ]);

    const result = computeDisplayDiffOps(raw, new Set(), entries);

    // i=1: leader 正常展示
    expect(result[1].diff_type).toBe("wrong");
    expect(result[1].ocr_word).toBe("great foods");
    expect(result[1].reference_word).toBe("grapefruit");

    // i=2: cross-line hidden → 静默隐藏，不消耗后续 EXTRA
    expect(result[2].diff_type).toBe("corrected_hidden");

    // i=3: "I" 保持 EXTRA（未被重配对）
    expect(result[3].diff_type).toBe("extra");
    expect(result[3].ocr_word).toBe("I");

    // i=4: "would" 保持 EXTRA
    expect(result[4].diff_type).toBe("extra");
  });
});

// ============================================================================
// rebuildCorrectedEntries 单元测试
// ============================================================================

function ann(
  word_index: number | null,
  ocr_word: string | null,
  reference_word: string | null,
  error_type: string,
  is_user_corrected: boolean,
): AnnotationForRebuild {
  return { word_index, ocr_word, reference_word, error_type, is_user_corrected };
}

describe("rebuildCorrectedEntries", () => {
  it("无用户修正时返回空 Map", () => {
    const diffResult: RawDiffOp[] = [
      op("wrong", "great", "grapefruit", 0, 0),
    ];
    const annotations: AnnotationForRebuild[] = [
      ann(0, "great", "grapefruit", "wrong", false), // auto, not user-corrected
    ];
    const entries = rebuildCorrectedEntries(diffResult, annotations);
    expect(entries.size).toBe(0);
  });

  it("null 输入返回空 Map", () => {
    expect(rebuildCorrectedEntries(null, null).size).toBe(0);
    expect(rebuildCorrectedEntries([], null).size).toBe(0);
    expect(rebuildCorrectedEntries(null, []).size).toBe(0);
  });

  it("单词合并：leader + hidden 正确建立", () => {
    // 对应首次合并保存后（diff_result 未更新，仍是原始 wrong 类型）
    const diffResult: RawDiffOp[] = [
      op("correct", "with", "with", 0, 0),
      op("wrong", "great", "grapefruit", 1, 1),   // leader 所在 diff op
      op("wrong", "foods", "I've", 2, 2),           // hidden 所在 diff op
      op("extra", "I", null, 3, null),
    ];
    const annotations: AnnotationForRebuild[] = [
      ann(0, "with", "with", "correct", false),
      ann(1, "great foods", "grapefruit", "wrong", true),  // leader
      ann(2, "foods", "I've", "correct", true),             // hidden (error_type=correct)
      ann(3, "I", null, "extra", false),
    ];

    const entries = rebuildCorrectedEntries(diffResult, annotations);

    // leader 在 diff 数组索引 1
    expect(entries.has(1)).toBe(true);
    expect(entries.get(1)?.hidden).toBe(false);
    expect(entries.get(1)?.newWord).toBe("grapefruit");
    expect(entries.get(1)?.mergedOcrWords).toBe("great foods");

    // hidden 在 diff 数组索引 2
    expect(entries.has(2)).toBe(true);
    expect(entries.get(2)?.hidden).toBe(true);

    // EXTRA "I" 不在 entries 中
    expect(entries.has(3)).toBe(false);
  });

  it("【重新生成后】diff_result 已更新为修正版本，rebuildCorrectedEntries 仍能正确建立", () => {
    // 重新生成后：
    // - diff_result[1] = {diff_type:"wrong", ocr_word:"great foods", ref:"grapefruit"} ← 后端已合并
    // - diff_result[2] = {diff_type:"correct", ocr_word:"foods", ref:"I've"} ← hidden 变 CORRECT
    const diffResultAfterRegen: RawDiffOp[] = [
      op("correct", "with", "with", 0, 0),
      op("wrong", "great foods", "grapefruit", 1, 1),   // ← 后端合并后的 leader diff op
      op("correct", "foods", "I've", 2, 2),              // ← hidden 由 WRONG 变 CORRECT
      op("extra", "I", null, 3, null),
      op("extra", "would", null, 4, null),
    ];
    // annotations 同样由后端重新生成（_create_annotations）
    const annotationsAfterRegen: AnnotationForRebuild[] = [
      ann(0, "with", "with", "correct", false),
      ann(1, "great foods", "grapefruit", "wrong", true),  // leader，is_user_corrected=true
      ann(2, "foods", "I've", "correct", true),             // hidden，is_user_corrected=true
      ann(3, "I", null, "extra", false),
      ann(4, "would", null, "extra", false),
    ];

    const entries = rebuildCorrectedEntries(diffResultAfterRegen, annotationsAfterRegen);

    // 应与首次合并时产生相同的 entries
    expect(entries.size).toBe(2);
    expect(entries.has(1)).toBe(true);
    expect(entries.get(1)?.hidden).toBe(false);
    expect(entries.get(1)?.newWord).toBe("grapefruit");
    expect(entries.get(1)?.mergedOcrWords).toBe("great foods");

    expect(entries.has(2)).toBe(true);
    expect(entries.get(2)?.hidden).toBe(true);
  });

  it("hidden 成员 ocr_word 有空格时，不会被误识别为新的 leader", () => {
    // 确保 hidden 成员不会触发外层 leader 检测
    const diffResult: RawDiffOp[] = [
      op("wrong", "great foods", "grapefruit", 0, 0),
      op("correct", "good morning", "I've", 1, 1),  // hidden 成员，ocr_word 有空格
      op("extra", "I", null, 2, null),
    ];
    // 构造 hidden 成员 ocr_word 有空格但 error_type=correct 的场景
    const annotations: AnnotationForRebuild[] = [
      ann(0, "great foods", "grapefruit", "wrong", true),         // leader
      ann(1, "good morning", "I've", "correct", true),             // hidden with space in ocr_word
      ann(2, "I", null, "extra", false),
    ];

    const entries = rebuildCorrectedEntries(diffResult, annotations);

    // leader 处理：ocr_word="great foods"(有空格), error_type="wrong" → 进入循环
    expect(entries.has(0)).toBe(true); // leader

    // "good morning" 有空格，但 error_type="correct" → 被 skip 条件过滤
    // 所以只有 leader 产生的 entries，包括 leader(0) 和 hidden(1)
    expect(entries.has(1)).toBe(true);
    expect(entries.get(1)?.hidden).toBe(true);
  });
});

// ============================================================================
// 端到端集成测试：rebuildCorrectedEntries → computeDisplayDiffOps
// ============================================================================

describe("集成：rebuildCorrectedEntries + computeDisplayDiffOps", () => {
  const baseRawOps: RawDiffOp[] = [
    op("correct", "with", "with", 0, 0),
    op("wrong", "great", "grapefruit", 1, 1),
    op("wrong", "foods", "I've", 2, 2),
    op("extra", "I", null, 3, null),
    op("extra", "would", null, 4, null),
    op("correct", "got", "got", 5, 3),
  ];

  it("首次合并后（diff_result 未更新）：rebuild → compute → 正确展示", () => {
    // diff_result 仍是原始 SequenceMatcher 输出（未经 _apply_user_corrections）
    const annotations: AnnotationForRebuild[] = [
      ann(0, "with", "with", "correct", false),
      ann(1, "great foods", "grapefruit", "wrong", true),  // leader
      ann(2, "foods", "I've", "correct", true),             // hidden
      ann(3, "I", null, "extra", false),
      ann(4, "would", null, "extra", false),
      ann(5, "got", "got", "correct", false),
    ];

    const entries = rebuildCorrectedEntries(baseRawOps, annotations);
    const display = computeDisplayDiffOps(baseRawOps, new Set(), entries);

    expect(display[1].ocr_word).toBe("great foods");
    expect(display[1].reference_word).toBe("grapefruit");
    expect(display[2].diff_type).toBe("corrected_hidden");
    expect(display[3].diff_type).toBe("wrong");
    expect(display[3].reference_word).toBe("I've");
    expect(display[4].diff_type).toBe("extra");
  });

  it("重新生成后（diff_result 已更新）：rebuild → compute → 仍正确展示", () => {
    // diff_result 已经过 _apply_user_corrections 更新
    const rawAfterRegen: RawDiffOp[] = [
      op("correct", "with", "with", 0, 0),
      op("wrong", "great foods", "grapefruit", 1, 1),  // ← 已合并
      op("correct", "foods", "I've", 2, 2),              // ← 变为 CORRECT
      op("extra", "I", null, 3, null),
      op("extra", "would", null, 4, null),
      op("correct", "got", "got", 5, 3),
    ];
    const annotationsAfterRegen: AnnotationForRebuild[] = [
      ann(0, "with", "with", "correct", false),
      ann(1, "great foods", "grapefruit", "wrong", true),
      ann(2, "foods", "I've", "correct", true),
      ann(3, "I", null, "extra", false),
      ann(4, "would", null, "extra", false),
      ann(5, "got", "got", "correct", false),
    ];

    const entries = rebuildCorrectedEntries(rawAfterRegen, annotationsAfterRegen);
    const display = computeDisplayDiffOps(rawAfterRegen, new Set(), entries);

    // 结果应与首次合并后完全相同
    expect(display[1].ocr_word).toBe("great foods");
    expect(display[1].reference_word).toBe("grapefruit");
    expect(display[1].diff_type).toBe("wrong");
    expect(display[2].diff_type).toBe("corrected_hidden");
    expect(display[3].diff_type).toBe("wrong");
    expect(display[3].ocr_word).toBe("I");
    expect(display[3].reference_word).toBe("I've");
    expect(display[4].diff_type).toBe("extra");
    expect(display[5].diff_type).toBe("correct");
  });

  it("【跨行合并 + 重新生成】cross-line hidden 静默隐藏，EXTRA 不被消耗", () => {
    // 跨行合并后 hidden 成员 reference_word 被覆盖为 "grapefruit"（=leader.newWord）
    // 重新生成后 rawOps[2].reference_word = "grapefruit"
    // 期望：hidden 静默隐藏，EXTRA "I" 保持 EXTRA（不变为 ×I→grapefruit）
    const rawCrossLine: RawDiffOp[] = [
      op("correct", "with", "with", 0, 0),
      op("wrong",  "great foods", "grapefruit", 1, 1),  // leader
      op("wrong",  "foods",       "grapefruit", 2, 2),  // cross-line hidden（ref 被覆盖）
      op("extra",  "I",           null,          3, null),
      op("extra",  "would",       null,          4, null),
      op("correct", "got",        "got",         5, 3),
    ];
    // 跨行 hidden 的 annotation error_type = "wrong"（不是 "correct"），ocr_word 无空格
    const annCrossLine: AnnotationForRebuild[] = [
      ann(0, "with",       "with",       "correct", false),
      ann(1, "great foods","grapefruit", "wrong",   true),  // leader
      ann(2, "foods",      "grapefruit", "wrong",   true),  // cross-line hidden
      ann(3, "I",          null,         "extra",   false),
      ann(4, "would",      null,         "extra",   false),
      ann(5, "got",        "got",        "correct", false),
    ];

    const entries = rebuildCorrectedEntries(rawCrossLine, annCrossLine);
    // leader 在 index 1，hidden 在 index 2
    expect(entries.has(1)).toBe(true);
    expect(entries.get(1)?.hidden).toBe(false);
    expect(entries.has(2)).toBe(true);
    expect(entries.get(2)?.hidden).toBe(true);

    const display = computeDisplayDiffOps(rawCrossLine, new Set(), entries);

    // leader 正常展示
    expect(display[1].diff_type).toBe("wrong");
    expect(display[1].ocr_word).toBe("great foods");

    // cross-line hidden 静默隐藏，不消耗 EXTRA
    expect(display[2].diff_type).toBe("corrected_hidden");

    // "I" 保持 EXTRA（不被重配对）
    expect(display[3].diff_type).toBe("extra");
    expect(display[4].diff_type).toBe("extra");
  });

  it("多次重新生成：幂等性 — 第二次生成结果与第一次相同", () => {
    // 第二次生成的 diff_result 与第一次完全相同（后端幂等）
    // 验证 rebuild+compute 管道也是幂等的
    const rawSecondRegen: RawDiffOp[] = [
      op("correct", "with", "with", 0, 0),
      op("wrong", "great foods", "grapefruit", 1, 1),
      op("correct", "foods", "I've", 2, 2),
      op("extra", "I", null, 3, null),
      op("extra", "would", null, 4, null),
      op("correct", "got", "got", 5, 3),
    ];
    const annSecondRegen: AnnotationForRebuild[] = [
      ann(0, "with", "with", "correct", false),
      ann(1, "great foods", "grapefruit", "wrong", true),
      ann(2, "foods", "I've", "correct", true),
      ann(3, "I", null, "extra", false),
      ann(4, "would", null, "extra", false),
      ann(5, "got", "got", "correct", false),
    ];

    const entries1 = rebuildCorrectedEntries(rawSecondRegen, annSecondRegen);
    const display1 = computeDisplayDiffOps(rawSecondRegen, new Set(), entries1);

    const entries2 = rebuildCorrectedEntries(rawSecondRegen, annSecondRegen);
    const display2 = computeDisplayDiffOps(rawSecondRegen, new Set(), entries2);

    // 两次结果完全一致
    display1.forEach((op1, i) => {
      const op2 = display2[i];
      expect(op1.diff_type).toBe(op2.diff_type);
      expect(op1.ocr_word).toBe(op2.ocr_word);
      expect(op1.reference_word).toBe(op2.reference_word);
    });
  });

  it("【跨行合并新修复】hidden is_user_corrected=true 但后端保留原始 ref → 重生成后 EXTRA 正确重配对", () => {
    // 修复后：后端 _apply_user_corrections 跳过 hidden 成员，
    // diff_result_json 保留原始 ref="I've"（非 "grapefruit"）。
    // annotation 仍保存 reference_word="grapefruit" 供标注编辑器显示，
    // 但 rawOps[2] 由后端保留原始 ref="I've"。
    // 预期：wrong:I→I've（与同行合并行为一致）。
    const rawAfterFix: RawDiffOp[] = [
      op("correct", "with", "with", 0, 0),
      op("wrong", "great foods", "grapefruit", 1, 1),  // leader（后端已合并 ocr_word）
      op("wrong",  "foods",      "I've",        2, 2), // hidden：后端保留原始 ref
      op("extra",  "I",          null,           3, null),
      op("extra",  "would",      null,           4, null),
      op("correct","got",        "got",          5, 3),
    ];
    // 新修复后：cross-line hidden 保持 is_user_corrected=true，
    // annotation 中 reference_word="grapefruit"（供编辑器显示），
    // 但 rawOps[2].reference_word="I've"（后端跳过 hidden 成员，原始 ref 保留）
    const annAfterFix: AnnotationForRebuild[] = [
      ann(0, "with",        "with",       "correct", false),
      ann(1, "great foods", "grapefruit", "wrong",   true),  // leader
      ann(2, "foods",       "grapefruit", "wrong",   true),  // cross-line hidden（annotation 中 ref="grapefruit"）
      ann(3, "I",           null,         "extra",   false),
      ann(4, "would",       null,         "extra",   false),
      ann(5, "got",         "got",        "correct", false),
    ];

    const entries = rebuildCorrectedEntries(rawAfterFix, annAfterFix);
    expect(entries.has(1)).toBe(true);
    expect(entries.get(1)?.hidden).toBe(false);
    expect(entries.has(2)).toBe(true);
    expect(entries.get(2)?.hidden).toBe(true);

    const display = computeDisplayDiffOps(rawAfterFix, new Set(), entries);

    // leader 正常展示
    expect(display[1].ocr_word).toBe("great foods");
    expect(display[1].reference_word).toBe("grapefruit");

    // hidden 成员 ref="I've" ≠ leader.newWord="grapefruit" → 触发重配对（非静默隐藏）
    expect(display[2].diff_type).toBe("corrected_hidden");

    // "I" 被重配对为 ×I→I've（与同行合并行为一致）
    expect(display[3].diff_type).toBe("wrong");
    expect(display[3].ocr_word).toBe("I");
    expect(display[3].reference_word).toBe("I've");

    // "would" 无配对，保持 EXTRA
    expect(display[4].diff_type).toBe("extra");
  });
});
