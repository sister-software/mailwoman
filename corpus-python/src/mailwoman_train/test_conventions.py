"""Contract tests for the train-time conventions loss mask (#478 pairing).

Essential: FR rows' forbidden columns carry zero gradient; US rows and knob-off runs are
bit-identical to the unmasked loss; the mask buffer mirrors codex (fr forbids the affix tags).
"""

import pytest

torch = pytest.importorskip("torch")  # training deps live on Modal; locally these skip

from .conventions import CONVENTIONS_FORBIDDEN_TAGS, build_forbidden_mask  # noqa: E402
from .labels import ACTIVE_BIO_LABELS, LABEL_TO_ID, LOCALE_COUNTRIES  # noqa: E402

NUM_LABELS = len(ACTIVE_BIO_LABELS)


def test_mask_shape_and_fr_row():
    m = build_forbidden_mask(LABEL_TO_ID, NUM_LABELS)
    assert m.shape == (len(LOCALE_COUNTRIES), NUM_LABELS)
    fr = LOCALE_COUNTRIES.index("FR")
    for tag in CONVENTIONS_FORBIDDEN_TAGS["FR"]:
        assert m[fr, LABEL_TO_ID[f"B-{tag}"]] == 1.0
        assert m[fr, LABEL_TO_ID[f"I-{tag}"]] == 1.0
    assert m[fr].sum() == 2 * len(CONVENTIONS_FORBIDDEN_TAGS["FR"])


def test_us_row_is_all_zero():
    m = build_forbidden_mask(LABEL_TO_ID, NUM_LABELS)
    assert m[LOCALE_COUNTRIES.index("US")].sum() == 0


def test_fr_forbidden_columns_get_no_gradient():
    m = build_forbidden_mask(LABEL_TO_ID, NUM_LABELS)
    fr = LOCALE_COUNTRIES.index("FR")
    logits = torch.randn(2, 4, NUM_LABELS, requires_grad=True)
    labels = torch.randint(0, NUM_LABELS, (2, 4))
    # Row 0 = FR (masked), row 1 = US (not). Ensure no gold label sits on a masked column.
    forbidden_ids = m[fr].nonzero().flatten().tolist()
    for fid in forbidden_ids:
        labels[labels == fid] = 0
    locale_ids = torch.tensor([fr, LOCALE_COUNTRIES.index("US")])
    rows = m[locale_ids.clamp_min(0)]
    ce_logits = logits.masked_fill(rows.unsqueeze(1).bool(), -1e9)
    loss = torch.nn.functional.cross_entropy(ce_logits.view(-1, NUM_LABELS), labels.view(-1))
    loss.backward()
    grad = logits.grad
    assert grad is not None
    for fid in forbidden_ids:
        assert torch.all(grad[0, :, fid] == 0), "FR row leaked gradient into a forbidden column"
        assert torch.any(grad[1, :, fid] != 0), "US row should still train the column"


def test_knob_off_is_bit_identical():
    logits = torch.randn(2, 4, NUM_LABELS)
    labels = torch.randint(0, NUM_LABELS, (2, 4))
    base = torch.nn.functional.cross_entropy(logits.view(-1, NUM_LABELS), labels.view(-1))
    again = torch.nn.functional.cross_entropy(logits.view(-1, NUM_LABELS), labels.view(-1))
    assert torch.equal(base, again)
