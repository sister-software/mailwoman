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
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.nominatim_feature_collection_features_item_properties import (
        NominatimFeatureCollectionFeaturesItemProperties,
    )


T = TypeVar("T", bound="NominatimFeatureCollectionFeaturesItem")


@_attrs_define
class NominatimFeatureCollectionFeaturesItem:
    """
    Attributes:
        type_ (Literal['Feature']):
        properties (NominatimFeatureCollectionFeaturesItemProperties):
        geometry (Any): A GeoJSON geometry (the place polygon when present, else a Point).
        bbox (list[float] | Unset): `[west, south, east, north]` (GeoJSON bbox order).
    """

    type_: Literal["Feature"]
    properties: NominatimFeatureCollectionFeaturesItemProperties
    geometry: Any
    bbox: list[float] | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        type_ = self.type_

        properties = self.properties.to_dict()

        geometry = self.geometry

        bbox: list[float] | Unset = UNSET
        if not isinstance(self.bbox, Unset):
            bbox = self.bbox

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "type": type_,
                "properties": properties,
                "geometry": geometry,
            }
        )
        if bbox is not UNSET:
            field_dict["bbox"] = bbox

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.nominatim_feature_collection_features_item_properties import (
            NominatimFeatureCollectionFeaturesItemProperties,
        )

        d = dict(src_dict)
        type_ = cast(Literal["Feature"], d.pop("type"))
        if type_ != "Feature":
            raise ValueError(f"type must match const 'Feature', got '{type_}'")

        properties = NominatimFeatureCollectionFeaturesItemProperties.from_dict(
            d.pop("properties")
        )

        geometry = d.pop("geometry")

        bbox = cast(list[float], d.pop("bbox", UNSET))

        nominatim_feature_collection_features_item = cls(
            type_=type_,
            properties=properties,
            geometry=geometry,
            bbox=bbox,
        )

        nominatim_feature_collection_features_item.additional_properties = d
        return nominatim_feature_collection_features_item

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
