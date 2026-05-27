"""Tests for training-time augmentation."""

import random

from .augment import augment_row, _expand_token


def test_expand_token_single_word():
    tokens = ["350", "5th", "Ave", "NW"]
    labels = ["B-house_number", "B-street", "I-street", "I-street"]
    new_tokens, new_labels = _expand_token(tokens, labels, 3, "Northwest")
    assert new_tokens == ["350", "5th", "Ave", "Northwest"]
    assert new_labels == ["B-house_number", "B-street", "I-street", "I-street"]


def test_expand_token_multi_word_b_label():
    tokens = ["Washington", ",", "DC"]
    labels = ["B-region", "O", "B-region"]
    # Expand "DC" → "District of Columbia"
    new_tokens, new_labels = _expand_token(tokens, labels, 2, "District of Columbia")
    assert new_tokens == ["Washington", ",", "District", "of", "Columbia"]
    assert new_labels == ["B-region", "O", "B-region", "I-region", "I-region"]


def test_expand_token_multi_word_i_label():
    tokens = ["New", "York", ",", "NY"]
    labels = ["B-locality", "I-locality", "O", "B-region"]
    # Expand "NY" → "New York" (B-region stays B-region, second word gets I-region)
    new_tokens, new_labels = _expand_token(tokens, labels, 3, "New York")
    assert new_tokens == ["New", "York", ",", "New", "York"]
    assert new_labels == ["B-locality", "I-locality", "O", "B-region", "I-region"]


def test_augment_row_original_always_yielded():
    row = {
        "raw": "350 5th Ave NW",
        "tokens": ["350", "5th", "Ave", "NW"],
        "labels": ["B-house_number", "B-street", "I-street", "I-street"],
        "country": "US",
        "source": "tiger",
    }
    rng = random.Random(42)
    results = list(augment_row(row, rng, directional_prob=0.0, region_prob=0.0))
    assert len(results) == 1
    assert results[0] is row


def test_augment_row_directional_fires():
    row = {
        "raw": "350 5th Ave NW",
        "tokens": ["350", "5th", "Ave", "NW"],
        "labels": ["B-house_number", "B-street", "I-street", "I-street"],
        "country": "US",
        "source": "tiger",
    }
    rng = random.Random(42)
    results = list(augment_row(row, rng, directional_prob=1.0, region_prob=0.0))
    assert len(results) == 2
    assert results[0] is row
    assert "Northwest" in results[1]["tokens"]


def test_augment_row_region_fires():
    row = {
        "raw": "New York , NY",
        "tokens": ["New", "York", ",", "NY"],
        "labels": ["B-locality", "I-locality", "O", "B-region"],
        "country": "US",
        "source": "tiger",
    }
    rng = random.Random(42)
    results = list(augment_row(row, rng, directional_prob=0.0, region_prob=1.0))
    assert len(results) == 2
    augmented = results[1]
    # "NY" should be expanded to "New" "York" with B-region I-region
    assert "B-region" in augmented["labels"]
    assert "I-region" in augmented["labels"]


def test_augment_row_no_match_no_extra():
    row = {
        "raw": "123 Main St",
        "tokens": ["123", "Main", "St"],
        "labels": ["B-house_number", "B-street", "I-street"],
        "country": "US",
        "source": "tiger",
    }
    rng = random.Random(42)
    # Even with prob=1.0, no directionals or region abbreviations → no augmented copy
    results = list(augment_row(row, rng, directional_prob=1.0, region_prob=1.0))
    assert len(results) == 1


def test_augment_row_region_only_expands_region_labeled():
    row = {
        "raw": "PA Ave , DC",
        "tokens": ["PA", "Ave", ",", "DC"],
        "labels": ["B-street", "I-street", "O", "B-region"],
        "country": "US",
        "source": "tiger",
    }
    rng = random.Random(42)
    results = list(augment_row(row, rng, directional_prob=0.0, region_prob=1.0))
    assert len(results) == 2
    augmented = results[1]
    # PA (labeled B-street) should NOT be expanded — only DC (B-region) should
    assert augmented["tokens"][0] == "PA"
    assert "District" in augmented["tokens"]
