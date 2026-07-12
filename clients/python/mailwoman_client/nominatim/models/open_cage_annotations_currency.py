from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

T = TypeVar("T", bound="OpenCageAnnotationsCurrency")


@_attrs_define
class OpenCageAnnotationsCurrency:
    """
    Attributes:
        iso_code (str | Unset):
        name (str | Unset):
        symbol (str | Unset):
    """

    iso_code: str | Unset = UNSET
    name: str | Unset = UNSET
    symbol: str | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        iso_code = self.iso_code

        name = self.name

        symbol = self.symbol

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({})
        if iso_code is not UNSET:
            field_dict["iso_code"] = iso_code
        if name is not UNSET:
            field_dict["name"] = name
        if symbol is not UNSET:
            field_dict["symbol"] = symbol

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        iso_code = d.pop("iso_code", UNSET)

        name = d.pop("name", UNSET)

        symbol = d.pop("symbol", UNSET)

        open_cage_annotations_currency = cls(
            iso_code=iso_code,
            name=name,
            symbol=symbol,
        )

        open_cage_annotations_currency.additional_properties = d
        return open_cage_annotations_currency

    @property
    def additional_keys(self) -> list[str]:
        return list(self.additional_properties.keys())

    def __getitem__(self, key: str) -> Any:
        return self.additional_properties[key]

    def __setitem__(self, key: str, value: Any) -> None:
        self.additional_properties[key] = value

    def __delitem__(self, key: str) -> None:
        del self.additional_properties[key]

    def __contains__(self, key: str) -> bool:
        return key in self.additional_properties
