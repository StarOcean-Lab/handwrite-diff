"""Unit tests for diff_engine."""

import pytest

from app.services.diff_engine import DiffOp, DiffType, compute_word_diff, normalize_word_list


class TestNormalizeWordList:
    def test_basic(self) -> None:
        assert normalize_word_list("The cat sat") == ["The", "cat", "sat"]

    def test_strips_punctuation(self) -> None:
        assert normalize_word_list("Hello, world!") == ["Hello", "world"]

    def test_empty_string(self) -> None:
        assert normalize_word_list("") == []

    def test_preserves_case(self) -> None:
        assert normalize_word_list("The CAT Sat") == ["The", "CAT", "Sat"]


class TestComputeWordDiff:
    def test_identical(self) -> None:
        ocr = ["the", "cat", "sat"]
        ref = ["the", "cat", "sat"]
        ops = compute_word_diff(ocr, ref)
        assert all(op.diff_type == DiffType.CORRECT for op in ops)
        assert len(ops) == 3

    def test_single_replacement(self) -> None:
        ocr = ["the", "cat", "set", "on", "the", "mat"]
        ref = ["the", "cat", "sat", "on", "the", "mat"]
        ops = compute_word_diff(ocr, ref)
        wrong_ops = [op for op in ops if op.diff_type == DiffType.WRONG]
        assert len(wrong_ops) == 1
        assert wrong_ops[0].ocr_word == "set"
        assert wrong_ops[0].reference_word == "sat"

    def test_multiple_replacements(self) -> None:
        ocr = ["The", "cat", "set", "on", "the", "met"]
        ref = ["The", "cat", "sat", "on", "the", "mat"]
        ops = compute_word_diff(ocr, ref)
        wrong_ops = [op for op in ops if op.diff_type == DiffType.WRONG]
        assert len(wrong_ops) == 2

    def test_extra_word(self) -> None:
        ocr = ["the", "big", "cat", "sat"]
        ref = ["the", "cat", "sat"]
        ops = compute_word_diff(ocr, ref)
        extra_ops = [op for op in ops if op.diff_type == DiffType.EXTRA]
        assert len(extra_ops) == 1
        assert extra_ops[0].ocr_word == "big"

    def test_missing_word(self) -> None:
        ocr = ["the", "sat"]
        ref = ["the", "cat", "sat"]
        ops = compute_word_diff(ocr, ref)
        missing_ops = [op for op in ops if op.diff_type == DiffType.MISSING]
        assert len(missing_ops) == 1
        assert missing_ops[0].reference_word == "cat"

    def test_empty_ocr(self) -> None:
        ops = compute_word_diff([], ["the", "cat"])
        assert all(op.diff_type == DiffType.MISSING for op in ops)
        assert len(ops) == 2

    def test_empty_reference(self) -> None:
        ops = compute_word_diff(["the", "cat"], [])
        assert all(op.diff_type == DiffType.EXTRA for op in ops)
        assert len(ops) == 2

    def test_both_empty(self) -> None:
        ops = compute_word_diff([], [])
        assert ops == []

    def test_case_insensitive(self) -> None:
        ocr = ["The", "CAT"]
        ref = ["the", "cat"]
        ops = compute_word_diff(ocr, ref)
        assert all(op.diff_type == DiffType.CORRECT for op in ops)

    def test_punctuation_tolerance(self) -> None:
        ocr = ["hello,", "world!"]
        ref = ["hello", "world"]
        ops = compute_word_diff(ocr, ref)
        assert all(op.diff_type == DiffType.CORRECT for op in ops)

    def test_complex_scenario(self) -> None:
        """Test: OCR has errors, extras, and missing words."""
        ocr = ["The", "big", "cat", "set", "on", "the"]
        ref = ["The", "cat", "sat", "on", "the", "mat"]
        ops = compute_word_diff(ocr, ref)

        types = [op.diff_type for op in ops]
        assert DiffType.CORRECT in types
        assert DiffType.WRONG in types or DiffType.EXTRA in types
        # At least one mismatch
        assert sum(1 for t in types if t != DiffType.CORRECT) >= 1

    def test_preserves_original_words(self) -> None:
        """Ensure original (non-normalized) words are in the DiffOp."""
        ocr = ["Hello,"]
        ref = ["Hello"]
        ops = compute_word_diff(ocr, ref)
        assert ops[0].ocr_word == "Hello,"
        assert ops[0].reference_word == "Hello"


class TestContractionHandling:
    """Tests for contraction equivalence post-processing."""

    def test_contraction_ill_vs_i_will(self) -> None:
        """I'll ↔ I will → CORRECT."""
        ocr = ["I'll"]
        ref = ["I", "will"]
        ops = compute_word_diff(ocr, ref)
        assert len(ops) == 1
        assert ops[0].diff_type == DiffType.CORRECT
        assert ops[0].ocr_word == "I'll"
        assert ops[0].reference_word == "I will"

    def test_contraction_dont_vs_do_not(self) -> None:
        """don't ↔ do not → CORRECT."""
        ocr = ["don't"]
        ref = ["do", "not"]
        ops = compute_word_diff(ocr, ref)
        assert len(ops) == 1
        assert ops[0].diff_type == DiffType.CORRECT

    def test_contraction_cant_vs_cannot(self) -> None:
        """can't ↔ cannot → CORRECT (single-word equivalence, P0)."""
        ocr = ["can't"]
        ref = ["cannot"]
        ops = compute_word_diff(ocr, ref)
        assert len(ops) == 1
        assert ops[0].diff_type == DiffType.CORRECT

    def test_contraction_its_ambiguous(self) -> None:
        """it's ↔ it is AND it's ↔ it has → both CORRECT."""
        for ref in [["it", "is"], ["it", "has"]]:
            ops = compute_word_diff(["it's"], ref)
            assert len(ops) == 1
            assert ops[0].diff_type == DiffType.CORRECT

    def test_contraction_reverse(self) -> None:
        """do not (OCR) ↔ don't (ref) → CORRECT (P2 pattern)."""
        ocr = ["do", "not"]
        ref = ["don't"]
        ops = compute_word_diff(ocr, ref)
        assert len(ops) == 1
        assert ops[0].diff_type == DiffType.CORRECT
        assert ops[0].ocr_word == "do not"
        assert ops[0].reference_word == "don't"

    def test_contraction_in_context(self) -> None:
        """I'll go home ↔ I will go home → all CORRECT."""
        ocr = ["I'll", "go", "home"]
        ref = ["I", "will", "go", "home"]
        ops = compute_word_diff(ocr, ref)
        assert all(op.diff_type == DiffType.CORRECT for op in ops)

    def test_contraction_with_real_error(self) -> None:
        """I'll sit ↔ I will set → I'll CORRECT, sit↔set WRONG."""
        ocr = ["I'll", "sit"]
        ref = ["I", "will", "set"]
        ops = compute_word_diff(ocr, ref)
        correct_ops = [op for op in ops if op.diff_type == DiffType.CORRECT]
        wrong_ops = [op for op in ops if op.diff_type == DiffType.WRONG]
        # I'll ↔ "I will" should be correct
        assert len(correct_ops) >= 1
        assert any("I'll" in (op.ocr_word or "") for op in correct_ops)
        # sit ↔ set should be wrong
        assert len(wrong_ops) == 1
        assert wrong_ops[0].ocr_word == "sit"
        assert wrong_ops[0].reference_word == "set"

    def test_no_false_positive(self) -> None:
        """Ill ↔ I'll → WRONG (OCR misread, no apostrophe = not a contraction)."""
        ocr = ["Ill"]
        ref = ["I'll"]
        ops = compute_word_diff(ocr, ref)
        assert len(ops) == 1
        assert ops[0].diff_type == DiffType.WRONG
