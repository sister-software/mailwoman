from __future__ import annotations

from collections.abc import Mapping
from typing import (
    Any,
    Literal,
    TypeVar,
    cast,
)

from attrs import define as _attrs_define

T = TypeVar("T", bound="PointGeometry")


@_attrs_define
class PointGeometry:
    """A GeoJSON `Point` geometry — `coordinates` are `[longitude, latitude]`.

    Attributes:
        type_ (Literal['Point']):
        coordinates (list[float]): `[longitude, latitude]` (RFC 7946 position order).
    """

    type_: Literal["Point"]
    coordinates: list[float]

    def to_dict(self) -> dict[str, Any]:
        type_ = self.type_

        coordinates = self.coordinates

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "type": type_,
                "coordinates": coordinates,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        type_ = cast(Literal["Point"], d.pop("type"))
        if type_ != "Point":
            raise ValueError(f"type must match const 'Point', got '{type_}'")

        coordinates = cast(list[float], d.pop("coordinates"))

        point_geometry = cls(
            type_=type_,
            coordinates=coordinates,
        )

        return point_geometry
