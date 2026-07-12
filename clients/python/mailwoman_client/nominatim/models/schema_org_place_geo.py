from __future__ import annotations

from collections.abc import Mapping
from typing import (
    Any,
    Literal,
    TypeVar,
    cast,
)

from attrs import define as _attrs_define

T = TypeVar("T", bound="SchemaOrgPlaceGeo")


@_attrs_define
class SchemaOrgPlaceGeo:
    """
    Attributes:
        type_ (Literal['GeoCoordinates']):
        latitude (float):
        longitude (float):
    """

    type_: Literal["GeoCoordinates"]
    latitude: float
    longitude: float

    def to_dict(self) -> dict[str, Any]:
        type_ = self.type_

        latitude = self.latitude

        longitude = self.longitude

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "@type": type_,
                "latitude": latitude,
                "longitude": longitude,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        type_ = cast(Literal["GeoCoordinates"], d.pop("@type"))
        if type_ != "GeoCoordinates":
            raise ValueError(f"@type must match const 'GeoCoordinates', got '{type_}'")

        latitude = d.pop("latitude")

        longitude = d.pop("longitude")

        schema_org_place_geo = cls(
            type_=type_,
            latitude=latitude,
            longitude=longitude,
        )

        return schema_org_place_geo
