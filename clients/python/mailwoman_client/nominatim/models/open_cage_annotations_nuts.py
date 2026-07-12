from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.open_cage_annotations_nutsnuts0 import OpenCageAnnotationsNUTSNUTS0
    from ..models.open_cage_annotations_nutsnuts1 import OpenCageAnnotationsNUTSNUTS1
    from ..models.open_cage_annotations_nutsnuts2 import OpenCageAnnotationsNUTSNUTS2
    from ..models.open_cage_annotations_nutsnuts3 import OpenCageAnnotationsNUTSNUTS3


T = TypeVar("T", bound="OpenCageAnnotationsNUTS")


@_attrs_define
class OpenCageAnnotationsNUTS:
    """EU NUTS region codes (when the NUTS data bundle is present).

    Attributes:
        nuts0 (OpenCageAnnotationsNUTSNUTS0 | Unset):
        nuts1 (OpenCageAnnotationsNUTSNUTS1 | Unset):
        nuts2 (OpenCageAnnotationsNUTSNUTS2 | Unset):
        nuts3 (OpenCageAnnotationsNUTSNUTS3 | Unset):
    """

    nuts0: OpenCageAnnotationsNUTSNUTS0 | Unset = UNSET
    nuts1: OpenCageAnnotationsNUTSNUTS1 | Unset = UNSET
    nuts2: OpenCageAnnotationsNUTSNUTS2 | Unset = UNSET
    nuts3: OpenCageAnnotationsNUTSNUTS3 | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        nuts0: dict[str, Any] | Unset = UNSET
        if not isinstance(self.nuts0, Unset):
            nuts0 = self.nuts0.to_dict()

        nuts1: dict[str, Any] | Unset = UNSET
        if not isinstance(self.nuts1, Unset):
            nuts1 = self.nuts1.to_dict()

        nuts2: dict[str, Any] | Unset = UNSET
        if not isinstance(self.nuts2, Unset):
            nuts2 = self.nuts2.to_dict()

        nuts3: dict[str, Any] | Unset = UNSET
        if not isinstance(self.nuts3, Unset):
            nuts3 = self.nuts3.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({})
        if nuts0 is not UNSET:
            field_dict["NUTS0"] = nuts0
        if nuts1 is not UNSET:
            field_dict["NUTS1"] = nuts1
        if nuts2 is not UNSET:
            field_dict["NUTS2"] = nuts2
        if nuts3 is not UNSET:
            field_dict["NUTS3"] = nuts3

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.open_cage_annotations_nutsnuts0 import (
            OpenCageAnnotationsNUTSNUTS0,
        )
        from ..models.open_cage_annotations_nutsnuts1 import (
            OpenCageAnnotationsNUTSNUTS1,
        )
        from ..models.open_cage_annotations_nutsnuts2 import (
            OpenCageAnnotationsNUTSNUTS2,
        )
        from ..models.open_cage_annotations_nutsnuts3 import (
            OpenCageAnnotationsNUTSNUTS3,
        )

        d = dict(src_dict)
        _nuts0 = d.pop("NUTS0", UNSET)
        nuts0: OpenCageAnnotationsNUTSNUTS0 | Unset
        if isinstance(_nuts0, Unset):
            nuts0 = UNSET
        else:
            nuts0 = OpenCageAnnotationsNUTSNUTS0.from_dict(_nuts0)

        _nuts1 = d.pop("NUTS1", UNSET)
        nuts1: OpenCageAnnotationsNUTSNUTS1 | Unset
        if isinstance(_nuts1, Unset):
            nuts1 = UNSET
        else:
            nuts1 = OpenCageAnnotationsNUTSNUTS1.from_dict(_nuts1)

        _nuts2 = d.pop("NUTS2", UNSET)
        nuts2: OpenCageAnnotationsNUTSNUTS2 | Unset
        if isinstance(_nuts2, Unset):
            nuts2 = UNSET
        else:
            nuts2 = OpenCageAnnotationsNUTSNUTS2.from_dict(_nuts2)

        _nuts3 = d.pop("NUTS3", UNSET)
        nuts3: OpenCageAnnotationsNUTSNUTS3 | Unset
        if isinstance(_nuts3, Unset):
            nuts3 = UNSET
        else:
            nuts3 = OpenCageAnnotationsNUTSNUTS3.from_dict(_nuts3)

        open_cage_annotations_nuts = cls(
            nuts0=nuts0,
            nuts1=nuts1,
            nuts2=nuts2,
            nuts3=nuts3,
        )

        open_cage_annotations_nuts.additional_properties = d
        return open_cage_annotations_nuts

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
