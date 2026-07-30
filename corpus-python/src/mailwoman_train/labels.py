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
- ``STAGE3_TAGS`` (16 tags) / ``STAGE3_BIO_LABELS`` (33) — v0.6.0 ship, the CURRENT active set.
  Decomposes ``street`` into prefix/suffix and adds unit/po_box/intersection.
- ``STAGE4_TAGS`` (23 tags) / ``STAGE4_BIO_LABELS`` (47) — the secondary-address family
  (#1100/#456): unit/level/building designator↔id pairs + entrance/staircase. DEFINED but NOT
  active; activation is coupled to a retrain + the JS union bump (see the Stage 4 block below).

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

# --- Stage 4: secondary-address family (#1100 / #456) — DEFINED, NOT YET ACTIVE ------
#
# The secondary-address vertical axis: designator/id pairs for units, levels (floors), and buildings,
# plus the EU entrance/staircase forms (USPS Pub-28 C2 + the codex level-semantics table already ship
# the reference data). Modeled as designator↔id pairs mirroring the street prefix/suffix split:
#
#   "STE 200"     -> unit_designator="STE"  + (existing) unit="200"   (unit is the bare id, #456)
#   "FL 3" / "3F" -> level_designator="FL"  + level_id="3"
#   "BLDG B"      -> building_designator="BLDG" + building_id="B"
#   "Eingang 2"   -> entrance="Eingang 2" ; "Stiege 4" -> staircase="Stiege 4"
#
# The existing STAGE3 ``unit`` tag is deliberately KEPT as the bare unit-id role rather than renamed to
# ``unit_id`` — a rename would rewrite every ``unit``-labeled corpus row. A ``unit`` → ``unit_id``
# rename, plus reconciling the JP ``building_number``/``building_name`` declarations against
# ``building_designator``/``building_id``, is a version-gated batch for the activation bump, not
# piecemeal here (same discipline as the #875 casing batch).
#
# ACTIVATION (coupled, deliberately deferred — rides the v7-adjacent label-stage bump): bumping
# ACTIVE_* to STAGE4 widens the model head 33 → 47 labels, so it REQUIRES a retrain (from-scratch or
# an output-head expansion) AND a same-commit extension of the JS ``COMPONENT_TAGS`` union in
# ``core/types/component.ts`` (the decoder maps model indices → labels through it — they must move
# together). Until then ACTIVE stays STAGE3 and these tags collapse to ``O`` at load, so defining them
# now is inert for live models and lets the parser shard emit them.
STAGE4_FINE_TAGS: Final[tuple[str, ...]] = (
    "unit_designator",
    "level_designator",
    "level_id",
    "building_designator",
    "building_id",
    "entrance",
    "staircase",
)

STAGE4_TAGS: Final[tuple[str, ...]] = STAGE3_TAGS + STAGE4_FINE_TAGS

STAGE4_BIO_LABELS: Final[tuple[str, ...]] = (
    "O",
    *(prefix + tag for tag in STAGE4_TAGS for prefix in ("B-", "I-")),
)

# --- JP fine tags (v8 CJK Phase 2 — schema activation) --------------------------------
#
# The seven JP-specific tags SCHEMA.mdx declares (mirrored in core/types/component.ts, where they
# have sat as forward-compat declarations since Phase 0): the admin ladder (prefecture 都道府県,
# municipality 市区町村, district 大字/丁目-level name) and the kanji-designator number parts
# (block 丁目, sub_block 番地, building_number 号) + building_name (romaji buildings). Per the
# encoder-design D4 rule, COMPACT numbers (2-3-16) stay whole-span ``house_number`` — the fine
# number tags are for the long designator form (2丁目3番16号) only. NOT a universal stage: the JP
# CHAR model trains with ``stage3-jp``; the Latin model stays on STAGE3; STAGE4 (the
# secondary-address family above — numerically also 47 BIO, a coincidence) remains its own future
# activation.
JP_FINE_TAGS: Final[tuple[str, ...]] = (
    "prefecture",
    "municipality",
    "district",
    "block",
    "sub_block",
    "building_number",
    "building_name",
)

STAGE3_JP_TAGS: Final[tuple[str, ...]] = STAGE3_TAGS + JP_FINE_TAGS

STAGE3_JP_BIO_LABELS: Final[tuple[str, ...]] = (
    "O",
    *(prefix + tag for tag in STAGE3_JP_TAGS for prefix in ("B-", "I-")),
)

# --- Active set (points at the most-recent stage) ------------------------------------
# Bump to STAGE3 when training with v0.6.0 corpus. Until then, STAGE2 is active so
# existing v0.5.x models keep working. STAGE4 is DEFINED above but NOT active — its
# activation is coupled to a retrain + the JS union bump (see the Stage 4 block).

ACTIVE_TAGS: Final[tuple[str, ...]] = STAGE3_TAGS
ACTIVE_BIO_LABELS: Final[tuple[str, ...]] = STAGE3_BIO_LABELS

LABEL_TO_ID: Final[dict[str, int]] = {label: i for i, label in enumerate(ACTIVE_BIO_LABELS)}
ID_TO_LABEL: Final[dict[int, str]] = {i: label for label, i in LABEL_TO_ID.items()}


# --- Per-config label sets (v8 CJK Phase 2) -------------------------------------------
#
# The label vocabulary became per-MODEL when the JP sibling model activated (the JP head is 47
# labels while the Latin head stays 33). ``resolve_label_set`` is the single lookup; the module
# globals above remain the STAGE3 default so every existing consumer is byte-identical. A consumer
# that supports only the default must RAISE on a non-default set, never silently collapse (the
# #1349 lesson: a label-space mismatch that zero-fills is invisible until fingerprinted).
class LabelSet:
    """One model's label vocabulary: tags, BIO labels, and the derived id maps."""

    def __init__(self, name: str, tags: tuple[str, ...], bio_labels: tuple[str, ...]) -> None:
        self.name = name
        self.tags = tags
        self.bio_labels = bio_labels
        self.label_to_id = {label: i for i, label in enumerate(bio_labels)}
        self.id_to_label = {i: label for label, i in self.label_to_id.items()}
        self._tag_set = frozenset(tags)

    def collapse_label(self, bio_label: str) -> str:
        """``collapse_label`` against THIS set's tag vocabulary (same shape rules as the module fn)."""
        if bio_label == "O" or "-" not in bio_label:
            return "O"
        prefix, tag = bio_label.split("-", 1)
        if tag not in self._tag_set or prefix not in ("B", "I"):
            return "O"
        return bio_label


_LABEL_SETS: Final[dict[str, tuple[tuple[str, ...], tuple[str, ...]]]] = {
    "stage3": (STAGE3_TAGS, STAGE3_BIO_LABELS),
    "stage3-jp": (STAGE3_JP_TAGS, STAGE3_JP_BIO_LABELS),
    "stage4": (STAGE4_TAGS, STAGE4_BIO_LABELS),
}


def resolve_label_set(name: str = "stage3") -> LabelSet:
    if name not in _LABEL_SETS:
        raise ValueError(f"unknown label_set {name!r} (expected one of {sorted(_LABEL_SETS)})")
    tags, bio = _LABEL_SETS[name]
    return LabelSet(name, tags, bio)


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
