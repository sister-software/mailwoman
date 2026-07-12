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
    from ..models.photon_feature import PhotonFeature


T = TypeVar("T", bound="PhotonFeatureCollection")


@_attrs_define
class PhotonFeatureCollection:
    """A GeoJSON `FeatureCollection` of Photon result features (RFC 7946).

    Attributes:
        type_ (Literal['FeatureCollection']):
        features (list[PhotonFeature]):
    """

    type_: Literal["FeatureCollection"]
    features: list[PhotonFeature]

    def to_dict(self) -> dict[str, Any]:
        type_ = self.type_

        features = []
        for features_item_data in self.features:
            features_item = features_item_data.to_dict()
            features.append(features_item)

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "type": type_,
                "features": features,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.photon_feature import PhotonFeature

        d = dict(src_dict)
        type_ = cast(Literal["FeatureCollection"], d.pop("type"))
        if type_ != "FeatureCollection":
            raise ValueError(
                f"type must match const 'FeatureCollection', got '{type_}'"
            )

        features = []
        _features = d.pop("features")
        for features_item_data in _features:
            features_item = PhotonFeature.from_dict(features_item_data)

            features.append(features_item)

        photon_feature_collection = cls(
            type_=type_,
            features=features,
        )

        return photon_feature_collection
