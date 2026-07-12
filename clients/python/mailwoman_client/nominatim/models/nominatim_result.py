from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.nominatim_address_details import NominatimAddressDetails
    from ..models.open_cage_annotations import OpenCageAnnotations


T = TypeVar("T", bound="NominatimResult")


@_attrs_define
class NominatimResult:
    """A Nominatim result object (the shape `geopy` and friends parse).

    Attributes:
        place_id (int | str):
        licence (str): The attribution string for the resolved data sources.
        lat (str): Latitude, as a string (Nominatim convention).
        lon (str): Longitude, as a string (Nominatim convention).
        display_name (str):
        osm_type (str | Unset):
        osm_id (int | str | Unset):
        boundingbox (list[str] | Unset): `[south, north, west, east]` as strings (Nominatim convention).
        class_ (str | Unset):
        type_ (str | Unset):
        importance (float | Unset):
        place_rank (int | Unset):
        address (NominatimAddressDetails | Unset): The structured address breakdown returned under `address` when
            `addressdetails=1`. Keys mirror Nominatim's OSM-derived tag names.
        geojson (Any | Unset): Present when `format=geojson` or `polygon_geojson=1` — a GeoJSON geometry.
        annotations (OpenCageAnnotations | Unset): The OpenCage-style enrichment block, keyed and cased as OpenCage
            documents it. A Mailwoman extension over upstream Nominatim. Only populated fields are emitted.
    """

    place_id: int | str
    licence: str
    lat: str
    lon: str
    display_name: str
    osm_type: str | Unset = UNSET
    osm_id: int | str | Unset = UNSET
    boundingbox: list[str] | Unset = UNSET
    class_: str | Unset = UNSET
    type_: str | Unset = UNSET
    importance: float | Unset = UNSET
    place_rank: int | Unset = UNSET
    address: NominatimAddressDetails | Unset = UNSET
    geojson: Any | Unset = UNSET
    annotations: OpenCageAnnotations | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        place_id: int | str
        place_id = self.place_id

        licence = self.licence

        lat = self.lat

        lon = self.lon

        display_name = self.display_name

        osm_type = self.osm_type

        osm_id: int | str | Unset
        if isinstance(self.osm_id, Unset):
            osm_id = UNSET
        else:
            osm_id = self.osm_id

        boundingbox: list[str] | Unset = UNSET
        if not isinstance(self.boundingbox, Unset):
            boundingbox = self.boundingbox

        class_ = self.class_

        type_ = self.type_

        importance = self.importance

        place_rank = self.place_rank

        address: dict[str, Any] | Unset = UNSET
        if not isinstance(self.address, Unset):
            address = self.address.to_dict()

        geojson = self.geojson

        annotations: dict[str, Any] | Unset = UNSET
        if not isinstance(self.annotations, Unset):
            annotations = self.annotations.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "place_id": place_id,
                "licence": licence,
                "lat": lat,
                "lon": lon,
                "display_name": display_name,
            }
        )
        if osm_type is not UNSET:
            field_dict["osm_type"] = osm_type
        if osm_id is not UNSET:
            field_dict["osm_id"] = osm_id
        if boundingbox is not UNSET:
            field_dict["boundingbox"] = boundingbox
        if class_ is not UNSET:
            field_dict["class"] = class_
        if type_ is not UNSET:
            field_dict["type"] = type_
        if importance is not UNSET:
            field_dict["importance"] = importance
        if place_rank is not UNSET:
            field_dict["place_rank"] = place_rank
        if address is not UNSET:
            field_dict["address"] = address
        if geojson is not UNSET:
            field_dict["geojson"] = geojson
        if annotations is not UNSET:
            field_dict["annotations"] = annotations

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.nominatim_address_details import NominatimAddressDetails
        from ..models.open_cage_annotations import OpenCageAnnotations

        d = dict(src_dict)

        def _parse_place_id(data: object) -> int | str:
            return cast(int | str, data)

        place_id = _parse_place_id(d.pop("place_id"))

        licence = d.pop("licence")

        lat = d.pop("lat")

        lon = d.pop("lon")

        display_name = d.pop("display_name")

        osm_type = d.pop("osm_type", UNSET)

        def _parse_osm_id(data: object) -> int | str | Unset:
            if isinstance(data, Unset):
                return data
            return cast(int | str | Unset, data)

        osm_id = _parse_osm_id(d.pop("osm_id", UNSET))

        boundingbox = cast(list[str], d.pop("boundingbox", UNSET))

        class_ = d.pop("class", UNSET)

        type_ = d.pop("type", UNSET)

        importance = d.pop("importance", UNSET)

        place_rank = d.pop("place_rank", UNSET)

        _address = d.pop("address", UNSET)
        address: NominatimAddressDetails | Unset
        if isinstance(_address, Unset):
            address = UNSET
        else:
            address = NominatimAddressDetails.from_dict(_address)

        geojson = d.pop("geojson", UNSET)

        _annotations = d.pop("annotations", UNSET)
        annotations: OpenCageAnnotations | Unset
        if isinstance(_annotations, Unset):
            annotations = UNSET
        else:
            annotations = OpenCageAnnotations.from_dict(_annotations)

        nominatim_result = cls(
            place_id=place_id,
            licence=licence,
            lat=lat,
            lon=lon,
            display_name=display_name,
            osm_type=osm_type,
            osm_id=osm_id,
            boundingbox=boundingbox,
            class_=class_,
            type_=type_,
            importance=importance,
            place_rank=place_rank,
            address=address,
            geojson=geojson,
            annotations=annotations,
        )

        nominatim_result.additional_properties = d
        return nominatim_result

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
