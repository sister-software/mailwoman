"""The emit step: turn one sampled row into the rows a consumer actually reads.

WHY THIS IS ITS OWN MODULE. Two policies apply between the sampler and the consumer — augmentation
(with a per-source opt-out) and affix relabelling — and they have to be applied in that ORDER, because
relabel must see the label-inheriting directional expansions augmentation produces (#511). Expressing
that twice is what #2243 was: `data_loader` applied the exclusion and `audit_epoch_mixture` did not, so
the audit reported an excluded source with the emitted count it would have had if it were augmented. The
two call sites had matching augment probabilities and a matching call to `augment_row`; they diverged at
the branch a shared constant cannot express, which is the failure mode AGENTS.md describes — when two
copies must agree, share the FUNCTION.

It cannot live in `augment.py`, because `relabel.py` imports that module and the cycle would close. It
imports both instead, and every consumer imports it.

`EmitPolicy` carries the decision rather than ten positional arguments, so a new policy reaches both
call sites by construction instead of by someone remembering the second one.
"""

from __future__ import annotations

import random
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

from .augment import augment_row
from .relabel import AffixRelabelLexicon, relabel_row


@dataclass(frozen=True)
class EmitPolicy:
    """Everything that decides what one sampled row becomes.

    The seven probabilities are `augment_row`'s, in its argument order. `excluded_sources` names the
    sources that bypass augmentation entirely: copies of an oversampled source compound its repetition
    without adding diversity (2026-08-10). The relabel still applies to an excluded source — the two
    policies are independent, and that independence is the part a reimplementation loses.
    """

    directional_prob: float = 0.0
    region_prob: float = 0.0
    glue_prob: float = 0.0
    case_prob: float = 0.0
    punct_drop_prob: float = 0.0
    upper_case_prob: float = 0.0
    ordinal_prob: float = 0.0
    excluded_sources: frozenset[str] = field(default_factory=frozenset)
    relabel_lexicon: AffixRelabelLexicon | None = None

    @property
    def augments(self) -> bool:
        """Whether any augmentation probability is live. All-zero means the row passes through."""
        return any(
            probability > 0
            for probability in (
                self.directional_prob,
                self.region_prob,
                self.glue_prob,
                self.case_prob,
                self.punct_drop_prob,
                self.upper_case_prob,
                self.ordinal_prob,
            )
        )

    def augments_source(self, source: str) -> bool:
        """Whether a row from ``source`` is augmented, which is the check the audit used to skip."""
        return self.augments and source not in self.excluded_sources


def emit_row(row: dict[str, Any], rng: random.Random, policy: EmitPolicy) -> Iterator[dict[str, Any]]:
    """Yield the rows one sampled ``row`` becomes under ``policy``.

    Relabel runs AFTER augmentation so label-inheriting directional expansions are caught (#511 — see
    relabel.py). `augment_row` yields fresh dicts but shares the labels list with the source row on the
    no-op path, so relabel copies before mutating.
    """
    if policy.augments_source(row["source"]):
        for augmented in augment_row(
            row,
            rng,
            policy.directional_prob,
            policy.region_prob,
            policy.glue_prob,
            policy.case_prob,
            policy.punct_drop_prob,
            policy.upper_case_prob,
            policy.ordinal_prob,
        ):
            if policy.relabel_lexicon is not None:
                augmented = {**augmented, "labels": list(augmented["labels"])}
                relabel_row(augmented, policy.relabel_lexicon)
            yield augmented
    elif policy.relabel_lexicon is not None:
        row = {**row, "labels": list(row["labels"])}
        relabel_row(row, policy.relabel_lexicon)
        yield row
    else:
        yield row
