"""Address-system conventions — the train-time half of the conventions mask (#478).

The inference mask (codex/address-system-conventions.ts + neural/span decode) FORBIDS tags that
are ungrammatical in a detected system; this module supplies the TRAIN-TIME pairing: on rows whose
gold country has a conventions row, the forbidden label columns are masked out of the CE loss
(logits to -1e9 → softmax excludes them), so the model learns "this context → these tags do not
exist" instead of merely being decode-blocked. The v0.9.13 choreography lesson says the pairing is
load-bearing; this is the same discipline applied to grammar.

MIRROR CONTRACT: the table below mirrors ``codex/address-system-conventions.ts`` (the provenance-
carrying source of truth). Rows are added there first, with evidence; this mirror follows. Same
never-drift discipline as ``LOCALE_COUNTRIES`` (labels.py) — the locale-id indexing depends on it.
"""

from __future__ import annotations

import torch

from .labels import LOCALE_COUNTRIES

# ISO-2 country → component tags that are ungrammatical in that address system.
# fr: street types are LEADING particles (NF Z 10-011) — and the corpus labels those particles as
# street_PREFIX ("Rue"/"Avenue"/"Boulevard" → street_prefix 98-100% of the time, 28.6% of the FR street
# family). So FR DOES use street_prefix; only street_SUFFIX has no French counterpart (0.00% in the base).
# The old ("street_prefix", "street_suffix") forbid broke the v1.6.0 run: with use_conventions_loss_mask
# on, it -inf'd the boundary shard's gold FR street_prefix ("Rue" → street_prefix) and exploded
# train_loss to ~7M (killed at step 2000). Verified against the v0.5.0 FR/ban shards, 2026-06-18.
CONVENTIONS_FORBIDDEN_TAGS: dict[str, tuple[str, ...]] = {
    "FR": ("street_suffix",),
}


def build_forbidden_mask(label2id: dict[str, int], num_labels: int) -> torch.Tensor:
    """(NUM_LOCALES, num_labels) float mask — 1.0 where the label is forbidden for that locale.

    Indexed by the locale-head class id (labels.LOCALE_COUNTRIES order). Locales without a
    conventions row are all-zero; unmapped rows (IGNORE_INDEX) must be clamped to a zero row by
    the caller. B- and I- variants of each forbidden tag are both masked.
    """
    mask = torch.zeros(len(LOCALE_COUNTRIES), num_labels, dtype=torch.float32)
    for locale_idx, country in enumerate(LOCALE_COUNTRIES):
        for tag in CONVENTIONS_FORBIDDEN_TAGS.get(country, ()):
            for prefix in ("B-", "I-"):
                label_id = label2id.get(f"{prefix}{tag}")
                if label_id is not None:
                    mask[locale_idx, label_id] = 1.0
    return mask
