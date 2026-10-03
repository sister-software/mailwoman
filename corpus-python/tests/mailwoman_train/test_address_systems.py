"""The address-system registry, the head trained against it, and the locale hint."""

from __future__ import annotations

import torch

from mailwoman_train.address_systems import address_system_for_country, address_system_id, num_address_systems
from mailwoman_train.labels import IGNORE_INDEX
from mailwoman_train.nn.encoder import MailwomanCoarseEncoder
from mailwoman_train.nn.encoder.address_system import training_hint_ids


def _model(**flags: object) -> MailwomanCoarseEncoder:
    torch.manual_seed(0)
    return MailwomanCoarseEncoder(
        vocab_size=64,
        hidden_size=16,
        num_hidden_layers=1,
        num_attention_heads=2,
        intermediate_size=32,
        max_position_embeddings=12,
        hidden_dropout_prob=0.0,
        num_labels=5,
        pad_token_id=0,
        use_crf=False,
        use_locale_conditioning=True,
        locale_loss_weight=0.3,
        **flags,  # type: ignore[arg-type]
    )


def test_countries_with_the_same_component_order_share_a_system() -> None:
    # Germany and Austria both print the street before the house number and the postcode before the locality.
    assert address_system_for_country("DE", latin=False) == address_system_for_country("AT", latin=False)
    assert address_system_for_country("DE", latin=False) != address_system_for_country("US", latin=False)


def test_a_country_without_a_layout_has_no_system() -> None:
    assert address_system_id("GH", "Plot 12, Spintex Road, Accra") == IGNORE_INDEX
    assert address_system_id(None, "anything") == IGNORE_INDEX


def test_every_member_id_is_inside_the_head() -> None:
    assert 0 <= address_system_id("RU", "Тверская улица, 13, Москва") < num_address_systems()


def test_the_new_modules_leave_every_existing_parameter_where_it_was() -> None:
    plain = _model().state_dict()
    extended = _model(
        use_address_system_head=True, num_address_systems=9, address_system_loss_weight=0.3, use_locale_hint=True
    ).state_dict()
    assert all(torch.equal(plain[name], extended[name]) for name in plain)


def test_an_untrained_hint_changes_no_prediction() -> None:
    plain = _model().eval()
    hinted = _model(use_locale_hint=True, num_address_systems=9).eval()
    ids = torch.randint(1, 64, (3, 6))
    mask = torch.ones(3, 6, dtype=torch.long)
    with torch.no_grad():
        expected = plain(input_ids=ids, attention_mask=mask).logits
        given = hinted(input_ids=ids, attention_mask=mask, locale_hint_ids=torch.tensor([0, 4, 9])).logits
    assert torch.allclose(expected, given)


def test_the_head_adds_a_loss_term_and_skips_rows_without_a_system() -> None:
    model = _model(use_address_system_head=True, num_address_systems=9, address_system_loss_weight=1.0).train()
    ids = torch.randint(1, 64, (2, 6))
    mask = torch.ones(2, 6, dtype=torch.long)
    labels = torch.zeros(2, 6, dtype=torch.long)
    base = model(input_ids=ids, attention_mask=mask, labels=labels).loss
    none = model(
        input_ids=ids, attention_mask=mask, labels=labels, address_system_ids=torch.tensor([IGNORE_INDEX] * 2)
    ).loss
    some = model(input_ids=ids, attention_mask=mask, labels=labels, address_system_ids=torch.tensor([1, 5])).loss
    assert base is not None and none is not None and some is not None
    assert torch.allclose(base, none)
    assert float(some) > float(base)


def test_training_hints_drop_and_swap_at_their_rates() -> None:
    torch.manual_seed(0)
    systems = torch.full((20_000,), 3)
    hints = training_hint_ids(systems, num_systems=9, drop_prob=0.5, noise_prob=0.1)
    dropped = float((hints == 9).float().mean())
    swapped = float(((hints != 3) & (hints != 9)).float().mean())
    assert abs(dropped - 0.5) < 0.02
    assert abs(swapped - 0.1) < 0.01
    assert bool((hints[hints != 9] < 9).all())


def test_a_row_without_a_system_always_gets_no_hint() -> None:
    hints = training_hint_ids(torch.full((100,), IGNORE_INDEX), num_systems=9, drop_prob=0.0, noise_prob=0.5)
    assert bool((hints == 9).all())
