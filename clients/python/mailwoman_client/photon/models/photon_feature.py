from __future__ import annotations

from collections.abc import Mapping
from typing import (
    TYPE_CHECKING,
    Any,
    Literal,
    TypeVar,
    cast,
)

from attrs import define as _attrs_define

if TYPE_CHECKING:
    from ..models.photon_properties import PhotonProperties
    from ..models.point_geometry import PointGeometry


T = TypeVar("T", bound="PhotonFeature")


@_attrs_define
class PhotonFeature:
    """A GeoJSON `Point` feature carrying Photon properties.

    Attributes:
        type_ (Literal['Feature']):
        geometry (PointGeometry): A GeoJSON `Point` geometry — `coordinates` are `[longitude, latitude]`.
        properties (PhotonProperties): OSM-derived feature properties, populated from the resolved place. `osm_key`,
            `osm_value`, and `type` are always present so a Photon client never dereferences `undefined`. Unlisted keys may
            also appear.
    """

    type_: Literal["Feature"]
    geometry: PointGeometry
    properties: PhotonProperties

    def to_dict(self) -> dict[str, Any]:
        type_ = self.type_

        geometry = self.geometry.to_dict()

        properties = self.properties.to_dict()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "type": type_,
                "geometry": geometry,
                "properties": properties,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.photon_properties import PhotonProperties
        from ..models.point_geometry import PointGeometry

        d = dict(src_dict)
        type_ = cast(Literal["Feature"], d.pop("type"))
        if type_ != "Feature":
            raise ValueError(f"type must match const 'Feature', got '{type_}'")

        geometry = PointGeometry.from_dict(d.pop("geometry"))

        properties = PhotonProperties.from_dict(d.pop("properties"))

        photon_feature = cls(
            type_=type_,
            geometry=geometry,
            properties=properties,
        )

        return photon_feature
