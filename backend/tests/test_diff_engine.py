"""Unit tests for diff_engine."""

import pytest

from app.services.diff_engine import (
    DiffOp,
    DiffType,
    _are_number_equivalent,
    _parse_as_number,
    compute_word_diff,
    normalize_word_list,
)


class TestNormalizeWordList:
    def test_basic(self) -> None:
        assert normalize_word_list("The cat sat") == ["The", "cat", "sat"]

    def test_preserves_punctuation(self) -> None:
        assert normalize_word_list("Hello, world!") == ["Hello,", "world!"]

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

    def test_strips_edge_punctuation_from_diff_ops(self) -> None:
        """DiffOp word fields must have edge punctuation stripped.
        'Hello,' (OCR) vs 'Hello' (ref) → CORRECT, ocr_word='Hello'."""
        ocr = ["Hello,"]
        ref = ["Hello"]
        ops = compute_word_diff(ocr, ref)
        assert ops[0].diff_type == DiffType.CORRECT
        assert ops[0].ocr_word == "Hello"
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

    # ------------------------------------------------------------------
    # P2b: na is EXTRA, subsequent OCR words match the ref contraction
    # ------------------------------------------------------------------

    def test_p2b_extra_word_before_expansion(self) -> None:
        """'of you are' vs 'you're' → EXTRA 'of', CORRECT 'you are'↔'you're'."""
        ocr = ["because", "of", "you", "are", "in"]
        ref = ["because", "you're", "in"]
        ops = compute_word_diff(ocr, ref)

        types = [op.diff_type for op in ops]
        # "because" and "in" must be CORRECT
        assert types[0] == DiffType.CORRECT
        assert types[-1] == DiffType.CORRECT
        # Must have exactly one EXTRA ("of")
        extra_ops = [op for op in ops if op.diff_type == DiffType.EXTRA]
        assert len(extra_ops) == 1
        assert extra_ops[0].ocr_word == "of"
        # Must have exactly one CORRECT for the contraction pair
        correct_ops = [op for op in ops if op.diff_type == DiffType.CORRECT]
        contraction_correct = [
            op for op in correct_ops if op.reference_word == "you're"
        ]
        assert len(contraction_correct) == 1
        assert contraction_correct[0].ocr_word == "you are"

    def test_p2b_full_sentence(self) -> None:
        """'because of you are in a different environment to usual'
        vs 'because you're in a different environment to usual'."""
        ocr_text = "because of you are in a different environment to usual"
        ref_text = "because you're in a different environment to usual"
        ocr = ocr_text.split()
        ref = ref_text.split()
        ops = compute_word_diff(ocr, ref)

        extra_ops = [op for op in ops if op.diff_type == DiffType.EXTRA]
        wrong_ops = [op for op in ops if op.diff_type == DiffType.WRONG]
        correct_ops = [op for op in ops if op.diff_type == DiffType.CORRECT]

        # Only "of" should be extra; no WRONG ops at all
        assert len(extra_ops) == 1
        assert extra_ops[0].ocr_word == "of"
        assert len(wrong_ops) == 0
        # "you are" ↔ "you're" should be CORRECT
        contraction_correct = [
            op for op in correct_ops if op.reference_word == "you're"
        ]
        assert len(contraction_correct) == 1

    # ------------------------------------------------------------------
    # P1b: nb is MISSING, subsequent ref words match the OCR contraction
    # ------------------------------------------------------------------

    def test_p1b_extra_ref_word_before_expansion(self) -> None:
        """'you're' (OCR) vs 'of you are' (ref) → MISSING 'of', CORRECT 'you're'↔'you are'."""
        ocr = ["because", "you're", "in"]
        ref = ["because", "of", "you", "are", "in"]
        ops = compute_word_diff(ocr, ref)

        types = [op.diff_type for op in ops]
        assert types[0] == DiffType.CORRECT
        assert types[-1] == DiffType.CORRECT
        # Must have exactly one MISSING ("of")
        missing_ops = [op for op in ops if op.diff_type == DiffType.MISSING]
        assert len(missing_ops) == 1
        assert missing_ops[0].reference_word == "of"
        # Must have exactly one CORRECT for the contraction pair
        correct_ops = [op for op in ops if op.diff_type == DiffType.CORRECT]
        contraction_correct = [
            op for op in correct_ops if op.ocr_word == "you're"
        ]
        assert len(contraction_correct) == 1


class TestNumberEquivalence:
    """Tests for number word ↔ Arabic digit equivalence (P0 path)."""

    # ------------------------------------------------------------------
    # _parse_as_number unit tests
    # ------------------------------------------------------------------

    def test_parse_arabic_digit(self) -> None:
        assert _parse_as_number("3") == 3

    def test_parse_arabic_ordinal(self) -> None:
        assert _parse_as_number("1st") == 1
        assert _parse_as_number("2nd") == 2
        assert _parse_as_number("3rd") == 3
        assert _parse_as_number("10th") == 10

    def test_parse_english_cardinal(self) -> None:
        assert _parse_as_number("one") == 1
        assert _parse_as_number("twelve") == 12
        assert _parse_as_number("twenty") == 20

    def test_parse_english_ordinal(self) -> None:
        assert _parse_as_number("first") == 1
        assert _parse_as_number("second") == 2
        assert _parse_as_number("twentieth") == 20

    def test_parse_non_number_returns_none(self) -> None:
        assert _parse_as_number("cat") is None
        assert _parse_as_number("the") is None

    # ------------------------------------------------------------------
    # _are_number_equivalent unit tests
    # ------------------------------------------------------------------

    def test_one_vs_1(self) -> None:
        assert _are_number_equivalent("one", "1") is True

    def test_1_vs_one(self) -> None:
        assert _are_number_equivalent("1", "one") is True

    def test_first_vs_1st(self) -> None:
        assert _are_number_equivalent("first", "1st") is True

    def test_different_numbers_not_equivalent(self) -> None:
        assert _are_number_equivalent("one", "2") is False

    def test_non_number_not_equivalent(self) -> None:
        assert _are_number_equivalent("cat", "1") is False

    # ------------------------------------------------------------------
    # compute_word_diff integration tests
    # ------------------------------------------------------------------

    def test_digit_ocr_word_ref_correct(self) -> None:
        """OCR '1' vs ref 'one' → CORRECT."""
        ops = compute_word_diff(["1"], ["one"])
        assert len(ops) == 1
        assert ops[0].diff_type == DiffType.CORRECT

    def test_word_ocr_digit_ref_correct(self) -> None:
        """OCR 'one' vs ref '1' → CORRECT."""
        ops = compute_word_diff(["one"], ["1"])
        assert len(ops) == 1
        assert ops[0].diff_type == DiffType.CORRECT

    def test_ordinal_word_vs_digit_suffix(self) -> None:
        """OCR 'first' vs ref '1st' → CORRECT."""
        ops = compute_word_diff(["first"], ["1st"])
        assert len(ops) == 1
        assert ops[0].diff_type == DiffType.CORRECT

    def test_ordinal_digit_vs_word(self) -> None:
        """OCR '2nd' vs ref 'second' → CORRECT."""
        ops = compute_word_diff(["2nd"], ["second"])
        assert len(ops) == 1
        assert ops[0].diff_type == DiffType.CORRECT

    def test_number_in_sentence_context(self) -> None:
        """'I have 3 cats' vs 'I have three cats' → all CORRECT."""
        ocr = ["I", "have", "3", "cats"]
        ref = ["I", "have", "three", "cats"]
        ops = compute_word_diff(ocr, ref)
        assert all(op.diff_type == DiffType.CORRECT for op in ops)

    def test_different_numbers_still_wrong(self) -> None:
        """OCR 'two' vs ref '3' → WRONG (different values)."""
        ops = compute_word_diff(["two"], ["3"])
        assert len(ops) == 1
        assert ops[0].diff_type == DiffType.WRONG

    def test_twelve_vs_12_correct(self) -> None:
        """OCR 'twelve' vs ref '12' → CORRECT."""
        ops = compute_word_diff(["twelve"], ["12"])
        assert len(ops) == 1
        assert ops[0].diff_type == DiffType.CORRECT
