"""Label set + helpers for the mailwoman neural classifier.

Mirrors the JS-side ``COMPONENT_TAGS`` / ``BIO_LABELS`` in
``packages/core/core/types/component.ts``. Any tag outside ``ACTIVE_TAGS`` is rewritten
to ``O`` at data-load time (see ``data_loader.collapse_to_active``).

Older STAGE-N constants are kept exportable so historical checkpoints and eval reports can be
diffed against today's labels. ``ACTIVE_TAGS`` / ``ACTIVE_BIO_LABELS`` point at the current
training round's vocabulary: bump them together with a new STAGE-N constant and never mutate an
older STAGE-N constant.

Keep ``ACTIVE_TAGS`` in sync with the JS ``ComponentTag`` union. If a new tag lands in
``component.ts``, add it to a new STAGE-N constant in the same commit and shift ``ACTIVE_*``.
"""

from __future__ import annotations

from typing import Final

# region Historical coarse-only tags


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

# endregion

# region Coarse + fine tags


# Order is stable across runs so label IDs are reproducible within a stage: never reorder, always append.
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

# endregion

# region Street decomposition + PO box + intersection


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

# endregion

# region Secondary-address family (defined, not yet active)

# The secondary-address vertical axis: designator/id pairs for units, levels (floors), and buildings,
# plus the EU entrance/staircase forms (USPS Pub-28 C2 and the codex level-semantics table ship the
# reference data). Modeled as designator↔id pairs mirroring the street prefix/suffix split:
#
#   "STE 200"     -> unit_designator="STE"  + (existing) unit="200"   (unit is the bare id)
#   "FL 3" / "3F" -> level_designator="FL"  + level_id="3"
#   "bldg B"      -> building_designator="bldg" + building_id="B"
#   "Eingang 2"   -> entrance="Eingang 2" ; "Stiege 4" -> staircase="Stiege 4"
#
# The existing STAGE3 ``unit`` tag stays the bare unit-id role rather than being renamed to
# ``unit_id``, because a rename would rewrite every ``unit``-labeled corpus row. That rename, and
# reconciling the JP ``building_number``/``building_name`` declarations against
# ``building_designator``/``building_id``, is a version-conditional batch for the activation bump
# rather than piecemeal here.
#
# Bumping ACTIVE_* to STAGE4 widens the model head 33 → 47 labels, so activation requires a retrain
# (from-scratch or an output-head expansion) and a same-commit extension of the JS ``COMPONENT_TAGS``
# union in ``core/types/component.ts`` (the decoder maps model indices → labels through it, so they
# must move together). Until then active stays STAGE3 and these tags collapse to ``O`` at load, so
# defining them now is inert for live models and lets the secondary-address recipe emit them.
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

# endregion

# region JP fine tags

# The seven JP-specific tags schema.mdx declares (mirrored in core/types/component.ts): the admin
# ladder (prefecture 都道府県, municipality 市区町村, district 大字/丁目-level name) and the
# kanji-designator number parts (block 丁目, sub_block 番地, building_number 号) + building_name
# (romaji buildings). Per the encoder-design D4 rule, compact numbers (2-3-16) stay whole-span
# ``house_number`` — the fine number tags are for the long designator form (2丁目3番16号) only.
# The JP char model trains with ``stage3-jp``; the Latin model stays on STAGE3.
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

# endregion

# region CN fine tags (the organizational ladder)

# One tag, ``locality_unit``, for the whole ordinal chain China's rural and state-farm addresses
# carry below the named settlement (``三分场八队``: No. 3 sub-farm, No. 8 production team; the xpcc
# ``一四三团十二连``; the villager group ``民权三组``). Which rung each generic names is a deterministic
# reading of the suffix (``分场``/``大队``/``队``/``连``/``团``/``组``), done after decode by
# ``@mailwoman/core``'s CN unit reader, so the label set does not grow with every ladder found.
# The named head unit (``孟定农场``) is ``dependent_locality``. Mirrors ``core/types/component.ts``
# and schema.mdx; like ``stage3-jp``, the Latin model never trains on it.
CN_FINE_TAGS: Final[tuple[str, ...]] = ("locality_unit",)

STAGE3_CN_TAGS: Final[tuple[str, ...]] = STAGE3_TAGS + CN_FINE_TAGS

STAGE3_CN_BIO_LABELS: Final[tuple[str, ...]] = (
    "O",
    *(prefix + tag for tag in STAGE3_CN_TAGS for prefix in ("B-", "I-")),
)

# endregion

# region CJK union (one head for the JP and CN character models)

# The JP seven and the CN one behind one classifier, so a single from-scratch character model can
# train on the JP corpus and the CN organizational-unit rows together. STAGE3 keeps its ids and the
# JP tags keep theirs (this is ``stage3-jp`` with ``locality_unit`` appended), so a JP-only consumer
# reading a CJK checkpoint sees every JP label at the id it already knows.
CJK_FINE_TAGS: Final[tuple[str, ...]] = JP_FINE_TAGS + CN_FINE_TAGS

STAGE3_CJK_TAGS: Final[tuple[str, ...]] = STAGE3_TAGS + CJK_FINE_TAGS

STAGE3_CJK_BIO_LABELS: Final[tuple[str, ...]] = (
    "O",
    *(prefix + tag for tag in STAGE3_CJK_TAGS for prefix in ("B-", "I-")),
)

# endregion

# region Active set (points at the most-recent stage)

ACTIVE_TAGS: Final[tuple[str, ...]] = STAGE3_TAGS
ACTIVE_BIO_LABELS: Final[tuple[str, ...]] = STAGE3_BIO_LABELS

LABEL_TO_ID: Final[dict[str, int]] = {label: i for i, label in enumerate(ACTIVE_BIO_LABELS)}
ID_TO_LABEL: Final[dict[int, str]] = {i: label for label, i in LABEL_TO_ID.items()}


# endregion

# region Per-config label sets


# The label vocabulary is per-model (the JP head is 47 labels while the Latin head stays 33).
# ``resolve_label_set`` is the single lookup; the module globals above remain the STAGE3 default so
# every existing consumer is byte-identical. A consumer that supports only the default must raise on
# a non-default set, never silently collapse: a label-space mismatch that zero-fills is invisible
# until fingerprinted.
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
        """Collapse against this set's tag vocabulary, with the module function's shape rules."""
        if bio_label == "O" or "-" not in bio_label:
            return "O"
        prefix, tag = bio_label.split("-", 1)
        if tag not in self._tag_set or prefix not in ("B", "I"):
            return "O"
        return bio_label


_LABEL_SETS: Final[dict[str, tuple[tuple[str, ...], tuple[str, ...]]]] = {
    "stage3": (STAGE3_TAGS, STAGE3_BIO_LABELS),
    "stage3-jp": (STAGE3_JP_TAGS, STAGE3_JP_BIO_LABELS),
    "stage3-cn": (STAGE3_CN_TAGS, STAGE3_CN_BIO_LABELS),
    "stage3-cjk": (STAGE3_CJK_TAGS, STAGE3_CJK_BIO_LABELS),
    "stage4": (STAGE4_TAGS, STAGE4_BIO_LABELS),
}


def resolve_label_set(name: str = "stage3") -> LabelSet:
    if name not in _LABEL_SETS:
        raise ValueError(f"unknown label_set {name!r} (expected one of {sorted(_LABEL_SETS)})")
    tags, bio = _LABEL_SETS[name]
    return LabelSet(name, tags, bio)


# Labels that mean "ignore" in cross-entropy. The HF Trainer treats ``-100`` as the sentinel.
IGNORE_INDEX: Final[int] = -100

# endregion

# region Locale conditioning (self-conditioning)

# Country (ISO 3166-1 alpha-2) → locale class id for the auxiliary self-conditioning head.
# The head predicts which country an address belongs to from the pooled sequence, and it is the
# LocalePosterior the resolver consumes. The posterior does not feed the FiLM path: model.py sends
# the same pooled vector through a sibling projection, so the aux loss shapes what both read rather
# than one selecting the other.
#
# Stable order: never reorder, only append, so a checkpoint's locale-head ids stay reproducible. A
# row whose ``country`` is absent from this map maps to IGNORE_INDEX and contributes no gradient to
# the aux loss. The head still carries a slot for every entry here.
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
    """Rewrite a BIO label to its active-set equivalent, or ``O``."""
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

    The check drops rows with no usable supervision at all rather than enforcing a particular
    schema shape; a row with only fine tags still contributes.
    """
    return bool(set(components_keys) & set(ACTIVE_TAGS))


coarse_components_present = active_components_present
