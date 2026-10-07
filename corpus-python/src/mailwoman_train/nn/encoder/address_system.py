"""The address-system head and the locale hint.

The address-system head predicts from the pooled encoder output which of the registry's address
systems (``address_systems.json``, one per component order in codex's layouts) the row's text follows.
Its cross-entropy is an auxiliary term: it pushes the grammar the row follows into the pooled vector
that ``locale_film`` reads. Countries that print the same components in the same order share a target,
so the term separates grammars rather than countries, and it covers every country with a layout.
``locale_head``'s nine-country target is unchanged beside it.

The locale hint is an optional input: an address-system id a caller already knows, such as the system of
the country a user is searching in. One learned vector per system, plus one for "no hint", is added to
every token before the encoder. The hint embedding starts at zero, so the model starts identical to one
without it. During training the row's own system is the hint, replaced by "no hint" with probability
``locale_hint_drop_prob`` and by a uniformly drawn other system with probability
``locale_hint_noise_prob``. The model therefore parses without a hint and treats a hint as evidence it
can overrule, because a user's country is not always the address's country.
"""

from __future__ import annotations

import torch
from torch import nn

from ...labels import IGNORE_INDEX
from .state import CoarseEncoderState


def training_hint_ids(
    address_system_ids: torch.Tensor,
    *,
    num_systems: int,
    drop_prob: float,
    noise_prob: float,
) -> torch.Tensor:
    """The hints a training batch sees: the row's system, dropped or swapped for another at the given rates.

    A row with no system (``IGNORE_INDEX``) always gets the "no hint" id, ``num_systems``.
    """
    no_hint = torch.full_like(address_system_ids, num_systems)
    hints = torch.where(address_system_ids == IGNORE_INDEX, no_hint, address_system_ids)
    draw = torch.rand(hints.shape, device=hints.device)
    if num_systems > 1:
        offset = torch.randint(1, num_systems, hints.shape, device=hints.device)
        swapped = (hints + offset) % num_systems
        hints = torch.where((draw < noise_prob) & (hints != num_systems), swapped, hints)
    return torch.where((draw >= noise_prob) & (draw < noise_prob + drop_prob), no_hint, hints)


class CoarseEncoderAddressSystem(CoarseEncoderState):
    """Builds, applies and supervises the address-system head and the locale hint."""

    def _build_address_system(
        self,
        *,
        hidden_size: int,
        use_address_system_head: bool,
        num_address_systems: int,
        address_system_loss_weight: float,
        use_locale_hint: bool,
        locale_hint_drop_prob: float,
        locale_hint_noise_prob: float,
    ) -> None:
        """Register and initialize both modules. The constructor calls this after `_init_weights`.

        The head takes the Xavier weights and zero bias `_init_weights` gives every other linear layer.
        The hint embedding starts at zero, so a model with the hint begins identical to one without it.
        """
        self.use_address_system_head = bool(use_address_system_head)
        self.num_address_systems = int(num_address_systems)
        self.address_system_loss_weight = float(address_system_loss_weight)
        self.use_locale_hint = bool(use_locale_hint)
        self.locale_hint_drop_prob = float(locale_hint_drop_prob)
        self.locale_hint_noise_prob = float(locale_hint_noise_prob)
        if (self.use_address_system_head or self.use_locale_hint) and self.num_address_systems < 1:
            raise ValueError("the address-system head and the locale hint need a registry with at least one system")
        self.address_system_head: nn.Linear | None = (
            nn.Linear(hidden_size, self.num_address_systems) if self.use_address_system_head else None
        )
        self.locale_hint_embedding: nn.Embedding | None = (
            nn.Embedding(self.num_address_systems + 1, hidden_size) if self.use_locale_hint else None
        )
        if self.address_system_head is not None:
            nn.init.xavier_uniform_(self.address_system_head.weight)
            nn.init.zeros_(self.address_system_head.bias)
        if self.locale_hint_embedding is not None:
            nn.init.zeros_(self.locale_hint_embedding.weight)

    def _apply_locale_hint(
        self,
        h: torch.Tensor,
        *,
        locale_hint_ids: torch.Tensor | None,
        address_system_ids: torch.Tensor | None,
    ) -> torch.Tensor:
        """Add the hint vector to every token. An absent hint reads as "no hint" outside training."""
        if self.locale_hint_embedding is None:
            return h
        if locale_hint_ids is None:
            if self.training and address_system_ids is not None:
                locale_hint_ids = training_hint_ids(
                    address_system_ids,
                    num_systems=self.num_address_systems,
                    drop_prob=self.locale_hint_drop_prob,
                    noise_prob=self.locale_hint_noise_prob,
                )
            else:
                locale_hint_ids = torch.full((h.shape[0],), self.num_address_systems, dtype=torch.long, device=h.device)
        hint: torch.Tensor = self.locale_hint_embedding(locale_hint_ids)
        return h + hint.to(h.dtype).unsqueeze(1)

    def _address_system_logits(self, pooled: torch.Tensor | None) -> torch.Tensor | None:
        if self.address_system_head is None or pooled is None:
            return None
        logits: torch.Tensor = self.address_system_head(pooled)
        return logits

    def _address_system_loss(
        self,
        loss: torch.Tensor | None,
        *,
        address_system_logits: torch.Tensor | None,
        address_system_ids: torch.Tensor | None,
    ) -> torch.Tensor | None:
        """Add the head's weighted cross-entropy. A batch whose rows all lack a system adds no term."""
        if (
            address_system_logits is None
            or address_system_ids is None
            or self.address_system_loss_weight <= 0
            or not bool((address_system_ids != IGNORE_INDEX).any())
        ):
            return loss
        term = self.address_system_loss_weight * nn.functional.cross_entropy(
            address_system_logits.float(), address_system_ids, ignore_index=IGNORE_INDEX
        )
        return term if loss is None else loss + term.to(loss.dtype)
