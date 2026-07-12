from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

T = TypeVar("T", bound="OpenCageAnnotationsTimezone")


@_attrs_define
class OpenCageAnnotationsTimezone:
    """
    Attributes:
        name (str | Unset):
        offset_sec (float | Unset):
        offset_string (str | Unset):
    """

    name: str | Unset = UNSET
    offset_sec: float | Unset = UNSET
    offset_string: str | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        name = self.name

        offset_sec = self.offset_sec

        offset_string = self.offset_string

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({})
        if name is not UNSET:
            field_dict["name"] = name
        if offset_sec is not UNSET:
            field_dict["offset_sec"] = offset_sec
        if offset_string is not UNSET:
            field_dict["offset_string"] = offset_string

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        name = d.pop("name", UNSET)

        offset_sec = d.pop("offset_sec", UNSET)

        offset_string = d.pop("offset_string", UNSET)

        open_cage_annotations_timezone = cls(
            name=name,
            offset_sec=offset_sec,
            offset_string=offset_string,
        )

        open_cage_annotations_timezone.additional_properties = d
        return open_cage_annotations_timezone

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
