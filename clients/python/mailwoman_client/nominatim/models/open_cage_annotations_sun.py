from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.open_cage_annotations_sun_rise import OpenCageAnnotationsSunRise
    from ..models.open_cage_annotations_sun_set import OpenCageAnnotationsSunSet


T = TypeVar("T", bound="OpenCageAnnotationsSun")


@_attrs_define
class OpenCageAnnotationsSun:
    """
    Attributes:
        rise (OpenCageAnnotationsSunRise | Unset):
        set_ (OpenCageAnnotationsSunSet | Unset):
    """

    rise: OpenCageAnnotationsSunRise | Unset = UNSET
    set_: OpenCageAnnotationsSunSet | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        rise: dict[str, Any] | Unset = UNSET
        if not isinstance(self.rise, Unset):
            rise = self.rise.to_dict()

        set_: dict[str, Any] | Unset = UNSET
        if not isinstance(self.set_, Unset):
            set_ = self.set_.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({})
        if rise is not UNSET:
            field_dict["rise"] = rise
        if set_ is not UNSET:
            field_dict["set"] = set_

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.open_cage_annotations_sun_rise import OpenCageAnnotationsSunRise
        from ..models.open_cage_annotations_sun_set import OpenCageAnnotationsSunSet

        d = dict(src_dict)
        _rise = d.pop("rise", UNSET)
        rise: OpenCageAnnotationsSunRise | Unset
        if isinstance(_rise, Unset):
            rise = UNSET
        else:
            rise = OpenCageAnnotationsSunRise.from_dict(_rise)

        _set_ = d.pop("set", UNSET)
        set_: OpenCageAnnotationsSunSet | Unset
        if isinstance(_set_, Unset):
            set_ = UNSET
        else:
            set_ = OpenCageAnnotationsSunSet.from_dict(_set_)

        open_cage_annotations_sun = cls(
            rise=rise,
            set_=set_,
        )

        open_cage_annotations_sun.additional_properties = d
        return open_cage_annotations_sun

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
