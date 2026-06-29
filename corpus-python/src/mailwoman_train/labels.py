"""Label set + helpers for the mailwoman neural classifier.

Mirrors the JS-side ``COMPONENT_TAGS`` / ``BIO_LABELS`` in
``packages/core/core/types/component.ts``. Any tag outside ``ACTIVE_TAGS`` is rewritten
to ``O`` at data-load time (see ``data_loader.collapse_to_active``).

**Versioning** — the active set evolves across training rounds. Older constants are kept
exportable so historical checkpoints + eval reports can be diffed against today's labels:

- ``STAGE1_COARSE_TAGS`` (7 tags) / ``STAGE1_BIO_LABELS`` (15) — v0.1.0 + v0.2.0 ship.
- ``STAGE2_TAGS`` (10 tags) / ``STAGE2_BIO_LABELS`` (21) — v0.3.0 ship (this file's active
  set as of 2026-05-22). Adds ``venue`` / ``street`` / ``house_number`` BIO classes per
  issue #57.

``ACTIVE_TAGS`` / ``ACTIVE_BIO_LABELS`` always point at the *current* training round's
vocabulary. Bump these together with a new STAGE-N constant when ship-line moves; never
mutate an older STAGE-N constant.

Drift check: keep ``ACTIVE_TAGS`` in sync with the JS ``ComponentTag`` union. If a new
tag lands in ``component.ts``, decide whether it belongs in the next active set; if so,
add it to a new STAGE-N constant in the same commit and shift ACTIVE_*.
"""

from __future__ import annotations

from typing import Final

# --- Historical: v0.1.0 + v0.2.0 (coarse-only) ---------------------------------------

STAGE1_COARSE_TAGS: Final[tuple[str, ...]] = (
    "country",
    "region",
    "locality",
    "dependent_locality",
    "postcode",
    "subregion",
    "cedex",
)

STAGE1_BIO_LABELS: Final[tuple[str, ...]] = (
    "O",
    *(prefix + tag for tag in STAGE1_COARSE_TAGS for prefix in ("B-", "I-")),
)

# --- v0.3.0: coarse + fine (venue, street, house_number) -----------------------------

# Fine tags added in Stage 2. Order is stable across runs so label IDs are reproducible
# within a stage. NEVER reorder within a stage; ALWAYS append for a new stage.
STAGE2_FINE_TAGS: Final[tuple[str, ...]] = (
    "venue",
    "street",
    "house_number",
)

STAGE2_TAGS: Final[tuple[str, ...]] = STAGE1_COARSE_TAGS + STAGE2_FINE_TAGS

STAGE2_BIO_LABELS: Final[tuple[str, ...]] = (
    "O",
    *(prefix + tag for tag in STAGE2_TAGS for prefix in ("B-", "I-")),
)

# --- v0.6.0: Stage 3 — street decomposition + PO box + intersection -----------------

# Fine tags added in Stage 3. Extends Stage 2 by decomposing the monolithic `street` tag
# into prefix/suffix and adding unit/po_box/intersection. The golden eval set already has
# these tags; corpus adapters need to emit them for training. The schema, formatting, and
# runtime pipeline are already Stage 3-ready (core/types/component.ts).
STAGE3_FINE_TAGS: Final[tuple[str, ...]] = (
    "street_prefix",
    "street_suffix",
    "unit",
    "po_box",
    "intersection_a",
    "intersection_b",
)

STAGE3_TAGS: Final[tuple[str, ...]] = STAGE2_TAGS + STAGE3_FINE_TAGS

STAGE3_BIO_LABELS: Final[tuple[str, ...]] = (
    "O",
    *(prefix + tag for tag in STAGE3_TAGS for prefix in ("B-", "I-")),
)

# --- Active set (points at the most-recent stage) ------------------------------------
# Bump to STAGE3 when training with v0.6.0 corpus. Until then, STAGE2 is active so
# existing v0.5.x models keep working.

ACTIVE_TAGS: Final[tuple[str, ...]] = STAGE3_TAGS
ACTIVE_BIO_LABELS: Final[tuple[str, ...]] = STAGE3_BIO_LABELS

LABEL_TO_ID: Final[dict[str, int]] = {label: i for i, label in enumerate(ACTIVE_BIO_LABELS)}
ID_TO_LABEL: Final[dict[int, str]] = {i: label for label, i in LABEL_TO_ID.items()}

# Labels that mean "ignore" in cross-entropy. The HF Trainer treats ``-100`` as the sentinel.
IGNORE_INDEX: Final[int] = -100

# --- Locale conditioning (PR3 / self-conditioning) -----------------------------------
# Country (ISO 3166-1 alpha-2) → locale class id for the auxiliary self-conditioning head.
# The head predicts which country an address belongs to from the POOLED sequence; that
# posterior conditions the per-token labeling (model.py FiLM) and is the LocalePosterior the
# resolver consumes. The probe behind PR3 showed the postcode alone pins the country only
# 28–44% of the time, so the model must infer it from the whole string — this map is the
# aux head's target vocabulary.
#
# Stable order: NEVER reorder, only APPEND, so a checkpoint's locale-head ids stay
# reproducible (same discipline as the BIO STAGE-N constants above). A row whose ``country``
# is absent from this map maps to IGNORE_INDEX and contributes nothing to the aux loss —
# graceful for locales the head wasn't trained on. The head still carries a slot for every
# entry here, so the pilot (US/FR/DE) can grow to the others without a geometry change.
LOCALE_COUNTRIES: Final[tuple[str, ...]] = (
    "US",
    "FR",
    "DE",
    "CA",
    "GB",
    "JP",
    "ES",
    "IT",
    "NL",
)
LOCALE_TO_ID: Final[dict[str, int]] = {c: i for i, c in enumerate(LOCALE_COUNTRIES)}
ID_TO_LOCALE: Final[dict[int, str]] = {i: c for c, i in LOCALE_TO_ID.items()}
NUM_LOCALES: Final[int] = len(LOCALE_COUNTRIES)


def locale_id(country: str | None) -> int:
    """Country (ISO-2, case-insensitive) → locale class id, or IGNORE_INDEX if unmapped."""
    if not country:
        return IGNORE_INDEX
    return LOCALE_TO_ID.get(country.strip().upper(), IGNORE_INDEX)


def collapse_label(bio_label: str) -> str:
    """Rewrite a BIO label to its active-set equivalent, or ``O``.

    Tags outside ``ACTIVE_TAGS`` (e.g. a future ``B-org`` that hasn't been added yet)
    collapse to ``O``; unknown shapes (no ``-`` prefix, bad prefix) also collapse to ``O``.
    """
    if bio_label == "O":
        return "O"
    if "-" not in bio_label:
        return "O"
    prefix, tag = bio_label.split("-", 1)
    if tag not in ACTIVE_TAGS or prefix not in ("B", "I"):
        return "O"
    return bio_label


def active_components_present(components_keys: list[str]) -> bool:
    """True iff the row has at least one ACTIVE tag.

    Used to filter training rows per Phase 2 §5.1.

    The v0.1.0 gate required ``country`` plus one of (region, locality, postcode),
    modelled on wof-admin's "Paris, France"-style rows. That gate silently dropped every
    non-wof-admin source in corpus v0.2.0 — BAN, TIGER, NPPES, IMLS, state-* all label
    house_number / street / postcode / locality / region without a country token, because
    country is implicit in the data source's geography. The strict gate was the upstream
    cause of the v0.1.0 positional-heuristic overfit (PR #42, issue #43): pre-filter the
    training data was ~73% wof-admin, post-filter ~100% wof-admin.

    v0.2.0 relaxed the gate to "at least one coarse tag". v0.3.0 broadens further: "at
    least one ACTIVE tag" — rows with only fine tags (e.g. BAN's house_number + street,
    TIGER's street-only ADDRFEAT segments) now contribute. The gate's purpose is to drop
    rows with no usable supervision at all, not to enforce a particular schema shape.
    """
    return bool(set(components_keys) & set(ACTIVE_TAGS))


# Backwards-compat alias for callers that haven't migrated to the active-set naming.
# Removed once the rename lands across data_loader / eval / train / model.
coarse_components_present = active_components_present
