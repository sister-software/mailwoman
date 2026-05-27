"""Training-time augmentation: expand abbreviations to teach token equivalence.

Two augmentations, applied independently with configurable probability:

1. **Directional expansion**: "NW" → "Northwest", "SE" → "Southeast", etc.
   Teaches the model that both abbreviated and expanded directionals are the same
   component, without requiring inference-time normalization.

2. **Region-abbreviation expansion**: "NY" → "New York", "CA" → "California", etc.
   Only US state abbreviations for now. Teaches the model that "NY" and "New York"
   are both B-region, improving locality/region disambiguation.

Both augmentations replace the token in the raw text AND update the tokens + labels
lists to match. The expanded form inherits the original token's BIO label (B- for
the first word, I- for continuation words).
"""

from __future__ import annotations

import random
from typing import Iterator

# US directional abbreviations → expanded forms.
DIRECTIONALS: dict[str, str] = {
    "N": "North",
    "S": "South",
    "E": "East",
    "W": "West",
    "NE": "Northeast",
    "NW": "Northwest",
    "SE": "Southeast",
    "SW": "Southwest",
}

# US state abbreviations → full names. Only unambiguous 2-letter codes.
US_STATES: dict[str, str] = {
    "AL": "Alabama",
    "AK": "Alaska",
    "AZ": "Arizona",
    "AR": "Arkansas",
    "CA": "California",
    "CO": "Colorado",
    "CT": "Connecticut",
    "DE": "Delaware",
    "FL": "Florida",
    "GA": "Georgia",
    "HI": "Hawaii",
    "ID": "Idaho",
    "IL": "Illinois",
    "IN": "Indiana",
    "IA": "Iowa",
    "KS": "Kansas",
    "KY": "Kentucky",
    "LA": "Louisiana",
    "ME": "Maine",
    "MD": "Maryland",
    "MA": "Massachusetts",
    "MI": "Michigan",
    "MN": "Minnesota",
    "MS": "Mississippi",
    "MO": "Missouri",
    "MT": "Montana",
    "NE": "Nebraska",
    "NV": "Nevada",
    "NH": "New Hampshire",
    "NJ": "New Jersey",
    "NM": "New Mexico",
    "NY": "New York",
    "NC": "North Carolina",
    "ND": "North Dakota",
    "OH": "Ohio",
    "OK": "Oklahoma",
    "OR": "Oregon",
    "PA": "Pennsylvania",
    "RI": "Rhode Island",
    "SC": "South Carolina",
    "SD": "South Dakota",
    "TN": "Tennessee",
    "TX": "Texas",
    "UT": "Utah",
    "VT": "Vermont",
    "VA": "Virginia",
    "WA": "Washington",
    "WV": "West Virginia",
    "WI": "Wisconsin",
    "WY": "Wyoming",
    "DC": "District of Columbia",
}


def _expand_token(
    tokens: list[str],
    labels: list[str],
    idx: int,
    expansion: str,
) -> tuple[list[str], list[str]]:
    """Replace token at `idx` with a multi-word expansion, updating labels with B-/I- continuation."""
    orig_label = labels[idx]
    expansion_words = expansion.split()

    if len(expansion_words) == 1:
        new_tokens = tokens[:idx] + [expansion_words[0]] + tokens[idx + 1 :]
        new_labels = labels[:]
        return new_tokens, new_labels

    # Multi-word: first word keeps the original label, rest get I- version.
    if orig_label.startswith("B-"):
        tag = orig_label[2:]
        new_labels_for_expansion = [orig_label] + [f"I-{tag}"] * (len(expansion_words) - 1)
    elif orig_label.startswith("I-"):
        new_labels_for_expansion = [orig_label] * len(expansion_words)
    else:
        # O label — all expansion words are O
        new_labels_for_expansion = ["O"] * len(expansion_words)

    new_tokens = tokens[:idx] + expansion_words + tokens[idx + 1 :]
    new_labels = labels[:idx] + new_labels_for_expansion + labels[idx + 1 :]
    return new_tokens, new_labels


def augment_row(
    row: dict,
    rng: random.Random,
    directional_prob: float = 0.3,
    region_prob: float = 0.3,
) -> Iterator[dict]:
    """Yield the original row, then optionally an augmented copy.

    Each augmentation fires independently with its configured probability. When an
    augmentation fires, a COPY of the row is yielded with the expansion applied.
    The original row is always yielded first, unchanged.
    """
    yield row

    tokens: list[str] = row["tokens"]
    labels: list[str] = row["labels"]

    # Directional expansion: find directional tokens and expand one.
    if rng.random() < directional_prob:
        directional_indices = [
            i for i, t in enumerate(tokens) if t in DIRECTIONALS
        ]
        if directional_indices:
            idx = rng.choice(directional_indices)
            new_tokens, new_labels = _expand_token(
                tokens, labels, idx, DIRECTIONALS[tokens[idx]]
            )
            new_raw = " ".join(new_tokens)
            yield {
                **row,
                "raw": new_raw,
                "tokens": new_tokens,
                "labels": new_labels,
            }

    # Region-abbreviation expansion: find region-labeled abbreviations and expand one.
    if rng.random() < region_prob:
        region_indices = [
            i
            for i, (t, l) in enumerate(zip(tokens, labels))
            if t in US_STATES and l in ("B-region", "I-region")
        ]
        if region_indices:
            idx = rng.choice(region_indices)
            new_tokens, new_labels = _expand_token(
                tokens, labels, idx, US_STATES[tokens[idx]]
            )
            new_raw = " ".join(new_tokens)
            yield {
                **row,
                "raw": new_raw,
                "tokens": new_tokens,
                "labels": new_labels,
            }
