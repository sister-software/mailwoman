from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

T = TypeVar("T", bound="ExpandRequest")


@_attrs_define
class ExpandRequest:
    """An `/expand` request body.

    Attributes:
        address (str): The address to expand.
    """

    address: str

    def to_dict(self) -> dict[str, Any]:
        address = self.address

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "address": address,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        address = d.pop("address")

        expand_request = cls(
            address=address,
        )

        return expand_request
