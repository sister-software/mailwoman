"""The shared semantic tag registry: one global identity per address concept, across every model family.

A label set (``stage3``, ``stage3-cjk``, ...) is a model family's head vocabulary. Its head indices are
positions in that set, and two sets may place the same tag at different indices: ``locality_unit`` is
head tag 16 in ``stage3-cn`` and head tag 23 in ``stage3-cjk``. The tag's *semantic* identity is its
entry here, and it is the same in both.

Script and locale choose a family, a tokenizer and priors. They do not choose what a tag means. A
romanized Japanese address and its kanji rendering carry the same concepts: ``Tokyo`` and ``東京都`` are
both ``prefecture`` (``docs/engineering/reference/SCHEMA.mdx`` gives both as examples). A family whose
head lacks ``prefecture`` emits the concept the schema says it refines, ``region``, and a family with
no documented equivalent reports the concept as unrepresentable rather than writing ``O``.

Rules for this module:

- ``SEMANTIC_TAGS`` is append-only. A tag's global id is its index and never changes.
- ``REFINES`` maps a fine tag to the shared tag that carries the same concept at coarser grain, and
  only where SCHEMA.mdx states the relation. A tag with no documented coarser equivalent is absent,
  so a family without it reports the tag instead of guessing.
- ``SEMANTIC_TAG_REGISTRY_VERSION`` increments whenever ``SEMANTIC_TAGS`` or ``REFINES`` changes, and
  every model card records it beside ``label_set`` and ``head_mapping``.
"""

from __future__ import annotations

from collections import Counter
from typing import Final

from .labels import (
    CN_FINE_TAGS,
    JP_FINE_TAGS,
    STAGE3_TAGS,
    STAGE4_FINE_TAGS,
    LabelSet,
    resolve_label_set,
    split_bio,
)

SEMANTIC_TAG_REGISTRY_VERSION: Final[int] = 1

# The JS ``COMPONENT_TAGS`` union in ``packages/codex/lib/component.ts`` declares two tags no Python
# label set trains: ``street_prefix_particle`` and ``attention``. They are registered here so the
# registry covers both languages' vocabularies and the parity test can compare them.
JS_ONLY_TAGS: Final[tuple[str, ...]] = ("street_prefix_particle", "attention")

SEMANTIC_TAGS: Final[tuple[str, ...]] = (
    *STAGE3_TAGS,
    *JP_FINE_TAGS,
    *CN_FINE_TAGS,
    *STAGE4_FINE_TAGS,
    *JS_ONLY_TAGS,
)

SEMANTIC_TAG_ID: Final[dict[str, int]] = {tag: i for i, tag in enumerate(SEMANTIC_TAGS)}

# Each entry cites the SCHEMA.mdx statement it rests on.
REFINES: Final[dict[str, str]] = {
    # "JP first-level admin (都道府県)": the first-level administrative unit is `region` elsewhere.
    "prefecture": "region",
    # "JP city/ward (市区町村)": the city is `locality`.
    "municipality": "locality",
    # "JP district (大字)": the named area below the city is `dependent_locality`.
    "district": "dependent_locality",
    # Encoder-design rule D4: the compact number `2-3-16` is one `house_number` span, and
    # `block`/`sub_block`/`building_number` label the parts of the same number in its long form.
    "block": "house_number",
    "sub_block": "house_number",
    "building_number": "house_number",
}

# Tags with no documented coarser equivalent, recorded so the omission from REFINES is a statement.
# `locality_unit`: SCHEMA.mdx says "the universal tags cannot represent" the CN organizational ladder.
# `building_name`: SCHEMA.mdx defines a JP named building without stating its Latin-head equivalent.
# The STAGE4 secondary-address tags and the two JS-only tags: no schema statement maps them onto STAGE3.
UNREFINED: Final[frozenset[str]] = frozenset({"locality_unit", "building_name", *STAGE4_FINE_TAGS, *JS_ONLY_TAGS})


def head_mapping(label_set: LabelSet) -> tuple[int, ...]:
    """The global semantic id of each head tag, in head order.

    Raises when the label set carries a tag the registry does not know, which is how a new tag that
    skipped registration is caught.
    """
    unknown = [tag for tag in label_set.tags if tag not in SEMANTIC_TAG_ID]
    if unknown:
        raise ValueError(f"label set {label_set.name!r} carries unregistered tags {unknown}")
    return tuple(SEMANTIC_TAG_ID[tag] for tag in label_set.tags)


def label_set_contract(name: str) -> dict[str, object]:
    """The block a model card or build manifest pins: label set, registry version and head mapping."""
    label_set = resolve_label_set(name)
    return {
        "label_set_id": label_set.name,
        "semantic_tag_registry_version": SEMANTIC_TAG_REGISTRY_VERSION,
        "head_mapping": list(head_mapping(label_set)),
        "head_tags": list(label_set.tags),
    }


def project_tag(tag: str, label_set: LabelSet) -> str | None:
    """The tag ``label_set`` emits for the concept ``tag``, or None when the family cannot represent it.

    A tag the head carries is returned unchanged. A refined tag the head lacks walks ``REFINES`` to
    the first ancestor the head carries.
    """
    current: str | None = tag
    while current is not None:
        if current in label_set.tags:
            return current
        current = REFINES.get(current)
    return None


class ProjectionLedger:
    """Counts of what projecting labels into one family changed and what it could not represent.

    A loader that projects through this ledger can report, per run, how many spans of each concept
    became a coarser tag and how many the family could not emit. The second count is the one
    invariant 6 of the decoder-exposure plan forbids leaving silent.
    """

    def __init__(self, label_set: LabelSet) -> None:
        self.label_set = label_set
        self.projected: Counter[tuple[str, str]] = Counter()
        self.unrepresentable: Counter[str] = Counter()

    def project_label(self, bio_label: str) -> str:
        """A BIO label rewritten into the family's head, counting every rewrite and every refusal."""
        parts = split_bio(bio_label)
        if parts is None:
            return "O"
        prefix, tag = parts
        target = project_tag(tag, self.label_set) if tag in SEMANTIC_TAG_ID else None
        if target is None:
            self.unrepresentable[tag] += 1
            return "O"
        if target != tag:
            self.projected[(tag, target)] += 1
        return f"{prefix}-{target}"

    def project_sequence(self, bio_labels: list[str]) -> list[str]:
        """Project a row's labels, merging adjacent spans that refine the same target into one span.

        ``2丁目3番16号`` is three spans (``block``, ``sub_block``, ``building_number``) on a head that has
        them and one ``house_number`` span on a head that does not, which is how rule D4 labels the
        compact form ``2-3-16``. A span that projects to the target it already carries is never merged
        with its neighbor, so two adjacent ``street`` spans stay two.
        """
        out: list[str] = []
        previous_source: str | None = None
        for label in bio_labels:
            projected = self.project_label(label)
            parts = split_bio(label)
            source = parts[1] if parts is not None else None
            if (
                projected.startswith("B-")
                and out
                and out[-1] != "O"
                and out[-1][2:] == projected[2:]
                and source != projected[2:]
                and previous_source is not None
                and previous_source != source
                and previous_source != projected[2:]
            ):
                projected = "I-" + projected[2:]
            out.append(projected)
            previous_source = source if projected != "O" else None
        return out

    def report(self) -> dict[str, object]:
        return {
            **label_set_contract(self.label_set.name),
            "projected": {f"{a}->{b}": n for (a, b), n in sorted(self.projected.items())},
            "unrepresentable": dict(sorted(self.unrepresentable.items())),
        }
