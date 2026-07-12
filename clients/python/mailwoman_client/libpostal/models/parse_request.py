from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..types import UNSET, Unset

T = TypeVar("T", bound="ParseRequest")


@_attrs_define
class ParseRequest:
    """A `/parse` request body. Provide `query` (or its alias `address`).

    Attributes:
        query (str | Unset): The address to parse.
        address (str | Unset): Alias for `query`.
    """

    query: str | Unset = UNSET
    address: str | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        query = self.query

        address = self.address

        field_dict: dict[str, Any] = {}

        field_dict.update({})
        if query is not UNSET:
            field_dict["query"] = query
        if address is not UNSET:
            field_dict["address"] = address

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        query = d.pop("query", UNSET)

        address = d.pop("address", UNSET)

        parse_request = cls(
            query=query,
            address=address,
        )

        return parse_request
