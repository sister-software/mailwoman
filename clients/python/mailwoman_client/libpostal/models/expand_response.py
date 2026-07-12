from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define

T = TypeVar("T", bound="ExpandResponse")


@_attrs_define
class ExpandResponse:
    """The `/expand` response.

    Attributes:
        expansions (list[str]): The distinct expanded forms (original + normalized + abbreviation-expanded), order
            preserved.
    """

    expansions: list[str]

    def to_dict(self) -> dict[str, Any]:
        expansions = self.expansions

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "expansions": expansions,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        expansions = cast(list[str], d.pop("expansions"))

        expand_response = cls(
            expansions=expansions,
        )

        return expand_response
